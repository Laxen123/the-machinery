// scripts/assert-posix-path-assertions.test.mjs — unit tests for the platform-dependent
// test-assertion gate (plan 2490; extended to the Python test tree by plan 2853).
//
// This file is the gate's ONE structural exemption (`isExempt`): its fixtures are, by construction,
// the violating source text the gate exists to reject, so scanning it would be guaranteed
// self-indictment. Fixtures are `String.raw` templates so a `\\` or a `\n` inside a fixture stays
// the two literal characters real source carries, not an escape the template resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyze,
  analyzeFor,
  analyzePython,
  collectAddedByFile,
  collectPathBindings,
  hasBlockingViolation,
  inScope,
  isExempt,
  langFor,
  violationsIntroduced,
  CORPUS_SKIP_DIRS,
  SELF_TEST_PATH,
} from './assert-posix-path-assertions.mjs';

const kinds = (text) => analyze(text).map((v) => v.kind);

// ── acceptance 1: both plan-2478 shapes are caught ────────────────────────────

// Verbatim from the plan-2478 file as it landed (the form the 2462 land had to fix).
const SHAPE_POSIX_LITERAL = String.raw`
test('resolveCommonDirPath: honors an injected _exec and joins a relative result', () => {
  const common = resolveCommonDirPath({ anchor: '/somewhere', _exec: () => '.git\n' });
  assert.equal(common.replaceAll('\\', '/'), '/somewhere/.git');
});
`;

const SHAPE_RAW_COMPARE = String.raw`
test('resolveCommonDirPath: resolves the SHARED common dir from a linked worktree', () => {
  const { mainDir, wtDir, cleanup } = makeRepoWithWorktree();
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  assert.equal(fromWorktree, fromMain);
});
`;

test('shape 1 — a drive-less absolute literal as the expectation is caught', () => {
  const found = analyze(SHAPE_POSIX_LITERAL);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'posix-literal-expected');
  assert.match(found[0].detail, /'\/somewhere\/\.git'/);
});

test('shape 1 — the single-line form from the plan summary is caught', () => {
  // `resolve('/somewhere', '.git')` yields `C:\somewhere\.git` on Windows: a leading slash there is
  // drive-RELATIVE, so this assertion can only ever hold on Linux.
  const src = String.raw`
test('x', () => {
  assert.equal(resolve('/somewhere', '.git'), '/somewhere/.git');
});
`;
  assert.deepEqual(kinds(src), ['posix-literal-expected']);
});

test('shape 1 — an actual-side literal is caught too (argument order is not a loophole)', () => {
  const src = String.raw`
test('x', () => {
  assert.equal('/somewhere/.git', resolve(anchor, '.git'));
});
`;
  assert.deepEqual(kinds(src), ['posix-literal-expected']);
});

test('shape 2 — two path-valued bindings compared raw is caught', () => {
  const found = analyze(SHAPE_RAW_COMPARE);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'unnormalized-path-compare');
  assert.match(found[0].detail, /fromWorktree vs fromMain/);
});

test('shape 2 — the binding may come from a destructured path-ish NAME alone', () => {
  // `makeRepoWithWorktree()` says nothing about paths; `mainDir` / `wtDir` do.
  const src = String.raw`
test('x', () => {
  const { mainDir, wtDir } = makeRepoWithWorktree();
  assert.equal(wtDir, mainDir);
});
`;
  assert.deepEqual(kinds(src), ['unnormalized-path-compare']);
});

// ── the fixes the gate points at are clean ────────────────────────────────────

test('assertSamePath is the remedy — it is not an equality assertion, so it never fires', () => {
  const src = String.raw`
test('x', () => {
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  assertSamePath(fromWorktree, fromMain);
});
`;
  assert.deepEqual(kinds(src), []);
});

test('deriving the expectation the same way the actual is derived is clean', () => {
  const src = String.raw`
test('x', () => {
  const anchor = resolve('/somewhere');
  const common = resolveCommonDirPath({ anchor, _exec: () => '.git\n' });
  assert.equal(common.replaceAll('\\', '/'), join(anchor, '.git').replaceAll('\\', '/'));
});
`;
  assert.deepEqual(kinds(src), []);
});

test('a test block that PINS a platform is exempt — that is the prescribed pattern', () => {
  const src = String.raw`
test('honors an injected _exec', () => {
  const common = resolveCommonDirPath({ anchor: '/somewhere', _exec: () => '.git\n', _path: posix });
  assert.equal(common, '/somewhere/.git');
});
`;
  assert.deepEqual(kinds(src), []);
});

test('the pin exempts only ITS block, not the rest of the file', () => {
  const src = String.raw`
test('pinned', () => {
  const common = resolveCommonDirPath({ anchor: '/somewhere', _path: win32 });
  assert.equal(common, '/somewhere/.git');
});

test('unpinned', () => {
  const other = resolveCommonDirPath({ anchor: '/elsewhere' });
  assert.equal(other, '/elsewhere/.git');
});
`;
  const found = analyze(src);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /elsewhere/);
});

test('a file-scope import of win32/posix does NOT exempt anything', () => {
  const src = String.raw`
import { join, resolve, win32, posix } from 'node:path';

test('x', () => {
  const common = resolveCommonDirPath({ anchor: '/somewhere' });
  assert.equal(common, '/somewhere/.git');
});
`;
  assert.deepEqual(kinds(src), ['posix-literal-expected']);
});

// ── waivers ───────────────────────────────────────────────────────────────────

test('a waiver WITH a reason clears the line, on the line or the line above', () => {
  const onLine = String.raw`
test('x', () => {
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  assert.equal(fromWorktree, fromMain); // path-assert-ok: these must be BYTE-identical lock paths
});
`;
  const above = String.raw`
test('x', () => {
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  // path-assert-ok: these must be BYTE-identical lock paths
  assert.equal(fromWorktree, fromMain);
});
`;
  assert.deepEqual(kinds(onLine), []);
  assert.deepEqual(kinds(above), []);
});

test('a waiver may sit anywhere in the contiguous comment block above the assertion', () => {
  const src = String.raw`
test('x', () => {
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  // path-assert-ok: byte-identity IS the invariant — these strings are used AS lockfile paths,
  // so a normalizing compare would pass on a pair that cannot actually rendezvous.
  assert.equal(fromWorktree, fromMain);
});
`;
  assert.deepEqual(kinds(src), []);
});

test('a waiver does NOT reach past a line of code to a later assertion', () => {
  const src = String.raw`
test('x', () => {
  // path-assert-ok: only waives the next statement
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  assert.equal(fromWorktree, fromMain);
});
`;
  assert.deepEqual(kinds(src), ['unnormalized-path-compare']);
});

test('a bare waiver marker with no reason does NOT waive', () => {
  const src = String.raw`
test('x', () => {
  const fromMain = resolveCommonDirPath({ anchor: mainDir });
  const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
  assert.equal(fromWorktree, fromMain); // path-assert-ok:
});
`;
  assert.deepEqual(kinds(src), ['unnormalized-path-compare']);
});

// ── acceptance 1 (plan 2552): shape (3), the third-recurrence gap ─────────────

// VERBATIM from `git show 18c16e8940^:scripts/pass-cache-kernel.test.mjs` — the assertion exactly
// as it stood when incident #3 reddened master on 2026-07-27. Plan 2507 migrated resolveCacheDir
// onto resolveCommonDirPath (join-shaped → resolve-shaped) and this fixture, which hand-built its
// expectation with join(), went red on Windows only. The gate was LIVE at the time and did not
// fire; this case is the proof that the gap is closed.
const SHAPE_JOIN_ROOTED_INCIDENT_3 = String.raw`
test('plan 2492: the two caches still rendezvous in SEPARATE dirs', () => {
  const git = () => '/repo/.git\n';
  assert.equal(resolveCacheDir(git, 'gate-pass-cache'), join('/repo/.git', 'gate-pass-cache'));
  assert.notEqual(gateCache.resolveCacheDir(git), batteryCache.resolveCacheDir(git));
});
`;

test('shape 3 — the verbatim incident-#3 assertion is caught', () => {
  const found = analyze(SHAPE_JOIN_ROOTED_INCIDENT_3);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'join-rooted-literal');
  assert.match(found[0].detail, /'\/repo\/\.git'/);
});

test('shape 3 — a join buried inside a deepEqual ARRAY is caught (the cut-worktree shape)', () => {
  // Verbatim from scripts/cut-worktree.test.mjs before this plan migrated it. Neither operand is
  // itself a literal or a path-named binding, so a rule conditioned on the OTHER side would let
  // this escape — which is why shape (3) is judged unconditionally on the operand.
  const src = String.raw`
test('x', () => {
  assert.deepEqual(
    installCwds,
    [join('/main', '.claude/worktrees/e1-slug')],
    'install runs once, in the new worktree directory',
  );
});
`;
  assert.deepEqual(kinds(src), ['join-rooted-literal']);
});

test('shape 3 — an actual-side join is caught too (argument order is not a loophole)', () => {
  const src = String.raw`
test('x', () => {
  assert.equal(join('/repo/.git', 'x'), someDir);
});
`;
  assert.deepEqual(kinds(src), ['join-rooted-literal']);
});

test('shape 3 — a NESTED join does not hide behind an innocent outer call', () => {
  const src = String.raw`
test('x', () => {
  assert.equal(d, join(base, join('/a', 'b')));
});
`;
  assert.deepEqual(kinds(src), ['join-rooted-literal']);
});

test('shape 3 — the existing waiver and platform-pin escape hatches still apply', () => {
  const waived = String.raw`
test('x', () => {
  // path-assert-ok: these two must be BYTE-identical, not merely equivalent.
  assert.equal(p.pnpmDir, join('/root', 'node_modules', '.pnpm'));
});
`;
  assert.deepEqual(kinds(waived), []);
  const pinned = String.raw`
test('x', () => {
  const p = resolvePaths('/root', { _path: win32 });
  assert.equal(p.pnpmDir, join('/root', 'node_modules', '.pnpm'));
});
`;
  assert.deepEqual(kinds(pinned), []);
});

