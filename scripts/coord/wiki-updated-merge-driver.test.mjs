// scripts/coord/wiki-updated-merge-driver.test.mjs (plan 1528 A2)
// Pure-resolution units for the wiki `updated:`-line merge conflict resolver. The plan-1528
// acceptance test (a real land-rebase exercising ensure-wiki-merge-driver.mjs, a vetapp-only
// top-level command not shipped by the coord-kit) is removed — see plan 3958's note below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveUpdatedBlock,
  resolveUpdatedOnlyConflicts,
  UPDATED_VALUE_MAX_BYTES,
} from './wiki-updated-merge-driver.mjs';
import { UPDATED_MAX } from './wiki-size-lint.mjs';

// plan 3415 Item C review round 3 (findings 1opz6ve/10x3fi): the driver's own header mandates
// staying self-contained on node built-ins (a merge driver must never drag repo deps), so
// UPDATED_VALUE_MAX_BYTES cannot import wiki-size-lint.mjs's canonical UPDATED_MAX directly —
// but nothing stops THIS TEST from importing both and pinning them to the same value, so a
// future change to either cap is caught here instead of the two silently drifting apart.
test("plan 3415 Item C review round 3: UPDATED_VALUE_MAX_BYTES stays pinned to wiki-size-lint.mjs's canonical UPDATED_MAX", () => {
  assert.equal(UPDATED_VALUE_MAX_BYTES, UPDATED_MAX);
});

// node --test under a git hook exports GIT_DIR etc. — scrub so scratch repos are isolated.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];

test('plan 1528: resolveUpdatedBlock — lone updated: lines on both sides take the LATER date', () => {
  assert.equal(
    resolveUpdatedBlock('updated: 2026-07-01\n', 'updated: 2026-07-06\n'),
    'updated: 2026-07-06\n',
  );
  assert.equal(
    resolveUpdatedBlock('updated: 2026-07-06\n', 'updated: 2026-07-01\n'),
    'updated: 2026-07-06\n',
  );
  // equal dates resolve too (both sides bumped to the same day)
  assert.equal(
    resolveUpdatedBlock('updated: 2026-07-06\n', 'updated: 2026-07-06\n'),
    'updated: 2026-07-06\n',
  );
});

// plan 3415 Item C: the wiki page-budget contract's annotated superset
// `updated: YYYY-MM-DD (plan NNNN: ...)`. Before Item C fix 3 this driver only matched the
// bare-date form (UPDATED_LINE_RE had no optional annotation group), so an annotated block fell
// through resolveUpdatedBlock's `!om || !tm` check and returned null — a genuine conflict left
// for the session, exactly like any unrelated prose hunk. Demonstrated failing against the
// pre-fix driver: `resolveUpdatedBlock('updated: 2026-08-10 (plan 3395: caller bump)\n', ...)`
// returned `null` (assertion `assert.equal(result, 'updated: ...\n')` failed with
// `null !== 'updated: 2026-08-15 (plan 9999: master bump)\n'`).
test('plan 3415 Item C fix 3: resolveUpdatedBlock resolves annotated updated: lines — MASTER newer', () => {
  assert.equal(
    resolveUpdatedBlock(
      'updated: 2026-08-10 (plan 3395: caller bump)\n',
      'updated: 2026-08-15 (plan 9999: master bump)\n',
    ),
    'updated: 2026-08-15 (plan 9999: master bump)\n',
  );
});

test('plan 3415 Item C: resolveUpdatedBlock resolves annotated updated: lines — CALLER newer (the direction that already worked)', () => {
  assert.equal(
    resolveUpdatedBlock(
      'updated: 2026-08-20 (plan 3395: caller bump)\n',
      'updated: 2026-08-10 (plan 9999: master bump)\n',
    ),
    'updated: 2026-08-20 (plan 3395: caller bump)\n',
  );
});

