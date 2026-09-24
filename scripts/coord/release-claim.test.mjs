// scripts/release-claim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRef, readHolder } from './claim-plan.mjs';
import { buildClaimMessage } from './claim-plan-lib.mjs';
import { CLAIM_GLOBS, claimRef } from './coord-refs.mjs';

// plan 3756: a release no longer DELETES the ref — it appends a tombstone — so "released"
// is asserted through readHolder (which reads a tombstone as unheld), and "still held"
// through a pattern built from the seam rather than a pinned legacy literal.
const claimRx = (id) => new RegExp(claimRef(id).replace(/[/]/g, '\\/'));
import { releaseDecision, releaseClaim } from './release-claim.mjs';

for (const name of [
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
])
  delete process.env[name];

for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

function makeBareOrigin() {
  const origin = mkdtempSync(join(tmpdir(), 'rel-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), 'rel-work-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('remote', 'add', 'origin', origin);
  writeFileSync(join(dir, 'f.txt'), 'one\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  g('push', '-q', 'origin', 'master');
  return {
    dir,
    origin,
    lsClaims: () => g('ls-remote', origin, ...CLAIM_GLOBS),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

test('releaseDecision: unheld -> no-op; force -> delete; owner -> delete; foreign -> refuse', () => {
  assert.deepEqual(releaseDecision({ holder: null, sessionUuid: 'me' }), {
    delete: false,
    reason: 'unheld',
  });
  assert.equal(
    releaseDecision({ holder: { sessionUuid: 'them' }, sessionUuid: 'me', force: true }).delete,
    true,
  );
  assert.equal(releaseDecision({ holder: { sessionUuid: 'me' }, sessionUuid: 'me' }).delete, true);
  assert.deepEqual(releaseDecision({ holder: { sessionUuid: 'them' }, sessionUuid: 'me' }), {
    delete: false,
    reason: 'foreign',
  });
});

test('releaseClaim --force releases the ref on origin', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    acquireRef(dir, {
      planId: '368',
      message: buildClaimMessage({ planId: '368', sessionUuid: 'X', host: 'H', iso: 'I' }),
    });
    assert.match(lsClaims(), claimRx('368'));
    const r = releaseClaim(dir, '368', { force: true, sessionUuid: 'test-force' });
    assert.equal(r.released, true);
    assert.equal(readHolder(dir, '368'), null, 'released — the ref survives, the lock does not');
  } finally {
    cleanup();
  }
});

test('releaseClaim by the OWNING session releases it (no --force needed)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    acquireRef(dir, {
      planId: '368',
      message: buildClaimMessage({ planId: '368', sessionUuid: 'ME', host: 'H', iso: 'I' }),
    });
    const r = releaseClaim(dir, '368', { sessionUuid: 'ME' });
    assert.equal(r.released, true);
    assert.equal(readHolder(dir, '368'), null);
  } finally {
    cleanup();
  }
});

test('releaseClaim refuses a FOREIGN-held ref without --force (and never throws)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    acquireRef(dir, {
      planId: '368',
      message: buildClaimMessage({ planId: '368', sessionUuid: 'OTHER', host: 'H', iso: 'I' }),
    });
    const r = releaseClaim(dir, '368', { sessionUuid: 'ME' });
    assert.equal(r.released, false);
    assert.equal(r.reason, 'foreign');
    assert.match(lsClaims(), claimRx('368')); // still held
    assert.ok(readHolder(dir, '368'), 'a refused release leaves the claim live');
  } finally {
    cleanup();
  }
});

test('releaseClaim: F-014 — a re-acquired claim in the read->delete window is NOT clobbered (force-with-lease CAS)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    // OLD holder claims the plan; capture what a stale-info observer (e.g. reconcile-board's
    // advisory --force suggestion) would have read at that moment.
    acquireRef(dir, {
      planId: '368',
      message: buildClaimMessage({ planId: '368', sessionUuid: 'OLD', host: 'H', iso: 'I' }),
    });
    const staleHolder = readHolder(dir, '368');
    assert.match(staleHolder.body, /OLD/);
    // Simulate the REAL race happening underneath: OLD released it, then a NEW session
    // re-acquired fresh (a plain non-force push onto the now-empty ref — no `--force` needed for
    // a genuinely re-created ref, exactly like the real acquire/release lifecycle).
    releaseClaim(dir, '368', { force: true });
    acquireRef(dir, {
      planId: '368',
      message: buildClaimMessage({ planId: '368', sessionUuid: 'NEW', host: 'H', iso: 'I' }),
    });
    assert.match(readHolder(dir, '368').body, /NEW/, "NEW's claim is live");

    // Now release, but INJECT the STALE holder view for the release's own read (simulating an
    // operator/tool that observed OLD's claim before the race, then acted on it) — the SECOND
    // (disambiguation) read must see the REAL current state.
    let calls = 0;
    const staleThenFresh = (d, id) => {
      calls++;
      return calls === 1 ? staleHolder : readHolder(d, id);
    };
    const r = releaseClaim(dir, '368', {
      force: true,
      sessionUuid: 'test-force',
      _readHolder: staleThenFresh,
    });

    assert.equal(r.released, false, 'a re-acquired claim must NOT be released out from under NEW');
    assert.equal(r.reason, 'raced');
    assert.equal(r.holder.sessionUuid, 'NEW', 'the disambiguation re-read reports the TRUE holder');
    assert.match(readHolder(dir, '368').body, /NEW/, "NEW's claim survives, untouched");
  } finally {
    cleanup();
  }
});

test('releaseClaim on an unheld plan is an idempotent no-op', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const r = releaseClaim(dir, '999', { force: true, sessionUuid: 'test-force' });
    assert.equal(r.released, false);
    assert.equal(r.reason, 'unheld');
  } finally {
    cleanup();
  }
});