test('shape 3 — the shared global regex carries no lastIndex state between operands', () => {
  // joinRootedLiteral reuses ONE module-level /g regex instead of recompiling per call, so its
  // `lastIndex` is state shared across calls — and every early `return` leaves it mid-string. If it
  // were not reset on entry, a later operand would be scanned from a stale offset and its violation
  // silently skipped. Each of these lines must be flagged on its own, in order, in one pass; a
  // leaked lastIndex drops the second or third.
  const src = String.raw`
test('x', () => {
  assert.equal(a, join('/one', 'x'));
  assert.equal(b, join('/two', 'y'));
  assert.equal(c, join('/three', 'z'));
});
`;
  const found = analyze(src);
  assert.deepEqual(
    found.map((v) => v.kind),
    ['join-rooted-literal', 'join-rooted-literal', 'join-rooted-literal'],
  );
  assert.deepEqual(
    found.map((v) => v.detail.match(/'\/\w+'/)[0]),
    ["'/one'", "'/two'", "'/three'"],
  );
  // …and a second analyze() of the same text is identical (no cross-CALL leakage either).
  assert.deepEqual(kinds(src), kinds(src));
});

// ── acceptance 3 (plan 2552): shape (3) negative controls ─────────────────────

test('shape 3 negatives — the anchor idiom, relative joins, pins, and Array#join are clean', () => {
  // (a) The prescribed fix: a drive-QUALIFIED anchor fed to both sides. Must never be flagged —
  // the gate cannot indict its own remedy.
  const anchored = String.raw`
test('x', () => {
  const anchor = resolve('/c');
  assert.equal(entryPath(anchor, KEY), join(anchor, 'k.json'));
});
`;
  assert.deepEqual(kinds(anchored), []);

  // (b) A RELATIVE first argument is drive-agnostic by construction — nothing to disagree about.
  const relative = String.raw`
test('x', () => {
  assert.equal(p.sub, join('sub', 'x'));
});
`;
  assert.deepEqual(kinds(relative), []);

  // (c) An explicitly pinned module produces a platform-independent value; `posix.join` and
  // `win32.join` must stay out via the lookbehind, independently of the test-block pin exemption.
  const pinnedModule = String.raw`
test('x', () => {
  assert.equal(a, posix.join('/somewhere', '.git'));
});
`;
  assert.deepEqual(kinds(pinnedModule), []);

  // (d) An Array#join is not a path op. The real corpus shape from scripts/loader-common.test.mjs.
  const arrayJoin = String.raw`
test('x', () => {
  assert.equal(readFile(p), files[p.split(/[\\/]/).slice(-2).join('/')]);
});
`;
  assert.deepEqual(kinds(arrayJoin), []);

  // (e) The documented KNOWN BOUND: a resolve()-rooted expectation is the landed remedy for
  // incident #3 and agrees with the resolve-shaped implementations the codebase migrates toward.
  const resolveRooted = String.raw`
test('x', () => {
  assert.equal(resolveCacheDir(git, 'gate-pass-cache'), resolve('/repo/.git', 'gate-pass-cache'));
});
`;
  assert.deepEqual(kinds(resolveRooted), []);

  // (f) A UNC / protocol-relative root is a different animal, excluded by POSIX_ABS_LITERAL_RX.
  const unc = String.raw`
test('x', () => {
  assert.equal(p, join('//host/share', 'x'));
});
`;
  assert.deepEqual(kinds(unc), []);
});

// ── measured NON-violations (regression pins from the plan-2490 corpus sweep) ──
// Each of these is a real shape in scripts/*.test.mjs today. Flagging any of them would make the
// gate a false-positive factory, so they are pinned as explicitly clean.

test('a drive-less absolute literal in an INPUT position is not an assertion about a spelling', () => {
  const src = String.raw`
test('x', () => {
  assert.deepEqual(resolveGuardRanges('/repo', [], { _git: fake }), ['origin/master..HEAD']);
  assert.equal(computeDriftIsInherited({ repoRoot: '/repo', _exec }), true);
  assert.equal(loadHobbyEnv('/nonexistent-root-for-test'), false);
});
`;
  assert.deepEqual(kinds(src), []);
});

// FLIPPED by plan 2552 (was a "measured NON-violation" pin, and was WRONG). The old rationale —
// "both sides derived through the same native path call is platform-consistent" — silently assumed
// the IMPLEMENTATION side also joins. `join('/root', x)` stays drive-less while `resolve('/root',
// x)` drive-qualifies, so the moment resolvePaths/entryPath migrates to a resolve-shaped builder
// (as resolveCacheDir did in plan 2507) these red on Windows only. Both lines are verbatim from
// the real corpus and both were latent instances; they are now positive fixtures of shape (3).
test('shape 3 — a join rooted at a drive-less literal is caught on BOTH corpus lines', () => {
  const src = String.raw`
test('x', () => {
  const p = resolvePaths('/root');
  assert.equal(p.pnpmDir, join('/root', 'node_modules', '.pnpm'));
  assert.equal(entryPath('/c', 'k'), join('/c', 'k.json'));
});
`;
  assert.deepEqual(kinds(src), ['join-rooted-literal', 'join-rooted-literal']);
});

test('a URL route literal is not mistaken for a filesystem path', () => {
  const src = String.raw`
test('x', () => {
  assert.equal(r.path, '/v1/claude_code/routines/trig_abc/fire');
  assert.equal(f.entryFile, '/tmp/e.md');
});
`;
  assert.deepEqual(kinds(src), []);
});

test('a path fed through a hash is a hash — the outermost call decides the type', () => {
  const src = String.raw`
test('x', () => {
  const h1 = hashInstallRoot(resolve('.', 'root-a'));
  const h2 = hashInstallRoot(resolve('.', 'root-a') + '/');
  assert.equal(h1, h2);
});
`;
  assert.deepEqual(collectPathBindings(src.split('\n')).size, 0);
  assert.deepEqual(kinds(src), []);
});

test('a path-ish NAME is matched by word, not by substring — `profile` is not a path', () => {
  const src = String.raw`
test('x', () => {
  const profile = loadProfile(a);
  const otherProfile = loadProfile(b);
  assert.equal(profile, otherProfile);
});
`;
  assert.deepEqual(collectPathBindings(src.split('\n')).size, 0);
  assert.deepEqual(kinds(src), []);
  // …while the real camelCase and whole-word forms still bind.
  const bound = collectPathBindings([
    'const mainDir = f();',
    'const dir = g();',
    'const repoRoot = h();',
  ]);
  assert.deepEqual([...bound].sort(), ['dir', 'mainDir', 'repoRoot']);
});

test('a file ACTION yields content, not a path — readFile results are not path bindings', () => {
  const src = String.raw`
test('x', () => {
  const a = readFile(one);
  const b = readFile(two);
  assert.equal(a, b);
});
`;
  assert.deepEqual(collectPathBindings(src.split('\n')).size, 0);
  assert.deepEqual(kinds(src), []);
});

test('the member form path.win32.x() counts as a platform pin', () => {
  const src = String.raw`
test('x', () => {
  const common = path.win32.join('/somewhere', '.git');
  assert.equal(common, '/somewhere/.git');
});
`;
  assert.deepEqual(kinds(src), []);
});

test("a bare 'win32' platform STRING is not a pin", () => {
  const src = String.raw`
test('x', () => {
  if (process.platform !== 'win32') return;
  const common = resolveCommonDirPath({ anchor });
  assert.equal(common, '/somewhere/.git');
});
`;
  assert.deepEqual(kinds(src), ['posix-literal-expected']);
});

test('a whole-line comment carrying a violating example does not fire', () => {
  const src = String.raw`
test('x', () => {
  // assert.equal(common, '/somewhere/.git') is what this used to say
  const common = resolveCommonDirPath({ anchor });
  assert.ok(common);
});
`;
  assert.deepEqual(kinds(src), []);
});

// ── mechanics ─────────────────────────────────────────────────────────────────

test('a multi-line assertion is joined and judged as one call', () => {
  const src = String.raw`
test('x', () => {
  const common = resolveCommonDirPath({ anchor });
  assert.equal(
    common.replaceAll('\\', '/'),
    '/somewhere/.git',
  );
});
`;
  const found = analyze(src);
  assert.deepEqual(
    found.map((v) => v.kind),
    ['posix-literal-expected'],
  );
  // Reported at the FIRST physical line of the call, and spanning to its close.
  assert.ok(found[0].endLine > found[0].line);
});

test('scope: only scripts/**/*.test.mjs, and the gate exempts its own test file', () => {
  assert.equal(inScope('scripts/lock-path.test.mjs'), true);
  assert.equal(inScope('scripts/coord/lock-path.mjs'), false);
  assert.equal(inScope('backend/tests/foo.test.mjs'), false);
  assert.equal(isExempt(SELF_TEST_PATH), true);
  assert.equal(isExempt('scripts/lock-path.test.mjs'), false);
});

// ── diff scoping ──────────────────────────────────────────────────────────────

const DIFF = [
  'diff --git a/scripts/lock-path.test.mjs b/scripts/lock-path.test.mjs',
  '--- a/scripts/lock-path.test.mjs',
  '+++ b/scripts/lock-path.test.mjs',
  '@@ -5,0 +6 @@',
  '+  assert.equal(fromWorktree, fromMain);',
].join('\n');

test('collectAddedByFile: added line texts per in-scope file', () => {
  const byFile = collectAddedByFile(DIFF);
  assert.deepEqual([...byFile.keys()], ['scripts/lock-path.test.mjs']);
  assert.ok(byFile.get('scripts/lock-path.test.mjs').has('assert.equal(fromWorktree, fromMain);'));
});

test('collectAddedByFile: an out-of-scope or exempt file contributes nothing', () => {
  const other = DIFF.replaceAll('scripts/lock-path.test.mjs', 'scripts/coord/lock-path.mjs');
  assert.equal(collectAddedByFile(other).size, 0);
  const self = DIFF.replaceAll('scripts/lock-path.test.mjs', SELF_TEST_PATH);
  assert.equal(collectAddedByFile(self).size, 0);
});

