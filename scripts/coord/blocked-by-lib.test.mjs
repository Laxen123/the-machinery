// scripts/blocked-by-lib.test.mjs — unit tests for the shared Blocked-by matcher.
// node:test, no fs/git. The corpus is injected as a plain id→folder map so the
// tests pin the parsing + classification decisions, not the filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  blockedByText,
  blockedByLines,
  tailOnlyBlockedByLines,
  referencedBlockerIds,
  hasNonPlanGate,
  classifyBlocked,
  isShippedArchiveContent,
  makeArchiveIsShipped,
  ARCHIVE_COMPLETED_RX,
  STRIKETHROUGH_RX,
  BLOCKED_BY_LINE_RE,
  rewriteFirstBlockedByLine,
} from './blocked-by-lib.mjs';
// plan 1836: queue-drain.mjs deliberately keeps its OWN copy of this regex rather
// than importing from blocked-by-lib.mjs (queue-drain.mjs is adopted byte-identical
// by the tandapp sibling, which does not adopt blocked-by-lib.mjs — see the comment
// on queue-drain.mjs's own ARCHIVE_COMPLETED_RX). This file (blocked-by-lib.test.mjs)
// is NOT adopted by any sibling, so it is the safe place to pin that the two literals
// never drift apart.
import {
  ARCHIVE_COMPLETED_RX as QUEUE_DRAIN_ARCHIVE_COMPLETED_RX,
  STRIKETHROUGH_RX as QUEUE_DRAIN_STRIKETHROUGH_RX,
  BLOCKED_BY_LINE_RE as QUEUE_DRAIN_BLOCKED_BY_LINE_RE,
  parsePlanMeta,
} from './queue-drain.mjs';

// id→folder corpus helper → statusOf
const corpus = (map) => (id) => map[id] ?? null;

// isShipped stub for tests exercising the pre-1836 "archive/ = cleared" shape —
// every archived id in this test's corpus is treated as shipped, isolating the
// test's intent (blocked vs. archived) from the separate shipped-vs-closed axis.
const shippedAll = () => true;

// The real plan-484 body that the broken auto-promoter missed (2026-06-13).
const PLAN_484 = `---
summary: "NO chain-template fast-path …"
---
# NO chain-template homepage/pricelistUrl fast-path

**Blocked-by:** plan 477's WS-4 chain lane (477 promoted to ready/ 2026-06-12) — revive when the chain-lane machinery lands
> **Blocked-by:** the 474 NO-import family (NO clinics with country:"NO" + chain locations) **and** the WS-4 chain lane (the apply machinery these URLs feed). Revive when BOTH have landed.

## What to build
…
`;

