// scripts/coord-edit.test.mjs  (plan 646, T2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCoordEditArgs,
  capturePatch,
  coordEdit,
  coordEditApply,
  assertNoCorruption,
} from './coord-edit.mjs';
import { COORD_TRAILER, git as rawGit } from './coord-git.mjs';
import { nulBytes as nul } from './corruption-guard.mjs';
import { injectTransientOnFirst as injectTransientGit } from '../test-helpers/inject-transient-git.mjs';

// plan 338: clear inherited GIT_* so `git -C <tmpdir>` honours the temp repo even when
// this suite runs inside a git hook (which exports those vars and would redirect temp-repo
// ops onto the real repo — shared user.name corruption + junk commits).
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// --- arg parsing --------------------------------------------------------------
test('parseCoordEditArgs collects multiple --paths, --message, and --dry', () => {
  const a = parseCoordEditArgs([
    '--paths',
    'docs/INDEX.md',
    'handoff.md',
    '--message',
    'm',
    '--dry',
  ]);
  assert.deepEqual(a.paths, ['docs/INDEX.md', 'handoff.md']);
  assert.equal(a.flags.message, 'm');
  assert.equal(a.flags.dry, true);
});

test('parseCoordEditArgs rejects an unknown flag', () => {
  assert.throws(() => parseCoordEditArgs(['--paths', 'x', '--bogus']), /unknown flag --bogus/);
});

test('parseCoordEditArgs: bare and single-dash tokens keep the historical paths hint', () => {
  assert.throws(
    () => parseCoordEditArgs(['stray.md']),
    /unexpected argument "stray\.md" \(paths go after --paths\)/,
  );
  // pre-1769 a single-dash token OUTSIDE a --paths run fell to the same branch as a bare
  // positional — pinned (inside a --paths run it is collected as a path, then as now)
  assert.throws(
    () => parseCoordEditArgs(['-z', '--paths', 'x']),
    /unexpected argument "-z" \(paths go after --paths\)/,
  );
  assert.deepEqual(parseCoordEditArgs(['--paths', 'x', '-z']).paths, ['x', '-z']);
});

// --- real-git harness: bare origin + a work clone (acts as $MAIN on master) ----
function makeBareOrigin(seed = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coord-edit-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const dir = join(root, 'work');
  execFileSync('git', ['clone', '-q', origin, dir]);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('config', 'user.email', 'work@t.t');
  g('config', 'user.name', 'work');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  for (const [f, content] of Object.entries(seed)) writeFileSync(join(dir, f), content);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  // plan 989/1286: ignore the disposable coord-checkout (withCoordCheckout creates
  // .claude/coord-worktree under the clone) so status/clean assertions never see it —
  // mirrors the real repo's .gitignore.
  writeFileSync(join(dir, '.gitignore'), '.claude/\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  g('push', '-q', 'origin', 'master');
  g('branch', '--set-upstream-to=origin/master', 'master');
  return { root, dir, origin, g, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function cloneOf(origin, name = 'sib') {
  const dir = mkdtempSync(join(dirname(origin), `${name}-`));
  // -c core.autocrlf=false at CLONE time: the checkout happens during clone, so setting it
  // afterward would leave a CRLF worktree vs LF blobs → phantom "modified" dirt on Windows.
  execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', `${name}@t.t`]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', name]);
  execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
  return dir;
}

const showOrigin = (dir, path) =>
  execFileSync('git', ['-C', dir, 'show', `origin/master:${path}`], { encoding: 'utf8' });

// --- capture + land -----------------------------------------------------------
test('coordEdit lands a hand-authored tracked-file edit with a Coord-Write trailer', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\nline2\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'line1\nEDITED\n'); // the hand edit
    const res = coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit doc' });
    assert.ok(!res.noop && res.attempts >= 1);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'line1\nEDITED\n', 'edit landed on origin');
    const msg = s.g('log', '-1', '--format=%B', 'origin/master');
    assert.match(msg, new RegExp(`${COORD_TRAILER}: coord-edit`));
    assert.equal(s.g('status', '--porcelain').trim(), '', 'working tree clean after land');
  } finally {
    s.cleanup();
  }
});

test('coordEdit throws NO_CHANGES when the pathspec has no uncommitted edit', () => {
  const s = makeBareOrigin({ 'doc.md': 'x\n' });
  try {
    assert.throws(
      () => coordEdit(s.dir, { relPaths: ['doc.md'], message: 'm' }),
      /no uncommitted changes/,
    );
  } finally {
    s.cleanup();
  }
});

// --- plan 1634: NUL-corruption guard -------------------------------------------

test('coordEdit refuses (CORRUPTED_PREIMAGE) when the working copy is zero-filled', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\nline2\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), nul(6)); // disk-zeroed, not a real edit
    assert.throws(
      () => coordEdit(s.dir, { relPaths: ['doc.md'], message: 'm' }),
      (e) => e.code === 'CORRUPTED_PREIMAGE' && /doc\.md/.test(e.message),
    );
    // Never captured/applied/landed: origin is untouched.
    assert.equal(showOrigin(s.dir, 'doc.md'), 'line1\nline2\n');
  } finally {
    s.cleanup();
  }
});

