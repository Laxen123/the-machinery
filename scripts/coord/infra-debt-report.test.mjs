// scripts/coord/infra-debt-report.test.mjs (plan 4199)
// Name-paired with scripts/coord/infra-debt-report.mjs — a genuinely new module, no existing test
// file to fold into (CLAUDE.md's "new *.test.mjs file needs a one-line justification").
//
// Every fixture is an in-memory ledger string handed to the pure `buildReport`, and every age
// figure takes an injected `now`, so nothing here reads the real ledger or the real clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  parseLedger,
  normalizeSlug,
  findDuplicateClusters,
  formatCheck,
  main,
} from './infra-debt-report.mjs';

const NOW = new Date('2026-09-25T12:00:00Z');

function ledger({ sweep = '2026-09-20', entries }) {
  return [
    '# Fixture debt list',
    '',
    `Every line carries a tag, one of \`[pipeline]\` \`[land]\` \`[coord]\`. Last sweep ${sweep}.`,
    '',
    '## Entries',
    '',
    ...entries,
    '',
  ].join('\n');
}

const CLEAN = [
  '- 2026-09-24 [pipeline] `alpha-thing-breaks` — body. (fix-now failed: (a).)',
  '- 2026-09-23 [land] `beta-gate-slow` — body',
  '  continuation line that is not an entry',
  '- 2026-09-23 [coord] `gamma-ref-leak` — body',
];

test('a clean ledger reports no sweep due', () => {
  const r = buildReport(ledger({ entries: CLEAN }), { now: NOW });
  assert.equal(r.entries, 3, 'the indented continuation line is not an entry');
  assert.deepEqual(r.allowedTags, ['pipeline', 'land', 'coord']);
  assert.equal(r.lastSweep, '2026-09-20');
  assert.equal(r.lastSweepAgeDays, 5);
  assert.equal(r.oldestDate, '2026-09-23');
  assert.equal(r.sweepDue, false, r.reasons.join('; '));
  assert.match(formatCheck(r, 'fixture.md'), /^INFRA-DEBT: OK \(fixture\.md: 3 entries/);
});

test('flags all five shape defects: off-contract tag, untagged line, inversion, duplicate slug, stale sweep', () => {
  const text = ledger({
    sweep: '2026-08-01',
    entries: [
      '- 2026-09-24 [scripts] `off-contract-tag-line` — body',
      '- 2026-09-23 `no-tag-at-all` — body',
      '- 2026-09-25 [land] `newer-below-older` — body',
      '- 2026-09-20 [coord] `same-slug-twice` — first filing',
      '- 2026-09-19 [coord] `same-slug-twice` — second filing',
    ],
  });
  const r = buildReport(text, { now: NOW });
  assert.deepEqual(
    r.offContractTags.map((x) => x.tag),
    ['scripts'],
  );
  assert.deepEqual(
    r.untagged.map((x) => x.slug),
    ['no-tag-at-all'],
  );
  assert.deepEqual(
    r.inversions.map((x) => [x.date, x.after]),
    [['2026-09-25', '2026-09-23']],
  );
  assert.equal(r.duplicateClusters.length, 1);
  assert.equal(r.duplicateClusters[0].kind, 'exact');
  assert.deepEqual(
    r.duplicateClusters[0].entries.map((e) => e.slug),
    ['same-slug-twice', 'same-slug-twice'],
  );
  assert.equal(r.lastSweepAgeDays, 55);
  assert.equal(r.sweepDue, true);
  assert.equal(r.reasons.length, 5, r.reasons.join('; '));
  assert.ok(r.reasons.some((x) => /last sweep 2026-08-01 is 55d old/.test(x)));
});

test('with sweepDateOptional, a dateless header reads "never" and is not by itself a reason', () => {
  // gpt-review r1 (907a0d/aaa514): grammar-debt.md carries no sweep date by design, so a reason no
  // sweep could clear would make that ledger SWEEP DUE forever — board-pass passes the opt-out.
  const text = ledger({ entries: CLEAN }).replace(' Last sweep 2026-09-20.', '');
  const r = buildReport(text, { now: NOW, sweepDateOptional: true });
  assert.equal(r.lastSweep, null);
  assert.deepEqual(r.reasons, []);
  assert.match(formatCheck(r, 'x.md'), /last sweep never\)$/);
});

