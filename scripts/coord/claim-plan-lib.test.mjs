// scripts/claim-plan-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimRef } from './coord-refs.mjs';
import {
  planIdOf,
  refForPlan,
  buildClaimMessage,
  parseClaimMessage,
  classifyPushResult,
  parseLsRemote,
  nextSessionNumber,
  flipStatusToInProgress,
  isWaitingFolder,
  sessionEntryRelPath,
  sessionEntryCandidates,
  boardPlanClaimCell,
  assertBatchSlug,
  assertSlugCharset,
  SLUG_CHARSET_RX,
  checkBatchEligibility,
  boardBatchPlanClaimCell,
  checkBatchSoloClaimGate,
  normalizeExecutorProvenance,
  DISPATCH_MODES,
  assertSessionEntryDate,
  EXEC_LANE_TABLE,
  resolveExecLane,
} from './claim-plan-lib.mjs';
import { derivePaths } from './coord-config.mjs';
import { extractPlanRefs } from './lint-board.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';
import { MUTATION_BANNER_LABEL } from './build-index-lib.mjs';

// plan 4071 D3: GATE1_PIPELINE_FIELDS was removed from this module — the historical Gate-1
// field list now lives in coord.config.json's `land.specReviewGatedFields[]`, and
// checkBatchEligibility/checkStubClaimGate take it as a `pipelineFields` parameter
// (default `[]`) instead of a hardcoded literal. PIPELINE_FIELDS below is a purely synthetic
// TEST FIXTURE constant (plan 3958: this module ships as-is into the public coord-kit, so a
// shipped core test must not pin THIS repo's real coord.config.json value) — the F1 tests below
// inject it directly via the `pipelineFields` parameter, so none of them depend on this repo's
// actual coord.config.json content.
const PIPELINE_FIELDS = ['acceptsAcuteCases', 'acuteCapability'];
// plan 3958: same rationale as build-index-lib.test.mjs's own `sw()` — MUTATION_BANNER_LABEL is
// the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row, and is the
// IDENTITY function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);

test('sessionEntryCandidates: first is the bare path, then b–z suffixes (sessions layout)', () => {
  const c = sessionEntryCandidates('2026-06-20', 828, 'sessions');
  assert.equal(c[0], 'handoff/sessions/2026-06-20-session-828.md');
  assert.equal(c[1], 'handoff/sessions/2026-06-20-session-828b.md');
  assert.equal(c[2], 'handoff/sessions/2026-06-20-session-828c.md');
  assert.equal(c[c.length - 1], 'handoff/sessions/2026-06-20-session-828z.md');
  assert.equal(c.length, 26, 'bare + b..z (25 suffixes) = 26 candidates');
  assert.equal(new Set(c).size, c.length, 'all candidates are distinct');
});

test('sessionEntryCandidates: single layout yields only handoff.md (no per-session collision)', () => {
  assert.deepEqual(sessionEntryCandidates('2026-06-20', 828, 'single'), ['handoff.md']);
});

// plan 857: with the docs/handoff/ layout injected (vetapp production config), the
// session-entry path resolves UNDER docs/handoff/sessions/ — not the legacy root dir.
test('sessionEntryRelPath/Candidates honour injected docs/handoff paths', () => {
  const paths = derivePaths('docs/handoff');
  assert.equal(
    sessionEntryRelPath('2026-06-20', 848, 'sessions', paths),
    'docs/handoff/sessions/2026-06-20-session-848.md',
  );
  const c = sessionEntryCandidates('2026-06-20', 848, 'sessions', paths);
  assert.equal(c[0], 'docs/handoff/sessions/2026-06-20-session-848.md');
  assert.equal(c[1], 'docs/handoff/sessions/2026-06-20-session-848b.md');
  // single layout under docs/handoff/ → the rolling handoff current.md
  assert.deepEqual(sessionEntryCandidates('2026-06-20', 848, 'single', paths), [
    'docs/handoff/current.md',
  ]);
});

test('planIdOf extracts the plan id (3+ digits); throws on a non-id', () => {
  assert.equal(planIdOf('365'), '365');
  assert.equal(planIdOf('365-UI-mobile-nav'), '365');
  // 4-digit ids (plan 1000+): the whole leading numeric run, not the first 3 digits.
  assert.equal(planIdOf('1000'), '1000');
  assert.equal(planIdOf('1000-Infra-seedwrite-concurrency'), '1000');
  assert.throws(() => planIdOf('nope'), /cannot derive/);
});

test('refForPlan maps a plan id (or basename) to its claims ref', () => {
  // plan 3756: refForPlan is the WRITE seam, so it names the live (branch-shaped) namespace.
  // Reads go through claimRefCandidates, which still honours the legacy name.
  assert.equal(refForPlan('365'), claimRef('365'));
  assert.equal(refForPlan('365-UI-mobile-nav'), claimRef('365'));
});

test('buildClaimMessage embeds a unique, parseable identity', () => {
  const msg = buildClaimMessage({
    planId: '365',
    sessionUuid: 'abc-123',
    host: 'PC1',
    iso: '2026-06-05T16:50:00Z',
  });
  assert.deepEqual(parseClaimMessage(msg), {
    planId: '365',
    sessionUuid: 'abc-123',
    host: 'PC1',
    iso: '2026-06-05T16:50:00Z',
    // plan 3756: the discriminator that tells a live claim from a release tombstone.
    released: false,
  });
});

test('parseClaimMessage returns null on a non-claim commit body', () => {
  assert.equal(parseClaimMessage('just a normal commit\n'), null);
});

test('classifyPushResult: clean push = won', () => {
  assert.deepEqual(classifyPushResult({ ok: true }), { won: true });
});

test('classifyPushResult: non-ff rejection = lost (not an error)', () => {
  const r = classifyPushResult({
    ok: false,
    stderr: ' ! [rejected]        abc -> refs/claims/365 (non-fast-forward)',
  });
  assert.equal(r.won, false);
  assert.equal(r.lost, true);
});

test('classifyPushResult: "already exists" rejection = lost', () => {
  const r = classifyPushResult({ ok: false, stderr: ' ! [remote rejected] ... (already exists)' });
  assert.equal(r.lost, true);
});

test('classifyPushResult: a hook/other failure is neither won nor lost (surface it)', () => {
  const r = classifyPushResult({ ok: false, stderr: 'fatal: the remote end hung up unexpectedly' });
  assert.equal(r.won, false);
  assert.equal(r.lost, false);
  assert.equal(r.error, true);
});

test('parseLsRemote builds a holder map keyed by plan id', () => {
  const out = '0a1b\trefs/claims/365\n9f8e\trefs/claims/366\n';
  assert.deepEqual(parseLsRemote(out), { 365: '0a1b', 366: '9f8e' });
});

test('parseLsRemote ignores non-claims refs and blank lines', () => {
  const out = '0a1b\trefs/claims/365\nDEAD\trefs/heads/master\n\n';
  assert.deepEqual(parseLsRemote(out), { 365: '0a1b' });
});

test('parseClaimMessage / parseLsRemote handle 4-digit ids (plan 1000+)', () => {
  const msg = buildClaimMessage({
    planId: '1000',
    sessionUuid: 'sid-1',
    host: 'PC1',
    iso: '2026-06-23T10:00:00Z',
  });
  assert.equal(parseClaimMessage(msg).planId, '1000');
  assert.equal(refForPlan('1000-Infra-x'), claimRef('1000'));
  assert.deepEqual(parseLsRemote('0a1b\trefs/claims/1000\n9f8e\trefs/claims/999\n'), {
    1000: '0a1b',
    999: '9f8e',
  });
});

test('nextSessionNumber: no counter yet -> 1; else parsed+1', () => {
  assert.equal(nextSessionNumber(null), 1);
  assert.equal(nextSessionNumber('session=330 by abc'), 331);
  assert.equal(nextSessionNumber('session=7'), 8);
});

