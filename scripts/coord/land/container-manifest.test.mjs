// scripts/coord/land/container-manifest.test.mjs — the name-pair of
// scripts/coord/land/container-manifest.mjs (plan 4066 task 0).
//
// NEW-FILE JUSTIFICATION (CLAUDE.md § a new scripts/*.test.mjs FILE requires one): the name-pair
// of a genuinely new module, container-manifest.mjs, which no existing test file exercises.
//
// Imports ONLY deps.mjs and container-manifest.mjs — never done-worktree.mjs, whose module load
// binds the REAL container as a side effect (see deps.mjs's own header, § TESTING RULE), which
// would make this file's own bind below fail with "already bound".
//
// `node --test` runs the top-level tests in ONE file sequentially, sharing the module's state —
// and bindLandDeps() is exactly that kind of state (bound once, refuses a second bind). So this
// file binds EXACTLY ONCE, deliberately built complete except for one member
// (testQueue.perSlotWorkerBudget, read only by gates-runner.mjs) — the negative/named-refusal
// test drives assertContainerManifests() against that one gap, and the positive check that
// follows proves a correctly-provisioned module's manifest passes by calling requireDeps()
// directly against a DIFFERENT module's groups on the SAME bound container (queue-probe.mjs's —
// none of its groups touch testQueue), rather than needing a second bind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bindLandDeps,
  landDeps,
  requireDeps,
  LAND_DEPS_GROUPS,
  PROJECT_GROUP_DEFAULTS,
} from './deps.mjs';
import { CORE_MODULE_MANIFESTS, assertContainerManifests } from './container-manifest.mjs';
// gpt-review 4066 finding dc4070/b30b16: the scanner used to hand-roll its own comment/string
// blanker (blankNonCode, below) that mixed Array.from(source) (code POINTS) with UTF-16 source
// indexing — once the source contains an astral character (this codebase's comments are full of
// them: 🟢 🟥 🟩 💰 ⛔), `out` (code-point length) desyncs from `source` (UTF-16 length) and every
// later mask lands at the wrong offset. Reuse the maintained, length-preserving tokenizer instead
// of a second hand-rolled copy that can drift from it.
import { stripJsCommentsAndStrings } from '../write-lint-common.mjs';

// ── the scanner — the SAME classification container-manifest.mjs's manifests must stay honest
// against. Three shapes only (plan 4066 task 0, D-4066-3): `D.<group>.<member>`,
// `landDeps().<group>.<member>`, and a whole-group destructure (`const { a, b } = D.<group>;` /
// `= landDeps().<group>;`). Anything else — a bare group capture, a computed access, a group
// passed as a value — is a violation the parity test below fails on, naming the file and line. ──

const IDENT = '[A-Za-z_$][\\w$]*';

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

function maskSpan(t, start, end) {
  return t.slice(0, start) + t.slice(start, end).replace(/[^\n]/g, ' ') + t.slice(end);
}

/**
 * Scan one core module's source for its container reads. Returns { reads: Map<group,Set<member>>,
 * violations: [{line, match}] } — a violation is any `D.` or `landDeps()` occurrence in
 * non-comment, non-string code that is not one of the three classified shapes above, nor the bare
 * whole-container bind idiom (`const D = landDeps();`, nothing chained after the call, which every
 * core module uses once and which is deliberately NOT a member read).
 */
