// scripts/build-index.test.mjs
// plan 651: regression — a half-staged `git mv` close-out can leave `git ls-files`
// listing a plan's OLD in-progress path while the working file already sits at
// archive/ on disk. build-index's collectPlans used to `readFileSync` that path and
// ENOENT-crash the whole INDEX regen (step 4 of the 642 land recovery). It must now
// skip the tracked-but-missing path with a warning, never throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPlans } from './build-index.mjs';

function enoent() {
  const e = new Error('ENOENT: no such file or directory');
  e.code = 'ENOENT';
  throw e;
}

test('plan 651: collectPlans skips a tracked-but-missing plan path instead of ENOENT-crashing', () => {
  const lsFiles = () => [
    'docs/superpowers/plans/in-progress/651-Infra-gone.md', // tracked, missing on disk (half-staged)
    'docs/superpowers/plans/ready/652-Infra-here.md', // present + readable
  ];
  const readFile = (rel) =>
    rel.endsWith('651-Infra-gone.md') ? enoent() : '---\nsummary: still here\n---\n# 652 here\n';

  let result;
  assert.doesNotThrow(() => {
    result = collectPlans({ lsFiles, readFile });
  });
  // only the readable plan is indexed; the missing one is skipped (not crashed on)
  assert.equal(result.plans.length, 1, 'only the readable plan is indexed');
  assert.equal(result.plans[0].basename, '652-Infra-here.md');
  assert.ok(
    result.warnings.some((w) => /651-Infra-gone\.md.*missing on disk/.test(w)),
    'a half-staged-rename warning is recorded for the skipped path',
  );
});

test('plan 651: collectPlans rethrows a NON-ENOENT read error (a real failure is not swallowed)', () => {
  const lsFiles = () => ['docs/superpowers/plans/ready/653-Infra-x.md'];
  const readFile = () => {
    const e = new Error('EACCES: permission denied');
    e.code = 'EACCES';
    throw e;
  };
  assert.throws(() => collectPlans({ lsFiles, readFile }), /EACCES/);
});

