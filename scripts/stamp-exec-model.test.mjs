// scripts/stamp-exec-model.test.mjs — modeled on move-plan.test.mjs: unit tests
// for the pure helpers (renameForExecModel, setFrontmatterKey,
// assertStampableStatus) PLUS end-to-end subprocess tests against a throwaway
// isolated git repo (the shared test-helpers/isolated-plan-repo.mjs scaffold —
// plan 1797; it also clears the inherited git env vars at import, plan 338).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { isolatedRepoFactory, runTool as runStamp } from './test-helpers/isolated-plan-repo.mjs';
import {
  renameForExecModel,
  setFrontmatterKey,
  assertStampableStatus,
  specSpeccedBody,
  argvUsageError,
  VALID_EXEC_MODELS,
} from './stamp-exec-model.mjs';
// plan 2892: the promotable-state predicate the --spec-review preflight consults. Its
// unit tests live here rather than in a new name-paired file (repo rule: fold into the
// existing test file of the module under test) because stamp-exec-model is its only
// consumer and these cases ARE the stamp's refusal behaviour.
import { completeSpeccedStatusProse, findPromotionBlockers } from './coord/plan-promotable-lib.mjs';
// plan 3609: the E1/E2 cost-capture helpers. Same "fold into the consumer's test file" reason
// as plan-promotable-lib.mjs above — stamp-exec-model.mjs is stamp-lib.mjs's only caller for
// these two, and there is no name-paired stamp-lib.test.mjs to host them in.
import { resolveSpecPassCost, specCostFrontmatterValue } from './coord/stamp-lib.mjs';
// plan 4071 review fix (T2 caller): the SEED-WRITE label findPromotionBlockers'
// SEED_BANNER_ANCHOR_RX anchors on now comes from coord.config.json's mutationBanner.label
// (the removed literal) — read vetapp's OWN row once, same precedent as stamp-lib.test.mjs's
// VETAPP_PLAN_CATEGORIES / move-plan.test.mjs's VETAPP_PLAN_CATEGORIES.
import { resolveConfigDir, loadCoordConfig } from './coord/coord-config.mjs';
import { repoRootFrom } from './coord/scripts-anchor.mjs';
import {
  applyExecutionBranchRename,
  planExecutionBranchRename,
} from './coord/exec-model-stamp.mjs';
import { applyAdoptBranchStamp } from './coord/plan-adopt-branch.mjs';
import { collapseSameShaBranches } from './coord/queue-drain.mjs';

// ─────────────────────────── pure-function tests ───────────────────────────

test('renameForExecModel: sonnet → fable inserts the FABLE- segment right after the id', () => {
  assert.equal(renameForExecModel('1000-Other-foo.md', 'fable'), '1000-FABLE-Other-foo.md');
});

test('renameForExecModel: fable → sonnet strips an existing FABLE- segment', () => {
  assert.equal(renameForExecModel('1000-FABLE-Other-foo.md', 'sonnet'), '1000-Other-foo.md');
});

test('renameForExecModel: idempotent — stamping fable on an already-FABLE basename is a no-op', () => {
  assert.equal(renameForExecModel('1000-FABLE-Other-foo.md', 'fable'), '1000-FABLE-Other-foo.md');
});

test('renameForExecModel: idempotent — stamping sonnet on an already-plain basename is a no-op', () => {
  assert.equal(renameForExecModel('1000-Other-foo.md', 'sonnet'), '1000-Other-foo.md');
});

