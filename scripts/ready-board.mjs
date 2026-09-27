#!/usr/bin/env node
// scripts/ready-board.mjs (plan 2524) — the /ready-plans board.
//
// Read-only. Renders EVERY plan in `docs/superpowers/plans/ready/` as one boxed table:
// its execution lane (sonnet / fable), its operator priority class, and whether a cloud drain
// can take it right now — with the oracle's own blocked reasons as footnotes.
//
//   Ready plans: 19 (sonnet 12 · fable 7) — 5 takeable by a cloud drain now.
//   ┌──────┬───────────────────────┬───────────┬──────┬──────────────┬──────────┬──────────────────────┐
//   │ Plan │ Title                 │ Lane      │ Prio │ Cloud        │ Evidence │ Cost                 │
//   ├──────┼───────────────────────┼───────────┼──────┼──────────────┼──────────┼──────────────────────┤
//   │ 2383 │ Pipe-notes-carry-raw… │ 🟢 sonnet │      │ ✅ ELIGIBLE  │          │ Cash $0 · Claude $5  │
//   │ 2370 │ Pipe-grammar-kloklip… │ 🟣 fable  │  ⚡  │ ⛔ unstamped │          │ >$2                  │
//   │ 2401 │ Infra-low-prio-thing… │ 🟢 sonnet │  ↓  │ ✅ ELIGIBLE  │          │                      │
//   └──────┴───────────────────────┴───────────┴──────┴──────────────┴──────────┴──────────────────────┘
//   ⛔ unstamped — cloudExec unset — not yet stamped cloud-eligible …
//
// Prio column (plan 2582): the full three-tier `priority` stamp (`high`/`medium`/`low`, plan
// 2520's ruled vocabulary), not a high/blank boolean — `high` → ⚡, `medium` → blank (medium is
// PRIORITY_DEFAULT; an unmarked cell reading as "default priority" is the honest render and keeps
// the majority tier's visual unchanged), `low` → ↓. An absent `priority:` field normalizes to
// `medium` before this board ever sees it (readPriorityTier()'s PRIORITY_DEFAULT), so it renders
// identically to an explicit `medium` row — by design, not a gap.
//
// WHY THIS FILE EXISTS (plan 2524): this report used to BE a ~60-line `node - <<'EOF'` heredoc
// inlined in the `/cloud-eligibility` skill body. A markdown skill body cannot be imported, so
// it could not be tested, so every defect in it was found in production and fixed by hand —
// three times for one class of bug (see the numbered notes below). Plan 2423 had already moved the
// stamp READ out into `read-plan-stamps.mjs`; this file finishes the job by moving the RENDER
// out, leaving the command body doing what `/landing-queue`'s does: run one script, paste the
// output verbatim.
//
// ── The five things that make the naive `--cloud` output misleading ───────────────────────────
// These are regression pins, not commentary. Each cost a live misreport.
//
// 1. TWO LANES. Plain `--cloud` serves the SONNET lane and excludes every `execModel: fable`
//    plan (`exclude: 'fable'`); fable plans have their own lane, `--cloud --lane fable`
//    (plan 1810). A full picture needs BOTH runs, each plan reported under its NATIVE lane, and
//    the cross-lane codes (`fable` in the sonnet run, `sonnet-lane` in the fable run) dropped as
//    noise — they are the other lane's plans, not a verdict.
//
//    A plan's lane is read from its file's `execModel:`, NEVER inferred from the oracle's
//    exclude codes. `queue-drain.mjs` evaluates the cloud/env/operator gates BEFORE the lane
//    gate, so a plan blocked for `cloudExec: false` carries code `cloud` in BOTH runs and never
//    a cross-lane code in either. Inferring fable-ness from "the fable run did not exclude it as
//    sonnet-lane" filed every `cloudExec: false` SONNET plan under a bogus FABLE heading on
//    2026-07-19 (misreported 1701 / 2018 / 2023 / 2045).
//
// 2. RUN THE FULL-ENV VIEW, not the trusted subset. Plain `--cloud` (no `--env`) is the
//    trusted-env view and excludes every `cloudEnv: full` plan as `exclude: 'full-env'`. Since
//    the 2026-07-19 trusted-lane retirement, the scheduled fleet is the full pair (`sonnet-full`
//    / `fable-full`, i.e. `--env full`) on every account. So both runs pass `--env full`, a
//    strict superset of the trusted floor, and `cloudEnv: full` rows carry a `(full)` tag from
//    their frontmatter so the operator can still see which need a Full-egress runner. Running
//    plain `--cloud` misreported drainable `cloudEnv: full` plans (2131) as BLOCKED on
//    2026-07-20. A `full-env` exclude should never appear here unless someone re-provisions a
//    trusted drain.
//
//    `--env full` is no longer the whole fleet's CEILING (plan 3821), and since plan 3823 it is
//    no longer the whole fleet's ADMISSION CAP either: BOTH drain slots (`sonnet-full` and
//    `fable-full`) on every live account now carry a generated `--env browser` body
//    (the project's browser-lane routine prompts) — the browser lane
//    is the fleet DEFAULT, not a single-account exception, so a SCHEDULED firing of ANY drain slot runs
//    `--env browser` for its own native lane. This board answers that by running a THIRD,
//    lane-paired `--env browser` tier (`fuseBrowserTier`, paired sonnet-with-sonnet and
//    fable-with-fable exactly the way note 1 pairs the two `--env full` runs) alongside the two
//    `--env full` runs above — which stay `--env full` and are NEVER re-pointed at `--env
//    browser`. The fusion only ADDS rows a full-env run excluded purely on the env axis
//    (`browser-env` — the one exclude code `--env full` can produce on this ladder, since
//    `full`/`webkit`/`trusted` are already admitted there): every other verdict the two
//    `--env full` runs already settled — eligible, blocked, operator-gated, batch, mutex,
//    whatever — is untouched. A promoted row renders `✅ ELIGIBLE (browser)`; the tag is sourced
//    from the plan's own `cloudEnv` stamp exactly the way `(full)` is (see `cloudCell`), never
//    from which run happened to report the row.
//
//    Whether a given drain routine is currently ENABLED to run its browser body is separate,
//    LIVE state — read the project's dated enable/pause log,
//    never asserted from this file.
//
// 3. CLAIMS AREN'T IN THE ORACLE. Its pure functions don't see remote claim refs — the drain
//    excludes an already-claimed plan separately (`git ls-remote origin 'refs/claims/*'`), so a
//    plan another session is mid-work on still shows eligible in raw oracle JSON.
//
// 4. READ THE WHOLE FRONTMATTER BLOCK, never a fixed-size head slice. Plan frontmatter has no
//    size bound (a `summary:` is routinely a 1500+ character YAML scalar). This file does not
//    parse frontmatter AT ALL: the stamps come from the repo's ONE contracted reader,
//    `read-plan-stamps.mjs`, built on `readFrontmatterScalar` and normalized EXACTLY as
//    `queue-drain.mjs` normalizes the same fields — so the lane this board prints cannot
//    disagree with the oracle it is reporting. NEVER re-inline a frontmatter parser here; that
//    inlining is what made one byte-slice bug get discovered and hand-patched twice in one day,
//    in two places (plans 2396 and 2423).
//
// 5. A BATCH HOLD IS NOT A CLOUD BLOCK (plan 2643, operator catch 2026-07-30). Everywhere else
//    on this board ⛔ answers "a cloud drain cannot take this" — but a member of a RUNNABLE train
//    IS cloud-takeable: every drain routine's batch check MUST take a runnable train, ahead of
//    `.next`. Only the SOLO claim is blocked (the plan-2459 hold, which is also why a batch-held
//    member is deliberately absent from the oracle's `eligible[]`). Rendering that as ⛔ misreports
//    the board's central question, so those rows render `🚃 via-train` and COUNT as takeable.
//
//    A hold whose train is NOT runnable in this run (blocked-under-hold, held-by-another-batch,
//    a withheld train) keeps ⛔ batch — there the hold really is a block.
//
//    Runnability is read from the SAME run's `runnableBatches` (the oracle applies every gate to
//    every member, all-or-nothing), never from the exclude reason: `batchHoldReason` says "member
//    of runnable batch <slug>" off the batch.md `status:`/`gate:` fields alone, which is a
//    different question from "is this train takeable in THIS lane and env" — the string is true of
//    a train this run withheld.
//
//    We match by MEMBER ID rather than the `batchHold.slug` the plan body first proposed, because
//    `toExcluded` (queue-drain.mjs) serializes only {slug, exclude, reason, cloudExec} — the
//    in-process `batchHold` never crosses the JSON boundary this file reads. The two are
//    equivalent BY CONSTRUCTION, not by luck: `computeRunnableBatches` marks a batch runnable only
//    when EVERY member's `batchHold.slug === batch.slug` (a member held by a different batch is a
//    `held-by-other-batch` blocker that withholds the whole train), so "this id appears in some
//    runnable batch's members" ⟺ "this row's holding batch is runnable".
//
// Usage: node scripts/ready-board.mjs        (run from the vetapp repo root)
// Exit codes: 0 ok · 5 error (stamps unreadable — see loadStamps).
//
// vetapp ONLY. Measured 2026-07-26 (plan 2488): a sibling repo's `queue-drain.mjs` has drifted
// out of sync with its own `build-index-lib.mjs` and dies before any stamp is read.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { renderBox } from './coord/box-table.mjs';
import { LANE_FAST, collectPlanStamps } from './coord/read-plan-stamps.mjs';
import { lsRemoteTimed } from './coord/coord-git.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756 step 2).
// Legacy constructor only — this step does not flip the namespace.
import { heldClaimsMap } from './coord/claim-plan.mjs';
import { PRIORITY_SORT_WEIGHT, PRIORITY_DEFAULT } from './coord/build-index-lib.mjs';
// The fail-closed lane resolver (plan 3341) — the ONE seam a lane ternary migrates to,
// never a re-rolled `execModel === 'fable' ? … : 'sonnet'` binary. See laneOf below for
// why this board still catches its throw rather than propagating it.
import { resolveExecLane, EXEC_LANE_TABLE } from './coord/claim-plan-lib.mjs';
// The single (lane, marker, detector) table for a filename's lane segment (plan 3341) — used
// by stripTitle below to strip a `SOL-` marker exactly like a `FABLE-` one, mirroring
// batches-view.mjs's parsePlanBasename precedent (review finding B) rather than typing a
// second, hand-rolled marker literal here.
import { LANE_SEGMENTS } from './coord/lint-filename-execmodel-drift.mjs';
// The oracle's own id normalizer (batch-paths.mjs), NOT a re-inlined copy: the ids this file
// compares come from BOTH sides of the oracle boundary (`idOf(slug)` here vs `String(m.id)` in
// queue-drain's runnableBatches), so the matching semantics must be the oracle's, by import.
// Same reasoning as note 4 below about the frontmatter reader. It is a pure string function —
// importing it does not make buildBoard impure.
import { canonicalPlanId } from './coord/batch-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const ORACLE = join(HERE, 'queue-drain.mjs');
const execFileAsync = promisify(execFile);

