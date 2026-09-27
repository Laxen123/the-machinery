#!/usr/bin/env node
// scripts/coord/plan-body-state.mjs  (plan 619)
// Pure body-state rewrites shared by every path that re-files a plan between
// status folders, so a state MOVE always leaves the plan BODY honest — never just
// the folder. The folder is the state machine; the body must agree with it
// (vetapp CLAUDE.md § "Specs, plans, handoffs"). Before this, a promotion kept the
// stale **Blocked-by:** line + a blocked **Status:** (read as still-blocked), and the
// land/archive path left the body frozen at authoring-time `📋 READY` with a
// `LAND_BLOCKED` parking note surviving into archive/ (the 2026-06-14 plan-612
// false-alarm: an archived plan body read `READY` + `Blocked-by: LAND_BLOCKED`,
// which read as a botched land though the code HAD shipped).
//
// These functions are intentionally side-effect-free string transforms (no fs, no
// git) so the three call sites — move-plan.mjs (re-file), done-worktree.mjs
// (archive close-out), drain-run.mjs (claim) — share ONE source of truth and each
// stays unit-testable. Drain's claim reuses claim-plan-lib's flipStatusToInProgress
// directly (the ref-CAS claim's own helper); the rest live here.

// build-index-lib is equally pure (no fs, no git), so this import keeps the
// side-effect-free contract above intact.
import {
  upsertFrontmatterKey,
  readFrontmatterScalar,
  sectionBounds,
  splitFrontmatter,
  insertAfterFrontmatterOrPrepend,
  spliceAtMatch,
  STATUS_BLOCK_RX,
  COST_BANNER_RX,
  SEED_BANNER_RX,
  H1_RX,
} from './build-index-lib.mjs';

// readFrontmatterScalar (imported above) is build-index-lib's ONE frontmatter-scoped
// scalar reader — reused here rather than a second hand-rolled `stage:` regex (plan 2587
// Task 3).

// STATUS_BLOCK_RX — a **Status:** line plus its contiguous annotation lines — is
// IMPORTED, not redefined here (plan 2353). This file used to own the only block-scoped
// copy while claim-plan-lib.mjs matched a bare Status LINE, so the two writers disagreed
// about what "the status" even is; the single definition and its annotation-key list now
// live in build-index-lib beside the other shared plan-body primitives.
// Anchors for INSERTING a Status line into a body that has none, in preference
// order — cost-forecast banner, else SEED-WRITE banner, else H1 (mirrors
// claim-plan-lib's flipStatusToInProgress anchor order). COST_BANNER_RX /
// SEED_BANNER_RX / H1_RX are now all imported from build-index-lib.mjs (plan 2409)
// instead of hand-copied here — see that module for the cost-anchor narrowing
// rationale (a body sentence merely discussing a cost forecast must not hijack the
// anchor). setStatusLine below still matches all three anchors, AND the
// existing-Status STATUS_BLOCK_RX fast-replace path, against a frontmatter-STRIPPED
// body so a summary line quoting a banner verbatim can never hijack either path
// (round 5 / plan 2392, unchanged by this plan).
// Global (`g`) so dropBlockedBy strips EVERY Blocked-by line — a promotion / archive
// must leave no stale blocker, even if a body somehow stacked two.
//
// plan 2378 (review finding, CONFIRMED): this is a PORTED-VERBATIM MIRROR of
// blocked-by-lib.mjs's `BLOCKED_BY_LINE_RE` plus a trailing `\n?` to eat the line's own
// newline. It must RECOGNIZE exactly what that matcher recognizes, because the two now
// meet: `move-plan`'s promote path calls dropBlockedBy and the plan-2378 write-time gate
// then re-reads the SAME body with `BLOCKED_BY_LINE_RE`. The prior literal
// (`/^\*\*Blocked-by:\*\*.*\n?/gm`) was strictly NARROWER — it required an unquoted,
// exactly-bolded `**Blocked-by:**` at line start — so three sanctioned, corpus-attested
// declaration forms survived the drop:
//   - `> **Blocked-by:** …`        (blockquoted — the shape this repo's own PLAN_484
//                                   test fixture uses)
//   - `Blocked-by: …`             (un-bolded)
//   - `**Blocked-by (soft):** …`  (parenthetical qualifier — 14 archived plans)
// A promotion of such a plan left the line in place and the gate then refused the write,
// turning a routine `move-plan <id> ready` into a confusing BoardInvariantError. Widening
// the drop to the shared shape is what makes the promote path's own comment true again
// ("the line the gate would object to is gone before it looks").
//
// It is a COPY, not an import, for the same tandapp-sibling-adopt reason queue-drain.mjs
// carries its own copy: `plan-body-state.mjs` IS adopted byte-identical by the sibling
// repo (see coord.config.json) while `blocked-by-lib.mjs` is NOT, so importing it would
// ERR_MODULE_NOT_FOUND the moment tandapp syncs. `plan-body-state.test.mjs` asserts this
// literal stays exactly `BLOCKED_BY_LINE_RE.source + '\n?'` so the two cannot drift.
const BLOCKED_RX =
  /^[ \t]*>?[ \t]*\*{0,2}Blocked-by(?:[ \t]*\([^)\n]*\))?(?:\*{1,2}:?|:\*{0,2})[ \t:]*(.*)$\n?/gim;

