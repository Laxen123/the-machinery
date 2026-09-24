// scripts/lint-index-brevity.test.mjs  (plan 639)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOverlongArchiveBullets, resolveBaseFlags } from './lint-index-brevity.mjs';

const END = '<!-- INDEX:PLANS-END -->';

// plan 3971 review r1 (A): `shortPrefixOnly` replaces the old `short` fixture, which carried
// a narrative sentence ("Did the thing.") after the merged-sha prefix — exactly the shape
// the new 'narrative' check now flags. Every "this row is fine" test below must use a
// GENUINELY prefix-only (or batch-tagged) fixture, or it would now fail on its own input.
const shortPrefixOnly = '- `001-X-foo.md` — archived 2026-06-15 (session 1), merged `abc1234`.';
const shortNarrative =
  '- `001-X-foo.md` — archived 2026-06-15 (session 1), merged `abc1234`. Did the thing.';
const shortBatchTagged =
  '- `003-X-baz.md` — archived 2026-06-15 (session 3), merged `fed6543`. — batch some-slug (2 members).';
const long =
  '- `002-X-bar.md` — archived 2026-06-15 (session 2), merged `def5678`. ' +
  'narrative '.repeat(80);

test('flags an over-cap bullet in the archive region', () => {
  const doc = ['# INDEX', END, shortPrefixOnly, long].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].preview, /002-X-bar/);
  assert.equal(offenders[0].reason, 'overlong');
});

test('passes a clean one-liner archive region (prefix-only and batch-tagged rows)', () => {
  const doc = ['# INDEX', END, shortPrefixOnly, shortBatchTagged].join('\n');
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
});

test('exempts grandfathered sole-record bullets', () => {
  const sole = '- `legacy.md` _(no archive plan file — body retained inline)_ — ' + 'x'.repeat(900);
  const doc = ['# INDEX', END, sole].join('\n');
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
});

test('ignores the generated region (before the END sentinel)', () => {
  const doc = ['# INDEX', long, END, shortPrefixOnly].join('\n'); // long bullet is ABOVE the sentinel
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
});

test('stops at the next top-level section header', () => {
  const doc = ['# INDEX', END, shortPrefixOnly, '## Reference', long].join('\n'); // long is past "## "
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
});

test('a fenced "## " inside the archive region does not end it (review r3, finding a9b8fc)', () => {
  const fencedRow =
    '- `999-Fake-fenced.md` — archived 2099-01-01 (session 1), merged `deadbee`. Drop me too.';
  const doc = [
    '# INDEX',
    END,
    shortPrefixOnly,
    '```',
    '## This looks like a heading but is inside a fence',
    '```',
    fencedRow,
  ].join('\n');
  // Before the fix, the fenced "## " line would have wrongly ended the region right there,
  // so fencedRow (past it) would never be scanned at all — no offender, silently.
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
  assert.match(offenders[0].preview, /999-Fake-fenced/);
});

// --- plan 3971 review r1 (A): the narrative-shape check ---------------------------------
// Finding 5d88dd/38662c/edab33/etc.: a length-only lint let a SHORT narrative row through,
// which no longer satisfies the prefix-only archive contract. findOverlongArchiveBullets now
// flags a spine-shaped row that condenseArchiveRow would still change, tagged reason:
// 'narrative', independent of the 'overlong' length check.

test("flags a short narrative spine row with reason: 'narrative'", () => {
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
  assert.match(offenders[0].preview, /001-X-foo/);
});

test('EXEMPT row is not flagged, even when its tail loosely resembles spine prose', () => {
  // finding 3d0901's exact shape: an EXEMPT_RX row (the real grandfathered marker,
  // `_(no archive plan file — body retained inline)_` — review r3 (finding 2197fc) ANCHORED
  // EXEMPT_RX to `^- \`name\` _(...)_`, the exact position all 4 real rows use, so a row can
  // no longer be BOTH exempt-shaped and spine-shaped at once (both compete for the position
  // right after the backtick token); its narrative IS its only surviving record either way,
  // so it must be exempt from BOTH checks, not just the length one, even when its tail
  // mentions archived/merged-shaped text.
  const exemptRow =
    '- `legacy.md` _(no archive plan file — body retained inline)_ — History mentions it was archived 2026-01-01, merged deadbee elsewhere in the sentence.';
  const doc = ['# INDEX', END, exemptRow].join('\n');
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
});