// The other lane's plans. Pure noise in a two-lane report — dropped, never rendered as a block.
export const CROSS_LANE = new Set(['fable', 'sonnet-lane']);

// The lanes queue-drain.mjs actually runs a native `--lane` oracle invocation for — the two,
// and only two, values `requestedLane` in queue-drain.mjs ever takes (default/sonnet, or
// `--lane fable`). Derived from EXEC_LANE_TABLE's own `hasNativeRun` flag (plan 3461, after a
// sonnet-review finding on this plan's first cut, which hardcoded this same set as a second,
// independent literal) rather than a local copy — `drainClaimable` used to coincide with it
// (before plan 3461, `sol` was the only lane with neither), but plan 3461 made `sol`
// drain-claimable while deliberately NOT adding a `--lane sol` CLI value, so a `sol` plan is
// drain-claimable yet still has no native run of its own; conflating the two axes again is
// exactly the defect this derivation closes off. See EXEC_LANE_TABLE's header comment
// (claim-plan-lib.mjs) for the full `hasNativeRun` vs `drainClaimable` distinction.
// `needsCodexTransport` is a different axis too (whether the lane's conductor needs codex, not
// whether it has a CLI value) that happens to anti-correlate with this set today but answers a
// different question.
const NATIVE_RUN_LANES = new Set(
  Object.values(EXEC_LANE_TABLE)
    .filter((entry) => entry.hasNativeRun)
    .map((entry) => entry.lane),
);

// plan 3341: `sol` added alongside — laneOf can now return it, and an unlabelled lane would
// render as its bare id-less string (laneLabelFor(r.lane) below), which is the honest
// degrade but a worse read than a proper icon for the common `sol` case.
//
// plan 3341 review (finding C, key ba580c): the glyphs used to be typed here as a second,
// independent literal (sonnet 🔵) that disagreed with batches-view.mjs's own local map
// (sonnet 🟢) for the SAME lane — the same plan could show a different colour depending on
// which board you looked at. Derived from EXEC_LANE_TABLE's `icon` field (claim-plan-lib.mjs)
// instead, the one canonical source both boards now read; EXEC_LANE_TABLE's values are
// sonnet 🟢 / fable 🟣 / sol 🔶, so this board's sonnet glyph changes from 🔵 to 🟢 — a
// deliberate correction, not a regression, and every test expecting 🔵 is updated to match.
export const LANE_LABEL = Object.fromEntries(
  Object.entries(EXEC_LANE_TABLE).map(([lane, { icon }]) => [lane, `${icon} ${lane}`]),
);

// plan 3341 delta-review follow-up (key 1d63e3): `LANE_LABEL[r.lane]` used to be a bare
// index into a plain object literal (LANE_LABEL is built by Object.fromEntries, which
// always returns an Object.prototype-having object) — the exact class of bug
// resolveExecLane (claim-plan-lib.mjs) already closed one layer up, reopened here one
// layer down. A plan mis-stamped `execModel: constructor` made `LANE_LABEL['constructor']`
// resolve through Object.prototype to the Object constructor function instead of `undefined`,
// so the Lane column printed the function's own source text
// (`function Object() { [native code] }`) instead of falling through to the `?? r.lane`
// fallback. laneLabelFor is the own-property-safe accessor: any lane string that isn't a
// real LANE_LABEL key (a resolver bug, not merely an absent stamp — laneOf's catch path is
// the only way a row gets here with an unrecognized lane) renders as a clearly-marked
// unknown lane instead of silently reading Object.prototype.
export function laneLabelFor(lane) {
  if (Object.prototype.hasOwnProperty.call(LANE_LABEL, lane)) return LANE_LABEL[lane];
  return `❓ unknown lane (${lane})`;
}

// Max visual width of the Title column. Long enough to disambiguate, short enough that the box
// fits a normal terminal beside the other four columns.
const TITLE_MAX = 38;

export function idOf(slug) {
  return (String(slug ?? '').match(/^(\d+)/) || [])[1] ?? null;
}

// Slug → a human title, UNTRUNCATED. Drops the leading `NNN-` (it is already the Plan column)
// and a `FABLE-`/`SOL-` lane-marker segment (already the Lane column), and keeps the category
// token (Pipe / Coord / Infra — that IS information).
//
// plan 3341 review (finding B, keys 7bd971/eab05a/873376/0df823/66b70b): this used to strip
// ONLY a hardcoded `^FABLE-`, so a `SOL-` marker fell through untouched and rendered verbatim
// in the Title column (`102-SOL-DQ-x` → title `SOL-DQ-x` instead of `DQ-x`). Sourced from
// LANE_SEGMENTS (lint-filename-execmodel-drift.mjs) — the single (lane, marker, detector)
// table — instead of typing a second marker literal here; a fourth lane needs no edit in this
// file. `test` runs against the id-prefixed slug (it anchors on `^\d{3,}-FABLE-`), never the
// post-id-stripped string below — same precedent as batches-view.mjs's parsePlanBasename.
//
// Split out from titleOf at plan 2932 so a board can share the STRIPPING without inheriting
// this one's UTF-16 cap: /in-progress truncates by visual width instead, and running the
// length cap first can slice a surrogate pair in half before the width-aware pass ever sees it.
export function stripTitle(slug) {
  const bare = String(slug ?? '');
  let after = bare.replace(/^\d+-/, '');
  const segment = LANE_SEGMENTS.find(({ test }) => test(bare));
  if (segment) after = after.slice(segment.marker.length);
  return after;
}

// As stripTitle, plus this board's own truncation with a single-cell ellipsis.
export function titleOf(slug) {
  const stripped = stripTitle(slug);
  return stripped.length > TITLE_MAX ? stripped.slice(0, TITLE_MAX - 1) + '…' : stripped;
}

// Lane comes from the PLAN FILE's execModel (note 1). `fallback` is the run the row came from,
// used only when the plan has no stamps entry at all — i.e. its file was moved out of ready/ by
// a parallel session between the oracle run and the stamp walk.
//
// plan 3341: resolved through the shared fail-closed lane table (claim-plan-lib.mjs), never a
// re-rolled `=== 'fable' ? … : 'sonnet'` binary — so a `sol` plan reports its own lane instead
// of being silently folded into sonnet. resolveExecLane THROWS on a genuinely unrecognized
// execModel value (a real stamp bug, not absence, which it already resolves to sonnet); this
// board must never crash on one bad plan, so that case is caught and passed through as its own
// raw string, matching shortCode's "unknown code passed through as itself" convention above.
export function laneOf(id, stamps, fallback) {
  const s = stamps?.[id];
  if (!s) return fallback;
  try {
    return resolveExecLane(s.execModel).lane;
  } catch {
    return String(s.execModel ?? '');
  }
}

// One oracle result's `runnableBatches` → `{ canonical member id → batch slug }`.
//
// FIRST-match-wins on a double-listed id, matching every other member-map builder in the repo
// (`batchMembershipMap`, batches-view.mjs:491; `readRunnableBatchMembers`, batch-paths.mjs:264)
// and, more importantly, matching the tiebreak the ORACLE itself resolved upstream — so this
// board can never name a different holding train than the roster view does for the same id
// (sonnet-review finding, 2026-07-30; a bare `.set()` was last-match-wins). Keyed by
// `canonicalPlanId`, the oracle's own id normalizer — see the top-of-file import comment for why
// that matters.
//
// Deliberately NOT importing `batchMembershipMap`, despite the identical shape: batches-view.mjs
// pulls move-plan / queue-drain / coord-share-lib / decision-dossier transitively, and this
// module's whole design is to stay light enough to spawn the oracle as a subprocess rather than
// import it (see the header). The 3 lines are the cheap side of that trade; the SEMANTICS are
// what had to stop diverging.
//
// finding a55380/21f627 (review round 3): ONE helper, two callers — `fuseBrowserTier` over the
// BROWSER run's batches and `ingest` over each run's own. They were two copies of this loop, and
// two copies is exactly how the first-match tiebreak above comes back: change canonicalization
// or match order in one and a browser-fused row names a different train than the same id's
// normal ingest does, on the one board whose entire purpose is not misreporting.
export function batchSlugByMember(res) {
  const byMember = new Map();
  for (const b of res?.runnableBatches ?? []) {
    for (const mid of b?.members ?? []) {
      const k = canonicalPlanId(mid);
      if (!byMember.has(k)) byMember.set(k, b.slug);
    }
  }
  return byMember;
}

