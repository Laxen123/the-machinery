// scripts/coord/land/deps.test.mjs — the name-pair of scripts/coord/land/deps.mjs (plan 3961
// T3.0). NEW-FILE JUSTIFICATION: the name-pair of a genuinely new module.
//
// Imports ONLY deps.mjs — never done-worktree.mjs, whose module load binds the REAL container as
// a side effect, which would make the "before any bind" tests below fail with "already bound"
// (see deps.mjs's own header, § TESTING RULE).
//
// `node --test` runs the top-level tests in ONE file sequentially, in declaration order, sharing
// the module's state — and bindLandDeps() is exactly that kind of state (bound once, refuses a
// second bind). So the order below is load-bearing: every test that needs "nothing bound yet"
// comes first, then the one successful bind, then everything that reads the now-bound container.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindLandDeps,
  landDeps,
  requireDeps,
  LAND_DEPS_GROUPS,
  PROJECT_GROUP_DEFAULTS,
  PROJECT_SPINE_DEFAULTS,
  withProjectGroups,
} from './deps.mjs';

function fullDeps() {
  const deps = {};
  for (const name of LAND_DEPS_GROUPS) deps[name] = { marker: name };
  return deps;
}

let bound; // set by the "clean bind" test, read by every test after it

test('landDeps() before any bind throws', () => {
  assert.throws(() => landDeps(), /before bindLandDeps\(\)/);
});

test('bindLandDeps() refuses a non-object argument', () => {
  for (const bad of [null, 'nope', 42, ['array'], undefined]) {
    assert.throws(() => bindLandDeps(bad), /needs a plain object/, String(bad));
  }
});

test('bindLandDeps() names every missing group, not just the first', () => {
  const deps = fullDeps();
  delete deps.coordGit;
  delete deps.landLib;
  // plan 3961 T3.1: 'spine' — the third synthetic group (alongside spawn/env) — is checked the
  // same generic by-name way as every plain-module group; nothing about its content is special
  // to bindLandDeps, which only ever checks presence-and-shape.
  delete deps.spine;
  assert.throws(
    () => bindLandDeps(deps),
    (err) => {
      assert.match(err.message, /coordGit \(missing\)/);
      assert.match(err.message, /landLib \(missing\)/);
      assert.match(err.message, /spine \(missing\)/);
      return true;
    },
  );
});

test('bindLandDeps() refuses a non-object group, by name', () => {
  const deps = fullDeps();
  deps.env = 'not an object';
  deps.spawn = ['also', 'not'];
  assert.throws(
    () => bindLandDeps(deps),
    (err) => {
      assert.match(err.message, /env \(string, not an object\)/);
      assert.match(err.message, /spawn \(an array, not an object\)/);
      return true;
    },
  );
});

test('bindLandDeps() refuses a non-object project-private group too, by name (plan 4096 b1f480)', () => {
  const deps = fullDeps();
  deps.projectPrivate = 'not an object';
  assert.throws(() => bindLandDeps(deps), /projectPrivate \(string, not an object\)/);
});

test('a clean bind returns a frozen container carrying every group', () => {
  const deps = fullDeps();
  // plan 4096 review b1f480: a project-private group (one no core module reads) is optional, but
  // when present it rides the same bind and gets the same freeze as a declared group.
  deps.projectPrivate = { marker: 'projectPrivate' };
  bound = bindLandDeps(deps);
  for (const name of LAND_DEPS_GROUPS) {
    assert.equal(bound[name], deps[name], name);
  }
  assert.equal(bound.projectPrivate, deps.projectPrivate, 'the private group is bound');
  assert.ok(Object.isFrozen(bound.projectPrivate), 'the private group is frozen too');
  assert.ok(Object.isFrozen(bound), 'container itself is frozen');
});

test('landDeps() returns the exact container the bind produced', () => {
  assert.equal(landDeps(), bound);
});

test('a second bind throws, naming that it is already bound', () => {
  assert.throws(() => bindLandDeps(fullDeps()), /already bound/);
});