function scanContainerReads(source) {
  const reads = new Map();
  const violations = [];
  const noteRead = (group, member) => {
    if (!reads.has(group)) reads.set(group, new Set());
    reads.get(group).add(member);
  };

  let text = stripJsCommentsAndStrings(source);

  // Shape 3: whole-group destructure. The group capture must be followed (mod whitespace)
  // directly by `;` — a `.member(` after the group name means this is a function-call return
  // destructured (shape 1/2 below), not this shape, so it must NOT match here.
  {
    const re = new RegExp(
      `\\b(?:const|let)\\s*\\{\\s*([^}]*)\\}\\s*=\\s*(?:D\\.(${IDENT})|landDeps\\(\\)\\.(${IDENT}))\\s*;`,
      'g',
    );
    let m;
    const spans = [];
    while ((m = re.exec(text))) {
      const group = m[2] || m[3];
      const members = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.includes(':') ? s.split(':')[0].trim() : s));
      for (const mem of members) noteRead(group, mem);
      spans.push([m.index, m.index + m[0].length]);
    }
    for (const [start, end] of spans) text = maskSpan(text, start, end);
  }

  // Shape 1 & 2: D.<group>.<member> / landDeps().<group>.<member> — `\s*` between tokens crosses
  // a prettier line-break in a chained call the same way it crosses a space.
  {
    const re = new RegExp(
      `\\bD\\.(${IDENT})\\s*\\.(${IDENT})|landDeps\\(\\)\\s*\\.(${IDENT})\\s*\\.(${IDENT})`,
      'g',
    );
    let m;
    const spans = [];
    while ((m = re.exec(text))) {
      const group = m[1] || m[3];
      const member = m[2] || m[4];
      noteRead(group, member);
      spans.push([m.index, m.index + m[0].length]);
    }
    for (const [start, end] of spans) text = maskSpan(text, start, end);
  }

  // Anything left: a bare `D.<ident>` not part of a two-dot read, or `landDeps()` chained into
  // exactly one member (not two) — except the bare whole-container bind idiom (`landDeps()` with
  // nothing chained at all), which is deliberately allowed and never flagged.
  {
    const re = /\bD\.[A-Za-z_$][\w$]*/g;
    let m;
    while ((m = re.exec(text))) violations.push({ line: lineOf(source, m.index), match: m[0] });
  }
  {
    const re = /landDeps\(\)(\s*\.[A-Za-z_$][\w$]*)?/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1])
        violations.push({ line: lineOf(source, m.index), match: m[0].replace(/\s+/g, ' ') });
    }
  }

  return { reads, violations };
}

// gpt-review 4066 findings dc4070/b30b16: the scanner's original hand-rolled blanker
// (`blankNonCode`, since deleted) built its output buffer with `Array.from(source)` — a
// CODE-POINT array — while indexing the ORIGINAL `source` string by UTF-16 code unit
// (`source[i]`, `source.slice(i, i+2)`). An astral character (this codebase's own land-module
// comments carry several: 🟢 🟥 🟩 💰 ⛔) is ONE code point but TWO UTF-16 units, so `Array.from`
// produces one array element per code point while `source.length` counts UTF-16 units — the two
// walks desync at the first astral character and every mask applied after it lands at the wrong
// offset, corrupting real code content rather than just the comment. `stripJsCommentsAndStrings`
// indexes by UTF-16 code unit throughout (never Array.from), so it cannot desync this way.
test('scanContainerReads (via stripJsCommentsAndStrings) is length-preserving and stays correctly aligned across an astral character', () => {
  // Empirically, the deleted blankNonCode on this exact source produced a 140-char string from a
  // 141-char input and had already corrupted the `D.spawn.run("x")` call by the time it got
  // there (`D.spawn.run("   ;` — the closing paren and quote gone) — not just a benign one-char
  // shift in the comment, a real mis-scan of downstream code.
  const source = [
    '// plan 0000: 🟢 an astral emoji (🟢) inside a comment, followed by real code',
    'function f() {',
    '  const D = landDeps();',
    '  return D.spawn.run("x");',
    '}',
    '',
  ].join('\n');

  const stripped = stripJsCommentsAndStrings(source);
  assert.equal(
    stripped.length,
    source.length,
    'stripJsCommentsAndStrings must preserve length even when the source contains an astral character',
  );

  const { reads, violations } = scanContainerReads(source);
  assert.deepEqual(violations, [], 'no unclassified D./landDeps() shape after the astral comment');
  assert.deepEqual(
    [...(reads.get('spawn') || [])],
    ['run'],
    'the real D.spawn.run read after the astral comment must still be found intact',
  );
});

// ── negative / positive: one bind, deliberately incomplete by exactly one member ──

const CORE_DIR = fileURLToPath(new URL('.', import.meta.url));

function buildDeps({ omitGroup, omitMember }) {
  // Every distinct member every core module's manifest reads, per group — a stub function is
  // enough for requireDeps (it only checks presence, `group[name] === undefined`).
  const byGroup = new Map();
  for (const manifest of Object.values(CORE_MODULE_MANIFESTS)) {
    for (const [group, members] of Object.entries(manifest)) {
      if (!byGroup.has(group)) byGroup.set(group, new Set());
      for (const m of members) byGroup.get(group).add(m);
    }
  }
  const deps = {};
  for (const name of LAND_DEPS_GROUPS) {
    const members = byGroup.get(name);
    if (!members) {
      deps[name] = {}; // a group no core module's manifest names — bindLandDeps only needs an object
      continue;
    }
    const group = {};
    for (const m of members) {
      if (name === omitGroup && m === omitMember) continue; // the deliberate gap
      group[m] = () => {};
    }
    deps[name] = group;
  }
  return deps;
}

let bound;

