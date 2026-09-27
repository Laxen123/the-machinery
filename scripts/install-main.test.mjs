// scripts/install-main.test.mjs — unit tests for the pnpm virtual-store healer and its path-
// containment guard (plan 1869). Every fixture is a SYNTHETIC temp directory tree that mirrors the
// REAL on-disk layout verified against this worktree's own `node_modules/.pnpm/` (see
// install-main.mjs's file header): an entry's `node_modules/` links every OTHER dependency in as a
// symlink/junction and leaves exactly its OWN extracted package as a real directory. Nothing here
// touches the real store, runs `pnpm`, or hits the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  isPathContained,
  findOwnPackageDirs,
  isPackageJsonMissing,
  scanPnpmStore,
  healPnpmStore,
  emptyHealResult,
  shouldHeal,
  healOrSkip,
  postInstallVerify,
  installVerifyRetry,
  appendHealJournal,
  readHealJournal,
  repeatHealNotice,
  healedSetOf,
} from './install-main.mjs';
import { EXIT_TIMEOUT, EXIT_ERROR } from './coord/install-lock.mjs';
import { trackedMkdtempSync } from './test-helpers/tracked-tmpdir.mjs';
import { makeNoRepoRoot } from './test-helpers/no-repo-root.mjs';

// Plan 2365 T4: NOTHING in this suite ever removed the temp trees it created (confirmed: zero
// afterEach/cleanup), leaking a dir per fixture per run, unbounded, since the suite's inception —
// measured on the operator's real TEMP: 267 leaked `install-main-*` dirs.
//
// Review finding [3]: the first fix routed dirs through an OPT-IN `tmp()` wrapper while leaving the
// raw `node:fs` `mkdtempSync` imported, and two call sites (the `--root` CLI cases below) kept
// calling the raw one — so the suite still leaked while this comment claimed it did not. The name
// `mkdtempSync` is now SHADOWED by the shared tracking wrapper and dropped from the `node:fs` import
// above, so no call site can bypass tracking: the raw symbol is not in scope at all. `tmp()` remains
// as prefix sugar only. The wrapper + its one `after()` sweep live in
// `scripts/test-helpers/tracked-tmpdir.mjs` (review finding [5]) rather than being duplicated here
// and in install-lock.test.mjs.
const mkdtempSync = trackedMkdtempSync();
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const CLI = resolve(import.meta.dirname, 'install-main.mjs');

// Directory symlink helper — 'junction' on win32 (no admin privilege required, unlike a plain
// directory symlink there; matches how pnpm itself links dependencies on Windows), 'dir' on POSIX.
function linkDir(target, linkPath) {
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function writePkg(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'index.js'), '// stub');
}

// --- isPathContained (pure) ---------------------------------------------------

test('isPathContained: a path inside the parent is contained; a sibling with a shared PREFIX is not', () => {
  const root = tmp('contain-');
  const parent = join(root, '.pnpm');
  assert.equal(isPathContained(parent, join(parent, 'entry-a')), true);
  assert.equal(isPathContained(parent, parent), true); // the dir itself
  // The naive bug this guards: a raw string startsWith would wrongly admit ".pnpm-evil" as
  // "inside" ".pnpm" because the STRING happens to share a prefix.
  assert.equal(isPathContained(parent, join(root, '.pnpm-evil', 'entry')), false);
  assert.equal(isPathContained(parent, join(root, 'elsewhere')), false);
});

test('isPathContained: case/slash-insensitive on win32, case-sensitive on POSIX', () => {
  const root = tmp('contain-case-');
  const parent = join(root, '.pnpm');
  if (process.platform === 'win32') {
    assert.equal(isPathContained(parent.toUpperCase(), join(parent, 'entry-a')), true);
  } else {
    assert.equal(isPathContained(parent.toUpperCase(), join(parent, 'entry-a')), false);
  }
});

// --- findOwnPackageDirs (verified real layout) --------------------------------