// ── plan 1945: a bad-filename ACTIVE plan is a loud ERROR, not a silent skip ────────
test('plan 1945: collectPlans ERRORs (not silently skips) a lowercase-tag ACTIVE plan (the 1928 repro)', () => {
  const lsFiles = () => [
    'docs/superpowers/plans/ready/1928-tooling-routine-ctl-no-llm-trigger-cli.md',
    'docs/superpowers/plans/ready/1929-Infra-fine.md',
  ];
  const readFile = (rel) =>
    rel.endsWith('1929-Infra-fine.md')
      ? '---\nsummary: fine\n---\n# 1929 fine'
      : '---\nsummary: bad tag\n---\n# 1928 bad tag';
  const { plans, errors } = collectPlans({ lsFiles, readFile });
  assert.equal(plans.length, 1, 'the bad-filename plan is NOT indexed');
  assert.equal(plans[0].basename, '1929-Infra-fine.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1928-tooling-routine-ctl-no-llm-trigger-cli\.md.*PLAN_FILENAME_RX/s);
});

test('plan 1945: collectPlans exempts FOG.md by name, never by loosening the regex', () => {
  // FOG.md lives at the plans ROOT (no STATUS_ORDER subfolder), so it's already
  // filtered out upstream by the folder check — this fixture proves the allowlist
  // path is ALSO harmless if FOG.md (or a sanctioned sibling) ever sat inside one.
  const lsFiles = () => ['docs/superpowers/plans/ready/FOG.md'];
  const readFile = () => '# Plan-shaped material not yet a plan';
  const { plans, errors } = collectPlans({ lsFiles, readFile });
  assert.equal(plans.length, 0, 'FOG.md is not indexed as a plan bullet');
  assert.equal(errors.length, 0, 'FOG.md is exempt, not an error');
});

// ── plan 4122: lane-keeper files (README.md/README.txt) skip silently ────────
test('plan 4122: collectPlans skips a README.md/README.txt lane keeper silently, no error, no warning', () => {
  const lsFiles = () => [
    'docs/superpowers/plans/parked/README.md',
    'docs/superpowers/plans/waiting-grill/README.txt',
    'docs/superpowers/plans/waiting-grill/1928-Infra-fine.md',
  ];
  const readFile = (rel) =>
    rel.endsWith('1928-Infra-fine.md')
      ? '---\nsummary: fine\n---\n# 1928 fine'
      : '# lane keeper, not a plan';
  const { plans, errors, warnings } = collectPlans({ lsFiles, readFile });
  assert.equal(plans.length, 1, 'only the real plan is indexed');
  assert.equal(plans[0].basename, '1928-Infra-fine.md');
  assert.equal(errors.length, 0, 'a README keeper is never a PLAN_FILENAME_RX error');
  assert.equal(warnings.length, 0, 'a README keeper is never a warning either — a silent skip');
});

// gpt-review finding 4038e4 (altitude): the keeper skip is a LANE-keeper exemption, so it
// must be keyed to a DIRECT status-folder entry (`category === null`), not to the basename
// alone. A categorised `ready/infra/README.md` is a misplaced file, not a lane keeper —
// silently skipping it would reinstate exactly the plan-1928 invisibility the ERROR exists
// to prevent, one directory level down.
test('plan 4122: a README inside a CATEGORY folder is NOT a lane keeper — it still ERRORs', () => {
  const lsFiles = () => ['docs/superpowers/plans/ready/infra/README.md'];
  const readFile = () => '# misplaced, not a lane keeper';
  const { plans, errors } = collectPlans({ lsFiles, readFile });
  assert.equal(plans.length, 0);
  assert.equal(errors.length, 1, 'a categorised README is not exempt');
  assert.match(errors[0], /ready\/infra\/README\.md.*PLAN_FILENAME_RX/s);
});

test('plan 4122: a genuinely malformed basename still ERRORs — the keeper skip does not loosen PLAN_FILENAME_RX', () => {
  const lsFiles = () => ['docs/superpowers/plans/ready/1928-tooling-bad-tag.md'];
  const readFile = () => '---\nsummary: bad tag\n---\n# 1928 bad tag';
  const { plans, errors } = collectPlans({ lsFiles, readFile });
  assert.equal(plans.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /1928-tooling-bad-tag\.md.*PLAN_FILENAME_RX/s);
});

test('plan 1945: collectPlans stays clean (no errors) when every ACTIVE plan matches the shape', () => {
  const lsFiles = () => ['docs/superpowers/plans/ready/1930-Infra-fine.md'];
  const readFile = () => '---\nsummary: fine\n---\n# 1930 fine';
  const { errors } = collectPlans({ lsFiles, readFile });
  assert.equal(errors.length, 0);
});

// sonnet-review finding on plan 1945 itself: build-index.mjs's default (no --check/
// --print) run is invoked UNCONDITIONALLY by done-worktree.mjs's regenIndex() on every
// land close-out, for whichever plan happens to be landing — an unrelated bad-filename
// plan sitting anywhere else in the tree must not turn that call into a hard failure,
// or it blocks every session's land, not just a push touching the offending plan.
// --check (what the pre-push lint actually runs, unconditionally on every push) is the
// only mode allowed to hard-fail on a filename error. main()'s CLI wiring (REPO_ROOT is
// derived from build-index.mjs's OWN file location, not an injectable cwd/mainDir — see
// its module-level `const REPO_ROOT = …`) has no fixture seam, so this is proven at the
// collectPlans level (the exact data the `check && errors.length > 0` branch reads) plus
// a direct read of main()'s source shape below, rather than a subprocess fixture that
// would risk running the real (non---check) write mode against this checkout's own
// docs/INDEX.md.
test('plan 1945: main() only hard-fails on filename errors when --check is passed (source-shape guard)', async () => {
  const { readFileSync: rfs } = await import('node:fs');
  const src = rfs(new URL('./build-index.mjs', import.meta.url), 'utf8');
  assert.match(
    src,
    /if \(check && errors\.length > 0\)/,
    'the filename-error hard-fail must be gated on `check`, not unconditional — an ' +
      "unconditional `if (errors.length > 0)` would make done-worktree.mjs's unconditional " +
      "default-mode regenIndex() call throw over an UNRELATED plan's bad filename",
  );
});

// ── collectSpecs (plan 856) ─────────────────────────────────────────────────
import { collectSpecs } from './build-index.mjs';

test('plan 856: collectSpecs maps tracked spec paths to display paths + blurbs', () => {
  const lsFiles = () => [
    'docs/superpowers/specs/2026-06-09-foo-design.md',
    'docs/superpowers/specs/archive/2026-04-14-bar.md',
  ];
  const readFile = (rel) =>
    rel.endsWith('foo-design.md')
      ? '---\ntitle: Foo design\n---\n# Foo'
      : '# Bar archived spec\n\nbody';
  const { specs, warnings } = collectSpecs({ lsFiles, readFile });
  assert.equal(specs.length, 2);
  assert.deepEqual(
    specs.find((s) => s.displayPath === '2026-06-09-foo-design.md'),
    { displayPath: '2026-06-09-foo-design.md', blurb: 'Foo design' },
  );
  assert.deepEqual(
    specs.find((s) => s.displayPath === 'archive/2026-04-14-bar.md'),
    { displayPath: 'archive/2026-04-14-bar.md', blurb: 'Bar archived spec' },
  );
  assert.equal(warnings.length, 0);
});

test('plan 856: collectSpecs warns (but does not crash) on a spec with no blurb source', () => {
  const lsFiles = () => ['docs/superpowers/specs/2026-06-09-empty.md'];
  const readFile = () => 'no heading, no frontmatter at all';
  const { specs, warnings } = collectSpecs({ lsFiles, readFile });
  assert.equal(specs[0].blurb, '(no summary)');
  assert.ok(warnings.some((w) => /no frontmatter summary\/title or H1/.test(w)));
});

test('plan 856: collectSpecs skips a tracked-but-missing spec path instead of crashing', () => {
  const lsFiles = () => [
    'docs/superpowers/specs/2026-06-09-gone.md',
    'docs/superpowers/specs/2026-06-10-here.md',
  ];
  const readFile = (rel) => (rel.endsWith('gone.md') ? enoent() : '# Here');
  let result;
  assert.doesNotThrow(() => {
    result = collectSpecs({ lsFiles, readFile });
  });
  assert.equal(result.specs.length, 1);
  assert.equal(result.specs[0].displayPath, '2026-06-10-here.md');
  assert.ok(result.warnings.some((w) => /gone\.md.*missing on disk/.test(w)));
});

// ── plan 2678: category subfolders — collectPlans/renderPlansBlock ──────────
// Before this plan, statusAndBasename split on the FIRST slash only, so a plan at
// `ready/<cat>/NNNN-Coord-x.md` produced `basename: "<cat>/NNNN-Coord-x.md"` — a
// string PLAN_FILENAME_RX can never match (it requires the id at position 0). That
// turned a legal categorised `git mv` into a hard "INVISIBLE to docs/INDEX.md" error
// on every push (the plan-1928 failure mode, now hit by DESIGN instead of by mistake).
import { renderPlansBlock } from './build-index-lib.mjs';

// ONE fixture for the two tests below (they assert two halves of the same scenario —
// the collected record and the bullet it renders into). Duplicating the literals let a
// future edit to one copy silently leave the other asserting against stale input.
const NESTED_FIXTURE = {
  lsFiles: () => ['docs/superpowers/plans/ready/infra/2679-Coord-nested.md'],
  readFile: () => '---\nsummary: nested under a category\n---\n# 2679 nested',
};

test('plan 2678: collectPlans indexes a category-subfolder plan with a BARE basename and no error', () => {
  const { plans, errors } = collectPlans(NESTED_FIXTURE);
  assert.equal(errors.length, 0, 'a legally categorised plan must not fail PLAN_FILENAME_RX');
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0], {
    status: 'ready',
    category: 'infra',
    basename: '2679-Coord-nested.md', // BARE — not "infra/2679-Coord-nested.md"
    marker: '🟩',
    summary: 'nested under a category',
  });
});