test('setup: bind a container complete except for one member gates-runner.mjs reads', () => {
  bound = bindLandDeps(buildDeps({ omitGroup: 'testQueue', omitMember: 'perSlotWorkerBudget' }));
  assert.ok(bound, 'bind succeeded');
});

test('assertContainerManifests() throws a named refusal for the missing member, naming the reading module', () => {
  assert.throws(
    () => assertContainerManifests(),
    (err) => {
      assert.match(err.message, /perSlotWorkerBudget/, 'names the missing member');
      assert.match(err.message, /gates-runner\.mjs/, 'names the reading module');
      return true;
    },
  );
});

test('requireDeps passes a correctly-provisioned module through the same bound container (positive path, no second bind)', () => {
  // queue-probe.mjs's manifest touches L/env/spawn/spine only — none of them is testQueue, so
  // every one of its groups is fully provisioned on the SAME container test 2 just found a gap
  // in elsewhere. This proves assertContainerManifests()'s per-group requireDeps() call succeeds
  // for a module whose manifest the container DOES fully satisfy, without a second bind (bindLandDeps
  // refuses one — see this file's own header).
  const D = landDeps();
  const manifest = CORE_MODULE_MANIFESTS['queue-probe.mjs'];
  assert.ok(manifest, 'queue-probe.mjs has a manifest');
  for (const [group, members] of Object.entries(manifest)) {
    assert.deepEqual(requireDeps(D[group], members, 'queue-probe.mjs'), D[group]);
  }
});

// ── manifest / source parity: for each core module, its declared manifest and its scanned
// source must name the exact same groups and, per group, the exact same members. ──

for (const [moduleId, manifest] of Object.entries(CORE_MODULE_MANIFESTS)) {
  test(`${moduleId}'s CONTAINER_READS matches its own source (no lag, no stale entry)`, () => {
    const source = readFileSync(CORE_DIR + moduleId, 'utf8');
    const { reads: actual, violations } = scanContainerReads(source);
    assert.deepEqual(
      violations,
      [],
      `${moduleId} has an unclassified D./landDeps() shape: ${JSON.stringify(violations)}`,
    );

    const declaredGroups = new Set(Object.keys(manifest));
    const actualGroups = new Set(actual.keys());
    const missingGroups = [...actualGroups].filter((g) => !declaredGroups.has(g)).sort();
    const staleGroups = [...declaredGroups].filter((g) => !actualGroups.has(g)).sort();
    assert.deepEqual(
      { missingGroups, staleGroups },
      { missingGroups: [], staleGroups: [] },
      `${moduleId}: manifest groups vs source groups differ (missing = read in source but not ` +
        `declared; stale = declared but not read)`,
    );

    for (const group of declaredGroups) {
      const declaredMembers = new Set(manifest[group]);
      const actualMembers = actual.get(group) || new Set();
      const missing = [...actualMembers].filter((m) => !declaredMembers.has(m)).sort();
      const stale = [...declaredMembers].filter((m) => !actualMembers.has(m)).sort();
      assert.deepEqual(
        { missing, stale },
        { missing: [], stale: [] },
        `${moduleId}.${group}: manifest members vs source members differ (missing = read in ` +
          `source but not declared; stale = declared but not read)`,
      );
    }
  });
}

// ── plan 4096 review b1f480: the net's reach. A project plugin may add PROJECT-PRIVATE container
// groups (deps.mjs's withProjectGroups) that no core default covers and no manifest here checks.
// That is sound only while no core manifest can name a group the core does not declare — pinned
// here — and while each core-read, project-supplied group's DEFAULT carries every member a core
// manifest reads from it, so a core-only boot passes this net. ──

test('every group a core manifest reads is a core-declared group (project-private groups stay outside the net)', () => {
  const declared = new Set(LAND_DEPS_GROUPS);
  const undeclared = [];
  for (const [moduleId, manifest] of Object.entries(CORE_MODULE_MANIFESTS)) {
    for (const group of Object.keys(manifest)) {
      if (!declared.has(group)) undeclared.push(`${moduleId}:${group}`);
    }
  }
  assert.deepEqual(undeclared, []);
});

test('each project-supplied group default carries every member a core manifest reads from it', () => {
  for (const [group, fallback] of Object.entries(PROJECT_GROUP_DEFAULTS)) {
    for (const [moduleId, manifest] of Object.entries(CORE_MODULE_MANIFESTS)) {
      if (!manifest[group]) continue;
      assert.equal(
        requireDeps(fallback, manifest[group], moduleId),
        fallback,
        `${moduleId}.${group}`,
      );
    }
  }
});
