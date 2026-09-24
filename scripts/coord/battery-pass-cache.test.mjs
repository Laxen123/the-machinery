// scripts/battery-pass-cache.test.mjs — unit + CLI tests for the pre-push battery pass-cache
// (plan 1824). Pure key/selection/entry logic, deriveKey against an injectable git fake, fs ops
// against temp dirs, and end-to-end CLI runs inside throwaway git repos (the cache rendezvous is
// `git rev-parse --git-common-dir`, so a real repo is needed for the CLI arm — battery-lock's
// pattern).
//
// The invariant every case defends: A FAILURE OR AN UNCERTAINTY IS NEVER CACHED, AND A CACHE
// PROBLEM NEVER SKIPS A BATTERY. Every refusal path (dirt, git error, expired/corrupt entry,
// key drift at record time, kill-switch) must land on MISS or UNCACHEABLE — exits the hook reads
// as "run the battery exactly as today". Only an exact, live, same-key pass may HIT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  CACHE_ARG_SPEC,
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  KEY_FORMAT_VERSION,
  UNIVERSAL_SELECTION,
  CORE_SCOPED_PREFIXES,
  scopedPrefixesFor,
  isUniversalSelection,
  selectionCovers,
  testReadsRealTreeSegment,
  reachableScopedPrefixes,
  deriveCanonicalSelection,
  keyedPaths,
  normalizeSelection,
  parseLsTree,
  computeKey,
  parseEntry,
  isLive,
  deriveKey,
  looksLikeOid,
  resolveMergeBaseOid,
  entryPath,
  readCacheEntry,
  writeCacheEntry,
  removeCacheEntry,
  pruneExpired,
  attributeMiss,
  closurePathsForSelection,
  gatherRepoState,
  universalKeyFor,
  gateLogicKey,
  GATE_LOGIC_PATH,
  GATE_LOGIC_PATHS,
  makeGit,
  keyForSelection,
} from './battery-pass-cache.mjs';
import {
  EXTERNAL_TREE_PREFIXES,
  DEFAULT_EXTERNAL_TREE_PREFIXES,
  REAL_TREE_JOIN_IDIOMS,
  repoRootAlt,
  isTestFile,
  makeReadSource,
} from './select-battery-tests.mjs';
const CLI = resolve(import.meta.dirname, 'battery-pass-cache.mjs');

// plan 4071 T2 / plan 3958: vetapp's own row (coord.config.json's `batteryScopedPrefixes`),
// merged with the core list. A fixed, portable literal — matching today's real vetapp value —
// rather than a live read of coord.config.json: the public coord-kit's own config carries no
// batteryScopedPrefixes at all, so a self-resolved read degrades to CORE_SCOPED_PREFIXES alone
// and every test below that exercises the vetapp-scoped ('backend/') behaviour goes stale.
const VETAPP_SCOPED_PREFIXES = scopedPrefixesFor(['backend/']);
// Same portability reasoning, for EXTERNAL_TREE_PREFIXES: it merges DEFAULT_EXTERNAL_TREE_PREFIXES
// (coord-kit-generic, so a safe live import) with coord.config.json's `externalTreePrefixes` row —
// today's real vetapp value, `['backend/']` — which the kit's own neutral config carries as `[]`.
// A test asserting vetapp's specific 'backend/' coverage needs this fixture, not the live import.
const VETAPP_EXTERNAL_TREE_PREFIXES = [...DEFAULT_EXTERNAL_TREE_PREFIXES, 'backend/'];
// The REAL scripts/ tree — the fixture source for the plan-2578 acceptance cases. Synthetic-only
// fixtures are what hid both of plan 2560's bugs, so the narrowing is pinned against live sources.
// A SYNTHETIC tree has no modules to resolve a computed-directory basename against, and saying so
// explicitly is how a fixture caller declares its reader is paired (plan 4085) — an unpaired
// reader makes closurePathsForSelection refuse to narrow rather than narrow unsoundly.
const FIXTURE_INDEX = new Map();

const REPO_SCRIPTS = import.meta.dirname;
const ISO = '2026-07-14T10:00:00.000Z';
const at = (min) => Date.parse(ISO) + min * 60000;

// git exports GIT_DIR/GIT_WORK_TREE into every hook subprocess; this suite RUNS inside the
// pre-push hook, so an inherited GIT_DIR would point our throwaway repos at the real one. Scrub,
// exactly as battery-lock.test.mjs does — plus the cache's own kill-switches, which a developer
// shell (or the very push running this suite) may have exported.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  delete env.PREPUSH_NO_BATTERY_CACHE;
  delete env.PREPUSH_FULL_BATTERY;
  return env;
}

function commitAll(dir, msg) {
  execFileSync('git', ['add', '-A'], { cwd: dir, env: cleanEnv() });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', 'commit', '-q', '-m', msg],
    { cwd: dir, env: cleanEnv() },
  );
}

// A throwaway repo whose HEAD has a scripts/ tree (deriveKey refuses repos without one).
function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'dummy.test.mjs'), "import 'node:test';\n");
  commitAll(dir, 'init');
  return dir;
}

const SEL = 'scripts/dummy.test.mjs\n';

const runCli = (repo, args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...cleanEnv(), ...env },
    input,
    encoding: 'utf8',
  });

const cacheDirOf = (repo) => join(repo, '.git', 'battery-pass-cache');

// check → record in one step (the lifecycle prelude every HIT/expiry/telemetry test needs);
// returns the minted key. One helper so a CLI-shape change is a one-line test fix, not six.
function recordPass(repo, extraRecordArgs = []) {
  const key = runCli(repo, ['check'], { input: SEL }).stdout.trim();
  runCli(repo, ['record', '--key', key, ...extraRecordArgs], { input: SEL });
  return key;
}

// --- keyed paths -------------------------------------------------------------

test('keyedPaths: scripts + lockfile always keyed; node_modules excluded; slashes stripped; sorted', () => {
  const paths = keyedPaths();
  assert.ok(paths.includes('scripts'));
  assert.ok(paths.includes('pnpm-lock.yaml'));
  // node_modules is untracked — it CANNOT be content-addressed; the lockfile is its proxy.
  assert.ok(!paths.some((p) => p.includes('node_modules')));
  assert.ok(paths.every((p) => !p.endsWith('/')));
  assert.deepEqual(paths, [...paths].sort());
  // Lockstep-by-construction: every selector prefix except node_modules/ appears slash-stripped.
  for (const p of EXTERNAL_TREE_PREFIXES) {
    if (p === 'node_modules/') continue;
    assert.ok(paths.includes(p.replace(/\/$/, '')), `selector prefix ${p} missing from key`);
  }
});

test('keyedPaths: a NEW selector prefix flows into the key with no edit here', () => {
  const paths = keyedPaths([...EXTERNAL_TREE_PREFIXES, 'frontend/']);
  assert.ok(paths.includes('frontend'));
});

// --- selection normalization -------------------------------------------------

test('normalizeSelection: trims, drops blanks, dedupes, sorts, strips CR', () => {
  assert.deepEqual(normalizeSelection('  b.mjs \r\n\na.mjs\nb.mjs\n'), ['a.mjs', 'b.mjs']);
  assert.deepEqual(normalizeSelection(''), []);
  assert.deepEqual(normalizeSelection('\n \n'), []);
});

// --- ls-tree parsing ----------------------------------------------------------

test('parseLsTree: blob/tree/commit lines parse; junk is ignored', () => {
  const out = parseLsTree(
    [
      '040000 tree aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tscripts',
      '100644 blob bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tpnpm-lock.yaml',
      '160000 commit cccccccccccccccccccccccccccccccccccccccc\tsubmodule',
      'not a real line',
      '',
    ].join('\n'),
  );
  assert.equal(out.get('scripts'), 'a'.repeat(40));
  assert.equal(out.get('pnpm-lock.yaml'), 'b'.repeat(40));
  assert.equal(out.get('submodule'), 'c'.repeat(40));
  assert.equal(out.size, 3);
});

// --- key derivation (pure) ----------------------------------------------------

const baseOids = () => new Map([['scripts', 'a'.repeat(40)]]);

test('computeKey: deterministic 32-hex, and every component perturbs it', () => {
  const args = {
    oids: baseOids(),
    selection: ['a.mjs'],
    nodeMajor: 22,
    gitVersion: 'git version 2.49.0',
  };
  const { key } = computeKey(args);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(computeKey(args).key, key); // deterministic
  // oid change → new key
  assert.notEqual(computeKey({ ...args, oids: new Map([['scripts', 'b'.repeat(40)]]) }).key, key);
  // selection change → new key (a pass of S says nothing about S')
  assert.notEqual(computeKey({ ...args, selection: ['a.mjs', 'b.mjs'] }).key, key);
  // node major change → new key
  assert.notEqual(computeKey({ ...args, nodeMajor: 23 }).key, key);
  // git binary change → new key (the battery spins real git repos)
  assert.notEqual(computeKey({ ...args, gitVersion: 'git version 2.50.0' }).key, key);
});

test('computeKey: an absent keyed path is content too — present vs absent never collide', () => {
  const withLock = new Map([
    ['scripts', 'a'.repeat(40)],
    ['pnpm-lock.yaml', 'd'.repeat(40)],
  ]);
  const a = computeKey({ oids: baseOids(), selection: ['a.mjs'], nodeMajor: 22, gitVersion: 'g' });
  const b = computeKey({ oids: withLock, selection: ['a.mjs'], nodeMajor: 22, gitVersion: 'g' });
  assert.notEqual(a.key, b.key);
  assert.equal(a.components.oids['pnpm-lock.yaml'], 'absent');
  assert.equal(a.components.v, KEY_FORMAT_VERSION);
});

// --- entry parse + liveness ---------------------------------------------------

test('parseEntry: valid entry parses; corrupt JSON / wrong shape / missing iso → null', () => {
  assert.equal(parseEntry(JSON.stringify({ iso: ISO })).iso, ISO);
  assert.equal(parseEntry('{nope'), null);
  assert.equal(parseEntry('"a string"'), null);
  assert.equal(parseEntry(JSON.stringify({ label: 'no-iso' })), null);
});

test('isLive: fresh live, boundary live, beyond-TTL dead, unknown age NEVER live', () => {
  const entry = { iso: ISO };
  assert.equal(isLive(entry, at(1)), true);
  assert.equal(isLive(entry, at(DEFAULT_TTL_MIN)), true); // age == ttl still live
  assert.equal(isLive(entry, at(DEFAULT_TTL_MIN + 1)), false);
  assert.equal(isLive(entry, at(5), 4), false); // explicit ttl override
  assert.equal(isLive(null, at(0)), false);
  // Unknown age must never SKIP a battery — the opposite fail direction from battery-lock reaping.
  assert.equal(isLive({ iso: 'not-a-date' }, at(0)), false);
  // A FUTURE iso (clock skew / VM-snapshot resume) is an untrustworthy clock, never a fresh
  // entry — ageMinutes would clamp the negative delta to a permanently-live 0 (xhigh finding).
  assert.equal(isLive(entry, at(-1)), false);
});

// --- deriveKey (injectable git seam) -------------------------------------------

function fakeGit({ status = '', lsTree = `040000 tree ${'a'.repeat(40)}\tscripts`, throwOn } = {}) {
  return (args) => {
    if (throwOn && args[0] === throwOn) throw new Error(`fake ${throwOn} failure`);
    if (args[0] === 'status') return status;
    if (args[0] === 'ls-tree') return lsTree;
    if (args[0] === 'version') return 'git version 2.49.0.fake\n';
    throw new Error(`unexpected git ${args[0]}`);
  };
}

test('deriveKey: happy path keys on HEAD oids + selection', () => {
  const d = deriveKey({ git: fakeGit(), selection: ['a.mjs'] });
  assert.equal(d.ok, true);
  assert.match(d.key, /^[0-9a-f]{32}$/);
  assert.equal(d.components.oids.scripts, 'a'.repeat(40));
  assert.equal(d.components.gitVersion, 'git version 2.49.0.fake');
});

test('deriveKey: refusals — empty selection, ANY dirt, git errors, no scripts tree', () => {
  assert.deepEqual(deriveKey({ git: fakeGit(), selection: [] }), {
    ok: false,
    reason: 'empty-selection',
  });
  // dirt (tracked OR untracked) in a keyed path means the working tree ≠ the HEAD content we key on
  assert.equal(
    deriveKey({ git: fakeGit({ status: '?? scripts/new.mjs\n' }), selection: ['a.mjs'] }).ok,
    false,
  );
  assert.match(
    deriveKey({ git: fakeGit({ throwOn: 'status' }), selection: ['a.mjs'] }).reason,
    /^git-status-failed/,
  );
  assert.match(
    deriveKey({ git: fakeGit({ throwOn: 'ls-tree' }), selection: ['a.mjs'] }).reason,
    /^git-ls-tree-failed/,
  );
  assert.equal(
    deriveKey({ git: fakeGit({ lsTree: '' }), selection: ['a.mjs'] }).reason,
    'no-scripts-tree',
  );
  assert.match(
    deriveKey({ git: fakeGit({ throwOn: 'version' }), selection: ['a.mjs'] }).reason,
    /^git-version-failed/,
  );
});

// --- merge-base pinning (plan 2559: check pins the baseline, record reuses it) --------

test('looksLikeOid: a plausible git object id (4-40 hex) passes; anything else is treated as absent', () => {
  assert.equal(looksLikeOid('a'.repeat(40)), true);
  assert.equal(looksLikeOid('ABCDEF01'), true); // hex case-insensitive, short form allowed
  assert.equal(looksLikeOid('abc'), false); // too short
  assert.equal(looksLikeOid('g'.repeat(40)), false); // not hex
  assert.equal(looksLikeOid(''), false);
  assert.equal(looksLikeOid(undefined), false);
  assert.equal(looksLikeOid('--merge-base'), false); // a swallowed flag token, never a value
});

test('resolveMergeBaseOid: returns the trimmed oid, and "" (never throws) on any git trouble', () => {
  assert.equal(
    resolveMergeBaseOid((args) => (args[0] === 'merge-base' ? 'abc123\n' : '')),
    'abc123',
  );
  assert.equal(
    resolveMergeBaseOid(() => {
      throw new Error('no origin/master');
    }),
    '',
  );
});

