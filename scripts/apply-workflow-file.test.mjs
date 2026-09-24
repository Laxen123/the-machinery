// scripts/apply-workflow-file.test.mjs — name-paired test for the plan-2965 sanctioned
// `.claude/workflows/**` apply route (AC1). Every test builds its OWN throwaway fake repo
// root (`.claude/workflows/` only) under the OS temp dir and passes it as `repoRoot` — never
// touches the real checkout's `.claude/` (this test file itself must never Write/Edit under
// `.claude/**` — only exercise the script's own file ops via injected `repoRoot`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyWorkflowFile, assertTargetContained, main } from './apply-workflow-file.mjs';
import { assertSamePath } from './test-path-assert.mjs';

function makeFakeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'apply-workflow-file-repo-'));
  mkdirSync(join(repoRoot, '.claude', 'workflows'), { recursive: true });
  mkdirSync(join(repoRoot, '.claude', 'hooks'), { recursive: true });
  return repoRoot;
}

function makeScratchFile(content, name = 'staged.mjs') {
  const dir = mkdtempSync(join(tmpdir(), 'apply-workflow-file-scratch-'));
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function withCleanup(t, dir) {
  t.after(() => rmSync(dir, { recursive: true, force: true }));
}

test('refuses a target outside .claude/workflows/ (sibling .claude/hooks/)', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  assert.throws(
    () => assertTargetContained({ target: '.claude/hooks/evil.mjs', repoRoot }),
    /outside the sanctioned/,
  );
});

test('refuses a traversal target (../ escaping workflows/)', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  assert.throws(
    () =>
      assertTargetContained({
        target: '.claude/workflows/../../etc/passwd',
        repoRoot,
      }),
    /outside the sanctioned/,
  );
});

test('refuses an ABSOLUTE traversal target entirely outside the repo', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  assert.throws(
    () => assertTargetContained({ target: '/etc/passwd', repoRoot }),
    /outside the sanctioned/,
  );
});

test('refuses a symlink-escape via a symlinked ancestor directory inside workflows/', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const outsideDir = mkdtempSync(join(tmpdir(), 'apply-workflow-file-outside-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  const linkPath = join(repoRoot, '.claude', 'workflows', 'escape-link');
  try {
    symlinkSync(outsideDir, linkPath, 'dir');
  } catch (err) {
    // Symlink creation needs a privilege this sandbox may not have (notably Windows without
    // Developer Mode / admin) — the containment guard cannot be exercised here, so skip
    // rather than false-fail an unrelated environment. (platform-assert-ok: symlink creation
    // itself is the thing under test, not a faked platform branch — there is no symbol to
    // inject in its place; EPERM here means "cannot test", not "test failed".)
    t.skip(`symlinkSync unavailable in this sandbox (${err.code}): ${err.message}`);
    return;
  }
  assert.throws(
    () =>
      assertTargetContained({
        target: '.claude/workflows/escape-link/pwned.mjs',
        repoRoot,
      }),
    /outside the sanctioned/,
  );
});

test('refuses a target that is itself an EXISTING symlink', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const realFile = join(repoRoot, '.claude', 'workflows', 'real.mjs');
  writeFileSync(realFile, 'export const x = 1;\n', 'utf8');
  const linkTarget = join(repoRoot, '.claude', 'workflows', 'linked.mjs');
  try {
    symlinkSync(realFile, linkTarget, 'file');
  } catch (err) {
    t.skip(`symlinkSync unavailable in this sandbox (${err.code}): ${err.message}`);
    return;
  }
  assert.throws(
    () => assertTargetContained({ target: '.claude/workflows/linked.mjs', repoRoot }),
    /is a symlink/,
  );
});

test('allows creating a brand-new file directly inside workflows/ (does not exist yet)', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const targetAbs = assertTargetContained({ target: '.claude/workflows/brand-new.mjs', repoRoot });
  assertSamePath(targetAbs, join(repoRoot, '.claude', 'workflows', 'brand-new.mjs'));
});

test('refuses a syntax-broken .mjs staged content and leaves no file behind', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('export const x = ;\n', 'broken.mjs');
  t.after(() => rmSync(from, { force: true }));
  assert.throws(
    () => applyWorkflowFile({ target: '.claude/workflows/broken.mjs', from, repoRoot }),
    /fails `node --check`/,
  );
  assert.equal(
    existsSync(join(repoRoot, '.claude', 'workflows', 'broken.mjs')),
    false,
    'a syntax-check refusal must not write the target at all',
  );
});

test('refuses a syntax-broken .js staged content the same as .mjs', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('const x = ;\n', 'broken.js');
  t.after(() => rmSync(from, { force: true }));
  assert.throws(
    () => applyWorkflowFile({ target: '.claude/workflows/broken.js', from, repoRoot }),
    /fails `node --check`/,
  );
});

