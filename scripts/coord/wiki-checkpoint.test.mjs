// scripts/coord/wiki-checkpoint.test.mjs
//
// Justification for a NEW test file (vetapp CLAUDE.md): the name-pair of a genuinely new module,
// scripts/coord/wiki-checkpoint.mjs (plan 4096 T2). There is no existing name-paired file to fold
// these into — the predicate's former home, scripts/project/land-seams.mjs, keeps its own suite
// for `wikiCheckpointSeam`, which is a different function with a different contract.
//
// What these pin is exactly what two gpt-review rounds flagged about this module: the config read
// must FAIL CLOSED when it is asked, and must NOT be an import-time precondition for a command
// that merely wants the predicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { wikiCheckpointNeeded, wikiSubjectPatterns } from './wiki-checkpoint.mjs';

/** A throwaway repo root carrying exactly the coord.config.json text given. */
function rootWithConfig(text) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-checkpoint-'));
  writeFileSync(join(root, 'coord.config.json'), text);
  return root;
}

test('wikiCheckpointNeeded: the two explicit signals fire regardless of the pattern list', () => {
  assert.equal(wikiCheckpointNeeded([], true), true, 'chainsChanged');
  assert.equal(wikiCheckpointNeeded([], false, true), true, 'subjectPageChanged');
  assert.equal(wikiCheckpointNeeded([]), false);
  assert.equal(wikiCheckpointNeeded(null), false, 'a nullish diff is total, never a throw');
});

// plan 3958: this module ships as-is into the public coord-kit, whose own coord.config.json
// carries no wikiSubjectPatterns at all — the self-resolved default degrades to "never
// checkpoints", so a shipped core test cannot assert against THIS repo's real configured
// patterns. A fixed, portable pattern list instead (today's real vetapp shape: adapters, the
// price pipeline, and pricing-concept modules), passed via wikiCheckpointNeeded's injectable
// 4th parameter — the same match/no-match logic every real caller exercises, just fed a
// synthetic registry instead of the calling checkout's live one.
const SUBJECT_PATTERNS = [
  /^backend\/src\/adapters\//,
  /^backend\/scripts\/data-pipeline\//,
  /^shared\/src\/price-resolver\.ts$/,
];

test('wikiCheckpointNeeded: a configured pattern matches a subject path, not a record row', () => {
  // The distinction the checkpoint exists to draw: subject SYNTHESIS (how an adapter / the price
  // pipeline / a pricing-concept module WORKS) is the wiki's, plain per-record seed DATA is not.
  assert.equal(
    wikiCheckpointNeeded(['backend/src/adapters/acme-cloud.ts'], false, false, SUBJECT_PATTERNS),
    true,
  );
  assert.equal(
    wikiCheckpointNeeded(
      ['backend/scripts/data-pipeline/extract.py'],
      false,
      false,
      SUBJECT_PATTERNS,
    ),
    true,
  );
  assert.equal(
    wikiCheckpointNeeded(['shared/src/price-resolver.ts'], false, false, SUBJECT_PATTERNS),
    true,
  );
  // The seed sample is built SEGMENT-WISE, never a quoted whole-path literal: this file lives
  // under scripts/, where assert-seed-io-seam.mjs reads such a literal as a direct open of the
  // sharded seed. Same convention assert-no-landed-reversion.test.mjs already follows.
  const recordRow = ['backend/src/data', 'seed', 'records', 'SE', 'rec-327.json'].join('/');
  assert.equal(wikiCheckpointNeeded([recordRow], false, false, SUBJECT_PATTERNS), false);
  assert.equal(wikiCheckpointNeeded(['docs/runbooks/x.md'], false, false, SUBJECT_PATTERNS), false);
  // One matching path among many still fires.
  assert.equal(
    wikiCheckpointNeeded(
      ['docs/x.md', 'backend/src/adapters/a.ts'],
      false,
      false,
      SUBJECT_PATTERNS,
    ),
    true,
  );
});

