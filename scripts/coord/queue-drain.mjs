#!/usr/bin/env node
// scripts/queue-drain.mjs — read-only eligibility oracle for the autonomous
// `ready/`-queue drain (plan 231, Phase 1).
//
// The drain runs ONE plan at a time (serial autonomy — no concurrent plan
// execution; see plan 231 "Mode clarity"). This oracle answers a single
// question for the driver (scripts/drain-run.mjs): "what is the next eligible
// plan to pick up, if any?" It parses each `ready/` plan's coordination
// metadata (SEED-WRITE banner, Blocked-by line, operator-gating language, Cost
// forecast) and applies the same gates a human picker would:
//
// SELECTION is read-only — nothing below writes to a plan, the INDEX, or the
// queue. The ONE exception (plan 3443) is the board REAPER: a 🟢 LANDING row
// proven dead on all three staleness axes is flipped to ⏸ PAUSED before the
// mutex is read, so a killed session cannot wedge the seed lane until a human
// notices (the ~9 h outage of 2026-08-24/25). `--no-heal` restores the strictly
// read-only behaviour for a consumer that needs it.
//
//   - cross-plan-blocked plans (a Blocked-by line naming another plan id) are
//     excluded — their upstream hasn't landed.
//   - operator-gated plans (need an operator-supplied export / decision /
//     green-light) are excluded — the drain can't satisfy them.
//   - while a 🟢 LANDING row's OWN plan is itself 🟥 SEED-WRITE, 🟥 SEED-WRITE
//     candidates are dropped (only one 🟥 lands at a time — the LANDING mutex;
//     🟩 merge freely). Lane-aware since plan 3443: a 🟩-only LANDING state
//     drops nothing — see resolveLandingHeldForSeedLane below, which also
//     reaps a provably-stale 🟢 LANDING row (dead session, no live queue
//     entry, no branch progress) to ⏸ PAUSED before this read.
//   - (cloud path, plan 2863) plans that ALREADY have an execution branch on
//     origin (`claude/drain-<id>-…` / `worktree-<id>-…`) are excluded — an earlier
//     firing did the work and it awaits adoption, not a second execution.
//   - survivors sort 🟩-before-🟥, then cost ascending (cheapest forecast first;
//     an unknown-cost plan sorts last since the drain pauses on it anyway), then
//     plan-id ascending as the final tiebreak.
//
// Output (stdout, always JSON):
//   exit 0:  { next: {slug,path,seedWrite,cost}, eligible: [ … ], runnableBatches: [ … ] }
//   exit 1:  { reason: empty|all_blocked|all_need_operator|all_fable_or_stub|
//             all_not_cloud_eligible|all_already_on_origin|all_batch_held|
//             all_batch_held_none_runnable|landing_mutex_active,
//             excluded: [ … ], runnableBatches: [ … ], skippedBatches: [ … ] }
//             (no SINGLE plan runnable right now)
//
// `all_batch_held` vs `all_batch_held_none_runnable`: both mean every excluded plan is held
// by a runnable batch, but only the FIRST promises a takeable train. A member can be
// batch-held AND blocked underneath the hold (the batch gate is checked above Blocked-by),
// so the second says "held, but nothing to take" — see `skippedBatches` for which train and
// which member.
//   exit 2:  hard error (printed to stderr)
//
// `runnableBatches` (plan 2556) rides BOTH shapes: the takeable execution BATCHES, one
// entry per batch ({slug, members, memberSlugs, memberPaths, seedWrite}), lowest
// smallest-member-id first. It is a SEPARATE unit kind from `eligible`, never folded
// into it — `eligible` is the solo-claimable set and a batch-held member appearing there
// would re-open the plan-2459 leak-B hold (the fastest claimer dissolves the train).
// The EXIT CODE is unchanged and still keys on the single-plan pool only: exit 1 means
// "no single plan runnable", which is compatible with a non-empty `runnableBatches`
// (reason `all_batch_held` is exactly that state). A consumer able to run a train
// therefore checks `.runnableBatches` REGARDLESS of the exit code, and treats exit 1 as
// terminal only when that array is empty too. Consumers that cannot (drain-run.mjs,
// local-drain-filter.mjs, orchestrate-dryrun.mjs — all of which read exit 0 as "`.next`
// exists") are unaffected by construction.
//
// `--cloud` (plan 1781, Gap 2): the CLOUD-drain eligibility mode. An unattended
// cloud routine cannot run a plan whose work needs local-only tooling (the price
// pipeline's Playwright/Chrome), an unlisted external key, or the seed sandbox —
// yet "is this cloud-safe" used to be re-derived inside EACH cloud routine prompt
// from a fragile grep of `execModel`/seed/external-key keywords, mis-firing both
// ways. In `--cloud` mode this oracle instead reads the dedicated `cloudExec:
// true|false` frontmatter axis (stamped at spec-pass time by
// scripts/stamp-cloud-exec.mjs) and EXCLUDES any plan not explicitly stamped
// `cloudExec: true` — a plan stamped `false` (reason in its body banner) OR one
// not yet stamped at all (conservative: forward-only adoption, an unstamped plan
// is never auto-run in the cloud). The cloud routine calls `queue-drain.mjs
// --cloud` and lands whatever `next` names; local drains omit the flag and see
// the unchanged full pool.
//
// `--lane fable` (plan 1810): composable with `--cloud`. The default pool serves
// the SONNET lane (execModel: fable plans are excluded, `exclude: 'fable'`,
// "route to a Fable session"). `--lane fable` INVERTS that one gate — the pool
// becomes `execModel: fable` plans, and `execModel: sonnet` (or absent, the
// grandfathered-sonnet default) plans are excluded instead, as `exclude:
// 'sonnet-lane'`. Every other gate (stage/specReview, blocked-by, operator-
// gating, landing mutex, cloudExec-first precedence under `--cloud`, 🟩-before-🟥
// + cost sort) is untouched and order-identical — a fable-lane stub is still
// excluded by the stage/specReview gate, never bypassed. Flagless behaviour is
// byte-identical to pre-1810. The cloud FABLE-drain routine calls `queue-drain.mjs
// --cloud --lane fable` (docs/runbooks/cloud-routines/fable-drain.md).
//
// `--env full` (plan 1925, superset since plan 2003): composable with `--cloud`
// (and REQUIRES it — the `cloudEnv` axis routes between CLOUD environment kinds;
// local drains run on the operator's full-egress machine and never read it). The
// second cloud axis, `cloudEnv: trusted | full` (stamped via
// `stamp-cloud-exec.mjs <id> true --env full`), declares which network policy the
// runner's environment must have: `full` = the plan's work needs Full-egress
// (live clinic/platform-host fetches, a WebKit install for the mobile gate);
// absent (or `trusted`) = drainable by any cloud runner. In plain `--cloud` mode
// a `cloudEnv: full` plan is excluded as `exclude: 'full-env'` (a Trusted drain
// would proxy-403 the very work the plan exists to do). `--cloud --env full` is a
// strict SUPERSET lane (plan 2003) — a Full-egress environment can run anything a
// Trusted one can, plus the fetch/WebKit work, so it excludes NOTHING on the
// cloudEnv axis and admits both `cloudEnv: full` AND `cloudEnv: trusted`/absent
// plans. The old plan-1925 'trusted-env' exclusion (full lane rejecting the
// trusted pool) is retired; the end state is full-only draining (trusted drains
// disabled), and the claim CAS keeps any transient two-lane overlap
// safe-but-wasteful. Every other gate is untouched and order-identical;
// `--env`-less behaviour is byte-identical to pre-1925. The full-lane routines
// call `queue-drain.mjs --cloud --env full [--lane fable]`
// (docs/runbooks/cloud-routines/{sonnet,fable}-full.md).
//
// `--env browser` (plan 2250): a THIRD cloudEnv value, one level above `full` on
// the same superset ladder — `cloudEnv: browser` means the plan's acceptance needs
// live headless-BROWSER egress (a real Chromium TLS handshake against a live host),
// not just the fetch/WebKit-install egress `full` already covers. The distinction is
// load-bearing: plan 2241's cloud drain (Full-egress lane) found `curl`/Node `https`
// succeed against live hosts from the SAME container where headless Chromium fails
// every TLS handshake (`net::ERR_CONNECTION_RESET`) — Full-egress network policy does
// NOT imply working browser-engine egress. `--cloud --env browser` is a strict
// SUPERSET of `--env full` (which is itself a superset of the trusted default): it
// excludes NOTHING on the cloudEnv axis, admitting `browser`/`full`/`trusted`/absent
// plans alike. As of plan 3754 (operator 2026-09-06) the lane decision is TAKEN, and
// plan 3823 made the browser body the FLEET DEFAULT rather than a single-account exception:
// the account registry marks every live account's `sonnet-full` AND `fable-full` slot
// `browser`, so the reconciler renders a generated `--env browser` body for all six
// (`docs/runbooks/cloud-routines/sonnet-browser.md`, `fable-browser.md`). WHICH of
// those bodies is actually PUSHED onto its live trigger, and which routines are
// ENABLED to run it, are both LIVE state — read the dated log in
// `docs/runbooks/cloud-drain-landing.md` and ask `node
// scripts/sync-trigger-bodies.mjs --dry-run`; never assert either here. The
// chromium-egress PASS behind the rung was measured on ONE env (one account, run
// `cse_012Fc6JeHtjvuh4zkdMMPq3e`), and the operator decided on 2026-09-08 that a box
// measured green for one account is taken to work for all, so there is no per-account
// probe verdict to cite for the others. Evidence + probe recipe + lane status:
// `docs/runbooks/cloud-drain-autonomy.md` § The cloudEnv axis.
//
// `cloudEnv: webkit` (plan 2313): a FOURTH rung on the same ladder, slotting between
// `full` and `browser` — the plan's acceptance needs a live BROWSER-RENDERED page but
// consumes only DOM/HTML/anchors/`http_status` from it (never pixels, crops, vision
// grades, or structural hashes — those stay `browser`, Chromium-pinned: swapping
// engines there would invalidate the cached shot corpus and change what the vision
// judges see). WebKit satisfies the DOM-only class, and WebKit live egress WORKS in
// a Full-egress environment — production fact, not hope: the plan-2206 NO/DK booking
// sweep rendered ~328 live clinic pages through HTTPS_PROXY on cloud WebKit, and plan
// 2269's shared render core ships `engine="webkit"` for exactly this (WebKit's
// soup/GnuTLS stack tunnels cleanly through the egress relay that resets every
// Chromium ClientHello — the 2241 defect is engine-specific). So there is NO new
// `--env webkit` CLI value: `--env full` admits `cloudEnv: webkit` directly (a
// separate lane flag would be identical to `--env full`), `--env browser` admits it
// as the top rung, and only the plain-`--cloud` Trusted lane excludes it (`exclude:
// 'webkit-env'` — a Trusted env can neither install WebKit nor reach live hosts).
// Positive per-lane verification: `scripts/probe-webkit-egress.mjs` (the
// probe-chromium-egress sibling). Split rule + evidence:
// `docs/runbooks/cloud-drain-autonomy.md` § The `cloudEnv: webkit` value.
//
// Blocked-by / archive check (plan 1819): a Blocked-by line naming another plan is
// trusted at face value UNLESS that named plan is archived — a landed-and-archived
// blocker leaves a stale line an operator never gets around to hand-editing (the
// 1790/1794 incident), so the oracle instead resolves the named id against
// `docs/superpowers/plans/archive/<id>-*.md` (read from disk the same way `ready/`
// itself is — no git-show; the CLI always reads the checked-out working tree of the
// resolved main worktree, so "the ref being judged" IS that on-disk snapshot). An
// archived blocker does NOT exclude — the plan is included and a `staleBlockedBy`
// warning is attached (surfaced in the oracle JSON) so a sweep/human can clean the
// body. Anything else (blocker still in flight, or the id matches no plan file at
// all) keeps today's conservative `exclude: 'blocked'`.
//
// Plan 2496: "archived" alone is NOT "shipped" (plan 1836's ARCHIVE_COMPLETED_RX
// distinction, below) — a blocker can sit in `archive/` 🗄️ SUPERSEDED or abandoned
// without the blocking WORK ever landing. Before 2496 that case fell all the way
// through to the generic `exclude: 'blocked'` bucket, indistinguishable from a
// blocker that is simply still open in `ready/`. It now gets its OWN named reason,
// `exclude: 'blocker_archived_unshipped'` — see the classification block in
// parsePlanMeta and readArchivedIds's `unshipped` Set below.
//
// Runnable-batch hold (plan 2459 Task 2, leak B): a member of a `status: proposed,
// gate: null` batch (docs/superpowers/batches/<slug>/batch.md) must not be claimable
// SOLO — the fastest single-plan claimer was silently dissolving proposed trains (~7
// recorded "landed/claimed solo before any train ran" dissolutions,
// docs/superpowers/batches/README.md). `readReadyMetas` precomputes the held-by map ONCE
// per scan (batch-paths.mjs's `readRunnableBatchMembers`, the shared helper claim-plan.mjs's
// single-claim path also consumes) and threads it through `parsePlanMeta`'s options bag —
// same shape as the `archivedIds` precompute below — so parsePlanMeta itself stays pure (no
// fs read inside it). A `gate:` non-null batch's members are NEVER in the map (a gate must
// never freeze them); a stale roster whose members have all long since moved on never
// excludes anything either, by construction — this oracle only ever consults the map for
// ids it is ACTUALLY scanning in ready/, never iterates a roster's membership independently.
// Excluded as `exclude: 'batch'`, checked AFTER the stage/specReview stub gate (a stub still
// needs a spec-pass regardless of batch membership) and BEFORE Blocked-by (a batch hold
// names an alternative claim PATH, not an upstream dependency).
//
// The pure functions (parsePlanMeta / selectEligible / parseCost) take strings (plus,
// for the archive check, a precomputed `archivedIds` Set, and for the batch-hold check, a
// precomputed `batchHeldBy` Map — no fs read inside the pure function itself), touch no
// fs/git, and carry the unit tests (queue-drain.test.mjs).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findScriptsDir } from './scripts-anchor.mjs';
import { execFileSync } from 'node:child_process';
import {
  resolveMain,
  parseFlags,
  deadSeedVerdict,
  DEAD_SEED_MIN_AGE_MS,
  // plan 3816 fix round: the ONE `git cat-file --batch` maxBuffer this repo's git subprocesses
  // agree on (coord-git.mjs) — readBlobsBatched below mirrors in-progress-board.mjs's
  // listPlansFromOrigin, which imports the SAME constant for the SAME reason (a whole ready/
  // corpus's raw content, read in one batch, can exceed Node's 1MB execFileSync default).
  GIT_MAXBUFFER,
} from './coord-git.mjs';
import { DRAIN_STATUS_REF_GLOB, parseStatusHeads, readDrainStatuses } from './drain-status.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import {
  readFrontmatterScalar,
  readSeedWriteValue,
  specReviewGateErrorFromValues,
  stripFrontmatter,
  HEADING_LEVEL_RX,
  FENCE_DELIM_RX,
  readPriorityTier,
  PRIORITY_SORT_WEIGHT,
  walkPlanStatusDir,
  // plan 3816: the ONE plans-root-relative-path classifier (statusFolder/category/basename,
  // including the plan-2678 one-level category subfolder) — reused so the origin-mode ready/
  // listing (readyEntriesFromOrigin below) derives the SAME shape walkPlanDir yields from the
  // local tree, instead of hand-rolling a second path-splitting rule that could drift from it.
  classifyPlanRel,
  // plan 3960 cluster-6 review fix: the configured lane names — a renamed ready/archive folder
  // used to be invisible to this module's own hardcoded 'ready'/'archive' literals.
  READY_FOLDER,
  ARCHIVE_FOLDER,
} from './build-index-lib.mjs';
import { readCloudExecStamp, UNSET, NO_FRONTMATTER } from './local-drain-filter.mjs';
import { lazyBatchRoster, canonicalPlanId, batchHoldFor } from './batch-paths.mjs';
// plan 3962 P1: was `import { parseCloudRepos } from './cloud-repos-lib.mjs'` — that project
// module (the vetapp EXTRA-REPO registry, hardcodes the project's own extra-repo values) is not importable from
// here once this file moves under the generic scripts/coord/** core (Rule 3,
// assert-scripts-self-contained.mjs). The generic parse/validate half moved to
// token-list-lib.mjs (a pure, zero-import leaf); the valid-key set is now a parameter
// (`validCloudRepoKeys`, threaded from main()'s already-loaded coord.config.json `cloudRepos`
// rows — see main() below), never looked up here.
import { parseAndValidateTokenList } from './token-list-lib.mjs';
// plan 3443: cellsOf (held-row column parsing) + the reaper's pure verdict — board-lib.mjs
// carries zero imports of its own, so pulling it in here creates no import-cycle risk with
// landing-queue-lib.mjs below (which already imports board-lib.mjs itself).
// LANDING_STATE / batchSlugOfCell / isBatchMemberCell (review round, Fixes 3/4): the same
// column-exact state literal and the batch-marker reader/predicate board-lib.mjs's own writer
// (claim-plan-lib.mjs's boardBatchPlanClaimCell) stamps into a batch member's claim cell — read
// from here, never re-derived, so the reaper's batch-routing can never drift from the marker's
// actual grammar.
import {
  cellsOf,
  landingRowReapVerdict,
  LANDING_STATE,
  batchSlugOfCell,
  isBatchMemberCell,
} from './board-lib.mjs';
// plan 3443: the ONE freshness predicate + its default staleness bound (matches
// `landing-queue.mjs steal --confirm-holder-gone`'s own default) — the reaper's queue-side
// staleness input is computed through the SAME rule `steal`/`demote`/`reap` themselves use,
// never a re-rolled copy.
import { ageIsFresh, DEFAULT_STEAL_STALE_MIN } from './landing-queue-lib.mjs';
// resolveExecLane / EXEC_LANE_TABLE (plan 3341): the ONE fail-closed lane lookup —
// sonnet/fable/sol today — a third session (claim-plan-lib.mjs) is landing alongside
// this change. THIS import is written against its published contract ('' | null |
// undefined -> the sonnet entry; a known key -> its entry; anything else -> throws)
// regardless of whether that export has landed yet in this worktree's copy of the
// file — see this plan's report for which was true at write time. Never
// re-implement the table here: a second copy is exactly the drift this plan exists
// to prevent.
import { resolveExecLane, EXEC_LANE_TABLE } from './claim-plan-lib.mjs';

// --- pure: gating language ----------------------------------------------------

// Plan needs an operator-supplied input / decision before it can run.
// Mirrors plan 231's regex set, widened slightly: `[\s\S]{0,40}` (bounded,
// crosses newlines) instead of `.*` so an "operator" early in the doc can't
// match a "supply" thousands of chars later, and `suppl` catches both
// "supply" and "supplies" (e.g. 221's "Operator supplies the volume export").
export const OPERATOR_GATE_RX =
  /operator[\s\S]{0,40}suppl|account-gated|operator[\s\S]{0,40}green-light/i;