test('coordEdit refuses when a text file flips to binary vs its HEAD baseline', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\nline2\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), `line1${nul(1)}CORRUPT`);
    assert.throws(
      () => coordEdit(s.dir, { relPaths: ['doc.md'], message: 'm' }),
      (e) => e.code === 'CORRUPTED_PREIMAGE',
    );
  } finally {
    s.cleanup();
  }
});

test('assertNoCorruption is a no-op for an ordinary uncorrupted edit', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'line1\nline2\n');
    assert.doesNotThrow(() => assertNoCorruption(s.dir, ['doc.md'], {}));
  } finally {
    s.cleanup();
  }
});

test('coord-edit CLI --dry exits 3 with a corruption message on a zero-filled working copy', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), nul(3));
    // plan 1739: fileURLToPath, NOT URL.pathname + a drive-letter strip —
    // pathname keeps percent-encoding, so a checkout path with a space
    // ("98 Hobby") yielded a %20 module path that doesn't exist and the CLI
    // exited 1 (module not found) instead of 3 on every such host.
    const modPath = fileURLToPath(new URL('./coord-edit.mjs', import.meta.url));
    let threw = null;
    try {
      execFileSync(process.execPath, [modPath, '--paths', 'doc.md', '--message', 'm', '--dry'], {
        cwd: s.dir,
        encoding: 'utf8',
      });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, 'CLI should exit non-zero');
    assert.equal(threw.status, 3);
    assert.match(threw.stderr, /corruption-guard/);
    assert.match(threw.stderr, /doc\.md/);
  } finally {
    s.cleanup();
  }
});

test('coordEdit lands a normal edit fine when nothing is corrupted', () => {
  const s = makeBareOrigin({ 'doc.md': 'a\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'b\n');
    const res = coordEdit(s.dir, { relPaths: ['doc.md'], message: 'm' });
    assert.ok(!res.noop);
    assert.equal(showOrigin(s.dir, 'doc.md'), 'b\n');
  } finally {
    s.cleanup();
  }
});

test('capturePatch returns the HEAD→worktree delta of the pathspec', () => {
  const s = makeBareOrigin({ 'doc.md': 'a\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'b\n');
    const patch = capturePatch(s.dir, ['doc.md']);
    assert.match(patch, /-a/);
    assert.match(patch, /\+b/);
  } finally {
    s.cleanup();
  }
});

// --- freshen-then-reapply: a sibling's edit to ANOTHER file is absorbed --------
test('coordEdit freshens onto a sibling commit then replays the patch (both land)', () => {
  const s = makeBareOrigin({ 'doc.md': 'ours-base\n' });
  try {
    // a sibling lands an unrelated file on origin BEFORE we run
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    writeFileSync(join(s.dir, 'doc.md'), 'ours-EDITED\n'); // our hand edit on a stale base
    coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit doc' });

    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'ours-EDITED\n', 'our edit landed');
    assert.equal(showOrigin(s.dir, 'sibling.txt'), 'theirs\n', "sibling's file survived");
  } finally {
    s.cleanup();
  }
});

// --- 3-way merge: a sibling edit to OTHER lines of the SAME file is preserved --
test('coordEdit 3-way-merges a sibling edit to other lines of the same file', () => {
  const s = makeBareOrigin({ 'doc.md': 'L1\nL2\nL3\nL4\nL5\n' });
  try {
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'doc.md'), 'S1\nL2\nL3\nL4\nL5\n'); // sibling edits L1
    execFileSync('git', ['-C', sib, 'commit', '-aqm', 'sibling edits L1']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    writeFileSync(join(s.dir, 'doc.md'), 'L1\nL2\nL3\nL4\nW5\n'); // we edit L5 (other lines)
    coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit L5' });

    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(
      showOrigin(s.dir, 'doc.md'),
      'S1\nL2\nL3\nL4\nW5\n',
      'both the sibling L1 edit and our L5 edit are present',
    );
  } finally {
    s.cleanup();
  }
});

// --- conflict: a sibling edit to the SAME line fails LOUD, leaves the tree clean
test('coordEdit fails with PATCH_CONFLICT when a sibling edited the same line', () => {
  const s = makeBareOrigin({ 'doc.md': 'L1\nL2\nL3\n' });
  try {
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'doc.md'), 'L1\nSIBLING\nL3\n'); // sibling edits L2
    execFileSync('git', ['-C', sib, 'commit', '-aqm', 'sibling edits L2']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    writeFileSync(join(s.dir, 'doc.md'), 'L1\nOURS\nL3\n'); // we ALSO edit L2 → conflict
    let err;
    try {
      coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit L2' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected a throw');
    assert.equal(err.code, 'PATCH_CONFLICT');
    // plan 1286: the hand edit SURVIVES in $MAIN's working tree on a conflict (the land ran in
    // the disposable coord-checkout, so MAIN was never dirtied with conflict state) — the
    // re-author starts from the still-visible edit instead of a wiped tree.
    assert.equal(readFileSync(join(s.dir, 'doc.md'), 'utf8'), 'L1\nOURS\nL3\n');
    assert.ok(!s.g('status', '--porcelain').includes('U'), 'no unmerged entries dangling in $MAIN');
    // nothing of ours pushed — origin keeps only the sibling edit
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'L1\nSIBLING\nL3\n');
  } finally {
    s.cleanup();
  }
});