// deriveKey owns the reader whenever the caller did not inject one — and when it does, the tree
// it reads must be the tree the caller NAMED. Round 3 paired reader and tree at the two seams
// below it (closurePathsForSelection, selectTests) but left this default spelled
// `makeReadSource(SCRIPTS_DIR_DEFAULT)`, so `deriveKey({ scriptsDir })` with no readSource read
// the AMBIENT checkout while every seam below was told the named one: the closure then resolves
// nothing, and the key silently falls back to the whole-tree `scripts` oid (/gpt-review round 4,
// 656499 / e5df98 / d19669 / 681e32 / 6949cd / 7c8dfe — six reports of one line).
test('deriveKey: the default reader reads the NAMED tree, not the ambient one (round-4 656499)', () => {
  // ambient-git-ok: no git repo is involved — the fake git seam answers every call, and the tmp
  // tree is read only through makeReadSource/basenameIndexFor.
  const root = mkdtempSync(join(tmpdir(), 'p4085-derivekey-'));
  try {
    const sdir = join(root, 'scripts');
    mkdirSync(sdir, { recursive: true });
    // Names that exist in NO real checkout, so an ambient read can only come back empty.
    writeFileSync(join(sdir, 'zeta-probe.test.mjs'), "import './zeta-probe.mjs';\n");
    writeFileSync(join(sdir, 'zeta-probe.mjs'), "import './zeta-helper.mjs';\n");
    writeFileSync(join(sdir, 'zeta-helper.mjs'), 'export const y = 2;\n');
    const git = (args) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-tree' && args[1] === '-r')
        return (
          `100644 blob ${'1'.repeat(40)}\tscripts/zeta-probe.mjs\n` +
          `100644 blob ${'2'.repeat(40)}\tscripts/zeta-probe.test.mjs\n` +
          `100644 blob ${'3'.repeat(40)}\tscripts/zeta-helper.mjs\n`
        );
      if (args[0] === 'ls-tree') return `040000 tree ${'a'.repeat(40)}\tscripts\n`;
      if (args[0] === 'version') return 'git version 2.49.0.fake\n';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const d = deriveKey({
      git,
      selection: ['scripts/zeta-probe.test.mjs'],
      canonical: null, // no canonical arm — this pins the reader, not the merge-base derivation
      scriptsDir: sdir,
    });
    assert.equal(d.ok, true, d.reason);
    const scriptKeys = Object.keys(d.components.oids)
      .filter((k) => k === 'scripts' || k.startsWith('scripts/'))
      .sort();
    // The closure of the named tree — NOT the un-narrowed whole-tree `scripts` fallback an
    // ambient read produces.
    assert.deepEqual(scriptKeys, [
      'scripts/zeta-helper.mjs',
      'scripts/zeta-probe.mjs',
      'scripts/zeta-probe.test.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deriveKey: mergeBase threading — a pinned oid is used verbatim; an absent/bad one falls back to a fresh resolve', () => {
  // canonGit-shaped fake: 'merge-base' would answer 'freshbase', but a pin must never call it.
  // diff = an external-tree touch (wiki/) so deriveCanonicalSelection short-circuits to
  // UNIVERSAL_SELECTION without needing a real listTests()/readSource() fixture.
  let mergeBaseCalls = 0;
  const git = (args) => {
    if (args[0] === 'merge-base') {
      mergeBaseCalls += 1;
      return 'freshbase1234567890abcdef12345678\n';
    }
    if (args[0] === 'diff') return 'wiki/x.md\n';
    return fakeGit()(args);
  };
  // A valid pin: deriveCanonicalSelection must receive it directly — no merge-base spawn at all.
  const pinned = deriveKey({
    git,
    selection: ['a.mjs'],
    mergeBase: 'deadbeef1234567890abcdef12345678',
  });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.mergeBase, 'deadbeef1234567890abcdef12345678');
  assert.equal(pinned.mode, 'canonical-universal');
  assert.equal(mergeBaseCalls, 0, 'a valid pin must skip the git merge-base spawn entirely');

  // No pin (absent): falls back to the fresh resolve, exactly today's behavior.
  mergeBaseCalls = 0;
  const fresh = deriveKey({ git, selection: ['a.mjs'] });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.mergeBase, 'freshbase1234567890abcdef12345678');
  assert.equal(mergeBaseCalls, 1);

  // An unparseable pin (not oid-shaped) is treated exactly like "not provided" — re-resolve fresh.
  mergeBaseCalls = 0;
  const bad = deriveKey({ git, selection: ['a.mjs'], mergeBase: 'not-an-oid!!' });
  assert.equal(bad.ok, true);
  assert.equal(bad.mergeBase, 'freshbase1234567890abcdef12345678');
  assert.equal(mergeBaseCalls, 1);
});

test('deriveCanonicalSelection: an underivable mergeBase pin ("") is exactly "not provided" — falls back to git', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args[0]);
    if (args[0] === 'merge-base') return 'gitresolved\n';
    if (args[0] === 'diff') return 'docs/INDEX.md\n';
    throw new Error(`unexpected ${args[0]}`);
  };
  const sel = deriveCanonicalSelection({
    git,
    mergeBase: '',
    listTests: () => [],
    readSource: () => null,
  });
  assert.deepEqual(sel, []); // the diff (docs/INDEX.md) carries no scripts/*.mjs
  assert.ok(calls.includes('merge-base'), 'an empty pin must not suppress the git resolve');
});

// --- entry path safety + fs ops -------------------------------------------------

test('entryPath: only our own 32-lowercase-hex shape; anything else throws (shell-supplied --key)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-fs-'));
  const key = '0123456789abcdef0123456789abcdef';
  assert.equal(entryPath(dir, key), join(dir, `${key}.json`));
  for (const bad of ['../../evil', 'ABCDEF0123456789ABCDEF0123456789', 'short', '', 'g'.repeat(32)])
    assert.throws(() => entryPath(dir, bad), /malformed cache key/);
});

test('fs ops: write→read roundtrip, remove, and prune drops expired+corrupt but keeps live', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'battery-cache-fs-')), 'cache');
  const live = 'a'.repeat(32);
  const dead = 'b'.repeat(32);
  writeCacheEntry(dir, live, { iso: ISO, label: 'live' });
  assert.equal(readCacheEntry(dir, live).label, 'live');
  assert.equal(readCacheEntry(dir, dead), null); // absent ⇒ MISS
  writeCacheEntry(dir, dead, { iso: '2026-07-13T00:00:00.000Z' }); // >TTL older than ISO
  writeFileSync(join(dir, `${'c'.repeat(32)}.json`), '{corrupt'); // corrupt ⇒ prune-able
  writeFileSync(join(dir, 'telemetry.log'), 'not an entry\n'); // non-.json ⇒ untouched
  assert.equal(pruneExpired(dir, at(0)), 2);
  assert.ok(existsSync(join(dir, `${live}.json`)));
  assert.ok(existsSync(join(dir, 'telemetry.log')));
  assert.equal(removeCacheEntry(dir, live), true);
  assert.equal(removeCacheEntry(dir, live), false); // already gone — close-out never throws
  assert.equal(pruneExpired(join(dir, 'no-such-dir'), at(0)), 0);
});

// --- CLI: the miss → record → hit → invalidate lifecycle -------------------------

test('CLI: check MISS mints a key, record stores it, identical check HITs, invalidate drops it', () => {
  const repo = tmpRepo();
  const miss = runCli(repo, ['check'], { input: SEL });
  assert.equal(miss.status, EXIT_MISS);
  const key = miss.stdout.trim();
  assert.match(key, /^[0-9a-f]{32}$/); // stdout is the key and ONLY the key

  const rec = runCli(repo, ['record', '--key', key, '--label', 'unit'], { input: SEL });
  assert.equal(rec.status, 0);
  assert.match(rec.stderr, /recorded pass/);

  const hit = runCli(repo, ['check'], { input: SEL });
  assert.equal(hit.status, EXIT_HIT);
  assert.equal(hit.stdout.trim(), key); // same content + selection ⇒ same key
  assert.match(hit.stderr, /HIT/);

  // selection ORDER must not matter (normalizeSelection sorts)
  const reordered = runCli(repo, ['check'], {
    input: 'scripts/dummy.test.mjs\nscripts/dummy.test.mjs\n',
  });
  assert.equal(reordered.status, EXIT_HIT);

  const inv = runCli(repo, ['invalidate', '--key', key]);
  assert.equal(inv.status, 0);
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_MISS);
});

test('CLI: a different selection is a MISS even when the content already passed', () => {
  const repo = tmpRepo();
  const key = recordPass(repo);
  const other = runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' });
  assert.equal(other.status, EXIT_MISS);
  assert.notEqual(other.stdout.trim(), key);
});

test('CLI: dirt in a keyed path is UNCACHEABLE (empty stdout), clean again is cacheable', () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, 'scripts', 'untracked.mjs'), '// dirt\n');
  const dirty = runCli(repo, ['check'], { input: SEL });
  assert.equal(dirty.status, EXIT_UNCACHEABLE);
  assert.equal(dirty.stdout.trim(), '');
  assert.match(dirty.stderr, /dirty-gated-paths/);
  commitAll(repo, 'absorb dirt');
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_MISS);
});

test('CLI: gated-content change between check and record REFUSES the record (key drift)', () => {
  const repo = tmpRepo();
  const key = runCli(repo, ['check'], { input: SEL }).stdout.trim();
  // the battery "mutated the repo" (the plan-338 incident class) and the mutation got committed.
  // Plan 2560: the mutation must land INSIDE the selected test's closure (dummy.test.mjs itself
  // — it has no deps, so its closure is only itself) — an edit OUTSIDE the closure is now
  // correctly invisible to the key (see the "OUTSIDE the closure now HITs" test), so it would no
  // longer reproduce a drift here.
  writeFileSync(
    join(repo, 'scripts', 'dummy.test.mjs'),
    "import 'node:test'; // changed under the battery\n",
  );
  commitAll(repo, 'mutation');
  const rec = runCli(repo, ['record', '--key', key], { input: SEL });
  assert.equal(rec.status, 0); // close-out never blocks a push…
  assert.match(rec.stderr, /key mismatch/);
  // …but NEITHER key may now hit: the old state is gone, the new state never recorded
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_MISS);
});

test('CLI: content change after a recorded pass is a MISS (content-addressing, no invalidation needed)', () => {
  const repo = tmpRepo();
  const key = recordPass(repo);
  writeFileSync(join(repo, 'scripts', 'dummy.test.mjs'), "import 'node:test'; // v2\n");
  commitAll(repo, 'edit gated content');
  const after = runCli(repo, ['check'], { input: SEL });
  assert.equal(after.status, EXIT_MISS);
  assert.notEqual(after.stdout.trim(), key);
});

test('CLI: an expired entry is a MISS, never a HIT', () => {
  const repo = tmpRepo();
  const key = recordPass(repo);
  // Backdate the entry past DEFAULT_TTL_MIN (ageMinutes rounds to whole minutes, so a --ttl-min 0
  // probe against a fresh entry would still be age-0 LIVE — backdating is the deterministic path).
  const file = join(cacheDirOf(repo), `${key}.json`);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  entry.iso = new Date(Date.now() - (DEFAULT_TTL_MIN + 5) * 60000).toISOString();
  writeFileSync(file, JSON.stringify(entry));
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_MISS);
});

test('CLI: PREPUSH_NO_BATTERY_CACHE=1 is UNCACHEABLE even with a live entry (defense in depth)', () => {
  const repo = tmpRepo();
  recordPass(repo);
  const off = runCli(repo, ['check'], { input: SEL, env: { PREPUSH_NO_BATTERY_CACHE: '1' } });
  assert.equal(off.status, EXIT_UNCACHEABLE);
  assert.equal(off.stdout.trim(), '');
});

test('CLI: record/invalidate close-out surface never blocks — missing or malformed --key exits 0', () => {
  const repo = tmpRepo();
  assert.equal(runCli(repo, ['record'], { input: SEL }).status, 0);
  assert.equal(runCli(repo, ['record', '--key'], { input: SEL }).status, 0);
  assert.equal(runCli(repo, ['invalidate', '--key', '../../evil']).status, 0);
  assert.equal(runCli(repo, ['invalidate']).status, 0);
  // …and no entry file was created anywhere in the cache dir by any of that
  const names = existsSync(cacheDirOf(repo))
    ? readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json'))
    : [];
  assert.deepEqual(names, []);
});

test('CLI: status lists live entries, path prints the rendezvous, unknown cmd is UNCACHEABLE', () => {
  const repo = tmpRepo();
  assert.match(runCli(repo, ['status']).stdout, /^empty/);
  const key = recordPass(repo, ['--label', 'unit-status']);
  const st = runCli(repo, ['status']);
  assert.match(st.stdout, new RegExp(`${key} pass @ .*unit-status`));
  assert.equal(runCli(repo, ['path']).stdout.trim(), cacheDirOf(repo));
  assert.equal(runCli(repo, ['bogus']).status, EXIT_UNCACHEABLE);
  assert.equal(runCli(repo, []).status, EXIT_UNCACHEABLE);
});

test('CLI: telemetry log receives one line per decision (the plan-1824 sizing instrumentation)', () => {
  const repo = tmpRepo();
  recordPass(repo);
  runCli(repo, ['check'], { input: SEL });
  const log = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8');
  assert.match(log, /MISS key=/);
  assert.match(log, /RECORD key=/);
  assert.match(log, /HIT key=/);
});

// --- plan 2279: canonical-selection keying, prefix scoping, MISS attribution ----
// The invariant every case below defends, ON TOP of the plan-1824 one: a HIT may only ever skip
// tests whose pass IS proven on identical keyed content (record never claims more than the run
// proved; check never accepts a claim narrower than the run it would skip), and dropping a
// scoped prefix from the key is only ever done for selections proven unable to read it.

const gitIn = (dir, args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@test.invalid', ...args], {
    cwd: dir,
    env: cleanEnv(),
    encoding: 'utf8',
  });

