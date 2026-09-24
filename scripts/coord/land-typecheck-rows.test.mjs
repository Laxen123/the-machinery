// scripts/coord/land-typecheck-rows.test.mjs — name-pair of scripts/coord/land-typecheck-rows.mjs
// (plan 4096 T5). NEW FILE JUSTIFICATION (vetapp CLAUDE.md): the name-pair of a genuinely new
// module; there is no existing test file for this module to fold into.
//
// What this file is really protecting is a SHELL contract, not a JS one. The hook consumes these
// records with `IFS=<tab> read` and expands the command field UNQUOTED, so three properties are
// load-bearing and each has a case below:
//   1. no field is ever empty      — tab is IFS whitespace, so an empty field shifts every later
//                                    field one position left, silently
//   2. commands are plain words    — the unquoted expansion has no quoting available
//   3. a bad row THROWS            — a dropped row is a gate that stops running on a green push

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { typecheckRows, typecheckRecords, ereUnsupportedReason } from './land-typecheck-rows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'land-typecheck-rows.mjs');

const row = (over = {}) => ({
  name: 'tsc-frontend',
  label: 'frontend typecheck',
  group: 'frontend typecheck',
  groupDiffLabel: 'frontend/src diff',
  changed: '^frontend/src/',
  command: 'pnpm --filter @vetapp/frontend exec tsc --noEmit',
  capSeconds: 300,
  failHint: 'fix the type error, then re-push',
  ...over,
});

const cfg = (rows) => ({ land: { typecheckCommands: rows } });

// ── the empty / absent default ────────────────────────────────────────────────────────────────

test('an absent or empty land.typecheckCommands yields no rows and no records', () => {
  for (const c of [{}, { land: {} }, cfg([]), null, undefined]) {
    assert.deepEqual(typecheckRows(c ?? undefined), []);
    assert.deepEqual(typecheckRecords(c ?? undefined), []);
  }
});

test('a non-array land.typecheckCommands throws rather than reading as empty', () => {
  assert.throws(() => typecheckRows(cfg('tsc')), /must be an array/);
});

// ── property 1: NO FIELD IS EVER EMPTY (the IFS-collapse guard) ───────────────────────────────

test('no emitted field is ever empty — an empty one would shift every later field under IFS=tab', () => {
  // Both group shapes, because `plural` is the field that would otherwise be "" for a
  // single-row group — the exact case that motivated the `each`/`single` token.
  const records = typecheckRecords(
    cfg([
      row(),
      row({ name: 'a', group: 'g2', groupDiffLabel: 'd2', changed: '^x/' }),
      row({ name: 'b', group: 'g2', groupDiffLabel: 'd2', changed: '^x/' }),
    ]),
  );
  assert.equal(records.length, 3);
  for (const rec of records) {
    const fields = rec.split('\t');
    assert.equal(fields.length, 10, `expected 10 fields, got ${fields.length}: ${rec}`);
    for (const [i, f] of fields.entries()) {
      assert.notEqual(f, '', `field ${i} is empty in: ${rec}`);
    }
  }
  // And the shell's own reading of it: splitting on a collapsed run of tabs must not change the
  // field count, which is only true because none of them is empty.
  for (const rec of records) {
    assert.equal(rec.split(/\t+/).length, rec.split('\t').length);
  }
});

test('plural is the literal token each/single, and lastOfGroup marks the group trailer', () => {
  const [r1, r2, r3] = typecheckRecords(
    cfg([
      row(),
      row({ name: 'a', group: 'g2', groupDiffLabel: 'd2', changed: '^x/' }),
      row({ name: 'b', group: 'g2', groupDiffLabel: 'd2', changed: '^x/' }),
    ]),
  ).map((r) => r.split('\t'));
  assert.equal(r1[7], 'single');
  assert.equal(r1[6], '1', 'a one-row group is its own last row');
  assert.equal(r2[7], 'each');
  assert.equal(r2[6], '0');
  assert.equal(r3[7], 'each');
  assert.equal(r3[6], '1');
});

