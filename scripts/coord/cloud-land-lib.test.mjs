// Tests for scripts/coord/cloud-land-lib.mjs (plan 4255) — name-paired test file of a new module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_LAND_NOTE_HEADING,
  MAX_CLOUD_LAND_HANDOFFS,
  applyHandoff,
  cloudExecFalseReasons,
  countCloudLandHandoffs,
  isLandHandoff,
  judgeLandRefusals,
  missingHandoffParts,
  noteForSha,
  readLandStamps,
  renderHandoffNote,
  judgeHandoff,
  runHandoff,
  HANDOFF_STEPS,
} from './cloud-land-lib.mjs';
import { readFrontmatterScalar } from './build-index-lib.mjs';

const SHA = 'a'.repeat(40);

function planText({ cloudExec = 'false', extraFm = [], body = '' } = {}) {
  return [
    '---',
    'summary: t',
    `cloudExec: ${cloudExec}`,
    ...extraFm,
    '---',
    '',
    '# T',
    '',
    body,
    '',
  ].join('\n');
}

function note(sha = SHA, n = 1) {
  return renderHandoffNote({
    iso: '2026-09-26T22:00:00Z',
    branch: 'worktree-9999-X',
    headSha: sha,
    verdict: 'PASS',
    env: 'full',
    handoffNumber: n,
  });
}

test('applyHandoff stamps the land-phase carrier + env and appends the note', () => {
  const out = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  assert.equal(readFrontmatterScalar(out, 'landCloudExec'), 'true');
  assert.equal(readFrontmatterScalar(out, 'landCloudEnv'), 'full');
  assert.equal(
    readFrontmatterScalar(out, 'cloudExec'),
    'false',
    'cloudExec keeps its meaning (S1)',
  );
  assert.equal(countCloudLandHandoffs(out), 1);
  assert.ok(out.includes(`${CLOUD_LAND_NOTE_HEADING} 2026-09-26T22:00:00Z`));
});

test('applyHandoff is idempotent for the same HEAD sha — a re-run never adds a second note', () => {
  const once = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  const twice = applyHandoff(once, { note: note(), env: 'full', headSha: SHA });
  assert.equal(twice, once);
  assert.equal(countCloudLandHandoffs(twice), 1);
});

test('applyHandoff at a NEW sha appends a second note (the one allowed bounce)', () => {
  const once = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  const sha2 = 'b'.repeat(40);
  const twice = applyHandoff(once, { note: note(sha2, 2), env: 'full', headSha: sha2 });
  assert.equal(countCloudLandHandoffs(twice), MAX_CLOUD_LAND_HANDOFFS);
  assert.ok(noteForSha(twice, SHA) && noteForSha(twice, sha2));
});

test('applyHandoff preserves CRLF line endings', () => {
  const crlf = planText().replace(/\n/g, '\r\n');
  const out = applyHandoff(crlf, { note: note(), env: 'full', headSha: SHA });
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced');
});

test('noteForSha ignores a sha that appears only outside a hand-off note', () => {
  const text = planText({ body: `## Evidence\n\ncommit ${SHA}\n` });
  assert.equal(noteForSha(text, SHA), false);
});

test('isLandHandoff needs all three parts: carrier, adoptBranch, note', () => {
  const full = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  assert.equal(isLandHandoff(full, 'worktree-9999-X'), true);
  assert.equal(isLandHandoff(full, null), false, 'no adoptBranch');
  const noNote = planText({ extraFm: ['landCloudExec: true'] });
  assert.equal(isLandHandoff(noNote, 'worktree-9999-X'), false, 'no note');
  const noCarrier = planText({ body: note() });
  assert.equal(isLandHandoff(noCarrier, 'worktree-9999-X'), false, 'no carrier');
});

test('missingHandoffParts names what an incomplete hand-off lacks, and nothing when unstamped', () => {
  assert.deepEqual(missingHandoffParts(planText(), null), []);
  const noNote = planText({ extraFm: ['landCloudExec: true'] });
  assert.equal(missingHandoffParts(noNote, null).length, 2);
  assert.deepEqual(missingHandoffParts(noNote, 'b'), [`the "${CLOUD_LAND_NOTE_HEADING}" note`]);
});

test('readLandStamps normalizes case and absence', () => {
  assert.deepEqual(readLandStamps(planText()), { landCloudExec: null, landCloudEnv: null });
  assert.deepEqual(
    readLandStamps(planText({ extraFm: ['landCloudExec: TRUE', 'landCloudEnv: Full'] })),
    {
      landCloudExec: 'true',
      landCloudEnv: 'full',
    },
  );
});

