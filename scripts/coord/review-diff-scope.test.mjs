// scripts/coord/review-diff-scope.test.mjs — name-paired tests for the genuinely new module
// scripts/coord/review-diff-scope.mjs (plan 3093). That name-pair IS the one-line justification
// the repo requires for a new `scripts/*.test.mjs` file; there is no existing test file
// whose module owns the review diff-scope rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import { cleanGitEnv } from '../test-helpers/clean-git-env.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';
import {
  CORE_REVIEW_DIFF_EXCLUDES,
  MANDATORY_REVIEW_SOURCE_ROOTS,
  reviewDiffExcludesFor,
  excludePathspecs,
  scopedPathspecs,
  scopedDiffArgs,
  scopedDiffCommand,
  isExcludedPath,
  partitionPaths,
  excludedNote,
  excludedCountFor,
  materializeScopedDiff,
  main,
} from './review-diff-scope.mjs';

const mkdtempSync = trackedMkdtempSync();

// plan 4071 T2 / plan 3958: vetapp's own row (coord.config.json's `reviewDiffExcludes`), merged
// with the core list. A fixed, portable literal matching today's real vetapp value — rather than
// a live read of coord.config.json: the public coord-kit's own config carries no
// reviewDiffExcludes at all, so a self-resolved read degrades to CORE_REVIEW_DIFF_EXCLUDES alone
// and every test below that exercises the vetapp-scoped (backend/data, backend/src/data/seed)
// behaviour goes stale.
const VETAPP_EXCLUDES = reviewDiffExcludesFor(['backend/data', 'backend/src/data/seed']);

// A seed shard path, built SEGMENT-WISE on purpose. Spelled as one quoted literal it
// would trip `scripts/assert-seed-io-seam.mjs`, which cannot tell a throwaway fixture
// path from a real direct seed open — and it is right not to try. The guard's own header
// names segment-wise builds as the sanctioned form, so this stays a fixture without
// weakening the gate or growing its grandfather list (which may only shrink).
const SEED_SHARD = ['backend', 'src', 'data', 'seed', 'clinics', 'SE', 'clinic-001.json'].join('/');

// ─── The core list + the merge ──────────────────────────────────────────────
test('CORE_REVIEW_DIFF_EXCLUDES: exactly the three project-agnostic data-artifact roots', () => {
  assert.deepEqual(CORE_REVIEW_DIFF_EXCLUDES, ['output', 'input', 'pnpm-lock.yaml']);
});

test('reviewDiffExcludesFor: merges core + config, core first, deduplicated', () => {
  assert.deepEqual(reviewDiffExcludesFor([]), CORE_REVIEW_DIFF_EXCLUDES);
  assert.deepEqual(reviewDiffExcludesFor(['backend/data']), [
    ...CORE_REVIEW_DIFF_EXCLUDES,
    'backend/data',
  ]);
  // A config entry that duplicates a core one must not appear twice.
  assert.deepEqual(reviewDiffExcludesFor(['output', 'backend/data']), [
    ...CORE_REVIEW_DIFF_EXCLUDES,
    'backend/data',
  ]);
});

// plan 4071 review round 1 (finding e26400): a configured reviewDiffExcludes entry can never
// hide a mandatory review source root wholesale -- see the header comment on
// MANDATORY_REVIEW_SOURCE_ROOTS in review-diff-scope.mjs for why this must be a loud refusal
// rather than a silent drop.
test('reviewDiffExcludesFor: an entry equal to, or an ancestor of, a mandatory review root is REFUSED', () => {
  assert.throws(() => reviewDiffExcludesFor(['scripts']), /mandatory review root "scripts"/);
  assert.throws(
    () => reviewDiffExcludesFor(['backend/src']),
    /mandatory review root "backend\/src"/,
  );
  // An ancestor of the root (not the root itself) is refused too -- it would hide the whole
  // root beneath it just as completely.
  assert.throws(() => reviewDiffExcludesFor(['backend']), /mandatory review root "backend\/src"/);
  assert.throws(
    () => reviewDiffExcludesFor(['frontend/src']),
    /mandatory review root "frontend\/src"/,
  );
  assert.throws(() => reviewDiffExcludesFor(['shared/src']), /mandatory review root "shared\/src"/);
  // A trailing slash or a backslash is refused as a non-literal entry BEFORE the root check
  // ever runs -- round 3 no longer normalizes a decorated spelling to compare it against the
  // root, it refuses the decoration outright (see the decorated / glob-magic tests below).
  assert.throws(() => reviewDiffExcludesFor(['scripts/']), /decorated/);
  assert.throws(() => reviewDiffExcludesFor(['backend\\src']), /glob or pathspec-magic/);
});