test('the command is the LAST field, so the one field that may contain spaces cannot shift others', () => {
  const [rec] = typecheckRecords(cfg([row()]));
  const fields = rec.split('\t');
  assert.equal(fields[9], 'pnpm --filter @vetapp/frontend exec tsc --noEmit');
  assert.equal(fields.at(-1), fields[9]);
});

test('a tab or newline anywhere in a field is refused, not escaped', () => {
  for (const key of [
    'name',
    'label',
    'group',
    'groupDiffLabel',
    'changed',
    'failHint',
    'command',
  ]) {
    for (const ch of ['\t', '\n', '\r']) {
      assert.throws(
        () => typecheckRows(cfg([row({ [key]: `a${ch}b` })])),
        /must not contain a tab or newline|shell metacharacter/,
        `${key} containing ${JSON.stringify(ch)} must be refused`,
      );
    }
  }
});

// ── property 2: commands are plain words ──────────────────────────────────────────────────────

test('a command carrying any shell metacharacter is refused — the hook expands it unquoted', () => {
  const bad = [
    'pnpm build; curl evil.example',
    'pnpm build && rm -rf /',
    'pnpm build | tee out',
    'pnpm build > out.txt',
    'pnpm build $(whoami)',
    'pnpm build `whoami`',
    'pnpm exec tsc --noEmit "two words"',
    "pnpm exec tsc 'quoted'",
    'pnpm build *.ts',
    'pnpm build ?.ts',
    'pnpm build [a]',
    'pnpm build {a,b}',
    'pnpm build \\escaped',
    'pnpm build & ',
  ];
  for (const command of bad) {
    assert.throws(
      () => typecheckRows(cfg([row({ command })])),
      /shell metacharacter/,
      `must refuse: ${command}`,
    );
  }
});

test('the three real vetapp commands are plain words and survive', () => {
  const real = [
    'pnpm --filter @vetapp/frontend exec tsc --noEmit',
    'pnpm --filter @vetapp/backend exec tsc --noEmit -p tsconfig.json',
    'pnpm --filter @vetapp/backend exec tsc --noEmit -p ../shared/tsconfig.json',
  ];
  for (const command of real) {
    assert.equal(typecheckRows(cfg([row({ command })]))[0].command, command);
  }
});

// NOTE — deliberately NO test here reads the repo's real coord.config.json.
//
// An earlier cut of this file did, by joining HERE with two parent-directory segments, and
// select-battery-tests.mjs's own EXTERNAL_TREE_PREFIXES lint correctly rejected it: no prefix
// covers a parent-directory escape out of scripts/, so a change to coord.config.json would NOT have
// selected this file, and the assertion would have gone stale without anything re-running it —
// a test that cannot be selected by the thing it watches is worse than no test, because it reads
// as coverage. The lint's own remedy is "switch the test to a fixture", which is what every case
// above does.
//
// The real rows ARE pinned, in scripts/pre-push-hook.test.mjs's
// "pre-push-core.sh invokes no vetapp package, and the typecheck rows survive in config" test —
// that file already reads the hook and the config together, and the selector handles it.

// ── property 3: a bad row throws ──────────────────────────────────────────────────────────────