// Oracle exclude code → the short code shown in the table. The oracle's `reason` strings run
// 80–140 characters; putting them inline makes the box wrap, so the cell carries a code and the
// verbatim reason goes to a footnote (operator ruling 2026-07-26).
//
// `cloud` splits on WHY: an unstamped plan needs a spec-pass to adjudicate it, an explicitly
// `cloudExec: false` plan has already been adjudicated as local-only. Those are different
// operator actions, so they are different codes.
//
// An UNKNOWN code is passed through as itself rather than collapsed to a generic label: a new
// oracle gate must not silently render as a familiar one, and its reason still reaches the
// footnotes. Returning the raw code makes a vocabulary drift visible on the board.
//
// plan 3341: queue-drain.mjs's sol-lane axis added four new exclude codes — `sol` (a
// generic non-drainClaimable refusal that, since plan 3461 made `sol` drain-claimable, no
// longer fires for `sol` itself and is kept only as the mechanism for a future non-claimable
// lane), `sol-env-trusted` / `sol-env-full-unproven` (the sol lane's own cloud-env ladder,
// mirroring `full-env` / `webkit-env` above — `sol-env-trusted` is the one still reachable
// today, a permanent refusal on trusted/limited-egress cloud), and `exec-lane-malformed` (an
// execModel value resolveExecLane doesn't recognize — a stamping typo). None gets a branch
// here on PURPOSE: each is already a single, self-explanatory short code (matching the shape
// `full-env`/`webkit-env`/`batch` already pass through unmapped), so the fallback below
// renders them correctly with no new logic — the carve-out that actually made these visible
// lives in `ingest()`'s native-run check (a `sol` plan has no native oracle run of its own to
// defer to, so it must not be dropped as a would-be duplicate the way a real cross-lane plan
// is — see NATIVE_RUN_LANES above).
export function shortCode(entry) {
  const ex = entry?.exclude;
  if (!ex) return null;
  if (ex === 'cloud') return String(entry.cloudExec) === 'false' ? 'cloud-false' : 'unstamped';
  if (ex === 'blocked') return 'blocked-by';
  if (ex === 'stub') return 'unspecced';
  // plan 4202: a real specReview sha stamped with specReviewBy: undeclared — the oracle's
  // OWN exclude code ('provenance', never a reuse of 'stub': the fix is a re-run /spec-pass
  // + --provenance stamp, not the bare-stub "no spec-pass ran at all" fix).
  if (ex === 'provenance') return 'undeclared-provenance';
  if (ex === 'operator') return 'operator-gated';
  return ex;
}

// plan 3341 delta-review follow-up: the sort comparator below had TWO MORE instances of the
// same bare-plain-object-lookup shape laneLabelFor/priorityGlyphFor close above — on the same
// two hand/oracle-derived fields (`priority`, `lane`), just in the SORT path rather than the
// render path. `PRIORITY_SORT_WEIGHT[a.priority] ?? PRIORITY_SORT_WEIGHT[PRIORITY_DEFAULT]`
// LOOKS like the same class of bug: a prototype-chain name resolves through Object.prototype to
// a FUNCTION, which is not nullish, so the `??` fallback never fires, and subtracting two
// functions produces NaN — a comparator that can return NaN violates Array#sort's contract.
//
// plan 3341 review round 2 (finding E, key da3b41) — CORRECTION to this comment's original
// claim: unlike `lane` (laneRankFor below), `priority` is NOT actually reachable with such a
// value today. read-plan-stamps.mjs routes every `priority:` frontmatter scalar through
// `readPriorityTier()` → `normalizePriorityTier()` (build-index-lib.mjs) BEFORE it ever reaches
// `stamps[id].priority`; that normalizer maps anything outside {high, medium, low} — absent OR
// malformed — to PRIORITY_DEFAULT (with a warn), so `row.priority` is always one of the three
// real tiers by the time it reaches this file. `execModel`, by contrast, reaches
// `laneOf`/`LANE_LABEL` UN-normalized (a plain lower-cased scalar via read-plan-stamps.mjs's
// generic STAMP_KEYS loop), which is exactly why THAT path is genuinely reachable and had to be
// fixed. `priorityWeightFor`'s own-property guard below is kept anyway, as defense-in-depth —
// one cheap line, and "the upstream normaliser will never change or be bypassed" is not a
// contract this file should lean on — but it is hardening against a hypothetical, not a fix for
// a bug that is reachable today the way the lane case was.
export function priorityWeightFor(priority) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_SORT_WEIGHT, priority)
    ? PRIORITY_SORT_WEIGHT[priority]
    : PRIORITY_SORT_WEIGHT[PRIORITY_DEFAULT];
}

// Same shape again for `laneRank` (declared fresh per buildBoard call, right before its one
// call site) — `lane` reaches the sort as whatever laneOf's catch path handed back for a
// genuinely unresolvable execModel, so it is exactly as reachable as the LANE_LABEL case above.
// Takes the table as a parameter (rather than closing over the local `laneRank`) so this is
// directly unit-testable without reaching into buildBoard's internals.
export function laneRankFor(table, lane) {
  return Object.prototype.hasOwnProperty.call(table, lane) ? table[lane] : 9;
}

// plan 3438: the oracle's third bucket (`mutexDropped`, queue-drain.mjs:1941/1964) carries ONE
// reason for the whole run, not a per-plan `excludeReason` the way `excluded[]` does — a seed-write
// plan withheld by the ACTIVE landing mutex is never withheld for a plan-specific cause, so there is
// nothing per-row to quote. Synthesized once here rather than threading `reason: 'landing_mutex_active'`
// (the oracle's own machine-readable code, see queue-drain.mjs:1857) through to the operator verbatim.
const MUTEX_REASON =
  'held by the ACTIVE landing mutex: a seed-write plan cannot be drained while a land is in ' +
  'flight. Not a routing problem and nothing to stamp — it clears when the queue head lands. ' +
  '`node scripts/landing-queue.mjs status` names the holder.';

