// scripts/coord/blocked-by-lib.mjs — parse a plan's **Blocked-by:** declaration(s) into
// the set of plan-ids it depends on, and classify whether those dependencies have
// all cleared. ONE matcher shared by two consumers so they can never drift:
//   - done-worktree's promoteWaitingBlocked (auto-mv a now-unblocked plan to ready/)
//   - lint-stale-blocked.mjs (advisory: surface plans whose blockers all archived)
//
// WHY THIS EXISTS (plan 569): the prior promoteWaitingBlocked matched the blocker's
// FULL FILENAME after a `Blocked-by-plan:` / `Blocked by:` token. No real plan writes
// either — the canonical token is `**Blocked-by:**` and blockers are named by bare id
// (`plan 477`, `474`). So the auto-promoter never fired: plan 484 sat in
// waiting-blocked/ ~2h after its last blocker (477) landed (2026-06-13) until a human
// spotted it. This matcher keys on the real convention instead.
//
// SCOPING (plan 2446): every exported entry point below takes RAW plan content
// (frontmatter present or absent — a caller need never pre-strip) and scopes the
// scan itself, at this ONE seam, to the drainable body:
//   1. frontmatter is stripped first (plan 2360/2368's frontmatter-shadow class — a
//      YAML `summary:` block scalar quoting "Blocked-by: …" must never read as this
//      plan's own declaration). Was already true for queue-drain.mjs's OWN twin
//      extractor (plan 2368); this file's `done-worktree.mjs`/`lint-stale-blocked.mjs`
//      callers still passed RAW content until now — the two "one source of truth"
//      call paths disagreed, which is worse than both being wrong.
//   2. the body is then scoped to `closeoutTailSpans` — a `**Blocked-by:**` line
//      inside a `split-don't-sink` close-out tail (queue-drain.mjs's own convention,
//      plan 2368) declares a dependency of the DEFERRED operator-local follow-up, not
//      of the drainable body, so it must not gate the whole plan (same reading 2368
//      applied to the operator gates). The unsafe direction (a mis-scoped real
//      blocker silently drains) is answered with VISIBILITY, not silence:
//      `tailOnlyBlockedByLines` below surfaces exactly what a tail-scoped scan
//      dropped, so every consumer can print a loud per-plan note instead of quietly
//      trusting the tail author never misfiled.
//
// `stripFrontmatter` (build-index-lib.mjs), `closeoutTailSpans`, `tailScopedBody`,
// and `tailOnlyBlockedByLines` (all queue-drain.mjs) are IMPORTED here, not ported —
// safe because both of those modules are on the tandapp coordShare adopt list
// (byte-identical siblings), and an adopted module importing THIS one (not on that
// list) would be the dangerous direction (ERR_MODULE_NOT_FOUND the moment tandapp
// syncs); this file importing FROM an adopted module is not — nothing tandapp runs
// ever resolves an import statement that lives only in this un-adopted file.
// `queue-drain.mjs` still cannot import FROM this file (unchanged constraint — see
// its own `BLOCKED_BY_LINE_RE` / `ARCHIVE_COMPLETED_RX` / `STRIKETHROUGH_RX`
// comments), so its own twin extractor keeps its ported `BLOCKED_BY_LINE_RE` copy;
// that literal is pinned identical to this file's own copy by cross-module test,
// the same pattern used for the two other ported literals below. The tail-scoping
// WRAPPER and the tail-only multiset-diff algorithm, by contrast, are NOT ported
// copies (plan 2543 — they used to be, independently, which is exactly the class of
// duplication the ported-literal convention is meant to bound, not extend): this
// file imports queue-drain.mjs's own `tailScopedBody`/`tailOnlyBlockedByLines`
// directly, so there is only ONE tail-scoping algorithm in the repo, not two kept in
// lockstep by a test alone.
import { stripFrontmatter, splitFrontmatter } from './build-index-lib.mjs';
import {
  tailScopedBody as tailScopedBodyShared,
  tailOnlyBlockedByLines as tailOnlyBlockedByLinesShared,
} from './queue-drain.mjs';