test('renameForExecModel: throws on a basename that does not match the <id>-... shape', () => {
  assert.throws(() => renameForExecModel('not-a-plan.md', 'fable'), /doesn't match the expected/);
});

// plan 3341: the `sol` lane's SOL- marker — same shape as the FABLE- cases above, plus the
// mutual-exclusivity swap (a basename can never carry both).
test('renameForExecModel: sonnet → sol inserts the SOL- segment right after the id', () => {
  assert.equal(renameForExecModel('3341-Infra-foo.md', 'sol'), '3341-SOL-Infra-foo.md');
});

test('renameForExecModel: sol → sonnet strips an existing SOL- segment', () => {
  assert.equal(renameForExecModel('3341-SOL-Infra-foo.md', 'sonnet'), '3341-Infra-foo.md');
});

test('renameForExecModel: idempotent — stamping sol on an already-SOL basename is a no-op', () => {
  assert.equal(renameForExecModel('3341-SOL-Infra-foo.md', 'sol'), '3341-SOL-Infra-foo.md');
});

test('renameForExecModel: FABLE- → sol REPLACES the marker in one step (mutually exclusive)', () => {
  assert.equal(renameForExecModel('3341-FABLE-Infra-foo.md', 'sol'), '3341-SOL-Infra-foo.md');
});

test('renameForExecModel: SOL- → fable REPLACES the marker in one step (mutually exclusive)', () => {
  assert.equal(renameForExecModel('3341-SOL-Infra-foo.md', 'fable'), '3341-FABLE-Infra-foo.md');
});

// plan 3341 review: VALID_EXEC_MODELS is now DERIVED from claim-plan-lib.mjs's
// EXEC_LANE_TABLE (Object.keys), so this checks membership rather than a fixed order — the
// order is EXEC_LANE_TABLE's own key order, not a fact this test should pin independently.
test('VALID_EXEC_MODELS: includes sonnet, fable, and sol (plan 3341)', () => {
  assert.deepEqual(new Set(VALID_EXEC_MODELS), new Set(['fable', 'sonnet', 'sol']));
  assert.equal(VALID_EXEC_MODELS.length, 3);
});

test('setFrontmatterKey: inserts a new key into an existing frontmatter block, preserving others', () => {
  const out = setFrontmatterKey('---\nsummary: x\n---\n\n# T\n', 'execModel', 'fable');
  assert.match(out, /^summary: x$/m);
  assert.match(out, /^execModel: fable$/m);
  // exactly one frontmatter block (opens once)
  assert.equal((out.match(/^---$/gm) || []).length, 2);
});

test('setFrontmatterKey: replaces an existing key in place without duplicating it', () => {
  const out = setFrontmatterKey(
    '---\nsummary: x\nexecModel: sonnet\n---\n\n# T\n',
    'execModel',
    'fable',
  );
  assert.equal((out.match(/^execModel:/gm) || []).length, 1);
  assert.match(out, /^execModel: fable$/m);
  assert.match(out, /^summary: x$/m);
});

test('setFrontmatterKey: creates a frontmatter block when the body has none', () => {
  const out = setFrontmatterKey('# T\n\nBody.\n', 'stage', 'specced');
  assert.match(out, /^---\nstage: specced\n---\n\n# T/);
});

// plan 1292 bugfix (plan 1015 shape): re-stamping a key that carries a trailing YAML
// inline comment must NOT delete the comment — it's the operator's guard annotation
// (e.g. plan 1015's "NOT drain-eligible" note), and stamp-exec-model is meant to be
// safely re-runnable (e.g. attaching a --spec-review later) without erasing it.
test('setFrontmatterKey: preserves a trailing YAML comment when replacing an existing value', () => {
  const out = setFrontmatterKey(
    '---\nexecModel: fable # umbrella tracker — NOT drain-eligible\n---\n\n# T\n',
    'execModel',
    'fable',
  );
  assert.match(out, /^execModel: fable # umbrella tracker — NOT drain-eligible$/m);
  assert.equal((out.match(/^execModel:/gm) || []).length, 1);
});

// plan 1292 round-2 bugfix: round 1 preserved the comment UNCONDITIONALLY, even when the
// stamped VALUE actually changes — producing a self-contradicting line like
// `execModel: sonnet # umbrella tracker — NOT drain-eligible` (a comment that described
// the OLD value, now stapled onto a line it no longer explains). The comment only stays
// true across an IDEMPOTENT re-stamp of the SAME value; a genuine value change must drop
// the stale annotation instead of carrying it forward onto a value it never described.
test('setFrontmatterKey: a value change on a commented line DROPS the stale comment', () => {
  const out = setFrontmatterKey(
    '---\nexecModel: sonnet # umbrella tracker — NOT drain-eligible\n---\n\n# T\n',
    'execModel',
    'fable',
  );
  assert.match(out, /^execModel: fable$/m);
  assert.doesNotMatch(out, /umbrella tracker/);
});

test('setFrontmatterKey: no trailing comment on the old line ⇒ no comment introduced', () => {
  const out = setFrontmatterKey('---\nexecModel: sonnet\n---\n\n# T\n', 'execModel', 'fable');
  assert.match(out, /^execModel: fable$/m);
});

test('assertStampableStatus: refuses in-progress/ and archive/, passes everything else', () => {
  assert.throws(
    () => assertStampableStatus('in-progress', '1000-Other-foo.md'),
    /refusing to stamp .* in-progress\//,
  );
  assert.throws(
    () => assertStampableStatus('archive', '1000-Other-foo.md'),
    /refusing to stamp .* archive\//,
  );
  for (const s of [
    'pending-approval',
    'ready',
    'waiting-blocked',
    'waiting-operator',
    'waiting-date',
    'waiting-trip',
  ])
    assert.doesNotThrow(() => assertStampableStatus(s, '1000-Other-foo.md'));
});

// ─────────────────────────── subprocess / repo tests ───────────────────────────

// plan 4071 review fix (T2 caller): the SEED-WRITE label findPromotionBlockers'
// SEED_BANNER_ANCHOR_RX anchors on comes from coord.config.json's mutationBanner.label — read
// THIS test file's own (self-resolving) checkout once, same value every in-process call below
// sees (they import build-index-lib.mjs the same way this file does) — moved ahead of
// VERDICT_SECTION/DEFAULT_BODY/stubProseBody so `sw()` is defined before they need it.
const { mutationBanner: VETAPP_MUTATION_BANNER } = loadCoordConfig(
  repoRootFrom(import.meta.dirname),
);
// plan 3958: this module ships as-is into the public coord-kit, so VETAPP_MUTATION_BANNER.label
// resolves to the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' —
// every fixture body below that hardcodes the literal banner text runs through this helper
// instead, so it always matches whatever findPromotionBlockers' own (self-resolved, from the
// SAME checkout) anchor actually looks for. Identity function on vetapp itself.
const sw = (s) => s.replaceAll('SEED-WRITE', VETAPP_MUTATION_BANNER.label);

// plan 3943: a canonical `## Spec-pass verdict` section, satisfying the new
// findPromotionBlockers verdict check (C1-C5 tags + litmus + exit-test lines) — appended
// at the very END of both fixture bodies below so nextHeadingBoundary's "up to the next
// H2 or EOF" scan has nothing after it to accidentally truncate the section against.
const VERDICT_SECTION = [
  '## Spec-pass verdict (fixture)',
  '',
  '- C1: PASS',
  '- C2: PASS',
  '- C3: PASS',
  '- C4: PASS',
  '- C5: PASS',
  '- execModel litmus: sonnet.',
  '- exit test: yes.',
  '',
].join('\n');

// plan 2892: the 💰 banner is part of the default fixture now, not decoration — a
// `--spec-review` stamp validates the whole promotable state before writing, and a body
// without one is (correctly) refused. Every real plan carries both banners; the fixture
// carrying only one was what made the old default un-promotable.
const DEFAULT_BODY = [
  '---',
  'summary: Test plan for stamp-exec-model',
  'seedWrite: false',
  '---',
  '',
  sw('> 🟩 **SEED-WRITE: no**'),
  '',
  '> 💰 **Cost forecast:** $0 — no LLM/API spend.',
  '',
  '**Status:** 📋 READY — opened 2026-07-02.',
  '',
  '# 1000-Other-foo',
  '',
  'Body.',
  '',
  VERDICT_SECTION,
].join('\n');

// The wedged shape the four absorbed infra-debt entries all start from: a fresh mint
// whose Status prose still says STUB. Stamping `stage: specced` over it used to strand
// the prose, and board-write-gate's Check A then refused every subsequent write.
const stubProseBody = (extra = {}) =>
  [
    '---',
    'summary: Test plan for stamp-exec-model',
    'stage: stub',
    '---',
    '',
    ...(extra.noSeedBanner ? [] : [sw('> 🟩 **SEED-WRITE: no**'), '']),
    ...(extra.noCostBanner ? [] : ['> 💰 **Cost forecast:** $0 — no LLM/API spend.', '']),
    '**Status:** 📋 STUB — minted 2026-08-05.',
    '',
    '# 1000-Other-foo',
    '',
    'Body.',
    '',
    ...(extra.noVerdict ? [] : [VERDICT_SECTION]),
  ].join('\n');

// The shared isolated-plan-repo scaffold with this suite's defaults baked in; the
// `stampExecModel` key is the COPIED tool inside the temp repo (run that copy,
// never the real tool).
const makeIsolatedRepo = isolatedRepoFactory({
  prefix: 'stampexec',
  basename: '1000-Other-foo.md',
  body: DEFAULT_BODY,
  tools: { stampExecModel: 'stamp-exec-model.mjs' },
});

// plan 4071: the isolated fixture repo carries no coord.config.json of its own, and an
// absent mutationBanner.label degrades to the core's neutral default (`DATA-WRITE`) — not
// vetapp's own "SEED-WRITE". Every fixture body in this file (DEFAULT_BODY, stubProseBody,
// and the grillBody variants below) carries the literal `> 🟩 **SEED-WRITE: no**` banner
// line, so any invocation that reaches findPromotionBlockers' SEED_BANNER_ANCHOR_RX check
// (any `--spec-review` value) or move-plan's own Blocked-by anchor (`--move waiting-*`)
// needs the fixture repo configured with vetapp's OWN label — otherwise the anchor looks
// for a banner these bodies never wrote. Twelve call sites need this; one helper instead
// of repeating the write/add/commit/push block twelve times.
function withVetappMutationBanner(repo) {
  writeFileSync(
    join(repo.dir, 'coord.config.json'),
    JSON.stringify({ mutationBanner: VETAPP_MUTATION_BANNER }),
  );
  repo.g('add', 'coord.config.json');
  repo.g('commit', '-qm', 'plan 4071 test fixture: configure the SEED-WRITE mutation banner');
  repo.g('push', '-q', 'origin', 'master');
  return repo;
}

// ───────────── plan 3919: execution-branch reconciliation on lane re-stamp ─────────────

const OLD = 'worktree-1000-SOL-Other-foo';
const NEW = 'worktree-1000-FABLE-Other-foo';
const SHA = 'abc1234';
const oldBase = '1000-SOL-Other-foo.md';
const newBase = '1000-FABLE-Other-foo.md';
const rawHeads = (entries) =>
  entries.map(({ name, sha = SHA }) => `${sha}\trefs/heads/${name}`).join('\n') +
  (entries.length ? '\n' : '');

function planner(overrides = {}) {
  const entries = overrides.entries ?? [{ name: OLD, sha: SHA, fresh: false }];
  let reads = 0;
  let claims = 0;
  const result = planExecutionBranchRename({
    mainDir: '/fixture',
    planId: '1000',
    oldBasename: oldBase,
    newBasename: newBase,
    body: DEFAULT_BODY,
    branchMap: new Map([['1000', entries]]),
    lsRemote: () => (reads++, rawHeads(entries)),
    claimStatus: () => (claims++, { held: false }),
    collapse: (list) => ({ branches: list, duplicates: [] }),
    applyAdopt: applyAdoptBranchStamp,
    ...overrides,
  });
  return { result, reads, claims };
}

function renamePlan(overrides = {}) {
  return {
    action: 'rename',
    planId: '1000',
    sourceRefs: [{ name: OLD, sha: SHA }],
    destination: { name: NEW, sha: SHA },
    adoptAction: 'stamped',
    adoptBranch: NEW,
    ...overrides,
  };
}

test('3919: planner maps the 3886 old-lane branch to the new slug without mutating', () => {
  const { result, reads } = planner();
  assert.equal(result.action, 'rename');
  assert.deepEqual(result.destination, { name: NEW, sha: SHA });
  assert.equal(result.adoptBranch, NEW);
  assert.equal(reads, 1);
});

test('3919 c2f4e2: zero-padded basename queries both id spellings and renames its branch', () => {
  const paddedOld = 'worktree-0912-SOL-Other-foo';
  const paddedNew = 'worktree-0912-FABLE-Other-foo';
  const patterns = [];
  const { result } = planner({
    planId: '912',
    oldBasename: '0912-SOL-Other-foo.md',
    newBasename: '0912-FABLE-Other-foo.md',
    branchMap: new Map([['912', [{ name: paddedOld, sha: SHA, fresh: false }]]]),
    lsRemote: (_dir, refs) => (patterns.push(...refs), rawHeads([{ name: paddedOld }])),
  });
  assert.equal(result.action, 'rename');
  assert.equal(result.destination.name, paddedNew);
  assert.ok(patterns.includes('refs/heads/worktree-0912-*'));
  assert.ok(patterns.includes('refs/heads/worktree-912-*'));
});

for (const [field, message] of [
  ['fresh', /oracle reports it live.*stamp after that session lands/s],
  ['livenessUnknown', /liveness probe failed.*stamp after that session lands/s],
]) {
  test(`3919 677b37: lone ${field} source is hands-off`, () => {
    assert.throws(() => planner({ entries: [{ name: OLD, sha: SHA, [field]: true }] }), message);
  });
}

test('3919 677b37: lone explicitly dead source still proceeds', () => {
  assert.equal(
    planner({ entries: [{ name: OLD, sha: SHA, fresh: false, livenessUnknown: false }] }).result
      .action,
    'rename',
  );
});

test('3919 c9d9f4: raw/oracle sha disagreement is unknown liveness and refuses', () => {
  assert.throws(
    () =>
      planner({
        branchMap: new Map([['1000', [{ name: OLD, sha: 'oracle111', fresh: false }]]]),
        lsRemote: () => rawHeads([{ name: OLD, sha: 'origin222' }]),
      }),
    /origin moved under the oracle snapshot.*oracle111.*origin222/s,
  );
});

test('3919: projected adoptBranch cannot become ambiguous from a lane re-stamp alone', () => {
  const { result } = planner({
    applyAdopt: (body, names) => {
      assert.deepEqual(names, [NEW]);
      return applyAdoptBranchStamp(body, names);
    },
  });
  assert.ok(['stamped', 'noop'].includes(result.adoptAction));
  assert.notEqual(result.adoptAction, 'ambiguous');
});

test('3919: a foreign held claim refuses before the raw origin read', () => {
  let reads = 0;
  assert.throws(
    () =>
      planner({
        lsRemote: () => (reads++, ''),
        claimStatus: () => ({
          held: true,
          holder: { sessionUuid: 'session-77', host: 'cloud-a' },
        }),
      }),
    /HELD by session-77 on cloud-a/,
  );
  assert.equal(reads, 0);
});

test('3919: a self-held claim proceeds', () => {
  const { result } = planner({
    claimStatus: () => ({ held: true, youAreHolder: true }),
  });
  assert.equal(result.action, 'rename');
});

test('3919: a raw ref missing from the oracle map refuses with unknown liveness', () => {
  assert.throws(
    () =>
      planner({
        branchMap: new Map([['1000', []]]),
        lsRemote: () => rawHeads([{ name: OLD }]),
      }),
    new RegExp(`${OLD}.*liveness is UNKNOWN`, 's'),
  );
});

test('3919: execution-branch namespace is preserved in both directions', () => {
  const drainOld = 'claude/drain-1000-SOL-Other-foo';
  const drainNew = 'claude/drain-1000-FABLE-Other-foo';
  assert.equal(
    planner({ entries: [{ name: drainOld, sha: SHA, fresh: false }] }).result.destination.name,
    drainNew,
  );
  assert.equal(planner().result.destination.name, NEW);
});

test('3919: mixed old and new namespaces refuse and name both refs', () => {
  const drainOld = 'claude/drain-1000-SOL-Other-foo';
  assert.throws(
    () =>
      planner({
        entries: [
          { name: drainOld, sha: SHA, fresh: false },
          { name: NEW, sha: SHA, fresh: false },
        ],
      }),
    new RegExp(`${drainOld}.*${NEW}`, 's'),
  );
});

test('3919: divergent branch tips refuse and name each ref with its sha', () => {
  assert.throws(
    () =>
      planner({
        entries: [
          { name: OLD, sha: 'aaa111', fresh: false },
          { name: NEW, sha: 'bbb222', fresh: false },
        ],
      }),
    new RegExp(`${OLD}@aaa111.*${NEW}@bbb222`, 's'),
  );
});

test('3919: an unexpected third slug refuses and names every raw ref', () => {
  const third = 'worktree-1000-Other-surprise';
  const entries = [
    { name: OLD, sha: 'aaa111', fresh: false },
    { name: third, sha: 'bbb222', fresh: false },
  ];
  assert.throws(() => planner({ entries }), new RegExp(`${OLD}@aaa111.*${third}@bbb222`, 's'));
});

test('3919 R4: multi-ref refusal reports every ref and never offers to delete destination', () => {
  const drainNew = 'claude/drain-1000-FABLE-Other-foo';
  assert.throws(
    () =>
      planner({
        entries: [
          { name: NEW, sha: SHA, fresh: false },
          { name: drainNew, sha: SHA, fresh: false },
        ],
        collapse: (list) => ({ branches: list, duplicates: [] }),
      }),
    (error) => {
      assert.match(error.message, new RegExp(`Refs involved: ${NEW}@${SHA}, ${drainNew}@${SHA}`));
      assert.match(error.message, new RegExp(`origin :refs/heads/${NEW}`));
      assert.doesNotMatch(error.message, new RegExp(`origin :refs/heads/${drainNew}`));
      return true;
    },
  );
});

test('3919: zero refs plans no rename and strips stale adoptBranch', () => {
  const body = DEFAULT_BODY.replace('seedWrite: false', `seedWrite: false\nadoptBranch: ${OLD}`);
  const { result } = planner({ entries: [], body });
  assert.equal(result.action, 'none');
  assert.equal(result.adoptAction, 'stripped');
  assert.equal(result.adoptBranch, OLD);
});

test('3919: already-new re-entry names the destination and has no sources', () => {
  const { result } = planner({ entries: [{ name: NEW, sha: SHA, fresh: false }] });
  assert.equal(result.action, 'already-new');
  assert.deepEqual(result.sourceRefs, []);
  assert.deepEqual(result.destination, { name: NEW, sha: SHA });
});

test('3919: same-sha old and new refs plan finish-delete re-entry', () => {
  const { result } = planner({
    entries: [
      { name: OLD, sha: SHA, fresh: false },
      { name: NEW, sha: SHA, fresh: false },
    ],
  });
  assert.equal(result.action, 'finish-delete');
});

test('3919: an id-less legacy basename reads neither claims nor origin', () => {
  let claims = 0;
  let reads = 0;
  const { result } = planner({
    planId: null,
    oldBasename: '2024-legacy.md',
    newBasename: '2024-FABLE-legacy.md',
    claimStatus: () => claims++,
    lsRemote: () => reads++,
  });
  assert.equal(result.action, 'noop-idless');
  assert.equal(claims, 0);
  assert.equal(reads, 0);
});

test('3919: applier copy uses git empty-value must-not-exist lease', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => rawHeads([{ name: OLD }]),
    gitImpl: (_dir, args) => calls.push(args),
  });
  assert.deepEqual(calls.slice(0, 2), [
    ['cat-file', '-e', `${SHA}^{commit}`],
    ['push', `--force-with-lease=refs/heads/${NEW}:`, 'origin', `${SHA}:refs/heads/${NEW}`],
  ]);
});

test('3919 c9c112: absent local object fetches source and verifies FETCH_HEAD before copy', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => rawHeads([{ name: OLD }]),
    gitImpl: (_dir, args) => {
      calls.push(args);
      if (args[0] === 'cat-file') throw new Error('missing');
      return args[0] === 'rev-parse' ? `${SHA}\n` : '';
    },
  });
  assert.deepEqual(calls.slice(0, 4), [
    ['cat-file', '-e', `${SHA}^{commit}`],
    ['fetch', 'origin', `refs/heads/${OLD}`],
    ['rev-parse', 'FETCH_HEAD'],
    ['push', `--force-with-lease=refs/heads/${NEW}:`, 'origin', `${SHA}:refs/heads/${NEW}`],
  ]);
});