test('violationsIntroduced: editing ONLY the expected line of a multi-line assertion still counts', () => {
  // The first line `assert.equal(` is unchanged by such a diff, so matching on it alone would let
  // the introduced violation through.
  const src = String.raw`
test('x', () => {
  const common = resolveCommonDirPath({ anchor });
  assert.equal(
    common.replaceAll('\\', '/'),
    '/somewhere/.git',
  );
});
`;
  const addedExpectedOnly = new Set(["'/somewhere/.git',"]);
  assert.equal(violationsIntroduced(src, addedExpectedOnly).length, 1);
  // A blank added line must not match the statement's span.
  assert.equal(violationsIntroduced(src, new Set([''])).length, 0);
});

test('violationsIntroduced: a PRE-EXISTING violation does not block; the added one does', () => {
  const added = collectAddedByFile(DIFF).get('scripts/lock-path.test.mjs');
  assert.equal(violationsIntroduced(SHAPE_RAW_COMPARE, added).length, 1);
  // Same file text, but the range added nothing matching → nothing to block on.
  assert.equal(violationsIntroduced(SHAPE_RAW_COMPARE, new Set(['// unrelated'])).length, 0);
});

// ── acceptance 1 (plan 3622): shape (6), the ambient-git-state axis ────────────
//
// The flag / waive / pass triple for the third axis. The violating fixture is the real shape the
// four corpus instances had: a test that NAMES an outside-a-repo condition and then builds its
// root with a bare `mkdtempSync`, asserting a property of the machine rather than of the path.

const SHAPE_AMBIENT_GIT = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));
  assert.doesNotThrow(() => runHelper(root));
});
`;

test('shape 6 — a bare mkdtemp root under an outside-a-repo claim is caught', () => {
  assert.deepEqual(kinds(SHAPE_AMBIENT_GIT), ['ambient-git-state']);
});

test('shape 6 — the waiver clears it, and the reason is REQUIRED', () => {
  const waived = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  // ambient-git-ok: the harness guarantees a repo-free TMPDIR for this suite
  const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));
  assert.doesNotThrow(() => runHelper(root));
});
`;
  assert.deepEqual(kinds(waived), []);

  // A bare marker with no reason does NOT waive — same rule the other shapes' waivers follow.
  const reasonless = waived.replace(
    '// ambient-git-ok: the harness guarantees a repo-free TMPDIR for this suite',
    '// ambient-git-ok:',
  );
  assert.deepEqual(kinds(reasonless), ['ambient-git-state']);
});

test('shape 6 — git-initing the root clears it (a repo is then a fact about the path)', () => {
  const inited = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.doesNotThrow(() => runHelper(root));
});
`;
  assert.deepEqual(kinds(inited), []);
});

test('shape 6 — planting a .git marker in the root clears it', () => {
  const planted = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));
  writeFileSync(join(root, '.git'), 'gitdir: ' + join(root, 'no-such-gitdir'));
  assert.doesNotThrow(() => runHelper(root));
});
`;
  assert.deepEqual(kinds(planted), []);
});

test('shape 6 — the landed remedy (makeNoRepoRoot) is clean with no waiver at all', () => {
  const seamed = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  const root = makeNoRepoRoot('cswl-nogit-');
  assert.doesNotThrow(() => runHelper(root));
});
`;
  assert.deepEqual(kinds(seamed), []);
});

test('shape 6 — a GIT_CEILING_DIRECTORIES fence clears it', () => {
  const fenced = String.raw`
test('exits 0 outside any git repo (never blocks a commit retry)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));
  runHelper(root, { GIT_CEILING_DIRECTORIES: tmpdir() });
});
`;
  assert.deepEqual(kinds(fenced), []);
});

// ── shape 6 negative controls (the false positives the corpus sweep forced out) ─

test('shape 6 — a mkdtemp root with NO outside-a-repo claim is not flagged', () => {
  const src = String.raw`
test('removes a STALE lock on a worktree-private index', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-'));
  assert.doesNotThrow(() => runHelper(root));
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 6 — an error-STRING assertion is not a filesystem claim', () => {
  // The file-wide phrase scan this rule deliberately does NOT do would hit 17 corpus files on
  // exactly this shape: the phrase appears as an expected git ERROR MESSAGE, and the test asserts
  // nothing about what the host filesystem contains.
  const src = String.raw`
test('indexLockPath throws on a bad dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-'));
  assert.throws(() => indexLockPath(dir), /fatal|not a git repository/i);
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 6 — a same-named binding git-inited in ANOTHER block does not cover this one', () => {
  // Measured against gate-pass-cache.test.mjs, which binds `dir` twice: once in a fixture that
  // git-inits it and once in the outside-a-repo test that must not. A file-wide, name-keyed cover
  // let the fixture clear the real instance.
  const src = String.raw`
test('a cached gate HITs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cache-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(runCli(dir, ['check']).status, EXIT_HIT);
});

test('CLI: outside a git repo everything is UNCACHEABLE, never a crash-hit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-cache-nogit-'));
  assert.notEqual(runCli(dir, ['check']).status, EXIT_HIT);
});
`;
  assert.deepEqual(kinds(src), ['ambient-git-state']);
});

test('shape 6 — a .git inside a STRING LITERAL does not cover a top-level binding', () => {
  // Measured against git-maintenance-guard.test.mjs, whose module-level command table contains
  // 'git --git-dir /a/.git gc': `--git-dir` matches a bare `dir` reference and `/a/.git` matches
  // the planted-marker cover, so a real instance was cleared by a line establishing nothing.
  const src = String.raw`
const SAFE = ['git gc', 'git --work-tree /a --git-dir /a/.git gc'];
const dir = mkdtempSync(join(tmpdir(), 'gmg-'));

test('CLI: a safe command needs NO liveness read at all (lazy) — works outside a repo', () => {
  const r = spawnSync(process.execPath, [CLI, 'check'], { cwd: dir });
  assert.equal(r.status, 0);
});
`;
  assert.deepEqual(kinds(src), ['ambient-git-state']);
});

test('shape 6 — a top-level binding declared BETWEEN test blocks is still top-level', () => {
  // The `test(…)`-span model runs block-start → next-block-start, so a top-level statement sitting
  // between two blocks is attributed to the preceding one. Keying scope on indentation instead is
  // what lets the claiming block below see `dir` as a candidate at all.
  const src = String.raw`
test('an earlier, unrelated test', () => {
  assert.ok(true);
});

const dir = mkdtempSync(join(tmpdir(), 'gmg-'));

test('CLI: works outside a repo', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 0);
});
`;
  assert.deepEqual(kinds(src), ['ambient-git-state']);
});

test('shape 6 — a NEW claiming block over a PRE-EXISTING top-level binding still blocks the push', () => {
  // Review finding [1] (sonnet-review, 2026-09-02) — the diff-scoped gate is what pre-push.sh
  // actually runs, and it keeps only violations whose `texts` include a line the range ADDED.
  // Anchoring a top-level-binding violation solely at the binding meant the commonest real shape
  // — a shared `const dir = mkdtempSync(…)` that already exists, plus a NEWLY ADDED test block
  // claiming to be outside a repo — carried only the pre-existing binding line in `texts` and was
  // filtered straight out. The gate reported clean on exactly the diff it exists to stop, which
  // is the plan-3595 failure mode reproduced inside the fix for it.
  const src = String.raw`
const dir = mkdtempSync(join(tmpdir(), 'gmg-'));

test('CLI: works outside a repo', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 0);
});
`;
  assert.deepEqual(kinds(src), ['ambient-git-state']);

  // Only the test block is new; the binding line is untouched, pre-existing context.
  const addedBlockOnly = new Set([
    "test('CLI: works outside a repo', () => {",
    'assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 0);',
    '});',
  ]);
  assert.equal(violationsIntroduced(src, addedBlockOnly).length, 1);

  // The mirror case — the binding is what moved into an existing claiming block — still counts.
  const addedBindingOnly = new Set(["const dir = mkdtempSync(join(tmpdir(), 'gmg-'));"]);
  assert.equal(violationsIntroduced(src, addedBindingOnly).length, 1);

  // And a range that added neither still blocks nothing.
  assert.equal(violationsIntroduced(src, new Set(['// unrelated'])).length, 0);
});

test('shape 6 — a claim added as a HEADER COMMENT also blocks the push', () => {
  // Review finding [1] (sonnet-review round 2) — the claim is tested against the test-open line
  // JOINED WITH its header comment block, so a claim can arrive purely as a comment over an
  // otherwise generically-titled test. Round 1's fix put only the binding and the test-open line
  // in `texts`, so a diff whose ONLY new line was that comment intersected neither and the
  // diff-scoped gate reported clean — the same hole as finding [1], through the other door.
  const src = String.raw`
const dir = mkdtempSync(join(tmpdir(), 'gmg-'));

// exits 0 outside any git repo, never blocking a commit retry
test('CLI: the safe path', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 0);
});
`;
  assert.deepEqual(kinds(src), ['ambient-git-state']);

  const addedCommentOnly = new Set([
    '// exits 0 outside any git repo, never blocking a commit retry',
  ]);
  assert.equal(violationsIntroduced(src, addedCommentOnly).length, 1);

  // An UNRELATED comment added above an already-claiming test must NOT newly block: the
  // violation was already there, and this range did not introduce it.
  const alreadyClaiming = String.raw`
const dir = mkdtempSync(join(tmpdir(), 'gmg-'));

// bookkeeping note about the CLI flag
test('CLI: works outside a repo', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { cwd: dir }).status, 0);
});
`;
  assert.deepEqual(kinds(alreadyClaiming), ['ambient-git-state']);
  assert.equal(
    violationsIntroduced(alreadyClaiming, new Set(['// bookkeeping note about the CLI flag']))
      .length,
    0,
  );
});

test('shape 6 — a mkdtemp FACTORY binding is not itself a root', () => {
  const src = String.raw`
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