// A Blocked-by declaration line: optional `>` quote prefix, optional `**` bold, the
// canonical `Blocked-by` token (hyphenated), an OPTIONAL parenthetical qualifier, a
// MANDATORY `:` / `**` delimiter, then the text.
//
// The delimiter is mandatory (plan 2378 step 7). The prior form ended the token with a
// `(?=[:*\s]|$)` lookahead, which accepted a bare line-initial `Blocked-by` followed by
// a SPACE — so ordinary wrapped prose that happened to break the line right before the
// token parsed as a declaration. Corpus scan at filing time: 4 hits, ALL of them
// meta-plans ABOUT this machinery (2378 itself, plus archived 161 / 2166 / 2180) — i.e.
// the false-positive class was systematically aimed at exactly the plans that touch it.
// 2378 excluded ITSELF from the fable drain that way (`exclude: malformed`, "unparseable
// Blocked-by line: line IN PLACE by a later …"); backticking the token (`e66a9a7a29`)
// was a workaround, this is the gate. Requiring the delimiter rejects all four while
// still refusing the retired `**Blocked-by-plan:**` variant (next char `-` satisfies
// neither delimiter alternative), so the anti-`-date:`/`-operator:`-drift property the
// old lookahead provided is preserved.
//
// The parenthetical qualifier is NOT decoration — it is a corpus-attested declaration
// shape (`**Blocked-by (CLEARED):**`, `**Blocked-by (unblock: decision):**`,
// `**Blocked-by (soft):**`, `**Blocked-by (must land before the clean re-extract):**` —
// 14 archived plans at filing time). It must keep matching, which is precisely why the
// tightening is "token + optional qualifier + delimiter" and NOT the simpler "the char
// after the token must be `:` or `*`" (that shape would have silently stopped parsing
// every qualified declaration). Bounded `[^)\n]*` so a qualifier can never span lines.
// Side benefit: the qualifier is now EXCLUDED from the captured text (it used to leak
// in as `(CLEARED):** …`), so a qualifier's own words can no longer be misread as
// blocker content by referencedBlockerIds / hasNonPlanGate.
//
// Exported (plan 2180) solely so a test can assert this stays byte-identical to
// queue-drain.mjs's own independently-maintained copy of the same literal (the
// tandapp-sibling-adopt constraint documented on queue-drain.mjs's `ARCHIVE_COMPLETED_RX`
// prevents that file importing this one) — same precedent as ARCHIVE_COMPLETED_RX/
// STRIKETHROUGH_RX below. Both literals must be edited in lockstep.
export const BLOCKED_BY_LINE_RE =
  /^[ \t]*>?[ \t]*\*{0,2}Blocked-by(?:[ \t]*\([^)\n]*\))?(?:\*{1,2}:?|:\*{0,2})[ \t:]*(.*)$/gim;

// Non-plan revival gates. A Blocked-by line naming one of these is NOT safe to
// auto-promote even when its named plan-blockers have all archived — the operator /
// calendar / external trip still has to fire. By folder convention such plans live in
// waiting-{operator,date,trip}/, but this catches a mis-filed waiting-blocked/ plan.
// Deliberately narrow: a bare ISO date (e.g. "(477 promoted to ready/ 2026-06-12)")
// is NOT a gate — only a date with a calendar verb (`due`, `on/after`, `>=20xx`) is.
// NB: deliberately omits common English words that recur in blocker RATIONALE prose
// (e.g. "availability") — those would false-downgrade a cleanly-promotable plan to
// 'review'. The operator-availability case is already caught by the `operator` keyword.
const GATE_RE =
  /\b(operator|calendar|green-?light|approval|user[- ]reports?|cron|quarterly|annual(?:ly)?|seasonal|re-?arm)\b|\btrip(?:-condition)?\b|\b(?:on\/after|due|start on\/after|re-?run on\/after)\b|(?:>=|≥)\s*20\d{2}/i;