test('findOwnPackageDirs: finds the real (non-symlink) scoped package beside symlinked siblings', () => {
  const root = tmp('own-dirs-');
  const nm = join(root, 'entry', 'node_modules');
  // The entry's OWN package: a real directory at @scope/pkg.
  writePkg(join(nm, '@scope', 'pkg'), '@scope/pkg');
  // A symlinked DEPENDENCY beside it — must never be reported as the entry's own package.
  const elsewhere = join(root, 'elsewhere-real', '@scope', 'other');
  writePkg(elsewhere, '@scope/other');
  linkDir(elsewhere, join(nm, '@scope', 'other-linked'));

  assert.deepEqual(findOwnPackageDirs(nm), ['@scope/pkg']);
});

test('findOwnPackageDirs: unscoped real package beside a symlinked unscoped dependency', () => {
  const root = tmp('own-dirs-unscoped-');
  const nm = join(root, 'entry', 'node_modules');
  writePkg(join(nm, 'pkg-real'), 'pkg-real');
  const elsewhere = join(root, 'elsewhere-real', 'pkg-linked');
  writePkg(elsewhere, 'pkg-linked');
  linkDir(elsewhere, join(nm, 'pkg-linked'));

  assert.deepEqual(findOwnPackageDirs(nm), ['pkg-real']);
});

test('findOwnPackageDirs: entirely-symlinked node_modules yields [] (not this corruption signature)', () => {
  const root = tmp('own-dirs-empty-');
  const nm = join(root, 'entry', 'node_modules');
  const elsewhere = join(root, 'elsewhere-real', 'pkg');
  writePkg(elsewhere, 'pkg');
  linkDir(elsewhere, join(nm, 'pkg-linked'));
  assert.deepEqual(findOwnPackageDirs(nm), []);
});

test('findOwnPackageDirs: a missing node_modules dir yields [] rather than throwing', () => {
  assert.deepEqual(findOwnPackageDirs(join(tmp('own-dirs-missing-'), 'nope')), []);
});

// Review finding [1]: a non-ENOENT readdirSync error on an entry's node_modules dir used to be
// rethrown uncaught, killing the scan of every OTHER entry too. A FILE where a directory is
// expected reliably (cross-platform, no chmod/permission tricks needed) produces ENOTDIR — a
// non-ENOENT error — exercising exactly that path.
test('findOwnPackageDirs: a non-ENOENT read error (node_modules is a FILE, not a dir) is skipped, never thrown', () => {
  const root = tmp('own-dirs-notdir-');
  const nmPath = join(root, 'entry', 'node_modules');
  mkdirSync(dirname(nmPath), { recursive: true });
  writeFileSync(nmPath, 'not actually a directory'); // readdirSync(nmPath) throws ENOTDIR
  const messages = [];
  assert.doesNotThrow(() => {
    const found = findOwnPackageDirs(nmPath, { log: (m) => messages.push(m) });
    assert.deepEqual(found, []);
  });
  assert.ok(messages.some((m) => /cannot read/.test(m)));
});

// Same bug class, at the top-level pnpm store dir (listEntryDirs, exercised via scanPnpmStore /
// healPnpmStore since listEntryDirs itself is not exported).
test('scanPnpmStore / healPnpmStore: a non-ENOENT read error on the store dir itself is skipped, never thrown', () => {
  const root = tmp('store-notdir-');
  const pnpmDirPath = join(root, '.pnpm');
  writeFileSync(pnpmDirPath, 'not actually a directory'); // readdirSync throws ENOTDIR, not ENOENT
  const messages = [];
  assert.doesNotThrow(() => {
    assert.deepEqual(scanPnpmStore(pnpmDirPath, { log: (m) => messages.push(m) }), []);
  });
  const result = healPnpmStore(pnpmDirPath, { dryRun: false, log: (m) => messages.push(m) });
  assert.deepEqual(result, { scanned: 0, corrupt: 0, healed: [] });
  assert.ok(messages.some((m) => /cannot read/.test(m)));
});

// --- isPackageJsonMissing (review finding [2]) --------------------------------

test('isPackageJsonMissing: a genuinely absent package.json (ENOENT) IS the corruption signature', () => {
  const root = tmp('pkgjson-enoent-');
  mkdirSync(root, { recursive: true });
  assert.equal(isPackageJsonMissing(join(root, 'package.json')), true);
});

test('isPackageJsonMissing: present package.json is healthy, never flagged', () => {
  const root = tmp('pkgjson-present-');
  writeFileSync(join(root, 'package.json'), '{}');
  assert.equal(isPackageJsonMissing(join(root, 'package.json')), false);
});