test('3919 c9c112: fetched source mismatch refuses before every push', () => {
  let pushes = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        lsRemote: () => rawHeads([{ name: OLD }]),
        gitImpl: (_dir, args) => {
          if (args[0] === 'push') pushes++;
          if (args[0] === 'cat-file') throw new Error('missing');
          return args[0] === 'rev-parse' ? 'moved999\n' : '';
        },
      }),
    /expected abc1234.*fetched moved999/s,
  );
  assert.equal(pushes, 0);
});

test('3919 382d79: foreign claim acquired after planning refuses before every push', () => {
  let pushes = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        claimStatus: () => ({ held: true, holder: { sessionUuid: 'late-session' } }),
        lsRemote: () => rawHeads([{ name: OLD }]),
        gitImpl: () => pushes++,
      }),
    /HELD by late-session/,
  );
  assert.equal(pushes, 0);
});

for (const action of ['none', 'already-new']) {
  test(`3919 round 2: durable non-mutating ${action} ignores a late foreign claim`, () => {
    let claims = 0;
    assert.doesNotThrow(() =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan({ action }),
        claimStatus: () => (claims++, { held: true, holder: { sessionUuid: 'late-session' } }),
        lsRemote: () => (action === 'already-new' ? rawHeads([{ name: NEW }]) : ''),
        gitImpl: () => assert.fail('must not mutate'),
      }),
    );
    assert.equal(claims, 0);
  });
}

test('3919 round 2: destination already present performs no object fetch', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan({ action: 'finish-delete' }),
    claimStatus: () => ({ held: false }),
    lsRemote: () => rawHeads([{ name: OLD }, { name: NEW }]),
    gitImpl: (_dir, args) => calls.push(args),
  });
  assert.deepEqual(calls, [
    [
      'push',
      '--atomic',
      `--force-with-lease=refs/heads/${OLD}:${SHA}`,
      `--force-with-lease=refs/heads/${NEW}:${SHA}`,
      'origin',
      `:refs/heads/${OLD}`,
      `${SHA}:refs/heads/${NEW}`,
    ],
  ]);
});

test('3919 round 2: local source object skips fetch but retains the empty-value lease', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    claimStatus: () => ({ held: false }),
    lsRemote: () => rawHeads([{ name: OLD }]),
    gitImpl: (_dir, args) => calls.push(args),
  });
  assert.deepEqual(calls.slice(0, 2), [
    ['cat-file', '-e', `${SHA}^{commit}`],
    ['push', `--force-with-lease=refs/heads/${NEW}:`, 'origin', `${SHA}:refs/heads/${NEW}`],
  ]);
});

test('3919 round 2: missing local source fetches and verifies before leased copy', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    claimStatus: () => ({ held: false }),
    lsRemote: () => rawHeads([{ name: OLD }]),
    gitImpl: (_dir, args) => {
      calls.push(args);
      if (args[0] === 'cat-file') throw new Error('missing');
      if (args[0] === 'rev-parse') return `${SHA}\n`;
      return '';
    },
  });
  assert.deepEqual(calls.slice(0, 4), [
    ['cat-file', '-e', `${SHA}^{commit}`],
    ['fetch', 'origin', `refs/heads/${OLD}`],
    ['rev-parse', 'FETCH_HEAD'],
    ['push', `--force-with-lease=refs/heads/${NEW}:`, 'origin', `${SHA}:refs/heads/${NEW}`],
  ]);
});

for (const [label, objectIsLocal] of [
  ['local-object', true],
  ['fetched', false],
]) {
  test(`3919 round 3 finding 434/436/440: ${label} copy refuses a last-moment source move`, () => {
    let reads = 0;
    let pushes = 0;
    assert.throws(
      () =>
        applyExecutionBranchRename({
          mainDir: '/fixture',
          plan: renamePlan(),
          lsRemote: () =>
            reads++ === 0 ? rawHeads([{ name: OLD }]) : rawHeads([{ name: OLD, sha: 'moved999' }]),
          gitImpl: (_dir, args) => {
            if (args[0] === 'cat-file' && !objectIsLocal) throw new Error('missing');
            if (args[0] === 'rev-parse') return `${SHA}\n`;
            if (args[0] === 'push') pushes++;
            return '';
          },
        }),
      new RegExp(`${OLD}.*expected ${SHA}.*moved999`, 's'),
    );
    assert.equal(pushes, 0);
  });
}

test('3919 round 3 finding 434/436/440: unchanged source is re-read and copied', () => {
  let reads = 0;
  let copies = 0;
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => (reads++, rawHeads([{ name: OLD }])),
    gitImpl: (_dir, args) => {
      if (args.at(-1) === `${SHA}:refs/heads/${NEW}` && !args.includes('--atomic')) copies++;
      return '';
    },
  });
  assert.equal(reads, 2);
  assert.equal(copies, 1);
});

test('3919 R4: final pre-copy read refuses an unexpected ref without copying', () => {
  const surprise = 'worktree-1000-Other-surprise';
  let reads = 0;
  let copies = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan({ expectedRefs: [OLD, NEW] }),
        lsRemote: () =>
          reads++ === 0 ? rawHeads([{ name: OLD }]) : rawHeads([{ name: OLD }, { name: surprise }]),
        gitImpl: (_dir, args) => {
          if (args.at(-1) === `${SHA}:refs/heads/${NEW}` && !args.includes('--atomic')) copies++;
          return '';
        },
      }),
    new RegExp(`final pre-copy read.*${surprise}.*nothing was copied`, 's'),
  );
  assert.equal(copies, 0);
});

test('3919 round 2: fetch failure uses the classified copy refusal and never pushes', () => {
  let pushes = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        claimStatus: () => ({ held: false }),
        lsRemote: () => rawHeads([{ name: OLD }]),
        gitImpl: (_dir, args) => {
          if (args[0] === 'cat-file') throw new Error('missing');
          if (args[0] === 'fetch') throw new Error('fetch offline');
          if (args[0] === 'push') pushes++;
          return '';
        },
      }),
    new RegExp(`refusing to copy.*${NEW}.*fetch offline.*source ref.*not retired`, 's'),
  );
  assert.equal(pushes, 0);
});

test('3919 round 2: copy failure re-read names a source that moved', () => {
  let reads = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        claimStatus: () => ({ held: false }),
        lsRemote: () =>
          reads++ === 0 ? rawHeads([{ name: OLD }]) : rawHeads([{ name: OLD, sha: 'moved999' }]),
        gitImpl: (_dir, args) => {
          if (args[0] === 'push' && args.at(-1) === `${SHA}:refs/heads/${NEW}`)
            throw new Error('network down');
          return '';
        },
      }),
    new RegExp(`${OLD}.*expected ${SHA}.*moved999`, 's'),
  );
});

for (const [label, reread, pattern, deleteExpected] of [
  ['accepted before reply died', [{ name: OLD }, { name: NEW }], /renamed/s, true],
  ['lost destination lease', [{ name: OLD }, { name: NEW, sha: 'winner999' }], /winner999/s, false],
  ['transport failure before landing', [{ name: OLD }], /network down/s, false],
]) {
  test(`3919 7e461b: copy failure classification — ${label}`, () => {
    let reads = 0;
    let deletes = 0;
    const invoke = () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        lsRemote: () => (reads++ === 0 ? rawHeads([{ name: OLD }]) : rawHeads(reread)),
        gitImpl: (_dir, args) => {
          if (args[0] === 'rev-parse') return `${SHA}\n`;
          if (args.at(-1) === `${SHA}:refs/heads/${NEW}` && !args.includes('--atomic'))
            throw new Error('network down');
          if (args.includes(`:refs/heads/${OLD}`)) deletes++;
          return '';
        },
      });
    if (deleteExpected) assert.match(invoke().action, pattern);
    else assert.throws(invoke, pattern);
    assert.equal(deletes, deleteExpected ? 1 : 0);
  });
}

test('3919 round 3 finding 472: copy recovery accepts a completed rename', () => {
  let reads = 0;
  let pushes = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => {
      reads++;
      if (reads < 3) return rawHeads([{ name: OLD }]);
      return rawHeads([{ name: NEW }]);
    },
    gitImpl: (_dir, args) => {
      if (args[0] === 'push') {
        pushes++;
        throw new Error('reply lost');
      }
      return '';
    },
  });
  assert.equal(result.action, 'renamed');
  assert.equal(pushes, 1);
});

test('3919 7e461b: copy failure plus failed re-read reports unknown outcome', () => {
  let reads = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        lsRemote: () => {
          if (reads++ === 0) return rawHeads([{ name: OLD }]);
          throw new Error('read unavailable');
        },
        gitImpl: (_dir, args) => {
          if (args[0] === 'rev-parse') return `${SHA}\n`;
          if (args[0] === 'push') throw new Error('network down');
          return '';
        },
      }),
    /outcome is unknown.*read unavailable/s,
  );
});

test('3919: a failed copy still never deletes its source when destination stays absent', () => {
  const calls = [];
  let reads = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        lsRemote: () => (reads++, rawHeads([{ name: OLD }])),
        gitImpl: (_dir, args) => {
          calls.push(args);
          if (args[0] === 'push') assert.fail('lease refused');
        },
      }),
    /destination is still absent.*lease refused/s,
  );
  assert.deepEqual(calls, [
    ['cat-file', '-e', `${SHA}^{commit}`],
    ['push', `--force-with-lease=refs/heads/${NEW}:`, 'origin', `${SHA}:refs/heads/${NEW}`],
  ]);
  assert.equal(reads, 3);
});

for (const [label, entries, pattern] of [
  ['moved', [{ name: OLD, sha: 'moved999' }], /expected abc1234.*moved999/s],
  ['vanished', [], /expected abc1234.*no ref/s],
]) {
  test(`3919: a source that ${label} between plan and apply refuses before push`, () => {
    let pushes = 0;
    assert.throws(
      () =>
        applyExecutionBranchRename({
          mainDir: '/fixture',
          plan: renamePlan(),
          lsRemote: () => rawHeads(entries),
          gitImpl: () => pushes++,
        }),
      pattern,
    );
    assert.equal(pushes, 0);
  });
}

test('3919: a divergent destination collision refuses before push', () => {
  let pushes = 0;
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan(),
        lsRemote: () => rawHeads([{ name: OLD }, { name: NEW, sha: 'other999' }]),
        gitImpl: () => pushes++,
      }),
    new RegExp(`${NEW}.*other999.*nothing was overwritten`, 's'),
  );
  assert.equal(pushes, 0);
});

test('3919 6f7056: mutating apply refuses an unexpected ref that appeared after preflight', () => {
  let pushes = 0;
  const surprise = 'worktree-1000-Other-surprise';
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture',
        plan: renamePlan({ expectedRefs: [OLD, NEW] }),
        lsRemote: () => rawHeads([{ name: OLD }, { name: surprise }]),
        gitImpl: () => pushes++,
      }),
    new RegExp(`unexpected execution ref.*${surprise}`, 's'),
  );
  assert.equal(pushes, 0);
});

test('3919: destination already at the planned sha skips copy and deletes source', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan({ action: 'finish-delete' }),
    lsRemote: () => rawHeads([{ name: OLD }, { name: NEW }]),
    gitImpl: (_dir, args) => calls.push(args),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`:refs/heads/${OLD}`));
});

test('3919: denied delete degrades to a loud successful same-sha leftover', () => {
  const calls = [];
  const logs = [];
  let reads = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () =>
      reads++ === 0 ? rawHeads([{ name: OLD }]) : rawHeads([{ name: OLD }, { name: NEW }]),
    gitImpl: (_dir, args) => {
      calls.push(args);
      if (args.includes(`:refs/heads/${OLD}`)) throw new Error('delete denied');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.action, 'renamed-leftover');
  assert.deepEqual(result.leftovers, [OLD]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`WARNING.*${OLD}`));
});

