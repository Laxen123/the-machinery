// scripts/test-helpers/torn-index-repo.mjs — the shared "large tree + torn index" fixture
// for the plan-3968 truncated-index suites (review findings a23554/1a2f55).
//
// WHY THIS IS A SHARED HELPER. heal-main.test.mjs, pre-yield-guard.test.mjs, and
// index-sanity.test.mjs each independently grew their own `makeLargeRepo`/`tornIndex` copy —
// same shape (pad a repo past TRUNCATED_INDEX_HEAD_FLOOR, then simulate a torn index against
// it), different Git-call seams and tracked filenames. A future change to the threshold or
// the simulated corruption shape could update one caller and leave the others testing a
// stale fixture, letting a real recovery regression through untested. One copy lives here.
//
// `makeLargeRepo` deliberately does NOT build its own base repo — heal-main.test.mjs seeds an
// origin remote its healMasterSync tests need, pre-yield-guard.test.mjs's base file is named
// `f.txt`, index-sanity.test.mjs's is `base.txt` — each caller keeps its own base-repo shape
// and hands the resulting `{ dir, g, … }` in (or a zero-arg factory that builds one); this
// helper only pads it out with `many/f0.txt … f<fileCount-1>.txt` and commits them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Adds `fileCount` extra tracked files under `many/` to an ALREADY-BUILT repo object (only
// `.dir` and `.g` are used, so any caller's own repo shape works), committed as one extra
// commit — enough to clear TRUNCATED_INDEX_HEAD_FLOOR (scripts/coord/index-sanity.mjs) for any
// `fileCount` a caller passes. Returns the SAME repo object, unchanged aside from the commit.
export function addBulkFiles(repo, fileCount) {
  const many = join(repo.dir, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < fileCount; i++) writeFileSync(join(many, `f${i}.txt`), `${i}\n`);
  repo.g('add', '-A');
  repo.g('commit', '-qm', 'bulk files');
  return repo;
}

// `makeRepo` is the caller's own zero-arg base-repo factory (a closure over that test file's
// own `makeRepo()`) — this calls it once, then pads the result via addBulkFiles.
export function makeLargeRepo(makeRepo, fileCount) {
  return addBulkFiles(makeRepo(), fileCount);
}

// Simulates the 2026-09-12 incident's torn-index shape on disk (a torn lint-staged /
// pathspec-commit write is not reproducible byte-for-byte from a test, but its OUTCOME — a
// well-formed index carrying only a handful of HEAD's paths — is): `read-tree --empty` then
// staging exactly ONE tracked path leaves a small, valid index against a big HEAD, which is
// what the incident's `git status --short` symptom (whole tree `D` + `??`) actually was.
//
// Stages `many/f0.txt` — the one path every `makeLargeRepo` call is GUARANTEED to have
// created (fileCount is always ≥ 1 wherever this fixture is used), regardless of that
// caller's own base-file naming (heal-main.test.mjs's is `base.txt`, pre-yield-guard.test.mjs's
// is `f.txt`) — so this one helper needs no per-caller path argument.
export function tornIndex(dir, { exec = execFileSync } = {}) {
  const g = (...a) => exec('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('read-tree', '--empty');
  g('add', 'many/f0.txt');
}
