// scripts/coord/wiki-log-lint.test.mjs — tests for the wiki/log.md structural lint + dedupe
// (plan 2764).
//
// NEW-TEST-FILE JUSTIFICATION (CLAUDE.md § pre-land checks): this is the name-pair of a
// genuinely new module, scripts/coord/wiki-log-lint.mjs. There is no existing name-paired test file
// to fold into — wiki-size-lint.test.mjs covers page BUDGETS (bytes per injection class), a
// different module with a different subject.
//
// Pure functions only: no git, no network, no fixture repo.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_REL,
  JOURNAL_HEADING,
  JOURNAL_INTRO,
  parseJournal,
  scanJournal,
  lineMultiset,
  dedupeJournalText,
  checkNoNewDuplication,
  checkJournalOrThrow,
} from './wiki-log-lint.mjs';

/**
 * A minimal well-formed journal: heading, intro, then newest-first entries, ending in a blank
 * line. The trailing blank matters: it is what the live corpus carries, and it is why each of
 * the eight concatenated copies of wiki/log.md opens with a blank-line-preceded heading
 * (verified on the real blob) — so `journal(x) + journal(x)` here reproduces the real
 * doubling's shape rather than a glued one.
 */
function journal(entries) {
  return (
    [JOURNAL_HEADING, '', JOURNAL_INTRO, '', ...entries.flatMap((e) => [e, ''])].join('\n') + '\n'
  );
}

const E1 = '- 2026-08-03 — plan 2765 landed.';
const E2 = '- 2026-08-02 — plan 2726 landed.';
const E3 = '- 2026-07-30 — plan 2651 landed.';

test('parseJournal splits entries on the bullet, not on blank lines', () => {
  // Whole regions of the live journal carry consecutive `- ` lines with no blank between
  // them; a run-of-non-blank-lines model fuses them into one block and the dedupe then finds
  // almost nothing to collapse (the first cut of this module scored 470 "entries" for 5 900).
  const text = [JOURNAL_HEADING, '', JOURNAL_INTRO, '', E1, E2, E3, ''].join('\n');
  const { entries, headings, intros } = parseJournal(text);
  assert.equal(headings.length, 1);
  assert.equal(intros.length, 1);
  assert.deepEqual(
    entries.map((e) => e.lines[0]),
    [E1, E2, E3],
  );
});

test('a continuation line travels with its entry, with or without a preceding blank', () => {
  const glued = 'trailing half of a wrapped code span`';
  const detached = '---';
  const text = [
    JOURNAL_HEADING,
    '',
    JOURNAL_INTRO,
    '',
    E1,
    glued, // no blank before it — a wrapped entry
    '',
    detached, // blank-separated stray, still belongs to E1
    '',
    E2,
    '',
  ].join('\n');
  const { entries } = parseJournal(text);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].lines, [E1, glued, '', detached]);
  assert.deepEqual(entries[1].lines, [E2]);
});

test('scanJournal counts headings and redundant entries', () => {
  const clean = scanJournal(journal([E1, E2, E3]));
  assert.equal(clean.headingCount, 1);
  assert.equal(clean.entryCount, 3);
  assert.equal(clean.uniqueEntryCount, 3);
  assert.equal(clean.duplicateEntryCount, 0);
  assert.deepEqual(clean.violations, []);

  const doubled = scanJournal(journal([E1, E2]) + journal([E1, E2]));
  assert.equal(doubled.headingCount, 2);
  assert.equal(doubled.duplicateEntryCount, 2);
  assert.deepEqual(doubled.violations.map((v) => v.kind).sort(), [
    'duplicate-entry',
    'multiple-heading',
  ]);
});

test('dedupe collapses an N-fold concatenation to one copy, losing nothing', () => {
  const one = journal([E1, E2, E3]);
  const eightfold = one.repeat(8);
  const { text, lost, stats } = dedupeJournalText(eightfold);

  assert.deepEqual(lost, [], 'set equality: no distinct line may be lost');
  assert.equal(stats.distinctLinesBefore, stats.distinctLinesAfter);
  assert.equal(stats.headingsAfter, 1);
  assert.equal(stats.entriesAfter, 3);
  assert.equal(stats.uniqueEntries, 3);
  assert.equal(stats.duplicatesRemoved, 21); // 24 entry occurrences, 3 unique

  // Every entry present exactly once, and the rebuilt file is itself clean.
  const after = scanJournal(text);
  assert.equal(after.duplicateEntryCount, 0);
  assert.equal(after.headingCount, 1);
  // ... and idempotent: a second pass changes nothing.
  assert.equal(dedupeJournalText(text).text, text);
});