// --- no-op: a sibling already landed our exact edit ---------------------------
test('coordEdit reports a clean no-op when our exact edit is already on origin', () => {
  const s = makeBareOrigin({ 'doc.md': 'before\n' });
  try {
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'doc.md'), 'after\n'); // sibling lands the SAME edit we will make
    execFileSync('git', ['-C', sib, 'commit', '-aqm', 'sibling lands after']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    writeFileSync(join(s.dir, 'doc.md'), 'after\n'); // our identical hand edit
    const res = coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit doc' });
    assert.equal(res.noop, true, 'already-present edit is a clean no-op');
    assert.equal(s.g('status', '--porcelain').trim(), '', 'tree clean after no-op');
  } finally {
    s.cleanup();
  }
});

// --- foreign dirt outside the pathspec no longer refuses (plan 1286) -----------
// The land runs in the disposable coord-checkout, so a sibling's uncommitted edit on $MAIN
// can't be swept OR fought — the op proceeds, and the foreign dirt survives byte-identical.
// (Pre-1286 this was a loud assertCleanOutsidePathspec refusal; the isolation makes the
// refusal class obsolete for every routed writer.)
test('coordEdit lands despite a dirty tracked file OUTSIDE the pathspec; the foreign dirt survives', () => {
  const s = makeBareOrigin({ 'doc.md': 'd\n', 'other.md': 'o\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'd-EDITED\n'); // our intended edit
    writeFileSync(join(s.dir, 'other.md'), 'o-FOREIGN\n'); // an uncommitted edit outside relPaths
    const res = coordEdit(s.dir, { relPaths: ['doc.md'], message: 'docs: edit doc' });
    assert.ok(!res.noop, 'the edit landed');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'd-EDITED\n', 'our edit is on origin');
    assert.equal(showOrigin(s.dir, 'other.md'), 'o\n', 'the foreign edit was NOT swept');
    assert.equal(
      readFileSync(join(s.dir, 'other.md'), 'utf8'),
      'o-FOREIGN\n',
      'the foreign edit survives untouched in the working tree',
    );
  } finally {
    s.cleanup();
  }
});

// --- non-ff retry under REAL concurrency: two writers, two files, both land ----
// coord-edit is synchronous, so a genuine non-ff (origin moves between our freshen and
// our push) needs two OS processes. Each edits its OWN tracked file, so the loser
// freshens onto the winner's commit, replays its own (still-clean) patch, and lands.
// Real-concurrency no-lost-write smoke (the deterministic non-ff RETRY path is covered by
// the onBeforePush test above). Two OS processes (coord-edit is synchronous), separate
// clones + files; whoever loses the push race rebases silently and both edits survive.
test('coordEdit: two concurrent writers both land (no lost write under real concurrency)', async () => {
  const s = makeBareOrigin({ 'a.md': 'a-base\n', 'b.md': 'b-base\n' });
  try {
    const A = s.dir; // writer A
    const B = cloneOf(s.origin, 'B'); // writer B
    const root = s.root;
    const modUrl = new URL('./coord-edit.mjs', import.meta.url).href;
    const fixture = join(root, 'edit-writer.mjs');
    writeFileSync(
      fixture,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        'const { coordEdit } = await import(process.env.CE_MOD);',
        'const dir = process.env.CE_DIR, file = process.env.CE_FILE, val = process.env.CE_VAL;',
        'writeFileSync(join(dir, file), val + "\\n");',
        "coordEdit(dir, { relPaths: [file], message: 'edit ' + file, attempts: 30 });",
        '',
      ].join('\n'),
    );
    const run = (dir, file, val) =>
      new Promise((res) => {
        const cp = spawn(process.execPath, [fixture], {
          env: { ...process.env, CE_MOD: modUrl, CE_DIR: dir, CE_FILE: file, CE_VAL: val },
        });
        let err = '';
        // Hard timeout: this test runs in the shared pre-push gate; a hung child (deadlock /
        // runaway retry) must FAIL the test fast, never wedge every session's push.
        const timer = setTimeout(() => {
          err += '\n[test] child exceeded 30s — killed';
          cp.kill('SIGKILL');
        }, 30000);
        cp.stderr.on('data', (d) => (err += d));
        cp.on('close', (code) => {
          clearTimeout(timer);
          res({ code, err });
        });
      });
    const [ra, rb] = await Promise.all([run(A, 'a.md', 'a-EDITED'), run(B, 'b.md', 'b-EDITED')]);
    assert.equal(ra.code, 0, `writer A failed: ${ra.err}`);
    assert.equal(rb.code, 0, `writer B failed: ${rb.err}`);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'a.md'), 'a-EDITED\n', "writer A's edit landed");
    assert.equal(showOrigin(s.dir, 'b.md'), 'b-EDITED\n', "writer B's edit landed");
  } finally {
    s.cleanup();
  }
});