// plan 2415 pinned "claim-plan-lib's STATUS_RX stays byte-identical to plan-body-state's
// STATUS_BLOCK_RX" by extracting both regex literals from the two SOURCE files and comparing
// the strings — the only guard available while the constant was hand-copied into each writer.
//
// Plan 2353 removed both copies: the one definition now lives in build-index-lib.mjs (which is
// itself tandapp-adopted, so sharing it costs no adoption problem) and both writers import it.
// The source-grep test cannot survive that by construction — there is no literal left to grep —
// and it should not, because it guarded a weaker property. Replaced with the stronger one:
// assert the two writers resolve the SAME object, so byte-identity is a fact about the module
// graph rather than a string comparison someone must remember to re-run. `Object.is` on the
// imported binding is the whole check; drift is no longer expressible.
test('2353: both Status writers share ONE STATUS_BLOCK_RX object (drift structurally impossible)', async () => {
  const shared = await import('./build-index-lib.mjs');
  const claimSrc = readFileSync(new URL('./claim-plan-lib.mjs', import.meta.url), 'utf8');
  const bodySrc = readFileSync(new URL('./plan-body-state.mjs', import.meta.url), 'utf8');

  // Neither writer may re-declare a local copy — that is exactly the drift being retired.
  assert.doesNotMatch(
    claimSrc,
    /const (?:STATUS_RX|STATUS_BLOCK_RX)\s*=\s*\//,
    'claim-plan-lib.mjs must import STATUS_BLOCK_RX, not re-declare a literal',
  );
  assert.doesNotMatch(
    bodySrc,
    /const STATUS_BLOCK_RX\s*=\s*\//,
    'plan-body-state.mjs must import STATUS_BLOCK_RX, not re-declare a literal',
  );
  // …and both must import it from the shared home.
  assert.match(claimSrc, /STATUS_BLOCK_RX,?[\s\S]{0,400}?from '\.\/build-index-lib\.mjs'/);
  assert.match(bodySrc, /STATUS_BLOCK_RX,?[\s\S]{0,400}?from '\.\/build-index-lib\.mjs'/);

  // The shared definition still matches a full block, including the annotation kind plan 2353
  // added — the property 2415's byte-comparison existed to protect.
  const block =
    '**Status:** 🔄 IN PROGRESS — x.\n**Previous status:** 📋 READY — y.\n**Takeover:** resumed by `H`.';
  assert.equal(block.match(shared.STATUS_BLOCK_RX)[0], block, 'matches Status + all annotations');
  assert.ok(shared.STATUS_ANNOTATION_KEYS.includes('Takeover'));
});

test('flipStatusToInProgress rewrites the Status line and records the previous one', () => {
  const body = '# T\n\n**Status:** 📋 READY — opened 2026-06-05.\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '365-x', date: '2026-06-05' });
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-05 by `PC1` in `worktree-365-x`\./,
  );
  assert.match(out, /\*\*Previous status:\*\* 📋 READY — opened 2026-06-05\./);
});

test('flipStatusToInProgress: a SECOND claim (resumed from waiting-*/) replaces the WHOLE stale block, not just the Status line (plan 2415)', () => {
  // Simulates a plan already carrying a Status + Previous-status + Override block
  // from an earlier claim (e.g. parked to waiting-operator/ then re-claimed).
  const body =
    '# T\n\n' +
    '**Status:** 🔄 IN PROGRESS — picked up 2026-06-01 by `PC0` in `worktree-365-x`.\n' +
    '**Previous status:** 📋 READY — opened 2026-05-30.\n' +
    '**Override:** operator pickup 2026-06-01 satisfied the `waiting-operator/` gate (auto-projected by `claim-plan acquire`).\n\n' +
    'body\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '365-x',
    date: '2026-06-05',
    srcFolder: 'waiting-operator',
  });
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-05 by `PC1` in `worktree-365-x`\./,
  );
  // Exactly ONE **Previous status:** line — the fresh one, derived from the prior
  // run's **Status:** line only, not the whole stale block.
  const prevStatusMatches = out.match(/\*\*Previous status:\*\*/g) || [];
  assert.equal(prevStatusMatches.length, 1);
  assert.match(
    out,
    /\*\*Previous status:\*\* 🔄 IN PROGRESS — picked up 2026-06-01 by `PC0` in `worktree-365-x`\./,
  );
  // The stale Previous-status/Override lines from the FIRST claim are gone, and only
  // the fresh Override line (for THIS resume) survives.
  assert.doesNotMatch(out, /📋 READY — opened 2026-05-30/);
  const overrideMatches = out.match(/\*\*Override:\*\*/g) || [];
  assert.equal(overrideMatches.length, 1);
  assert.match(
    out,
    /\*\*Override:\*\* operator pickup 2026-06-05 satisfied the `waiting-operator\/` gate/,
  );
});

test('sessionEntryRelPath builds the per-session handoff path', () => {
  assert.equal(
    sessionEntryRelPath('2026-06-05', 332),
    'handoff/sessions/2026-06-05-session-332.md',
  );
});

test('sessionEntryRelPath: single layout ⇒ handoff.md', () => {
  assert.equal(sessionEntryRelPath('2026-06-05', 332, 'single'), 'handoff.md');
});

// plan 2844 Task 1: `--date` reaches sessionEntryCandidates unvalidated at both claim-plan
// call sites and is concatenated straight into `${date}-session-${n}.md`. Pin the shared
// validator that closes that gap.
test('assertSessionEntryDate: accepts a well-formed YYYY-MM-DD', () => {
  assert.doesNotThrow(() => assertSessionEntryDate('2026-08-04', { cmd: 'acquire' }));
});

test('assertSessionEntryDate: rejects a non-ISO --date (the mis-named-entry trigger)', () => {
  assert.throws(
    () => assertSessionEntryDate('20260804', { cmd: 'acquire' }),
    /--date "20260804" must be YYYY-MM-DD/,
  );
});

test('assertSessionEntryDate: rejects garbage, empty, and undefined, naming the command', () => {
  assert.throws(
    () => assertSessionEntryDate('not-a-date', { cmd: 'batch' }),
    /claim-plan batch: --date/,
  );
  assert.throws(() => assertSessionEntryDate('', { cmd: 'acquire' }), /--date/);
  assert.throws(() => assertSessionEntryDate(undefined, { cmd: 'acquire' }), /--date/);
});

test('assertSessionEntryDate: a shape-valid but impossible calendar date is NOT refused (shape-only, by design)', () => {
  // rankSessionFiles only needs the SHAPE to sort/order correctly — an impossible date like
  // 2026-13-40 still sorts as a string exactly like a real one, so validating full calendar
  // correctness would refuse more than the bug this closes actually requires.
  assert.doesNotThrow(() => assertSessionEntryDate('2026-13-40', { cmd: 'acquire' }));
});

test('boardPlanClaimCell renders the plan-claim cell with id, session, host, seed marker', () => {
  const cell = boardPlanClaimCell({
    slug: '368-Other-atomic-ref-cas-plan-claims',
    sessionNum: 332,
    host: 'PC1',
    seedWrite: 'no',
  });
  assert.match(cell, /`368-Other-atomic-ref-cas-plan-claims\.md`/);
  assert.match(cell, /session 332/);
  assert.match(cell, /host=`PC1`/);
  assert.match(cell, /🟩/);
});

test('boardPlanClaimCell uses the red marker for a seed-write claim', () => {
  const cell = boardPlanClaimCell({ slug: '134-DQ-x', sessionNum: 5, host: 'H', seedWrite: 'yes' });
  assert.match(cell, /🟥/);
});

test('boardPlanClaimCell (plan 2328): priority prefixes ⚡ onto the lane marker; absent → unchanged', () => {
  const cell = boardPlanClaimCell({
    slug: '2340-DQ-urgent',
    sessionNum: 7,
    host: 'H',
    seedWrite: 'yes',
    priority: true,
  });
  assert.match(cell, /⚡🟥 SEED-WRITE/);
  const plain = boardPlanClaimCell({
    slug: '2341-UI-x',
    sessionNum: 8,
    host: 'H',
    seedWrite: 'no',
  });
  assert.ok(!plain.includes('⚡'));
});

test('boardPlanClaimCell uses planRef verbatim over the bare slug when given', () => {
  const cell = boardPlanClaimCell({
    slug: '811-price-surface-comparable-price-categories-prislista',
    planRef: 'in-progress/811-Price-Surface-Comparable-Price-Categories-Prislista.md',
    sessionNum: 736,
    host: 'PC1',
    seedWrite: 'yes',
  });
  assert.match(cell, /`in-progress\/811-Price-Surface-Comparable-Price-Categories-Prislista\.md`/);
});

// Regression for plan 819 / the 2026-06-18 plan-811 strand: a slug whose category
// tag lowercased (`price`) renders a bare-slug cell that the board lint's NO_PLAN_REF
// regex cannot match — the planRef (dir-prefixed, original-cased basename) restores
// a lint-valid cell.
test('boardPlanClaimCell: lowercased-category slug is lint-unmatchable bare but matchable via planRef', () => {
  const slug = '811-price-surface-comparable-price-categories-prislista';
  const bare = boardPlanClaimCell({ slug, sessionNum: 736, host: 'PC1', seedWrite: 'yes' });
  assert.equal(extractPlanRefs(bare).length, 0); // the bug: bare lowercased slug ⇒ no plan ref

  const withRef = boardPlanClaimCell({
    slug,
    planRef: '811-Price-Surface-Comparable-Price-Categories-Prislista.md',
    sessionNum: 736,
    host: 'PC1',
    seedWrite: 'yes',
  });
  assert.equal(extractPlanRefs(withRef).length, 1); // the fix: real-cased basename ⇒ valid ref
});