test('reviewDiffExcludesFor: an entry NESTED inside a mandatory review root is accepted -- it narrows the hidden set, it does not cover the root', () => {
  assert.deepEqual(reviewDiffExcludesFor(['backend/src/data/seed']), [
    ...CORE_REVIEW_DIFF_EXCLUDES,
    'backend/src/data/seed',
  ]);
  // The vetapp row (`backend/data`, `backend/src/data/seed`) reproduces exactly, unchanged.
  assert.deepEqual(reviewDiffExcludesFor(['backend/data', 'backend/src/data/seed']), [
    ...CORE_REVIEW_DIFF_EXCLUDES,
    'backend/data',
    'backend/src/data/seed',
  ]);
});

// plan 4071 review round 3 (nine findings: 356638, 08b412, 63eba4, ed6453, ca1d60, fa5d8b,
// df853d, cd8623, ac6a9e): round 2's normalizer recognized glob spellings of a protected
// root, but accepting globs AT ALL was the defect -- a mid-segment wildcard passes the root
// check but git's pathspec expands it further, and even a harmless-looking accepted glob
// reaches git as glob-aware while `isExcludedPath` matches literally, so the two can silently
// disagree about what was excluded. There is no normalizer any more: every one of these is
// refused outright, whether or not it would have hit a protected root.
test('reviewDiffExcludesFor: any glob or pathspec-magic entry is refused, not normalized', () => {
  for (const spelling of [
    'scripts/**',
    'scripts/*',
    '*/src/**',
    'scr*pts',
    'backend/s*rc',
    // A glob spelling of a NESTED (non-root) path is refused too now -- round 2 accepted
    // this one; round 3 does not, because accepting the glob at all is the defect.
    'backend/src/data/seed/**',
    ':(glob)x',
  ]) {
    assert.throws(
      () => reviewDiffExcludesFor([spelling]),
      /glob or pathspec-magic/,
      `"${spelling}" must be refused as a glob/pathspec-magic entry`,
    );
  }
});

test('reviewDiffExcludesFor: a decorated (non-literal) entry is refused, not normalized', () => {
  for (const spelling of ['./backend/data', '/backend/data', 'backend/data/']) {
    assert.throws(
      () => reviewDiffExcludesFor([spelling]),
      /decorated/,
      `"${spelling}" must be refused as decorated`,
    );
  }
});

test('reviewDiffExcludesFor: a ".." path segment is refused', () => {
  assert.throws(() => reviewDiffExcludesFor(['a/../scripts']), /"\.\." path segment/);
});

test('reviewDiffExcludesFor: an empty string entry is refused', () => {
  assert.throws(() => reviewDiffExcludesFor(['']), /empty string/);
});

// The equal-or-ancestor guard still applies to the LITERAL form of a protected root -- these
// entries pass the literal check (no glob, no decoration) and are refused by the root check.
test('reviewDiffExcludesFor: a literal entry equal to, or an ancestor of, a mandatory review root is still refused', () => {
  assert.throws(() => reviewDiffExcludesFor(['scripts']), /mandatory review root "scripts"/);
  assert.throws(
    () => reviewDiffExcludesFor(['backend/src']),
    /mandatory review root "backend\/src"/,
  );
  assert.throws(() => reviewDiffExcludesFor(['backend']), /mandatory review root "backend\/src"/);
});

