// scripts/lint-plan-index.test.mjs (plan 1371 D7)
// Pure-core tests for findStageFolderViolations — the stage/folder invariant added to
// lint-plan-index.mjs: pending-approval/ must hold ONLY `stage: stub` plans. The other
// two lint-plan-index checks (build-index --check, archive-consistency) shell out to a
// real git repo and are exercised only indirectly (via the coord pre-push suite); this
// new check is deliberately pure (entries in, violation strings out) so it can be pinned
// here without spinning up a scratch repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findStageFolderViolations,
  findInheritedPremisesViolations,
  boundArchiveRegion,
  checkIndexStale,
  findNestingViolations,
  findDuplicateIdViolations,
  checkDuplicateIdInvariant,
  GRANDFATHERED_DUPLICATE_ID_PATHS,
} from './lint-plan-index.mjs';

// ── findInheritedPremisesViolations (plan 3943) ────────────────────────────
// Pure core, same in/out shape as findStageFolderViolations above: a `program:` child in
// ready/ must carry a `## Inherited premises` section. Folded into this file rather than a
// new one — it is a second pure check on the SAME module, which is the repo's default.

const PROGRAM_CHILD = [
  '---',
  'stage: specced',
  'program: 3796-meaning-census',
  '---',
  '',
  '# X',
  '',
];

test('findInheritedPremisesViolations: flags a program child in ready/ with no section', () => {
  const v = findInheritedPremisesViolations([
    {
      path: 'docs/superpowers/plans/ready/500-Pipe-bite.md',
      content: PROGRAM_CHILD.join('\n'),
    },
  ]);
  assert.equal(v.length, 1);
  assert.match(v[0], /500-Pipe-bite\.md/);
  assert.match(v[0], /Inherited premises/);
});