// The finding: `existsSync` returns false on ANY stat error, so an EPERM/EBUSY (AV/indexer lock)
// used to be misread as "missing" and the whole GOOD entry got deleted. Only ENOENT counts;
// anything else is conservatively treated as present/healthy. `_statSync` is injected so this is
// provoked deterministically rather than needing a real EPERM/EBUSY.
test('isPackageJsonMissing: a non-ENOENT stat error (EPERM/EBUSY) is NEVER treated as missing/corrupt', () => {
  const messages = [];
  const flaky = () => {
    const e = new Error('resource busy or locked');
    e.code = 'EBUSY';
    throw e;
  };
  const result = isPackageJsonMissing('/some/locked/package.json', {
    log: (m) => messages.push(m),
    _statSync: flaky,
  });
  assert.equal(result, false); // conservative: NOT corrupt
  assert.ok(messages.some((m) => /cannot stat/.test(m) && /EBUSY/.test(m)));
});

// --- scanPnpmStore / healPnpmStore --------------------------------------------

// Builds a synthetic .pnpm store with:
//   healthy-entry     — real own package, package.json present (must SURVIVE)
//   corrupt-scoped     — real own package dir present, package.json MISSING (scoped)
//   corrupt-unscoped   — same, unscoped
//   no-own-entry       — only a symlinked dependency, no own dir at all (NOT flagged)
function buildFixtureStore() {
  const root = tmp('pnpm-store-');
  const pnpmDir = join(root, '.pnpm');

  writePkg(join(pnpmDir, 'healthy-entry', 'node_modules', '@scope', 'good'), '@scope/good');

  mkdirSync(join(pnpmDir, 'corrupt-scoped', 'node_modules', '@scope', 'bad'), { recursive: true });
  writeFileSync(
    join(pnpmDir, 'corrupt-scoped', 'node_modules', '@scope', 'bad', 'index.js'),
    '// torn install: package.json never landed',
  );

  mkdirSync(join(pnpmDir, 'corrupt-unscoped', 'node_modules', 'bad-pkg'), { recursive: true });
  writeFileSync(
    join(pnpmDir, 'corrupt-unscoped', 'node_modules', 'bad-pkg', 'index.js'),
    '// torn install',
  );

  const elsewhere = join(root, 'elsewhere-real', 'linked-dep');
  writePkg(elsewhere, 'linked-dep');
  linkDir(elsewhere, join(pnpmDir, 'no-own-entry', 'node_modules', 'linked-dep'));

  return { root, pnpmDir };
}

test('scanPnpmStore: flags exactly the corrupt (own-dir-present, package.json-missing) entries', () => {
  const { pnpmDir } = buildFixtureStore();
  const corrupt = scanPnpmStore(pnpmDir)
    .map((c) => c.entry)
    .sort();
  assert.deepEqual(corrupt, ['corrupt-scoped', 'corrupt-unscoped']);
});

// ACCEPTANCE TEST 2 (the plan's own criterion): the healer removes a SYNTHETIC corrupt entry and a
// healthy sibling SURVIVES.
test('acceptance: healPnpmStore removes corrupt entries; the healthy sibling and the no-own entry survive', () => {
  const { pnpmDir } = buildFixtureStore();
  const messages = [];
  const result = healPnpmStore(pnpmDir, { dryRun: false, log: (m) => messages.push(m) });

  assert.deepEqual(result.healed.sort(), ['corrupt-scoped', 'corrupt-unscoped']);
  assert.equal(existsSync(join(pnpmDir, 'corrupt-scoped')), false);
  assert.equal(existsSync(join(pnpmDir, 'corrupt-unscoped')), false);
  // The healthy sibling survives WHOLE, package.json and all.
  assert.equal(
    existsSync(join(pnpmDir, 'healthy-entry', 'node_modules', '@scope', 'good', 'package.json')),
    true,
  );
  // An entry with no own directory at all is not this signature — untouched.
  assert.equal(existsSync(join(pnpmDir, 'no-own-entry')), true);
  assert.ok(messages.some((m) => /healing corrupt store entry "corrupt-scoped"/.test(m)));
});