// Round-3's own regression guard: the JS partition (`isExcludedPath`) and git's pathspec
// must agree by construction now that every exclude entry is literal -- pinned against a
// REAL git diff on a fixture repo, not just against each other's logic.
test('reviewDiffExcludesFor + isExcludedPath: the JS partition and a real git pathspec diff agree exactly, for excludes that used to slip past the old glob normalizer', () => {
  const dir = initRepo();
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'scripts/data/nested.mjs', 'a\n');
  write(dir, 'backend/src/app.ts', 'a\n');
  write(dir, 'backend/src/data/seed/clinic-001.json', 'a\n');
  write(dir, 'backend/data/big.json', 'a\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'scripts/data/nested.mjs', 'b\n');
  write(dir, 'backend/src/app.ts', 'b\n');
  write(dir, 'backend/src/data/seed/clinic-001.json', 'b\n');
  write(dir, 'backend/data/big.json', 'b\n');
  const head = commit(dir, 'head');

  const excludes = reviewDiffExcludesFor(['backend/data', 'backend/src/data/seed']);
  const allFiles = execFileSync('git', ['-C', dir, 'diff', '--name-only', base, head], {
    env: cleanGitEnv(),
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const { included: jsIncluded } = partitionPaths(allFiles, excludes);

  const gitIncluded = execFileSync(
    'git',
    ['-C', dir, 'diff', '--name-only', base, head, '--', ...scopedPathspecs(excludes)],
    { env: cleanGitEnv(), encoding: 'utf8' },
  )
    .split(/\r?\n/)
    .filter(Boolean);

  assert.deepEqual(jsIncluded.sort(), gitIncluded.sort());
  assert.deepEqual(jsIncluded.sort(), [
    'backend/src/app.ts',
    'scripts/data/nested.mjs',
    'scripts/keep.mjs',
  ]);
});

test('MANDATORY_REVIEW_SOURCE_ROOTS: the four CLAUDE.md-mandated review roots, frozen', () => {
  assert.deepEqual(MANDATORY_REVIEW_SOURCE_ROOTS, [
    'frontend/src',
    'backend/src',
    'shared/src',
    'scripts',
  ]);
  assert.ok(Object.isFrozen(MANDATORY_REVIEW_SOURCE_ROOTS));
});

// ─── Pathspec assembly ──────────────────────────────────────────────────────
test('excludePathspecs: every entry gets git top+exclude magic', () => {
  assert.deepEqual(excludePathspecs(VETAPP_EXCLUDES), [
    ':(top,exclude)output',
    ':(top,exclude)input',
    ':(top,exclude)pnpm-lock.yaml',
    ':(top,exclude)backend/data',
    ':(top,exclude)backend/src/data/seed',
  ]);
});

// The pathspec tail must be EXCLUDE-ONLY. A leading `:/` ("match everything") would be a
// no-op for the default whole-repo diff but would silently WIDEN an explicit-target diff
// the sonnet-review lane had already narrowed to one file — the round-1 review's
// highest-count finding. Pinning the absence is the regression guard.
test('scopedPathspecs: exclude-only, never a `:/` match-everything pathspec', () => {
  const specs = scopedPathspecs(VETAPP_EXCLUDES);
  assert.deepEqual(specs, excludePathspecs(VETAPP_EXCLUDES));
  assert.ok(!specs.includes(':/'), 'a `:/` here would widen an already-narrowed target');
});

test('scopedDiffArgs: options precede the commits, and `--` precedes the pathspecs', () => {
  const args = scopedDiffArgs(['base', 'head'], ['--name-only'], VETAPP_EXCLUDES);
  assert.deepEqual(args.slice(0, 4), ['diff', '--name-only', 'base', 'head']);
  // Without the separator git would try to resolve a leading `:` pathspec as a revision.
  assert.equal(args[4], '--');
  assert.deepEqual(args.slice(5), scopedPathspecs(VETAPP_EXCLUDES));
});

test('scopedPathspecs: appending to a narrowed pathspec keeps it narrowed', () => {
  const dir = initRepo();
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'frontend/src/app.tsx', 'a\n');
  write(dir, 'backend/data/big.json', '{}\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'frontend/src/app.tsx', 'b\n');
  write(dir, 'backend/data/big.json', '{"x":1}\n');
  const head = commit(dir, 'head');

  // Exactly what the sonnet-review explicit-target branch now builds: an existing narrow
  // pathspec, with the exclusion appended to the SAME list.
  const out = execFileSync(
    'git',
    [
      '-C',
      dir,
      'diff',
      '--name-only',
      base,
      head,
      '--',
      'scripts',
      ...scopedPathspecs(VETAPP_EXCLUDES),
    ],
    { env: cleanGitEnv(), encoding: 'utf8' },
  );
  assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['scripts/keep.mjs']);
});

test('scopedDiffArgs: a single range string is passed through unsplit', () => {
  const args = scopedDiffArgs(['origin/master...HEAD']);
  assert.deepEqual(args.slice(0, 3), ['diff', 'origin/master...HEAD', '--']);
});

test('scopedDiffCommand: quotes the pathspecs and leaves refs bare', () => {
  const cmd = scopedDiffCommand(['base', 'head'], [], VETAPP_EXCLUDES);
  assert.ok(cmd.startsWith('git diff base head -- '), cmd);
  // The pathspecs carry `:`, `(`, `)` and `!` — a shell would mangle them unquoted, and
  // this string is the fallback command a downstream agent is told to paste and run.
  assert.ok(cmd.includes(`':(top,exclude)backend/data'`), cmd);
  assert.ok(!cmd.includes(`':/'`), cmd);
});

// ─── Path membership ────────────────────────────────────────────────────────
test('isExcludedPath: matches whole path components, never bare prefixes', () => {
  assert.equal(isExcludedPath('backend/data/regression-study-2141/x.json', VETAPP_EXCLUDES), true);
  assert.equal(isExcludedPath('backend/data', VETAPP_EXCLUDES), true);
  // The trap this rule exists for: a sibling directory whose name STARTS with an
  // excluded one is reviewable source and must survive.
  assert.equal(isExcludedPath('backend/database/pool.ts', VETAPP_EXCLUDES), false);
  assert.equal(isExcludedPath('backend/data-loader.ts', VETAPP_EXCLUDES), false);
});

test('isExcludedPath: excludes are anchored at the repo root', () => {
  assert.equal(isExcludedPath('pnpm-lock.yaml', VETAPP_EXCLUDES), true);
  assert.equal(isExcludedPath('output/reports/a.md', VETAPP_EXCLUDES), true);
  // Same basename, different subtree — `top` magic means these are NOT excluded.
  assert.equal(isExcludedPath('frontend/pnpm-lock.yaml', VETAPP_EXCLUDES), false);
  assert.equal(isExcludedPath('scripts/output/x.mjs', VETAPP_EXCLUDES), false);
});

test('isExcludedPath: app source and docs stay in scope', () => {
  for (const p of [
    'scripts/gpt-review.mjs',
    'backend/src/routes/slots.ts',
    'frontend/src/app/page.tsx',
    'shared/src/schemas.ts',
    'docs/runbooks/review-calibration.md',
    'backend/src/data/chains.ts',
  ]) {
    assert.equal(isExcludedPath(p, VETAPP_EXCLUDES), false, p);
  }
});

test('isExcludedPath: normalizes backslashes and a leading ./', () => {
  assert.equal(isExcludedPath('backend\\data\\x.json', VETAPP_EXCLUDES), true);
  assert.equal(isExcludedPath('./output/reports/a.md', VETAPP_EXCLUDES), true);
});

test('isExcludedPath: defaults to the CORE list when no project excludes are given', () => {
  assert.equal(isExcludedPath('output/reports/a.md'), true);
  assert.equal(isExcludedPath('backend/data/x.json'), false); // not core — needs the config row
});

test('partitionPaths: splits a mixed list, preserving order within each side', () => {
  const { included, excluded } = partitionPaths(
    ['scripts/a.mjs', 'backend/data/b.json', 'backend/src/c.ts', 'output/reports/d.md', SEED_SHARD],
    VETAPP_EXCLUDES,
  );
  assert.deepEqual(included, ['scripts/a.mjs', 'backend/src/c.ts']);
  assert.deepEqual(excluded, ['backend/data/b.json', 'output/reports/d.md', SEED_SHARD]);
});

// ─── The no-silent-truncation sentence ──────────────────────────────────────
test('excludedNote: empty when nothing was dropped', () => {
  assert.equal(excludedNote(0, VETAPP_EXCLUDES), '');
  assert.equal(excludedNote(undefined, VETAPP_EXCLUDES), '');
});

test('excludedNote: names the count and the excluded roots', () => {
  const note = excludedNote(612, VETAPP_EXCLUDES);
  assert.ok(note.includes('612'), note);
  for (const ex of VETAPP_EXCLUDES) assert.ok(note.includes(ex), `${ex} missing: ${note}`);
});

// Round-2 review, 6 findings across 5 angles: under --include-worktree an excluded file
// may be an uncommitted edit, so calling every exclusion "committed" gives the reviewer
// false provenance about what the range actually did.
test('excludedNote: never claims the excluded files were committed', () => {
  assert.ok(!/committed/i.test(excludedNote(3, VETAPP_EXCLUDES)), excludedNote(3, VETAPP_EXCLUDES));
});

test('excludedCountFor: counts what the exclusion drops from a caller-built diff command', () => {
  const dir = initRepo();
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'backend/data/one.json', '{}\n');
  write(dir, 'backend/data/two.json', '{}\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'backend/data/one.json', '{"x":1}\n');
  write(dir, 'backend/data/two.json', '{"x":1}\n');
  const head = commit(dir, 'head');

  assert.equal(excludedCountFor({ targets: [base, head], cwd: dir, excludes: VETAPP_EXCLUDES }), 2);
  // Honors the caller's own narrowing: a command already scoped to scripts/ drops nothing.
  assert.equal(
    excludedCountFor({
      targets: [base, head],
      pathspecs: ['scripts'],
      cwd: dir,
      excludes: VETAPP_EXCLUDES,
    }),
    0,
  );
});

test('CLI note-for: emits the finished sentence, empty when nothing was dropped', () => {
  const dir = initRepo();
  // This throwaway repo carries no coord.config.json of its own, so the CLI resolves the
  // CORE list only — the changed data file must be under a CORE-excluded root ('output/'),
  // not a config-only addition ('backend/data'), or the CLI would (correctly) not drop it.
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'output/reports/one.md', 'x\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'output/reports/one.md', 'y\n');
  const head = commit(dir, 'head');

  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    assert.equal(main(['note-for', base, head], dir), 0);
    assert.equal(main(['note-for', base, head, '--', 'scripts'], dir), 0);
  } finally {
    console.log = orig;
  }
  assert.equal(lines[0], excludedNote(1, CORE_REVIEW_DIFF_EXCLUDES));
  assert.equal(lines[1], '', 'a caller-narrowed command that drops nothing prints nothing');
});

