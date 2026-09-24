// scripts/build-index-lib.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
// plan 3961 T2.9a ride-along fix: `import()` needs a real specifier, not a raw fs path —
// `pathToFileURL(...).href`, the same fix scripts/coord-config.test.mjs already applies, embedded
// in the generated probe source itself (rather than passed via `process.argv[1]`) so a scratch/
// worktree root on a non-C: drive (E:\Temp\...) never throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
import { pathToFileURL } from 'node:url';
// plan 3960 cluster-2 review fix: a REAL isolated repo (a fresh module graph, per the plan-3960
// T3 test's own precedent in coord-config.test.mjs) is the only way to prove a config VALUE
// actually reaches build-index-lib.mjs's module-scope-resolved label/lane constants — this test
// file's own already-imported module is vetapp's own unconfigured instance.
import { isolatedRepoFactory } from '../test-helpers/isolated-plan-repo.mjs';
import {
  parsePlanMeta,
  readFrontmatterSummary,
  readFrontmatterKey,
  readFrontmatterScalar,
  PRIORITY_VALUES,
  PRIORITY_DEFAULT,
  PRIORITY_SORT_WEIGHT,
  isValidPriorityValue,
  normalizePriorityTier,
  readPriorityTier,
  isHighPriorityTier,
  PRIORITY_BY_DIRECTIVES,
  isValidPriorityByValue,
  readPriorityBy,
  priorityStampProblem,
  priorityStampFixHint,
  upsertFrontmatterKey,
  specReviewGateError,
  specReviewGateErrorFromValues,
  readSeedMarker,
  readSeedWriteValue,
  planIdOf,
  renderBullet,
  renderPlansBlock,
  splicePlansBlock,
  INDEX_PLANS_START,
  INDEX_PLANS_END,
  parseSpecMeta,
  specBucket,
  renderSpecsBlock,
  spliceSpecsBlock,
  INDEX_SPECS_START,
  INDEX_SPECS_END,
  STATUS_ORDER,
  ALL_PLAN_FOLDERS,
  PLAN_FOLDER_ALT,
  WAITING_FOLDERS,
  isWaitingFolder,
  PLAN_FILENAME_RX,
  PLAN_TAG_SOURCE,
  PLAN_CATEGORY_RX,
  FLAT_ONLY_PLAN_FOLDERS,
  planNestingViolation,
  classifyPlanRel,
  classifyPlanPaths,
  planRelFor,
  walkPlanTree,
  walkPlanStatusDir,
  nextHeadingBoundary,
  specVerdictRegion,
  specVerdictRegions,
  stripFencedBlocks,
  sectionBounds,
  multiSectionBounds,
  claimedIdOfBasename,
  stripFrontmatter,
  splitFrontmatter,
  frontmatterEnd,
  STATUS_LINE_RX,
  STATUS_BLOCK_RX,
  COST_BANNER_RX,
  SEED_BANNER_RX,
  H1_RX,
  assertEvidenceFloorOk,
  cloudExecUnstampedWarning,
  hasFrontmatterKey,
  MUTATION_BANNER_LABEL,
} from './build-index-lib.mjs';
// plan 3958: this module ships as-is into the public coord-kit (scripts/coord/ is copied
// wholesale), so MUTATION_BANNER_LABEL resolves to the KIT's neutral default ('DATA-WRITE')
// there, not vetapp's real 'SEED-WRITE' row — every fixture below that hardcodes the literal
// banner text runs through this helper instead. On vetapp itself MUTATION_BANNER_LABEL IS
// 'SEED-WRITE', so `sw(x)` is the IDENTITY function there — this changes nothing about vetapp's
// own test behavior, it only makes the SAME fixtures portable to whatever label a repo actually
// configures.
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);
import * as buildIndexLib from './build-index-lib.mjs';
import * as movePlan from './move-plan.mjs';
// plan 3999 review fix round 1 (key 488889): the shared calendar-date check
// isValidPriorityByValue now imports, rather than re-implementing locally.
import { isCalendarDate } from './exec-model-default-lib.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';

// plan 3960 cluster-2 review fix: one isolated repo factory for the mutationBanner.label test
// below — body/basename are unused by that test (it never reads the seed plan file), so both
// are placeholders.
const makeCoordLabelRepo = isolatedRepoFactory({
  prefix: 'coord-label-iso',
  basename: '900-Coord-label-plan.md',
  body: '---\nsummary: plan 3960 cluster-2 label fixture\n---\n\n# 900-Coord-label-plan\n',
});

// --- ALL_PLAN_FOLDERS / PLAN_FOLDER_ALT (plan 1447 single-source derive) -----

// plan 3960 cluster-6 review fix: PLAN_FOLDER_ALT used to join folder names into a regex
// alternation UNESCAPED — a configured lane name is free-form text (coord-config.mjs's lane
// validation only requires non-empty + no duplicates), so a renamed lane containing a regex
// metacharacter (e.g. "review.pending") would silently change what a regex BUILT from
// PLAN_FOLDER_ALT matches, since a bare `.` matches any character. Proven with a REAL isolated
// repo whose coord.config.json renames a lane to a dotted name.
test('PLAN_FOLDER_ALT escapes a configured lane name containing a regex metacharacter (cluster-6 review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { waitingBlocked: 'review.pending' } }),
    );
    const probePath = join(repo.dir, 'probe.mjs');
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    writeFileSync(
      probePath,
      [
        `import { PLAN_FOLDER_ALT } from ${JSON.stringify(buildIndexLibUrl)};`,
        'const rx = new RegExp(`^(?:${PLAN_FOLDER_ALT})$`);',
        'process.stdout.write(JSON.stringify({',
        // The literal renamed folder name matches.
        "  matchesLiteral: rx.test('review.pending'),",
        // An UNESCAPED `.` would also match "reviewXpending" (any char in the dot's place) —
        // this must NOT match once the dot is escaped.
        "  matchesWildcardStandIn: rx.test('reviewXpending'),",
        '}));',
      ].join('\n'),
    );
    const probe = spawnSync(process.execPath, [probePath], { cwd: repo.dir, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.matchesLiteral, true);
    assert.equal(result.matchesWildcardStandIn, false, 'the "." must be escaped, not a wildcard');
  } finally {
    repo.cleanup();
  }
});

// plan 3960 review fix (findings 18/21): the ONE configured-waiting-lane predicate — move-plan.mjs
// used to build this Set locally, and done-worktree.mjs's batch close-out (archiveBatchMembers)
// either tested the literal `startsWith('waiting-')` or imported claim-plan-lib.mjs's own
// hardcoded-prefix version, so a renamed `lanes.waitingOperator`/etc. was
// recognized by move-plan but NOT by the batch close-out path, which then archived a re-parked
// plan instead of skipping it as reparked-skipped.
test('WAITING_FOLDERS/isWaitingFolder: the five configured waiting lanes, by default value', () => {
  assert.deepEqual(
    [...WAITING_FOLDERS].sort(),
    ['waiting-blocked', 'waiting-date', 'waiting-grill', 'waiting-operator', 'waiting-trip'].sort(),
  );
  assert.equal(isWaitingFolder('waiting-operator'), true);
  assert.equal(isWaitingFolder('in-progress'), false);
  assert.equal(isWaitingFolder('archive'), false);
});