// Plan needs hands-on operator interaction DURING execution that an unattended
// `claude -p` worker cannot provide: driving the operator's logged-in browser
// (claude-in-chrome / Google Flow image-gen) or a mandatory operator-approval
// checkpoint mid-run. Distinct from OPERATOR_GATE_RX (a one-time operator-supplied
// input BEFORE the plan runs) — but it lands in the same `exclude='operator'`
// bucket: the drain can satisfy neither, so it SKIPS the plan and lists it at
// closing. This is the class that was halting the loop (437 Google Flow image-gen,
// 438 claude-in-chrome): both sort 🟩-first to the front of ready/, a headless
// worker returns `blocked`, and the driver's plan_blocked path stopped the whole
// run. Fail-safe by design — a false positive only defers an auto-drainable plan
// to the operator (the conservative direction). (plan 443)
export const OPERATOR_INTERACTIVE_RX =
  /claude-in-chrome|google flow|logged-in chrome|operator['’]?s\s+logged-in|operator[\s\S]{0,30}approval checkpoint/i;

// A `##`+ heading opening a CLOSE-OUT TAIL section — the repo's `split-don't-sink`
// convention (the 1810/1819 pattern): operator-needing follow-up work is carved out
// of the plan's acceptance into its own named section so the REMAINING body can be
// drained unattended. Shapes in the live corpus:
//   ## Close-out follow-up (operator-local tail — split-don't-sink)
//   ## Close-out follow-up (machine-local tail — split-don't-sink)
//
// Two deliberate tightenings (review findings, both the same class as the bug):
//
// - The tail phrase must OPEN the heading text, not merely appear in it. A first cut
//   that accepted the phrase anywhere matched "### Second live instance: the heuristic
//   defeats the split-don't-sink convention" (plan 2368's own heading — one that
//   DISCUSSES the convention) and dropped the rest of the plan from every gate scan;
//   an unanchored `\w+-local tail` would likewise swallow "## Fixing the
//   per-client-local tail latency bug". Same "describing a thing is not being the
//   thing" trap the gates themselves fall into, one level up.
// - `#{1,6}`, not `#{2,}`: nothing enforces H2 for the convention, and an H1 tail that
//   silently bypassed the scan would restore 2403's false exclusion exactly.
export const CLOSEOUT_TAIL_HEADING_RX = /^#{1,6}\s+(?:close-?out follow-up|\w+-local tail)\b/i;

// The plan body split into the SPANS the operator-gate regexes may scan: every run of
// lines outside a close-out-tail section (a tail heading through to the next heading of
// the SAME-or-shallower level). Without this scoping, the very convention that makes a
// plan drainable is what marks it undrainable: a tail says "the operator does this
// LATER, it does not block the body", yet describing that tail is textually
// indistinguishable from depending on it — the gates scanned the whole file and
// excluded the plan anyway (live case: plan 2403's "operator's logged-in" inside
// exactly such a section, whose next sentence reads "the unit-test acceptance below is
// the cloud-drainable body"). Scoping past the tail is the structural read of the
// convention, not a heuristic softening: the section's contract IS "not part of the
// drainable body".
//
// SPANS, not one spliced string (review finding): both gate regexes have a bounded
// cross-newline window (`[\s\S]{0,40}` / `{0,30}`), so deleting a section and rejoining
// its neighbours with a single '\n' can make text that was never adjacent in the real
// plan adjacent enough to match — fabricating an exclusion in the false-POSITIVE
// direction, and (symmetrically) tearing a genuine straddling phrase apart in the
// dangerous false-negative one. Scanning each retained run separately cannot invent
// either adjacency.
//
// Fence state and heading depth both come from build-index-lib's shared literals
// (plan 2052/2083): a heading-shaped line inside a ``` fenced example — a plan quoting
// the convention, which real plans do — is not a section boundary.
export function closeoutTailSpans(body) {
  const spans = [];
  let cur = [];
  let dropDepth = null; // heading depth of the tail section currently being dropped
  let inFence = false;
  const flush = () => {
    if (cur.length) spans.push(cur.join('\n'));
    cur = [];
  };
  for (const line of body.split('\n')) {
    if (FENCE_DELIM_RX.test(line)) {
      // Tracked even inside a dropped tail — a fence opened there still governs the
      // lines that follow it. Never itself a heading.
      inFence = !inFence;
      if (dropDepth === null) cur.push(line);
      continue;
    }
    if (!inFence) {
      const h = HEADING_LEVEL_RX.exec(line);
      if (h) {
        const depth = h[1].length;
        if (dropDepth !== null && depth <= dropDepth) dropDepth = null; // section ended
        if (dropDepth === null && CLOSEOUT_TAIL_HEADING_RX.test(line)) {
          dropDepth = depth;
          flush();
          continue;
        }
      }
    }
    if (dropDepth === null) cur.push(line);
  }
  flush();
  return spans;
}

// The two gate reads, both over `closeoutTailSpans` — one place, so
// OPERATOR_GATE_RX and OPERATOR_INTERACTIVE_RX can never scan different scopes.
export function operatorGatedByText(body) {
  return closeoutTailSpans(body).some((span) => OPERATOR_GATE_RX.test(span));
}

// Human-readable reason for an operator-interactive exclusion — the matched
// marker (whitespace-collapsed, capped) so the closing skip-list says WHAT the
// operator must do. Returns null when no marker matches.
//
// Takes text and strips nothing itself: `operatorInteractiveReasonInBody` below is the
// body-scoped entry point parsePlanMeta uses, and other callers may pass text that is
// already scoped.
export function operatorInteractiveReason(content) {
  const m = content.match(OPERATOR_INTERACTIVE_RX);
  if (!m) return null;
  const marker = m[0].replace(/\s+/g, ' ').trim().slice(0, 50);
  return `operator-interactive: needs the operator's live browser/session (matched "${marker}")`;
}

// First operator-interactive marker in any scannable span of `body`, as a reason
// string — the span-wise twin of operatorGatedByText. Null when no span matches.
export function operatorInteractiveReasonInBody(body) {
  for (const span of closeoutTailSpans(body)) {
    const reason = operatorInteractiveReason(span);
    if (reason) return reason;
  }
  return null;
}

// A Blocked-by clause that names another plan ("018", "plan 230", "230-P07-…", "1001-Other").
// `\d{3,}` (not `\d{3}`) so a 4-digit plan id (1000+) is recognized as a plan-blocker (plan 1002).
// Capturing + global (plan 1819 review fix): a single regex used for BOTH detection
// (via extractBlockedPlanIds(...).length > 0) and extraction, so there is no second,
// independently-maintained literal that can silently desync from this one. `/g` lets
// `matchAll` walk every blocker named on a MULTI-blocker line ("plan 1055 and plan
// 1541") instead of stopping at the first — `String.prototype.matchAll` clones the
// regex per the spec, so reusing this module-level `/g` instance across calls never
// leaks `lastIndex` state between them.
//
// plan 1836 parity check: this stays a SEPARATE extractor from blocked-by-lib.mjs's
// `referencedBlockerIds` on purpose. That helper GROUNDS every `\d{3,}` token against
// a real id→folder corpus (`statusOf(id) != null`) — safe only when the caller can
// afford to know the folder of EVERY plan id, not just the archived ones. This oracle
// deliberately reads only `ready/` (+ `archive/` on demand, see readArchivedIds below)
// for perf (archive/ is a scan of 1000s of files); grounding a bare `\d{3,})\b` token
// here without a full corpus would readmit exactly the prose-noise false-positives
// blocked-by-lib's own tests guard against ("~$227 remaining = 648 clinics"), while a
// syntactic id→folder-map build over the WHOLE plans tree (every status folder, not
// just ready/archive) would be a materially bigger fs-scan than this oracle does
// today — so `BLOCKED_PLAN_ID_RX`/`extractBlockedPlanIds` are kept (verified against
// every Blocked-by case in queue-drain.test.mjs, including the bare-id "009-common-
// services-backfill-v2" case that has no matching real plan file in these tests'
// fixtures and must still classify as 'blocked', which grounded extraction would miss).
// The shipped-vs-closed content test (readArchivedIds below) is kept in sync with
// blocked-by-lib.mjs's `isShippedArchiveContent` by PORTING the same regex verbatim
// rather than importing it: `queue-drain.mjs` is one of the coord scripts vetapp
// shares byte-identical with the tandapp sibling (coord.config.json coordShare.
// siblings[0].adopt), and `blocked-by-lib.mjs` is NOT on that adopt list — an import
// here would silently break the sibling's copy (ERR_MODULE_NOT_FOUND) the moment it's
// synced. Both regexes are asserted identical by test (queue-drain.test.mjs / plan
// 1836) so the two literals cannot quietly drift apart.
const BLOCKED_PLAN_ID_RX = /\b(\d{3,})-[A-Za-z]|\bplan[\s-]*(\d{3,})\b/gi;

// All plan ids named in a Blocked-by clause (sorted-stable insertion order, deduped).
// Empty array ⇒ no plan-shaped blocker was found (falls through to the operator/
// malformed checks below).
function extractBlockedPlanIds(text) {
  const ids = [];
  for (const m of text.matchAll(BLOCKED_PLAN_ID_RX)) {
    const id = m[1] ?? m[2];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
// A Blocked-by clause that points at the operator rather than a sibling plan.
const BLOCKED_OPERATOR_RX = /operator|green-light|account|export|supply|decision/i;
// A Blocked-by value that explicitly declares NO upstream block — an informational
// "Blocked-by: none (…)" / "n/a" / bare-dash line on a ready/ plan. Without this,
// such a line falls through to `malformed` and the plan is conservatively excluded,
// silently vanishing from the drain (plan 407 was dropped this way).
const BLOCKED_NONE_RX = /^(none|n\/?a)\b|^[—–-]\s*$/i;
// A struck-then-annotated Blocked-by line whose CLEARED remainder is judged ONLY
// after ID extraction and the operator check have both already failed to find
// anything live in it (plan 2174 review fix, sonnet-review CONFIRMED finding). This
// must NOT be folded into BLOCKED_NONE_RX above: testing `^cleared\b` up front, before
// extraction ever runs, would wrongly admit a multi-blocker line whose FIRST clause
// clears but a LATER un-struck clause names a genuinely open blocker —
// "~~2123~~ CLEARED (spec-sweep) — 2123 landed. Still blocked by plan 2200." — since
// the whole classification block would short-circuit before extractBlockedPlanIds
// ever sees the "plan 2200" reference. Checking it last, only once extraction+operator
// both come back empty, keeps that reference live.
const BLOCKED_CLEARED_RX = /^cleared\b/i;
// plan 2180: this stays a SEPARATE literal from blocked-by-lib.mjs's own
// `BLOCKED_BY_LINE_RE` on purpose (the same tandapp-sibling-adopt constraint as
// `ARCHIVE_COMPLETED_RX` below — this file cannot import blocked-by-lib.mjs), ported
// verbatim rather than merely widened: the prior single-line, bold-only
// `BLOCKED_BY_LINE_RX` (`content.match(...)`, non-global) read only the FIRST
// `**Blocked-by:**` line in a body, silently dropping a second line naming a
// genuinely open blocker — a real, if rare, shape (a spec-sweep/board-pass can leave
// a struck-then-cleared first line behind a second, un-struck line, `move-plan.mjs`'s
// own single-line-replace insertion can do the same). `blocked-by-lib.mjs`'s
// `blockedByLines`/`blockedByText` already join ALL such lines correctly (used by
// done-worktree.mjs's promoteWaitingBlocked and lint-stale-blocked.mjs), so this
// oracle adopts the SAME wider, global regex (accepts `>`-quoted and un-bolded forms
// too) instead of just adding `/g` to the narrower literal. Exported so a test can
// assert this stays byte-identical to blocked-by-lib.mjs's own `BLOCKED_BY_LINE_RE`
// — the two literals are independently maintained but must never drift apart.
// plan 2378 step 7: the trailing `:` / `**` delimiter is MANDATORY (the prior
// `(?=[:*\s]|$)` lookahead let a bare line-initial `Blocked-by ` + prose parse as a
// declaration — THIS oracle is what excluded plan 2378 as `malformed` on exactly that
// shape), and an optional parenthetical qualifier (`**Blocked-by (CLEARED):**`) is
// consumed before it so the 14 corpus plans using that form keep parsing. Full
// rationale on blocked-by-lib.mjs's copy; edit the two literals in lockstep.
export const BLOCKED_BY_LINE_RE =
  /^[ \t]*>?[ \t]*\*{0,2}Blocked-by(?:[ \t]*\([^)\n]*\))?(?:\*{1,2}:?|:\*{0,2})[ \t:]*(.*)$/gim;

// CLOUD_ENV_RUNGS (plan 2323): a PORTED-VERBATIM MIRROR of stamp-cloud-exec.mjs's
// own `CLOUD_ENV_RUNGS` — the same tandapp-sibling-adopt constraint as
// `BLOCKED_BY_LINE_RE` above forbids importing stamp-cloud-exec.mjs from here
// (queue-drain.mjs IS coordShare-adopted byte-identical by tandapp;
// stamp-cloud-exec.mjs is NOT, so an import would ERR_MODULE_NOT_FOUND the
// moment tandapp syncs). A test asserts the two literals stay deeply identical
// — see stamp-cloud-exec.mjs for the full per-field rationale (rank/exclude/
// excludeReason/pinned); this file only consumes `rank` (the lane-admission
// gate below) and `exclude`/`excludeReason` (the per-rung exclude classification
// and the `selectEligible` "lifecycle, not blocked" exclude-set membership).
export const CLOUD_ENV_RUNGS = [
  { value: 'trusted', rank: 0, exclude: null, excludeReason: null, pinned: false },
  {
    value: 'full',
    rank: 1,
    exclude: 'full-env',
    excludeReason:
      'cloudEnv: full — needs a Full-egress environment (live-host fetches / WebKit install); route to a full-lane drain (--env full)',
    pinned: false,
  },
  {
    value: 'webkit',
    rank: 1,
    exclude: 'webkit-env',
    excludeReason:
      'cloudEnv: webkit — needs live WebKit browser-render egress (DOM/HTML acceptance); ' +
      'a Full-egress lane provides it (plans 2206/2269) — route to a full-lane drain (--env full)',
    pinned: false,
  },
  {
    value: 'browser',
    rank: 2,
    exclude: 'browser-env',
    // plan 3754: this string is a PORTED-VERBATIM MIRROR of scripts/stamp-cloud-exec.mjs's
    // own CLOUD_ENV_RUNGS entry (that file is the authoritative copy; stamp-cloud-exec.test.mjs
    // asserts the two stay deeply identical) — the two literals are edited IN LOCKSTEP, as the
    // table header above requires. Leaving this one stale while the header comment said the
    // opposite was the gpt-review finding that caught it.
    excludeReason:
      'cloudEnv: browser — needs a lane with verified live headless-Chromium egress ' +
      '(a plain Full-egress environment has fetch/WebKit egress but not verified ' +
      'Chromium-TLS egress, see the 2241 evidence in ' +
      'docs/runbooks/cloud-drain-autonomy.md); since plan 3823 the browser body is ' +
      'the FLEET DEFAULT rather than a single-account exception — the account registry marks ' +
      'BOTH drain slots on all three live accounts `browser`, and the reconciler ' +
      'renders sonnet-browser.md / fable-browser.md for them. WHICH slots have that ' +
      'body pushed onto the live trigger, and which are enabled, are both LIVE state ' +
      'this literal must never assert: read the dated log in ' +
      'docs/runbooks/cloud-drain-landing.md, and ask ' +
      'node scripts/sync-trigger-bodies.mjs --dry-run which bodies are actually in ' +
      'sync. ' +
      'You are seeing this code because the run that produced it asked for a LOWER ' +
      'rung: re-run with --env browser, or route to a local/interactive session.',
    pinned: true,
  },
];

// The lane side of the admission gate (plan 2387, the other half of plan 2323):
// the CLI-flag-advertised `--env` LANES, table-driven the same way CLOUD_ENV_RUNGS
// tables the RUNG side. Each row is one legal `--env` CLI value and the highest
// rung rank a drain running that lane may admit. `trusted` (the flagless default,
// rank 0) is deliberately NOT a row here — it is the floor every lane admits, not
// a CLI value to validate — so this table only lists the lanes an operator can
// actually pass. Adding a hypothetical intermediate lane is one row here (its CLI
// value + rank) — `cloudEnvLaneRank` and the CLI's `--env` validation below both
// derive from it; neither needs an edit. `browser`'s rank is `Infinity`, not a
// literal max-of-today number (sonnet-review CONFIRMED finding on this same diff):
// browser is the TOP of the whole superset ladder by definition — it must admit
// every CLOUD_ENV_RUNGS rung, including one a later plan adds ABOVE today's
// highest rank, with no edit here. A finite literal (even one that happens to
// equal today's max rung rank) would silently re-exclude a future higher rung the
// moment CLOUD_ENV_RUNGS grew past it. WHY each lane sits where it does (the
// 2206/2269 WebKit-in-Full-egress proof, the 2241 Chromium-TLS evidence, and why
// no separate `webkitEnv` flag exists) is documented ONCE, on the CLOUD_ENV_RUNGS
// table above — not restated here. Unlike CLOUD_ENV_RUNGS this table is NOT
// mirrored in stamp-cloud-exec.mjs — that script stamps `cloudEnv` rungs, it has
// no `--env` CLI lane concept, so there is no sibling copy to drift from.
export const CLOUD_ENV_LANES = [
  { value: 'full', rank: 1 },
  { value: 'browser', rank: Infinity },
];

// `lane` is `undefined` (the flagless trusted default) | 'full' | 'browser' — the
// literal `flags.env` value, validated against CLOUD_ENV_LANES by the CLI parser
// below. An unrecognized value (shouldn't reach here past that validation, but
// kept conservative) ranks as the trusted floor rather than throwing.
function cloudEnvLaneRank(lane) {
  if (!lane) return 0;
  const found = CLOUD_ENV_LANES.find((l) => l.value === lane);
  return found ? found.rank : 0;
}

// The set of exclude codes any CLOUD_ENV_RUNGS row can produce (excluding the
// `null` trusted-floor row) — derived once so selectEligible's "lifecycle, not
// blocked" membership check (below) never drifts from the table: a future rung
// automatically joins this set without a new `||` clause.
const CLOUD_ENV_EXCLUDE_CODES = new Set(CLOUD_ENV_RUNGS.map((r) => r.exclude).filter(Boolean));

// Find the rung for a plan's parsed `cloudEnv` value (already lower-cased by the
// caller), or `undefined` when it's absent/unrecognized (a typo, or the literal
// `trusted`) — both cases the pre-2323 behavior left ungated (read as the
// trusted floor). Returns `null` (not the rung) when the rung IS admitted by
// the lane, so callers can do a single truthy check for "should exclude".
function cloudEnvExclusion(cloudEnv, { lane }) {
  const rung = CLOUD_ENV_RUNGS.find((r) => r.value === cloudEnv);
  if (!rung || !rung.exclude) return null; // absent/unknown/trusted — never gated
  if (rung.rank <= cloudEnvLaneRank(lane)) return null; // lane admits it
  return rung;
}

// SOL_FULL_EGRESS_CLOUD_SUPPORTED (plan 3341): whether a `sol`-lane plan's codex
// transport is PROVEN to work in a Full-egress cloud env. MEASURED 2026-08-22
// (plan 3377, env env_01XtbDomijQ4uMBXXk7tQCBo, session cse_0156b66b6jFMCCyztNX8n8Hg):
// transport itself is fine (`codex exec` authenticates off the configured codex-auth secret and
// round-trips a probe prompt cleanly), but `~/.codex/config.toml` — the file that
// holds the `[projects...]`/`[hooks.state...]` trust entries — does not exist at
// all in the sandbox, only `auth.json`. With zero trust entries, codex's
// hook-driven context injection (the project + umbrella CLAUDE.md, the wiki page)
// fires untrusted and silently does nothing: both a positive and a negative
// control prompt came back NOT_IN_MY_CONTEXT.
//
// LIFTED 2026-08-22 (plan 3380), which fixed the cause and re-measured the same
// differential IN a full-egress drain sandbox. `ensureCodexProjectTrust` in
// scripts/gpt-review.mjs now seeds the missing `~/.codex/config.toml` with a
// `[projects."<main checkout>"] trust_level = "trusted"` entry, and
// `codexHookTrustArgs` passes `--dangerously-bypass-hook-trust` per invocation;
// BOTH halves are required (measured: either alone fires zero hooks). Controls on
// the fixed sandbox: inside the checkout the injected wiki page answered COUNT=419,
// a byte-identical prompt from outside it returned NOT_IN_MY_CONTEXT, and the
// pre-fix baseline returned NOT_IN_MY_CONTEXT — so injection is live and the trust
// state is what moves it. This constant governs ONLY the environment axis below
// (solEnvExclusion) — the lane gate is a SEPARATE axis (plan 3461 made `sol`
// drain-claimable on both the sonnet and fable pools; see EXEC_LANE_TABLE.sol in
// scripts/coord/claim-plan-lib.mjs), so flipping this constant lifts the environment
// refusal (and the more specific footnote a `--cloud --env full` render shows)
// without touching lane admission at all.
//
// The seeding is deliberately FAIL-OPEN (an unresolvable checkout, an unwritable home dir,
// a config that already trusts something else) — so "supported" here asserts the environment
// is CAPABLE, not that every future run is guaranteed injected. That asymmetry is safe
// because of the paragraph above: this constant routes nothing on its own, so a bootstrap
// that fails degrades to a dark-but-working codex seat, never to a plan being admitted
// somewhere it cannot run. A seat that must PROVE injection runs the differential control in
// docs/runbooks/codex-claude-context-parity.md rather than trusting this flag.
const SOL_FULL_EGRESS_CLOUD_SUPPORTED = true;

// solEnvExclusion (plan 3341): the `sol` lane's OWN environment ladder — driven off
// the SAME CLOUD_ENV_LANES rank the cloudEnv axis above uses (cloudEnvLaneRank),
// never a parallel ladder, per this plan's explicit instruction. It is deliberately
// NOT keyed off CLOUD_ENV_RUNGS the way cloudEnvExclusion is: that table answers
// "which cloudEnv rung does THIS PLAN'S OWN stamp need", and a `sol` plan carries no
// such stamp — what gates it here is which environment THIS DRAIN INVOCATION is
// running in, i.e. exactly the `lane` value cloudEnvLaneRank already ranks (0 =
// trusted/limited-egress, the flagless --cloud default; 1 = full/webkit; Infinity =
// browser). Ladder (operator-specified, plan 3341 item 4): LOCAL admits
// unconditionally (cloudOnly is false there, so this function is never even
// called); trusted cloud (rank 0) is a HARD, PERMANENT refusal — codex exec cannot
// reach api.openai.com from a trusted/limited-egress env at all, independent of the
// constant above; Full-egress-or-above (rank >= 1) is refused only behind
// SOL_FULL_EGRESS_CLOUD_SUPPORTED, because whether codex exec's hook-driven context
// injection (the project + umbrella CLAUDE.md + wiki page a `sol` dispatch needs)
// actually FIRES inside a full-egress sandbox is unproven — codex hook trust keys on
// the main checkout's `.codex/hooks.json` path plus a per-event content hash, and an
// UNTRUSTED hook fires SILENTLY rather than loudly, so a false "it worked" is the
// failure mode a probe must rule out before this constant can flip (see
// docs/runbooks/codex-claude-context-parity.md, roughly :65-84). Returns null when
// admitted, else an { exclude, excludeReason } pair in the same shape
// cloudEnvExclusion returns, so both feed the same downstream branch shape.
// The two exclude codes solEnvExclusion below can produce, named ONCE here so its return
// statements and SOL_ENV_EXCLUDE_CODES further down reference the SAME string rather than
// two independently-typed literals that could drift apart on a rename (plan 3341 review —
// mirrors CLOUD_ENV_EXCLUDE_CODES's derived-not-duplicated intent for the cloudEnv axis).
// Not table-derived the way CLOUD_ENV_EXCLUDE_CODES is: solEnvExclusion's two branches carry
// genuinely different guard shapes (an unconditional rank-0 refusal vs. a
// SOL_FULL_EGRESS_CLOUD_SUPPORTED-gated one), so folding them into a CLOUD_ENV_RUNGS-style
// iterable table would contort the logic for two branches with no shared shape to iterate —
// naming the two codes once and referencing them from both call sites removes the actual
// drift risk (a typo'd/renamed code silently falling out of sync) without that contortion.
const SOL_ENV_EXCLUDE_TRUSTED = 'sol-env-trusted';
const SOL_ENV_EXCLUDE_FULL_UNPROVEN = 'sol-env-full-unproven';

function solEnvExclusion(lane) {
  const rank = cloudEnvLaneRank(lane);
  if (rank === 0) {
    return {
      exclude: SOL_ENV_EXCLUDE_TRUSTED,
      excludeReason:
        "execModel: sol — needs codex exec's transport (reachability of api.openai.com), which a " +
        'trusted/limited-egress cloud env cannot reach at all; route to LOCAL or a full-egress ' +
        'cloud env instead (a full-egress env clears this environment axis since plan 3380, and ' +
        'sol is drain-claimable there since plan 3461)',
    };
  }
  if (!SOL_FULL_EGRESS_CLOUD_SUPPORTED) {
    return {
      exclude: SOL_ENV_EXCLUDE_FULL_UNPROVEN,
      excludeReason:
        'execModel: sol — Full-egress cloud codex transport is PROVEN WORKING (measured 2026-08-22, ' +
        'plan 3377) and hook-driven context injection was PROVEN DARK there, but plan 3380 fixed the ' +
        'cause (scripts/gpt-review.mjs seeds the missing ~/.codex/config.toml project-trust entry and ' +
        'passes --dangerously-bypass-hook-trust) and re-measured injection LIVE in a full-egress ' +
        'sandbox; this branch is therefore unreachable while SOL_FULL_EGRESS_CLOUD_SUPPORTED is true ' +
        'and survives only for a deliberate re-pin (see docs/runbooks/codex-claude-context-parity.md) ' +
        '— route to LOCAL for now',
    };
  }
  return null;
}

// SOL_ENV_EXCLUDE_CODES (plan 3341): the two exclude codes solEnvExclusion can
// produce — mirrors CLOUD_ENV_EXCLUDE_CODES's role for the cloudEnv axis, so
// selectEligible's "lifecycle, not blocked" membership check below never drifts
// from this ladder either. DERIVED from the two named constants above, not a second
// pair of hand-typed literals (plan 3341 review).
const SOL_ENV_EXCLUDE_CODES = new Set([SOL_ENV_EXCLUDE_TRUSTED, SOL_ENV_EXCLUDE_FULL_UNPROVEN]);

// `~~struck text~~` spans in a Blocked-by line are semantically DELETED prose — a
// spec-sweep / board-pass "clears" a stale blocker by striking it through rather than
// erasing it (plan 2174). Strip every such span before classification so a struck
// plan id can never feed extractBlockedPlanIds (which would resurrect the plan-1819
// archived-blocker path with noisy `staleBlockedBy` warnings) and a struck bare-id
// line's remainder is judged on its own, un-struck text instead of being counted as
// unparseable. Any UN-struck plan reference in the remainder still extracts normally
// and still blocks — this only removes what the author already marked as deleted.
export const STRIKETHROUGH_RX = /~~[^~]*~~/g;
function stripStrikethrough(text) {
  return text.replace(STRIKETHROUGH_RX, ' ').trim();
}

// The raw **Blocked-by:** line text(s), ALL matched lines joined by ' ' (mirroring
// blocked-by-lib.mjs's `blockedByText`, plan 2180), or null when the plan carries no
// such line at all. Shared by parsePlanMeta and readReadyMetas's archive-scan
// pre-check below (plan 1819 review fix) so the two can never disagree about what
// counts as "this plan has a Blocked-by line". Joining (rather than reading only the
// first match) means a second Blocked-by line naming a still-open blocker is never
// invisible to classification just because an earlier line already cleared.
//
// Takes the BODY, never raw content (plan 2368 — same frontmatter-shadow class as the
// banner parses): the `^`-anchored per-line regex used to scan the frontmatter too, so
// a `summary:` written as a YAML block scalar containing a line starting "Blocked-by:"
// was picked up as the plan's own Blocked-by clause and wrongly excluded it as
// cross-plan-blocked. Both callers pass a `stripFrontmatter`ed body.
//
// plan 2446: also scoped to `closeoutTailSpans` — a `**Blocked-by:**` line inside a
// close-out tail declares a dependency of the deferred operator-local follow-up, not
// of the drainable body (same split-don't-sink reading this file's own
// operatorGatedByText/operatorInteractiveReasonInBody already apply, plan 2368).
// Splicing the retained spans back into one string is safe for THIS regex only
// (single-line-anchored, no cross-newline window) — unlike the two operator-gate
// regexes, which is why closeoutTailSpans returns spans rather than one string.
// blocked-by-lib.mjs applies the identical rule; it imports THIS function (plan
// 2446) plus tailOnlyBlockedByLines below (plan 2543) rather than keeping either as
// an independent copy — the tandapp-adopt constraint is one-directional (queue-
// drain.mjs cannot import FROM blocked-by-lib.mjs, see BLOCKED_BY_LINE_RE above),
// not mutual, so blocked-by-lib.mjs importing FROM this already-adopted module is
// safe and is exactly the pattern it already uses for closeoutTailSpans. Only
// `BLOCKED_BY_LINE_RE` itself stays a ported literal, pinned byte-identical by
// blocked-by-lib.test.mjs. Exported (plan 2543) for that import; callers in THIS
// file that scan the same body twice (parsePlanMeta) compute it once and pass the
// result to extractBlockedByLine/tailOnlyBlockedByLines instead of recomputing.
export function tailScopedBody(body) {
  return closeoutTailSpans(body).join('\n');
}
// plan 2543 review fix: named `…QD` (not the bare `rawBlockedByLines` blocked-by-lib.mjs
// already exports) so the two are never mistaken for a SHARED helper that quietly needs
// to stay in lockstep — they aren't shared, by the same one-directional tandapp-adopt
// constraint as `BLOCKED_BY_LINE_RE` above: this one-liner scans over THIS file's own
// ported `BLOCKED_BY_LINE_RE` copy, blocked-by-lib.mjs's scans over ITS OWN copy, and
// the two literals (not this loop) are what a cross-module test pins byte-identical.
// Not new duplication either: before this plan, the identical 3-line matchAll+trim loop
// was already written out THREE separate times inline in this file (once in
// extractBlockedByLine, twice in tailOnlyBlockedByLines) — this factors those three
// copies into the one function below, it does not introduce a new cross-file copy.
function rawBlockedByLinesQD(text) {
  const out = [];
  for (const m of text.matchAll(BLOCKED_BY_LINE_RE)) out.push(m[1].trim());
  return out;
}
// Takes the ALREADY tail-scoped body (tailScopedBody's output), not raw body — the
// caller computes it once and threads it here and into tailOnlyBlockedByLines below
// (plan 2543) instead of each callee re-deriving it from body.
function extractBlockedByLine(scopedBody) {
  const lines = rawBlockedByLinesQD(scopedBody);
  return lines.length ? lines.join(' ') : null;
}

// plan 2446: the tail-scoping's unsafe direction (a real blocker mis-parked in a
// close-out tail silently never gates) is answered with VISIBILITY, not silence — a
// `**Blocked-by:**` line present in the raw body but dropped by the tail scope above
// is surfaced as a loud per-plan note (`tailBlockedBySkipped` on the returned meta,
// carried into the oracle JSON the same way `staleBlockedBy` already is) instead of
// vanishing. Multiset diff (not a plain array subtract) so a line duplicated
// verbatim both inside and outside a tail is still counted correctly on each side.
// Exported (plan 2543) so blocked-by-lib.mjs imports this instead of keeping an
// independent copy of the same multiset-diff — see tailScopedBody above.
// `scopedBody` defaults to a fresh tailScopedBody(body) call so an external caller
// (blocked-by-lib.mjs, or a test) can still call this with just `body`; a caller
// that already computed it (parsePlanMeta) passes it to skip the recompute.
export function tailOnlyBlockedByLines(body, scopedBody = tailScopedBody(body)) {
  const all = rawBlockedByLinesQD(body);
  if (all.length === 0) return [];
  const retained = rawBlockedByLinesQD(scopedBody);
  const remaining = new Map();
  for (const l of retained) remaining.set(l, (remaining.get(l) || 0) + 1);
  const out = [];
  for (const l of all) {
    const n = remaining.get(l) || 0;
    if (n > 0) remaining.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

// --- pure: cost forecast ------------------------------------------------------

// The real banner is always a `💰`-marked line, but its formatting varies
// widely across the corpus: "> 💰 **Cost forecast:** …", "**💰 Cost
// forecast:**" (no blockquote), "> **💰 Cost forecast:**" (emoji inside the
// bold run), a bracketed qualifier like "(FIRMED)", OR — common, ~8+ archived
// plans — no bold markup at all ("> 💰 Cost forecast: ~$0 — …",
// "💰 Cost forecast: ~1 short session."). Round 2 of this plan's review
// tightened the anchor to require a `**` bold-open alongside 💰, reasoning
// that plain prose could otherwise combine "cost forecast" with an unrelated
// 💰 on one line; round 3 caught that this BROKE every real non-bold banner
// (they'd fall through to the unguarded loose fallback, reopening exactly the
// shadowing bug this plan exists to close, for the more common shape). A
// corpus check settled it: comparing this 💰-shares-a-line anchor against the
// bold-required one across all 2339 plan files under docs/superpowers/plans/
// found ZERO behavioral differences — the round-2 "adversarial prose" case
// and the round-3 "non-bold regression" case are BOTH synthetic, but the
// bold requirement's failure mode sits on a real, currently-used banner
// style while the loose anchor's failure mode requires a coincidence
// (💰 emoji + the literal phrase "cost forecast" in ordinary prose) nothing
// in the corpus does today. Anchoring on 💰-shares-a-line, unqualified, is
// the corpus-validated choice. The trailing peel (`[:*\s]*` then
// capture-to-end-of-line) is unchanged from the pre-2360 loose match, so
// every banner shape's VALUE — including one written inside a bold run, e.g.
// "**Cost forecast: ~$0**" — still resolves correctly regardless of where
// bold formatting (if any) falls.
// Shared trailing peel — "Cost forecast", any run of `:`/`*`/whitespace (the
// label's own punctuation), then everything to end-of-line is the value. Used
// by BOTH the anchored primary match and the loose fallback below so the two
// can never silently diverge on how a value is extracted once a banner LINE
// is found (only how that line is found differs between them).
const COST_LABEL_TAIL_SRC = 'Cost forecast[:*\\s]*\\s*(.+?)\\s*$';
const ANCHORED_COST_BANNER_RX = new RegExp(`^.*💰.*${COST_LABEL_TAIL_SRC}`, 'imu');
const LOOSE_COST_BANNER_RX = new RegExp(COST_LABEL_TAIL_SRC, 'im');

// Scan `text` for dollar/ceiling figures and return the DOMINANT (max-valued)
// one as { usd, over }, or null when the text carries no figure at all.
// Shared by the split-banner Cash/Claude slices (parseCost below) and the
// legacy whole-line scan, so the two paths can never diverge on what counts
// as a figure.
function extractDominantFigure(text) {
  // Collect every figure, tagged by whether it is a ceiling bound. Two scans:
  const figures = []; // { usd:number, over:boolean }
  //  1. dollar figures, incl. BOTH ends of a "$X–Y" / "$X–$Y" range
  //     ("$3", "$0.40", "$6–18", "$8–$10").
  const DOLLAR_RX = /\$\s*(\d+(?:\.\d+)?)(?:\s*[–—-]\s*\$?\s*(\d+(?:\.\d+)?))?/g;
  for (let m; (m = DOLLAR_RX.exec(text)); ) {
    figures.push({ usd: Number(m[1]), over: false });
    if (m[2] != null) figures.push({ usd: Number(m[2]), over: false });
  }
  //  2. ceiling figures ("> $5", "≥ 15") — the $ is optional in this form.
  const CEIL_RX = /[>≥]\s*\$?\s*(\d+(?:\.\d+)?)/g;
  for (let m; (m = CEIL_RX.exec(text)); ) {
    figures.push({ usd: Number(m[1]), over: true });
  }
  if (figures.length === 0) return null;
  const usd = Math.max(...figures.map((f) => f.usd));
  // `over` iff the dominant (max-valued) figure came from a ceiling match.
  const over = figures.some((f) => f.usd === usd && f.over);
  return { usd, over };
}

// Parse the text following a "Cost forecast:" line into a spend signal the
// driver can branch on. Returns { raw, usd, over, unknown, split, claude }:
//   usd      — the gated figure. On a legacy (unsplit) banner, the MAX of
//              every dollar/ceiling figure in the text (0 when the plan
//              declares no LLM spend) — max-of-figures, NOT first-figure:
//              this parser feeds pause-gates (drain `shouldPauseForCost`, $5;
//              `lint-plan-cost-forecast`), and UNDER-reporting is the dangerous
//              direction — a plan whose true spend is >$5 but parses low would
//              skip the pause and (Phase 3) auto-land, spending unforecast money.
//              So we take the worst-case figure: a leading "render $0" can't
//              mask a later "$6–18", and a "$8–$10" range resolves to its high
//              end (10). On a SPLIT banner (plan 3748), `usd` is narrowed to
//              the max figure inside the **Cash** part only — a prose-tail or
//              Claude-axis figure can no longer trip the gate.
//   over     — the dominant (max-valued) Cash-axis figure was a ceiling
//              ("> $5" / "≥ $5")
//   unknown  — no Cash-axis figure at all and no "no LLM" phrase (TBD /
//              prose-only / absent), OR a malformed split (see `split` below)
//   split    — true iff the banner used the `Cash … · Claude …` grammar
//   claude   — `{ usd, over }` for the Claude axis on a split banner
//              (informational only — never gates), else `null`
export function parseCost(text) {
  if (text == null) {
    return { raw: null, usd: null, over: false, unknown: true, split: false, claude: null };
  }
  const raw = String(text).trim();
  const lower = raw.toLowerCase();

  // Split-grammar detection: case-insensitive `Cash` and `Claude` LABELS —
  // anchored to where the grammar actually allows them (line-start for Cash;
  // line-start or right after the ' · ' separator for Claude), not a bare
  // \bclaude\b anywhere on the line. A loose anywhere-on-the-line match would
  // misfire on ordinary legacy prose that mentions a "claude -p" fan-out
  // (extremely common in this corpus — e.g. "$0 setup, then ~$12 of claude
  // -p"), which carries no "Cash" label at all and must keep parsing via the
  // legacy max-of-figures path below, not fall into the split/malformed branch.
  const CASH_LABEL_RX = /^cash\b/i;
  const CLAUDE_LABEL_RX = /^claude\b/i;
  // A LONE label (the other axis absent) counts as a half-written split ONLY
  // when the part is NOTHING BUT that label and its figure — `Claude ~$4`,
  // `Cash $0`, `Cash > 5`. Ordinary legacy prose that merely OPENS with the
  // word (`Claude -p fan-out … ~$12`, `Cash outlay ~$3 for Places`,
  // `Claude $85 fan-out; no cash cost`) keeps parsing on the legacy path.
  // Anchoring on "the whole part is label+figure" is what separates the two:
  // a genuine half-written split has nothing after the figure, while prose
  // always continues. Getting this wrong is repo-wide in the dangerous
  // direction — an unparseable banner both pauses the drain and makes
  // lint-plan-cost-forecast block every session's next push. Only the lone
  // case consults this: once BOTH labels are present the ` · ` grammar is
  // unambiguous, and a label there with no figure is malformed by design.
  const LONE_LABEL_FIGURE_RX =
    /^[a-z]+\s*(?:[~>≥]\s*)?\$?\s*\d+(?:\.\d+)?(?:\s*[–—-]\s*\$?\s*\d+(?:\.\d+)?)?\s*$/i;
  const hasCash = CASH_LABEL_RX.test(raw);
  let claudeIdx = -1;
  if (CLAUDE_LABEL_RX.test(raw)) {
    claudeIdx = 0; // a Claude-only malformed split ("Claude ~$4", no Cash at all)
  } else {
    const dotMatch = raw.match(/·\s*/);
    if (dotMatch) {
      const afterDot = dotMatch.index + dotMatch[0].length;
      if (CLAUDE_LABEL_RX.test(raw.slice(afterDot))) claudeIdx = afterDot;
    }
  }
  const hasClaude = claudeIdx !== -1;

  if (hasCash && hasClaude) {
    // Slice BEFORE extracting figures — a prose tail (e.g. "… at $0.025/call")
    // must never leak into either axis's max. Cash runs from its label (line
    // start) to the ' · ' separator (or the Claude label, if the separator is
    // missing); Claude runs from its label to the ' — ' prose break (or end
    // of line).
    const cashIdx = 0;
    const dotIdx = raw.indexOf(' · ');
    const cashEnd = dotIdx !== -1 && dotIdx < claudeIdx ? dotIdx : claudeIdx;
    const cashPart = raw.slice(cashIdx, cashEnd);
    const dashIdx = raw.indexOf(' — ', claudeIdx);
    const claudePart = dashIdx !== -1 ? raw.slice(claudeIdx, dashIdx) : raw.slice(claudeIdx);

    const cashFigure = extractDominantFigure(cashPart);
    const claudeFigure = extractDominantFigure(claudePart);

    // A half-written split (either axis present with no figure after it) is
    // malformed, not a silent fall-back to a legacy max-of-figures read —
    // otherwise an author writing "Cash $0 · Claude" with no number could
    // have the gate pick up a stray figure from the prose tail.
    if (cashFigure == null || claudeFigure == null) {
      return { raw, usd: null, over: false, unknown: true, split: true, claude: null };
    }
    return {
      raw,
      usd: cashFigure.usd,
      over: cashFigure.over,
      unknown: false,
      split: true,
      claude: { usd: claudeFigure.usd, over: claudeFigure.over },
    };
  }

  if (hasCash !== hasClaude) {
    // Exactly one label present. It is a half-written split ONLY if a figure
    // follows the label directly (`Claude ~$4`, `Cash $0`); otherwise the word
    // is just the opening of legacy prose (`Claude -p fan-out …`, `Cash outlay
    // ~$3 …`) and falls through to the legacy path below, unchanged.
    const loneLabelPart = hasCash ? raw : raw.slice(claudeIdx);
    if (LONE_LABEL_FIGURE_RX.test(loneLabelPart)) {
      return { raw, usd: null, over: false, unknown: true, split: true, claude: null };
    }
  }

  // Neither label present: today's legacy single-figure grammar, byte-identical.
  const figure = extractDominantFigure(raw);
  if (figure != null) {
    return { raw, usd: figure.usd, over: figure.over, unknown: false, split: false, claude: null };
  }

  // No figure: "no LLM spend" is an explicit prose zero; anything else is unknown.
  if (/\bno\s+llm\b/.test(lower)) {
    return { raw, usd: 0, over: false, unknown: false, split: false, claude: null };
  }
  return { raw, usd: null, over: false, unknown: true, split: false, claude: null };
}

// --- pure: per-plan metadata --------------------------------------------------

// Parse one plan file's coordination metadata. `filename` is the basename
// (e.g. "231-Other-autonomous-ready-queue-drain.md"); `content` is its body.
//
// exclude is the gate decision: null (eligible) | 'operator' | 'blocked' |
// 'blocker_archived_unshipped' | 'malformed' | 'cloud'. operator-gating (body
// language) takes precedence over a Blocked-by line, since a ready/ plan can be
// operator-gated without ever having been filed into waiting-operator/ (e.g. 221).
//
// `cloudOnly` (plan 1781): when true (the CLI's --cloud mode), a plan not
// explicitly stamped `cloudExec: true` is excluded FIRST (exclude='cloud'),
// ahead of every other gate — in the cloud, cloud-safety is the primary
// admission question. Off by default, so the local drain's selection is
// byte-identical to the pre-1781 behaviour.
//
// `fableLane` (plan 1810): when true (the CLI's --lane fable mode), the drain is
// requesting the fable lane instead of the (default) sonnet lane. Pre-3341 this was
// a straight boolean invert (`execModel !== 'fable'` vs `execModel === 'fable'`),
// which worked only because there were exactly two lanes and every plan was in
// exactly one of them. Plan 3341 added `sol` as a third lane; plan 3461 made it
// drain-claimable but deliberately did NOT invent a `--lane sol` CLI value, since
// no plan ever stamps `execModel: sol` because a session asked for that specific
// lane — a `sol` plan is admitted under BOTH `--lane sonnet` and `--lane fable`
// requests (see the two-step gate below: `sol`'s `hasNativeRun: false`
// (EXEC_LANE_TABLE, claim-plan-lib.mjs) exempts it from the
// `execLaneInfo.lane !== requestedLane` comparison entirely, so it never needs a
// third CLI value of its own). `requestedLane` itself still only ever takes the two
// values ('fable' when fableLane, else 'sonnet') — see the two-step gate below.
// Off by default, so the default pool's selection is byte-identical to the
// pre-1810 behaviour for every sonnet/fable plan; a `sol` plan is now admitted
// under either --lane value (plan 3461).
//
// `archivedIds` (plan 1819, narrowed to shipped-only by plan 1836): a Set of plan-id
// STRINGS (e.g. "1760") found under `docs/superpowers/plans/archive/` AND carrying the
// `**Status:** ✅ COMPLETED` stamp — precomputed once by the caller (readReadyMetas) so
// this function stays pure (no fs read here). Defaults to an empty Set, so omitting it
// is byte-identical to pre-1819 behaviour (every plan-shaped Blocked-by excludes, as
// before).
// `archivedUnshippedIds` (plan 2496): the sibling Set — plan-id STRINGS found under
// `archive/` WITHOUT the shipped stamp (🗄️ SUPERSEDED, abandoned, or no terminal
// `**Status:**` line at all). Disjoint from `archivedIds` by construction (readArchivedIds
// below partitions one archive/ scan into the two sets). Used ONLY to give the
// archived-but-not-shipped case its own named exclude reason
// (`blocker_archived_unshipped`) instead of falling into the same generic 'blocked'
// bucket as a blocker that is simply still open in ready/ — see the classification
// block below. Defaults to an empty Set, so omitting it is byte-identical to
// pre-2496 behaviour (such a blocker still excludes, just under the older generic
// 'blocked' reason).
// `batchHeldBy` (plan 2459 Task 2): a Map of plan-id STRING -> the slug of the RUNNABLE
// batch holding it (batch-paths.mjs's readRunnableBatchMembers), precomputed once by
// readReadyMetas — same shape as archivedIds above. Defaults to an empty Map, so
// omitting it never gates (byte-identical to pre-2459 behaviour).
// `lane` (plan 1925, superset since plan 2003; extended 2250/2313; generalized to
// a data-driven RUNG ladder by plan 2323, and to a data-driven LANE table by plan
// 2387): the single CLI-advertised `--env` lane value (`undefined` | 'full' |
// 'browser') gating the `cloudEnv` axis, applied via `cloudEnvExclusion`/
// `cloudEnvLaneRank`. Inert without `cloudOnly` (the axis routes between CLOUD
// environment kinds only). Which rungs each lane admits, and why, lives on the
// `CLOUD_ENV_RUNGS` table above; which CLI values are legal lanes, and their
// ranks, lives on `CLOUD_ENV_LANES` — the single places that rationale is written.

// THE plan-basename id shape (plan 3111 round-3 findings 4/5/6 — CONFIRMED by three angles).
// `\d{3,}-(?=[A-Za-z])`: accepts 4-digit ids (plan 1000+) while keeping a full-date legacy plan
// ("2026-05-16-…") id-less (plan 1002) — the same discipline `ORIGIN_EXECUTED_BRANCH_RXS` below
// applies to BRANCH names, and the two must agree by construction: this module derives a plan's id
// from its FILENAME and the branch id from origin's HEADS, then compares them. Exported because
// `plan-adopt-branch.mjs` needs exactly this predicate to decide whether a plan it is about to
// stamp is one the origin map can even represent — round 2 gave it a local copy of this regex,
// which is a fourth spelling of a rule that must never have two. Change it here and every
// consumer follows.
export const PLAN_BASENAME_ID_RX = /^(\d{3,})-(?=[A-Za-z])/;

export function parsePlanMeta(
  filename,
  content,
  {
    cloudOnly = false,
    fableLane = false,
    lane = undefined,
    archivedIds = new Set(),
    archivedUnshippedIds = new Set(),
    batchHeldBy = new Map(),
    // plan 2543 review fix: readReadyMetas' needsArchiveCheck pass already computes
    // this exact plan's tail-scoped body (to decide whether its Blocked-by line names
    // a plan id) before calling parsePlanMeta for the SAME content — without this,
    // parsePlanMeta always re-derives it from scratch, so the corpus scan below still
    // ran closeoutTailSpans twice per ready/ file, the exact cross-function duplication
    // this plan's own comment at readReadyMetas flagged but left unfixed. Optional and
    // unvalidated against `content` (like `archivedIds` above, callers are trusted) —
    // omitted by every OTHER caller (direct parsePlanMeta calls in tests, etc.), which
    // fall back to computing it themselves exactly as before.
    precomputedScopedBody = null,
    // plan 2678: the optional one-level category subfolder this plan sits in below its
    // status folder (`ready/infra/…` → `'infra'`), or null when flat. Carried purely so
    // `toItem` can emit the plan's REAL path — the drain reads that path to open the file.
    category = null,
    // plan 3962 P1: the cloudRepos axis's valid-key set, supplied by the CALLER (main()
    // derives it from coord.config.json's `cloudRepos` rows; direct callers/tests supply
    // their own) — this module carries no project registry of its own. Default `[]` means
    // every cloudRepos token is unknown and gets dropped, the same as an unconfigured repo.
    validCloudRepoKeys = [],
  } = {},
) {
  const base = filename.replace(/\.md$/, '');
  const idM = base.match(PLAN_BASENAME_ID_RX);
  const id = idM ? Number(idM[1]) : Infinity;

  // Frontmatter-shadow guard (plan 2360): a plan's YAML `summary:` can quote a
  // banner verbatim (SEED-WRITE — plan 723 — or, as of this round, Cost
  // forecast), so BOTH banner parses below scan the BODY, never the leading
  // frontmatter block. Computed once and threaded through — stripFrontmatter
  // is a cheap line-split, but re-running it twice per plan scanned across the
  // whole ready/ pool is pure duplicated work for no benefit (review finding).
  const body = stripFrontmatter(content);

  // THE shared seed-banner parse (build-index-lib.mjs, plan 1324) — the same
  // single authority docs/INDEX.md renders from, so the mutex and the INDEX
  // bullet can never disagree about a banner (the 2026-07-02 1278/1282 drift).
  // 'yes' | 'no' | 'maybe' | null; null = banner missing, which isSeedWrite
  // below still treats conservatively as seed-write (unknown must not land
  // during a LANDING) — the one deliberate divergence from the 🟩 display
  // default, documented at readSeedMarker.
  const seedWrite = readSeedWriteValue(content, body);

  // plan 2543: computed once (or reused from the caller via precomputedScopedBody
  // above) and threaded through both calls below (extractBlockedByLine needs the
  // scoped body; tailOnlyBlockedByLines needs both the raw and the scoped body to
  // diff) instead of each independently re-deriving it from `body` — halves the
  // closeoutTailSpans work per plan in this hot corpus-scanning path.
  const scopedBody = precomputedScopedBody ?? tailScopedBody(body);
  const blockedBy = extractBlockedByLine(scopedBody);
  // plan 2174: computed once here (not per-branch) so the classification block below
  // never has to call stripStrikethrough twice on the same string (sonnet-review
  // simplification finding) — `null` when there is no Blocked-by line at all.
  const strippedBlockedBy = blockedBy ? stripStrikethrough(blockedBy) : null;
  // plan 2446: a loud note (never a gate) for a **Blocked-by:** line the tail scope
  // above dropped — see tailOnlyBlockedByLines. `null` when nothing was dropped.
  const tailSkipped = tailOnlyBlockedByLines(body, scopedBody);
  const tailBlockedBySkipped = tailSkipped.length
    ? `close-out-tail Blocked-by line(s) NOT counted toward the drainable body (plan 2446): ${tailSkipped.join('; ')}`
    : null;

  // Primary match: the 💰-anchored banner line. Fall back to the pre-2360
  // loose phrase match ONLY when no anchored banner line exists anywhere in
  // the body — scoped to the body too (review finding: the fallback used to
  // still scan raw `content`, so a legacy plan with no real banner but a
  // frontmatter `summary:` mentioning the phrase was still shadowed via this
  // path), so pre-banner-era legacy plans keep parsing by the same rule, just
  // never against metadata.
  const costM = body.match(ANCHORED_COST_BANNER_RX) || body.match(LOOSE_COST_BANNER_RX);
  const cost = parseCost(costM ? costM[1] : null);

  // Operator-gating (plan 2368 — two changes, both in the frontmatter-shadow class
  // plan 2360 opened):
  //
  // 1. SCOPE. Both regexes scan the body's `closeoutTailSpans` — no frontmatter, no
  //    close-out tails — never raw `content`. Before this, a frontmatter `summary:`
  //    combining "operator" with a "suppl*" word inside OPERATOR_GATE_RX's 40-char
  //    window (which crosses newlines, so it can even span frontmatter→body) silently
  //    dropped the plan from BOTH drain lanes, and a `split-don't-sink` close-out tail
  //    marked its own drainable body undrainable (live: 2403). See
  //    stripCloseoutTailSections for why the tail scope-out is structural.
  //
  // 2. A DECLARED-INTENT STAMP beats the text heuristic. `operatorGated: false` in
  //    frontmatter means "this plan needs no operator" even if its prose *describes*
  //    operator-gating; `operatorGated: true` forces the gate on. This is the only
  //    mechanism that separates a plan that NEEDS an operator from one that TALKS
  //    ABOUT operator-gating — plan 2368's own Background sentence quotes the gate
  //    phrases to describe the defect, i.e. writing down what the bug is trips the
  //    bug, and no amount of regex narrowing fixes that class.
  //
  //    Deliberately NOT done: stripping fenced/inline-code and double-quoted spans
  //    before scanning (the middle option in 2368's scope list). It reads well for
  //    OPERATOR_GATE_RX but is a FALSE-NEGATIVE hazard for OPERATOR_INTERACTIVE_RX in
  //    the dangerous direction: real plans that genuinely need the operator's browser
  //    write the tool name in backticks (`claude-in-chrome`), so code-span stripping
  //    would let operator-dependent plans into an unattended drain. A wrong stamp is
  //    at least a deliberate, auditable act; a silently-stripped span is not.
  //
  //    `false` suppresses BOTH gates, the interactive one included — that is the point
  //    (this plan's own prose trips both), but it means the stamp asserts "no
  //    live-session dependency either", a stronger claim than it looks. So it is
  //    SURFACED on the meta (and from there into the oracle JSON via toItem) rather
  //    than applied silently: a wrong stamp reads as `operatorGated: "false"` beside a
  //    plan a human can check, instead of a plan that inexplicably drains (review
  //    finding). Nothing writes this key today; the runbook records that it is a
  //    deliberate per-plan act.
  const operatorGatedFm = readFrontmatterScalar(content, 'operatorGated');
  const operatorGatedStamp = operatorGatedFm ? operatorGatedFm.toLowerCase() : null;
  const operatorGated =
    operatorGatedStamp === 'false'
      ? false
      : operatorGatedStamp === 'true' || operatorGatedByText(body);
  const interactiveReason =
    operatorGatedStamp === 'false' ? null : operatorInteractiveReasonInBody(body);

  // Plan-lifecycle stage/execModel gates (plan 1292). These are read from the
  // YAML FRONTMATTER ONLY — never the filename. The `NNNN-FABLE-…` filename
  // segment (work item 4b) is a display convenience for the operator's file
  // tree; the frontmatter `execModel:`/`stage:` fields are the single source of
  // truth the drain enforces. readFrontmatterScalar returns '' when the
  // frontmatter block or key is absent (and strips a trailing YAML inline
  // comment — plan 1292 bugfix: a raw readFrontmatterKey read left a comment,
  // e.g. plan 1015's `execModel: fable # umbrella tracker…`, embedded in the
  // value, so it never equalled the bare 'fable' this gate compares against and
  // the plan silently escaped the fable exclusion), which we normalize to null
  // below.
  //
  // Grandfather (must hold, per the plan's Conventions): a plan minted before
  // this gate landed has no `execModel`/`stage` fields at all — absent execModel
  // is treated as 'sonnet' (eligible) and absent stage is treated as 'specced'
  // (eligible), so the existing ready/ pool is never bounced by this change.
  const execModelFm = readFrontmatterScalar(content, 'execModel');
  const execModel = execModelFm ? execModelFm.toLowerCase() : null;
  // execLaneInfo / execLaneMalformed (plan 3341): resolveExecLane throws on an
  // unrecognized execModel value BY DESIGN — the whole point of a fail-closed
  // lookup is that a typo can never silently fall into the sonnet pool. But
  // letting that throw escape here would crash the WHOLE ready/ scan over one
  // plan's typo — the exact "one bad plan takes down every other plan's
  // selection" failure mode the malformed-Blocked-by handling below (and
  // cloudEnv's unrecognized-value handling above) both deliberately avoid.
  // Caught once, right where execModel is read, into a `null`-on-bad-value pair
  // the exclude chain below consumes — the malformed branch excludes THIS plan
  // only, conservatively, same as an unparseable Blocked-by line does.
  let execLaneInfo = null;
  let execLaneMalformed = null;
  try {
    execLaneInfo = resolveExecLane(execModel);
  } catch (err) {
    execLaneMalformed = err && err.message ? err.message : String(err);
  }
  const stageFm = readFrontmatterScalar(content, 'stage');
  const stage = stageFm ? stageFm.toLowerCase() : null;
  const specReviewFm = readFrontmatterScalar(content, 'specReview');
  const specReview = specReviewFm || null;
  // plan 1781: the cloud-safety axis. Read from frontmatter ONLY (like execModel/
  // stage). 'true' | 'false' | null (absent — never stamped). In --cloud mode
  // anything but an explicit 'true' is excluded (see the gate below); off-cloud
  // the value is carried for reporting but gates nothing.
  // plan 2421 (sonnet-review fix [2]): the ONE normalization — read ONCE via the shared
  // readCloudExecStamp (the richer enum: 'true' | 'false' | 'unset' | 'no-frontmatter' | a
  // verbatim-lowercased typo). `cloudExec` (this function's own exclusion-gate value, and every
  // caller's pre-existing null-means-absent contract) is DERIVED from it rather than an
  // independent second readFrontmatterScalar call + frontmatter-fence rescan — the two-read
  // shape review found here duplicated the exact same parse this line already does.
  const cloudExecStamp = readCloudExecStamp(content);
  const cloudExec =
    cloudExecStamp === UNSET || cloudExecStamp === NO_FRONTMATTER ? null : cloudExecStamp;
  // plan 1925 (values extended by plans 2250/2313): the cloud ENV-routing axis.
  // 'trusted' | 'full' | 'webkit' | 'browser' | null (absent — reads as trusted,
  // the stamp-tool contract). Only the literal ladder values route upward; any
  // other value (explicit 'trusted', a typo) stays in the trusted pool — the
  // same stall-not-damage failure mode an unstamped cloudExec has. Gates only
  // under cloudOnly; carried for reporting otherwise.
  const cloudEnvFm = readFrontmatterScalar(content, 'cloudEnv');
  const cloudEnv = cloudEnvFm ? cloudEnvFm.toLowerCase() : null;
  // The rung this plan's cloudEnv is excluded by, given the CURRENT `lane` value
  // — `null` when the lane admits it (or cloudEnv is absent/unrecognized).
  // Computed once here (not per-branch) for the same reason `strippedBlockedBy`
  // is precomputed above: the gate below and this value must never re-derive
  // independently.
  const cloudEnvRung = cloudOnly ? cloudEnvExclusion(cloudEnv, { lane }) : null;
  // solEnvRung (plan 3341): the sol lane's OWN environment refusal (see
  // solEnvExclusion above) — `null` when admitted (every LOCAL invocation,
  // where cloudOnly is false, never reaches this) or when the plan isn't a
  // `sol`-lane plan (`execLaneInfo` is null on a malformed execModel, guarded
  // here too — that case excludes earlier via `execLaneMalformed` instead).
  // Precomputed once for the same reason cloudEnvRung is: the gate below and
  // this value must never re-derive independently.
  const solEnvRung =
    cloudOnly && execLaneInfo && execLaneInfo.needsCodexTransport ? solEnvExclusion(lane) : null;
  // requestedLane (plan 3341): the ONE other lane a drain can ask for today —
  // 'fable' via --lane fable, 'sonnet' otherwise. `sol` is never requestable
  // here — no --lane sol exists, and plan 3461 deliberately did not add one
  // (see the fableLane comment above): a `sol` plan is lane-agnostic and is
  // admitted under BOTH requested values instead. So `requestedLane` only
  // ever takes one of these two values, even though three lanes are
  // drainClaimable.
  const requestedLane = fableLane ? 'fable' : 'sonnet';
  // plan 2577: the extra-repo axis — which registered repos beyond vetapp the drain must
  // clone to work this plan (`cloudRepos: hobby-main`). SURFACED, never GATED (decision
  // D4): the oracle cannot see which secrets a given drain environment holds, and a lane
  // flag whose value would be identical on all four routines buys nothing — so the
  // capability check belongs where the environment is actually visible, in the drain
  // session at runtime, before it claims. Parsed non-strict: an unknown key is dropped
  // rather than thrown, because one typo in one plan body must never take the whole
  // selection down (the same report-don't-die posture cloudEnv's unrecognized values get).
  const cloudRepos = parseAndValidateTokenList(
    readFrontmatterScalar(content, 'cloudRepos'),
    validCloudRepoKeys,
  );
  // plan 3111: the adopt-hand-off axis — the branch a taker must CONTINUE rather than restart,
  // written by scripts/plan-adopt-branch.mjs at every entry into ready/ and read here so
  // selectEligible's carve-out (see its `gated` block) can match it against what origin carries.
  // Parsed unconditionally (not only under cloudOnly) so a non-cloud caller still SURFACES it on
  // the item — the stamp is the plan's own declaration that a branch exists to inherit, and the
  // local drain driver hands the same adopt instruction to its worker (drain-run.mjs). Empty
  // string ⇒ null, matching every other optional scalar on this record.
  const adoptBranch = readFrontmatterScalar(content, 'adoptBranch') || null;
  // plan 2328: the operator priority stamp — `priority: high` (stamped via edit-plan.mjs,
  // spec 2026-07-24). It is a SORT key only (first key in selectEligible, ahead of the
  // 🟩/🟥-cost-id chain) — it never gates: an excluded priority plan stays excluded, and the
  // seed-write LANDING mutex / pause-on-unknown-cost behaviour are untouched.
  // plan 2520: three legal tiers now — `high` / `medium` / `low`, `medium` the DEFAULT (byte-
  // equivalent to unstamped). `priorityTier` feeds the sort comparator's 3-way split below;
  // `priority` (the pre-2520 boolean the oracle JSON's `item.priority` field and every OTHER
  // consumer already key on) stays a `high`-only flag, byte-identical to before — routed through
  // the ONE shared normalization (build-index-lib.mjs) so this can never re-drift from the INDEX
  // ⚡ marker / board row flag / done-worktree's queue-priority check again.
  const priorityTier = readPriorityTier(content);
  const priority = priorityTier === 'high';
  // Same shared gate move-plan.mjs's assertSpecReviewOk uses (build-index-lib.mjs;
  // plan 1292 bugfix — this used to be an inline `stage === 'stub' && !specReview`
  // compare that couldn't drift from move-plan's rule, and now literally can't).
  // Calls the FromValues variant (not specReviewGateError) — stage/specReview
  // are already parsed above for this record, so this avoids re-parsing the
  // same content's frontmatter a second time just to run the gate.
  const specGateMsg = specReviewGateErrorFromValues(
    stage,
    specReview,
    filename,
    'queue-drain: excluding',
  );

  // exclude is the gate; excludeReason is a human string surfaced in the drain's
  // closing skip-list (plan 443). Precedence (first match wins): in --cloud mode the
  // cloudExec gate is checked FIRST (plan 1781 — cloud-safety is the primary cloud
  // admission question), then the cloudEnv routing gate (plan 1925/2003 — the
  // trusted lane is a strict subset that excludes cloudEnv: full; the full lane is
  // a superset that excludes nothing on this axis); then operator-gating language,
  // then operator-interactive markers, then the stage/execModel gates, then a
  // Blocked-by line.
  let exclude = null;
  let excludeReason = null;
  // plan 1819: set when a Blocked-by line names a plan that turns out to be
  // archived (stale line, plan stays eligible) — see the branch below. Surfaced
  // on the returned meta (and from there into the oracle JSON via toItem) so a
  // sweep/human can clean the body; null in every other case.
  let staleBlockedBy = null;
  // plan 2556: set ONLY on a plan the batch hold excludes — `{ slug, otherwise }`,
  // where `slug` is the holding batch and `otherwise` is what this plan would have
  // been excluded for BUT FOR the hold (`null` meaning "otherwise eligible"). Null on
  // every plan the hold does not touch.
  //
  // Both halves are load-bearing for selectEligible's runnableBatches pass:
  //   • `otherwise` — the batch gate sits ABOVE Blocked-by in the chain (deliberately:
  //     a hold names an alternative claim path, not an upstream dependency), so
  //     `exclude === 'batch'` alone does NOT prove a member is runnable. A member that
  //     is BOTH batch-held and blocked-by an open upstream reports 'batch' and would
  //     otherwise read as ready to train. Every gate ABOVE the batch position (cloud,
  //     cloudEnv, operator, lane, stub) needs no equivalent probe: a plan failing one
  //     of those never reaches this branch at all, which is what makes runnableBatches
  //     automatically lane- and cloud-correct under every flag combination.
  //   • `slug` — batch-paths.mjs resolves a (data-error) double listing first-match-
  //     wins, so on a malformed roster only ONE batch actually holds the member.
  //     Carrying the winner lets the runnableBatches pass honour that same tiebreak
  //     instead of reporting BOTH batches runnable off a bare `exclude === 'batch'`.
  let batchHold = null;

  // The Blocked-by classification, extracted (plan 2556) so the batch branch can ask
  // "what would this member be excluded for but for the hold?" without a second,
  // drifting copy of the same ladder. Closes over the already-computed `blockedBy` /
  // `strippedBlockedBy` / archive sets; pure, no fs. Callers decide what to do with
  // the result — the batch branch keeps only `.exclude`, the Blocked-by branch adopts
  // all three fields, which is exactly the pre-2556 behaviour of each.
  const classifyBlockedBy = () => {
    // plan 2174: the guard tests RAW `blockedBy` truthiness (a Blocked-by line exists
    // at all), never `strippedBlockedBy` — a bare struck-only line ("~~2123~~") strips
    // to an EMPTY string, which is falsy; guarding on the stripped value would skip
    // this whole block and silently leave `exclude = null` (eligible) for a line that
    // is genuinely unparseable, the dangerous direction. Classification itself still
    // runs on the STRIPPED remainder (struck spans deleted, computed once above
    // alongside `blockedBy`) — a struck plan id must not resurrect as a blocker.
    // `blockedBy` stays the raw original for every message below, so the reader sees
    // exactly what the plan body says.
    //
    // plan 2180 review fix: id-extraction runs BEFORE the BLOCKED_NONE_RX check now
    // (previously the outer guard tested the whole joined text against
    // BLOCKED_NONE_RX first — `^(none|n\/?a)\b`, start-anchored only — so a joined
    // multi-line Blocked-by whose FIRST line is an explicit "none" idiom made the
    // WHOLE string read as "no blocker" and skipped extraction entirely, even when a
    // SEPARATE, later Blocked-by line named a real, still-open blocker: "none" +
    // "plan 1055 (still pending)" joins to "none plan 1055 (still pending)", which
    // still matches `^none\b`. This was a live gap the multi-line join itself
    // introduced — sonnet-review CONFIRMED finding on this same diff. A named plan id
    // anywhere in the joined text now always wins over a leading none/n-a/dash idiom.
    const blockedIds = extractBlockedPlanIds(strippedBlockedBy);
    if (blockedIds.length > 0) {
      // plan 1819 (review fix): resolve EVERY named id against archivedIds — a
      // multi-blocker line ("plan 1055 and plan 1541") is stale only when ALL of
      // them have landed; a single still-open blocker keeps the whole line
      // 'blocked' even if an earlier-named sibling already archived.
      if (blockedIds.every((bid) => archivedIds.has(bid))) {
        // Archived AND shipped ⇒ STALE line: every named upstream has already
        // landed. Do not exclude — include the plan and warn instead of silently
        // vanishing it from the drain (the 1790/1794 incident).
        return {
          exclude: null,
          excludeReason: null,
          staleBlockedBy: `blocked-by ${blockedIds.length > 1 ? `plans ${blockedIds.join(', ')}` : `plan ${blockedIds[0]}`} — all archived (landed) — stale Blocked-by line: "${blockedBy}"`,
        };
      }
      if (blockedIds.every((bid) => archivedIds.has(bid) || archivedUnshippedIds.has(bid))) {
        // plan 2496 (candidate 3, "surface, don't reconcile"): every named blocker IS
        // in archive/, but NOT every one of them is shipped (else the branch above
        // would have already fired) — at least one sits there 🗄️ SUPERSEDED or
        // abandoned, never having landed the blocking work. Before this branch
        // existed, this case fell through to the generic 'blocked' exclude below,
        // indistinguishable from a blocker that is simply still open in ready/ — the
        // drain would then offer the plan (staleBlockedBy path required ALL-shipped)
        // only for the write-time board gate (blocked-by-lib.mjs's classifyBlocked,
        // which applies the SAME shipped-stamp test) to hard-refuse it at claim,
        // every run, deterministically (the divergence this plan is about). Naming it
        // here instead means the plan never reaches the gate and the operator sees
        // WHY at selection time, without re-narrowing plan 1819's archived-AND-shipped
        // widening (candidate 1, explicitly not chosen — see this plan's Execution
        // notes).
        return {
          exclude: 'blocker_archived_unshipped',
          excludeReason: `blocked-by an archived-but-not-shipped plan: ${blockedBy} (archived without the ✅ COMPLETED stamp — the blocking work may not have landed; see plan 1836)`,
          staleBlockedBy: null,
        };
      }
      // At least one named blocker is still in flight (or matches no plan file
      // anywhere — conservative/malformed reference): unchanged from pre-1819
      // behaviour.
      return {
        exclude: 'blocked',
        excludeReason: `blocked-by another plan: ${blockedBy}`,
        staleBlockedBy: null,
      };
    }
    if (BLOCKED_NONE_RX.test(strippedBlockedBy)) {
      // No plan id anywhere in the joined text, and it reads as an explicit
      // none/n-a/bare-dash idiom — eligible, leave exclude = null.
      return { exclude: null, excludeReason: null, staleBlockedBy: null };
    }
    if (BLOCKED_OPERATOR_RX.test(strippedBlockedBy)) {
      return {
        exclude: 'operator',
        excludeReason: `blocked-by operator: ${blockedBy}`,
        staleBlockedBy: null,
      };
    }
    if (BLOCKED_CLEARED_RX.test(strippedBlockedBy)) {
      // plan 2174: a struck-then-annotated line ("~~2123~~ CLEARED (spec-sweep) — …
      // Executable now.") whose remainder named no other plan id and no operator —
      // eligible, leave exclude = null. Reached ONLY after the checks above find
      // nothing live, so a still-open reference elsewhere in the same line (caught by
      // blockedIds/BLOCKED_OPERATOR_RX first) still blocks as usual.
      return { exclude: null, excludeReason: null, staleBlockedBy: null };
    }
    return {
      exclude: 'malformed', // present but unparseable → conservative exclude
      excludeReason: `unparseable Blocked-by line: ${blockedBy}`,
      staleBlockedBy: null,
    };
  };
  if (cloudOnly && cloudExec !== 'true') {
    // plan 1781: in the cloud, cloud-safety is the FIRST admission question.
    exclude = 'cloud';
    excludeReason =
      cloudExec === 'false'
        ? 'cloudExec: false — not cloud-safe (needs local tooling/keys or the seed sandbox); route to a local drain'
        : 'cloudExec unset — not yet stamped cloud-eligible (spec-pass has not marked it); route to a local drain or stamp it';
  } else if (cloudEnvRung) {
    // plan 1925/2003/2250/2313, generalized by plan 2323: the cloudEnv routing
    // gate against the ordered CLOUD_ENV_RUNGS ladder (trusted < full == webkit <
    // browser — see the table comment above). A rung the lane doesn't advertise
    // (rank-compared via cloudEnvLaneRank) excludes with that rung's own code —
    // 'full-env' / 'webkit-env' / 'browser-env' — so a future rung slotting
    // anywhere on the ladder needs no new branch here, only a new table row.
    exclude = cloudEnvRung.exclude;
    excludeReason = cloudEnvRung.excludeReason;
  } else if (execLaneMalformed) {
    // plan 3341: an execModel value resolveExecLane doesn't recognize — present but
    // unparseable, the exact same posture the Blocked-by 'malformed' exclude below
    // takes on its own axis. Conservative exclude rather than a silent fall-through
    // into the sonnet pool (which is what a pre-3341 typo used to do — see the
    // fableLane doc comment above) or a scan-wide crash (which letting the
    // resolveExecLane throw escape unguarded would do).
    exclude = 'exec-lane-malformed';
    excludeReason = `unrecognized execModel: "${execModel}" (${execLaneMalformed})`;
  } else if (solEnvRung) {
    // plan 3341 item 4: the sol lane's own environment axis (solEnvExclusion above),
    // checked here — ahead of the drainClaimable/lane-mismatch gate below — so a
    // CLOUD refusal of a `sol` plan always carries the more specific, named
    // environment reason (codex transport unreachable/unproven) rather than the
    // generic "not drain-claimable" one. Inert on every LOCAL invocation (cloudOnly
    // is false there, so solEnvRung is always null) and on every non-sol plan.
    exclude = solEnvRung.exclude;
    excludeReason = solEnvRung.excludeReason;
  } else if (operatorGated) {
    exclude = 'operator';
    excludeReason = 'operator-gated: needs an operator-supplied input / decision / green-light';
  } else if (interactiveReason) {
    exclude = 'operator';
    excludeReason = interactiveReason;
  } else if (!execLaneInfo.drainClaimable) {
    // plan 3341, comment reframed by plan 3461: a lane not drainClaimable by ANY
    // drain excludes regardless of --lane, ahead of the sonnet/fable comparison
    // below (which only discriminates between LANE-MATCHED drainClaimable
    // lanes). `sol` was this branch's only example (plan 3341) until plan 3461
    // made it drain-claimable too (operator ruling: "I want plans that can be
    // run by Sol to be Sol by default from now on"), so this branch is
    // presently UNREACHABLE — no recognized lane has `drainClaimable: false`
    // today. It stays as the mechanism for whatever future lane genuinely needs
    // a hard drain refusal, and the generic wording below deliberately no
    // longer names `sol`.
    exclude = execLaneInfo.lane;
    excludeReason =
      `execModel: ${execLaneInfo.lane} — ${execLaneInfo.label} is not drain-claimable; needs an ` +
      'Opus-orchestrated interactive session (pickup-plan directly, never a queue-drain claim)';
  } else if (execLaneInfo.hasNativeRun && execLaneInfo.lane !== requestedLane) {
    // plan 1810, generalized by plan 3341, made lane-agnostic for `sol` by plan
    // 3461: pre-3341 this was a straight boolean invert (`fableLane ?
    // execModel !== 'fable' : execModel === 'fable'`), which only worked
    // because there were exactly two lanes and "not fable" and "is fable" were
    // complements. Plan 3341 added `sol` as a third lane, kept out of this
    // comparison entirely by its `drainClaimable: false`. Plan 3461 made `sol`
    // drain-claimable AND deliberately did not invent a `--lane sol` CLI value
    // (see the fableLane/requestedLane comments above) — every drain session
    // is already Opus-class regardless of --lane (`sonnet-full` and
    // `fable-full` cloud triggers, and every local drain, all run
    // `claude-opus-5`; the lane name is only the WORKER tier), and Sol bills
    // the ChatGPT subscription, so neither lane's Claude-usage economy is at
    // stake either way — so a `sol` plan is explicitly exempted here and
    // admitted under EITHER requested lane. Guarded by `hasNativeRun`
    // (EXEC_LANE_TABLE, claim-plan-lib.mjs) rather than a hand-typed
    // `lane !== 'sol'` literal (a sonnet-review finding on this plan's first
    // cut, which found `ready-board.mjs` duplicating the same axis as its own
    // `NATIVE_RUN_LANES` set) — a future lane with no `--lane` value of its
    // own inherits this exemption automatically by setting `hasNativeRun:
    // false`, with no new literal to keep in sync here. This comparison
    // therefore still only ever discriminates between sonnet and fable,
    // byte-identical to the pre-3341 behaviour for every sonnet/fable plan.
    exclude = requestedLane === 'fable' ? 'sonnet-lane' : 'fable';
    excludeReason =
      requestedLane === 'fable'
        ? 'execModel: sonnet (or absent, grandfathered sonnet) — not in the fable lane; route to the sonnet oracle/drain'
        : 'execModel: fable — heavy-model plan, not drainable (route to a Fable session; thin-orchestrator doctrine)';
  } else if (specGateMsg) {
    exclude = 'stub';
    excludeReason = specGateMsg;
  } else if (batchHeldBy.has(canonicalPlanId(id))) {
    // plan 2459 Task 2 (leak B): this plan is a member of a RUNNABLE batch
    // (status: proposed, gate: null) — refuse the solo claim path here rather than
    // let the fastest claimer dissolve the train. Checked BEFORE Blocked-by: a batch
    // hold names an ALTERNATIVE claim path, not an upstream dependency.
    //
    // Evaluated HERE rather than hoisted above the chain (plan 2518 item 3): `batchHeldBy`
    // may be the lazy façade, so touching it is what triggers the batches walk — a plan
    // already excluded by an earlier gate must never pay for it.
    //
    // The wording comes from batchHoldFor (plan 2518 item 1) — the same helper
    // claim-plan-lib.mjs's checkBatchSoloClaimGate calls — so the drain's exclusion reason
    // and the claim path's refusal can never drift into two different sentences.
    const hold = batchHoldFor(id, batchHeldBy);
    exclude = 'batch';
    excludeReason = hold.reason;
    // plan 2556: the hold WINS (unchanged), but record which batch won it and what the
    // plan would have been excluded for underneath it, so selectEligible can tell a
    // member that is merely waiting for its train from one that is ALSO blocked-by an
    // open upstream. Only `.exclude` is adopted from the classifier — `staleBlockedBy`
    // deliberately stays null on a batch-held plan, byte-identical to the pre-2556
    // output for every pre-existing field.
    batchHold = { slug: hold.slug, otherwise: blockedBy ? classifyBlockedBy().exclude : null };
  } else if (blockedBy) {
    const blocked = classifyBlockedBy();
    exclude = blocked.exclude;
    excludeReason = blocked.excludeReason;
    staleBlockedBy = blocked.staleBlockedBy;
  }
  // a "Blocked-by: none/n-a/—" line (with no plan id anywhere in the joined text)
  // leaves exclude = null (eligible).

  return {
    id,
    slug: base,
    category,
    seedWrite,
    blockedBy,
    cost,
    execModel,
    // plan 3461 round 2: the plan's OWN resolved lane ('sonnet' | 'fable' | 'sol'), read
    // straight off `execModel` via the one fail-closed resolver — never inferred by a
    // consumer from which pool/oracle-run happened to report the plan. `execLaneInfo` is
    // null only when execModel is malformed (caught above), in which case `exclude` is set
    // to 'exec-lane-malformed' and this meta never reaches `candidates`/`toItem` at all; the
    // `?? null` here is defense-in-depth for the few direct `parsePlanMeta` callers (tests)
    // that read a raw, still-excluded meta.
    lane: execLaneInfo ? execLaneInfo.lane : null,
    stage,
    specReview,
    cloudExec,
    cloudExecStamp,
    cloudEnv,
    cloudRepos,
    adoptBranch,
    priority,
    priorityTier,
    operatorGatedStamp,
    exclude,
    excludeReason,
    staleBlockedBy,
    batchHold,
    tailBlockedBySkipped,
  };
}

// --- pure: selection ----------------------------------------------------------

function toItem(m) {
  // plan 3461 round 2: the plan's OWN resolved lane, carried on every `eligible[]` entry so a
  // consumer never has to infer it from which oracle run (or which pool) happened to report
  // this plan — that inference is exactly what let a single-sighting `sol` plan misroute to
  // Claude (round 1's `local-drain-filter.mjs` dedup only relabeled a SECOND cross-pool
  // sighting, so a `sol` plan seen in only one pool kept the raw sonnet/fable pool label).
  // Every candidate reaching `toItem` has a non-null `execLaneInfo` by construction (an
  // unresolvable execModel is excluded as 'exec-lane-malformed' before `candidates` is built —
  // see the exclude chain above, where the malformed branch runs BEFORE the two branches that
  // dereference `execLaneInfo` directly), so `m.lane` is always a real lane string here.
  //
  // plan 3461 round 3: this used to read `m.lane ?? 'sonnet'` as "defense-in-depth". That
  // default is exactly backwards for what it is defending against: if the invariant above ever
  // breaks and `m.lane` really is falsy, silently stamping `'sonnet'` hands a `sol` (or any
  // non-sonnet) plan to a Claude worker instead of `codex exec` — the precise failure round 2
  // closed, reintroduced as the "safe" fallback. Worse, `local-drain-filter.mjs` falls back to
  // the POOL label whenever `e.lane` is not a non-empty string, so an `undefined` lane here
  // would silently resurrect round 1's inferred-from-pool bug on the consumer side too. An
  // unreachable branch is not a place to guess — it is a place to fail loudly, so a future
  // regression that makes this reachable is caught at the source instead of laundered into a
  // plausible-looking wrong value three layers away.
  // plan 3461 round 4 (review finding): a bare truthiness check (`!m.lane`) only catches an
  // ABSENT lane — a garbage string (a typo like 'sonnett', or a stale value from a future lane
  // rename) is truthy and would sail straight through as if it were a real lane, reaching every
  // consumer as though it had been resolved. Checking membership in EXEC_LANE_TABLE (the ONE
  // lane vocabulary, claim-plan-lib.mjs) instead of a hand-typed list keeps this guard from
  // silently drifting out of sync with the table if a lane is ever added, renamed, or removed —
  // own-property lookup, never a bare `EXEC_LANE_TABLE[m.lane]`, for the same prototype-pollution
  // reason `resolveExecLane` documents (an `m.lane` of 'constructor'/'toString'/'valueOf' would
  // otherwise resolve to a truthy but nonsensical "lane" instead of hitting the throw below).
  //
  // plan 3461 round 5 (finding 186aba, CONFIRMED): `hasOwnProperty.call(EXEC_LANE_TABLE, m.lane)`
  // coerces its second argument to a property key BEFORE the lookup — so a non-string `m.lane`
  // whose `toString()` happens to return a real lane name (e.g. `{ toString: () => 'sol' }`, or
  // any object the invariant above never anticipated) passes this check outright. It then rides
  // through as an OBJECT everywhere downstream that expects a string: it serializes into the
  // oracle JSON as `"lane": {}`-shaped garbage, and `local-drain-filter.mjs`'s
  // `typeof e.lane === 'string' && e.lane ? e.lane : poolLane` fallback (partitionPools) does not
  // recognize it as a usable lane either — it falls back to the REQUESTED POOL label instead,
  // which can dispatch a Sol plan to a Sonnet or Fable worker. That is exactly the misrouting
  // this whole invariant chain exists to prevent, so `typeof m.lane === 'string'` is required
  // explicitly rather than trusted to the coercing membership check alone.
  if (
    typeof m.lane !== 'string' ||
    !m.lane ||
    !Object.prototype.hasOwnProperty.call(EXEC_LANE_TABLE, m.lane)
  ) {
    throw new Error(
      `queue-drain internal invariant violated: candidate ${m.slug} reached toItem() with an ` +
        `unrecognized lane (m.lane is ${JSON.stringify(m.lane)}, typeof ${typeof m.lane}, must ` +
        `be a STRING that is one of ${Object.keys(EXEC_LANE_TABLE).join(' / ')}). Every ` +
        `candidate is supposed to carry a non-null execLaneInfo by construction — refusing to ` +
        `default to 'sonnet' or pass the value through unchecked, since either would silently ` +
        `misroute this plan to the wrong worker tier.`,
    );
  }
  const item = {
    slug: m.slug,
    path: `docs/superpowers/plans/${READY_FOLDER}/${m.category ? `${m.category}/` : ''}${m.slug}.md`,
    seedWrite: m.seedWrite ?? 'unknown',
    cost: m.cost,
    // plan 2421: the richer cloudExec enum ('true'|'false'|'unset'|'no-frontmatter'|typo),
    // already computed while parsing this plan — carried here so `/local-drain`'s filter can
    // trust it instead of re-reading and re-normalizing the same file a second time.
    cloudExec: m.cloudExecStamp,
    lane: m.lane,
  };
  // plan 1819: only present when the plan's Blocked-by line named an archived
  // (stale) blocker — the field a sweep/human greps the JSON for to know which
  // ready/ bodies need a Blocked-by cleanup.
  if (m.staleBlockedBy) item.staleBlockedBy = m.staleBlockedBy;
  // plan 2328: only present when stamped — a driver/human reading the oracle JSON
  // sees WHY this plan jumped the cost/lane ordering.
  if (m.priority) item.priority = true;
  // plan 2368: only present when stamped. A `false` stamp OVERRODE the operator-gate
  // text heuristics for this plan, so it must be visible next to the plan that drained
  // — a wrong stamp should be auditable, not silent (review finding).
  if (m.operatorGatedStamp) item.operatorGated = m.operatorGatedStamp;
  // plan 2446: only present when a **Blocked-by:** line sat in a close-out tail and
  // was NOT counted — the plan still drains (the tail rule is skip, not gate), but a
  // human/sweep reading the oracle JSON needs to see that an author may have parked
  // the plan's REAL blocker somewhere this drain does not look.
  if (m.tailBlockedBySkipped) item.tailBlockedBySkipped = m.tailBlockedBySkipped;
  // plan 2577: only present when the plan names extra repos. The drain reads this field
  // on the plan it picked and clones each listed repo BEFORE claiming — see the § Extra
  // repos section of the routine prompts and docs/runbooks/cloud-drain-autonomy.md.
  if (m.cloudRepos?.length) item.cloudRepos = m.cloudRepos;
  // plan 3111: only present when the plan carries the hand-off stamp. Its meaning to a consumer is
  // "there is committed work on this branch — CONTINUE it, do not restart": cut the worktree with
  // `cut-worktree.mjs <slug> --adopt=<branch>` and re-derive done-ness from the branch. Carried
  // whenever the stamp exists rather than only when verified against origin, deliberately — the
  // non-cloud oracle call (drain-run.mjs's driver) never reads origin at all, and gating the field
  // on that read would make the whole adopt instruction dead code in the local lane. Consumers are
  // told what to do if the branch turns out to be gone (the stamp is stale ⇒ cut normally), which
  // is the one state a present-but-unverified stamp can be in: an EXISTING but DIFFERENT branch is
  // already excluded above, so it never reaches here.
  if (m.adoptBranch) item.adoptBranch = m.adoptBranch;
  return item;
}

// Shape an excluded meta for the driver's skip-list (plan 443): slug + why.
function toExcluded(m) {
  const excluded = {
    slug: m.slug,
    exclude: m.exclude,
    reason: m.excludeReason ?? null,
    cloudExec: m.cloudExecStamp,
    // plan 3955: mirrors `toItem()`'s `cost: m.cost` — an excluded plan still carries its own
    // cost-forecast banner, and the `/ready-plans` Cost column renders every ready/ row
    // (eligible or excluded), not only the takeable ones.
    cost: m.cost,
  };
  // plan 2446: surfaced for an excluded plan too — same rationale as toItem above.
  if (m.tailBlockedBySkipped) excluded.tailBlockedBySkipped = m.tailBlockedBySkipped;
  return excluded;
}

// A null SEED-WRITE banner is treated as 🟥 for mutex/sort purposes
// (conservative: an unknown-seed-status plan must not land during a LANDING).
function isSeedWrite(m) {
  return m.seedWrite !== 'no';
}

// THE ordering over plans — extracted (plan 2556) so a runnable BATCH can be ranked by its
// BEST member using the exact comparator single plans are ranked by, per the operator ruling
// "a batch rides the priority of its best member". Two hand-written copies of this chain
// would drift the moment either is touched, and the drift would be invisible: a batch would
// quietly sort into the wrong queue position rather than fail.
//
// plan 2328: `priority` is the FIRST sort key — a higher-tier plan beats a
// cheaper/greener lower-tier one, while the whole pre-2328 chain (🟩→🟥,
// cost-asc, id-asc) is preserved unchanged WITHIN each priority tier (so two
// same-tier plans fall back to the normal ordering between themselves). Sort-only:
// the hard gates above and the LANDING mutex filter never see this field.
// plan 2520: three tiers now — `high` (0) > `medium`/unstamped (1) > `low` (2) — via the
// ONE shared weight map (build-index-lib.mjs), so this can never disagree with what
// `priorityTier` itself normalizes a bad/escaped value to (`medium`, warn-not-crash).
function planRank(seedy) {
  return (a, b) => {
    const pa = PRIORITY_SORT_WEIGHT[a.priorityTier] ?? PRIORITY_SORT_WEIGHT.medium;
    const pb = PRIORITY_SORT_WEIGHT[b.priorityTier] ?? PRIORITY_SORT_WEIGHT.medium;
    if (pa !== pb) return pa - pb; // ⚡ high first, low sinks below the unstamped bulk
    const sa = seedy(a) ? 1 : 0;
    const sb = seedy(b) ? 1 : 0;
    if (sa !== sb) return sa - sb; // 🟩 (0) before 🟥 (1)
    // then cheapest first within the group. An unknown-cost plan (usd null) sorts
    // LAST — the drain pauses on it anyway (cost.unknown / shouldPauseForCost), so
    // it must never jump ahead of a plan with a known, cheap forecast.
    const ca = a.cost?.usd ?? Infinity;
    const cb = b.cost?.usd ?? Infinity;
    if (ca !== cb) return ca - cb; // cost ascending (cheap first)
    return a.id - b.id; // stable final tiebreak: plan-id ascending
  };
}

// plan 2556: the runnable-BATCH pass. `eligible` is by contract the SOLO-claimable
// set — every routine prompt says "if your pick is claimed, take the next eligible
// unit", and `next` is drawn from it — so a batch-held member must never appear there
// (that IS the plan-2459 leak-B hold). A takeable TRAIN is therefore surfaced as its
// own unit beside `eligible`, never inside it.
//
// Before this existed the routine prompts' batch check was structurally dead in BOTH
// lanes: it asked whether "every id in the batch's `members` array appears in the
// oracle's `eligible` list", which the hold makes impossible by construction. (Verified
// live 2026-07-27 — the sonnet check's deadness is only UNOBSERVABLE in the cloud lane
// because the cloudExec gate at chain position 1 preempts the batch gate at position 7
// for every current sonnet batch member.)
//
// `batchRoster` is the caller's fs read (batch-paths.mjs's readRunnableBatches) — passed
// in, never read here, so this function stays pure.
//
// A batch is runnable iff EVERY member:
//   • resolves to a plan in THIS scan's ready/ pool (an archived or moved member means
//     the roster is stale — never a runnable train),
//   • is excluded as 'batch' BY THIS BATCH (honouring batch-paths.mjs's first-match-wins
//     tiebreak on a double-listed id), and
//   • carries `batchHold.otherwise === null` — nothing else against it underneath the
//     hold.
// The second condition is what makes the result automatically lane-, cloud- and env-
// correct: every one of those gates sits ABOVE the batch gate, so a member failing one
// is excluded as 'cloud'/'sonnet-lane'/'stub'/… and never reads as 'batch' at all.
// Returns { runnable, skipped }. `skipped` is REQUIRED by the operator ruling
// (2026-07-27): a train a drain may not take must be SKIPPED WITH A LOGGED REASON, never
// silently absent — otherwise "no batch was runnable" and "a batch was withheld because one
// member is not cloud-eligible in this environment" are indistinguishable to whoever reads
// the drain's output, and a mixed train would rot invisibly instead of being routed to the
// local lane.
function computeRunnableBatches(metas, batchRoster, { landingHeld, seedLane }) {
  if (!batchRoster || batchRoster.length === 0) return { runnable: [], skipped: [] };
  const seedy = (m) => seedLane && isSeedWrite(m);
  const byId = new Map(metas.map((m) => [canonicalPlanId(m.id), m]));
  const runnable = [];
  const skipped = [];
  for (const batch of batchRoster) {
    if (!batch.members || batch.members.length === 0) {
      skipped.push({ slug: batch.slug, reason: 'roster lists no members', blockers: [] });
      continue;
    }
    // Per-member verdict, so the skip reason can NAME the member and its cause. The
    // all-or-nothing rule falls out of this being an `every`: one blocker withholds the
    // whole train, and the train is never partially offered.
    const blockers = [];
    const members = [];
    for (const mid of batch.members) {
      const m = byId.get(canonicalPlanId(mid));
      if (!m) {
        // Not in this scan's ready/ pool at all: archived, claimed, or re-filed since the
        // roster was written — a stale roster entry, never a runnable train.
        blockers.push({ id: String(mid), cause: 'not-in-ready-pool' });
        continue;
      }
      members.push(m);
      if (m.exclude !== 'batch') {
        // Excluded by a gate ABOVE the batch gate — cloud-safety, cloudEnv, operator,
        // lane, stub. THIS is the all-or-nothing cloud-eligibility case the ruling pins:
        // in `--cloud [--env X]` mode a member that is not cloud-eligible for this
        // environment reads `cloud` / `full-env` / `browser-env` here, so the train is
        // withheld from this environment and left for one that can take it.
        blockers.push({ id: String(m.id), cause: m.exclude ?? 'unexpectedly-eligible' });
      } else if (!m.batchHold || m.batchHold.slug !== batch.slug) {
        // Held by a DIFFERENT batch — batch-paths.mjs resolves a double-listed id
        // first-match-wins, so on a malformed roster only one batch really holds it.
        blockers.push({
          id: String(m.id),
          cause: `held-by-other-batch:${m.batchHold?.slug ?? 'unknown'}`,
        });
      } else if (m.batchHold.otherwise !== null) {
        // Something underneath the hold: the batch gate sits ABOVE Blocked-by, so this is
        // the only way to see a member that is blocked as well as batch-held.
        blockers.push({ id: String(m.id), cause: `${m.batchHold.otherwise}-under-hold` });
      }
    }
    // Same SEED-WRITE semantics the candidate filter applies to single plans: a 🟥 train may
    // not board while a 🟢 LANDING row holds the mutex. Read off the MEMBERS' own parsed
    // banners, never batch.md's `lane:` glyph — the roster's glyph is a human summary, the
    // banners are what the mutex is actually defined over.
    const seedWrite = members.some(seedy);
    if (blockers.length === 0 && landingHeld && seedWrite) {
      skipped.push({
        slug: batch.slug,
        reason: 'a 🟥 train may not board while the LANDING mutex is held',
        blockers: [],
      });
      continue;
    }
    if (blockers.length > 0) {
      skipped.push({
        slug: batch.slug,
        reason:
          `not every member is takeable here: ` +
          blockers.map((b) => `${b.id} (${b.cause})`).join(', ') +
          `. All-or-nothing by ruling — never claim a train partially; if the cause is ` +
          `cloud-eligibility, leave it for a lane that can take every member.`,
        blockers,
      });
      continue;
    }
    // Operator ruling 2: a batch rides the priority of its BEST member. Ranked with the
    // SAME comparator single plans use, so a train can never sort into a different queue
    // position than the plan that earned it would have.
    const best = members.slice().sort(planRank(seedy))[0];
    runnable.push({
      slug: batch.slug,
      members: members.map((m) => String(m.id)),
      memberSlugs: members.map((m) => m.slug),
      memberPaths: members.map((m) => `docs/superpowers/plans/${READY_FOLDER}/${m.slug}.md`),
      // The ALREADY-COMPUTED per-member cloudExec stamps, in member order (plan 2556 review
      // finding 6) — the same optimization plan 2421 applied to `eligible[]` entries, for the
      // same consumer: local-drain-filter's batch partitioner would otherwise re-read and
      // re-parse every member file that parsePlanMeta just read on this very scan.
      memberCloudExec: members.map((m) => m.cloudExecStamp),
      // Same treatment for the plan-2577 extra-repo axis, and for the same reason: without it
      // a drain taking a train had to re-grep every member body for `cloudRepos:` to learn
      // whether it must clone a second repo — a hand-rolled frontmatter read the standing
      // "call the oracle, never grep plan frontmatter" rule exists to prevent (sonnet-review
      // finding, plan 2577). parsePlanMeta already computed this on this very scan.
      memberCloudRepos: members.map((m) => m.cloudRepos),
      seedWrite: seedWrite ? 'yes' : 'no',
      // The member whose rank the train inherits — surfaced so a drain (or a human reading
      // the JSON) can see WHY a train sits where it does, rather than trusting the order.
      rankedBy: { slug: best.slug, id: String(best.id), priorityTier: best.priorityTier },
      priority: best.priorityTier === 'high',
      priorityTier: best.priorityTier,
      cost: best.cost,
      _rank: best,
    });
  }
  // Hoisted once (review finding 7) — the same shape `candidates.sort(planRank(seedy))` uses.
  // Building the comparator inside the callback re-allocated a closure per PAIRWISE comparison.
  const rank = planRank(seedy);
  runnable.sort((a, b) => rank(a._rank, b._rank));
  for (const b of runnable) delete b._rank; // internal ranking handle, never part of the contract
  skipped.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { runnable, skipped };
}

// ─── The already-executed-on-origin gate (plan 2863) ─────────────────────────
// WHY this exists at all. On 2026-08-05 four independent cloud drain firings each executed plan 2855
// end-to-end inside ~70 minutes, producing four finished, separately-reviewed branches, none of which
// knew the others existed; the same shape reproduced on 2858, 2860, 2857 and 2861 the same day —
// 9+ redundant full plan executions (worktree, implementation, two review rounds, full pytest suite).
//
// The trigger was a transport failure that made claiming impossible in the FULL-egress envs (fixed
// upstream in ensure-coord-reroute.mjs + the routine's probe-retry), but the DUPLICATION was this
// oracle's blind spot: eligibility gated purely on plan frontmatter and never asked origin whether a
// branch for the slug already existed. The only place in the whole toolchain that reads origin
// branches for a slug is `cut-worktree.mjs --adopt` — at CONSUMPTION time. Adoption caught the rival
// branch; nothing caught it BEFORE the work was redone.
//
// So this gate is generic duplication defense, deliberately NOT coupled to the claim mechanism: it
// closes the gap for ANY future claim failure, not just the one that motivated it.
//
// IT IS NOT A MUTEX, and must not be read as one. The origin read here and the marker push a firing
// makes later are two separate operations with a window between them, so two firings that both read
// origin before either has staked its marker will both proceed — the check narrows the race, it does
// not close it. The MUTEX is and remains `refs/claims/<id>` (an atomic ref-CAS, `claim-plan.mjs`);
// this gate exists for exactly the case where that mutex is unreachable, and it turns "four firings
// over ~70 minutes" into "at most the few firings that overlap inside one selection window". Do not
// try to make it atomic — fix the claim transport instead, which is the other half of this plan.
//
// The branch shapes a prior execution leaves on origin. `claude/drain-<id>-…` is the unclaimed
// escape-hatch branch; `worktree-<id>-…` is the ordinary claimed-execution branch.
//
// The id must be followed by `-<letter>` or by end-of-branch — the SAME discipline `parsePlanMeta`'s
// own `/^(\d{3,})-(?=[A-Za-z])/` applies to plan FILENAMES, and it is load-bearing, not cosmetic.
// A bare `\d{3,}` prefix also matches the LEGACY date-prefixed slugs (`worktree-2026-05-17-vetpris-…`)
// and would add `2026` to the id-set — while `parsePlanMeta` gives those same legacy plans
// `id = Infinity`, so the two sides disagree about what "2026" means. The live consequence is a FALSE
// EXCLUSION: `docs/superpowers/plans/archive/2026-FABLE-Price-…` is a real plan whose id IS 2026, and
// one unrelated date-slugged branch on origin would have withheld it from every cloud firing.
// `worktree-batch-<date>-<slug>` never matches either way (it starts with letters).
export const ORIGIN_EXECUTED_BRANCH_RXS = [
  /^claude\/drain-(\d{3,})(?:-(?=[A-Za-z])|$)/,
  /^worktree-(\d{3,})(?:-(?=[A-Za-z])|$)/,
];

// The sha-keeping pure parser for the two execution-branch namespaces. `planIdsFromRemoteHeads`
// folds this output; shas remain here so the dead-seed predicate can run once per origin head.
export function parseExecutionHeads(stdout) {
  const heads = [];
  const seenNames = new Set();
  for (const raw of String(stdout).split('\n')) {
    // ls-remote emits `<sha>\trefs/heads/<name>`; ignore anything else (blank lines, warnings).
    const line = raw.trim();
    const m = /^([0-9a-f]{7,})\s+refs\/heads\/(.+)$/.exec(line);
    if (!m || seenNames.has(m[2])) continue;
    for (const rx of ORIGIN_EXECUTED_BRANCH_RXS) {
      const hit = rx.exec(m[2]);
      if (hit) {
        // De-duped: repeated names must not inflate the plan-3111 ambiguity count — "how many
        // branches does origin carry for this id" is a decision input, not a report field.
        seenNames.add(m[2]);
        heads.push({ sha: m[1], name: m[2], id: canonicalPlanId(hit[1]) });
        break;
      }
    }
  }
  return heads;
}

function executionHeadsByPlanId(heads) {
  const byId = new Map();
  for (const head of heads) {
    const { id, name } = head;
    // Strict `=== true` lets this fold serve both callers: `originExecutedPlanIds` attaches a real
    // verdict-derived `fresh`, while `planIdsFromRemoteHeads` has no `fresh` field and lands false.
    // plan 3619: `gateBlocked`/`status` ride alongside `fresh` on the same strict-`=== true`
    // terms — a caller with no status reader attaches neither, and the fold lands false/null.
    // plan 3767: `sha` rides along too — `parseExecutionHeads` always carries one for a real
    // `ls-remote` head, but a hand-built test list (or any future caller that never resolved a
    // sha) legitimately omits it, so this folds it through as `null` rather than requiring it.
    // `collapseSameShaBranches` below is the ONE consumer that reads it, and it treats a missing
    // sha as "never collapse" — the discriminator this plan needs (N branches, one finished tip)
    // depends on sha equality, and a null sha can prove nothing about equality either way.
    const branch = {
      name,
      sha: head.sha ?? null,
      fresh: head.fresh === true,
      // plan 3767 (gpt-review round 2): carried through so `collapseSameShaBranches` can refuse a
      // head whose liveness probe threw — dropping it here would restore the exact ambiguity the
      // boolean `fresh` cannot express.
      livenessUnknown: head.livenessUnknown === true,
      gateBlocked: head.gateBlocked === true,
      status: head.status ?? null,
    };
    const list = byId.get(id);
    if (list) list.push(branch);
    else byId.set(id, [branch]);
  }
  return byId;
}

// plan 3767: N execution branches sitting at ONE sha are one finished branch, not an unresolved
// rival. An override adopt's normalization push (`cut-worktree.mjs`) leaves its SOURCE branch on
// origin whenever the cloud sandbox proxy refuses the retirement delete (plan 3756), so a plan can
// carry e.g. `claude/drain-<id>-…` AND `worktree-<id>-…` at the IDENTICAL tip with nothing left to
// decide between them — the plan-3652 incident this plan fixes: `plan-adopt-branch.mjs` hit its
// `ambiguous` arm and wrote no stamp, and `selectEligible` below excluded the plan `already-on-origin`
// with a "decide which one is the truth" NOTE, even though there was nothing to decide.
//
// Collapses ONLY when every entry's `sha` is present (non-null) AND all of them are equal —
// otherwise the list is returned UNCHANGED with `duplicates: []`, byte-for-byte identical to
// pre-3767 behaviour. A missing sha never collapses: `planIdsFromRemoteHeads`'s pure parser and a
// hand-built test list both legitimately carry no sha, and a null value can prove nothing about
// equality — the genuinely-divergent case (plan 2855: three branches, three different tips) must
// keep refusing as a human call exactly as it always has.
//
// `worktree-` beats `claude/drain-` among equal-sha candidates: the canonical spine branch name is
// always the one worth keeping (cut-worktree.mjs's normalization push already made it the
// fast-forwarded superset — an override adopt's whole point). Among further ties (two names in the
// same namespace, unreached in practice — a branch name is unique per id within either namespace —
// but decided rather than left unspecified) the first in list order survives.
export function collapseSameShaBranches(list) {
  if (!Array.isArray(list) || list.length < 2) return { branches: list, duplicates: [] };
  if (!list.every((b) => b.sha != null)) return { branches: list, duplicates: [] };
  // gpt-review fix (plan 3767): a FRESH head is a LIVE session, and same-sha is NOT evidence of
  // equivalence for one. The plan-2863 marker writer stakes a branch with
  // `push origin origin/master:refs/heads/claude/drain-<slug>` — the origin/master tip, no commits
  // of its own — so two rival firings that both staked for one id are same-sha BY CONSTRUCTION
  // while being exactly the "two sessions racing" case the ambiguity guard exists to catch.
  // Folding one away would hand a taker a branch another session is still executing on. Same-sha
  // means "one finished branch" only among DEAD heads; a live stake is never collapsed, and the
  // pre-3767 answer (hands-off unstamped, adopt-ambiguous stamped) stands for it unchanged.
  // gpt-review round 2 (plan 3767): the same refusal for a head whose liveness probe THREW.
  // `originExecutedPlanIds` renders that as `fresh: false`, which is indistinguishable from a
  // genuinely finished head — collapsing on it would read a failed probe as proof of death.
  if (list.some((b) => b.fresh === true || b.livenessUnknown === true))
    return { branches: list, duplicates: [] };
  const firstSha = list[0].sha;
  if (!list.every((b) => b.sha === firstSha)) return { branches: list, duplicates: [] };
  const preferredIdx = list.findIndex((b) => b.name.startsWith('worktree-'));
  const idx = preferredIdx === -1 ? 0 : preferredIdx;
  const duplicates = list.filter((_, i) => i !== idx);
  return { branches: [list[idx]], duplicates };
}

// Parse `git ls-remote --heads origin` stdout into a MAP of plan id → the execution branch NAMES
// origin carries for it. Pure (a string in, a Map out) so the whole extraction is unit-testable
// without a remote. Ids are canonicalised the same way every other plan-id comparison in this
// toolchain is (`canonicalPlanId`), so `0912` and `912` can never miss each other.
//
// plan 3111 widened this from `Set<id>` to `Map<id, string[]>`. The plan-2863 gate below only ever
// asked "does this id have ANY branch?", which a Set answered; the adopt carve-out has to compare a
// plan's STAMPED branch name against what origin actually carries, and the ambiguous arm has to
// name every branch it found. `map.size > 0` / `map.has(id)` behave exactly as the Set's did, so
// the pre-existing gate is byte-equivalent — only the extra `.get(id)` capability is new.
//
// plan 3583 widened each value again from `string` to `{name, fresh}` so the gate can tell a fresh
// marker stake from real work. The same `.size` / `.has` equivalence still holds.
export function planIdsFromRemoteHeads(stdout) {
  // This pure parser has no git access, so every head gets `fresh: false`. That is conservative:
  // it renders today's carries-work wording rather than hands-off wording, and only tests consume it.
  return executionHeadsByPlanId(parseExecutionHeads(stdout));
}

// The adoption command DIFFERS by branch shape and the reason line must not misdirect: a
// `worktree-<slug>` branch adopts with a bare `--adopt`, but a `claude/drain-<slug>` branch has to
// NAME itself (`--adopt=claude/drain-<slug>`) — `cut-worktree.mjs` looks for `origin/worktree-<slug>`
// by default and refuses when only the drain branch exists.
const ALREADY_ON_ORIGIN_REASON =
  'already-on-origin: an execution branch for this plan id already exists on origin — the work was ' +
  'done by an earlier firing and awaits adoption, not redoing. Adopt it: ' +
  '`cut-worktree.mjs <slug> --adopt` for a `worktree-<slug>` branch, or ' +
  '`cut-worktree.mjs <slug> --adopt=claude/drain-<slug>` for an unclaimed drain branch. ' +
  'If that branch is DEAD work this plan should INHERIT (a cap-killed session re-filed to ready/), ' +
  'stamp it so a drain can take the plan instead of skipping it forever: ' +
  '`node scripts/plan-adopt-branch.mjs <id>` (plan 3111)';

const HANDS_OFF_ON_ORIGIN_REASON =
  'already-on-origin: this branch carries NO commits of its own and is not yet provably older ' +
  'than the dead-seed threshold of ' +
  `${DEAD_SEED_MIN_AGE_MS / (60 * 60 * 1000)}h, so a drain may be staking it right now — hands ` +
  'off. It is NOT adoptable and NOT deletable; re-check after that threshold. On a ' +
  'PAT-limited account a drain ' +
  'runs UNCLAIMED by design, so the absence of `refs/claims/<id>` is NOT evidence the session ' +
  'is gone.';

// `fresh` is an empty marker provably younger than DEAD_SEED_MIN_AGE_MS. `age-unknown` is an
// empty marker whose tip is an ancestor of origin/master with an EMPTY `<tip>..origin/master`
// ancestry path: a marker sitting AT the current tip. That is the COMMON fresh stake produced by
// the plan-2863 writer before master next moves, not an edge case. `carries-work` and `git-error`
// deliberately retain today's non-hands-off wording. This errs toward one delayed cleanup because
// mislabeling a genuinely old age-unknown marker as hands-off costs only that delay, while calling
// a LIVE marker adoptable recreates the plan-3562 near-miss plan 3583 exists to prevent. An
// age-unknown head is never dead, so this changes neither dead-head dropping nor the excluded-id set.
//
// plan 3619 adds `status-heartbeat`: an empty marker whose drain is publishing a FRESH heartbeat on
// the gate-exempt status channel. That is the strongest hands-off evidence of the three — the other
// two only fail to prove the session is gone, while this one is the session actively saying it is
// alive and holding work it cannot push.
export const GATE_BLOCKED_VERDICT_REASON = 'status-heartbeat';
export const HANDS_OFF_VERDICT_REASONS = new Set([
  'fresh',
  'age-unknown',
  GATE_BLOCKED_VERDICT_REASON,
]);

// plan 3767 (gpt-review round 2): the verdicts that mean "the probe could not TELL", as opposed to
// the ones that mean "this head is finished". Both land as `fresh: false`, which is correct for the
// hands-off axis — neither is evidence a session is still alive — but `collapseSameShaBranches`
// asks a DIFFERENT question, "is this head provably a dead duplicate?", and for that a failed probe
// is not a yes. `git-error` is the returned form (ancestry unreadable for that sha); a THROWN
// `_deadSeed` is the other, marked at its own call site. Deliberately NOT a hands-off reason: this
// changes nothing about which heads are dropped, excluded, or rendered — only what may collapse.
export const UNKNOWN_LIVENESS_VERDICT_REASONS = new Set(['git-error']);

// plan 3619: its OWN exclude code, not another reason string under `already-on-origin`. The
// ready-board renders the exclude CODE in its Cloud cell (`⛔ gate-blocked`) and the reason only as
// a footnote, and the whole point of this state is that it must not read as "already-on-origin,
// hands off" — that is the exact misreading that let the plan-3595 stall sit 3.5h looking like a
// drain that never started. The operator action differs too: this plan is not awaiting adoption and
// not awaiting a threshold, it is awaiting a HUMAN look at a named failing gate.
const gateBlockedReason = (status) => {
  const held = Number.isFinite(status?.heldCommits) ? status.heldCommits : null;
  const heldText =
    held === null ? 'an unreported number of commits' : `${held} commit${held === 1 ? '' : 's'}`;
  const gateText = status?.blockedOn ? `\`${status.blockedOn}\`` : 'an unnamed gate';
  const sessionText = status?.session ? ` Session: ${status.session}.` : '';
  // The WORK branch, not just the status branch. The reader's next move is to look at the commits
  // the drain is holding, and the payload carries the branch they are on — omitting it sent them to
  // the heartbeat and left them to guess the rest.
  const workBranchText = status?.branch ? ` Its work is on \`${status.branch}\`.` : '';
  return (
    "gate-blocked: a LIVE drain is holding this plan's work in its sandbox behind a failing " +
    `pre-push gate — it published a fresh heartbeat on \`claude/status/${status?.slug ?? '<slug>'}\` ` +
    `reporting ${heldText} it cannot push, blocked on ${gateText}.${workBranchText}${sessionText} This is NOT a dead ` +
    'seed and NOT a plan awaiting adoption: the work exists, it is just quarantined behind the gate. ' +
    'Do not stake, adopt, or delete anything — read the failing gate and unblock it (the branch the ' +
    'heartbeat names carries the commits). The dead-seed clock is suspended while the heartbeat ' +
    'stays fresh, and resumes on its own once it goes stale.'
  );
};

// plan 3111: the stamp is set but names a branch origin does NOT carry, while origin carries a
// DIFFERENT one for the same id. The stamp is stale (the named branch landed or was renamed), so
// the plan-2863 exclusion STANDS — the carve-out only ever fires on an exact match, which is what
// keeps a stale sticker from waving a live rival's branch through. Same exclude CODE as the plain
// case (the operator action is still "adopt or re-stamp"), a different reason string so the reader
// is not left comparing two branch names by hand.
const adoptStaleReason = (stamped, branches) =>
  `${ALREADY_ON_ORIGIN_REASON}. NOTE: this plan carries \`adoptBranch: ${stamped}\`, which origin ` +
  `does NOT carry — origin has ${branches.join(', ')}. The stamp is STALE, so the plan-2863 ` +
  `exclusion stands rather than the adopt carve-out.`;

// plan 3111: more than one execution branch for one id. Plan 2855 had three at once; "which one do
// I continue" is a human call, never an unattended one, so the plan stays excluded and every branch
// is named. Distinct exclude code from `already-on-origin` because the operator action differs —
// fold/delete the extras, not adopt one at random (the precedent this file's own history sets: plan
// 2459's `all_batch_held`, plan 2556's split of it, and plan 2863's own reason).
const adoptAmbiguousReason = (stamped, branches) =>
  `adopt-ambiguous: this plan carries \`adoptBranch: ${stamped}\` but origin holds ` +
  `${branches.length} execution branches for its id (${branches.join(', ')}) — which one a taker ` +
  'should continue is a human call. Fold or delete the extras, then re-stamp with ' +
  '`node scripts/plan-adopt-branch.mjs <id>` and re-run.';

// Given parsed plan metas + whether a LANDING row is held, return either the
// ordered eligible set ({ next, eligible }) or a { reason, … } when nothing is
// runnable. Pure — no fs, no git.
//
// plan 2556: BOTH shapes additionally carry `runnableBatches` (see
// computeRunnableBatches above). It is deliberately present on the exit-1 payload too —
// `all_batch_held` is precisely the state where no SINGLE plan is runnable but a train
// is, and the exit CODE is left unchanged (exit 1 keeps meaning "no single plan
// runnable") because drain-run.mjs, local-drain-filter.mjs and orchestrate-dryrun.mjs
// all read exit 0 as "`.next` exists". Consumers that can take a train check
// `.runnableBatches` regardless of the exit code, and only stop when it is empty too.
//
// `onOriginIds` (plan 2863, widened by plans 3111/3583): `Map<id, {name, fresh}[]>` — the execution
// branches origin carries per plan id — or `null` when the caller could not (or does not) read origin, which
// turns the gate OFF. A `Set` is NOT accepted any more: the adopt carve-out needs `.get(id)`.
//
// `seedLane` (default true): when false (config-less / non-vetapp repo), the
// SEED-WRITE mutex and sort-priority are disabled — all plans compete by id only,
// and landingHeld has no effect. The seedLane=true path is byte-identical to the
// original behaviour (vetapp).
export function selectEligible(
  metas,
  { landingHeld = false, seedLane = true, batchRoster = null, onOriginIds = null } = {},
) {
  if (metas.length === 0)
    return { reason: 'empty', excluded: [], runnableBatches: [], skippedBatches: [] };

  const { runnable: runnableBatches, skipped: skippedBatches } = computeRunnableBatches(
    metas,
    batchRoster,
    { landingHeld, seedLane },
  );

  // plan 2863: stamp the already-on-origin exclusion onto a COPY of each affected meta, so this
  // function stays pure (its inputs are never mutated) while the exclusion flows through the normal
  // excluded/toExcluded path — the plan is REPORTED with a reason, never silently vanished.
  //
  // `onOriginIds === null` means the caller could not read origin (or is a non-cloud/dry-run caller)
  // and the gate is OFF: this is duplication DEFENSE, so failing closed would brick the whole drain
  // on a transient network blip, which is strictly worse than the duplicate it prevents. Since plan
  // 3111/3583 it is a `Map<id, {name, fresh}[]>`; `.size`/`.has` behave
  // exactly as the old Set's did.
  //
  // Bounded on purpose: applied to SINGLE-plan candidates only, never to `computeRunnableBatches`
  // above. A batch train is one co-executed unit with its own claim-all-or-release semantics, and
  // withholding a whole train because one member has a branch on origin is a different decision than
  // the one measured here — that stays with the train's own adoption path.
  //
  // plan 3111 — THE ADOPT CARVE-OUT. The 2863 gate could not tell a LIVE rival's branch from a DEAD
  // predecessor's hand-off, and defaulted to exclude for both. That is right for the rival and wrong
  // for the hand-off: a cap-killed cloud session's plan, deliberately re-filed to `ready/` with its
  // branch preserved and its body saying CONTINUE IT, was excluded here and told to "adopt it" — an
  // instruction whose only possible taker IS the drain this gate just withheld it from. Measured
  // live on 3073/3084/3092. The discriminator is an explicit `adoptBranch:` stamp naming the exact
  // branch (written by scripts/plan-adopt-branch.mjs, the one authority all three ready/-writers
  // call), and the carve-out fires ONLY on an exact name match. Four outcomes, no silent
  // fall-through:
  //
  //   stamp matches origin's single branch  → SELECTED, `next.adoptBranch` carries it through
  //   stamp set, origin has >1 branch       → excluded 'adopt-ambiguous', naming every branch
  //   stamp set, origin has a DIFFERENT one → excluded 'already-on-origin' (the stamp is stale)
  //   no stamp, branch on origin            → excluded 'already-on-origin', EXACTLY as before
  //
  // A plan whose stamp names a branch origin no longer carries at all is not in this map, so no
  // exclusion fires and the stamp is simply inert — asserted by a test so a future refactor cannot
  // quietly turn an inert stamp into an exclusion.
  //
  // RESIDUAL RACE, accepted and not closed: if a rival firing is genuinely still alive when a human
  // re-files its plan to `ready/`, the authority stamps `adoptBranch` and this carve-out hands the
  // plan out. That is not a new hole — re-filing INTO `ready/` has always been the board's assertion
  // that a plan is free, and the header above says plainly that this gate IS NOT A MUTEX. The mutex
  // is and remains `refs/claims/<id>`. Do not "harden" the carve-out into one.
  const gated =
    onOriginIds && onOriginIds.size > 0
      ? metas.map((m) => {
          if (m.exclude) return m;
          const branches = onOriginIds.get(canonicalPlanId(m.id));
          if (!branches || branches.length === 0) return m;
          // plan 3619: a live gate-blocked drain outranks every other reading of this id's
          // branches, stamped or not. It is the one case where origin's branch state is KNOWN to be
          // lagging a live sandbox, so neither "adopt it" nor "hands off until the threshold" is
          // true — and an `adoptBranch` stamp must not wave a drain into a worktree over the top of
          // a session that is still working. Checked before the stamp dispatch for exactly that.
          const gateBlockedBranch = branches.find((b) => b.gateBlocked);
          if (gateBlockedBranch)
            return {
              ...m,
              exclude: 'gate-blocked',
              excludeReason: gateBlockedReason(gateBlockedBranch.status),
            };
          // plan 3767: collapse AFTER the gate-blocked check (a live gate-blocked drain must
          // never be hidden behind its own same-sha twin) and BEFORE every dispatch below, so
          // neither the unstamped nor the stamped arm has to special-case a same-sha pair —
          // they just see ONE branch (or the genuinely divergent list, unchanged).
          const { branches: collapsed, duplicates } = collapseSameShaBranches(branches);
          const stamped = m.adoptBranch;
          if (!stamped)
            return {
              ...m,
              exclude: 'already-on-origin',
              // Review fix (plan 3111, finding 4 — CONFIRMED): when origin holds MORE THAN ONE
              // branch for an unstamped id, the bare reason tells the reader to "adopt it" while
              // withholding the fact that there is more than one "it" — and following that
              // guidance can resume the wrong rival branch. The stamped path already refuses that
              // choice as a human call (`adopt-ambiguous`); the unstamped path cannot refuse
              // (plan 2863's exclusion is correct here regardless), but it can at least NAME the
              // branches so the choice is made with the facts. One branch keeps the exact
              // pre-3111 sentence, byte-for-byte.
              // plan 3583: keep fresh stakes distinct. On 2026-08-31 `/ready-plans` read the old
              // adoption wording and proposed deleting plan 3562's marker while its live cloud
              // drain was mid-run; collapsing this split recreates that near-miss.
              // plan 3767: a same-sha COLLAPSE (duplicates.length > 0) is ONE finished branch,
              // not an unresolved rival — it gets the plain single-branch sentence plus a
              // footnote naming what else origin still carries at that identical tip, never the
              // "decide which one is the truth" NOTE (there is nothing to decide).
              excludeReason: collapsed.every((b) => b.fresh)
                ? HANDS_OFF_ON_ORIGIN_REASON
                : duplicates.length > 0
                  ? `${ALREADY_ON_ORIGIN_REASON} (origin also carries ` +
                    `${duplicates.map((b) => b.name).join(', ')} at the same tip)`
                  : collapsed.length > 1
                    ? `${ALREADY_ON_ORIGIN_REASON}. NOTE: origin holds ${collapsed.length} execution ` +
                      `branches for this id (${collapsed.map((b) => b.name).join(', ')}) — decide ` +
                      `which one is the truth before adopting either.`
                    : ALREADY_ON_ORIGIN_REASON,
            };
          if (collapsed.length > 1)
            return {
              ...m,
              exclude: 'adopt-ambiguous',
              excludeReason: adoptAmbiguousReason(
                stamped,
                collapsed.map((b) => b.name),
              ),
            };
          // collapsed.length === 1 here — either origin genuinely carried one branch, or a
          // same-sha set just collapsed to its preferred name. Plan 3767: the stamp matches if
          // it names EITHER the preferred branch or one of the duplicates folded into it (the
          // stamp may have been written against the exact branch the collapse just retired —
          // the plan-3652 shape). `next.adoptBranch` stays whatever the stamp already was: a
          // match is a match, never rewritten to the preferred name just because it collapsed.
          const sameTipNames = [collapsed[0].name, ...duplicates.map((b) => b.name)];
          if (!sameTipNames.includes(stamped))
            return {
              ...m,
              exclude: 'already-on-origin',
              excludeReason: adoptStaleReason(stamped, sameTipNames),
            };
          return m; // the hand-off case: selected, with the branch to adopt on the payload.
        })
      : metas;

  const excluded = gated.filter((m) => m.exclude);
  let candidates = gated.filter((m) => !m.exclude);

  // seedy(): treat a plan as seed-write only when the lane is active.
  // seedLane off ⇒ nothing is seedy → mutex never fires, sort is pure id order.
  const seedy = (m) => seedLane && isSeedWrite(m);

  let mutexDropped = [];
  if (landingHeld && seedLane) {
    mutexDropped = candidates.filter(seedy);
    candidates = candidates.filter((m) => !seedy(m));
  }

  if (candidates.length === 0) {
    let reason;
    if (mutexDropped.length > 0) reason = 'landing_mutex_active';
    else if (excluded.every((m) => m.exclude === 'operator')) reason = 'all_need_operator';
    // plan 1781: a --cloud run whose ready/ pool holds NOTHING stamped cloudExec:true —
    // distinct from 'all_blocked' so the cloud routine reports "no cloud-eligible plan"
    // (the expected steady state until spec-pass backfills the axis) rather than hunting
    // for a phantom upstream.
    else if (excluded.length > 0 && excluded.every((m) => m.exclude === 'cloud'))
      reason = 'all_not_cloud_eligible';
    // plan 2863: its OWN reason when the pool is excluded purely by the origin gate, following the
    // 'cloud' precedent directly above rather than being folded into all_fable_or_stub. The operator
    // action here is ADOPT the finished branches (`cut-worktree.mjs <slug> --adopt`) — a different
    // action from "route to /spec-pass or a Fable session", and this file's own history (plan 2459's
    // all_batch_held, plan 2556's review finding 1) is that conflating distinct operator actions into
    // one reason misdirects whoever reads it. It still joins the lifecycle set below for MIXED pools,
    // where the alternative would be the outright-wrong 'all_blocked'.
    else if (excluded.length > 0 && excluded.every((m) => m.exclude === 'already-on-origin'))
      reason = 'all_already_on_origin';
    // plan 3111: its OWN reason for the same reason all_already_on_origin got one — the operator
    // action differs. `all_already_on_origin` says "adopt the finished branch"; this says "origin
    // holds SEVERAL branches for these ids, decide which one is the truth (fold or delete the
    // rest), then re-stamp". Folding the two would send a reader to adopt a branch that has not
    // been chosen yet.
    else if (excluded.length > 0 && excluded.every((m) => m.exclude === 'adopt-ambiguous'))
      reason = 'all_adopt_ambiguous';
    // plan 2459 Task 2: a pool excluded ONLY by the runnable-batch hold gets its OWN
    // reason, deliberately NOT folded into all_fable_or_stub below — "take the train"
    // is a different operator action than a lifecycle stub (route to /spec-pass or a
    // Fable session), so conflating the two would misdirect whoever reads this reason.
    //
    // plan 2556 (review finding 1): SPLIT IN TWO, because `all_batch_held` stopped implying
    // "a train is takeable" the moment `batchHold.otherwise` existed. A member can be
    // batch-held AND blocked underneath the hold (the batch gate sits above Blocked-by), so
    // a pool that is entirely batch-held can still have NO runnable train — and reporting
    // `all_batch_held` there tells the reader to go take a train that is not on offer,
    // contradicting this file's own header contract. The two states now say which they are.
    else if (excluded.length > 0 && excluded.every((m) => m.exclude === 'batch'))
      reason = runnableBatches.length > 0 ? 'all_batch_held' : 'all_batch_held_none_runnable';
    // plan 1292 bugfix: a queue excluded ONLY by the fable/stub lifecycle gates (never
    // truly "blocked" — a fable plan just needs a Fable session, a stub just needs
    // /spec-pass) used to misreport as 'all_blocked' alongside genuine cross-plan-blocked
    // and malformed-Blocked-by exclusions. Distinct reason so the driver/operator doesn't
    // read "blocked" and go hunting for an upstream plan that doesn't exist. cloud-excluded
    // plans join fable/stub here when the pool is a MIX of lifecycle-gated kinds. plan 1810:
    // 'sonnet-lane' (the --lane fable inversion's exclude code) joins the same set — a
    // fable-lane pool holding only sonnet/stub/unstamped plans is the same "lifecycle, not
    // blocked" class, not a genuine cross-plan block. The reason STRING stays
    // 'all_fable_or_stub' (routine prompts may match on it) even though the membership now
    // spans both lane directions. plan 1925/2003/2250/2313, generalized by plan
    // 2323: every CLOUD_ENV_RUNGS exclude code ('full-env' / 'webkit-env' /
    // 'browser-env' today) joins the same lifecycle set via CLOUD_ENV_EXCLUDE_CODES
    // — a pool whose plans all need a stronger-lane cloudEnv rung is "wrong lane",
    // never "blocked on an upstream", and a future rung joins automatically
    // ('trusted-env' is retired since plan 2003: the full lane is a superset and
    // excludes nothing on this axis). plan 3341: 'sol' joined the same set for a
    // pool that was entirely non-drain-claimable sol plans ("wrong lane", never a
    // cross-plan block); plan 3461 made `sol` drain-claimable, so the generic
    // non-drainClaimable branch that used to emit the literal 'sol' code is now
    // unreachable for it (no recognized lane currently has `drainClaimable:
    // false`) — the membership check for it is left in place as a harmless no-op
    // rather than removed, since it still correctly classifies whatever future
    // lane's non-claimable exclude code happens to equal the string 'sol' (there
    // is none today). SOL_ENV_EXCLUDE_CODES (the sol lane's own environment
    // refusals — still reachable: trusted cloud is a permanent refusal) stays
    // fully live and joins the same set for the same reason — a pool excluded
    // only by the sol environment ladder is "wrong env", never a cross-plan
    // block; 'exec-lane-malformed' does NOT join it, because an unrecognized
    // execModel is a genuine data problem to fix, not a lifecycle state to route
    // around.
    else if (
      excluded.length > 0 &&
      excluded.every(
        (m) =>
          m.exclude === 'fable' ||
          m.exclude === 'stub' ||
          m.exclude === 'cloud' ||
          m.exclude === 'sonnet-lane' ||
          m.exclude === 'sol' ||
          m.exclude === 'already-on-origin' ||
          // plan 3111: joins the same MIXED-pool set already-on-origin joined, for the same
          // reason — in a mixed pool the alternative is the outright-wrong 'all_blocked' (there
          // is no upstream plan to go hunting for). The pure-pool case still gets its own
          // all_adopt_ambiguous reason above.
          m.exclude === 'adopt-ambiguous' ||
          CLOUD_ENV_EXCLUDE_CODES.has(m.exclude) ||
          SOL_ENV_EXCLUDE_CODES.has(m.exclude),
      )
    )
      reason = 'all_fable_or_stub';
    else reason = 'all_blocked'; // 'blocked' + 'malformed' (and any fable/stub MIXED with those)
    return {
      reason,
      excluded: excluded.map(toExcluded),
      mutexDropped: mutexDropped.map((m) => m.slug),
      // plan 3955: a SIBLING array, never a change to `mutexDropped`'s own shape — that array is
      // a pinned contract (bare slug strings, asserted with deepEqual by several tests and read
      // as slugs by the drain prompts/runbook), so cost rides alongside it here instead of being
      // folded in. `/ready-plans` needs each mutex-held plan's cost too (it renders every ready/
      // row, not only the takeable ones), and a mutex hold otherwise reached the board as a bare
      // slug with no cost anywhere to read.
      mutexDroppedMeta: mutexDropped.map((m) => ({ slug: m.slug, cost: m.cost })),
      // plan 2556: present on the NOTHING-RUNNABLE shape too. `all_batch_held` is
      // exactly the state where no single plan is takeable but a train is, so a
      // consumer that can run a batch must be able to see it without the exit code
      // changing underneath every consumer that cannot.
      runnableBatches,
      skippedBatches,
    };
  }

  candidates.sort(planRank(seedy));

  // `excluded` is returned on the success path too (not just the no-runnable
  // path) so the driver can accumulate the skip-list across iterations and report
  // it at closing — what was skipped and why (plan 443). `mutexDropped` likewise
  // rides the success path (plan 948): without it, `excluded:[]` reads as "all
  // runnable" while N 🟥 plans are invisibly withheld by the LANDING mutex —
  // opaque to the orchestrator and to a human reading the oracle output. Empty
  // [] when no LANDING is held, so the shape is stable across both branches.
  return {
    next: toItem(candidates[0]),
    eligible: candidates.map(toItem),
    excluded: excluded.map(toExcluded),
    mutexDropped: mutexDropped.map((m) => m.slug),
    // plan 3955: same sibling-array rationale as the nothing-runnable branch above — additive,
    // `mutexDropped` itself untouched.
    mutexDroppedMeta: mutexDropped.map((m) => ({ slug: m.slug, cost: m.cost })),
    // plan 2556: a runnable train and a runnable single plan coexist routinely — the
    // batch check runs BEFORE `.next` in every routine prompt, so this must ride the
    // success path too, not only the all_batch_held one. Empty [] when no batch is
    // takeable, so the shape is stable across both branches (same contract
    // `mutexDropped` above already follows).
    runnableBatches,
    skippedBatches,
  };
}

// --- CLI: fs + board.mjs wiring ----------------------------------------------

// The real scripts/ directory, NOT this module's own: every spawn below runs `board.mjs` or
// `landing-queue.mjs`, and neither moved to scripts/coord/ with this module (plan 3962 Phase 2).
const SCRIPTS_DIR = findScriptsDir(dirname(fileURLToPath(import.meta.url)));

// plan 2863: the ONE origin read per firing that feeds the already-executed-on-origin gate. A single
// `ls-remote --heads` scoped to the two execution-branch namespaces, not one call per candidate:
// cheaper than N calls AND it reports the whole picture in one shot (the mint's open question,
// resolved at spec-pass).
//
// NOT `coord-git.mjs`'s `lsRemoteTimed`: that helper takes ONE required positional ref and returns
// raw stdout, so it cannot express the two-pattern query this needs. Widening its signature for one
// caller would change a helper every `refs/claims` consumer shares; a direct `execFileSync` here —
// the same idiom `landingHeldViaBoard` below already uses in this file — is the smaller change.
//
// Fails OPEN (returns null ⇒ gate off) with a LOUD warning, never closed. The gate is duplication
// defense; bricking every drain firing on a transient network blip would be a worse failure than the
// duplicate it exists to prevent. The warning goes to stderr, so it reaches the routine's transcript
// without corrupting the JSON on stdout that every consumer parses.
//
// plans 3111/3583: returns `Map<id, {name, fresh}[]>` rather
// than the old `Set<id>` — the adopt carve-out compares a stamped branch name against it, and
// `plan-adopt-branch.mjs` reuses this exact function as its origin reader instead of re-rolling the
// `ls-remote`. `null` on failure is unchanged and load-bearing in BOTH consumers: here it means
// "gate off", and in the stamp authority it means "change nothing" — never "no branches found".
export function originExecutedPlanIds(
  repoRoot,
  {
    _exec = execFileSync,
    log = console.error,
    // Keep `now` before `_deadSeed`: the latter's default closes over it and would hit the TDZ if
    // an alphabetising refactor reversed these destructuring defaults.
    now = Date.now,
    // plan 3619: `_deadSeed` now takes the head's status heartbeat as a second argument. Kept
    // positional-optional so every existing caller and test that injects a one-arg stub is
    // unaffected — an injected stub that ignores it simply behaves as it did before.
    _deadSeed = (sha, statusHeartbeatMs = null) =>
      deadSeedVerdict(repoRoot, sha, { nowMs: now(), statusHeartbeatMs }),
    _readStatuses = readDrainStatuses,
  } = {},
) {
  try {
    // Ask origin for ONLY the two execution-branch namespaces rather than every head. Same single
    // round trip, but the server filters instead of us: on a repo carrying hundreds of heads (this
    // one does) that is most of the payload saved, and an unrelated branch can never even reach the
    // parser. The patterns are refspec globs, matched by git against the full ref name.
    const out = _exec(
      'git',
      [
        '-C',
        repoRoot,
        'ls-remote',
        '--heads',
        'origin',
        'refs/heads/claude/drain-*',
        'refs/heads/worktree-*',
        // plan 3619: the drain status namespace rides the SAME single ls-remote. It is a third
        // pattern, not a third round trip — the one-call property plan 2863 established is intact,
        // and `parseExecutionHeads`/`parseStatusHeads` each ignore what is not theirs. The
        // namespace deliberately does not match `claude/drain-*`, so no execution-branch parser can
        // mistake a status branch for work.
        DRAIN_STATUS_REF_GLOB,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000,
        maxBuffer: 1e8,
      },
    );
    // Read the published statuses ONCE per firing, keyed by plan id. Normally this map is empty
    // (nobody is gate-blocked) and the reader short-circuits without touching the network at all.
    let statusesByPlanId = new Map();
    try {
      // Re-keyed through `canonicalPlanId`, the same normaliser `parseExecutionHeads` runs its ids
      // through, so a zero-padded slug (`0912-…`) and a bare head id (`912`) cannot miss each other
      // — the identical trap plan 3111 called out for the branch map.
      const raw = _readStatuses(repoRoot, parseStatusHeads(out), { log }) ?? new Map();
      for (const [planId, status] of raw) statusesByPlanId.set(canonicalPlanId(planId), status);
    } catch (e) {
      // Fail OPEN in the SAME direction as the enclosing gate: an unreadable status channel must
      // degrade to the pre-3619 behaviour (the ordinary dead-seed age test), never brick selection.
      log(
        `queue-drain: WARNING — drain statuses unreadable (${e.message}); dead-seed clock unchanged.`,
      );
    }
    const survivors = [];
    const verdictsBySha = new Map();
    for (const head of parseExecutionHeads(out)) {
      const status = statusesByPlanId.get(head.id) ?? null;
      // The memo key is (sha, heartbeat), not sha alone: the verdict now depends on the status too,
      // and two heads can share a sha while belonging to different plan ids with different statuses
      // (a marker and a worktree branch staked at the same tip is the ordinary case). Keying on sha
      // alone would let the first head's status decide the second head's verdict.
      const verdictKey = `${head.sha} ${status?.heartbeatMs ?? ''}`;
      let cached = verdictsBySha.get(verdictKey);
      if (!cached) {
        try {
          cached = { verdict: _deadSeed(head.sha, status?.heartbeatMs ?? null), threw: false };
        } catch {
          cached = { verdict: null, threw: true };
        }
        verdictsBySha.set(verdictKey, cached);
      }
      if (cached.threw) {
        // plan 3767 (gpt-review round 2): `fresh: false` here means "the liveness probe FAILED",
        // not "this head is finished" — the two are indistinguishable in that boolean, and
        // `collapseSameShaBranches` must not read a probe failure as evidence that a same-sha
        // twin is a dead duplicate. Mark it explicitly so the collapse can refuse; every other
        // reader ignores the field and keeps the pre-3767 behaviour.
        survivors.push({ ...head, fresh: false, livenessUnknown: true });
        continue;
      }
      const verdict = cached.verdict;
      if (verdict?.dead === true) {
        const ageMs = Number.isFinite(verdict.ageMs) ? verdict.ageMs : DEAD_SEED_MIN_AGE_MS;
        const hours = Math.floor(Math.max(0, ageMs) / (60 * 60 * 1000));
        log(
          `queue-drain: ignoring DEAD SEED ${head.name} (no commits of its own, staked ≥${hours}h ago) — ` +
            `delete it: git push origin --delete ${head.name}`,
        );
      } else {
        survivors.push({
          ...head,
          fresh: HANDS_OFF_VERDICT_REASONS.has(verdict?.reason),
          livenessUnknown: UNKNOWN_LIVENESS_VERDICT_REASONS.has(verdict?.reason),
          gateBlocked: verdict?.reason === GATE_BLOCKED_VERDICT_REASON,
          status,
        });
      }
    }
    return executionHeadsByPlanId(survivors);
  } catch (e) {
    log(
      `queue-drain: WARNING — could not list origin heads (${e.message}). The duplicate-execution ` +
        `gate is OFF for this firing: a plan whose work already exists on origin may be picked and ` +
        `redone. Check connectivity/credentials before trusting this selection.`,
    );
    return null;
  }
}

// Ask the board whether a 🟢 LANDING row is held. board.mjs landing-held exits
// 0 (held) / 1 (not held) / 2 (error). Fail SAFE on error: assume held, so a
// 🟥 plan is never dispatched while the board state is unknown.
//
// Kept and still exported (plan 3443) — other callers/tests may want the blunt "is ANY row
// held" answer — but main() no longer consults it directly: the seed-lane-aware resolution
// below (resolveLandingHeldForSeedLane) is what feeds `landingHeld` now.
export function landingHeldViaBoard(scriptsDir = SCRIPTS_DIR, { _exec = execFileSync } = {}) {
  try {
    _exec('node', [join(scriptsDir, 'board.mjs'), 'landing-held'], { stdio: 'pipe' });
    return true; // exit 0 → a LANDING row is held
  } catch (e) {
    if (e.status === 1) return false; // documented "not held"
    console.error(`queue-drain: board landing-held check errored (assuming held): ${e.message}`);
    return true; // fail safe
  }
}

// plan 3443 Fix 2: cell 3 ("Plan / claim") of a held 🟢 LANDING row carries the executing
// plan's path in backticks — e.g. `` `in-progress/3309-FABLE-….md` `` — the same shape
// board-lib's cellsOf already splits table columns for; this just pulls the backticked ref
// back out of that cell.
const HELD_ROW_PLAN_REF_RX = /`([^`]+\.md)`/;

// plan 3443 Fix 2: resolve "held FOR THE SEED LANE" from a set of already-fetched 🟢 LANDING
// row lines (board.mjs `landing-held`'s stdout, one line per row) — PURE, so this is unit
// testable without git or a real board. `readPlanContent(ref)` is injected: production wires
// it to an authoritative git-show-from-origin read (readPlanContentFromOrigin below); tests
// hand it a plain lookup.
//
// Applies the SAME conservative rule `isSeedWrite` (above) applies to ready/ candidates —
// SEED-WRITE 'no' ⇒ 🟩 (does not hold the seed lane); 'yes'/'maybe'/a missing banner ⇒ 🟥
// (holds) — read off each held row's OWN plan, never the board's glyph (the board carries no
// SEED-WRITE glyph at all; only the plan body does). Fails toward HELD on ANY read/parse
// error for a row: an unparseable row, a missing plan ref, or an unreadable plan all count as
// 🟥, mirroring landingHeldViaBoard's own catch-arm fail-safe direction above. Short-circuits
// on the first held row — the result only needs to be true/false, so every remaining row is
// exactly as un-consulted as it always was under the old blunt boolean.
export function seedLaneHeldFromRows(rows, readPlanContent, { log = console.error } = {}) {
  for (const line of rows) {
    const cells = cellsOf(line);
    if (!cells || cells.length < 4) {
      log(
        `queue-drain: seed-lane resolve — unparseable held row (${JSON.stringify(line)}); ` +
          'failing toward HELD',
      );
      return true;
    }
    const slug = cells[0];
    const refMatch = HELD_ROW_PLAN_REF_RX.exec(cells[3]);
    if (!refMatch) {
      log(
        `queue-drain: seed-lane resolve — row "${slug}" has no parseable plan ref in its ` +
          'claim cell; failing toward HELD',
      );
      return true;
    }
    let content;
    try {
      content = readPlanContent(refMatch[1]);
    } catch (e) {
      log(
        `queue-drain: seed-lane resolve — could not read plan "${refMatch[1]}" for row ` +
          `"${slug}" (${e.message}); failing toward HELD`,
      );
      return true;
    }
    if (readSeedWriteValue(content) !== 'no') return true; // 🟥 (or unreadable/missing banner)
  }
  return false; // every held row's plan is 🟩 — the seed lane is free
}

// plan 3443: the git-show-from-origin reader `seedLaneHeldFromRows` is wired to in
// production — AUTHORITATIVE, the same provenance rule `landing-held`/`landing-age`
// themselves already read the board through (plan 989: MAIN's on-disk checkout can drift
// behind origin in a shared-.git fleet; a stale local read could miss a sibling's
// freshly-stamped SEED-WRITE banner). There is NO local-disk fallback — see the fail-closed
// rationale in the body.
export function readPlanContentFromOrigin(repoRoot, ref, { _exec = execFileSync } = {}) {
  if (!repoRoot) throw new Error('readPlanContentFromOrigin: no repoRoot available');
  const gitPath = `docs/superpowers/plans/${ref}`;
  // plan 3443 review Fix 7: FAIL CLOSED, deliberately — no local-disk fallback. This feeds
  // `seedLaneHeldFromRows`, whose own catch-arm already fails toward HELD on any read error
  // here (the mutex's whole point is conservatism). The pre-fix fallback to the local checkout
  // silently traded that authoritative-origin read for a possibly-STALE local copy — exactly
  // the drift plan 989 introduced the origin/master read to close (a shared-.git fleet's local
  // checkout can lag behind a sibling's freshly-pushed SEED-WRITE banner). A local file saying
  // 🟩 while origin says 🟥 would wrongly FREE the seed lane — the one direction this mutex must
  // never move on unverifiable data. Letting the git failure propagate is intentional: the
  // caller's fail-toward-HELD catch is the correct response to "cannot read authoritatively",
  // not a silent read of whatever happens to be on disk. Fix 2's `git fetch origin` ahead of
  // every call site here keeps the local ref this reads current in the common case, so this
  // throw is reserved for a genuine reachability/auth failure.
  return _exec('git', ['-C', repoRoot, 'show', `origin/master:${gitPath}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// plan 3816 fix round (review Fix 1): the LISTING twin of readPlanContentFromOrigin above, now
// returning BLOB SHAS rather than bare paths — mirroring in-progress-board.mjs's
// listPlansFromOrigin (the plan-3247 shape this fix was told to mirror). The pre-fix listing
// (`--name-only`) plus a PER-FILE `git show origin/master:<path>` had two problems: (1) a
// concurrent fetch could advance `origin/master` between the listing and a later file's content
// read (ready-board.mjs runs TWO oracles concurrently, each now fetching), so the oracle could
// list one snapshot and read contents from another, or throw when a listed file had since
// vanished from the ref it re-resolves at each `git show`; (2) it was one subprocess per ready
// file, not one for the whole scan. A blob sha names an IMMUTABLE git object — reading its
// content later by sha (readBlobsBatched below) can never be affected by any later ref move, so
// the snapshot is stable BY CONSTRUCTION rather than by hoping no fetch lands mid-scan.
//
// `git ls-tree -r <commitSha> -- docs/superpowers/plans/ready` (no `--name-only`) on a path
// that is simply ABSENT at that ref exits 0 with empty stdout (the same absent-vs-fault
// distinction batch-paths.mjs's resolveManifestAtRefTri documents for `git ls-tree` generally)
// — never confused with a git-command fault, which still throws through `_exec`. Each line is
// `<mode> <type> <sha>\t<path>` — split on the FIRST tab (a path can itself contain no tab, but
// splitting on the first one rather than assuming a fixed prefix width is the robust read), and
// the sha is the 3rd whitespace-separated token in the part before it.
//
// `ref` (plan 3816 fix round 2, Fix A): an explicit, already-resolved COMMIT SHA — never the
// mutable `origin/master` ref name. Passing the ref lets the caller resolve `origin/master` to
// one immutable sha ONCE (readReadyMetas below) and reuse it here and in readBlobsBatched, so a
// concurrent `git fetch` landing between this call and the caller's earlier resolve can no
// longer make the listing and the resolved/reported sha name two different commits.
export function listReadyBlobsFromOrigin(repoRoot, ref, { _exec = execFileSync } = {}) {
  if (!repoRoot) throw new Error('listReadyBlobsFromOrigin: no repoRoot available');
  if (!ref) throw new Error('listReadyBlobsFromOrigin: no ref (commit sha) available');
  const out = _exec(
    'git',
    ['-C', repoRoot, 'ls-tree', '-r', ref, '--', `docs/superpowers/plans/${READY_FOLDER}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
  );
  const entries = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const sha = line.slice(0, tab).trim().split(/\s+/)[2];
    const path = line.slice(tab + 1);
    if (sha && path.endsWith('.md')) entries.push({ sha, path });
  }
  return entries;
}

// plan 3816 fix round (review Fix 1): ONE `git cat-file --batch` call for a whole SET of blob
// shas — the byte-offset parser is PORTED from in-progress-board.mjs's listPlansFromOrigin
// rather than imported (queue-drain.mjs is the one coordShare-adopted-byte-identical file the
// tandapp sibling pulls verbatim; in-progress-board.mjs is not on that adopt list, so an import
// here would ERR_MODULE_NOT_FOUND the sibling's copy the moment it syncs — the same
// one-directional constraint documented on BLOCKED_BY_LINE_RE above). `encoding: null` — NOT the
// string `'buffer'`, which throws `Unknown encoding: buffer` when `input` is also a string,
// because Node encodes `input` with this same value — is what makes `out` a raw Buffer, so this
// can slice by the BYTE size cat-file's header reports rather than a pre-decoded utf8 string (a
// multi-byte character straddling a size boundary would corrupt every later offset).
//
// Returns contents aligned index-for-index with `shas`; a missing or malformed blob resolves to
// `null` at its own index (mirroring listPlansFromOrigin's unreadable-entry-survives contract)
// rather than throwing, so one vanished/truncated blob cannot take down the whole ready/ read —
// once the stream stops being parseable, every remaining index degrades to `null` too, since a
// malformed header means the position of the NEXT object is no longer known.
export function readBlobsBatched(repoRoot, shas, { _exec = execFileSync } = {}) {
  if (!repoRoot) throw new Error('readBlobsBatched: no repoRoot available');
  if (shas.length === 0) return [];
  const input = shas.join('\n') + '\n';
  const out = _exec('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input,
    encoding: null,
    maxBuffer: GIT_MAXBUFFER,
    timeout: 15000,
  });
  const contents = [];
  let offset = 0;
  let unrecoverable = false;
  for (let i = 0; i < shas.length; i++) {
    if (unrecoverable) {
      contents.push(null);
      continue;
    }
    const nl = out.indexOf(0x0a, offset);
    if (nl === -1) {
      unrecoverable = true;
      contents.push(null);
      continue;
    }
    const header = out.slice(offset, nl).toString('utf8').trim();
    offset = nl + 1;
    const parts = header.split(/\s+/);
    const size = parts.length >= 3 ? parseInt(parts[2], 10) : NaN;
    if (parts[1] === 'missing') {
      contents.push(null); // a vanished blob — no body follows, offset stays correct
      continue;
    }
    if (!Number.isFinite(size) || offset + size > out.length) {
      unrecoverable = true;
      contents.push(null);
      continue;
    }
    contents.push(out.slice(offset, offset + size).toString('utf8'));
    offset += size + 1; // the trailing newline cat-file --batch appends after each object
  }
  return contents;
}

// plan 3443 Fix 1: minutes since `iso`, or null on an absent/unparseable stamp — the same
// arithmetic landing-lock.mjs's ageMinutes uses, inlined rather than imported so this file
// pulls in only the two named landing-queue-lib exports the execution notes call for.
function ageMinFromIso(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (nowMs - t) / 60000;
}

// plan 3443 Fix 1: the reaper's QUEUE input for one held slug — does a live landing-queue
// entry exist, and if so is its heartbeat still fresh? `position === 0` (landing-queue.mjs's
// positionOf) means no entry at all. Any throw or unparseable JSON fails toward "unknown"
// (never toward reaping) — matches landingRowReapVerdict's own fail-open contract for a null
// queueEntryPresent.
export function queueStateFor(scriptsDir, slug, nowMs, { _exec = execFileSync } = {}) {
  try {
    const out = _exec('node', [join(scriptsDir, 'landing-queue.mjs'), 'status', slug, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const payload = JSON.parse(out);
    if (payload.position === 0) return { queueEntryPresent: false, queueHeartbeatFresh: null };
    const ageMin = payload.heartbeatIso ? ageMinFromIso(payload.heartbeatIso, nowMs) : null;
    // plan 3443 review Fix 1: `ageMin === null` (an absent OR unparseable heartbeatIso) must
    // resolve to `queueHeartbeatFresh: null` ("unknown"), never `ageIsFresh(null, …)` —
    // `ageIsFresh` reads `ageMin != null && ageMin <= staleMin`, so a null age comes back
    // `false`, which THIS caller's downstream (`landingRowReapVerdict`) reads as "heartbeat gone
    // stale" — a WRITE-decision input, where fail-open means unknown must never masquerade as
    // proof of staleness. Passing null straight through made the verdict's own
    // `queueHeartbeatFresh === null` branch unreachable from production and pushed a present-
    // but-unreadable heartbeat toward reaping — the opposite of the documented fail-open
    // contract.
    return {
      queueEntryPresent: true,
      queueHeartbeatFresh: ageMin == null ? null : ageIsFresh(ageMin, DEFAULT_STEAL_STALE_MIN),
    };
  } catch (e) {
    console.error(
      `queue-drain: reaper — landing-queue status check errored for "${slug}" (${e.message}); ` +
        'queue state unknown',
    );
    return { queueEntryPresent: null, queueHeartbeatFresh: null };
  }
}

// plan 3443 Fix 1: the reaper's BRANCH input — has the plan's execution branch moved since
// the `landing@` stamp? Two candidate origin refs (worktree-<slug> / claude/drain-<slug>);
// neither resolving is "no progress" (false), a git error other than "ref doesn't exist" is
// "unknown" (null, never toward reaping), and a resolved ref's tip committer time strictly
// after the stamp is "progress" (true).
export function branchProgressedSince(repoRoot, slug, landingIso, { _exec = execFileSync } = {}) {
  const landingMs = landingIso ? Date.parse(landingIso) : NaN;
  const refs = [`refs/remotes/origin/worktree-${slug}`, `refs/remotes/origin/claude/drain-${slug}`];
  try {
    for (const ref of refs) {
      let sha = '';
      try {
        sha = _exec('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', ref], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      } catch (e) {
        if (e.status === 1) continue; // ref does not resolve — try the next candidate
        throw e; // a genuine git error, not "ref absent"
      }
      if (!sha) continue;
      // plan 3443 re-review round 2: compare at SECOND granularity, rounding toward "progress".
      //
      // A git commit timestamp has no sub-second component at all — `%ct` is whole Unix seconds
      // and `%cI` renders the same value as `2026-08-25T15:52:59+00:00`, never with a fraction
      // (verified against real git, not assumed; an earlier pass "fixed" this by switching to
      // `%cI` and pinned it with a stub emitting `…:00.750Z`, output git cannot produce — the
      // change was inert and the test fictional). `landing@`, by contrast, is a full-precision
      // ISO stamp from `new Date().toISOString()`, so it carries milliseconds.
      //
      // Comparing `tipSec * 1000 > landingMs` therefore loses every commit made in the SAME
      // second as the claim: `stampLanding` at `…:00.812Z` against a commit at `…:00` compares
      // 00.000 > 00.812 → false → "no progress" → a stale-side input, i.e. toward reaping a live
      // land. Truncating the STAMP to its second instead makes the two comparable, and `>=`
      // resolves the remaining ambiguity within that shared second toward "progress" — the
      // never-reap direction, which is the only safe way to round a WRITE decision.
      const tipSec = Number(
        _exec('git', ['-C', repoRoot, 'log', '-1', '--format=%ct', sha], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim(),
      );
      if (
        !Number.isNaN(landingMs) &&
        Number.isFinite(tipSec) &&
        tipSec >= Math.floor(landingMs / 1000)
      ) {
        return true;
      }
    }
    return false; // neither ref resolved, or a resolved ref's tip is not after the stamp
  } catch (e) {
    console.error(
      `queue-drain: reaper — branch-progress check errored for "${slug}" (${e.message}); ` +
        'branch state unknown',
    );
    return null;
  }
}

// plan 3443 review Fix 5: the row's `landing@` stamp lives in cell 4 ("Last touched" —
// `stampLanding`'s own write target) ONLY. Scanning the WHOLE row line (the pre-fix approach)
// can pick up an unrelated `landing@…` token surviving in another cell — notably the resume
// cell (cell 5), where the reaper's own prior REAPED note quotes the stamp it acted on. Reading
// only cell 4 means an ABSENT cell-4 stamp reads as `landingIso: null` (cannot prove staleness)
// even when an old token lingers elsewhere in the row.
function landingIsoFromRow(rowLine) {
  const cells = cellsOf(rowLine);
  const touchedCell = cells ? cells[4] : null;
  const stampMatch = touchedCell ? touchedCell.match(/landing@(\S+)/) : null;
  return stampMatch ? stampMatch[1] : null;
}

// plan 3443 Fix 1 / review Fixes 3-5: gathers the three staleness inputs for ONE held row, asks
// board-lib's pure landingRowReapVerdict, and — on `stale: true` — flips the row to ⏸ PAUSED via
// the normal `board.mjs update` CLI (the existing coordWrite mutate/retry path; a non-ff retry
// there is expected, never an error). Returns true iff the row was actually reaped this call. A
// board-write failure logs and leaves the row HELD for this firing — it never "succeeds" into a
// reaped state it didn't actually achieve.
//
// review Fix 3: a batch MEMBER row's board row carries the MEMBER plan's own slug (cell 0), but
// the batch QUEUES and EXECUTES under the batch's own slug — the member slug was never enqueued
// and never has its own execution branch, so probing the queue/branch state by the member slug
// for a member row always reads "no entry" / "no branch", pushing a LIVE batch's member rows
// toward reaping. `batchSlugOfCell`/`isBatchMemberCell` (board-lib.mjs, the same marker
// `claim-plan-lib.mjs`'s `boardBatchPlanClaimCell` writes) redirect the queue/branch LOOKUPS to
// the batch slug for a member row; the board WRITE below still targets the row's own slug (cell
// 0) — only the liveness lookups move. A `batch=` marker present but unparseable (a corrupted
// cell) is treated as UNKNOWN rather than guessed at either way: `queueEntryPresent: null` fails
// toward "never reap" via `landingRowReapVerdict`'s own contract, without ever shelling out for
// a lookup keyed on a slug this function cannot trust.
export function reapRowIfStale(
  scriptsDir,
  repoRoot,
  slug,
  rowLine,
  nowMs,
  { _exec = execFileSync, log = console.error } = {},
) {
  const landingIso = landingIsoFromRow(rowLine);

  const cells = cellsOf(rowLine);
  const planClaimCell = cells ? cells[3] : '';
  let queueBranchSlug = slug;
  let queueUnknown = false;
  if (isBatchMemberCell(planClaimCell)) {
    const batchSlug = batchSlugOfCell(planClaimCell);
    if (batchSlug) {
      queueBranchSlug = batchSlug;
    } else {
      queueUnknown = true;
      log(
        `queue-drain: reaper — row "${slug}" carries a batch= marker that could not be parsed ` +
          '(no slug value); queue/branch state UNKNOWN, never reaping off an unparseable marker',
      );
    }
  }

  let queueEntryPresent = null;
  let queueHeartbeatFresh = null;
  let branchProgressed = null;
  if (!queueUnknown) {
    ({ queueEntryPresent, queueHeartbeatFresh } = queueStateFor(
      scriptsDir,
      queueBranchSlug,
      nowMs,
      {
        _exec,
      },
    ));
    // plan 3443 re-review round 2: a batch-member row with NO queue entry is treated as
    // genuinely ABSENT, exactly like an ordinary row — deliberately NOT forced to "unknown".
    //
    // An earlier pass did force it to unknown, reasoning that a mis-resolved batch slug looks
    // like a dead batch. That trade was wrong in both directions. It bought nothing: a LIVE
    // batch is already protected by the branch check below, which now probes the BATCH slug's
    // execution branch — a live batch's branch exists and is progressing, so `branchProgressed`
    // comes back true and the row is not stale regardless of the queue answer. And it cost a
    // PERMANENT wedge: a genuinely dead batch member row's queue entry is gone for good
    // (`landing-queue.mjs` dequeue removes it), so "unknown" would never resolve and that row
    // could never be reaped at all — re-creating, for batch rows specifically, the indefinite
    // seed-lane wedge this whole plan exists to end.
    branchProgressed = branchProgressedSince(repoRoot, queueBranchSlug, landingIso, { _exec });
  }

  const verdict = landingRowReapVerdict({
    landingIso,
    nowMs,
    queueEntryPresent,
    queueHeartbeatFresh,
    branchProgressed,
  });
  if (!verdict.stale) return false;

  // plan 3443 review Fix 4 (TOCTOU): the verdict above was computed from a landing-held
  // SNAPSHOT that may already be stale itself — a session can resume and re-stamp LANDING
  // between that read and this write. Re-read the held rows ONE more time, immediately before
  // the write, and confirm the target row is still present, still exactly 🟢 LANDING, and still
  // carries the SAME cell-4 `landing@` stamp the verdict was computed from; abort the reap
  // otherwise. This narrows the clobber window from minutes to milliseconds without touching
  // board.mjs's write contract at all — the write below is unchanged, only gated behind one
  // extra read.
  let freshRows;
  try {
    const out = _exec('node', [join(scriptsDir, 'board.mjs'), 'landing-held'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    freshRows = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    if (e.status === 1) {
      freshRows = []; // documented "not held" — nothing is held any more
    } else {
      log(
        `queue-drain: reaper — TOCTOU re-check errored for "${slug}" (${e.message}); aborting ` +
          'the reap, leaving the row HELD for this firing',
      );
      return false;
    }
  }
  const freshLine = freshRows.find((l) => {
    const c = cellsOf(l);
    return c && c[0] === slug;
  });
  if (!freshLine) {
    log(`queue-drain: reaper — row "${slug}" is no longer held at write time; aborting the reap`);
    return false;
  }
  const freshCells = cellsOf(freshLine);
  if (!freshCells || freshCells[2] !== LANDING_STATE) {
    log(
      `queue-drain: reaper — row "${slug}" is no longer exactly 🟢 LANDING at write time; ` +
        'aborting the reap',
    );
    return false;
  }
  const freshLandingIso = landingIsoFromRow(freshLine);
  if (freshLandingIso !== landingIso) {
    log(
      `queue-drain: reaper — row "${slug}"'s landing@ stamp changed between the verdict and the ` +
        `write (was ${landingIso}, now ${freshLandingIso}); aborting the reap`,
    );
    return false;
  }

  const note = `REAPED ${new Date(nowMs).toISOString()}: ${verdict.reason} — auto-flipped by queue-drain`;
  try {
    _exec(
      'node',
      [join(scriptsDir, 'board.mjs'), 'update', slug, '--state', 'PAUSED', '--resume', note],
      { stdio: 'pipe' },
    );
    log(`queue-drain: reaper — ${note} (row "${slug}")`);
    return true;
  } catch (e) {
    log(
      `queue-drain: reaper — board update to PAUSED failed for "${slug}" (${e.message}); ` +
        'leaving the row HELD for this firing',
    );
    return false;
  }
}

// plan 3443: the consult site's ONE resolution — runs the reaper (Fix 1) first, so a
// provably-stale row is reaped and dropped from the set BEFORE the seed-lane read (Fix 2)
// consults it; a row reaped this firing must never hold the lane in the SAME firing. Then
// resolves "held for the seed lane" (never the old blunt "any row held") from whatever rows
// survive. `heal` is DEFAULT ON at the CLI (`--no-heal` opts a deliberately read-only
// consumer out).
//
// review Fix 6: a missing `repoRoot` (the `--ready` fixture/test mode) takes the OLD blunt
// `landingHeldViaBoard` path outright, before even reading rows here — not merely "skip
// healing". Without `repoRoot`, `readPlanContentFromOrigin` throws for every held row (it has
// no origin to read), and `seedLaneHeldFromRows`'s own catch-arm turns every such throw into an
// unconditional HELD — a real behaviour change for `--ready` versus its pre-3443 blunt-boolean
// answer, and pure log noise on top ("could not read plan… failing toward HELD" for a read that
// was never going to succeed). No heal, no plan reads, no fetch: just the blunt board answer.
export function resolveLandingHeldForSeedLane({
  scriptsDir,
  repoRoot,
  heal,
  _exec = execFileSync,
  log = console.error,
}) {
  if (!repoRoot) return landingHeldViaBoard(scriptsDir, { _exec });

  let rows;
  try {
    const out = _exec('node', [join(scriptsDir, 'board.mjs'), 'landing-held'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    rows = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    if (e.status === 1) return false; // documented "not held" — nothing to reap or resolve
    log(
      `queue-drain: board landing-held check errored (assuming held for the seed lane): ${e.message}`,
    );
    return true; // fail safe, same direction as landingHeldViaBoard's own catch-arm
  }
  if (rows.length === 0) return false;

  // plan 3443 review Fix 2: fetch origin ONCE, before any staleness reading or plan reading —
  // CLAUDE.md § Coordination: "Fetch before judging a plan landed/blocked or a queue slot free:
  // reason about origin/master, not drifting local refs (git fetch origin first)". Both the
  // branch-progress staleness input (reapRowIfStale, below) and the authoritative plan read
  // (readPlanContentFromOrigin, review Fix 7) consume local refs/remotes/origin/* state that
  // only a fetch can refresh — a stale or absent ref can misjudge a LIVE land as dead, or read a
  // stale SEED-WRITE banner. Runs unconditionally whenever there is at least one held row and a
  // repoRoot to fetch into, regardless of `heal` — the plan read below needs a current ref
  // whether or not healing itself is enabled this firing.
  try {
    // `--prune` (re-review round 2): without it a deleted execution branch leaves its
    // remote-tracking ref behind, and `branchProgressedSince` then reads a tip that no longer
    // exists on origin. Harmless for the reap verdict itself (an old tip is not "after" the
    // stamp either way), but it means the branch probe answers from a branch that is gone —
    // pruning keeps the ref set honest for the same reason the fetch is here at all.
    _exec('git', ['-C', repoRoot, 'fetch', '--prune', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (e) {
    // plan 3443 re-review: a failed fetch FAILS CLOSED — held for the seed lane, no reaping and
    // no lane-narrowing this firing. The first cut skipped only the healing and still narrowed
    // the lane from whatever the local refs said, which is the same mistake review Fix 7 removed
    // one seam over: `readPlanContentFromOrigin` reads `origin/master:<plan>` from the LOCAL
    // origin/master ref, so an unrefreshed ref can serve a stale SEED-WRITE banner. A banner
    // reading 🟩 while origin says 🟥 would wrongly FREE the seed lane — the one direction this
    // mutex must never move on unverifiable data. Returning held costs at most one firing's
    // 🟥 pickups and self-heals the moment the fetch works again.
    log(
      `queue-drain: reaper — git fetch origin failed (${e.message}); refs could not be ` +
        'refreshed, so neither a reap nor a seed-lane narrowing can be trusted this firing — ' +
        'failing CLOSED (held for the seed lane)',
    );
    return true;
  }

  if (heal) {
    const nowMs = Date.now();
    rows = rows.filter((line) => {
      const cells = cellsOf(line);
      const slug = cells ? cells[0] : null;
      // Unparseable — leave it in place; seedLaneHeldFromRows below fails toward held on it.
      if (!slug) return true;
      return !reapRowIfStale(scriptsDir, repoRoot, slug, line, nowMs, { _exec, log });
    });
    if (rows.length === 0) return false;
  }

  return seedLaneHeldFromRows(rows, (ref) => readPlanContentFromOrigin(repoRoot, ref, { _exec }), {
    log,
  });
}

// plan 1819: scan `docs/superpowers/plans/archive/` — the sibling of `ready/`
// (readyDir is always `<plans>/ready`, so `dirname(readyDir)/archive` is the
// SAME `<plans>` root, read from the SAME on-disk snapshot readyDir itself is
// read from — no separate ref/checkout to drift out of sync with). Returns
// `{ shipped, unshipped }`, each a Set of id STRINGS (matching the same
// `\d{3,}-(?=[A-Za-z])` shape used for the `id` field above) so parsePlanMeta's
// archive checks stay plain Set lookups.
//
// Review fix: `archive/` holds plans that are "shipped OR closed"
// (docs/runbooks/plans-workflow.md § Plan folder layout) — mere presence does
// NOT prove the blocking WORK landed (a plan can be archived SUPERSEDED /
// abandoned without ever shipping). Only a file whose `**Status:**` line carries
// the `✅ COMPLETED` stamp done-worktree's normal archive close-out writes
// counts as a satisfied blocker (`shipped`); anything else (SUPERSEDED,
// PARTIALLY SHIPPED, a stray non-terminal row, …) lands in `unshipped` instead —
// NOT stale, but (plan 2496) also not the plain "still open" case: it gets its
// own named exclude reason (`blocker_archived_unshipped`) rather than silently
// reusing the generic 'blocked' bucket. See parsePlanMeta's classification block.
//
// plan 1836: blocked-by-lib.mjs's `classifyBlocked` (shared by done-worktree.mjs's
// promoteWaitingBlocked and lint-stale-blocked.mjs) now applies this SAME shipped
// test via its own `isShippedArchiveContent`/`ARCHIVE_COMPLETED_RX` — ported
// verbatim from this regex, not imported (see the BLOCKED_PLAN_ID_RX comment above
// for why: this file is adopted byte-identical by the tandapp sibling, which does
// not adopt blocked-by-lib.mjs). All three consumers now agree on what "shipped"
// means; queue-drain.test.mjs and blocked-by-lib.test.mjs each assert it directly.
// Exported (plan 1836) solely so a test can assert this stays byte-identical to
// blocked-by-lib.mjs's own `ARCHIVE_COMPLETED_RX` — the two literals are
// independently maintained (see the comment above) but must never drift apart.
export const ARCHIVE_COMPLETED_RX = /^\*\*Status:\*\*\s*✅\s*COMPLETED\b/im;

// plan 2496: one archive/ scan, partitioned into the two disjoint Sets
// parsePlanMeta needs — `shipped` (the pre-existing `archivedIds`, unchanged
// selection: carries the ✅ COMPLETED stamp) and `unshipped` (present in archive/
// but WITHOUT that stamp — 🗄️ SUPERSEDED, abandoned, or no terminal Status line at
// all). Splitting here rather than adding a second directory scan keeps the
// "archive/ is 1000s of files, scan it once" perf property readReadyMetas already
// relies on (see needsArchiveCheck below).
function readArchivedIds(archiveDir) {
  if (!existsSync(archiveDir)) return { shipped: new Set(), unshipped: new Set() };
  const shipped = new Set();
  const unshipped = new Set();
  // plan 2678: `archive/` is lint-enforced FLAT, so this scan was already correct — but it
  // routes through the shared walker anyway, so a hand-created category folder there shows
  // up as a loud lint violation on a plan the oracle CAN see, never as a plan the oracle
  // silently forgot was archived (which would let a stale Blocked-by gate ready/ forever).
  for (const { rel } of walkPlanDir(archiveDir, { pattern: /^(\d{3,})-(?=[A-Za-z])/ })) {
    const m = rel
      .split('/')
      .pop()
      .match(/^(\d{3,})-(?=[A-Za-z])/);
    let content;
    try {
      content = readFileSync(join(archiveDir, ...rel.split('/')), 'utf8');
    } catch {
      continue; // race with a concurrent archive move — skip, stay conservative
    }
    (ARCHIVE_COMPLETED_RX.test(content) ? shipped : unshipped).add(m[1]);
  }
  return { shipped, unshipped };
}

// plan 2678: enumerate ONE status folder recursively (its flat files plus any one-level
// category subfolder) via the shared walker, returning `{ rel, category, basename }` per
// plan file with `rel` relative to THAT folder. ENOENT below the top level is tolerated
// for the same reason the per-file read above is — ~5-7 sessions mutate this tree
// continuously, so a category folder can vanish between the parent readdir and this one.
function walkPlanDir(dir, { pattern = /\.md$/ } = {}) {
  return walkPlanStatusDir({
    statusFolder: basename(dir),
    readdir: (segments) => {
      try {
        return readdirSync(join(dir, ...segments), { withFileTypes: true });
      } catch (e) {
        const code = (e && e.code) || 'UNKNOWN';
        if (segments.length && (code === 'ENOENT' || code === 'ENOTDIR')) return [];
        throw e;
      }
    },
    isPlanFile: (name) => name.endsWith('.md') && pattern.test(name),
  }).map(({ category, basename, relInStatus }) => ({ rel: relInStatus, category, basename }));
}

// plan 3816 fix round (review Fix 1): builds the SAME { rel, category, basename } triples
// walkPlanDir yields off the local tree, but off ORIGIN/MASTER — one `listReadyBlobsFromOrigin`
// (git ls-tree) plus ONE `readBlobsBatched` (git cat-file --batch) for the WHOLE ready/ set,
// never a per-file `git show`. Content is read by BLOB SHA, so a later ref move cannot change
// what was read once the sha is captured — see listReadyBlobsFromOrigin's header comment for why
// that fixes the snapshot-instability the prior per-file `git show` had. `classifyPlanRel`
// (build-index-lib.mjs) is the SAME path classifier `walkPlanStatusDir` runs on the local-tree
// side, including its plan-2678 one-level category-subfolder support — so a ready/ plan clumped
// into `ready/<category>/…` is exactly as visible here as it is locally.
//
// `ref` (fix round 2, Fix A): the already-resolved commit sha, threaded straight into
// listReadyBlobsFromOrigin — see that function's header for why this must be a commit, not the
// mutable `origin/master` name.
//
// `rawContents[i]` may be `null` (fix round 2, Fix B): readBlobsBatched returns `null` for a
// missing/malformed blob, and the string-only parsers downstream (stripFrontmatter/
// tailScopedBody/parsePlanMeta) would throw a TypeError on anything else — crashing the WHOLE
// oracle over one bad blob. SKIP that entry entirely (neither the entry nor its content is
// pushed) and log ONE named line so the drop is loud rather than silent; every other ready/ plan
// is unaffected.
function readyEntriesFromOrigin(repoRoot, ref, { _exec = execFileSync, log = console.error } = {}) {
  const PLANS_PREFIX = 'docs/superpowers/plans/';
  const blobs = listReadyBlobsFromOrigin(repoRoot, ref, { _exec });
  const rawContents = readBlobsBatched(
    repoRoot,
    blobs.map((b) => b.sha),
    { _exec },
  );
  const entries = [];
  const contents = [];
  // fix round 3 (review Fix 5ba3e/1494a6): counted here so the caller can carry it past the
  // stderr-only log line above — see readReadyMetas's onSnapshot plumbing below for why the
  // count, not just the log line, has to reach the board.
  let skippedUnreadable = 0;
  for (let i = 0; i < blobs.length; i++) {
    const p = blobs[i].path;
    // Defensive only — `git ls-tree … <ref> -- docs/superpowers/plans/ready` is already scoped
    // to that subtree and listReadyBlobsFromOrigin already filters to `.md`, so both conditions
    // below are expected to always hold.
    if (!p.startsWith(PLANS_PREFIX) || !p.endsWith('.md')) continue;
    const relFromPlansRoot = p.slice(PLANS_PREFIX.length); // e.g. "ready/1234-Foo.md"
    const classified = classifyPlanRel(relFromPlansRoot);
    if (classified.statusFolder !== READY_FOLDER) continue;
    const content = rawContents[i];
    if (typeof content !== 'string') {
      log(
        `queue-drain: readReadyMetas — unreadable blob for ${p} (${blobs[i].sha.slice(0, 7)}); ` +
          'skipping this ready plan.',
      );
      skippedUnreadable++;
      continue;
    }
    entries.push({
      rel: classified.rel.split('/').slice(1).join('/'), // relInStatus — matches walkPlanDir's shape
      category: classified.category,
      basename: classified.basename,
    });
    contents.push(content);
  }
  return { entries, contents, skippedUnreadable };
}

// Exported (plan 1819 review fix) so callers outside this module — currently
// orchestrate-dryrun.mjs's dry-run pacer — read the SAME ready/ selection this
// CLI does, instead of hand-maintaining a second copy that can silently drift
// out of sync whenever this function's option surface changes (e.g. missing the
// archivedIds wiring below).
//
// `source` (plan 3816): 'origin' (the default) reads ready/'s CURRENT file set off
// `origin/master` after a quiet `git fetch origin` — CLAUDE.md § Coordination's "fetch before
// judging a plan … queue slot free: reason about origin/master, not drifting local refs",
// applied to `ready/` the way plan 3247 already applied it to `in-progress/`. `repoRoot` is
// REQUIRED for that path (listReadyBlobsFromOrigin/readBlobsBatched both need one
// to run `git -C repoRoot …`). `source: 'tree'` is the explicit opt-in for a repo-less read of
// the LOCAL working tree — every existing option (`cloudOnly`/`fableLane`/`lane`/`batchRoster`)
// is unchanged and additive either way; both sources feed the SAME parsePlanMeta/frontmatter
// path below, so which one ran can never change how a plan's own content is parsed.
export function readReadyMetas(
  readyDir,
  {
    cloudOnly = false,
    fableLane = false,
    lane = undefined,
    batchRoster = null,
    source = 'origin',
    repoRoot = null,
    _exec = execFileSync,
    // plan 3816 fix round (review Fix 2): injectable so a test can assert the exact fetch-failure
    // stderr line without monkey-patching the global console — the same DI shape
    // resolveLandingHeldForSeedLane/seedLaneHeldFromRows already use for their own fail-soft logs.
    log = console.error,
    // onSnapshot (fix round 2, Fix A; extended fix round 3 with `skippedUnreadable`): invoked
    // ONCE, before this function returns, with the `{ originSha, fetchFailed, skippedUnreadable }`
    // this call actually read off origin — NEVER on `source: 'tree'` (there is no origin snapshot
    // to report there; the caller's own default stands). The array return type stays unchanged on
    // purpose — this rides alongside it as a callback rather than widening the return shape, so
    // every existing caller (orchestrate-dryrun.mjs's pacer included) keeps working unmodified.
    onSnapshot = null,
    // plan 3962 P1: threaded straight through to parsePlanMeta (see its own comment) — this
    // function carries no project registry either, only the pass-through.
    validCloudRepoKeys = [],
  } = {},
) {
  let entries;
  let contents;
  if (source === 'origin') {
    if (!repoRoot) {
      throw new Error(
        'readReadyMetas: source "origin" (the default) requires repoRoot — pass ' +
          '`{ source: "tree" }` for a repo-less read of the local working tree instead ' +
          '(the shape a fixture/test readyDir with no real git repo behind it needs).',
      );
    }
    // One quiet fetch per CALL, never per file — the drain's own selection path already
    // fetches before this runs, so that second fetch is a cheap no-op; a bare CLI/board
    // invocation still gets a fresh origin/master read either way.
    //
    // plan 3816 fix round (review Fix 2): the fetch is wrapped, deliberately FAIL-SOFT — mirrors
    // the try/catch SHAPE of resolveLandingHeldForSeedLane's own fetch guard above (a named
    // stderr line on failure) but not its OUTCOME. That guard fails CLOSED because it feeds the
    // seed-write landing mutex, where a stale read could wrongly FREE the lane — the one
    // direction that mutex must never move on unverifiable data. This read has no such
    // asymmetry: before this plan, readReadyMetas was a pure LOCAL read that could never fail at
    // all, so a stale-but-authoritative origin/master ref is still strictly BETTER than the
    // working-tree read this plan replaced — degrading to "whatever origin/master the local ref
    // already has" is correct here, not a refusal. Without this guard, a transient network blip
    // or a concurrent-oracle FETCH_HEAD lock race (ready-board.mjs runs TWO oracles concurrently,
    // each now fetching) throws out of readReadyMetas, the CLI's main() never prints its JSON,
    // and ready-board.mjs's runOracle then fails to parse stdout — so a purely transient hiccup
    // renders NO BOARD AT ALL on /ready-plans.
    //
    // Logged to STDERR, never stdout: stdout must stay parseable JSON (main() below is the sole
    // stdout writer), so a warning line mixed into it would break every JSON.parse caller — the
    // exact failure mode this fix exists to prevent one level up.
    let fetchFailed = false;
    try {
      _exec('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (e) {
      fetchFailed = true;
      log(
        `queue-drain: readReadyMetas — git fetch origin failed (${e.message}); reading ready/ ` +
          'off the LOCAL origin/master ref, which may lag origin.',
      );
    }

    // fix round 2, Fix A: resolve `origin/master` to ONE immutable commit sha UP FRONT, before
    // any ready/ content is read, and thread THAT sha through listReadyBlobsFromOrigin instead
    // of letting it (and readReadyMetas's caller, main() below) each re-resolve the mutable ref
    // independently. Before this fix, resolveLandingHeldForSeedLane's own `git fetch --prune
    // origin` (called between this read and main()'s post-hoc rev-parse) could advance
    // `origin/master` in between, so the sha main() REPORTED could name a commit newer than the
    // one this scan actually read — the listing itself also still named the mutable ref, so two
    // concurrent readReadyMetas calls (ready-board.mjs runs two) were never provably reading the
    // same snapshot either. Resolving once and passing the sha everywhere below closes both
    // gaps: everything this call does is pinned to the one commit resolved right here.
    //
    // fix round 2, Fix C: a fresh/partial clone with NO local `origin/master` ref at all makes
    // this throw even after a successful fetch (a shallow/no-remote checkout, or the very first
    // fetch of a brand-new worktree before any remote-tracking ref exists) — round 1's fetch
    // guard alone left that case to crash on the very next call. Fail soft here too: log a named
    // line, report the snapshot as failed, and return an EMPTY ready set rather than throwing —
    // an empty set is a safe degradation (the drain simply finds nothing to take), never a crash
    // and never invented work.
    let originSha;
    try {
      originSha = _exec('git', ['-C', repoRoot, 'rev-parse', 'origin/master'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      }).trim();
    } catch (e) {
      log(
        `queue-drain: readReadyMetas — no readable origin/master (${e.message}); returning an ` +
          'EMPTY ready set.',
      );
      // fix round 3: no ready/ content was read at all on this path, so there is nothing to
      // have skipped — report the count as 0, the same "nothing to report" shape the tree-source
      // path implies by never calling onSnapshot at all.
      if (onSnapshot) onSnapshot({ originSha: null, fetchFailed: true, skippedUnreadable: 0 });
      return [];
    }

    // fix round 3: the onSnapshot call is deferred to AFTER readyEntriesFromOrigin runs (it moved
    // one line down from fix round 2's placement) so it can carry the unreadable-blob count that
    // read produces — onSnapshot still fires exactly once, still before this function returns,
    // per its own header comment above.
    let skippedUnreadable;
    ({ entries, contents, skippedUnreadable } = readyEntriesFromOrigin(repoRoot, originSha, {
      _exec,
      log,
    }));
    if (onSnapshot) onSnapshot({ originSha, fetchFailed, skippedUnreadable });
  } else if (source === 'tree') {
    if (!existsSync(readyDir)) return [];
    // plan 2678: RECURSIVE — a ready/ plan clumped into an optional category subfolder
    // (`ready/infra/…`) was invisible to the drain oracle entirely, so it could never be
    // picked, excluded, or even reported as skipped.
    entries = walkPlanDir(readyDir);
    contents = entries.map((e) => readFileSync(join(readyDir, ...e.rel.split('/')), 'utf8'));
  } else {
    throw new Error(`readReadyMetas: unsupported source "${source}" (must be "origin" or "tree")`);
  }
  const files = entries.map((e) => e.basename);
  // plan 2543 review fix: computed ONCE per file here and threaded into parsePlanMeta
  // below via precomputedScopedBody — previously this scan and parsePlanMeta each ran
  // closeoutTailSpans independently on the same content, the exact per-corpus-scan
  // duplication this plan's own perf fix elsewhere was supposed to close.
  const scopedBodies = contents.map((c) => tailScopedBody(stripFrontmatter(c)));
  // Perf (review fix): archive/ only ever grows (1000s of files) and a full scan
  // of it is wasted work on the common tick where no ready/ plan even carries a
  // plan-shaped Blocked-by line. Only pay for readArchivedIds when at least one
  // ready/ file's Blocked-by line actually names a plan id.
  const needsArchiveCheck = scopedBodies.some((sb) => {
    // BODY, matching parsePlanMeta's call exactly (plan 2368) — the two must never
    // disagree about whether a plan "has a Blocked-by line". extractBlockedByLine
    // takes the tail-scoped body (plan 2543), not raw body — same scoping
    // parsePlanMeta applies, off the same precomputed scopedBodies array.
    const bb = extractBlockedByLine(sb);
    return bb && extractBlockedPlanIds(bb).length > 0;
  });
  const { shipped: archivedIds, unshipped: archivedUnshippedIds } = needsArchiveCheck
    ? readArchivedIds(join(dirname(readyDir), ARCHIVE_FOLDER))
    : { shipped: new Set(), unshipped: new Set() };
  // plan 2459 Task 2: batch-hold membership, computed at most ONCE per scan (mirrors the
  // archivedIds precompute above) so parsePlanMeta never touches fs. Batches live as a
  // SIBLING of the plans root (docs/superpowers/batches), one level up from where
  // archive/ sits (…/plans/ready → …/plans → …/superpowers/{plans,batches}) — the same
  // one-level-up sibling derivation readArchivedIds uses above, applied one level
  // further out.
  //
  // LAZY, and ONE walk for both shapes (plan 2518 item 3, re-cut by the plan-2556 review).
  // The façade defers the batches walk until something actually asks — a tree with no
  // batches dir, or a scan that never consults it, performs no per-batch read at all,
  // exactly as the archivedIds precompute above is gated behind needsArchiveCheck.
  //
  // It is the SAME object main() later asks for the roster array (`.list()`), so the map
  // and the roster can never come from two different walks of a tree other sessions are
  // concurrently editing, and the walk is paid for at most once per scan. `batchRoster` is
  // accepted from the caller so main can hold that reference; readReadyMetas builds its own
  // when called directly (orchestrate-dryrun's pacer).
  const batchHeldBy = batchRoster ?? lazyBatchRoster(join(dirname(dirname(readyDir)), 'batches'));
  return files.map((f, i) =>
    parsePlanMeta(f, contents[i], {
      category: entries[i].category,
      cloudOnly,
      fableLane,
      lane,
      archivedIds,
      archivedUnshippedIds,
      batchHeldBy,
      precomputedScopedBody: scopedBodies[i],
      validCloudRepoKeys,
    }),
  );
}

export function main(argv) {
  // The ONE shared value-aware flag parser (coord-git.mjs, plan 1769): `cloud`/
  // `no-mutex` are bare booleans (never consume the next token), `ready`/`lane`/
  // `env` take a value; unknown flags throw instead of being silently swallowed
  // as `true`. `--lane` (plan 1810) supports exactly one value today: `fable`.
  // `--env` (plan 1925, extended plan 2250; table-driven by plan 2387) supports
  // the CLOUD_ENV_LANES values (today: `full` and `browser`; trusted is the
  // flagless default — an explicit `--env trusted` would just invite drift
  // between two spellings of the same pool).
  // `no-heal` (plan 3443): the reaper is DEFAULT ON — this opts a deliberately read-only
  // consumer out of it (never consumes the next token, same bare-boolean shape as
  // `no-mutex`).
  const { flags } = parseFlags(argv, {
    label: 'queue-drain',
    value: ['ready', 'lane', 'env'],
    boolean: ['cloud', 'no-mutex', 'no-heal'],
  });
  if (flags.lane !== undefined && flags.lane !== 'fable') {
    throw new Error(
      `queue-drain: unsupported --lane value "${flags.lane}" (only "fable" is supported)`,
    );
  }
  if (flags.env !== undefined && !CLOUD_ENV_LANES.some((l) => l.value === flags.env)) {
    throw new Error(
      `queue-drain: unsupported --env value "${flags.env}" (only ` +
        `${CLOUD_ENV_LANES.map((l) => `"${l.value}"`).join(' or ')} are supported; trusted is ` +
        'the flagless default)',
    );
  }
  if (flags.env !== undefined && !flags.cloud) {
    // The cloudEnv axis routes between CLOUD environment kinds; a local drain runs
    // on the operator's full-egress machine and reads the unchanged full pool.
    throw new Error('queue-drain: --env requires --cloud (cloudEnv only routes cloud drains)');
  }
  const repoRoot = flags.ready ? null : resolveMain();
  const readyDir = flags.ready || join(repoRoot, 'docs', 'superpowers', 'plans', READY_FOLDER);
  const cloudOnly = !!flags.cloud;
  const fableLane = flags.lane === 'fable';
  const lane = flags.env; // undefined (trusted) | 'full' | 'browser'

  const batchRoster = lazyBatchRoster(join(dirname(readyDir), '..', 'batches'));
  // fix round 2, Fix A/D: `originSha`/`originFetchFailed` are reported through readReadyMetas's
  // `onSnapshot` callback (invoked once, from INSIDE the origin read) rather than by main()
  // re-deriving its own post-hoc `rev-parse` — see readReadyMetas's Fix-A comment for why a
  // second, later-timed resolve could name a commit newer than the one this scan actually read.
  // `--ready` fixture mode (repoRoot: null, the same carve-out Fix 6's resolveLandingHeldForSeedLane
  // already applies) has no origin to read at all, so it never fires the callback and these stay
  // at their fixture-mode defaults: `originSha: null`, `originFetchFailed: null`.
  let originSha = null;
  let originFetchFailed = repoRoot ? false : null;
  // fix round 3: same additive shape as originFetchFailed above — a real number once a real
  // origin read ran, `null` in `--ready`/tree fixture mode where no origin snapshot exists at all.
  let originSkippedUnreadable = repoRoot ? 0 : null;
  // plan 3816: `--ready` (repoRoot: null, the fixture/test escape hatch — see `cfg` just above)
  // has no origin to read, so it stays on the LOCAL working tree, the same carve-out Fix 6's
  // resolveLandingHeldForSeedLane already applies for the identical reason. Every real
  // invocation (repoRoot present) gets the default `origin` read.
  const cfg = repoRoot ? loadCoordConfig(repoRoot) : null; // --ready test mode has no repoRoot
  const seedLane = cfg ? cfg.seedLane : true; // preserve default-on selection in test mode
  // plan 3962 P1: the cloudRepos axis's valid-key set, read off coord.config.json's own
  // `cloudRepos` rows via the config already loaded above — NOT from scripts/coord/cloud-repos-lib.mjs
  // (see the import comment near the top of this file for why). `[]` in `--ready` test mode,
  // matching seedLane's fallback right above.
  const validCloudRepoKeys = cfg ? cfg.cloudRepos.map((r) => r.key) : [];
  const metas = readReadyMetas(readyDir, {
    cloudOnly,
    fableLane,
    lane,
    batchRoster,
    repoRoot,
    source: repoRoot ? undefined : 'tree',
    onSnapshot: repoRoot
      ? ({ originSha: sha, fetchFailed, skippedUnreadable }) => {
          originSha = sha;
          originFetchFailed = fetchFailed;
          originSkippedUnreadable = skippedUnreadable;
        }
      : undefined,
    validCloudRepoKeys,
  });
  // plan 3443: the seed-lane-aware resolution (reaper first, then Fix 2's narrowed read) —
  // this consult site is the ONE place `landingHeld` is produced, so both drop sites
  // (selectEligible's single-plan filter and computeRunnableBatches) inherit the narrowing
  // and the reap without either changing shape. The `no-mutex`/`!seedLane` short-circuits are
  // preserved verbatim from before this plan — neither the reaper nor the seed-lane read ever
  // runs on that path.
  const heal = !flags['no-heal'];
  const landingHeld =
    flags['no-mutex'] || (cfg && !cfg.seedLane)
      ? false
      : resolveLandingHeldForSeedLane({ scriptsDir: SCRIPTS_DIR, repoRoot, heal });
  // plan 2556 (review finding 0): the roster is consulted UNCONDITIONALLY, off the same
  // memoized walk readReadyMetas already used for the hold-map. The first cut gated this on
  // `metas.some(m => m.exclude === 'batch')`, which is false in exactly the case that most
  // needs reporting — a runnable batch ALL of whose members have left ready/ — so that batch
  // appeared in neither runnableBatches nor skippedBatches and rotted with no trace.
  // plan 2863: the duplicate-execution gate, CLOUD path only — that is where the measured incident
  // happened (a cloud firing that cannot claim still executes the plan unclaimed, per the routine's
  // escape hatch), and it is where one network round trip per firing is clearly worth its cost.
  // `repoRoot` is null under `--ready` (the fixture/test mode), which correctly leaves the gate off.
  const onOriginIds = cloudOnly && repoRoot ? originExecutedPlanIds(repoRoot) : null;
  const result = selectEligible(metas, {
    landingHeld,
    seedLane,
    batchRoster: batchRoster.list(),
    onOriginIds,
  });

  // plan 3816 fix round (review Fix 3), narrowed in fix round 2 (Fix A/D), extended in fix round
  // 3 (review keys f5ba3e/1494a6): each oracle call reports the ORIGIN SNAPSHOT it actually
  // read — additive ONLY (no existing field changes, no selection/claim logic touched) — and now
  // also whether that read degraded (a failed fetch, no readable local `origin/master` at all, or
  // one or more ready/ plans whose blob came back unreadable and were silently skipped).
  // `originSha`/`originFetchFailed`/`originSkippedUnreadable` were all captured above via
  // readReadyMetas's `onSnapshot` callback; main() reports exactly what it read rather than
  // re-resolving anything of its own. Feeds ready-board.mjs's per-run header (originHeaderLine +
  // the Fix-D degradation warning + the fix-round-3 unreadable-skip warning).
  console.log(
    JSON.stringify({ ...result, originSha, originFetchFailed, originSkippedUnreadable }, null, 2),
  );
  return result.reason ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('queue-drain:', e.message);
    process.exit(2);
  }
}