test('judgeLandRefusals: .claude/** is rubric #7, .husky/** is #8, wiki/ refuses', () => {
  const r = judgeLandRefusals({
    changedPaths: ['.claude/commands/x.md', '.husky/pre-push', 'wiki/a.md', 'scripts/x.mjs'],
    planContent: planText({ cloudExec: 'true' }),
  });
  assert.deepEqual(
    r.map((x) => x.rubric),
    ['#7', '#8', 'wiki'],
  );
});

test('judgeLandRefusals: a clean scripts diff is admitted', () => {
  assert.deepEqual(
    judgeLandRefusals({
      changedPaths: ['scripts/x.mjs', 'frontend/src/a.tsx'],
      planContent: planText(),
    }),
    [],
  );
});

test('judgeLandRefusals: a cloudExec:false reason naming a key or a route:local host refuses (#2/#3)', () => {
  for (const reason of [
    '> ☁️ **cloudExec: false** — needs CLOUDFLARE_API_TOKEN (rubric #3)',
    '> ☁️ **cloudExec: false** — the host is route: local in the registry',
    'cloudExec: false — rubric #2 (datacenter-blocked host)',
  ]) {
    const r = judgeLandRefusals({ changedPaths: [], planContent: planText({ body: reason }) });
    assert.equal(r.length, 1, reason);
    assert.equal(r[0].rubric, '#2/#3');
  }
});

test('judgeLandRefusals: --gates-cloud-safe waives #2/#3 but never #7/#8', () => {
  const body = '> ☁️ **cloudExec: false** — needs CLOUDFLARE_API_TOKEN (#3)';
  const r = judgeLandRefusals({
    changedPaths: ['.claude/settings.json'],
    planContent: planText({ body }),
    gatesCloudSafe: 'the token is read only by the build step',
  });
  assert.deepEqual(
    r.map((x) => x.rubric),
    ['#7'],
  );
});

test('judgeLandRefusals: operator-as-oracle (#6) and machine state (#5) reasons are build-only — admitted', () => {
  const body =
    '> ☁️ **cloudExec: false** — operator decides mid-run (#6) and reads ~/.claude-* (#5)';
  assert.deepEqual(judgeLandRefusals({ changedPaths: [], planContent: planText({ body }) }), []);
});

test("judgeLandRefusals: a cloudExec:true plan quoting another plan's #3 reason is not refused", () => {
  const body = '- `cloudExec: false` plans: 4213 (#3 `CLOUDFLARE_API_TOKEN`)';
  assert.deepEqual(
    judgeLandRefusals({ changedPaths: [], planContent: planText({ cloudExec: 'true', body }) }),
    [],
  );
});

test('cloudExecFalseReasons skips the frontmatter stamp line itself', () => {
  assert.deepEqual(cloudExecFalseReasons(planText()), []);
});

// --- judgeHandoff / runHandoff (T1) -------------------------------------------------------------

function facts(over = {}) {
  return {
    planId: '9999',
    slug: '9999-X',
    branch: 'worktree-9999-X',
    headSha: SHA,
    originSha: SHA,
    dirtyPaths: [],
    changedPaths: ['scripts/x.mjs'],
    planContent: planText(),
    planFolder: 'in-progress',
    adoptBranch: null,
    claim: { held: true, youAreHolder: true },
    review: { verdict: 'PASS', sha: SHA },
    findingsOpen: null,
    ...over,
  };
}