test('impossible calendar dates never count as dates (gpt-review r1 705803)', () => {
  const r = buildReport(
    ledger({
      sweep: '2026-99-99',
      entries: [...CLEAN, '- 2026-02-31 [land] `feb-31` — body'],
    }),
    { now: NOW },
  );
  assert.equal(r.lastSweep, null, 'an invalid sweep date is no sweep date, never a NaN age');
  assert.equal(r.entries, 3);
  assert.deepEqual(
    r.malformed.map((m) => m.line),
    [11],
  );
  assert.ok(Number.isFinite(r.oldestAgeDays));
});

test('the --check headline carries the oldest entry and its age (gpt-review r1 b8cdcc)', () => {
  const r = buildReport(ledger({ entries: CLEAN }), { now: NOW });
  assert.match(formatCheck(r, 'x.md'), /oldest 2026-09-23 \(2d\), last sweep 2026-09-20\)$/);
});

test("grammar-debt.md's bold date and bold slug shapes parse as dated entries (gpt-review r1 d60ff9)", () => {
  const { entries } = parseLedger(
    [
      '# g',
      '',
      '- **2026-08-12 · An extraction arm swept the NAV into a row.**',
      '- **tooth-count-tier-exactly-two** (2026-08-13, plan-3099 batch-2): body',
    ].join('\n'),
  );
  assert.deepEqual(
    entries.map((e) => [e.date, e.slug]),
    [
      ['2026-08-12', null], // a bold-date title is prose, not a slug (r2 1f1a72)
      ['2026-08-13', 'tooth-count-tier-exactly-two'],
    ],
  );
});

