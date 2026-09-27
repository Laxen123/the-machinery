// scripts/index-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_END_RX,
  findBulletIndexBySlug,
  addBullet,
  removeBullet,
  repathBullet,
  archiveBullet,
  insertArchiveNarrativeLine,
  clampArchiveNote,
  clampOverlongArchiveBullets,
  assertGeneratedRegionCanonical,
  parseGeneratedBullet,
  condenseArchiveRows,
  condenseArchiveRow,
} from './index-lib.mjs';
import {
  renderPlansBlock,
  splicePlansBlock,
  INDEX_PLANS_START,
  INDEX_PLANS_END,
  ALL_PLAN_FOLDERS,
} from './build-index-lib.mjs';
import { CAP, findOverlongArchiveBullets } from './lint-index-brevity.mjs';

// A docs/INDEX.md in the CURRENT (sentinel + `**status/**` subheading) format that
// `build-index` generates. `wrapGenerated(block)` embeds a generated block inside the
// surrounding prose + archive narrative the splicer must preserve verbatim.
// plan 3971 review r1 (A): this baseline archive row is prefix-only (no trailing "Did old
// thing.") — every test that runs it through findOverlongArchiveBullets now ALSO flags a
// spine-shaped row carrying leftover narrative text, cap or no cap, so a narrative baseline
// row would pollute every one of those tests' offender counts with an unrelated hit.
const wrapGenerated = (block) =>
  [
    '# Vetapp Index',
    '',
    'Active / open:',
    '',
    block,
    '',
    'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
    '',
    '- `099-Other-old.md` — archived 2026-05-01 (session 1), merged `abc1234`.',
    '',
  ].join('\n');

const SAMPLE = [
  '## Plans (`docs/superpowers/plans/`)',
  '',
  'Active / open:',
  '',
  '**Seed-write legend:** 🟥 = … 🟩 = …',
  '',
  '1. **A design rule.** Not a plan bullet — never touched.',
  '',
  '- 🟩 **[Other — Alpha]** Does alpha. → `ready/100-Other-alpha.md`',
  '- 🟥 **[P07 — Beta]** Does beta. → `in-progress/101-P07-beta.md`',
  '',
  'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
  '',
  '- `099-Other-old.md` — archived 2026-05-01 (session 1), merged `abc1234`. Did old thing.',
  '',
].join('\n');

test('findBulletIndexBySlug finds a plan bullet by basename, ignores non-bullets', () => {
  const lines = SAMPLE.split('\n');
  assert.equal(findBulletIndexBySlug(lines, '101-P07-beta.md') >= 0, true);
  assert.equal(findBulletIndexBySlug(lines, 'nope.md'), -1);
  // the legend / numbered rule are never matched
  assert.equal(findBulletIndexBySlug(lines, 'design rule'), -1);
});

test('addBullet inserts at end of the active plan-bullet run, before the archive header', () => {
  const out = addBullet(
    SAMPLE,
    '- 🟩 **[Other — Gamma]** Does gamma. → `ready/102-Other-gamma.md`',
  );
  const lines = out.split('\n');
  const gammaIdx = lines.findIndex((l) => l.includes('102-Other-gamma.md'));
  const betaIdx = lines.findIndex((l) => l.includes('101-P07-beta.md'));
  const archiveIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  assert.ok(gammaIdx > betaIdx && gammaIdx < archiveIdx); // sits after last active bullet, above archive
});

test('addBullet is idempotent on slug (replaces, no dup)', () => {
  const once = addBullet(
    SAMPLE,
    '- 🟩 **[Other — Alpha v2]** New blurb. → `in-progress/100-Other-alpha.md`',
  );
  assert.equal((once.match(/100-Other-alpha\.md/g) || []).length, 1);
  assert.ok(once.includes('Alpha v2'));
});

test('repathBullet rewrites only the path token of the matched bullet', () => {
  const out = repathBullet(SAMPLE, '100-Other-alpha.md', 'in-progress/100-Other-alpha.md');
  assert.ok(out.includes('→ `in-progress/100-Other-alpha.md`'));
  assert.ok(out.includes('Does alpha.')); // blurb preserved
  assert.ok(out.includes('`in-progress/101-P07-beta.md`')); // beta untouched
});

test('repathBullet rewrites a markdown-link-form path token, preserving its prefix', () => {
  // Older / hand-authored bullets use the markdown-link form with paths rooted at
  // docs/ (`superpowers/plans/<sub>/…`). The caller passes the plans/-rooted
  // subfolder relpath (`in-progress/…`); the docs/-relative prefix must survive.
  const MDLINK = [
    'Active / open:',
    '',
    '- 🟩 [220-UI — search row](superpowers/plans/ready/220-UI-search-row.md) — merges form into nav bar.',
    '- 🟩 **[Other — Alpha]** Does alpha. → `ready/100-Other-alpha.md`',
    '',
    'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
    '',
  ].join('\n');
  const out = repathBullet(MDLINK, '220-UI-search-row.md', 'in-progress/220-UI-search-row.md');
  assert.ok(out.includes('](superpowers/plans/in-progress/220-UI-search-row.md)')); // prefix preserved
  assert.ok(!out.includes('](superpowers/plans/ready/220-UI-search-row.md)')); // old path gone
  assert.ok(out.includes('220-UI — search row')); // label preserved
  assert.ok(out.includes('`ready/100-Other-alpha.md`')); // sibling backtick bullet untouched
});

test('repathBullet (legacy format) recognizes a pending-approval/ old prefix (plan 1371 taxonomy)', () => {
  // STATUS_SUBFOLDER_RX must include pending-approval/ (the retired drafting/'s
  // replacement, plan 1371) so a legacy-format bullet parked there repaths cleanly.
  const PENDING = [
    'Active / open:',
    '',
    '- 🟩 **[Other — Gamma]** Fresh mint. → `pending-approval/300-Other-gamma.md`',
    '',
    'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
    '',
  ].join('\n');
  const out = repathBullet(PENDING, '300-Other-gamma.md', 'ready/300-Other-gamma.md');
  assert.ok(out.includes('→ `ready/300-Other-gamma.md`'));
  assert.ok(!out.includes('pending-approval/300-Other-gamma.md'));
});