test('3919: divergent delete leftover is named as a human call', () => {
  const logs = [];
  let reads = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () =>
      reads++ < 2
        ? rawHeads([{ name: OLD }])
        : rawHeads([{ name: OLD, sha: 'moved999' }, { name: NEW }]),
    gitImpl: (_dir, args) => {
      if (args.includes(`:refs/heads/${OLD}`)) throw new Error('delete denied');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.action, 'renamed-leftover-divergent');
  assert.deepEqual(result.leftovers, [OLD]);
  assert.match(logs[0], /human call/);
});

test('3919: failed delete followed by a missing source counts as renamed', () => {
  let reads = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => (reads++ < 2 ? rawHeads([{ name: OLD }]) : rawHeads([{ name: NEW }])),
    gitImpl: (_dir, args) => {
      if (args.includes(`:refs/heads/${OLD}`)) throw new Error('reply lost');
    },
    log: () => assert.fail('gone is not a warning'),
  });
  assert.equal(result.action, 'renamed');
  assert.deepEqual(result.leftovers, []);
});

test('3919 round 3 finding 527: failed delete with both refs gone is divergent or unknown', () => {
  const logs = [];
  let reads = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => {
      reads++;
      return reads < 3 ? rawHeads([{ name: OLD }]) : '';
    },
    gitImpl: (_dir, args) => {
      if (args.includes(`:refs/heads/${OLD}`)) throw new Error('reply lost');
      return '';
    },
    log: (line) => logs.push(line),
  });
  assert.ok(['renamed-leftover-divergent', 'renamed-leftover-unknown'].includes(result.action));
  assert.notEqual(result.action, 'renamed');
  assert.match(logs.join('\n'), /missing|unknown|human call/i);
});

test('3919 round 3 finding 137: recovery uses mainDir and deletes every source ref', () => {
  const secondOld = 'claude/drain-1000-SOL-Other-foo';
  const plan = renamePlan({
    sourceRefs: [
      { name: OLD, sha: SHA },
      { name: secondOld, sha: SHA },
    ],
  });
  assert.throws(
    () =>
      applyExecutionBranchRename({
        mainDir: '/fixture checkout',
        plan,
        lsRemote: () => rawHeads([{ name: OLD }, { name: secondOld, sha: 'moved999' }]),
        gitImpl: () => assert.fail('must not mutate'),
      }),
    (error) => {
      assert.match(error.message, /git -C "\/fixture checkout" push/);
      assert.match(error.message, new RegExp(`:refs/heads/${OLD}`));
      assert.match(error.message, new RegExp(`:refs/heads/${secondOld}`));
      return true;
    },
  );
});

test('3919: failed delete plus failed re-read reports unknown leftover', () => {
  const logs = [];
  let reads = 0;
  const result = applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan(),
    lsRemote: () => {
      if (reads++ < 2) return rawHeads([{ name: OLD }]);
      throw new Error('origin unavailable');
    },
    gitImpl: (_dir, args) => {
      if (args.includes(`:refs/heads/${OLD}`)) throw new Error('delete denied');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.action, 'renamed-leftover-unknown');
  assert.deepEqual(result.leftovers, [OLD]);
  assert.match(logs[0], /could not be re-read/);
});

test('3919: source delete is leased to the observed sha', () => {
  const calls = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan({ action: 'finish-delete' }),
    lsRemote: () => rawHeads([{ name: OLD }, { name: NEW }]),
    gitImpl: (_dir, args) => calls.push(args),
  });
  assert.deepEqual(calls[0], [
    'push',
    '--atomic',
    `--force-with-lease=refs/heads/${OLD}:${SHA}`,
    `--force-with-lease=refs/heads/${NEW}:${SHA}`,
    'origin',
    `:refs/heads/${OLD}`,
    `${SHA}:refs/heads/${NEW}`,
  ]);
});

for (const action of ['none', 'already-new', 'noop-idless']) {
  test(`3919: non-mutating ${action} plan validates origin without pushes`, () => {
    let reads = 0;
    let pushes = 0;
    const result = applyExecutionBranchRename({
      mainDir: '/fixture',
      plan: renamePlan({ action }),
      lsRemote: () => reads++,
      gitImpl: () => pushes++,
    });
    assert.equal(result.mutated, false);
    assert.equal(reads, action === 'noop-idless' ? 0 : 1);
    assert.equal(pushes, 0);
  });
}

test('3919 6f7056: already-new warns when stamped destination vanished', () => {
  const logs = [];
  assert.doesNotThrow(() =>
    applyExecutionBranchRename({
      mainDir: '/fixture',
      plan: renamePlan({ action: 'already-new', sourceRefs: [] }),
      lsRemote: () => '',
      gitImpl: () => assert.fail('must not mutate'),
      log: (line) => logs.push(line),
    }),
  );
  assert.match(
    logs.join('\n'),
    new RegExp(`WARNING.*${NEW}.*origin now carries.*plan-adopt-branch.mjs 1000`, 's'),
  );
});

test('3919 6f7056: none warns when an execution branch appeared after preflight', () => {
  const logs = [];
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan({ action: 'none', sourceRefs: [], destination: null, adoptBranch: null }),
    lsRemote: () => rawHeads([{ name: OLD }]),
    gitImpl: () => assert.fail('must not mutate'),
    log: (line) => logs.push(line),
  });
  assert.match(logs.join('\n'), new RegExp(`WARNING.*${OLD}.*plan-adopt-branch.mjs 1000`, 's'));
});

test('3919 6f7056: noop-idless remains a pure no-op', () => {
  let reads = 0;
  applyExecutionBranchRename({
    mainDir: '/fixture',
    plan: renamePlan({ action: 'noop-idless', planId: null }),
    lsRemote: () => reads++,
    gitImpl: () => assert.fail('must not mutate'),
  });
  assert.equal(reads, 0);
});

function writeSpineHarness(repo, mode) {
  // Written BESIDE the copied stamp-lib.mjs (plan 3962 Phase 2 moved it to scripts/coord/),
  // because the harness source below imports it with a bare './stamp-lib.mjs'.
  const harness = join(dirname(repo.toolPath('stamp-lib.mjs')), 'stamp-spine-3919-harness.mjs');
  writeFileSync(
    harness,
    [
      "import { execFileSync } from 'node:child_process';",
      "import { stampFrontmatterAxis } from './stamp-lib.mjs';",
      'const mode = process.argv[2];',
      'try {',
      '  await stampFrontmatterAxis({',
      "    tool: 'stamp-spine-3919', idOrName: '1000', dry: mode === 'dry',",
      "    renameFor: (name) => ['mutatefail', 'pushreject'].includes(mode) ? name.replace('1000-', '1000-FABLE-') : name, regenIndex: false,",
      '    preflight: () => {},',
      "    mutateBody: (body) => { if (mode === 'mutatefail') throw new Error('MUTATE_FAILED'); return body.replace('seedWrite: false', 'seedWrite: false\\nexecModel: fable'); },",
      "    commitSubject: () => 'docs(plans): spine fixture',",
      "    dryPreview: () => ['[dry] spine fixture'],",
      '    postPush: (_ctx, result) => {',
      "      const head = execFileSync('git', ['rev-parse', 'origin/master'], { encoding: 'utf8' }).trim();",
      "      const local = execFileSync('git', ['-C', process.env.COORD_MAIN_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
      "      const body = execFileSync('git', ['show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md'], { encoding: 'utf8' });",
      "      console.error('ORDER:commit=' + local + ',push=' + head + ',postPush=' + result.pushed + ',stamped=' + /execModel: fable/.test(body));",
      "      if (mode === 'postthrow') throw new Error('POST_PUSH_SENTINEL');",
      '    },',
      '  });',
      '} catch (error) {',
      "  console.error('CAUGHT:' + error.message + ':nonFastForward=' + String(error.nonFastForward));",
      '  process.exitCode = 1;',
      '}',
      '',
    ].join('\n'),
  );
  return harness;
}

test('3919: postPush runs once after commit and master push, and never on dry', () => {
  const repo = makeIsolatedRepo();
  try {
    const harness = writeSpineHarness(repo);
    const dry = runStamp(repo.dir, ['dry'], harness);
    assert.equal(dry.code, 0);
    assert.doesNotMatch(dry.stderr, /ORDER:/);
    assert.equal(repo.g('rev-list', '--count', 'origin/master').trim(), '1');

    const real = runStamp(repo.dir, ['ok'], harness);
    assert.equal(real.code, 0, real.stderr);
    const order = real.stderr.match(
      /ORDER:commit=([^,]+),push=([^,]+),postPush=true,stamped=true/g,
    );
    assert.equal(order?.length, 1);
    assert.equal(order[0].match(/commit=([^,]+)/)[1], order[0].match(/push=([^,]+)/)[1]);
  } finally {
    repo.cleanup();
  }
});

test('3919: postPush failure preserves the pushed stamp and propagates unchanged', () => {
  const repo = makeIsolatedRepo();
  try {
    const harness = writeSpineHarness(repo);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runStamp(repo.dir, ['postthrow'], harness);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CAUGHT:POST_PUSH_SENTINEL:nonFastForward=undefined/);
    const after = repo.g('rev-parse', 'origin/master').trim();
    assert.notEqual(after, before);
    assert.match(
      repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md'),
      /^execModel: fable$/m,
    );
  } finally {
    repo.cleanup();
  }
});

test('3919: a rejected master push rolls back local bytes, rename, and commit', () => {
  const repo = makeIsolatedRepo();
  try {
    const harness = writeSpineHarness(repo);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const original = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    const hook = join(repo.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho PUSH_REJECTED >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const res = runStamp(repo.dir, ['pushreject'], harness);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CAUGHT:coord-git: push .*rejected after \d+ attempts/i);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
    assert.doesNotMatch(
      repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md'),
      /execModel:/,
    );
    const coord = join(repo.dir, '.claude', 'coord-worktree');
    const oldPlan = join(coord, 'docs/superpowers/plans/ready/1000-Other-foo.md');
    const renamedPlan = join(coord, 'docs/superpowers/plans/ready/1000-FABLE-Other-foo.md');
    assert.equal(readFileSync(oldPlan, 'utf8'), original);
    assert.equal(existsSync(renamedPlan), false);
    assert.equal(repo.g('-C', coord, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(repo.g('-C', coord, 'status', '--short'), '');
  } finally {
    repo.cleanup();
  }
});

test('3919: a pre-commit body failure rolls back local bytes and rename without retrying', () => {
  const repo = makeIsolatedRepo();
  try {
    const harness = writeSpineHarness(repo);
    const before = repo.g('rev-parse', 'origin/master').trim();
    const original = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    const res = runStamp(repo.dir, ['mutatefail'], harness);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /CAUGHT:MUTATE_FAILED:nonFastForward=undefined/);
    assert.equal((res.stderr.match(/CAUGHT:/g) || []).length, 1);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
    const coord = join(repo.dir, '.claude', 'coord-worktree');
    const oldPlan = join(coord, 'docs/superpowers/plans/ready/1000-Other-foo.md');
    const renamedPlan = join(coord, 'docs/superpowers/plans/ready/1000-FABLE-Other-foo.md');
    assert.equal(readFileSync(oldPlan, 'utf8'), original);
    assert.equal(existsSync(renamedPlan), false);
    assert.equal(repo.g('-C', coord, 'rev-parse', 'HEAD').trim(), before);
    assert.equal(repo.g('-C', coord, 'status', '--short'), '');
  } finally {
    repo.cleanup();
  }
});

test('3919: CLI dry run reads execution refs but changes neither plan, commit, nor refs', () => {
  const body = DEFAULT_BODY.replace(
    'seedWrite: false',
    `seedWrite: false\nexecModel: sol\nadoptBranch: ${OLD}`,
  );
  const repo = makeIsolatedRepo({ basename: oldBase, body });
  try {
    // A commit of its own makes this a finished execution branch, not a fresh firing marker.
    repo.g('checkout', '-q', '-b', OLD);
    repo.g('commit', '-q', '--allow-empty', '-m', 'finished execution fixture');
    repo.g('push', '-q', 'origin', `${OLD}:${OLD}`);
    repo.g('checkout', '-q', 'master');
    const beforeMaster = repo.g('rev-parse', 'origin/master').trim();
    const beforeRef = repo.g('rev-parse', `origin/${OLD}`).trim();
    const res = runStamp(repo.dir, ['1000', 'fable', '--dry'], repo.stampExecModel);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /lease-copy/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), beforeMaster);
    assert.equal(repo.g('ls-remote', '--heads', 'origin', OLD).split(/\s/u)[0], beforeRef);
    assert.equal(repo.g('show', `origin/master:${repo.srcRel}`), body);
  } finally {
    repo.cleanup();
  }
});