test('wikiSubjectPatterns: a repo configuring none gets an empty list, and the path axis goes quiet', () => {
  const root = rootWithConfig('{"wikiSubjectPatterns": []}');
  try {
    assert.deepEqual([...wikiSubjectPatterns(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wikiSubjectPatterns: an absent coord.config.json is the documented empty default, not a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-checkpoint-nocfg-'));
  try {
    assert.deepEqual([...wikiSubjectPatterns(root)], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// THE fail-closed pin (gpt-review round 1, angle-B). An earlier draft caught this throw and
// returned [], which silently switches OFF the path axis of the WIKI_CHECKPOINT land gate — a
// land touching the price pipeline would sail through with no wiki decision recorded, saying
// nothing. A broken config must be an error, never a quiet "no".
test('wikiSubjectPatterns: a MALFORMED config throws rather than degrading to an empty list', () => {
  for (const [label, text] of [
    ['not JSON at all', '{ this is not json'],
    ['wrong type', '{"wikiSubjectPatterns": "^backend/"}'],
    ['a non-string entry', '{"wikiSubjectPatterns": [17]}'],
    ['an uncompilable pattern', '{"wikiSubjectPatterns": ["^a(["]}'],
  ]) {
    const root = rootWithConfig(text);
    try {
      assert.throws(() => wikiSubjectPatterns(root), Error, `${label} must throw`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// THE not-an-import-precondition pin (gpt-review round 2, angle-C; strengthened round 3).
// record-review.mjs statically imports this module for one predicate; reading the config at
// module scope meant a malformed key with nothing to do with the wiki — an invalid
// `handoffLayout`, say — killed that command at import. Importing a module must not fail for a
// reason the importer never asked about.
//
// Round 3 (simplification) retired the source-text regex this used to be: it only rejected one
// SPELLING (`const X = loadCoordConfig(…)`) and would have stayed green on
// `const X = resolveIt()` where `resolveIt` reads the config. So this drives the real behaviour
// instead — a CHILD PROCESS that imports a copy of this module standing over a deliberately
// malformed config, and must exit 0 on the bare import and non-zero once it actually asks.
test('importing this module reads no config, and asking DOES — driven, not pattern-matched', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-checkpoint-import-'));
  try {
    // The WHOLE scripts/coord/ tree, minus its tests. Rule 3 (assert-scripts-self-contained)
    // guarantees a non-test module here imports only its own siblings and node: builtins, so the
    // directory IS the closure — no hand-listed file set to go stale. The directory really being
    // named `scripts` is what scripts-anchor.mjs anchors on, so the copy resolves `root` as its
    // repo root exactly as the real one resolves the real repo.
    const here = dirname(fileURLToPath(import.meta.url));
    const dest = join(root, 'scripts', 'coord');
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(here, dest, {
      recursive: true,
      filter: (src) => !src.endsWith('.test.mjs'),
    });
    writeFileSync(join(root, 'coord.config.json'), '{"wikiSubjectPatterns": [17]}');

    const mod = pathToFileURL(join(dest, 'wiki-checkpoint.mjs')).href;
    const run = (body) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf8' });

    const imported = run(`await import(${JSON.stringify(mod)});`);
    assert.equal(
      imported.status,
      0,
      `a bare import must not read the config (stderr: ${imported.stderr})`,
    );

    const asked = run(
      `const m = await import(${JSON.stringify(mod)}); m.wikiCheckpointNeeded(['x']);`,
    );
    assert.notEqual(asked.status, 0, 'asking the wiki question over a malformed config must throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('wikiSubjectPatterns: the default-root answer is memoized, an explicit root is not', () => {
  assert.equal(wikiSubjectPatterns(), wikiSubjectPatterns(), 'default root is cached');
  const root = rootWithConfig('{"wikiSubjectPatterns": ["^x/"]}');
  try {
    // A test fixture must never be able to poison the real process-wide answer.
    assert.notEqual(wikiSubjectPatterns(root), wikiSubjectPatterns());
    assert.deepEqual(
      wikiSubjectPatterns(root).map(String),
      [String(/^x\//)],
      'an explicit root re-reads that root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