test('repathBullet (legacy format) recognizes a parked/ old prefix (plan 1426)', () => {
  // STATUS_SUBFOLDER_RX must include parked/ so a legacy-format bullet being un-parked
  // repaths cleanly — same shape as the pending-approval/ test above.
  const PARKED = [
    'Active / open:',
    '',
    '- 🟩 **[Other — Delta]** Frozen for now. → `parked/301-Other-delta.md`',
    '',
    'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
    '',
  ].join('\n');
  const out = repathBullet(PARKED, '301-Other-delta.md', 'ready/301-Other-delta.md');
  assert.ok(out.includes('→ `ready/301-Other-delta.md`'));
  assert.ok(!out.includes('parked/301-Other-delta.md'));
});

// plan 1447 drift guard: STATUS_SUBFOLDER_RX is now BUILT from build-index-lib's
// PLAN_FOLDER_ALT instead of a hand-listed literal (its alternation order also
// changed — see build-index-lib.mjs's ALL_PLAN_FOLDERS comment for why that's
// harmless). BEHAVIORAL equivalence, not textual .source equality, is the
// meaningful guard here: every folder in ALL_PLAN_FOLDERS must still be
// recognized as a legacy-format bullet's old subfolder prefix and repathed
// cleanly, exactly as the original hand-listed regex did.
test('repathBullet (legacy format) recognizes EVERY ALL_PLAN_FOLDERS entry as an old prefix (plan 1447 drift guard)', () => {
  for (const folder of ALL_PLAN_FOLDERS) {
    // Target a DIFFERENT status than the one under test, so the old-prefix token is
    // never accidentally identical to the new one (which would make the "old prefix
    // gone" assertion below vacuously true).
    const target = folder === 'ready' ? 'in-progress' : 'ready';
    const content = [
      'Active / open:',
      '',
      `- 🟩 **[Other — X]** Thing. → \`${folder}/900-Other-x.md\``,
      '',
      'Moved to `docs/superpowers/plans/archive/` (one-line index — see each plan file):',
      '',
    ].join('\n');
    const out = repathBullet(content, '900-Other-x.md', `${target}/900-Other-x.md`);
    assert.ok(
      out.includes(`→ \`${target}/900-Other-x.md\``),
      `folder "${folder}" was not recognized as an old prefix`,
    );
    assert.ok(!out.includes(`${folder}/900-Other-x.md`));
  }
});

test('removeBullet deletes the matched active bullet only', () => {
  const out = removeBullet(SAMPLE, '100-Other-alpha.md');
  assert.equal(out.includes('100-Other-alpha.md'), false);
  assert.ok(out.includes('101-P07-beta.md'));
});

test('archiveBullet removes the active bullet and inserts a one-liner under the archive header', () => {
  const out = archiveBullet(
    SAMPLE,
    '101-P07-beta.md',
    'archived 2026-05-29 (session 9), merged `def5678`.',
  );
  const lines = out.split('\n');
  assert.equal(
    lines.some((l) => /^- 🟥.*101-P07-beta\.md/.test(l)),
    false,
  ); // active bullet gone
  const headerIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  const archiveIdx = lines.findIndex(
    (l) => l.includes('`101-P07-beta.md`') && l.includes('merged `def5678`'),
  );
  assert.ok(archiveIdx > headerIdx); // new one-liner sits under the archive header
});

// plan 3971 review r1 (A): the generic `index.mjs archive --note` CLI is not itself
// restricted to the prefix-only shape, so archiveBullet must condense the freshly
// inserted row itself — a narrative note can never survive into docs/INDEX.md.
test('plan 3971 review r1 (A): archiveBullet condenses a narrative note to the prefix-only shape', () => {
  const out = archiveBullet(
    SAMPLE,
    '101-P07-beta.md',
    'archived 2026-05-29 (session 9), merged `def5678`. Shipped beta.',
  );
  const line = out
    .split('\n')
    .find((l) => l.includes('`101-P07-beta.md`') && l.includes('archived'));
  assert.equal(line, '- `101-P07-beta.md` — archived 2026-05-29 (session 9), merged `def5678`.');
  assert.ok(!out.includes('Shipped beta'));
});

test('mutators throw on unknown slug', () => {
  assert.throws(() => removeBullet(SAMPLE, 'ghost.md'), /not found/);
  assert.throws(() => repathBullet(SAMPLE, 'ghost.md', 'x/ghost.md'), /not found/);
  assert.throws(() => archiveBullet(SAMPLE, 'ghost.md', 'note'), /not found/);
});

// --- Sentinel-format canonicality (plan 475) -------------------------------
// In the generated (sentinel + `**status/**`) format, the legacy "append after the
// last bullet" placement is canonical ONLY when the new plan's status-group sorts
// last. For `ready/` — the default landing folder for every new plan — appending at
// the tail leaves the region non-canonical, so the next `build-index --check` push
// gate trips. The mutators must produce exactly what `renderPlansBlock` would.