test('flipStatusToInProgress inserts a Status line after the cost-forecast banner when none exists', () => {
  const body =
    sw('> 🟩 **SEED-WRITE: NO** — code only.\n') +
    '> 💰 **Cost forecast:** $0 (deterministic).\n' +
    '\n# T\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '371-x', date: '2026-06-06' });
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-06 by `PC1` in `worktree-371-x`\./,
  );
  // No previous value on insert.
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
  // Anchored directly after the cost-forecast banner.
  assert.match(
    out,
    /\*\*Cost forecast:\*\* \$0 \(deterministic\)\.\n\n\*\*Status:\*\* 🔄 IN PROGRESS/,
  );
});

test("flipStatusToInProgress anchors on a non-bold cost banner too (plan 2360 review — matches queue-drain.mjs's tolerance)", () => {
  const body =
    sw('> 🟩 **SEED-WRITE: NO** — code only.\n') +
    '💰 Cost forecast: ~1 short session. No LLM spend.\n' +
    '\n# T\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '371-x', date: '2026-06-06' });
  assert.match(
    out,
    /No LLM spend\.\n\n\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-06 by `PC1` in `worktree-371-x`\./,
  );
});

test('flipStatusToInProgress does NOT anchor on a frontmatter summary that quotes a 💰 banner verbatim — no corruption of the YAML block (plan 2360 review round 5)', () => {
  const body = [
    '---',
    "summary: 'see the banner shape > 💰 **Cost forecast:** $0 quoted here'",
    'stage: specced',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: NO** — code only.'),
    '> 💰 **Cost forecast:** $0 (deterministic).',
    '',
    '# T',
    '',
    'body',
    '',
  ].join('\n');
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '371-x', date: '2026-06-06' });
  // frontmatter block is untouched — the Status line must not land inside it
  assert.match(out, /^---\nsummary:.*\nstage: specced\n---\n/);
  // it lands after the REAL body banner instead
  assert.match(
    out,
    /\*\*Cost forecast:\*\* \$0 \(deterministic\)\.\n\n\*\*Status:\*\* 🔄 IN PROGRESS/,
  );
});

// --- plan 2392: round-6 findings on the round-5 fix's remaining gaps -----------

test('flipStatusToInProgress: the EXISTING-Status fast-replace path is frontmatter-guarded too (plan 2392 finding 1) — a malformed frontmatter block with a stray **Status:**-shaped line at column 0 is left untouched', () => {
  const body = [
    '---',
    '**Status:** stray legacy line hand-edited into frontmatter',
    'stage: specced',
    '---',
    '',
    '# T',
    '',
    '**Status:** 📋 READY — opened 2026-06-05.',
    '',
    'body',
    '',
  ].join('\n');
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '371-x', date: '2026-06-06' });
  // the stray frontmatter line survives byte-for-byte — never flipped, never duplicated into
  assert.match(
    out,
    /^---\n\*\*Status:\*\* stray legacy line hand-edited into frontmatter\nstage: specced\n---\n/,
  );
  // the REAL body Status line is the one that was flipped (its prior value is
  // correctly captured in **Previous status:**, not the frontmatter's stray line)
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-06 by `PC1` in `worktree-371-x`\./,
  );
  assert.match(out, /\*\*Previous status:\*\* 📋 READY — opened 2026-06-05\./);
  assert.equal((out.match(/^\*\*Status:\*\*/gm) || []).length, 2); // frontmatter stray + real flip
});

test('flipStatusToInProgress: the no-anchor prepend fallback inserts AFTER the frontmatter fence, never before it (plan 2392 finding 2 — pre-existing bug, predates plan 2360)', () => {
  const body = '---\nstage: stub\n---\n\nJust body text, no COST/SEED/H1 anchor yet.\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  // the frontmatter fence must still lead the file — a prepend-before-fence would
  // corrupt this into unreadable frontmatter (stripFrontmatter/readFrontmatterScalar
  // both require lines[0] === '---').
  assert.match(out, /^---\nstage: stub\n---\n/);
  assert.ok(
    out.indexOf('**Status:** 🔄 IN PROGRESS') > out.indexOf('---\nstage: stub\n---'),
    'Status line must land after the closing fence, not before it',
  );
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
});

test('flipStatusToInProgress: an INDENTED closing fence is NOT frontmatter for ANY consumer — one fence rule, no detector disagreement (plan 2392 finding 2, converged by plan 2368)', () => {
  // History: this test used to pin the OPPOSITE outcome. stripFrontmatter carried its
  // own fence literal that trimmed BOTH ends, so ' ---' closed the block there while
  // frontmatterEnd's isFenceLine (trailing whitespace only, plan 1328) said it did
  // not — plan 2392 routed the no-anchor fallback through splitFrontmatter so that
  // every branch at least agreed with ITSELF. Plan 2368 removed the second literal
  // (stripFrontmatter now delegates to frontmatterEnd, because the both-ends trim was
  // ending frontmatter early inside indented YAML block scalars), so the two
  // detectors converged on "leading whitespace ⇒ not a fence".
  //
  // Consequence pinned here: this malformed file has no recognized frontmatter
  // anywhere in the system — `stage:` was already invisible to readFrontmatterScalar
  // (frontmatterEnd -1), and upsertFrontmatterKey would prepend a fresh block above
  // it — so the Status line lands at the TOP, consistently. What must never regress
  // is consumers disagreeing about the same bytes; the direction they agree on is a
  // property of the shared rule.
  const body = '---\nstage: stub\n ---\n\nJust body text, no COST/SEED/H1 anchor yet.\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  assert.match(out, /^\*\*Status:\*\* 🔄 IN PROGRESS/, 'no frontmatter recognized ⇒ prepend');
  // The malformed block itself is preserved verbatim, never spliced into.
  assert.ok(out.includes('---\nstage: stub\n ---\n'));
});

test('flipStatusToInProgress: a duplicate H1-shaped literal text embedded mid-sentence earlier in the body does not hijack the anchor splice (plan 2392 finding 3)', () => {
  const body = [
    'Renamed from # Original Title in an earlier draft.',
    '',
    '# Original Title',
    '',
    'body text',
    '',
  ].join('\n');
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  // the earlier prose sentence is untouched — a literal-text .replace() would have
  // spliced into the MIDDLE of this sentence instead, since "# Original Title" also
  // occurs there as a raw substring (just not at true line-start, so H1_RX itself
  // never matches it).
  assert.ok(out.includes('Renamed from # Original Title in an earlier draft.'));
  // the REAL, line-anchored H1 is the one that got the Status line appended after it
  assert.match(out, /\n# Original Title\n\n\*\*Status:\*\* 🔄 IN PROGRESS/);
});

test('flipStatusToInProgress falls back to the SEED-WRITE banner when there is no cost banner', () => {
  const body = sw('> 🟥 **SEED-WRITE: YES** — mutates seed.\n\n# T\n\nbody\n');
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  assert.match(
    out,
    new RegExp(
      `\\*\\*${MUTATION_BANNER_LABEL}: YES\\*\\* — mutates seed\\.\\n\\n\\*\\*Status:\\*\\* 🔄 IN PROGRESS`,
    ),
  );
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
});

test('flipStatusToInProgress falls back to after the H1 when there is no banner', () => {
  const body = '# Title here\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  assert.match(out, /# Title here\n\n\*\*Status:\*\* 🔄 IN PROGRESS/);
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
});

test('flipStatusToInProgress preserves $-pattern sequences ($&, $$) in the anchor banner', () => {
  const body = '> 💰 **Cost forecast:** weird $& and $$ signs.\n\n# T\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  assert.match(
    out,
    /\*\*Cost forecast:\*\* weird \$& and \$\$ signs\.\n\n\*\*Status:\*\* 🔄 IN PROGRESS/,
  );
});

test('flipStatusToInProgress prepends a Status line when the body has no banner or H1', () => {
  const body = 'just some text\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd' });
  assert.match(
    out,
    /^\*\*Status:\*\* 🔄 IN PROGRESS — picked up d by `h` in `worktree-s`\.\n\njust some text/,
  );
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
});

// --- plan 446: resume from a waiting-*/ gate stamps an Override line -----------

test('flipStatusToInProgress appends an Override line when resuming from a waiting-* gate', () => {
  const body = '# T\n\n**Status:** 📋 READY — opened 2026-06-05.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '446-x',
    date: '2026-06-07',
    srcFolder: 'waiting-operator',
  });
  assert.match(
    out,
    /\*\*Status:\*\* 🔄 IN PROGRESS — picked up 2026-06-07 by `PC1` in `worktree-446-x`\./,
  );
  assert.match(out, /\*\*Previous status:\*\* 📋 READY — opened 2026-06-05\./);
  assert.match(
    out,
    /\*\*Override:\*\* operator pickup 2026-06-07 satisfied the `waiting-operator\/` gate \(auto-projected by `claim-plan acquire`\)\./,
  );
});