test('the frozen container rejects mutation', () => {
  assert.throws(() => {
    'use strict';
    bound.coordGit = { nope: true };
  });
  assert.notEqual(bound.coordGit?.nope, true);
});

test('each frozen group rejects mutation too', () => {
  assert.ok(Object.isFrozen(bound.coordGit));
  assert.throws(() => {
    'use strict';
    bound.coordGit.nope = true;
  });
});

test('requireDeps passes a complete group through unchanged', () => {
  const group = { a: 1, b: 2, c: 3 };
  assert.equal(requireDeps(group, ['a', 'b'], 'some step'), group);
});

test('requireDeps throws naming every missing member, not just the first', () => {
  const group = { a: 1 };
  assert.throws(
    () => requireDeps(group, ['a', 'b', 'c'], 'some step'),
    (err) => {
      assert.match(err.message, /some step/);
      assert.match(err.message, /\bb, c\b|\bb\b.*\bc\b/);
      return true;
    },
  );
});

test('requireDeps refuses a non-object group', () => {
  assert.throws(() => requireDeps(null, ['a'], 'some step'), /needs a dependency group/);
  assert.throws(() => requireDeps('nope', ['a'], 'some step'), /needs a dependency group/);
  assert.throws(() => requireDeps(['a'], ['a'], 'some step'), /needs a dependency group/);
});

// ── plan 4096 T1: withProjectGroups — the core defaults for what only a project supplies ────────
// Pure (it never binds), so these cases are order-independent of the bind tests above.

function coreOnlyGroups() {
  const deps = {};
  for (const name of LAND_DEPS_GROUPS) {
    if (name in PROJECT_GROUP_DEFAULTS) continue;
    deps[name] = name === 'spine' ? { emitSeam: () => {} } : { marker: name };
  }
  return deps;
}

test('plan 4096: with NO project layer, withProjectGroups completes every group from the core defaults', () => {
  const merged = withProjectGroups(coreOnlyGroups(), null);
  for (const name of LAND_DEPS_GROUPS) assert.ok(merged[name], `group ${name} present`);
  assert.equal(merged.scriptsBattery, PROJECT_GROUP_DEFAULTS.scriptsBattery);
  assert.deepEqual(merged.scriptsBattery.BATTERIES, []);
  assert.deepEqual(merged.scriptsBattery.listScriptsTestFiles('/any'), []);
  assert.throws(() => merged.scriptsBattery.batteryRunCapMs(10, 2), /project layer/);
  // plan 4096 review b1f480: the core names none of this repo's own groups.
  assert.deepEqual(Object.keys(PROJECT_GROUP_DEFAULTS), ['scriptsBattery']);
  assert.ok(!('hobbyEnv' in merged), 'no hobbyEnv group in a core-only boot');
  assert.ok(!('nightlyWindowsSuite' in merged), 'no nightlyWindowsSuite group in a core-only boot');
  assert.ok(!LAND_DEPS_GROUPS.includes('hobbyEnv'));
  assert.ok(!LAND_DEPS_GROUPS.includes('nightlyWindowsSuite'));
  for (const [member, value] of Object.entries(PROJECT_SPINE_DEFAULTS)) {
    assert.equal(merged.spine[member], value, `spine.${member} takes its core default`);
  }
  assert.equal(typeof merged.spine.emitSeam, 'function', 'the core spine members survive');
  assert.equal(merged.spine.wikiDiffOnWorktreeBranch('/wt', 'worktree-x'), null);
  assert.deepEqual(merged.spine.SWEEP_CHECKPOINT_PATHSPEC, []);
  assert.throws(() => merged.spine.changedPriceClinics([], []), /project layer/);
});

test('plan 4096: a project plugin supplies its groups and spine members over the defaults', () => {
  const nightly = {
    BATTERIES: [{ key: 'battery' }],
    listScriptsTestFiles: () => ['a'],
    batteryRunCapMs: () => 1,
  };
  const reading = () => '1 GB free';
  const merged = withProjectGroups(coreOnlyGroups(), {
    scriptsBattery: nightly,
    spine: { freeMemoryReading: reading },
  });
  assert.equal(merged.scriptsBattery, nightly);
  assert.equal(merged.spine.freeMemoryReading, reading);
  assert.equal(merged.spine.preflightInterlude, null, 'an unsupplied member keeps its default');
});