test('addBullet keeps the generated region canonical: a ready/ bullet lands under **ready/**, not at the tail', () => {
  const existing = [
    { status: 'in-progress', basename: '470-UI-foo.md', marker: '🟩', summary: 'Foo plan.' },
    { status: 'waiting-trip', basename: '471-DQ-bar.md', marker: '🟥', summary: 'Bar plan.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = addBullet(content, '- 🟩 Baz plan. → `ready/475-Infra-baz.md`');
  const expected = wrapGenerated(
    renderPlansBlock([
      existing[0],
      { status: 'ready', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
      existing[1],
    ]),
  );
  assert.equal(out, expected);
});

test('removeBullet drops an emptied group heading, staying canonical (sentinel format)', () => {
  const existing = [
    { status: 'in-progress', basename: '470-UI-foo.md', marker: '🟩', summary: 'Foo plan.' },
    { status: 'ready', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = removeBullet(content, '475-Infra-baz.md');
  const expected = wrapGenerated(renderPlansBlock([existing[0]]));
  assert.equal(out, expected); // `**ready/**` heading must vanish, not orphan
});

test('repathBullet relocates a bullet to its new status group, staying canonical (sentinel format)', () => {
  const existing = [
    { status: 'ready', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
    { status: 'waiting-trip', basename: '471-DQ-bar.md', marker: '🟥', summary: 'Bar plan.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = repathBullet(content, '475-Infra-baz.md', 'in-progress/475-Infra-baz.md');
  const expected = wrapGenerated(
    renderPlansBlock([
      { status: 'in-progress', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
      existing[1],
    ]),
  );
  assert.equal(out, expected); // moves under **in-progress/**, leaves no orphan **ready/**
});

test('assertGeneratedRegionCanonical passes canonical content, throws on tail-appended drift', () => {
  const canonical = wrapGenerated(
    renderPlansBlock([
      { status: 'waiting-trip', basename: '471-DQ-bar.md', marker: '🟥', summary: 'Bar.' },
    ]),
  );
  assert.doesNotThrow(() => assertGeneratedRegionCanonical(canonical));

  // A ready/ bullet jammed after the waiting-trip group with no `**ready/**` heading —
  // exactly the legacy tail-append drift that reached origin twice on 2026-06-09.
  const drifted = wrapGenerated(
    [
      INDEX_PLANS_START,
      '',
      '**waiting-trip/**',
      '',
      '- 🟥 Bar. → `waiting-trip/471-DQ-bar.md`',
      '',
      '- 🟩 Baz. → `ready/475-Infra-baz.md`',
      '',
      INDEX_PLANS_END,
    ].join('\n'),
  );
  assert.throws(() => assertGeneratedRegionCanonical(drifted), /not canonical/);

  // No-op on pre-sentinel content — nothing to canonicalise, must not throw.
  assert.doesNotThrow(() => assertGeneratedRegionCanonical(SAMPLE));
});

test('plan 2328: a ⚡-prefixed marker round-trips through the generated region (canonical, never drift)', () => {
  const canonical = wrapGenerated(
    renderPlansBlock([
      { status: 'ready', basename: '2340-DQ-urgent.md', marker: '⚡🟥', summary: 'Urgent.' },
      { status: 'ready', basename: '2341-UI-calm.md', marker: '🟩', summary: 'Calm.' },
    ]),
  );
  // parse → re-render is byte-identical: the widened bullet regex admits the ⚡ prefix
  assert.doesNotThrow(() => assertGeneratedRegionCanonical(canonical));
  assert.ok(canonical.includes('- ⚡🟥 Urgent. → `ready/2340-DQ-urgent.md`'));
});

test('archiveBullet keeps the generated region canonical, drops the emptied group (sentinel format)', () => {
  const existing = [
    { status: 'in-progress', basename: '470-UI-foo.md', marker: '🟩', summary: 'Foo plan.' },
    { status: 'ready', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = archiveBullet(
    content,
    '475-Infra-baz.md',
    'archived 2026-06-09 (session 406), merged `deadbee`. Shipped.',
  );
  assert.doesNotThrow(() => assertGeneratedRegionCanonical(out)); // region canonical (ready group gone)
  assert.ok(!/→ `ready\/475-Infra-baz\.md`/.test(out)); // active bullet removed
  assert.ok(out.includes('`475-Infra-baz.md` — archived 2026-06-09')); // archive one-liner present
});

// Guard against silent bullet-drop: renderPlansBlock discards any record whose status
// isn't a known plan folder, so a path that mis-parses its status (e.g. a docs-rooted
// `superpowers/plans/…` form) would make the bullet vanish from INDEX while the plan
// file persists — the exact drift class plan 475 fixes. The mutators must throw loudly.
test('addBullet throws on a bullet whose path status is not a known plan folder (sentinel)', () => {
  const content = wrapGenerated(
    renderPlansBlock([{ status: 'ready', basename: '474-X-a.md', marker: '🟩', summary: 'A.' }]),
  );
  assert.throws(
    () => addBullet(content, '- 🟩 Bad. → `superpowers/plans/ready/999-X-bad.md`'),
    /known plan folder/,
  );
});

test('repathBullet throws when newPath status is not a known plan folder (sentinel)', () => {
  const content = wrapGenerated(
    renderPlansBlock([{ status: 'ready', basename: '474-X-a.md', marker: '🟩', summary: 'A.' }]),
  );
  assert.throws(
    () => repathBullet(content, '474-X-a.md', 'superpowers/plans/in-progress/474-X-a.md'),
    /known plan folder/,
  );
});

// --- plan 645: archive-bullet brevity clamp -------------------------------
// done-worktree built the archive note from the FULL plan summary frontmatter
// uncapped, so a long-summary land wrote a >CAP bullet that crashed the close-out
// push on lint-index-brevity and wedged the queue (hit 641 @910, 640 @755, 635
// @1054 on 2026-06-15). The clamp lives in the insertArchiveNarrativeLine choke
// point so BOTH writers (index.mjs archive + done-worktree close-out) get it.

const longSummary = `Render frontend egress is 7.08 GB/30d. ${'word '.repeat(200)}end.`;

test('clampArchiveNote: a short note passes through byte-identical (no clamp, no whitespace touch)', () => {
  const note = 'archived 2026-06-15 (session 9), merged `def5678`. Shipped the thing.';
  assert.equal(clampArchiveNote('641-Perf-record-photo-bandwidth.md', note), note);
});

test('clampArchiveNote: a long note is clamped so the RENDERED bullet line stays <= CAP, ending with an ellipsis', () => {
  const slug = '641-Perf-record-photo-bandwidth.md';
  const note = `archived 2026-06-15 (session 563), merged \`8679c79\`. ${longSummary}`;
  assert.ok(note.length > CAP, 'fixture note must exceed CAP to exercise the clamp');
  const clamped = clampArchiveNote(slug, note);
  const rendered = `- \`${slug}\` — ${clamped}`;
  assert.ok(rendered.length <= CAP, `rendered bullet ${rendered.length} must be <= ${CAP}`);
  assert.ok(clamped.endsWith('…'), 'clamped note ends with an ellipsis');
});

test('clampArchiveNote: the slug prefix counts against the budget (longer slug ⇒ smaller note budget)', () => {
  // A note sized to fit comfortably under the SHORT slug's budget but to overflow
  // the LONG slug's budget — proving the clamp accounts for the `- \`<slug>\` — ` prefix.
  const slugShort = 'a.md';
  const slugLong = 'a-very-long-plan-slug-name-that-eats-the-budget.md';
  const note = 'x'.repeat(580);
  const cShort = clampArchiveNote(slugShort, note);
  const cLong = clampArchiveNote(slugLong, note);
  assert.equal(cShort, note, 'short slug leaves the note unchanged (fits)');
  assert.ok(cLong.endsWith('…'), 'long slug forces a clamp');
  assert.ok(cLong.length < cShort.length, 'longer prefix ⇒ smaller note budget');
  assert.ok(`- \`${slugShort}\` — ${cShort}`.length <= CAP);
  assert.ok(`- \`${slugLong}\` — ${cLong}`.length <= CAP);
});

// A fixture with BOTH the INDEX:PLANS sentinels (so findOverlongArchiveBullets,
// which scans after INDEX_PLANS_END, actually engages) AND the "Moved to archive"
// header (so insertArchiveNarrativeLine has an insert anchor). Using SAMPLE here
// would FALSE-PASS: it lacks the sentinel, so the lint returns [] vacuously.
const FIXTURE_WITH_SENTINEL = wrapGenerated(
  renderPlansBlock([
    { status: 'in-progress', basename: '101-P07-beta.md', marker: '🟥', summary: 'Beta.' },
  ]),
);

test('insertArchiveNarrativeLine clamps a long note under CAP (length-only — condensing to prefix-only is a SEPARATE, later concern)', () => {
  // Guard against a vacuous pass: the fixture must actually carry the lint's region marker.
  assert.ok(
    FIXTURE_WITH_SENTINEL.includes(INDEX_PLANS_END),
    'fixture has the lint region sentinel',
  );
  const note = `archived 2026-06-15 (session 563), merged \`8679c79\`. ${longSummary}`;
  const out = insertArchiveNarrativeLine(
    FIXTURE_WITH_SENTINEL,
    '641-Perf-record-photo-bandwidth.md',
    note,
  );
  const line = out.split('\n').find((l) => l.includes('`641-Perf-record-photo-bandwidth.md`'));
  assert.ok(line.length <= CAP, 'the clamp keeps the rendered bullet length under CAP');
  assert.ok(line.endsWith('…'));
  // plan 3971 review r1 (A): insertArchiveNarrativeLine stays a plain, unopinionated
  // inserter — it clamps LENGTH but never condenses to the prefix-only shape (its one
  // direct caller, done-worktree, already only ever hands it a prefix-only note post plan
  // 3971; the generic `index.mjs archive` CLI's archiveBullet wrapper is what condenses on
  // top of it — see the "drops a long note entirely" test below). A row that is merely
  // CLAMPED but still narrative is therefore correctly STILL flagged by the lint's
  // narrative check — length alone no longer satisfies the archive-row contract.
  const offenders = findOverlongArchiveBullets(out);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

// Pre-plan-3971 this only proved the clamp truncated a long note under CAP with an
// ellipsis. Since review r1 (A), archiveBullet condenses the note ENTIRELY (the clamp
// still runs first, inside insertArchiveNarrativeLine, but condenseArchiveRow then strips
// whatever survived it) — so the produced row satisfies the length cap trivially, and
// carries none of the long summary at all, clamped or not.
test('archiveBullet (index.mjs path) drops a long note entirely (condensed, not just clamped)', () => {
  const note = `archived 2026-06-15 (session 563), merged \`8679c79\`. ${longSummary}`;
  const out = archiveBullet(FIXTURE_WITH_SENTINEL, '101-P07-beta.md', note);
  assert.equal(findOverlongArchiveBullets(out).length, 0);
  assert.equal(
    out.split('\n').some((l) => /^- 🟥.*101-P07-beta\.md/.test(l)),
    false,
    'active bullet removed',
  );
  const line = out
    .split('\n')
    .find((l) => l.includes('`101-P07-beta.md`') && l.includes('archived'));
  assert.equal(line, '- `101-P07-beta.md` — archived 2026-06-15 (session 563), merged `8679c79`.');
  assert.ok(!out.includes('…'), 'nothing left to ellipsis-truncate');
});

// --- plan 665 G1.3: last-resort belt over the archive region -----------------
// clampOverlongArchiveBullets is the spine's net for a bullet that reaches the
// archive region OVER cap (a worktree whose scripts predate clampArchiveNote — the
// real 646 root cause — or a clamp regression). It must produce a lint-clean region.

// Forge an over-CAP archive bullet directly in the region (simulating a stale-worktree
// write that bypassed clampArchiveNote), then prove the belt brings it back ≤ CAP.
test('clampOverlongArchiveBullets: hard-caps an over-CAP archive bullet → lint clean', () => {
  const overlong = `- \`641-Perf-record-photo-bandwidth.md\` — ${longSummary}`;
  assert.ok(overlong.length > CAP, 'fixture bullet is genuinely over CAP');
  const lines = FIXTURE_WITH_SENTINEL.split('\n');
  const headerIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  lines.splice(headerIdx + 1, 0, overlong); // inject directly under the archive header
  const forged = lines.join('\n');
  assert.equal(findOverlongArchiveBullets(forged).length, 1, 'fixture starts over-cap');

  const { content, fixed } = clampOverlongArchiveBullets(forged);
  assert.equal(fixed.length, 1, 'one bullet reported fixed');
  assert.equal(fixed[0].slug, '641-Perf-record-photo-bandwidth.md');
  assert.ok(fixed[0].after <= CAP && fixed[0].before > CAP, 'before>CAP, after<=CAP');
  assert.equal(findOverlongArchiveBullets(content).length, 0, 'region is lint-clean after belt');
  const capped = content.split('\n').find((l) => l.includes('641-Perf-record-photo-bandwidth.md'));
  assert.ok(capped.length <= CAP && capped.endsWith('…'));
});

test('clampOverlongArchiveBullets (review r3, finding f81505): CRLF-safe — an overlong CRLF row is clamped and keeps its \\r', () => {
  const overlong = `- \`642-Perf-crlf.md\` — ${longSummary}`;
  assert.ok(overlong.length > CAP, 'fixture bullet is genuinely over CAP');
  const lines = FIXTURE_WITH_SENTINEL.split('\n');
  const headerIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  lines.splice(headerIdx + 1, 0, overlong);
  const forgedCrlf = lines.join('\n').replace(/\n/g, '\r\n');

  const { content, fixed } = clampOverlongArchiveBullets(forgedCrlf);
  assert.equal(fixed.length, 1, 'one bullet reported fixed');
  assert.equal(fixed[0].slug, '642-Perf-crlf.md');

  const cappedLine = content.split('\n').find((l) => l.includes('642-Perf-crlf.md'));
  assert.ok(cappedLine.endsWith('\r'), 'the clamped line keeps its trailing \\r');
  const bareLine = cappedLine.slice(0, -1);
  assert.ok(bareLine.length <= CAP && bareLine.endsWith('…'));
  // No bare \n was introduced anywhere: every \n in the output is still immediately
  // preceded by \r, exactly as in the CRLF input.
  assert.doesNotMatch(content, /(?<!\r)\n/);
});

test('clampOverlongArchiveBullets: no-op on an already-clean region (byte-identical)', () => {
  const clean = insertArchiveNarrativeLine(
    FIXTURE_WITH_SENTINEL,
    '641-Perf-record-photo-bandwidth.md',
    'archived 2026-06-15 (session 563), merged `8679c79`. Short note.',
  );
  const { content, fixed } = clampOverlongArchiveBullets(clean);
  assert.equal(fixed.length, 0);
  assert.equal(content, clean, 'clean region returned byte-identical');
});

// --- plan 652: clamp truncates on a boundary, never mid-word -----------------
// plan 645 capped the bullet length but cut with a raw `slice(0, room)`, so an
// over-cap note ended on a half-word ("…the budg…"). Plan 652's refinement: prefer
// the first sentence(s) that fit as the blurb, else the last whole word — so the
// archive bullet stays a coherent one-liner. The cap invariant (≤ CAP, ends with …)
// is unchanged; only the cut POSITION moves to a boundary.

// The last whitespace-delimited word kept (before the trailing …) must be a complete
// token of the source — i.e. the cut never lands inside a word. A trailing sentence
// terminator on the source token is stripped by the clamp, so compare both forms.
function endsOnWholeWord(clamped, source) {
  const oneLine = source.replace(/\s+/g, ' ').trim();
  const kept = clamped.replace(/…$/, '');
  const lastWord = kept.split(' ').filter(Boolean).pop();
  if (lastWord === undefined) return true; // empty clamp (degenerate) — vacuously OK
  return oneLine.split(' ').some((w) => w === lastWord || w.replace(/[.!?]+$/, '') === lastWord);
}

test('clampArchiveNote: truncates on a WORD boundary — never mid-word', () => {
  // cap chosen so the raw slice would land inside "foxtrotgolf"; the clamp must back
  // up to the last whole word ("echo") instead.
  const note = 'Alpha bravo charlie delta echo foxtrotgolf hotel.';
  const clamped = clampArchiveNote('p.md', note, 50);
  assert.equal(clamped, 'Alpha bravo charlie delta echo…');
  assert.ok(clamped.endsWith('…'));
  assert.ok(`- \`p.md\` — ${clamped}`.length <= 50);
  assert.ok(endsOnWholeWord(clamped, note), 'no mid-word cut');
});

test('clampArchiveNote: prefers the first sentence as the blurb when it fits', () => {
  // The first sentence comfortably fills the budget; rather than splice a fragment
  // of the second, the clamp keeps the whole first sentence (terminator stripped).
  const note = 'First short sentence. Second sentence that overflows the budget here.';
  const clamped = clampArchiveNote('p.md', note, 50);
  assert.equal(clamped, 'First short sentence…');
  assert.ok(`- \`p.md\` — ${clamped}`.length <= 50);
});

test('clampArchiveNote: a single token longer than the budget still hard-cuts (no word boundary to find)', () => {
  const note = 'x'.repeat(120); // one unbroken token
  const clamped = clampArchiveNote('p.md', note, 50);
  assert.ok(clamped.endsWith('…'));
  assert.ok(`- \`p.md\` — ${clamped}`.length <= 50);
});

test('clampArchiveNote: hard-cut strips a trailing terminator so the ellipsis reads cleanly (no ".…")', () => {
  // A single unbroken token whose cut lands exactly on a sentence terminator: the
  // hard-cut path must still strip it, like the sentence/word paths do.
  const note = `${'x'.repeat(37)}.more-text-with-no-spaces-at-all-here`;
  const clamped = clampArchiveNote('p.md', note, 50);
  assert.ok(!clamped.includes('.…'), 'no period directly before the ellipsis');
  assert.ok(clamped.endsWith('…'));
  assert.ok(`- \`p.md\` — ${clamped}`.length <= 50);
});

test('clampArchiveNote: a realistic >CAP multi-sentence summary clamps to a coherent boundary (plan 440 scenario)', () => {
  const slug = '440-Infra-some-realistic-plan-slug.md';
  const summary =
    'Render frontend egress hit 7.08 GB over 30 days, dominated by record-photo ' +
    'thumbnails served at full resolution rather than the responsive size each card ' +
    'actually needs. The fix downscales every photo to a responsive srcset at build ' +
    'time and serves AVIF with a WebP fallback, cutting the median payload by roughly ' +
    'four-fifths across the directory, the map cards, and the record detail page. A ' +
    'follow-up audits the remaining hero images, which are still shipped uncompressed ' +
    'on the landing page today and dwarf every other asset in the critical path.';
  const note = `archived 2026-06-15 (session 566), merged \`abc1234\`. ${summary}`;
  assert.ok(note.length > CAP, 'fixture note must exceed CAP to exercise the clamp');
  const clamped = clampArchiveNote(slug, note);
  const rendered = `- \`${slug}\` — ${clamped}`;
  assert.ok(rendered.length <= CAP, `rendered bullet ${rendered.length} must be <= ${CAP}`);
  assert.ok(clamped.endsWith('…'));
  assert.ok(endsOnWholeWord(clamped, note), 'no mid-word cut on a realistic summary');
  // The clamp's own job is length, and it satisfies that (asserted above). It does NOT
  // condense to prefix-only — insertArchiveNarrativeLine is a plain inserter (plan 3971
  // review r1, A) — so the lint's separate narrative check still (correctly) flags the
  // produced bullet; see the insertArchiveNarrativeLine test above for that contract.
  const out = insertArchiveNarrativeLine(FIXTURE_WITH_SENTINEL, slug, note);
  const offenders = findOverlongArchiveBullets(out);
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, 'narrative');
});

// --- plan 2678: category-subfolder bullets ------------------------------------
// Before this plan, parseGeneratedBullet split the path token on the FIRST slash
// only, so a categorised path (`parked/denmark/9-X-y.md`) yielded `basename:
// "denmark/9-X-y.md"` — every `records.findIndex(r => r.basename === slug)` in
// addBullet/removeBullet/repathBullet then missed a categorised bullet entirely
// (findIndex returns -1 ⇒ "not found"), and planIdOf(basename) read the sort key
// as Infinity. classifyPlanRel is now the shared splitter, so basename stays bare
// and category is captured separately.

test('plan 2678: parseGeneratedBullet on a categorised bullet returns a status-only status, a BARE basename, and the category', () => {
  const line = '- 🟩 Baz plan. → `parked/denmark/900-Infra-x.md`';
  assert.deepEqual(parseGeneratedBullet(line), {
    marker: '🟩',
    summary: 'Baz plan.',
    status: 'parked', // NOT "parked/denmark"
    category: 'denmark',
    basename: '900-Infra-x.md', // NOT "denmark/900-Infra-x.md"
  });
});

test('plan 2678: removeBullet(content, bareBasename) finds and removes a categorised bullet', () => {
  // Without the classifyPlanRel fix, records[i].basename would be "infra/900-Infra-x.md"
  // and this findIndex(r => r.basename === '900-Infra-x.md') would come up -1, throwing
  // "active bullet not found" for a bullet that is plainly right there.
  const existing = [
    { status: 'ready', category: 'infra', basename: '900-Infra-x.md', marker: '🟩', summary: 'X.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = removeBullet(content, '900-Infra-x.md');
  const expected = wrapGenerated(renderPlansBlock([]));
  assert.equal(out, expected);
  assert.ok(!out.includes('900-Infra-x.md'));
});

test('plan 2678: repathBullet moves a bullet into a NEW status group and writes the full categorised path token', () => {
  // 'parked/denmark/…' is NOT usable here (see the PRODUCTION BUG note in this task's
  // report — repathBullet hard-throws on any status outside STATUS_ORDER, and parked/
  // is deliberately excluded from STATUS_ORDER, so a generated-format repath into
  // parked/ throws "not a known plan folder" instead of relocating the bullet). This
  // pin uses in-progress/, an eligible STATUS_ORDER member, to cover the same
  // categorised-repath mechanics (new status group + full path token written).
  const existing = [
    { status: 'ready', basename: '475-Infra-baz.md', marker: '🟩', summary: 'Baz plan.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = repathBullet(content, '475-Infra-baz.md', 'in-progress/denmark/475-Infra-baz.md');
  const expected = wrapGenerated(
    renderPlansBlock([
      {
        status: 'in-progress',
        category: 'denmark',
        basename: '475-Infra-baz.md',
        marker: '🟩',
        summary: 'Baz plan.',
      },
    ]),
  );
  assert.equal(out, expected);
  assert.ok(out.includes('**in-progress/**'));
  assert.ok(out.includes('→ `in-progress/denmark/475-Infra-baz.md`'));
});

test('plan 2678: repathBullet to a bare "<status>/<basename>" CLEARS an existing category', () => {
  const existing = [
    { status: 'ready', category: 'infra', basename: '900-Infra-x.md', marker: '🟩', summary: 'X.' },
  ];
  const content = wrapGenerated(renderPlansBlock(existing));
  const out = repathBullet(content, '900-Infra-x.md', 'ready/900-Infra-x.md');
  const expected = wrapGenerated(
    renderPlansBlock([
      { status: 'ready', category: null, basename: '900-Infra-x.md', marker: '🟩', summary: 'X.' },
    ]),
  );
  assert.equal(out, expected);
  assert.ok(out.includes('→ `ready/900-Infra-x.md`')); // no "infra/" survives
});

// --- plan 3971: condenseArchiveRows — shrink existing spine-shaped rows to prefix-only ---
// The operator chose to drop the summary sentence from every archive row (the plan file
// already carries it; the INDEX row is a pointer). This is the one-time (and repeatable,
// idempotent) repair tool for rows the pre-3971 spine already wrote.

// Replace everything from the archive header onward with a caller-supplied set of raw
// archive-region lines, so each test controls exactly what's in the scanned region
// without fighting insertArchiveNarrativeLine's own clamp/anchor behavior.
function fixtureWithArchiveLines(lines) {
  const base = FIXTURE_WITH_SENTINEL.split('\n');
  const headerIdx = base.findIndex((l) => ACTIVE_END_RX.test(l));
  return [...base.slice(0, headerIdx + 1), '', ...lines, ''].join('\n');
}

test('condenseArchiveRows: canonical spine-shaped row is condensed to the bare prefix', () => {
  const row =
    '- `641-Perf-foo.md` — archived 2026-06-15 (session 563), merged `8679c79`. Some summary text here.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes('- `641-Perf-foo.md` — archived 2026-06-15 (session 563), merged `8679c79`.'),
  );
  assert.ok(!content.includes('Some summary text here.'));
});

test('condenseArchiveRows: a batch-tagged row with no summary text keeps its tag, exactly one space before the em dash', () => {
  const row =
    '- `642-Perf-bar.md` — archived 2026-06-16 (session 564), merged `abc1234`. — batch some-slug (4 members).';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  // Already prefix-only (plus tag) — nothing to rewrite.
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row));
});

test('condenseArchiveRows: a row with summary text AND a batch tag keeps only the tag', () => {
  const row =
    '- `643-Perf-baz.md` — archived 2026-06-17 (session 565), merged `def5678`. This has a lot of extra description; multiple sentences. — batch other-slug (12 members).';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes(
      '- `643-Perf-baz.md` — archived 2026-06-17 (session 565), merged `def5678`. — batch other-slug (12 members).',
    ),
  );
  assert.ok(!content.includes('This has a lot of extra description'));
});

test('condenseArchiveRows: a hand-authored row with no "merged" clause is untouched', () => {
  const row = '- `650-Coord-something.md` — superseded by plan 651, no code/seed change.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row));
});

// plan 3971 review r2 (findings bc887f, 9d158f, 576e98): the row uses the REAL grandfathered
// marker (`_(no archive plan file — body retained inline)_`, matching the 4 real rows in
// docs/INDEX.md) — the old fixture text ("no archive plan file, body retained inline." as
// free prose, no parens/italics) matched the PRE-review-r2 unanchored EXEMPT_RX but would not
// match the tightened one, so it stopped being a meaningful EXEMPT test.
test('condenseArchiveRows: an EXEMPT-shaped grandfathered row is untouched', () => {
  const row =
    '- `Some old feature` _(no archive plan file — body retained inline)_ — Did the thing in 2026.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row));
});

// plan 3971 review r1 (B, finding 3d0901): before this fix, an EXEMPT row that ALSO carries
// the canonical archived-date/session/merged-SHA prefix (a grandfathered row whose narrative
// IS its only surviving record) was still rewritten — CONDENSE_ROW_RX matched it and nothing
// checked EXEMPT_RX. The EXEMPT_RX pre-check must win even when the rest of the line still
// mentions archived/merged-shaped text. Review r3 (finding 2197fc) ANCHORED EXEMPT_RX to
// `^- \`name\` _(...)_` (the exact position all 4 real grandfathered rows use) — a row can no
// longer be BOTH exempt-shaped AND spine-shaped at once (both compete for the same position
// right after the backtick token), so this fixture keeps the marker anchored correctly and
// proves the EXEMPT short-circuit still wins even though the tail of the line loosely
// resembles narrative prose that condenseArchiveRow's own shape-matcher is never even
// reached to evaluate.
test('condenseArchiveRows (review r1, B / review r3, finding 2197fc): an EXEMPT row is untouched even when its tail loosely resembles spine prose (finding 3d0901)', () => {
  const row =
    '- `legacy.md` _(no archive plan file — body retained inline)_ — History mentions it was archived 2026-01-01, merged deadbee elsewhere in the sentence.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row), 'the sole historical record survives byte-identical');
});

// plan 3971 review r3 (finding 2197fc, negative case): the marker appearing MID-ROW (not
// anchored right after the backtick token) must NOT exempt a genuinely spine-shaped row —
// the old unanchored EXEMPT_RX would have matched this via a bare substring search anywhere
// in the line.
test('condenseArchiveRows (review r3, finding 2197fc): the grandfather marker mid-row does NOT exempt a normal spine row', () => {
  const row =
    '- `legacy3.md` — archived 2026-03-03 (session 3), merged `cafebabe`. _(no archive plan file — body retained inline)_ this text happens to mention the marker but is not anchored.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes('- `legacy3.md` — archived 2026-03-03 (session 3), merged `cafebabe`.'),
  );
});

// plan 3971 review r2 (finding bc887f/9d158f/576e98, negative case): the OLD unanchored
// EXEMPT_RX matched any row containing the bare substring "no plan file" — real prose in the
// wild says "...trip-condition unmet, no plan filed; future session..." (docs/INDEX.md,
// `157-Other-test-suite-rot-from-parallel-sessions.md`), a normal spine row that MUST
// condense. The tightened regex must NOT treat this as exempt.
test('condenseArchiveRows (review r2): a row containing "no plan filed" prose is NOT exempt — it condenses normally', () => {
  const row =
    '- `157-Other-test-suite-rot.md` — archived 2026-05-27 (session 117), merged `45ce4775`. ' +
    'Carry-forwards: trip-condition unmet, no plan filed; future session can read the archived plan body.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes(
      '- `157-Other-test-suite-rot.md` — archived 2026-05-27 (session 117), merged `45ce4775`.',
    ),
  );
  assert.ok(!content.includes('no plan filed'));
});

// plan 3971 review r1 (B, finding bde157/3d0901): condenseArchiveRows(content, {
// archivedFiles }) — a Set of tracked archive/ basenames — never strips a spine-shaped row's
// narrative when its file isn't (or is no longer) tracked, since that narrative is the row's
// only surviving explanation.
test('condenseArchiveRows (review r1, B): a row whose archived file is present in archivedFiles is condensed', () => {
  const row =
    '- `653-Perf-e.md` — archived 2026-06-26 (session 574), merged `9abcfde`. Present, drop me.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture, {
    archivedFiles: new Set(['653-Perf-e.md']),
  });
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes('- `653-Perf-e.md` — archived 2026-06-26 (session 574), merged `9abcfde`.'),
  );
  assert.ok(!content.includes('Present, drop me'));
});

test('condenseArchiveRows (review r1, B): a row whose archived file is ABSENT from archivedFiles is untouched', () => {
  const row =
    '- `654-Perf-f.md` — archived 2026-06-27 (session 575), merged `abcdef1`. File never landed, keep me.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture, {
    archivedFiles: new Set(['some-other-file.md']), // 654-Perf-f.md is NOT in the set
  });
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row), 'the sole surviving record for a missing file is untouched');
});

test('condenseArchiveRows (review r1, B): EXEMPT_RX still wins even when the file IS in archivedFiles', () => {
  const row =
    '- `legacy2.md` _(no archive plan file — body retained inline)_ — Keep me, session 2, merged abc9876.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture, {
    archivedFiles: new Set(['legacy2.md']), // present in the set, but still EXEMPT
  });
  assert.equal(rewritten, 0);
  assert.ok(content.includes(row));
});