// Cost is NEVER a revival gate (plan 1065). Spend is governed solely by the
// 💰 Cost-forecast banner + the drain's pause-on->$5, never by Blocked-by. So a gate
// keyword that exists ONLY because of cost ("operator-gated on the ~$8-10 claude -p
// spend") must not hold a plan whose plan-blockers have all cleared — but a GENUINE
// non-cost decision ("operator must approve the new scope") must still gate, even when
// it sits next to cost language.
//
// We decide per CLAUSE (split on `.` `;` `,` `+` `&` `and` `plus`). For a clause that
// carries a gate keyword:
//   - no cost language in the clause            → a real gate (return true).
//   - cost language present → reduce the clause to its SUBSTANTIVE non-cost residue:
//     strip cost tokens + the cost-binding vocabulary (the gate keyword itself, the
//     spend-approval verbs, prepositions/stopwords) + punctuation; if a word of ≥3
//     letters survives, it is a non-cost decision object ("scope") → a real gate.
//     Only an EMPTY residue ("operator-gated on the spend" → nothing left) is cost-only.
// This biases to 'review' (the safe direction — a missed promote is benign; the lint
// surfaces it and a human moves it) and has no nested-quantifier backtracking (the prior
// COST_CLAUSE_RE was O(n²) — code-review wmct563vc).
const CLAUSE_SPLIT_RE = /[.;,+&]|\band\b|\bplus\b/i;
// Cost vocabulary — nouns/symbols denoting spend. Also used (non-global) to test a clause.
const COST_TOKEN_RE =
  /\$\s?\d|[~≈≃]\s*\$|\b(?:costs?|spend(?:ing|s)?|budget(?:ed|s)?|kr|sek|usd|eur|llm|claude\s*-?p|compute|tokens?|api|quota|credits?)\b/i;
// Words that merely BIND a gate keyword to a cost rationale — the gate keyword, the
// spend-approval verbs, and prepositions/stopwords. Removing these + the cost tokens
// leaves a clause's substantive non-cost content; an empty residue ⇒ cost-only.
const COST_BINDING_RE =
  /\b(?:operator|green-?light|greenlights?|approvals?|approve[ds]?|fund(?:s|ed|ing)?|gated?|gating|pays?|payment|authoriz\w*|sign-?offs?|the|an?|for|of|to|on|before|after|then|first|must|be|is|are|am|run|running|approx\w*|about|larger|extra|additional|once|when|pending|need(?:s|ed)?|require[ds]?|until)\b/i;
const COST_TOKEN_RE_G = new RegExp(COST_TOKEN_RE.source, 'gi');
const COST_BINDING_RE_G = new RegExp(COST_BINDING_RE.source, 'gi');

// `~~struck text~~` spans are semantically DELETED prose — a spec-sweep / board-pass
// "clears" a stale blocker by striking it through rather than erasing it (plan 2174:
// "~~2123~~ CLEARED (spec-sweep) — … Executable now."). Stripped here, at the single
// shared entry point, so every consumer (referencedBlockerIds, hasNonPlanGate) sees
// only live text: a struck plan id can never re-extract as a blocker, and a struck
// gate keyword ("~~operator must approve~~ CLEARED …") can never re-fire as a gate.
// Any UN-struck reference in the remainder still extracts/gates normally.
export const STRIKETHROUGH_RX = /~~[^~]*~~/g;

// The raw per-line scan, with NO frontmatter/tail scoping — the shared primitive
// both `blockedByLines` (scoped) and `tailOnlyBlockedByLines` (the tail-only
// complement, for the loud note) are built from, so the two can never disagree
// about what counts as a matched declaration line.
function rawBlockedByLines(text) {
  const out = [];
  for (const m of String(text || '').matchAll(BLOCKED_BY_LINE_RE)) out.push(m[1].trim());
  return out;
}

// `tailScopedBodyShared` (queue-drain.mjs's `tailScopedBody`) operates on a body (no
// frontmatter) and returns the RETAINED spans (every run of lines outside a
// close-out tail), joined back into one string — safe for BLOCKED_BY_LINE_RE
// specifically (unlike the operator-gate regexes queue-drain.mjs's own comment
// warns about): it is single-line-anchored (`^…$` per line, no cross-newline
// window), so a dropped-tail seam can never fabricate or tear apart a match the
// way a bounded cross-newline window could. This wrapper only adds the
// frontmatter-strip step (queue-drain.mjs's own callers already pass a pre-stripped
// body — see its `parsePlanMeta`) before delegating.
function tailScopedBody(content) {
  return tailScopedBodyShared(stripFrontmatter(String(content || '')));
}

/** Raw **Blocked-by:** declaration line texts (one per matched line) found in the
 * DRAINABLE body — frontmatter stripped, close-out-tail sections scoped out (plan
 * 2446) — BEFORE strikethrough stripping. The write-time lint (lint-stale-blocked.mjs)
 * needs the raw text to detect the `~~…~~` idiom itself, which blockedByText below
 * deletes. Takes RAW plan content; frontmatter/tail scoping happens at this ONE seam
 * so every consumer inherits it without a per-caller strip call. */