test('findInheritedPremisesViolations: the section satisfies it (heading anywhere in the body)', () => {
  const content = [
    ...PROGRAM_CHILD,
    '## Inherited premises',
    '',
    '- phase_judges runs before phase_apply (run-batch.py:17917 / :17961).',
    '',
  ].join('\n');
  assert.deepEqual(
    findInheritedPremisesViolations([
      { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
    ]),
    [],
  );
});

test('findInheritedPremisesViolations: a heading whose case/spacing differs still counts', () => {
  for (const heading of ['##   Inherited premises', '## INHERITED PREMISES (from 3796)']) {
    assert.deepEqual(
      findInheritedPremisesViolations([
        {
          path: 'docs/superpowers/plans/ready/500-Pipe-bite.md',
          content: [...PROGRAM_CHILD, heading, '', '- a premise.', ''].join('\n'),
        },
      ]),
      [],
      `expected "${heading}" to satisfy the check`,
    );
  }
});

test('findInheritedPremisesViolations: a plan with NO program: key is out of scope', () => {
  assert.deepEqual(
    findInheritedPremisesViolations([
      {
        path: 'docs/superpowers/plans/ready/500-Other-standalone.md',
        content: '---\nstage: specced\n---\n\n# X\n',
      },
    ]),
    [],
  );
});

test('findInheritedPremisesViolations: a program child OUTSIDE ready/ is out of scope', () => {
  // pending-approval/ is still pre-spec-pass (the pass is what writes the section);
  // in-progress/ is already claimed and grandfathered; archive/ is history.
  for (const folder of ['pending-approval', 'in-progress', 'waiting-blocked', 'archive']) {
    assert.deepEqual(
      findInheritedPremisesViolations([
        {
          path: `docs/superpowers/plans/${folder}/500-Pipe-bite.md`,
          content: PROGRAM_CHILD.join('\n'),
        },
      ]),
      [],
      `expected ${folder}/ to be out of scope`,
    );
  }
});

test('findInheritedPremisesViolations: a category subfolder under ready/ is still in scope', () => {
  // classifyPlanPaths allows one optional lowercase category level (plan 2678); the
  // status segment is still rel.split('/')[0], so such a child must not slip the check.
  const v = findInheritedPremisesViolations([
    {
      path: 'docs/superpowers/plans/ready/denmark/500-Pipe-bite.md',
      content: PROGRAM_CHILD.join('\n'),
    },
  ]);
  assert.equal(v.length, 1);
  assert.match(v[0], /500-Pipe-bite\.md/);
});

// --- plan 3943 review round 1 ---------------------------------------------------------

test('findInheritedPremisesViolations [review]: an EMPTY section does not satisfy the check', () => {
  // A heading with nothing under it is the section's shape without its content — and the
  // whole point is the premises themselves, one line each.
  for (const tail of ['', '\n', '\n\n', '\n\n## Tasks\n\n- T1 do the thing.\n']) {
    const content = [...PROGRAM_CHILD, '## Inherited premises'].join('\n') + tail;
    assert.equal(
      findInheritedPremisesViolations([
        { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
      ]).length,
      1,
      `expected an empty section (tail ${JSON.stringify(tail)}) to still be a violation`,
    );
  }
});

test('findInheritedPremisesViolations [review-2]: a section whose ONLY content is a fenced example is empty', () => {
  // The round-1 non-empty check trimmed the whole section, so a real heading followed by a
  // ```md illustration of what premises look like read as "has content".
  const content = [
    ...PROGRAM_CHILD,
    '## Inherited premises',
    '',
    '```md',
    '- phase_judges runs before phase_apply (run-batch.py:17917 / :17961).',
    '```',
    '',
  ].join('\n');
  assert.equal(
    findInheritedPremisesViolations([
      { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
    ]).length,
    1,
  );
});

test('findInheritedPremisesViolations [review-2]: a real premise line PLUS a fenced example is fine', () => {
  const content = [
    ...PROGRAM_CHILD,
    '## Inherited premises',
    '',
    '- phase_judges runs before phase_apply (run-batch.py:17917 / :17961).',
    '',
    '```md',
    '(an illustration of the shape)',
    '```',
    '',
  ].join('\n');
  assert.deepEqual(
    findInheritedPremisesViolations([
      { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
    ]),
    [],
  );
});

test('findInheritedPremisesViolations [review]: a heading inside a FENCED example does not satisfy it', () => {
  const content = [
    ...PROGRAM_CHILD,
    'A program child is expected to carry:',
    '',
    '```md',
    '## Inherited premises',
    '',
    '- phase_judges runs before phase_apply.',
    '```',
    '',
  ].join('\n');
  assert.equal(
    findInheritedPremisesViolations([
      { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
    ]).length,
    1,
  );
});

test('findInheritedPremisesViolations: a PROSE mention of "Inherited premises" is not a heading', () => {
  const content = [
    ...PROGRAM_CHILD,
    'The parent lists its Inherited premises elsewhere; see 3796.',
    '',
  ].join('\n');
  assert.equal(
    findInheritedPremisesViolations([
      { path: 'docs/superpowers/plans/ready/500-Pipe-bite.md', content },
    ]).length,
    1,
  );
});

test('findStageFolderViolations: flags a specced plan resting in pending-approval/', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/pending-approval/500-Other-x.md',
      content: '---\nstage: specced\n---\n\n# X\n',
    },
  ];
  const v = findStageFolderViolations(entries);
  assert.equal(v.length, 1);
  assert.match(v[0], /500-Other-x\.md/);
  assert.match(v[0], /stage: specced/);
});

test('findStageFolderViolations: stage: stub in pending-approval/ is fine', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/pending-approval/501-Other-y.md',
      content: '---\nstage: stub\n---\n\n# Y\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

test('findStageFolderViolations: no stage key at all (legacy plan) is fine — grandfathered', () => {
  const entries = [
    { path: 'docs/superpowers/plans/pending-approval/502-Other-z.md', content: '# Z\n\nBody.\n' },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

test('findStageFolderViolations: a specced plan in ready/ is out of scope for this check (write-time gate covers it)', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/ready/503-Other-w.md',
      content: '---\nstage: specced\n---\n\n# W\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

test('findStageFolderViolations: a stub in ready/ is also out of scope for this check (a different gate owns it)', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/ready/504-Other-w2.md',
      content: '---\nstage: stub\n---\n\n# W2\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

// plan 1426: parked/ is EXEMPT from the stage/folder invariant — a plan can be frozen
// at any stage (stub, specced, or absent), and the invariant only ever scopes to
// pending-approval/ in the first place, so this is a regression pin on that scoping.
test('findStageFolderViolations: a specced plan in parked/ is out of scope (frozen at any stage)', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/parked/509-Other-frozen.md',
      content: '---\nstage: specced\n---\n\n# Frozen\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

test('findStageFolderViolations: case-insensitive + comment-tolerant stage comparison', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/pending-approval/505-Other-v.md',
      content: '---\nstage: Specced # spec-pass verdict\n---\n\n# V\n',
    },
  ];
  assert.equal(findStageFolderViolations(entries).length, 1);
});

test('findStageFolderViolations: multiple violations across multiple entries are all reported', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/pending-approval/506-Other-a.md',
      content: '---\nstage: specced\n---\n\n# A\n',
    },
    {
      path: 'docs/superpowers/plans/pending-approval/507-Other-b.md',
      content: '---\nstage: stub\n---\n\n# B\n',
    },
    {
      path: 'docs/superpowers/plans/pending-approval/508-Other-c.md',
      content: '---\nstage: specced\n---\n\n# C\n',
    },
  ];
  const v = findStageFolderViolations(entries);
  assert.equal(v.length, 2);
  assert.ok(v.some((m) => m.includes('506-Other-a.md')));
  assert.ok(v.some((m) => m.includes('508-Other-c.md')));
});

// --- findNestingViolations (plan 2678, category-subfolder nesting) -----------
// Pure over a repo-relative path list — no fixture repo needed. A plan sits flat
// under its status folder, or ONE level down in a lowercase [a-z0-9-]+ category
// folder; two levels of nesting, an uppercase category, or ANY category under the
// flat-only archive/ are each a lint failure. Without this check the rule would be
// documentation only — an illegal path would still enumerate (classifyPlanRel makes
// it VISIBLE, never skips it) into INDEX bullets / board refs nobody validated.

test('findNestingViolations: a flat corpus is clean', () => {
  const paths = [
    'docs/superpowers/plans/ready/900-Infra-a.md',
    'docs/superpowers/plans/in-progress/901-Infra-b.md',
  ];
  assert.deepEqual(findNestingViolations(paths), []);
});

test('findNestingViolations: a legal one-level category folder is clean', () => {
  const paths = ['docs/superpowers/plans/ready/infra/902-Infra-c.md'];
  assert.deepEqual(findNestingViolations(paths), []);
});

test('findNestingViolations: two levels of category nesting is EXACTLY one violation matching /EXACTLY one/', () => {
  const paths = ['docs/superpowers/plans/ready/infra/sub/903-Infra-d.md'];
  const v = findNestingViolations(paths);
  assert.equal(v.length, 1);
  assert.match(v[0], /EXACTLY one/);
});

test('findNestingViolations: an uppercase category folder is a violation matching /lowercase/', () => {
  const paths = ['docs/superpowers/plans/ready/Infra/904-Infra-e.md'];
  const v = findNestingViolations(paths);
  assert.equal(v.length, 1);
  assert.match(v[0], /lowercase/);
});

test('findNestingViolations: a category folder under the flat-only archive/ is a violation matching /stays FLAT/', () => {
  const paths = ['docs/superpowers/plans/archive/infra/905-Infra-f.md'];
  const v = findNestingViolations(paths);
  assert.equal(v.length, 1);
  assert.match(v[0], /stays FLAT/);
});

// --- driftIsInherited (plan 1650, layer 2) -----------------------------------
// Attribution is exact: a non-master branch whose own commits (merge-base with
// origin/master → HEAD) touched NONE of the generated-INDEX inputs, with a clean
// working tree over them, carries any found violation verbatim from master —
// inherited, tolerated with a WARN. Master, detached HEAD, an input-touching
// branch, local working-tree dirt, and every git failure stay STRICT
// (fail-closed). Driven through the _exec seam; each fake asserts the git calls
// it expects so a reordering of the plumbing shows up here.

import { driftIsInherited, INDEX_INPUT_PATHSPECS } from './lint-plan-index.mjs';
import { fakeExec } from '../fake-git-exec.mjs';

test('driftIsInherited: worktree branch, inputs untouched + clean tree → inherited (true)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1650-x\n',
    'merge-base': 'abc123\n',
    diff: '', // exit 0 ⇔ untouched
    status: '', // clean working tree over the pathspecs
  });
  assert.equal(driftIsInherited({ _exec }), true);
  assert.ok(
    _exec.calls.some((c) => c.includes('diff --quiet abc123 HEAD --')),
    'attribution must diff merge-base..HEAD over the input pathspecs',
  );
  assert.ok(
    !_exec.calls.some((c) => c.startsWith('fetch')),
    'no network fetch — a stale local origin/master only moves the answer toward strict',
  );
});