test('flipStatusToInProgress adds NO Override line for a fresh ready/ claim', () => {
  const body = '# T\n\n**Status:** 📋 READY.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '446-x',
    date: '2026-06-07',
    srcFolder: 'ready',
  });
  assert.doesNotMatch(out, /\*\*Override:\*\*/);
});

test('flipStatusToInProgress adds NO Override line when srcFolder is omitted (back-compat)', () => {
  const body = '# T\n\n**Status:** 📋 READY.\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'PC1', slug: '446-x', date: '2026-06-07' });
  assert.doesNotMatch(out, /\*\*Override:\*\*/);
});

test('flipStatusToInProgress stamps the Override line on the no-Status insert path too', () => {
  const body = '> 💰 **Cost forecast:** $0.\n\n# T\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'h',
    slug: 's',
    date: 'd',
    srcFolder: 'waiting-trip',
  });
  assert.match(out, /\*\*Status:\*\* 🔄 IN PROGRESS/);
  assert.doesNotMatch(out, /\*\*Previous status:\*\*/);
  assert.match(out, /\*\*Override:\*\* operator pickup d satisfied the `waiting-trip\/` gate/);
});

// --- plan 2459 Task 2: flipStatusToInProgress overrideBatchSolo -------------

test('flipStatusToInProgress appends an Override line for a batch-solo override, naming the note', () => {
  const body = '# T\n\n**Status:** 📋 READY — opened 2026-06-05.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '2460-x',
    date: '2026-07-26',
    srcFolder: 'ready',
    overrideBatchSolo: 'operator wants this one landed ahead of its batch',
  });
  assert.match(
    out,
    /\*\*Override:\*\* claimed solo via `--override-batch-solo` \(plan 2459 Task 2 batch-hold bypass\) — "operator wants this one landed ahead of its batch"\./,
  );
});

test('flipStatusToInProgress: stub-ok and batch-solo overrides can both apply (independent lines)', () => {
  const body = '# T\n\n**Status:** 📋 READY.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'h',
    slug: 's',
    date: 'd',
    srcFolder: 'ready',
    stubOk: 'stub authorization note',
    overrideBatchSolo: 'batch-hold authorization note',
  });
  assert.match(out, /\*\*Override:\*\* claimed via `--stub-ok`.*stub authorization note/);
  assert.match(
    out,
    /\*\*Override:\*\* claimed solo via `--override-batch-solo`.*batch-hold authorization note/,
  );
});

test('flipStatusToInProgress adds NO batch-solo Override line when the option is omitted', () => {
  const body = '# T\n\n**Status:** 📋 READY.\n\nbody\n';
  const out = flipStatusToInProgress(body, { host: 'h', slug: 's', date: 'd', srcFolder: 'ready' });
  assert.doesNotMatch(out, /--override-batch-solo/);
});

// --- plan 2459 Task 2: checkBatchSoloClaimGate (pure) ------------------------

// plan 2518 review: the gate takes the RESOLVED slug (or null/undefined when unheld), not a
// lookup map — its only production caller answers about the one plan being claimed, and
// resolves that slug itself via batch-paths.mjs's findRunnableBatchForPlan. The id-keyed
// lookup (and its canonicalization) is tested where it now lives, in batch-paths.test.mjs.
// Behaviour is unchanged: same verdicts, byte-identical refusal text.

test('checkBatchSoloClaimGate: an unheld plan (no slug resolved) passes', () => {
  assert.equal(checkBatchSoloClaimGate('2460', null).ok, true);
  assert.equal(checkBatchSoloClaimGate('2460', undefined).ok, true);
});

test('checkBatchSoloClaimGate: a held plan is refused, naming the batch slug and both legal moves', () => {
  const r = checkBatchSoloClaimGate('2460', 'batch-claim-projection');
  assert.equal(r.ok, false);
  assert.match(r.reason, /^plan 2460 is a member of runnable batch "batch-claim-projection"/);
  assert.match(r.reason, /claim-plan\.mjs batch/);
  assert.match(r.reason, /--override-batch-solo/);
});

test('checkBatchSoloClaimGate: a non-empty overrideNote WINS over a held plan', () => {
  const r = checkBatchSoloClaimGate('2460', 'batch-x', {
    overrideNote: 'operator says land this one now',
  });
  assert.equal(r.ok, true);
});

// ───────────────────── plan 1364 Ship 1: batch claim pure helpers ─────────────

function fm({ stage = 'specced', execModel = 'sonnet' } = {}, seedWrite = 'NO') {
  return [
    '---',
    `stage: ${stage}`,
    `execModel: ${execModel}`,
    '---',
    '',
    '# T',
    '',
    `> ${seedWrite === 'YES' ? '🟥' : '🟩'} **${MUTATION_BANNER_LABEL}: ${seedWrite}** — desc.`,
    '',
    'body',
    '',
  ].join('\n');
}

test('assertBatchSlug: throws unless the slug starts with "batch-"', () => {
  assert.throws(() => assertBatchSlug('1362-DQ-x'), /must start with "batch-"/);
  assert.throws(() => assertBatchSlug(''), /must start with "batch-"/);
  assert.throws(() => assertBatchSlug(undefined), /must start with "batch-"/);
  assert.doesNotThrow(() => assertBatchSlug('batch-2026-07-03-x'));
});

// F-004/F-015 (plan 1313 coord audit): the shared ASCII slug/category charset gate.
test('SLUG_CHARSET_RX / assertSlugCharset: accepts ASCII letters/digits/._- starting with a letter or digit', () => {
  for (const ok of [
    '869-UI-x',
    'batch-2026-07-03-coord-hardening',
    'fine-slug_v2.1',
    'Other',
    '0-x',
  ]) {
    assert.ok(SLUG_CHARSET_RX.test(ok), `expected "${ok}" to match`);
    assert.doesNotThrow(() => assertSlugCharset(ok, 'slug'));
  }
});

test('assertSlugCharset: rejects a space (the F-015 non-ASCII-scanner mismatch trigger)', () => {
  assert.throws(() => assertSlugCharset('my plan', 'slug'), /--slug "my plan" must match/);
});

test('assertSlugCharset: rejects an apostrophe (the F-004 PowerShell-injection trigger)', () => {
  assert.throws(() => assertSlugCharset("clinic's-fix", 'slug'), /--slug/);
});

test('assertSlugCharset: rejects non-ASCII letters (Swedish öäå)', () => {
  assert.throws(() => assertSlugCharset('öppettider-ändring', 'category'), /--category/);
});

test('assertSlugCharset: rejects empty/undefined and a leading hyphen/dot', () => {
  assert.throws(() => assertSlugCharset('', 'slug'), /--slug/);
  assert.throws(() => assertSlugCharset(undefined, 'slug'), /--slug/);
  assert.throws(() => assertSlugCharset('-leading-hyphen', 'slug'), /--slug/);
  assert.throws(() => assertSlugCharset('.leading-dot', 'slug'), /--slug/);
});

test('checkBatchEligibility: rejects a count outside 2-8', () => {
  const one = [{ id: '1', path: 'p', content: fm() }];
  assert.equal(checkBatchEligibility(one).ok, false);
  assert.match(checkBatchEligibility(one).reason, /2-8 plans \(got 1\)/);
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: String(i), path: 'p', content: fm() }));
  assert.equal(checkBatchEligibility(nine).ok, false);
  assert.match(checkBatchEligibility(nine).reason, /2-8 plans \(got 9\)/);
});

// plan 1516: the ceiling moved 5→8 (operator batch-sizing doctrine, 2026-07-06) — a
// trivial single-shard train may now ride up to 8 members. Pin both new edges: 8 passes,
// 9 rejects (covered above).
test('checkBatchEligibility: an 8-member batch passes eligibility (plan 1516 ceiling)', () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: String(i), path: 'p', content: fm() }));
  assert.equal(checkBatchEligibility(eight).ok, true);
});

test('checkBatchEligibility: rejects duplicate ids', () => {
  const dup = [
    { id: '1', path: 'p', content: fm() },
    { id: '1', path: 'p', content: fm() },
  ];
  const r = checkBatchEligibility(dup);
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate plan id "1"/);
});

test('checkBatchEligibility: rejects an unresolved member (path=null)', () => {
  const members = [
    { id: '1', path: 'p', content: fm() },
    { id: '2', path: null, content: null },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not resolvable.*2/);
});

test('checkBatchEligibility: rejects a non-specced member', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ stage: 'specced', execModel: 'sonnet' }) },
    { id: '2', path: 'p', content: fm({ stage: 'stub', execModel: 'sonnet' }) },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan 2 has stage "stub", batch requires "specced"/);
});