// --- DETERMINISTIC non-ff retry via the onBeforePush seam ---------------------
// Forces exactly one non-ff: a sibling lands an unrelated commit AFTER our freshen but
// BEFORE our push (the seam fires right before `git push`), so attempt 0's push is rejected
// non-ff; attempt 1 freshens onto the sibling, replays our patch, and lands. Unlike the
// two-process race below, this ALWAYS exercises the reset+restore+re-apply retry branch.
test('coordEdit retries deterministically on a non-ff push and lands (onBeforePush seam)', () => {
  const s = makeBareOrigin({ 'doc.md': 'base-doc\n' });
  try {
    const sib = cloneOf(s.origin);
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED-doc\n');
    let pushes = 0;
    const res = coordEdit(s.dir, {
      relPaths: ['doc.md'],
      message: 'docs: edit doc',
      onBeforePush: (i) => {
        pushes++;
        if (i === 0) {
          writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
          execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
          execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
          execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
        }
      },
    });
    assert.ok(res.attempts >= 2, `expected a retry (attempts>=2), got ${res.attempts}`);
    assert.ok(pushes >= 2, 'push attempted again after the non-ff');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'EDITED-doc\n', 'our edit landed after the retry');
    assert.equal(showOrigin(s.dir, 'sibling.txt'), 'theirs\n', "the sibling's commit survived");
  } finally {
    s.cleanup();
  }
});

// --- untracked path rejection (new files unsupported) -------------------------
test('coordEdit rejects an untracked path in --paths (git diff HEAD would silently drop it)', () => {
  const s = makeBareOrigin({ 'doc.md': 'd\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'd-EDITED\n');
    writeFileSync(join(s.dir, 'newfile.md'), 'brand new\n'); // untracked
    assert.throws(
      () => coordEdit(s.dir, { relPaths: ['doc.md', 'newfile.md'], message: 'm' }),
      /not tracked/,
    );
    // nothing pushed — newfile.md must not have been swept in behind a misleading success
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(s.g('show', 'origin/master:doc.md'), 'd\n', 'doc.md unchanged on origin');
  } finally {
    s.cleanup();
  }
});

// --- plan 1684: docs/superpowers/batches/** new-file carve-out ----------------

test('coordEdit lands a brand-new docs/superpowers/batches/**/batch.md (carve-out)', () => {
  const s = makeBareOrigin();
  try {
    const rel = 'docs/superpowers/batches/batch-x/batch.md';
    mkdirSync(join(s.dir, 'docs', 'superpowers', 'batches', 'batch-x'), { recursive: true });
    writeFileSync(join(s.dir, rel), '# batch-x\n');
    const res = coordEdit(s.dir, { relPaths: [rel], message: 'chore(batch): mint batch-x' });
    assert.ok(!res.noop);
    assert.deepEqual(res.changed, [rel]);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, rel), '# batch-x\n', 'new batch folder file landed on origin');
    assert.equal(s.g('status', '--porcelain').trim(), '', 'working tree clean after land');
  } finally {
    s.cleanup();
  }
});

// Regression test (plan 1678 batch review finding [1]): a carve-out path has no HEAD blob under
// MAIN's OLD local HEAD, so the post-land cleanup DELETES its working-tree copy before attempting
// to recreate it via ff (git merge --ff-only refuses when a matching untracked file already
// occupies the target path — confirmed empirically, not merely inferred). When MAIN itself has
// genuinely diverged (its own unpushed local commit, unrelated to the carve-out path), that ff
// fails for real — the carve-out file must be recovered from the already-landed patch rather than
// left silently missing even though coordEdit() reports success.
test('coordEdit recovers a carve-out file on disk when the post-land ff fails (diverged MAIN)', () => {
  const s = makeBareOrigin();
  try {
    // MAIN gets an unpushed local commit, unrelated to the carve-out path.
    writeFileSync(join(s.dir, 'local-only.txt'), 'mainDir has an unpushed commit\n');
    s.g('add', 'local-only.txt');
    s.g('commit', '-qm', 'local-only, never pushed');

    // Origin advances past MAIN's old tip via a sibling, so MAIN's eventual `merge --ff-only`
    // sees BOTH a local-only commit AND missed upstream commits — genuine, unresolvable divergence.
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    const rel = 'docs/superpowers/batches/batch-y/batch.md';
    mkdirSync(join(s.dir, 'docs', 'superpowers', 'batches', 'batch-y'), { recursive: true });
    writeFileSync(join(s.dir, rel), '# batch-y\n');
    const res = coordEdit(s.dir, { relPaths: [rel], message: 'chore(batch): mint batch-y' });
    assert.ok(!res.noop);
    assert.deepEqual(res.changed, [rel]);

    // The land succeeds on origin regardless of MAIN's own divergence — a disposable checkout,
    // not mainDir's own branch, does the actual push.
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, rel), '# batch-y\n', 'the batch file landed on origin');

    // MAIN's own post-land ff genuinely failed (real divergence, not a transient hiccup) — the
    // carve-out file must not be silently missing from disk even though coordEdit() reported
    // success.
    assert.equal(
      readFileSync(join(s.dir, rel), 'utf8'),
      '# batch-y\n',
      'carve-out file recovered on disk despite the failed ff',
    );
  } finally {
    s.cleanup();
  }
});

