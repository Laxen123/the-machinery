// scripts/assert-lock-free-git-polls.test.mjs — unit tests for the lock-free git-poll gate
// (plan 3974 T1b). Name-paired with assert-lock-free-git-polls.mjs — the name-pair of a genuinely
// new module (see that file's header for why this is not a case folded into
// assert-posix-path-assertions.mjs: disjoint corpus, disjoint violation shape).
//
// This file is the gate's ONE structural exemption (`isExempt` treats every `.test.mjs` as
// exempt): its fixtures are, by construction, the violating source text the gate exists to
// reject, so scanning it would be guaranteed self-indictment. Fixtures are `String.raw` templates
// so a `\` inside a fixture stays the literal character real source carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findViolations,
  findGitSpawnCalls,
  hasStatusOrDiffEvidence,
  inScope,
  isExempt,
  collectAddedByFile,
  violationsIntroduced,
  listCorpusFiles,
  SCOPE_PATHSPECS,
  MAIN_POLLER_FILES,
} from './assert-lock-free-git-polls.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const kinds = (text) => findViolations(text).map((v) => v.kind);

// ── scope ───────────────────────────────────────────────────────────────────

test('inScope: scripts/hooks/**/*.mjs and scripts/redgreen*.mjs, nothing else', () => {
  assert.equal(inScope('scripts/hooks/coord-write-guard-pretooluse.mjs'), true);
  assert.equal(inScope('scripts/hooks/lib/loader-common.mjs'), true);
  assert.equal(inScope('scripts/redgreen.mjs'), true);
  assert.equal(inScope('scripts/coord/redgreen-lib.mjs'), true);
  assert.equal(inScope('scripts/hooks/pre-push.sh'), false); // not .mjs
  assert.equal(inScope('scripts/coord/worktree-lock.mjs'), false); // not scoped in
  assert.equal(inScope('scripts/coord/land-lib.mjs'), false);
  assert.equal(inScope('scripts/done-worktree.mjs'), false);
  assert.equal(inScope('backend/scripts/foo.mjs'), false);
});

test('isExempt: every .test.mjs is exempt (fixtures legitimately quote violating text)', () => {
  assert.equal(isExempt('scripts/assert-lock-free-git-polls.test.mjs'), true);
  assert.equal(isExempt('scripts/redgreen-lib.test.mjs'), true);
  assert.equal(isExempt('scripts/redgreen.mjs'), false);
});

// ── shape (a) DIRECT: a literal argv naming status/diff ──────────────────────

test('direct — a literal git status spawn missing the flag is caught', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }).trim();
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-direct']);
});

test('direct — a literal git diff spawn missing the flag is caught', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8', cwd });
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-direct']);
});

test('direct — negative control: the flag present and ordered first is clean', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { encoding: 'utf8', cwd }).trim();
}
`;
  assert.deepEqual(findViolations(src), []);
});

test('direct — the flag present but AFTER the subcommand is still caught (git errors on that order)', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--no-optional-locks', '--porcelain'], { encoding: 'utf8', cwd });
}
`;
  const found = findViolations(src);
  assert.deepEqual(
    found.map((v) => v.kind),
    ['missing-flag-direct'],
  );
  assert.match(found[0].detail, /BEFORE the subcommand/);
});

test('direct — a literal argv with neither status nor diff (rev-parse/merge-base) is never flagged', () => {
  const src = String.raw`
function branch() {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}
function mergeBase() {
  execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/master']);
}
`;
  assert.deepEqual(findViolations(src), []);
});

// ── shape (b) PASSTHROUGH: dynamic argv, gated on same-file status/diff evidence ─

test('passthrough — a bare dynamic argv in a file WITH status/diff evidence is caught (the pre-fix redgreen.mjs shape)', () => {
  const src = String.raw`
function gitOut(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}
function gatherSignals() {
  const dirty = gitOut(['status', '--porcelain']).length > 0;
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-passthrough']);
});

test('passthrough — an array-literal-with-spread argv in a file WITH evidence is caught (the pre-fix coord-write-guard shape)', () => {
  const src = String.raw`
function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd });
}
function stagedPaths(cwd) {
  return git(['diff', '--cached', '--name-only'], cwd);
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-passthrough']);
});