// Recognized `unblock:` values for parsing/detection. NOTE: `cost` is RECOGNIZED but is
// NOT a valid operator hold — cost is never a blocker (plan 1065). The allowed set for a
// waiting-operator/ plan is `manual`/`decision` only (move-plan.OPERATOR_UNBLOCK enforces
// it; a `cost` move auto-routes to ready/). Keep `cost` here so getUnblock/lint can still
// DETECT a misfiled `unblock: cost` and surface it.
export const VALID_UNBLOCK = ['cost', 'manual', 'decision'];

// Replace the Status block (Status line + contiguous Previous-status/Override
// lines) with a single fresh status line; INSERT after the best anchor when the
// body has no Status line. Idempotent: re-running with the same line is a no-op.
// Splices by index/length (never `String.replace(pattern, statusLine)`), so a
// `$`-sequence in `statusLine` is never reinterpreted as a replacement pattern.
export function setStatusLine(content, statusLine) {
  // Both the existing-Status fast-replace path AND the anchor-insertion path
  // search AND splice within the frontmatter-stripped body only (plan 2360 round
  // 5, hardened plan 2392) — a plan's YAML `summary:` can quote a banner (or even
  // a `**Status:**`-shaped line) verbatim, and the widened COST_BANNER_RX no
  // longer requires a leading `>` that would have kept it out of frontmatter.
  // Splicing by `match.index` + `match[0].length` (not `content.replace(literalText,
  // …)`) means a SECOND, stale occurrence of the same anchor/Status text
  // elsewhere in the body can never mis-target the splice either (plan 2392
  // finding 3) — `replace()` always targets the first occurrence, which need not
  // be the one that was matched.
  const { prefix: fmPrefix, body, block: blockMatch } = matchStatusBlock(content);
  if (blockMatch) {
    return fmPrefix + spliceAtMatch(body, blockMatch, statusLine);
  }
  const anchorMatch = body.match(COST_BANNER_RX) || body.match(SEED_BANNER_RX) || body.match(H1_RX);
  if (anchorMatch) {
    const anchor = anchorMatch[0];
    return fmPrefix + spliceAtMatch(body, anchorMatch, `${anchor}\n\n${statusLine}`);
  }
  // No banner / H1 anchor. If a YAML frontmatter block leads the body, insert AFTER
  // its closing fence — never prepend, which would split the frontmatter and hide
  // `unblock:` / `summary:` from every frontmatter reader. Else (no frontmatter
  // either) prepend. Shared with claim-plan-lib.mjs's flipStatusToInProgress via
  // the one `insertAfterFrontmatterOrPrepend` helper (plan 2392 findings 2-5) —
  // see its build-index-lib.mjs header comment for why a from-scratch
  // frontmatterEnd() rescan here could disagree with the splitFrontmatter this
  // function already used above.
  return insertAfterFrontmatterOrPrepend(content, statusLine);
}