test('plan 2678: the rendered INDEX bullet for a category-subfolder plan names its real relative path', () => {
  const { plans } = collectPlans(NESTED_FIXTURE);
  const block = renderPlansBlock(plans);
  assert.ok(
    block.includes('→ `ready/infra/2679-Coord-nested.md`'),
    'the bullet must name the REAL path (with category), not a flattened ready/<basename>',
  );
});

test('plan 2678: a FLAT corpus still renders byte-identical to the pre-2678 shape', () => {
  const lsFiles = () => [
    'docs/superpowers/plans/ready/2680-Coord-flat.md',
    'docs/superpowers/plans/in-progress/2681-Infra-other.md',
  ];
  const readFile = (rel) =>
    rel.endsWith('2680-Coord-flat.md')
      ? '---\nsummary: Flat plan.\n---\n# 2680 flat'
      : '---\nsummary: Other plan.\n---\n# 2681 other';
  const { plans, errors } = collectPlans({ lsFiles, readFile });
  assert.equal(errors.length, 0);
  const block = renderPlansBlock(plans);
  assert.equal(
    block,
    [
      '<!-- INDEX:PLANS-START (generated by scripts/build-index.mjs — do not hand-edit between the sentinels) -->',
      '',
      '**in-progress/**',
      '',
      '- 🟩 Other plan. → `in-progress/2681-Infra-other.md`',
      '',
      '**ready/**',
      '',
      '- 🟩 Flat plan. → `ready/2680-Coord-flat.md`',
      '',
      '<!-- INDEX:PLANS-END -->',
    ].join('\n'),
  );
});