// A throwaway repo WITH an origin/master ref (refs/remotes/origin/master), so the CLI exercises
// CANONICAL mode instead of the legacy fallback the origin-less tmpRepo() repos take. Base
// commit: an independent dummy test, a module + its paired test, and a wiki/ page.
function tmpRepoWithCanonical({ fooTestSource = "import './foo.mjs';\n" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-canon-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'dummy.test.mjs'), "import 'node:test';\n");
  writeFileSync(join(dir, 'scripts', 'foo.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'scripts', 'foo.test.mjs'), fooTestSource);
  writeFileSync(join(dir, 'wiki', 'page.md'), '# page v1\n');
  commitAll(dir, 'base');
  gitIn(dir, ['update-ref', 'refs/remotes/origin/master', 'HEAD']);
  return dir;
}

// The branch's own content change: scripts/foo.mjs — canonical selection resolves to exactly
// scripts/foo.test.mjs (name pairing) for every repo built above.
function commitFooChange(dir, v = 2) {
  writeFileSync(join(dir, 'scripts', 'foo.mjs'), `export const x = ${v};\n`);
  commitAll(dir, `foo v${v}`);
}

// --- plan 2559: merge-base pinning (check resolves it, record reuses it) --------
// A repo shaped so origin/master starts STALE, at an ancestor Z of HEAD's own history — the
// realistic drift shape: a worktree that hasn't fetched since its branch point sees a NARROWER
// window (Z..HEAD is actually WIDER here, deliberately: it also carries B0's wiki touch) than a
// fresh resolve would once a sibling session's fetch catches the shared `origin/master` ref up
// to B0. Z..HEAD touches wiki/ (external tree) ⇒ canonical selection bails to UNIVERSAL;
// B0..HEAD touches only scripts/foo.mjs ⇒ a narrow, DIFFERENT canonical selection — so the two
// merge-base baselines mint genuinely different keys, exactly the leak the plan closes.
function tmpRepoWithStaleOrigin() {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-mb-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: cleanEnv() });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'wiki'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'dummy.test.mjs'), "import 'node:test';\n");
  commitAll(dir, 'Z: base');
  const zSha = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  gitIn(dir, ['update-ref', 'refs/remotes/origin/master', zSha]); // origin/master starts stale, at Z
  writeFileSync(join(dir, 'scripts', 'foo.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'scripts', 'foo.test.mjs'), "import './foo.mjs';\n");
  writeFileSync(join(dir, 'wiki', 'page.md'), '# page v1\n');
  commitAll(dir, 'B0: master advances (wiki touch + a new foo pairing)');
  const b0Sha = gitIn(dir, ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(dir, 'scripts', 'foo.mjs'), 'export const x = 2;\n');
  commitAll(dir, 'C1: our own gated change — foo v2');
  return { dir, zSha, b0Sha };
}

test("CLI plan 2559: a mid-battery origin/master move no longer key-drifts record when check's own resolved merge-base is pinned", () => {
  const { dir: repo, zSha, b0Sha } = tmpRepoWithStaleOrigin();
  const input = 'scripts/*.test.mjs\n'; // the union-trigger's full-glob bail — realistic for a UNIVERSAL claim
  const mbFile = join(repo, '.merge-base-out');
  const check = runCli(repo, ['check', '--merge-base-out', mbFile], { input });
  assert.equal(check.status, EXIT_MISS);
  const key = check.stdout.trim();
  const pinnedBase = readFileSync(mbFile, 'utf8');
  assert.equal(pinnedBase, zSha, 'check must resolve+pin the STALE origin/master it actually saw');

  // Simulate a sibling session's `git fetch` catching the shared origin/master ref up to B0 —
  // this worktree's own HEAD/working tree is untouched, exactly the plan's failure shape.
  gitIn(repo, ['update-ref', 'refs/remotes/origin/master', b0Sha]);

  // WITHOUT the pin, record would re-resolve merge-base fresh — now B0, not Z — deriving a
  // NARROWER canonical selection (only foo.test.mjs, not universal) and hence a different key:
  // today's bug, reproduced here as a control.
  const withoutPin = runCli(repo, ['record', '--key', key], { input });
  assert.equal(withoutPin.status, 0); // close-out never blocks a push…
  assert.match(withoutPin.stderr, /key mismatch/);
  assert.match(
    readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8'),
    /RECORD-REFUSED reason=key-drift/,
  );
  assert.deepEqual(
    existsSync(cacheDirOf(repo))
      ? readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json'))
      : [],
    [],
  );

  // WITH the pin (check's own resolved oid), record derives the SAME canonical selection check
  // did — the fix: an intervening origin/master move can no longer erode this record.
  const withPin = runCli(repo, ['record', '--key', key, '--merge-base', pinnedBase], { input });
  assert.equal(withPin.status, 0);
  assert.match(withPin.stderr, /recorded pass/);
  assert.ok(readdirSync(cacheDirOf(repo)).some((n) => n.startsWith(key)));
  assert.equal(runCli(repo, ['check'], { input }).status, EXIT_HIT);
});

test('CLI plan 2559: a tampered --merge-base cannot mint an unsound record — caught exactly like any other key drift', () => {
  const { dir: repo, b0Sha } = tmpRepoWithStaleOrigin();
  const input = 'scripts/*.test.mjs\n';
  const check = runCli(repo, ['check'], { input });
  assert.equal(check.status, EXIT_MISS);
  const key = check.stdout.trim();

  // A caller hands record a PLAUSIBLE-looking but WRONG oid (not the baseline check actually
  // used) — whether from a bug in the plumbing or deliberate tampering, this must never mint a
  // record under a claim the run never actually proved.
  const tampered = runCli(repo, ['record', '--key', key, '--merge-base', b0Sha], { input });
  assert.equal(tampered.status, 0); // close-out never blocks a push…
  assert.doesNotMatch(tampered.stderr, /recorded pass/);
  assert.match(readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8'), /RECORD-REFUSED/);
  assert.deepEqual(
    existsSync(cacheDirOf(repo))
      ? readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json'))
      : [],
    [],
  );
  assert.equal(runCli(repo, ['check'], { input }).status, EXIT_MISS);
});

// --- selection-cover semantics -------------------------------------------------

test('selectionCovers: plain inclusion plus universal semantics on both sides', () => {
  assert.equal(selectionCovers(['a', 'b'], ['a']), true);
  assert.equal(selectionCovers(['a'], ['a', 'b']), false);
  assert.equal(selectionCovers([...UNIVERSAL_SELECTION], ['anything']), true); // a full run proves all
  assert.equal(selectionCovers(['a'], [...UNIVERSAL_SELECTION]), false); // only a full run proves "all"
  assert.equal(selectionCovers([...UNIVERSAL_SELECTION], [...UNIVERSAL_SELECTION]), true);
  assert.equal(isUniversalSelection([...UNIVERSAL_SELECTION]), true);
  assert.equal(isUniversalSelection(['scripts/a.test.mjs']), false);
});

// --- scoped-prefix attribution ---------------------------------------------------

test('CORE_SCOPED_PREFIXES: exactly the one project-agnostic real-tree prefix', () => {
  assert.deepEqual(CORE_SCOPED_PREFIXES, ['wiki/']);
});

test('scopedPrefixesFor: merges core + config, core first, deduplicated', () => {
  assert.deepEqual(scopedPrefixesFor([]), CORE_SCOPED_PREFIXES);
  assert.deepEqual(scopedPrefixesFor(['backend/']), [...CORE_SCOPED_PREFIXES, 'backend/']);
  // A config entry that duplicates a core one must not appear twice.
  assert.deepEqual(scopedPrefixesFor(['wiki/', 'backend/']), [...CORE_SCOPED_PREFIXES, 'backend/']);
});

test('VETAPP_SCOPED_PREFIXES: every scoped prefix is itself a keyed EXTERNAL_TREE_PREFIXES entry', () => {
  // Scoping only makes sense for prefixes the key otherwise covers — a scoped prefix missing
  // from the selector's list would mean this module "scopes" content that was never keyed.
  for (const p of VETAPP_SCOPED_PREFIXES) assert.ok(VETAPP_EXTERNAL_TREE_PREFIXES.includes(p), p);
});

// plan 4071 review finding 859192's fix merges scopedPrefixes into the prefix list both
// gatherRepoState and keyForSelection offer to keyedPaths. This is the vetapp-unchanged pin the
// review asked for: because every VETAPP_SCOPED_PREFIXES entry is ALREADY an EXTERNAL_TREE_PREFIXES
// member (pinned above), merging them in is a no-op for vetapp's real config — the resulting
// path SET, and therefore every key computed from it, is byte-identical to the pre-fix behavior.
test('keyedPaths plan 4071 review finding 859192: merging in VETAPP_SCOPED_PREFIXES changes nothing for vetapp', () => {
  assert.deepEqual(
    keyedPaths([...VETAPP_EXTERNAL_TREE_PREFIXES, ...VETAPP_SCOPED_PREFIXES]),
    keyedPaths(VETAPP_EXTERNAL_TREE_PREFIXES),
  );
});

test('testReadsRealTreeSegment: the guard idioms, the quoted-path literal, and clean sources', () => {
  // shape 1: join(<root-const>, '<segment>', …) — the EXTERNAL_TREE_PREFIXES guard's first scan
  assert.equal(testReadsRealTreeSegment(`join(REPO, 'wiki', 'log.md')`, 'wiki'), true);
  assert.equal(testReadsRealTreeSegment(`join(repoRoot, 'backend', 'src')`, 'backend'), true);
  // shape 2: join(<root-or-HERE>, '..', '<segment>', …) — the guard's second scan
  assert.equal(testReadsRealTreeSegment(`join(HERE, '..', 'wiki', 'x.md')`, 'wiki'), true);
  // shape 3: a quoted path literal starting `<seg>/`
  assert.equal(testReadsRealTreeSegment(`readFileSync('wiki/log.md')`, 'wiki'), true);
  assert.equal(testReadsRealTreeSegment('const g = `backend/src/data`;', 'backend'), true);
  // prose mentions and other segments do NOT attribute
  assert.equal(testReadsRealTreeSegment('// the wiki moves constantly', 'wiki'), false);
  // ('scripts' doubles as the non-target segment here — an uncovered segment like 'docs' would
  // itself trip the EXTERNAL_TREE_PREFIXES guard's raw-source scan of THIS test file.)
  assert.equal(testReadsRealTreeSegment(`join(REPO, 'scripts', 'x.mjs')`, 'wiki'), false);
  assert.equal(testReadsRealTreeSegment(`join(dir, 'wiki', 'x')`, 'wiki'), false); // not a root const
});

// plan 4071 review finding f5ea01: a CONFIGURED prefix (unlike the two hardcoded ones) can
// contain regex metacharacters — the segment must be escaped before it is interpolated into a
// RegExp, or a prefix like `backend[legacy]` is parsed as a character class and silently never
// matches (dropping it from attribution, and — via reachableScopedPrefixes — from the key).
test('testReadsRealTreeSegment: a prefix segment with regex metacharacters is escaped, not parsed as regex', () => {
  const seg = 'backend[legacy]';
  // the metacharacter form must be matched LITERALLY — a false '[legacy]' character-class parse
  // would make this false, which is exactly the finding
  // The join-idiom fixture is ASSEMBLED at runtime rather than written as one literal: the
  // corpus guard in select-battery-tests.test.mjs scans this file's SOURCE with the same
  // REAL_TREE_JOIN_IDIOMS and would otherwise report `backend[legacy]` as an uncovered real-tree
  // read (it is a fixture, not a read).
  const joinFixture = ['join(REPO', "'backend[legacy]'", "'x.json')"].join(', ');
  assert.equal(testReadsRealTreeSegment(`readFileSync('backend[legacy]/x.json')`, seg), true);
  assert.equal(testReadsRealTreeSegment(joinFixture, seg), true);
  // a source that merely contains the UNESCAPED-would-be-matched text (any single 'l', 'e', …
  // followed by '/', which `[legacy]/` as a literal character class would match) must NOT
  // attribute — proves the segment is treated as a literal string, not compiled as regex source
  assert.equal(testReadsRealTreeSegment("readFileSync('l/x.json')", seg), false);
});

// plan 4071 review finding 66d3c7: a NESTED configured prefix (more than one path segment, e.g.
// `backend/scripts`) must be attributed at any depth in BOTH source shapes a test can spell a
// real-tree read in — not just the top-level single-segment prefixes this module shipped with.
test('testReadsRealTreeSegment: a nested prefix matches at any depth, in both source shapes', () => {
  const seg = 'backend/scripts';
  // shape A: segment-wise join() — join(REPO, 'backend', 'scripts', …) — REAL_TREE_JOIN_IDIOMS
  // only captures the FIRST quoted argument, so a naive `m[1] === seg` comparison never matches.
  assert.equal(
    testReadsRealTreeSegment(`join(REPO, 'backend', 'scripts', '_seed_validation.py')`, seg),
    true,
  );
  assert.equal(
    testReadsRealTreeSegment(`join(HERE, '..', 'backend', 'scripts', 'x.py')`, seg),
    true,
  );
  // shape B: one slash-joined literal — join(REPO, 'backend/scripts/x.py') or a bare string
  assert.equal(testReadsRealTreeSegment(`join(REPO, 'backend/scripts/x.py')`, seg), true);
  assert.equal(testReadsRealTreeSegment(`readFileSync('backend/scripts/x.py')`, seg), true);
  // a shallower sibling under the SAME top segment must not false-positive a deeper prefix
  assert.equal(testReadsRealTreeSegment(`join(REPO, 'backend', 'src', 'x.ts')`, seg), false);
  assert.equal(testReadsRealTreeSegment('// backend/other/thing', seg), false);
});

// plan 4071 review finding e5de0f/733b4e: the nested-prefix segment-wise join() shape used to be
// hand-duplicated from REAL_TREE_JOIN_IDIOMS with SINGLE-quoted arguments only, so a test that
// spelled the same read with double quotes or backticks (both legal, common JS) went unattributed
// and its content could move without ever busting the key. Fixed by generalizing to one shared,
// quote-agnostic N-argument matcher — every quote style must attribute identically.
test('testReadsRealTreeSegment: a nested prefix segment-wise join() attributes in any quote style', () => {
  const seg = 'backend/scripts';
  assert.equal(
    testReadsRealTreeSegment(`join(REPO, "backend", "scripts", "x.py")`, seg),
    true,
    'double-quoted segments',
  );
  assert.equal(
    testReadsRealTreeSegment('join(REPO, `backend`, `scripts`, `x.py`)', seg),
    true,
    'backtick-quoted segments',
  );
  // mixed quote styles across the same call are legal JS and must attribute too
  assert.equal(
    testReadsRealTreeSegment(`join(REPO, 'backend', "scripts", x)`, seg),
    true,
    'mixed single/double segments',
  );
  // the `'..'` shape (HERE/…, '..', <segments>) in the non-default quote styles
  assert.equal(
    testReadsRealTreeSegment(`join(HERE, '..', "backend", "scripts", 'x.py')`, seg),
    true,
    'double-quoted segments after the ".." traversal literal',
  );
  // a shallower double-quoted sibling under the SAME top segment must not false-positive
  assert.equal(testReadsRealTreeSegment(`join(REPO, "backend", "src", "x.ts")`, seg), false);
});

// plan 4071 review round 3, findings 555ec4/8718c1: the nested matcher's `..` TRAVERSAL TOKEN
// itself (as opposed to the segments after it, already covered above) was still hard-coded as
// the single-quoted literal `'\.\.'`, so a test that spelled the traversal in double quotes or
// backticks went unattributed even though its segments used the exact same quote style. Fixed by
// running the traversal literal through the same quote-agnostic matcher as every other segment.
test('testReadsRealTreeSegment: a nested prefix attributes the ".." traversal literal in any quote style', () => {
  const seg = 'backend/scripts';
  assert.equal(
    testReadsRealTreeSegment(`join(HERE, "..", "backend", "scripts", "x.py")`, seg),
    true,
    'double-quoted ".." traversal literal',
  );
  assert.equal(
    testReadsRealTreeSegment('join(HERE, `..`, `backend`, `scripts`, `x.py`)', seg),
    true,
    'backtick-quoted ".." traversal literal',
  );
  // mixing the traversal literal's quote style with the segments' is legal JS and must attribute
  assert.equal(
    testReadsRealTreeSegment(`join(REPO_ROOT, "..", 'backend', 'scripts', x)`, seg),
    true,
    'double-quoted ".." traversal literal with single-quoted segments',
  );
});

// plan 4071 review round 3, finding a576e4: REAL_TREE_JOIN_IDIOMS (N=1) is now BUILT from
// select-battery-tests.mjs's exported `repoRootAlt`, and battery-pass-cache's own nested N>1
// matcher (joinIdiomsForSegments, not exported — exercised via testReadsRealTreeSegment above)
// is built from the identical import, so there is exactly one place a future root alias needs to
// change. Prove the N=1 half directly: each REAL_TREE_JOIN_IDIOMS regex's source is exactly
// `repoRootAlt(...)` spliced into the shape it names in its own comment — not a re-typed copy.
test('REAL_TREE_JOIN_IDIOMS is built from the shared repoRootAlt, not a re-typed alias list', () => {
  assert.equal(REAL_TREE_JOIN_IDIOMS[0].source, `\\bjoin\\(\\s*${repoRootAlt()}\\s*,\\s*'([^']+)'`);
  assert.equal(
    REAL_TREE_JOIN_IDIOMS[1].source,
    `\\bjoin\\(\\s*${repoRootAlt(true)}\\s*,\\s*'\\.\\.'\\s*,\\s*'([^']+)'`,
  );
});

test('reachableScopedPrefixes: attribution over test sources, DATA_DEPENDENCY_MAP pin, fail-safe routes', () => {
  const sources = {
    'clean.test.mjs': "import 'node:test';\n",
    'wikireader.test.mjs': "const p = join(REPO, 'wiki', 'log.md');\n",
    'backendlit.test.mjs': "readFileSync('backend/src/data/x.json');\n",
    'mapped.test.mjs': "import 'node:test'; // reads seed via the loaders, no literal here\n",
  };
  const readSource = (b) => sources[b] ?? null;
  const dataMap = { 'mapped.test.mjs': ['backend/src/x/**'] };
  const opts = { readSource, dataMap, scopedPrefixes: VETAPP_SCOPED_PREFIXES };
  assert.deepEqual(reachableScopedPrefixes(['scripts/clean.test.mjs'], opts), []);
  assert.deepEqual(reachableScopedPrefixes(['scripts/wikireader.test.mjs'], opts), ['wiki/']);
  assert.deepEqual(reachableScopedPrefixes(['scripts/backendlit.test.mjs'], opts), ['backend/']);
  // the DATA_DEPENDENCY_MAP pin attributes even when the test's own source scan finds nothing
  assert.deepEqual(reachableScopedPrefixes(['scripts/mapped.test.mjs'], opts), ['backend/']);
  // union across the selection
  assert.deepEqual(
    reachableScopedPrefixes(['scripts/wikireader.test.mjs', 'scripts/mapped.test.mjs'], opts),
    ['wiki/', 'backend/'],
  );
  // fail-safe: universal, unreadable, and non-flat-test selections attribute EVERYTHING
  assert.deepEqual(reachableScopedPrefixes([...UNIVERSAL_SELECTION], opts), [
    ...VETAPP_SCOPED_PREFIXES,
  ]);
  assert.deepEqual(reachableScopedPrefixes(['scripts/ghost.test.mjs'], opts), [
    ...VETAPP_SCOPED_PREFIXES,
  ]);
  assert.deepEqual(reachableScopedPrefixes(['scripts/lib/x.test.mjs'], opts), [
    ...VETAPP_SCOPED_PREFIXES,
  ]);
});

test('reachableScopedPrefixes: defaults to the CORE list when no project scopedPrefixes are given', () => {
  const sources = { 'wikireader.test.mjs': "const p = join(REPO, 'wiki', 'log.md');\n" };
  const readSource = (b) => sources[b] ?? null;
  // No scopedPrefixes given ⇒ CORE_SCOPED_PREFIXES only, so backend/ can never attribute.
  assert.deepEqual(reachableScopedPrefixes([...UNIVERSAL_SELECTION], { readSource }), [
    ...CORE_SCOPED_PREFIXES,
  ]);
});

// plan 4071 review finding 66d3c7: a NESTED configured prefix must be attributed end-to-end
// through reachableScopedPrefixes, both via a test's own source scan and via the
// DATA_DEPENDENCY_MAP pin (whose first-path-segment-only comparison had the identical gap).
test('reachableScopedPrefixes: a nested configured prefix (backend/scripts/) attributes at depth', () => {
  const sources = {
    'nestedsrc.test.mjs': "const p = join(REPO, 'backend', 'scripts', 'x.py');\n",
    'shallowsrc.test.mjs': "readFileSync('backend/src/data/x.json');\n",
    'nestedmapped.test.mjs': "import 'node:test'; // reads via the loaders, no literal here\n",
  };
  const readSource = (b) => sources[b] ?? null;
  const dataMap = { 'nestedmapped.test.mjs': ['backend/scripts/fixtures/**'] };
  const scopedPrefixes = ['wiki/', 'backend/', 'backend/scripts/'];
  const opts = { readSource, dataMap, scopedPrefixes };
  // segment-wise join() under the nested prefix attributes the nested prefix — AND, soundly, the
  // shallower 'backend/' sibling too: reading `backend/scripts/x.py` is also a read under
  // `backend/` (deliberate over-approximation, same as the module's other shapes)
  assert.deepEqual(reachableScopedPrefixes(['scripts/nestedsrc.test.mjs'], opts), [
    'backend/',
    'backend/scripts/',
  ]);
  // a shallower literal attributes only the shallower prefix
  assert.deepEqual(reachableScopedPrefixes(['scripts/shallowsrc.test.mjs'], opts), ['backend/']);
  // a DATA_DEPENDENCY_MAP glob under the nested prefix pins the nested prefix — not just the
  // glob's first path segment ('backend'), the exact gap the finding named — while also,
  // soundly, pinning the shallower 'backend/' sibling the glob sits under too.
  assert.deepEqual(reachableScopedPrefixes(['scripts/nestedmapped.test.mjs'], opts), [
    'backend/',
    'backend/scripts/',
  ]);
});

test('reachableScopedPrefixes: corpus parity — every real test the guard idioms attribute, this scan attributes', () => {
  // The EXTERNAL_TREE_PREFIXES guard in select-battery-tests.test.mjs is the system's enforced
  // definition of "a battery test reads the real tree". testReadsRealTreeSegment scans the SAME
  // REAL_TREE_JOIN_IDIOMS regex objects (plus a broader literal shape), so on the REAL suite it
  // must attribute a superset of what the guard sees — this pins that superset relation on the
  // live corpus (the shared import already makes regex drift impossible).
  const scriptsDir = import.meta.dirname;
  for (const file of readdirSync(scriptsDir).filter(isTestFile)) {
    const src = readFileSync(join(scriptsDir, file), 'utf8');
    for (const seg of VETAPP_SCOPED_PREFIXES.map((p) => p.replace(/\/$/, ''))) {
      const guardSees = REAL_TREE_JOIN_IDIOMS.some((idiom) =>
        [...src.matchAll(idiom)].some((m) => m[1] === seg),
      );
      if (guardSees)
        assert.equal(
          testReadsRealTreeSegment(src, seg),
          true,
          `${file}: guard idioms see a real-tree '${seg}' read this scan misses`,
        );
    }
  }
});

test('keyedPaths: a scoped-out prefix leaves the key; everything else stays', () => {
  const paths = keyedPaths(VETAPP_EXTERNAL_TREE_PREFIXES, ['wiki/']);
  assert.ok(!paths.includes('wiki'));
  assert.ok(paths.includes('backend'));
  assert.ok(paths.includes('scripts'));
});

test('computeKey: the keyed-path SET is itself key content — scoped and unscoped keys never collide', () => {
  const args = {
    oids: baseOids(),
    selection: ['a.mjs'],
    nodeMajor: 22,
    gitVersion: 'g',
  };
  const full = computeKey({ ...args, paths: keyedPaths() });
  const scoped = computeKey({ ...args, paths: keyedPaths(EXTERNAL_TREE_PREFIXES, ['wiki/']) });
  assert.notEqual(full.key, scoped.key);
});

// --- deriveCanonicalSelection (injectable seams) ---------------------------------

const canonGit =
  ({ base = 'abc123\n', diff = 'scripts/foo.mjs\n', throwOn } = {}) =>
  (args) => {
    if (throwOn && args[0] === throwOn) throw new Error(`fake ${throwOn} failure`);
    if (args[0] === 'merge-base') return base;
    if (args[0] === 'diff') return diff;
    throw new Error(`unexpected git ${args[0]}`);
  };
const canonTree = {
  'foo.mjs': 'export const x = 1;\n',
  'foo.test.mjs': "import './foo.mjs';\n",
  'dummy.test.mjs': "import 'node:test';\n",
};
const canonOpts = {
  listTests: () => Object.keys(canonTree).filter(isTestFile).sort(),
  readSource: (b) => canonTree[b] ?? null,
};

test('deriveCanonicalSelection: happy path — the selector pipeline over the merge-base diff', () => {
  assert.deepEqual(deriveCanonicalSelection({ git: canonGit(), ...canonOpts }), [
    'scripts/foo.test.mjs',
  ]);
});

test('deriveCanonicalSelection: underivable (no origin/master, git failure) → null (legacy keying)', () => {
  assert.equal(
    deriveCanonicalSelection({ git: canonGit({ throwOn: 'merge-base' }), ...canonOpts }),
    null,
  );
  assert.equal(
    deriveCanonicalSelection({ git: canonGit({ throwOn: 'diff' }), ...canonOpts }),
    null,
  );
  assert.equal(deriveCanonicalSelection({ git: canonGit({ base: '\n' }), ...canonOpts }), null);
});

test('deriveCanonicalSelection: selector-CLI parity on every cannot-scope route → UNIVERSAL', () => {
  for (const diff of [
    'scripts/foo.mjs\nwiki/log.md\n', // external-tree touch
    'scripts/lib/nested.mjs\n', // nested module the flat closure cannot resolve
    'scripts/a b.mjs\n', // malformed path
    'scripts/unreferenced.mjs\n', // empty selection (nothing depends on it)
  ])
    assert.deepEqual(
      deriveCanonicalSelection({ git: canonGit({ diff }), ...canonOpts }),
      [...UNIVERSAL_SELECTION],
      JSON.stringify(diff),
    );
});

// The pairing discipline round 3 applied at closurePathsForSelection and selectTests, applied at
// the seam it missed (/gpt-review round 4, 015346 / 39d887 / 07bc89 + 81b8c8 / 512d18 / 62d562).
// `basenameIndex = basenameIndexFor(scriptsDir)` as a DEFAULT PARAMETER does two wrong things:
// a caller that injects a reader without naming a tree is handed an index describing THIS
// process's cwd (the disguise), and a named tree that cannot be walked throws straight out of a
// function whose whole contract is to fail safe to `null`.
test('deriveCanonicalSelection: an injected reader with no named tree gets NO ambient index (round-4 015346)', () => {
  // The fixture tree holds `foo.mjs` only. AMBIENT names one real `spine.mjs`; if the ambient
  // index leaks in, the fixture's `join(dir, '<AMBIENT>')` resolves against it and welds an edge
  // to a module this fixture has never heard of.
  //
  // AMBIENT is interpolated rather than written into the fixture literal ON PURPOSE: a quoted
  // `'spine.mjs'` sitting in THIS file's source text is a construction site by the selector's own
  // rules, so spelling it out would add a real basename-fallback edge from this test to
  // coord/land/spine.mjs and drag spine's whole closure along (measured: +1 test on spine.mjs,
  // board.mjs and coord/gate-pass-cache.mjs). The fixture STRING is identical either way.
  const AMBIENT = 'spine.mjs';
  const sources = {
    'bar.test.mjs': "import './bar.mjs';\n",
    'bar.mjs': `import { join } from 'node:path';\nexport const p = join(dir, '${AMBIENT}');\n`,
    'foo.mjs': 'export const x = 1;\n',
  };
  const git = (args) => {
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'diff') return `scripts/${AMBIENT}\n`;
    throw new Error(`unexpected git ${args[0]}`);
  };
  assert.deepEqual(
    deriveCanonicalSelection({
      git,
      listTests: () => ['bar.test.mjs'],
      readSource: (b) => sources[b] ?? null,
    }),
    // No index → the basename fallback contributes nothing → nothing depends on the changed
    // `spine.mjs` in THIS tree → the selector-CLI's empty-selection route, UNIVERSAL.
    [...UNIVERSAL_SELECTION],
  );
});

test('deriveCanonicalSelection: an unwalkable named tree fails SAFE to null, never throws (round-4 015346)', () => {
  // ambient-git-ok: the path is only ever handed to basenameIndexFor, never to git.
  const root = mkdtempSync(join(tmpdir(), 'p4085-nowalk-'));
  try {
    const git = (args) => {
      if (args[0] === 'merge-base') return 'abc123\n';
      if (args[0] === 'diff') return 'scripts/foo.mjs\n';
      throw new Error(`unexpected git ${args[0]}`);
    };
    assert.equal(
      deriveCanonicalSelection({ git, scriptsDir: join(root, 'absent-scripts'), ...canonOpts }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The pairing discipline's THIRD seam: enumerating tests is a property of a TREE too. An injected
// reader with neither a named tree nor a test list leaves nothing to enumerate but the ambient
// checkout — and name-pairing alone would then mint a canonical claim over tests the injected tree
// may not even have (/gpt-review round 5, 6d123d).
test('deriveCanonicalSelection: an injected reader with no tree AND no test list refuses (round-5 6d123d)', () => {
  // A module that name-pairs with a test the AMBIENT tree really has, so a leak would be visible.
  // Interpolated rather than spelled as a literal for the same reason AMBIENT above is: a quoted
  // `scripts/…mjs` path in this file's source text is a graph key by the selector's own rules, and
  // writing it out would weld this test onto board.mjs's closure (measured: board.mjs 122 -> 123).
  const MODULE = 'board';
  const git = (args) => {
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'diff') return `scripts/${MODULE}.mjs\n`;
    throw new Error(`unexpected git ${args[0]}`);
  };
  assert.equal(deriveCanonicalSelection({ git, readSource: () => null }), null);
  // Naming EITHER the tree or the list is enough — the refusal is about having neither.
  assert.ok(
    Array.isArray(
      deriveCanonicalSelection({
        git,
        readSource: () => null,
        listTests: () => [`${MODULE}.test.mjs`],
      }),
    ),
  );
});

test('deriveCanonicalSelection: no scripts/*.mjs in the canonical diff → [] (no canonical claim)', () => {
  assert.deepEqual(
    deriveCanonicalSelection({ git: canonGit({ diff: 'docs/INDEX.md\n' }), ...canonOpts }),
    [],
  );
  assert.deepEqual(deriveCanonicalSelection({ git: canonGit({ diff: '\n' }), ...canonOpts }), []);
});

// --- CLI: canonical-mode lifecycle (repos WITH origin/master) ---------------------

test('CLI plan 2279 leak 1: a full-glob branch run and the scoped merge-push check share the canonical key', () => {
  const repo = tmpRepoWithCanonical();
  commitFooChange(repo);
  // The branch's final push bailed to the FULL battery (range-side churn) and passed green:
  const check1 = runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' });
  assert.equal(check1.status, EXIT_MISS);
  const key = check1.stdout.trim();
  assert.match(key, /^[0-9a-f]{32}$/);
  runCli(repo, ['record', '--key', key], { input: 'scripts/*.test.mjs\n' });
  // The land's merge-push derives the plan's own selection — a DIFFERENT push selection over
  // identical content. Pre-2279 this was the 56/75 MISS; now the canonical key matches.
  const check2 = runCli(repo, ['check'], { input: 'scripts/foo.test.mjs\n' });
  assert.equal(check2.status, EXIT_HIT);
  assert.equal(check2.stdout.trim(), key);
  // …and the full-glob MISS was attributed as the run exceeding the canonical claim.
  const log = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8');
  assert.match(log, /MISS key=\w+ sel=1 mode=canonical reason=run-exceeds-canonical/);
});

test('CLI plan 2279 leak 1: identical canonical selections hit across pushes (record + check both scoped)', () => {
  const repo = tmpRepoWithCanonical();
  commitFooChange(repo);
  const key = recordPassWith(repo, 'scripts/foo.test.mjs\n');
  const again = runCli(repo, ['check'], { input: 'scripts/foo.test.mjs\n' });
  assert.equal(again.status, EXIT_HIT);
  assert.equal(again.stdout.trim(), key);
});

test('CLI plan 2279 leak 2: master-side wiki churn no longer defeats a hit for a selection that cannot read wiki', () => {
  const repo = tmpRepoWithCanonical();
  const baseSha = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  commitFooChange(repo);
  const branchSha = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  const key = recordPassWith(repo, 'scripts/foo.test.mjs\n');
  // master moves: a wiki-only commit lands (the constant parallel-session churn)…
  gitIn(repo, ['checkout', '-q', '--detach', baseSha]);
  writeFileSync(join(repo, 'wiki', 'page.md'), '# page v2 — master moved\n');
  commitAll(repo, 'wiki churn on master');
  const newMaster = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  gitIn(repo, ['update-ref', 'refs/remotes/origin/master', newMaster]);
  // …and the branch rebases onto it (cherry-pick = the same tree the rebase would produce):
  gitIn(repo, ['cherry-pick', branchSha]);
  // Identical scripts content, identical canonical selection, moved wiki oid — the wiki prefix
  // is not keyed for this selection (foo.test.mjs cannot read it), so the recorded pass HITs.
  const after = runCli(repo, ['check'], { input: 'scripts/foo.test.mjs\n' });
  assert.equal(after.status, EXIT_HIT);
  assert.equal(after.stdout.trim(), key);
});

test('CLI plan 2279 leak 2 control: the SAME churn misses when the selected test READS wiki, attributed oid-moved', () => {
  const repo = tmpRepoWithCanonical({
    fooTestSource: "import './foo.mjs';\nconst p = join(REPO, 'wiki', 'page.md');\n",
  });
  const baseSha = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  commitFooChange(repo);
  const branchSha = gitIn(repo, ['rev-parse', 'HEAD']).trim();
  const key = recordPassWith(repo, 'scripts/foo.test.mjs\n');
  gitIn(repo, ['checkout', '-q', '--detach', baseSha]);
  writeFileSync(join(repo, 'wiki', 'page.md'), '# page v2 — master moved\n');
  commitAll(repo, 'wiki churn on master');
  gitIn(repo, [
    'update-ref',
    'refs/remotes/origin/master',
    gitIn(repo, ['rev-parse', 'HEAD']).trim(),
  ]);
  gitIn(repo, ['cherry-pick', branchSha]);
  const after = runCli(repo, ['check'], { input: 'scripts/foo.test.mjs\n' });
  assert.equal(after.status, EXIT_MISS); // wiki IS keyed for this selection — correct fail direction
  assert.notEqual(after.stdout.trim(), key);
  const log = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8');
  assert.match(log, /reason=oid-moved:wiki/);
});

test('CLI plan 2279 soundness pin: record REFUSES when the run selection does not cover the canonical claim', () => {
  const repo = tmpRepoWithCanonical();
  commitFooChange(repo);
  // A hypothetical direct caller ran only dummy.test.mjs — the canonical claim (foo.test.mjs)
  // is NOT proven by that run and must never be recorded under the canonical key.
  const check = runCli(repo, ['check'], { input: 'scripts/dummy.test.mjs\n' });
  assert.equal(check.status, EXIT_MISS);
  const key = check.stdout.trim();
  const rec = runCli(repo, ['record', '--key', key], { input: 'scripts/dummy.test.mjs\n' });
  assert.equal(rec.status, 0); // close-out never blocks…
  assert.match(rec.stderr, /does not cover the canonical claim/);
  const names = existsSync(cacheDirOf(repo))
    ? readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json'))
    : [];
  assert.deepEqual(names, []); // …and nothing was recorded under ANY key
  const log = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8');
  assert.match(log, /RECORD-REFUSED reason=sel-not-superset/);
  assert.match(log, /reason=run-exceeds-canonical/); // the check side already refused the hit arm
});

test('CLI plan 2279: a red run invalidates the canonical entry AND its universal twin', () => {
  const repo = tmpRepoWithCanonical();
  commitFooChange(repo);
  const check = runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' });
  const key = check.stdout.trim();
  runCli(repo, ['record', '--key', key], { input: 'scripts/*.test.mjs\n' });
  assert.equal(readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json')).length, 2);
  const inv = runCli(repo, ['invalidate', '--key', key]);
  assert.equal(inv.status, 0);
  assert.match(inv.stderr, /invalidated universal twin/);
  assert.deepEqual(
    readdirSync(cacheDirOf(repo)).filter((n) => n.endsWith('.json')),
    [],
  );
  // Neither the canonical nor the universal arm may now serve the unchanged content.
  assert.equal(runCli(repo, ['check'], { input: 'scripts/foo.test.mjs\n' }).status, EXIT_MISS);
  assert.equal(runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' }).status, EXIT_MISS);
});

test('CLI plan 2279: a repeat full-glob check HITs via the universal twin — stdout names the SERVING entry', () => {
  const repo = tmpRepoWithCanonical();
  commitFooChange(repo);
  const check1 = runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' });
  const key = check1.stdout.trim();
  runCli(repo, ['record', '--key', key], { input: 'scripts/*.test.mjs\n' });
  // The full-glob run's own claim is the canonical selection (run-exceeds-canonical on the
  // primary arm), so this repeat check is served by the TWIN — and stdout must name that twin,
  // not the primary key of a different entry (xhigh review finding).
  const again = runCli(repo, ['check'], { input: 'scripts/*.test.mjs\n' });
  assert.equal(again.status, EXIT_HIT);
  assert.match(again.stderr, /universal/);
  const served = again.stdout.trim();
  assert.match(served, /^[0-9a-f]{32}$/);
  assert.notEqual(served, key);
  const m = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8').match(
    /HIT key=(\w+) sel=1 mode=universal/,
  );
  assert.ok(m, 'telemetry carries the universal-mode HIT');
  assert.equal(served, m[1]); // stdout and telemetry name the SAME entry
});

test('attributeMiss: key-SET drift (per-selection scoping) cannot mask a real shared-path move', () => {
  // A sibling recorded BEFORE its selection could read backend/ keys a NARROWER path set. The
  // sorted union walk would blame 'backend' (absent-vs-present, alphabetically first) and hide
  // the genuine scripts change — only SHARED paths may evidence content movement.
  const dir = mkdtempSync(join(tmpdir(), 'bpc-attr-'));
  const mkComponents = (oids) => ({
    v: KEY_FORMAT_VERSION,
    nodeMajor: 22,
    gitVersion: 'git version 2.x',
    oids,
    selection: ['scripts/foo.test.mjs'],
  });
  writeFileSync(
    join(dir, `${'1'.repeat(32)}.json`),
    JSON.stringify({ iso: new Date().toISOString(), components: mkComponents({ scripts: 'aaa' }) }),
  );
  const derived = {
    key: '2'.repeat(32),
    components: mkComponents({ scripts: 'bbb', backend: 'ccc' }),
  };
  assert.equal(attributeMiss(dir, derived, Date.now()), 'oid-moved:scripts');
  rmSync(dir, { recursive: true, force: true });
});

test('CLI plan 2279: legacy mode (no origin/master) still keys on the exact push selection', () => {
  const repo = tmpRepo(); // the origin-less plan-1824 fixture
  const key = recordPass(repo);
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_HIT);
  // sel-mismatch attribution: identical content checked under a different (legacy) selection
  const other = runCli(repo, ['check'], { input: 'scripts/other.test.mjs\n' });
  assert.equal(other.status, EXIT_MISS);
  assert.notEqual(other.stdout.trim(), key);
  const log = readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8');
  assert.match(log, /MISS key=\w+ sel=1 mode=legacy reason=sel-mismatch/);
});

test('CLI plan 2279: MISS attribution — expired entries and moved keyed content are named', () => {
  const repo = tmpRepo();
  const key = recordPass(repo);
  const file = join(cacheDirOf(repo), `${key}.json`);
  const entry = JSON.parse(readFileSync(file, 'utf8'));
  entry.iso = new Date(Date.now() - (DEFAULT_TTL_MIN + 5) * 60000).toISOString();
  writeFileSync(file, JSON.stringify(entry));
  assert.equal(runCli(repo, ['check'], { input: SEL }).status, EXIT_MISS);
  assert.match(readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8'), /reason=expired/);
  // oid-moved: re-record fresh, then move content INSIDE the selected test's closure (itself —
  // dummy.test.mjs has no deps, so under plan 2560's closure scoping only editing ITS OWN file
  // moves the key; see the "OUTSIDE the closure" test below for the complementary HIT case).
  const key2 = recordPass(repo);
  writeFileSync(join(repo, 'scripts', 'dummy.test.mjs'), "import 'node:test'; // moved\n");
  commitAll(repo, 'move the selected test itself');
  const moved = runCli(repo, ['check'], { input: SEL });
  assert.equal(moved.status, EXIT_MISS);
  assert.notEqual(moved.stdout.trim(), key2);
  assert.match(
    readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8'),
    /reason=oid-moved:scripts\/dummy\.test\.mjs/,
  );
});

// --- plan 2560: scripts/ import-closure scoping + gate-logic block scoping (retargeted by 2598
// --- from .husky/pre-push to scripts/hooks/pre-push.sh) ----------------------------------------
// The invariant every case below defends: closure scoping may only ever DROP oid-moved misses
// caused by content the selection provably cannot reach — any uncertainty (universal selection, a
// non-flat path, an unresolvable dynamic import, a git error) must widen back to the pre-2560
// whole-tree key, never narrow further.

// plan 2578: the classifier itself is unit-tested beside its OWNER, in
// select-battery-tests.test.mjs. What this file pins is how closurePathsForSelection CONSUMES it.
//
// Every dynamic fixture below is ASSEMBLED (`DYN_IMPORT`) rather than written out. That is not
// style: this file's own source is scanned by the very guard it tests, and a literal `import(p)`
// anywhere in it would classify battery-pass-cache.test.mjs as unresolvable — so every selection
// whose closure reaches THIS file would widen to whole-tree keying, which is precisely plan 2560's
// finding 1 (the feature no-op'ing exactly where it was measured). Assembling the fixture keeps
// the file classifiable; `scripts/select-battery-tests.test.mjs` asserts that it stays that way.
const DYN_IMPORT = `import${'('}p);`;

test('closurePathsForSelection: a dep-free test keys itself only; a dependency joins the closure', () => {
  const sources = {
    'dummy.test.mjs': "import 'node:test';\n",
    'foo.mjs': 'export const x = 1;\n',
    'foo.test.mjs': "import './foo.mjs';\n",
  };
  const readSource = (b) => sources[b] ?? null;
  assert.deepEqual(
    closurePathsForSelection(['scripts/dummy.test.mjs'], {
      readSource,
      basenameIndex: FIXTURE_INDEX,
    }),
    {
      ok: true,
      paths: ['scripts/dummy.test.mjs'],
    },
  );
  assert.deepEqual(
    closurePathsForSelection(['scripts/foo.test.mjs'], {
      readSource,
      basenameIndex: FIXTURE_INDEX,
    }),
    {
      ok: true,
      paths: ['scripts/foo.mjs', 'scripts/foo.test.mjs'],
    },
  );
});

test('closurePathsForSelection: universal / non-flat / unreadable / dynamic-specifier all widen (ok:false)', () => {
  const sources = {
    'dummy.test.mjs': "import 'node:test';\n",
    'dynamic.test.mjs': `const p = process.argv[2];\n${DYN_IMPORT}\n`,
  };
  const readSource = (b) => sources[b] ?? null;
  assert.equal(
    closurePathsForSelection([...UNIVERSAL_SELECTION], { readSource, basenameIndex: FIXTURE_INDEX })
      .ok,
    false,
  );
  assert.equal(
    closurePathsForSelection(['a.mjs'], { readSource, basenameIndex: FIXTURE_INDEX }).ok,
    false,
  ); // not scripts/*.test.mjs
  assert.equal(
    closurePathsForSelection(['scripts/ghost.test.mjs'], {
      readSource,
      basenameIndex: FIXTURE_INDEX,
    }).ok,
    false,
  ); // unreadable
  const dyn = closurePathsForSelection(['scripts/dynamic.test.mjs'], {
    readSource,
    basenameIndex: FIXTURE_INDEX,
  });
  assert.equal(dyn.ok, false);
  assert.match(dyn.reason, /^dynamic-import:/);
});

// plan 2578 finding 2: the dominant cross-script spawn idiom in this repo is
// `const CLI = join(HERE, 'sibling.mjs')` — no `scripts/` substring, no interpolation. The plan-2560
// closure could not see it, so a selection keyed the entry test but NOT the CLI it drives: editing
// that CLI re-computed the same key and served a HIT for changed content (a false green).
test('closurePathsForSelection: a self-dir sibling-join spawn target is IN the closure (plan 2578 finding 2)', () => {
  const sources = {
    'spawner.test.mjs':
      "import { dirname, join } from 'node:path';\n" +
      "import { fileURLToPath } from 'node:url';\n" +
      'const HERE = dirname(fileURLToPath(import.meta.url));\n' +
      "const CLI = join(HERE, 'target.mjs');\n" +
      "execFileSync('node', [CLI]);\n",
    'target.mjs': 'export const x = 1;\n',
  };
  const readSource = (b) => sources[b] ?? null;
  assert.deepEqual(
    closurePathsForSelection(['scripts/spawner.test.mjs'], {
      readSource,
      basenameIndex: FIXTURE_INDEX,
    }),
    {
      ok: true,
      paths: ['scripts/spawner.test.mjs', 'scripts/target.mjs'],
    },
  );
});

// plan 2578: the key's closure walk is PERMISSIVE (`allLiterals`), unlike the selector's
// spawn-gated one. A LIBRARY module that holds a sibling CLI path in a constant has no
// child-process call on that line — the selector deliberately drops that edge to avoid welding the
// dependency graph into one blob, and for the KEY that same drop is a false green.
test('closurePathsForSelection: a library-held CLI constant is keyed even with no spawn on its line', () => {
  const sources = {
    'lib.test.mjs': "import './lib.mjs';\n",
    'lib.mjs':
      "import { dirname, join } from 'node:path';\n" +
      "import { fileURLToPath } from 'node:url';\n" +
      'const HERE = dirname(fileURLToPath(import.meta.url));\n' +
      "const CLI = join(HERE, 'spawned.mjs');\n" +
      'export const run = () => CLI;\n',
    'spawned.mjs': 'export const y = 2;\n',
  };
  const readSource = (b) => sources[b] ?? null;
  assert.deepEqual(
    closurePathsForSelection(['scripts/lib.test.mjs'], {
      readSource,
      basenameIndex: FIXTURE_INDEX,
    }),
    {
      ok: true,
      paths: ['scripts/lib.mjs', 'scripts/lib.test.mjs', 'scripts/spawned.mjs'],
    },
  );
});

// The finding-1 regression pin, on REAL repo sources rather than synthetic fixtures — synthetic-only
// fixtures are exactly what hid both plan-2560 bugs. plan 2560's guard matched
// `FLAT_TEST_PATH_RX.exec(path)` (plain RegExp.prototype.exec) as a child-process call, so every
// selection whose closure reached battery-pass-cache.mjs fell back to whole-tree keying and the
// feature no-op'd where it had been measured.
test('closurePathsForSelection: the pass-cache own-closure selection NARROWS on real sources (plan 2578 finding 1)', () => {
  const readSource = makeReadSource(REPO_SCRIPTS);
  // Name the tree, so the reader and the basename index describe one checkout (plan 4085).
  const res = closurePathsForSelection(['scripts/pass-cache-kernel.test.mjs'], {
    readSource,
    scriptsDir: REPO_SCRIPTS,
  });
  assert.equal(res.ok, true, `expected a narrowed key, got widen: ${res.reason}`);
  assert.ok(
    res.paths.includes('scripts/battery-pass-cache.mjs'),
    'the closure must reach battery-pass-cache.mjs — otherwise this pins nothing',
  );
  assert.ok(
    res.paths.length < readdirSync(REPO_SCRIPTS).filter((f) => f.endsWith('.mjs')).length,
    'a narrowed key must cover fewer files than the whole tree',
  );
});

test('gateLogicKey: the WHOLE gate-logic file is keyed, by its blob oid — no block scoping (plan 2598)', () => {
  const lsTree = (oid) => (args) => {
    if (args[0] === 'ls-tree') return `100644 blob ${oid}\t${GATE_LOGIC_PATH}\n`;
    throw new Error('gateLogicKey must not spawn anything but ls-tree');
  };
  const r1 = gateLogicKey(lsTree('a'.repeat(40)));
  assert.equal(r1.ok, true);
  // plan 3963: the component is now one `path:oid` field per sourced gate-logic file rather than a
  // bare oid (see the test below for why every file must be covered), so this pins the DISPATCHER's
  // own contribution inside that hash rather than the hash being equal to it.
  assert.match(r1.hash, new RegExp(`(^| )${GATE_LOGIC_PATH}:${'a'.repeat(40)}( |$)`));
  // The blob oid IS the whole file's content hash, so ANY edit anywhere in the hook moves it —
  // including the verdict-deciding helpers (run_battery_with_retry, the selection assembly) that
  // sit outside the old marker pair and were therefore invisible to the retired block scoping.
  assert.notEqual(gateLogicKey(lsTree('b'.repeat(40))).hash, r1.hash);

  // A path git does not report is genuinely absent: still ok, and still narrowable. Read through
  // parseLsTree, so output this module cannot parse can never masquerade as a present file.
  const allAbsent = GATE_LOGIC_PATHS.map((p) => `${p}:absent`).join(' ');
  const absent = gateLogicKey((args) => (args[0] === 'ls-tree' ? '\n' : ''));
  assert.equal(absent.ok, true);
  assert.equal(absent.hash, allAbsent);
  const unparseable = gateLogicKey(() => 'some warning git printed\n');
  assert.equal(unparseable.hash, allAbsent);

  // Only a git failure is ok:false — the do-not-narrow signal, never read as "absent".
  assert.equal(
    gateLogicKey(() => {
      throw new Error('not a repo');
    }).ok,
    false,
  );
});

// plan 3963 regression pin. The split moved every verdict-deciding line OUT of
// scripts/hooks/pre-push.sh — it is now a ~27-line dispatcher that sources pre-push-core.sh (the
// generic gates, including run_battery_with_retry and the selection assembly) and, when present,
// pre-push-project.sh. Keying the dispatcher ALONE would reinstate exactly the failure plan 2598
// deleted the block scoping to kill: a fix to a misclassification bug in run_battery_with_retry
// would not move the key, so entries recorded by the buggy version stay servable after the bug is
// fixed — a false green surviving its own remediation. Every file the dispatcher sources is
// therefore part of the component.
test('gateLogicKey: a change in EITHER sourced gate file moves the key, not just the dispatcher (plan 3963)', () => {
  // One fake tree, one oid per gate-logic path — flip any single one and the component must move.
  const treeWith = (oids) => (args) => {
    if (args[0] !== 'ls-tree') throw new Error('gateLogicKey must not spawn anything but ls-tree');
    return (
      Object.entries(oids)
        .map(([path, oid]) => `100644 blob ${oid}\t${path}`)
        .join('\n') + '\n'
    );
  };
  const base = {
    'scripts/hooks/pre-push.sh': 'a'.repeat(40),
    'scripts/hooks/pre-push-core.sh': 'b'.repeat(40),
    'scripts/hooks/pre-push-project.sh': 'c'.repeat(40),
  };
  const baseKey = gateLogicKey(treeWith(base));
  assert.equal(baseKey.ok, true);

  for (const path of Object.keys(base)) {
    const moved = gateLogicKey(treeWith({ ...base, [path]: 'd'.repeat(40) }));
    assert.notEqual(
      moved.hash,
      baseKey.hash,
      `an edit to ${path} must move the gate-logic key — otherwise a recorded battery pass ` +
        'survives the very gate change that should invalidate it',
    );
  }

  // The core-only checkout (the public coordination core: no pre-push-project.sh) still keys
  // cleanly, and is DISTINCT from the same tree that also carries a project file — absence is
  // content, the convention this module already uses for a missing path.
  const coreOnly = gateLogicKey(
    treeWith({
      'scripts/hooks/pre-push.sh': base['scripts/hooks/pre-push.sh'],
      'scripts/hooks/pre-push-core.sh': base['scripts/hooks/pre-push-core.sh'],
    }),
  );
  assert.equal(coreOnly.ok, true);
  assert.notEqual(coreOnly.hash, baseKey.hash);
});

test('keyForSelection: .husky is ALWAYS keyed wholesale now (plan 2598); the gate-logic hash is its own component', () => {
  const baseState = {
    oids: new Map([
      ['scripts', 'a'.repeat(40)],
      ['.husky', 'b'.repeat(40)],
    ]),
    nodeMajor: 22,
    gitVersion: 'g',
    scriptOidsOk: false,
  };
  const resolved = keyForSelection(
    { ...baseState, gateLogic: { ok: true, hash: 'deadbeef12345678' } },
    [...UNIVERSAL_SELECTION],
  );
  // The block no longer lives in .husky, so a resolved block may NOT stand in for it.
  assert.equal(resolved.components.oids['.husky'], 'b'.repeat(40));
  assert.equal(resolved.components.gateLogic, 'deadbeef12345678');

  const unresolved = keyForSelection({ ...baseState, gateLogic: { ok: false } }, [
    ...UNIVERSAL_SELECTION,
  ]);
  assert.equal(unresolved.components.oids['.husky'], 'b'.repeat(40));
  assert.equal(unresolved.components.gateLogic, null);
  assert.notEqual(resolved.key, unresolved.key);
});

test('keyForSelection: a NARROWED key still covers scripts/hooks/pre-push.sh — via the gateLogic component', () => {
  // The plan-2598 acceptance pin. The closure walk reaches flat scripts/*.mjs only, so if the
  // gate-logic file were not its own component, editing it alone would leave a narrowed key
  // unchanged and `check` could serve a HIT for a push whose gate logic had moved.
  const sources = { 'dummy.test.mjs': "import 'node:test';\n" };
  const readSource = (b) => sources[b] ?? null;
  const state = {
    oids: new Map([
      ['scripts', 'a'.repeat(40)],
      ['scripts/dummy.test.mjs', 'c'.repeat(40)],
    ]),
    nodeMajor: 22,
    gitVersion: 'g',
    scriptOidsOk: true,
    gateLogic: { ok: true, hash: '1111111111111111' },
  };
  const before = keyForSelection(state, ['scripts/dummy.test.mjs'], readSource, {
    basenameIndex: FIXTURE_INDEX,
  });
  // Confirm the key really IS narrowed — otherwise this test would pass vacuously off the
  // whole-tree 'scripts' oid, which covers the hook file anyway.
  assert.deepEqual(
    Object.keys(before.components.oids).filter((p) => p.startsWith('scripts')),
    ['scripts/dummy.test.mjs'],
  );
  const after = keyForSelection(
    { ...state, gateLogic: { ok: true, hash: '2222222222222222' } },
    ['scripts/dummy.test.mjs'],
    readSource,
  );
  assert.notEqual(after.key, before.key);
});

test('keyForSelection: an UNRESOLVABLE gate-logic file refuses to narrow (widen to the whole scripts tree)', () => {
  // ok:false means we cannot key the hook file directly; narrowing would then leave it covered by
  // nothing at all. The whole-tree 'scripts' oid covers it — or its absence — the pre-2578 way.
  const sources = { 'dummy.test.mjs': "import 'node:test';\n" };
  const readSource = (b) => sources[b] ?? null;
  const state = {
    oids: new Map([
      ['scripts', 'a'.repeat(40)],
      ['scripts/dummy.test.mjs', 'c'.repeat(40)],
    ]),
    nodeMajor: 22,
    gitVersion: 'g',
    scriptOidsOk: true,
    gateLogic: { ok: false },
  };
  const { components } = keyForSelection(state, ['scripts/dummy.test.mjs'], readSource, {
    basenameIndex: FIXTURE_INDEX,
  });
  assert.deepEqual(
    Object.keys(components.oids).filter((p) => p.startsWith('scripts')),
    ['scripts'],
  );
  assert.equal(components.gateLogic, null);
});

test("keyForSelection: scriptOidsOk + a resolvable selection scopes the key to the closure's own files", () => {
  const sources = { 'dummy.test.mjs': "import 'node:test';\n" };
  const readSource = (b) => sources[b] ?? null;
  const state = {
    oids: new Map([
      ['scripts', 'a'.repeat(40)],
      ['scripts/dummy.test.mjs', 'c'.repeat(40)],
    ]),
    nodeMajor: 22,
    gitVersion: 'g',
    scriptOidsOk: true,
    gateLogic: { ok: true, hash: 'absent' },
  };
  const { components } = keyForSelection(state, ['scripts/dummy.test.mjs'], readSource, {
    basenameIndex: FIXTURE_INDEX,
  });
  const scriptsKeys = Object.keys(components.oids).filter((p) => p.startsWith('scripts'));
  assert.deepEqual(scriptsKeys, ['scripts/dummy.test.mjs']);

  // scriptOidsOk: false (the recursive ls-tree probe failed this run) must fall back to the
  // whole-tree 'scripts' oid, never key on an unproven individual path.
  const fallback = keyForSelection(
    { ...state, scriptOidsOk: false },
    ['scripts/dummy.test.mjs'],
    readSource,
  );
  assert.deepEqual(
    Object.keys(fallback.components.oids).filter((p) => p.startsWith('scripts')),
    ['scripts'],
  );
});

test('gatherRepoState plan 2598: a genuinely ABSENT gate-logic file resolves as absent, not as doubt', () => {
  // A repo with no scripts/hooks/pre-push.sh (fixture repos, and any sibling that never adopted
  // plan 2576's move) has no gate logic to cover. It must stay narrowable — otherwise this plan
  // would silently revoke plan 2578's closure scoping everywhere the file does not exist.
  const repo = tmpRepo();
  const state = gatherRepoState(makeGit({ cwd: repo }));
  assert.equal(state.ok, true);
  assert.equal(state.oids.has(GATE_LOGIC_PATH), false, 'fixture repo must have no gate-logic file');
  assert.equal(state.gateLogic.ok, true);
  // plan 3963: every sourced gate-logic file contributes its own `path:oid` field, so a repo
  // carrying NONE of them reads absent on each — still ok, still narrowable, which is the property
  // this test exists to pin.
  assert.equal(state.gateLogic.hash, GATE_LOGIC_PATHS.map((p) => `${p}:absent`).join(' '));
});

// plan 4071 review finding 859192: gatherRepoState's default (EXTERNAL_TREE_PREFIXES-only) path
// set has no oid and no dirty-status coverage for a CONFIGURED scoped prefix outside that list —
// `legacy-config/` here stands in for a project-named tree neither DEFAULT_EXTERNAL_TREE_PREFIXES
// nor vetapp's own coord.config.json row happens to cover.
test('gatherRepoState plan 4071 review finding 859192: a configured-only scoped prefix gets an oid only once threaded through', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'legacy-config'), { recursive: true });
  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'v1\n');
  commitAll(repo, 'add a tree no EXTERNAL_TREE_PREFIXES entry covers');
  const git = makeGit({ cwd: repo });

  // Reproduces the bug: without the prefix threaded through, its HEAD oid is simply absent from
  // the gathered state — nothing downstream could ever key on it.
  const withoutConfig = gatherRepoState(git);
  assert.equal(withoutConfig.ok, true);
  assert.equal(withoutConfig.oids.has('legacy-config'), false);

  // The fix: threading it through surfaces the oid.
  const withConfig = gatherRepoState(git, { scopedPrefixes: ['legacy-config/'] });
  assert.equal(withConfig.ok, true);
  assert.ok(withConfig.oids.has('legacy-config'));

  // And it is genuinely load-bearing — a content change under it moves the oid.
  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'v2\n');
  commitAll(repo, 'change the configured-only tree');
  const after = gatherRepoState(makeGit({ cwd: repo }), { scopedPrefixes: ['legacy-config/'] });
  assert.notEqual(after.oids.get('legacy-config'), withConfig.oids.get('legacy-config'));
});

test('gatherRepoState plan 4071 review finding 859192: dirt under a configured-only scoped prefix is caught only once threaded through', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'legacy-config'), { recursive: true });
  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'v1\n');
  commitAll(repo, 'add the configured-only tree');
  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'dirty\n'); // uncommitted
  const git = makeGit({ cwd: repo });
  // Reproduces the bug: the dirt is invisible to the default status check — a false "clean" that
  // would key on stale HEAD content while the working tree the battery actually reads differs.
  assert.equal(gatherRepoState(git).ok, true);
  // The fix: threading the prefix through makes the same dirt refuse the cache.
  const withConfig = gatherRepoState(git, { scopedPrefixes: ['legacy-config/'] });
  assert.equal(withConfig.ok, false);
  assert.equal(withConfig.reason, 'dirty-gated-paths');
});

