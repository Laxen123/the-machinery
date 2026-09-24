// scripts/session-priority.test.mjs — battery for the session scheduling-class resolver
// (plan 2716). Name-paired with session-priority.mjs, a genuinely new module.
//
// Every derivation branch is exercised through injected seams (branch string, plans root, readdir,
// readFile), so nothing here needs a repo, a claim, a git binary, or a real process to renice.
// The one thing NOT faked is the tier vocabulary: the assertions below pin that a plan's
// `priority:` frontmatter arrives normalized by read-plan-stamps.mjs (plan 2423 + 2520), which is
// the whole point of the module — a re-inlined `=== 'high'` would pass a hand-rolled test and
// fail these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  explainSessionTier,
  resolveSessionTier,
  resolveSchedulingClass,
  readLandingHead,
  applyCpuClass,
  findPlanFile,
  CPU_CLASS_DEMOTED,
  TIER_ENV,
  LANDING_QUEUE_HEAD_ENV,
  LANDING_HEAD_YIELD_ENV,
} from './session-priority.mjs';
import { initialQueueDoc, renderQueue } from './landing-queue-lib.mjs';

// A throwaway plans tree: `<root>/<status>/<id>-…md` with the given frontmatter priority.
function plansTree(plans) {
  const root = mkdtempSync(join(tmpdir(), 'session-priority-plans-'));
  for (const { status = 'in-progress', name, priority } of plans) {
    mkdirSync(join(root, status), { recursive: true });
    const fm = priority === undefined ? '' : `priority: ${priority}\n`;
    writeFileSync(join(root, status, name), `---\nstage: specced\n${fm}---\n\n# ${name}\n`);
  }
  return root;
}

const NO_ENV = {}; // never inherit a real SESSION_PRIORITY_TIER from the runner's shell