// Regression test (plan 1678 batch review finding [0], second round): the ff-failure recovery
// path must re-materialize ONLY the carve-out path, never the full captured patch — reapplying
// the full patch would re-dirty an OTHER, already-landed tracked file in the SAME call as local
// (unpushed) modifications, which a subsequent `merge --ff-only` would then hard-refuse on
// ("local changes would be overwritten"), wedging MAIN's ff entirely instead of merely lagging.
test('coordEdit ff-failure recovery does not re-dirty an ordinary tracked path landed in the same call', () => {
  const s = makeBareOrigin({ 'doc.md': 'd-base\n' });
  try {
    writeFileSync(join(s.dir, 'local-only.txt'), 'mainDir has an unpushed commit\n');
    s.g('add', 'local-only.txt');
    s.g('commit', '-qm', 'local-only, never pushed');

    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);

    const rel = 'docs/superpowers/batches/batch-z/batch.md';
    mkdirSync(join(s.dir, 'docs', 'superpowers', 'batches', 'batch-z'), { recursive: true });
    writeFileSync(join(s.dir, rel), '# batch-z\n');
    writeFileSync(join(s.dir, 'doc.md'), 'd-EDITED\n');
    const res = coordEdit(s.dir, {
      relPaths: [rel, 'doc.md'],
      message: 'chore(batch): mint batch-z + edit doc',
    });
    assert.ok(!res.noop);
    assert.deepEqual(res.changed.sort(), [rel, 'doc.md'].sort());

    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, rel), '# batch-z\n', 'the batch file landed on origin');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'd-EDITED\n', 'the doc.md edit landed on origin');

    // Carve-out file recovered on disk despite the failed ff.
    assert.equal(readFileSync(join(s.dir, rel), 'utf8'), '# batch-z\n');
    // doc.md must NOT be re-dirtied as a phantom local modification — revertPathsToHead already
    // reverted it to (old) HEAD cleanly before the ff attempt, and the recovery step must not
    // touch it at all.
    const status = s.g('status', '--porcelain', '--', 'doc.md').trim();
    assert.equal(status, '', `doc.md must be clean after the ff-failure recovery, got: ${status}`);
  } finally {
    s.cleanup();
  }
});

test('coordEdit still refuses a brand-new file OUTSIDE docs/superpowers/batches/ (no carve-out)', () => {
  const s = makeBareOrigin();
  try {
    writeFileSync(join(s.dir, 'newplan.md'), 'brand new\n');
    assert.throws(
      () => coordEdit(s.dir, { relPaths: ['newplan.md'], message: 'm' }),
      /not tracked/,
    );
    s.g('fetch', '-q', 'origin', 'master');
    assert.throws(() => showOrigin(s.dir, 'newplan.md'), 'must not have landed on origin');
  } finally {
    s.cleanup();
  }
});

test('coordEdit refuses a MIX of a new batches/** file and a new file elsewhere (all-or-nothing)', () => {
  const s = makeBareOrigin();
  try {
    const batchRel = 'docs/superpowers/batches/batch-y/batch.md';
    mkdirSync(join(s.dir, 'docs', 'superpowers', 'batches', 'batch-y'), { recursive: true });
    writeFileSync(join(s.dir, batchRel), '# batch-y\n');
    writeFileSync(join(s.dir, 'newplan.md'), 'brand new\n');
    assert.throws(
      () => coordEdit(s.dir, { relPaths: [batchRel, 'newplan.md'], message: 'm' }),
      /not tracked/,
    );
    // the carve-out must not have left a stray intent-to-add marker on the batches file
    assert.equal(
      s.g('status', '--porcelain', '--', batchRel).trim().slice(0, 2),
      '??',
      'batches file reverts to plain untracked after the mixed refusal',
    );
    s.g('fetch', '-q', 'origin', 'master');
    assert.throws(() => showOrigin(s.dir, batchRel), 'must not have landed on origin');
  } finally {
    s.cleanup();
  }
});