test('blockedByText captures both plain and `>`-quoted **Blocked-by:** lines, drops body prose', () => {
  const t = blockedByText(PLAN_484);
  assert.match(t, /plan 477's WS-4 chain lane/);
  assert.match(t, /the 474 NO-import family/);
  assert.ok(!/What to build/.test(t), 'must not leak non-Blocked-by prose');
});

test('blockedByText: the retired hyphenated `**Blocked-by-plan:**` token is NOT matched', () => {
  // a line using the old token must not leak its ids into the matcher (review fix)
  const body = '# x\n\n**Blocked-by-plan:** 477 must ship first\n';
  assert.equal(blockedByText(body), '');
  assert.deepEqual(
    referencedBlockerIds(body, () => true),
    [],
  );
});

test('hasNonPlanGate: "availability" in rationale prose is NOT a gate (review fix), but "operator" is', () => {
  assert.equal(
    hasNonPlanGate('**Blocked-by:** 477 (waiting on slot availability data to stabilise)'),
    false,
  );
  assert.equal(
    hasNonPlanGate('**Blocked-by:** operator availability for the manual capture'),
    true,
  );
});

test('referencedBlockerIds: bare ids ("477", "474") are grounded against the corpus', () => {
  const statusOf = corpus({ 474: 'archive', 477: 'archive' });
  assert.deepEqual(
    referencedBlockerIds(PLAN_484, (id) => statusOf(id) != null),
    ['474', '477'],
  );
});

test('referencedBlockerIds: a 4-digit plan id is extracted and grounded (plan 1002)', () => {
  const body = '**Blocked-by:** plan 1001 reply tail (1001-Other) — revive when it lands';
  const statusOf = corpus({ 1001: 'waiting-operator' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['1001'],
  );
});

test('referencedBlockerIds: a 3-digit and a 4-digit id sort numerically, not lexicographically (plan 2447)', () => {
  const body = '**Blocked-by:** plans 1055 and 641 must both land first';
  const statusOf = corpus({ 1055: 'ready', 641: 'archive' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['641', '1055'],
  );
});

test('referencedBlockerIds: prose-noise 3-digit tokens that are not real plans are dropped', () => {
  const body =
    '**Blocked-by:** operator green-light + cost approval (~$227 remaining = 648 clinics × $0.35)';
  // neither 227 nor 648 is a real plan → no phantom blockers
  assert.deepEqual(
    referencedBlockerIds(body, () => false),
    [],
  );
  // plan 2417 (design A): both numerals sit inside a parenthetical aside with no
  // `plan[s]?`/`#`/basename cue, so neither grounds even when isPlanId would allow it —
  // "~$227 remaining = 648 clinics" is cost-approval prose, not a blocker declaration.
  assert.deepEqual(
    referencedBlockerIds(body, (id) => id === '227' || id === '648'),
    [],
  );
});

test('referencedBlockerIds: a self-reference in the Blocked-by line is excluded', () => {
  const body =
    '**Blocked-by:** plans 432 + 436. 438 is the residual-cohort signal — run after 432 collapses dups. Revive when BOTH 432 and 436 have archived.';
  const statusOf = corpus({ 432: 'archive', 436: 'archive', 438: 'waiting-blocked' });
  // 438 (self) is not its own blocker
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null, '438'),
    ['432', '436'],
  );
});

test('referencedBlockerIds: a range "478-479" yields both ids; a year "2026" yields none', () => {
  const body = '**Blocked-by:** plans 478-479 must land first (spec dated 2026-06-09)';
  const statusOf = corpus({ 478: 'ready', 479: 'ready' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['478', '479'],
  );
});

// ── plan 2417: Blocked-by blocker-id extraction grounds prose numerals as plan ids ──
// Design A (ruled at spec-pass, refined against the live corpus at execution time): at
// a Blocked-by declaration's TOP LEVEL every numeral grounds — the corpus routinely
// names multiple real blockers without repeating "plan" for each one ("the covering
// refreshes: 1055 ... + 1541 ...", "1551/1552/1554 ready, 1917 waiting-blocked on
// 1551, ..."), so requiring an explicit per-id cue there was found (via the Work-0
// corpus audit) to silently DROP genuine open blockers — a dangerous premature-promote
// risk, worse than the phantom-blocker bug this plan fixes. INSIDE a parenthetical
// aside a numeral only grounds when explicitly cued by `plan[s]?`/`#`/a
// `NNNN-Category-slug` basename — that is where the corpus's genuine phantoms live (a
// clinic-id list, a "plan-2299 precedent" citation, a bare date). Design B
// (belt-and-braces): inline-code spans and ISO dates are stripped before scanning
// regardless of position, so a cue-adjacent code span or date can never ground.

test('referencedBlockerIds: the verbatim 2403 evidence line extracts exactly [2382], not the five raw digit tokens (plan 2417)', () => {
  // All five numbers below are grounded as REAL plan ids on purpose — proves the other
  // four are excluded because they are un-cued prose (a date, three backtick-quoted
  // source-line refs), not because isPlanId happens to reject them.
  const body =
    "**Blocked-by:** RESOLVED — plan 2382 archived 2026-07-25; `fetchSessionsCovering` (cursor paging, TRUNCATED result) verified landed on master (`wake-stalls.mjs:327`), both call sites verified still on plain `fetchSessions(ws)` (`cloud-session-hygiene.mjs:282`, `:590`). Specced by the same day's later spec-sweep, see the verdict below.";
  const statusOf = corpus({
    2382: 'archive',
    2026: 'archive',
    327: 'archive',
    282: 'archive',
    590: 'archive',
  });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['2382'],
  );
});

test('referencedBlockerIds: "plans 2201+2202+2203 (Wave A defect fixes) must land on master" extracts all three (plan 2141 multi-blocker shape)', () => {
  const body = '**Blocked-by:** plans 2201+2202+2203 (Wave A defect fixes) must land on master';
  const statusOf = corpus({ 2201: 'archive', 2202: 'in-progress', 2203: 'ready' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['2201', '2202', '2203'],
  );
});

test('classifyBlocked: a real cued blocker plus a backtick-quoted source-line citation → promotable (design B strips the code span before grounding)', () => {
  const body = '**Blocked-by:** plan 2199 landed; regression verified per `foo.mjs:327`.';
  // 327 is grounded as a REAL (unrelated) plan id too — proves it drops because of the
  // code-span strip, not because isPlanId happens to reject it.
  const statusOf = corpus({ 2199: 'archive', 327: 'archive' });
  const c = classifyBlocked(body, statusOf, '2417', shippedAll);
  assert.equal(c.kind, 'promotable');
  assert.deepEqual(c.ids, ['2199']);
});

test('referencedBlockerIds: a top-level multi-blocker declaration grounds every id, but a parenthetical clinic-id list and an uncued citation do not (real corpus shape, plan 2369)', () => {
  const body =
    '**Blocked-by:** 2364 lands (fix + audit report), then the covering refreshes: 1055 (SE clinics 291/427/459/552/787) + 1541 (NO clinics 1191/1203) — national-refresh supersession (plans-workflow §, plan-2299 precedent).';
  const statusOf = corpus({
    2364: 'in-progress',
    1055: 'waiting-blocked',
    1541: 'waiting-blocked',
    291: 'archive', // grounded as a REAL (unrelated) plan id too — proves the parenthetical
    2299: 'archive', // clinic list and the hyphenated "plan-2299" citation drop on their own
  });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['1055', '1541', '2364'],
  );
});

test('referencedBlockerIds: a `NNNN-Category-slug` basename cues an id even inside a parenthetical aside', () => {
  const body = '**Blocked-by:** plan 2199 (superseded by 1752-Infra-seam-guard.md — same defect)';
  const statusOf = corpus({ 2199: 'archive', 1752: 'archive' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    ['1752', '2199'],
  );
});

// ── plan 2174: strikethrough Blocked-by clearing — spec-sweeps/board-passes "clear" a
// stale blocker by striking it through (`~~2123~~ CLEARED …`) instead of erasing it.
// Struck text is semantically deleted, so it must not feed referencedBlockerIds.

test('blockedByText strips a `~~struck~~` span; blockedByLines preserves the raw line', () => {
  const body = '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep) — landed. Executable now.';
  assert.equal(blockedByText(body), 'CLEARED (spec-sweep) — landed. Executable now.');
  assert.deepEqual(blockedByLines(body), [
    '~~2123~~ CLEARED (spec-sweep) — landed. Executable now.',
  ]);
});

test('referencedBlockerIds: a struck bare id ("(i)") does not extract — only the CLEARED remainder is judged', () => {
  const body = '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep) — landed. Executable now.';
  const statusOf = corpus({ 2123: 'archive' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    [],
  );
});

test('classifyBlocked: a struck bare id classifies as none ("(i)")', () => {
  const body = '**Blocked-by:** ~~2123~~ CLEARED (spec-sweep) — landed. Executable now.';
  const statusOf = corpus({ 2123: 'archive' });
  const c = classifyBlocked(body, statusOf, '2142', shippedAll);
  assert.equal(c.kind, 'none');
});

test('referencedBlockerIds: a struck "plan NNNN" reference does not extract ("(ii)")', () => {
  const body = '**Blocked-by:** ~~plan 2123~~ CLEARED — superseded by the national refresh.';
  const statusOf = corpus({ 2123: 'archive' });
  assert.deepEqual(
    referencedBlockerIds(body, (id) => statusOf(id) != null),
    [],
  );
});

test('classifyBlocked: an UN-struck reference alongside a struck one still blocks ("(iii)")', () => {
  const body = '**Blocked-by:** ~~2123~~ now blocked by 2200';
  const statusOf = corpus({ 2123: 'archive', 2200: 'in-progress' });
  const c = classifyBlocked(body, statusOf, '2201', shippedAll);
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['2200']);
});

test('hasNonPlanGate: a struck gate keyword does not fire — only an UN-struck one does', () => {
  assert.equal(
    hasNonPlanGate('**Blocked-by:** ~~operator must approve~~ CLEARED — auto-promotable now.'),
    false,
  );
  assert.equal(hasNonPlanGate('**Blocked-by:** ~~2123~~ operator must re-approve scope'), true);
});

test('classifyBlocked: sonnet-review regression — a struck plan-id blocker with a live UN-struck gate surfaces as review, not none', () => {
  // Before stripping existed, ids would have included 2123 (archived+shipped), and
  // hasNonPlanGate would have run, correctly yielding 'review'. The strip-then-
  // classify fix must not silently drop that gate to 'none' just because the ONLY
  // named plan-id happened to be the one that got struck out.
  const body = '**Blocked-by:** ~~2123~~ operator must re-approve scope';
  const statusOf = corpus({ 2123: 'archive' });
  const c = classifyBlocked(body, statusOf, null, shippedAll);
  assert.equal(c.kind, 'review');
  assert.equal(c.gate, true);
});

test('classifyBlocked: a genuinely id-less line (pure trip/calendar gate) still classifies none — unaffected by the review fix', () => {
  const body = '**Blocked-by:** cron surfaces ≥1 changed clinic';
  const c = classifyBlocked(body, corpus({}), null, shippedAll);
  assert.equal(c.kind, 'none');
  assert.equal(c.gate, false);
});

test('hasNonPlanGate: bare ISO date is NOT a gate; operator/calendar/trip/cron ARE', () => {
  assert.equal(hasNonPlanGate(PLAN_484), false); // "(… 2026-06-12)" bare date only
  assert.equal(hasNonPlanGate('**Blocked-by:** operator green-light to promote'), true);
  assert.equal(hasNonPlanGate('**Blocked-by:** calendar: start on/after 2026-06-14'), true);
  assert.equal(hasNonPlanGate('**Blocked-by:** trip-condition — revive if reported'), true);
  assert.equal(hasNonPlanGate('**Blocked-by:** cron surfaces ≥1 changed clinic'), true);
  assert.equal(hasNonPlanGate('**Blocked-by:** Run 3 due >=2026-06-15'), true);
});

test('classifyBlocked: plan 484 with both blockers archived-and-shipped and no gate → promotable', () => {
  const statusOf = corpus({ 474: 'archive', 477: 'archive' });
  const c = classifyBlocked(PLAN_484, statusOf, '484', shippedAll);
  assert.equal(c.kind, 'promotable');
  assert.deepEqual(c.ids, ['474', '477']);
  assert.deepEqual(c.openIds, []);
});

test('classifyBlocked: one blocker still open → blocked', () => {
  const statusOf = corpus({ 474: 'in-progress', 477: 'archive' });
  const c = classifyBlocked(PLAN_484, statusOf, '484', shippedAll);
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['474']);
});

test('classifyBlocked: all blockers archived-and-shipped but a non-plan gate remains → review (do not auto-move)', () => {
  const body = '**Blocked-by:** plan 479 + operator green-light to promote to ready/';
  const c = classifyBlocked(body, corpus({ 479: 'archive' }), '510', shippedAll);
  assert.equal(c.kind, 'review');
  assert.equal(c.gate, true);
});

// ── plan 1836: shipped-vs-closed — archive/ presence alone does not prove the
// blocking work landed (a plan can be archived SUPERSEDED / abandoned without
// ever shipping). Mirrors the queue-drain.test.mjs cases plan 1819 added.

test('isShippedArchiveContent: only the exact ✅ COMPLETED stamp counts as shipped', () => {
  assert.equal(
    isShippedArchiveContent(
      '# archived upstream\n\n**Status:** ✅ COMPLETED — archived 2026-07-01 (done-worktree).\n',
    ),
    true,
  );
  assert.equal(
    isShippedArchiveContent(
      '# archived upstream\n\n**Status:** 🗄️ SUPERSEDED by plan 1900 — folded in, not executed standalone.\n',
    ),
    false,
  );
  assert.equal(isShippedArchiveContent('# archived upstream (no Status line at all)\n'), false);
});

test('ARCHIVE_COMPLETED_RX stays byte-identical to queue-drain.mjs’s independently-maintained copy', () => {
  assert.equal(ARCHIVE_COMPLETED_RX.source, QUEUE_DRAIN_ARCHIVE_COMPLETED_RX.source);
  assert.equal(ARCHIVE_COMPLETED_RX.flags, QUEUE_DRAIN_ARCHIVE_COMPLETED_RX.flags);
});

// plan 2174 (sonnet-review CONFIRMED reuse finding): queue-drain.mjs cannot import
// STRIKETHROUGH_RX from blocked-by-lib.mjs either (same sibling byte-share
// constraint as ARCHIVE_COMPLETED_RX above) — pin the two independently-maintained
// copies identical, same pattern as the test above.
test('STRIKETHROUGH_RX stays byte-identical to queue-drain.mjs’s independently-maintained copy', () => {
  assert.equal(STRIKETHROUGH_RX.source, QUEUE_DRAIN_STRIKETHROUGH_RX.source);
  assert.equal(STRIKETHROUGH_RX.flags, QUEUE_DRAIN_STRIKETHROUGH_RX.flags);
});

// plan 2180 (sonnet-review CONFIRMED finding during plan 2174's work): queue-drain.mjs's
// Blocked-by read used to be a non-global, first-match-only regex — a second
// **Blocked-by:** line naming a genuinely open blocker was silently invisible to that
// oracle, unlike this file's blockedByLines/blockedByText which join ALL such lines.
// queue-drain.mjs now adopts the SAME wider, global regex as this file's own
// BLOCKED_BY_LINE_RE (rather than merely widening its old narrower literal) so the two
// oracles read a multi-Blocked-by-line body identically. Byte-identity of the regex
// literal alone is dispositive proof the two oracles join the SAME lines (matchAll over
// the same string with byte-identical regexes cannot diverge) — a separate joined-text
// equality test over the PLAN_484 fixture would be a mathematical corollary of this one,
// not an independent guarantee (sonnet-review simplification finding), so it is not
// duplicated here.
test('BLOCKED_BY_LINE_RE stays byte-identical to queue-drain.mjs’s independently-maintained copy', () => {
  assert.equal(BLOCKED_BY_LINE_RE.source, QUEUE_DRAIN_BLOCKED_BY_LINE_RE.source);
  assert.equal(BLOCKED_BY_LINE_RE.flags, QUEUE_DRAIN_BLOCKED_BY_LINE_RE.flags);
});

test('classifyBlocked: isShipped defaults to `() => false` — an archived blocker with no isShipped wired stays blocked (fail-safe)', () => {
  const statusOf = corpus({ 474: 'archive', 477: 'archive' });
  const c = classifyBlocked(PLAN_484, statusOf, '484'); // isShipped omitted
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['474', '477']);
});