test('dedupe emits strict newest-first order, stable within a date', () => {
  const a = '- 2026-07-01 — first same-day entry.';
  const b = '- 2026-07-01 — second same-day entry.';
  const scrambled = journal([E3, b, E1, a, E2]);
  const { text } = dedupeJournalText(scrambled);
  const order = text
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2, 12));
  assert.deepEqual(order, ['2026-08-03', '2026-08-02', '2026-07-30', '2026-07-01', '2026-07-01']);
  // Ties keep source order (b appeared before a in the input).
  const sameDay = text.split('\n').filter((l) => l.startsWith('- 2026-07-01'));
  assert.deepEqual(sameDay, [b, a]);
});

test('an undated entry is preserved and sorts last', () => {
  const undated = '- no date on this one at all.';
  const { text, lost } = dedupeJournalText(journal([E1, undated, E2]));
  assert.deepEqual(lost, []);
  const bullets = text.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(bullets, [E1, E2, undated]);
});

test('checkNoNewDuplication ignores a normal append onto an ALREADY dirty master', () => {
  // The delta property that avoids a flag day: the guard lands before the one-shot cleanup,
  // so on a master that still carries N copies an ordinary sibling append must still pass.
  const dirty = journal([E2, E3]).repeat(8);
  const appended = journal([E1, E2, E3]).repeat(1) + journal([E2, E3]).repeat(7);
  assert.equal(checkNoNewDuplication(dirty, dirty), null, 'a no-op write is clean');
  // An append that leaves the duplicate count no higher than master's is admitted.
  const before = scanJournal(dirty).duplicateEntryCount;
  const after = scanJournal(appended).duplicateEntryCount;
  assert.ok(after <= before);
  assert.equal(checkNoNewDuplication(dirty, appended), null);
});

test('checkNoNewDuplication fires on the plan-2764 doubling signature', () => {
  const master = journal([E1, E2, E3]);
  // The observed shape: the caller's copy (which already holds master's content) with
  // master's blob appended to it again.
  const doubled = master + master;
  const v = checkNoNewDuplication(master, doubled);
  assert.ok(v, 'a whole-file doubling must be refused');
  assert.equal(v.kind, 'introduced-duplication');
  assert.equal(v.headingGrew, true);
  assert.equal(v.dupsGrew, true);
  assert.equal(v.before.headingCount, 1);
  assert.equal(v.after.headingCount, 2);
});

test('checkNoNewDuplication admits a clean write onto a page absent from master', () => {
  assert.equal(checkNoNewDuplication(null, journal([E1, E2])), null);
});

test('checkJournalOrThrow throws on a doubling and never on a deletion', () => {
  const master = journal([E1, E2]);
  const doubled = master + master;

  assert.throws(() => checkJournalOrThrow(master, doubled), /would ADD structural duplication/);
  // A deletion is handled by the plan-1622/1697 guards, not here.
  assert.doesNotThrow(() => checkJournalOrThrow(master, null));
  // Buffers are accepted alongside strings (wiki-commit hands it git blob Buffers).
  assert.throws(
    () => checkJournalOrThrow(Buffer.from(master), Buffer.from(doubled)),
    /would ADD structural duplication/,
  );
});

test('the refusal message names the replacing-redirect fix and the repair command', () => {
  const master = journal([E1]);
  let msg = '';
  try {
    checkJournalOrThrow(master, master + master);
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, new RegExp(JOURNAL_REL.replace('.', '\\.')));
  assert.match(msg, /never `>>`/);
  assert.match(msg, /wiki-log-lint\.mjs --fix/);
});

// ── review-round fixes (plan 2764) ────────────────────────────────────────────────────────

