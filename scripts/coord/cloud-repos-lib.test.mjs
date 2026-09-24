// scripts/coord/cloud-repos-lib.test.mjs — name-paired test for cloud-repos-lib.mjs.
//
// New file (justification, per the repo's "new *.test.mjs needs a one-line reason" rule):
// cloud-repos-lib.mjs's exports were previously only exercised indirectly, as an import inside
// stamp-cloud-exec.test.mjs. This file needs an isolation property that file cannot host: it
// reads the REAL repo-root coord.config.json from disk, so it must run against the real
// checkout, never inside scripts/test-helpers/isolated-plan-repo.mjs's copied-tree fixture
// (that fixture writes its OWN small, synthetic coord.config.json — see that file's own
// comment — which is deliberately NOT this repo's real one). stamp-cloud-exec.test.mjs's
// `--repos` cases DO run inside that fixture (by design, to prove the subprocess CLI path end
// to end against the fixture's synthetic registry), so bolting a real-tree-only assertion onto
// that file would mix two different execution contexts in one suite. A dedicated file keeps the
// isolation clean.
//
// WHAT THIS GUARDS (plan 3958): cloud-repos-lib.mjs's `CLOUD_REPOS` is now READ from
// coord.config.json's `cloudRepos` array at module load (see cloud-repos-lib.mjs's own header
// for the mechanism and why two earlier attempts at this broke the isolated-plan-repo fixture
// before plan 3958 fixed both halves). This test proves that self-resolving read actually lands
// on THIS repo's own coord.config.json — not an empty registry, not some other repo's, not a
// stale cached copy — by comparing the module's live export against an INDEPENDENT reading of
// the same file. Deliberately NOT reusing loadCoordConfig (scripts/coord/coord-config.mjs) for
// that second reading: the whole point is two independent readings of the same on-disk file, so
// this reads coord.config.json with a plain readFileSync + JSON.parse, the same way a human
// diffing the two would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD_REPOS } from './cloud-repos-lib.mjs';

// This file sits in scripts/coord/ since plan 4096's T4 move — TWO levels under the repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COORD_CONFIG_PATH = join(REPO_ROOT, 'coord.config.json');

// The fields pinned against drift. `note` is included: `extraReposBlock()` in
// scripts/cloud-routine-prompt-lib.mjs renders `${r.note}` verbatim into the extra-repos
// section of the cloud-drain prompt every worker reads before cloning a registered repo, so it
// IS consumed, not just prose for a human skimming this file — a drift here would silently
// change what a drain is told to do.
const PINNED_FIELDS = ['url', 'dir', 'tokenEnv', 'note'];

test('cloud-repos-lib.mjs CLOUD_REPOS resolves the real coord.config.json cloudRepos, exactly', () => {
  // plan 3958: this module ships as-is into the public coord-kit, whose own coord.config.json
  // carries no "cloudRepos" key at all (the neutral config-less default, matching
  // cloud-repos-lib.mjs's own resolveCloudRepos() degrade-to-[] behavior right below) — a
  // missing key is therefore an EMPTY registry to compare against, not a precondition failure;
  // only a present-but-malformed (non-array) value is a real error.
  const configRaw = JSON.parse(readFileSync(COORD_CONFIG_PATH, 'utf8'));
  assert.ok(
    configRaw.cloudRepos === undefined || Array.isArray(configRaw.cloudRepos),
    `coord.config.json's "cloudRepos" is present but not an array: ${JSON.stringify(configRaw.cloudRepos)}`,
  );
  const configRepos = configRaw.cloudRepos ?? [];

  const libByKey = new Map(CLOUD_REPOS.map((r) => [r.key, r]));
  const configByKey = new Map(configRepos.map((r) => [r.key, r]));

  const mismatches = [];

  for (const key of libByKey.keys()) {
    if (!configByKey.has(key)) {
      mismatches.push(
        `key "${key}" is registered in scripts/coord/cloud-repos-lib.mjs's CLOUD_REPOS but missing ` +
          'from coord.config.json\'s "cloudRepos" array.',
      );
    }
  }
  for (const key of configByKey.keys()) {
    if (!libByKey.has(key)) {
      mismatches.push(
        `key "${key}" is registered in coord.config.json's "cloudRepos" array but missing from ` +
          "scripts/coord/cloud-repos-lib.mjs's CLOUD_REPOS.",
      );
    }
  }
  for (const key of libByKey.keys()) {
    const libRow = libByKey.get(key);
    const configRow = configByKey.get(key);
    if (!configRow) continue; // already reported as missing above
    for (const field of PINNED_FIELDS) {
      if (libRow[field] !== configRow[field]) {
        mismatches.push(
          `key "${key}" field "${field}" disagrees: scripts/coord/cloud-repos-lib.mjs says ` +
            `${JSON.stringify(libRow[field])}, coord.config.json says ${JSON.stringify(configRow[field])}.`,
        );
      }
    }
  }

  assert.deepEqual(
    mismatches,
    [],
    "scripts/coord/cloud-repos-lib.mjs's CLOUD_REPOS disagrees with coord.config.json's " +
      '"cloudRepos" (CLOUD_REPOS is READ from that file at module load — see cloud-repos-lib.mjs\'s ' +
      `own header — so a mismatch here means the self-resolve landed on the wrong file, or a stale ` +
      `import, not a hand-maintained second copy):\n  ${mismatches.join('\n  ')}`,
  );
});