test('classifyBlocked: a blocker archived but NOT shipped (SUPERSEDED, isShipped → false) stays blocked, not promotable', () => {
  const body = '**Blocked-by:** plan 1760 (in flight)';
  const statusOf = corpus({ 1760: 'archive' });
  const isShipped = (id) => id !== '1760'; // 1760 archived-but-not-shipped; everything else would be
  const c = classifyBlocked(body, statusOf, '1790', isShipped);
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['1760']);
});

test('classifyBlocked: a multi-blocker line is promotable only when EVERY archived blocker is also shipped', () => {
  const body = '**Blocked-by:** plan 1055 and plan 1541';
  const statusOf = corpus({ 1055: 'archive', 1541: 'archive' });
  // 1055 shipped, 1541 archived-but-not-shipped (e.g. superseded)
  const partiallyShipped = (id) => id === '1055';
  const c = classifyBlocked(body, statusOf, '1790', partiallyShipped);
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['1541']);
});

test('makeArchiveIsShipped: lazily reads content via the provided readFile, memoized per id', () => {
  const relById = new Map([
    ['1760', 'docs/superpowers/plans/archive/1760-Other-upstream.md'],
    ['1761', 'docs/superpowers/plans/archive/1761-Other-superseded.md'],
  ]);
  const contents = {
    'docs/superpowers/plans/archive/1760-Other-upstream.md':
      '**Status:** ✅ COMPLETED — archived 2026-07-01.\n',
    'docs/superpowers/plans/archive/1761-Other-superseded.md':
      '**Status:** 🗄️ SUPERSEDED by plan 1900.\n',
  };
  let reads = 0;
  const readFile = (rel) => {
    reads += 1;
    return contents[rel];
  };
  const isShipped = makeArchiveIsShipped(relById, readFile);
  assert.equal(isShipped('1760'), true);
  assert.equal(isShipped('1761'), false);
  assert.equal(isShipped('1760'), true); // memoized — no re-read
  assert.equal(isShipped('9999'), false); // unknown id — no rel, conservative false
  assert.equal(reads, 2, 'each id with a known rel is read exactly once');
});