test('3919: CLI stamp renames plan and leaves one matching renamed execution branch', () => {
  const body = DEFAULT_BODY.replace(
    'seedWrite: false',
    `seedWrite: false\nexecModel: sol\nadoptBranch: ${OLD}`,
  );
  const repo = makeIsolatedRepo({ basename: oldBase, body });
  try {
    repo.g('checkout', '-q', '-b', OLD);
    repo.g('commit', '-q', '--allow-empty', '-m', 'finished execution fixture');
    repo.g('push', '-q', 'origin', `${OLD}:${OLD}`);
    repo.g('checkout', '-q', 'master');
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `stdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', '--prune', 'origin');
    const heads = repo.g('ls-remote', '--heads', 'origin', '*1000-*').trim().split('\n');
    assert.equal(heads.length, 1);
    assert.match(heads[0], new RegExp(`refs/heads/${NEW}$`));
    const stamped = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.match(stamped, /^execModel: fable$/m);
    assert.match(stamped, new RegExp(`^adoptBranch: ${NEW}$`, 'm'));
  } finally {
    repo.cleanup();
  }
});
test('stamp-exec-model: stamping fable renames the file and sets execModel: fable', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-FABLE-Other-foo\.md/, 'plan should be renamed on origin');
    assert.doesNotMatch(tree, /ready\/1000-Other-foo\.md$/m, 'the old basename must be gone');
    const newBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.match(newBody, /^execModel: fable$/m);
    // other frontmatter keys preserved
    assert.match(newBody, /^summary: Test plan for stamp-exec-model$/m);
    assert.match(newBody, /^seedWrite: false$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: stamping sonnet on a FABLE- file removes the segment and sets execModel: sonnet', () => {
  const FABLE_BODY = DEFAULT_BODY.replace(
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\n---',
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ basename: '1000-FABLE-Other-foo.md', body: FABLE_BODY });
  try {
    const res = runStamp(repo.dir, ['1000', 'sonnet'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-Other-foo\.md$/m, 'plan should be renamed back on origin');
    assert.doesNotMatch(tree, /FABLE/, 'no FABLE- basename should survive');
    const newBody = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(newBody, /^execModel: sonnet$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: stamping sol renames the file and sets execModel: sol (plan 3341)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'sol'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-SOL-Other-foo\.md/, 'plan should be renamed on origin');
    assert.doesNotMatch(tree, /ready\/1000-Other-foo\.md$/m, 'the old basename must be gone');
    const newBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-SOL-Other-foo.md',
    );
    assert.match(newBody, /^execModel: sol$/m);
    // other frontmatter keys preserved
    assert.match(newBody, /^summary: Test plan for stamp-exec-model$/m);
    assert.match(newBody, /^seedWrite: false$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: stamping sol on a FABLE- file swaps the marker (mutually exclusive, plan 3341)', () => {
  const FABLE_BODY = DEFAULT_BODY.replace(
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\n---',
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ basename: '1000-FABLE-Other-foo.md', body: FABLE_BODY });
  try {
    const res = runStamp(repo.dir, ['1000', 'sol'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-SOL-Other-foo\.md$/m, 'plan should carry the SOL- marker');
    assert.doesNotMatch(tree, /FABLE/, 'no FABLE- basename should survive the swap');
    const newBody = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-SOL-Other-foo.md',
    );
    assert.match(newBody, /^execModel: sol$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: --spec-review stamps specReview + flips stage: specced', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^execModel: sonnet$/m);
    assert.match(body, /^specReview: a1b2c3d$/m);
    assert.match(body, /^stage: specced$/m);
  } finally {
    repo.cleanup();
  }
});

// ── plan 2973: cloudExec-unstamped WARN after a successful stamp ────────────
// DEFAULT_BODY carries no `cloudExec:` key, so the two happy-path tests above already
// exercise the warn incidentally; these pin the warning text, the silent case, and the
// --dry no-op explicitly.

test('stamp-exec-model: a successful stamp on a cloudExec-less plan emits ONE stderr warning naming the stamp-cloud-exec command', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /cloudExec: frontmatter key/);
    // Named against the plan's basename AS IT LANDS (post-rename), not the pre-rename one.
    assert.match(res.stderr, /node scripts\/stamp-cloud-exec\.mjs 1000 true /);
    assert.match(
      res.stderr,
      /node scripts\/stamp-cloud-exec\.mjs 1000 false --reason "<why not cloud-safe>"/,
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: a plan already stamped cloudExec: false stamps silently — no warning', () => {
  const BODY = DEFAULT_BODY.replace(
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\n---',
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\ncloudExec: false\n---',
  );
  const repo = makeIsolatedRepo({ body: BODY });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: a plan already stamped cloudExec: true stamps silently — no warning', () => {
  const BODY = DEFAULT_BODY.replace(
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\n---',
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\ncloudExec: true\n---',
  );
  const repo = makeIsolatedRepo({ body: BODY });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: --dry on a cloudExec-less plan emits NO cloudExec warning (mutateBody never runs)', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable', '--dry'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /cloudExec: frontmatter key/);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: refuses in-progress/ and leaves a clean tree, unrenamed', () => {
  const repo = makeIsolatedRepo({ startFolder: 'in-progress' });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to stamp .* in-progress\//);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(
      tree,
      /in-progress\/1000-Other-foo\.md/,
      'plan must remain unrenamed in-progress/',
    );
    assert.doesNotMatch(tree, /FABLE/, 'no rename must have happened');
    assert.equal(
      repo.g('status', '--porcelain', '--untracked-files=no').trim(),
      '',
      'MAIN tracked tree should be untouched',
    );
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: refuses archive/ and leaves a clean tree', () => {
  const repo = makeIsolatedRepo({ startFolder: 'archive' });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.notEqual(res.code, 0, `expected non-zero\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(`${res.stderr}${res.stdout}`, /refusing to stamp .* archive\//);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /archive\/1000-Other-foo\.md/, 'plan must remain unrenamed in archive/');
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: idempotent re-stamp (fable on an already-FABLE file) does not double the segment', () => {
  const FABLE_BODY = DEFAULT_BODY.replace(
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\n---',
    '---\nsummary: Test plan for stamp-exec-model\nseedWrite: false\nexecModel: fable\n---',
  );
  const repo = makeIsolatedRepo({ basename: '1000-FABLE-Other-foo.md', body: FABLE_BODY });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-FABLE-Other-foo\.md/, 'basename should stay single-FABLE-');
    assert.doesNotMatch(tree, /FABLE-FABLE/, 'must never double the segment');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.match(body, /^execModel: fable$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: --dry previews without mutating anything', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable', '--dry'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /\[dry\] set execModel: fable/);
    assert.match(res.stdout, /\[dry\] git mv/);
    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-Other-foo\.md$/m, 'nothing should have moved on origin');
    assert.doesNotMatch(tree, /FABLE/, 'no rename should have landed');
  } finally {
    repo.cleanup();
  }
});

// ───────────────── plan 2892: validate-before-stamp + complete the prose ─────────────────
//
// `--spec-review` is the flag that flips `stage: specced`, and until this plan it did so
// without reading the body. Any body defect the NEXT tool checks then wedged the plan
// between two gates — edit-plan refusing every write (specced-in-pending-approval) and
// move-plan refusing the route-out — each prescribing the other. ≥7 firings,
// 2026-07-30..08-04. The stamp now refuses BEFORE writing (so the plan stays at
// `stage: stub`, where edit-plan still works and the fix menu is executable) and fixes
// the one defect it is itself the authority for.

test('2892: --spec-review rewrites a STUB Status token to the specced form in the same commit', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo({ body: stubProseBody() }));
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: specced$/m);
    // the token is fixed AND the author's remainder survives byte-for-byte
    assert.match(body, /^\*\*Status:\*\* 📋 READY — minted 2026-08-05\.$/m);
    assert.doesNotMatch(body, /STUB/);
  } finally {
    repo.cleanup();
  }
});

test('2892: --spec-review REFUSES a body with no 💰 banner, writing nothing', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody({ noCostBanner: true }) });
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /Cost forecast/);
    assert.match(res.stderr, /NOTHING HAS BEEN WRITTEN/);
    // the whole point: the plan is left at stage: stub, where edit-plan still works.
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: stub$/m);
    assert.doesNotMatch(body, /specReview/);
  } finally {
    repo.cleanup();
  }
});

test('2892: --spec-review REFUSES a body with no SEED-WRITE banner, writing nothing', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody({ noSeedBanner: true }) });
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /SEED-WRITE/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: stub$/m);
  } finally {
    repo.cleanup();
  }
});

test('2892: a plain execModel stamp (no --spec-review) is UNAFFECTED by a non-canonical body', () => {
  // Blast-radius bound: the gate is scoped to the flag that flips the stage. Re-routing an
  // older, banner-less plan between exec models must keep working exactly as before.
  const repo = makeIsolatedRepo({ body: stubProseBody({ noCostBanner: true }) });
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.match(body, /^execModel: fable$/m);
    // untouched: no stage flip, no prose rewrite
    assert.match(body, /^stage: stub$/m);
    assert.match(body, /\*\*Status:\*\* 📋 STUB/);
  } finally {
    repo.cleanup();
  }
});

test('2892: --dry is gated identically to a real stamp (refuses, previews nothing)', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody({ noCostBanner: true }) });
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d', '--dry'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stdout, /\[dry\] set specReview/);
  } finally {
    repo.cleanup();
  }
});

test('2892: completeSpeccedStatusProse rewrites ONLY the STUB token', () => {
  const withToken = (t) => `---\nstage: specced\n---\n\n**Status:** ${t} — note.\n`;
  // the one token a specced stamp invalidates
  assert.match(
    completeSpeccedStatusProse(withToken('📋 STUB')),
    /\*\*Status:\*\* 📋 READY — note\./,
  );
  // legitimate specced pairings are left alone — a specced plan on a trip condition
  // must keep saying so
  for (const t of ['⏳ WAITING-TRIP', '📅 WAITING-DATE', '🔄 IN PROGRESS', '📋 READY']) {
    assert.equal(completeSpeccedStatusProse(withToken(t)), withToken(t), `${t} must survive`);
  }
  // no Status line at all: unchanged (writing one is move-plan's job on promotion)
  const bare = '---\nstage: specced\n---\n\n# T\n';
  assert.equal(completeSpeccedStatusProse(bare), bare);
});

// plan 2892 review round 1 (CONFIRMED): assertStampableStatus permits stamping a plan that
// sits in a waiting lane, and stamp-lib leaves it there. Completing its STUB token to
// READY would advertise a still-waiting plan as takeable to every operator and board tool.
test('2892 R1: the STUB completion is SKIPPED outside the ready-token folders', () => {
  const body = `---\nstage: specced\n---\n\n**Status:** 📋 STUB — minted.\n`;
  for (const status of ['pending-approval', 'ready']) {
    assert.match(
      completeSpeccedStatusProse(body, { status }),
      /📋 READY/,
      `${status} must complete`,
    );
  }
  for (const status of ['waiting-trip', 'waiting-date', 'waiting-blocked', 'waiting-operator']) {
    assert.equal(completeSpeccedStatusProse(body, { status }), body, `${status} must NOT complete`);
  }
});

test('2892 R1: a waiting-lane STUB body is REFUSED rather than silently re-tokened', () => {
  // The completion is skipped there, so Check A sees the (specced, STUB) contradiction and
  // the stamp refuses — leaving a human to write the waiting token that is actually true.
  const body =
    `---\nstage: specced\n---\n\n> 🟩 **${VETAPP_MUTATION_BANNER.label}: no**\n\n` +
    `> 💰 **Cost forecast:** $0 — none.\n\n**Status:** 📋 STUB — minted.\n\n${VERDICT_SECTION}`;
  const kinds = findPromotionBlockers('1000-Other-foo.md', body, { status: 'waiting-trip' }).map(
    (b) => b.kind,
  );
  assert.deepEqual(kinds, ['stage-status-prose']);
});