test('coordEdit carve-out composes with an ordinary tracked-file edit in the same call', () => {
  const s = makeBareOrigin({ 'doc.md': 'line1\n' });
  try {
    const batchRel = 'docs/superpowers/batches/batch-z/batch.md';
    mkdirSync(join(s.dir, 'docs', 'superpowers', 'batches', 'batch-z'), { recursive: true });
    writeFileSync(join(s.dir, batchRel), '# batch-z\n');
    writeFileSync(join(s.dir, 'doc.md'), 'line1\nEDITED\n');
    const res = coordEdit(s.dir, {
      relPaths: ['doc.md', batchRel],
      message: 'docs: edit + mint batch-z',
    });
    assert.ok(!res.noop);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, batchRel), '# batch-z\n');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'line1\nEDITED\n');
  } finally {
    s.cleanup();
  }
});

// --- changed-reporting: only files that actually had an edit are reported ------
test('coordEdit.changed lists only the paths that actually changed (not every --paths name)', () => {
  const s = makeBareOrigin({ 'a.md': 'a\n', 'b.md': 'b\n' });
  try {
    writeFileSync(join(s.dir, 'a.md'), 'a-EDITED\n'); // only a.md changes; b.md untouched
    const res = coordEdit(s.dir, { relPaths: ['a.md', 'b.md'], message: 'docs: edit a' });
    assert.deepEqual(res.changed, ['a.md'], 'only a.md reported as changed');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'a.md'), 'a-EDITED\n');
    assert.equal(showOrigin(s.dir, 'b.md'), 'b\n', 'b.md untouched on origin');
  } finally {
    s.cleanup();
  }
});

// --- coordEditApply guards ----------------------------------------------------
test('coordEditApply throws NO_CHANGES on an empty patch', () => {
  const s = makeBareOrigin();
  try {
    assert.throws(
      () => coordEditApply(s.dir, { relPaths: ['x'], patch: '', message: 'm' }),
      /no uncommitted changes/,
    );
  } finally {
    s.cleanup();
  }
});

test('coordEditApply requires a non-empty message', () => {
  const s = makeBareOrigin();
  try {
    assert.throws(
      () => coordEditApply(s.dir, { relPaths: ['x'], patch: 'p', message: '' }),
      /non-empty message/,
    );
    assert.throws(
      () => coordEditApply(s.dir, { relPaths: ['x'], patch: 'p' }),
      /non-empty message/,
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2519 (porting plan 2393 lever 1): the critical section ends at the commit ────────────
// coordEditApply duplicated coordWrite's freshen→apply→commit→push shape but never had the
// early-release optimization. These mirror coord-git.test.mjs's lever-1 tests (the pinned-sha
// boundary, resilience to a checkout reset in the released window, and the reacquire-on-rollback
// concurrency guard), adapted to coordEditApply's patch-replay flow. All three call
// coordEditApply directly with a hand-built lockCtx (bypassing withCoordCheckout), exactly as
// the coordWrite tests call coordWrite directly — this is the only way to observe the release
// boundary without a second OS process.

const headOf = (d) =>
  execFileSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// Prepares a hand-edit exactly as coordEdit() does (capture the patch), then restores the
// working tree to HEAD so the tree is clean at entry — coordEditApply's own contract (see its
// docstring: "the working tree of relPaths is assumed clean at entry").
function captureAndClean(dir, relPaths) {
  const patch = capturePatch(dir, relPaths);
  execFileSync('git', ['-C', dir, 'checkout', '--', ...relPaths]);
  return patch;
}

test('plan 2519: coordEditApply releases the lock AFTER the commit and BEFORE the push', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    let releasedAt = null;
    let reacquires = 0;
    const lockCtx = {
      release: () => {
        releasedAt = headOf(s.dir); // must already be OUR commit — release happens after commit
      },
      reacquire: () => {
        reacquires++;
      },
      held: true,
    };
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    const res = coordEditApply(s.dir, {
      relPaths: ['doc.md'],
      patch,
      message: 'test: boundary',
      lockCtx,
    });
    assert.ok(!res.noop && res.attempts === 1);
    assert.ok(releasedAt, 'release must have run');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(
      s.g('rev-parse', 'origin/master').trim(),
      releasedAt,
      'the pushed commit is exactly the one already at HEAD when release ran — commit → release → push',
    );
    assert.equal(reacquires, 0, 'no rollback on a clean first-attempt push');
  } finally {
    s.cleanup();
  }
});

test('plan 2519: the push names the PINNED sha, so a checkout reset in the released window cannot substitute another commit', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    // A sibling lands an unrelated commit, then — in OUR released window — hard-resets our
    // checkout onto that tip, exactly as resolveCoordCheckout does at the start of every op.
    const sib = cloneOf(s.origin);
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    let ours;
    const lockCtx = {
      release: () => {
        ours = headOf(s.dir);
        execFileSync('git', ['-C', s.dir, 'fetch', '-q', 'origin', 'master']);
        execFileSync('git', ['-C', s.dir, 'reset', '--hard', '-q', 'origin/master']);
      },
      reacquire: () => {},
      held: true,
    };
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    coordEditApply(s.dir, {
      relPaths: ['doc.md'],
      patch,
      message: 'test: pinned sha',
      lockCtx,
    });
    assert.ok(ours, 'release must have run');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(
      showOrigin(s.dir, 'doc.md'),
      'EDITED\n',
      'our edit landed despite the reset in the released window',
    );
    assert.equal(showOrigin(s.dir, 'sibling.txt'), 'theirs\n', "the sibling's commit survived");
  } finally {
    s.cleanup();
  }
});