// plan 2556: the gate is LANE-HOMOGENEITY, not sonnet-only. A MIXED batch is still refused —
// one batch runs under ONE conductor, and a Sonnet batch-train cannot ride a fable member.
test('checkBatchEligibility: rejects a MIXED-lane batch, naming both members lanes', () => {
  const members = [
    { id: '1', path: 'p', content: fm() },
    { id: '2', path: 'p', content: fm({ execModel: 'fable' }) },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /mixed execModel in batch \(1=sonnet, 2=fable\)/);
});

// THE BLOCKER THIS PINS: before plan 2556 this returned `batch requires "sonnet"`, so an
// ALL-FABLE batch was unclaimable through the only sanctioned path — and the cloud-routine
// prompts forbid `--force`, so there was no escape at all. That was the last link in the dead
// zone: the plan-2459 hold blocked every member from a solo claim while the batch claim
// refused the train, leaving a board-pass-grouped fable pair executable by nothing.
test('checkBatchEligibility: an ALL-FABLE batch is claimable (the plan-2556 unblock)', () => {
  const members = [
    { id: '2532', path: 'p', content: fm({ execModel: 'fable' }) },
    { id: '2533', path: 'p', content: fm({ execModel: 'fable' }) },
  ];
  assert.equal(checkBatchEligibility(members).ok, true);
});

// An absent execModel is the grandfathered sonnet default — the same normalization
// queue-drain's lane gate applies — so it still batches with sonnet members.
test('checkBatchEligibility: an ABSENT execModel batches with sonnet, but not with fable', () => {
  const withSonnet = [
    { id: '1', path: 'p', content: fm({ execModel: '' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sonnet' }) },
  ];
  assert.equal(checkBatchEligibility(withSonnet).ok, true);

  const withFable = [
    { id: '1', path: 'p', content: fm({ execModel: '' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'fable' }) },
  ];
  assert.equal(checkBatchEligibility(withFable).ok, false);
  assert.match(checkBatchEligibility(withFable).reason, /1=sonnet, 2=fable/);
});

test('checkBatchEligibility: rejects mixed SEED-WRITE banners', () => {
  const members = [
    { id: '1', path: 'p', content: fm({}, 'NO') },
    { id: '2', path: 'p', content: fm({}, 'YES') },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /mixed SEED-WRITE banners/);
});

test('checkBatchEligibility: --force bypasses execModel/seed-write but never count, resolvability, or (plan 1427 Gate 2) stage', () => {
  const execAndSeedMismatchOnly = [
    { id: '1', path: 'p', content: fm({ stage: 'specced' }, 'NO') },
    { id: '2', path: 'p', content: fm({ stage: 'specced', execModel: 'fable' }, 'YES') },
  ];
  assert.equal(checkBatchEligibility(execAndSeedMismatchOnly, { force: true }).ok, true);

  const unresolved = [
    { id: '1', path: null, content: null },
    { id: '2', path: 'p', content: fm() },
  ];
  const r = checkBatchEligibility(unresolved, { force: true });
  assert.equal(r.ok, false, 'force does not bypass resolvability');
  assert.match(r.reason, /not resolvable/);

  const tooFew = [{ id: '1', path: 'p', content: fm() }];
  assert.equal(
    checkBatchEligibility(tooFew, { force: true }).ok,
    false,
    'force does not bypass the 2-8 count',
  );
});

// plan 1427 Gate 2: --force USED TO bypass the stage:"specced" check too — that was a
// batch-shaped escape hatch around the exact self-pickup bypass Gate 2 closes for
// single-plan acquire. Only --stub-ok bypasses stage now.
test('checkBatchEligibility: --force alone no longer bypasses a stub-stage member (plan 1427 Gate 2)', () => {
  const withStub = [
    { id: '1', path: 'p', content: fm({ stage: 'specced' }, 'NO') },
    { id: '2', path: 'p', content: fm({ stage: 'stub' }, 'NO') },
  ];
  const r = checkBatchEligibility(withStub, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan 2 has stage "stub", batch requires "specced"/);
  assert.match(r.reason, /--stub-ok/);
});

test('checkBatchEligibility: --stub-ok DOES bypass a stub-stage member', () => {
  const withStub = [
    { id: '1', path: 'p', content: fm({ stage: 'specced' }, 'NO') },
    { id: '2', path: 'p', content: fm({ stage: 'stub' }, 'NO') },
  ];
  assert.equal(checkBatchEligibility(withStub, { stubOk: true }).ok, true);
});

test('checkBatchEligibility: a homogeneous specced/sonnet batch is eligible', () => {
  const members = [
    { id: '1', path: 'p', content: fm() },
    { id: '2', path: 'p', content: fm() },
  ];
  assert.equal(checkBatchEligibility(members).ok, true);
});

// plan 1427 review F1: a member can read stage:"specced" (passing the plain stage check)
// while still carrying `specReview: exempt-mechanical` on a 🟥 plan whose body mentions a
// Gate-1 pipeline-owned field — the exact narrowing single-plan acquire always applies via
// checkStubClaimGate. checkBatchEligibility must run that SAME narrowing per member, or a
// batch claim is a structural bypass of it.
function fmExempt({ seedWrite = 'YES', mentionsField = true } = {}) {
  return [
    '---',
    'stage: specced',
    'execModel: sonnet',
    'specReview: exempt-mechanical',
    '---',
    '',
    '# T',
    '',
    `> ${seedWrite === 'YES' ? '🟥' : '🟩'} **${MUTATION_BANNER_LABEL}: ${seedWrite}** — desc.`,
    '',
    mentionsField ? 'Body mentions acceptsAcuteCases in passing.' : 'Body has nothing special.',
    '',
  ].join('\n');
}

test('checkBatchEligibility: F1 — a member with specReview:exempt-mechanical + 🟥 + Gate-1 field mention is refused', () => {
  const members = [
    { id: '1', path: 'p', content: fm({}, 'YES') },
    { id: '2', path: 'p', content: fmExempt({ seedWrite: 'YES', mentionsField: true }) },
  ];
  const r = checkBatchEligibility(members, { pipelineFields: PIPELINE_FIELDS });
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan 2: /);
  assert.match(r.reason, /exempt-mechanical/);
});

test('checkBatchEligibility: F1 — the same member PASSES with --stub-ok (explicit operator override)', () => {
  const members = [
    { id: '1', path: 'p', content: fm({}, 'YES') },
    { id: '2', path: 'p', content: fmExempt({ seedWrite: 'YES', mentionsField: true }) },
  ];
  assert.equal(
    checkBatchEligibility(members, { stubOk: true, pipelineFields: PIPELINE_FIELDS }).ok,
    true,
  );
});

test('checkBatchEligibility: F1 — a 🟩 exempt-mechanical member (no seed-write) still passes', () => {
  const members = [
    { id: '1', path: 'p', content: fm() },
    { id: '2', path: 'p', content: fmExempt({ seedWrite: 'NO', mentionsField: true }) },
  ];
  assert.equal(checkBatchEligibility(members).ok, true);
});

test('boardBatchPlanClaimCell: appends a batch pointer after boardPlanClaimCell, still lint-valid', () => {
  const cell = boardBatchPlanClaimCell({
    batchSlug: 'batch-2026-07-03-x',
    slug: '1362-DQ-a',
    planRef: 'in-progress/1362-DQ-a.md',
    sessionNum: 5,
    host: 'H',
    seedWrite: 'no',
  });
  assert.match(cell, /`in-progress\/1362-DQ-a\.md`/);
  assert.match(cell, /· batch=`batch-2026-07-03-x`/);
  assert.equal(
    extractPlanRefs(cell).length,
    1,
    'the appended batch pointer does not confuse the board lint',
  );
});

test('isWaitingFolder: true for waiting-* folders, false for ready/in-progress/undefined', () => {
  assert.equal(isWaitingFolder('waiting-operator'), true);
  assert.equal(isWaitingFolder('waiting-blocked'), true);
  assert.equal(isWaitingFolder('waiting-date'), true);
  assert.equal(isWaitingFolder('waiting-trip'), true);
  assert.equal(isWaitingFolder('ready'), false);
  assert.equal(isWaitingFolder('in-progress'), false);
  assert.equal(isWaitingFolder(undefined), false);
});

// ── plan 2353: `acquire --resume` takeovers ───────────────────────────────────
// A takeover flips a plan that is ALREADY in in-progress/ (its previous holder's
// refs/claims lock having been released first), so it is the one claim path that
// routinely rewrites a Status block the claim path itself wrote.

test('flipStatusToInProgress: srcFolder in-progress adds a Takeover line, not a waiting-gate Override', () => {
  const body =
    '# T\n\n**Status:** 🔄 IN PROGRESS — picked up 2026-07-24 by `DEAD` in `worktree-x`.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '2353-x',
    date: '2026-07-25',
    srcFolder: 'in-progress',
  });
  assert.match(
    out,
    /\*\*Takeover:\*\* resumed 2026-07-25 by `PC1` via `claim-plan acquire --resume`/,
  );
  assert.match(out, /previous holder's `refs\/claims\/` lock was released/);
  assert.doesNotMatch(out, /\*\*Override:\*\* operator pickup/, 'not a waiting-gate override');
  // the prior holder's Status is still captured as the previous value
  assert.match(out, /\*\*Previous status:\*\* 🔄 IN PROGRESS — picked up 2026-07-24 by `DEAD`/);
});

test('flipStatusToInProgress: a fresh ready/ claim gets NO Takeover line', () => {
  const body = '# T\n\n**Status:** 📋 READY — opened 2026-07-25.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '2353-x',
    date: '2026-07-25',
    srcFolder: 'ready',
  });
  assert.doesNotMatch(out, /\*\*Takeover:\*\*/);
});