test('plan 1650 review [0]: INDEX_INPUT_PATHSPECS pins the GENERATOR code, not just the data', () => {
  for (const gen of [
    'scripts/build-index.mjs',
    'scripts/coord/build-index-lib.mjs',
    'scripts/lint-plan-index.mjs',
    // plan 1664 review [0]/[1]: the git-attribution engine itself, extracted out of this
    // file, must stay an input — a branch weakening it must not grade its own change.
    'scripts/coord/drift-attribution-lib.mjs',
    'coord.config.json',
    'docs/INDEX.md',
  ]) {
    assert.ok(
      INDEX_INPUT_PATHSPECS.includes(gen),
      `${gen} must be an attribution input — a branch changing generation semantics owns its drift`,
    );
  }
});

test('plan 1650 review [1]/[2]: local working-tree dirt over the inputs → strict (false)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1650-x\n',
    'merge-base': 'abc123\n',
    diff: '',
    status: ' M docs/superpowers/plans/pending-approval/999-DQ-x.md\n', // uncommitted local edit
  });
  assert.equal(driftIsInherited({ _exec }), false);
});

test('driftIsInherited: branch touched a plan-doc input → strict (false)', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1650-x\n',
    'merge-base': 'abc123\n',
    diff: () => {
      const e = new Error('exit 1');
      e.status = 1;
      throw e;
    },
  });
  assert.equal(driftIsInherited({ _exec }), false);
});