test('2892: specSpeccedBody is the ONE transform the preflight and the write share', () => {
  // Both call sites go through this function, so "what the gate was shown" and "what the
  // stamp wrote" cannot drift. Asserted structurally: it does both halves at once.
  const out = specSpeccedBody(`---\nstage: stub\n---\n\n**Status:** 📋 STUB — minted.\n`);
  assert.match(out, /^stage: specced$/m);
  assert.match(out, /\*\*Status:\*\* 📋 READY — minted\./);
});

test('2892: findPromotionBlockers reports each missing banner, and nothing on a canonical body', () => {
  const canonical =
    `---\nstage: specced\n---\n\n> 🟩 **${VETAPP_MUTATION_BANNER.label}: no**\n\n` +
    `> 💰 **Cost forecast:** $0 — none.\n\n**Status:** 📋 READY — filed.\n\n${VERDICT_SECTION}`;
  assert.deepEqual(findPromotionBlockers('1000-Other-foo.md', canonical), []);

  const kinds = (c) =>
    findPromotionBlockers('1000-Other-foo.md', c)
      .map((b) => b.kind)
      .sort();
  assert.deepEqual(kinds(canonical.replace(/> 💰 [^\n]*\n/, '')), ['cost-banner']);
  assert.deepEqual(kinds(canonical.replace(/> 🟩 [^\n]*\n/, '')), ['seed-write-banner']);
  // a STUB token that somehow survived the completion still reports — the gate that
  // would refuse the write is asked in advance, not a lookalike of it
  assert.deepEqual(kinds(canonical.replace('📋 READY', '📋 STUB')), ['stage-status-prose']);
});

// ───────────────── plan 3943: a specced stamp requires a written verdict ─────────────────

// The canonical body from the test above, minus the verdict section, used as the base for
// every verdict-blocker case below.
const CANONICAL_NO_VERDICT =
  `---\nstage: specced\n---\n\n> 🟩 **${VETAPP_MUTATION_BANNER.label}: no**\n\n` +
  `> 💰 **Cost forecast:** $0 — none.\n\n**Status:** 📋 READY — filed.\n`;

test('3943: findPromotionBlockers refuses a body with no `## Spec-pass verdict` section at all', () => {
  const kinds = findPromotionBlockers('1000-Other-foo.md', CANONICAL_NO_VERDICT).map((b) => b.kind);
  assert.deepEqual(kinds, ['spec-verdict-missing']);
});

test('3943: findPromotionBlockers names each missing C1-C5/litmus/exit-test token, on an incomplete section', () => {
  const withHeading = `${CANONICAL_NO_VERDICT}\n## Spec-pass verdict (fixture)\n\n- C1: PASS\n`;
  const blockers = findPromotionBlockers('1000-Other-foo.md', withHeading);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'spec-verdict-incomplete');
  // C1 is present and tagged — must not be named as missing — but C2-C5, litmus and
  // exit-test all are.
  assert.doesNotMatch(blockers[0].detail, /`C1`/);
  for (const c of ['C2', 'C3', 'C4', 'C5'])
    assert.match(blockers[0].detail, new RegExp(`\`${c}\``));
  assert.match(blockers[0].detail, /litmus/i);
  assert.match(blockers[0].detail, /exit test/i);
});

test('3943: a check letter mentioned with NO PASS/FAIL/PARTIAL tag on its line still reports that letter missing', () => {
  const section =
    '## Spec-pass verdict (fixture)\n\n' +
    '- C1: PASS\n- C2: PASS\n- C3 needs another look, not yet judged.\n- C4: PASS\n- C5: PASS\n' +
    '- execModel litmus: sonnet.\n- exit test: yes.\n';
  const blockers = findPromotionBlockers(
    '1000-Other-foo.md',
    `${CANONICAL_NO_VERDICT}\n${section}`,
  );
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'spec-verdict-incomplete');
  assert.match(blockers[0].detail, /`C3`/);
  assert.doesNotMatch(blockers[0].detail, /`C1`|`C2`|`C4`|`C5`/);
});

test('3943: a complete verdict section (C1-C5 + litmus + exit test) clears the blocker', () => {
  assert.deepEqual(
    findPromotionBlockers('1000-Other-foo.md', `${CANONICAL_NO_VERDICT}\n${VERDICT_SECTION}`),
    [],
  );
});

test('3943: the verdict section is bounded at the NEXT H2 or EOF — a PASS tag past that boundary does not count', () => {
  const body =
    `${CANONICAL_NO_VERDICT}\n## Spec-pass verdict (fixture)\n\n- C1: PASS\n- C2: PASS\n- C3: PASS\n- C4: PASS\n` +
    `- execModel litmus: sonnet.\n- exit test: yes.\n\n` +
    // C5 only appears AFTER a new H2 — outside the section this verdict owns.
    `## Some other section\n\n- C5: PASS\n`;
  const blockers = findPromotionBlockers('1000-Other-foo.md', body);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'spec-verdict-incomplete');
  assert.match(blockers[0].detail, /`C5`/);
});

test('3943: --spec-review exempt-mechanical skips the verdict check entirely, even with no section at all', () => {
  assert.deepEqual(
    findPromotionBlockers('1000-Other-foo.md', CANONICAL_NO_VERDICT, {
      specReview: 'exempt-mechanical',
    }),
    [],
  );
});

test('3943: the legacy `**Spec-pass verdict**` bold-paragraph marker is still recognized (widened regex)', () => {
  // The paragraph form is a single block of text — the same paragraph carries the marker
  // AND the C1-C5/litmus/exit-test tokens, since there is no H2 to bound a separate section.
  const legacy =
    `${CANONICAL_NO_VERDICT}\n**Spec-pass verdict (fixture):** C1: PASS. C2: PASS. C3: PASS. ` +
    `C4: PASS. C5: PASS. execModel litmus: sonnet. exit test: yes.\n`;
  assert.deepEqual(findPromotionBlockers('1000-Other-foo.md', legacy), []);
});

// --- plan 3943 review round 1 -------------------------------------------------------

test('3943 [review]: a verdict heading inside a FENCED example does not satisfy the blocker', () => {
  // A plan documenting the required shape (this one does, and so does the spec-pass skill)
  // must not thereby satisfy the requirement. The repo already owns a fence-aware heading
  // scanner; a bare `^##` regex was reading the illustration as the real thing.
  const body =
    `${CANONICAL_NO_VERDICT}\nThe stamp now wants a section shaped like this:\n\n` +
    '```md\n' +
    `${VERDICT_SECTION}` +
    '```\n';
  const kinds = findPromotionBlockers('1000-Other-foo.md', body).map((b) => b.kind);
  assert.deepEqual(kinds, ['spec-verdict-missing']);
});

test('3943 [review]: a tag belonging to a LATER check letter on the same line does not satisfy the earlier one', () => {
  // "C3: not judged yet. C4: PASS" must still report C3 — the scan may not reach past the
  // next check letter to borrow its tag.
  const section =
    '## Spec-pass verdict (fixture)\n\n' +
    '- C1: PASS\n- C2: PASS\n- C3: still open, see below. C4: PASS\n- C5: PASS\n' +
    '- execModel litmus: sonnet.\n- exit test: yes.\n';
  const blockers = findPromotionBlockers(
    '1000-Other-foo.md',
    `${CANONICAL_NO_VERDICT}\n${section}`,
  );
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'spec-verdict-incomplete');
  assert.match(blockers[0].detail, /`C3`/);
  assert.doesNotMatch(blockers[0].detail, /`C4`/, 'C4 carries its own tag and is satisfied');
});

test('3943 [review-2]: tokens that exist ONLY inside a fence WITHIN the section do not satisfy it', () => {
  // Round 1 stopped a fenced heading from being read as the section; round 2 is the inner
  // half — a real heading whose C1-C5 tags live only in a ```md illustration under it.
  const body =
    `${CANONICAL_NO_VERDICT}\n## Spec-pass verdict (fixture)\n\nWrite it like this:\n\n` +
    '```md\n- C1: PASS\n- C2: PASS\n- C3: PASS\n- C4: PASS\n- C5: PASS\n' +
    '- execModel litmus: sonnet.\n- exit test: yes.\n```\n';
  const blockers = findPromotionBlockers('1000-Other-foo.md', body);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].kind, 'spec-verdict-incomplete');
  for (const c of ['C1', 'C2', 'C3', 'C4', 'C5'])
    assert.match(blockers[0].detail, new RegExp(`\`${c}\``));
});

test('3943 [review-2]: a SECOND verdict block (a re-verdict) can satisfy the blocker on its own', () => {
  // A plan re-verdicted by a later pass carries two verdict blocks. Checking only the first
  // would refuse a plan whose CURRENT verdict is complete.
  const body = `${CANONICAL_NO_VERDICT}\n**Spec-pass verdict (superseded):** C1: PASS.\n\n${VERDICT_SECTION}`;
  assert.deepEqual(findPromotionBlockers('1000-Other-foo.md', body), []);
});

test('3943 [review]: a real verdict section is still accepted when the plan ALSO shows a fenced example', () => {
  // The companion to the fence test above: fence-awareness must not make a genuine section
  // unreachable just because an illustration appears earlier in the body.
  const body =
    `${CANONICAL_NO_VERDICT}\nShape:\n\n` +
    '```md\n## Spec-pass verdict (illustration only)\n```\n\n' +
    `${VERDICT_SECTION}`;
  assert.deepEqual(findPromotionBlockers('1000-Other-foo.md', body), []);
});

test('3943: end-to-end — --spec-review REFUSES a body with no verdict section, writing nothing', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody({ noVerdict: true }) });
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /Spec-pass verdict/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: stub$/m);
    assert.doesNotMatch(body, /specReview/);
  } finally {
    repo.cleanup();
  }
});

test('3943: end-to-end — --spec-review exempt-mechanical on a body with no verdict section still succeeds', () => {
  const repo = withVetappMutationBanner(
    makeIsolatedRepo({ body: stubProseBody({ noVerdict: true }) }),
  );
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'exempt-mechanical'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: specced$/m);
  } finally {
    repo.cleanup();
  }
});

test('3943: end-to-end — --spec-review with a real verdict section stamps normally', () => {
  // default includes VERDICT_SECTION
  const repo = withVetappMutationBanner(makeIsolatedRepo({ body: stubProseBody() }));
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: specced$/m);
  } finally {
    repo.cleanup();
  }
});

// plan 2892 review round 1 (CONFIRMED): the check must require move-plan's STRICT anchor
// banner, not the loose value parser. A body that merely DISCUSSES the banner passed the
// value parser and then hard-failed the waiting-* move it was cleared for.
test('2892 R1: a prose MENTION of SEED-WRITE does not satisfy the banner check', () => {
  const mentionOnly =
    `---\nstage: specced\n---\n\n# T\n\n${sw('This discusses 🟩 **SEED-WRITE** in passing.')}\n\n` +
    `> 💰 **Cost forecast:** $0 — none.\n\n**Status:** 📋 READY — filed.\n\n${VERDICT_SECTION}`;
  assert.deepEqual(
    findPromotionBlockers('1000-Other-foo.md', mentionOnly).map((b) => b.kind),
    ['seed-write-banner'],
    'the loose value parser accepts this; the anchor regex move-plan uses does not',
  );
  // ...and the canonical banner line does satisfy it.
  assert.deepEqual(
    findPromotionBlockers(
      '1000-Other-foo.md',
      mentionOnly.replace(
        sw('This discusses 🟩 **SEED-WRITE** in passing.'),
        `> 🟩 **${VETAPP_MUTATION_BANNER.label}: no**`,
      ),
    ),
    [],
  );
});