// note 2 (post-3823 revision): fuses a lane's `--env browser` oracle payload into that SAME
// lane's `--env full` payload BEFORE `ingest()` ever sees either — so `ingest`, footnote
// grouping, the native-run/CROSS_LANE/`sol` handling, and the batch/via-train logic (note 5)
// all stay completely unmodified; this is the SAME "(full)"-style mirroring the fusion is meant
// to produce, just applied at the admission layer instead of only the render layer.
//
// Only an `excluded[]` entry whose exclude code is EXACTLY `browser-env` — the one code the env
// axis can produce under `--env full` today (a `full`/`webkit`/`trusted` plan is already
// admitted there; see CLOUD_ENV_RUNGS, queue-drain.mjs) — is a candidate for revision. Every
// OTHER exclude reason (`cloud`, `blocked`, `operator`, `stub`, `batch`, …) already present under
// `--env full` is untouched: `queue-drain.mjs`'s gate order runs the cloud/env checks well ahead
// of blocked-by/operator/stub/batch/mutex (see `parsePlanMeta`), so a row excluded by one of THOSE
// gates already passed env identically in both runs — the browser run cannot disagree with it.
//
// A `browser-env` candidate, though, genuinely CAN disagree, because it is the one row shape that
// never reached those later gates under `--env full` at all — the env gate stopped it first. Once
// the browser run admits it past env, whatever that SAME later pipeline finds is new information,
// not noise, and review round 2 (findings #1/#3) generalizes this fusion to report it faithfully
// — a stale `browser-env` label left standing once a DIFFERENT gate is now the real reason is the
// same misreport class this file's header exists to prevent:
//   - eligible in the browser run                → PROMOTED to eligible.
//   - excluded in the browser run, ANY OTHER code → adopts that entry VERBATIM (never re-derived;
//                                                    "excluded for a different reason" now
//                                                    includes `batch` — see the `runnableBatches`
//                                                    merge below for why that specific code still
//                                                    renders correctly as 🚃 via-train, not ⛔).
//                                                    EXCEPT a CROSS_LANE code (`fable` /
//                                                    `sonnet-lane`, review round 2 finding A):
//                                                    that means "this row belongs to the OTHER
//                                                    lane's run", not new information about THIS
//                                                    lane's verdict — adopting it verbatim would
//                                                    hand `ingest`'s CROSS_LANE check (per-fuse,
//                                                    keyed on exclude code) an entry it silently
//                                                    drops, erasing the row from the board instead
//                                                    of reporting it. The ORIGINAL browser-env
//                                                    entry is kept instead; the row's OWN
//                                                    native-lane fuse (the other `ingest()` call)
//                                                    is the one that reaches this id past its own
//                                                    env gate, since the env gate is lane-agnostic
//                                                    (queue-drain runs it well ahead of the
//                                                    lane-mismatch check on EVERY invocation) — so
//                                                    that fuse always sees this same id as its own
//                                                    browser-env candidate too.
//   - mutex-dropped in the browser run             → re-filed into the fused `mutexDropped`
//                                                    bucket, so `ingest`'s EXISTING plan-3438
//                                                    third-bucket handling renders `⏸ mutex` with
//                                                    the canonical MUTEX_REASON.
//   - reported in NONE of the browser run's three buckets (a snapshot/timing gap between the two
//     independently-timed oracle calls — e.g. the plan left ready/ between them) → no better
//     information exists, so the row keeps its ORIGINAL full-env verdict, unchanged. This is the
//     one case still genuinely "untouched", and it is a degrade-to-safe, never a promotion.
// A mutex hold (or any other real block the browser run finds) is NEVER promoted to eligible —
// only an explicit `eligible[]` hit ever is. `(browser)` still renders on every one of these rows
// regardless of outcome: it is a stamp-derived provenance fact (`stamps[id].cloudEnv==='browser'`
// — see `browserEnv` on the row shape below), not a claim about which gate currently blocks the
// row, exactly the way `(full)` already renders next to an unrelated `⏸ mutex` row elsewhere on
// this board. "Never a flip of the two `--env full` runs" (the file header) means their verdict
// on every OTHER row (not a `browser-env` candidate) is reproduced byte-for-byte — not that a
// `browser-env` candidate is frozen at a code the pipeline never actually got to test.
//
// `browserRes` missing/undefined (an oracle spawn that failed before this file's caller decided
// how to handle it — see `gatherOracleRuns` below) degrades to the full run's own verdict,
// unchanged: promotion/revision is a bonus a scheduled drain can act on, never a requirement for
// the board to render at all.
export function fuseBrowserTier(fullRes, browserRes) {
  if (!browserRes) return fullRes;
  // finding 54b09a (review round 4): the matching key is the CANONICAL id, not the raw one.
  // `idOf` preserves whatever the filename wrote (`007-Infra-x` reads `007`), while
  // `canonicalPlanId` — the oracle's own normalizer, and what `batchSlugByMember` keys on two
  // lines below — strips the padding. This function was mixing the two: the three browser sets
  // were keyed raw and the batch map canonically, so a plan whose basename padding differs
  // between the two independently-timed oracle snapshots (a rename landing between them) hashed
  // to two different keys and its browser verdict was silently not found, leaving the row on its
  // `browser-env` exclusion. One convention, applied to every key this fusion builds or reads.
  const keyOf = (slug) => {
    const id = idOf(slug);
    return id == null ? null : canonicalPlanId(id);
  };
  const browserEligibleIds = new Set((browserRes.eligible ?? []).map((e) => keyOf(e.slug)));
  const browserExcludedById = new Map((browserRes.excluded ?? []).map((e) => [keyOf(e.slug), e]));
  const browserMutexIds = new Set((browserRes.mutexDropped ?? []).map((slug) => keyOf(slug)));
  // finding C (review round 2): which batch slug (if any) a given id sits in among the BROWSER
  // run's own `runnableBatches` — the SAME `batchSlugByMember` helper `ingest` uses on each run's
  // own batches, so the two can never disagree about which train holds an id (finding a55380/
  // 21f627, review round 3). Consulted ONLY below, to find which batch backs an id this fusion
  // is about to adopt as `exclude: 'batch'` — never for anything else.
  const browserBatchOf = batchSlugByMember(browserRes);
  const excluded = [];
  const promoted = [];
  const mutexPromoted = [];
  // plan 3955: the sibling of `mutexPromoted` — `mutexDropped` itself stays bare slug strings
  // (see the comment at the push site below), so a promoted mutex entry's cost rides here
  // instead, mirroring queue-drain.mjs's own `mutexDropped`/`mutexDroppedMeta` split.
  const mutexMetaPromoted = [];
  // finding C: the slugs of batches this fusion actually adopted a `batch`-excluded row FOR —
  // the only batches allowed into the merged `runnableBatches` below. A batch the browser run
  // reports that backs no row this fusion adopted must not populate the fused via-train mapping,
  // or a full-env row can render as a takeable train with no browser promotion behind it.
  const adoptedBatchSlugs = new Set();
  for (const e of fullRes?.excluded ?? []) {
    if (e.exclude !== 'browser-env') {
      excluded.push(e);
      continue;
    }
    const id = keyOf(e.slug);
    if (browserEligibleIds.has(id)) {
      // Re-shaped to an `eligible[]` entry — that bucket only ever needs `{ slug }` (see
      // `ingest`'s `eligible` loop, which never reads any other field off an eligible entry).
      // plan 3955: carry `cost` through too, or a browser-promoted (`cloudEnv: browser`) plan
      // renders a blank Cost cell for no reason — `e` here is the FULL run's own excluded entry,
      // which already carries its own cost-forecast banner regardless of promotion.
      promoted.push({ slug: e.slug, cost: e.cost });
    } else if (browserExcludedById.has(id)) {
      const browserEntry = browserExcludedById.get(id);
      // finding A (review round 2, most serious): a CROSS_LANE code means "this row belongs to
      // the OTHER lane's run" — see this function's header comment above for the full reasoning.
      // Adopting it here would hand `ingest`'s CROSS_LANE check an entry it silently drops,
      // erasing the row from the board instead of reporting it. Keep the ORIGINAL browser-env
      // entry instead; the row's own native-lane fuse is the one that reports it.
      if (CROSS_LANE.has(browserEntry.exclude)) {
        excluded.push(e);
      } else {
        excluded.push(browserEntry);
        // finding C: record which batch backs this adoption, if any — only a `batch`-coded
        // adoption can ever need one.
        if (browserEntry.exclude === 'batch') {
          const batchSlug = browserBatchOf.get(id);
          if (batchSlug) adoptedBatchSlugs.add(batchSlug);
        }
      }
    } else if (browserMutexIds.has(id)) {
      // `mutexDropped` only ever needs the bare slug string (see `ingest`'s own
      // `.map((slug) => ({ slug, … }))` normalization of this exact bucket).
      mutexPromoted.push(e.slug);
      // plan 3955: `e` is the FULL run's own excluded entry (its `cost` already carries the
      // plan's own banner, same as the `browserEligibleIds` branch above) — recorded as a
      // sibling so a mutex-held row promoted this way still renders its Cost cell.
      mutexMetaPromoted.push({ slug: e.slug, cost: e.cost });
    } else {
      excluded.push(e);
    }
  }
  const fused = { ...fullRes, eligible: [...(fullRes?.eligible ?? []), ...promoted], excluded };
  // Only touch `mutexDropped`/`runnableBatches` when there is actually something to add — a
  // no-op run (the overwhelming common case, and every pre-existing caller shape) must keep
  // producing the EXACT same object shape it always has, each key included or omitted exactly as
  // `fullRes` had it, never a freshly-computed empty array standing in for "absent".
  if (mutexPromoted.length > 0) {
    fused.mutexDropped = [...(fullRes?.mutexDropped ?? []), ...mutexPromoted];
    // plan 3955: same guard, same union order as `mutexDropped` above — kept in the SAME
    // `if` block since the two arrays only ever grow together (one push site, just above).
    fused.mutexDroppedMeta = [...(fullRes?.mutexDroppedMeta ?? []), ...mutexMetaPromoted];
  }
  // An adopted `exclude: 'batch'` entry needs the matching `runnableBatches` row too, or
  // `ingest`'s via-train check (note 5) — which reads `runnableBatches` off THIS SAME fused
  // object — has no way to know a train is runnable only under `--env browser`, and the row
  // would render a plain ⛔ batch instead of the correct 🚃 via-train. finding C (review round 2):
  // merged as a pure union (full-env entries first, matching the "first match wins" convention
  // `ingest`'s own `viaTrainOf` already relies on), but ONLY the batches `adoptedBatchSlugs`
  // actually backs — no longer unconditional on "the browser run reports any runnableBatches at
  // all", which could merge in a batch whose adopted-row premise never held.
  const adoptedRunnableBatches = (browserRes.runnableBatches ?? []).filter((b) =>
    adoptedBatchSlugs.has(b.slug),
  );
  if (adoptedRunnableBatches.length > 0) {
    fused.runnableBatches = [...(fullRes?.runnableBatches ?? []), ...adoptedRunnableBatches];
  }
  return fused;
}