test('healPnpmStore --dry: reports what would be healed, deletes NOTHING', () => {
  const { pnpmDir } = buildFixtureStore();
  const messages = [];
  const result = healPnpmStore(pnpmDir, { dryRun: true, log: (m) => messages.push(m) });
  assert.deepEqual(result.healed.sort(), ['corrupt-scoped', 'corrupt-unscoped']);
  // Nothing was actually removed — both corrupt entries are still present on disk.
  assert.equal(existsSync(join(pnpmDir, 'corrupt-scoped')), true);
  assert.equal(existsSync(join(pnpmDir, 'corrupt-unscoped')), true);
  assert.ok(messages.some((m) => /\[dry] would heal/.test(m)));
});

test('healPnpmStore: safe no-op when node_modules/.pnpm does not exist at all', () => {
  const root = tmp('no-pnpm-dir-');
  const result = healPnpmStore(join(root, 'node_modules', '.pnpm'), { dryRun: false });
  assert.deepEqual(result, { scanned: 0, corrupt: 0, healed: [] });
});

// Review finding [8]: `scanned` used to actually hold `corrupt.length` (a healthy run misread as
// "scanned nothing"). `scanned` is now the real top-level entry count; `corrupt` is the honest name
// for what used to squat in `scanned`.
test('healPnpmStore: `scanned` is the real entry count, `corrupt` is corrupt.length (finding [8])', () => {
  const { pnpmDir } = buildFixtureStore();
  const result = healPnpmStore(pnpmDir, { dryRun: false });
  // 4 top-level entries in the fixture: healthy-entry, corrupt-scoped, corrupt-unscoped, no-own-entry.
  assert.equal(result.scanned, 4);
  assert.equal(result.corrupt, 2);
  assert.equal(result.healed.length, 2);
});

test('healPnpmStore: a sibling dir that merely SHARES A STRING PREFIX with .pnpm is never scanned or touched', () => {
  const { root, pnpmDir } = buildFixtureStore();
  // ".pnpm-evil" sits next to the real ".pnpm" — a naive string startsWith could confuse the two;
  // scanPnpmStore/healPnpmStore must only ever touch the exact resolved pnpmDir passed in.
  mkdirSync(join(root, '.pnpm-evil', 'looks-corrupt', 'node_modules', 'bad'), { recursive: true });
  writeFileSync(join(root, '.pnpm-evil', 'looks-corrupt', 'node_modules', 'bad', 'index.js'), '');
  const result = healPnpmStore(pnpmDir, { dryRun: false });
  assert.deepEqual(result.healed.sort(), ['corrupt-scoped', 'corrupt-unscoped']);
  assert.equal(existsSync(join(root, '.pnpm-evil', 'looks-corrupt')), true); // never touched
});

// --- shouldHeal (review finding [0]) ------------------------------------------
//
// The CRITICAL bug: a non-zero acquire (timeout OR error OR the disable bypass) used to only log a
// warning and heal STILL RAN — exactly the path where a rival install may be live, so the healer
// could rmSync the rival's in-flight store entry. shouldHeal is the extracted, unit-testable
// decision main() now gates on (installed so a real 900s install-lock queue wait / a real pnpm
// spawn is never needed to exercise this).

test('shouldHeal: a genuinely ACQUIRED lock (code 0, not bypassed) allows healing', () => {
  const messages = [];
  assert.equal(shouldHeal({ code: 0 }, { log: (m) => messages.push(m) }), true);
  assert.deepEqual(messages, []); // no bypass — nothing extra to say
});

test('shouldHeal: INSTALL_LOCK_DISABLE=1 bypass (code 0, bypassed: true) ALSO allows healing, logged', () => {
  const messages = [];
  assert.equal(shouldHeal({ code: 0, bypassed: true }, { log: (m) => messages.push(m) }), true);
  assert.ok(messages.some((m) => /INSTALL_LOCK_DISABLE=1/.test(m) && /healing anyway/.test(m)));
});

test('shouldHeal: a TIMED-OUT acquire (EXIT_TIMEOUT) SKIPS healing — a rival install may be live', () => {
  const messages = [];
  assert.equal(shouldHeal({ code: EXIT_TIMEOUT }, { log: (m) => messages.push(m) }), false);
  assert.ok(messages.some((m) => /SKIPPING the heal/.test(m) && /TIMEOUT/.test(m)));
});