test('the grandfather marker mid-row does NOT exempt a normal spine row (review r3, finding 2197fc)', () => {
  const midRowMarker =
    '- `legacy3.md` — archived 2026-03-03 (session 3), merged `cafebabe`. _(no archive plan file — body retained inline)_ mentioned mid-row, not anchored.';
  const doc = ['# INDEX', END, midRowMarker].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

test('a row containing "no plan filed" prose is NOT exempt (review r2 negative case for the tightened EXEMPT_RX)', () => {
  // The OLD unanchored EXEMPT_RX matched the bare substring "no plan file" — real prose in
  // the wild says "...trip-condition unmet, no plan filed; future session..." (a normal
  // spine row that must condense, not a grandfathered one). The tightened regex must not.
  const row =
    '- `157-Other-test-suite-rot.md` — archived 2026-05-27 (session 117), merged `45ce4775`. ' +
    'trip-condition unmet, no plan filed; future session can read the archived plan body.';
  const doc = ['# INDEX', END, row].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

test('an overlong AND narrative-shaped row is reported once, as overlong (length wins)', () => {
  // `long` is both over CAP and narrative-shaped (it has trailing text past the merged-sha
  // prefix) — the loop reports the length violation and `continue`s before the narrative
  // check, so it never double-counts the same row under two reasons.
  const doc = ['# INDEX', END, long].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'overlong');
});

// --- plan 3971 review r1/r2 (sequencing fix): base-scoping BOTH offender reasons --------
// Review r1: the narrative check would otherwise make the lint's OWN land fail on the
// pre-existing ~3200-row backlog still on origin/master (T4, the one-time condense, hasn't
// run yet). baseContent lets a row already present on the base ref (byte-identical, mod \r)
// pass the narrative check.
// Review r2: 'overlong' gets the SAME exemption now, for the same reason — a pre-push gate
// judges what THIS PUSH adds, not the whole file's standing state (condense-archive's job).
// Review r1 originally left 'overlong' un-scoped, but that meant fixing the EXEMPT_RX false
// positive (see the "no plan filed" tests above) immediately made every push fail on a REAL,
// pre-existing 2496-char row this push never touched — condense-archive repairs it exactly
// like any other spine-shaped row, so the gate has nothing new to catch there either.

test('base-scoping: a narrative row already present in baseContent is NOT flagged', () => {
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  // The row already exists verbatim on the "base" (here, the base IS the doc itself —
  // simulating "already on origin/master").
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600, baseContent: doc }), []);
});

test('base-scoping: a narrative row ABSENT from baseContent is still flagged', () => {
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  const base = ['# INDEX', END].join('\n'); // baseContent lacks the row entirely — it's NEW
  const offenders = findOverlongArchiveBullets(doc, { cap: 600, baseContent: base });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

test('base-scoping (review r2): an overlong row already present in baseContent is now EXEMPT too (both reasons scoped identically)', () => {
  const doc = ['# INDEX', END, long].join('\n');
  // `long` already exists verbatim on the "base" (here, the base IS the doc itself) — it's
  // pre-existing, not something this push introduced, so it's exempt from 'overlong' too.
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600, baseContent: doc }), []);
});

test('base-scoping (review r2): a NEW overlong row (absent from baseContent) is still flagged', () => {
  const doc = ['# INDEX', END, shortPrefixOnly, long].join('\n');
  const base = ['# INDEX', END, shortPrefixOnly].join('\n'); // base lacks `long` entirely
  const offenders = findOverlongArchiveBullets(doc, { cap: 600, baseContent: base });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'overlong');
});

test('base-scoping: CRLF on either side of the comparison does not defeat the "already exists" match', () => {
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  // pushed content is CRLF, base is LF.
  const docCrlf = doc.replace(/\n/g, '\r\n');
  assert.deepEqual(findOverlongArchiveBullets(docCrlf, { cap: 600, baseContent: doc }), []);
  // pushed content is LF, base is CRLF.
  const baseCrlf = doc.replace(/\n/g, '\r\n');
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600, baseContent: baseCrlf }), []);
});