test('CLI note: prints the shared sentence so the explicit-target lane can emit it too', () => {
  const dir = initRepo();
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    assert.equal(main(['note', '7'], dir), 0);
  } finally {
    console.log = orig;
  }
  assert.equal(lines[0], excludedNote(7, CORE_REVIEW_DIFF_EXCLUDES));

  const errs = [];
  const origErr = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(main(['note'], dir), 2);
    assert.equal(main(['note', 'abc'], dir), 2);
    assert.equal(main(['note', '-1'], dir), 2);
  } finally {
    console.error = origErr;
  }
});

// ─── End-to-end against a real git repo ─────────────────────────────────────
function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'review-diff-scope-'));
  const env = cleanGitEnv();
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'base'], { env });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { env });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { env });
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { env });
  return dir;
}

function write(dir, rel, body) {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function commit(dir, message) {
  const env = cleanGitEnv();
  execFileSync('git', ['-C', dir, 'add', '-A'], { env });
  execFileSync('git', ['-C', dir, 'commit', '-qm', message], { env });
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim();
}

test('materializeScopedDiff: a range mixing app source with data artifacts yields only the source', () => {
  const dir = initRepo();
  write(dir, 'scripts/keep.mjs', 'export const a = 1;\n');
  write(dir, 'backend/data/big.json', '{"v":1}\n');
  write(dir, SEED_SHARD, '{"id":"clinic-001"}\n');
  const base = commit(dir, 'base');

  write(dir, 'scripts/keep.mjs', 'export const a = 2;\n');
  write(dir, 'backend/data/big.json', '{"v":2}\n');
  write(dir, SEED_SHARD, '{"id":"clinic-001","x":1}\n');
  write(dir, 'output/reports/report.md', '# report\n');
  write(dir, 'docs/runbooks/note.md', 'docs stay in scope\n');
  const head = commit(dir, 'head');

  const out = join(dir, '.scratch', 'diff.patch');
  const res = materializeScopedDiff({
    targets: [base, head],
    outPath: out,
    cwd: dir,
    excludes: VETAPP_EXCLUDES,
  });
  const patch = readFileSync(out, 'utf8');

  assert.ok(patch.includes('scripts/keep.mjs'), 'app source must be in the patch');
  assert.ok(patch.includes('docs/runbooks/note.md'), 'docs must stay in the patch');
  // The whole point: excluded hunks never exist in the artifact at any point, so a
  // reviewer's file read and the finder timeouts both see only reviewable bytes.
  assert.ok(!patch.includes('backend/data/big.json'), 'data artifact leaked into the patch');
  assert.ok(!patch.includes('output/reports/report.md'), 'output report leaked into the patch');
  assert.ok(!patch.includes('clinic-001.json'), 'seed row leaked into the patch');

  assert.deepEqual(res.files.sort(), ['docs/runbooks/note.md', 'scripts/keep.mjs']);
  assert.equal(res.excludedFiles, 3);
  assert.ok(res.bytes > 0);
  assert.ok(res.note.includes('3'), res.note);
  assert.ok(res.diffCommand.startsWith(`git diff ${base} ${head} -- `), res.diffCommand);
});

test('materializeScopedDiff: --include-worktree appends uncommitted changes, still scoped', () => {
  const dir = initRepo();
  write(dir, 'scripts/keep.mjs', 'export const a = 1;\n');
  // Untouched by the committed range — its ONLY change is uncommitted, so it exists in the
  // patch solely because of --include-worktree. That is the case the round-1 finding was
  // about: a file the list omitted while the patch carried its hunks.
  write(dir, 'scripts/worktree-only.mjs', 'export const b = 1;\n');
  write(dir, 'backend/data/big.json', '{"v":1}\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'export const a = 2;\n');
  const head = commit(dir, 'head');

  // Uncommitted on both sides of the rule.
  write(dir, 'scripts/keep.mjs', 'export const a = 3;\n');
  write(dir, 'scripts/worktree-only.mjs', 'export const b = 2;\n');
  write(dir, 'backend/data/big.json', '{"v":99}\n');

  const out = join(dir, '.scratch', 'diff.patch');
  const res = materializeScopedDiff({
    targets: [base, head],
    outPath: out,
    includeWorktree: true,
    cwd: dir,
    excludes: VETAPP_EXCLUDES,
  });
  const patch = readFileSync(out, 'utf8');
  assert.ok(patch.includes('export const a = 3;'), 'uncommitted source change must be appended');
  assert.ok(!patch.includes('"v":99'), 'uncommitted data change must stay excluded');
  // Round-1 review, 7 findings across 4 angles: the file LIST must cover the same commits
  // the PATCH does. A file present as hunks but absent from the list would show a finder a
  // diff for a file its own scope block says did not change.
  assert.deepEqual(res.files.sort(), ['scripts/keep.mjs', 'scripts/worktree-only.mjs']);
  assert.equal(res.excludedFiles, 1, 'the uncommitted data file counts as excluded too');
  // The fallback command must reproduce EVERYTHING the artifact covers, or a downstream
  // agent that falls back reviews strictly less than the artifact did.
  assert.ok(res.diffCommand.includes(' && git diff HEAD -- '), res.diffCommand);
});

test('materializeScopedDiff: a data-only range produces an empty patch and zero reviewable files', () => {
  const dir = initRepo();
  write(dir, 'backend/data/big.json', '{"v":1}\n');
  const base = commit(dir, 'base');
  write(dir, 'backend/data/big.json', '{"v":2}\n');
  const head = commit(dir, 'head');

  const res = materializeScopedDiff({
    targets: [base, head],
    outPath: join(dir, '.scratch', 'diff.patch'),
    cwd: dir,
    excludes: VETAPP_EXCLUDES,
  });
  assert.deepEqual(res.files, []);
  assert.equal(res.excludedFiles, 1);
  assert.equal(res.bytes, 0);
});

// ─── CLI surface (the sonnet-review lane's ONLY access to the list) ──────────
test('CLI pathspecs: prints the shell-quoted suffix', () => {
  const dir = initRepo();
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    assert.equal(main(['pathspecs'], dir), 0);
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`':(top,exclude)output'`), lines[0]);
});