test("resolves the claimed plan's priority tier from the worktree branch", () => {
  const root = plansTree([{ name: '2716-FABLE-Infra-plan-priority.md', priority: 'high' }]);
  try {
    const { tier, reason } = explainSessionTier({
      env: NO_ENV,
      branch: 'worktree-2716-FABLE-infra-plan-priority-test-queue-cpu-class',
      plansRoot: root,
    });
    assert.equal(tier, 'high');
    assert.match(reason, /plan 2716/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an UNSTAMPED plan reads as medium — the ruled default, never null', () => {
  const root = plansTree([{ name: '900-Infra-thing.md' }]);
  try {
    assert.equal(
      explainSessionTier({ env: NO_ENV, branch: 'worktree-900-Infra-thing', plansRoot: root }).tier,
      'medium',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an illegal priority value soft-fails to medium (the plan-2520 backstop, via the shared reader)', () => {
  const root = plansTree([{ name: '901-Infra-thing.md', priority: 'normal' }]);
  try {
    assert.equal(
      explainSessionTier({
        env: NO_ENV,
        branch: 'worktree-901-Infra-thing',
        plansRoot: root,
        warn: () => {},
      }).tier,
      'medium',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plan in a category subfolder is still found (the plan-2678 walk)', () => {
  const root = plansTree([{ status: 'in-progress', name: '902-Infra-thing.md', priority: 'low' }]);
  try {
    mkdirSync(join(root, 'parked', 'denmark'), { recursive: true });
    writeFileSync(
      join(root, 'parked', 'denmark', '903-Infra-nested.md'),
      '---\npriority: high\n---\n',
    );
    assert.equal(
      explainSessionTier({ env: NO_ENV, branch: 'worktree-903-Infra-nested', plansRoot: root })
        .tier,
      'high',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive/ is not searched — an archived plan is not a live claim', () => {
  const root = plansTree([{ status: 'archive', name: '904-Infra-old.md', priority: 'high' }]);
  try {
    const { tier, reason } = explainSessionTier({
      env: NO_ENV,
      branch: 'worktree-904-Infra-old',
      plansRoot: root,
    });
    assert.equal(tier, 'medium');
    assert.match(reason, /no active plan file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-claim contexts all resolve to medium, each with its own reason', () => {
  const root = plansTree([{ name: '905-Infra-thing.md', priority: 'high' }]);
  try {
    const at = (branch) => explainSessionTier({ env: NO_ENV, branch, plansRoot: root });
    assert.equal(at('master').tier, 'medium');
    assert.match(at('master').reason, /not a worktree claim/);
    // A batch-lane slug carries no single plan id — its members can hold different tiers.
    assert.match(at('worktree-batch-2026-07-05-coord-fable').reason, /no plan id/);
    assert.match(at('worktree-9999-Infra-nonexistent').reason, /no active plan file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing plans root is a medium, not a throw (this runs on a spawn path)', () => {
  const { tier } = explainSessionTier({
    env: NO_ENV,
    branch: 'worktree-906-Infra-thing',
    plansRoot: join(tmpdir(), 'session-priority-does-not-exist-2716'),
  });
  assert.equal(tier, 'medium');
});

test('an unreadable plan file degrades to medium instead of throwing', () => {
  const root = plansTree([{ name: '907-Infra-thing.md', priority: 'high' }]);
  try {
    const { tier, reason } = explainSessionTier({
      env: NO_ENV,
      branch: 'worktree-907-Infra-thing',
      plansRoot: root,
      readFile: () => {
        const e = new Error('boom');
        e.code = 'EACCES';
        throw e;
      },
    });
    assert.equal(tier, 'medium');
    assert.match(reason, /unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`${TIER_ENV} overrides the derivation; a typo is warned about and ignored`, () => {
  const root = plansTree([{ name: '908-Infra-thing.md', priority: 'high' }]);
  try {
    const at = (v, warn = () => {}) =>
      explainSessionTier({
        env: { [TIER_ENV]: v },
        branch: 'worktree-908-Infra-thing',
        plansRoot: root,
        warn,
      });
    assert.equal(at('low').tier, 'low');
    assert.equal(at('LOW').tier, 'low'); // case-insensitive, like every other stamp read
    const warnings = [];
    assert.equal(at('urgent', (m) => warnings.push(m)).tier, 'high'); // falls through to the plan
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSessionTier returns the tier explainSessionTier derived', () => {
  const root = plansTree([{ name: '909-Infra-thing.md', priority: 'low' }]);
  try {
    assert.equal(
      resolveSessionTier({ env: NO_ENV, branch: 'worktree-909-Infra-thing', plansRoot: root }),
      'low',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findPlanFile uses the canonical plan-id rule — no substring or digit-prefix collisions', () => {
  const root = plansTree([
    { name: '271-Infra-short.md' },
    { name: '2716-FABLE-long.md' },
    { name: '2716b-Infra-decoy.md' }, // no dash after the digits → not an id at all
  ]);
  try {
    assert.match(findPlanFile(2716, { plansRoot: root }), /2716-FABLE-long\.md$/);
    assert.match(findPlanFile(271, { plansRoot: root }), /271-Infra-short\.md$/);
    assert.equal(findPlanFile(9999, { plansRoot: root }), null);
    assert.equal(findPlanFile(Number.POSITIVE_INFINITY, { plansRoot: root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy date-prefixed plan is NOT mistaken for the plan whose id matches its year', () => {
  // `/^(\d+)/` would have read "2026" out of `2026-05-17-vetpris-retry.md`, so a session on the
  // branch for plan 2026 could have taken its tier from an unrelated dated plan. planIdOf requires
  // a letter-category segment after the digits, which sends date-prefixed names to Infinity.
  const root = plansTree([
    { name: '2026-05-17-vetpris-retry.md', priority: 'high' },
    { name: '2026-Infra-real-plan.md', priority: 'low' },
  ]);
  try {
    assert.match(findPlanFile(2026, { plansRoot: root }), /2026-Infra-real-plan\.md$/);
    assert.equal(
      explainSessionTier({ env: NO_ENV, branch: 'worktree-2026-Infra-real-plan', plansRoot: root })
        .tier,
      'low',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSessionTier is NOT memoized — a mid-flight priority bump is observed', () => {
  const root = plansTree([{ name: '910-Infra-thing.md', priority: 'low' }]);
  const at = () =>
    resolveSessionTier({ env: NO_ENV, branch: 'worktree-910-Infra-thing', plansRoot: root });
  try {
    assert.equal(at(), 'low');
    writeFileSync(join(root, 'in-progress', '910-Infra-thing.md'), '---\npriority: high\n---\n');
    assert.equal(at(), 'high', 'a process-wide cache would have pinned the first answer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- readLandingHead / resolveSchedulingClass — plan 3226 --------------------------
// The landing-queue-head axis: axis 1 ("am I the head?" → high) and axis 2 ("is a local land in
// flight at the head, and should I therefore yield the CPU class?"), both fed by ONE queue read.
// Every external input is injected (readQueueDoc, readHeartbeatRef, hostname, pidAlive, now) —
// nothing here touches a real repo, a real clock, or a real process.

const HEAD_SLUG = '3226-Infra-landing-head-cpu-priority';
const NOW_ISO = '2026-08-16T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

// A head entry in the shape parseQueue produces, defaulting to "IN_LAND, this host, live pid,
// fresh heartbeat" — the one shape axis 2 says yes to. Individual fields are overridden per test
// to walk each refusal branch.
function headEntry(overrides = {}) {
  return {
    slug: HEAD_SLUG,
    lane: 'sonnet',
    session: 'vm',
    host: 'buildbox',
    enqueuedIso: '2026-08-16T11:00:00.000Z',
    heartbeatIso: '2026-08-16T11:58:00.000Z', // 2m before NOW_MS
    pid: 4242,
    state: 'IN_LAND',
    reapArmedIso: null,
    priority: false,
    progressIso: null,
    ...overrides,
  };
}

function queueDocWithHead(entry) {
  return renderQueue(initialQueueDoc(), [entry], []);
}

// resolveSchedulingClass with every queue-read seam pre-wired to a fake head entry (or `null` for
// an empty queue) — callers only vary the bits the test under discussion cares about.
function scheduling({
  env = NO_ENV,
  branch,
  plansRoot,
  entry = headEntry(),
  hostnameValue = 'buildbox',
  pidAliveValue = true,
  now = NOW_MS,
  readHeartbeatRefValue = null,
} = {}) {
  return resolveSchedulingClass({
    env,
    branch,
    plansRoot,
    mainDir: '/fake/main',
    readQueueDoc: () => (entry ? queueDocWithHead(entry) : initialQueueDoc()),
    readHeartbeatRef: () => readHeartbeatRefValue,
    now: () => now,
    hostname: () => hostnameValue,
    pidAlive: () => pidAliveValue,
  });
}

test('landing-queue head matched via LANDING_QUEUE_HEAD env resolves high — no priority: stamp needed', () => {
  const { tier, reason } = scheduling({
    env: { [LANDING_QUEUE_HEAD_ENV]: HEAD_SLUG },
    branch: 'master', // not even a worktree claim — the env match alone is sufficient
  });
  assert.equal(tier, 'high');
  assert.match(reason, new RegExp(`landing-queue head \\(${HEAD_SLUG}\\)`));
});

test('landing-queue head matched via worktree branch resolves high (the ephemeral-merge-push env line is a separate, load-bearing signal — see the module header)', () => {
  const { tier, reason } = scheduling({ branch: `worktree-${HEAD_SLUG}` });
  assert.equal(tier, 'high');
  assert.match(reason, /landing-queue head/);
});

test('a sibling (not the head): my own stamp tier applies, and I yield the CPU — IN_LAND + live pid + fresh heartbeat', () => {
  const root = plansTree([{ name: '950-Infra-sibling.md', priority: 'medium' }]);
  try {
    const { tier, reason, yieldToHead, yieldReason } = scheduling({
      branch: 'worktree-950-Infra-sibling',
      plansRoot: root,
    });
    assert.equal(tier, 'medium');
    assert.match(reason, /plan 950/);
    assert.equal(yieldToHead, true);
    assert.match(yieldReason, new RegExp(`local land in flight at head: ${HEAD_SLUG}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a HOLDING head counts for axis 1 (still what everyone waits on) but never for axis 2 (provably not in the merge window)', () => {
  const root = plansTree([{ name: '951-Infra-sibling.md', priority: 'low' }]);
  try {
    const asHead = scheduling({
      branch: `worktree-${HEAD_SLUG}`,
      entry: headEntry({ state: 'HOLDING' }),
    });
    assert.equal(asHead.tier, 'high');

    const asSibling = scheduling({
      branch: 'worktree-951-Infra-sibling',
      plansRoot: root,
      entry: headEntry({ state: 'HOLDING' }),
    });
    assert.equal(asSibling.yieldToHead, false);
    assert.match(asSibling.yieldReason, /HOLDING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('axis 2 requires the SAME host as the head — compared case-insensitively on the first DNS label (Windows hostname()/`hostname` drift)', () => {
  const root = plansTree([{ name: '952-Infra-sibling.md' }]);
  try {
    const remoteHost = scheduling({
      branch: 'worktree-952-Infra-sibling',
      plansRoot: root,
      entry: headEntry({ host: 'otherbox' }),
      hostnameValue: 'buildbox',
    });
    assert.equal(remoteHost.yieldToHead, false);
    assert.match(remoteHost.yieldReason, /on host/);

    const sameHostCaseDrift = scheduling({
      branch: 'worktree-952-Infra-sibling',
      plansRoot: root,
      entry: headEntry({ host: 'BuildBox.some-domain.example' }),
      hostnameValue: 'buildbox',
    });
    assert.equal(sameHostCaseDrift.yieldToHead, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dead head pid (ESRCH) never yields — ESRCH is the one unambiguous "gone" signal', () => {
  const root = plansTree([{ name: '953-Infra-sibling.md' }]);
  try {
    const { yieldToHead, yieldReason } = scheduling({
      branch: 'worktree-953-Infra-sibling',
      plansRoot: root,
      pidAliveValue: false,
    });
    assert.equal(yieldToHead, false);
    assert.match(yieldReason, /pid 4242 is not alive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale doc heartbeat alone does not yield; a fresher local heartbeat-ref stamp rescues it', () => {
  const root = plansTree([{ name: '954-Infra-sibling.md' }]);
  try {
    const staleOnly = scheduling({
      branch: 'worktree-954-Infra-sibling',
      plansRoot: root,
      entry: headEntry({ heartbeatIso: '2026-08-16T10:00:00.000Z' }), // 120m before NOW_MS
    });
    assert.equal(staleOnly.yieldToHead, false);
    assert.match(staleOnly.yieldReason, /stale/);

    const rescuedByLocalRef = scheduling({
      branch: 'worktree-954-Infra-sibling',
      plansRoot: root,
      entry: headEntry({ heartbeatIso: '2026-08-16T10:00:00.000Z' }),
      readHeartbeatRefValue: { ts: '2026-08-16T11:59:00.000Z' }, // 1m before NOW_MS
    });
    assert.equal(rescuedByLocalRef.yieldToHead, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The fold goes through landing-queue-lib's decorateWithHeartbeatRefs precisely so this guard
// comes along: a heartbeat ref left over from a PREVIOUS residency of the same slug (dequeue →
// `reenter` re-enqueues under the same name) is stamped at-or-before the CURRENT residency's
// enqueuedIso, and must not be allowed to vouch for a head whose own heartbeat has gone stale.
// Without the guard a single foreign-residency timestamp demotes every sibling on the box.
test('a leftover heartbeat-ref from a PRIOR residency (stamped at-or-before enqueuedIso) does NOT rescue a stale head', () => {
  const root = plansTree([{ name: '958-Infra-sibling.md' }]);
  try {
    const entry = headEntry({
      enqueuedIso: '2026-08-16T11:30:00.000Z',
      heartbeatIso: '2026-08-16T10:00:00.000Z', // 120m before NOW_MS — stale
    });
    const leftover = scheduling({
      branch: 'worktree-958-Infra-sibling',
      plansRoot: root,
      entry,
      // Fresh in wall-clock terms (1m old) but stamped BEFORE this residency was enqueued, so it
      // belongs to the previous one and proves nothing about the current land.
      readHeartbeatRefValue: { ts: '2026-08-16T11:29:00.000Z' },
    });
    assert.equal(leftover.yieldToHead, false);
    assert.match(leftover.yieldReason, /stale/);

    // Control: the SAME stamp moved after enqueuedIso is a genuine current-residency heartbeat
    // and does rescue the head — proving the guard keys on enqueuedIso, not on rejecting refs.
    const current = scheduling({
      branch: 'worktree-958-Infra-sibling',
      plansRoot: root,
      entry,
      readHeartbeatRefValue: { ts: '2026-08-16T11:59:00.000Z' },
    });
    assert.equal(current.yieldToHead, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The pre-3226 derivation tests above call explainSessionTier/resolveSessionTier with only
// {env, branch, plansRoot} and no queue seams. Their file-header contract is that nothing here
// needs a repo, a claim, or a git binary — so resolveSchedulingClass must NOT go discover a real
// main checkout behind their back and read the live shared landing queue (which on this box is a
// different sibling session's land every few minutes, i.e. a flaky hidden input).
test('a plansRoot-injected caller stays hermetic: no main-checkout discovery, no live queue read', () => {
  const root = plansTree([{ name: '959-Infra-sibling.md', priority: 'low' }]);
  try {
    let queueReads = 0;
    const { tier, yieldToHead } = resolveSchedulingClass({
      env: NO_ENV,
      branch: 'worktree-959-Infra-sibling',
      plansRoot: root,
      readQueueDoc: () => {
        queueReads += 1;
        return null;
      },
    });
    // The seam WAS honored when explicitly injected (opt-in), and the stamp still resolved.
    assert.equal(queueReads, 1);
    assert.equal(tier, 'low');
    assert.equal(yieldToHead, false);

    // …and with NO queue seam injected at all, the head axis is skipped entirely rather than
    // silently falling back to the real repo.
    const bare = resolveSchedulingClass({
      env: NO_ENV,
      branch: 'worktree-959-Infra-sibling',
      plansRoot: root,
    });
    assert.equal(bare.tier, 'low');
    assert.equal(bare.yieldToHead, false);
    assert.match(bare.yieldReason, /no main checkout resolved/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// …and the suppression is an explicit, overridable decision, not an inference a future caller
// can trip over: `discoverMainDir: true` redirects ONLY the plan-stamp lookup and keeps the
// landing-queue-head axis live.
test('discoverMainDir:true keeps the head axis while plansRoot redirects only the stamp lookup', () => {
  const root = plansTree([{ name: '960-Infra-sibling.md', priority: 'low' }]);
  try {
    let discovered = 0;
    const { tier, yieldToHead } = resolveSchedulingClass({
      env: NO_ENV,
      branch: 'worktree-960-Infra-sibling',
      plansRoot: root,
      discoverMainDir: true,
      // Stand in for the discovered checkout's queue doc, so the assertion is about the axis
      // being ON rather than about this sandbox's real repo state.
      readQueueDoc: () => {
        discovered += 1;
        return queueDocWithHead(headEntry());
      },
      readHeartbeatRef: () => null,
      now: () => NOW_MS,
      hostname: () => 'buildbox',
      pidAlive: () => true,
    });
    assert.equal(discovered, 1);
    assert.equal(tier, 'low'); // the stamp still comes from the injected plansRoot
    assert.equal(yieldToHead, true); // …while the head axis stayed live
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`${LANDING_HEAD_YIELD_ENV}=0 is the operator escape hatch — opts a babysat session out of yielding`, () => {
  const root = plansTree([{ name: '955-Infra-sibling.md' }]);
  try {
    const { yieldToHead, yieldReason } = scheduling({
      branch: 'worktree-955-Infra-sibling',
      plansRoot: root,
      env: { [LANDING_HEAD_YIELD_ENV]: '0' },
    });
    assert.equal(yieldToHead, false);
    assert.match(yieldReason, new RegExp(`${LANDING_HEAD_YIELD_ENV}=0`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty landing queue: nobody is the head, and nobody yields', () => {
  const root = plansTree([{ name: '957-Infra-sibling.md', priority: 'low' }]);
  try {
    const { tier, yieldToHead, yieldReason } = scheduling({
      branch: 'worktree-957-Infra-sibling',
      plansRoot: root,
      entry: null,
    });
    assert.equal(tier, 'low');
    assert.equal(yieldToHead, false);
    assert.match(yieldReason, /empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readLandingHead: a queue-doc read failure, an unparseable doc, and an unavailable doc all fail OPEN — never throw', () => {
  const thrown = readLandingHead({
    mainDir: '/fake/main',
    readQueueDoc: () => {
      throw new Error('git show boom');
    },
  });
  assert.equal(thrown.head, null);
  assert.equal(thrown.inFlightLocal, false);
  assert.match(thrown.reason, /unreadable/);

  const unparseable = readLandingHead({
    mainDir: '/fake/main',
    readQueueDoc: () => 'not a real queue doc — no sentinels here',
  });
  assert.equal(unparseable.head, null);
  assert.equal(unparseable.inFlightLocal, false);
  assert.match(unparseable.reason, /unparseable/);

  const unavailable = readLandingHead({
    mainDir: '/fake/main',
    readQueueDoc: () => null,
  });
  assert.equal(unavailable.head, null);
  assert.match(unavailable.reason, /unavailable/);

  const noMainDir = readLandingHead({});
  assert.equal(noMainDir.head, null);
  assert.match(noMainDir.reason, /no main checkout/);
});

test('resolveSchedulingClass: a broken queue read degrades to the plan-stamp tier and no yield — never throws', () => {
  const root = plansTree([{ name: '956-Infra-sibling.md', priority: 'high' }]);
  try {
    const { tier, yieldToHead } = resolveSchedulingClass({
      env: NO_ENV,
      branch: 'worktree-956-Infra-sibling',
      plansRoot: root,
      mainDir: '/fake/main',
      readQueueDoc: () => {
        throw new Error('boom');
      },
    });
    assert.equal(tier, 'high');
    assert.equal(yieldToHead, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`${TIER_ENV} override wins over the landing-queue head too (axis 1 ordering is pinned: TIER_ENV > head > plan stamp)`, () => {
  const { tier, reason } = scheduling({
    env: { [TIER_ENV]: 'low' },
    branch: `worktree-${HEAD_SLUG}`, // this session IS the head, by branch match
  });
  assert.equal(tier, 'low');
  assert.match(reason, new RegExp(`${TIER_ENV}=low`));
});

// --- applyCpuClass -----------------------------------------------------------
// Acceptance 2 is verified live on Windows (Get-Process … PriorityClass); these pin the CONTRACT:
// demote only, never elevate, never throw.

test('applyCpuClass: only a low tier steps down from the ambient class to idle', () => {
  const calls = [];
  const setPriority = (p, v) => calls.push([p, v]);
  assert.equal(applyCpuClass(4242, 'low', { setPriority }), true);
  assert.deepEqual(calls, [[4242, CPU_CLASS_DEMOTED]]);
  assert.equal(applyCpuClass(4242, 'medium', { setPriority }), false);
  assert.equal(applyCpuClass(4242, 'high', { setPriority }), false);
  assert.equal(applyCpuClass(4242, undefined, { setPriority }), false);
  assert.equal(calls.length, 1, 'no tier but `low` may touch the process at all');
});

test('applyCpuClass: yieldToHead demotes ANY tier (axis 2, plan 3226) — a bare tier check alone would not', () => {
  const calls = [];
  const setPriority = (p, v) => calls.push([p, v]);
  assert.equal(applyCpuClass(4242, 'high', { yieldToHead: true, setPriority }), true);
  assert.deepEqual(calls, [[4242, CPU_CLASS_DEMOTED]]);
  assert.equal(applyCpuClass(4242, 'medium', { setPriority }), false, 'yieldToHead defaults false');
  assert.equal(calls.length, 1);
});

test('applyCpuClass: the demotion target is IDLE and elevation is impossible by construction', () => {
  // os.setPriority takes a nice-like scale where NEGATIVE means higher priority. A positive
  // constant can only ever lower the class, which is the spec-pinned invariant (no AboveNormal
  // for `high`: elevating starves system interactivity).
  assert.ok(CPU_CLASS_DEMOTED > 0, `expected a positive nice value, got ${CPU_CLASS_DEMOTED}`);
});

test('applyCpuClass: a failed demotion warns and proceeds — it never breaks the heavy run', () => {
  const warnings = [];
  const ok = applyCpuClass(4242, 'low', {
    setPriority: () => {
      throw new Error('EPERM');
    },
    warn: (m) => warnings.push(m),
  });
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not demote pid 4242/);
  assert.match(warnings[0], /inherited class/);
});

test('applyCpuClass: a bogus pid is a no-op, not a throw', () => {
  const setPriority = () => assert.fail('must not be called for a bogus pid');
  assert.equal(applyCpuClass(undefined, 'low', { setPriority }), false);
  assert.equal(applyCpuClass(0, 'low', { setPriority }), false);
  assert.equal(applyCpuClass(-1, 'low', { setPriority }), false);
});