// The end-to-end pin: deriveKey (the only caller a real check/record run goes through) must
// actually mint a DIFFERENT key when content changes under a configured-only scoped prefix — the
// gatherRepoState fix alone is not enough, because keyForSelection's own keyedPaths() call (see
// its plan 4071 review finding 859192 comment) must also fold scopedPrefixes into the prefix
// list it offers, or the gathered oid would sit in `state.oids` unread.
test('deriveKey plan 4071 review finding 859192: the key moves when content changes under a configured-only scoped prefix', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'legacy-config'), { recursive: true });
  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'v1\n');
  commitAll(repo, 'add the configured-only tree');
  const git = makeGit({ cwd: repo });
  const scopedPrefixes = ['legacy-config/'];
  const before = deriveKey({ git, selection: [SEL.trim()], scopedPrefixes });
  assert.equal(before.ok, true);

  writeFileSync(join(repo, 'legacy-config', 'note.txt'), 'v2\n');
  commitAll(repo, 'change the configured-only tree');
  const after = deriveKey({ git, selection: [SEL.trim()], scopedPrefixes });
  assert.equal(after.ok, true);
  assert.notEqual(after.key, before.key);
});

// plan 4071 review finding 9179f0/99567b: with BOTH an ancestor and a nested descendant scoped
// prefix configured (e.g. `backend/` and `backend/scripts/`), the combined `git ls-tree` call
// gatherRepoState issues cannot resolve both at once — the descendant forces git to recurse, and
// the ancestor's own top-level tree entry silently drops out of the output. Reproduced directly
// against a real repo below, then pinned end to end.
test('gatherRepoState plan 4071 review finding 9179f0/99567b: git itself drops the ancestor entry when queried alongside a nested descendant', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'backend', 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'top.txt'), 'v1\n');
  writeFileSync(join(repo, 'backend', 'scripts', 'x.txt'), 's1\n');
  commitAll(repo, 'add backend/ with a direct file and a nested scripts/ subtree');
  const git = makeGit({ cwd: repo });
  const raw = parseLsTree(git(['ls-tree', 'HEAD', '--', 'backend', 'backend/scripts']));
  assert.ok(
    !raw.has('backend'),
    'sanity check: this is what the bug looked like before the fix — git itself, queried this ' +
      'way, never returns the ancestor entry',
  );
  assert.ok(raw.has('backend/scripts'));
});