test('passthrough — negative control: the wrapper prepends the flag unconditionally, clean', () => {
  const src = String.raw`
function gitOut(args, cwd) {
  return execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8', cwd }).trim();
}
function gatherSignals() {
  const dirty = gitOut(['status', '--porcelain']).length > 0;
}
`;
  assert.deepEqual(findViolations(src), []);
});

test('passthrough — negative control: NO same-file status/diff evidence is never flagged (the review-round-cap-guard.mjs shape)', () => {
  const src = String.raw`
export function runGit(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
`;
  assert.deepEqual(
    findViolations(src),
    [],
    'no status/diff literal anywhere in the file — not flagged',
  );
  assert.equal(hasStatusOrDiffEvidence(src), false);
});

test('hasStatusOrDiffEvidence: true the moment a status/diff literal appears anywhere', () => {
  assert.equal(hasStatusOrDiffEvidence("const x = ['status', 'foo'];"), true);
  assert.equal(hasStatusOrDiffEvidence('const x = ["diff"];'), true);
  assert.equal(hasStatusOrDiffEvidence("const x = ['rev-parse'];"), false);
});

// Plan 3974 review finding b78d7c: the evidence heuristic used to match ANY quoted `'status'`/
// `'diff'` string anywhere in the file, so an unrelated non-argv literal false-flagged a
// perfectly safe dynamic wrapper elsewhere in the same file. Tightened to require ARGUMENT
// POSITION — immediately preceded (modulo whitespace) by `[`, `(`, or `,`.
test('hasStatusOrDiffEvidence: a non-argument-position literal does NOT count as evidence', () => {
  const src = String.raw`
const label = 'status';
function runGit(repoRoot, args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}
`;
  assert.equal(hasStatusOrDiffEvidence(src), false);
  assert.deepEqual(
    findViolations(src),
    [],
    'no argument-position evidence in the file — the dynamic wrapper is not flagged',
  );
});

test("hasStatusOrDiffEvidence: an argument-position literal still counts (git(['status', …]))", () => {
  assert.equal(hasStatusOrDiffEvidence("git(['status', '--porcelain'])"), true);
  assert.equal(hasStatusOrDiffEvidence('gitOut(["diff", "--cached"])'), true);
});

// ── waivers ───────────────────────────────────────────────────────────────────

test('waiver — a marker WITH a reason on the violating line waives it', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }); // lock-free-poll-ok: this path always holds the write lock anyway
}
`;
  assert.deepEqual(findViolations(src), []);
});

test('waiver — a marker WITH a reason in the comment block directly above waives it', () => {
  const src = String.raw`
function poll(cwd) {
  // lock-free-poll-ok: this is a write path, not a poller — the lock is intentional here
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd });
}
`;
  assert.deepEqual(findViolations(src), []);
});

test('waiver — a BARE marker with no reason does NOT waive', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }); // lock-free-poll-ok:
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-direct']);
});

test('waiver — no marker at all does NOT waive', () => {
  const src = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd }); // TODO: fix later
}
`;
  assert.deepEqual(kinds(src), ['missing-flag-direct']);
});

// ── findGitSpawnCalls: literal vs dynamic classification ─────────────────────

test('findGitSpawnCalls: classifies an array literal vs a bare identifier correctly', () => {
  const src = String.raw`
execFileSync('git', ['status', '--porcelain'], opts);
execFileSync('git', args, opts);
`;
  const calls = findGitSpawnCalls(src);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].argKind, 'literal');
  assert.equal(calls[1].argKind, 'dynamic');
});

// ── diff scoping: only a NEWLY ADDED violation blocks ─────────────────────────

test('violationsIntroduced: a pre-existing violation the diff does not touch is not reported', () => {
  const fileText = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd });
}
function unrelated() {
  return 1 + 1;
}
`;
  // The diff added only the unrelated line — the violation's own line was never added.
  const addedTexts = new Set(['return 1 + 1;']);
  assert.deepEqual(violationsIntroduced(fileText, addedTexts), []);
});

test('violationsIntroduced: a violation whose line WAS added by the diff is reported', () => {
  const fileText = String.raw`