// plan 3415 Item C fix 2: an EXACT date tie must not silently drop one side's provenance
// annotation. Pre-fix (`>=` picking one bare string wholesale, no annotation-aware merge)
// this returned ours verbatim and theirs' "(plan 9999: master bump)" note vanished with no
// signal — the silent-loss shape the plan calls the one unacceptable outcome.
test('plan 3415 Item C fix 2: resolveUpdatedBlock on an EXACT date tie keeps BOTH sides annotations', () => {
  assert.equal(
    resolveUpdatedBlock(
      'updated: 2026-08-10 (plan 3395: caller bump)\n',
      'updated: 2026-08-10 (plan 9999: master bump)\n',
    ),
    'updated: 2026-08-10 (plan 3395: caller bump; plan 9999: master bump)\n',
  );
  // identical annotations (e.g. a retried commit) never duplicate
  assert.equal(
    resolveUpdatedBlock(
      'updated: 2026-08-10 (plan 3395: caller bump)\n',
      'updated: 2026-08-10 (plan 3395: caller bump)\n',
    ),
    'updated: 2026-08-10 (plan 3395: caller bump)\n',
  );
  // one side bare, the other annotated — the annotation still survives, not discarded
  assert.equal(
    resolveUpdatedBlock('updated: 2026-08-10\n', 'updated: 2026-08-10 (plan 9999: master bump)\n'),
    'updated: 2026-08-10 (plan 9999: master bump)\n',
  );
  // both bare, equal — unchanged from the pre-existing bare-tie behavior
  assert.equal(
    resolveUpdatedBlock('updated: 2026-08-10\n', 'updated: 2026-08-10\n'),
    'updated: 2026-08-10\n',
  );
});

// plan 3415 Item C round 3 (supersedes cluster 12's entry-level dedup, now retired):
// `; `-splitting is GONE —
// measured against the real vault (85 committed `updated:` lines, 2026-08-25), 38 contain a
// semicolon and in the real data it is ordinary sentence punctuation inside ONE narrative note
// as often as it is a delimiter. Two REAL committed annotations, each internally punctuated
// with `;`, must survive WHOLE and UNSPLIT in the merged result (findings 1xugg58 / yz4ii4).
test('plan 3415 Item C round 3 (findings 1xugg58/yz4ii4): a same-date merge keeps each annotation WHOLE — a `;` inside one note is never mistaken for an entry delimiter', () => {
  const oursNote =
    'plan 3201 retire-back sweep: `REQUIRED_PRICE_AXES` bullet now names `kremering` (joined plan 2691, 2026-08-02); added the `isKastreringLeadingBundleRow` addendum (plan 2994). Full history in wiki/log.md';
  const theirsNote =
    'DK roster prints FIRST NAMES ONLY, surname recoverable only from the per-person profile URL; roster is client-rendered so a static fetch proves nothing, plan 3364';
  const result = resolveUpdatedBlock(
    `updated: 2026-08-16 (${oursNote})\n`,
    `updated: 2026-08-16 (${theirsNote})\n`,
  );
  // both whole notes present, joined by exactly one `; ` between them — never split further
  assert.equal(result, `updated: 2026-08-16 (${oursNote}; ${theirsNote})\n`);
});

test('plan 3415 Item C round 3: distinct annotations on a same-date tie are kept BOTH, WHOLE, joined by "; " — never reordered or deduped at the entry level', () => {
  assert.equal(
    resolveUpdatedBlock(
      'updated: 2026-08-10 (plan 100: A; plan 200: B)\n',
      'updated: 2026-08-10 (plan 100: A)\n',
    ),
    // the shared "plan 100: A" text is NOT deduped — round 3 deliberately stopped trying to
    // tell a repeated entry apart from coincidentally-similar prose (that WAS the cluster-12
    // design; it is retired, not reinstated here).
    'updated: 2026-08-10 (plan 100: A; plan 200: B; plan 100: A)\n',
  );
});

// plan 3415 Item C round 3 (finding 1bfdsx4): overflow REFUSES explicitly (returns null, same
// as any other unresolvable conflict block) rather than silently trimming — the round-2
// oldest-first trim reintroduced the exact silent-provenance-loss shape the plan rules
// unacceptable. Confirmed failing against the round-2 code: that version returned a
// truncated-but-non-null string here instead of null.
test('plan 3415 Item C round 3 (finding 1bfdsx4): a same-date merge whose combined annotations would overflow the 400-byte cap REFUSES (returns null) instead of trimming', () => {
  const big = 'x'.repeat(380);
  const result = resolveUpdatedBlock(
    `updated: 2026-08-10 (${big})\n`,
    'updated: 2026-08-10 (plan 9999: fresh entry)\n',
  );
  assert.equal(result, null, 'overflow must refuse, never silently trim one side away');
});

test('plan 1528: resolveUpdatedBlock refuses anything beyond the one-updated:-line shape', () => {
  // extra content beside the date line
  assert.equal(
    resolveUpdatedBlock('updated: 2026-07-01\nextra line\n', 'updated: 2026-07-06\n'),
    null,
  );
  // a non-updated: line
  assert.equal(resolveUpdatedBlock('title: Foo\n', 'updated: 2026-07-06\n'), null);
  // malformed date
  assert.equal(resolveUpdatedBlock('updated: yesterday\n', 'updated: 2026-07-06\n'), null);
  // empty side (pure deletion) is NOT the class
  assert.equal(resolveUpdatedBlock('', 'updated: 2026-07-06\n'), null);
});