test('CLI: works outside a repo', () => {
  assert.ok(tmp('x-'));
});
`;
  assert.deepEqual(kinds(src), []);
});

// ── acceptance (plan 4005): shape (7), the ambient-load-state axis ─────────────
//
// The fourth axis: live free memory and real elapsed wall-clock time, both properties of the
// MACHINE at the moment a test runs, not of the code under test. Fixtures mirror the real trio
// this plan fixed (pre-push-hook.test.mjs's live os.freemem() read, pre-push-battery-cap.test.mjs's
// wallMs < N ceilings, and the Date.now()-based poll deadlines the orphan test used before this
// plan named them a hang backstop).

test('shape 7a — a bare os.freemem() call is caught', () => {
  const src = String.raw`
test('worker count reflects live memory', () => {
  const free = os.freemem();
  assert.ok(free > 0);
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-freemem']);
});

test('shape 7a — a bare (unqualified) freemem()/totalmem() call is caught the same as the os.-qualified form', () => {
  const src = String.raw`
import { freemem, totalmem } from 'node:os';
test('shares of the pool', () => {
  const free = freemem();
  const total = totalmem();
  assert.ok(free < total);
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-freemem', 'ambient-load-freemem']);
});

test('shape 7a — the injected-fake PROPERTY shape (freemem: () => literal) is NOT flagged', () => {
  // The corpus convention throughout test-queue.test.mjs / pytest-workers.test.mjs — freemem is
  // a property KEY here (colon, not a call), the seam this shape's own FIX advice recommends.
  const src = String.raw`
test('injected budget', () => {
  const detail = perSlotWorkerBudgetDetail(cpu, env, { freemem: () => 40_000_000_000 });
  assert.equal(detail.workers, 9);
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 7a — the waiver clears it, and the reason is REQUIRED', () => {
  const waived = String.raw`
test('worker count reflects live memory', () => {
  // ambient-load-ok: this file measures the REAL budget on purpose, plan-3954 T0
  const free = os.freemem();
  assert.ok(free > 0);
});
`;
  assert.deepEqual(kinds(waived), []);

  const reasonless = waived.replace(
    '// ambient-load-ok: this file measures the REAL budget on purpose, plan-3954 T0',
    '// ambient-load-ok:',
  );
  assert.deepEqual(kinds(reasonless), ['ambient-load-freemem']);
});

test('shape 7b — a Date.now()-based poll deadline compared against Date.now() again is caught', () => {
  const src = String.raw`
test('waits for the child to appear', () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (probe()) break;
  }
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — the reverse operand order (name > Date.now()) is caught the same way', () => {
  const src = String.raw`
test('waits for the child to appear', () => {
  const deadline = Date.now() + 30_000;
  while (deadline > Date.now()) {
    if (probe()) break;
  }
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — a Date.now() + N binding NEVER compared against Date.now() again is injected test DATA, not flagged', () => {
  // The measured real corpus shape (coord-git.test.mjs's farFuture, done-worktree.test.mjs's
  // nearPast, heal-main.test.mjs's/pre-yield-guard.test.mjs's future): a FIXED future timestamp
  // fed to an injected `now:` fake or a function argument, never itself a poll-loop deadline.
  const src = String.raw`
test('a future-dated holder is not reclaimed', () => {
  const farFuture = Date.now() + 10_000_000;
  const state = acquireLock(dir, { now: () => farFuture });
  assert.equal(state, 'live');
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 7b — a name bound from a real elapsed delta held to a literal CEILING (<) is caught', () => {
  const src = String.raw`
test('a fast healthy battery completes untouched', () => {
  const start = process.hrtime.bigint();
  const res = runCappedBattery();
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(wallMs < 5_000, 'expected a fast pass well under the cap');
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — Date.now() and performance.now() deltas are caught the same way as process.hrtime', () => {
  const dateSrc = String.raw`
test('a fast pass', () => {
  const t0 = Date.now();
  const res = runIt();
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 8000, 'expected a fast pass');
});
`;
  assert.deepEqual(kinds(dateSrc), ['ambient-load-elapsed-ceiling']);

  const perfSrc = String.raw`
test('a fast pass', () => {
  const t0 = performance.now();
  const res = runIt();
  const wallMs = performance.now() - t0;
  assert.ok(wallMs < 8000, 'expected a fast pass');
});
`;
  assert.deepEqual(kinds(perfSrc), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — a FLOOR comparison (>=, "took at least this long") is NOT flagged — load can only make it MORE true', () => {
  const src = String.raw`
test('force kill follows the named grace period', () => {
  const started = Date.now();
  killAndWait();
  assert.ok(Date.now() - started >= 2_000, 'force kill should follow the named grace period');
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 7b — the waiver clears an elapsed-ceiling comparison, and the reason is REQUIRED', () => {
  const waived = String.raw`
test('a bounded hang backstop', () => {
  let appeared = false;
  // ambient-load-ok: a single named hang backstop, not a timing assertion (plan 4005 T2).
  const appearDeadline = Date.now() + ORPHAN_POLL_HANG_BACKSTOP_MS;
  while (Date.now() < appearDeadline) {
    if (probe()) { appeared = true; break; }
  }
});
`;
  assert.deepEqual(kinds(waived), []);

  const reasonless = waived.replace(
    '// ambient-load-ok: a single named hang backstop, not a timing assertion (plan 4005 T2).',
    '// ambient-load-ok:',
  );
  assert.deepEqual(kinds(reasonless), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — two DIFFERENT tests binding the SAME conventional name do not cross-attribute', () => {
  // Real corpus shape: pre-push-hook.test.mjs binds `elapsedMs` in two unrelated tests. Each
  // test's own comparison must be judged against ITS OWN binding, never the other test's — and
  // in particular a waiver on one test's comparison must not silently clear the OTHER's.
  const src = String.raw`
test('first thing is fast', () => {
  const t0 = Date.now();
  runFirst();
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 8000, 'first must be fast');
});

test('second thing is fast', () => {
  const t0 = Date.now();
  runSecond();
  const elapsedMs = Date.now() - t0;
  // ambient-load-ok: this one is deliberately waived for the fixture
  assert.ok(elapsedMs < 5000, 'second must be fast');
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

// ── shape 7 (plan 4005) round-1 review fixes ───────────────────────────────────

test('shape 7a — a helper FUNCTION DECLARATION named freemem/totalmem is not mistaken for a call', () => {
  // Review finding: FREEMEM_TOTALMEM_CALL_RX matched any `freemem(`/`totalmem(` text, including a
  // same-named helper's own parameter list — `function freemem() { … }` textually contains
  // `freemem(` with nothing between the keyword and the name.
  const src = String.raw`
function freemem() {
  return 40_000_000_000;
}
function totalmem() {
  return 200_000_000_000;
}
test('injected budget via local helpers', () => {
  const free = freemem();
  const total = totalmem();
  assert.ok(free < total);
});
`;
  // NOTE: the reference calls freemem()/totalmem() inside the test body are still genuine bare
  // calls and must still be caught — only the two DECLARATIONS must not double-count as calls.
  // (One call per PHYSICAL LINE is this gate's existing, unrelated known bound — see ASSERT_EQ_RX's
  // own KNOWN BOUND note above — so the two calls are put on separate lines here, not combined onto
  // one `freemem() < totalmem()` line.)
  assert.deepEqual(kinds(src), ['ambient-load-freemem', 'ambient-load-freemem']);
});

test('shape 7a — a MEMBER call on an injected fake (not the real os module) is not flagged', () => {
  // Same regex fix as the declaration case above: only a bare call or an `os.`-qualified one is a
  // live read. A fake reached through ITS OWN object (`fakeOs.freemem()`) is not `node:os`.
  const src = String.raw`
test('injected budget via a fake os object', () => {
  const fakeOs = { freemem: () => 40_000_000_000, totalmem: () => 200_000_000_000 };
  assert.ok(fakeOs.freemem() < fakeOs.totalmem());
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 7a — freemem()/totalmem() as PROSE inside a string literal is not a live call', () => {
  // Review finding: the call regex matched inside STRING literals too — descriptive text like an
  // assertion failure message quoting the forbidden call must not itself trip the gate.
  const src = String.raw`
test('the lint names the forbidden call', () => {
  const msg = 'do not call freemem() or totalmem() directly — inject the reading';
  assert.match(RULE_TEXT, /freemem\(\)/);
});
`;
  assert.deepEqual(kinds(src), []);
});

test("shape 7a — freemem()/totalmem() text inside a MULTI-LINE template-literal fixture body is not this file's own code", () => {
  // Review finding: the corpus builds fake child processes as backtick template strings containing
  // real-looking JS (sol-run.test.mjs's `fixture(\`...\`)` idiom) — a live-looking call inside that
  // string is the CHILD's source, not a call this file itself makes.
  //
  // Built via array-join rather than a literal nested backtick: this file's OWN fixtures are
  // `String.raw` TEMPLATE literals too, so an unescaped backtick inside one would close the outer
  // template early — the join keeps the outer fixture a plain single-backtick template while still
  // producing a genuine multi-line backtick string in the ANALYZED source text.
  const src = [
    `test('a fake child that reads its own memory', () => {`,
    '  const f = fixture(`',
    "    import { freemem, totalmem } from 'node:os';",
    '    process.stdout.write(String(freemem() + totalmem()));',
    '  `);',
    '  assert.ok(f.dir);',
    '});',
  ].join('\n');
  assert.deepEqual(kinds(src), []);
});

test("shape 7b — a Date.now()-deadline poll INSIDE a multi-line template-literal fixture body is not this file's own poll loop", () => {
  // Same class as the freemem template-literal finding above, for the 7b binding scan: a fixture
  // string's OWN `Date.now() + N` / `while (Date.now() < …)` shape belongs to the spawned child,
  // never to this test file.
  const src = [
    `test('a fake child that busy-waits on its own clock', () => {`,
    '  const f = fixture(`',
    '    const deadline = Date.now() + 50;',
    '    while (Date.now() < deadline) {}',
    '    process.exit(0);',
    '  `);',
    '  assert.ok(f.dir);',
    '});',
  ].join('\n');
  assert.deepEqual(kinds(src), []);
});

test('shape 7b — two DIFFERENT tests binding the SAME name do not cross-attribute a Date.now() deadline', () => {
  // Review finding: usedAsDateNowDeadline scanned the WHOLE FILE for `Date.now() <cmp> name`, so a
  // FIXED injected timestamp in one test (never itself polled) was wrongly flagged because an
  // UNRELATED test polls its own same-named deadline. Scoped to the binding's own enclosing test
  // block, mirroring the elapsed-delta branch's `enclosingTestSpan` treatment.
  const src = String.raw`
test('a future-dated holder is not reclaimed', () => {
  const deadline = Date.now() + 10_000_000;
  const state = acquireLock(dir, { now: () => deadline });
  assert.equal(state, 'live');
});

test('waits for the child to appear', () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (probe()) break;
  }
});
`;
  // Only the SECOND test's own poll loop is a real violation; the first test's fixed timestamp
  // must not be flagged just because the second test polls a same-named binding.
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
  const found = analyze(src);
  assert.equal(found.length, 1);
  assert.match(found[0].text, /while \(Date\.now\(\) < deadline\)/);
});

test('shape 7b — a MODULE-SCOPE Date.now() deadline binding still uses the whole-file fallback', () => {
  // The scoping fix must not break the module-level case: a binding outside every test(...) block
  // has no enclosing span, so the search must still fall back to the whole file (same fallback the
  // elapsed-delta branch already uses for a top-level binding).
  const src = String.raw`
const sharedDeadline = Date.now() + 30_000;

test('waits using the shared deadline', () => {
  while (Date.now() < sharedDeadline) {
    if (probe()) break;
  }
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — a NAMED-CONSTANT elapsed ceiling is caught, not just a bare numeric literal', () => {
  // Review finding: elapsedCeilingCompareRx only matched a bare numeric literal ceiling. Confirmed
  // real corpus miss: landing-queue-watch.test.mjs:1943 has `elapsed < PREP_MS / 2`.
  const bare = String.raw`
test('finishes before half the prep budget', () => {
  const start = process.hrtime.bigint();
  runIt();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < PREP_MS);
});
`;
  assert.deepEqual(kinds(bare), ['ambient-load-elapsed-ceiling']);

  const arithmetic = String.raw`
test('finishes before half the prep budget', () => {
  const start = process.hrtime.bigint();
  runIt();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < PREP_MS / 2);
});
`;
  assert.deepEqual(kinds(arithmetic), ['ambient-load-elapsed-ceiling']);

  const scaled = String.raw`
test('finishes before double some named budget', () => {
  const start = process.hrtime.bigint();
  runIt();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < SOME_MS * 2);
});
`;
  assert.deepEqual(kinds(scaled), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — exponent-notation literal ceilings are still caught', () => {
  const src = String.raw`
test('finishes fast', () => {
  const start = process.hrtime.bigint();
  runIt();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < 1e4);
});
`;
  assert.deepEqual(kinds(src), ['ambient-load-elapsed-ceiling']);
});

test('shape 7b — a FLOOR comparison against a named constant is still NOT flagged', () => {
  // The `>`/`>=` FLOOR exclusion must survive the RHS widening — a named-constant floor is exactly
  // as load-immune as a literal one.
  const src = String.raw`
test('takes at least the grace period', () => {
  const started = Date.now();
  killAndWait();
  assert.ok(Date.now() - started >= GRACE_MS, 'force kill should follow the named grace period');
});
`;
  assert.deepEqual(kinds(src), []);
});

test('shape 7b — a Date.now()-deadline violation is reported at the COMPARISON line, and diff-scoping sees an added comparison over a pre-existing binding', () => {
  // Review finding: the violation used to be anchored ONLY at the binding line, so a diff whose
  // only new line was the COMPARISON (the binding pre-existing) matched nothing in `texts` and the
  // diff-scoped gate reported clean. Mirror shape 6's two-direction diff-scoping tests.
  const src = String.raw`
const dir = mkdtempSync(join(tmpdir(), 'x-'));

test('waits for the child to appear', () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (probe()) break;
  }
});
`;
  const found = analyze(src);
  const hit = found.find((v) => v.kind === 'ambient-load-elapsed-ceiling');
  assert.ok(hit, 'expected an ambient-load-elapsed-ceiling violation');
  assert.match(hit.text, /while \(Date\.now\(\) < deadline\)/);

  // Only the comparison line is "added" — the binding is pre-existing context.
  const addedComparisonOnly = new Set(['while (Date.now() < deadline) {']);
  assert.equal(violationsIntroduced(src, addedComparisonOnly).length, 1);

  // The mirror case — only the binding is "added", the comparison pre-existing — still counts.
  const addedBindingOnly = new Set(['const deadline = Date.now() + 30_000;']);
  assert.equal(violationsIntroduced(src, addedBindingOnly).length, 1);

  // A range that added neither blocks nothing.
  assert.equal(violationsIntroduced(src, new Set(['// unrelated'])).length, 0);
});

// ── Python shapes (plan 2853): acceptance ──────────────────────────────────────
//
// plan 3958: this module ships as-is into the public coord-kit, whose freshly-initialized git
// history carries none of vetapp's own commits — the pre-fix/post-fix corpus file below used to
// be read via `git show ad556d0812^:...`/`git show ad556d0812:...`, pinned to a specific vetapp
// commit SHA that cannot exist in any other repo's history. Copied here verbatim instead (same
// "copied rather than read from the tree" precedent as the test_lib_detached.py fixture further
// down this file) — a COOKED template literal, not this file's usual String.raw, because the
// fixture's own docstring/comments contain literal backticks that String.raw cannot represent
// without leaking a stray backslash; the source has no other backslash escapes, so cooked-mode
// processing changes nothing else.

test('shape 4/5 acceptance — the verbatim PRE-fix test_pp_proc.py flags all three symbols', () => {
  const pre = `"""Unit tests for _pp_proc.kill_tree (plan 2809, F-059).

\`kill_tree\` is the single-owned process-tree kill every LLM transport in this
dir now imports instead of keeping its own private \`_kill_tree\` copy. Covers
the POSIX \`killpg\` path, both failure modes it must swallow (a
\`ProcessLookupError\` and an arbitrary \`Exception\`), the win32 \`taskkill\`
fallback, and a source-text regression check that no private copy has crept
back into the four adopting transport modules. No real subprocess is spawned —
everything is monkeypatched, so this stays hermetic and fast.
"""
from __future__ import annotations

import signal
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import _pp_proc  # noqa: E402


class _FakeProc:
    def __init__(self, pid: int):
        self.pid = pid


def test_posix_kill_tree_calls_killpg_with_process_group_and_sigkill(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    calls = {}

    def fake_getpgid(pid):
        calls["getpgid_pid"] = pid
        return 4242

    def fake_killpg(pgid, sig):
        calls["killpg_args"] = (pgid, sig)

    monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)
    monkeypatch.setattr(_pp_proc.os, "killpg", fake_killpg)

    _pp_proc.kill_tree(_FakeProc(pid=999))

    assert calls["getpgid_pid"] == 999
    assert calls["killpg_args"] == (4242, signal.SIGKILL)


def test_posix_process_lookup_error_is_swallowed(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(_pp_proc.os, "getpgid", lambda pid: 1)

    def raising_killpg(pgid, sig):
        raise ProcessLookupError("already gone")

    monkeypatch.setattr(_pp_proc.os, "killpg", raising_killpg)

    # Must not raise.
    _pp_proc.kill_tree(_FakeProc(pid=1))


def test_arbitrary_exception_is_swallowed(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")

    def raising_getpgid(pid):
        raise RuntimeError("boom")

    monkeypatch.setattr(_pp_proc.os, "getpgid", raising_getpgid)

    # Must not raise, even for a failure mode unrelated to the process being gone.
    _pp_proc.kill_tree(_FakeProc(pid=1))


def test_win32_branch_shells_out_to_taskkill(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    calls = {}

    def fake_run(argv, **kwargs):
        calls["argv"] = argv
        calls["kwargs"] = kwargs

        class _Result:
            returncode = 0

        return _Result()

    monkeypatch.setattr(_pp_proc.subprocess, "run", fake_run)

    _pp_proc.kill_tree(_FakeProc(pid=1234))

    assert calls["argv"] == ["taskkill", "/F", "/T", "/PID", "1234"]
    assert calls["kwargs"]["capture_output"] is True
    assert calls["kwargs"]["check"] is False
    assert calls["kwargs"]["creationflags"] == _pp_proc.NO_WINDOW


_ADOPTING_MODULES = [
    "lib_codex_transport.py",
    "lib_opencode.py",
    "lib_agy.py",
    "lib_claude_transport.py",
]


def test_adopters_import_shared_kill_tree_and_no_private_copy_survives():
    for name in _ADOPTING_MODULES:
        text = (SCRIPT_DIR / name).read_text(encoding="utf-8")
        assert "from _pp_proc import kill_tree as _kill_tree" in text, (
            f"{name} does not import the shared kill_tree"
        )
        assert "def _kill_tree(" not in text, (
            f"{name} still carries a private _kill_tree definition"
        )


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
`;
  const found = analyzePython(pre);
  const symbols = found.map((v) => v.detail.split(' — ')[0].replace(/^import /, ''));
  assert.ok(symbols.includes('os.getpgid'), symbols.join(', '));
  assert.ok(symbols.includes('os.killpg'), symbols.join(', '));
  assert.ok(symbols.includes('signal.SIGKILL'), symbols.join(', '));
  assert.ok(
    found.every((v) =>
      ['py-unguarded-platform-setattr', 'py-uncovered-platform-symbol'].includes(v.kind),
    ),
  );
});

test('shape 4/5 acceptance — the verbatim POST-fix test_pp_proc.py analyzes clean', () => {
  const post = `"""Unit tests for _pp_proc.kill_tree (plan 2809, F-059).

\`kill_tree\` is the single-owned process-tree kill every LLM transport in this
dir now imports instead of keeping its own private \`_kill_tree\` copy. Covers
the POSIX \`killpg\` path, both failure modes it must swallow (a
\`ProcessLookupError\` and an arbitrary \`Exception\`), the win32 \`taskkill\`
fallback, and a source-text regression check that no private copy has crept
back into the four adopting transport modules. No real subprocess is spawned —
everything is monkeypatched, so this stays hermetic and fast.
"""
from __future__ import annotations

import signal
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import _pp_proc  # noqa: E402


class _FakeProc:
    def __init__(self, pid: int):
        self.pid = pid


def test_posix_kill_tree_calls_killpg_with_process_group_and_sigkill(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    calls = {}

    def fake_getpgid(pid):
        calls["getpgid_pid"] = pid
        return 4242

    def fake_killpg(pgid, sig):
        calls["killpg_args"] = (pgid, sig)

    # raising=False: os.getpgid/killpg and signal.SIGKILL are POSIX-only
    # attributes, absent entirely on a Windows CI/dev host — without this,
    # \`kill_tree\`'s bare \`except Exception: pass\` silently swallows the
    # resulting AttributeError and \`fake_killpg\` is never reached, which the
    # assertion below would report as a bare KeyError, not the real cause.
    monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid, raising=False)
    monkeypatch.setattr(_pp_proc.os, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)

    _pp_proc.kill_tree(_FakeProc(pid=999))

    assert calls["getpgid_pid"] == 999
    assert calls["killpg_args"] == (4242, signal.SIGKILL)


def test_posix_process_lookup_error_is_swallowed(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(_pp_proc.os, "getpgid", lambda pid: 1, raising=False)

    def raising_killpg(pgid, sig):
        raise ProcessLookupError("already gone")

    monkeypatch.setattr(_pp_proc.os, "killpg", raising_killpg, raising=False)

    # Must not raise.
    _pp_proc.kill_tree(_FakeProc(pid=1))


def test_arbitrary_exception_is_swallowed(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")

    def raising_getpgid(pid):
        raise RuntimeError("boom")

    monkeypatch.setattr(_pp_proc.os, "getpgid", raising_getpgid, raising=False)

    # Must not raise, even for a failure mode unrelated to the process being gone.
    _pp_proc.kill_tree(_FakeProc(pid=1))


def test_win32_branch_shells_out_to_taskkill(monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    calls = {}

    def fake_run(argv, **kwargs):
        calls["argv"] = argv
        calls["kwargs"] = kwargs

        class _Result:
            returncode = 0

        return _Result()

    monkeypatch.setattr(_pp_proc.subprocess, "run", fake_run)

    _pp_proc.kill_tree(_FakeProc(pid=1234))

    assert calls["argv"] == ["taskkill", "/F", "/T", "/PID", "1234"]
    assert calls["kwargs"]["capture_output"] is True
    assert calls["kwargs"]["check"] is False
    assert calls["kwargs"]["creationflags"] == _pp_proc.NO_WINDOW


_ADOPTING_MODULES = [
    "lib_codex_transport.py",
    "lib_opencode.py",
    "lib_agy.py",
    "lib_claude_transport.py",
]


def test_adopters_import_shared_kill_tree_and_no_private_copy_survives():
    for name in _ADOPTING_MODULES:
        text = (SCRIPT_DIR / name).read_text(encoding="utf-8")
        assert "from _pp_proc import kill_tree as _kill_tree" in text, (
            f"{name} does not import the shared kill_tree"
        )
        assert "def _kill_tree(" not in text, (
            f"{name} still carries a private _kill_tree definition"
        )


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
`;
  assert.deepEqual(analyzePython(post), []);
});

// Verbatim from the project's data pipeline test_lib_detached.py (lines 32-41 as of
// 2026-08-05) — the one other real corpus file that fakes the platform. Copied rather than READ
// from the tree on purpose: select-battery-tests.test.mjs fails any battery test that reads a
// real-tree path no EXTERNAL_TREE_PREFIXES entry covers, and covering `backend/scripts/` would
// both bail every backend-Python delta to the full battery and drag 768 files into the
// battery-pass-cache key (that list is dual-purpose — keyedPaths imports it). Re-check against the
// real file if this ever looks stale.
test('test_lib_detached.py\'s real monkeypatch.setattr(lib.os, "name", "nt", raising=False) shape analyzes clean', () => {
  const real = String.raw`
def test_pid_alive_tasklist_timeout_reads_alive(monkeypatch):
    # Every probe times out → we could not ASK → assume alive (a False here
    # would spawn a concurrent duplicate child).
    monkeypatch.setattr(lib.os, "name", "nt", raising=False)

    def _always_timeout(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="tasklist", timeout=kw.get("timeout", 15))

    monkeypatch.setattr(lib.subprocess, "run", _always_timeout)
    assert lib.pid_alive(4242) is True
`;
  assert.deepEqual(analyzePython(real), []);
});

// ── Python shapes: shape 4 (py-unguarded-platform-setattr) ────────────────────

test('shape 4 — monkeypatch.setattr(lib.subprocess, "run", ...) without raising=False is NOT flagged (run exists everywhere)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(lib.subprocess, "run", _always_timeout)
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 4 — both-platforms trap: signal.SIGTERM and os.kill are never flagged even bare and unguarded', () => {
  const setattrSrc = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(os, "kill", fake_kill)
    monkeypatch.setattr(signal, "SIGTERM", 15)
`;
  assert.deepEqual(analyzePython(setattrSrc), []);
  const refSrc = String.raw`
def test_x():
    assert os.kill(pid, signal.SIGTERM) is None
`;
  assert.deepEqual(analyzePython(refSrc), []);
});

test('shape 4 — the dotted-string setattr form is caught the same as the member-expression form', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr("os.getpgid", fake_getpgid)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
  assert.match(found[0].detail, /os\.getpgid — POSIX-only/);
});

test('shape 4 — mirror direction: a Windows-only subprocess attribute without raising=False is flagged', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", 0)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
  assert.match(found[0].detail, /subprocess\.CREATE_NO_WINDOW — Windows-only — absent on Linux/);
});

test('shape 4 — a multi-line / wrapped monkeypatch.setattr is judged as one call', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(
        _pp_proc.os,
        "getpgid",
        fake_getpgid,
    )
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
  assert.ok(found[0].endLine > found[0].line);

  const covered = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(
        _pp_proc.os,
        "getpgid",
        fake_getpgid,
        raising=False,
    )
`;
  assert.deepEqual(analyzePython(covered), []);
});

// ── Python shapes: shape 5 (py-uncovered-platform-symbol) ─────────────────────

test('shape 5 — a local variable named `grp` is NOT flagged; `import grp` IS', () => {
  // Real corpus shape: test_2223_twin_fold_engine.py:252 has a local var literally named `grp`.
  const localVar = String.raw`
def test_x():
    grp = compute_group(rows)
    assert grp[0] == "a"
`;
  assert.deepEqual(analyzePython(localVar), []);

  const importGrp = String.raw`
import grp

def test_x():
    assert grp.getgrnam("wheel")
`;
  const found = analyzePython(importGrp);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import grp — POSIX-only — absent on Windows/);
});

test('shape 5 — mirror direction: a bare signal.CTRL_BREAK_EVENT reference with no cover is flagged', () => {
  const src = String.raw`
def test_x():
    os.kill(pid, signal.CTRL_BREAK_EVENT)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.CTRL_BREAK_EVENT — Windows-only — absent on Linux/);
});

test('shape 5 — a dotted prefix on the reference is still caught (_pp_proc.os.getpgid)', () => {
  const src = String.raw`
def test_x():
    assert _pp_proc.os.getpgid(1) == 1
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /os\.getpgid/);
});

test('shape 5 — each cover idiom individually clears a reference', () => {
  const bySetattr = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(bySetattr), []);

  const bySkipif = String.raw`
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only")
def test_x():
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(bySkipif), []);

  const byPytestmark = String.raw`
pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX-only")

def test_x():
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(byPytestmark), []);

  const byImportorskip = String.raw`
fcntl = pytest.importorskip("fcntl")

def test_x():
    import fcntl
    fcntl.flock(0, 0)
`;
  assert.deepEqual(analyzePython(byImportorskip), []);

  const byGetattrGuard = String.raw`
def test_x():
    fn = getattr(os, "getpgid", None)
    assert fn is not None
    assert os.getpgid(1) == 1
`;
  assert.deepEqual(analyzePython(byGetattrGuard), []);
});

test('shape 5 — without any cover, the reference is flagged', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert expected == signal.SIGKILL
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
});

// ── Python shapes: waivers ──────────────────────────────────────────────────────

test('shape 5 — a `#`-comment waiver clears the reference, on the line or the line above', () => {
  const onLine = String.raw`
def test_x():
    assert expected == signal.SIGKILL  # path-assert-ok: byte-identical constant, deliberate
`;
  const above = String.raw`
def test_x():
    # platform-assert-ok: byte-identical constant, deliberate
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(onLine), []);
  assert.deepEqual(analyzePython(above), []);
});

test('shape 5 — a bare waiver marker with no reason does NOT waive', () => {
  const src = String.raw`
def test_x():
    assert expected == signal.SIGKILL  # path-assert-ok:
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
});

test('shape 4 — the `platform-assert-ok` alias waives a setattr the same as `path-assert-ok`', () => {
  const src = String.raw`
def test_x(monkeypatch):
    # platform-assert-ok: this must fail loudly on Windows, not fall back
    monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)
`;
  assert.deepEqual(analyzePython(src), []);
});

// ── Python shapes: review-driven refinements (plan 2853 code review, 2026-08-05) ──

test('shape 5 — a platform symbol MENTIONED IN A COMMENT is not a live reference (a171fb)', () => {
  const src = String.raw`
def test_x():
    value = 1  # signal.SIGKILL is unavailable on Windows
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — a `#` inside a STRING LITERAL is not mistaken for a comment start', () => {
  // If the comment boundary were found on the raw line instead of the string-blanked view, the `#`
  // inside `"#"` would truncate the line right after it, silently dropping the real `os.getpgid`
  // reference that follows on the SAME line.
  const src = String.raw`
def test_x():
    x = "#" + str(os.getpgid(1))
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /os\.getpgid/);
});

test('shape 4 — a file-level pytest.mark.skipif cover exempts an unguarded setattr too (b72cae)', () => {
  const src = String.raw`
@pytest.mark.skipif(os.name == "nt", reason="POSIX-only")
def test_x(monkeypatch):
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — `from signal import SIGKILL` is itself flagged (Python imports eagerly) (a048d9)', () => {
  const src = String.raw`
from signal import SIGKILL

def test_x():
    pass
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.SIGKILL — POSIX-only/);
});

test('shape 5 — a LATER bare use of a from-imported name is ALSO tracked (dbe6d7)', () => {
  const src = String.raw`
from os import getpgid

def test_x():
    assert getpgid(1) == 1
`;
  const found = analyzePython(src);
  // Both the import statement itself (Python fails on the missing symbol eagerly) and the later
  // bare use are real, distinct failure points; the gate reports each once.
  assert.equal(found.length, 2);
  assert.ok(found.every((v) => v.kind === 'py-uncovered-platform-symbol'));
  assert.ok(found.every((v) => /os\.getpgid — POSIX-only/.test(v.detail)));
});

test('shape 5 — a cover for a from-imported symbol suppresses BOTH the import and later uses', () => {
  const src = String.raw`
from os import getpgid

def test_x(monkeypatch):
    monkeypatch.setattr(os, "getpgid", getpgid, raising=False)
    assert getpgid(1) == 1
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — `import os as _os` / `import signal as _signal` aliases are matched (eb6606)', () => {
  // Verbatim shape from the real corpus (backend/scripts/booking-repilot/intl-stage6-sweep.py).
  const src = String.raw`
import os as _os
import signal as _signal

def test_x():
    _os.killpg(1, _signal.SIGKILL)
`;
  const found = analyzePython(src);
  const details = found.map((v) => v.detail);
  assert.ok(
    details.some((d) => /os\.killpg — POSIX-only/.test(d)),
    details.join(', '),
  );
  assert.ok(
    details.some((d) => /signal\.SIGKILL — POSIX-only/.test(d)),
    details.join(', '),
  );
});

test('shape 5 — arbitrary alias names (sig, operating_system) are matched too', () => {
  const src = String.raw`
import signal as sig
import os as operating_system

def test_x():
    assert expected == sig.SIGKILL
    operating_system.getpgid(1)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 2);
  assert.ok(found.some((v) => /signal\.SIGKILL/.test(v.detail)));
  assert.ok(found.some((v) => /os\.getpgid/.test(v.detail)));
});

test('shape 5 — aliasing an UNRELATED module creates no false alias match', () => {
  const src = String.raw`
import json as os_helper

def test_x():
    os_helper.dumps({})
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — from-import and alias forms respect the both-platforms trap (SIGTERM/os.kill)', () => {
  const src = String.raw`
from signal import SIGTERM
import os as _os

def test_x():
    assert expected == SIGTERM
    _os.kill(1, 15)
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — a getattr/hasattr guard in ONE function does NOT cover an unguarded use in ANOTHER (c49a16)', () => {
  const src = String.raw`
def test_probe():
    fn = getattr(os, "getpgid", None)
    assert fn is not None

def test_unguarded_use():
    os.getpgid(1)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /os\.getpgid/);
});

test('shape 4/5 — an unguarded setattr is not ALSO double-reported as a shape-5 reference on the same line (74f4f2)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(os, "getpgid", os.getpgid)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
});

test('shape 4/5 — the same symbol on a DIFFERENT line still reports separately', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
    assert os.getpgid is not None
`;
  const found = analyzePython(src);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((v) => v.kind).sort(), [
    'py-uncovered-platform-symbol',
    'py-unguarded-platform-setattr',
  ]);
});

test('shape 5 — a getattr/hasattr guard MENTIONED IN A COMMENT or STRING is not a real cover (ea084a)', () => {
  const commentCase = String.raw`
def test_x():
    # getattr(os, "getpgid", None) documented here for reference only
    os.getpgid(1)
`;
  const foundComment = analyzePython(commentCase);
  assert.equal(foundComment.length, 1);
  assert.equal(foundComment[0].kind, 'py-uncovered-platform-symbol');

  const stringCase = String.raw`
def test_x():
    doc = "getattr(os, 'getpgid', None)"
    os.getpgid(1)
`;
  const foundString = analyzePython(stringCase);
  assert.equal(foundString.length, 1);
  assert.equal(foundString[0].kind, 'py-uncovered-platform-symbol');
});

test('shape 5 — an importorskip mentioned only in a comment does not cover a real import (ea084a)', () => {
  const src = String.raw`
# pytest.importorskip("fcntl") is what the OLD version of this test did
import fcntl
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import fcntl/);
});

// THIRD REVIEW PASS (2026-08-05) — triple-quoted string tracking (finding 5cdd5f).

test('shape 5 — a triple-quoted DOCSTRING example does not counterfeit a real importorskip cover (5cdd5f)', () => {
  const src = String.raw`
def test_x():
    """
    Old approach: fcntl = pytest.importorskip("fcntl")
    """
    import fcntl
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import fcntl/);
});

// ROUND 3 — import detection reads the string-blanked view, not the raw line (finding: the
// round-3 cross-line triple-quote scanner above blanked strings for every OTHER structural
// detector, but import detection still scanned `lines[i]` directly — so a docstring LINE that
// itself happened to read like an import statement (`import fcntl`, `from signal import
// SIGKILL`) was misread as a real one, a false positive on a gate that blocks pushes).

test('shape 5 — a triple-quoted DOCSTRING line reading `import fcntl` is not mistaken for a real import', () => {
  const src = String.raw`
def test_x():
    """
    import fcntl
    """
    pass
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — a triple-quoted DOCSTRING line reading `from signal import SIGKILL` is not mistaken for a real import', () => {
  const src = String.raw`
def test_x():
    """
    from signal import SIGKILL
    """
    pass
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — a real `import fcntl` outside any string is still flagged (regression guard for the docstring fix above)', () => {
  const src = String.raw`
def test_x():
    """
    import fcntl
    """
    import fcntl
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import fcntl/);
});

test('shape 4 — a triple-quoted DOCSTRING example does not counterfeit a real raising=False cover (5cdd5f)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    """
    Old approach: monkeypatch.setattr(os, "getpgid", fake, raising=False)
    """
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
});

test('shape 5 — a self-closing single-line triple-quoted string does not swallow the code after it (5cdd5f)', () => {
  const src = String.raw`
def test_x():
    doc = """a one-line docstring"""
    os.getpgid(1)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /os\.getpgid/);
});

// THIRD REVIEW PASS — importorskip scoping + tokenized-argument reading (findings 0a0dfa/6e44cf).

test('shape 5 — a test-local importorskip does NOT cover an unguarded import in a DIFFERENT test (0a0dfa)', () => {
  const src = String.raw`
def test_a():
    fcntl = pytest.importorskip("fcntl")
    fcntl.flock(0, 0)

def test_b():
    import fcntl
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import fcntl/);
});

test('shape 5 — a test-local importorskip DOES cover an unguarded import in the SAME test (0a0dfa)', () => {
  const src = String.raw`
def test_a():
    pytest.importorskip("fcntl")
    import fcntl
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — a skipif REASON string merely mentioning "sys.platform" does not counterfeit a cover when the CONDITION is False (6e44cf)', () => {
  const src = String.raw`
@pytest.mark.skipif(False, reason="sys.platform is irrelevant here")
def test_x():
    assert expected == signal.SIGKILL
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.SIGKILL/);
});

test('shape 5 — a skipif whose CONDITION genuinely mentions sys.platform still covers (6e44cf regression guard)', () => {
  const src = String.raw`
@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only, nothing to do with a string")
def test_x():
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(src), []);
});

// THIRD REVIEW PASS — a runtime pytest.skip(...) only covers FROM its own line onward (finding 229495).

test('shape 4 — a runtime pytest.skip(...) does NOT cover an access that runs BEFORE it (229495)', () => {
  const src = String.raw`
def test_a(monkeypatch):
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
    pytest.skip("POSIX-only per sys.platform check")
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
});

test('shape 4 — a runtime pytest.skip(...) DOES cover an access that runs AFTER it (229495 regression guard)', () => {
  const src = String.raw`
def test_a(monkeypatch):
    pytest.skip("POSIX-only per sys.platform check")
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
`;
  assert.deepEqual(analyzePython(src), []);
});

// THIRD REVIEW PASS — comma-separated and semicolon-separated import parsing (findings 7d6735/63e8e3).

test('shape 5 — a comma-separated import reports EVERY platform-only module, not just the first (7d6735)', () => {
  const src = 'import fcntl, msvcrt\n';
  const found = analyzePython(src);
  assert.equal(found.length, 2);
  assert.equal(
    found.some((v) => /import fcntl/.test(v.detail)),
    true,
  );
  assert.equal(
    found.some((v) => /import msvcrt/.test(v.detail)),
    true,
  );
});

test('shape 5 — `import X as Y` still registers its alias when followed by `; <code>` on the same line (63e8e3)', () => {
  const src = 'import os as _os; _os.getpgid(1)\n';
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /os\.getpgid/);
});

test('shape 5 — a second `; import …` statement on the same line is ALSO parsed (63e8e3)', () => {
  const src = 'import os as o; import signal as sig\nsig.SIGKILL\n';
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.SIGKILL/);
});

// ── Python shapes: mechanics ─────────────────────────────────────────────────────

test('inScope: the Python test tree truth table', () => {
  assert.equal(inScope('backend/scripts/x/test_a.py'), true);
  assert.equal(inScope('backend/scripts/conftest.py'), true);
  assert.equal(inScope('backend/scripts/__tests__/_test_price_rows.py'), true);
  assert.equal(inScope('backend/scripts/data-pipeline/_pp_proc.py'), false);
  assert.equal(inScope('backend/src/foo.py'), false);
  // Existing JS cases unchanged.
  assert.equal(inScope('scripts/lock-path.test.mjs'), true);
  assert.equal(inScope('scripts/coord/lock-path.mjs'), false);
  assert.equal(inScope('backend/tests/foo.test.mjs'), false);
});

test('langFor: routes by extension', () => {
  assert.equal(langFor('backend/scripts/x/test_a.py'), 'py');
  assert.equal(langFor('scripts/lock-path.test.mjs'), 'js');
});

test('analyzeFor: dispatches to the right analyzer', () => {
  assert.deepEqual(
    analyzeFor('scripts/x.test.mjs', SHAPE_RAW_COMPARE).map((v) => v.kind),
    ['unnormalized-path-compare'],
  );
  const py = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)
`;
  assert.deepEqual(
    analyzeFor('backend/scripts/x/test_a.py', py).map((v) => v.kind),
    ['py-unguarded-platform-setattr'],
  );
});

test('violationsIntroduced: lang "py" routes through analyzePython', () => {
  const src = String.raw`
def test_x(monkeypatch):
    monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)
`;
  const added = new Set(['monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)']);
  const found = violationsIntroduced(src, added, 'py');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
  // The default (no third argument) still routes through the JS analyzer, unchanged.
  assert.deepEqual(
    violationsIntroduced(SHAPE_RAW_COMPARE, new Set(['assert.equal(fromWorktree, fromMain);'])).map(
      (v) => v.kind,
    ),
    ['unnormalized-path-compare'],
  );
});

// ── Python shapes: second review pass (plan 2853 round 2, 2026-08-05) ─────────

// Item 1: every scanner/cover detector routes through the same tokenized (comment-stripped,
// string-blanked) call-site view. Proved in BOTH directions per the round-2 brief.
test('shape 4 — a monkeypatch.setattr written inside a COMMENT is not a live call (round 2)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    # monkeypatch.setattr(os, "getpgid", fake_getpgid)
    pass
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 4 — a comment merely CONTAINING "raising=False" text does not silence a real violation (round 2)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    # some other call uses raising=False, this one deliberately does not
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
});