export function blockedByLines(content) {
  return rawBlockedByLines(tailScopedBody(content));
}

/** Blocked-by declaration line(s) present in the RAW content but dropped by
 * `blockedByLines`' tail scoping — i.e. a `**Blocked-by:**` line that sits inside a
 * `closeoutTailSpans` close-out tail, declaring a dependency of the deferred
 * operator-local follow-up rather than of the drainable body (plan 2446). Never
 * counted toward classification (see `blockedByLines`/`classifyBlocked`), but the
 * unsafe direction — an author mistakenly parking the plan's REAL blocker in a tail
 * — is answered with visibility: every consumer (done-worktree's promoteWaitingBlocked,
 * lint-stale-blocked.mjs, queue-drain.mjs's own twin) should print a loud note keyed
 * off this whenever it is non-empty, rather than silently trusting the tail.
 * A multiset diff (not a plain array subtract) so a line duplicated verbatim both
 * inside and outside a tail is still counted correctly on each side.
 *
 * Delegates the actual diff to queue-drain.mjs's own `tailOnlyBlockedByLines` (plan
 * 2543) instead of keeping an independent copy of the same ~15-25 line algorithm —
 * only the frontmatter strip (this file's own responsibility; queue-drain.mjs's
 * callers already pass a pre-stripped body) happens here. */
export function tailOnlyBlockedByLines(content) {
  const body = stripFrontmatter(String(content || ''));
  return tailOnlyBlockedByLinesShared(body);
}

/**
 * Replace the FIRST **Blocked-by:** declaration line's raw text (RAW content,
 * frontmatter left intact) with whatever `buildReplacement(oldLine)` returns, where
 * `oldLine` is that line's exact original text (no trailing newline — `$` in
 * BLOCKED_BY_LINE_RE's multiline mode never consumes it). The one MUTATING
 * capability this file adds beside its read-side extractors (blockedByLines /
 * classifyBlocked / tailOnlyBlockedByLines), for a caller that must rewrite a
 * plan's Blocked-by line in place rather than merely classify it — done-worktree's
 * promoteWaitingBlocked (plan 3975): an unblocked plan's stale Blocked-by line is
 * either struck through in place (routed to pending-approval/, awaiting a spec-pass)
 * or rewritten to name the ready/-gate that now holds it (routed to
 * waiting-operator/), rather than left to sleep in waiting-blocked/.
 *
 * Mirrors the REPLACE branch of move-plan.mjs's own rewriteBlockedByHeader
 * (`BLOCKED_RX.test(content) ? content.replace(BLOCKED_RX, line) : …`) without
 * importing move-plan.mjs into the close-out spine (plan 3975 execution notes: the
 * spine must not pull in the whole move-plan.mjs command module for one helper).
 * No anchor-insertion branch is needed here — unlike rewriteBlockedByHeader, which
 * must also handle a body with NO existing Blocked-by line, every candidate this is
 * called for already carries at least one matched line: classifyBlocked only
 * classes a plan 'review'/'promotable' after extracting its ids FROM a Blocked-by
 * line in the first place.
 *
 * Only the FIRST matched line is rewritten (a body carrying a second Blocked-by
 * line is a pre-existing authoring oddity this promoter did not create and does not
 * attempt to also fix); content is returned byte-identical when no Blocked-by line
 * is present at all.
 *
 * FRONTMATTER-SCOPED (review fix F3, plan 3975 round 1): every other reader in this
 * file scopes to the drainable body first (blockedByLines -> tailScopedBody ->
 * stripFrontmatter), but this mutating helper used to run BLOCKED_BY_LINE_RE over the
 * RAW content — so on a body whose YAML `summary:` block scalar happens to quote a
 * `**Blocked-by:**`-shaped line (an indented line under `summary: |`/`summary: >`
 * matches the line-anchored regex regardless of indentation, same frontmatter-shadow
 * class plan 2360/2368 named for the read-side matchers), the "first match" could land
 * INSIDE frontmatter instead of on the real body declaration — silently corrupting the
 * YAML instead of rewriting the plan's actual Blocked-by line. The frontmatter block is
 * split off via the shared `splitFrontmatter` (same seam `stripFrontmatter` above uses)
 * and reattached byte-identical; only the body half is scanned/rewritten.
 * @param {string} content raw plan content
 * @param {(oldLine:string)=>string} buildReplacement given the full matched old
 *   line (no trailing newline), returns its replacement (also no trailing newline)
 * @returns {string}
 */