test('plan 2519: a non-ff rollback re-takes the lock and does NOT reset a HEAD that moved under it', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    const sib = cloneOf(s.origin);
    let pushedSibling = false;
    let reacquires = 0;
    // Interferes only on the first attempt's release: lands an unrelated sibling commit AND
    // hard-resets our checkout onto it (moving our HEAD off the commit we just made). The
    // rollback must then skip `reset --soft HEAD~1` — resetting would amputate the commit now
    // at HEAD, which is the sibling's, not ours.
    const lockCtx = {
      release: () => {
        if (pushedSibling) return;
        writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
        execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
        execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
        execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
        execFileSync('git', ['-C', s.dir, 'fetch', '-q', 'origin', 'master']);
        execFileSync('git', ['-C', s.dir, 'reset', '--hard', '-q', 'origin/master']);
        pushedSibling = true;
      },
      reacquire: () => {
        reacquires++;
      },
      held: true,
    };
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    const res = coordEditApply(s.dir, {
      relPaths: ['doc.md'],
      patch,
      message: 'test: rollback under concurrency',
      lockCtx,
    });
    assert.equal(
      reacquires,
      1,
      'the rollback must re-take the lock exactly once (the non-ff path)',
    );
    assert.ok(res.attempts >= 2, `expected a retry (attempts>=2), got ${res.attempts}`);
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'EDITED\n', 'our edit landed after the retry');
    assert.equal(
      showOrigin(s.dir, 'sibling.txt'),
      'theirs\n',
      "the sibling's commit was never amputated by our rollback",
    );
  } finally {
    s.cleanup();
  }
});

test('plan 2519: a failed reacquire surfaces the original push error, annotated — never masks it', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    const sib = cloneOf(s.origin);
    // Force a genuine non-ff: sibling lands on origin BEFORE we ever start, so our freshen
    // brings us onto it, but we then diverge it back off during release (mirroring the
    // reset-in-the-released-window shape) so the push still fails non-ff.
    writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
    execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    const boom = new Error('lock timeout — a sibling holds it');
    const lockCtx = {
      release: () => {
        // land ANOTHER sibling commit so our pinned push is rejected non-ff
        writeFileSync(join(sib, 'sibling2.txt'), 'theirs2\n');
        execFileSync('git', ['-C', sib, 'add', 'sibling2.txt']);
        execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling2']);
        execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
      },
      reacquire: () => {
        throw boom;
      },
      held: true,
    };
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    assert.throws(
      () =>
        coordEditApply(s.dir, {
          relPaths: ['doc.md'],
          patch,
          message: 'test: reacquire failure',
          lockCtx,
        }),
      (e) => e.reacquireFailed === boom,
      'the push/reacquire error must surface with the reacquire failure attached as context',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2580: coordEditApply now shares coord-git's ONE coord-land protocol
// (coordLandCommit / assertNoopReachedOrigin / revertPathsToHead) instead of a private near-twin
// copy. These mirror coord-git.test.mjs's direct coordWrite-level coverage of that shared
// protocol, adapted to coordEditApply's patch-replay flow (a fixed `patch` captured once, not a
// re-run `mutate()`).

// plan 2580 review finding 5: the shim lives in scripts/test-helpers/ so this suite and
// coord-git.test.mjs prove tolerance of the SAME race, not two drifting copies of it. This
// binding just supplies THIS suite's real-git runner.
const injectTransientOnFirst = (op) => injectTransientGit(rawGit, op);

test('plan 2580: coordEditApply tolerates a half-land commit and the edit still lands on origin', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    const res = coordEditApply(s.dir, {
      relPaths: ['doc.md'],
      patch,
      message: 'test: half-land commit',
      tool: 'unit',
      _git: injectTransientOnFirst('commit'),
    });
    assert.ok(!res.noop, 'coordEditApply returned success, not a noop or a throw');
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(
      showOrigin(s.dir, 'doc.md'),
      'EDITED\n',
      'the edit landed on origin despite the half-land commit',
    );
    const body = s.g('log', '-1', '--format=%B', 'origin/master');
    assert.match(body, new RegExp(`${COORD_TRAILER}: unit`), 'the Coord-Write trailer survived');
  } finally {
    s.cleanup();
  }
});

test('plan 2580: coordEditApply does NOT silently treat a "nothing to commit" WITHOUT the commit at HEAD as success', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']);
    // _git throws "nothing to commit" WITHOUT ever actually committing → HEAD subject never
    // matches → must surface, never tolerated as a half-land.
    const _git = (d, a, o) => {
      if (a[0] === 'commit') throw new Error('nothing to commit, working tree clean');
      return rawGit(d, a, o);
    };
    assert.throws(
      () =>
        coordEditApply(s.dir, {
          relPaths: ['doc.md'],
          patch,
          message: 'test: never lands',
          tool: 'unit',
          _git,
        }),
      /nothing to commit/,
    );
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'base\n', 'nothing landed on origin');
  } finally {
    s.cleanup();
  }
});