// Build the board from ALREADY-FETCHED inputs. Pure — no spawns, no fs, no clock — so the whole
// classification surface is testable without a live repo.
//
//   sonnet / fable                 : the two oracle results at `--env full`
//                                    ({ eligible: [], excluded: [], mutexDropped: [] })
//   sonnetBrowser / fableBrowser   : the SAME two lanes' oracle results at `--env browser`
//                                    (note 2) — optional; omitted/undefined degrades to the
//                                    `--env full` verdict only, via fuseBrowserTier above
//   stamps                         : id → { execModel, cloudEnv, priority, … } from
//                                    read-plan-stamps
//   claimed                        : Set of plan ids holding a live refs/claims/<id>
export function buildBoard({
  sonnet,
  fable,
  sonnetBrowser,
  fableBrowser,
  stamps = {},
  claimed = new Set(),
}) {
  const seen = new Set();
  const rows = [];
  // Keyed by (code, reason) — NOT by code alone. Several oracle reasons are PER-PLAN, not
  // per-code: `blocked` embeds the specific upstream id ("blocked-by another plan: 2402") and
  // `operator` can quote the plan's own gate text. Keying on the code kept only the FIRST plan's
  // reason and printed it under every row sharing that code, so a second blocked plan was
  // attributed to the wrong upstream — a wrong-blocker misreport in a board whose entire purpose
  // is not misreporting. Each row also records its id so attribution is explicit even when two
  // causes share a code (sonnet-review finding, 2026-07-26).
  const footnotes = new Map();

  const ingest = (res, runLane) => {
    // note 5: which of THIS run's batch holds are holds on a train the run reports as RUNNABLE.
    // Per-run, never merged across the two lanes: a train's members are all one lane (a
    // cross-lane member would be excluded as `fable`/`sonnet-lane` and withhold the train), and
    // rows are only rendered under their native lane, so the run that renders the row is always
    // the run whose verdict governs it. Built by `batchSlugByMember` (above), which is also what
    // `fuseBrowserTier` uses on the browser run's batches — see that helper for the first-match
    // tiebreak and for why `batchMembershipMap` is deliberately not imported here.
    const viaTrainOf = batchSlugByMember(res);

    // plan 3955: `mutexDropped` itself stays bare slug strings (a pinned contract — deepEqual'd
    // elsewhere and read as slugs by the drain prompts), so cost rides the SIBLING
    // `mutexDroppedMeta` array (queue-drain.mjs) instead. Built once per `ingest` call and
    // consulted only by the mutex-bucket normalization immediately below.
    const mutexCostBySlug = new Map((res?.mutexDroppedMeta ?? []).map((m) => [m.slug, m.cost]));

    for (const [entries, eligible] of [
      [res?.eligible ?? [], true],
      [res?.excluded ?? [], false],
      // plan 3438: the third oracle bucket — a seed-write plan withheld by the ACTIVE landing
      // mutex (`mutexDropped`, queue-drain.mjs:1941/1964), never ingested before this fix. That
      // is the exact regression: dropped by CROSS_LANE in its non-native run, never present in
      // its native run's `eligible`/`excluded` either (the oracle moved it OUT of `candidates`
      // before either was computed), so it rendered nowhere at all — three real ready/ plans
      // (3309, 3397, 3424) vanished from the board on 2026-08-24.
      //
      // `mutexDropped` serializes as bare slug strings, not `{slug, exclude, reason}` objects
      // like the other two buckets — normalized to that shape HERE, on the way in, rather than
      // branching inside the loop body below (which reads `e.slug`/`e.exclude`/`e.reason` off
      // every entry uniformly regardless of which bucket it came from). plan 3955: `cost` is
      // looked up from the sibling `mutexDroppedMeta` map above — `mutexDropped` itself never
      // grows a fourth field.
      [
        (res?.mutexDropped ?? []).map((slug) => ({
          slug,
          exclude: 'mutex',
          reason: MUTEX_REASON,
          cost: mutexCostBySlug.get(slug) ?? null,
        })),
        false,
      ],
    ]) {
      for (const e of entries) {
        const id = idOf(e.slug);
        if (!id) continue;
        if (CROSS_LANE.has(e.exclude)) continue; // note 1: the other lane's plans
        const lane = laneOf(id, stamps, runLane);
        // Is `lane` one queue-drain actually runs a NATIVE `--lane` invocation for? This used
        // to be answered by `drainClaimable` (EXEC_LANE_TABLE, claim-plan-lib.mjs), back when
        // `sol` was the one lane with `drainClaimable: false` and the two questions happened to
        // coincide. Plan 3461 made `sol` drain-claimable WITHOUT inventing a `--lane sol` CLI
        // value (see queue-drain.mjs's requestedLane/fableLane comments) — a `sol` plan is
        // admitted under BOTH the sonnet and fable oracle runs instead of getting a run of its
        // own. So `drainClaimable` no longer answers "does this lane have a native run" — only
        // membership in NATIVE_RUN_LANES does. A genuinely unresolvable lane string (laneOf's
        // own catch path) is the other case with no native run; resolveExecLane's throw on that
        // is exactly why this is wrapped — it must not escape and crash the whole board over one
        // bad stamp.
        let laneHasNativeRun;
        try {
          resolveExecLane(lane); // throws on a genuinely unresolvable lane string
          laneHasNativeRun = NATIVE_RUN_LANES.has(lane);
        } catch {
          laneHasNativeRun = false;
        }
        if (laneHasNativeRun) {
          // The ORIGINAL two-lane case: dedupe a plan that WILL (or already did) render under
          // its own matching run — report it under its NATIVE lane only.
          if (lane !== runLane) continue;
        }
        // No native run exists for this lane (`sol` today), so "defer to the native run" is not
        // an option — both the sonnet and the fable oracle call legitimately report this plan
        // (each carrying its own real code/reason — `sol` plans render as either eligible or one
        // of `sol-env-trusted` / `sol-env-full-unproven` / `exec-lane-malformed`, since plan 3461
        // made `sol` drain-claimable and lane-agnostic in both lanes).
        //
        // plan 3461 round 2 (finding: ready-board.mjs:147): this used to hardcode "admit from the
        // sonnet run only" (`if (runLane !== 'sonnet') continue;`), which silently DROPPED a sol
        // plan the sonnet oracle call did not report at all (a partial/failed spawn, or any other
        // reason it did not surface there) even though the fable call reported it fine — the
        // fixed literal named a specific lane instead of deriving admission from `hasNativeRun`.
        // The `seen` Set immediately below is the SAME de-dupe every other bucket in this loop
        // already relies on (mutexDropped vs eligible/excluded, the id-level guard at line 437) —
        // reusing it here means: `ingest(sonnet, …)` runs first, so the sonnet call's sighting
        // wins whenever it reports the plan (preserving the deterministic tie-break plan 3341
        // documented for the common case), but a plan the sonnet call never reports still renders
        // from the fable call instead of vanishing from the board — never dropped, never doubled.
        if (seen.has(id)) continue; // defensive: never render one plan twice
        seen.add(id);

        const code = eligible ? null : shortCode(e);
        // Scoped to the `batch` code specifically, NOT to "any excluded row that appears in a
        // runnable batch": a member excluded by a gate ABOVE the batch gate (cloud, lane, env,
        // stub) withholds its whole train and so can never appear in `runnableBatches` — but
        // pinning the code here means a future oracle change cannot quietly turn some OTHER ⛔
        // into a 🚃.
        const viaTrain = code === 'batch' ? (viaTrainOf.get(canonicalPlanId(id)) ?? null) : null;
        if (code) {
          const reason = e.reason ?? '(no reason given)';
          // The GLYPH joins the footnote key (NUL-separated, so no component boundary can be
          // forged): two rows sharing a code AND a reason but differing in runnability must stay
          // two blocks. In practice the reason embeds the batch slug so they already differ —
          // keying on the glyph makes that a property of this code rather than of the oracle's
          // current reason wording.
          //
          // The separator is written as the ESCAPE `\0`, never a literal NUL byte in the source
          // (it was one until plan 2643). A literal NUL makes grep call this file "binary" and
          // renders as a space in most readers — during 2643's own review three independent
          // agents AND the authoring session each mis-read it as a space and filed a
          // comment-contradicts-code finding that byte inspection refuted. Same bytes at runtime,
          // legible in source. Do not re-introduce the literal.
          // plan 3438: a mutex hold gets its own glyph — ⛔ elsewhere on this board means "a
          // cloud drain cannot take this", but a mutex hold is not a routing problem the operator
          // can act on the way `cloud-false`/`unspecced`/`blocked-by` are; it clears on its own
          // the moment the queue head lands.
          const glyph = viaTrain ? '🚃' : code === 'mutex' ? '⏸' : '⛔';
          const label = viaTrain ? 'via-train' : code;
          const key = `${glyph}\0${label}\0${reason}`;
          if (!footnotes.has(key)) footnotes.set(key, { glyph, label, reason, ids: [] });
          footnotes.get(key).ids.push(id);
        }
        rows.push({
          id,
          slug: e.slug,
          lane,
          // The full tier string, not the boolean `=== 'high'` predicate — plan 2582. The
          // ⚡-for-high render below still agrees with the INDEX bullet's `isHighPriority`
          // predicate (build-index-lib.mjs), so the board and the INDEX bullet cannot disagree
          // about which plans are flagged; the board additionally distinguishes medium from low.
          priority: stamps[id]?.priority ?? PRIORITY_DEFAULT,
          fullEnv: stamps[id]?.cloudEnv === 'full',
          // note 2 (post-3823 revision): sourced from the plan's own stamp, exactly like
          // `fullEnv` above — never from which run (full-env or browser-env) actually reported
          // this row. A row can carry this tag while still excluded for a non-env reason (the
          // (full) tag already does the same), so it is set unconditionally here, not only on
          // a promoted row.
          browserEnv: stamps[id]?.cloudEnv === 'browser',
          // Review fix round (2943+2944, F9): 2943's acceptance names `/ready-plans` showing the
          // evidence-floor stamp as a column — `evidence` already reaches STAMP_KEYS
          // (read-plan-stamps.mjs), it just never reached this board's row shape. Derived exactly
          // like `fullEnv` above (a plain stamps[id] lookup, null when unstamped).
          evidence: stamps[id]?.evidence ?? null,
          // plan 3967: the review-round fastlane stamp — sourced from the SAME contracted
          // STAMP_KEYS field every other axis on this row reads (never a frontmatter regex);
          // `stamps[id].lane` is already the readLane-equivalent lower-cased scalar (STAMP_KEYS'
          // `lane` entry goes through the same readFrontmatterScalar+lowercase readPlanStamps
          // applies to every non-priority key), so comparing it to `'fast'` here IS readLane's own
          // normalization, not a second one. Named `fastLane`, never `.lane` — this row already
          // carries `.lane` for the UNRELATED execModel lane (sonnet/fable/sol; see
          // read-plan-stamps.mjs's LANE_FAST header comment for the two axes sharing one English
          // word).
          fastLane: stamps[id]?.lane === LANE_FAST,
          // plan 2577: which extra repos a drain must clone for this plan. Without it the board
          // shows a `cloudRepos` plan as an ordinary cloud-eligible row, so an operator asking
          // why such plans keep getting skipped (a drain with no credential for the repo passes
          // over them by design) gets no signal here at all.
          repos: stamps[id]?.cloudRepos || null,
          claimed: claimed.has(id),
          // plan 3955: the plan's own cost-forecast banner (Cash/Claude split, or the legacy
          // single figure) — a property of the PLAN, not of its takeable-ness, so it rides every
          // row (eligible, excluded, claimed, blocked) exactly like `evidence` above. `e.cost` is
          // undefined on a bare `{ slug }` fixture (e.g. `mutexDropped`'s normalized entries) —
          // `?? null` keeps the row shape's `cost` key always present, never `undefined`.
          cost: e.cost ?? null,
          eligible,
          code,
          // note 5: the slug of the runnable train that holds this row, else null. Carries the
          // slug rather than a boolean so the cell/footnote could name the train later without
          // re-deriving it, and so a debugging reader can see WHICH train made the row takeable.
          viaTrain,
        });
      }
    }
  };

  // note 2 (post-3823 revision): each lane's `--env full` payload is fused with that SAME
  // lane's `--env browser` payload before `ingest` sees it — sonnetBrowser pairs with sonnet,
  // fableBrowser pairs with fable, mirroring the sonnet/fable pairing note 1 already requires.
  // `ingest` itself is completely unaware this happened; it just sees a richer `eligible[]`.
  ingest(fuseBrowserTier(sonnet, sonnetBrowser), 'sonnet');
  ingest(fuseBrowserTier(fable, fableBrowser), 'fable');

  // Priority first, then lane (sonnet before fable), then id ascending — the operator reads this
  // top-down asking "what should be taken next". Lane order is an EXPLICIT rank, not
  // `localeCompare`: alphabetically 'fable' precedes 'sonnet', which is the opposite of the
  // intended reading order (the sonnet lane is the one a cloud drain can take unattended).
  // Review round 6 (key b2cec7): derived from EXEC_LANE_TABLE's own key order, not a fourth
  // hand-typed lane list. Hardcoded, a newly-recognised lane fell to laneRankFor's rank-9
  // fallback and sorted in among genuinely UNKNOWN lanes — counted and labelled correctly in
  // the header while sitting in the wrong place in the table, which is the worst combination
  // for an operator scanning it. Key order is the canonical lane order.
  const laneRank = Object.fromEntries(Object.keys(EXEC_LANE_TABLE).map((lane, i) => [lane, i]));
  rows.sort(
    (a, b) =>
      priorityWeightFor(a.priority) - priorityWeightFor(b.priority) ||
      laneRankFor(laneRank, a.lane) - laneRankFor(laneRank, b.lane) ||
      Number(a.id) - Number(b.id),
  );

  // plan 3341 review round 2 (finding D, key 17f5cf): a row's `.lane` can be a raw,
  // genuinely-unresolvable execModel string (laneOf's own catch path — see its comment
  // above) that is none of `sonnet`/`fable`/`sol`. That row still RENDERS (laneLabelFor
  // degrades it to "❓ unknown lane (…)"), but before this fix it was counted in NONE of the
  // three named buckets, so `counts.total` could exceed `sonnet + fable + sol` — the header
  // line then read e.g. "Ready plans: 1 (sonnet 0 · fable 0) — 0 takeable…", which
  // contradicts itself (1 total, 0 in the breakdown) and hides the malformed row from the
  // summary even though it sits right there in the table body. `other` closes the gap so
  // the breakdown always sums to `total`.
  // Derived from EXEC_LANE_TABLE (claim-plan-lib.mjs), the one canonical lane vocabulary,
  // never a fourth hand-typed copy of it (review keys 952c40/b41e2b/3f9b6d/7caff3). A
  // hardcoded set meant a newly-added RECOGNISED lane would render its proper label in the
  // Lane column while being counted under `other` in the header — a lane breakdown that
  // contradicts the rows above it, and a second edit needed for every new lane.
  const KNOWN_LANES = new Set(Object.keys(EXEC_LANE_TABLE));
  // Review round 5 (keys 4f7633/29607a/5f00ae/db39ea/322bfb/983f43): deriving KNOWN_LANES from
  // EXEC_LANE_TABLE while leaving the count BUCKETS hardcoded was a half-fix that made things
  // worse, not better — a newly-added recognised lane was now excluded from `other` (because it
  // IS known) while having no bucket of its own, so its rows vanished from EVERY bucket and the
  // breakdown no longer summed to `total`. Before the KNOWN_LANES change such a row at least
  // landed in `other`. So the buckets are derived from the same table: one per recognised lane,
  // plus `other` for a lane string that resolves to nothing at all. The breakdown always sums to
  // `total`, whatever lanes exist.
  const laneCounts = Object.fromEntries(
    Object.keys(EXEC_LANE_TABLE).map((lane) => [lane, rows.filter((r) => r.lane === lane).length]),
  );
  return {
    rows,
    footnotes,
    counts: {
      // Review round 6 (key e04fe6): the fixed summary fields are written AFTER the spread, so a
      // lane whose name collided with `total` / `other` / `takeable` could never shadow them —
      // it would lose its own bucket rather than corrupt the summary, which is the safe direction
      // to fail. Not guarded further: EXEC_LANE_TABLE is a hand-curated three-row literal in
      // claim-plan-lib.mjs, so a lane literally named `total` is a typo a reviewer sees, not a
      // runtime condition worth a check here.
      ...laneCounts,
      total: rows.length,
      // plan 3341 review round 2 (finding D, key 17f5cf): the catch-all for a lane string that
      // is none of the recognised ones — see the comment above this object.
      other: rows.filter((r) => !KNOWN_LANES.has(r.lane)).length,
      // "Takeable NOW" is the operator's actual question: eligible AND not already held.
      // note 5: a member of a RUNNABLE train counts too — the drain's batch check must take that
      // train, so the row is takeable this instant even though it is not in `eligible[]`. Leaving
      // it out made the header under-report exactly the work a drain would pick up first.
      takeable: rows.filter((r) => (r.eligible || r.viaTrain) && !r.claimed).length,
    },
  };
}