test('driftIsInherited: master stays strict — a master push can heal in the same motion', () => {
  const _exec = fakeExec({ 'rev-parse': 'master\n' });
  assert.equal(driftIsInherited({ _exec }), false);
  assert.equal(_exec.calls.length, 1, 'must short-circuit before any other git call');
});

test('driftIsInherited: detached HEAD stays strict', () => {
  const _exec = fakeExec({ 'rev-parse': 'HEAD\n' });
  assert.equal(driftIsInherited({ _exec }), false);
});

test('driftIsInherited: unresolvable origin/master (no merge-base) → strict, fail-closed', () => {
  const _exec = fakeExec({
    'rev-parse': 'worktree-1650-x\n',
    'merge-base': () => {
      throw new Error('fatal: no merge base');
    },
  });
  assert.equal(driftIsInherited({ _exec }), false);
});

test('driftIsInherited: rev-parse failure → strict', () => {
  const _exec = fakeExec({
    'rev-parse': () => {
      throw new Error('not a git repo');
    },
  });
  assert.equal(driftIsInherited({ _exec }), false);
});

// plan 1669: driftIsInherited's own `env` default is `{}`, never `process.env` — every
// test above calls `driftIsInherited({ _exec })` with no `env`, so this pins that the
// wrapper does NOT fall back to reading the ambient process environment (which
// `.husky/pre-push` may have populated with COORD_DRIFT_BRANCH/COORD_DRIFT_BASE for the
// shared rev-parse/merge-base optimization) — only main()'s real call site opts in.
test('driftIsInherited: env threads through to the shared core, skipping its rev-parse/merge-base', () => {
  const _exec = fakeExec({
    diff: '',
    status: '',
    // no rev-parse/merge-base handlers — calling either would throw here
  });
  assert.equal(
    driftIsInherited({
      _exec,
      env: { COORD_DRIFT_BRANCH: 'worktree-1669-x', COORD_DRIFT_BASE: 'abc123' },
    }),
    true,
  );
  assert.equal(_exec.calls.length, 2, 'only diff + status — rev-parse/merge-base came from env');
});