export function rewriteFirstBlockedByLine(content, buildReplacement) {
  const { prefix, body } = splitFrontmatter(String(content || ''));
  let done = false;
  const newBody = body.replace(BLOCKED_BY_LINE_RE, (m) => {
    if (done) return m;
    done = true;
    return buildReplacement(m);
  });
  return prefix + newBody;
}

// The join+strip step shared by blockedByText (below) and classifyBlocked (plan
// 2543 — classifyBlocked already has its Blocked-by lines in hand by the time it
// needs the text form, so it calls this directly instead of going back through
// blockedByText/blockedByLines and re-deriving the same lines from content).
function textFromLines(lines) {
  return lines.join(' ').replace(STRIKETHROUGH_RX, ' ').trim();
}

/** All **Blocked-by:** declaration lines (text after the token, tail-scoped per
 * `blockedByLines`), joined by ' ', with `~~struck~~` spans stripped. Takes raw
 * plan content. */
export function blockedByText(content) {
  return textFromLines(blockedByLines(content));
}

/** True iff a `~~struck~~` span in the raw Blocked-by line(s) contains a plan-id-
 * shaped token (\d{3,}) — i.e. a blocker WAS named there, just correctly cleared,
 * as opposed to a line that never named a plan id at all (a pure trip/calendar
 * gate). classifyBlocked below uses this to tell "the only blocker was struck but
 * a live non-plan gate remains" (should still surface, plan 2174 review fix) apart
 * from "this line is not our concern" (a genuinely id-less gate/trip line).
 * Operates on already-extracted lines (plan 2543) — see classifyBlocked. */
function struckPlanIdInLines(lines) {
  for (const line of lines) {
    for (const m of line.matchAll(STRIKETHROUGH_RX)) {
      if (/\d{3,}/.test(m[0])) return true;
    }
  }
  return false;
}

// Inline code spans (`...`) and ISO dates are pure evidence/reference syntax, never a
// plan-blocker declaration — stripped before grounding numerals (design B, plan 2417):
// a source line ref like `wake-stalls.mjs:327` or a bare `2026-07-25` must not ground
// as a blocker just because the number inside happens to also be a real plan id.
const CODE_SPAN_RX = /`[^`\n]*`/g;
const ISO_DATE_RX = /\b\d{4}-\d{2}-\d{2}\b/g;

// `\b` on both sides (plan 2417 fix during the corpus audit): without it a plain
// `\d{3,}` also matches the digits inside "1000px"/"q80"-style tokens, since digits
// and letters are both \w — a real false positive the OLD `\b(\d{3,})\b` avoided.
// Shared by both the top-level and parenthetical passes below (sonnet-review
// simplification finding) so a future widening/narrowing can't drift between them.
const ID_TOKEN_RX = /\b\d{3,}\b/g;

// `plan`/`plans` or `#` immediately preceding an id, or a `NNNN-Category-slug`
// basename shape — the only cues that ground a numeral sitting INSIDE a parenthetical
// aside (design A, plan 2417). A parenthetical is where the corpus's genuine phantoms
// live — a record-id list ("(SE records 291/427/459/552/787)"), a citation
// ("(plan-2299 precedent)"), a bare date ("(CMA Dec 2026)") — so a bare uncued numeral
// there does not ground even though one at the declaration's TOP LEVEL does (below).
const CUE_BEFORE_RX = /(?:\bplans?\b|#)\s*$/i;
const BASENAME_AFTER_RX = /^-[A-Za-z]/;
// A separator continuing a cued list within ONE parenthetical ("plans 2201 and 2202
// land first", "plans 2201, 2202, 2203") — sonnet-review CONFIRMED finding: the plural
// `plans?` cue was written to anticipate a list, but nothing chained past the first id.
const LIST_CONTINUE_RX = /^\s*(?:[-,+]|and)\s*$/i;

function isCuedAt(text, index, len) {
  return (
    CUE_BEFORE_RX.test(text.slice(0, index)) || BASENAME_AFTER_RX.test(text.slice(index + len))
  );
}

// Repeatedly blank out balanced `(...)` spans, innermost-out, so nesting resolves.
function stripParens(s) {
  let prev;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/\([^()]*\)/g, ' ');
  } while (cur !== prev);
  return cur;
}