test('--ref reads the committed ledger through git show, not the working tree (gpt-review r1 da7ed0)', () => {
  const calls = [];
  const git = (cmd, args) => {
    calls.push([cmd, ...args]);
    return ledger({ entries: CLEAN });
  };
  const out = [];
  const code = main(['--check', '--ref', 'origin/master'], {
    write: (s) => out.push(s),
    now: NOW,
    git,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), 'origin/master:docs/handoff/infra-debt.md');
  assert.match(out.join(''), /^INFRA-DEBT: OK \(infra-debt\.md: 3 entries/);
  const failing = () => {
    throw new Error('bad ref');
  };
  assert.equal(main(['--check', '--ref', 'nope'], { write: () => {}, now: NOW, git: failing }), 2);
});

test('the max sweep age is a parameter', () => {
  const r = buildReport(ledger({ entries: CLEAN }), { now: NOW, maxSweepAgeDays: 3 });
  assert.equal(r.sweepDue, true);
  assert.match(r.reasons[0], /> 3d/);
});

test('a ledger whose header declares no tags skips the tag checks (grammar-debt.md shape)', () => {
  const text = [
    '# Grammar debt',
    '',
    'Same write contract as infra-debt.md. Last sweep 2026-09-20.',
    '',
    '- 2026-09-24 `untagged-is-fine-here` — body',
    '  continuation',
    '- 2026-09-22 `another` — body',
  ].join('\n');
  const r = buildReport(text, { now: NOW });
  assert.equal(r.allowedTags, null);
  assert.equal(r.entries, 2);
  assert.deepEqual(r.untagged, []);
  assert.deepEqual(r.offContractTags, []);
  assert.equal(r.sweepDue, false, r.reasons.join('; '));
});

test('terminal markers: only a STATUS-position marker counts, never a mid-sentence word', () => {
  const { entries } = parseLedger(
    ledger({
      entries: [
        '- 2026-09-24 [land] `a` — **RESOLVED by plan 4189 (landed, `2d908963b22`)**',
        '- 2026-09-24 [land] `b` — **FIXED 2026-08-25** (thing now does x)',
        '- 2026-09-24 [land] `RESOLVED-BY-4192: c` — plan 4192 fixes it',
        '- ~~2026-09-24 [land] `d`~~ — RETIRED by plan 3519',
        '- 2026-09-24 [land] `e` — the probe is NOT FIXED on a FIXED path; the RESOLVED id is stale',
        '- 2026-09-24 [land] `f` — SUPERSEDED IN PART by plan 9',
      ],
    }),
  );
  assert.deepEqual(
    entries.map((e) => [e.slug, e.terminal]),
    [
      ['a', true],
      ['b', true],
      ['RESOLVED-BY-4192: c', true],
      ['d', true],
      ['e', false],
      ['f', true],
    ],
  );
});

test('an undated top-level line is reported, not silently counted as an entry', () => {
  const r = buildReport(
    ledger({
      entries: [...CLEAN, '- ✅ **RESOLVED 2026-08-27 (plan 3469)** — a stray sub-bullet'],
    }),
    { now: NOW },
  );
  assert.equal(r.entries, 3);
  assert.equal(r.malformed.length, 1);
  assert.equal(r.sweepDue, true);
});

test('normalizeSlug strips a RESOLVED status prefix so the closure clusters with its origin', () => {
  assert.equal(normalizeSlug('RESOLVED-BY-4192: Cloud-Land-Rebuilds'), 'cloud-land-rebuilds');
  assert.equal(normalizeSlug('RESOLVED — apply-2206-persists'), 'apply-2206-persists');
  const clusters = findDuplicateClusters([
    { line: 1, date: '2026-09-02', slug: 'apply-2206-persists-the-roster-early' },
    { line: 2, date: '2026-09-01', slug: 'RESOLVED — apply-2206-persists-the-roster-early' },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].kind, 'exact');
});

test('near-duplicate slugs cluster as candidates; short or unrelated slugs do not', () => {
  const clusters = findDuplicateClusters([
    {
      line: 1,
      date: '2026-09-03',
      slug: 'stamp-exec-model-move-fails-when-target-lane-dir-is-empty',
    },
    { line: 2, date: '2026-09-02', slug: 'stamp-exec-model-move-fails-into-empty-target-lane' },
    { line: 3, date: '2026-09-01', slug: 'gate-cache-closure-is-hand-enumerated' },
    { line: 4, date: '2026-09-01', slug: 'a-b-c' },
    { line: 5, date: '2026-09-01', slug: 'a-b-d' },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].kind, 'near');
  assert.deepEqual(
    clusters[0].entries.map((e) => e.line),
    [1, 2],
  );
});

test('main: --check prints the verdict and exits 0 even when a sweep is due; --json round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infra-debt-report-'));
  try {
    const path = join(dir, 'debt.md');
    writeFileSync(path, ledger({ sweep: '2026-01-01', entries: CLEAN }));
    const out = [];
    assert.equal(main(['--check', '--ledger', path], { write: (s) => out.push(s), now: NOW }), 0);
    assert.match(out.join(''), /^INFRA-DEBT: SWEEP DUE \(debt\.md: 3 entries/);
    const json = [];
    assert.equal(main(['--json', '--ledger', path], { write: (s) => json.push(s), now: NOW }), 0);
    const parsed = JSON.parse(json.join(''));
    assert.equal(parsed.ledger, 'debt.md');
    assert.equal(parsed.entries, 3);
    assert.equal(main(['--ledger', join(dir, 'missing.md')], { write: () => {}, now: NOW }), 2);
    assert.equal(main(['--bogus'], { write: () => {}, now: NOW }), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bold-shaped entries get the same terminal-marker detection (gpt-review r2 c7c55f/5ba14e/e7029b)', () => {
  const { entries } = parseLedger(
    [
      '# g',
      '',
      '- **RESOLVED-BY-4100: some-slug** (2026-08-13, plan 4100): fixed',
      '- ~~**2026-08-12 · A struck title.**~~',
      '- **2026-08-11 · FIXED — a title that leads with a status.**',
      '- **plain-slug** (2026-08-10): still open',
    ].join('\n'),
  );
  assert.deepEqual(
    entries.map((e) => [e.date, e.terminal]),
    [
      ['2026-08-13', true],
      ['2026-08-12', true], // struck-through bold date parses since r3 f557de
      ['2026-08-11', true],
      ['2026-08-10', false],
    ],
  );
});

test('a bold-date TITLE is not a slug, so it never feeds duplicate matching (gpt-review r2 1f1a72)', () => {
  const r = buildReport(
    [
      '# g',
      '',
      '- **2026-08-12 · The extraction arm swept the site navigation menu into rows.**',
      '- **2026-08-11 · The extraction arm swept the site navigation footer into rows.**',
    ].join('\n'),
    { now: NOW },
  );
  assert.equal(r.entries, 2);
  assert.deepEqual(r.duplicateClusters, []);
});

test('a missing sweep date IS a reason unless the caller says the ledger carries none (gpt-review r2 d7f6d7)', () => {
  const text = ledger({ entries: CLEAN }).replace(' Last sweep 2026-09-20.', '');
  assert.deepEqual(buildReport(text, { now: NOW }).reasons, ['header records no last-sweep date']);
  assert.deepEqual(buildReport(text, { now: NOW, sweepDateOptional: true }).reasons, []);
  const out = [];
  const git = () => text;
  main(['--check', '--ref', 'x', '--no-sweep-date-ok'], {
    write: (s) => out.push(s),
    now: NOW,
    git,
  });
  assert.match(out.join(''), /^INFRA-DEBT: OK/);
});

test('a fresh, entry-free ledger is never SWEEP DUE for lacking a last-sweep date (plan 4218 gap 2)', () => {
  // Mirrors coord-init's infraDebtSkeleton(): a header naming the tag contract, no "last sweep"
  // line, and nothing under `## Entries` yet — the shape a brand-new adopting project starts with.
  const text = [
    '# Rolling debt ledger',
    '',
    'Every line carries a category tag right after the date — one of `[land]` `[plans]` `[review]`',
    '`[hooks]` `[cloud]` `[wiki]` `[test]` `[misc]`.',
    '',
    '## Entries',
    '',
  ].join('\n');
  const r = buildReport(text, { now: NOW });
  assert.equal(r.entries, 0);
  assert.equal(r.lastSweep, null);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.sweepDue, false);
  assert.match(formatCheck(r, 'infra-debt.md'), /^INFRA-DEBT: OK/);
});

