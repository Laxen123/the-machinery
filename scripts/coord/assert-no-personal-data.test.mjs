// scripts/coord/assert-no-personal-data.test.mjs — name-pair of assert-no-personal-data.mjs
// (plan 3958). A NEW test file because assert-no-personal-data.mjs is a brand-new module with
// no existing name-paired test to fold into.
//
// This module ships verbatim into a public repo (coord-kit), and so does this test file, so
// NO real personal name, handle, hostname, or e-mail appears anywhere below — every fixture is
// a synthetic stand-in (Zorblat, DESKTOP-ZZZ999, someone@corp-mail.tld, ...) — personal-data-ok:
// fixture. The denylist rule is exercised with an inline array of synthetic entries, never by
// reading the real denylist file that stays behind in the private project
// (scripts/project/personal-data-denylist.json).
//
// Every fixture LINE below that carries a personal-data-SHAPED string (an email, a DESKTOP-*
// hostname, a home path, or an env_* cloud-sandbox id) is marked `personal-data-ok: fixture` —
// assert-no-personal-data.mjs's own per-line waiver — so this module's tree-wide self-scan
// (see the last test in this file) reports zero findings for this file.
//
// Two layers: direct scanText()/scanTree() calls exercise the pure core without a subprocess
// per case, and a handful of spawnSync calls against the real CLI entrypoint prove the argv
// parsing, exit codes, --json shape, and --denylist override actually wire up end to end.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import { scanText, scanTree } from './assert-no-personal-data.mjs';

const mkdtempSync = trackedMkdtempSync();
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'assert-no-personal-data.mjs');

function tmpDir(prefix = 'assert-no-personal-data-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

// ── scanText: the pure per-line rules ──────────────────────────────────────────────────────

describe('scanText: built-in rules', () => {
  test('email', () => {
    const input = 'contact us at hello@corp-mail.tld please'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'email', match: 'hello@corp-mail.tld' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(input), expected);
  });

  test('email: an RFC 2606 reserved fixture domain is exempt', () => {
    assert.deepEqual(scanText('contact us at hello@example.com please'), []);
    assert.deepEqual(scanText('or hello@sub.example.org, or hello@thing.invalid, or a@b.test'), []);
  });

  test('email: git@github.com (the standard SSH remote user) is exempt', () => {
    assert.deepEqual(scanText('origin git@github.com:someone/repo.git'), []);
  });

  test('hostname: DESKTOP-<6+ alnum>', () => {
    const input = 'Reported from DESKTOP-ZZZ999 during triage.'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'hostname', match: 'DESKTOP-ZZZ999' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(input), expected);
    assert.deepEqual(scanText('DESKTOP-AB1 is too short to count'), []);
  });

  test('cloud-env-id: env_<26 alnum>', () => {
    const input = 'Sandbox id: env_ABCDEFGHIJ0123456789abcdef end'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'cloud-env-id', match: 'env_ABCDEFGHIJ0123456789abcdef' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(input), expected);
  });

  test('home-path: all four prefix forms', () => {
    // Each [input, expectedMatch] pair below is one fixture on its own line —
    // personal-data-ok: fixture.
    const cases = [
      ['C:\\Users\\somebody\\file.txt', 'C:\\Users\\somebody'], // personal-data-ok: fixture
      ['C:/Users/somebody/file.txt', 'C:/Users/somebody'], // personal-data-ok: fixture
      ['/home/somebody/file.txt', '/home/somebody'], // personal-data-ok: fixture
      ['/Users/somebody/file.txt', '/Users/somebody'], // personal-data-ok: fixture
    ];
    for (const [line, match] of cases) {
      assert.deepEqual(scanText(line), [{ line: 1, kind: 'home-path', match }]);
    }
  });

  test('home-path: "/home/user" (and only that literal name) is exempt', () => {
    assert.deepEqual(scanText('sandbox path: /home/user/workspace is generic'), []);
    // A line carrying BOTH the exempt name and a real one still reports the real one.
    const input = '/home/user/a then /home/somebody/b'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'home-path', match: '/home/somebody' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(input), expected);
  });

  test('home-path: a dots-only leaf (documentation placeholder) is exempt', () => {
    assert.deepEqual(scanText('see C:/Users/.../file.txt for an example path'), []);
    const input = 'C:/Users/.../a then C:/Users/somebody/b'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'home-path', match: 'C:/Users/somebody' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(input), expected);
  });

  test('denylist: case-insensitive substring, match preserves source casing', () => {
    assert.deepEqual(scanText('Please avoid ZORBLAT in generic docs.', { denylist: ['zorblat'] }), [
      { line: 1, kind: 'denylist', match: 'ZORBLAT' },
    ]);
  });

  test('two different denylist entries can both fire on one line', () => {
    // scanText itself is NOT sorted (only scanTree's aggregate output is) — this is raw
    // per-line push order: built-in rules first (only "email" fires here), the denylist
    // entries after, in denylist array order.
    const input = 'Zorblat sent zorblat84@corp-mail.tld already.'; // personal-data-ok: fixture
    const expected = [
      { line: 1, kind: 'email', match: 'zorblat84@corp-mail.tld' }, // personal-data-ok: fixture
      { line: 1, kind: 'denylist', match: 'zorblat84' },
      { line: 1, kind: 'denylist', match: 'Zorblat' },
    ];
    assert.deepEqual(scanText(input, { denylist: ['zorblat84', 'zorblat'] }), expected);
  });

  test('a clean line produces no findings', () => {
    assert.deepEqual(scanText('Nothing to see here.'), []);
  });
});