// Drop the **Blocked-by:** line (and its trailing newline) if present. Idempotent.
export function dropBlockedBy(content) {
  return content.replace(BLOCKED_RX, '');
}

/**
 * plan 2587 — the ONE mapping from a plan's `stage:` stamp to the `**Status:**` state
 * token, shared by every writer that stamps a ready-lane Status line. Review finding
 * (CONFIRMED): the ternary was duplicated verbatim in `stampPromotedStatus` here and in
 * next-plan-id's `ensureReadyStatusLine`, which is the exact drift shape build-index-lib's
 * own plan-2409 STATUS_LINE_RX/STATUS_BLOCK_RX consolidation exists to prevent — a future
 * editor changing the vocabulary in one writer would silently re-introduce, in the other,
 * the contradiction board-write-gate's Check A polices.
 *
 * `defaultStage` is what the CALLER knows the body's stage will be if it carries none, and
 * it is deliberately not uniform:
 *   - the mint passes `MINT_DEFAULT_STAGE` ('stub'), because `ensureStageFrontmatter` is
 *     about to stamp exactly that a few lines later — the token must anticipate it.
 *   - a promotion passes nothing: no tool stamps `stage:` on that path, so a body with no
 *     stage stamp keeps the historical `📋 READY` (and Check A cannot fire on it either —
 *     it only judges a literal `specced`/`stub` stamp).
 */
export function statusTokenForStage(content, { defaultStage = '' } = {}) {
  const stage = (readFrontmatterScalar(content, 'stage') || defaultStage).toLowerCase();
  return stage === 'stub' ? '📋 STUB' : '📋 READY';
}

/**
 * plan 2587 (re-review round 2) — the ONE place that resolves "which block is this plan's
 * own Status block", plus the frontmatter split every caller needs to splice it back.
 *
 * The cross-file consolidation (board-write-gate + next-plan-id both calling in here) is
 * only half the job: writing the frontmatter-strip + STATUS_BLOCK_RX match out separately
 * in each export would leave FOUR copies of the selection rule inside this one file, so a
 * future change to it (an extra decoy exclusion, preferring the last match over the first)
 * would have to be echoed four times — reproducing, same-file, the exact "two writers
 * quietly disagree about which Status line is the plan's own" bug this plan closed
 * cross-file. `setStatusLine`, `readStatusState`, and `setStatusToken` all build on this.
 */
function matchStatusBlock(content) {
  const { prefix, body } = splitFrontmatter(content);
  return { prefix, body, block: body.match(STATUS_BLOCK_RX) };
}

/**
 * The leading state segment of a `**Status:**` line: the marker, the emoji/space run, and
 * the first word. Rewriting exactly this span swaps the token while preserving the
 * author's `— …` remainder byte-for-byte.
 */
const STATUS_HEAD_RX = /^(\*\*Status:\*\*)([^A-Za-z\n]*)([A-Za-z][A-Za-z-]*)/;

/**
 * plan 2587 (re-review finding) — the ONE reader of a plan's Status *state token*, and the
 * ONE place that decides WHICH `**Status:**` line is the plan's own.
 *
 * Both halves matter. board-write-gate's Check A and next-plan-id's mint-time reconcile
 * must agree about the same line on the same body, or the mint "fixes" one line while the
 * gate judges another and the write is refused-and-rolled-back for a contradiction the
 * tool just tried to clear. And the line-selection rule is not obvious: it is
 * frontmatter-STRIPPED first-match, exactly what `setStatusLine` below already does — a
 * plan's YAML `summary:` can quote a `**Status:**`-shaped line verbatim (plan 2360 round 5
 * / plan 2392), so a raw whole-content match can land on a frontmatter decoy.
 *
 * Returns the uppercased token (`'STUB'`, `'READY'`, `'IN'`, `'WAITING-DATE'`, …), or null
 * when the body carries no Status line, or one with no word after the marker.
 */