test('isWaitingFolder: a configured lanes.waitingOperator rename is recognized, and the OLD name no longer is (review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ lanes: { waitingOperator: 'frozen' } }),
    );
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(buildIndexLibUrl)}).then((m) => {`,
          '  process.stdout.write(JSON.stringify({',
          "    frozenIsWaiting: m.isWaitingFolder('frozen'),",
          "    oldNameNoLongerWaiting: m.isWaitingFolder('waiting-operator'),",
          '  }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.frozenIsWaiting, true);
    assert.equal(result.oldNameNoLongerWaiting, false);
  } finally {
    repo.cleanup();
  }
});

test('ALL_PLAN_FOLDERS is STATUS_ORDER plus archive + parked appended, in that order', () => {
  assert.deepEqual(ALL_PLAN_FOLDERS, [...STATUS_ORDER, 'archive', 'parked']);
});

test('ALL_PLAN_FOLDERS includes every frozen + active folder exactly once', () => {
  const expected = [
    'in-progress',
    'ready',
    'pending-approval',
    'waiting-blocked',
    'waiting-operator',
    'waiting-grill',
    'waiting-date',
    'waiting-trip',
    'archive',
    'parked',
  ];
  assert.deepEqual([...ALL_PLAN_FOLDERS].sort(), [...expected].sort());
  assert.equal(new Set(ALL_PLAN_FOLDERS).size, ALL_PLAN_FOLDERS.length);
});

// plan 2034: the batched operator-grilling lane sits between waiting-operator and
// waiting-date — a STATUS_ORDER member (renders in INDEX, claimable as an override)
// like every other waiting lane.
test('STATUS_ORDER: waiting-grill sits directly after waiting-operator (plan 2034)', () => {
  const io = STATUS_ORDER.indexOf('waiting-operator');
  const ig = STATUS_ORDER.indexOf('waiting-grill');
  assert.ok(io !== -1 && ig !== -1, 'both lanes must be STATUS_ORDER members');
  assert.equal(ig, io + 1);
});

test('PLAN_FOLDER_ALT is ALL_PLAN_FOLDERS joined by "|" (a valid regex alternation)', () => {
  assert.equal(PLAN_FOLDER_ALT, ALL_PLAN_FOLDERS.join('|'));
  for (const folder of ALL_PLAN_FOLDERS) {
    assert.match(folder, new RegExp(`^(?:${PLAN_FOLDER_ALT})$`));
  }
});

// --- PLAN_FILENAME_RX / PLAN_TAG_SOURCE (plan 1945 single-source derive) -----

test('PLAN_FILENAME_RX is built from PLAN_TAG_SOURCE (single source, not a re-declared literal)', () => {
  assert.equal(PLAN_FILENAME_RX.source, new RegExp(`^${PLAN_TAG_SOURCE}.+\\.md$`).source);
});

test('PLAN_FILENAME_RX accepts an uppercase-led category tag', () => {
  assert.match('1945-Infra-plan-filename-tag-validation-mint-gate.md', PLAN_FILENAME_RX);
  assert.match('077-Other-claude-haiku-429-retry.md', PLAN_FILENAME_RX);
});

test('PLAN_FILENAME_RX rejects a lowercase-led category tag (the plan-1928 repro)', () => {
  assert.doesNotMatch('1928-tooling-routine-ctl-no-llm-trigger-cli.md', PLAN_FILENAME_RX);
});

test('PLAN_FILENAME_RX rejects a 2-digit id, a missing category, and a non-.md file', () => {
  assert.doesNotMatch('45-Infra-too-short-id.md', PLAN_FILENAME_RX);
  assert.doesNotMatch('1945.md', PLAN_FILENAME_RX);
  assert.doesNotMatch('1945-Infra-plan.txt', PLAN_FILENAME_RX);
});

// --- STATUS_LINE_RX / STATUS_BLOCK_RX (plan 2409: STATUS_LINE_RX exported so
// next-plan-id.mjs's presence test shares one definition instead of a fourth
// hand-roll) ------------------------------------------------------------------

test('STATUS_LINE_RX matches a bare Status line', () => {
  assert.match('**Status:** 📋 READY.', STATUS_LINE_RX);
});

test('STATUS_BLOCK_RX starts with the SAME Status-line pattern text as STATUS_LINE_RX, plus the annotation-key alternation, and both share flags (plan 2409: no independently hand-typed flag literal to drift)', () => {
  const lineCore = STATUS_LINE_RX.source.slice(1, -1); // strip the wrapping ^ and $
  assert.equal(
    STATUS_BLOCK_RX.source,
    `^${lineCore}(?:\\n\\*\\*(?:Previous status|Override|Takeover):\\*\\*.*)*$`,
  );
  assert.equal(STATUS_BLOCK_RX.flags, STATUS_LINE_RX.flags);
});

// --- COST_BANNER_RX / SEED_BANNER_RX (plan 2409: narrowed insertion anchor) --
// Plan 2360 round 4 widened the shared anchor to match a 💰 glyph ANYWHERE on a
// line containing "Cost forecast", which let plain prose hijack the anchor. Plan
// 2409 narrows it back to requiring the glyph lead the line (tolerating a `>`
// quote marker and/or `**` bold-open) while still tolerating every real banner
// shape found in the corpus at spec-pass.

test('COST_BANNER_RX does NOT match a prose sentence merely discussing a cost forecast', () => {
  assert.doesNotMatch('the previous 💰 cost forecast already covered this', COST_BANNER_RX);
});

test('COST_BANNER_RX matches every real corpus banner shape (spec-pass enumeration)', () => {
  const shapes = [
    '> 💰 **Cost forecast:** $0 (deterministic).',
    '💰 Cost forecast: ~1 short session. No LLM spend.',
    sw('> 🟩 **SEED-WRITE: no** — code only.\n> 💰 **Cost forecast:** $0.'),
  ];
  for (const shape of shapes) {
    assert.match(shape, COST_BANNER_RX, `expected a match for: ${shape}`);
  }
});

test('COST_BANNER_RX misses a FUSED SEED-WRITE+cost-forecast line (💰 mid-line) — acceptable by construction, the fallback anchor still catches one of the two', () => {
  const fused1677 = sw(
    '> 🟩 **SEED-WRITE: NO**. 💰 **Cost forecast:** ~$0 (mechanical refactor + tests).',
  );
  const fused1766 = sw(
    '🟩 SEED-WRITE: no. 💰 Cost forecast: small (~half a session, no LLM arms).',
  );
  assert.doesNotMatch(fused1677, COST_BANNER_RX);
  assert.doesNotMatch(fused1766, COST_BANNER_RX);
  // 1677 still matches the next anchor in the preference order, same line:
  assert.match(fused1677, SEED_BANNER_RX);
  // 1766 has no `>` quote marker, so it falls through to the H1 anchor instead —
  // both source plans are archived and already carry Status lines, so neither
  // anchor path ever actually runs for them.
  assert.doesNotMatch(fused1766, SEED_BANNER_RX);
});

test('H1_RX matches a markdown H1 line (plan 2409: consolidated out of three hand-copies — claim-plan-lib, plan-body-state, next-plan-id)', () => {
  assert.match('# A Title', H1_RX);
  assert.doesNotMatch('## Not an H1', H1_RX);
  assert.doesNotMatch('#NoSpace', H1_RX);
});

test('readFrontmatterSummary reads a quoted scalar', () => {
  const c = ['---', 'summary: "Does the thing → safely"', 'foo: bar', '---', '# Title'].join('\n');
  assert.equal(readFrontmatterSummary(c), 'Does the thing → safely');
});

test('readFrontmatterSummary reads an unquoted scalar', () => {
  const c = ['---', 'summary: plain text here', '---', '# Title'].join('\n');
  assert.equal(readFrontmatterSummary(c), 'plain text here');
});

test('readFrontmatterSummary reads a prettier single-quoted scalar (doubled apostrophe)', () => {
  // prettier emits single quotes + '' escaping when the value contains "double quotes"
  const c = [
    '---',
    "summary: 'clinic-398''s pricelist had \"5 Besiktning\" rows'",
    '---',
    '# T',
  ].join('\n');
  assert.equal(readFrontmatterSummary(c), 'clinic-398\'s pricelist had "5 Besiktning" rows');
});

test('readFrontmatterSummary returns empty when no frontmatter', () => {
  assert.equal(readFrontmatterSummary('# Title\n\nbody'), '');
});

test('readSeedMarker maps banner YES/NO and defaults to green', () => {
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE: YES** — mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE: NO** — docs only')), '🟩');
  assert.equal(readSeedMarker('no banner at all'), '🟩');
});

test('readSeedMarker reads the leading banner emoji on the BARE form (no YES/NO)', () => {
  // The documented bare banner `> 🟥/🟩 **SEED-WRITE**` carries the signal in the
  // emoji. Before plan 362 these silently defaulted to 🟩 — wrong for a 🟥 plan.
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE** — mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE** — docs only')), '🟩');
});

test('readSeedMarker parses the value-bearing banner in all bold/colon conventions (plan 723)', () => {
  // The `**` may close before OR after the colon, and the YES/NO value may sit
  // inside or outside the bold. All must parse the VALUE directly — NOT lean on
  // the bare-banner emoji fallback or the 🟩 default (which would mask a parse miss).
  // value inside bold:
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE: yes** — mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE: no** — docs only')), '🟩');
  // value outside bold, colon INSIDE bold (the plan-718/722 form that used to drift):
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE:** yes — mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE:** no — docs only')), '🟩');
  // value outside bold, colon OUTSIDE bold:
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE**: yes — mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE**: no — docs only')), '🟩');
});

test('readSeedMarker ignores a SEED-WRITE banner quoted in the YAML frontmatter (plan 723 self-reference)', () => {
  // A 🟩 plan whose `summary:` describes the `**SEED-WRITE:** yes` form must NOT
  // have its metadata mistaken for the banner — the body banner is authoritative.
  const c = [
    '---',
    sw('summary: "Harden readSeedMarker to parse the **SEED-WRITE:** yes banner form"'),
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: no** — touches only scripts/coord/build-index-lib.mjs'),
    '',
    '## Problem',
    sw('Neither regex matches `> 🟥 **SEED-WRITE:** yes` (an example in prose).'),
  ].join('\n');
  assert.equal(readSeedMarker(c), '🟩');
});

test('readSeedMarker: value-outside-bold YES wins even when the emoji is 🟩 (no silent 🟩 drift)', () => {
  // The 722 failure mode: a 🟥 plan written `**SEED-WRITE:** yes` must not fall
  // through to 🟩. Force the emoji to 🟩 so a regex miss could ONLY surface as a
  // wrong 🟩 — proving the value (not the emoji or the default) drives the result.
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE:** yes — actually mutates seed')), '🟥');
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE**: yes — actually mutates seed')), '🟥');
});

test('readSeedMarker: explicit YES/NO wins over a stray banner emoji (precedence)', () => {
  // A stray 🟥 elsewhere in prose must NOT flip an explicit `SEED-WRITE: NO` to red.
  const stray = [
    '> 🟥 heads-up: touches a red-flagged area',
    sw('> 🟩 **SEED-WRITE: NO** — docs only'),
  ].join('\n');
  assert.equal(readSeedMarker(stray), '🟩');
  // ...and explicit YES wins even when the banner emoji is 🟩 (mismatch → trust the
  // machine-readable form, not the emoji).
  assert.equal(readSeedMarker(sw('> 🟩 **SEED-WRITE: YES** — actually mutates seed')), '🟥');
});

// The full live-convention table (plan 1324, folding 1288): every banner form
// authors have actually written — value YES/NO/MAYBE/conditional × colon inside
// vs outside the bold × with vs without emoji. A 🟥-emoji banner must NEVER
// parse 🟩 (the 2026-07-02 drift: `> 🟥 **SEED-WRITE: conditional**` and
// `> 🟥 **SEED-WRITE: MAYBE**` both rendered 🟩 in INDEX / the Bases mirror /
// stamp-plan-seedwrite --check).
test('readSeedMarker: live-convention table — every 🟥 form is 🟥, every 🟩 form is 🟩 (plan 1324)', () => {
  const red = [
    sw('> 🟥 **SEED-WRITE: YES** — value+colon inside bold'),
    sw('> 🟥 **SEED-WRITE:** yes — colon inside, value outside'),
    sw('> 🟥 **SEED-WRITE**: yes — colon outside bold'),
    sw('> 🟥 SEED-WRITE: yes — no bold at all'),
    sw('> 🟥 SEED-WRITE yes — no bold, no colon'),
    sw('**SEED-WRITE: yes** — no emoji, value inside bold'),
    sw('**SEED-WRITE:** yes — no emoji, colon inside bold'),
    sw('SEED-WRITE: YES — bare machine-readable line'),
    sw('> 🟥 **SEED-WRITE: MAYBE** — the plan-1282 form'),
    sw('> 🟥 **SEED-WRITE:** MAYBE'),
    sw('**SEED-WRITE:** MAYBE — no emoji: unsure must not render merges-freely'),
    sw('> 🟥 **SEED-WRITE: conditional** — the plan-1278 form (unparseable value)'),
    sw('> 🟥 **SEED-WRITE**: conditional'),
    sw('> 🟥 SEED-WRITE: possibly — invented value, emoji is authoritative'),
    sw('> 🟥 **SEED-WRITE** — bare documented form'),
    sw('> 🟥 ***SEED-WRITE:*** yes — bold+italic (queue-drain pre-1324 grammar, review finding)'),
  ];
  const green = [
    sw('> 🟩 **SEED-WRITE: NO** — value+colon inside bold'),
    sw('> 🟩 **SEED-WRITE:** no — colon inside, value outside'),
    sw('> 🟩 **SEED-WRITE**: no — colon outside bold'),
    sw('> 🟩 SEED-WRITE: no — no bold at all'),
    sw('**SEED-WRITE: no** — no emoji, value inside bold'),
    sw('SEED-WRITE: NO — bare machine-readable line'),
    sw('> 🟩 **SEED-WRITE: conditional** — unparseable value, emoji is authoritative'),
    sw('> 🟩 **SEED-WRITE** — bare documented form'),
    sw('***SEED-WRITE:*** no — bold+italic, no emoji (queue-drain pre-1324 grammar)'),
  ];
  for (const banner of red) assert.equal(readSeedMarker(banner), '🟥', `expected 🟥: ${banner}`);
  for (const banner of green) assert.equal(readSeedMarker(banner), '🟩', `expected 🟩: ${banner}`);
});

test('readSeedWriteValue: explicit value → lowercased; emoji fallback → yes/no; nothing → null', () => {
  assert.equal(
    readSeedWriteValue(sw('> 🟩 **SEED-WRITE: MAYBE** — explicit beats emoji')),
    'maybe',
  );
  assert.equal(readSeedWriteValue(sw('> 🟥 **SEED-WRITE: conditional** — emoji fallback')), 'yes');
  assert.equal(readSeedWriteValue(sw('> 🟩 **SEED-WRITE: conditional** — emoji fallback')), 'no');
  assert.equal(readSeedWriteValue('no banner anywhere'), null);
  // `\b` guard: a word STARTING with no/yes must not half-match as a value.
  assert.equal(readSeedWriteValue(sw('SEED-WRITE: nothing decided yet')), null);
});

// plan 3960 cluster-2 review fix: readSeedWriteValue (the AUTHORITATIVE banner parser) used to
// hardcode the "SEED-WRITE" literal even after SEED_BANNER_ANCHOR_RX was made to read
// mutationBanner.label — so a repo configuring a different label could never have its banner
// parsed. Proven with a REAL isolated repo (a fresh module graph under its own dirname, per the
// plan-3960 T3 test's own precedent) carrying a coord.config.json that renames the label, rather
// than asserting against this test file's already-loaded module (which is vetapp's own,
// unconfigured instance and would trivially "pass" without proving anything).
test('readSeedWriteValue: a configured mutationBanner.label is what the parser actually reads (cluster-2 review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ mutationBanner: { label: 'DATA-WRITE' } }),
    );
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(buildIndexLibUrl)}).then((m) => {`,
          '  process.stdout.write(JSON.stringify({',
          "    configured: m.readSeedWriteValue('> 🟥 **DATA-WRITE: YES** — renamed label'),",
          // Deliberately NOT run through sw(): this line asserts that the OLD label text
          // ("SEED-WRITE" literally) no longer matches once the isolated repo's config renames
          // the label to DATA-WRITE — sw() would defeat that by rewriting it to whatever label
          // the OUTER (parent) process has configured, which is exactly the wrong text here.
          "    oldLabelNoLongerMatches: m.readSeedWriteValue('> 🟥 **SEED-WRITE: YES** — old label'),",
          '  }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.configured, 'yes');
    assert.equal(result.oldLabelNoLongerMatches, null);
  } finally {
    repo.cleanup();
  }
});

