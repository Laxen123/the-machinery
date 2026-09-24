// scripts/read-plan-stamps.test.mjs — plan 2423. The regression pin for the contracted
// plan-stamp reader that retired the THIRD inline frontmatter parser (the /cloud-eligibility
// skill master's own regex, formerly in a per-account junction-layer master outside this repo).
//
// TWO pins matter here and neither is cosmetic:
//
//  1. THE BYTE-WINDOW PIN (plan 2396's defect, rediscovered independently in the skill and
//     misfiling plan 2365 on 2026-07-25): stamps that sit past a fixed head slice must still be
//     found. Every stamp test below is written against a >1500-byte `summary:`.
//  2. THE ORACLE-AGREEMENT PIN: a consumer's lane verdict must match what `queue-drain.mjs`
//     decides, because these consumers exist to REPORT the oracle (today `ready-board.mjs`;
//     until plan 2525 also the retired /cloud-eligibility skill). queue-drain reads
//     `readFrontmatterScalar(content, 'execModel').toLowerCase()` and compares to the bare string
//     `'fable'`. The retired skill regex was `/^execModel:\s*fable\b/m`, which ALSO matched
//     `execModel: fable.` and `execModel: fable CONFIRMED — …` (both real, both in archive/) —
//     i.e. it disagreed with the oracle on exactly the values a human hand-stamps. The tests
//     below pin the scalar semantics, so a future "let's just use a regex again" refactor goes
//     red instead of quietly re-splitting the lane verdict from the oracle's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  readPlanStamps,
  readLandGate,
  readLane,
  readLaneById,
  LANE_FAST,
  collectPlanStamps,
  STAMP_KEYS,
  PRIORITY_BY_DIRECTIVES,
} from './read-plan-stamps.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'read-plan-stamps.mjs');

// A plan-shaped body whose `summary:` is inflated the way real plans are (2378's is ~1900
// characters), which is what pushes every later key past any byte window.
const LONG_SUMMARY = 2000;
function planContent({ summaryLen = LONG_SUMMARY, keys = [], eol = '\n' } = {}) {
  const summary = `A summary long enough to push the stamps past a head slice. ${'x'.repeat(
    Math.max(0, summaryLen),
  )}`;
  return ['---', `summary: '${summary}'`, ...keys, '---', '', '# A plan', ''].join(eol);
}

test('readPlanStamps finds every stamp past byte 1500 (plan 2396/2423 regression pin)', () => {
  const content = planContent({
    keys: [
      'stage: specced',
      'execModel: fable',
      'cloudExec: true',
      'cloudEnv: full',
      'loop: hitl',
      'priority: high',
      'priorityBy: operator 2026-09-13',
    ],
  });
  // Guard the fixture itself: if the summary ever shrinks below the old window the test stops
  // pinning the bug while still passing.
  assert.ok(
    content.indexOf('execModel:') > 1500,
    `fixture must place the stamps past byte 1500 (got ${content.indexOf('execModel:')})`,
  );
  assert.deepEqual(readPlanStamps(content), {
    stage: 'specced',
    execModel: 'fable',
    cloudExec: 'true',
    cloudEnv: 'full',
    loop: 'hitl',
    priority: 'high',
    priorityBy: 'operator 2026-09-13', // plan 3999 — the provenance stamp this fixture carries
    cloudRepos: null, // plan 2577 — this fixture names no extra repo
    evidence: null, // plan 2943 — this fixture names no evidence class
    landGate: null, // plan 3295 — this fixture names no land-gate tier
    lane: null, // plan 3967 — this fixture names no review-round lane
    specReview: null, // plan 2571 — folded into readPlanStamps() itself; this fixture names none
    specReviewBy: null, // plan 3047 — the second named exception, same terms; fixture names none
  });
  // Proof the fixture is the RED case for the retired head-slice read.
  assert.equal(
    (content.slice(0, 1500).match(/^execModel:\s*(\S+)/m) || [])[1],
    undefined,
    'the retired byte-sliced read misses these stamps',
  );
});