test('base-scoping: no baseContent supplied → whole-file behavior (narrative always flagged, matching pre-review-r1)', () => {
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600 }); // no baseContent at all
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

// --- plan 3971 review r2 (findings eb1f57, 039000, 73d472, 32132f): precise base set ----
// The base multiset is built from base's ARCHIVE REGION only (same bounds as HEAD's own
// scan), and is a Map<line, count> — each base OCCURRENCE exempts at most one HEAD
// occurrence.

test("base-scoping (review r2): a row matching one of base's GENERATED-region lines (above base's own sentinel) does NOT exempt an identical HEAD archive row", () => {
  // The row sits ABOVE base's own INDEX_PLANS_END sentinel — i.e. in base's generated/active
  // region, never scanned into the base multiset — so it must not exempt HEAD's archive-region
  // copy of the same text.
  const base = ['# INDEX', shortNarrative, END].join('\n');
  const doc = ['# INDEX', END, shortNarrative].join('\n');
  const offenders = findOverlongArchiveBullets(doc, { cap: 600, baseContent: base });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

test('base-scoping (review r2): a base with ONE occurrence exempts at most one HEAD occurrence — a duplicate is still flagged', () => {
  const base = ['# INDEX', END, shortNarrative].join('\n'); // base has ONE copy
  const doc = ['# INDEX', END, shortNarrative, shortNarrative].join('\n'); // HEAD has TWO
  const offenders = findOverlongArchiveBullets(doc, { cap: 600, baseContent: base });
  assert.equal(offenders.length, 1, 'the first copy is exempt, the duplicate is new and flagged');
  assert.equal(offenders[0].reason, 'narrative');
});

// --- plan 3971 review r3 (findings 545c77, 7ca206): --base requires a value ------------
test('resolveBaseFlags: a bare --base (no value) throws instead of silently falling back to the merge-base default', () => {
  assert.throws(() => resolveBaseFlags(['--base']), /missing its value/);
});

test('resolveBaseFlags: an explicitly empty --base= also throws (requireValues covers both shapes)', () => {
  assert.throws(() => resolveBaseFlags(['--base=']), /missing its value/);
});

test('resolveBaseFlags: --base <ref> resolves normally', () => {
  const { explicitBase, noBase } = resolveBaseFlags(['--base', 'some-ref']);
  assert.equal(explicitBase, 'some-ref');
  assert.equal(noBase, false);
});

test('resolveBaseFlags: --no-base resolves normally, with no explicit base', () => {
  const { explicitBase, noBase } = resolveBaseFlags(['--no-base']);
  assert.equal(explicitBase, undefined);
  assert.equal(noBase, true);
});

test('resolveBaseFlags: no flags at all resolves to the default (no explicit base, base-scoping on)', () => {
  const { explicitBase, noBase } = resolveBaseFlags([]);
  assert.equal(explicitBase, undefined);
  assert.equal(noBase, false);
});

test('the cap measures the VISIBLE row: a CRLF row of exactly cap chars is not overlong (review r4, c2474c/8db714/b537cc/b8c0d0)', () => {
  // A prefix-only row padded to exactly `cap` visible chars via a long FILENAME (trailing
  // spaces would read as narrative), so only the CR could tip it over, and it must not count.
  const padded = (n) =>
    '- `001-X-' + 'f'.repeat(n) + '.md` — archived 2026-06-15 (session 1), merged `abc1234`.';
  const fixed = padded(0).length;
  const exact = padded(600 - fixed);
  assert.equal(exact.length, 600);
  const doc = ['# INDEX', END, exact].join('\r\n') + '\r\n';
  assert.deepEqual(findOverlongArchiveBullets(doc, { cap: 600 }), []);
  const over = padded(601 - fixed);
  const doc2 = ['# INDEX', END, over].join('\r\n') + '\r\n';
  const offenders = findOverlongArchiveBullets(doc2, { cap: 600 });
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'overlong');
  assert.equal(offenders[0].len, 601);
});