// CLAIMED takes precedence over an exclude code: once a session holds the plan, its cloud
// verdict is moot — the answer to "can this be taken" is no, someone has it. The exclude code is
// still reachable from the oracle for anyone asking why it was not drainable in the first place.
export function cloudCell(row) {
  // The repos tag stacks with either env tag: the axes are independent (a `cloudRepos` plan is
  // usually Trusted-env), so a plan can legitimately show `✅ ELIGIBLE (full) (+hobby-main)`.
  // `fullEnv`/`browserEnv` themselves never both fire on one row — a plan's `cloudEnv` stamp is
  // one value, not a set — but each is still an independent `??`-free boolean check (note 2),
  // not an `else`, so a future rung that legitimately sits on both axes is not silently dropped.
  const tag =
    (row.fullEnv ? ' (full)' : '') +
    (row.browserEnv ? ' (browser)' : '') +
    (row.repos ? ` (+${row.repos})` : '');
  if (row.claimed) return `🔒 CLAIMED${tag}`;
  // note 5: before ELIGIBLE only for readability — the two are mutually exclusive by
  // construction (viaTrain is set only on a row the oracle EXCLUDED as `batch`, and an excluded
  // row is never `eligible`), so the order cannot change any verdict.
  if (row.viaTrain) return `🚃 via-train${tag}`;
  if (row.eligible) return `✅ ELIGIBLE${tag}`;
  // plan 3438: the Cloud-column glyph must agree with the footnote's — a mutex hold renders ⏸
  // in both, not ⛔ in one and ⏸ in the other (see the footnote glyph selection in ingest above).
  const glyph = row.code === 'mutex' ? '⏸' : '⛔';
  return `${glyph} ${row.code}${tag}`;
}

// Tier → glyph (plan 2582, spec-pass-pinned — do not invent another scheme). `medium` renders
// blank: it is PRIORITY_DEFAULT, so an unmarked cell is the honest "default priority" render and
// keeps today's visual for the majority tier.
export const PRIORITY_GLYPH = { high: '⚡', medium: '', low: '↓' };

// plan 3341 review round 2 (key da3b41): CORRECTING this comment's own earlier claim. It used to
// say `priority` is "hand-stamped, exactly like `execModel`, so this is the same reachability
// story" — that was WRONG, and the reviewer traced the data path to show it. `row.priority` is
// `stamps[id]?.priority ?? PRIORITY_DEFAULT`, and that value comes only from readPriorityTier()
// -> normalizePriorityTier() (build-index-lib.mjs), which NORMALISES it. `execModel` by contrast
// reaches its own lookups un-normalised, which is exactly why laneLabelFor's case was a live leak
// and this one is not.
//
// So these guards are DEFENCE-IN-DEPTH, not a currently-reachable bug: one cheap line each at a
// render/sort site, against that upstream normaliser changing or being bypassed by a future
// caller. Kept for that reason and no stronger one. The underlying shape is real where the value
// is un-normalised — `PRIORITY_GLYPH[r.priority] ?? ''` LOOKS safe because of the `??`, but that
// only catches null/undefined: a prototype key resolves to a FUNCTION, which is not nullish, so
// the fallback never fires and the cell prints the function's own source text (verified
// empirically for constructor/toString/valueOf/hasOwnProperty).
export function priorityGlyphFor(priority) {
  if (Object.prototype.hasOwnProperty.call(PRIORITY_GLYPH, priority))
    return PRIORITY_GLYPH[priority];
  return priority == null || priority === '' ? '' : `❓ ${priority}`;
}

// plan 3955: the Cost column cell — the plan's own 💰 Cost forecast banner, parsed by
// `parseCost` (queue-drain.mjs) into `{ raw, usd, over, unknown, split, claude }`. ONE line
// (box-table.mjs has no multi-line cell support), and never a fabricated figure: `null`/
// `unknown` renders blank rather than guessing `$0`. `over` prefixes `>` on whichever axis it
// is set for — the banner's own "at least this much" convention. No `~` (the parser never
// retains it — `usd` is already a plain number) and no per-model breakdown beyond Cash/Claude
// (the banner grammar carries no richer data than that).
function fig(c) {
  return `${c.over ? '>' : ''}$${c.usd}`;
}
export function costCell(cost) {
  if (cost == null || cost.unknown) return '';
  if (cost.split) return `Cash ${fig(cost)} · Claude ${fig(cost.claude)}`;
  return fig(cost);
}