// --- checkArchiveConsistency return shape (plan 1650 review [1]) --------------
// The untracked-on-disk strand (245-DQ class) is flagged out-of-band so main() can
// refuse to tolerate it: it lives only in THIS working tree (gitignored — invisible
// to git diff AND git status), so it can never be "inherited master drift".

import { checkArchiveConsistency } from './lint-plan-index.mjs';

test('checkArchiveConsistency returns { code, untrackedStrand } (object, not a bare int)', () => {
  const res = checkArchiveConsistency();
  assert.equal(typeof res, 'object');
  assert.ok('code' in res && 'untrackedStrand' in res);
});

// --- boundArchiveRegion (plan 2052 R2) -----------------------------------------
// The archive-narrative region's real shape today: a paragraph anchor, some
// `- \`name.md\`` bullet lines, zero interior headings, until `## Reference` far
// below — this is the parity case (byte-identical to the old level-blind
// `region.search(/\n#{1,6} /)` for any input that never mixes heading levels).
// `afterPlansEnd` + `fromIndex` are passed SEPARATELY (never pre-sliced) so
// nextHeadingBoundary's fence-tracking always sees the text's true start —
// review finding, plan 2052.

test('boundArchiveRegion: parity — bounds at the next heading of level <= 2, real-shape input', () => {
  const region =
    'Moved to `docs/superpowers/plans/archive/`:\n\n- `100-Other-x.md`\n- `200-Other-y.md`\n\n## Reference\n\nmore stuff\n';
  assert.equal(boundArchiveRegion(region, 0), region.slice(0, region.indexOf('## Reference')));
});

test('boundArchiveRegion: no interior heading at all — returns the region unchanged', () => {
  const region = 'Moved to `docs/superpowers/plans/archive/`:\n\n- `100-Other-x.md`\n';
  assert.equal(boundArchiveRegion(region, 0), region);
});

// The live fence hazard (plan 2052 R1), transplanted into the archive-narrative shape:
// a stray fenced block whose interior "# comment" line must not be misread as an H1
// terminator (dependencies.md carries exactly this shape in its own ## Dependencies
// section — see build-index-lib.test.mjs for the primitive-level version of this case).
test('boundArchiveRegion: a "#"-line inside a fence does not terminate the region early', () => {
  const region =
    'Moved to `docs/superpowers/plans/archive/`:\n\n- `100-Other-x.md`\n\n```notes\n# not a heading\n```\n\n## Reference\n\nmore\n';
  assert.equal(boundArchiveRegion(region, 0), region.slice(0, region.indexOf('## Reference')));
});

// The pre-slicing bug this signature exists to prevent (review finding, plan 2052): a
// fence opened BEFORE the intro paragraph (inside the generated Plans-bullet region) and
// closed AFTER it, inside the archive narrative itself. Passing a pre-sliced substring
// starting at the intro paragraph would never see the fence open, then misread its close
// delimiter as re-opening a fence — silently swallowing the real "## Reference" boundary.
test('boundArchiveRegion: a fence opened BEFORE fromIndex and closed after it is tracked correctly', () => {
  const afterPlansEnd =
    '```stray\nMoved to `docs/superpowers/plans/archive/`:\n\n- `100-Other-x.md`\n```\n\n## Reference\n\nmore\n';
  const fromIndex = afterPlansEnd.indexOf('Moved to');
  // The fence is still open at fromIndex, so the intro line + bullet are fenced content —
  // the boundary must land on the REAL "## Reference", not misfire on the closing "```".
  assert.equal(
    boundArchiveRegion(afterPlansEnd, fromIndex),
    afterPlansEnd.slice(fromIndex, afterPlansEnd.indexOf('## Reference')),
  );
});