test('copies a non-js/mjs extension WITHOUT a syntax check, even if it would fail one', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const weirdContent = 'this is not valid javascript at all { [ ( ;;;\n';
  const from = makeScratchFile(weirdContent, 'notes.md');
  t.after(() => rmSync(from, { force: true }));
  applyWorkflowFile({ target: '.claude/workflows/notes.md', from, repoRoot });
  const written = readFileSync(join(repoRoot, '.claude', 'workflows', 'notes.md'), 'utf8');
  assert.equal(written, weirdContent);
});

test('successful apply: full-file-from-scratch copy, byte-identical, overwrites existing content', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const targetPath = join(repoRoot, '.claude', 'workflows', 'sonnet-review.js');
  writeFileSync(targetPath, 'export const meta = { name: "old" };\n', 'utf8');

  const newContent = 'export const meta = { name: "new" };\nexport function run() { return 1; }\n';
  const from = makeScratchFile(newContent, 'sonnet-review.js');
  t.after(() => rmSync(from, { force: true }));

  const result = applyWorkflowFile({
    target: '.claude/workflows/sonnet-review.js',
    from,
    repoRoot,
  });

  const written = readFileSync(targetPath, 'utf8');
  assert.equal(written, newContent, 'target content must be byte-identical to --from');
  assert.equal(result.bytes, Buffer.byteLength(newContent, 'utf8'));
  assert.equal(
    result.sha,
    createHash('sha256').update(newContent, 'utf8').digest('hex'),
    'reported sha256 must match the actually-written content',
  );
});

test('refuses when --from does not exist', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  // The missing path is built under the OS temp dir, NOT via join(repoRoot, …): the battery's
  // EXTERNAL_TREE_PREFIXES guard statically scans for real-tree reads and cannot tell that
  // `repoRoot` is a throwaway fake repo, so the repoRoot-joined form read as an uncovered
  // real-tree path and failed selection. Same assertion, unambiguous provenance.
  const missing = join(tmpdir(), 'apply-workflow-file-nope-does-not-exist.mjs');
  assert.throws(
    () =>
      applyWorkflowFile({
        target: '.claude/workflows/new.mjs',
        from: missing,
        repoRoot,
      }),
    /--from file not found/,
  );
});

test('refuses when --target is missing', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('export const x = 1;\n');
  t.after(() => rmSync(from, { force: true }));
  assert.throws(() => applyWorkflowFile({ from, repoRoot }), /--target .* is required/);
});

test('refuses when --from is missing', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  assert.throws(
    () => applyWorkflowFile({ target: '.claude/workflows/new.mjs', repoRoot }),
    /--from <scratch file> is required/,
  );
});

test('audit line shape: names the target, a byte count, and a sha256 content hash', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const content = 'export const x = 42;\n';
  const from = makeScratchFile(content, 'audited.mjs');
  t.after(() => rmSync(from, { force: true }));
  const result = applyWorkflowFile({ target: '.claude/workflows/audited.mjs', from, repoRoot });
  assert.match(
    result.line,
    /^apply-workflow-file: wrote \.claude\/workflows\/audited\.mjs \(\d+ bytes, sha256:[0-9a-f]{64}\)$/,
  );
});

test('CLI main(): exits 2 on missing flags, 1 on containment refusal, 0 on success', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('export const x = 1;\n', 'cli-ok.mjs');
  t.after(() => rmSync(from, { force: true }));

  assert.equal(main({ argv: [], repoRoot }), 2);
  assert.equal(main({ argv: ['--target', '.claude/workflows/x.mjs'], repoRoot }), 2);
  assert.equal(main({ argv: ['--target', '.claude/hooks/x.mjs', '--from', from], repoRoot }), 1);
  assert.equal(
    main({ argv: ['--target', '.claude/workflows/cli-ok.mjs', '--from', from], repoRoot }),
    0,
  );
  assert.equal(
    readFileSync(join(repoRoot, '.claude', 'workflows', 'cli-ok.mjs'), 'utf8'),
    'export const x = 1;\n',
  );
});

// ── Regression cases from the plan-2965 gpt-review round ─────────────────────

test('refuses when the .claude/workflows ROOT itself is a symlink escaping the repo', (t) => {
  // gpt-review 89a62a + 70a48d: anchoring containment on realpath(.claude/workflows) alone
  // makes a symlinked workflows root self-authorising — every target under it resolves inside
  // the external directory and passes, so the route writes outside the checkout while its audit
  // line still prints a repo-relative path. The anchor is checked against the repo root.
  const repoRoot = mkdtempSync(join(tmpdir(), 'apply-workflow-file-repo-'));
  withCleanup(t, repoRoot);
  const outside = mkdtempSync(join(tmpdir(), 'apply-workflow-file-outside-'));
  withCleanup(t, outside);
  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  try {
    symlinkSync(outside, join(repoRoot, '.claude', 'workflows'), 'dir');
  } catch {
    t.skip('symlink creation not permitted in this environment');
    return;
  }
  assert.throws(
    () => assertTargetContained({ target: '.claude/workflows/sonnet-review.js', repoRoot }),
    /outside the repo root/,
  );
});