// EVERY parenthetical span's own text, at EVERY nesting depth, plus whether the text
// immediately BEFORE its own `(` (in the enclosing context) is itself a `plan[s]?`/`#`
// cue — sonnet-review CONFIRMED finding: a naive single-pass `/\(([^()]*)\)/g` only
// ever matches the innermost, non-nested groups, so an OUTER paren wrapping a nested
// one (`(plan 5551 (see plan-5552-slug)))`) never surfaces at all, AND a cue that sits
// just outside a nested paren ("plan (2199)") is invisible to a check scoped to the
// paren's own interior text alone. Collect the innermost matches (recording each one's
// enclosing-cue flag from its position in the CURRENT pass's text), blank them out
// (same-length, so an enclosing paren's own parens survive intact), and repeat until no
// `(...)` remains; each pass exposes the next level out.
function allParenSpans(s) {
  const spans = [];
  let cur = s;
  for (;;) {
    const found = [...cur.matchAll(/\(([^()]*)\)/g)];
    if (found.length === 0) return spans;
    for (const m of found) {
      spans.push({ text: m[1], cuedByEnclosing: CUE_BEFORE_RX.test(cur.slice(0, m.index)) });
    }
    cur = cur.replace(/\(([^()]*)\)/g, (m) => ' '.repeat(m.length));
  }
}

// Cued ids within ONE parenthetical span: an id cued by `plan[s]?`/`#`/a basename
// within the span's own text, OR (only for the span's first id) by a `plan[s]?`/`#`
// cue sitting just outside the paren itself (`cuedByEnclosing`) — plus any id chained
// to either via `,`/`+`/`-`/`and` (design A's list form, scoped to this one aside).
function cuedIdsInSpan({ text: spanText, cuedByEnclosing }) {
  const ids = [];
  const nums = [...spanText.matchAll(ID_TOKEN_RX)];
  let chainOpen = false;
  for (let i = 0; i < nums.length; i++) {
    const m = nums[i];
    if (isCuedAt(spanText, m.index, m[0].length) || (i === 0 && cuedByEnclosing)) {
      ids.push(m[0]);
      chainOpen = true;
      continue;
    }
    if (
      chainOpen &&
      LIST_CONTINUE_RX.test(spanText.slice(nums[i - 1].index + nums[i - 1][0].length, m.index))
    ) {
      ids.push(m[0]);
      continue;
    }
    chainOpen = false;
  }
  return ids;
}

/**
 * Design A (plan 2417, ruled at spec-pass): count a numeral on ONE Blocked-by
 * declaration line only when it is INTRODUCED as a plan reference. At the
 * declaration's TOP LEVEL (outside any parenthetical aside) every numeral counts — the
 * whole point of a Blocked-by line is to name its blocker(s), and the corpus routinely
 * does so without repeating "plan" for every id ("the covering refreshes: 1055 ... +
 * 1541 ...", "1551/1552/1554 ready, 1917 waiting-blocked on 1551, ..."). INSIDE a
 * parenthetical aside — at ANY nesting depth — a numeral only counts when explicitly
 * cued by `plan[s]?`/`#`/a `NNNN-Category-slug` basename, or chained to such a cue via
 * a list separator — that is where the corpus's genuine phantoms live (a record-id
 * list, a source-line citation, a bare date), and stripping code spans + ISO dates
 * first (design B) removes the rest (the 2403 false-positive class this plan fixes).
 * Operates on one already-strikethrough-stripped line at a time.
 * @param {string} rawLine one entry from blockedByLines (pre-strikethrough-strip)
 * @returns {string[]} ids in the order found (dupes allowed; caller dedupes)
 */
function lineBlockerIds(rawLine) {
  const text = rawLine
    .replace(STRIKETHROUGH_RX, ' ')
    .replace(CODE_SPAN_RX, ' ')
    .replace(ISO_DATE_RX, ' ');
  const ids = [...stripParens(text).matchAll(ID_TOKEN_RX)].map((m) => m[0]);
  for (const span of allParenSpans(text)) ids.push(...cuedIdsInSpan(span));
  return ids;
}