test('CLI materialize: writes the patch and prints one JSON line', () => {
  const dir = initRepo();
  // No coord.config.json in this throwaway repo ⇒ the CLI resolves the CORE list only,
  // which does not touch `backend/data` — reflects the CLI's own "cwd is the repo, read
  // its own config" contract rather than reusing this checkout's coord.config.json. Use a
  // CORE-excluded root ('output/') to exercise the drop.
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'output/reports/big.md', 'x\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'output/reports/big.md', 'y\n');
  const head = commit(dir, 'head');

  const out = join(dir, '.scratch', 'cli.patch');
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    assert.equal(main(['materialize', '--out', out, base, head], dir), 0);
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  const res = JSON.parse(lines[0]);
  assert.deepEqual(res.files, ['scripts/keep.mjs']);
  assert.equal(res.excludedFiles, 1);
  assert.ok(res.bytes > 0);
  assert.ok(existsSync(out));
});

test('CLI materialize: a repo with its own coord.config.json picks up its reviewDiffExcludes row', () => {
  const dir = initRepo();
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ reviewDiffExcludes: ['backend/data'] }),
  );
  write(dir, 'scripts/keep.mjs', 'a\n');
  write(dir, 'backend/data/big.json', '{}\n');
  const base = commit(dir, 'base');
  write(dir, 'scripts/keep.mjs', 'b\n');
  write(dir, 'backend/data/big.json', '{"x":1}\n');
  const head = commit(dir, 'head');

  const out = join(dir, '.scratch', 'cli.patch');
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    assert.equal(main(['materialize', '--out', out, base, head], dir), 0);
  } finally {
    console.log = orig;
  }
  const res = JSON.parse(lines[0]);
  assert.deepEqual(res.files, ['scripts/keep.mjs']);
  assert.equal(res.excludedFiles, 1);
});