describe('scanText: personal-data-ok waiver', () => {
  test('a waived line yields nothing, even though it would otherwise match', () => {
    const line = 'contact hello@corp-mail.tld // personal-data-ok: fixture'; // personal-data-ok: fixture
    assert.deepEqual(scanText(line), []);
  });

  test('the waiver token itself is not matched by any BUILT-IN rule', () => {
    // "personal-data-ok:" alone is not email/hostname/home-path/cloud-env-id-shaped — proves the
    // waiver's own marker text cannot accidentally BECOME a built-in-rule finding.
    assert.deepEqual(scanText('personal-data-ok: nothing else on this line'), []);
    // A denylist entry is a different axis — the waiver never suppresses it (see the module's
    // WAIVER section), so a denylist term that happens to appear on a waived line still fires.
    assert.deepEqual(
      scanText('personal-data-ok: nothing else on this line', { denylist: ['nothing else'] }),
      [{ line: 1, kind: 'denylist', match: 'nothing else' }],
    );
  });

  test('a non-waived sibling line still fires', () => {
    const waived = 'contact hello@corp-mail.tld // personal-data-ok: fixture'; // personal-data-ok: fixture
    const notWaived = 'contact hello@corp-mail.tld with no waiver'; // personal-data-ok: fixture
    const text = `${waived}\n${notWaived}`;
    const expected = [{ line: 2, kind: 'email', match: 'hello@corp-mail.tld' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(text), expected);
  });

  test('the waiver does NOT suppress a denylist hit', () => {
    // A `personal-data-ok:` comment trailing a real denylisted literal must not hide it — this is
    // the exact hole that let the real machine hostname through three shipped test-file waivers
    // (the gate reported 0 findings). Deliberately does not also match a built-in shape rule, so
    // this pins the denylist axis in isolation.
    const line = 'reported by ZORBLAT-CI // personal-data-ok: fixture'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'denylist', match: 'ZORBLAT-CI' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(line, { denylist: ['zorblat-ci'] }), expected);
  });

  test('the waiver still suppresses a built-in rule on the SAME line a denylist hit fires on', () => {
    // A line can legitimately carry both: a synthetic hostname the waiver hides, and a real
    // denylisted literal the waiver must not hide. Both must be judged independently.
    const line = 'DESKTOP-ZZZ999 reported by ZORBLAT-CI // personal-data-ok: fixture'; // personal-data-ok: fixture
    const expected = [{ line: 1, kind: 'denylist', match: 'ZORBLAT-CI' }]; // personal-data-ok: fixture
    assert.deepEqual(scanText(line, { denylist: ['zorblat-ci'] }), expected);
  });
});

// ── scanTree: the fixture-tree integration test ────────────────────────────────────────────