test('accepts a workflow body using a top-level `return` (the runtime wraps it)', (t) => {
  // gpt-review c8e951: workflow scripts run inside an async function, so a top-level early
  // `return` is legal for them and illegal to a bare `node --check`. Measured against the real
  // .claude/workflows/price-cohort-apply.mjs:52 and price-cohort-extract-apply.mjs:51 — a
  // one-pass gate refuses 2 of the 3 production workflows outright.
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const body = "const args = {}\nif (!args.worktree) {\n  return { error: 'missing args' }\n}\n";
  const from = makeScratchFile(body, 'top-level-return.mjs');
  t.after(() => rmSync(from, { force: true }));
  applyWorkflowFile({ target: '.claude/workflows/top-level-return.mjs', from, repoRoot });
  assert.equal(
    readFileSync(join(repoRoot, '.claude', 'workflows', 'top-level-return.mjs'), 'utf8'),
    body,
  );
});

test('a genuine syntax error still refuses even under the wrapped re-check', (t) => {
  // The two-pass gate must not become a blanket bypass: only an illegal-return failure earns
  // pass 2, and content that is broken in BOTH shapes still refuses.
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('return function ( {\n', 'broken-return.mjs');
  t.after(() => rmSync(from, { force: true }));
  assert.throws(
    () => applyWorkflowFile({ target: '.claude/workflows/broken-return.mjs', from, repoRoot }),
    /fails `node --check`/,
  );
  assert.equal(existsSync(join(repoRoot, '.claude', 'workflows', 'broken-return.mjs')), false);
});

test('apply leaves no temp residue beside the target (atomic write cleans up)', (t) => {
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const from = makeScratchFile('export const ok = 1;\n', 'clean.mjs');
  t.after(() => rmSync(from, { force: true }));
  applyWorkflowFile({ target: '.claude/workflows/clean.mjs', from, repoRoot });
  const entries = readdirSync(join(repoRoot, '.claude', 'workflows'));
  assert.deepEqual(entries, ['clean.mjs']);
});

test('preserves the existing target file mode across the atomic replace', (t) => {
  // gpt-review c0eee9: a rename-based replace installs the TEMP file's mode, silently dropping
  // the target's permission bits — and git tracks the exec bit, so the loss resurfaces later as
  // an unrelated-looking diff.
  //
  // platform-assert-ok: the mode is read from the filesystem rather than hardcoded, because
  // Windows cannot represent an exec bit — `chmod 0o755` there yields 0o666. Asserting the
  // literal 0o755 made this POSIX-only: green on the Linux cloud drains, and then a hard
  // block on every LOCAL Windows land (which is what it did on 2026-08-08, stopping an
  // unrelated plan). The invariant under test is PRESERVATION, so assert against whatever
  // mode the platform actually stored, and check the exec bit only where one can exist.
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const target = join(repoRoot, '.claude', 'workflows', 'moded.mjs');
  writeFileSync(target, 'export const before = 1;\n', 'utf8');
  chmodSync(target, 0o755);
  const priorMode = lstatSync(target).mode & 0o777;
  const from = makeScratchFile('export const after = 2;\n', 'moded.mjs');
  t.after(() => rmSync(from, { force: true }));
  applyWorkflowFile({ target: '.claude/workflows/moded.mjs', from, repoRoot });
  assert.equal(readFileSync(target, 'utf8'), 'export const after = 2;\n');
  assert.equal(lstatSync(target).mode & 0o777, priorMode, 'the replace kept the prior mode');
  if (process.platform !== 'win32') {
    assert.equal(priorMode, 0o755, 'POSIX must actually carry the exec bit into the assertion');
  }
});

test('a .js workflow opening with `export const meta` applies (module-detection independence)', (t) => {
  // gpt-review 02d6d0: the staged copy is checked in a temp dir with no ancestor package.json and
  // this repo sets no `"type"`, so a `.js` file's ESM-ness rests on Node's syntax auto-detection.
  // sonnet-review.js is exactly this shape; the gate must not depend on that heuristic holding.
  const repoRoot = makeFakeRepo();
  withCleanup(t, repoRoot);
  const body = "export const meta = { name: 'x' }\nif (!1) {\n  return { error: 'nope' }\n}\n";
  const from = makeScratchFile(body, 'meta-and-return.js');
  t.after(() => rmSync(from, { force: true }));
  applyWorkflowFile({ target: '.claude/workflows/meta-and-return.js', from, repoRoot });
  assert.equal(
    readFileSync(join(repoRoot, '.claude', 'workflows', 'meta-and-return.js'), 'utf8'),
    body,
  );
});