/**
 * Plan ids (3+-digit strings) referenced as blockers, bounded to the Blocked-by
 * line(s), grammar-gated (design A above) and GROUNDED: a candidate counts only if
 * `isPlanId(id)` is true, so prose noise that still happens to sit in a cued position
 * never resolves to a phantom blocker. The plan's own id (`selfId`) is excluded — a
 * plan that names itself in third person inside its Blocked-by line ("438 is the
 * residual-cohort signal") is not its own blocker.
 * @param {string} content raw plan content (frontmatter optional — stripped, and
 *   close-out-tail sections scoped out, by `blockedByLines` at plan 2446's seam)
 * @param {(id:string)=>boolean} isPlanId
 * @param {string|null} [selfId]
 * @returns {string[]} sorted unique ids
 */
// Shared by referencedBlockerIds (below) and classifyBlocked (plan 2543), which
// already has its Blocked-by lines in hand and passes them here directly instead
// of routing back through blockedByLines(content) a second time.
function idsFromLines(lines, isPlanId, selfId) {
  const ids = new Set();
  for (const rawLine of lines) {
    for (const id of lineBlockerIds(rawLine)) {
      if (id !== selfId && isPlanId(id)) ids.add(id);
    }
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}
export function referencedBlockerIds(content, isPlanId, selfId = null) {
  return idsFromLines(blockedByLines(content), isPlanId, selfId);
}

/**
 * True if any Blocked-by line carries a non-plan revival gate that is NOT purely
 * cost-motivated. A gate keyword that survives stripping every cost clause is a
 * genuine operator/calendar/trip hold; one that does not was cost-only — and cost is
 * never a blocker (plan 1065), so it does not gate. Takes raw plan content.
 */
// The gate-detection logic, factored out so classifyBlocked (plan 2543) can run it
// against a `textFromLines` result it builds from its own already-extracted lines,
// instead of hasNonPlanGate re-deriving the lines from content via blockedByText.
function gateFromText(text) {
  if (!GATE_RE.test(text)) return false; // no gate keyword anywhere → not a gate
  for (const clause of text.split(CLAUSE_SPLIT_RE)) {
    if (!GATE_RE.test(clause)) continue; // this clause carries no gate keyword
    if (!COST_TOKEN_RE.test(clause)) return true; // gate keyword, no cost → a real gate
    // gate keyword + cost in one clause: real iff a non-cost decision object survives.
    const residue = clause
      .replace(COST_TOKEN_RE_G, ' ')
      .replace(COST_BINDING_RE_G, ' ')
      .replace(/[^a-zA-Z\s]/g, ' ');
    if (residue.split(/\s+/).some((w) => w.length >= 3)) return true;
    // else: empty residue ⇒ the gate keyword was purely cost-motivated; keep scanning.
  }
  return false;
}
export function hasNonPlanGate(content) {
  return gateFromText(blockedByText(content));
}

// A **Status:** line carrying the ✅ COMPLETED stamp done-worktree's normal
// archive close-out writes — ported verbatim (plan 1836) from queue-drain.mjs's
// ARCHIVE_COMPLETED_RX so the two never drift. `archive/` holds plans that are
// "shipped OR closed" (docs/coord/plan-lanes.md § The lane set) —
// mere archive/ presence does NOT prove the blocking WORK landed: a plan can be
// archived 🗄️ SUPERSEDED / abandoned without ever shipping. Only this exact
// stamp counts as "shipped"; anything else (SUPERSEDED, a stray non-terminal
// row, or no Status line at all) is conservatively "closed, not shipped".
export const ARCHIVE_COMPLETED_RX = /^\*\*Status:\*\*\s*✅\s*COMPLETED\b/im;

/** True iff an archived plan's raw body content carries the shipped stamp. */
export function isShippedArchiveContent(content) {
  return ARCHIVE_COMPLETED_RX.test(String(content || ''));
}

/**
 * Build a lazy, memoized isShipped(id) predicate for classifyBlocked from a
 * plan-id→relative-path map and a content reader — an archived file's content
 * is read AT MOST ONCE, and only for ids actually looked up (classifyBlocked
 * only calls isShipped for ids whose statusOf(id) === 'archive'). Shared by
 * done-worktree.mjs's promoteWaitingBlocked and lint-stale-blocked.mjs so
 * neither hand-rolls its own read+cache for the same shipped-content check.
 * @param {Map<string,string>} relById  plan id -> tracked relative path
 * @param {(rel:string)=>string} readFile  reads a rel path to its raw content
 * @returns {(id:string)=>boolean}
 */
export function makeArchiveIsShipped(relById, readFile) {
  const cache = new Map();
  return function isShipped(id) {
    if (cache.has(id)) return cache.get(id);
    let shipped = false;
    const rel = relById.get(id);
    if (rel) {
      try {
        shipped = isShippedArchiveContent(readFile(rel));
      } catch {
        shipped = false; // race with a concurrent archive move, or unreadable — stay conservative
      }
    }
    cache.set(id, shipped);
    return shipped;
  };
}

/**
 * Classify a waiting-blocked plan against the current plan corpus.
 * @param {string} content raw plan content (frontmatter optional, close-out-tail
 *   Blocked-by lines scoped out — see `blockedByLines`, plan 2446's seam)
 * @param {(id:string)=>(string|null)} statusOf  folder of plan `id` ('archive',
 *   'ready', 'in-progress', 'waiting-*'), or null/'' if no such plan exists.
 * @param {string|null} [selfId]  this plan's own id (excluded from its blockers)
 * @param {(id:string)=>boolean} [isShipped]  for an id whose statusOf(id) is
 *   'archive', true iff that archived plan actually SHIPPED the blocking work
 *   (carries the `**Status:** ✅ COMPLETED` stamp) rather than being archived
 *   closed/superseded/abandoned without shipping (plan 1836). Archive presence
 *   alone does NOT prove the work landed. Defaults to `() => false` — the
 *   STRICT fail-safe: a caller that omits this predicate never silently
 *   regains the pre-1836 loose "any archive/ = cleared" behaviour; it must
 *   explicitly wire shipped-detection to get any archived blocker to clear.
 * @returns {{kind:'none'|'blocked'|'promotable'|'review', ids:string[], openIds:string[], gate:boolean}}
 *   none       — no plan-id blockers (e.g. a pure trip/calendar gate); not our concern
 *   blocked    — ≥1 named blocker still open (not archived, or archived-not-shipped)
 *   promotable — every named blocker archived-and-shipped AND no non-plan gate → safe to auto-mv
 *   review     — every named blocker archived-and-shipped BUT a non-plan gate remains → surface, don't move
 */
export function classifyBlocked(content, statusOf, selfId = null, isShipped = () => false) {
  // plan 2543: the tail-scoped Blocked-by lines are computed ONCE here (blockedByLines
  // -> tailScopedBody -> closeoutTailSpans) and threaded through idsFromLines/
  // gateFromText/struckPlanIdInLines below, instead of each of referencedBlockerIds/
  // hasNonPlanGate/hasStruckPlanIdToken independently re-deriving them from `content`
  // (previously 2-3x per call depending on branch).
  const lines = blockedByLines(content);
  const ids = idsFromLines(lines, (id) => statusOf(id) != null, selfId);
  if (ids.length === 0) {
    // plan 2174 review fix: a struck plan-id blocker strips out of `ids` just like a
    // genuinely id-less line, but the two are NOT the same — a struck-but-cleared
    // blocker sitting next to a live, un-struck non-plan gate ("~~2123~~ operator must
    // re-approve scope") must still surface as 'review', not silently vanish to 'none'
    // (before stripping existed, ids would have included 2123, hasNonPlanGate would
    // have run, and this would already have been 'review'). Only a line that NEVER
    // named a plan id at all — the genuine "pure trip/calendar gate, not our concern"
    // case this early return exists for — stays 'none'.
    const gate = gateFromText(textFromLines(lines));
    if (gate && struckPlanIdInLines(lines)) return { kind: 'review', ids, openIds: [], gate };
    return { kind: 'none', ids, openIds: [], gate: false };
  }
  const openIds = ids.filter((id) => !(statusOf(id) === 'archive' && isShipped(id)));
  const gate = gateFromText(textFromLines(lines));
  if (openIds.length > 0) return { kind: 'blocked', ids, openIds, gate };
  return { kind: gate ? 'review' : 'promotable', ids, openIds: [], gate };
}