test('every required field must be a non-empty string', () => {
  for (const key of [
    'name',
    'label',
    'group',
    'groupDiffLabel',
    'changed',
    'command',
    'failHint',
  ]) {
    for (const bad of [undefined, null, '', 42, {}]) {
      assert.throws(
        () => typecheckRows(cfg([row({ [key]: bad })])),
        new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} must be a non-empty string`),
        `${key}=${JSON.stringify(bad)} must be refused`,
      );
    }
  }
});

test('capSeconds must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, '300', null, undefined, NaN]) {
    assert.throws(
      () => typecheckRows(cfg([row({ capSeconds: bad })])),
      /capSeconds must be a positive integer/,
      `capSeconds=${String(bad)} must be refused`,
    );
  }
  assert.equal(typecheckRows(cfg([row({ capSeconds: 1 })]))[0].capSeconds, 1);
});

test('a duplicate gate name is refused — the name is a pass-cache key', () => {
  assert.throws(
    () => typecheckRows(cfg([row(), row({ group: 'g2', groupDiffLabel: 'd2', changed: '^x/' })])),
    /duplicates an earlier row/,
  );
});

test('an invalid `changed` regular expression is refused at read time, not at grep time', () => {
  assert.throws(
    () => typecheckRows(cfg([row({ changed: '[' })])),
    /not a valid regular expression/,
  );
});

// ── the DIALECT gap: validated in JS, executed by `grep -E` ───────────────────────────────────
//
// gpt-review finding (plan 4096 review round 1), raised independently by 4 angles:
// `new RegExp(changed)` proves the pattern is valid JAVASCRIPT, but the hook runs it through
// `grep -E`, which is POSIX ERE. A JS-only construct therefore passed validation and then either
// errored inside the hook or — worse — matched something different, leaving a gate quietly
// watching the wrong paths on a green push.
test('a `changed` pattern that is valid JS but not POSIX ERE is refused (the grep -E dialect gap)', () => {
  const jsOnly = [
    ['^(?:frontend|backend)/src/', /group/],
    ['^frontend/src/\\d+/', /shorthand/],
    ['^frontend/\\w+/src/', /shorthand/],
    ['^frontend/\\s*src/', /shorthand/],
    ['^frontend/src/\\bfoo', /shorthand/],
    ['^frontend/src/.*?\\.ts', /greedy/],
    ['^(frontend)/src/\\1', /backreference/],
    ['^frontend/src/\\u0041', /escape/],
  ];
  for (const [changed, why] of jsOnly) {
    assert.throws(
      () => typecheckRows(cfg([row({ changed })])),
      /valid JavaScript but NOT POSIX ERE/,
      `must refuse the JS-only pattern: ${changed}`,
    );
    assert.match(ereUnsupportedReason(changed), why);
  }
});

test('the ERE subset real rows use is accepted', () => {
  for (const changed of [
    '^frontend/src/',
    '^(shared/src/|backend/src/)',
    '^(a|b)/[A-Za-z0-9_-]+/.*\\.ts$',
    '^docs/(runbooks|coord)/',
    '^x{1,3}/',
  ]) {
    assert.equal(ereUnsupportedReason(changed), null, `must accept the ERE pattern: ${changed}`);
    assert.equal(typecheckRows(cfg([row({ changed })]))[0].changed, changed);
  }
});

// ── the gate NAME reaches an unescaped grep expression ────────────────────────────────────────
//
// gpt-review finding (plan 4096 review round 1): gate_needs_run interpolates "$1" into the
// pass-cache lookup WITHOUT escaping, so a name carrying a regex metacharacter reads some other
// gate's cached verdict, or none — a wrong green, not a crash.
test('a gate name carrying a regex metacharacter is refused', () => {
  for (const name of [
    'tsc.frontend|tsc-backend',
    'tsc-front(end)',
    'tsc-front*',
    'tsc frontend',
    'tsc-front$',
    '^tsc',
    'tsc[1]',
    '-leading-dash',
    '.leading-dot',
  ]) {
    assert.throws(
      () => typecheckRows(cfg([row({ name })])),
      /name must match/,
      `must refuse the unsafe gate name: ${name}`,
    );
  }
});

// Review round 2: `.` was still allowed, and it is the one metacharacter that looks like an
// ordinary name character — `tsc.frontend` would match `tscXfrontend` in the unescaped cache
// lookup, which is exactly the wrong-gate read the allowlist exists to stop.
test('a gate name containing a dot is refused — it is a regex metacharacter in the cache lookup', () => {
  for (const name of ['tsc.frontend', 'a.b', 'tsc-frontend.v2']) {
    assert.throws(
      () => typecheckRows(cfg([row({ name })])),
      /name must match/,
      `must refuse the dotted gate name: ${name}`,
    );
  }
});

// Review round 2: the control escapes are the quiet half of the dialect gap — `\n` compiles in
// BOTH dialects and means different things in each, so nothing errors and the gate just watches
// the wrong text.
test('a `changed` pattern using a JS control escape is refused (it means something else in ERE)', () => {
  for (const changed of ['^a\\nb/', '^a\\tb/', '^a\\rb/', '^a\\fb/', '^a\\vb/', '^a\\cJb/']) {
    assert.throws(
      () => typecheckRows(cfg([row({ changed })])),
      /valid JavaScript but NOT POSIX ERE/,
      `must refuse the control-escape pattern: ${changed}`,
    );
  }
});

test('the gate names this repo actually uses are accepted', () => {
  for (const name of ['tsc-frontend', 'tsc-backend', 'tsc-shared', 'vitest-backend-seed-sanity']) {
    assert.equal(typecheckRows(cfg([row({ name })]))[0].name, name);
  }
});

test('a row that is not an object is refused', () => {
  for (const bad of [null, 'tsc', 42, ['tsc']]) {
    assert.throws(() => typecheckRows(cfg([bad])), /must be an object/);
  }
});

test('a non-contiguous group is refused — the hook evaluates one trigger per contiguous group', () => {
  assert.throws(
    () =>
      typecheckRows(
        cfg([
          row({ name: 'a', group: 'g1', groupDiffLabel: 'd1', changed: '^a/' }),
          row({ name: 'b', group: 'g2', groupDiffLabel: 'd2', changed: '^b/' }),
          row({ name: 'c', group: 'g1', groupDiffLabel: 'd1', changed: '^a/' }),
        ]),
      ),
    /is not contiguous/,
  );
});

test('rows in one group must agree on the trigger and the label', () => {
  for (const [key, value] of [
    ['changed', '^other/'],
    ['groupDiffLabel', 'other label'],
  ]) {
    assert.throws(
      () => typecheckRows(cfg([row({ name: 'a' }), row({ name: 'b', [key]: value })])),
      new RegExp(`disagree on ${key}`),
      `a group whose rows disagree on ${key} must be refused`,
    );
  }
});

// ── the CLI seam: it must never exit 0-with-no-output on a real config ────────────────────────

test('the CLI entry check survives a SYMLINKED path — the bare idiom fails OPEN here', (t) => {
  // The measured regression this pins: reached through a symlinked `scripts/coord`, the usual
  // `import.meta.url === pathToFileURL(process.argv[1]).href` guard answers false (node resolves
  // the module's own URL through symlinks, argv[1] keeps the caller's spelling), main() never
  // runs, and the process exits 0 printing nothing — which the hook reads as "no typecheck
  // configured" and skips all three gates on a green push.
  const dir = mkdtempSync(join(tmpdir(), 'tc-rows-symlink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  try {
    symlinkSync(HERE, join(dir, 'scripts', 'coord'), 'dir');
  } catch {
    t.skip('this platform/user cannot create a directory symlink');
    return;
  }
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ land: { typecheckCommands: [row()] } }),
  );
  const out = execFileSync(process.execPath, ['scripts/coord/land-typecheck-rows.mjs'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.match(
    out,
    /^tsc-frontend\t/,
    'the CLI must emit its records when reached through a symlinked path — an empty stdout here ' +
      'is a silent skip of every typecheck gate, not an empty configuration',
  );
});

test('the CLI exits 2 and names the offending row on a bad config', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-rows-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({ land: { typecheckCommands: [row({ command: 'pnpm x; curl evil' })] } }),
  );
  const res = spawnSync(process.execPath, [MODULE, dir], { encoding: 'utf8' });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}\n${res.stdout}${res.stderr}`);
  assert.equal(
    res.stdout,
    '',
    'a refused config must emit NO records — a partial list would run a partial gate set',
  );
  assert.match(res.stderr, /shell metacharacter/);
  assert.match(
    res.stderr,
    /land\.typecheckCommands\[0\]\.command/,
    'the message must name the row',
  );
});