export function readStatusState(content) {
  const { block } = matchStatusBlock(content);
  if (!block) return { hasLine: false, token: null };
  const head = block[0].match(STATUS_HEAD_RX);
  return { hasLine: true, token: head ? head[3].toUpperCase() : null };
}

/** Just the token — the shape board-write-gate's Check A wants (a null token and an absent
 * Status line are both simply "nothing to contradict" there, so it never needs `hasLine`). */
export function readStatusToken(content) {
  return readStatusState(content).token;
}

// plan 2587 Check A, MOVED here from board-write-gate.mjs by plan 2892. Its natural
// owner: the predicate is entirely a question about a plan's own Status line vs its own
// stage stamp, and this module already owns readStatusToken plus the "which Status line
// is this plan's own" selection rule the check depends on. Living here also lets the
// pre-stamp promotability check (plan-promotable-lib.mjs) consult the SAME predicate the
// gate refuses with, without importing the gate — which would close a module cycle.
// board-write-gate.mjs imports and re-exports it, so every existing consumer is unchanged.
// plan 2587 Check A (BLOCKING) — a plan's own `**Status:**` prose line contradicting its
// own `stage:` frontmatter stamp. Measured 2026-07-27: 11 plans (10 `stage: specced` +
// `**Status:** stub`, plus 2563 the reverse `stage: stub` + `**Status:** READY`) carried
// this — tooling (stamp-exec-model, stamp-cloud-exec, move-plan) rewrites the STAMP on
// every re-adjudication and never touches the prose, so the duplicated prose line rots by
// construction and is the one a human reads first (docs/superpowers/plans/archive or
// ready — see plan 2587's provenance for the corpus scan).
//
// Safe to BLOCK (unlike Check B below): the `**Status:**` line is unambiguously a
// self-assertion about THIS plan — there is no "discussing another plan's Status" false
// positive shape the way there is for a body sentence that merely mentions a stamp value.
//
// Only the two measured contradiction pairs are policed; every other token/stage
// combination is silently ignored ON PURPOSE — the live token vocabulary (READY / IN /
// WAITING-TRIP / WAITING-BLOCKED / STUB / SPECCED / WAITING-DATE / BLOCKED / FILED /
// DERAILED / OPEN) has many legitimate stage/token pairings (e.g. `stage: specced` +
// `**Status:** WAITING-TRIP` is entirely normal — a specced plan waiting on a trip
// condition); inventing a rule for combinations nobody has measured as wrong would just be
// guessing.
export function findStageStatusProseViolations(entries) {
  const violations = [];
  for (const { path, content, basename: bn } of entries) {
    const stage = readFrontmatterScalar(content, 'stage').toLowerCase();
    if (stage !== 'specced' && stage !== 'stub') continue; // only the two measured stamps matter
    // Line selection AND token extraction are plan-body-state's `readStatusToken` — never
    // re-rolled here (review findings, both rounds). This file's own header rule is "NO
    // SECOND COPY OF ANY INVARIANT", and the rule matters beyond tidiness: next-plan-id's
    // mint-time reconcile reads the token through the SAME helper, so the heal and this
    // gate can never disagree about WHICH `**Status:**` line is the plan's own. They would
    // otherwise: the local variant here stripped frontmatter while the mint's did not, so
    // on a body whose `summary:` quotes a Status-shaped line the heal fixed the decoy and
    // this check cleared it, leaving the real line contradicting and the gate silent.
    const token = readStatusToken(content);
    if (!token) continue; // no Status line, or no state word — nothing to contradict
    if ((stage === 'specced' && token === 'STUB') || (stage === 'stub' && token === 'READY')) {
      violations.push(
        `${bn}: **Status:** prose says "${token}" while the frontmatter stamp says ` +
          `\`stage: ${stage}\` — the FRONTMATTER is the tooled value; fix the prose line. (${path})`,
      );
    }
  }
  return violations;
}

