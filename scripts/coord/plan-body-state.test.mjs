// scripts/plan-body-state.test.mjs  (plan 619)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setStatusLine,
  dropBlockedBy,
  stampPromotedStatus,
  statusTokenForStage,
  readStatusToken,
  readStatusState,
  setStatusToken,
  stampArchivedStatus,
  stampWaitingOperatorStatus,
  stampLandBlockedResume,
  stampHeartbeatRun,
  hasTripCondition,
  hasGrillQuestions,
  hasOperatorRulings,
  hasSessionDecisions,
  grillQuestionsSection,
  getUnblock,
  setUnblock,
  VALID_UNBLOCK,
} from './plan-body-state.mjs';

const BANNER = '> 🟩 **SEED-WRITE: NO** — touches scripts only';
const COST = '> 💰 **Cost forecast:** $0';

// ── dropBlockedBy ────────────────────────────────────────────────────────────
test('dropBlockedBy removes a Blocked-by line; idempotent when absent', () => {
  const c = [BANNER, '', '**Blocked-by:** plan 246 landing', '', '# Title', 'body'].join('\n');
  const out = dropBlockedBy(c);
  assert.ok(!out.includes('**Blocked-by:**'));
  assert.ok(out.includes('# Title'));
  // no Blocked-by present → unchanged
  const clean = [BANNER, '', '# Title'].join('\n');
  assert.equal(dropBlockedBy(clean), clean);
});

test('dropBlockedBy strips EVERY Blocked-by line, not just the first (no stale blocker)', () => {
  const c = ['**Blocked-by:** plan 600', '**Blocked-by:** plan 601', '', '# T'].join('\n');
  const out = dropBlockedBy(c);
  assert.ok(!out.includes('**Blocked-by:**'), 'no Blocked-by line may survive');
});

// ── setStatusLine ──────────────────────────────────────────────────────────
test('setStatusLine replaces an existing Status line in place', () => {
  const c = [BANNER, '', '**Status:** 📋 READY — opened 2026-06-01.', '', '# Title'].join('\n');
  const out = setStatusLine(c, '**Status:** ✅ DONE.');
  assert.match(out, /\*\*Status:\*\* ✅ DONE\./);
  assert.ok(!out.includes('📋 READY'));
  assert.equal((out.match(/\*\*Status:\*\*/g) || []).length, 1);
});

test('setStatusLine replaces the WHOLE status block (Previous status / Override lines too)', () => {
  const c = [
    BANNER,
    '',
    '**Status:** 🔄 IN PROGRESS — picked up 2026-06-10 by `H` in `worktree-x`.',
    '**Previous status:** 📋 READY — opened 2026-06-01.',
    '**Override:** operator pickup satisfied the gate.',
    '',
    '# Title',
  ].join('\n');
  const out = setStatusLine(c, '**Status:** 📋 READY — re-filed.');
  assert.ok(!out.includes('**Previous status:**'), 'stale Previous status must be gone');
  assert.ok(!out.includes('**Override:**'), 'stale Override must be gone');
  assert.equal((out.match(/\*\*Status:\*\*/g) || []).length, 1);
});

test('setStatusLine inserts after the cost banner when no Status line exists', () => {
  const c = [BANNER, '', COST, '', '# Title', 'body'].join('\n');
  const out = setStatusLine(c, '**Status:** 📋 READY.');
  assert.match(out, /Cost forecast:.*\$0\n\n\*\*Status:\*\* 📋 READY\./s);
  assert.ok(out.indexOf('**Status:**') < out.indexOf('# Title'));
});

test("setStatusLine anchors on a non-bold cost banner too (plan 2360 review — matches queue-drain.mjs's tolerance)", () => {
  const nonBoldCost = '💰 Cost forecast: ~1 short session. No LLM spend.';
  const c = [BANNER, '', nonBoldCost, '', '# Title', 'body'].join('\n');
  const out = setStatusLine(c, '**Status:** 📋 READY.');
  assert.match(out, /No LLM spend\.\n\n\*\*Status:\*\* 📋 READY\./s);
  assert.ok(out.indexOf('**Status:**') < out.indexOf('# Title'));
});

test('setStatusLine does NOT anchor on a frontmatter summary that quotes a 💰 banner verbatim — no corruption of the YAML block (plan 2360 review round 5)', () => {
  const c = [
    '---',
    "summary: 'see the banner shape > 💰 **Cost forecast:** $0 quoted here'",
    'stage: specced',
    '---',
    '',
    BANNER,
    '',
    COST,
    '',
    '# Title',
    'body',
  ].join('\n');
  const out = setStatusLine(c, '**Status:** 📋 READY.');
  // frontmatter block is untouched — the Status line must not land inside it
  assert.match(out, /^---\nsummary:.*\nstage: specced\n---\n/);
  // it lands after the REAL body banner instead
  assert.match(out, /Cost forecast:.*\$0\n\n\*\*Status:\*\* 📋 READY\./s);
});