test('condenseArchiveRows (review r1, B): no archivedFiles supplied → shape-only behavior, unchanged from before the fix', () => {
  const row =
    '- `655-Perf-g.md` — archived 2026-06-28 (session 576), merged `bcdef12`. No set supplied, drop me anyway.';
  const fixture = fixtureWithArchiveLines([row]);
  const { content, rewritten } = condenseArchiveRows(fixture); // no options object at all
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes('- `655-Perf-g.md` — archived 2026-06-28 (session 576), merged `bcdef12`.'),
  );
});

test('condenseArchiveRows: an active bullet ABOVE INDEX_PLANS_END (generated region) is untouched', () => {
  // FIXTURE_WITH_SENTINEL's generated block carries one active bullet for 101-P07-beta.md —
  // prove condenseArchiveRows never reaches into the generated region above the sentinel.
  const fixture = fixtureWithArchiveLines([
    '- `644-Perf-qux.md` — archived 2026-06-18 (session 566), merged `1234abc`. Drop me.',
  ]);
  const { content } = condenseArchiveRows(fixture);
  assert.ok(content.includes('→ `in-progress/101-P07-beta.md`')); // active bullet untouched
});

test('condenseArchiveRows: a spine-shaped line AFTER a following "## " header is untouched', () => {
  const inRegionRow =
    '- `645-Perf-quux.md` — archived 2026-06-19 (session 567), merged `2345bcd`. Drop me.';
  const afterHeaderRow =
    '- `999-Fake-not-a-plan.md` — archived 2099-01-01 (session 1), merged `deadbee`. Should not touch.';
  const fixture =
    fixtureWithArchiveLines([inRegionRow]) + ['## Specs', '', afterHeaderRow, ''].join('\n');
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1); // only the in-region row counted
  assert.ok(!content.includes(inRegionRow.slice(inRegionRow.indexOf('Drop me'))));
  assert.ok(content.includes(afterHeaderRow), 'row after the ## header survives byte-identical');
});