test('shape 4 — a fixture STRING containing a raising=False setattr example does not cover a real unguarded call (round 2)', () => {
  const src = String.raw`
def test_x(monkeypatch):
    doc = 'monkeypatch.setattr(os, "getpgid", fake, raising=False)'
    monkeypatch.setattr(os, "getpgid", fake_getpgid)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
});

test('shape 5 — an importorskip mentioned only in a STRING does not cover a real import (round 2)', () => {
  const src = String.raw`
doc = 'pytest.importorskip("fcntl")'

import fcntl
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /import fcntl/);
});

// Item 2: alias resolution is shared with the setattr-target resolver and the getattr/hasattr cover
// detector, and a comma-joined `import X as a, Y as b` populates the alias map for every piece.
test('shape 4 — an ALIASED setattr target is resolved the same as the canonical name (round 2)', () => {
  const unguarded = String.raw`
import os as _os

def test_x(monkeypatch):
    monkeypatch.setattr(_os, "getpgid", fake_getpgid)
`;
  const found = analyzePython(unguarded);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-unguarded-platform-setattr');
  assert.match(found[0].detail, /os\.getpgid/);

  const covered = String.raw`
import os as _os

def test_x(monkeypatch):
    monkeypatch.setattr(_os, "getpgid", fake_getpgid, raising=False)
    assert _os.getpgid(1) == 1
`;
  assert.deepEqual(analyzePython(covered), []);
});