test('shouldHeal: an ERRORED acquire (EXIT_ERROR) SKIPS healing too — distinct from disabled/bypassed', () => {
  const messages = [];
  assert.equal(shouldHeal({ code: EXIT_ERROR }, { log: (m) => messages.push(m) }), false);
  assert.ok(messages.some((m) => /SKIPPING the heal/.test(m) && /ERROR/.test(m)));
});

// --- healOrSkip (review finding [1]) ------------------------------------------

test('healOrSkip: delegates to healPnpmStore on the happy path', () => {
  const { pnpmDir } = buildFixtureStore();
  const result = healOrSkip(pnpmDir, {});
  assert.deepEqual(result.healed.sort(), ['corrupt-scoped', 'corrupt-unscoped']);
});

// The CRITICAL bug this closes: a heal-internal failure used to be able to prevent `pnpm install`
// from ever running — strictly worse than the bare `pnpm install` this script replaces. `_healPnpmStore`
// is injected so a throw is provoked deterministically (a real heal never throws after findings
// [1]/[2], so this exercises the defense-in-depth wrapper directly).
test('healOrSkip: a heal that THROWS is swallowed — never propagates, safe default returned', () => {
  const messages = [];
  const throwing = () => {
    throw new Error('boom — an unforeseen heal-internal bug');
  };
  let result;
  assert.doesNotThrow(() => {
    result = healOrSkip('/irrelevant/pnpm-dir', {
      log: (m) => messages.push(m),
      _healPnpmStore: throwing,
    });
  });
  assert.deepEqual(result, { scanned: 0, corrupt: 0, healed: [] });
  assert.ok(messages.some((m) => /heal step failed unexpectedly/.test(m) && /boom/.test(m)));
});

// --- emptyHealResult / scanPnpmStore _entries reuse (review findings [5]/[6], delta round) -------

test('emptyHealResult: a FRESH object/array on every call, never a shared mutable singleton', () => {
  const a = emptyHealResult();
  const b = emptyHealResult();
  assert.notEqual(a, b);
  assert.notEqual(a.healed, b.healed);
  a.healed.push('mutated');
  assert.deepEqual(b.healed, []); // mutating one call's result must never bleed into another's
});

test('scanPnpmStore: an injected _entries list is used instead of re-listing the store dir', () => {
  const { pnpmDir } = buildFixtureStore();
  // Passing ONLY one corrupt entry's name via _entries must scope the scan to exactly that entry —
  // proving the parameter is load-bearing (healPnpmStore's own single-read reuse), not silently
  // ignored in favor of a fresh internal listEntryDirs call over the whole store.
  const corrupt = scanPnpmStore(pnpmDir, { _entries: ['corrupt-scoped'] });
  assert.deepEqual(
    corrupt.map((c) => c.entry),
    ['corrupt-scoped'],
  );
});

// --- CLI: root validation (review finding [1], delta round) ----------------------------------

// install-main.mjs --root <bad> used to die with a raw unhandled stack trace (`e?.stack`) before
// `pnpm install` ever ran — violating this file's own FAIL-OPEN / never-wedge contract (a genuine
// caller/config error must fail cleanly, not crash loudly). This pins the clean, one-line,
// non-zero-exit replacement, checked before ANY lock/git work (never touches INSTALL_LOCK_DIR).
test('CLI: a nonexistent --root fails fast with ONE clean line, never a raw stack trace', () => {
  const parent = mkdtempSync(join(tmpdir(), 'install-main-noroot-'));
  const badRoot = join(parent, 'does-not-exist');
  const out = spawnSync(process.execPath, [CLI, '--root', badRoot], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /install-main: install root does not exist/);
  assert.equal(out.stderr.trim().split('\n').length, 1); // ONE line, no stack
});

// Review finding [1] (round 3) — REGRESSION FIXED: `--root` swallowing the next flag as its own
// value is ALSO an intentional/validation error (same bucket as a nonexistent root above) — it must
// be caught inline and print ONE clean line too, never reach the outer main().catch() as a raw
// exception.
test('CLI: --root immediately followed by another flag is REJECTED with ONE clean line, not a stack trace', () => {
  const out = spawnSync(process.execPath, [CLI, '--root', '--dry'], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /install-main: --root is missing its value/);
  assert.equal(out.stderr.trim().split('\n').length, 1); // ONE line, no stack
});