/**
 * Swap ONLY the state token of the plan's own Status line, preserving its `— …` remainder
 * and any contiguous annotation lines the STATUS_BLOCK carries. Splices by `match.index`
 * (never `String.replace` on the matched text) for the plan-2392 finding-3 reason: a second,
 * stale occurrence of the same text elsewhere in the body must not be able to mis-target it.
 * A body with no Status line is returned unchanged — inserting one is `setStatusLine`'s job.
 */
export function setStatusToken(content, token) {
  const { prefix, body, block } = matchStatusBlock(content);
  if (!block || !STATUS_HEAD_RX.test(block[0])) return content;
  return prefix + spliceAtMatch(body, block, block[0].replace(STATUS_HEAD_RX, `$1 ${token}`));
}

// Promotion (→ ready / in-progress): drop the now-stale Blocked-by line and stamp a
// fresh Status line so the body matches the folder. `fromStatus` names the origin
// folder for the audit trail.
//
// STAGE-AWARE for `target === 'ready'` (plan 2587 acceptance #5): move-plan's own
// promotion gate (specReviewGateError, ~line 250) ACCEPTS a `stage: stub` body carrying
// `specReview: exempt-mechanical` straight into ready/ — a legitimate combination. Before
// this, a `ready` promotion always hardcoded `📋 READY` regardless of `stage:`, so THAT
// promotion would write `**Status:** 📋 READY` against a `stage: stub` stamp — exactly the
// contradiction board-write-gate.mjs's new `stage-status-prose` check (Check A) refuses.
// The tool must carry the prose fix rather than the gate waiving its own invariant for the
// tool that writes it: read the body's OWN `stage:` stamp and emit the matching token
// (`STUB` for `stage: stub`, `READY` otherwise) so a stage-stub/exempt-mechanical
// promotion's Status line agrees with the stamp it is landing beside. `in-progress` needs
// no equivalent branch for a structural reason, not a statistical one: its token is `IN`
// (from `🔄 IN PROGRESS`), which is neither `STUB` nor `READY`, so Check A's two measured
// contradiction pairs can never fire on it at ANY stage value.
export function stampPromotedStatus(content, { target, fromStatus, date }) {
  const emoji = target === 'in-progress' ? '🔄 IN PROGRESS' : statusTokenForStage(content);
  const line = `**Status:** ${emoji} — re-filed ${fromStatus}→${target} ${date}.`;
  return setStatusLine(dropBlockedBy(content), line);
}

// Archive: a landed/closed plan's body MUST end ✅ COMPLETED, with any stale
// Blocked-by (incl. a `LAND_BLOCKED` parking note) dropped. `via` names the path
// that archived it (e.g. 'done-worktree', 'move-plan') for the audit trail.
export function stampArchivedStatus(content, { date, via } = {}) {
  const suffix = via ? ` (${via})` : '';
  const line = `**Status:** ✅ COMPLETED — archived ${date}${suffix}.`;
  return setStatusLine(dropBlockedBy(content), line);
}

// plan 1329: a recurring "heartbeat" plan (frontmatter `heartbeat: <days>`) does NOT
// archive on land — done-worktree re-files it back to waiting-date/ +<days>. This stamp
// keeps the re-filed body honest: re-date the leading `YYYY-MM-DD` on the **Blocked-by:**
// and **Trip-date:** lines to the next trip date, and set a 📅 WAITING-DATE Status line
// recording the run just completed. Unlike stampArchived/stampPromoted it KEEPS the
// Blocked-by line (the trip marker is intrinsic to a heartbeat) — it only re-dates it.
// Idempotent for the same inputs: re-dating an already-nextDate line is a no-op and
// setStatusLine replaces the Status block in place, so a partial-run re-invoke (same
// run/next dates) leaves the body byte-identical.
const HEARTBEAT_DATE_RX = '\\d{4}-\\d{2}-\\d{2}';
// `g` so EVERY matching label line is re-dated — mirrors dropBlockedBy's global strip, which
// is global precisely because a body can stack two **Blocked-by:** lines; a non-global replace
// would leave a stale (expired) date on the second occurrence.
function bumpLeadingDate(content, label, nextDate) {
  const rx = new RegExp(`^(\\*\\*${label}:\\*\\*\\s*)${HEARTBEAT_DATE_RX}`, 'gm');
  return content.replace(rx, (_m, head) => `${head}${nextDate}`);
}
export function stampHeartbeatRun(content, { runDate, nextDate, sessionN, mergeSha } = {}) {
  let out = bumpLeadingDate(content, 'Blocked-by', nextDate);
  out = bumpLeadingDate(out, 'Trip-date', nextDate);
  const ran = [`session ${sessionN ?? '?'}`];
  if (mergeSha) ran.push(`landed \`${mergeSha}\``);
  const line = `**Status:** 📅 WAITING-DATE — parked until ${nextDate}. Last run: ${runDate} (${ran.join(', ')}).`;
  return setStatusLine(out, line);
}