test('gatherRepoState plan 4071 review finding 9179f0/99567b: an ancestor and a nested descendant scoped prefix both keep their own live oid', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'backend', 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'top.txt'), 'v1\n');
  writeFileSync(join(repo, 'backend', 'scripts', 'x.txt'), 's1\n');
  commitAll(repo, 'add backend/ with a direct file and a nested scripts/ subtree');
  const git = makeGit({ cwd: repo });
  const scopedPrefixes = ['backend/', 'backend/scripts/'];

  const before = gatherRepoState(git, { scopedPrefixes });
  assert.equal(before.ok, true);
  assert.ok(before.oids.has('backend'), 'the ancestor must be REPORTED, never silently skipped');
  assert.notEqual(before.oids.get('backend'), 'absent', 'the ancestor must not read as absent');
  assert.ok(before.oids.has('backend/scripts'));
  assert.notEqual(before.oids.get('backend/scripts'), 'absent');

  // A change ONLY under the ancestor's own direct file (nothing under the nested descendant) must
  // still move the ancestor's oid — this is the exact soundness gap the finding named: before the
  // fix, `backend` always read as 'absent', so a change here could never bust the key.
  writeFileSync(join(repo, 'backend', 'top.txt'), 'v2\n');
  commitAll(repo, 'change only the ancestor-level file');
  const after = gatherRepoState(makeGit({ cwd: repo }), { scopedPrefixes });
  assert.equal(after.ok, true);
  assert.notEqual(after.oids.get('backend'), before.oids.get('backend'));
  assert.equal(
    after.oids.get('backend/scripts'),
    before.oids.get('backend/scripts'),
    'the untouched nested descendant must not move',
  );
});