function fakeOps({ failAt = null, adopt = 'worktree-9999-X' } = {}) {
  const calls = [];
  const op = (name, ret) => () => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} boom`);
    return ret;
  };
  const ops = {
    writePlan: (c) => {
      calls.push('writePlan');
      ops.written = c;
      if (failAt === 'writePlan') throw new Error('write boom');
    },
    dequeue: op('dequeue'),
    moveReady: op('moveReady'),
    readAdoptBranch: op('readAdoptBranch', adopt),
    release: op('release'),
  };
  return { ops, calls };
}

test('judgeHandoff: a clean, claimed, pushed, reviewed branch has no refusals', () => {
  const j = judgeHandoff(facts());
  assert.deepEqual(j.refusals, []);
  assert.equal(j.handoffNumber, 1);
});

test('judgeHandoff: each preflight failure is its own named refusal', () => {
  const j = judgeHandoff(
    facts({
      claim: { held: false },
      dirtyPaths: ['a.mjs'],
      originSha: 'c'.repeat(40),
      review: { verdict: 'PASS', sha: 'd'.repeat(40) },
      findingsOpen: '1 finding open',
    }),
  );
  assert.deepEqual(
    j.refusals.map((r) => r.code),
    ['NOT_CLAIMED', 'DIRTY', 'PUSH_UNCONFIRMED', 'NO_REVIEW', 'FINDINGS_OPEN'],
  );
});

test('judgeHandoff: a branch not on origin at all is PUSH_UNCONFIRMED', () => {
  const j = judgeHandoff(facts({ originSha: null }));
  assert.deepEqual(
    j.refusals.map((r) => r.code),
    ['PUSH_UNCONFIRMED'],
  );
});

test('judgeHandoff (S3): the second bounce refuses; a re-run at the same sha does not count itself', () => {
  const one = applyHandoff(planText(), {
    note: note('e'.repeat(40)),
    env: 'full',
    headSha: 'e'.repeat(40),
  });
  assert.deepEqual(
    judgeHandoff(facts({ planContent: one })).refusals,
    [],
    'one prior hand-off: allowed',
  );
  assert.equal(judgeHandoff(facts({ planContent: one })).handoffNumber, 2);
  const two = applyHandoff(one, {
    note: note('f'.repeat(40), 2),
    env: 'full',
    headSha: 'f'.repeat(40),
  });
  assert.deepEqual(
    judgeHandoff(facts({ planContent: two })).refusals.map((r) => r.code),
    ['BOUNCE_LIMIT'],
  );
  const rerun = applyHandoff(one, { note: note(SHA, 2), env: 'full', headSha: SHA });
  assert.deepEqual(
    judgeHandoff(facts({ planContent: rerun })).refusals,
    [],
    'our own note is not a bounce',
  );
});

test('judgeHandoff: a finished hand-off (ready, stamped, released) reports done, not NOT_CLAIMED', () => {
  const content = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  const j = judgeHandoff(
    facts({
      planContent: content,
      planFolder: 'ready',
      adoptBranch: 'worktree-9999-X',
      claim: { held: false },
    }),
  );
  assert.deepEqual(j, { done: true });
});

test('runHandoff runs the steps in the load-bearing order: note → dequeue → move → verify → release', () => {
  const { ops, calls } = fakeOps();
  const r = runHandoff(facts(), ops, { iso: '2026-09-26T22:00:00Z' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ran, HANDOFF_STEPS);
  assert.deepEqual(calls, ['writePlan', 'dequeue', 'moveReady', 'readAdoptBranch', 'release']);
  assert.equal(readFrontmatterScalar(ops.written, 'landCloudExec'), 'true');
  assert.ok(ops.written.includes('## Cloud-land hand-off 2026-09-26T22:00:00Z'));
});

test('runHandoff: a failure before release leaves the claim held and names the step', () => {
  for (const failAt of ['writePlan', 'dequeue', 'moveReady']) {
    const { ops, calls } = fakeOps({ failAt });
    const r = runHandoff(facts(), ops);
    assert.equal(r.ok, false);
    assert.equal(r.claimHeld, true);
    assert.ok(!calls.includes('release'), `${failAt}: release never ran`);
  }
});

test('runHandoff: a wrong adoptBranch stamp stops before release', () => {
  const { ops, calls } = fakeOps({ adopt: 'worktree-9999-OTHER' });
  const r = runHandoff(facts(), ops);
  assert.equal(r.failedStep, 'verify');
  assert.equal(r.claimHeld, true);
  assert.ok(!calls.includes('release'));
});

test('runHandoff is idempotent: a re-run after a failed move skips the note and the move already done', () => {
  const content = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  const { ops, calls } = fakeOps();
  const r = runHandoff(facts({ planContent: content, planFolder: 'ready' }), ops);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['dequeue', 'readAdoptBranch', 'release']);
  assert.deepEqual(r.ran, ['dequeue', 'verify', 'release']);
});

test('judgeHandoff (S3, review r4 5172df): re-handing the SAME HEAD after a bounce counts as a bounce', () => {
  // The first hand-off at SHA, then a cloud drain bounced it with a plan-3248 hand-back note.
  const handed = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  const bounced = `${handed}\n## Cloud drain handoff 2026-09-27T01:00:00Z\n\n- cloud-only flake; handed back.\n`;
  const j = judgeHandoff(facts({ planContent: bounced }));
  assert.deepEqual(j.refusals, [], 'one bounce: a second hand-off is allowed');
  assert.equal(j.handoffNumber, 2);
  const second = applyHandoff(bounced, { note: note(SHA, 2), env: 'full', headSha: SHA });
  assert.equal(
    countCloudLandHandoffs(second),
    2,
    'the second hand-off writes its own note even at the same sha',
  );
  const bouncedAgain = `${second}\n## Cloud drain handoff 2026-09-27T02:00:00Z\n\n- flaked again.\n`;
  assert.deepEqual(
    judgeHandoff(facts({ planContent: bouncedAgain })).refusals.map((r) => r.code),
    ['BOUNCE_LIMIT'],
  );
});

test('applyHandoff (review r4 5172df): a re-run whose own note is still the LAST section stays idempotent', () => {
  const once = applyHandoff(planText(), { note: note(), env: 'full', headSha: SHA });
  assert.equal(applyHandoff(once, { note: note(), env: 'full', headSha: SHA }), once);
});