// plan 2892 review rounds 1+2 (CONFIRMED): parseFlags DROPS a value flag given with no
// value, so `--spec-review` without one silently degraded to a plain execModel stamp —
// skipping both the stage flip the operator asked for and the promotability gate. Round 2
// widened this from a bespoke bare-flag argv scan to parseFlags' own `requireValues` mode,
// which also catches the EMPTY and FLAG-SHAPED values the scan missed.
// plan 2892 review rounds 1-3 (CONFIRMED, many angles). Round 1: parseFlags DROPS a value
// flag given no value, so `--spec-review` without one silently degraded to a plain
// execModel stamp. Round 2: swapped to parseFlags' own `requireValues`, which also catches
// the EMPTY value. Round 3: `requireValues` throws BEFORE main()'s `return 2` paths (so a
// usage refusal was exiting 1, which automation may retry), and the flag-shaped guard only
// rejected `--`, letting a single-dash `-d` through as a real `specReview` value.
//
// The pure cases are asserted on argvUsageError directly rather than by building a whole
// isolated repo each (review round 3, efficiency); ONE subprocess case still proves the
// end-to-end exit code and that nothing was stamped.
test('2892 R3: argvUsageError rejects every malformed invocation shape', () => {
  const err = (positionals, specReview) => argvUsageError({ positionals, specReview });
  // flag-shaped values — BOTH dash forms, since parseFlags consumes the next token greedily;
  // whitespace-padded too (gpt-review 3004 finding 1rs7lce: a quoted " -d" is still flag-shaped)
  for (const v of ['--dry', '-d', '-x', '-dry', ' -d', '  --dry']) {
    assert.match(err(['1000', 'sonnet'], v) || '', /got the flag/, `${v} must be rejected`);
  }
  // a stray third positional must not be silently dropped onto the wrong plan
  assert.match(err(['1000', 'sonnet', '1001'], undefined) || '', /unexpected extra argument/);
  // missing operands
  assert.match(err([], undefined) || '', /^usage:/);
  assert.match(err(['1000'], undefined) || '', /^usage:/);
  // well-formed invocations pass
  assert.equal(err(['1000', 'sonnet'], undefined), null);
  assert.equal(err(['1000', 'sonnet'], 'a1b2c3d'), null);
  assert.equal(err(['1000', 'sonnet'], 'exempt-mechanical'), null);
});

// ───────────────── plan 3004: spec-pass provenance (`--provenance` → `specReviewBy:`) ─────────────────
//
// Every spec-pass stamp durably records which model/effort produced it — a self-declared,
// labeled value (the A1 design; a harvested/inferred value would carry true-value confidence
// when wrong). Absent flag → WARN + `specReviewBy: undeclared`, never a refusal: a hard
// refusal would wedge every pre-flag caller, the cloud sweep included, and `undeclared` is
// itself signal (it separates the cloud arm until its routine prompt learns the flag).

test('3004: argvUsageError validates --provenance shape and pairing', () => {
  const err = (specReview, provenance) =>
    argvUsageError({ positionals: ['1000', 'sonnet'], specReview, provenance });
  // flag-shaped value (parseFlags consumes the next token greedily)
  assert.match(err('a1b2c3d', '--dry') || '', /got the flag/);
  assert.match(err('a1b2c3d', '-d') || '', /got the flag/);
  // provenance without a spec-review stamp has nothing to attribute
  assert.match(
    err(undefined, 'fable-5/xhigh') || '',
    /only makes sense together with --spec-review/,
  );
  // exempt-mechanical has no judgment pass to attribute (gpt-review 3004 finding 912c0b)
  assert.match(
    err('exempt-mechanical', 'fable-5/xhigh') || '',
    /cannot accompany --spec-review exempt-mechanical/,
  );
  // malformed shapes
  assert.match(err('a1b2c3d', 'fable-5') || '', /expected "<model>\/<effort>"/);
  assert.match(err('a1b2c3d', 'fable-5/xhigh/extra') || '', /expected "<model>\/<effort>"/);
  assert.match(err('a1b2c3d', '/xhigh') || '', /expected "<model>\/<effort>"/);
  assert.match(err('a1b2c3d', 'fable-5/') || '', /expected "<model>\/<effort>"/);
  // whitespace and control characters are refused OUTRIGHT — the value is written raw into
  // a `key: value` frontmatter line, so a newline would inject extra frontmatter keys and a
  // trim-then-store-raw split would persist a non-canonical value (gpt-review 3004 findings
  // df96e9/cb3ba3/e057d1)
  assert.match(err('a1b2c3d', 'fable-5/ xhigh') || '', /expected "<model>\/<effort>"/);
  assert.match(err('a1b2c3d', 'fable-5 /xhigh') || '', /expected "<model>\/<effort>"/);
  assert.match(err('a1b2c3d', 'fable-5\nstage: stub/xhigh') || '', /expected "<model>\/<effort>"/);
  assert.match(
    err('a1b2c3d', 'model\nexecModel: sonnet/xhigh') || '',
    /expected "<model>\/<effort>"/,
  );
  // the effort half is the closed harness enum; the model half is free-form
  assert.match(err('a1b2c3d', 'fable-5/xhigg') || '', /not one of low\|medium\|high\|xhigh\|max/);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(err('a1b2c3d', `any-model.name-4/${effort}`), null, `${effort} must pass`);
  assert.equal(err('a1b2c3d', undefined), null, 'absent flag is always well-formed');
});

test('3004: --spec-review exempt-mechanical stamps NO specReviewBy and does not WARN', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'exempt-mechanical'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /no --provenance given/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^specReview: exempt-mechanical$/m);
    assert.doesNotMatch(body, /specReviewBy/);
  } finally {
    repo.cleanup();
  }
});

test('3004: --spec-review --provenance stamps specReviewBy with the declared value, no WARN', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d', '--provenance', 'fable-5/xhigh'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^specReview: a1b2c3d$/m);
    assert.match(body, /^specReviewBy: fable-5\/xhigh$/m);
    assert.doesNotMatch(res.stderr, /no --provenance given/);
  } finally {
    repo.cleanup();
  }
});

test('3004: --spec-review WITHOUT --provenance stamps specReviewBy: undeclared and WARNs', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /no --provenance given/);
    assert.match(res.stderr, /specReviewBy: undeclared/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^specReviewBy: undeclared$/m);
  } finally {
    repo.cleanup();
  }
});

test('3004: a plain execModel stamp writes NO specReviewBy key and never WARNs about provenance', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /provenance/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.doesNotMatch(body, /specReviewBy/);
  } finally {
    repo.cleanup();
  }
});

test('3004: a malformed --provenance exits 2 (usage), stamping nothing', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody() });
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'sonnet', '--spec-review', 'a1b2c3d', '--provenance', 'fable-5'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: stub$/m, 'nothing was stamped');
    assert.doesNotMatch(body, /specReview/);
  } finally {
    repo.cleanup();
  }
});