test('gatherRepoState plan 4071 review finding 9179f0/99567b: a genuinely absent scoped prefix is recorded as an explicit absence, not silently omitted', () => {
  const repo = tmpRepo();
  const git = makeGit({ cwd: repo });
  const state = gatherRepoState(git, { scopedPrefixes: ['never-created/'] });
  assert.equal(state.ok, true);
  assert.ok(
    state.oids.has('never-created'),
    'a requested-but-missing path must be REPORTED as absent, not skipped from the map entirely',
  );
  assert.equal(state.oids.get('never-created'), 'absent');
});

test('deriveKey plan 4071 review finding 9179f0/99567b: the key moves when only the ANCESTOR of a nested scoped-prefix pair changes', () => {
  const repo = tmpRepo();
  mkdirSync(join(repo, 'backend', 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'backend', 'top.txt'), 'v1\n');
  writeFileSync(join(repo, 'backend', 'scripts', 'x.txt'), 's1\n');
  commitAll(repo, 'add backend/ with a direct file and a nested scripts/ subtree');
  const git = makeGit({ cwd: repo });
  const scopedPrefixes = ['backend/', 'backend/scripts/'];
  const before = deriveKey({ git, selection: [SEL.trim()], scopedPrefixes });
  assert.equal(before.ok, true);

  writeFileSync(join(repo, 'backend', 'top.txt'), 'v2\n');
  commitAll(repo, 'change only the ancestor-level file');
  const after = deriveKey({ git, selection: [SEL.trim()], scopedPrefixes });
  assert.equal(after.ok, true);
  assert.notEqual(after.key, before.key);
});