test('classifyBlocked: a pure trip/calendar gate with no plan id → none (not our concern)', () => {
  const body =
    '**Blocked-by:** first natural price-page change — monthly-render-refresh.ps1 cron surfaces ≥1 changed clinic';
  const c = classifyBlocked(body, corpus({}), '213');
  assert.equal(c.kind, 'none');
  assert.deepEqual(c.ids, []);
});

// ── plan 1065: cost is never a blocker ───────────────────────────────────────
// Spend is governed solely by the 💰 Cost-forecast banner + the drain's pause-on->$5,
// never by Blocked-by. So a gate keyword whose ONLY rationale is cost ("operator-gated
// on the ~$8-10 spend") must NOT hold a plan whose plan-blockers have all cleared.

test('hasNonPlanGate: an operator gate whose ONLY rationale is cost is NOT a gate (cost-only → stripped)', () => {
  assert.equal(
    hasNonPlanGate(
      '**Blocked-by:** plan 1061 must land first; then operator-gated on the ~$8-10 claude -p spend.',
    ),
    false,
  );
});

test('hasNonPlanGate: a non-cost operator decision survives cost-stripping → still a gate', () => {
  // a clause with a decision verb and NO cost language is untouched
  assert.equal(
    hasNonPlanGate('**Blocked-by:** plan 479; operator must approve the scope before this runs.'),
    true,
  );
  // a decision gate bundled with cost via a `+` conjunction keeps the decision half
  assert.equal(
    hasNonPlanGate('**Blocked-by:** operator green-light on scope + cost approval (~$8 spend)'),
    true,
  );
});