// Review finding [1] (round 3) — the other half of the regression fix: a GENUINELY unexpected
// failure (here, a real root that simply isn't inside any git repository — the install-lock mutex
// can't resolve a rendezvous dir for it) must surface via the OUTER main().catch() with its FULL
// stack, not get flattened to one clean line the way the previous round's blanket `e?.message ?? e`
// handler did. A real stack trace is multiple lines (the message + " at ..." frames); the
// intentional/validation errors above are pinned at exactly one line, so line-count is the
// discriminator between the two classes.
test('CLI: a genuinely unexpected error (root exists but is outside any git repo) prints the FULL stack via the outer catch', () => {
  // The outside-a-repo condition is BUILT, not hoped for (plan 3622). A bare
  // `mkdtempSync(join(tmpdir(), …))` is outside a repo only while the machine has no repo above
  // tmpdir(); with one there, install-main resolves a git common dir, gets all the way to pnpm,
  // and dies with ERR_PNPM_NO_PKG_MANIFEST on STDOUT — stderr empty, this test red, on a diff
  // that touched nothing near it. `makeNoRepoRoot` plants the barrier and asserts the condition.
  // `_mkdtempSync` is this suite's tracked shadow, so the root still rides the after() sweep.
  const root = makeNoRepoRoot('install-main-notgit-', { _mkdtempSync: mkdtempSync });
  const out = spawnSync(process.execPath, [CLI, '--root', root], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /install-main: unexpected error/);
  assert.match(out.stderr, /cannot resolve the shared \.git common dir/);
  assert.ok(
    out.stderr.trim().split('\n').length > 1,
    `expected a multi-line stack trace, got:\n${out.stderr}`,
  );
});

// --- postInstallVerify / appendHealJournal (plan 2198) -------------------------

// Build a minimal root: package.json (with/without deps), node_modules/.pnpm store (via the same
// synthetic layout the healer tests use), optional node_modules/.bin content.
function mkRoot({ deps = true, bins = ['tool.CMD'], tornEntry = false } = {}) {
  const root = tmp('verify-');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', devDependencies: deps ? { tool: '1.0.0' } : {} }),
  );
  const pnpm = join(root, 'node_modules', '.pnpm');
  const own = join(pnpm, 'tool@1.0.0', 'node_modules', 'tool');
  writePkg(own, 'tool');
  if (tornEntry) rmSync(join(own, 'package.json'));
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  for (const b of bins) writeFileSync(join(binDir, b), 'stub');
  return root;
}

test('postInstallVerify: healthy store + populated .bin verifies clean', () => {
  const root = mkRoot();
  const v = postInstallVerify(root, { log: () => {} });
  assert.equal(v.corrupt.length, 0);
  assert.equal(v.binEmpty, false);
});

test('postInstallVerify: a torn entry after install IS reported', () => {
  const root = mkRoot({ tornEntry: true });
  const v = postInstallVerify(root, { log: () => {} });
  assert.equal(v.corrupt.length, 1);
  assert.equal(v.corrupt[0].entry, 'tool@1.0.0');
});

test('postInstallVerify: deps declared but .bin missing/empty flags binEmpty (the 2026-07-21 gate-death signature)', () => {
  const root = mkRoot({ bins: [] });
  assert.equal(postInstallVerify(root, { log: () => {} }).binEmpty, true);
  rmSync(join(root, 'node_modules', '.bin'), { recursive: true, force: true });
  assert.equal(postInstallVerify(root, { log: () => {} }).binEmpty, true);
});

test('postInstallVerify: NO deps declared -> an absent .bin is legitimate, never flagged', () => {
  const root = mkRoot({ deps: false, bins: [] });
  rmSync(join(root, 'node_modules', '.bin'), { recursive: true, force: true });
  assert.equal(postInstallVerify(root, { log: () => {} }).binEmpty, false);
});