test('condenseArchiveRows (review r3, finding a9b8fc): a fenced "## " inside the archive region does not end it', () => {
  const fencedRow =
    '- `998-Fake-fenced.md` — archived 2099-02-02 (session 2), merged `cafebabe`. Drop me too.';
  const fixture = fixtureWithArchiveLines([
    '```',
    '## This looks like a heading but is inside a fence',
    '```',
    fencedRow,
  ]);
  // Before the fix, the fenced "## " line would have wrongly ended the region right there, so
  // fencedRow (past it) would never be scanned — silently left un-condensed.
  const { content, rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes(
      '- `998-Fake-fenced.md` — archived 2099-02-02 (session 2), merged `cafebabe`.',
    ),
  );
  assert.ok(!content.includes('Drop me too'));
});

test('condenseArchiveRows: idempotent — a second run on already-condensed output rewrites 0', () => {
  const fixture = fixtureWithArchiveLines([
    '- `646-Perf-corge.md` — archived 2026-06-20 (session 568), merged `3456cde`. First pass drops this.',
    '- `647-Perf-grault.md` — archived 2026-06-21 (session 569), merged `4567def`. Also drops this. — batch b-slug (2 members).',
  ]);
  const once = condenseArchiveRows(fixture);
  assert.equal(once.rewritten, 2);
  const twice = condenseArchiveRows(once.content);
  assert.equal(twice.rewritten, 0);
  assert.equal(twice.content, once.content);
});