test('2892 R3: a malformed --spec-review exits 2 (usage), stamping nothing', () => {
  const repo = makeIsolatedRepo({ body: stubProseBody() });
  try {
    // requireValues throws from inside parseFlags; the CLI must still classify it as a
    // USAGE error (exit 2), not an operational failure (exit 1).
    const res = runStamp(repo.dir, ['1000', 'sonnet', '--spec-review'], repo.stampExecModel);
    assert.equal(res.code, 2, `expected exit 2\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^stage: stub$/m, 'nothing was stamped');
  } finally {
    repo.cleanup();
  }
});

// ───────────────── plan 3609: spec-pass cost capture at stamp time (E1/E2/E4/E6) ─────────────────
//
// E1 resolves `${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<any-slug>/${CLAUDE_CODE_SESSION_ID}.jsonl`
// and sums every `type: "assistant"` record's `message.usage`; E2 stamps the result as a single
// frontmatter key, `specCost`, JSON-quoted, or the literal `null` on any resolution failure. The
// pure-function cases below exercise resolveSpecPassCost/specCostFrontmatterValue directly (no fs
// touched — every access is injected, matching the mid-walk-race injection style the rest of the
// repo's readers use); the subprocess cases at the bottom prove the real CLI writes what E1/E2
// promise, using a real temp-dir transcript and CLAUDE_CONFIG_DIR/CLAUDE_CODE_SESSION_ID on the
// child env (spawnSync inherits process.env when no `env` override is given — the same mechanism
// claim-plan.test.mjs's withSessionId helper relies on).

test('resolveSpecPassCost: sums usage across every assistant record, skips non-assistant and malformed lines, picks the majority model', () => {
  const lines = [
    '{"type":"user","message":{"content":"hi"}}',
    'not even json',
    '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}',
    '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":3,"output_tokens":7,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}}',
    '{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
    // an assistant record with no usage (e.g. a pure tool-result echo) must not crash the sum
    '{"type":"assistant","message":{"model":"claude-sonnet-5"}}',
    '',
  ].join('\n');
  const usage = resolveSpecPassCost({
    sessionId: 'sess-1',
    configDir: '/fake/config',
    readdir: () => [{ name: 'slug', isDirectory: () => true }],
    exists: (p) => p.replace(/\\/g, '/').endsWith('slug/sess-1.jsonl'),
    readFile: () => lines,
    warn: () => {},
  });
  assert.deepEqual(usage, {
    in: 14,
    out: 28,
    cacheRead: 6,
    cacheWrite: 2,
    model: 'claude-sonnet-5',
    sessionId: 'sess-1',
  });
});

test('resolveSpecPassCost: no CLAUDE_CODE_SESSION_ID → null, ONE warn line, never throws', () => {
  let warnCount = 0;
  let warned = '';
  const usage = resolveSpecPassCost({
    // '' (not `undefined`) — a default PARAMETER only substitutes for `undefined`, and passing
    // `undefined` here would silently fall through to this actual process's own
    // CLAUDE_CODE_SESSION_ID (this test itself may be running inside a real Claude Code
    // session). An explicit empty string is unambiguously "not set" while still overriding
    // the default.
    sessionId: '',
    configDir: '/fake/config',
    readdir: () => {
      throw new Error('must not be reached — sessionId is checked first');
    },
    warn: (msg) => {
      warnCount++;
      warned = msg;
    },
  });
  assert.equal(usage, null);
  assert.equal(warnCount, 1);
  assert.match(warned, /CLAUDE_CODE_SESSION_ID is not set/);
  assert.match(warned, /specCost: null/);
});

test('resolveSpecPassCost: no matching transcript under any project slug → null, one warn line', () => {
  let warnCount = 0;
  const usage = resolveSpecPassCost({
    sessionId: 'sess-missing',
    configDir: '/fake/config',
    readdir: () => [
      { name: 'slug-a', isDirectory: () => true },
      { name: 'slug-b', isDirectory: () => true },
      { name: 'not-a-dir.txt', isDirectory: () => false },
    ],
    exists: () => false,
    readFile: () => {
      throw new Error('must not be reached — no candidate resolved');
    },
    warn: () => {
      warnCount++;
    },
  });
  assert.equal(usage, null);
  assert.equal(warnCount, 1);
});

test('resolveSpecPassCost: an unreadable projects/ dir → null, one warn line, never throws', () => {
  let warnCount = 0;
  const usage = resolveSpecPassCost({
    sessionId: 'sess-1',
    configDir: '/fake/config',
    readdir: () => {
      throw new Error('EACCES');
    },
    warn: () => {
      warnCount++;
    },
  });
  assert.equal(usage, null);
  assert.equal(warnCount, 1);
});

test('resolveSpecPassCost: the config dir comes from the shared resolveConfigDir seam', () => {
  // Review round 1 finding [2]: this must NOT be a hand-rolled fifth copy of the
  // $CLAUDE_CONFIG_DIR-else-~/.claude decision. Pin it by asserting the scanned directory is
  // exactly `<resolveConfigDir()>/projects` for both branches of that seam — so a later change to
  // the seam's fallback or candidate order moves this resolution with it instead of drifting.
  const scan = () => {
    let seenDir = null;
    resolveSpecPassCost({
      sessionId: 'sess-1',
      readdir: (dir) => {
        seenDir = dir;
        return [];
      },
      warn: () => {},
    });
    return seenDir;
  };
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = join('/fixture', 'cfg');
    assert.equal(scan(), join(resolveConfigDir(), 'projects'));
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(scan(), join(resolveConfigDir(), 'projects'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('specCostFrontmatterValue: null usage stamps the bare literal `null`, never a quoted string', () => {
  assert.equal(specCostFrontmatterValue(null), 'null');
});

test('specCostFrontmatterValue: known usage stamps a single-quoted JSON string that round-trips', () => {
  const usage = {
    in: 14,
    out: 28,
    cacheRead: 6,
    cacheWrite: 2,
    model: 'claude-sonnet-5',
    sessionId: 'sess-1',
  };
  const literal = specCostFrontmatterValue(usage);
  assert.match(literal, /^'.*'$/, 'single-quoted, matching the summary: quoting convention');
  const parsed = JSON.parse(literal.slice(1, -1));
  assert.deepEqual(parsed, {
    in: 14,
    out: 28,
    cacheRead: 6,
    cacheWrite: 2,
    model: 'claude-sonnet-5',
    sessionId: 'sess-1',
    cumulative: true,
    usd: null,
  });
});

// Save/restore CLAUDE_CONFIG_DIR + CLAUDE_CODE_SESSION_ID on process.env for the duration of `fn`
// — spawnSync inherits process.env for a child that gets no explicit `env` override (runTool's
// case), so setting them here reaches the real subprocess exactly like claim-plan.test.mjs's
// withSessionId helper relies on for CLAUDE_CODE_SESSION_ID alone.
function withCostEnv({ configDir, sessionId }, fn) {
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const prevSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = configDir;
  if (sessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = sessionId;
  try {
    return fn();
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSessionId;
  }
}

// Build a throwaway `$CLAUDE_CONFIG_DIR/projects/<slug>/<sessionId>.jsonl` fixture transcript.
function makeFixtureTranscript(sessionId, jsonlLines) {
  const configDir = mkdtempSync(join(tmpdir(), 'stampexec-cost-'));
  const projectsSlugDir = join(configDir, 'projects', 'fixture-slug');
  mkdirSync(projectsSlugDir, { recursive: true });
  writeFileSync(join(projectsSlugDir, `${sessionId}.jsonl`), jsonlLines.join('\n'));
  return { configDir, cleanup: () => rmSync(configDir, { recursive: true, force: true }) };
}

test('stamp-exec-model: --spec-review resolves the real transcript and stamps specCost (E1/E2)', () => {
  const sessionId = 'e2e-cost-session-1';
  const fixture = makeFixtureTranscript(sessionId, [
    '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}',
    '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":3,"output_tokens":7,"cache_read_input_tokens":1,"cache_creation_input_tokens":0}}}',
  ]);
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = withCostEnv({ configDir: fixture.configDir, sessionId }, () =>
      runStamp(
        repo.dir,
        ['1000', 'sonnet', '--spec-review', 'a1b2c3d', '--provenance', 'sonnet-5/high'],
        repo.stampExecModel,
      ),
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(
      body,
      /^specCost: '\{"in":13,"out":27,"cacheRead":6,"cacheWrite":2,"model":"claude-sonnet-5","sessionId":"e2e-cost-session-1","cumulative":true,"usd":null\}'$/m,
    );
  } finally {
    repo.cleanup();
    fixture.cleanup();
  }
});

test('stamp-exec-model: --spec-review with CLAUDE_CODE_SESSION_ID unset stamps `specCost: null` and WARNs exactly once', () => {
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = withCostEnv({ configDir: undefined, sessionId: undefined }, () =>
      runStamp(repo.dir, ['1000', 'sonnet', '--spec-review', 'a1b2c3d'], repo.stampExecModel),
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    const warnLines = res.stderr
      .split('\n')
      .filter((l) => /could not resolve spec-pass cost/.test(l));
    assert.equal(warnLines.length, 1, `expected exactly one cost-resolution WARN\n${res.stderr}`);
    assert.match(res.stderr, /CLAUDE_CODE_SESSION_ID is not set/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.match(body, /^specCost: null$/m);
  } finally {
    repo.cleanup();
  }
});

test('stamp-exec-model: --spec-review exempt-mechanical writes NO specCost key, even when the transcript would resolve', () => {
  const sessionId = 'e2e-cost-session-exempt';
  const fixture = makeFixtureTranscript(sessionId, [
    '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_tokens":1,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}',
  ]);
  const repo = withVetappMutationBanner(makeIsolatedRepo());
  try {
    const res = withCostEnv({ configDir: fixture.configDir, sessionId }, () =>
      runStamp(
        repo.dir,
        ['1000', 'sonnet', '--spec-review', 'exempt-mechanical'],
        repo.stampExecModel,
      ),
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /could not resolve spec-pass cost/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g('show', 'origin/master:docs/superpowers/plans/ready/1000-Other-foo.md');
    assert.doesNotMatch(body, /specCost/);
  } finally {
    repo.cleanup();
    fixture.cleanup();
  }
});

test('stamp-exec-model: a plain execModel stamp (no --spec-review) writes NO specCost key and never resolves a transcript', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = withCostEnv({ configDir: undefined, sessionId: undefined }, () =>
      runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel),
    );
    assert.equal(res.code, 0, `expected exit 0\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.doesNotMatch(res.stderr, /could not resolve spec-pass cost/);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.doesNotMatch(body, /specCost/);
  } finally {
    repo.cleanup();
  }
});

test('3919: oracle liveness metadata survives the raw-ref join', () => {
  const drainOld = 'claude/drain-1000-SOL-Other-foo';
  assert.throws(
    () =>
      planner({
        entries: [
          { name: OLD, sha: SHA, fresh: true },
          { name: drainOld, sha: SHA, fresh: false },
        ],
        collapse: collapseSameShaBranches,
      }),
    /oracle reports it live.*stamp after that session lands/s,
  );
});

// ───────────────── plan 3973 (T2): the combined --cloud-exec/--env/--move form ─────────────────

test('3973: argvUsageError rejects flag-shaped values and mis-ordered combined-form flags', () => {
  const err = (extra) => argvUsageError({ positionals: ['1000', 'fable'], ...extra });
  // flag-shaped values (parseFlags consumes the next token greedily)
  assert.match(err({ cloudExec: '--dry' }) || '', /--cloud-exec got the flag/);
  assert.match(err({ cloudEnv: '--dry' }) || '', /--env got the flag/);
  assert.match(err({ moveTarget: '--dry' }) || '', /--move got the flag/);
  assert.match(err({ blockedBy: '--dry' }) || '', /--blocked-by got the flag/);
  assert.match(err({ unblock: '--dry' }) || '', /--unblock got the flag/);
  assert.match(err({ cloudReason: '--dry' }) || '', /--reason got the flag/);
  // ordering: --env/--reason need --cloud-exec; --blocked-by/--unblock need --move
  assert.match(
    err({ cloudEnv: 'full' }) || '',
    /--env only makes sense together with --cloud-exec/,
  );
  assert.match(
    err({ cloudReason: 'why' }) || '',
    /--reason only makes sense together with --cloud-exec false/,
  );
  assert.match(
    err({ blockedBy: 'x' }) || '',
    /--blocked-by\/--unblock only make sense together with --move/,
  );
  assert.match(
    err({ unblock: 'manual' }) || '',
    /--blocked-by\/--unblock only make sense together with --move/,
  );
  // well-formed combined invocations pass
  assert.equal(err({ cloudExec: 'true', cloudEnv: 'full' }), null);
  assert.equal(err({ cloudExec: 'false', cloudReason: 'needs Chrome' }), null);
  assert.equal(err({ moveTarget: 'ready' }), null);
  assert.equal(err({ moveTarget: 'waiting-blocked', blockedBy: 'plan 1 landing' }), null);
});

test('3973: --cloud-exec/--env/--move fold execModel + cloudExec(+cloudEnv) + a lane move into ONE commit', () => {
  const repo = makeIsolatedRepo({ startFolder: 'pending-approval' });
  try {
    const before = repo.g('rev-list', '--count', 'origin/master').trim();
    const res = runStamp(
      repo.dir,
      ['1000', 'fable', '--cloud-exec', 'true', '--env', 'full', '--move', 'ready'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, res.stderr);
    const after = repo.g('rev-list', '--count', 'origin/master').trim();
    assert.equal(Number(after) - Number(before), 1, 'exactly one new commit');

    repo.g('fetch', '-q', 'origin', 'master');
    const tree = repo.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/1000-FABLE-Other-foo\.md/, 'plan renamed + moved to ready/');
    assert.doesNotMatch(tree, /pending-approval\/1000-Other-foo\.md$/m);
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/ready/1000-FABLE-Other-foo.md',
    );
    assert.match(body, /^execModel: fable$/m);
    assert.match(body, /^cloudExec: true$/m);
    assert.match(body, /^cloudEnv: full$/m);
    const subject = repo.g('log', '-1', '--format=%B', 'origin/master');
    assert.match(subject, /Coord-Write: stamp-exec-model\+stamp-cloud-exec/);
  } finally {
    repo.cleanup();
  }
});

test('3973: --move to an unsupported target refuses before any mutation — no commit', () => {
  const repo = makeIsolatedRepo();
  try {
    const before = repo.g('rev-parse', 'origin/master').trim();
    const res = runStamp(repo.dir, ['1000', 'fable', '--move', 'archive'], repo.stampExecModel);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--move archive is not supported/);
    assert.equal(repo.g('rev-parse', 'origin/master').trim(), before);
    repo.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(
      repo.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /FABLE-Other-foo/,
      'no rename either — the refusal fires before any filesystem mutation',
    );
  } finally {
    repo.cleanup();
  }
});

test('3973: an invocation with none of the combined-form flags is byte-identical to the pre-3973 output', () => {
  const repo = makeIsolatedRepo();
  try {
    const res = runStamp(repo.dir, ['1000', 'fable'], repo.stampExecModel);
    assert.equal(res.code, 0, res.stderr);
    assert.match(
      res.stdout,
      /^stamp-exec-model: 1000-Other-foo\.md → execModel: fable \(renamed to 1000-FABLE-Other-foo\.md\) — committed \+ pushed$/m,
    );
  } finally {
    repo.cleanup();
  }
});

// plan 3973 review fix (findings 8b2c92/071ab9): --move waiting-grill with NO --blocked-by
// must default to move-plan.mjs's own GRILL_BLOCKED_BY_DEFAULT reason (plan 2034 R3b) rather
// than refusing — the combined form's own pre-move assertBlockedByOk call used to see the
// bare `undefined` and refuse a documented, otherwise-valid route.
test('3973 review fix: --move waiting-grill with no --blocked-by defaults to the grill reason (findings 8b2c92/071ab9)', () => {
  const grillBody = DEFAULT_BODY.replace(
    VERDICT_SECTION,
    ['## Grill questions', '', '1. Q? — recommend: yes.', '', VERDICT_SECTION].join('\n'),
  );
  const repo = withVetappMutationBanner(makeIsolatedRepo({ body: grillBody }));
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'fable', '--move', 'waiting-grill'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, res.stderr);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/waiting-grill/1000-FABLE-Other-foo.md',
    );
    assert.match(body, /\*\*Blocked-by:\*\* operator grilling — see ## Grill questions/);
  } finally {
    repo.cleanup();
  }
});

// An explicit --blocked-by still wins over the waiting-grill default (mirrors move-plan.mjs).
test('3973 review fix: --move waiting-grill with an EXPLICIT --blocked-by keeps that reason', () => {
  const grillBody = DEFAULT_BODY.replace(
    VERDICT_SECTION,
    ['## Grill questions', '', '1. Q? — recommend: yes.', '', VERDICT_SECTION].join('\n'),
  );
  const repo = withVetappMutationBanner(makeIsolatedRepo({ body: grillBody }));
  try {
    const res = runStamp(
      repo.dir,
      ['1000', 'fable', '--move', 'waiting-grill', '--blocked-by', 'custom reason'],
      repo.stampExecModel,
    );
    assert.equal(res.code, 0, res.stderr);
    repo.g('fetch', '-q', 'origin', 'master');
    const body = repo.g(
      'show',
      'origin/master:docs/superpowers/plans/waiting-grill/1000-FABLE-Other-foo.md',
    );
    assert.match(body, /\*\*Blocked-by:\*\* custom reason/);
  } finally {
    repo.cleanup();
  }
});