export function renderReadyBoard(board) {
  const { rows, footnotes, counts } = board;
  const out = [];
  out.push(
    `Ready plans: ${counts.total} (sonnet ${counts.sonnet} · fable ${counts.fable}` +
      // sonnet and fable ALWAYS render (even at 0) so the common line stays byte-identical to
      // what it was before this plan. Every other recognised lane renders only when present —
      // same convention as the (full)/(+repo) footers — and the list comes from EXEC_LANE_TABLE
      // rather than a hand-maintained sequence, so a future lane appears here with no edit
      // (review round 5). `other` stays last: it is the not-a-lane-at-all catch-all.
      Object.keys(EXEC_LANE_TABLE)
        .filter((lane) => lane !== 'sonnet' && lane !== 'fable' && counts[lane])
        .map((lane) => ` · ${lane} ${counts[lane]}`)
        .join('') +
      (counts.other ? ` · other ${counts.other}` : '') +
      `) — ${counts.takeable} takeable by a cloud drain now.`,
  );
  if (!rows.length) {
    out.push('(ready/ is empty.)');
    return out.join('\n');
  }

  out.push(
    renderBox(
      // F9: one small added column, everything else byte-identical — the evidence stamp reads
      // blank for an unstamped plan (the grandfathered-pool default), exactly like the Prio
      // column's blank-for-medium convention already does.
      // plan 3955: Cost added LAST, after Evidence — same blank-for-unset convention, never a
      // fabricated figure for an unparseable/absent banner.
      ['Plan', 'Title', 'Lane', 'Prio', 'Cloud', 'Evidence', 'Cost'],
      rows.map((r) => [
        r.id,
        titleOf(r.slug),
        // plan 3967: a `lane: fast` row carries a ⚡ suffix on the Lane cell — a DIFFERENT axis
        // from the execModel lane laneLabelFor itself renders (sonnet/fable/sol), appended rather
        // than folded into laneLabelFor's own table so an unrecognized/future execModel lane
        // still degrades exactly as laneLabelFor already documents.
        laneLabelFor(r.lane) + (r.fastLane ? ' ⚡' : ''),
        priorityGlyphFor(r.priority),
        cloudCell(r),
        r.evidence ?? '',
        costCell(r.cost),
      ]),
      { centerCols: [0, 3] },
    ),
  );

  // One block per DISTINCT CAUSE — the oracle's verbatim reason, with the plan ids that carry it.
  // Two plans blocked on two different upstreams get two blocks, each naming its own rows; plans
  // sharing one generic cause (cloudExec unset, a stub gate) still collapse to a single block.
  // note 5: the glyph comes from the entry, not a hardcoded ⛔ — a via-train block is not a
  // blocked block. Its reason is the oracle's VERBATIM hold text, which already carries the
  // "take the whole train via `claim-plan.mjs batch`" instruction an operator needs to act on it.
  for (const { glyph, label, reason, ids } of footnotes.values()) {
    out.push(`${glyph} ${label} (${ids.join(', ')}) — ${reason}`);
  }
  if (rows.some((r) => r.fullEnv)) {
    out.push('(full) = needs a Full-egress runner. Every live drain routine is one — not a block.');
  }
  if (rows.some((r) => r.browserEnv)) {
    out.push(
      // plan 3823 review (claude-data-grounding, keys eeb8bf/967848 on the twin rung literals):
      // this line must NOT claim every live slot already RUNS a browser body. The registry marks
      // them; the reconciler pushes them per account; which pushes have actually landed is live
      // state a dated log cannot answer reliably (round 3 finding D) — it can lag reality in
      // EITHER direction (a slot synced after the log's last entry, or a slot the log still
      // claims is synced but was since re-provisioned). The LIVE check is
      // `sync-trigger-bodies.mjs --dry-run`, which reads each account's actual trigger body
      // rather than a point-in-time note about it; the dated log stays useful as background
      // history, never as the answer to "is this slot running browser right now".
      '(browser) = needs verified live headless-Chromium egress. Every drain slot is marked ' +
        '`browser` in the account registry since plan 3823 — that MARKS the slot, it does not ' +
        'mean its live trigger already runs that body. Not a block on this board either way — ' +
        'the live check is the trigger-body sync tool in dry-run mode; ' +
        "the project's fleet log has the dated history, which can lag reality.",
    );
  }
  if (rows.some((r) => r.repos)) {
    out.push(
      '(+repo) = the drain must clone that extra repo beside vetapp before working the plan. ' +
        'Not a block while its credential is provisioned — a drain that lacks one skips the plan.',
    );
  }
  return out.join('\n');
}

// ── live inputs ───────────────────────────────────────────────────────────────

// The oracle exits 1 when a lane has nothing eligible — a NORMAL condition, not a failure — and
// prints its JSON either way, so a non-zero exit whose stdout PARSES is a legitimately empty lane.
//
// Anything else is a real oracle failure (a crash before it printed, a bad flag, a broken import
// like the sibling-repo drift plan 2488 measured) and it THROWS. It must not degrade to an empty
// lane: "0 ready plans, 0 takeable" is a plausible-looking board that reads as "nothing to do"
// while a live regression hides behind it — the same false-empty misreport loadStamps() below
// refuses to commit, and refusing it in one place but not the other is no protection at all
// (sonnet-review finding, 2026-07-26).
export async function runOracle(args, { exec = execFileAsync } = {}) {
  try {
    const { stdout } = await exec(process.execPath, [ORACLE, ...args], { encoding: 'utf8' });
    return JSON.parse(stdout || '{}');
  } catch (e) {
    try {
      return JSON.parse(e.stdout);
    } catch {
      throw new Error(
        `ready-board: the drain oracle failed and printed no parseable JSON — NOT printing a\n` +
          `board, because an empty lane here is indistinguishable from "nothing to do".\n` +
          `  queue-drain.mjs ${args.join(' ')}\n` +
          (e?.stderr || e?.message || e),
      );
    }
  }
}

// Claims via the canonical `lsRemoteTimed` (coord-git.mjs), NOT a hand-rolled ls-remote: plan
// 1475 created that primitive precisely to give every refs/claims reader a 5s cap, so an
// unreachable origin fails fast instead of blocking on the OS-level DNS/TCP timeout. An untimed
// call here would hang the whole board rather than degrading to "claims unknown" the way the
// catch below advertises (sonnet-review finding, 2026-07-26).
export function readClaims({ heldClaims = heldClaimsMap } = {}) {
  const claimed = new Set();
  try {
    // plan 3756 review: a claim ref outliving its claim (the release tombstone) means ref
    // EXISTENCE is no longer holding. heldClaimsMap resolves the tips — one capped fetch for
    // the whole namespace, both namespaces covered — so a landed plan stops reading as claimed.
    //
    // This set feeds the /ready-plans VIEW (the drain oracle reads claims itself), so the cost
    // of a stale entry is a board that tells an operator a landed plan is still being worked.
    for (const id of Object.keys(heldClaims(REPO_ROOT))) claimed.add(id);
  } catch {
    // Offline / no remote / timed out: claims are ADDITIVE information. Degrading to "none known"
    // costs an operator one wasted pickup attempt (claim-plan.mjs's ref-CAS still refuses it),
    // far cheaper than refusing to print the board. Unlike the stamps and the oracle, a missing
    // claim can never MISATTRIBUTE a row — only under-annotate it.
  }
  return claimed;
}

// The stamps are LOAD-BEARING for lane attribution (note 1) — an empty map silently files every
// plan under SONNET, the exact 2026-07-19 misreport. So this fails LOUD and self-explaining
// rather than degrading to `{}` the way the two readers above do.
export function loadStamps({ collect = collectPlanStamps } = {}) {
  try {
    return collect();
  } catch (e) {
    throw new Error(
      'ready-board: could not read the plan stamps — NOT printing a board, because without them\n' +
        'every plan would be filed under the SONNET lane. Two likely causes:\n' +
        '  1. wrong cwd — run this from the vetapp repo ROOT, not a subdirectory;\n' +
        '  2. the wrong REPO — /ready-plans is vetapp-only (plan 2488).\n' +
        (e?.message ?? e),
    );
  }
}

// plan 3816 fix round (review Fix 3): honest per-run snapshot provenance. The prior
// `originMasterShortSha` resolved ONE `rev-parse origin/master` AFTER both oracle calls
// returned — since this board runs the sonnet and fable oracles CONCURRENTLY, each fetching
// independently, that post-hoc read could land on a THIRD ref if yet another fetch (this
// checkout's own, or a sibling session's) landed in between the two calls and this resolve —
// so the header could print snapshot C while one call's rows actually came from snapshot A.
//
// Each oracle now reports the snapshot it ACTUALLY read (queue-drain.mjs main()'s additive
// `originSha` field), so this renders straight off those two payloads instead of a third,
// independently-timed git read. Pure and non-fatal by construction (no fs/git of its own, and
// every branch just formats strings) — any missing/malformed sha degrades to '(unknown)'
// rather than throwing, because losing the sha is not the same as misattributing a row.
//
// fix round 2, Fix E: the EQUALITY CHECK below compares the FULL `originSha` strings, never the
// 7-char prefixes — two genuinely different commits sharing a 7-char prefix would otherwise
// render as one agreed snapshot. Shortening happens only at the very end, for DISPLAY.
//
// fix round 2, Fix D: surfaces the fetch-degradation warning to the board. Before this, a failed
// `git fetch origin` (or an unreadable local `origin/master`, see readReadyMetas's Fix C) only
// ever logged to the oracle CHILD PROCESS's stderr — which ready-board.mjs's runOracle discards
// on a successful (exit-0-or-1) run, so the board would silently show a stale/empty snapshot as
// if it were fresh. `originFetchFailed` (main()'s additive field) carries that degradation into
// the JSON payload instead, so it survives the child-process boundary; when EITHER oracle
// reports it, the header appends a loud, non-fatal warning rather than staying silent.
//
// fix round 3 (review keys f5ba3e/1494a6): the SAME child-process-stderr blind spot applied to
// the unreadable-blob skip readyEntriesFromOrigin/readReadyMetas already logged — a plan whose
// blob comes back non-string is dropped from the ready/ scan with one line to the oracle's own
// stderr, which this board's runOracle also discards on success, so `/ready-plans` rendered a
// fresh-looking snapshot silently missing a ready plan. `originSkippedUnreadable` (main()'s
// additive field, mirroring `originFetchFailed`'s plumbing exactly) carries that count across the
// same child-process boundary. Both oracles scan the same origin/master snapshot in the common
// case, so they normally agree; `Math.max` reports the worse of the two rather than silently
// hiding one oracle's finding behind the other's (or double-counting via a sum, which would be
// wrong on the — expected — common case where both report the same skip). When BOTH warnings
// apply, the fetch-failure warning appears first, per this round's fix spec.
//
// note 2 (post-3823 revision, review round 2 finding #2): `sonnetBrowser`/`fableBrowser` join the
// SAME agreement/warning logic as `sonnet`/`fable` — rows can now be promoted or revised on the
// strength of a browser run that may have read a different origin snapshot, hit its own fetch
// degradation, or skipped its own unreadable blob, and an operator shown a sha that ignores that
// run would be looking at provenance the rendered rows don't actually match. `sonnet`/`fable`
// stay REQUIRED exactly as before (either missing still forces `(unknown)`, unchanged from every
// pre-existing caller and test) — `sonnetBrowser`/`fableBrowser` are OPTIONAL: omitted entirely
// (the pre-3823 two-run call shape) or present-but-shaless (the browser tier degraded this run,
// warned separately via `browserTierStatus` below) both simply drop out of the sha set rather
// than forcing `(unknown)` or fabricating a disagreement — a browser-tier outage must cost
// promotions, never the whole header (finding #1's same non-fatal posture).
//
// The equality/display logic generalizes from exactly 2 slots to however many of the four
// actually reported a sha, preserving the ORIGINAL 2-run behaviour byte-for-byte in every
// pre-existing test (proven by the unchanged test fixtures, none of which pass
// sonnetBrowser/fableBrowser): full shas are compared for equality (never the shortened
// prefixes — Fix E's lesson, unchanged), and on disagreement every present run's shortened sha is
// listed in `sonnet, fable, sonnetBrowser, fableBrowser` order, not deduped by short form (Fix
// E's prefix-collision case still shows the same short prefix twice when the full shas differ).
export function originHeaderLine({
  sonnet,
  fable,
  sonnetBrowser,
  fableBrowser,
  browserTierStatus,
} = {}) {
  const sonnetSha = sonnet?.originSha;
  const fableSha = fable?.originSha;
  const fetchWarning =
    sonnet?.originFetchFailed ||
    fable?.originFetchFailed ||
    sonnetBrowser?.originFetchFailed ||
    fableBrowser?.originFetchFailed
      ? ' — WARNING: origin fetch failed, board may be stale'
      : '';
  const skippedUnreadable = Math.max(
    sonnet?.originSkippedUnreadable || 0,
    fable?.originSkippedUnreadable || 0,
    sonnetBrowser?.originSkippedUnreadable || 0,
    fableBrowser?.originSkippedUnreadable || 0,
  );
  const skippedWarning =
    skippedUnreadable > 0
      ? ` — WARNING: ${skippedUnreadable} ready plan(s) unreadable at that snapshot and omitted`
      : '';
  // finding B (review round 2): `browserTierStatus` is a PER-LANE outcome (`{ sonnet, fable }`,
  // each one of `'ok'` / `'failed'` / `'skipped'`) — a single shared boolean made a PARTIAL
  // failure print a false statement: if the sonnet browser call succeeded and promoted a row the
  // table is showing, a shared boolean still said "no browser-only promotions were applied"
  // whenever the OTHER lane's call failed. The board must never assert something the rows on it
  // disprove, so only a lane whose own call actually failed is named. finding E: `'skipped'` (no
  // ready plan carries `cloudEnv: browser` this run, so `gatherOracleRuns` never even spawned the
  // call) is a THIRD, silent outcome — never worded as a degradation, the same "warn, don't hide"
  // posture the two warnings above use for what genuinely IS one.
  const failedBrowserLanes = ['sonnet', 'fable'].filter(
    (lane) => browserTierStatus?.[lane] === 'failed',
  );
  const browserWarning =
    failedBrowserLanes.length > 0
      ? ` — WARNING: the browser-env tier could not be reached this run for the ` +
        `${failedBrowserLanes.join(' and ')} lane${failedBrowserLanes.length > 1 ? 's' : ''}; ` +
        `no browser-only promotions/revisions applied there`
      : '';
  const warning = fetchWarning + skippedWarning + browserWarning;
  if (!sonnetSha || !fableSha) return `source: origin/master @ (unknown)${warning}`;
  const shas = [sonnetSha, fableSha, sonnetBrowser?.originSha, fableBrowser?.originSha].filter(
    (sha) => sha != null,
  );
  const allAgree = shas.every((sha) => sha === shas[0]);
  if (allAgree) return `source: origin/master @ ${String(shas[0]).slice(0, 7)}${warning}`;
  const shortShas = shas.map((sha) => String(sha).slice(0, 7));
  return `source: origin/master @ ${shortShas.join(' / ')} (snapshots differ)${warning}`;
}