// plan 3960 review fix (findings 1/2/15/16): SEED_BANNER_RX itself — the looser export every
// STATUS-LINE INSERTION consumer anchors on (plan-body-state.mjs's setStatusLine,
// claim-plan-lib.mjs's flipStatusToInProgress, next-plan-id.mjs's ensureReadyStatusLine) and the
// UNCLAIMED-DRAIN marker projector (reconcile-drain-markers.mjs) — used to stay a hardcoded
// "SEED-WRITE" literal even after SEED_BANNER_ANCHOR_RX (a sibling export, same module) was made
// to read mutationBanner.label. A repo configuring a different label therefore had every ONE of
// those consumers silently miss the anchor and fall back to their next insertion point (or, for
// the marker reconciler, project nothing at all) — proven here the same way the sibling
// readSeedWriteValue test above proves its own parser: a REAL isolated repo whose
// coord.config.json renames the label, a fresh module graph, never this test file's own
// already-loaded (unconfigured) instance.
test('SEED_BANNER_RX: a configured mutationBanner.label is what the loose banner-anchor export actually matches (review fix)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ mutationBanner: { label: 'DATA-WRITE' } }),
    );
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(buildIndexLibUrl)}).then((m) => {`,
          '  process.stdout.write(JSON.stringify({',
          "    configuredMatches: m.SEED_BANNER_RX.test('> 🟥 **DATA-WRITE: YES** — renamed label'),",
          // Deliberately NOT run through sw() — same reasoning as the sibling
          // readSeedWriteValue test above.
          "    oldLabelNoLongerMatches: m.SEED_BANNER_RX.test('> 🟥 **SEED-WRITE: YES** — old label'),",
          '  }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.configuredMatches, true);
    assert.equal(result.oldLabelNoLongerMatches, false);
  } finally {
    repo.cleanup();
  }
});

// plan 3961 T3.1a: MUTATION_BANNER_FLAG mirrors MUTATION_BANNER_LABEL's own configurability —
// give it the equivalent coverage: a CONFIGURED flag is what the carry-forward minter (which
// imports this export) would pass to `next-plan-id.mjs claim`. Same isolated-repo, fresh-module-
// graph proof as the label tests above, never this test file's own (unconfigured) instance.
test('MUTATION_BANNER_FLAG: a configured mutationBanner.flag is what the minter would pass (plan 3961 T3.1a)', () => {
  const repo = makeCoordLabelRepo();
  try {
    writeFileSync(
      join(repo.dir, 'coord.config.json'),
      JSON.stringify({ mutationBanner: { flag: '--data-write' } }),
    );
    const buildIndexLibUrl = pathToFileURL(repo.toolPath('build-index-lib.mjs')).href;
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `import(${JSON.stringify(buildIndexLibUrl)}).then((m) => {`,
          '  process.stdout.write(JSON.stringify({ flag: m.MUTATION_BANNER_FLAG }));',
          '});',
        ].join('\n'),
      ],
      { cwd: repo.dir, encoding: 'utf8' },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const result = JSON.parse(probe.stdout.trim());
    assert.equal(result.flag, '--data-write');
  } finally {
    repo.cleanup();
  }
});

// Review finding (plan 1324): the explicit match is first-anywhere-in-body, so
// the colon requirement is what keeps colon-less PROSE about the convention
// ("the SEED-WRITE yes/no forms…") from overriding the real banner below it.
test('readSeedWriteValue: colon-less prose before the banner does not override it', () => {
  const c = [
    sw('Authors keep inventing SEED-WRITE yes variants in the wild.'),
    '',
    sw('> 🟩 **SEED-WRITE: NO** — docs only'),
  ].join('\n');
  assert.equal(readSeedWriteValue(c), 'no');
  assert.equal(readSeedMarker(c), '🟩');
});

// The emoji fallback is deliberately TWO-step (bold banner form first, loose
// mention second): with no explicit value anywhere, a loose 🟥 prose mention
// on an EARLIER line must not outrank the actual bare-form banner (review
// finding asked for this precedence to be exercised, not just asserted in a
// comment).
test('readSeedWriteValue: bare-form bold banner beats an earlier loose emoji mention', () => {
  const c = [
    sw('> 🟥 heads-up: SEED-WRITE plans serialize under the LANDING mutex'),
    '',
    sw('> 🟩 **SEED-WRITE** — docs only'),
  ].join('\n');
  assert.equal(readSeedWriteValue(c), 'no');
});

// --- stripFrontmatter: block-scalar hardening (plan 2368) --------------------
//
// stripFrontmatter now delegates fence detection to frontmatterEnd/isFenceLine —
// THE single fence rule — instead of carrying a second literal that trimmed BOTH
// ends of a candidate fence. That literal terminated the scan on the first line
// that merely TRIMMED to `---`, so a YAML block scalar (`summary: |`) containing an
// indented `---` ended the frontmatter early and everything after it — still
// frontmatter — was handed to the banner parsers as "body". Trailing whitespace on
// the real fence stays tolerated; a corpus run over all 2414 tracked plan files
// found ZERO output differences.

test('stripFrontmatter: a --- inside a block scalar is not the closing fence (plan 2368)', () => {
  const content = [
    '---',
    'summary: |',
    '  quoting an old draft:',
    '  ---',
    sw('  > 🟥 **SEED-WRITE: YES** — bogus, still inside the frontmatter'),
    '  more notes.',
    '---',
    '',
    sw('> 🟩 **SEED-WRITE: NO** — the real banner'),
  ].join('\n');
  const body = stripFrontmatter(content);
  assert.doesNotMatch(body, /bogus/);
  // The consumer that motivated the guard: the seed banner parse must see only the
  // real body banner, not the one quoted inside the scalar.
  assert.equal(readSeedWriteValue(content), 'no');
  assert.equal(readSeedMarker(content), '🟩');
  // splitFrontmatter rides on the same scan, so its prefix/body split moves too.
  const { prefix, body: split } = splitFrontmatter(content);
  assert.match(prefix, /bogus/);
  assert.equal(split, body);
});

test('stripFrontmatter: trailing whitespace on the real fence is still tolerated; an indented one is not (plan 2368)', () => {
  assert.equal(stripFrontmatter(['---', 'a: 1', '--- ', 'body'].join('\n')), 'body');
  // Indented fence ⇒ not a fence ⇒ unterminated ⇒ content unchanged. Asserted
  // against frontmatterEnd too: the point of plan 2368 is that these two agree.
  const indented = ['---', 'a: 1', '  ---', 'not body'].join('\n');
  assert.equal(stripFrontmatter(indented), indented);
  assert.equal(frontmatterEnd(indented.split('\n')), -1);
});

test('stripFrontmatter: no leading fence / unterminated ⇒ content unchanged (fallbacks kept)', () => {
  assert.equal(stripFrontmatter('# plain plan\n\nbody'), '# plain plan\n\nbody');
  const unterminated = ['---', 'summary: x', 'never closed'].join('\n');
  assert.equal(stripFrontmatter(unterminated), unterminated);
});

test('parsePlanMeta falls back to H1 when no frontmatter summary', () => {
  const c = ['# My Plan Title', '', sw('> 🟥 **SEED-WRITE: YES** — x')].join('\n');
  const meta = parsePlanMeta(c);
  assert.equal(meta.summary, 'My Plan Title');
  assert.equal(meta.marker, '🟥');
  assert.equal(meta.hasFrontmatterSummary, false);
});

test('parsePlanMeta prefers frontmatter summary over H1', () => {
  const c = [
    '---',
    'summary: short blurb',
    '---',
    '# Long H1 Title',
    sw('> 🟩 **SEED-WRITE: NO**'),
  ].join('\n');
  const meta = parsePlanMeta(c);
  assert.equal(meta.summary, 'short blurb');
  assert.equal(meta.marker, '🟩');
  assert.equal(meta.hasFrontmatterSummary, true);
});

test('parsePlanMeta (plan 2328): priority: high prefixes ⚡ onto the marker as one token', () => {
  const hi = parsePlanMeta(
    ['---', 'priority: high', '---', '# Urgent', sw('> 🟥 **SEED-WRITE: YES** — x')].join('\n'),
  );
  assert.equal(hi.marker, '⚡🟥');
  assert.equal(hi.priority, true);
  // single tier: any other value — and no stamp at all — renders the bare lane marker
  const other = parsePlanMeta(
    ['---', 'priority: low', '---', '# P', sw('> 🟩 **SEED-WRITE: NO**')].join('\n'),
  );
  assert.equal(other.marker, '🟩');
  assert.equal(other.priority, false);
  // review 2328 fix: a hand-stamp with a trailing YAML comment (the execModel
  // convention) must still read as priority — same comment-stripping scalar read
  // as queue-drain / done-worktree / claim-plan, so the INDEX bullet can never
  // disagree with the queue/board about the same stamp.
  const commented = parsePlanMeta(
    [
      '---',
      'priority: high # stamped by board-pass 2026-07-24',
      '---',
      '# U',
      sw('> 🟩 **SEED-WRITE: NO**'),
    ].join('\n'),
  );
  assert.equal(commented.priority, true);
  assert.equal(commented.marker, '⚡🟩');
});

// plan 2520: the three-tier priority vocabulary's canonical normalization.
test('normalizePriorityTier: absent and every legal value, case-insensitive', () => {
  assert.equal(normalizePriorityTier(''), 'medium');
  assert.equal(normalizePriorityTier(null), 'medium');
  assert.equal(normalizePriorityTier(undefined), 'medium');
  assert.equal(normalizePriorityTier('high'), 'high');
  assert.equal(normalizePriorityTier('HIGH'), 'high');
  assert.equal(normalizePriorityTier('Medium'), 'medium');
  assert.equal(normalizePriorityTier('LOW'), 'low');
  assert.equal(normalizePriorityTier(' low '), 'low');
});

test('normalizePriorityTier: an unrecognized value (typo, or the now-illegal "normal") warns and falls back to medium, never throws', () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  assert.equal(normalizePriorityTier('normal', { warn }), 'medium');
  assert.equal(normalizePriorityTier('urgnet', { warn }), 'medium');
  assert.equal(normalizePriorityTier('P1', { warn }), 'medium');
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /unrecognized value "normal"/);
  assert.match(warnings[0], /medium/);
});

test('isValidPriorityValue: absent is legal; only {high,medium,low} (case-insensitive) are legal explicit values', () => {
  assert.equal(isValidPriorityValue(''), true);
  assert.equal(isValidPriorityValue(null), true);
  assert.equal(isValidPriorityValue(undefined), true);
  for (const v of ['high', 'HIGH', 'Medium', 'low', 'LOW'])
    assert.equal(isValidPriorityValue(v), true);
  assert.equal(isValidPriorityValue('normal'), false);
  assert.equal(isValidPriorityValue('urgnet'), false);
  assert.equal(isValidPriorityValue('P1'), false);
});

test('PRIORITY_VALUES / PRIORITY_DEFAULT / PRIORITY_SORT_WEIGHT: the ruled vocabulary shape', () => {
  assert.deepEqual(PRIORITY_VALUES, ['high', 'medium', 'low']);
  assert.equal(PRIORITY_DEFAULT, 'medium');
  assert.deepEqual(PRIORITY_SORT_WEIGHT, { high: 0, medium: 1, low: 2 });
});

test('readPriorityTier / isHighPriorityTier: read straight off plan content, trailing-comment-safe (plan 1292 shape)', () => {
  const content = (v) => ['---', `priority: ${v}`, '---', '# P'].join('\n');
  assert.equal(readPriorityTier(content('high')), 'high');
  assert.equal(readPriorityTier(content('low')), 'low');
  assert.equal(readPriorityTier(content('medium')), 'medium');
  assert.equal(readPriorityTier('# no frontmatter at all\n'), 'medium');
  assert.equal(isHighPriorityTier(content('high')), true);
  assert.equal(isHighPriorityTier(content('low')), false);
  assert.equal(isHighPriorityTier(content('medium')), false);
  assert.equal(isHighPriorityTier('# no frontmatter at all\n'), false);
  // trailing YAML inline comment (plan 1292 lesson) still normalizes correctly
  assert.equal(readPriorityTier(content('high # stamped by board-pass 2026-07-24')), 'high');
});

// plan 2520 work item 6: bind all FIVE priority consumers (build-index-lib's own ⚡ marker,
// queue-drain's sort + oracle-JSON flag, claim-plan's two board-cell sites, done-worktree's
// queue-priority check, read-plan-stamps' contract map) to the ONE shared normalization here —
// a source-scan pin (the idiom done-worktree-land.test.mjs / claim-plan-lib.test.mjs / blocked-
// by-lib.test.mjs already use for cross-file "must call the shared helper" contracts) so a
// future edit cannot re-inline `readFrontmatterScalar(content, 'priority').toLowerCase() ===
// 'high'` in just one of the five and quietly reopen the exact drift class plan 2423 closed for
// execModel/cloudEnv and this plan closes for priority.
test('plan 2520: all five priority consumers call the shared isHighPriorityTier/readPriorityTier — none re-inlines the raw priority === "high" check', () => {
  const files = [
    'build-index-lib.mjs',
    'queue-drain.mjs',
    'claim-plan.mjs',
    'done-worktree.mjs',
    'read-plan-stamps.mjs',
  ];
  // The exact shape every one of the five used to carry, independently, before 2520.
  const RAW_INLINE_RX =
    /readFrontmatterScalar\([^)]*,\s*['"]priority['"]\)[^;\n]*===\s*['"]high['"]/;
  for (const f of files) {
    const src = readFileSync(scriptFile(f, import.meta.dirname), 'utf8');
    assert.doesNotMatch(
      src,
      RAW_INLINE_RX,
      `${f} must not re-inline the raw priority === 'high' check — call isHighPriorityTier/readPriorityTier instead`,
    );
    assert.match(
      src,
      /isHighPriorityTier|readPriorityTier/,
      `${f} must call the shared priority normalization (build-index-lib.mjs)`,
    );
  }
});

// ── plan 3999: priorityBy vocabulary + shared validator ────────────────────────────────────

test('PRIORITY_BY_DIRECTIVES: today carries exactly the one standing class (grammar-omnibus-carryforward retired by plan 3961)', () => {
  assert.deepEqual(PRIORITY_BY_DIRECTIVES, ['2141-critical-path']);
});

test('isValidPriorityByValue: absent is legal', () => {
  assert.equal(isValidPriorityByValue(''), true);
  assert.equal(isValidPriorityByValue(null), true);
  assert.equal(isValidPriorityByValue(undefined), true);
});

test('isValidPriorityByValue: `operator <YYYY-MM-DD>` is legal, case-insensitively, only for a REAL calendar date', () => {
  assert.equal(isValidPriorityByValue('operator 2026-09-13'), true);
  assert.equal(isValidPriorityByValue('OPERATOR 2026-09-13'), true, 'keyword is case-insensitive');
  // Shape-valid but not a real date: no month 13, no day 45, no Feb 30.
  assert.equal(isValidPriorityByValue('operator 2026-13-45'), false);
  assert.equal(isValidPriorityByValue('operator 2026-02-30'), false);
  // A leap-day IS real in a leap year, not in a non-leap year.
  assert.equal(isValidPriorityByValue('operator 2024-02-29'), true);
  assert.equal(isValidPriorityByValue('operator 2026-02-29'), false);
});

// review fix round 1 (key 488889): isValidPriorityByValue now round-trips its calendar check
// through the SHARED isCalendarDate (exec-model-default-lib.mjs) instead of a private
// re-implementation — the test above already pins the observable behaviour (rejects
// 2026-13-45/2026-02-30, accepts a real leap day), so this is a plain import-identity check that
// the shared function really is in the call path, not a second copy of it.
test('isValidPriorityByValue: the calendar check is the SHARED isCalendarDate, not a private re-implementation', () => {
  assert.equal(
    isCalendarDate('2026-13-45'),
    false,
    'sanity: the shared function itself rejects this',
  );
  assert.equal(isValidPriorityByValue('operator 2026-13-45'), false);
  assert.equal(isCalendarDate('2026-09-13'), true);
  assert.equal(isValidPriorityByValue('operator 2026-09-13'), true);
});

// review fix round 1 (keys dbf9e7/2a0c54): an operator sitting cannot have happened on a date
// that hasn't occurred yet. `now` is injectable so this pins a fixed "today" rather than
// depending on the machine clock (the CLAUDE.md ambient-environment rule).
test('isValidPriorityByValue: a FUTURE operator date is illegal; the SAME day is legal (now is injectable)', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  assert.equal(isValidPriorityByValue('operator 2026-09-14', { now }), false, 'tomorrow is future');
  assert.equal(isValidPriorityByValue('operator 2099-01-01', { now }), false, 'far future');
  assert.equal(
    isValidPriorityByValue('operator 2026-09-13', { now }),
    true,
    'the SAME day as `now` is valid — an operator stamping today is the normal case',
  );
  assert.equal(isValidPriorityByValue('operator 2026-09-12', { now }), true, 'yesterday is fine');
});

test('isValidPriorityByValue: `directive <name>` is legal only for a listed name, case-insensitively', () => {
  assert.equal(isValidPriorityByValue('directive 2141-critical-path'), true);
  assert.equal(isValidPriorityByValue('DIRECTIVE 2141-critical-path'), true);
  assert.equal(isValidPriorityByValue('directive 2141-CRITICAL-PATH'), true);
  // grammar-omnibus-carryforward was retired by plan 3961 — a plan carrying it is no longer a
  // valid directive, same as any other unlisted name.
  assert.equal(isValidPriorityByValue('directive grammar-omnibus-carryforward'), false);
  assert.equal(isValidPriorityByValue('directive not-a-real-directive'), false);
});

test('isValidPriorityByValue: neither shape, or a malformed one, is illegal', () => {
  assert.equal(isValidPriorityByValue('operator'), false, 'missing the date entirely');
  assert.equal(isValidPriorityByValue('operator 2026-9-13'), false, 'not zero-padded');
  assert.equal(isValidPriorityByValue('directive'), false, 'missing the name entirely');
  assert.equal(isValidPriorityByValue('operator 2026-09-13 extra'), false, 'trailing garbage');
  assert.equal(isValidPriorityByValue('vibes'), false);
});

test('readPriorityBy: reads the raw scalar verbatim (not lower-cased), comment-stripped, null when absent', () => {
  const fm = (line) => ['---', line, '---', '# P'].join('\n');
  assert.equal(readPriorityBy(fm('priorityBy: operator 2026-09-13')), 'operator 2026-09-13');
  assert.equal(
    readPriorityBy(fm('priorityBy: directive 2141-critical-path')),
    'directive 2141-critical-path',
  );
  assert.equal(
    readPriorityBy(fm('priorityBy: operator 2026-09-13 # sitting notes')),
    'operator 2026-09-13',
    'trailing YAML inline comment stripped',
  );
  assert.equal(readPriorityBy(fm('priority: high')), null);
  assert.equal(readPriorityBy('# no frontmatter\n'), null);
});

test('priorityStampProblem: a bare `priority: high` with no priorityBy is unbacked-high', () => {
  const content = ['---', 'priority: high', '---', '# P'].join('\n');
  assert.equal(priorityStampProblem(content), 'unbacked-high');
});

test('priorityStampProblem: `priority: high` with a legal priorityBy has no problem', () => {
  for (const by of ['operator 2026-09-13', 'directive 2141-critical-path']) {
    const content = ['---', 'priority: high', `priorityBy: ${by}`, '---', '# P'].join('\n');
    assert.equal(priorityStampProblem(content), null, `priorityBy: ${by} should clear the plan`);
  }
});

test('priorityStampProblem: a `priorityBy:` stranded on a medium/low plan is stale-priorityBy', () => {
  for (const tier of ['medium', 'low']) {
    const content = [
      '---',
      `priority: ${tier}`,
      'priorityBy: operator 2026-09-13',
      '---',
      '# P',
    ].join('\n');
    assert.equal(priorityStampProblem(content), 'stale-priorityBy', `tier ${tier}`);
  }
  // Absent priority defaults to medium (plan 2520) — the same stranding applies.
  const content = ['---', 'priorityBy: operator 2026-09-13', '---', '# P'].join('\n');
  assert.equal(priorityStampProblem(content), 'stale-priorityBy');
});

test('priorityStampProblem: an unparseable priorityBy value wins over "stale", even on a non-high plan', () => {
  const content = ['---', 'priority: medium', 'priorityBy: vibes', '---', '# P'].join('\n');
  assert.equal(priorityStampProblem(content), 'bad-priorityBy-value');
});

test('priorityStampProblem: an unparseable priorityBy value is reported on a high plan too', () => {
  const content = ['---', 'priority: high', 'priorityBy: vibes', '---', '# P'].join('\n');
  assert.equal(priorityStampProblem(content), 'bad-priorityBy-value');
});

test('priorityStampProblem: a medium/low plan with no priorityBy has no problem', () => {
  for (const content of [
    ['---', 'priority: medium', '---', '# P'].join('\n'),
    ['---', 'priority: low', '---', '# P'].join('\n'),
    '# no frontmatter at all\n',
  ]) {
    assert.equal(priorityStampProblem(content), null);
  }
});

// review fix round 1 (keys 5898e9/711687): an explicitly EMPTY `priorityBy:` (the key present,
// nothing after the colon) used to read identically to ABSENT — readPriorityBy/
// readFrontmatterScalar both collapse "absent" and "present-but-empty" to the same `null` — so it
// silently passed on a medium/low plan instead of being flagged. It must be 'bad-priorityBy-value'
// on ANY tier: a key that exists has to carry a real value.
test('priorityStampProblem: a PRESENT but EMPTY priorityBy: is bad-priorityBy-value, on every tier — not silently read as absent', () => {
  for (const tier of ['medium', 'low', 'high']) {
    const content = ['---', `priority: ${tier}`, 'priorityBy:', '---', '# P'].join('\n');
    assert.equal(
      priorityStampProblem(content),
      'bad-priorityBy-value',
      `an empty priorityBy: must be flagged even on tier ${tier}`,
    );
  }
  // Trailing whitespace only (still no real value) reads the same way.
  const whitespaceOnly = ['---', 'priority: medium', 'priorityBy:   ', '---', '# P'].join('\n');
  assert.equal(priorityStampProblem(whitespaceOnly), 'bad-priorityBy-value');
});

test('priorityStampProblem: `now` is injectable and reaches the future-date check (keys dbf9e7/2a0c54)', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  const future = ['---', 'priority: high', 'priorityBy: operator 2026-09-14', '---', '# P'].join(
    '\n',
  );
  assert.equal(priorityStampProblem(future, { now }), 'bad-priorityBy-value');
  const sameDay = ['---', 'priority: high', 'priorityBy: operator 2026-09-13', '---', '# P'].join(
    '\n',
  );
  assert.equal(priorityStampProblem(sameDay, { now }), null, 'same-day stays valid');
});

// ── priorityStampFixHint (review fix round 1, key 32672c): the fix guidance must be TIER-AWARE —
// ── a bad VALUE can land on a medium/low plan whose `priority:` stamp is fine, and suggesting a
// ── demote-to-medium there is nonsense (there is no `priority: high` line to demote). Shared by
// ── the lint and the mint refusal so the two can never disagree.

test('priorityStampFixHint: unbacked-high always offers the demote suggestion (tier is always high)', () => {
  const hint = priorityStampFixHint('unbacked-high', 'high');
  assert.equal(hint.demoteApplicable, true);
  assert.match(hint.guidance, /priorityBy/);
});

test('priorityStampFixHint: bad-priorityBy-value on a HIGH plan offers the demote suggestion', () => {
  const hint = priorityStampFixHint('bad-priorityBy-value', 'high');
  assert.equal(hint.demoteApplicable, true);
});

test('priorityStampFixHint: bad-priorityBy-value on a medium/low plan does NOT offer the demote suggestion — there is no `priority: high` line to find', () => {
  for (const tier of ['medium', 'low']) {
    const hint = priorityStampFixHint('bad-priorityBy-value', tier);
    assert.equal(hint.demoteApplicable, false, `tier ${tier}`);
    assert.match(hint.guidance, /priorityBy/);
    assert.doesNotMatch(
      hint.guidance,
      /priority: high/,
      `tier ${tier}: no dangling high reference`,
    );
  }
});

test('priorityStampFixHint: returns null for stale-priorityBy — that problem has its own message shape, not this hint', () => {
  assert.equal(priorityStampFixHint('stale-priorityBy', 'medium'), null);
});

test('planIdOf parses NNN (incl. 4-digit) and sorts legacy date names last', () => {
  assert.equal(planIdOf('007-P07-foo.md'), 7);
  assert.equal(planIdOf('249-Other-bar.md'), 249);
  // 4-digit ids (plan 1000+) parse to their full numeric value, not the first 3 digits.
  assert.equal(planIdOf('1000-Infra-x.md'), 1000);
  assert.equal(planIdOf('1234-Other-y.md'), 1234);
  // a legacy date-prefixed name (\d{4}-\d{2}-\d{2}) still falls through to Infinity —
  // the `(?=[A-Za-z])` lookahead rejects the \d{2} that follows the year's dash.
  assert.equal(planIdOf('2026-05-17-legacy.md'), Number.POSITIVE_INFINITY);
});

test('renderBullet emits the index-lib-compatible backtick form', () => {
  const b = renderBullet({
    marker: '🟩',
    summary: 'Does alpha.',
    status: 'ready',
    basename: '100-Other-alpha.md',
  });
  assert.equal(b, '- 🟩 Does alpha. → `ready/100-Other-alpha.md`');
});

test('renderPlansBlock groups by status order and sorts by id', () => {
  const plans = [
    { status: 'ready', basename: '105-P07-e.md', marker: '🟩', summary: 'E' },
    { status: 'in-progress', basename: '101-P07-b.md', marker: '🟥', summary: 'B' },
    { status: 'ready', basename: '100-Other-a.md', marker: '🟩', summary: 'A' },
    { status: 'archive', basename: '009-old.md', marker: '🟩', summary: 'dropped' },
  ];
  const block = renderPlansBlock(plans);
  assert.ok(block.startsWith(INDEX_PLANS_START));
  assert.ok(block.endsWith(INDEX_PLANS_END));
  // in-progress group precedes ready group
  assert.ok(block.indexOf('**in-progress/**') < block.indexOf('**ready/**'));
  // within ready, id 100 precedes id 105
  assert.ok(block.indexOf('100-Other-a.md') < block.indexOf('105-P07-e.md'));
  // archive plan is dropped
  assert.ok(!block.includes('009-old.md'));
});

// plan 1426: parked/ deliberately absent from STATUS_ORDER — a record with
// status:'parked' must be dropped from the generated block exactly like archive/,
// with NO separate "Parked" section ever emitted.
test('renderPlansBlock drops a parked/ plan (no bullet, no Parked section)', () => {
  const plans = [
    { status: 'ready', basename: '100-Other-a.md', marker: '🟩', summary: 'A' },
    { status: 'parked', basename: '200-Other-frozen.md', marker: '🟩', summary: 'frozen' },
  ];
  const block = renderPlansBlock(plans);
  assert.ok(!block.includes('200-Other-frozen.md'), 'parked plan bullet must not be emitted');
  assert.ok(!block.includes('**parked/**'), 'no separate parked/ subheading section');
  assert.ok(!/parked/i.test(block), 'the word "parked" must not appear anywhere in the block');
});

test('splicePlansBlock replaces between sentinels (idempotent)', () => {
  const index = [
    'Active / open:',
    '',
    INDEX_PLANS_START,
    '',
    '- 🟩 OLD → `ready/001-Other-old.md`',
    '',
    INDEX_PLANS_END,
    '',
    'Moved to `docs/superpowers/plans/archive/` …',
    '- `000-old.md` — archived.',
  ].join('\n');
  const block = renderPlansBlock([
    { status: 'ready', basename: '002-Other-new.md', marker: '🟩', summary: 'NEW' },
  ]);
  const out1 = splicePlansBlock(index, block);
  assert.ok(out1.includes('002-Other-new.md'));
  assert.ok(!out1.includes('001-Other-old.md'));
  assert.ok(out1.includes('Moved to `docs/superpowers/plans/archive/`'));
  // idempotent: splicing the same block again is a fixpoint
  const out2 = splicePlansBlock(out1, block);
  assert.equal(out2, out1);
});

test('readSeedMarker: seedLane disabled ⇒ always 🟩 regardless of banner', () => {
  assert.equal(readSeedMarker(sw('> 🟥 **SEED-WRITE**: YES'), { seedLane: false }), '🟩');
});
test('readSeedMarker: seedLane enabled (default) still reads YES banner ⇒ 🟥', () => {
  assert.equal(readSeedMarker(sw('SEED-WRITE: YES')), '🟥');
});

test('splicePlansBlock inserts before archive header when sentinels absent', () => {
  const index = [
    'Active / open:',
    '',
    '- 🟩 legacy bullet (will be replaced by the block) → `ready/001.md`',
    '',
    'Moved to `docs/superpowers/plans/archive/` …',
  ].join('\n');
  const block = renderPlansBlock([
    { status: 'ready', basename: '002-Other-new.md', marker: '🟩', summary: 'NEW' },
  ]);
  const out = splicePlansBlock(index, block);
  assert.ok(
    out.indexOf(INDEX_PLANS_START) < out.indexOf('Moved to `docs/superpowers/plans/archive/`'),
  );
  assert.ok(out.includes('002-Other-new.md'));
});

// ── Specs region (plan 856) ─────────────────────────────────────────────────

test('readFrontmatterKey reads an arbitrary scalar key (title)', () => {
  const c = [
    '---',
    'title: Finish plan 456 — auto-fit search',
    'date: 2026-06-09',
    '---',
    '# H1',
  ].join('\n');
  assert.equal(readFrontmatterKey(c, 'title'), 'Finish plan 456 — auto-fit search');
  assert.equal(readFrontmatterKey(c, 'missing'), '');
});

test('readFrontmatterKey reads whitespace after the colon, not a literal metachar', () => {
  // Regression guard: the `\s*` in the generated regex must be a whitespace class,
  // not a literal `s` (a value starting with 's' must keep its leading 's').
  assert.equal(readFrontmatterKey('---\nsummary:safety spec\n---', 'summary'), 'safety spec');
  assert.equal(readFrontmatterKey('---\nsummary:\tTabbed\n---', 'summary'), 'Tabbed');
});

test('readFrontmatterKey escapes regex metacharacters in the key', () => {
  // A key with a metachar must match literally: `a.b` must NOT match `axb:`.
  assert.equal(readFrontmatterKey('---\naxb: wrong\n---', 'a.b'), '');
  assert.equal(readFrontmatterKey('---\na.b: right\n---', 'a.b'), 'right');
});

// ── hasFrontmatterKey (plan 2973 fix round 2): distinguishes "key absent" from "key present ─
// ── but empty/comment-only" — readFrontmatterKey/readFrontmatterScalar collapse both to '' ──

test('hasFrontmatterKey: false when there is no frontmatter at all', () => {
  assert.equal(hasFrontmatterKey('# just a heading\n\nno frontmatter\n', 'cloudExec'), false);
});

test('hasFrontmatterKey: false when frontmatter exists but the key is absent', () => {
  assert.equal(
    hasFrontmatterKey('---\nsummary: x\nstage: specced\n---\n\nbody\n', 'cloudExec'),
    false,
  );
});

test('hasFrontmatterKey: true when the key is present with a value', () => {
  assert.equal(hasFrontmatterKey('---\ncloudExec: true\n---\n\nbody\n', 'cloudExec'), true);
});

test('hasFrontmatterKey: true when the key is present but its value is empty', () => {
  assert.equal(hasFrontmatterKey('---\ncloudExec:\n---\n\nbody\n', 'cloudExec'), true);
});

test('hasFrontmatterKey: true when the key is present but comment-only (no real value)', () => {
  assert.equal(
    hasFrontmatterKey('---\ncloudExec: # not stamped yet\n---\n\nbody\n', 'cloudExec'),
    true,
  );
});

test('hasFrontmatterKey escapes regex metacharacters in the key, same as readFrontmatterKey', () => {
  assert.equal(hasFrontmatterKey('---\naxb: wrong\n---', 'a.b'), false);
  assert.equal(hasFrontmatterKey('---\na.b: right\n---', 'a.b'), true);
});

// ── readFrontmatterScalar / specReviewGateError (plan 1292 bugfix) ─────────

test('readFrontmatterScalar strips a trailing YAML inline comment and trims', () => {
  const c = '---\nexecModel: fable # umbrella tracker — NOT drain-eligible\n---\n# T';
  assert.equal(readFrontmatterScalar(c, 'execModel'), 'fable');
});

test('readFrontmatterScalar behaves like readFrontmatterKey when there is no comment', () => {
  const c = '---\nstage: stub\n---\n# T';
  assert.equal(readFrontmatterScalar(c, 'stage'), 'stub');
  assert.equal(readFrontmatterScalar(c, 'missing'), '');
});

test('specReviewGateError: absent/empty stage → null (legacy grandfather)', () => {
  assert.equal(specReviewGateError('050-Infra-foo.md', '# T\n\nno frontmatter', 'ctx:'), null);
  assert.equal(specReviewGateError('050-Infra-foo.md', '---\nsummary: hi\n---\n# T', 'ctx:'), null);
});

test('specReviewGateError: stage other than stub (any case) → null', () => {
  assert.equal(
    specReviewGateError('050-Infra-foo.md', '---\nstage: specced\n---\n# T', 'ctx:'),
    null,
  );
  assert.equal(
    specReviewGateError('050-Infra-foo.md', '---\nstage: SPECCED\n---\n# T', 'ctx:'),
    null,
  );
});

test('specReviewGateError: stage: stub (any case) with a specReview stamp → null', () => {
  assert.equal(
    specReviewGateError(
      '050-Infra-foo.md',
      '---\nstage: STUB\nspecReview: 328a351c0\n---\n# T',
      'ctx:',
    ),
    null,
  );
  assert.equal(
    specReviewGateError(
      '050-Infra-foo.md',
      '---\nstage: stub\nspecReview: exempt-mechanical\n---\n# T',
      'ctx:',
    ),
    null,
  );
});

test('specReviewGateError: stub with a comment-suffixed specReview still satisfies the gate', () => {
  assert.equal(
    specReviewGateError(
      '050-Infra-foo.md',
      '---\nstage: stub\nspecReview: exempt-mechanical # no judgment call here\n---\n# T',
      'ctx:',
    ),
    null,
  );
});

test('readFrontmatterScalar unquotes a quoted value after stripping a trailing comment', () => {
  // plan 1292 round-2 bugfix repro: readFrontmatterKey's own unquoteYaml pass sees the
  // RAW value including the comment (`"stub" # awaiting spec-pass`) — its last char is
  // comment text, not a closing quote, so the quote-strip never fires there. Stripping
  // the comment afterward UNMASKS the still-quoted `"stub"`, so readFrontmatterScalar
  // must unquote a second time or a bare-string gate compare never matches.
  const c = '---\nstage: "stub" # awaiting spec-pass\n---\n# T';
  assert.equal(readFrontmatterScalar(c, 'stage'), 'stub');
});

test('specReviewGateError: quoted stub value with a trailing comment still trips the gate', () => {
  // Repro for the same bug at the gate level: before the fix, the surviving quotes
  // made the compare `'"stub"' !== 'stub'` pass, silently waving the plan through.
  const msg = specReviewGateError(
    'x.md',
    '---\nstage: "stub" # awaiting spec-pass\n---\n# T',
    'ctx:',
  );
  assert.notEqual(msg, null);
  assert.match(msg, /stage: stub without a specReview stamp/);
});

test('specReviewGateErrorFromValues: pure core matches specReviewGateError given the same normalized inputs', () => {
  assert.equal(
    specReviewGateErrorFromValues('stub', null, '050-Infra-foo.md', 'ctx:'),
    specReviewGateError('050-Infra-foo.md', '---\nstage: stub\n---\n# T', 'ctx:'),
  );
  assert.equal(specReviewGateErrorFromValues('specced', null, '050-Infra-foo.md', 'ctx:'), null);
  assert.equal(
    specReviewGateErrorFromValues('stub', 'exempt-mechanical', '050-Infra-foo.md', 'ctx:'),
    null,
  );
});

test('specReviewGateError: stub without specReview → actionable message naming both fixes', () => {
  const msg = specReviewGateError(
    '050-Infra-foo.md',
    '---\nstage: stub\n---\n# T',
    'move-plan: cannot promote to ready/ —',
  );
  assert.match(msg, /050-Infra-foo\.md/);
  assert.match(msg, /stage: stub without a specReview stamp/);
  assert.match(msg, /\/spec-pass/);
  assert.match(msg, /stamp-exec-model\.mjs/);
  assert.match(msg, /exempt-mechanical/);
});

test('parseSpecMeta precedence: summary → title → H1 → fallback', () => {
  assert.deepEqual(parseSpecMeta(['---', 'summary: S', 'title: T', '---', '# H'].join('\n')), {
    blurb: 'S',
    source: 'summary',
  });
  assert.deepEqual(parseSpecMeta(['---', 'title: T', '---', '# H'].join('\n')), {
    blurb: 'T',
    source: 'title',
  });
  assert.deepEqual(parseSpecMeta('# Just an H1\n\nbody'), { blurb: 'Just an H1', source: 'h1' });
  assert.deepEqual(parseSpecMeta('no heading, no frontmatter'), {
    blurb: '(no summary)',
    source: 'none',
  });
});

test('specBucket splits top-level (active) from archive/', () => {
  assert.equal(specBucket('2026-06-09-foo-design.md'), 'active');
  assert.equal(specBucket('_bakeoff-template.md'), 'active');
  assert.equal(specBucket('archive/2026-04-14-bar.md'), 'archive');
  assert.equal(specBucket('archive/2026-05-21-redesign/rationale.md'), 'archive');
});

test('renderSpecsBlock groups Active/Archive, codepoint-sorts, fences with sentinels', () => {
  const block = renderSpecsBlock([
    { displayPath: 'archive/2026-04-14-bar.md', blurb: 'Bar' },
    { displayPath: '2026-06-09-foo.md', blurb: 'Foo' },
    { displayPath: '2026-05-01-baz.md', blurb: 'Baz' },
    { displayPath: 'archive/2026-04-10-aaa.md', blurb: 'Aaa' },
  ]);
  assert.ok(block.startsWith(INDEX_SPECS_START));
  assert.ok(block.endsWith(INDEX_SPECS_END));
  // active before archive subheadings
  assert.ok(block.indexOf('**Active**') < block.indexOf('**Archive**'));
  // within Active, codepoint order (05 before 06)
  assert.ok(block.indexOf('2026-05-01-baz.md') < block.indexOf('2026-06-09-foo.md'));
  // within Archive, codepoint order (04-10 before 04-14)
  assert.ok(
    block.indexOf('archive/2026-04-10-aaa.md') < block.indexOf('archive/2026-04-14-bar.md'),
  );
  // an archive bullet never lands in the Active group
  assert.ok(block.indexOf('archive/2026-04-14-bar.md') > block.indexOf('**Archive**'));
});

test('spliceSpecsBlock replaces between existing sentinels', () => {
  const idx = [
    '## Specs',
    'intro prose',
    INDEX_SPECS_START,
    'STALE',
    INDEX_SPECS_END,
    '',
    '## Plans (`docs/superpowers/plans/`)',
  ].join('\n');
  const out = spliceSpecsBlock(idx, renderSpecsBlock([{ displayPath: 'x.md', blurb: 'X' }]));
  assert.ok(!out.includes('STALE'));
  assert.ok(out.includes('- `x.md` — X'));
  // prose above the sentinels and the Plans header are preserved
  assert.ok(out.includes('intro prose'));
  assert.ok(out.includes('## Plans (`docs/superpowers/plans/`)'));
});

test('spliceSpecsBlock first-time insertion lands just before "## Plans"', () => {
  const idx = ['## Specs', 'intro prose', '', '## Plans (`docs/superpowers/plans/`)', 'x'].join(
    '\n',
  );
  const out = spliceSpecsBlock(idx, renderSpecsBlock([{ displayPath: 'y.md', blurb: 'Y' }]));
  assert.ok(out.indexOf(INDEX_SPECS_START) < out.indexOf('## Plans (`docs/superpowers/plans/`)'));
  assert.ok(out.indexOf('intro prose') < out.indexOf(INDEX_SPECS_START));
});

// --- upsertFrontmatterKey (plan 1304 — the shared write-side twin) ------------

test('upsertFrontmatterKey: replaces an existing key, preserving a trailing comment on an idempotent re-stamp', () => {
  const body = '---\nexecModel: fable # umbrella tracker — NOT drain-eligible\n---\n\n# T\n';
  const out = upsertFrontmatterKey(body, 'execModel', 'fable');
  assert.match(out, /^execModel: fable # umbrella tracker — NOT drain-eligible$/m);
  assert.equal((out.match(/^execModel:/gm) || []).length, 1);
});

test('upsertFrontmatterKey: a value change on a commented line DROPS the stale comment', () => {
  const body = '---\nexecModel: sonnet # describes the OLD value\n---\n\n# T\n';
  const out = upsertFrontmatterKey(body, 'execModel', 'fable');
  assert.match(out, /^execModel: fable$/m);
  assert.doesNotMatch(out, /OLD value/);
});

test('upsertFrontmatterKey: preserveComment=false drops the comment even on an idempotent re-stamp', () => {
  const body = '---\nunblock: cost # the ~$8 spend\n---\n\n# T\n';
  const out = upsertFrontmatterKey(body, 'unblock', 'cost', { preserveComment: false });
  assert.match(out, /^unblock: cost$/m);
  assert.doesNotMatch(out, /\$8 spend/);
});

test('upsertFrontmatterKey: appends into an existing block without clobbering sibling keys', () => {
  const out = upsertFrontmatterKey("---\nsummary: 'x'\n---\n\n# T\nbody\n", 'stage', 'stub');
  assert.equal(out, "---\nsummary: 'x'\nstage: stub\n---\n\n# T\nbody\n");
});

test('upsertFrontmatterKey: creates a fresh block when the body has none', () => {
  const out = upsertFrontmatterKey('# T\n\nbody\n', 'stage', 'specced');
  assert.equal(out, '---\nstage: specced\n---\n\n# T\n\nbody\n');
});

test('upsertFrontmatterKey: an unterminated opening --- is not frontmatter — a new block is prepended', () => {
  const body = '---\nsummary: never closed\n\n# T\n';
  const out = upsertFrontmatterKey(body, 'stage', 'stub');
  assert.match(out, /^---\nstage: stub\n---\n\n---\nsummary: never closed/);
});

test('upsertFrontmatterKey: colon-in-value round-trips through readFrontmatterKey', () => {
  const value = "'fix X: don''t drop it → see `ready/y.md`'";
  const out = upsertFrontmatterKey('# T\n\nbody\n', 'summary', value);
  assert.equal(readFrontmatterSummary(out), "fix X: don't drop it → see `ready/y.md`");
  // Replacing a colon-carrying value in place keeps a single key line.
  const out2 = upsertFrontmatterKey(out, 'summary', "'plain'");
  assert.equal((out2.match(/^summary:/gm) || []).length, 1);
  assert.equal(readFrontmatterSummary(out2), 'plain');
});

test('upsertFrontmatterKey: keepExisting leaves an existing key (and the whole body) unchanged', () => {
  const body = "---\nsummary: 'the author wins'\n---\n\n# T\n";
  assert.equal(upsertFrontmatterKey(body, 'summary', "'a blurb'", { keepExisting: true }), body);
  // …but still inserts when the key is absent.
  const out = upsertFrontmatterKey(body, 'stage', 'stub', { keepExisting: true });
  assert.equal(readFrontmatterScalar(out, 'stage'), 'stub');
});

// 1304-review regression: a fence is a line that is EXACTLY `---`. A body opening
// with a dash rule (`----`) plus a later `---` markdown divider must get a fresh
// block PREPENDED — never have the key spliced into prose between the two.
test('upsertFrontmatterKey: a `----` dash-rule first line is not a fence — block is prepended, prose untouched', () => {
  const body = '----\ncol1 | col2\n---\nrow\n\n# Title\nbody text\n';
  const out = upsertFrontmatterKey(body, 'stage', 'stub');
  assert.equal(out, `---\nstage: stub\n---\n\n${body}`);
});

test('upsertFrontmatterKey: a `---text` first line is not a fence either', () => {
  const body = '---draft\nprose\n---\nmore\n';
  const out = upsertFrontmatterKey(body, 'stage', 'stub', { keepExisting: true });
  assert.equal(out, `---\nstage: stub\n---\n\n${body}`);
});

// plan 1328: wholesale EOL awareness (split/join on the file's own line ending),
// replacing stamp-plan-seedwrite.mjs's now-folded per-file CRLF handling.
test('upsertFrontmatterKey: CRLF body round-trips CRLF (idempotent + on insert)', () => {
  const crlf = "---\r\nsummary: 'x'\r\nexecModel: sonnet\r\n---\r\n\r\n# T\r\n";
  const same = upsertFrontmatterKey(crlf, 'execModel', 'sonnet');
  assert.equal(same, crlf, 'idempotent re-stamp must not churn EOLs');

  const noKey = "---\r\nsummary: 'x'\r\n---\r\n\r\n# T\r\n";
  const inserted = upsertFrontmatterKey(noKey, 'stage', 'stub');
  assert.match(
    inserted,
    /stage: stub\r\n/,
    'inserted line must carry the file CRLF, not a bare LF',
  );
  assert.doesNotMatch(inserted, /[^\r]\nstage:/, 'no LF-only line inside a CRLF file');
});

test('upsertFrontmatterKey: a `----` line does not CLOSE a real block — the true fence further down does', () => {
  const body = '---\nsummary: x\n----\nstill-inside: yes\n---\n\n# T\n';
  const out = upsertFrontmatterKey(body, 'stage', 'stub');
  // stage lands before the real closing fence, after the ---- line.
  assert.equal(out, '---\nsummary: x\n----\nstill-inside: yes\nstage: stub\n---\n\n# T\n');
});

// --- CRLF-safe frontmatter READ (plan 1650 root cause) -----------------------
// The write side (upsertFrontmatterKey) was already EOL-aware; the READ side split
// on '\n' and its `^key:\s*(.*)$` per-line match then failed outright on a trailing
// '\r' (JS `.` never matches '\r'; a non-multiline `$` matches only at end-of-string).
// A CRLF plan body therefore parsed with NO frontmatter values at all — summary fell
// back to the H1 (the 1647 mint's atomically-drifted INDEX bullet) and the
// stage/specReview gates saw empty scalars. The committed blob, LF-normalized by
// `* text=auto eol=lf`, parsed fine — so drift was born in one commit and every
// LF-tree regen disagreed with it. These tests pin CRLF ≡ LF for the whole read seam.

const CRLF_BODY = [
  '---',
  "summary: 'Audit VetAtHome family render-store attributions: clinic-883 carries'",
  'stage: stub',
  'execModel: sonnet',
  '---',
  '',
  '# VetAtHome render-store section-crop attribution audit',
  '',
  sw('> 🟩 **SEED-WRITE: NO** — render-store artefacts only.'),
  '',
].join('\r\n');
const LF_BODY = CRLF_BODY.replace(/\r\n/g, '\n');

test('plan 1650: readFrontmatterKey parses a CRLF body identically to its LF twin', () => {
  assert.equal(readFrontmatterKey(CRLF_BODY, 'summary'), readFrontmatterKey(LF_BODY, 'summary'));
  assert.equal(
    readFrontmatterKey(CRLF_BODY, 'summary'),
    'Audit VetAtHome family render-store attributions: clinic-883 carries',
  );
});

test('plan 1650: parsePlanMeta on CRLF must NOT fall back to the H1 (the 1647 drift shape)', () => {
  const crlfMeta = parsePlanMeta(CRLF_BODY);
  const lfMeta = parsePlanMeta(LF_BODY);
  assert.equal(crlfMeta.hasFrontmatterSummary, true, 'summary must be visible through CRLF');
  assert.equal(crlfMeta.summary, lfMeta.summary);
  assert.equal(crlfMeta.marker, lfMeta.marker);
  assert.notEqual(
    crlfMeta.summary,
    'VetAtHome render-store section-crop attribution audit',
    'the H1 fallback firing on CRLF is exactly the committed-vs-regen INDEX drift',
  );
});

test('plan 1650: renderBullet from CRLF and LF parses is byte-identical (regen oracle restored)', () => {
  const bullet = (content) => {
    const meta = parsePlanMeta(content);
    return renderBullet({
      marker: meta.marker,
      summary: meta.summary,
      status: 'ready',
      basename: '1647-DQ-x.md',
    });
  };
  assert.equal(bullet(CRLF_BODY), bullet(LF_BODY));
});

test('plan 1650: readFrontmatterScalar sees stage/specReview through CRLF (spec-review gate not waved through)', () => {
  assert.equal(readFrontmatterScalar(CRLF_BODY, 'stage'), 'stub');
  // a CRLF stub with no specReview must still trip the gate, exactly like its LF twin
  const err = specReviewGateError('1647-DQ-x.md', CRLF_BODY, 'test:');
  assert.ok(err, 'CRLF stub without specReview must be caught by the gate');
  assert.equal(err, specReviewGateError('1647-DQ-x.md', LF_BODY, 'test:'));
});

test('plan 1650: a CR-decorated comment/quote combo still round-trips through readFrontmatterScalar', () => {
  const body = "---\r\nexecModel: 'fable' # umbrella tracker\r\n---\r\n\r\n# T\r\n";
  assert.equal(readFrontmatterScalar(body, 'execModel'), 'fable');
});

// --- specVerdictRegion — the shared spec-pass-verdict locator (plan 3943) ---
// Two callers depend on it shaping the region differently per FORM, and on it being
// fence-aware; both properties came out of review round 1 and both are pinned here rather
// than only at the two call sites.

test('specVerdictRegion: an H2 marker owns everything to the next same-or-shallower heading', () => {
  const text =
    '# Plan\n\n## Spec-pass verdict (2026-09-11)\n\n- C1: PASS\n- C5: PASS\n\n## Not in this plan\n\n- x\n';
  const r = specVerdictRegion(text);
  assert.equal(r.heading, true);
  // Round 2: the region's text begins AFTER the heading's own line, so a word like PASS in
  // the heading's parenthetical cannot satisfy a check.
  assert.equal(
    r.start,
    text.indexOf('## Spec-pass verdict') + '## Spec-pass verdict (2026-09-11)\n'.length,
  );
  assert.equal(r.end, text.indexOf('## Not in this plan'));
  // The BODY is inside the region — the bug review found was a region of just the heading.
  assert.match(text.slice(r.start, r.end), /C1: PASS/);
});

test('specVerdictRegion: an H2 marker at EOF runs to the end', () => {
  const text = '# Plan\n\n## Spec-pass verdict\n\n- C1: PASS\n';
  const r = specVerdictRegion(text);
  assert.equal(r.end, text.length);
});

test('specVerdictRegion: the legacy bold form is PARAGRAPH-scoped, not widened to the next H2', () => {
  const text =
    '# Plan\n\n**Spec-pass verdict:** C1: PASS. C5: PASS.\n\nA later paragraph.\n\n## Tasks\n';
  const r = specVerdictRegion(text);
  assert.equal(r.heading, false);
  assert.equal(text.slice(r.start, r.end), '**Spec-pass verdict:** C1: PASS. C5: PASS.');
});

test('specVerdictRegion: a multi-line legacy paragraph is kept whole', () => {
  const text = '**Spec-pass verdict:** C1: PASS.\nC2 through C5: PASS.\n\nLater.\n';
  const r = specVerdictRegion(text);
  assert.equal(
    text.slice(r.start, r.end),
    '**Spec-pass verdict:** C1: PASS.\nC2 through C5: PASS.',
  );
});

test('specVerdictRegion: a marker inside a fenced block is skipped; a real one after it is found', () => {
  const text =
    '# Plan\n\n```md\n## Spec-pass verdict (illustration)\n\n- C1: PASS\n```\n\n## Spec-pass verdict (real)\n\n- C1: PASS\n';
  const r = specVerdictRegion(text);
  assert.equal(r.heading, true);
  assert.match(text.slice(r.start, r.end), /C1: PASS/);
  assert.ok(
    r.start > text.indexOf('## Spec-pass verdict (real)'),
    'anchored at the REAL marker, past the fenced one',
  );
});

test('specVerdictRegion: a marker ONLY inside a fence yields null', () => {
  const text = '# Plan\n\n```md\n## Spec-pass verdict\n\n- C1: PASS\n```\n';
  assert.equal(specVerdictRegion(text), null);
});

test('specVerdictRegion: no marker at all yields null', () => {
  assert.equal(specVerdictRegion('# Plan\n\nNothing here.\n'), null);
});

// --- plan 3943 review round 2 ---------------------------------------------------------

test('specVerdictRegions: EVERY marker outside a fence is returned, not just the first', () => {
  // Check B's pre-3943 paragraph loop pushed one region per matching paragraph. Returning
  // only the first regressed a plan carrying a re-verdict (two verdict blocks) — the second
  // one stopped being scanned at all.
  const text =
    '**Spec-pass verdict (first):** C1: PASS.\n\n' +
    'Filler.\n\n' +
    '## Spec-pass verdict (re-verdict)\n\n- C1: PASS\n';
  const rs = specVerdictRegions(text);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].heading, false);
  assert.equal(rs[1].heading, true);
});

test('specVerdictRegions: a fenced marker between two real ones is still skipped', () => {
  const text =
    '**Spec-pass verdict (a):** C1: PASS.\n\n' +
    '```md\n**Spec-pass verdict (illustration):** C1: PASS.\n```\n\n' +
    '## Spec-pass verdict (b)\n\n- C1: PASS\n';
  assert.equal(specVerdictRegions(text).length, 2);
});

test('specVerdictRegion: an INDENTED legacy bold marker is still recognized', () => {
  // The pre-3943 caller tested `para.trim()`, so leading whitespace never mattered; the
  // line-anchored scan must keep that tolerance.
  const r = specVerdictRegion('# P\n\n  **Spec-pass verdict:** C1: PASS.\n\nLater.\n');
  assert.notEqual(r, null);
  assert.equal(r.heading, false);
});

test('specVerdictRegion: a CRLF legacy paragraph terminates at its CRLF blank line', () => {
  const text = '# P\r\n\r\n**Spec-pass verdict:** C1: PASS.\r\n\r\nA later paragraph.\r\n';
  const r = specVerdictRegion(text);
  assert.doesNotMatch(
    text.slice(r.start, r.end),
    /A later paragraph/,
    'a CRLF blank line must end the legacy paragraph just as an LF one does',
  );
});

test("specVerdictRegion: an H2 region's text begins AFTER the heading line", () => {
  const text = '## Spec-pass verdict (PASS in the heading)\n\n- C1: PASS\n';
  const r = specVerdictRegion(text);
  assert.doesNotMatch(text.slice(r.start, r.end), /in the heading/);
  assert.match(text.slice(r.start, r.end), /C1: PASS/);
});

test('stripFencedBlocks: fenced content is removed, surrounding prose kept, line count preserved', () => {
  const text = 'before\n```md\n- C1: PASS\n```\nafter\n';
  const out = stripFencedBlocks(text);
  assert.match(out, /before/);
  assert.match(out, /after/);
  assert.doesNotMatch(out, /C1: PASS/);
  assert.equal(out.split('\n').length, text.split('\n').length, 'line count is preserved');
});

test('stripFencedBlocks: an UNCLOSED fence strips to the end (never leaks the tail)', () => {
  assert.doesNotMatch(stripFencedBlocks('ok\n```\n- C1: PASS\n'), /C1: PASS/);
});

test('specVerdictRegion [review-3]: an INDENTED `##` line is NOT a heading marker', () => {
  // The leading-whitespace tolerance exists for the LEGACY bold form only (the pre-3943
  // caller tested `para.trim()`); an indented `##` is not a markdown heading at all, and
  // admitting one lets a 4-space-indented code block masquerade as a verdict section.
  assert.equal(specVerdictRegion('# P\n\n    ## Spec-pass verdict\n\n- C1: PASS\n'), null);
});

test('specVerdictRegions [review-3]: two marker lines in ONE legacy paragraph yield one region', () => {
  const text =
    '**Spec-pass verdict (a):** C1: PASS.\n**Spec-pass verdict (b):** C2: PASS.\n\nLater.\n';
  const rs = specVerdictRegions(text);
  assert.equal(rs.length, 1, 'overlapping regions from the same paragraph are not collected twice');
  assert.match(text.slice(rs[0].start, rs[0].end), /C2: PASS/);
});

test('specVerdictRegions [review-4]: a legacy marker with no blank line after it does not swallow a following H2 verdict', () => {
  // `end` fell back to EOF when no blank line followed, and skipUntil then suppressed every
  // later marker. A paragraph also ends at a heading, so the bound takes whichever comes first.
  const text =
    '**Spec-pass verdict (legacy):** C1: PASS.\n## Spec-pass verdict (real)\n\n- C1: PASS\n';
  const rs = specVerdictRegions(text);
  assert.equal(rs.length, 2);
  assert.equal(rs[0].heading, false);
  assert.equal(rs[1].heading, true);
  assert.doesNotMatch(text.slice(rs[0].start, rs[0].end), /real/);
});

// --- nextHeadingBoundary / sectionBounds — the shared heading-section scanner (plan 2052) ---

test('nextHeadingBoundary: a same-level heading ends the scan; a deeper sub-heading is skipped', () => {
  const text = '## Grill questions\n\n### Fork: tombstone or keep?\n\nContent.\n\n## Next\n\nx\n';
  const afterHeading = text.indexOf('\n\n### Fork') + 1; // right after the H2's own line
  assert.equal(nextHeadingBoundary(text, afterHeading, 2), text.indexOf('## Next'));
});

test('nextHeadingBoundary: a shallower heading also ends the scan (same-or-shallower rule)', () => {
  const text = '## Section\n\ncontent\n\n# Shallower\n\nmore\n';
  const afterHeading = text.indexOf('\n\ncontent') + 1;
  assert.equal(nextHeadingBoundary(text, afterHeading, 2), text.indexOf('# Shallower'));
});

test('nextHeadingBoundary: returns text.length when no qualifying heading follows', () => {
  const text = '## Section\n\ncontent, no more headings\n';
  const afterHeading = text.indexOf('\n\ncontent') + 1;
  assert.equal(nextHeadingBoundary(text, afterHeading, 2), text.length);
});

// The live fence hazard (plan 2052 R1): docs/superpowers/batches/dependencies.md carries
// a ```dependencies fence whose interior board-pass comment lines start "# Reconciled …".
// A level-aware scan WITHOUT fence-awareness would misread each such line as an H1
// terminator and truncate the fence — this is that exact shape, minimized.
test('nextHeadingBoundary: a "#"-prefixed line INSIDE a fence is never a heading (dependencies.md fence hazard)', () => {
  const text =
    '## Dependencies\n\n```dependencies\n# Reconciled 2026-07-19 board-pass\n100 blocked-by 200\n```\n\n## Next\n\nx\n';
  const afterHeading = text.indexOf('\n\n```dependencies') + 1;
  // Without fence-awareness this would return the index of the in-fence "# Reconciled …"
  // line; with it, the scan skips straight through the fence to the real "## Next".
  assert.equal(nextHeadingBoundary(text, afterHeading, 2), text.indexOf('## Next'));
});

test('nextHeadingBoundary: a fence left open (unterminated) suppresses heading detection to EOF', () => {
  const text = '## Section\n\n```dependencies\n# not a heading\n100 blocked-by 200\n';
  const afterHeading = text.indexOf('\n\n```dependencies') + 1;
  assert.equal(nextHeadingBoundary(text, afterHeading, 2), text.length);
});

test('sectionBounds: null when the heading is absent', () => {
  assert.equal(sectionBounds('# T\n\nno match here\n', /^## Grill questions/i), null);
});

test('sectionBounds: level is read off the matched heading, start/end bound the section', () => {
  const text = '# T\n\n### Grill questions\n\ncontent\n\n### Next\n\nmore\n';
  const bounds = sectionBounds(text, /^#{1,6}\s+.*grill questions/i);
  assert.equal(bounds.level, 3);
  assert.equal(text.slice(bounds.start, bounds.end).trim(), 'content');
});

test('sectionBounds: a deeper sub-heading inside the matched section is content, not a boundary', () => {
  const text =
    '## Grill questions\n\n### Fork: tombstone or keep?\n\nRecommend: tombstone.\n\n## Next\n\nx\n';
  const bounds = sectionBounds(text, /^#{1,6}\s+.*grill questions/i);
  const section = text.slice(bounds.start, bounds.end);
  assert.match(section, /Fork: tombstone or keep\?/);
  assert.match(section, /Recommend: tombstone\./);
  assert.doesNotMatch(section, /## Next/);
});

// Review finding, plan 2052: sectionBounds' anchor search must be fence-aware too, not
// only the end-boundary search — a fenced documentation example quoting the heading text
// (a normal thing to write in this repo's own doc style) must never be mistaken for the
// real section.
test('sectionBounds: a heading-shaped line INSIDE a fence is never the anchor', () => {
  const text =
    '```example\n## Grill questions\nplaceholder text\n```\n\n## Grill questions\n\nreal content\n\n## Next\n\nx\n';
  const bounds = sectionBounds(text, /^#{1,6}\s+.*grill questions/i);
  assert.equal(text.slice(bounds.start, bounds.end).trim(), 'real content');
});

// plan 4069 (task 1): `## Session decisions` is a new recognised body section
// (plan-body-state.mjs's hasSessionDecisions/grillQuestionsSection), but it needs no special
// case HERE — sectionBounds is heading-text-agnostic, so a `## Session decisions` heading is
// bounded exactly like any other, and neither it nor a neighbouring `## Grill questions` /
// `## Operator rulings` section leaks into the other's scan. Confirms the section is inert BY
// CONSTRUCTION in this module (there is no generic "open question" scanner here for it to be
// mistaken by), not merely by convention.
test('sectionBounds: a "## Session decisions" heading is bounded like any other, and neighbouring Grill-questions/Operator-rulings sections stay independent (plan 4069)', () => {
  const text = [
    '# T',
    '',
    '## Grill questions',
    '',
    '1. `[axis: policy]` A live question?',
    '',
    '## Session decisions',
    '',
    '- (a) chosen — the tech-design fork this session decided itself.',
    '',
    '## Operator rulings',
    '',
    '- R1 — the operator-only call.',
    '',
  ].join('\n');
  const grillBounds = sectionBounds(text, /^#{1,6}\s+.*grill questions/i);
  const decisionsBounds = sectionBounds(text, /^#{1,6}\s+.*session decisions/i);
  const rulingsBounds = sectionBounds(text, /^#{1,6}\s+.*operator rulings/i);
  assert.match(text.slice(grillBounds.start, grillBounds.end), /A live question\?/);
  assert.doesNotMatch(text.slice(grillBounds.start, grillBounds.end), /Session decisions|chosen/);
  assert.match(text.slice(decisionsBounds.start, decisionsBounds.end), /chosen — the tech-design/);
  assert.doesNotMatch(
    text.slice(decisionsBounds.start, decisionsBounds.end),
    /Operator rulings|R1/,
  );
  assert.match(text.slice(rulingsBounds.start, rulingsBounds.end), /R1 — the operator-only call/);
});

// --- multiSectionBounds — shared multi-heading scan (plan 2083) -------------

test('multiSectionBounds: matches sectionBounds called once per regex, for each regex', () => {
  const text =
    '# T\n\n## Batches\n\nbatch content\n\n## Fable lane\n\n- one\n- two\n\n## Not batched\n\n- three\n\n## Dependencies\n\n```dependencies\n1 blocked-by 2\n```\n';
  const rxs = [
    /^## Batches\b.*$/m,
    /^## Fable lane\b.*$/m,
    /^## Not batched\b.*$/m,
    /^## Dependencies\b.*$/m,
  ];
  const multi = multiSectionBounds(text, rxs);
  for (const rx of rxs) {
    assert.deepEqual(multi.get(rx), sectionBounds(text, rx));
  }
});

test('multiSectionBounds: a regex with no matching heading is simply absent from the map', () => {
  const text = '# T\n\n## Batches\n\ncontent\n';
  const multi = multiSectionBounds(text, [/^## Batches\b.*$/m, /^## Nope\b.*$/m]);
  assert.equal(multi.has(/^## Nope\b.*$/m), false); // distinct regex object never matches by reference anyway
  assert.equal([...multi.values()].length, 1);
});

test("multiSectionBounds: a deeper sub-heading inside one section is content, not a boundary, for the OTHER heading's scan too", () => {
  const text = '## Grill questions\n\n### Fork: tombstone or keep?\n\ncontent\n\n## Next\n\nx\n';
  const grillRx = /^#{1,6}\s+.*grill questions/i;
  const nextRx = /^## Next\b.*$/m;
  const multi = multiSectionBounds(text, [grillRx, nextRx]);
  assert.match(
    text.slice(multi.get(grillRx).start, multi.get(grillRx).end),
    /Fork: tombstone or keep\?/,
  );
  assert.doesNotMatch(text.slice(multi.get(grillRx).start, multi.get(grillRx).end), /## Next/);
});

// The live fence hazard (plan 2052 R1), re-verified for the multi-heading scan: a
// dependencies.md-style fence with an interior "# Reconciled …" comment line must not
// be mistaken for a heading by ANY of the regexes in the same shared pass.
test('multiSectionBounds: a "#"-prefixed line INSIDE a fence is never a heading, across every regex in the batch', () => {
  const text =
    '## Dependencies\n\n```dependencies\n# Reconciled 2026-07-19 board-pass\n100 blocked-by 200\n```\n\n## Next\n\nx\n';
  const depsRx = /^## Dependencies\b.*$/m;
  const nextRx = /^## Next\b.*$/m;
  const multi = multiSectionBounds(text, [depsRx, nextRx]);
  const depsSection = text.slice(multi.get(depsRx).start, multi.get(depsRx).end);
  assert.match(depsSection, /# Reconciled 2026-07-19 board-pass/);
  assert.equal(multi.get(nextRx).start, text.indexOf('## Next') + '## Next'.length);
});

// --- claimedIdOfBasename (plan 2082, review r9) ------------------------------

test('claimedIdOfBasename: derives the claimed id, excludes dated legacy basenames', () => {
  assert.equal(claimedIdOfBasename('2082-FABLE-Other-move-plan-board-row-sync.md'), '2082');
  assert.equal(claimedIdOfBasename('050-Infra-foo.md'), '050');
  assert.equal(
    claimedIdOfBasename('2026-05-17-legacy-archive-note.md'),
    null,
    'dated legacy → no claim',
  );
  assert.equal(claimedIdOfBasename('no-id-here.md'), null);
  assert.equal(
    claimedIdOfBasename('1002-2026-06-10-old-shape.md'),
    '1002',
    'id + full date one dash later still claims the id (the documented archived-plan shape)',
  );
});

// --- category subfolders (plan 2678) -----------------------------------------
// A fake Dirent tree, so the walker's cases are testable without a fixture repo — the
// whole point of build-index-lib.mjs taking an injected `readdir` seam.
function fakeReaddir(tree) {
  return (segments) => {
    let node = tree;
    for (const seg of segments) {
      node = node?.[seg];
      if (node === undefined) {
        const e = new Error(`ENOENT: ${segments.join('/')}`);
        e.code = 'ENOENT';
        throw e;
      }
    }
    if (typeof node !== 'object') throw new Error('not a directory');
    return Object.entries(node).map(([name, v]) => ({
      name,
      isDirectory: () => typeof v === 'object',
      isFile: () => typeof v !== 'object',
    }));
  };
}

test('classifyPlanRel: status is the FIRST segment, category the optional one below it', () => {
  assert.deepEqual(classifyPlanRel('ready/2678-Coord-x.md'), {
    statusFolder: 'ready',
    category: null,
    basename: '2678-Coord-x.md',
    rel: 'ready/2678-Coord-x.md',
    violation: null,
  });
  const nested = classifyPlanRel('parked/denmark/2678-Coord-x.md');
  assert.equal(nested.statusFolder, 'parked');
  assert.equal(nested.category, 'denmark');
  assert.equal(nested.basename, '2678-Coord-x.md', 'basename stays BARE, not "denmark/…"');
  assert.equal(nested.violation, null);
  // A plans-root file (FOG.md, _dashboard.base) has no status — every caller's own
  // STATUS_ORDER check already rejects '' , so this must not invent one.
  assert.equal(classifyPlanRel('FOG.md').statusFolder, '');
});

test('planNestingViolation: two levels, uppercase, and any category under archive/ are errors', () => {
  assert.equal(planNestingViolation('parked', ['denmark'], 'parked/denmark/x.md'), null);
  assert.equal(planNestingViolation('ready', [], 'ready/x.md'), null);
  assert.match(planNestingViolation('ready', ['a', 'b'], 'ready/a/b/x.md'), /EXACTLY one/);
  assert.match(planNestingViolation('parked', ['Denmark'], 'parked/Denmark/x.md'), /lowercase/);
  assert.match(planNestingViolation('archive', ['done'], 'archive/done/x.md'), /stays FLAT/);
  // The rule's own vocabulary, pinned so a future edit can't quietly widen it.
  assert.ok(PLAN_CATEGORY_RX.test('price-pipeline'));
  assert.ok(!PLAN_CATEGORY_RX.test('Price'));
  assert.deepEqual(FLAT_ONLY_PLAN_FOLDERS, ['archive']);
});

test('planRelFor / classifyPlanPaths round-trip a categorised path', () => {
  assert.equal(planRelFor({ status: 'ready', category: null, basename: 'x.md' }), 'ready/x.md');
  assert.equal(
    planRelFor({ statusFolder: 'parked', category: 'denmark', basename: 'x.md' }),
    'parked/denmark/x.md',
  );
  const classified = classifyPlanPaths([
    'docs/superpowers/plans/ready/1-A-x.md',
    'docs/superpowers/plans/parked/denmark/2-B-y.md',
    'docs/handoff/board.md', // not a plan — dropped
  ]);
  assert.deepEqual(
    classified.map((c) => planRelFor(c)),
    ['ready/1-A-x.md', 'parked/denmark/2-B-y.md'],
  );
});

test('walkPlanTree: recurses one level into category folders and skips archive/ by default', () => {
  const tree = {
    'FOG.md': 1, // plans-root file — never walked
    ready: { '2-B-y.md': 1, infra: { '1-A-x.md': 1 } },
    archive: { '3-C-z.md': 1 },
  };
  const flat = walkPlanTree({ readdir: fakeReaddir(tree) });
  assert.deepEqual(
    flat.map((e) => e.rel),
    ['ready/2-B-y.md', 'ready/infra/1-A-x.md'],
  );
  assert.equal(flat.find((e) => e.rel.includes('infra')).category, 'infra');
  const withArchive = walkPlanTree({ readdir: fakeReaddir(tree), includeArchive: true });
  assert.ok(withArchive.some((e) => e.rel === 'archive/3-C-z.md'));
});

test('walkPlanTree: an illegal nesting is RETURNED with a violation, never silently dropped', () => {
  const entries = walkPlanTree({
    readdir: fakeReaddir({ ready: { a: { b: { '1-A-x.md': 1 } } } }),
  });
  assert.equal(entries.length, 1, 'the mis-filed plan must stay visible to the lint');
  assert.match(entries[0].violation, /EXACTLY one/);
});

test('walkPlanStatusDir: yields folder-relative paths and refuses a path as statusFolder', () => {
  const entries = walkPlanStatusDir({
    statusFolder: 'parked',
    readdir: fakeReaddir({ '9-Z-flat.md': 1, denmark: { '8-Y-nested.md': 1 } }),
  });
  assert.deepEqual(
    entries.map((e) => [e.relInStatus, e.category]),
    [
      ['9-Z-flat.md', null],
      ['denmark/8-Y-nested.md', 'denmark'],
    ],
  );
  assert.equal(entries[1].rel, 'parked/denmark/8-Y-nested.md');
  assert.throws(
    () => walkPlanStatusDir({ statusFolder: '/abs/path/parked', readdir: fakeReaddir({}) }),
    /bare folder NAME/,
  );
});

test('renderPlansBlock: a categorised plan renders its REAL relative path, grouped by status', () => {
  const block = renderPlansBlock([
    { status: 'ready', category: null, basename: '10-A-flat.md', marker: '🟩', summary: 'flat' },
    {
      status: 'ready',
      category: 'infra',
      basename: '11-B-nested.md',
      marker: '🟩',
      summary: 'nested',
    },
  ]);
  assert.match(block, /→ `ready\/10-A-flat\.md`/);
  assert.match(block, /→ `ready\/infra\/11-B-nested\.md`/);
  // ONE `**ready/**` subheading — categories never split a status group.
  assert.equal(block.split('**ready/**').length - 1, 1);
});

// ── review fix round R2 (R7): EVIDENCE_GATED_CATEGORIES + assertEvidenceFloorOk lifted from
// ── move-plan.mjs to this leaf module (already owning PLAN_CATEGORY_ALLOWLIST +
// ── readFrontmatterScalar) so next-plan-id.mjs can call the SAME predicate at mint time without
// ── importing the whole move-plan.mjs command module for one gate function. move-plan.mjs
// ── re-exports assertEvidenceFloorOk so its own tests/callers are unaffected. Plan 4071 (T2/D1/D2)
// ── then moved BOTH module-level literals to coord.config.json's planCategories.{allowlist,
// ── evidenceGated} and made assertEvidenceFloorOk take the gated list as a PARAMETER (default
// ── `[]` — D1: empty means no category is gated) — this leaf module carries no project taxonomy
// ── at all anymore. These tests pin: (1) vetapp's config reproduces the historical taxonomy
// ── byte-for-byte, (2) the predicate itself still refuses/no-ops correctly when CALLED with that
// ── list, (3) the D1 empty-list default is genuinely "no gate" rather than "reject everything",
// ── and (4) move-plan.mjs genuinely calls the SAME shared function (not a re-rolled copy).

// plan 3958: this module ships as-is into the public coord-kit, so a shipped core test must not
// pin THIS repo's real coord.config.json planCategories row (the kit's own config carries none
// at all). assertEvidenceFloorOk already takes its gated-category list as an explicit parameter
// (never self-resolved), so a fixed, portable fixture exercises the SAME logic in any repo — the
// byte-identity-against-real-config drift guard this constant used to feed is vetapp product
// coverage, not core coverage, and was removed with it.
const VETAPP_PLAN_CATEGORIES = { evidenceGated: ['Pipe', 'DQ', 'App', 'UI'] };

test('assertEvidenceFloorOk: ready target REFUSES a gated category stamped evidence: latent (lifted predicate, same behavior)', () => {
  assert.throws(
    () =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n\nbody\n',
        '100-DQ-x.md',
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    /cannot promote to ready\/.*evidence: latent.*product family/s,
  );
});

// plan 3341 code-review follow-up: EVIDENCE_FLOOR_BASENAME_RX's optional marker group used to
// be hand-written as `(FABLE-)?` only — a `000-SOL-Pipe-<slug>.md` basename mis-parsed as
// category "SOL" (not in the gated list) instead of "Pipe" (gated), so the refusal below
// silently never fired for a SOL-embedded category. The marker group is now DERIVED from
// plan-lane-segments.mjs's LANE_MARKER_ALTERNATION, so this must refuse exactly like the
// plain-DQ case above.
test('assertEvidenceFloorOk: a SOL- embedded marker still parses the REAL category ("Pipe", not "SOL") and refuses when latent (plan 3341)', () => {
  assert.throws(
    () =>
      assertEvidenceFloorOk(
        'ready',
        '---\nevidence: latent\n---\n\nbody\n',
        '100-SOL-Pipe-x.md',
        VETAPP_PLAN_CATEGORIES.evidenceGated,
      ),
    /cannot promote to ready\/.*evidence: latent and category "Pipe" is a product family/s,
    'must gate on category "Pipe", not misparse "SOL" as the category',
  );
});

test('assertEvidenceFloorOk: no-op for a non-ready target and for an ungated category, even when latent', () => {
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'in-progress',
      '---\nevidence: latent\n---\n\nbody\n',
      '100-DQ-x.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk(
      'ready',
      '---\nevidence: latent\n---\n\nbody\n',
      '100-Infra-x.md',
      VETAPP_PLAN_CATEGORIES.evidenceGated,
    ),
  );
});

// plan 4071 D1: an OMITTED evidenceGatedCategories degrades to `[]` — "no category is gated" —
// never "reject everything". A config-less repo (or a caller that forgot the parameter) must
// never refuse a ready/ promotion on this gate.
test('assertEvidenceFloorOk: an omitted evidenceGatedCategories parameter never refuses (D1 default is empty, not the vetapp taxonomy)', () => {
  assert.doesNotThrow(() =>
    assertEvidenceFloorOk('ready', '---\nevidence: latent\n---\n\nbody\n', '100-DQ-x.md'),
  );
});

test('R7: move-plan.mjs re-exports the IDENTICAL function — not a re-rolled copy', () => {
  assert.equal(
    movePlan.assertEvidenceFloorOk,
    buildIndexLib.assertEvidenceFloorOk,
    'move-plan.mjs must re-export the SAME assertEvidenceFloorOk reference',
  );
});

// ── plan 2973: cloudExecUnstampedWarning — the ONE composer shared by move-plan.mjs's ready/
// ── promote path, done-worktree.mjs's 6b close-out promoter, and stamp-exec-model.mjs's
// ── post-stamp check. Never a throw — it's a pure string-or-null composer, so these are plain
// ── value assertions, no assert.throws anywhere in this block.

test('cloudExecUnstampedWarning: warns when there is no frontmatter at all', () => {
  const warn = cloudExecUnstampedWarning('100-Coord-x.md', '# just a heading\n\nno frontmatter\n');
  assert.ok(warn, 'expected a warning string, got null');
  assert.match(warn, /100-Coord-x\.md/);
  assert.match(warn, /has no cloudExec: frontmatter key/);
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 100 true /);
  assert.match(
    warn,
    /node scripts\/stamp-cloud-exec\.mjs 100 false --reason "<why not cloud-safe>"/,
  );
});

test('cloudExecUnstampedWarning: warns when frontmatter exists but omits the cloudExec key', () => {
  const warn = cloudExecUnstampedWarning(
    '2973-Coord-x.md',
    '---\nsummary: x\nstage: specced\n---\n\nbody\n',
  );
  assert.ok(warn, 'expected a warning string, got null');
  assert.match(warn, /has no cloudExec: frontmatter key/);
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 2973 true /);
  assert.match(
    warn,
    /node scripts\/stamp-cloud-exec\.mjs 2973 false --reason "<why not cloud-safe>"/,
  );
});

test('cloudExecUnstampedWarning: warns with a DISTINCT lead sentence when the key is present but empty (FIX ROUND 2)', () => {
  // Round-1 bug: readFrontmatterScalar returns '' for BOTH "key absent" and "key present but
  // empty" — the composer used to misreport this case as "has no cloudExec: frontmatter key"
  // even though the plan visibly HAS the key. hasFrontmatterKey now disambiguates.
  const warn = cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec:\n---\n\nbody\n');
  assert.ok(warn, 'expected a warning string, got null');
  assert.match(warn, /has an empty cloudExec: value/);
  assert.doesNotMatch(
    warn,
    /has no cloudExec: frontmatter key/,
    'the key IS present — must not be misreported as absent',
  );
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 100 true /);
});

test('cloudExecUnstampedWarning: silent (null) when cloudExec: true is stamped', () => {
  assert.equal(
    cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: true\n---\n\nbody\n'),
    null,
  );
});

test('cloudExecUnstampedWarning: silent (null) when cloudExec: false is stamped — false is a deliberate verdict, not absence', () => {
  assert.equal(
    cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: false\n---\n\nbody\n'),
    null,
  );
});

test('cloudExecUnstampedWarning: strips a trailing YAML inline comment same as readFrontmatterScalar (plan 1292 rule)', () => {
  assert.equal(
    cloudExecUnstampedWarning(
      '100-Coord-x.md',
      '---\ncloudExec: false # not cloud-eligible, no network here\n---\n\nbody\n',
    ),
    null,
  );
});

test('cloudExecUnstampedWarning: names the remediation command and the silent-exclusion consequence', () => {
  const warn = cloudExecUnstampedWarning('100-Coord-x.md', '---\nsummary: x\n---\n\nbody\n');
  assert.match(warn, /stamp-cloud-exec\.mjs/);
  assert.match(warn, /queue-drain\.mjs --cloud/);
});

// ── Review fix round: only the exact strings `true`/`false` count as a stamp ────────────────

test('cloudExecUnstampedWarning: warns (does NOT silence) on a malformed cloudExec value, and names the offending value', () => {
  const warn = cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: yes\n---\n\nbody\n');
  assert.ok(warn, 'expected a warning string, got null — a typo silently reads as a real stamp');
  assert.match(warn, /has an invalid cloudExec: value "yes" \(expected true or false\)/);
  // FIX ROUND 2: the malformed lead used to end "— it reads as unstamped to queue-drain" and
  // then immediately hit the shared tail's own "— it will be silently excluded from every
  // cloud drain (...)" — two em-dash clauses saying the same thing back to back. That
  // redundant clause is dropped now; the lead flows straight into the shared tail once.
  assert.doesNotMatch(
    warn,
    /reads as unstamped to queue-drain/,
    'the redundant "reads as unstamped" clause must be gone — the shared tail already says this',
  );
  assert.match(
    warn,
    /has an invalid cloudExec: value "yes" \(expected true or false\) — it will be silently excluded/,
    'the lead must flow directly into the shared tail with exactly one em-dash join',
  );
});

test('cloudExecUnstampedWarning: warns on a near-miss malformed value ("tru")', () => {
  const warn = cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: tru\n---\n\nbody\n');
  assert.ok(warn, 'expected a warning string, got null');
  assert.match(warn, /has an invalid cloudExec: value "tru" \(expected true or false\)/);
});

test('cloudExecUnstampedWarning: silent (null) on cloudExec: TRUE (mixed/upper case still counts as a real stamp)', () => {
  assert.equal(
    cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: TRUE\n---\n\nbody\n'),
    null,
  );
});

test('cloudExecUnstampedWarning: silent (null) on cloudExec: False (mixed case still counts as a real stamp)', () => {
  assert.equal(
    cloudExecUnstampedWarning('100-Coord-x.md', '---\ncloudExec: False\n---\n\nbody\n'),
    null,
  );
});

// ── Review fix round: remediation id reuses claimedIdOfBasename (rejects legacy date-prefixed
// ── basenames instead of mis-parsing their leading digit-group as a real plan id) ───────────

test('cloudExecUnstampedWarning: a legacy date-prefixed basename falls back to the whole basename, not a misparsed year', () => {
  const warn = cloudExecUnstampedWarning('2026-05-17-legacy.md', '# heading\n\nno frontmatter\n');
  assert.ok(warn, 'expected a warning string, got null');
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 2026-05-17-legacy\.md true /);
  assert.doesNotMatch(warn, /stamp-cloud-exec\.mjs 2026 /);
});

test('cloudExecUnstampedWarning: a real numeric-id basename still extracts the bare id', () => {
  const warn = cloudExecUnstampedWarning('2973-Coord-x.md', '# heading\n\nno frontmatter\n');
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 2973 true /);
});

// ── Review fix round: the remediation prints two separately runnable commands (the `false`
// ── stamp REQUIRES --reason and is not copy-pastable as a bare `true|false` placeholder) ────

test('cloudExecUnstampedWarning: prints both the true command and a false command carrying --reason', () => {
  const warn = cloudExecUnstampedWarning('2973-Coord-x.md', '---\nsummary: x\n---\n\nbody\n');
  assert.match(warn, /node scripts\/stamp-cloud-exec\.mjs 2973 true — /, 'bare true command');
  assert.match(
    warn,
    /node scripts\/stamp-cloud-exec\.mjs 2973 false --reason "<why not cloud-safe>"/,
    'false command must carry --reason',
  );
});

// next-plan-id.mjs imports assertEvidenceFloorOk directly (it doesn't re-export it — nothing
// needs to reach it through next-plan-id.mjs's own surface), so its wiring is proven
// behaviorally instead, via the CLI-level tests in next-plan-id.test.mjs (the "claim --ready
// F5/R5" tests) that exercise the actual refusal/idempotent-reclaim paths end to end.