test('CLI: a missing subcommand or --out exits 2 rather than materializing nothing silently', () => {
  const dir = initRepo();
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    assert.equal(main([], dir), 2);
    assert.equal(main(['materialize', 'base', 'head'], dir), 2);
    assert.equal(main(['materialize', '--out', 'x.patch'], dir), 2);
  } finally {
    console.error = orig;
  }
  assert.equal(errs.length, 3);
});

// ─── Acceptance #3: ONE list, both lanes ────────────────────────────────────
// The exclude literal must exist in exactly one scripts/ module, gpt-review must import
// it, and the sonnet-review lane must reach it through the CLI. This is the drift guard —
// the same shape gpt-review.test.mjs uses for the byte-copied angle prompts, and the only
// thing standing between "one rule" and two lists that quietly disagree.
const WORKFLOW_PATH = fileURLToPath(
  new URL('../../.claude/workflows/sonnet-review.js', import.meta.url),
);
// The isolated-plan-repo scaffold copies only scripts/ — the workflow file is absent there.
const WORKFLOW_SRC = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : null;
const GPT_REVIEW_SRC = readFileSync(scriptFile('gpt-review.mjs', import.meta.dirname), 'utf8');

test('gpt-review.mjs imports the shared scope module instead of restating the list', () => {
  assert.ok(
    /from '[^']*review-diff-scope\.mjs'/.test(GPT_REVIEW_SRC),
    'gpt-review.mjs must import ./review-diff-scope.mjs',
  );
  for (const ex of VETAPP_EXCLUDES) {
    assert.ok(
      !GPT_REVIEW_SRC.includes(`':(top,exclude)${ex}`),
      `gpt-review.mjs restates the pathspec for ${ex} — the list lives in ONE module`,
    );
  }
});