test('readPlanStamps: absent keys read null, not empty string — except priority, whose default IS a value', () => {
  const stamps = readPlanStamps(planContent({ keys: ['stage: specced'] }));
  assert.equal(stamps.stage, 'specced');
  assert.equal(stamps.execModel, null);
  assert.equal(stamps.cloudExec, null);
  assert.equal(stamps.cloudEnv, null);
  assert.equal(stamps.loop, null);
  // plan 2520: priority is the one axis where absence is NOT null — the ruled vocabulary's
  // default IS `medium`, byte-equivalent to unstamped at every consumer.
  assert.equal(stamps.priority, 'medium');
  // plan 3999: priorityBy is null-means-absent like every other non-priority key — absent is
  // the normal, legal case for a medium/low plan.
  assert.equal(stamps.priorityBy, null);
  // plan 2943: evidence is null-means-absent like every other non-priority key — a missing
  // stamp is the grandfathered-pool default, not a distinguished value.
  assert.equal(stamps.evidence, null);
});

// plan 2943: readPlanStamps reads `evidence` through the generic scalar branch (lower-cased,
// same as execModel/cloudEnv), past the byte-1500 window a fixed head-slice read would miss.
test('readPlanStamps: reads a stamped evidence class, lower-cased, past byte 1500', () => {
  const content = planContent({ keys: ['stage: specced', 'evidence: LATENT'] });
  assert.ok(
    content.indexOf('evidence:') > 1500,
    `fixture must place the stamp past byte 1500 (got ${content.indexOf('evidence:')})`,
  );
  assert.equal(readPlanStamps(content).evidence, 'latent');
  assert.equal(
    readPlanStamps(planContent({ keys: ['evidence: observed-wave'] })).evidence,
    'observed-wave',
  );
});

// plan 3295: `landGate` joins the contract on `evidence`'s exact terms (generic scalar branch,
// lower-cased, null-means-absent) — `/ready-plans` and any board renderer can show the tier
// without re-opening the plan file.
test('readPlanStamps: reads a stamped landGate tier, lower-cased, past byte 1500 (plan 3295)', () => {
  const content = planContent({ keys: ['stage: specced', 'landGate: SELECTIVE'] });
  assert.ok(
    content.indexOf('landGate:') > 1500,
    `fixture must place the stamp past byte 1500 (got ${content.indexOf('landGate:')})`,
  );
  assert.equal(readPlanStamps(content).landGate, 'selective');
  assert.equal(readPlanStamps(planContent({ keys: ['stage: specced'] })).landGate, null);
});

// plan 3295: readLandGate is the NORMALIZING reader the land spine consumes — `selective` is the
// ONLY stampable value, so anything else (a typo, a retired tier name, a decorated value the
// scalar read hands back whole) reads `null` = "the environment default", never a half-honoured
// tier. Deliberately narrower than the raw STAMP_KEYS scalar above, which reports what is
// written; this one reports what the gate will DO.
test('readLandGate: only `selective` is stampable, everything else reads null (plan 3295)', () => {
  assert.equal(readLandGate(planContent({ keys: ['landGate: selective'] })), 'selective');
  assert.equal(readLandGate(planContent({ keys: ['landGate: SELECTIVE'] })), 'selective');
  assert.equal(
    readLandGate(planContent({ keys: ['landGate: selective # plan 3295 tier'] })),
    'selective',
    'a trailing inline comment is stripped by the shared scalar read',
  );
  assert.equal(readLandGate(planContent({ keys: ['landGate: full-daily'] })), null);
  assert.equal(readLandGate(planContent({ keys: ['landGate: selectivey'] })), null);
  assert.equal(readLandGate(planContent({ keys: ['stage: specced'] })), null);
  assert.equal(readLandGate('# A plan with no frontmatter\n\nbody\n'), null);
  assert.equal(readLandGate(''), null);
  assert.equal(readLandGate(null), null);
});