// The reason this path matches STATUS_BLOCK_RX rather than a bare Status LINE: a
// CHAINED resume (holder dies → takeover → that session also dies → second takeover)
// must REPLACE the prior status block, not stack a second undated history beneath it.
test('flipStatusToInProgress: a chained second resume REPLACES the prior block — annotations never stack', () => {
  const first = flipStatusToInProgress(
    '# T\n\n**Status:** 📋 READY — opened 2026-07-20.\n\nbody\n',
    { host: 'A', slug: '2353-x', date: '2026-07-24', srcFolder: 'in-progress' },
  );
  const second = flipStatusToInProgress(first, {
    host: 'B',
    slug: '2353-x',
    date: '2026-07-25',
    srcFolder: 'in-progress',
  });
  assert.equal(
    (second.match(/\*\*Takeover:\*\*/g) || []).length,
    1,
    'exactly one Takeover line survives',
  );
  assert.equal(
    (second.match(/\*\*Previous status:\*\*/g) || []).length,
    1,
    'exactly one Previous-status line survives',
  );
  assert.equal((second.match(/\*\*Status:\*\*/g) || []).length, 1);
  assert.match(second, /\*\*Takeover:\*\* resumed 2026-07-25 by `B`/, 'the newest takeover wins');
  // the immediately-prior Status (A's) is what carries forward, not the original READY
  assert.match(second, /\*\*Previous status:\*\* 🔄 IN PROGRESS — picked up 2026-07-24 by `A`/);
});

test('flipStatusToInProgress: a waiting-gate Override does not stack across a later claim either', () => {
  const first = flipStatusToInProgress('# T\n\n**Status:** 📋 READY — x.\n\nbody\n', {
    host: 'A',
    slug: '2353-x',
    date: '2026-07-24',
    srcFolder: 'waiting-operator',
  });
  assert.match(first, /\*\*Override:\*\* operator pickup/);
  const second = flipStatusToInProgress(first, {
    host: 'B',
    slug: '2353-x',
    date: '2026-07-25',
    srcFolder: 'ready',
  });
  assert.doesNotMatch(second, /\*\*Override:\*\*/, 'the stale gate override does not survive');
});

test('flipStatusToInProgress: a takeover that ALSO bypassed the stub gate carries both lines', () => {
  const body =
    '# T\n\n**Status:** 🔄 IN PROGRESS — picked up 2026-07-24 by `DEAD` in `worktree-x`.\n\nbody\n';
  const out = flipStatusToInProgress(body, {
    host: 'PC1',
    slug: '2353-x',
    date: '2026-07-25',
    srcFolder: 'in-progress',
    stubOk: 'operator ok',
  });
  assert.match(out, /\*\*Takeover:\*\*/);
  assert.match(out, /\*\*Override:\*\* claimed via `--stub-ok`/);
});

// ── plan 2460 Phase 2: executor-provenance stamp ──────────────────────────────
// normalizeExecutorProvenance + the widened board-cell composers. The session-stub side
// (sessionEntryStub/batchSessionEntryStub, which live in claim-plan.mjs) is covered in
// claim-plan.test.mjs.

test('normalizeExecutorProvenance: absent input defaults to interactive/unlabeled', () => {
  assert.deepEqual(normalizeExecutorProvenance({}), {
    modelId: 'unlabeled',
    dispatchMode: 'interactive',
  });
  assert.deepEqual(normalizeExecutorProvenance(), {
    modelId: 'unlabeled',
    dispatchMode: 'interactive',
  });
  assert.deepEqual(normalizeExecutorProvenance({ modelId: undefined, dispatchMode: undefined }), {
    modelId: 'unlabeled',
    dispatchMode: 'interactive',
  });
});

test('normalizeExecutorProvenance: every valid dispatch mode passes through, trimmed', () => {
  for (const mode of DISPATCH_MODES) {
    const r = normalizeExecutorProvenance({
      modelId: 'claude-sonnet-5',
      dispatchMode: ` ${mode} `,
    });
    assert.equal(r.dispatchMode, mode);
    assert.equal(r.modelId, 'claude-sonnet-5');
  }
});

test('normalizeExecutorProvenance: throws on an invalid dispatch mode, naming the valid list', () => {
  assert.throws(
    () => normalizeExecutorProvenance({ dispatchMode: 'typo-mode' }),
    /invalid --dispatch-mode "typo-mode".*cloud-drain.*orchestrate-worker.*local-drain-inline.*interactive/s,
  );
});

test('normalizeExecutorProvenance: throws on a backtick/pipe/newline in modelId', () => {
  assert.throws(
    () => normalizeExecutorProvenance({ modelId: 'claude`sonnet', dispatchMode: 'interactive' }),
    /--model-id/,
  );
  assert.throws(
    () => normalizeExecutorProvenance({ modelId: 'claude|sonnet', dispatchMode: 'interactive' }),
    /--model-id/,
  );
  assert.throws(
    () => normalizeExecutorProvenance({ modelId: 'claude\nsonnet', dispatchMode: 'interactive' }),
    /--model-id/,
  );
  // A backtick/pipe/newline in dispatchMode always fails the DISPATCH_MODES membership check
  // instead (no valid mode contains those characters — the table-breaking check applies to
  // modelId only, sonnet-review 2026-07-26) — assert it throws, not which message wins.
  assert.throws(() => normalizeExecutorProvenance({ dispatchMode: 'cloud`drain' }));
});

test('normalizeExecutorProvenance: throws on an unsubstituted placeholder in modelId', () => {
  assert.throws(
    () =>
      normalizeExecutorProvenance({
        modelId: '<the model you are running as>',
        dispatchMode: 'cloud-drain',
      }),
    /--model-id ".*" looks like an unsubstituted placeholder/,
  );
  assert.throws(
    () => normalizeExecutorProvenance({ modelId: 'claude-opus-5>', dispatchMode: 'interactive' }),
    /--model-id/,
  );
  // A real resolved model id contains neither character and passes through unchanged.
  assert.deepEqual(
    normalizeExecutorProvenance({ modelId: 'claude-opus-5', dispatchMode: 'interactive' }),
    { modelId: 'claude-opus-5', dispatchMode: 'interactive' },
  );
});

test('boardPlanClaimCell: emits the exec=/model= segment, defaulted when omitted', () => {
  const withStamp = boardPlanClaimCell({
    slug: '2460-Coord-x',
    sessionNum: 5,
    host: 'H',
    seedWrite: 'no',
    modelId: 'claude-opus-5',
    dispatchMode: 'orchestrate-worker',
  });
  assert.match(withStamp, /exec=`orchestrate-worker` model=`claude-opus-5`/);

  const bare = boardPlanClaimCell({
    slug: '2460-Coord-y',
    sessionNum: 6,
    host: 'H',
    seedWrite: 'no',
  });
  assert.match(bare, /exec=`interactive` model=`unlabeled`/);
});

test('boardBatchPlanClaimCell: inherits the exec=/model= segment AND still appends batch=', () => {
  const cell = boardBatchPlanClaimCell({
    batchSlug: 'batch-2026-07-26-x',
    slug: '1362-DQ-a',
    planRef: 'in-progress/1362-DQ-a.md',
    sessionNum: 5,
    host: 'H',
    seedWrite: 'no',
    modelId: 'claude-sonnet-5',
    dispatchMode: 'cloud-drain',
  });
  assert.match(cell, /exec=`cloud-drain` model=`claude-sonnet-5`/);
  assert.match(cell, /· batch=`batch-2026-07-26-x`/);
  // the exec=/model= segment must land BEFORE the trailing batch= pointer, else the batch
  // pointer would no longer be the LAST token (a downstream parser split on it would break).
  assert.ok(cell.indexOf('exec=') < cell.indexOf('batch='));
});