test('classifyBlocked: blockers archived + ONLY a cost gate → promotable (cost is not a blocker)', () => {
  const body =
    '**Blocked-by:** plan 1061 must land first; then operator-gated on the ~$8-10 claude -p spend.';
  const c = classifyBlocked(body, corpus({ 1061: 'archive' }), '1062', shippedAll);
  assert.equal(c.kind, 'promotable');
});

test('classifyBlocked: a genuine operator-DECISION gate still → review', () => {
  const body = '**Blocked-by:** plan 479; operator must approve the scope before this runs.';
  const c = classifyBlocked(body, corpus({ 479: 'archive' }), '510', shippedAll);
  assert.equal(c.kind, 'review');
});

// DANGER cases (code-review wmct563vc, finding #1): a genuine non-cost DECISION gate
// bundled with cost language in the SAME clause — joined by a comma, by "and", or with
// no delimiter at all — must NOT be stripped to promotable. A false promote here lets
// done-worktree auto-move a still-held plan into ready/ for the autonomous drain.
test('hasNonPlanGate: a decision gate joined to cost by "and" survives → still a gate', () => {
  assert.equal(
    hasNonPlanGate(
      '**Blocked-by:** operator must green-light the larger scope and approve the ~$8 spend',
    ),
    true,
  );
});

test('hasNonPlanGate: a decision gate comma-joined to cost survives → still a gate', () => {
  assert.equal(hasNonPlanGate('**Blocked-by:** operator green-light scope, ~$8-10 spend'), true);
});

test('hasNonPlanGate: a decision gate bundled with cost in ONE undelimited clause survives', () => {
  // the hardest case: no `.`/`;`/`,`/`+`/`and` between the decision object and the cost
  assert.equal(
    hasNonPlanGate('**Blocked-by:** operator must approve the scope before the $8 spend'),
    true,
  );
});

test('classifyBlocked: blockers archived but a scope-decision bundled with cost → review (NOT promotable)', () => {
  const body =
    '**Blocked-by:** plan 479; operator must green-light the new scope and approve the ~$8 spend.';
  const c = classifyBlocked(body, corpus({ 479: 'archive' }), '511', shippedAll);
  assert.equal(c.kind, 'review');
});

// --- plan 2378 step 7: the trailing delimiter is MANDATORY ---------------------------
// The prior `Blocked-by(?=[:*\s]|$)` lookahead accepted a bare line-initial token
// followed by a SPACE, so ordinary wrapped prose parsed as a declaration. The corpus
// scan at filing time found 4 such hits and ALL of them were meta-plans ABOUT this
// machinery (2378 itself + archived 161/2166/2180) — the false-positive class was
// systematically aimed at exactly the plans that touch it. 2378 excluded ITSELF from
// the fable drain that way (`exclude: malformed`).

test('2378: prose that wraps onto a line starting with a bare `Blocked-by ` is NOT a declaration', () => {
  // Verbatim shape from archived plan 2166 — the real false positive, not a synthetic one.
  const body = [
    '# 2166 bundle-component capture',
    '',
    'The header note is stale and the sentence below wraps such that the token leads a line:',
    'Blocked-by nothing is stale (superseded by the Blocked-by header — the 2147 vocabulary',
    'this plan ports is not on master).',
  ].join('\n');
  assert.deepEqual(blockedByLines(body), []);
});

test('2378: an indented prose line starting with the bare token is NOT a declaration', () => {
  // Verbatim shape from archived plan 2180.
  const body = '# 2180\n\n  Blocked-by text for the `PLAN_484` fixture — asserted by a test\n';
  assert.deepEqual(blockedByLines(body), []);
});

test('2378: the token followed by a backtick-quoted phrase is NOT a declaration', () => {
  // Verbatim shape from archived plan 161.
  const body = '# 161\n\nBlocked-by `plan-209 landing` (was originally `plan-009`)\n';
  assert.deepEqual(blockedByLines(body), []);
});

test('2378: a bare `Blocked-by` alone on a line is NOT a declaration', () => {
  assert.deepEqual(blockedByLines('# x\n\nBlocked-by\n'), []);
});

test('2378: the PARENTHETICAL-qualifier declaration form still parses (14 corpus plans use it)', () => {
  // This is why the tightening is "token + optional qualifier + delimiter" and not the
  // simpler "next char must be : or *" — that would have silently stopped parsing every
  // qualified declaration in the corpus.
  const cases = [
    [
      '**Blocked-by (CLEARED):** both originals were blocked on plan 1220',
      'both originals were blocked on plan 1220',
    ],
    [
      '**Blocked-by (unblock: decision):** operator must approve the scope',
      'operator must approve the scope',
    ],
    ['**Blocked-by (soft):** plan 544 should land first', 'plan 544 should land first'],
    ['**Blocked-by (must land before the clean re-extract):** plan 999', 'plan 999'],
    [
      '**Blocked-by (stale at close):** 1752-Infra-seam-guard.md — F0 is the same defect',
      '1752-Infra-seam-guard.md — F0 is the same defect',
    ],
  ];
  for (const [line, wantText] of cases) {
    assert.deepEqual(blockedByLines(`# x\n\n${line}\n`), [wantText], line);
  }
});