// plan 629 Task 2: a drain/spine PARK into waiting-operator/ must leave the body
// Status honest — the 2026-06-15 audit found waiting-operator/ full of plans whose
// body still read the authoring-time `📋 READY` (the folder is the state machine; the
// body lied). Stamp a ⏸ WAITING-OPERATOR Status line matching the folder. The park
// inserts its own **Blocked-by:** line separately, so this does NOT drop it.
export function stampWaitingOperatorStatus(content, { date, reason } = {}) {
  const why = reason ? ` — ${reason}` : '';
  const line = `**Status:** ⏸ WAITING-OPERATOR — parked ${date}${why}`;
  return setStatusLine(content, line);
}

// Matches a `**RESUME-NEEDED:** …` marker line so a re-stamp replaces (never stacks)
// the prior one — one marker, newest seam wins. Global so a body that somehow carries
// two is fully cleared.
const RESUME_NEEDED_RX = /^\*\*RESUME-NEEDED:\*\*.*\r?\n?/gm;

// plan 629 Task 3: a LAND-STUCK seam keeps the plan in in-progress/ (the worktree
// branch is alive, mid-land) — Option A of the operator's 2026-06-15 destination
// taxonomy. Stamp a 🔄 IN PROGRESS "land blocked" Status PLUS a `**RESUME-NEEDED:**`
// marker naming the exact resume command, so the next reader knows this is
// land-completion (the branch is built + pushed), NOT an operator decision. Drops any
// stale Blocked-by (a land-stuck plan carries no operator blocker) and replaces any
// prior RESUME-NEEDED marker. Idempotent for the same inputs.
export function stampLandBlockedResume(content, { seam, date, resumeCmd } = {}) {
  const statusLine = `**Status:** 🔄 IN PROGRESS — land blocked (${seam}) ${date}; worktree held, resume to finish the land.`;
  const marker =
    `**RESUME-NEEDED:** ${seam} — run \`${resumeCmd}\` to finish the land. ` +
    `The branch is built + pushed; this is land-completion, not an operator decision.`;
  // Strip any prior RESUME-NEEDED marker + operator Blocked-by, THEN set the Status
  // line with the marker on the following line (setStatusLine replaces the whole Status
  // block, so embedding the marker keeps the two contiguous and idempotent on re-run).
  const base = dropBlockedBy(String(content).replace(RESUME_NEEDED_RX, ''));
  return setStatusLine(base, `${statusLine}\n${marker}`);
}

// True when the body carries a concrete revival trip-condition — either a heading
// mentioning it (`## Trip-condition`, `## Revival trip-condition`) or a labelled
// `Trip-condition:` line (incl. one embedded in a Status line). Hyphen/space and
// case tolerant.
export function hasTripCondition(content) {
  return (
    /^#{1,6}\s+.*trip[\s-]?condition/im.test(content) || /trip[\s-]?condition\s*:/i.test(content)
  );
}