function poll(cwd) {
  return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd });
}
`;
  const addedTexts = new Set([
    `return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd });`,
  ]);
  const found = violationsIntroduced(fileText, addedTexts);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'missing-flag-direct');
});

// Plan 3974 review finding 12eeb0: matching only on the spawn's OWN lines missed a diff that
// added a brand-new CALLER to an existing, unchanged dynamic wrapper — the wrapper's flagless
// spawn line pre-exists (not part of the diff), but the diff is exactly what turned it from a
// latent, never-invoked wrapper into a live lock-taker.
test('violationsIntroduced: a new caller line to an EXISTING unchanged dynamic wrapper introduces the passthrough violation', () => {
  const fileText = String.raw`
function gitOut(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}
function gatherSignals() {
  const dirty = gitOut(['status', '--porcelain']).length > 0;
}
`;
  // Only the new caller line was added — the wrapper's own spawn line is pre-existing source.
  const addedTexts = new Set([`const dirty = gitOut(['status', '--porcelain']).length > 0;`]);
  const found = violationsIntroduced(fileText, addedTexts);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'missing-flag-passthrough');
});

// Plan 3974 review round 2 findings 634891/d197d5: prettier's one-element-per-line array
// formatting splits a new caller like `gitOut(['status', '--porcelain'])` across several lines, so
// the added line carrying `'status'` never has the opening `[` in the SAME (trimmed) line text —
// EVIDENCE_ARG_RX alone (tested per added line) missed this. The whole-file scan
// (hasStatusOrDiffEvidence) already handles it fine because `\s*` in EVIDENCE_ARG_RX spans the
// newline when tested against the FULL file text.
test('hasStatusOrDiffEvidence: a status literal still counts as evidence across a newline (multi-line array literal)', () => {
  const src = "gitOut([\n  'status',\n  '--porcelain',\n]);";
  assert.equal(hasStatusOrDiffEvidence(src), true);
});

test('violationsIntroduced: a multi-line new caller to an EXISTING unchanged dynamic wrapper introduces the passthrough violation', () => {
  const fileText = String.raw`
function gitOut(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}
function gatherSignals() {
  const dirty =
    gitOut([
      'status',
      '--porcelain',
    ]).length > 0;
}
`;
  // Only the new multi-line caller was added, one array element per line (prettier's shape) — the
  // wrapper's own spawn line is pre-existing source, and no single added line carries a `[`/`,`
  // immediately before the `'status'` literal.
  const addedTexts = new Set(['gitOut([', "'status',", "'--porcelain',", ']).length > 0;']);
  const found = violationsIntroduced(fileText, addedTexts);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'missing-flag-passthrough');
});

test('violationsIntroduced: an unrelated added line with no status/diff evidence does not introduce a pre-existing passthrough violation', () => {
  const fileText = String.raw`
function gitOut(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}
function gatherSignals() {
  const dirty = gitOut(['status', '--porcelain']).length > 0;
}
function unrelated() {
  return 1 + 1;
}
`;
  const addedTexts = new Set(['return 1 + 1;']);
  assert.deepEqual(violationsIntroduced(fileText, addedTexts), []);
});

test('collectAddedByFile: only in-scope, non-exempt files are collected', () => {
  const diff = [
    'diff --git a/scripts/hooks/coord-write-guard-pretooluse.mjs b/scripts/hooks/coord-write-guard-pretooluse.mjs',
    '--- a/scripts/hooks/coord-write-guard-pretooluse.mjs',
    '+++ b/scripts/hooks/coord-write-guard-pretooluse.mjs',
    '@@ -1,0 +1,1 @@',
    "+  execFileSync('git', ['status'], {});",
    'diff --git a/scripts/hooks/coord-write-guard-pretooluse.test.mjs b/scripts/hooks/coord-write-guard-pretooluse.test.mjs',
    '--- a/scripts/hooks/coord-write-guard-pretooluse.test.mjs',
    '+++ b/scripts/hooks/coord-write-guard-pretooluse.test.mjs',
    '@@ -1,0 +1,1 @@',
    "+  execFileSync('git', ['status'], {});",
    'diff --git a/scripts/coord/worktree-lock.mjs b/scripts/coord/worktree-lock.mjs',
    '--- a/scripts/coord/worktree-lock.mjs',
    '+++ b/scripts/coord/worktree-lock.mjs',
    '@@ -1,0 +1,1 @@',
    "+  execFileSync('git', ['status'], {});",
  ].join('\n');
  const byFile = collectAddedByFile(diff);
  assert.deepEqual([...byFile.keys()], ['scripts/hooks/coord-write-guard-pretooluse.mjs']);
});

test('SCOPE_PATHSPECS covers exactly the in-scope surfaces', () => {
  // scripts/coord/redgreen*.mjs joined the list when plan 3962 moved redgreen-lib.mjs into the
  // coord core. Listed explicitly rather than folded into a scripts/** glob: this rule judges
  // POLLERS, a named short list, and widening the pathspec would change what the gate means.
  // plan 4237 T2 added the three named MAIN pollers the same way, file by file.
  assert.deepEqual(SCOPE_PATHSPECS, [
    ':(glob)scripts/hooks/**/*.mjs',
    ':(glob)scripts/redgreen*.mjs',
    ':(glob)scripts/coord/redgreen*.mjs',
    'scripts/coord/pre-yield-guard.mjs',
    'scripts/coord/heal-main.mjs',
    'scripts/coord/index-sanity.mjs',
  ]);
});

// ── acceptance: the real shipped files pass clean ─────────────────────────────

test('acceptance — the real shipped coord-write-guard-pretooluse.mjs is clean', () => {
  const text = readFileSync(
    join(REPO_ROOT, 'scripts/hooks/coord-write-guard-pretooluse.mjs'),
    'utf8',
  );
  assert.deepEqual(findViolations(text), []);
});

test('acceptance — the real shipped review-round-cap-guard.mjs (an unrelated passthrough wrapper with no status/diff evidence) is clean', () => {
  const text = readFileSync(join(REPO_ROOT, 'scripts/hooks/review-round-cap-guard.mjs'), 'utf8');
  assert.deepEqual(findViolations(text), []);
});

// plan 3962: redgreen-lib.mjs moved to scripts/coord/, and inScope()/SCOPE_PATHSPECS were widened
// for it, but the `--all` corpus walker kept reading only the top-level scripts/ directory — a
// file `inScope()` accepted was invisible to the sweep that is supposed to read every in-scope
// file. This test walks the REAL tree independently of listCorpusFiles' own logic (never reusing
// its internal helpers) and asserts every file inScope() accepts is present in what the sweep
// reads, so the two can never silently drift apart again.
function walkRealTreeForInScopeFiles(rel) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
    // node_modules is the only directory this scope could ever descend into that isn't part of
    // the repo's own source (scripts/hooks and scripts/coord carry none today, but a bare walk
    // must not assume that stays true).
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walkRealTreeForInScopeFiles(`${rel}/${entry.name}`));
      continue;
    }
    const child = `${rel}/${entry.name}`;
    if (inScope(child) && !isExempt(child)) out.push(child);
  }
  return out;
}

test('listCorpusFiles: matches every file inScope() accepts in the real tree (plan 3962 regression)', () => {
  const expected = new Set(walkRealTreeForInScopeFiles('scripts'));
  const actual = new Set(listCorpusFiles());
  assert.deepEqual(actual, expected);
  // Not a vacuous pass: scripts/coord/redgreen-lib.mjs must actually be one of the files being
  // compared, or this test would trivially agree with itself on an empty set.
  assert.ok(expected.has('scripts/coord/redgreen-lib.mjs'));
});

// ── plan 4237 T2: shape (c), wrapper calls in the named MAIN pollers ─────────────────────────

test('plan 4237 T2: the named MAIN pollers are in scope, other coord modules are not', () => {
  for (const f of MAIN_POLLER_FILES) assert.equal(inScope(f), true, f);
  assert.equal(inScope('scripts/coord/coord-git.mjs'), false);
  for (const f of MAIN_POLLER_FILES) assert.ok(SCOPE_PATHSPECS.includes(f), f);
});

test('plan 4237 T2: a deliberate optional-lock status/diff read through a coord wrapper goes RED in a MAIN poller', () => {
  const fixture = [
    "import { gitWithLockRetry, git } from './coord-git.mjs';",
    'export function probe(mainDir) {',
    "  const s = gitWithLockRetry(mainDir, ['status', '--porcelain']);",
    '  const d = git(mainDir, [',
    "    'diff',",
    "    '--cached',",
    '  ]);',
    '  return s + d;',
    '}',
  ].join('\n');
  const vs = findViolations(fixture, { mainPoller: true });
  assert.deepEqual(
    vs.map((v) => [v.line, v.kind]),
    [
      [3, 'missing-lock-free-env'],
      [4, 'missing-lock-free-env'],
    ],
  );
  // the same text outside a MAIN poller is not judged by shape (c)
  assert.deepEqual(findViolations(fixture), []);
});

test('plan 4237 T2: LOCK_FREE_READ_ENV / GIT_OPTIONAL_LOCKS / the flag in the call satisfies shape (c)', () => {
  const ok = [
    "gitWithLockRetry(mainDir, ['status', '--porcelain'], { env: LOCK_FREE_READ_ENV });",
    "git(mainDir, ['diff', '--quiet'], { env: { GIT_OPTIONAL_LOCKS: '0' } });",
    "gitRaw(mainDir, ['--no-optional-locks', 'status']);",
    // not status/diff → out of scope
    "git(mainDir, ['rev-parse', 'HEAD']);",
    // member call, not the coord wrapper
    "s.git(mainDir, ['status']);",
    // waived
    "// lock-free-poll-ok: the commit path must write the index\ngit(mainDir, ['status']);",
  ];
  for (const t of ok) assert.deepEqual(findViolations(t, { mainPoller: true }), [], t);
});

test('plan 4237 T2: a module-local wrapper whose body carries the marker covers its callers (index-sanity shape)', () => {
  const safe = [
    'function git(dir, args, { exec = execFileSync } = {}) {',
    "  return exec('git', ['-C', dir, ...args], { env: gitIsolatedEnv(LOCK_FREE_READ_ENV) });",
    '}',
    "const t = git(dir, ['diff', '--cached', '--name-only'], { exec });",
  ].join('\n');
  assert.deepEqual(findViolations(safe, { mainPoller: true }), []);
  const unsafe = safe.replace('gitIsolatedEnv(LOCK_FREE_READ_ENV)', 'gitIsolatedEnv()');
  assert.deepEqual(
    findViolations(unsafe, { mainPoller: true }).map((v) => v.kind),
    ['missing-lock-free-env'],
  );
});

test('plan 4237 T2: a direct spawn whose env carries GIT_OPTIONAL_LOCKS is accepted by shape (a)', () => {
  const t =
    "execFileSync('git', ['status', '--porcelain'], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });";
  assert.deepEqual(findViolations(t), []);
});

test('plan 4237 T2: the real MAIN pollers are clean, and a diff re-adding a flagless read is caught', () => {
  for (const f of MAIN_POLLER_FILES) {
    const text = readFileSync(join(REPO_ROOT, f), 'utf8');
    assert.deepEqual(findViolations(text, { mainPoller: true }), [], f);
  }
  const text = "const x = gitWithLockRetry(mainDir, ['status', '--porcelain']);";
  const added = new Set([text]);
  assert.equal(violationsIntroduced(text, added, { mainPoller: true }).length, 1);
});

test('plan 4237 review d9d5af: GIT_OPTIONAL_LOCKS counts only when it is set to 0', () => {
  const on = "gitWithLockRetry(mainDir, ['status'], { env: { GIT_OPTIONAL_LOCKS: '1' } });";
  assert.equal(findViolations(on, { mainPoller: true }).length, 1);
  const direct = "execFileSync('git', ['status'], { env: { GIT_OPTIONAL_LOCKS: '1' } });";
  assert.equal(findViolations(direct).length, 1);
  const off = "gitWithLockRetry(mainDir, ['status'], { env: { GIT_OPTIONAL_LOCKS: '0' } });";
  assert.deepEqual(findViolations(off, { mainPoller: true }), []);
});