test('2378: the qualifier is EXCLUDED from the captured text, so its words cannot be misread as blocker content', () => {
  // Before the tightening the capture leaked the qualifier in as `(RESOLVED 2026-07-17):** …`,
  // putting a bare year in front of referencedBlockerIds' `\d{3,}` scan.
  assert.deepEqual(
    blockedByLines('# x\n\n**Blocked-by (RESOLVED 2026-07-17):** plan 1900 landed\n'),
    ['plan 1900 landed'],
  );
});

test('2378: every canonical declaration shape still parses', () => {
  const shapes = [
    '**Blocked-by:** plan 477',
    '> **Blocked-by:** plan 477',
    '**Blocked-by**: plan 477',
    '**Blocked-by** plan 477',
    'Blocked-by: plan 477',
  ];
  for (const s of shapes) assert.deepEqual(blockedByLines(`# x\n\n${s}\n`), ['plan 477'], s);
});

test('2378: the retired `**Blocked-by-plan:**` variant stays unmatched (anti-drift property preserved)', () => {
  assert.deepEqual(blockedByLines('# x\n\n**Blocked-by-plan:** 477\n'), []);
  assert.deepEqual(blockedByLines('# x\n\n**Blocked-by-date:** 2026-07-25\n'), []);
});

// --- plan 2378 review fix: the DROP must recognize what the MATCHER recognizes ---------
//
// move-plan's promote path calls plan-body-state's dropBlockedBy, and the plan-2378
// write-time gate then re-reads the same body with BLOCKED_BY_LINE_RE. If the drop is
// narrower than the matcher, a promotion leaves a line the gate then refuses — turning a
// routine `move-plan <id> ready` into a BoardInvariantError. plan-body-state.mjs cannot
// IMPORT this module (it is tandapp-adopted byte-identical, blocked-by-lib is not), so it
// carries a ported copy; this pins the two together.

test('2378: plan-body-state`s BLOCKED_RX is BLOCKED_BY_LINE_RE + `\\n?`, byte-identical', async () => {
  const src = readFileSync(new URL('./plan-body-state.mjs', import.meta.url), 'utf8');
  const m = src.match(/const BLOCKED_RX =\s*(\/.*\/[gimsuy]*);/);
  assert.ok(m, 'BLOCKED_RX literal not found in plan-body-state.mjs');
  const literal = m[1];
  const body = literal.slice(1, literal.lastIndexOf('/'));
  const flags = literal.slice(literal.lastIndexOf('/') + 1);
  assert.equal(
    body,
    `${BLOCKED_BY_LINE_RE.source}\\n?`,
    'the ported drop regex drifted from the shared matcher',
  );
  assert.equal([...flags].sort().join(''), 'gim');
});

test('2378: dropBlockedBy removes every sanctioned declaration form the matcher accepts', async () => {
  const { dropBlockedBy } = await import('./plan-body-state.mjs');
  const forms = [
    '**Blocked-by:** plan 477',
    '> **Blocked-by:** plan 477 must land first',
    'Blocked-by: plan 477',
    '**Blocked-by (soft):** plan 477 should land first',
    '**Blocked-by (unblock: decision):** operator approves scope',
    '**Blocked-by** plan 477',
  ];
  for (const line of forms) {
    const body = `# x\n\n> 🟩 **SEED-WRITE: NO**\n\n${line}\n\n## Task\n\nbody\n`;
    const out = dropBlockedBy(body);
    assert.deepEqual(blockedByLines(out), [], `dropBlockedBy left a line for: ${line}`);
    assert.match(out, /## Task/, 'the rest of the body survives');
    assert.match(out, /SEED-WRITE/, 'the banner survives');
  }
});

test('2378: dropBlockedBy does NOT eat a prose line that merely starts with the token', async () => {
  const { dropBlockedBy } = await import('./plan-body-state.mjs');
  const body = '# x\n\nBlocked-by nothing is stale (superseded by the header)\nnext line\n';
  assert.equal(dropBlockedBy(body), body);
});

test('2378: dropBlockedBy still strips MULTIPLE stacked declaration lines', async () => {
  const { dropBlockedBy } = await import('./plan-body-state.mjs');
  const out = dropBlockedBy('# x\n\n**Blocked-by:** plan 1\n> **Blocked-by:** plan 2\n\n## Task\n');
  assert.deepEqual(blockedByLines(out), []);
});

// ── plan 2446: blocked-by-lib.mjs strips frontmatter AND close-out tails at its OWN
// seam, so done-worktree.mjs's promoteWaitingBlocked and lint-stale-blocked.mjs (both
// of which pass RAW file content, unlike queue-drain.mjs which already pre-strips)
// inherit correct scoping without a per-caller strip call. ──────────────────────────

test('2446: a frontmatter `summary:` block scalar quoting "Blocked-by:" is never read as the plan\'s own declaration, in every exported entry point', () => {
  const content = [
    '---',
    'summary: |',
    '  quoting an earlier draft that said:',
    '  Blocked-by: plan 999 landing',
    '  …no longer true.',
    '---',
    '',
    '# A plan',
    '',
    'No real blockers here.',
  ].join('\n');
  assert.deepEqual(blockedByLines(content), []);
  assert.equal(blockedByText(content), '');
  assert.deepEqual(
    referencedBlockerIds(content, () => true),
    [],
  );
  assert.equal(hasNonPlanGate(content), false);
  const c = classifyBlocked(content, () => 'ready', '2446');
  assert.equal(c.kind, 'none');
});

test('2446: a REAL body `**Blocked-by:**` line still gates even when the plan ALSO carries frontmatter (every consumer, raw content in)', () => {
  const content = [
    '---',
    'summary: "ordinary summary, no Blocked-by lookalike"',
    '---',
    '',
    '# A plan',
    '',
    '**Blocked-by:** plan 2199 must land first',
  ].join('\n');
  assert.deepEqual(blockedByLines(content), ['plan 2199 must land first']);
  const statusOf = (id) => (id === '2199' ? 'in-progress' : null);
  const c = classifyBlocked(content, statusOf, '2446');
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['2199']);
});