// finding #1 (review round 2): the two `--env full` calls stay STRICT — `runOracle` throws on a
// real oracle failure, and that propagation is load-bearing (the file header's own rule: an empty
// lane must never be indistinguishable from a genuine oracle crash). But wiring the two `--env
// browser` calls into the SAME `Promise.all` made that same throw reachable from a BROWSER oracle
// failure too — the documented "browserRes missing/undefined degrades to the full run's own
// verdict" fallback on `fuseBrowserTier` was therefore unreachable from `main()`: any one of the
// four rejecting failed the whole batch and printed nothing, even when both full-env runs were
// perfectly good. A browser-tier failure only costs promotions/revisions (note 2) — it must never
// cost the board. So the two browser calls are wrapped to NEVER reject: a failure resolves to a
// `'failed'` status instead, which this function unwraps to `undefined` (fuseBrowserTier's own
// documented degrade path) while setting `browserTierStatus` so the caller can warn loudly
// (`originHeaderLine` above) rather than silently lose the tier. finding B (review round 2):
// the status is PER LANE (`{ sonnet, fable }`), not one shared boolean — see originHeaderLine's
// header comment for why a shared flag prints a false statement on a partial failure.
//
// finding E (review round 2): the browser tier's fixed cost — two more full ready/ corpus walks,
// on EVERY invocation of an interactive command — is only worth paying when at least one ready
// plan is actually stamped `cloudEnv: browser`. `stamps` is the SAME map `main()` already builds
// via `loadStamps()` before calling this, so checking it here is free — no new fs/git read. When
// none exists, both browser calls are skipped entirely (never spawned) and report `'skipped'`,
// a THIRD status distinct from `'failed'` — see originHeaderLine for why that distinction must
// survive into the warning wording.
//
// finding a67bee/c3f0ee/b8523e/7d1ba0 (review round 3): scoped to `folder === 'ready'`, because
// `collectPlanStamps` walks EVERY active status folder, not just `ready/` — and the oracle only
// ever evaluates `ready/`. Without the folder scope a browser stamp on a plan no board row can
// come from admits the tier: `waiting-blocked/3560-SOL-Pipe-capture-reliability-eliminate-
// screenshot-blind.md` carries `cloudEnv: browser` today, so both calls were spawned on every
// render, and a failure of either printed originHeaderLine's browser-tier WARNING over a table
// on which no row had ever needed the tier. A board that warns about a degradation none of its
// rows suffered is the same misreport class as one that hides a real degradation.
//
// finding 4e9896/43bf1c (review round 3, both PLAUSIBLE, deliberately NOT fixed): this gate
// reads the LOCAL plan tree while the oracle reads a fetched `origin/master`, so a browser plan
// promoted into `ready/` remotely between the two skips the tier for one render and shows
// `⛔ browser-env` instead of its promotion. Closing that would mean deriving the gate from the
// full runs' own `browser-env` exclusions — which serializes the browser calls behind them and
// costs every render the tier's whole latency, to buy back one stale row on a read-only report.
// It is also the SAME accepted local-vs-origin skew `laneOf` documents at the top of this file
// (a plan moved out of `ready/` between the oracle run and the stamp walk); the board has always
// been a snapshot join of two sources, and the tier gate is not the place to start pretending
// otherwise.
//
// `runOracle` is an injected dependency (default the module's own export) so this stays testable
// against fake failures without spawning a real child process — same pattern as `runOracle`,
// `readClaims`, and `loadStamps` already use.
export async function gatherOracleRuns({ runOracle: run = runOracle, stamps = {} } = {}) {
  const anyBrowserRung = Object.values(stamps).some(
    (s) => s?.folder === 'ready' && s?.cloudEnv === 'browser',
  );
  const settleBrowser = (p) =>
    p.then(
      (res) => ({ status: 'ok', res }),
      () => ({ status: 'failed' }),
    );
  const [sonnet, fable, sonnetBrowserOutcome, fableBrowserOutcome] = await Promise.all([
    run(['--cloud', '--env', 'full']),
    run(['--cloud', '--lane', 'fable', '--env', 'full']),
    anyBrowserRung
      ? settleBrowser(run(['--cloud', '--env', 'browser']))
      : Promise.resolve({ status: 'skipped' }),
    anyBrowserRung
      ? settleBrowser(run(['--cloud', '--lane', 'fable', '--env', 'browser']))
      : Promise.resolve({ status: 'skipped' }),
  ]);
  return {
    sonnet,
    fable,
    sonnetBrowser: sonnetBrowserOutcome.status === 'ok' ? sonnetBrowserOutcome.res : undefined,
    fableBrowser: fableBrowserOutcome.status === 'ok' ? fableBrowserOutcome.res : undefined,
    browserTierStatus: {
      sonnet: sonnetBrowserOutcome.status,
      fable: fableBrowserOutcome.status,
    },
  };
}

async function main() {
  try {
    const stamps = loadStamps();
    // The four oracle runs are independent — none reads another's output — and each re-walks and
    // re-evaluates the whole ready/ corpus. Measured 2026-07-26 on a 148-plan board (then two
    // runs, not four): 3.4s + 2.5s sequential, so running them concurrently takes real time off
    // every invocation of an interactive command; the same reasoning holds now that a THIRD
    // lane-paired env tier joined them (note 2, post-3823). `--env full` = the superset view
    // every live drain used to run; `--env browser` = the superset every live drain slot's
    // generated body runs today, fused into the `--env full` payload by fuseBrowserTier before
    // buildBoard ever sees it — the two `--env full` calls stay `--env full` unmodified and
    // STRICT (a real failure there propagates, per the file header's own rule); the two `--env
    // browser` calls are TOLERANT (finding #1) — `gatherOracleRuns` never lets a browser-oracle
    // failure take the whole board down with it. finding E (review round 2): `stamps` lets
    // `gatherOracleRuns` skip the browser tier entirely when no ready plan needs it.
    const { sonnet, fable, sonnetBrowser, fableBrowser, browserTierStatus } =
      await gatherOracleRuns({ stamps });
    // plan 3816 fix round (review Fix 3): names WHICH origin/master snapshot EACH oracle call's
    // rows actually came from — see originHeaderLine's header comment for why this reads all four
    // calls' own reported snapshots rather than a third, independently-timed git read. Never let
    // this fail the board: originHeaderLine is pure and degrades to '(unknown)' on its own, but
    // the wrap is defense-in-depth against a future change to it throwing.
    try {
      console.log(
        originHeaderLine({ sonnet, fable, sonnetBrowser, fableBrowser, browserTierStatus }),
      );
    } catch {
      console.log('source: origin/master @ (unknown)');
    }
    console.log(
      renderReadyBoard(
        buildBoard({ sonnet, fable, sonnetBrowser, fableBrowser, stamps, claimed: readClaims() }),
      ),
    );
    return 0;
  } catch (e) {
    // loadStamps and runOracle both fail LOUD by design; this is where that reaches the operator
    // as an error instead of a plausible-looking empty board.
    console.error(e.message ?? e);
    return 5;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