// One file per kind, a clean file, a binary file, and a .git/node_modules/excludable dir each
// carrying content that WOULD fire if scanned — proving the skip logic, not just its absence.
function buildFixtureTree() {
  const root = tmpDir();
  writeFileSync(join(root, 'clean.txt'), 'Nothing to see here.\nJust ordinary prose.\n');
  const cloudenvContent = 'Sandbox id: env_ABCDEFGHIJ0123456789abcdef end\n'; // personal-data-ok: fixture
  writeFileSync(join(root, 'cloudenv.txt'), cloudenvContent);
  writeFileSync(
    join(root, 'denylist-only.txt'),
    'The sesame-secret-token must never appear in the public kit.\n',
  );
  const emailContent = 'line one\ncontact us at hello@corp-mail.tld please\n'; // personal-data-ok: fixture
  writeFileSync(join(root, 'email.txt'), emailContent);
  writeFileSync(
    join(root, 'email-fixture.txt'),
    'a fixture address, hello@example.com, produces no finding\n',
  );
  const homepathContent =
    'Windows: C:\\Users\\Somebody\\Desktop\\notes.txt\nSandbox: /home/user/workspace is fine\n'; // personal-data-ok: fixture
  writeFileSync(join(root, 'homepath.txt'), homepathContent);
  const hostnameContent = 'Reported from DESKTOP-ZZZ999 during triage.\n'; // personal-data-ok: fixture
  writeFileSync(join(root, 'hostname.txt'), hostnameContent);
  const overlapContent = 'Zorblat sent zorblat84@corp-mail.tld already.\n'; // personal-data-ok: fixture
  writeFileSync(join(root, 'overlap.txt'), overlapContent);
  writeFileSync(join(root, 'denylist-name.txt'), 'Zorblat is helping test this scrubber.\n');

  // Binary: a NUL in the first 8 KB must skip the WHOLE file, even though real text (an email)
  // follows it.
  mkdirSync(join(root, 'nested'), { recursive: true });
  const binaryTailEmail = 'hello@corp-mail.tld'; // personal-data-ok: fixture
  writeFileSync(
    join(root, 'binary.bin'),
    Buffer.concat([Buffer.from([0]), Buffer.from(binaryTailEmail)]),
  );

  // Always-skipped directories, regardless of --exclude.
  const skippedEmail = 'email: skip-me@corp-mail.tld\n'; // personal-data-ok: fixture
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'skip.txt'), skippedEmail);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'skip.txt'), skippedEmail);

  // Only skipped when named on --exclude.
  const excludeEmail = 'email: skip-me-too@corp-mail.tld\n'; // personal-data-ok: fixture
  mkdirSync(join(root, 'excludeme'), { recursive: true });
  writeFileSync(join(root, 'excludeme', 'skip.txt'), excludeEmail);

  return root;
}

const DENYLIST = ['zorblat84', 'zorblat', 'sesame-secret-token'];

// Every entry below whose `match` is personal-data-shaped mirrors a fixture written in
// buildFixtureTree() above — one expectation per line, each carrying its own waiver.
const EXPECTED_FINDINGS_WITH_EXCLUDEME = [
  { file: 'cloudenv.txt', line: 1, kind: 'cloud-env-id', match: 'env_ABCDEFGHIJ0123456789abcdef' }, // personal-data-ok: fixture
  { file: 'denylist-name.txt', line: 1, kind: 'denylist', match: 'Zorblat' },
  { file: 'denylist-only.txt', line: 1, kind: 'denylist', match: 'sesame-secret-token' },
  { file: 'email.txt', line: 2, kind: 'email', match: 'hello@corp-mail.tld' }, // personal-data-ok: fixture
  { file: 'excludeme/skip.txt', line: 1, kind: 'email', match: 'skip-me-too@corp-mail.tld' }, // personal-data-ok: fixture
  { file: 'homepath.txt', line: 1, kind: 'home-path', match: 'C:\\Users\\Somebody' }, // personal-data-ok: fixture
  { file: 'hostname.txt', line: 1, kind: 'hostname', match: 'DESKTOP-ZZZ999' }, // personal-data-ok: fixture
  { file: 'overlap.txt', line: 1, kind: 'denylist', match: 'Zorblat' },
  { file: 'overlap.txt', line: 1, kind: 'denylist', match: 'zorblat84' },
  { file: 'overlap.txt', line: 1, kind: 'email', match: 'zorblat84@corp-mail.tld' }, // personal-data-ok: fixture
];