// plan 2556 REVIEW finding 2: homogeneity alone is not enough. The pre-2556 gate demanded an
// exact `sonnet`, so a typo was refused BY NAME; a bare same-value check would accept a batch
// whose members all share the SAME typo, and queue-drain reads anything-not-`fable` as the
// sonnet pool — so it would silently execute as sonnet with nothing having validated it.
test('checkBatchEligibility: a UNIFORM but unrecognized execModel is refused (no strictness lost)', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'sonet' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sonet' }) },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognized execModel in batch \(1="sonet", 2="sonet"\)/);
  assert.match(r.reason, /must be one of sonnet \/ fable/);
});

// plan 3341 correctness fix: `--force` overrides a POLICY judgment (mixed lane, mixed
// SEED-WRITE banner) — it never rescues a value `resolveExecLane` cannot resolve at all.
// This used to pass (the bug this fix closes): the unknown-value check ran only when
// `force` was false, so a forced batch could admit a member whose execModel nothing
// downstream can execute — exactly the silently-broken state the gate exists to prevent.
test('checkBatchEligibility: --force does NOT rescue an unrecognized/malformed execModel (plan 3341)', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'sonet' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sonet' }) },
  ];
  const r = checkBatchEligibility(members, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognized execModel in batch/);
  assert.match(r.reason, /cannot rescue this/);
});

// A prototype-pollution-shaped value (`constructor`, `toString`, …) is exactly as
// unresolvable as a plain typo — `resolveExecLane` throws on it (see the resolver's own
// own-property fix), so it must be refused here too, force included.
test('checkBatchEligibility: --force does NOT rescue a batch carrying a prototype-key execModel', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'constructor' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'constructor' }) },
  ];
  const r = checkBatchEligibility(members, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unrecognized execModel in batch/);
});

// The unrecognized-value check runs BEFORE the mixed-lane check, so a batch that is both
// mixed AND typo'd reports the typo — the actionable defect.
test('checkBatchEligibility: an unrecognized value is reported ahead of the mixed-lane verdict', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'fable' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sonet' }) },
  ];
  assert.match(checkBatchEligibility(members).reason, /unrecognized execModel/);
});

// plan 3341 ruling (orchestrator decision, overrides an earlier draft): `sol` is
// DELIBERATELY EXCLUDED from BATCH_LANES — a sol plan is executed by a single
// Opus-orchestrated session dispatching `codex exec`, so no batch conductor exists for it
// at all, ever. Recognized as a real lane (not an "unrecognized" typo) but refused as
// non-batchable, distinctly, regardless of what it's homogeneous-with or mixed with.
test('checkBatchEligibility: an ALL-SOL batch is refused as non-batchable, never silently eligible (plan 3341)', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'sol' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sol' }) },
  ];
  const r = checkBatchEligibility(members);
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-batchable lane \(1=sol, 2=sol\)/);
  assert.match(r.reason, /no batch conductor for it at all/);
  assert.match(r.reason, /not the right tool here/);
});