test("CLI plan 2560: a scripts/ change OUTSIDE the selected test's closure now HITs (the fix)", () => {
  const repo = tmpRepo(); // dummy.test.mjs has no refs at all — its closure is itself only
  const key = recordPass(repo);
  writeFileSync(
    join(repo, 'scripts', 'extra.mjs'),
    "// unrelated — outside dummy.test.mjs's closure\n",
  );
  commitAll(repo, 'unrelated scripts file — a coord/infra land shape');
  const after = runCli(repo, ['check'], { input: SEL });
  assert.equal(after.status, EXIT_HIT); // the scoped key never saw extra.mjs move
  assert.equal(after.stdout.trim(), key);
});

test('CLI plan 2560: a dynamic import in the selected test forces whole-tree keying (widen)', () => {
  const repo = tmpRepo();
  writeFileSync(
    join(repo, 'scripts', 'dummy.test.mjs'),
    `import 'node:test';\nconst p = process.argv[2]; ${DYN_IMPORT}\n`,
  );
  commitAll(repo, 'a dynamic, unresolvable import');
  const key = recordPass(repo);
  // Under closure scoping this file would be OUTSIDE dummy.test.mjs's resolvable refs and would
  // HIT (see the test above) — widened, it must still MISS: the dynamic import means the static
  // walk cannot prove extra.mjs is unreachable.
  writeFileSync(join(repo, 'scripts', 'extra.mjs'), '// unrelated\n');
  commitAll(repo, 'unrelated scripts file (widened case)');
  const after = runCli(repo, ['check'], { input: SEL });
  assert.equal(after.status, EXIT_MISS);
  assert.notEqual(after.stdout.trim(), key);
  assert.match(
    readFileSync(join(cacheDirOf(repo), 'telemetry.log'), 'utf8'),
    /reason=oid-moved:scripts$/m,
  );
});

// check → record with an arbitrary stdin selection, canonical-mode twin of recordPass().
function recordPassWith(repo, input) {
  const key = runCli(repo, ['check'], { input }).stdout.trim();
  runCli(repo, ['record', '--key', key], { input });
  return key;
}

// --- arg spec -----------------------------------------------------------------

test('CACHE_ARG_SPEC: exactly the flags the CLI reads, no booleans', () => {
  assert.deepEqual(
    [...CACHE_ARG_SPEC.value],
    ['key', 'label', 'ttl-min', 'merge-base', 'merge-base-out'],
  );
  assert.deepEqual([...CACHE_ARG_SPEC.boolean], []);
});

// plan 2578 /sonnet-review high finding: invalidate() skips the recursive per-file scripts oid
// probe (it can only ever build the UNIVERSAL key). That is only sound because the universal key
// never consults those oids — an invariant that lived in a DIFFERENT function with no test on it.
// Pin it here: the universal key must be identical whichever way the state was gathered, so a
// future change that makes closurePathsForSelection scope universal selections fails loudly rather
// than silently orphaning the universal twin invalidate() is trying to drop.
test('universalKeyFor: identical with and without the per-file scripts oid probe (plan 2578)', () => {
  const repo = tmpRepo();
  const git = (args) => gitIn(repo, args);
  const withOids = gatherRepoState(git);
  const withoutOids = gatherRepoState(git, { perFileScriptOids: false });
  assert.equal(withOids.ok, true);
  assert.equal(withoutOids.ok, true);
  assert.equal(withOids.scriptOidsOk, true);
  assert.equal(withoutOids.scriptOidsOk, false);
  assert.equal(universalKeyFor(withOids).key, universalKeyFor(withoutOids).key);
});

// plan 3963 review finding 434629: GATE_LOGIC_PATHS is a HAND-MAINTAINED list of the hook files
// whose content keys the battery pass-cache. It already covers the three files the plan-3963
// split produced (pre-push.sh, pre-push-core.sh, pre-push-project.sh), but nothing stops a
// FUTURE hook file from being sourced into the chain without also being added here — a stale
// cache entry could then be served after gate logic changed in the file nobody remembered to add.
//
// This is a DRIFT-PIN, not a runtime source-discovery parser (the fix this finding asks for is
// proportionate to the risk: convert silent drift into a loud test failure, not build a shell-
// source-directive interpreter into battery-pass-cache.mjs itself). It reads the REAL hook files
// off disk, extracts every `. ./scripts/hooks/<file>` directive they contain (the exact shape
// scripts/hooks/pre-push.sh's dispatcher uses — see its own header on why sourcing, never exec,
// is load-bearing here), and asserts every sourced path is already a member of GATE_LOGIC_PATHS.
//
// plan 3963 review round 2, finding bade52: the walk used to be a hand-listed, ONE-LEVEL scan of
// exactly the three files the plan-3963 split produced. That misses a file sourced only
// TRANSITIVELY — e.g. if pre-push-project.sh someday grows its own `. ./scripts/hooks/<file>.sh`
// directive, the old scan would never open that inner file to look for further directives inside
// it. Below walks the sourcing graph as a proper closure (BFS from pre-push.sh, cycle-safe via a
// visited-set) instead of a fixed file list, and additionally asserts the reverse direction: every
// GATE_LOGIC_PATHS entry under scripts/hooks/ must itself be reached by that closure (or at least
// exist on disk) — so the list can carry neither a missing entry nor a stale one nobody sources
// any more.
// finding f19a32: recognizes every POSIX spelling this repo's own shellcheck-clean style could
// plausibly use for a same-directory source directive — bare `.` or `source`, the path bare or
// wrapped in single/double quotes: `. ./x.sh`, `source ./x.sh`, `. "./x.sh"`, `. './x.sh'`. A
// VARIABLE-based path (e.g. `. "$HOOKS_DIR/x.sh"`) is deliberately NOT recognized — resolving an
// arbitrary shell variable at parse time would need a real interpreter, which is out of
// proportion for a drift-PIN (see this function's own caller-side comment). No call site in this
// repo uses one today; if one appears, the reverse "every listed entry is reached" check in the
// test below would at least flag it as a stale-looking entry rather than silently missing it.
const SOURCE_DIRECTIVE_RX =
  /^\s*(?:\.|source)\s+["']?\.\/scripts\/hooks\/([A-Za-z0-9_.-]+\.sh)["']?\s*$/gm;

// Round 3, finding 81c189: a directive guarded by an `[ -f ./scripts/hooks/<file>.sh ]` test in the
// SAME file (the dispatcher's conditional project-hook source) is OPTIONAL — in a generic-core
// checkout that file is legitimately absent, so its absence is skipped rather than failed.
const OPTIONAL_SOURCE_GUARD_RX = /\[\s+-f\s+\.\/scripts\/hooks\/([A-Za-z0-9_.-]+\.sh)\s+\]/g;

function sourcedHookFilesFrom(entryPath) {
  const hooksDir = resolve(entryPath, '..');
  const visited = new Set();
  const optional = new Set();
  const queue = [entryPath];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) {
      continue;
    }
    if (optional.has(file) && !existsSync(file)) {
      continue; // guarded by an `-f` test in its sourcing file — absent is a legal state
    }
    // finding 2dd374: existence must be proven BEFORE the file is marked reached — the old order
    // added a missing sourced file to `visited` (this function's own "reached" set) FIRST, so a
    // hook file renamed/removed while something still sources its old path (or while
    // GATE_LOGIC_PATHS still lists it) would silently count as "reached" instead of failing
    // loudly. A sourced-but-missing file is a hard failure naming the path, not a skip.
    assert.ok(
      existsSync(file),
      `sourced hook file does not exist on disk: ${file} (finding 2dd374) — a stale source ` +
        `directive, or a hook file renamed/removed without updating what sources it`,
    );
    visited.add(file);
    const text = readFileSync(file, 'utf8');
    for (const g of text.matchAll(OPTIONAL_SOURCE_GUARD_RX)) {
      optional.add(join(hooksDir, g[1]));
    }
    for (const m of text.matchAll(SOURCE_DIRECTIVE_RX)) {
      const sourced = join(hooksDir, m[1]);
      if (!visited.has(sourced)) {
        queue.push(sourced);
      }
    }
  }
  return visited;
}