// ── the tail axis: a `**Blocked-by:**` line inside a `closeoutTailSpans` close-out
// tail does NOT gate the drainable body (same split-don't-sink reading plan 2368
// applied to the operator gates) — but is surfaced via tailOnlyBlockedByLines so a
// consumer can print a loud note instead of silently trusting the tail author.
// Fixture mirrors 2403's real close-out-tail section shape (archived plan 2403).

const TAIL_SHAPED = (bodyBlockedBy, tailBlockedBy) =>
  [
    '# A plan',
    '',
    '## Scope',
    '',
    bodyBlockedBy,
    '',
    "## Close-out follow-up (operator-local tail — split-don't-sink)",
    '',
    tailBlockedBy,
    '',
    'The unit-test acceptance above is the cloud-drainable body.',
    '',
    '## Verification',
    '',
    'node --test scripts/…',
  ].join('\n');

test('2446: a Blocked-by line INSIDE a close-out tail does not gate the drainable body, but is surfaced by tailOnlyBlockedByLines', () => {
  const content = TAIL_SHAPED('No real blockers in the body.', '**Blocked-by:** plan 3000');
  assert.deepEqual(blockedByLines(content), [], 'tail-only line excluded from the scoped scan');
  const c = classifyBlocked(content, () => 'in-progress', '2446');
  assert.equal(c.kind, 'none', 'the tail Blocked-by must not gate the body');
  assert.deepEqual(tailOnlyBlockedByLines(content), ['plan 3000']);
});

test('2446: a real BODY Blocked-by still gates even when the tail ALSO carries its own (unrelated) Blocked-by', () => {
  const content = TAIL_SHAPED(
    '**Blocked-by:** plan 2199 must land first',
    '**Blocked-by:** plan 3000 (operator-local follow-up dependency, not the body’s)',
  );
  const statusOf = (id) => (id === '2199' ? 'in-progress' : id === '3000' ? 'ready' : null);
  const c = classifyBlocked(content, statusOf, '2446');
  assert.equal(c.kind, 'blocked');
  assert.deepEqual(c.openIds, ['2199'], 'only the body blocker counts — 3000 never enters ids');
  assert.deepEqual(tailOnlyBlockedByLines(content), [
    'plan 3000 (operator-local follow-up dependency, not the body’s)',
  ]);
});

test('2446: tailOnlyBlockedByLines is empty when there is no close-out tail at all, or the tail carries no Blocked-by line', () => {
  assert.deepEqual(tailOnlyBlockedByLines('# x\n\n**Blocked-by:** plan 477\n'), []);
  const noBlockerInTail = TAIL_SHAPED('**Blocked-by:** plan 477', 'purely descriptive prose.');
  assert.deepEqual(tailOnlyBlockedByLines(noBlockerInTail), []);
});

test('2446: a duplicated Blocked-by line text both inside and outside a tail is diffed as a multiset, not double-counted', () => {
  // Same declaration text appears twice — once in the body, once (verbatim) in the
  // tail. The body copy must survive scoping; only the tail copy is "tail-only".
  const line = '**Blocked-by:** plan 477';
  const content = TAIL_SHAPED(line, line);
  assert.deepEqual(blockedByLines(content), ['plan 477'], 'the body copy is retained');
  assert.deepEqual(tailOnlyBlockedByLines(content), ['plan 477'], 'the tail copy is reported once');
});

// Cross-module parity: blocked-by-lib.mjs's tail-scoped `blockedByText` and
// queue-drain.mjs's own (independently-maintained, ported-regex) `extractBlockedByLine`
// — reached here via the exported `parsePlanMeta` — must agree on the SAME content.
// Both apply the SAME `closeoutTailSpans`/tail-scoping wrapper: this file imports
// queue-drain.mjs's own `tailScopedBody`/`tailOnlyBlockedByLines` directly (plan
// 2543 — before this, each file kept an independently-maintained copy of the
// multiset-diff algorithm, pinned identical only by this test; now there is one
// algorithm, so a divergence here would mean the import itself broke, not that a
// second copy drifted). Only the ported `BLOCKED_BY_LINE_RE` literal remains
// independently maintained (the one-directional tandapp-adopt constraint still
// applies to it), already pinned byte-identical above. This is the plan-1836-style
// cross-module identity check for the tail axis, the same spirit as the
// BLOCKED_BY_LINE_RE/ARCHIVE_COMPLETED_RX/STRIKETHROUGH_RX byte-identity tests
// already in this file.
test('2446: blocked-by-lib.mjs and queue-drain.mjs agree on tail-scoped Blocked-by extraction for the same content', () => {
  const content = TAIL_SHAPED(
    '**Blocked-by:** plan 2199 must land first',
    '**Blocked-by:** plan 3000 (tail-only, must not count)',
  );
  const meta = parsePlanMeta('2446-Coord-thing.md', content, {});
  assert.equal(meta.blockedBy, 'plan 2199 must land first');
  assert.equal(blockedByText(content), 'plan 2199 must land first');
  assert.match(meta.tailBlockedBySkipped, /3000/);
  assert.deepEqual(tailOnlyBlockedByLines(content), ['plan 3000 (tail-only, must not count)']);
});