// plan 2034: section-substance check shared by the two waiting-grill/ guards below.
// True when a heading matching `headingRx` is followed by at least one non-blank line
// before the section ends — presence + substance, never a machine-parse of the
// section's structure (R3: question/ruling format is runbook convention, not code).
//
// The section ends at a heading of the SAME OR SHALLOWER level, or at EOF (a DEEPER
// sub-heading is content, not a boundary — the 2034 review's finding). Boundary-finding
// itself is the shared build-index-lib scanner (plan 2052) — see its header comment for
// the fence-awareness rationale.
function sectionHasContent(content, headingRx) {
  const bounds = sectionBounds(content, headingRx);
  if (!bounds) return false;
  return String(content)
    .slice(bounds.start, bounds.end)
    .split(/\r?\n/)
    .some((l) => l.trim() !== '');
}

// The `## Grill questions` heading regex, factored out (plan 4069) so the section-presence
// check (hasGrillQuestions) and the raw-section extractor (grillQuestionsSection, used by
// move-plan.mjs's axis-tag/duplicate-park gates) can never drift onto two different headings.
const GRILL_QUESTIONS_HEADING_RX = /^#{1,6}\s+.*grill questions/i;

// True when the body carries a non-empty `## Grill questions` section — the
// waiting-grill/ ENTRY requirement (plan 2034 R3a, enforced by move-plan.mjs's
// assertGrillQuestionsOk). Heading-level and case tolerant, like hasTripCondition.
export function hasGrillQuestions(content) {
  return sectionHasContent(content, GRILL_QUESTIONS_HEADING_RX);
}

// The raw `## Grill questions` section text (heading's own line excluded — same slice
// sectionBounds/sectionHasContent already compute), or '' when the body carries none.
// plan 4069: move-plan.mjs's axis-tag scan (task 1) and duplicate-re-park refusal (task 2)
// both need the section's own text, not just a presence bit.
export function grillQuestionsSection(content) {
  const bounds = sectionBounds(content, GRILL_QUESTIONS_HEADING_RX);
  if (!bounds) return '';
  return String(content).slice(bounds.start, bounds.end);
}

// True when the body carries a non-empty `## Session decisions` section (plan 4069) — where a
// session records a tech-design or plan-scope fork it decided ITSELF rather than parking it (the
// operator ruling this plan implements: sessions decide, they don't ask, except on the fixed
// operator-only axis list — docs/coord/plan-lanes.md § Grill at spec time). Deliberately NOT a
// gate of any kind: nothing requires this section, nothing blocks on its absence — a plan with no
// session-decidable forks simply never has one. It is inert by construction wherever the heading
// text does not itself match another recognised section's regex (it matches neither
// GRILL_QUESTIONS_HEADING_RX above nor the `## Operator rulings` heading hasOperatorRulings uses
// below), so `assertGrillExitOk`'s ready/ exit guard — which only ever inspects those two other
// headings — never sees it at all.
export function hasSessionDecisions(content) {
  return sectionHasContent(content, /^#{1,6}\s+.*session decisions/i);
}

// True when the body carries a non-empty `## Operator rulings` section — the
// waiting-grill/ → ready/ EXIT requirement (plan 2034 R4b, enforced by move-plan.mjs's
// assertGrillExitOk). A one-line dissolution ruling (`dissolved: superseded by plan
// NNNN`) satisfies it naturally.
export function hasOperatorRulings(content) {
  return sectionHasContent(content, /^#{1,6}\s+.*operator rulings/i);
}

// Read the `unblock:` YAML frontmatter scalar (lowercased), or null. Delegates to
// the shared comment-stripping/unquoting reader (1304 delta review: the local
// loose fence scan disagreed with setUnblock's shared exact-fence write — a block
// with an interior `----` line read back as "no unblock", defeating the hold).
export function getUnblock(content) {
  const v = readFrontmatterScalar(content, 'unblock');
  return v ? v.toLowerCase() : null;
}

// Set / insert the `unblock:` frontmatter field. Replaces an existing one in place;
// appends to an existing frontmatter block; creates a frontmatter block at the top
// when the body has none. Idempotent for the same value. Delegates to the shared
// upsertFrontmatterKey (plan 1304) — merge edge cases live there, once.
export function setUnblock(content, value) {
  return upsertFrontmatterKey(content, 'unblock', value);
}