const mark = (ours, theirs, base = null) =>
  `<<<<<<< ours\n${ours}${base != null ? `||||||| base\n${base}` : ''}=======\n${theirs}>>>>>>> theirs\n`;

test('plan 1528: resolveUpdatedOnlyConflicts — resolves every updated:-only block, refuses on ANY other block', () => {
  const doc = `---\nname: page\n${mark('updated: 2026-07-01\n', 'updated: 2026-07-06\n')}---\nbody\n`;
  assert.equal(
    resolveUpdatedOnlyConflicts(doc),
    '---\nname: page\nupdated: 2026-07-06\n---\nbody\n',
  );
  // diff3-style base section is tolerated (the conflict block sits inside real frontmatter)
  const d3 = `x\n---\n${mark('updated: 2026-07-05\n', 'updated: 2026-07-02\n', 'updated: 2026-07-01\n')}---\ny\n`;
  assert.equal(resolveUpdatedOnlyConflicts(d3), null); // 'x' before the fence means no leading frontmatter at all
  const d3fm = `---\n${mark('updated: 2026-07-05\n', 'updated: 2026-07-02\n', 'updated: 2026-07-01\n')}---\ny\n`;
  assert.equal(resolveUpdatedOnlyConflicts(d3fm), '---\nupdated: 2026-07-05\n---\ny\n');
  // a second NON-updated: block poisons the whole file → null (no half-resolve)
  const mixed = `---\n${mark('updated: 2026-07-01\n', 'updated: 2026-07-06\n')}mid\n${mark('prose A\n', 'prose B\n')}---\n`;
  assert.equal(resolveUpdatedOnlyConflicts(mixed), null);
  // no conflict blocks at all → null (nothing this function should claim to have done)
  assert.equal(resolveUpdatedOnlyConflicts('clean file\n'), null);
});

// plan 3415 Item C review (finding a9ocvj): a conflict block outside the leading frontmatter
// fence is NEVER the updated:-line class, no matter how closely its shape matches — a body
// line quoting an example `updated:` date is real page content the driver has no business
// resolving by date comparison. Confirmed failing against the pre-fix driver: the pre-fix
// version had no frontmatter-position check at all, so this returned the date-compared merge
// instead of null.
test('plan 3415 Item C review (finding a9ocvj): a conflict block AFTER the frontmatter closing fence is refused even though it is shaped exactly like the updated:-line class', () => {
  const doc = `---\nname: page\nupdated: 2026-07-01\n---\nSee the example:\n${mark('updated: 2026-07-05\n', 'updated: 2026-07-02\n')}`;
  assert.equal(
    resolveUpdatedOnlyConflicts(doc),
    null,
    'a body-line conflict must never be auto-resolved, even in updated:-line shape',
  );
});

// plan 3958: the plan-1528 acceptance test that used to live here (a real land-rebase against
// ensure-wiki-merge-driver.mjs) is removed -- that registration tool is not in the coord-kit
// manifest (never shipped). Genuine vetapp product coverage, not core; the pure
// resolveUpdatedOnlyConflicts unit tests above/below cover the SAME merge-resolution logic
// portably.

test('plan 3415 review round 3: the IDENTICAL-annotation path is budget-checked too, not fast-pathed past it', () => {
  // The identical-annotation case used to return early with no budget check, so two sides that
  // AGREED on an already-oversized updated: line propagated it silently — the same silent-overflow
  // class the differing-annotation refusal exists to stop. Both paths now build the value first and
  // run one shared check, so agreement is not a way around the cap.
  const date = '2026-08-25';
  // Build one annotation that, on its own, already busts the cap.
  const oversized = `(plan 3415: ${'x'.repeat(UPDATED_VALUE_MAX_BYTES)})`;
  const line = `updated: ${date} ${oversized}\n`;
  assert.equal(
    resolveUpdatedBlock(line, line),
    null,
    'an identical but over-cap annotation must be refused, not returned unchecked',
  );

  // Control: an identical annotation that FITS still merges cleanly to the single shared value.
  const small = `updated: ${date} (plan 3415: fits)\n`;
  assert.equal(resolveUpdatedBlock(small, small), small);
});