describe('scanTree', () => {
  test('exact finding set, sorted (file, line, kind, match); binary/.git/node_modules skipped', () => {
    const root = buildFixtureTree();
    const findings = scanTree(root, { denylist: DENYLIST });
    assert.deepEqual(findings, EXPECTED_FINDINGS_WITH_EXCLUDEME);
  });

  test('--exclude removes a named directory; .git/node_modules stay skipped regardless', () => {
    const root = buildFixtureTree();
    const findings = scanTree(root, { denylist: DENYLIST, exclude: ['excludeme'] });
    assert.deepEqual(
      findings,
      EXPECTED_FINDINGS_WITH_EXCLUDEME.filter((f) => f.file !== 'excludeme/skip.txt'),
    );
  });

  // looksBinary() sniffs only the first 8 KB via a single reused buffer (dc6ad1) — these two
  // cases pin that the SEMANTICS are unchanged from the old whole-file-read version: a NUL past
  // the sniff window doesn't count as binary, and an empty file (0 bytes read) isn't binary
  // either.
  test('binary sniff: a NUL byte past the first 8 KB does not make the file "binary"', () => {
    const root = tmpDir();
    const past8k = 'x'.repeat(8200) + '\x00after the sniff window: hello@corp-mail.tld\n'; // personal-data-ok: fixture
    writeFileSync(join(root, 'late-nul.txt'), past8k);
    const findings = scanTree(root);
    assert.deepEqual(findings, [
      { file: 'late-nul.txt', line: 1, kind: 'email', match: 'hello@corp-mail.tld' }, // personal-data-ok: fixture
    ]);
  });

  test('binary sniff: an empty file is not "binary" and produces no findings', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'empty.txt'), '');
    assert.deepEqual(scanTree(root), []);
  });
});

// ── CLI: argv parsing, exit codes, --json shape, --denylist override ──────────────────────

describe('CLI', () => {
  test('exit 0 on a clean tree; --json shape is { root, findings, count }', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'clean.txt'), 'Nothing to see here.\n');
    const res = runCli(['--root', root, '--json']);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(parsed).sort(), ['count', 'findings', 'root']);
    assert.equal(parsed.count, 0);
    assert.deepEqual(parsed.findings, []);
  });

  test('exit 1 on a dirty tree; human output names file:line, kind, and match', () => {
    const root = tmpDir();
    const dirtyContent = 'contact hello@corp-mail.tld\n'; // personal-data-ok: fixture
    writeFileSync(join(root, 'dirty.txt'), dirtyContent);
    const res = runCli(['--root', root]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /dirty\.txt:1: email "hello@corp-mail\.tld"/);
    assert.match(res.stdout, /1 finding\(s\)\.$/m);
  });

  test('exit 2: --root is required', () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--root <dir> is required/);
  });

  test('exit 2: --root must be a directory that exists', () => {
    const res = runCli(['--root', join(tmpDir(), 'does-not-exist')]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--root is not a directory/);
  });

  test('exit 2: an unreadable/malformed --denylist file', () => {
    const root = tmpDir();
    const badDenylist = join(root, 'bad-denylist.json');
    writeFileSync(badDenylist, '{"not": "an array"}');
    const res = runCli(['--root', root, '--denylist', badDenylist]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /denylist file must be a JSON array/);
  });

  test('no --denylist means no denylist check at all', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'note.txt'), 'this line names totallycustomsecret once\n');
    const res = runCli(['--root', root, '--json']);
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).count, 0);
  });

  test('--denylist <file> is honoured when given', () => {
    const root = tmpDir();
    writeFileSync(join(root, 'note.txt'), 'this line names totallycustomsecret once\n');

    // Deliberately written OUTSIDE `root` — inside it, the JSON file's own text (which
    // necessarily names the word it denylists) would self-match and throw off the expected
    // count.
    const customDenylist = join(tmpDir(), 'custom-denylist.json');
    writeFileSync(customDenylist, JSON.stringify(['totallycustomsecret']));
    const dirty = runCli(['--root', root, '--denylist', customDenylist, '--json']);
    assert.equal(dirty.status, 1);
    const parsed = JSON.parse(dirty.stdout);
    assert.equal(parsed.count, 1);
    assert.deepEqual(parsed.findings, [
      { file: 'note.txt', line: 1, kind: 'denylist', match: 'totallycustomsecret' },
    ]);
  });
});