test('finding [1]: one byte-identical entry from a sibling session is NOT refused', () => {
  const master = journal([E1, E2]);
  // A second session appends a line that happens to render exactly like an existing one.
  const withDupe = journal([E2, E1, E2]);
  assert.equal(scanJournal(withDupe).duplicateEntryCount, 1);
  assert.equal(checkNoNewDuplication(master, withDupe), null);
  // Two repeated entries IS structural, and is still refused.
  const twoDupes = journal([E1, E2, E1, E2]);
  assert.equal(scanJournal(twoDupes).duplicateEntryCount, 2);
  assert.ok(checkNoNewDuplication(master, twoDupes));
});

test('finding [1]: a heading increase is refused regardless of the entry tolerance', () => {
  // A two-entry file doubled adds only 2 duplicate entries but always duplicates the heading,
  // so the heading arm is what makes a small doubling un-missable.
  const master = journal([E1]);
  const v = checkNoNewDuplication(master, master + master);
  assert.ok(v);
  assert.equal(v.headingGrew, true);
});

test('finding [2]: an entry quoting the heading or intro mid-body is not a new section', () => {
  const quoting = [
    JOURNAL_HEADING,
    '',
    JOURNAL_INTRO,
    '',
    E1,
    JOURNAL_HEADING, // a continuation line that happens to reproduce the heading verbatim
    JOURNAL_INTRO,
    '',
    E2,
    '',
  ].join('\n');
  const scan = scanJournal(quoting);
  assert.equal(scan.headingCount, 1, 'the quoted heading must not count as structural');
  assert.equal(scan.entryCount, 2);
  assert.deepEqual(scan.violations, []);
  // The quoted lines stay inside their entry, so the dedupe carries them.
  const { text, lost } = dedupeJournalText(quoting);
  assert.deepEqual(lost, []);
  assert.match(text, /plan 2765 landed\.\n# Wiki action log\nAppend-only\./);
});

test('finding [2]: a blank-line-preceded heading IS still structural', () => {
  // The real corpus's 8 concatenated copies each open with a blank-separated heading; the
  // finding-[2] qualifier must not blind the detector to them.
  const scan = scanJournal(journal([E1, E2]) + journal([E1, E2]));
  assert.equal(scan.headingCount, 2);
});

test('finding [2]: a GLUED doubling still trips the entry arm, heading arm or not', () => {
  // If a doubling ever concatenated with no blank before the second heading, the finding-[2]
  // qualifier would (correctly) not read that heading as structural. Detection must not
  // depend on it: the entry-duplication arm carries a real doubling on its own.
  const one = journal([E1, E2, E3]);
  const glued = one.replace(/\n+$/, '\n') + one;
  const scan = scanJournal(glued);
  assert.equal(scan.headingCount, 1, 'the glued heading is deliberately not structural');
  // The boundary entry absorbs the glued heading, so it no longer matches its twin — 3 unique
  // entries duplicate, minus that one.
  assert.equal(scan.duplicateEntryCount, 2);
  assert.equal(scan.introCount, 2, 'the intro one line down IS blank-preceded');
  const v = checkNoNewDuplication(one, glued);
  assert.ok(v, 'the doubling is still refused');
  assert.equal(v.headingGrew, false);
  assert.equal(v.introGrew, true);
  assert.equal(v.dupsGrew, true);
});

test('finding [2]: a glued doubling of a TINY journal is caught by the intro arm alone', () => {
  // The case the entry tolerance alone would miss: one entry duplicated once is +1, inside
  // DUP_ENTRY_TOLERANCE, and the glued heading is not structural.
  const one = journal([E1]);
  const glued = one.replace(/\n+$/, '\n') + one;
  const v = checkNoNewDuplication(one, glued);
  assert.ok(v, 'a tiny glued doubling must still be refused');
  assert.equal(v.headingGrew, false);
  assert.equal(v.dupsGrew, false);
  assert.equal(v.introGrew, true);
});

// ── re-review-round fixes (plan 2764) ─────────────────────────────────────────────────────

test('re-review [0]: the tolerance is an absolute floor, not a per-write ratchet', () => {
  // Written as `after > before + TOLERANCE` the guard re-baselines each round, so N writes
  // could each add one duplicate and none would ever be refused. The floor form refuses the
  // SECOND one.
  const clean = journal([E1, E2]);
  const oneDupe = journal([E2, E1, E2]);
  assert.equal(checkNoNewDuplication(clean, oneDupe), null, 'the first is tolerated');
  const twoDupes = journal([E2, E1, E2, E1]);
  assert.equal(scanJournal(twoDupes).duplicateEntryCount, 2);
  assert.ok(checkNoNewDuplication(oneDupe, twoDupes), 'the second must be refused — no ratchet');
  // And an already-dirty journal (pre-cleanup master) may still take an ordinary append.
  const dirty = journal([E1, E2]).repeat(8);
  assert.equal(checkNoNewDuplication(dirty, dirty), null);
});

test('re-review [4]: the null-prev baseline is scanJournal own zero state', () => {
  // A brand-new one-heading page is not growth; a brand-new DOUBLED page still is.
  assert.equal(checkNoNewDuplication(null, journal([E1, E2])), null);
  const v = checkNoNewDuplication(null, journal([E1, E2]).repeat(2));
  assert.ok(v);
  assert.equal(v.before.headingCount, 0, 'reports the true absent-page baseline, not a stand-in');
  assert.equal(v.before.introCount, 0);
});

test('re-review [1]: a blank-preceded bare heading line IS structural — accepted, pinned', () => {
  // Positionally indistinguishable from a real heading, because it is what one looks like.
  // The refusal message tells the author to use a code span instead.
  const quoted = [
    JOURNAL_HEADING,
    '',
    JOURNAL_INTRO,
    '',
    E1,
    '',
    JOURNAL_HEADING, // blank-preceded: counted
    '',
    E2,
    '',
  ].join('\n');
  assert.equal(scanJournal(quoted).headingCount, 2);
  let msg = '';
  try {
    checkJournalOrThrow(journal([E1, E2]), quoted);
  } catch (e) {
    msg = e.message;
  }
  assert.match(msg, /code span/);
});

test('re-review [2]: the fully-glued residual is bounded to a ≤2-entry journal', () => {
  // Both heading and intro glued: neither structural arm sees them, so the entry arm carries
  // it alone. The boundary entry absorbs the glued heading+intro and so stops matching its
  // twin, leaving N-1 duplicates for an N-entry doubling — refused from N = 3 up.
  const glue = (t) => t.replace(/\n\n/g, '\n');
  const gluedDouble = (t) => glue(t).replace(/\n+$/, '\n') + glue(t);

  const three = journal([E1, E2, E3]);
  const v3 = checkNoNewDuplication(glue(three), gluedDouble(three));
  assert.ok(v3, 'a three-entry glued doubling is refused');
  assert.equal(v3.headingGrew, false, 'both structural arms are blind to a full glue');
  assert.equal(v3.introGrew, false);
  assert.equal(v3.dupsGrew, true, 'the entry arm carries it');

  // At two entries it scores 1, inside the floor — the documented, accepted residual. This
  // journal has held hundreds of entries since 2026-05-18.
  const two = journal([E1, E2]);
  assert.equal(scanJournal(gluedDouble(two)).duplicateEntryCount, 1);
});

test('finding [7]: the duplicate detail list is opt-in', () => {
  const doubled = journal([E1, E2]) + journal([E1, E2]);
  const quiet = scanJournal(doubled).violations.find((v) => v.kind === 'duplicate-entry');
  assert.equal(quiet.worst, undefined, 'the hot guard path computes no detail');
  const loud = scanJournal(doubled, { detail: true }).violations.find(
    (v) => v.kind === 'duplicate-entry',
  );
  assert.equal(loud.worst.length, 2);
});

test('finding [6]: scanJournal accepts a pre-parsed journal and agrees with a fresh parse', () => {
  const doubled = journal([E1, E2, E3]) + journal([E1, E2, E3]);
  const parsed = parseJournal(doubled);
  assert.deepEqual(scanJournal(doubled, { parsed }), scanJournal(doubled));
});

test('lineMultiset ignores blank and trailing-whitespace-only differences', () => {
  const m = lineMultiset(['a', '   ', '', 'a', 'b   '].join('\n'));
  assert.equal(m.get('a'), 2);
  assert.equal(m.get('b'), 1);
  assert.equal(m.size, 2);
});