test('shape 5 — a getattr guard through an ALIAS covers the aliased reference too (round 2)', () => {
  const src = String.raw`
import os as _os

def test_x():
    fn = getattr(_os, "getpgid", None)
    assert fn is not None
    assert _os.getpgid(1) == 1
`;
  assert.deepEqual(analyzePython(src), []);
});

test('shape 5 — comma-joined aliases (`import os as a, signal as b`) both resolve (round 2)', () => {
  const src = String.raw`
import os as a, signal as b

def test_x():
    a.getpgid(1)
    assert expected == b.SIGKILL
`;
  const found = analyzePython(src);
  assert.equal(found.length, 2);
  assert.ok(found.some((v) => /os\.getpgid/.test(v.detail)));
  assert.ok(found.some((v) => /signal\.SIGKILL/.test(v.detail)));
});

// Item 3: async def gets a real scope, and the INNERMOST enclosing function wins for nested defs.
test('shape 5 — async def is a real function scope, not span -1 (round 2)', () => {
  const src = String.raw`
async def test_x():
    os.getpgid(1)
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
});

test('shape 5 — a getattr guard in an OUTER function does not cover an unguarded use in a NESTED one (round 2)', () => {
  const src = String.raw`
def test_x():
    fn = getattr(os, "getpgid", None)
    assert fn is not None

    def inner():
        os.getpgid(1)

    inner()
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
});