// ── plan 2543: classifyBlocked now computes its tail-scoped Blocked-by lines ONCE
// and threads them through the id-extraction, gate-detection, and struck-token
// checks instead of each independently re-deriving them from `content`. These
// tests pin that the threaded result stays byte-identical to what independently
// calling the still-public referencedBlockerIds/hasNonPlanGate on the SAME content
// would give — the exact property a caching/threading bug (passing a stale or
// wrongly-scoped value into one of the three internal call sites) would break.
test('2543: classifyBlocked.gate matches hasNonPlanGate(content) whenever a plan-id blocker (struck or open) is in play — the two intentionally diverge only on the pure id-less "none" path (gate forced false, see the early-return comment)', () => {
  const cases = [
    // ids present -> the openIds/gate branch always runs the real gate value.
    [
      '**Blocked-by:** 477 (waiting on slot availability data to stabilise)',
      corpus({ 477: 'ready' }),
    ],
    [PLAN_484, corpus({ 477: 'archive', 474: 'archive' })],
    // struck plan-id + live gate -> the review path, also the real gate value.
    ['**Blocked-by:** ~~2123~~ operator must re-approve scope', corpus({ 2123: 'archive' })],
    // struck plan-id, gate struck away too -> 'none', but gate is genuinely false
    // (not merely forced) since hasNonPlanGate agrees.
    ['**Blocked-by:** ~~operator must approve~~ CLEARED — auto-promotable now.', corpus({})],
  ];
  for (const [content, statusOf] of cases) {
    const c = classifyBlocked(content, statusOf, null, shippedAll);
    assert.equal(c.gate, hasNonPlanGate(content), `gate mismatch for: ${content}`);
  }
  // Pure id-less gate lines (no plan-id ever named) — classifyBlocked's early return
  // intentionally reports gate:false ("not our concern") even though hasNonPlanGate
  // on the same content is true; asserting the DIVERGENCE here (not equality) is the
  // point — a threading bug that accidentally started propagating the real gate
  // value onto this path would silently change 'none' plans into 'review'.
  for (const content of [
    '**Blocked-by:** operator availability for the manual capture',
    '**Blocked-by:** cron surfaces ≥1 changed clinic',
  ]) {
    const c = classifyBlocked(content, corpus({}), null, shippedAll);
    assert.equal(c.kind, 'none');
    assert.equal(c.gate, false);
    assert.equal(
      hasNonPlanGate(content),
      true,
      `expected this fixture to be a real gate: ${content}`,
    );
  }
});

// A test asserting classifyBlocked.ids === referencedBlockerIds(...) was cut here
// (sonnet-review CONFIRMED finding, plan 2543): both now delegate to the same
// idsFromLines(), so the two agreeing is a mathematical corollary of that sharing,
// not an independent guarantee — precisely the "not duplicated here" convention this
// file already documents at the STRIKETHROUGH_RX/referencedBlockerIds precedent
// above (plan 2180). Likewise cut: a standalone struck-token "review" regression
// using the exact fixture already covered by the pre-existing test above ("sonnet-
// review regression — a struck plan-id blocker with a live UN-struck gate surfaces
// as review, not none") AND by a case in the loop-based gate test above it — a third
// copy of the same fact added no coverage.

// review fix F3 (6 findings): rewriteFirstBlockedByLine must be FRONTMATTER-SCOPED —
// every other reader in this file (blockedByLines -> tailScopedBody -> stripFrontmatter)
// scopes to the drainable body first, but the mutating helper ran BLOCKED_BY_LINE_RE over
// the RAW content, so on a body whose YAML `summary:` block scalar quotes a
// `**Blocked-by:**`-shaped line, the "first match" lands INSIDE frontmatter — corrupting
// the YAML — instead of on the real body declaration.
test('rewriteFirstBlockedByLine is frontmatter-scoped: a Blocked-by-shaped line inside a YAML summary: block scalar is never the "first match" — the frontmatter survives byte-identical and the BODY line is rewritten', () => {
  const withFrontmatterShadow =
    '---\n' +
    'summary: |\n' +
    '  Some long description of this plan.\n' +
    '  **Blocked-by:** plan 999 for context, not a real declaration.\n' +
    'stage: stub\n' +
    '---\n' +
    '\n' +
    '# Some plan\n' +
    '\n' +
    '**Blocked-by:** plan 500\n' +
    '\n' +
    'body text\n';

  const out = rewriteFirstBlockedByLine(
    withFrontmatterShadow,
    (oldLine) => `~~${oldLine}~~ CLEARED`,
  );

  // The frontmatter block (everything up to and including the closing `---`) must be
  // byte-identical — the decoy line inside the summary: scalar is untouched.
  const fenceEnd = withFrontmatterShadow.indexOf('\n---\n', 4) + '\n---\n'.length;
  const originalFrontmatter = withFrontmatterShadow.slice(0, fenceEnd);
  const outFrontmatter = out.slice(0, fenceEnd);
  assert.equal(
    outFrontmatter,
    originalFrontmatter,
    'the frontmatter block (including the decoy Blocked-by-shaped summary: line) must survive untouched',
  );
  assert.match(
    out,
    /summary: \|\n {2}Some long description of this plan\.\n {2}\*\*Blocked-by:\*\* plan 999 for context, not a real declaration\.\n/,
    'the decoy line inside the YAML summary: scalar is NOT struck through',
  );
  // The REAL body declaration is the one rewritten.
  assert.match(
    out,
    /~~\*\*Blocked-by:\*\* plan 500~~ CLEARED/,
    'the real body Blocked-by line (plan 500) is the one rewritten',
  );
  assert.ok(
    !/~~.*plan 999.*~~/.test(out),
    'the frontmatter decoy (plan 999) is never struck through',
  );
});