test('plan 4096 review round 2: a `__proto__` group name is refused, never silently dropped', () => {
  // JSON.parse builds `__proto__` as an OWN key, the shape a plugin object could carry.
  assert.throws(
    () => withProjectGroups(coreOnlyGroups(), JSON.parse('{"__proto__": {"x": 1}}')),
    /prototype-special/,
  );
});

test('plan 4096 review round 5: an INHERITED spine never reaches the merged spine', () => {
  const project = Object.create({ spine: { freeMemoryReading: () => 'inherited' } });
  const merged = withProjectGroups(coreOnlyGroups(), project);
  assert.equal(merged.spine.freeMemoryReading, PROJECT_SPINE_DEFAULTS.freeMemoryReading);
});

test('plan 4096 review round 4: an INHERITED project-supplied group never overrides the default', () => {
  const project = Object.create({ scriptsBattery: { BATTERIES: ['inherited'] } });
  const merged = withProjectGroups(coreOnlyGroups(), project);
  assert.equal(merged.scriptsBattery, PROJECT_GROUP_DEFAULTS.scriptsBattery);
});

test('plan 4096 review round 3: Object.prototype names are ordinary private groups, kept as-is', () => {
  // Every membership test is an own-property test, so a name an `in` check would find on
  // Object.prototype is neither refused nor skipped.
  for (const name of ['constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    const group = { x: 1 };
    const merged = withProjectGroups(coreOnlyGroups(), { [name]: group });
    assert.ok(Object.hasOwn(merged, name), `${name} is an own key of the merged container`);
    assert.equal(merged[name], group, `${name} passes through as-is`);
  }
});

test('plan 4096 b1f480: a plugin adds a project-private group without any core default or core edit', () => {
  const privateGroup = { loadSomething: () => 'x' };
  const merged = withProjectGroups(coreOnlyGroups(), { projectPrivate: privateGroup });
  assert.equal(merged.projectPrivate, privateGroup, 'the private group passes through as-is');
  assert.equal(
    merged.scriptsBattery,
    PROJECT_GROUP_DEFAULTS.scriptsBattery,
    'an unsupplied core-read group keeps its default',
  );
  assert.ok(!('projectPrivate' in PROJECT_GROUP_DEFAULTS), 'no core default was needed');
  assert.throws(
    () => withProjectGroups(coreOnlyGroups(), { projectPrivate: 'nope' }),
    /projectPrivate must each be a plain object/,
  );
  assert.throws(
    () => withProjectGroups(coreOnlyGroups(), { projectPrivate: null }),
    /projectPrivate must each be a plain object/,
  );
});

test('plan 4096: withProjectGroups refuses a plugin that would replace a core group or add an undeclared member', () => {
  assert.throws(
    () => withProjectGroups(coreOnlyGroups(), { coordGit: {} }),
    /never replaces a core group — refused coordGit/,
  );
  // A group the command file passes but LAND_DEPS_GROUPS does not declare is still core-bound.
  assert.throws(
    () => withProjectGroups({ ...coreOnlyGroups(), extraCore: {} }, { extraCore: {} }),
    /never replaces a core group — refused extraCore/,
  );
  assert.throws(
    () => withProjectGroups(coreOnlyGroups(), { spine: { emitSeam: () => {} } }),
    /no core default in PROJECT_SPINE_DEFAULTS/,
  );
  assert.throws(() => withProjectGroups(coreOnlyGroups(), []), /plain object/);
});

test('plan 4096: withProjectGroups refuses a core group set that also owns a project-supplied name', () => {
  const withShadow = coreOnlyGroups();
  withShadow.spine = { ...withShadow.spine, freeMemoryReading: () => 'x' };
  assert.throws(() => withProjectGroups(withShadow, null), /never both/);
  const withGroup = { ...coreOnlyGroups(), scriptsBattery: {} };
  assert.throws(() => withProjectGroups(withGroup, null), /never both/);
});