test('plan 3963 review finding bade52: GATE_LOGIC_PATHS covers every scripts/hooks/*.sh reached by the TRANSITIVE sourcing closure from pre-push.sh (drift pin)', () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const hooksDir = join(repoRoot, 'scripts', 'hooks');
  const entryPath = join(hooksDir, 'pre-push.sh');
  assert.ok(existsSync(entryPath), 'test setup bug: expected scripts/hooks/pre-push.sh to exist');

  const reachedAbs = sourcedHookFilesFrom(entryPath);
  // The entry file sources itself trivially (BFS seed) — it is always "reached", whether or not
  // any other file sources it back. Convert to repo-relative posix-style paths, matching the
  // GATE_LOGIC_PATHS string shape ('scripts/hooks/<file>').
  const reached = new Set(
    [...reachedAbs].map((p) => `scripts/hooks/${p.slice(hooksDir.length + 1).replace(/\\/g, '/')}`),
  );
  assert.ok(
    reached.size >= 2,
    'test setup bug: the closure from pre-push.sh reached fewer than 2 files — expected at ' +
      'least pre-push.sh and pre-push-core.sh',
  );

  const covered = new Set(GATE_LOGIC_PATHS);
  const uncovered = [...reached].filter((p) => !covered.has(p));
  assert.deepEqual(
    uncovered,
    [],
    `the sourcing closure from scripts/hooks/pre-push.sh now reaches ${JSON.stringify(uncovered)}, ` +
      `which is NOT in GATE_LOGIC_PATHS (scripts/coord/battery-pass-cache.mjs) — add it there, ` +
      `or a fix to that file's gate logic could keep serving a stale pre-fix cache entry ` +
      `(finding bade52)`,
  );

  // A file reached only through an `[ -f ... ]` guard (see OPTIONAL_SOURCE_GUARD_RX) is legally
  // absent — plan 3958: the public coord-kit ships core-only, with no pre-push-project.sh on
  // disk at all, which is exactly the shape the guard at scripts/hooks/pre-push.sh exists for
  // (the big comment above GATE_LOGIC_PATHS: "keeps a core-only checkout... keyable rather than
  // permanently uncacheable"). Recompute which GATE_LOGIC_PATHS entries are guarded this way from
  // the same source text the reachability BFS already walked, so an entry that is BOTH
  // guarded-optional AND absent from disk is a legitimate state, not a stale one.
  const guardedOptional = new Set();
  for (const abs of reachedAbs) {
    for (const g of readFileSync(abs, 'utf8').matchAll(OPTIONAL_SOURCE_GUARD_RX)) {
      guardedOptional.add(`scripts/hooks/${g[1]}`);
    }
  }

  // Reverse direction: every GATE_LOGIC_PATHS entry under scripts/hooks/ must be reached by the
  // closure, guarded-optional, or at least still exist on disk — otherwise the list can carry a
  // STALE entry nothing sources any more (e.g. a hook file renamed/removed but never dropped from
  // the list).
  const hookLogicPaths = GATE_LOGIC_PATHS.filter((p) => p.startsWith('scripts/hooks/'));
  const staleEntries = hookLogicPaths.filter(
    (p) =>
      !reached.has(p) && !guardedOptional.has(p) && !existsSync(join(repoRoot, ...p.split('/'))),
  );
  assert.deepEqual(
    staleEntries,
    [],
    `GATE_LOGIC_PATHS names ${JSON.stringify(staleEntries)}, which the sourcing closure from ` +
      `pre-push.sh does not reach AND which does not exist on disk — a stale entry (finding ` +
      `bade52's reverse direction)`,
  );

  // Falsifiability check: this assertion must actually be ABLE to fail, not just currently pass
  // because GATE_LOGIC_PATHS happens to be complete today. Re-run the same uncovered-computation
  // against a deliberately INCOMPLETE stand-in (GATE_LOGIC_PATHS minus one real, reached entry —
  // never a mutation of the real exported array) and confirm it reports that entry as uncovered.
  const oneRealReachedPath = [...reached].find((p) => p !== 'scripts/hooks/pre-push.sh');
  assert.ok(
    oneRealReachedPath,
    'test setup bug: expected a second reached hook file besides the entry point',
  );
  const incompleteCovered = new Set(GATE_LOGIC_PATHS.filter((p) => p !== oneRealReachedPath));
  const wouldBeUncovered = [...reached].filter((p) => !incompleteCovered.has(p));
  assert.deepEqual(
    wouldBeUncovered,
    [oneRealReachedPath],
    'sanity check on the test itself: dropping one real reached path from the covered set must ' +
      'make this same computation report it uncovered, or the drift-pin above could never fail ' +
      'no matter how incomplete GATE_LOGIC_PATHS became',
  );
});

test('plan 3963 review finding f19a32: sourcedHookFilesFrom() recognizes every supported POSIX source-directive spelling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-source-spellings-'));
  const hooksDir = join(dir, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const entryPath = join(hooksDir, 'entry.sh');
  writeFileSync(join(hooksDir, 'a.sh'), '#!/usr/bin/env sh\necho a\n');
  writeFileSync(join(hooksDir, 'b.sh'), '#!/usr/bin/env sh\necho b\n');
  writeFileSync(join(hooksDir, 'c.sh'), '#!/usr/bin/env sh\necho c\n');
  writeFileSync(join(hooksDir, 'd.sh'), '#!/usr/bin/env sh\necho d\n');
  writeFileSync(
    entryPath,
    [
      '#!/usr/bin/env sh',
      '. ./scripts/hooks/a.sh', // the pre-existing, already-supported spelling
      'source ./scripts/hooks/b.sh', // `source` instead of bare `.`
      '. "./scripts/hooks/c.sh"', // double-quoted path
      ". './scripts/hooks/d.sh'", // single-quoted path
      '',
    ].join('\n'),
  );

  const reachedAbs = sourcedHookFilesFrom(entryPath);
  const reached = new Set(
    [...reachedAbs].map((p) => p.slice(hooksDir.length + 1).replace(/\\/g, '/')),
  );
  assert.deepEqual(
    [...reached].sort(),
    ['a.sh', 'b.sh', 'c.sh', 'd.sh', 'entry.sh'].sort(),
    `the walk must recognize \`. ./x.sh\`, \`source ./x.sh\`, \`. "./x.sh"\`, and \`. './x.sh'\` ` +
      `alike (finding f19a32); got ${JSON.stringify([...reached].sort())}`,
  );
});

test('plan 3963 review finding 81c189: a sourced file guarded by an `[ -f … ]` test in its sourcing file is OPTIONAL — absent is skipped, not failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-optional-source-'));
  const hooksDir = join(dir, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const entryPath = join(hooksDir, 'entry.sh');
  writeFileSync(join(hooksDir, 'core.sh'), '#!/usr/bin/env sh\necho core\n');
  writeFileSync(
    entryPath,
    [
      '#!/usr/bin/env sh',
      'if [ -f ./scripts/hooks/project.sh ]; then', // the dispatcher's conditional shape
      '  . ./scripts/hooks/project.sh',
      'fi',
      '. ./scripts/hooks/core.sh',
      '',
    ].join('\n'),
  );

  const reached = new Set(
    [...sourcedHookFilesFrom(entryPath)].map((p) =>
      p.slice(hooksDir.length + 1).replace(/\\/g, '/'),
    ),
  );
  assert.deepEqual(
    [...reached].sort(),
    ['core.sh', 'entry.sh'],
    `a generic-core checkout has no project.sh; the guarded directive must be skipped, not ` +
      `failed (finding 81c189); got ${JSON.stringify([...reached].sort())}`,
  );

  // The guard is per-path: an UNGUARDED missing file still hard-fails (finding 2dd374 stands).
  writeFileSync(
    entryPath,
    '#!/usr/bin/env sh\n. ./scripts/hooks/project.sh\n. ./scripts/hooks/core.sh\n',
  );
  assert.throws(() => sourcedHookFilesFrom(entryPath), /does not exist on disk/);
});

test('plan 3963 review finding 2dd374: sourcedHookFilesFrom() hard-fails on a sourced file that does not exist on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-missing-source-'));
  const hooksDir = join(dir, 'scripts', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const entryPath = join(hooksDir, 'entry.sh');
  writeFileSync(entryPath, '#!/usr/bin/env sh\n. ./scripts/hooks/missing.sh\n');

  assert.throws(
    () => sourcedHookFilesFrom(entryPath),
    /does not exist on disk/,
    'a sourced-but-missing file must hard-fail the walk instead of silently counting as reached ' +
      '(finding 2dd374)',
  );
});

test('closurePathsForSelection: an UNPAIRED readSource refuses to narrow (plan 4085)', () => {
  // A reader injected without its tree leaves the basename fallback nothing to resolve against, so
  // the closure would silently omit any computed-directory dependency — a key missing a file the
  // battery reads, i.e. a HIT for changed content. Declining to narrow falls back to whole-tree
  // keying: un-narrowed, never uncacheable, and never a false green. This is the pass-cache half
  // of the plan-4085 pairing rule; the selector half is that no index means no fallback edge.
  const readSource = (name) => (name === 'a.test.mjs' ? "import './a.mjs';\n" : '');
  const unpaired = closurePathsForSelection(['scripts/a.test.mjs'], { readSource });
  assert.equal(unpaired.ok, false);
  assert.equal(unpaired.reason, 'read-source-without-tree');
  // A synthetic tree declares itself with an explicit empty index, and narrowing resumes.
  const paired = closurePathsForSelection(['scripts/a.test.mjs'], {
    readSource,
    basenameIndex: new Map(),
  });
  assert.equal(paired.ok, true);
});

// A narrowed key is only sound if EVERY path it narrows to can actually be keyed. `computeKey`
// maps a path with no oid to the constant `'absent'`, so a closure member that git does not report
// contributes a component that never changes — editing that file recomputes the same key and
// serves a HIT for changed content. Two round-6 findings are the same hole seen from two sides:
// a git-IGNORED module admitted by the basename index's filesystem walk (8fe740; oids come from
// `git ls-tree -r HEAD` and `git status --untracked-files=normal` does not report ignored files),
// and a DELETED module, which `selectTests` folds back in via indexWithKeys for SELECTION but the
// cache closure never did (1585a0) — the two-views drift this plan's own T3 forbids.
// Requiring keyability closes both at one seam, in this module's established safe direction:
// un-narrowed, never uncacheable, never a false green.
test('keyForSelection: an UNKEYABLE closure member refuses to narrow (round-6 8fe740 / 1585a0)', () => {
  const sources = {
    'dummy.test.mjs': "import 'node:test';\nimport { x } from './ignored-worker.mjs';\n",
  };
  const readSource = (b) => sources[b] ?? null;
  // The index resolves the reference, so the closure DOES reach scripts/ignored-worker.mjs …
  const index = new Map([['ignored-worker.mjs', ['ignored-worker.mjs']]]);
  const base = {
    nodeMajor: 22,
    gitVersion: 'g',
    scriptOidsOk: true,
    gateLogic: { ok: true, hash: '1111111111111111' },
  };

  // … but git reports no oid for it (it is ignored, or it was deleted), so narrowing to a path set
  // containing it would key that file as the constant 'absent'.
  const unkeyable = keyForSelection(
    {
      ...base,
      oids: new Map([
        ['scripts', 'a'.repeat(40)],
        ['scripts/dummy.test.mjs', 'c'.repeat(40)],
      ]),
    },
    ['scripts/dummy.test.mjs'],
    readSource,
    { basenameIndex: index },
  );
  const unkeyableScripts = Object.keys(unkeyable.components.oids).filter((p) =>
    p.startsWith('scripts'),
  );
  assert.deepEqual(
    unkeyableScripts,
    ['scripts'],
    'an unkeyable closure member must fall back to the whole-tree scripts oid',
  );

  // The control: once git DOES report the member, narrowing resumes exactly as before — so this
  // guard costs nothing on the normal path and is not a blanket refusal to narrow.
  const keyable = keyForSelection(
    {
      ...base,
      oids: new Map([
        ['scripts', 'a'.repeat(40)],
        ['scripts/dummy.test.mjs', 'c'.repeat(40)],
        ['scripts/ignored-worker.mjs', 'e'.repeat(40)],
      ]),
    },
    ['scripts/dummy.test.mjs'],
    readSource,
    { basenameIndex: index },
  );
  assert.deepEqual(
    Object.keys(keyable.components.oids)
      .filter((p) => p.startsWith('scripts'))
      .sort(),
    ['scripts/dummy.test.mjs', 'scripts/ignored-worker.mjs'],
  );
});

// keyForSelection threads `treeOpts` into the CLOSURE half but used to call
// reachableScopedPrefixes with the reader alone, whose own default reads the AMBIENT scripts/ tree.
// So `keyForSelection(state, sel, undefined, { scriptsDir: alt })` attributed scoped prefixes from
// one checkout and narrowed scripts/ from another: if the ambient copy of the named test reads
// neither scoped prefix while the alternate copy reads `backend/`, that prefix is scoped OUT and an
// edit under backend/ leaves the key byte-identical — a stale HIT for changed content
// (/gpt-review round 6, 1f80a6). Same pairing-disguise class round 4 fixed at three other seams;
// this was the fourth. The control is a REAL ambient test file that reads neither prefix, so the
// assertion below fails for exactly the reason claimed rather than off an unreadable-source
// fail-safe (an unreadable test keys everything, which would mask the bug).
test('keyForSelection: scoped-prefix attribution reads the NAMED tree, not the ambient one (round-6 1f80a6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'battery-cache-reach-tree-'));
  try {
    // The ambient scripts/assert-plan-pointers.test.mjs mentions neither 'wiki/' nor 'backend/'
    // (plan 3958: unlike account-registry.test.mjs, this one ships in the public coord-kit too).
    const base = 'assert-plan-pointers.test.mjs';
    assert.equal(
      /backend\/|wiki\//.test(readFileSync(join(REPO_SCRIPTS, '..', base), 'utf8')),
      false,
      'control: the ambient copy must read neither scoped prefix',
    );
    // The alternate tree's copy of that same basename DOES read backend/.
    writeFileSync(join(dir, base), "import 'node:test';\nconst d = 'backend/scripts';\n");

    const state = {
      oids: new Map([
        ['scripts', 'a'.repeat(40)],
        [`scripts/${base}`, 'c'.repeat(40)],
        ['backend', 'b'.repeat(40)],
        ['wiki', 'd'.repeat(40)],
      ]),
      nodeMajor: 22,
      gitVersion: 'g',
      scriptOidsOk: true,
      gateLogic: { ok: true, hash: '1111111111111111' },
    };
    // scopedPrefixes given explicitly (plan 3958): keyForSelection's own default is
    // CORE_SCOPED_PREFIXES (['wiki/'] alone), and the prefix LIST offered to keyedPaths merges
    // in EXTERNAL_TREE_PREFIXES too (review finding 859192) — a self-resolved import that reads
    // THIS checkout's own coord.config.json. Passing 'backend/' here makes it a keyable
    // candidate on its own terms, regardless of whether the calling checkout's config happens to
    // configure it (vetapp's does; the public coord-kit's neutral default does not, because the
    // kit ships no backend/ tree to key at all).
    const { components } = keyForSelection(state, [`scripts/${base}`], undefined, {
      scriptsDir: dir,
      scopedPrefixes: ['wiki/', 'backend/'],
    });
    const keyed = Object.keys(components.oids);
    assert.ok(
      keyed.includes('backend'),
      `backend/ must stay in the key when the NAMED tree reads it (keyed: ${keyed})`,
    );
    // wiki/ is read by neither copy, so it is still legitimately scoped out — this pins that the
    // fix threads the tree rather than just giving up and keying everything.
    assert.equal(keyed.includes('wiki'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