test('checkBatchEligibility: a sol member mixed with a sonnet/fable sibling is STILL refused as non-batchable (not "mixed execModel")', () => {
  const withSonnet = [
    { id: '1', path: 'p', content: fm({ execModel: 'sol' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sonnet' }) },
  ];
  const r1 = checkBatchEligibility(withSonnet);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /non-batchable lane \(1=sol\)/);
  assert.doesNotMatch(r1.reason, /mixed execModel/);

  const withFable = [
    { id: '1', path: 'p', content: fm({ execModel: 'sol' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'fable' }) },
  ];
  const r2 = checkBatchEligibility(withFable);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /non-batchable lane \(1=sol\)/);
});

test('checkBatchEligibility: --force does NOT rescue a sol batch — non-batchable is structural, not a policy override', () => {
  const members = [
    { id: '1', path: 'p', content: fm({ execModel: 'sol' }) },
    { id: '2', path: 'p', content: fm({ execModel: 'sol' }) },
  ];
  const r = checkBatchEligibility(members, { force: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /non-batchable lane/);
});

// plan 3341: EXEC_LANE_TABLE / resolveExecLane — the fail-closed lane resolver every
// `execModel === 'fable'` ternary elsewhere should migrate to.
test('EXEC_LANE_TABLE: carries all three lanes with the documented shape', () => {
  assert.deepEqual(Object.keys(EXEC_LANE_TABLE), ['sonnet', 'fable', 'sol']);
  assert.equal(EXEC_LANE_TABLE.sonnet.icon, '🟢');
  assert.equal(EXEC_LANE_TABLE.fable.icon, '🟣');
  assert.equal(EXEC_LANE_TABLE.sol.icon, '🔶');
  assert.equal(EXEC_LANE_TABLE.sonnet.label, 'sonnet drain');
  assert.equal(EXEC_LANE_TABLE.fable.label, 'fable drain');
  assert.equal(EXEC_LANE_TABLE.sol.label, 'sol lane');
  assert.equal(EXEC_LANE_TABLE.sonnet.drainClaimable, true);
  assert.equal(EXEC_LANE_TABLE.fable.drainClaimable, true);
  // plan 3461 (operator ruling 2026-08-26) reverses plan 3341's opt-in-only clause: `sol`
  // is now drain-claimable too — the drains learn to drive a Sol seat instead of refusing
  // it. `batchable` stays false regardless: batchability is structural (a `sol` plan is one
  // Opus-orchestrated session dispatching `codex exec`, with no batch conductor at all),
  // orthogonal to whether a single such plan can be claimed and executed alone.
  assert.equal(EXEC_LANE_TABLE.sol.drainClaimable, true);
  // hasNativeRun = "does this lane get its own dedicated `--lane` oracle run" — a DIFFERENT
  // axis from drainClaimable (see the table's own header comment for why the two must never
  // be conflated again). True for sonnet (the default run) and fable (`--lane fable`); false
  // for sol — plan 3461 made it drain-claimable without inventing a `--lane sol` value, so a
  // sol plan rides BOTH the sonnet and fable runs instead of getting one of its own.
  assert.equal(EXEC_LANE_TABLE.sonnet.hasNativeRun, true);
  assert.equal(EXEC_LANE_TABLE.fable.hasNativeRun, true);
  assert.equal(EXEC_LANE_TABLE.sol.hasNativeRun, false);
  // batchable = "does ANY conductor exist for a batch of this lane" — true for both sonnet
  // (batch-train) and fable (a heavy session / fable-full's Fable-batch section, per the
  // plan-2556 all-fable-batch precedent); false ONLY for sol, which has none at all.
  assert.equal(EXEC_LANE_TABLE.sonnet.batchable, true);
  assert.equal(EXEC_LANE_TABLE.fable.batchable, true);
  assert.equal(EXEC_LANE_TABLE.sol.batchable, false);
  assert.equal(EXEC_LANE_TABLE.sol.needsCodexTransport, true);
  assert.equal(EXEC_LANE_TABLE.sonnet.needsCodexTransport, false);
  assert.equal(EXEC_LANE_TABLE.fable.needsCodexTransport, false);
});

test('EXEC_LANE_TABLE is frozen (a caller cannot mutate a shared entry)', () => {
  assert.throws(() => {
    'use strict';
    EXEC_LANE_TABLE.sonnet = { lane: 'nope' };
  });
  assert.equal(EXEC_LANE_TABLE.sonnet.lane, 'sonnet');
});

test('resolveExecLane: a recognized lane returns its EXEC_LANE_TABLE entry', () => {
  assert.equal(resolveExecLane('sonnet'), EXEC_LANE_TABLE.sonnet);
  assert.equal(resolveExecLane('fable'), EXEC_LANE_TABLE.fable);
  assert.equal(resolveExecLane('sol'), EXEC_LANE_TABLE.sol);
});

test('resolveExecLane: is case/whitespace-insensitive', () => {
  assert.equal(resolveExecLane('  SOL  '), EXEC_LANE_TABLE.sol);
  assert.equal(resolveExecLane('Fable'), EXEC_LANE_TABLE.fable);
});

test('resolveExecLane: absent/blank reads as sonnet (the documented default)', () => {
  assert.equal(resolveExecLane(undefined), EXEC_LANE_TABLE.sonnet);
  assert.equal(resolveExecLane(null), EXEC_LANE_TABLE.sonnet);
  assert.equal(resolveExecLane(''), EXEC_LANE_TABLE.sonnet);
  assert.equal(resolveExecLane('   '), EXEC_LANE_TABLE.sonnet);
});

test('resolveExecLane: THROWS on an unrecognized value — never silently defaults to sonnet', () => {
  assert.throws(() => resolveExecLane('opus'), /unrecognized execModel "opus"/);
  assert.throws(() => resolveExecLane('sonet'), /must be one of sonnet \/ fable \/ sol/);
});

// plan 3341 correctness fix: EXEC_LANE_TABLE is a plain object literal, so a bare
// `EXEC_LANE_TABLE[trimmed]` lookup resolves an INHERITED Object.prototype key
// (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, …) to a truthy value instead of
// falling through to the throw — defeating the resolver's whole purpose, which is to fail
// loud on anything it doesn't recognize rather than let it route somewhere.
test('resolveExecLane: THROWS on an inherited Object.prototype key, never resolves it as a lane', () => {
  assert.throws(() => resolveExecLane('constructor'), /unrecognized execModel "constructor"/);
  assert.throws(() => resolveExecLane('toString'), /unrecognized execModel "toString"/);
  assert.throws(() => resolveExecLane('valueOf'), /unrecognized execModel "valueOf"/);
  assert.throws(() => resolveExecLane('hasOwnProperty'), /unrecognized execModel "hasOwnProperty"/);
});

// ───────────────────────── plan 3341 success criterion: "no binary lane ternary survives
// outside the resolver" ─────────────────────────────────────────────────────────────────────
//
// What this guard checks (and what it deliberately does NOT try to check — read this before
// trusting or extending it):
//
// SCOPE: the flat `scripts/*.mjs` file list (non-recursive — verified empirically at write
// time that no file under scripts/hooks/, scripts/lib/, scripts/test-helpers/, scripts/generated/,
// or scripts/fb-responder/ mentions "fable" in any casing at all, so widening the walk into
// those directories would add cost for zero coverage today; re-verify if that ever changes),
// excluding `*.test.mjs` (fixtures/assertions legitimately compare against the literal, and are
// explicitly out of scope for this criterion — see the plan's own "Test-harness pointers" note)
// and excluding `claim-plan-lib.mjs` itself (the resolver's home — EXEC_LANE_TABLE's keys and
// resolveExecLane's own body necessarily mention 'fable').
//
// RULE (a real lookup, not a bare grep for the word "fable" — that would fire on every filename
// marker ('-FABLE-'), category string ('FABLE-Pipe'), and doctrine comment/print string in the
// corpus): a line is flagged only when it contains BOTH (a) the case-insensitive substring
// "execmodel" — the raw frontmatter FIELD NAME, present in every genuine hazard site's own
// identifier (`execModel`, `rawExecModel`, `readExecModel(...)`) precisely because that is what
// makes it a read of the UNVALIDATED value rather than an already-resolved one — AND (b) a
// `===`/`!==` comparison against the literal `'fable'`/`"fable"` (either operand order) on that
// SAME physical line. This is why `execLane.lane === 'fable'` (claim-plan.mjs, dispatching on an
// object resolveExecLane already returned), `m.exclude === 'fable'` / `requestedLane === 'fable'`
// (queue-drain.mjs), `r.lane === 'fable'` (ready-board.mjs), `lane === 'fable'`
// (cloud-routine-prompt-lib.mjs, gated by its own throwing `assertAxes`), and `m === 'fable'`
// (mine-spec-pass-effort-arms.mjs — a CLAUDE MODEL name, "fable-5" vs "opus-5", nothing to do
// with the execModel lane enum at all) all correctly do NOT match: none of their compared
// identifiers contain "execmodel".
//
// A flagged line clears only if EITHER: the containing file imports `resolveExecLane` from
// `./claim-plan-lib.mjs` anywhere (empirically, every current execmodel-vs-'fable' comparison in
// such a file — batches-view.mjs's `raw === 'fable'` feeding its own `key`, done-worktree.mjs's
// `rawExecModel === 'fable'` feeding `effectiveExecModel` — is a pre-resolver NORMALIZATION step
// whose result is handed to `resolveExecLane(...)` a few lines later, never a standalone binary
// fork), OR the line (or the contiguous `//`/`/* `-comment block immediately above it) carries a
// waiver: `// exec-lane-ok: <reason>` — the same convention `assert-posix-path-assertions.mjs`
// uses for `path-assert-ok`/`platform-assert-ok`.
//
// KNOWN BLIND SPOTS (a structural regex guard, not an AST/dataflow one — real limits, not just
// caveats):
//   1. Line-based: a comparison split across lines (`execModel ===\n  'fable'`) is MISSED.
//   2. Whole-line comments only strip lines that ARE a comment; an inline trailing `//` comment
//      on a code line, or a `/* block comment */` whose continuation lines don't start with `*`,
//      is not stripped — could theoretically self-false-positive (not observed in this corpus).
//   3. The resolver-import exemption is FILE-level, not call-site-level: importing
//      `resolveExecLane` anywhere clears EVERY execmodel-vs-'fable' line in that whole file, even
//      a hypothetical second, unrelated one elsewhere that never reaches the resolver. Verified
//      by hand against every real hit in the corpus at write time; not structurally enforced.
//   4. The single biggest gap: this is a NAMING-CONVENTION signal, not a semantic one. A raw
//      frontmatter read stored into a variable that does NOT carry "execModel" in its name (e.g.
//      `const x = readFrontmatterScalar(content, 'execModel'); if (x === 'fable') …`) is INVISIBLE
//      to this guard. It holds today because every genuine site's own identifier happens to name
//      the field — that is a fact about the current corpus, not a property this test enforces.
//
// Given blind spot 4, this guard is deliberately narrower than the plan's literal wording ("no
// binary ternary survives outside the resolver") might suggest: it is a NECESSARY, not sufficient,
// check for that property. It reliably catches the exact shape every real hazard site in this
// plan's own table took (a raw `execModel`-named read compared directly to 'fable'), and it
// reliably does NOT fire on the safe post-resolution dispatches the conversion produced — but it
// cannot prove no other shape of misroute exists. That is a fair trade for a test that stays
// trustworthy rather than one broad enough to need waiving on sight.

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

// Mirrors assert-posix-path-assertions.mjs's isCommentLine (JS-only here): a WHOLE line is a
// comment when, trimmed, it starts with `//`, `/*`, or a JSDoc-style `*` continuation. Does not
// track block-comment nesting/spans — see blind spot 2 above.
function isWholeLineComment(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || /^\*(?:\s|\/|$)/.test(t);
}

// `// exec-lane-ok: <reason>` — a non-empty reason required, same shape as path-assert-ok /
// platform-assert-ok (assert-posix-path-assertions.mjs) so this repo keeps exactly one waiver
// grammar rather than growing a second one for a second lint.
const EXEC_LANE_WAIVER_RX = /\/\/\s*exec-lane-ok:\s*\S/;

// Is line `i` waived by a `// exec-lane-ok:` on itself or on the CONTIGUOUS comment block
// immediately above it? Stops at the first non-comment line above, so a waiver can only ever
// apply to the statement it sits directly on top of (or beside).
function waivedForExecLane(lines, i) {
  if (EXEC_LANE_WAIVER_RX.test(lines[i])) return true;
  for (let j = i - 1; j >= 0 && isWholeLineComment(lines[j]); j--) {
    if (EXEC_LANE_WAIVER_RX.test(lines[j])) return true;
  }
  return false;
}

// Both halves of the rule, checked independently on one physical line (see the header comment
// for why this is a same-line substring pairing rather than a single adjacency regex).
const EXECMODEL_TOKEN_RX = /execmodel/i;
const FABLE_LITERAL_COMPARE_RX = /[!=]==\s*['"]fable['"]|['"]fable['"]\s*[!=]==/;

test("no binary execModel-vs-'fable' comparison survives outside the resolver in non-test scripts/*.mjs (plan 3341)", () => {
  const files = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'claim-plan-lib.mjs')
    .sort();
  // Sanity floor: if this ever reads as empty, the walk is broken (wrong directory, wrong
  // filter), not that the corpus genuinely has zero non-test .mjs files — fail loudly rather
  // than silently "passing" on nothing.
  assert.ok(
    files.length > 50,
    `expected the scripts/ non-test .mjs corpus, got ${files.length} files`,
  );

  const violations = [];
  for (const f of files) {
    const path = scriptFile(f, SCRIPTS_DIR);
    const content = readFileSync(path, 'utf8');
    const importsResolver =
      /from\s+['"]\.\/claim-plan-lib\.mjs['"]/.test(content) && /\bresolveExecLane\b/.test(content);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isWholeLineComment(line)) continue;
      if (!EXECMODEL_TOKEN_RX.test(line) || !FABLE_LITERAL_COMPARE_RX.test(line)) continue;
      if (importsResolver || waivedForExecLane(lines, i)) continue;
      violations.push(`${f}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `binary execModel-vs-'fable' comparison(s) outside the resolver — convert to resolveExecLane, ` +
      `or waive in place with "// exec-lane-ok: <reason>" if genuinely safe:\n${violations.join('\n')}`,
  );
});