// Captures a BRAND-NEW (untracked) file as a `git diff HEAD` new-file patch — the shape
// coordEdit()'s docs/superpowers/batches/** carve-out produces via `git add -N` before
// capturePatch (see stageCarveoutOrThrow in coord-edit.mjs) — then unstages + removes the
// working-tree copy so the tree is clean at entry (no HEAD blob, no working-tree file either),
// exactly coordEditApply's "clean at entry" contract for a path absent from HEAD.
function captureAndCleanNewFile(dir, relPaths) {
  execFileSync('git', ['-C', dir, 'add', '-N', '--', ...relPaths]);
  const patch = capturePatch(dir, relPaths);
  execFileSync('git', ['-C', dir, 'reset', '--', ...relPaths]);
  for (const p of relPaths) rmSync(join(dir, p), { force: true });
  return patch;
}

// plan 2580 (closing the plan-2572 gap): coordEditApply used to call a PRIVATE
// `restorePathsToHead` that lacked the new-file cleanup loop `revertPathsToHead` (coord-git.mjs)
// has always had for coordWrite — a rolled-back attempt that CREATED a brand-new file left it
// dangling untracked in the shared checkout. Now that both callers share the one superset
// `revertPathsToHead`, this proves the property holds through coordEditApply too. `attempts: 1`
// forces exactly one non-ff with no successful retry, so the post-rollback disk state can be
// inspected directly instead of being immediately overwritten by a successful attempt 1.
test('plan 2580: a coordEditApply attempt that creates a brand-new file leaves no dangling untracked leftover after a non-ff rollback', () => {
  const s = makeBareOrigin();
  try {
    const sib = cloneOf(s.origin);
    const rel = 'newfile.txt';
    writeFileSync(join(s.dir, rel), 'brand new\n');
    const patch = captureAndCleanNewFile(s.dir, [rel]);
    assert.equal(
      existsSync(join(s.dir, rel)),
      false,
      'sanity: the working tree has no trace of the new file at entry',
    );

    let err;
    try {
      coordEditApply(s.dir, {
        relPaths: [rel],
        patch,
        message: 'test: new-file rollback cleanup',
        attempts: 1,
        onBeforePush: () => {
          // force a non-ff: land an unrelated sibling commit right before our push
          writeFileSync(join(sib, 'sibling.txt'), 'theirs\n');
          execFileSync('git', ['-C', sib, 'add', 'sibling.txt']);
          execFileSync('git', ['-C', sib, 'commit', '-qm', 'sibling']);
          execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'expected the attempt budget to exhaust after the forced non-ff');
    assert.match(err.message, /blocked after 1 attempts/);
    assert.equal(
      existsSync(join(s.dir, rel)),
      false,
      'the new file must NOT be left dangling untracked in the working tree after the rollback',
    );
    assert.equal(
      s.g('status', '--porcelain', '--', rel).trim(),
      '',
      'git status must show nothing for the new file path after the rollback',
    );
    s.g('fetch', '-q', 'origin', 'master');
    assert.throws(() => showOrigin(s.dir, rel), 'the new file must not have landed on origin');
  } finally {
    s.cleanup();
  }
});

// plan 2580 (gap 3 of plan 2572, re-scoped): "nothing staged" (an idempotent re-apply) only
// means "already on origin" while local HEAD is CONTAINED in origin. Simulates the failure class
// directly: a local commit ALREADY carries the exact edit our patch would produce, but was never
// pushed — re-applying the same patch then stages nothing (proven empirically: `git apply
// --cached --3way` of an already-satisfied patch applies cleanly with no resulting diff), so the
// noop short-circuit must not trust that as "already on origin".
test('plan 2580 (gap 3): coordEditApply does NOT report {noop:true} when the content is already at a local HEAD origin does not contain', () => {
  const s = makeBareOrigin({ 'doc.md': 'base\n' });
  try {
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    const patch = captureAndClean(s.dir, ['doc.md']); // captures base→EDITED; tree back at base

    // A local-only commit already carries the SAME edit, never pushed — origin still only has
    // 'base'.
    writeFileSync(join(s.dir, 'doc.md'), 'EDITED\n');
    execFileSync('git', ['-C', s.dir, 'commit', '-aqm', 'local unpushed duplicate of our edit']);

    assert.throws(
      () => coordEditApply(s.dir, { relPaths: ['doc.md'], patch, message: 'test: gap3' }),
      (e) => {
        assert.equal(e.pushUnverified, true, 'must be the pushUnverified class, not a silent noop');
        assert.match(e.message, /^coordEditApply: refusing to report a no-op/);
        return true;
      },
    );
    s.g('fetch', '-q', 'origin', 'master');
    assert.equal(showOrigin(s.dir, 'doc.md'), 'base\n', 'origin still only has the base content');
  } finally {
    s.cleanup();
  }
});