// --- push telemetry (plan 1731) -----------------------------------------------
// makeInheritedDriftChecker builds the SAME memoized, telemetry-marking lazy wrapper
// main() uses over inheritedDrift() — pinned here as a pure unit test (injectable
// computeFn/env) so the "mark 'index' exactly once, at the point of consulting
// attribution, regardless of outcome" contract doesn't need an end-to-end git-repo
// drive of main() (which shells out to build-index --check + real git).

import { makeInheritedDriftChecker } from './lint-plan-index.mjs';

test('plan 1731: makeInheritedDriftChecker marks the "index" hit exactly once despite repeated (memoized) calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-index-telem-'));
  const hitsFile = join(dir, 'hits.txt');
  try {
    const check = makeInheritedDriftChecker(() => true, {
      COORD_PUSH_TELEMETRY_HITS_FILE: hitsFile,
    });
    assert.equal(check(), true);
    assert.equal(check(), true);
    assert.equal(check(), true);
    assert.equal(readFileSync(hitsFile, 'utf8'), 'index\n', 'exactly one marker line, not three');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 1731: makeInheritedDriftChecker marks the hit even when the outcome resolves STRICT (false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-index-telem-'));
  const hitsFile = join(dir, 'hits.txt');
  try {
    const check = makeInheritedDriftChecker(() => false, {
      COORD_PUSH_TELEMETRY_HITS_FILE: hitsFile,
    });
    assert.equal(check(), false);
    assert.equal(
      readFileSync(hitsFile, 'utf8'),
      'index\n',
      'a strict (non-inherited) outcome is still a "hit" — attribution was consulted',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plan 1731: makeInheritedDriftChecker is a complete no-op on telemetry when the env var is absent', () => {
  const check = makeInheritedDriftChecker(() => true, {});
  assert.doesNotThrow(() => check());
  assert.equal(check(), true, 'the underlying memoized computation is unaffected');
});

// plan 2034 (R4a): waiting-grill/ admits BOTH stages — a plan can be parked for
// grilling before spec-pass (stub) or after (specced, when execution surfaced new
// operator questions). The stage/folder invariant is pending-approval-scoped by
// construction (the early `continue`), so neither may ever flag; these pins keep a
// future widening of the check from silently outlawing one of the two.
test('findStageFolderViolations: a specced plan in waiting-grill/ never flags (plan 2034 R4a)', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/waiting-grill/510-Other-g.md',
      content: '---\nstage: specced\n---\n\n# G\n\n## Grill questions\n\n1. Q?\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

test('findStageFolderViolations: a stub plan in waiting-grill/ never flags (plan 2034 R4a)', () => {
  const entries = [
    {
      path: 'docs/superpowers/plans/waiting-grill/511-Other-h.md',
      content: '---\nstage: stub\n---\n\n# H\n\n## Grill questions\n\n1. Q?\n',
    },
  ];
  assert.deepEqual(findStageFolderViolations(entries), []);
});

// --- checkIndexStale (plan 2099 — self-diagnosing a stale worktree checkout) --------
// The full attribution matrix (master/HEAD/rev-parse-fail/etc.) is pinned once in
// drift-attribution-lib.test.mjs's checkWorktreeCoordDocStale suite; these tests confirm
// THIS gate's wrapper reads its OWN worktree copy of docs/INDEX.md off disk (unlike
// lint-board.mjs's checkBoardStale, which takes the already-read content as a param —
// neither of lint-plan-index.mjs's two call sites already holds the raw text in hand)
// and diffs it against origin/master's copy through the same fakeExec seam.

function withIndexFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-index-stale-'));
  try {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'INDEX.md'), content);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('checkIndexStale: worktree docs/INDEX.md differs from origin/master → stale', () => {
  withIndexFile('stale local INDEX\n', (dir) => {
    const _exec = fakeExec({
      'rev-parse': 'worktree-2099-x\n',
      show: 'fresh master INDEX\n',
      'rev-list': '5\n',
    });
    const result = checkIndexStale({ repoRoot: dir, _exec });
    assert.deepEqual(result, { stale: true, commitsBehind: 5 });
  });
});

test('checkIndexStale: worktree docs/INDEX.md matches origin/master → not stale', () => {
  withIndexFile('same content\n', (dir) => {
    const _exec = fakeExec({
      'rev-parse': 'worktree-2099-x\n',
      show: 'same content\n',
      'rev-list': '0\n',
    });
    const result = checkIndexStale({ repoRoot: dir, _exec });
    assert.deepEqual(result, { stale: false, commitsBehind: null });
  });
});

test('checkIndexStale: master branch never diagnosed as stale', () => {
  withIndexFile('anything\n', (dir) => {
    const _exec = fakeExec({ 'rev-parse': 'master\n' });
    const result = checkIndexStale({ repoRoot: dir, _exec });
    assert.deepEqual(result, { stale: false, commitsBehind: null });
  });
});

test('checkIndexStale: missing docs/INDEX.md on disk → not stale, fails safe (no crash)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lint-index-stale-missing-'));
  try {
    const _exec = fakeExec({});
    const result = checkIndexStale({ repoRoot: dir, _exec });
    assert.deepEqual(result, { stale: false, commitsBehind: null });
    assert.equal(_exec.calls.length, 0, 'never shells out once the local read already failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── plan 4237 T4: the same-id invariant ──────────────────────────────────────────────────────

test('plan 4237 T4: two plan files sharing an id are flagged; distinct ids, non-plan names and a 4-digit prefix are not', () => {
  const P = 'docs/superpowers/plans';
  assert.equal(
    findDuplicateIdViolations([`${P}/ready/900-Infra-a.md`, `${P}/archive/900-DQ-b.md`], {
      waivedPaths: [],
    }).length,
    1,
  );
  assert.deepEqual(
    findDuplicateIdViolations(
      [
        `${P}/ready/900-Infra-a.md`,
        `${P}/ready/9000-Infra-b.md`, // a longer id sharing the prefix is a different id
        `${P}/archive/900-addendum-notes.md`, // not plan-shaped (lowercase tag)
        `${P}/archive/2026-05-17-legacy.md`, // dated legacy name, claims no id
      ],
      { waivedPaths: [] },
    ),
    [],
  );
});

test('plan 4237 T4: the grandfathered 4232 pair passes, but a THIRD 4232 file is still a duplicate', () => {
  const P = 'docs/superpowers/plans';
  const pair = [
    `${P}/archive/4232-Pipe-stage6-shared-service-tag-meaning.md`,
    `${P}/waiting-operator/4232-FABLE-Coord-cloud-drains-as-cloud-sessions-spend-promo-credit.md`,
  ];
  assert.deepEqual(findDuplicateIdViolations(pair), []);
  const three = findDuplicateIdViolations([...pair, `${P}/ready/4232-Infra-new.md`]);
  assert.equal(three.length, 1);
  assert.match(three[0], /plan id 4232 is carried by 2 files/);
  assert.ok(GRANDFATHERED_DUPLICATE_ID_PATHS.includes(pair[0]));
  // review 98b87e/d933f5: a COPY of the waived basename in another folder is not waived
  const copy = findDuplicateIdViolations([
    ...pair,
    `${P}/ready/4232-Pipe-stage6-shared-service-tag-meaning.md`,
  ]);
  assert.equal(copy.length, 1, 'the waiver covers the archived path only');
});

test('plan 4237 T4: the real tracked plan tree has no unwaived duplicate id', () => {
  assert.equal(checkDuplicateIdInvariant(), 0);
});