test('setStatusLine falls back to the H1 anchor, then a prepend', () => {
  const onlyH1 = ['# Title', 'body'].join('\n');
  assert.match(setStatusLine(onlyH1, '**Status:** X'), /# Title\n\n\*\*Status:\*\* X/);
  const none = 'just body, no anchors';
  assert.match(setStatusLine(none, '**Status:** X'), /^\*\*Status:\*\* X\n\njust body/);
});

test('setStatusLine inserts AFTER frontmatter (never splitting it) when there is no banner/H1', () => {
  const c = '---\nunblock: cost\n---\n\nplain text, no banner or H1';
  const out = setStatusLine(c, '**Status:** ✅ X');
  // frontmatter still leads the file and is intact (getUnblock can still read it)
  assert.match(out, /^---\nunblock: cost\n---\n/, 'frontmatter must remain at the top, intact');
  assert.equal(getUnblock(out), 'cost', 'getUnblock must still see the field');
  // and the Status line landed after the closing fence, before the body
  assert.ok(out.indexOf('**Status:** ✅ X') > out.indexOf('---\n\n'));
});

// --- plan 2392: round-6 findings on the round-5 fix's remaining gaps -----------

test('setStatusLine: the EXISTING-Status fast-replace path is frontmatter-guarded too (plan 2392 finding 1) — a malformed frontmatter block with a stray **Status:**-shaped line at column 0 is left untouched', () => {
  const c = [
    '---',
    '**Status:** stray legacy line hand-edited into frontmatter',
    'stage: specced',
    '---',
    '',
    '# Title',
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
    '',
    'body',
  ].join('\n');
  const out = setStatusLine(c, '**Status:** ✅ DONE.');
  // the stray frontmatter line survives byte-for-byte — never flipped, never duplicated into
  assert.match(
    out,
    /^---\n\*\*Status:\*\* stray legacy line hand-edited into frontmatter\nstage: specced\n---\n/,
  );
  // the REAL body Status line is the one that was replaced
  assert.ok(!out.includes('📋 READY'));
  assert.equal((out.match(/\*\*Status:\*\* ✅ DONE\./g) || []).length, 1);
});

test('setStatusLine: a duplicate H1-shaped literal text embedded mid-sentence earlier in the body does not hijack the anchor splice (plan 2392 finding 3)', () => {
  const c = [
    'Renamed from # Original Title in an earlier draft.',
    '',
    '# Original Title',
    '',
    'body text',
  ].join('\n');
  const out = setStatusLine(c, '**Status:** ✅ X');
  // the earlier prose sentence is untouched — a literal-text .replace() would have
  // spliced into the MIDDLE of this sentence instead, since "# Original Title" also
  // occurs there as a raw substring (just not at true line-start, so H1_RX itself
  // never matches it).
  assert.ok(out.includes('Renamed from # Original Title in an earlier draft.'));
  // the REAL, line-anchored H1 is the one that got the Status line appended after it
  assert.match(out, /\n# Original Title\n\n\*\*Status:\*\* ✅ X/);
});

// ── statusTokenForStage (plan 2587: the ONE stage→token mapping) ─────────────
test('statusTokenForStage: stage stub → STUB, specced → READY, absent → caller default', () => {
  const withStage = (v) => `---\nsummary: 'x'\nstage: ${v}\n---\n\n# T\n`;
  assert.equal(statusTokenForStage(withStage('stub')), '📋 STUB');
  assert.equal(statusTokenForStage(withStage('specced')), '📋 READY');
  // no stage stamp + no caller default → the historical READY (Check A cannot fire on a
  // body with no literal stage stamp, so the promotion path deliberately keeps it).
  assert.equal(statusTokenForStage("---\nsummary: 'x'\n---\n\n# T\n"), '📋 READY');
  // the mint passes its own default because ensureStageFrontmatter is about to stamp it.
  assert.equal(
    statusTokenForStage("---\nsummary: 'x'\n---\n\n# T\n", { defaultStage: 'stub' }),
    '📋 STUB',
  );
  // an author-supplied stage always beats the caller default.
  assert.equal(statusTokenForStage(withStage('specced'), { defaultStage: 'stub' }), '📋 READY');
});

// ── readStatusToken / hasStatusLine / setStatusToken (plan 2587 re-review) ───
// The whole point of these living in ONE place is that board-write-gate's Check A and
// next-plan-id's mint-time reconcile pick the SAME line on the same body. The decoy case
// below is what a raw, non-frontmatter-stripped match got wrong: the heal would rewrite
// the quoted line while the gate judged the real one (or vice versa).
test('readStatusToken/readStatusState ignore a Status-shaped line quoted inside frontmatter (plan 2587)', () => {
  const decoy = [
    '---',
    "summary: 'the mint writes **Status:** 📋 READY — opened <date>. into fresh bodies'",
    'stage: stub',
    '---',
    '',
    '# T',
    '',
    '**Status:** 📋 STUB — opened 2026-07-27.',
    '',
    'body',
  ].join('\n');
  assert.equal(readStatusToken(decoy), 'STUB'); // the REAL line, not the frontmatter decoy
  assert.equal(readStatusState(decoy).hasLine, true);
});

test('readStatusToken: null when there is no Status line at all', () => {
  assert.equal(readStatusToken("---\nsummary: 'x'\n---\n\n# T\n\nbody\n"), null);
  assert.equal(readStatusState("---\nsummary: 'x'\n---\n\n# T\n\nbody\n").hasLine, false);
  // a Status line with NO state word: hasLine true, token null — the mint must not treat
  // that as "no Status line" and insert a second one.
  const wordless = "---\nsummary: 'x'\n---\n\n# T\n\n**Status:** 📋 —\n";
  assert.deepEqual(readStatusState(wordless), { hasLine: true, token: null });
});

test('readStatusToken reads the state word across the live token vocabulary', () => {
  const withLine = (l) => `---\nsummary: 'x'\n---\n\n# T\n\n${l}\n`;
  assert.equal(readStatusToken(withLine('**Status:** 📋 READY — x.')), 'READY');
  assert.equal(readStatusToken(withLine('**Status:** 🔄 IN PROGRESS — x.')), 'IN');
  assert.equal(readStatusToken(withLine('**Status:** 📅 WAITING-DATE — x.')), 'WAITING-DATE');
  assert.equal(readStatusToken(withLine('**Status:** ✅ COMPLETED — x.')), 'COMPLETED');
  assert.equal(readStatusToken(withLine('**Status:** 🌱 stub — x.')), 'STUB'); // case-folded
});

test('setStatusToken swaps only the token, preserving the remainder and the rest of the body', () => {
  const before = [
    '---',
    "summary: 'x'",
    '---',
    '',
    '# T',
    '',
    '**Status:** 📋 READY — opened 2026-07-27. <!-- spec-pass pending -->',
    '',
    'tail prose mentioning **Status:** 📋 READY as an example',
  ].join('\n');
  const after = setStatusToken(before, '📋 STUB');
  assert.match(after, /\*\*Status:\*\* 📋 STUB — opened 2026-07-27\. <!-- spec-pass pending -->/);
  // the LATER decoy occurrence must survive untouched — the splice is index-based, so a
  // second copy of the same text elsewhere can never be mis-targeted (plan 2392 finding 3).
  assert.match(after, /tail prose mentioning \*\*Status:\*\* 📋 READY as an example/);
  // a body with no Status line is returned unchanged rather than gaining one
  const bare = "---\nsummary: 'x'\n---\n\n# T\n";
  assert.equal(setStatusToken(bare, '📋 STUB'), bare);
});

// ── stampPromotedStatus ──────────────────────────────────────────────────────
test('stampPromotedStatus drops stale Blocked-by + stamps a READY promotion line', () => {
  const c = [
    BANNER,
    '',
    '**Status:** 🔄 IN PROGRESS — picked up 2026-06-10 by `H` in `worktree-x`.',
    '**Blocked-by:** plan 246 landing',
    '',
    '# Title',
  ].join('\n');
  const out = stampPromotedStatus(c, {
    target: 'ready',
    fromStatus: 'waiting-blocked',
    date: '2026-06-14',
  });
  assert.ok(!out.includes('**Blocked-by:**'), 'stale Blocked-by must be dropped on promotion');
  assert.match(out, /\*\*Status:\*\* 📋 READY — re-filed waiting-blocked→ready 2026-06-14\./);
  assert.ok(!out.includes('🔄 IN PROGRESS'), 'old IN PROGRESS status must be replaced');
});

test('stampPromotedStatus → in-progress uses the IN PROGRESS emoji', () => {
  const c = [BANNER, '', '**Status:** 📋 READY — opened 2026-06-01.', '', '# T'].join('\n');
  const out = stampPromotedStatus(c, {
    target: 'in-progress',
    fromStatus: 'ready',
    date: '2026-06-14',
  });
  assert.match(out, /\*\*Status:\*\* 🔄 IN PROGRESS — re-filed ready→in-progress 2026-06-14\./);
});

test('stampPromotedStatus is idempotent (re-stamp same day → no growth)', () => {
  const c = [BANNER, '', '**Status:** 📋 READY — opened 2026-06-01.', '', '# T'].join('\n');
  const once = stampPromotedStatus(c, {
    target: 'ready',
    fromStatus: 'waiting-trip',
    date: '2026-06-14',
  });
  const twice = stampPromotedStatus(once, {
    target: 'ready',
    fromStatus: 'waiting-trip',
    date: '2026-06-14',
  });
  assert.equal(once, twice);
});

// plan 2587 acceptance #5: a `stage: stub` + `specReview: exempt-mechanical` body promoted
// to ready/ must land `**Status:** 📋 STUB`, not `📋 READY` — else the write immediately
// contradicts board-write-gate.mjs's new `stage-status-prose` check.
test('stampPromotedStatus → ready emits STUB (not READY) when the body stage stamp is stub', () => {
  const c = [
    '---',
    "summary: 'x'",
    'stage: stub',
    'specReview: exempt-mechanical',
    '---',
    '',
    '# T',
    '',
    '**Status:** 📋 STUB — filed 2026-06-01.',
  ].join('\n');
  const out = stampPromotedStatus(c, {
    target: 'ready',
    fromStatus: 'waiting-blocked',
    date: '2026-06-14',
  });
  assert.match(out, /\*\*Status:\*\* 📋 STUB — re-filed waiting-blocked→ready 2026-06-14\./);
  assert.ok(!out.includes('📋 READY'));
});

test('stampPromotedStatus → ready keeps READY when the body stage stamp is specced', () => {
  const c = [
    '---',
    "summary: 'x'",
    'stage: specced',
    '---',
    '',
    '# T',
    '',
    '**Status:** 📋 STUB — filed 2026-06-01.',
  ].join('\n');
  const out = stampPromotedStatus(c, {
    target: 'ready',
    fromStatus: 'waiting-blocked',
    date: '2026-06-14',
  });
  assert.match(out, /\*\*Status:\*\* 📋 READY — re-filed waiting-blocked→ready 2026-06-14\./);
});

test('stampPromotedStatus → in-progress is unaffected by the body stage stamp', () => {
  const c = ['---', "summary: 'x'", 'stage: stub', '---', '', '# T'].join('\n');
  const out = stampPromotedStatus(c, {
    target: 'in-progress',
    fromStatus: 'ready',
    date: '2026-06-14',
  });
  assert.match(out, /\*\*Status:\*\* 🔄 IN PROGRESS — re-filed ready→in-progress 2026-06-14\./);
});

// ── stampArchivedStatus ──────────────────────────────────────────────────────
test('stampArchivedStatus flips Status → ✅ COMPLETED and drops a LAND_BLOCKED note', () => {
  const c = [
    BANNER,
    '',
    '**Status:** 📋 READY — opened 2026-06-01.',
    '**Blocked-by:** drain land seam LAND_BLOCKED 2026-06-14 — held.',
    '',
    '# Title',
  ].join('\n');
  const out = stampArchivedStatus(c, { date: '2026-06-14', via: 'done-worktree' });
  assert.match(out, /\*\*Status:\*\* ✅ COMPLETED — archived 2026-06-14 \(done-worktree\)\./);
  assert.ok(!out.includes('LAND_BLOCKED'), 'the LAND_BLOCKED parking note must be dropped');
  assert.ok(!out.includes('**Blocked-by:**'));
  assert.ok(!out.includes('📋 READY'));
});

test('stampArchivedStatus inserts a COMPLETED line when the body has no Status (via omitted)', () => {
  const c = [BANNER, '', '# Title', 'body'].join('\n');
  const out = stampArchivedStatus(c, { date: '2026-06-14' });
  assert.match(out, /\*\*Status:\*\* ✅ COMPLETED — archived 2026-06-14\./);
});

// ── hasTripCondition ─────────────────────────────────────────────────────────
test('hasTripCondition detects a heading, a labelled line, and an inline label', () => {
  assert.ok(hasTripCondition('## Trip-condition\n\nrevive if X recurs.'));
  assert.ok(hasTripCondition('## Revival trip-condition\n\n...'));
  assert.ok(hasTripCondition('**Trip-condition:** operator green-light'));
  assert.ok(hasTripCondition('**Status:** plan; not started. Trip-condition: see below.'));
});

test('hasTripCondition is false when no trip-condition marker is present', () => {
  assert.equal(hasTripCondition('# Title\n\nJust a body with no revival signal.'), false);
});

// ── getUnblock / setUnblock ──────────────────────────────────────────────────
test('getUnblock reads the frontmatter scalar (lowercased), null when absent', () => {
  assert.equal(getUnblock('---\nsummary: x\nunblock: Decision\n---\n\nbody'), 'decision');
  assert.equal(getUnblock('---\nsummary: x\n---\n\nbody'), null);
  assert.equal(getUnblock('no frontmatter'), null);
});

test('getUnblock drops a trailing YAML inline comment (plan 1065 / code-review)', () => {
  // without this, `unblock: cost # spend` parsed to "cost # spend" and slipped past every
  // `=== "cost"` guard (assertUnblockOk, lint findCostMisfiledOperator, the status view).
  assert.equal(getUnblock('---\nunblock: cost  # the ~$8 claude -p spend\n---\n# x'), 'cost');
  assert.equal(getUnblock('---\nunblock: decision # operator go/no-go\n---\n# x'), 'decision');
});

test('setUnblock replaces an existing field in place', () => {
  const out = setUnblock('---\nsummary: x\nunblock: cost\n---\n\nbody', 'decision');
  assert.match(out, /unblock: decision/);
  assert.ok(!out.includes('unblock: cost'));
  assert.equal((out.match(/^unblock:/gm) || []).length, 1);
});

test('setUnblock appends to an existing frontmatter block lacking the field', () => {
  const out = setUnblock('---\nsummary: x\n---\n\nbody', 'manual');
  assert.match(out, /---\nsummary: x\nunblock: manual\n---/);
  assert.match(out, /\nbody$/);
});

test('setUnblock creates a frontmatter block when the body has none', () => {
  const out = setUnblock('# Title\n\nbody', 'cost');
  assert.match(out, /^---\nunblock: cost\n---\n\n# Title/);
});

test('VALID_UNBLOCK is the canonical cost|manual|decision set', () => {
  assert.deepEqual(VALID_UNBLOCK, ['cost', 'manual', 'decision']);
});

// ── plan 629: park / land-stuck body-status stamps ───────────────────
const READY_BODY = [
  '---',
  'summary: "do the thing"',
  '---',
  '',
  '# Plan 700: do the thing',
  '',
  '> 🟩 **SEED-WRITE: NO** — touches scripts only',
  '',
  '**Status:** 📋 READY — opened 2026-06-15.',
  '',
  '## Tasks',
  '- [ ] do it',
  '',
].join('\n');

test('plan 629: stampWaitingOperatorStatus replaces a READY body with ⏸ WAITING-OPERATOR', () => {
  const out = stampWaitingOperatorStatus(READY_BODY, {
    date: '2026-06-15',
    reason: 'gate failure — operator triage',
  });
  assert.match(out, /\*\*Status:\*\* ⏸ WAITING-OPERATOR — parked 2026-06-15 — gate failure/);
  // Task-2 invariant: a parked body NEVER still reads 📋 READY.
  assert.ok(!/📋 READY/.test(out), 'no stale READY left in a parked body');
});

test('plan 629: stampWaitingOperatorStatus keeps the Blocked-by line (the park inserts it separately)', () => {
  const withBlocked = READY_BODY.replace(
    '> 🟩 **SEED-WRITE: NO** — touches scripts only',
    '> 🟩 **SEED-WRITE: NO** — touches scripts only\n\n**Blocked-by:** operator triage required',
  );
  const out = stampWaitingOperatorStatus(withBlocked, { date: '2026-06-15', reason: 'x' });
  assert.match(out, /\*\*Blocked-by:\*\* operator triage required/);
  assert.match(out, /⏸ WAITING-OPERATOR/);
});

test('plan 629: stampWaitingOperatorStatus is idempotent (re-stamp same day → no growth)', () => {
  const once = stampWaitingOperatorStatus(READY_BODY, { date: '2026-06-15', reason: 'x' });
  const twice = stampWaitingOperatorStatus(once, { date: '2026-06-15', reason: 'x' });
  assert.equal(once, twice);
});

test('plan 629: stampLandBlockedResume stamps 🔄 IN PROGRESS land-blocked + a RESUME-NEEDED marker', () => {
  const out = stampLandBlockedResume(READY_BODY, {
    seam: 'REBASE_CONFLICT',
    date: '2026-06-15',
    resumeCmd: 'node scripts/done-worktree.mjs 700-X --resume LAND_BLOCKED_HOLDING',
  });
  assert.match(out, /\*\*Status:\*\* 🔄 IN PROGRESS — land blocked \(REBASE_CONFLICT\) 2026-06-15/);
  assert.match(
    out,
    /\*\*RESUME-NEEDED:\*\* REBASE_CONFLICT — run `node scripts\/done-worktree\.mjs 700-X --resume LAND_BLOCKED_HOLDING`/,
  );
  assert.match(out, /not an operator decision/);
  assert.ok(!/📋 READY/.test(out), 'no stale READY in a land-blocked body');
});

test('plan 629: stampLandBlockedResume drops a stale operator Blocked-by (a land-stuck plan carries none)', () => {
  const withBlocked = READY_BODY.replace(
    '**Status:** 📋 READY — opened 2026-06-15.',
    '**Status:** 📋 READY — opened 2026-06-15.\n**Blocked-by:** something stale',
  );
  const out = stampLandBlockedResume(withBlocked, {
    seam: 'BUILD_FAILED',
    date: '2026-06-15',
    resumeCmd: 'node scripts/done-worktree.mjs 700-X --resume BUILD_FAILED',
  });
  assert.ok(!/\*\*Blocked-by:\*\*/.test(out), 'stale Blocked-by dropped');
});

test('plan 629: stampLandBlockedResume replaces (never stacks) a prior RESUME-NEEDED marker', () => {
  const once = stampLandBlockedResume(READY_BODY, {
    seam: 'REBASE_CONFLICT',
    date: '2026-06-15',
    resumeCmd: 'cmd-a',
  });
  const twice = stampLandBlockedResume(once, {
    seam: 'BUILD_FAILED',
    date: '2026-06-16',
    resumeCmd: 'cmd-b',
  });
  // exactly one marker, newest seam wins
  assert.equal((twice.match(/\*\*RESUME-NEEDED:\*\*/g) || []).length, 1);
  assert.match(twice, /BUILD_FAILED/);
  assert.ok(!/REBASE_CONFLICT/.test(twice), 'old seam gone from the marker');
  // re-stamping with identical inputs is idempotent
  const thrice = stampLandBlockedResume(twice, {
    seam: 'BUILD_FAILED',
    date: '2026-06-16',
    resumeCmd: 'cmd-b',
  });
  assert.equal(twice, thrice);
});

// 1304 delta-review regressions: fence detection is the shared exact-line scan.
test('getUnblock reads through a block whose interior contains a ---- dash line (agrees with setUnblock)', () => {
  const body = '---\nsummary: x\n----\nunblock: manual\n---\n\n# T\n';
  assert.equal(getUnblock(body), 'manual');
});

test('getUnblock: an unterminated opening --- is not frontmatter (matches the write side)', () => {
  assert.equal(getUnblock('---\nunblock: manual\n\n# T\n'), null);
});

test('setStatusLine inserts AFTER the real closing fence, never inside a block with an interior ---- line', () => {
  const body = '---\nsummary: x\n----\ncol | col2\n---\nrow\n\nprose\n';
  const out = setStatusLine(body, '**Status:** done.');
  assert.equal(out, '---\nsummary: x\n----\ncol | col2\n---\n**Status:** done.\n\nrow\n\nprose\n');
});

test('setStatusLine: a ---- first line is not a fence — status is prepended, prose untouched', () => {
  const body = '----\ncol | col2\n---\nrow\n';
  assert.equal(setStatusLine(body, '**Status:** done.'), `**Status:** done.\n\n${body}`);
});

// ── stampHeartbeatRun (plan 1329) ────────────────────────────────────────────
const HEARTBEAT_BODY = [
  '---',
  'summary: x',
  'heartbeat: 7',
  '---',
  '',
  '> 🟩 **SEED-WRITE: NO**',
  '',
  '**Blocked-by:** 2026-07-10 weekly cadence — recurring heartbeat, re-file +7d after each run',
  '',
  '> 💰 **Cost forecast:** $0',
  '',
  '**Status:** 📅 WAITING-DATE — parked until 2026-07-10. Last run: 2026-07-03 (session 1288, landed `9c996c7`).',
  '',
  '**Trip-date:** 2026-07-10 (weekly). After each run, re-file +7d.',
  '',
  '# Title',
  'body',
].join('\n');

test('stampHeartbeatRun re-dates Blocked-by + Trip-date to the next trip date', () => {
  const out = stampHeartbeatRun(HEARTBEAT_BODY, {
    runDate: '2026-07-11',
    nextDate: '2026-07-18',
    sessionN: '1400',
    mergeSha: 'abc1234',
  });
  assert.match(out, /^\*\*Blocked-by:\*\* 2026-07-18 weekly cadence/m, 'Blocked-by re-dated');
  assert.match(out, /^\*\*Trip-date:\*\* 2026-07-18 \(weekly\)/m, 'Trip-date re-dated');
  assert.ok(!out.includes('2026-07-10'), 'no stale prior date survives on the trip lines/status');
});

test('stampHeartbeatRun KEEPS the Blocked-by line (unlike archive/promote) + sets a WAITING-DATE run status', () => {
  const out = stampHeartbeatRun(HEARTBEAT_BODY, {
    runDate: '2026-07-11',
    nextDate: '2026-07-18',
    sessionN: '1400',
    mergeSha: 'abc1234',
  });
  assert.match(out, /\*\*Blocked-by:\*\*/, 'the trip marker is intrinsic — never dropped');
  assert.match(
    out,
    /\*\*Status:\*\* 📅 WAITING-DATE — parked until 2026-07-18\. Last run: 2026-07-11 \(session 1400, landed `abc1234`\)\./,
    'Status records the run just completed + next trip date',
  );
  // exactly one Status line (setStatusLine replaced, not stacked)
  assert.equal((out.match(/^\*\*Status:\*\*/gm) || []).length, 1, 'one Status line only');
});

test('stampHeartbeatRun is idempotent for the same run/next dates (re-run leaves body identical)', () => {
  const once = stampHeartbeatRun(HEARTBEAT_BODY, {
    runDate: '2026-07-11',
    nextDate: '2026-07-18',
    sessionN: '1400',
    mergeSha: 'abc1234',
  });
  const twice = stampHeartbeatRun(once, {
    runDate: '2026-07-11',
    nextDate: '2026-07-18',
    sessionN: '1400',
    mergeSha: 'abc1234',
  });
  assert.equal(twice, once, 're-stamp with identical inputs is a no-op');
});

test('stampHeartbeatRun re-dates EVERY stacked Blocked-by/Trip-date line (global replace)', () => {
  const stacked = [
    '**Blocked-by:** 2026-07-10 first',
    '**Blocked-by:** 2026-07-10 second',
    '**Trip-date:** 2026-07-10 (weekly).',
    '',
    '**Status:** 📅 WAITING-DATE — parked until 2026-07-10.',
    '',
    '# T',
  ].join('\n');
  const out = stampHeartbeatRun(stacked, { runDate: '2026-07-11', nextDate: '2026-07-18' });
  // no stale 2026-07-10 date may survive on ANY trip line (both Blocked-by lines + Trip-date)
  assert.equal(
    (out.match(/^\*\*(?:Blocked-by|Trip-date):\*\* 2026-07-10/gm) || []).length,
    0,
    'every stacked trip line is re-dated, not just the first',
  );
  assert.equal((out.match(/2026-07-18/g) || []).length >= 3, true, 'all three lines bumped');
});

test('stampHeartbeatRun omits the sha clause when no mergeSha (DRY / pre-merge)', () => {
  const out = stampHeartbeatRun(HEARTBEAT_BODY, {
    runDate: '2026-07-11',
    nextDate: '2026-07-18',
    sessionN: '1400',
  });
  assert.match(out, /Last run: 2026-07-11 \(session 1400\)\./, 'no `landed` clause without a sha');
});

// ── hasGrillQuestions / hasOperatorRulings (plan 2034) ───────────────────────
// The waiting-grill/ entry/exit substance checks: heading present AND at least one
// non-blank line before the next heading (or EOF). Format inside the section is
// runbook convention, never machine-parsed (R3).

test('hasGrillQuestions: true for a heading with content; false when absent', () => {
  const ok = '# T\n\n## Grill questions\n\n1. Fork A or B? Recommend: A.\n';
  assert.equal(hasGrillQuestions(ok), true);
  assert.equal(hasGrillQuestions('# T\n\nBody with the words grill questions inline.\n'), false);
});

test('hasGrillQuestions: false for an EMPTY section (next heading or EOF right after)', () => {
  assert.equal(hasGrillQuestions('# T\n\n## Grill questions\n\n## Next\n\ncontent\n'), false);
  assert.equal(hasGrillQuestions('# T\n\n## Grill questions\n\n'), false);
  assert.equal(hasGrillQuestions('# T\n\n## Grill questions'), false);
});

test('hasGrillQuestions: case- and heading-level tolerant, blank lines before content ok', () => {
  assert.equal(hasGrillQuestions('# T\n\n### GRILL QUESTIONS\n\n\n- one question\n'), true);
});

test('hasOperatorRulings: true with rulings (incl. a one-line dissolution); false when absent/empty', () => {
  assert.equal(hasOperatorRulings('# T\n\n## Operator rulings\n\n- R1: pick X.\n'), true);
  assert.equal(
    hasOperatorRulings('# T\n\n## Operator rulings\n\ndissolved: superseded by plan 2100\n'),
    true,
  );
  assert.equal(hasOperatorRulings('# T\n\nBody.\n'), false);
  assert.equal(hasOperatorRulings('# T\n\n## Operator rulings\n\n## Next\n\nx\n'), false);
});

test('hasGrillQuestions/hasOperatorRulings: the two sections are independent', () => {
  const both = '# T\n\n## Grill questions\n\n1. Q?\n\n## Operator rulings\n\n- R1: A.\n';
  assert.equal(hasGrillQuestions(both), true);
  assert.equal(hasOperatorRulings(both), true);
  const questionsOnly = '# T\n\n## Grill questions\n\n1. Q?\n';
  assert.equal(hasGrillQuestions(questionsOnly), true);
  assert.equal(hasOperatorRulings(questionsOnly), false);
});

// 2034 review, finding [0] — the level-blind section boundary. A section whose first
// line of real content is a DEEPER sub-heading read as EMPTY, so the entry guard refused
// a naturally-structured body and forced the parker to flatten legitimate sub-structure.
// The boundary is now level-aware: a deeper heading is part of the section (and is itself
// content); only a sibling-or-shallower heading ends it.
test('hasGrillQuestions: a deeper sub-heading is CONTENT, not a section boundary (2034 review)', () => {
  const subHeaded =
    '# T\n\n## Grill questions\n\n### Fork: tombstone or keep?\n\nRecommend: tombstone.\n';
  assert.equal(hasGrillQuestions(subHeaded), true);
  // …even when the sub-heading is the only thing in the section
  assert.equal(
    hasGrillQuestions('# T\n\n## Grill questions\n\n### Fork: tombstone or keep?\n'),
    true,
  );
});

test('hasOperatorRulings: sub-headings are content there too (2034 review)', () => {
  const subHeaded = '# T\n\n## Operator rulings\n\n### R1 — the taxonomy fork\n\nPick X.\n';
  assert.equal(hasOperatorRulings(subHeaded), true);
});

test('sectionHasContent boundary: a SIBLING heading still ends the section, a deeper one does not', () => {
  // sibling (##) immediately after ⇒ empty
  assert.equal(
    hasGrillQuestions('# T\n\n## Grill questions\n\n## Operator rulings\n\n- R1.\n'),
    false,
  );
  // a SHALLOWER heading (#) also ends it
  assert.equal(
    hasGrillQuestions('# T\n\n## Grill questions\n\n# Another top section\n\nbody\n'),
    false,
  );
  // deeper (###) is content
  assert.equal(hasGrillQuestions('# T\n\n## Grill questions\n\n### sub\n'), true);
});

test('sectionHasContent: an H3 grill-questions section ends at the next H3, not at a deeper H4', () => {
  const h3 = '# T\n\n### Grill questions\n\n#### detail\n\ntext\n';
  assert.equal(hasGrillQuestions(h3), true);
  const h3Empty = '# T\n\n### Grill questions\n\n### Next\n\ntext\n';
  assert.equal(hasGrillQuestions(h3Empty), false);
});

// plan 2052 R1: the shared scanner is fence-aware — a "#"-prefixed line INSIDE a fenced
// code block is never a heading, so it can neither terminate the section early nor be
// mistaken for a boundary. A grill-questions body quoting a shell comment (a real-world
// shape: pasted script output) must keep reading as one section through to the real
// next heading, exactly like the dependencies.md fence hazard this plan's R1 was ruled
// on (see build-index-lib.test.mjs / batches-view.test.mjs for that motivating case).
test('hasGrillQuestions: a "#"-prefixed line inside a fence does not end the section (plan 2052 R1)', () => {
  const fenced =
    '# T\n\n## Grill questions\n\n```\n# a shell comment, not a heading\necho hi\n```\n\n## Operator rulings\n\n- R1.\n';
  assert.equal(hasGrillQuestions(fenced), true);
});

// plan 2353: `**Takeover:**` is a THIRD status-block annotation (claim-plan-lib stamps
// it on an `acquire --resume` takeover). A promotion/archive stamp must strip it along
// with the other two, or an archived body carries a takeover note for a plan that is done.
test('setStatusLine strips a **Takeover:** annotation too (plan 2353 — no stale takeover in archive)', () => {
  const c = [
    BANNER,
    '',
    '**Status:** 🔄 IN PROGRESS — picked up 2026-07-25 by `H` in `worktree-x`.',
    '**Previous status:** 🔄 IN PROGRESS — picked up 2026-07-24 by `DEAD`.',
    '**Takeover:** resumed 2026-07-25 by `H` via `claim-plan acquire --resume`.',
    '',
    '# Title',
  ].join('\n');
  const out = setStatusLine(c, '**Status:** ✅ DONE — archived 2026-07-26.');
  assert.ok(!out.includes('**Takeover:**'), 'stale Takeover must be gone from an archived body');
  assert.ok(!out.includes('**Previous status:**'));
  assert.equal((out.match(/\*\*Status:\*\*/g) || []).length, 1);
  assert.match(out, /\*\*Status:\*\* ✅ DONE — archived 2026-07-26\./);
});

// ── hasSessionDecisions / grillQuestionsSection (plan 4069) ─────────────────────
test('hasSessionDecisions: true for a heading with content; false when absent or empty', () => {
  assert.equal(hasSessionDecisions('# T\n\n## Session decisions\n\n- picked (a).\n'), true);
  assert.equal(hasSessionDecisions('# T\n\nbody\n'), false);
  assert.equal(hasSessionDecisions('# T\n\n## Session decisions\n\n## Next\n\ntext\n'), false);
});

test(
  'hasSessionDecisions is INERT alongside hasGrillQuestions/hasOperatorRulings — the three ' +
    "sections never interfere with one another's presence check",
  () => {
    const all = [
      '# T',
      '## Grill questions',
      '1. `[axis: product]` **Q?** context.',
      '## Session decisions',
      '- (a) chosen — the tech-design fork this plan decided itself.',
      '## Operator rulings',
      '- R1 — the operator-only call.',
    ].join('\n\n');
    assert.equal(hasGrillQuestions(all), true);
    assert.equal(hasSessionDecisions(all), true);
    assert.equal(hasOperatorRulings(all), true);
  },
);

test('grillQuestionsSection: returns the raw section text, or "" when the body carries none', () => {
  const c = '# T\n\n## Grill questions\n\n1. one\n2. two\n\n## Next\n\nother\n';
  const section = grillQuestionsSection(c);
  assert.match(section, /1\. one/);
  assert.match(section, /2\. two/);
  assert.ok(!section.includes('## Next'));
  assert.equal(grillQuestionsSection('# T\n\nno such section\n'), '');
});