test('condenseArchiveRows: CRLF input is preserved (line endings untouched, rewrite still applies)', () => {
  const row =
    '- `648-Perf-garply.md` — archived 2026-06-22 (session 570), merged `5678efa`. Drop this too.';
  const fixtureLf = fixtureWithArchiveLines([row]);
  const fixtureCrlf = fixtureLf.replace(/\n/g, '\r\n');
  const { content, rewritten } = condenseArchiveRows(fixtureCrlf);
  assert.equal(rewritten, 1);
  assert.ok(
    content.includes(
      '- `648-Perf-garply.md` — archived 2026-06-22 (session 570), merged `5678efa`.\r\n',
    ),
    'the rewritten row keeps its CRLF line ending',
  );
  assert.ok(!content.includes('Drop this too'));
  // No bare \n was introduced anywhere: every \n in the output is still immediately
  // preceded by \r, exactly as in the CRLF input (the rewritten line reattaches its own
  // \r; every untouched line keeps the \r the split left on it).
  assert.doesNotMatch(content, /(?<!\r)\n/);
});

test('condenseArchiveRows: rewritten count matches the number of rows actually changed', () => {
  const fixture = fixtureWithArchiveLines([
    '- `649-Perf-a.md` — archived 2026-06-23 (session 571), merged `6789fab`. Changed one.',
    '- `650-Perf-b.md` — archived 2026-06-24 (session 572), merged `789afbc`.', // already bare, no change
    '- `651-Coord-c.md` — superseded by plan 652, no code/seed change.', // hand-authored, no change
    '- `652-Perf-d.md` — archived 2026-06-25 (session 573), merged `89abfcd`. Changed two. — batch c-slug (5 members).',
  ]);
  const { rewritten } = condenseArchiveRows(fixture);
  assert.equal(rewritten, 2);
});