test('shape 5 — a getattr guard covers a reference in the SAME nested function it sits in (round 2)', () => {
  const src = String.raw`
def test_x():
    def inner():
        fn = getattr(os, "getpgid", None)
        assert fn is not None
        os.getpgid(1)

    inner()
`;
  assert.deepEqual(analyzePython(src), []);
});

// Item 4: a parenthesised multi-line `from` import is tracked.
test('shape 5 — a parenthesised multi-line `from` import is tracked (round 2)', () => {
  const src = String.raw`
from signal import (
    SIGKILL,
)

def test_x():
    pass
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.SIGKILL — POSIX-only/);
});

// Item 5: a runtime pytest.skip(...) call is scoped to its enclosing function, not the whole file.
test('shape 5 — a runtime pytest.skip(...) inside one test covers ONLY that test, not the whole file (round 2)', () => {
  const src = String.raw`
def test_a():
    pytest.skip(f"POSIX-only per sys.platform check")
    os.getpgid(1)

def test_b():
    assert expected == signal.SIGKILL
`;
  const found = analyzePython(src);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'py-uncovered-platform-symbol');
  assert.match(found[0].detail, /signal\.SIGKILL/);
});

test('shape 5 — pytest.skip(...) OUTSIDE any function (module/collection-time) still covers the whole file (round 2)', () => {
  const src = String.raw`
pytest.skip(f"POSIX-only: sys.platform mismatch", allow_module_level=True)

def test_x():
    assert expected == signal.SIGKILL
`;
  assert.deepEqual(analyzePython(src), []);
});

// Item 6: the `--all` corpus walker agrees with `inScope`/the git pathspec on hidden directories —
// it must skip only the specific non-source directories, never every dot-directory wholesale (a
// blanket dot-skip would silently diverge from `inScope`/the `:(glob)` pathspec, which both admit a
// hidden directory the same as any other path segment).
test('the corpus-walker skip-set names specific directories, not a blanket dot-directory rule (round 2)', () => {
  assert.deepEqual([...CORPUS_SKIP_DIRS].sort(), ['.venv', '__pycache__', 'node_modules']);
  assert.equal(CORPUS_SKIP_DIRS.has('.hidden'), false);
  assert.equal(CORPUS_SKIP_DIRS.has('.github'), false);
  // …and `inScope` itself never special-cases a leading dot in the path either — a hidden directory
  // holding an otherwise in-scope test file is in scope.
  assert.equal(inScope('backend/scripts/.hidden/sub/test_a.py'), true);
  assert.equal(inScope('backend/scripts/.venv/test_a.py'), true); // inScope doesn't know about .venv;
  // CORPUS_SKIP_DIRS (the walker's OWN exclusion) is what keeps a real .venv out of --all, not inScope.
});

// ── plan 4005 round 2: block-comment backticks, and shape (7)'s advisory posture ───────────────

test('plan 4005 (46083f): an unmatched backtick in a BLOCK comment does not blind the rest of the file', () => {
  // Round 1 added a template-literal scanner so fixture bodies would stop reading as host code. It
  // handled `//` but not `/* … */`, so one unmatched backtick in ordinary block-comment prose opened
  // a template that never closed and every later line was skipped as "template interior" — the lint
  // silently stopped reporting. Measured on a probe file: 1 violation before, 0 after.
  const withBlockComment = [
    "import { test } from 'node:test';",
    '/* one unmatched backtick ` in a block comment */',
    "test('probe', () => {",
    '  const started = Date.now();',
    '  const elapsedMs = Date.now() - started;',
    '  if (elapsedMs < 5000) return;',
    '});',
  ].join('\n');
  const found = analyzeFor('scripts/probe.test.mjs', withBlockComment).filter(
    (v) => v.kind === 'ambient-load-elapsed-ceiling',
  );
  assert.equal(found.length, 1, 'the ceiling after the block comment must still be reported');
});

test('plan 4005: shape (7) findings are ADVISORY — they never make the gate exit non-zero', () => {
  const ambientOnly = new Map([
    ['scripts/a.test.mjs', [{ line: 3, kind: 'ambient-load-elapsed-ceiling', text: 'x < 10' }]],
    ['scripts/b.test.mjs', [{ line: 9, kind: 'ambient-load-freemem', text: 'os.freemem()' }]],
  ]);
  assert.equal(
    hasBlockingViolation(ambientOnly),
    false,
    'ambient-load findings alone must not block — see AMBIENT_LOAD_ADVISORY',
  );
  // A shape (1)-(6) finding in the SAME run still blocks, and carries the ambient one with it.
  const mixed = new Map([
    ...ambientOnly,
    ['scripts/c.test.mjs', [{ line: 1, kind: 'posix-path-assert', text: "'/tmp/x'" }]],
  ]);
  assert.equal(hasBlockingViolation(mixed), true, 'a path/symbol finding must still block');
});