test(
  'sonnet-review.js reaches the list through the CLI and never restates it',
  { skip: WORKFLOW_SRC === null ? 'sonnet-review.js absent (isolated scripts/ copy)' : false },
  () => {
    assert.ok(
      WORKFLOW_SRC.includes('review-diff-scope.mjs materialize'),
      'the sonnet-review scope prompt must materialize via the CLI (it cannot import — the Workflow runtime has no filesystem or Node API access)',
    );
    assert.ok(
      WORKFLOW_SRC.includes('review-diff-scope.mjs pathspecs'),
      'the explicit-target branch must append the exclusion via the CLI too',
    );
    assert.ok(
      WORKFLOW_SRC.includes('review-diff-scope.mjs note-for'),
      'the explicit-target branch must emit excludedNote via the CLI, or a data-only ' +
        'target reaches the empty-scope guard indistinguishable from an unchanged one',
    );
    // Round-3 review (2 PLAUSIBLE): the count must NOT be prompt-side arithmetic. An
    // unspecified subtraction order with no test silently omits the note on a wrong sign.
    assert.ok(
      /Do not compute this count yourself/.test(WORKFLOW_SRC),
      'the exclusion count must come from the module, not from agent arithmetic',
    );
    // Round-3 review (1 CONFIRMED): when the target NAMES an excluded path the agent takes
    // the opt-out and the hunks are PRESENT — emitting the note anyway would tell finders
    // not to report on exactly what the user asked them to review.
    assert.ok(
      /ONLY IF you appended the exclusion above/.test(WORKFLOW_SRC),
      'the note must be conditional on the exclusion actually having been appended',
    );
    // Round-3 review (3 CONFIRMED, mirroring the round-2 default-path defect on the
    // explicit-target branch): a data-only target legitimately yields an EMPTY diff.
    assert.ok(
      /an EMPTY result is VALID/.test(WORKFLOW_SRC),
      'the explicit-target branch must accept an empty diff when excludedNote is set',
    );
    // Round-3 review (2 CONFIRMED): under --include-worktree an exclusion may be an
    // uncommitted edit, so no prompt sentence may call the excluded set "committed".
    assert.ok(
      !/excludes committed data artifacts/.test(WORKFLOW_SRC),
      'the scope prompt must not claim every excluded artifact was committed',
    );
    // Round-2 review, 3 findings: a bare bytes>0 gate rejects the one case this plan is
    // FOR — a data-only range materializes an empty patch on purpose — and the fallback it
    // triggers rebuilds an UNSCOPED diff, reviewing the very artifacts we excluded.
    assert.ok(
      /bytes == 0 WITH excludedFiles > 0 is also VALID/.test(WORKFLOW_SRC),
      'the scope prompt must accept an empty patch when excludedFiles > 0',
    );
    // A pathspec literal here would be the second copy of the list — the exact drift the
    // module exists to prevent. Prose naming the paths in a comment is fine; a git
    // pathspec is not, because that is what would actually be USED.
    for (const ex of VETAPP_EXCLUDES) {
      assert.ok(
        !WORKFLOW_SRC.includes(`:(top,exclude)${ex}`),
        `sonnet-review.js restates the pathspec for ${ex} — it must call the CLI instead`,
      );
    }
  },
);