test('appendHealJournal: appends one JSON line per call, creates .scratch, and NEVER throws', () => {
  const root = tmp('journal-');
  appendHealJournal(root, { ts: 't1', healed: ['a@1'] }, { log: () => {} });
  appendHealJournal(root, { ts: 't2', healed: [] }, { log: () => {} });
  const lines = readFileSync(join(root, '.scratch', 'install-main-heals.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).ts, 't1');
  // unwritable journal path (root is a FILE) -> logged, not thrown
  const notADir = join(tmp('journal-bad-'), 'f');
  writeFileSync(notADir, 'x');
  const messages = [];
  appendHealJournal(join(notADir, 'nested'), { ts: 't3' }, { log: (m) => messages.push(m) });
  assert.ok(messages.some((m) => /could not write heal journal/.test(m)));
});

// --- installVerifyRetry (plan 2198 review findings [0]/[2]/[9]) ----------------

// Seam factory: a scripted verify sequence + counting heal/install fakes.
function fakeRun({ verifySeq, installCode = 0, elapsed = 0 }) {
  const calls = { installs: 0, heals: 0 };
  const p = installVerifyRetry({
    root: '/r',
    pnpmDir: '/r/node_modules/.pnpm',
    healAllowed: true,
    log: () => {},
    runInstall: async () => {
      calls.installs++;
      return { code: installCode, error: null };
    },
    elapsedMs: () => elapsed,
    _verify: () => verifySeq.shift(),
    _heal: () => {
      calls.heals++;
      return { scanned: 1, corrupt: 1, healed: ['torn@1.0.0'] };
    },
  });
  return p.then((r) => ({ ...r, calls }));
}

test('installVerifyRetry: clean verify -> no heal, no retry, exit 0', async () => {
  const r = await fakeRun({ verifySeq: [{ corrupt: [], binEmpty: false }] });
  assert.equal(r.code, 0);
  assert.equal(r.retried, false);
  assert.equal(r.calls.installs, 1);
  assert.equal(r.calls.heals, 0);
});

test('installVerifyRetry: corrupt after install -> ONE heal+reinstall, retryHealed captured, exit 0 when the retry fixes it', async () => {
  const r = await fakeRun({
    verifySeq: [
      { corrupt: [{ entry: 'torn@1.0.0' }], binEmpty: false },
      { corrupt: [], binEmpty: false },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.retried, true);
  assert.deepEqual(r.retryHealed, ['torn@1.0.0']); // finding [0]: no longer discarded
  assert.equal(r.calls.installs, 2);
  assert.equal(r.calls.heals, 1);
});

test('installVerifyRetry: STILL corrupt after the retry -> loud exit 3, never a silent 0', async () => {
  const torn = { corrupt: [{ entry: 'torn@1.0.0' }], binEmpty: false };
  const r = await fakeRun({ verifySeq: [torn, torn] });
  assert.equal(r.code, 3);
  assert.equal(r.retried, true);
});

test('installVerifyRetry: binEmpty alone post-retry never escalates (exit stays 0)', async () => {
  const r = await fakeRun({
    verifySeq: [
      { corrupt: [], binEmpty: true },
      { corrupt: [], binEmpty: true },
    ],
  });
  assert.equal(r.code, 0);
  assert.equal(r.retried, true);
});

test('installVerifyRetry: lock held past the retry budget -> retry SKIPPED (no heal, one install), corrupt still exits 3', async () => {
  const r = await fakeRun({
    verifySeq: [{ corrupt: [{ entry: 'torn@1.0.0' }], binEmpty: false }],
    elapsed: 11 * 60_000, // past the 10-min default budget
  });
  assert.equal(r.retrySkipped, 'stale-window');
  assert.equal(r.retried, false);
  assert.equal(r.calls.heals, 0);
  assert.equal(r.calls.installs, 1);
  assert.equal(r.code, 3);
});

test('installVerifyRetry: verify runs ONLY under held exclusivity (healAllowed=false skips it entirely)', async () => {
  let verified = 0;
  const r = await installVerifyRetry({
    root: '/r',
    pnpmDir: '/p',
    healAllowed: false,
    runInstall: async () => ({ code: 0, error: null }),
    _verify: () => {
      verified++;
      return { corrupt: [], binEmpty: false };
    },
  });
  assert.equal(verified, 0);
  assert.equal(r.code, 0);
  assert.equal(r.verify, null);
});

test('postInstallVerify: an UNREADABLE .bin (ENOTDIR — .bin is a file) is SUSPECT, not clean (finding [1])', () => {
  const root = mkRoot({ bins: [] });
  rmSync(join(root, 'node_modules', '.bin'), { recursive: true, force: true });
  writeFileSync(join(root, 'node_modules', '.bin'), 'not a dir');
  assert.equal(postInstallVerify(root, { log: () => {} }).binEmpty, true);
});

// ── plan 2401 task 5: the identical-set repeat-heal notice ─────────────────────────────────────
// The journal silently recorded 80 byte-identical 18-entry heals over 11 days; each session saw
// only its own "healed N entries" and moved on. Messaging only — heal/verify semantics untouched.

test('plan 2401: repeatHealNotice fires on an identical prior set, counting the priors', () => {
  const records = [
    { ts: '2026-07-21T16:26:38Z', healed: ['b@1', 'a@1'] },
    { ts: '2026-07-22T09:00:00Z', healed: ['a@1', 'b@1'] }, // order-insensitive match
    { ts: '2026-07-23T09:00:00Z', healed: ['a@1'] }, // different set — not counted
    { ts: '2026-07-23T10:00:00Z', retried: true }, // no healed field — skipped
  ];
  const notice = repeatHealNotice(records, ['b@1', 'a@1']);
  assert.ok(notice, 'an identical re-heal produces a notice');
  assert.match(notice, /heal #3 of the IDENTICAL 2-entry set/);
  assert.match(notice, /since 2026-07-21T16:26:38Z/, 'dates the recurrence from its first record');
  assert.match(notice, /plan 2401/, 'points the next reader at the root cause');
});

test('plan 2401: repeatHealNotice stays silent for a first-time or empty heal', () => {
  assert.equal(repeatHealNotice([], ['a@1']), null, 'no priors → no notice');
  assert.equal(
    repeatHealNotice([{ ts: 't', healed: ['x@1'] }], ['a@1']),
    null,
    'a different set is a new event, not a recurrence',
  );
  assert.equal(
    repeatHealNotice([{ ts: 't', healed: ['a@1'] }], []),
    null,
    'nothing healed → silent',
  );
  assert.equal(repeatHealNotice(null, ['a@1']), null, 'null records tolerated');
});

test('plan 2401: readHealJournal parses best-effort — bad lines and a missing file never throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'im-heal-journal-'));
  assert.deepEqual(readHealJournal(root), [], 'missing journal → []');
  mkdirSync(join(root, '.scratch'), { recursive: true });
  writeFileSync(
    join(root, '.scratch', 'install-main-heals.jsonl'),
    '{"ts":"t1","healed":["a@1"]}\nNOT-JSON\n{"ts":"t2","healed":["a@1"]}\n',
  );
  const records = readHealJournal(root);
  assert.equal(records.length, 2, 'the unparsable line is skipped, not fatal');
  // The journal-seeded dry run of the acceptance criterion: seeded records + the same set → #3.
  assert.match(repeatHealNotice(records, ['a@1']), /heal #3/);
});

test('plan 2401 review round 1: readHealJournal includes the rotated .1, oldest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'im-heal-rotated-'));
  mkdirSync(join(root, '.scratch'), { recursive: true });
  writeFileSync(
    join(root, '.scratch', 'install-main-heals.jsonl.1'),
    '{"ts":"t1","healed":["a@1"]}\n',
  );
  writeFileSync(
    join(root, '.scratch', 'install-main-heals.jsonl'),
    '{"ts":"t2","healed":["a@1"]}\n',
  );
  const records = readHealJournal(root);
  assert.deepEqual(
    records.map((r) => r.ts),
    ['t1', 't2'],
    'rotation must not reset the recurrence count — .1 records still count, oldest first',
  );
  assert.match(repeatHealNotice(records, ['a@1']), /heal #3/);
});

test('plan 2401 review round 1: a tear healed only in the RETRY round still matches (healedSetOf)', () => {
  const records = [
    { ts: 't1', healed: [], retryHealed: ['a@1', 'b@1'] }, // caught by post-install verify only
    { ts: 't2', healed: ['a@1'], retryHealed: ['b@1'] }, // split across the two rounds
  ];
  assert.deepEqual(healedSetOf(records[0]), ['a@1', 'b@1']);
  const notice = repeatHealNotice(records, healedSetOf({ healed: ['b@1'], retryHealed: ['a@1'] }));
  assert.ok(notice, 'the union set matches regardless of which round healed which entry');
  assert.match(notice, /heal #3 of the IDENTICAL 2-entry set/);
});
