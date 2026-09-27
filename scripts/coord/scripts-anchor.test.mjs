// scripts/coord/scripts-anchor.test.mjs — name-paired test for a genuinely new module
// (scripts-anchor.mjs, plan 3962 Phase 2); it has no existing test file to fold into.
//
// Every path here is BUILT with node:path's join from a root the test owns, never spelled as a
// POSIX literal: these assertions run on Windows at push time and on Linux in a cloud drain, and
// a hardcoded separator would make the platform ambient (vetapp CLAUDE.md § ambient-environment).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, parse } from 'node:path';
import { findScriptsDir, repoRootFrom, scriptsFileFrom } from './scripts-anchor.mjs';

const FIXTURE_ROOT = join(parse(process.cwd()).root, 'repo');
// Not spelled inside the join below: `join(<root>, '<literal>', …)` is the idiom
// select-battery-tests.mjs reads as a REAL-tree read, and this path is entirely synthetic.
const ORPHAN = 'elsewhere';
const SCRIPTS = join(FIXTURE_ROOT, 'scripts');

test('findScriptsDir returns the scripts dir itself from every depth under it', () => {
  assert.equal(findScriptsDir(SCRIPTS), SCRIPTS);
  assert.equal(findScriptsDir(join(SCRIPTS, 'coord')), SCRIPTS);
  assert.equal(findScriptsDir(join(SCRIPTS, 'coord', 'land')), SCRIPTS);
  assert.equal(findScriptsDir(join(SCRIPTS, 'a', 'b', 'c', 'd')), SCRIPTS);
});

test('findScriptsDir returns null when no ancestor is named scripts', () => {
  assert.equal(findScriptsDir(join(FIXTURE_ROOT, 'backend', 'src')), null);
});

test('findScriptsDir bounds the walk and never loops at the filesystem root', () => {
  const fsRoot = parse(process.cwd()).root;
  assert.equal(findScriptsDir(fsRoot), null);
});

test('repoRootFrom is depth-independent — the whole point of the move', () => {
  assert.equal(repoRootFrom(SCRIPTS), FIXTURE_ROOT);
  assert.equal(repoRootFrom(join(SCRIPTS, 'coord')), FIXTURE_ROOT);
  assert.equal(repoRootFrom(join(SCRIPTS, 'coord', 'land')), FIXTURE_ROOT);
});

test('repoRootFrom falls back to the parent when there is no scripts ancestor', () => {
  const orphan = join(FIXTURE_ROOT, ORPHAN, 'copied-module');
  assert.equal(repoRootFrom(orphan), dirname(orphan));
});

test('scriptsFileFrom resolves a sibling command from any depth', () => {
  const want = join(SCRIPTS, 'landing-queue.mjs');
  assert.equal(scriptsFileFrom('landing-queue.mjs', SCRIPTS), want);
  assert.equal(scriptsFileFrom('landing-queue.mjs', join(SCRIPTS, 'coord')), want);
  assert.equal(scriptsFileFrom('landing-queue.mjs', join(SCRIPTS, 'coord', 'land')), want);
});

test('scriptsFileFrom falls back to the caller directory with no scripts ancestor', () => {
  const orphan = join(FIXTURE_ROOT, ORPHAN, 'copied-module');
  assert.equal(scriptsFileFrom('x.mjs', orphan), join(orphan, 'x.mjs'));
});

test('the real module resolves this repo, from this test file location', () => {
  // A live check rather than a synthetic one: this file sits at scripts/coord/, so the anchor
  // must name the real scripts dir and the real repo root regardless of where the runner was
  // launched from.
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
  assert.equal(findScriptsDir(here), dirname(here));
  assert.equal(repoRootFrom(here), dirname(dirname(here)));
});