// plan 3967: readLane mirrors readLandGate exactly — `fast` is the ONLY stampable value, so a
// typo/retired-name/decorated value all read null (the safe direction: the default cap, more
// rounds not fewer, is what a mis-stamp falls back to).
test('readLane: only `fast` is stampable, everything else reads null (plan 3967)', () => {
  assert.equal(readLane(planContent({ keys: ['lane: fast'] })), LANE_FAST);
  assert.equal(readLane(planContent({ keys: ['lane: FAST'] })), LANE_FAST);
  assert.equal(
    readLane(planContent({ keys: ['lane: fast # opt-in fastlane'] })),
    LANE_FAST,
    'a trailing inline comment is stripped by the shared scalar read',
  );
  assert.equal(readLane(planContent({ keys: ['lane: slow'] })), null);
  assert.equal(readLane(planContent({ keys: ['lane: fastish'] })), null);
  assert.equal(readLane(planContent({ keys: ['stage: specced'] })), null);
  assert.equal(readLane('# A plan with no frontmatter\n\nbody\n'), null);
  assert.equal(readLane(''), null);
  assert.equal(readLane(null), null);
});

// plan 3967: readLaneById resolves `readLane` by PLAN ID against a checkout's plans tree — the
// shape the review-round-cap guard and record-review's warning need (they know a plan id, not
// content in hand). Byte-identity for the default case matters here: a lookup error, a missing
// root, or no matching file must all read as the default lane, never deny a review.
test('readLaneById: resolves a stamped plan by id under any status folder', () => {
  const root = makeTree({
    'docs/superpowers/plans/ready/3967-Infra-fastlane-thing.md': planContent({
      keys: ['stage: specced', 'lane: fast'],
    }),
    'docs/superpowers/plans/in-progress/1000-Other-unrelated.md': planContent({
      keys: ['stage: specced'],
    }),
  });
  try {
    assert.equal(readLaneById(root, '3967'), LANE_FAST);
    assert.equal(readLaneById(root, '1000'), null, 'an unstamped plan reads null');
    assert.equal(readLaneById(root, '9999'), null, 'no matching plan file reads null, not a throw');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 3967 fix round 1 (findings 16/17/18): a plan may legally rest one category level below its
// status folder (`in-progress/infra/<id>-…md`, plan 2678's `walkPlanTree`-supported shape). The
// old hand-rolled scan only ever looked at DIRECT children of each status folder, saw the `infra`
// DIRECTORY (never descending into it), and silently fell back to `null` — the default lane —
// which lets a stamped fastlane plan run extra review rounds instead of being capped at one.
test('readLaneById: resolves a stamped plan nested one category level deep (e.g. in-progress/infra/)', () => {
  const root = makeTree({
    'docs/superpowers/plans/in-progress/infra/3967-Infra-fastlane-thing.md': planContent({
      keys: ['stage: specced', 'lane: fast'],
    }),
  });
  try {
    assert.equal(readLaneById(root, '3967'), LANE_FAST);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readLaneById: fails OPEN to the default lane on every lookup error — a nonexistent root, a bad id', () => {
  assert.equal(readLaneById('/does/not/exist/at/all', '3967'), null);
  assert.equal(readLaneById(null, '3967'), null);
  assert.equal(readLaneById('/repo', ''), null);
  assert.equal(readLaneById('/repo', null), null);
});

test('readPlanStamps: no frontmatter block at all reads every stamp null, except priority (defaults to medium)', () => {
  const stamps = readPlanStamps('# A plan with no frontmatter\n\nbody\n');
  for (const k of STAMP_KEYS) {
    if (k === 'priority') continue;
    assert.equal(stamps[k], null, `${k} should be null`);
  }
  assert.equal(stamps.priority, 'medium');
});

// plan 2520: the reader's own priority normalization (case-insensitivity, trailing `# comment` —
// the plan-1292 lesson build-index-lib.mjs:218 already records — and the escaped-bad-value
// warn-and-fall-back-to-medium contract, never a crash).
test('readPlanStamps: priority normalizes case-insensitively and strips a trailing comment', () => {
  assert.equal(readPlanStamps(planContent({ keys: ['priority: HIGH'] })).priority, 'high');
  assert.equal(readPlanStamps(planContent({ keys: ['priority: Low'] })).priority, 'low');
  assert.equal(
    readPlanStamps(planContent({ keys: ['priority: high # stamped by board-pass 2026-07-24'] }))
      .priority,
    'high',
  );
});

test('readPlanStamps: an illegal priority value (the now-illegal "normal", or a typo) reads as medium, never crashes', () => {
  assert.equal(readPlanStamps(planContent({ keys: ['priority: normal'] })).priority, 'medium');
  assert.equal(readPlanStamps(planContent({ keys: ['priority: urgnet'] })).priority, 'medium');
});

// plan 3999: priorityBy joins STAMP_KEYS through the generic scalar branch (lower-cased,
// null-means-absent, past-byte-1500-safe) — no special-casing needed since, unlike `priority`,
// its absent-default IS null (a medium/low plan legally carries none).
test('readPlanStamps: reads a stamped priorityBy, lower-cased, past byte 1500', () => {
  const content = planContent({
    keys: ['priority: high', 'priorityBy: OPERATOR 2026-09-13'],
  });
  assert.ok(
    content.indexOf('priorityBy:') > 1500,
    `fixture must place the stamp past byte 1500 (got ${content.indexOf('priorityBy:')})`,
  );
  assert.equal(readPlanStamps(content).priorityBy, 'operator 2026-09-13');
  assert.equal(
    readPlanStamps(
      planContent({ keys: ['priority: high', 'priorityBy: directive 2141-critical-path'] }),
    ).priorityBy,
    'directive 2141-critical-path',
  );
  assert.equal(readPlanStamps(planContent({ keys: ['priority: medium'] })).priorityBy, null);
});

test('read-plan-stamps re-exports PRIORITY_BY_DIRECTIVES from build-index-lib.mjs (plan 3999)', () => {
  // A plain mirror of build-index-lib.mjs's own array, not a second source of truth.
  // grammar-omnibus-carryforward was retired by plan 3961.
  assert.deepEqual(PRIORITY_BY_DIRECTIVES, ['2141-critical-path']);
});

test('readPlanStamps: a trailing YAML inline comment is stripped (plan 1015 shape)', () => {
  const stamps = readPlanStamps(
    planContent({ keys: ['execModel: fable # umbrella tracker — NOT drain-eligible'] }),
  );
  assert.equal(stamps.execModel, 'fable');
});

test('readPlanStamps: values are lower-cased, matching queue-drain normalization', () => {
  const stamps = readPlanStamps(planContent({ keys: ['execModel: Fable', 'cloudExec: TRUE'] }));
  assert.equal(stamps.execModel, 'fable');
  assert.equal(stamps.cloudExec, 'true');
});

test('readPlanStamps: CRLF frontmatter parses (plan 1650 shape)', () => {
  const stamps = readPlanStamps(planContent({ keys: ['execModel: fable'], eol: '\r\n' }));
  assert.equal(stamps.execModel, 'fable');
});

// THE ORACLE-AGREEMENT PIN. queue-drain compares the whole `execModel:` scalar to 'fable', so it
// calls `execModel: fable CONFIRMED — …` and `execModel: fable.` sonnet-lane; the retired
// `/^execModel:\s*fable\b/` regex called both fable — the lane-misattribution class the skill's
// note 1 documents. Pin the oracle's answer.
//
// CITATION CORRECTED 2026-07-26 (plan 2488 review): this used to cite archive/1587 and
// archive/2232 as carrying those values. They do not — the decoration is body PROSE in 1587's
// spec verdict; both files' frontmatter is a bare `fable`. A measured sweep found
// DECORATED_EXECMODEL_VALUES_MEASURED decorated frontmatter `execModel` values in the corpus
// (plan 2495: that count lives in ONE export in read-plan-stamps.mjs), all `fable # <comment>`
// shaped, on which the retired regex and the scalar read AGREE.
// The divergence is LATENT, which is precisely why it needs a test: there is no row to catch it on.
test('readPlanStamps: a decorated execModel value is NOT bare "fable" (oracle agreement)', () => {
  assert.equal(
    readPlanStamps(planContent({ keys: ['execModel: fable CONFIRMED — the composer IS it'] }))
      .execModel,
    'fable confirmed — the composer is it',
  );
  assert.equal(readPlanStamps(planContent({ keys: ['execModel: fable.'] })).execModel, 'fable.');
  // …and the retired regex would have said "fable" for both.
  for (const v of ['fable CONFIRMED — the composer IS it', 'fable.']) {
    assert.ok(/^execModel:\s*fable\b/m.test(`execModel: ${v}`), 'the retired regex matched these');
  }
});

// ── collectPlanStamps over a plans tree ────────────────────────────────────

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'plan-stamps-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

// NOTE (plan 2524): a `priority` normalization test lived here briefly. Plan 2520 landed the
// ruled three-tier vocabulary and its own normalization tests above (case, trailing comment,
// illegal-value → medium) while 2524 was queued, so this file's priority coverage is 2520's.
// /ready-plans reads the same value under the same `=== 'high'` predicate build-index-lib applies.

test('collectPlanStamps keys by plan id and carries the status folder', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({ keys: ['stage: specced', 'execModel: sonnet'] }),
    'in-progress/2423-Coord-other.md': planContent({ keys: ['execModel: fable', 'loop: afk'] }),
  });
  try {
    const stamps = collectPlanStamps({ root });
    assert.deepEqual(Object.keys(stamps).sort(), ['2423', '2482']);
    assert.equal(stamps['2482'].folder, 'ready');
    assert.equal(stamps['2482'].execModel, 'sonnet');
    assert.equal(stamps['2423'].folder, 'in-progress');
    assert.equal(stamps['2423'].loop, 'afk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps skips archive/ by default and includes it on request', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({ keys: ['execModel: sonnet'] }),
    'archive/1587-FABLE-old.md': planContent({ keys: ['execModel: fable'] }),
  });
  try {
    assert.deepEqual(Object.keys(collectPlanStamps({ root })), ['2482']);
    assert.deepEqual(Object.keys(collectPlanStamps({ root, includeArchive: true })).sort(), [
      '1587',
      '2482',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps ignores non-.md files, un-numbered names, and nested dirs', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({ keys: ['execModel: sonnet'] }),
    'ready/README.md': '# not a plan\n',
    'ready/2483-notes.txt': planContent({ keys: ['execModel: fable'] }),
    'ready/2484-a-directory.md/inner.md': planContent({ keys: ['execModel: fable'] }),
    'loose-file.md': planContent({ keys: ['execModel: fable'] }),
  });
  try {
    assert.deepEqual(Object.keys(collectPlanStamps({ root })), ['2482']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps: a duplicate id across folders resolves last-wins in sorted order', () => {
  const root = makeTree({
    'in-progress/2423-Coord-thing.md': planContent({ keys: ['execModel: fable'] }),
    'ready/2423-Coord-thing.md': planContent({ keys: ['execModel: sonnet'] }),
  });
  try {
    // 'in-progress' < 'ready' when sorted, so 'ready' is seen last and wins. The value is
    // arbitrary for a transient mid-move duplicate; what this pins is that it is DETERMINISTIC
    // rather than dependent on readdir order (which differs across filesystems).
    assert.equal(collectPlanStamps({ root })['2423'].folder, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps: a missing plans root is an explicit error, not a silent {}', () => {
  assert.throws(
    () => collectPlanStamps({ root: join(tmpdir(), 'plan-stamps-does-not-exist-2423') }),
    /plans root/i,
  );
});

// THE MID-WALK RACE (sonnet-review finding, 2026-07-26). ~5-7 sessions mutate the plans tree
// continuously, so a plan listed by readdir can be gone by the time it is read. Losing the whole
// board — and, since no consumer wraps this script's execFileSync, the whole report — over one
// raced row is not acceptable. Skip the row, keep the rest.
test('collectPlanStamps: a plan that vanishes mid-walk is skipped, not fatal', () => {
  const root = makeTree({
    'ready/2482-Coord-survivor.md': planContent({ keys: ['execModel: sonnet'] }),
    'ready/2483-Coord-raced-away.md': planContent({ keys: ['execModel: fable'] }),
  });
  try {
    const enoent = () => {
      const e = new Error('ENOENT: no such file or directory');
      e.code = 'ENOENT';
      throw e;
    };
    const stamps = collectPlanStamps({
      root,
      readFile: (p) => (p.includes('2483') ? enoent() : readFileSync(p, 'utf8')),
    });
    assert.deepEqual(Object.keys(stamps), ['2482'], 'the raced row is dropped, the rest survive');
    assert.equal(stamps['2482'].execModel, 'sonnet');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// …but ONLY the vanished-path errnos. A reader that reports a plan as absent because it could
// not be READ is the silent-misreport class this plan exists to kill.
test('collectPlanStamps: a NON-race read error still throws (EACCES is a defect, not churn)', () => {
  const root = makeTree({ 'ready/2482-Coord-thing.md': planContent({ keys: ['loop: afk'] }) });
  try {
    assert.throws(
      () =>
        collectPlanStamps({
          root,
          readFile: () => {
            const e = new Error('EACCES: permission denied');
            e.code = 'EACCES';
            throw e;
          },
        }),
      /EACCES/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 2495: collectPlanStamps' additive contract extension ─────────────────────────────
// specReview + path are NEW per-plan keys (mine-sonnet-lane-executor-telemetry.mjs's buildPlanIndex
// is the first consumer — this pins the reader's own contract independent of that caller).

test('collectPlanStamps: specReview and path are additive keys, read off the same content', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({
      keys: ['execModel: sonnet', 'specReview: exempt-mechanical # no judgment call'],
    }),
  });
  try {
    const stamps = collectPlanStamps({ root });
    assert.equal(
      stamps['2482'].specReview,
      'exempt-mechanical',
      'comment-stripped, not lower-cased',
    );
    assert.equal(stamps['2482'].path, join(root, 'ready', '2482-Coord-thing.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── plan 3047: specReviewBy, the second named exception ───────────────────────────────────
// The spec-pass effort experiment's arm label. mine-spec-pass-effort-arms.mjs is its consumer;
// this pins the reader's own contract independent of that caller, exactly as the block above does.

test('collectPlanStamps: specReviewBy is read verbatim, case intact', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({
      keys: ['execModel: fable', 'specReviewBy: claude-fable-5/xhigh'],
    }),
  });
  try {
    // NOT lower-cased and NOT normalized here: the model-half spelling drift
    // (`fable`/`fable-5`/`claude-fable-5`) is collapsed by the CONSUMER that compares arms, so this
    // reader must hand it over unmodified or that consumer cannot tell the spellings apart.
    assert.equal(collectPlanStamps({ root })['2482'].specReviewBy, 'claude-fable-5/xhigh');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps: an absent specReview / specReviewBy reads null, not empty string', () => {
  const root = makeTree({ 'ready/2482-Coord-bare.md': planContent({ keys: [] }) });
  try {
    assert.equal(collectPlanStamps({ root })['2482'].specReview, null);
    assert.equal(collectPlanStamps({ root })['2482'].specReviewBy, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// plan 3958: the plan-2495 drift guard that used to live here (asserting
// DECORATED_EXECMODEL_VALUES_MEASURED === 44 and scanning
// mine-sonnet-lane-executor-telemetry.mjs/.test.mjs for a restated corpus count) is removed —
// those two sibling files are vetapp-only tooling (top-level scripts/, not in the coord-kit
// manifest and not under scripts/coord/), never shipped by the public kit. Genuine vetapp
// product coverage, not core.

// ── CLI contract ───────────────────────────────────────────────────────────

test('CLI --json prints the id → stamps map ready-board.mjs consumes', () => {
  const root = makeTree({
    'ready/2482-Coord-thing.md': planContent({
      keys: ['stage: specced', 'execModel: sonnet', 'cloudExec: true', 'cloudEnv: full'],
    }),
  });
  try {
    const out = JSON.parse(
      execFileSync('node', [CLI, '--json', '--root', root], { encoding: 'utf8' }),
    );
    assert.deepEqual(out, {
      2482: {
        stage: 'specced',
        execModel: 'sonnet',
        cloudExec: 'true',
        cloudEnv: 'full',
        loop: null,
        priority: 'medium',
        // priorityBy: plan 3999's additive extension — null-means-absent, the normal case for
        // a medium-tier plan (this fixture stamps no priorityBy).
        priorityBy: null,
        // cloudRepos: plan 2577's additive extension, same shape as every scalar key here —
        // the raw lower-cased frontmatter value, null when the plan names no extra repo.
        cloudRepos: null,
        // evidence: plan 2943's additive extension, same null-means-absent shape — this
        // fixture names no evidence class.
        evidence: null,
        // landGate: plan 3295's additive extension — the per-plan land-gate tier
        // (`selective`, or absent for the environment default). Same null-means-absent shape.
        landGate: null,
        // lane: plan 3967's additive extension — the review-round fastlane stamp (`fast`, or
        // absent for the default cap). Same null-means-absent shape as landGate/evidence.
        lane: null,
        // specReview + path: plan 2495's additive extension. NEW keys — a consumer's own
        // `s.cloudEnv === 'full'`-shaped reads are unaffected by a key it never asked for; this
        // assertion still deepEquals the WHOLE object so a future key REMOVAL still goes RED.
        specReview: null,
        // specReviewBy: plan 3047's additive extension — the spec-pass effort experiment's arm
        // label, on `specReview`'s exact terms (see readPlanStamps()). Same null-means-absent
        // shape; this fixture carries no spec-pass provenance stamp.
        specReviewBy: null,
        path: join(root, 'ready', '2482-Coord-thing.md'),
        folder: 'ready',
        // plan 2678's additive extension, alongside `path`/`folder`: the optional one-level
        // category subfolder below the status, null for the flat default.
        category: null,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Category subfolders (plan 2678) ────────────────────────────────────────

test('collectPlanStamps walks one level of category subfolders, reporting status + category', () => {
  const root = makeTree({
    'ready/2400-Coord-flat.md': planContent({ keys: ['stage: specced', 'execModel: fable'] }),
    'parked/denmark/2401-Biz-dk-thing.md': planContent({
      keys: ['stage: specced', 'execModel: sonnet'],
    }),
  });
  try {
    const stamps = collectPlanStamps({ root });
    // The nested plan is PRESENT — before plan 2678 the non-recursive readdir dropped it
    // silently, which is what took it off /ready-plans and every other stamp consumer.
    assert.deepEqual(Object.keys(stamps).sort(), ['2400', '2401']);
    // `folder` keeps meaning the STATUS (every consumer branches on it); `category` is the
    // new, additive, null-when-flat field.
    assert.equal(stamps['2400'].folder, 'ready');
    assert.equal(stamps['2400'].category, null);
    assert.equal(stamps['2401'].folder, 'parked');
    assert.equal(stamps['2401'].category, 'denmark');
    assert.equal(stamps['2401'].execModel, 'sonnet');
    assert.equal(stamps['2401'].path, join(root, 'parked', 'denmark', '2401-Biz-dk-thing.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectPlanStamps still skips archive/ by default when it is nested-clean', () => {
  const root = makeTree({
    'ready/2402-Coord-live.md': planContent({ keys: ['stage: specced'] }),
    'archive/2403-Coord-done.md': planContent({ keys: ['stage: specced'] }),
  });
  try {
    assert.deepEqual(Object.keys(collectPlanStamps({ root })), ['2402']);
    assert.deepEqual(Object.keys(collectPlanStamps({ root, includeArchive: true })).sort(), [
      '2402',
      '2403',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI rejects an unknown flag instead of silently ignoring it', () => {
  assert.throws(
    () => execFileSync('node', [CLI, '--lane', 'fable'], { encoding: 'utf8', stdio: 'pipe' }),
    /unknown option/i,
  );
});