test('the full report states the oldest entry once, in the headline (gpt-review r2 95b14f)', () => {
  const out = [];
  main(['--ref', 'x'], {
    write: (s) => out.push(s),
    now: NOW,
    git: () => ledger({ entries: CLEAN }),
  });
  assert.equal(out.join('').match(/2026-09-23/g).length, 1);
});

test('bold shapes: struck-through, body-status and slug-word cases (gpt-review r3 b5bd81/8e3509/f557de/1150d8)', () => {
  const { entries } = parseLedger(
    [
      '# g',
      '',
      '- ~~**2026-08-14 · A shipped item.**~~ — retired by plan 9',
      '- **some-slug** (2026-08-13, plan 4100): ✅ RESOLVED — shipped',
      '- **fixed-fee-rounding** (2026-08-12): still open',
      '- **retired-word-still-used** (2026-08-11, plan 1): open',
    ].join('\n'),
  );
  assert.deepEqual(
    entries.map((e) => [e.date, e.terminal]),
    [
      ['2026-08-14', true],
      ['2026-08-13', true],
      ['2026-08-12', false],
      ['2026-08-11', false],
    ],
  );
});

test('a relative --ledger resolves against the repo root, so --ref finds it from any cwd (gpt-review r3 d0a0f2)', () => {
  const seen = [];
  const git = (cmd, args) => {
    seen.push(args.at(-1));
    return ledger({ entries: CLEAN });
  };
  const code = main(
    ['--check', '--ref', 'origin/master', '--ledger', 'docs/handoff/grammar-debt.md'],
    {
      write: () => {},
      now: NOW,
      git,
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(seen, ['origin/master:docs/handoff/grammar-debt.md']);
});
