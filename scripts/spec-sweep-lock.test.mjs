// scripts/spec-sweep-lock.test.mjs — plan 1915. Temp bare-origin harness
// (claim-plan.test.mjs pattern): every ref push here hits a throwaway origin, never the
// real repo, so no zzz-* namespace scrubbing is needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOCK_REF,
  LEGACY_LOCK_REF,
  DEFAULT_TTL_MINUTES,
  buildLockMessage,
  parseLockMessage,
  isStale,
  readLockHolder,
  acquireLock,
  releaseLock,
  lockStatus,
  resolveOwnToken,
} from './spec-sweep-lock.mjs';
// plan 4083 fix-round: drive the identity-env-var list from the canonical resolver's
// own export instead of keeping a second hard-coded copy in this test file.
import { COORD_IDENTITY_ENV_NAMES } from './coord/coord-session-id.mjs';

// plan 338: git exports GIT_DIR / GIT_WORK_TREE / … into hook + test subprocesses,
// which OVERRIDE the `git -C <tmpdir>` repo selection and redirect these temp-repo
// ops onto the REAL repo. Clear them so every git call honours -C <tmpdir>.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// plan 4083 (ambient-environment rule, CLAUDE.md pre-land checks): CLAUDE_CODE_SESSION_ID is
// exported for real in cloud sandboxes, and spec-sweep-lock's holder-identity token now
// defaults to whichever identity var the canonical resolver (or its CLAUDE_SESSION_ID
// fallback) sees set. Left ambient, every acquireLock/releaseLock call below that omits
// `token` would silently pick up the SAME real session value, making every "two different
// identities" scenario in this file accidentally collide (both dirs would resolve to one
// token). Clear every var the module's identity resolution can read — the canonical
// resolver's own names plus CLAUDE_SESSION_ID, the one it doesn't cover — for the whole
// file. The dedicated token-source tests below set one back TEMPORARILY, in their own
// try/finally, exactly where the ambient value is the thing under test — and restore the
// sandbox's real values once this file's tests are done.
const SESSION_ID_ENV_KEYS = [...COORD_IDENTITY_ENV_NAMES, 'CLAUDE_SESSION_ID'];
const SAVED_SESSION_ENV = SESSION_ID_ENV_KEYS.map((k) => [k, process.env[k]]);
for (const k of SESSION_ID_ENV_KEYS) delete process.env[k];
after(() => {
  for (const [k, v] of SAVED_SESSION_ENV) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Temporarily set ONE session-id env var for the duration of `fn`, then restore whatever was
// there before (absent, by construction at this point in the file — see the module-level
// clear above) — the "set AND delete it themselves" half of the ambient-environment rule.
function withSessionEnv(key, value, fn) {
  const prev = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// A bare "origin" + N working clones (one per simulated cloud sandbox — the real sweeps
// never share a working tree, only origin).
function makeBareOrigin(clones = 1) {
  const origin = mkdtempSync(join(tmpdir(), 'sweeplock-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dirs = [];
  for (let i = 0; i < clones; i++) {
    const dir = mkdtempSync(join(tmpdir(), `sweeplock-work${i}-`));
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    g('remote', 'add', 'origin', origin);
    if (i === 0) {
      writeFileSync(join(dir, 'f.txt'), 'one\n');
      g('add', 'f.txt');
      g('commit', '-qm', 'init');
      g('push', '-q', 'origin', 'master');
    }
    dirs.push(dir);
  }
  return {
    origin,
    dirs,
    lsLock: () => execFileSync('git', ['ls-remote', origin, LOCK_REF], { encoding: 'utf8' }).trim(),
    cleanup: () => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

// A standalone repo (`makeBareOrigin`'s working clones) is never a LINKED worktree, so
// `isMainCheckout` reports `true` for it exactly as it would for the real shared main
// checkout — that is what makes the plain harness double as the "file-lane gate CLOSED"
// case with zero extra setup. This helper builds the OTHER shape: a main clone plus a
// real linked worktree of it (`git worktree add`), where `isMainCheckout(linked)` is
// `false` and the file lane should open.
function makeMainWithLinkedWorktree() {
  // acquireLock/releaseLock/readLockHolder all push/read against an `origin` remote
  // (coord-git's readRemoteRefCommit hard-codes it), so this harness needs a real bare
  // origin too — a linked worktree shares its main checkout's remotes, so configuring it
  // once on `main` is enough for `linked` to see it.
  const origin = mkdtempSync(join(tmpdir(), 'sweeplock-lockedwt-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const main = mkdtempSync(join(tmpdir(), 'sweeplock-mainwt-'));
  const g = (...a) => execFileSync('git', ['-C', main, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('remote', 'add', 'origin', origin);
  writeFileSync(join(main, 'f.txt'), 'one\n');
  g('add', 'f.txt');
  g('commit', '-qm', 'init');
  g('push', '-q', 'origin', 'master');
  // `linked` must be a path that does not exist yet (`git worktree add` creates it), so
  // it is a subdirectory of its own throwaway parent rather than mkdtempSync's own
  // (already-existing) directory. `cleanup()` must remove that parent too — `worktree
  // remove` only takes back `linked` itself, leaving the now-empty parent behind.
  const linkedParent = mkdtempSync(join(tmpdir(), 'sweeplock-linkedparent-'));
  const linked = join(linkedParent, 'wt');
  g('worktree', 'add', '-q', '--detach', linked);
  return {
    main,
    linked,
    cleanup: () => {
      execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', linked]);
      rmSync(linkedParent, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

const MIN = 60_000;

test('message round-trip: buildLockMessage → parseLockMessage', () => {
  const msg = buildLockMessage({
    account: 'home',
    startedAt: '2026-07-16T10:00:00.000Z',
    host: 'H',
  });
  assert.deepEqual(parseLockMessage(msg), {
    account: 'home',
    started: '2026-07-16T10:00:00.000Z',
    host: 'H',
    token: null,
  });
});

test('plan 4083: message round-trip carries a token when given one', () => {
  const msg = buildLockMessage({
    account: 'home',
    startedAt: '2026-07-16T10:00:00.000Z',
    host: 'H',
    token: 'sess-abc123',
  });
  assert.match(msg, /^token=sess-abc123$/m);
  assert.deepEqual(parseLockMessage(msg), {
    account: 'home',
    started: '2026-07-16T10:00:00.000Z',
    host: 'H',
    token: 'sess-abc123',
  });
});

test('plan 4083: a legacy (pre-token) message parses to token: null and never matches any token', () => {
  // Byte-identical to a message this module produced before plan 4083 — no token= line at all.
  const legacy = 'spec-sweep-lock account=home\nstarted=2026-07-16T10:00:00.000Z\nhost=H\n';
  const parsed = parseLockMessage(legacy);
  assert.equal(parsed.token, null);
  // The guard in acquireLock/releaseLock is `ownToken && holder.token === ownToken` — assert
  // the shape that guard depends on directly: no falsy caller token (however it is spelled)
  // may ever be judged a match against a null holder token.
  for (const ownToken of [null, undefined, '']) {
    assert.equal(Boolean(ownToken && parsed.token === ownToken), false);
  }
});

test('parseLockMessage: foreign commit message → null', () => {
  assert.equal(parseLockMessage('claim plan=365\nsession=A\n'), null);
  assert.equal(parseLockMessage(''), null);
});

test('isStale: fresh under TTL, stale at/over TTL, unparseable counts stale', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const iso = (minAgo) => new Date(now - minAgo * MIN).toISOString();
  assert.equal(isStale(iso(89), 90, now), false);
  assert.equal(isStale(iso(90), 90, now), true);
  assert.equal(isStale(iso(500), 90, now), true);
  assert.equal(isStale(null, 90, now), true);
  assert.equal(isStale('not-a-date', 90, now), true);
});

test('acquire: first firing wins and the ref exists on origin', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin();
  try {
    const r = acquireLock(dirs[0], { account: 'home' });
    assert.equal(r.won, true);
    assert.match(lsLock(), new RegExp(LOCK_REF.replace(/\//g, '\\/')));
    assert.equal(lsLock().split('\t')[0], r.sha);
  } finally {
    cleanup();
  }
});

test('acquire: a FRESH holder makes the second firing busy — holder identified, ref unchanged', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin(2);
  try {
    const first = acquireLock(dirs[0], { account: 'home' });
    const second = acquireLock(dirs[1], { account: 'vet' });
    assert.equal(first.won, true);
    assert.equal(second.won, false);
    assert.equal(second.busy, true);
    assert.equal(second.holder.account, 'home');
    assert.equal(lsLock().split('\t')[0], first.sha); // still the first winner's sha
  } finally {
    cleanup();
  }
});

test('acquire: a STALE holder (crashed sweep) is taken over; holder becomes the taker', () => {
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    const staleNow = Date.now() - 200 * MIN; // started 200 min ago, TTL 90
    const first = acquireLock(dirs[0], { account: 'home', nowMs: staleNow });
    assert.equal(first.won, true);
    const second = acquireLock(dirs[1], { account: 'vet', ttlMinutes: 90 });
    assert.equal(second.won, true);
    assert.equal(second.tookOverFrom.account, 'home');
    assert.equal(second.tookOverFrom.sha, first.sha);
    const holder = readLockHolder(dirs[0]);
    assert.equal(holder.account, 'vet');
  } finally {
    cleanup();
  }
});

test('takeover CAS: a takeover against a sha the ref no longer points at LOSES cleanly', () => {
  const { dirs, cleanup } = makeBareOrigin(3);
  try {
    // A stale holder…
    const staleNow = Date.now() - 200 * MIN;
    acquireLock(dirs[0], { account: 'home', nowMs: staleNow });
    // …taken over by vet. Simulate a third account racing the SAME takeover window by giving it a
    // long TTL so it judges vet's FRESH lock through the busy path, then assert the state
    // vet won stays intact — and that a direct second takeover (ttl 0 = everything stale)
    // resolves by CAS, not clobber: it must take over from VET's sha, never resurrect home.
    const vet = acquireLock(dirs[1], { account: 'vet' });
    assert.equal(vet.won, true);
    const thirdBusy = acquireLock(dirs[2], { account: 'acct-c', ttlMinutes: 90 });
    assert.equal(thirdBusy.busy, true);
    assert.equal(thirdBusy.holder.account, 'vet');
    const thirdForce = acquireLock(dirs[2], { account: 'acct-c', ttlMinutes: 0.0001 });
    assert.equal(thirdForce.won, true);
    assert.equal(thirdForce.tookOverFrom.sha, vet.sha);
  } finally {
    cleanup();
  }
});

test('acquire: a remote that REFUSES the create classifies as infra error (exit-4 class), never busy', () => {
  // The review-1915 F0 scenario: a proxy/permission denial on refs/coord/* must yield
  // "locking unavailable" (the sweep proceeds unlocked), NEVER "busy" (which would
  // silently skip the sweep on every no-PAT account). A pre-receive hook that declines
  // the push produces the same `! [remote rejected] … (pre-receive hook declined)`
  // shape a server-side denial does.
  const { origin, dirs, cleanup } = makeBareOrigin();
  try {
    const hook = join(origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "coord refs denied" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const r = acquireLock(dirs[0], { account: 'home' });
    assert.equal(r.won, false);
    assert.equal(r.error, true, `expected infra error, got ${JSON.stringify(r)}`);
    assert.equal(r.busy, undefined);
  } finally {
    cleanup();
  }
});

test('release: owner sha frees the lock; a second release reports absent (idempotent)', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin();
  try {
    const r = acquireLock(dirs[0], { account: 'home' });
    const rel = releaseLock(dirs[0], { sha: r.sha });
    assert.equal(rel.released, true);
    // plan 3756: releasing appends a marker instead of deleting (the proxy 403s deletes), so
    // the REF survives and only the HOLDER goes away.
    assert.notEqual(lsLock(), '', 'the ref survives the release');
    assert.equal(readLockHolder(dirs[0]), null, 'but nobody holds it');
    const again = releaseLock(dirs[0], { sha: r.sha });
    assert.equal(again.released, false);
    assert.equal(again.absent, true);
  } finally {
    cleanup();
  }
});

test('release: a NON-holder sha leaves the lock intact (expired holder returning late)', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin(2);
  try {
    const staleNow = Date.now() - 200 * MIN;
    const home = acquireLock(dirs[0], { account: 'home', nowMs: staleNow });
    const vet = acquireLock(dirs[1], { account: 'vet' }); // takeover
    assert.equal(vet.won, true);
    // home's sweep finishes late and tries to release with ITS sha — must not delete vet's lock.
    const rel = releaseLock(dirs[0], { sha: home.sha });
    assert.equal(rel.released, false);
    assert.equal(rel.notHolder, true);
    assert.equal(rel.holder.account, 'vet');
    assert.equal(lsLock().split('\t')[0], vet.sha);
  } finally {
    cleanup();
  }
});

test('release --force frees the lock regardless of sha (operator unwedge)', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin();
  try {
    acquireLock(dirs[0], { account: 'home' });
    const rel = releaseLock(dirs[0], { force: true });
    assert.equal(rel.released, true);
    assert.notEqual(lsLock(), '');
    assert.equal(readLockHolder(dirs[0]), null);
  } finally {
    cleanup();
  }
});

test('plan 3756: the lock survives MANY acquire/release cycles, not just the first', () => {
  // The failure this guards is total: a released lock keeps its ref, so a create-only acquire is
  // rejected non-ff forever and every later sweep would read "locking unavailable" and run
  // unlocked. Three rounds, because the bug shows up from the second onwards.
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    for (let i = 0; i < 3; i++) {
      const a = acquireLock(dirs[0], { account: 'home' });
      assert.equal(a.won, true, `round ${i}: acquire must win`);
      // ...and while it is held, a sibling is genuinely blocked.
      assert.equal(acquireLock(dirs[1], { account: 'vet' }).busy, true, `round ${i}: sibling busy`);
      assert.equal(releaseLock(dirs[0], { sha: a.sha }).released, true);
    }
  } finally {
    cleanup();
  }
});

test('plan 3756: a tombstone on the NEW ref does not hide a live legacy lock', () => {
  // The subtle one. Once the new ref carries a release marker it exists forever, so a
  // readLockHolder that returned null on seeing it would stop probing the retired namespace —
  // and a pre-flip sweep holding the old lock would become invisible for the rest of the
  // migration window.
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const mine = acquireLock(dirs[0], { account: 'new-sweep' });
    releaseLock(dirs[0], { sha: mine.sha }); // leaves a marker on the NEW ref
    assert.equal(readLockHolder(dirs[0]), null);

    const legacy = acquireLock(dirs[0], { account: 'old-sweep', ref: LEGACY_LOCK_REF });
    assert.equal(legacy.won, true);
    const seen = readLockHolder(dirs[0]);
    assert.ok(seen, 'the legacy holder must still be visible past the new tombstone');
    assert.equal(seen.account, 'old-sweep');
    assert.equal(seen.ref, LEGACY_LOCK_REF);
    assert.equal(acquireLock(dirs[0], { account: 'new-sweep' }).busy, true);
  } finally {
    cleanup();
  }
});

test('plan 3756: releasing acts on the ref that ANSWERED, not the one asked about', () => {
  // readLockHolder falls back to the retired namespace, so a default-ref release can be handed
  // a LEGACY holder. Releasing that with the new ref's name and strategy would leave the real
  // lock held forever.
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const legacy = acquireLock(dirs[0], { account: 'old-sweep', ref: LEGACY_LOCK_REF });
    const rel = releaseLock(dirs[0], { sha: legacy.sha });
    assert.equal(rel.released, true);
    assert.equal(readLockHolder(dirs[0], LEGACY_LOCK_REF), null, 'the legacy lock is really free');
    assert.equal(acquireLock(dirs[0], { account: 'new-sweep' }).won, true);
  } finally {
    cleanup();
  }
});

test('plan 3756: a STALE legacy lock does not block reclaiming a released new-ref husk', () => {
  // The combination that livelocked an earlier cut of this fix: the new ref carries a release
  // marker (so the create is rejected non-ff forever) AND the retired ref still has a stale
  // holder. Reading the holder through the dual-namespace fallback and skipping the round on a
  // legacy answer meant the husk was never reclaimed and every sweep reported "locking
  // unavailable". A stale legacy lock is not an obstacle to anything.
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const first = acquireLock(dirs[0], { account: 'new-sweep' });
    releaseLock(dirs[0], { sha: first.sha }); // new ref is now a husk
    acquireLock(dirs[0], {
      account: 'crashed-old-sweep',
      ref: LEGACY_LOCK_REF,
      nowMs: Date.now() - 200 * MIN, // stale
    });

    const got = acquireLock(dirs[0], { account: 'new-sweep' });
    assert.equal(got.won, true, 'must reclaim the husk despite the stale legacy lock');
    assert.equal(readLockHolder(dirs[0]).account, 'new-sweep');
  } finally {
    cleanup();
  }
});

test('plan 3756: a live LEGACY lock blocks a new-namespace acquire', () => {
  // A pre-flip sweep holds refs/coord/spec-sweep-lock and cannot see the branch-shaped ref, so
  // the new code has to yield or two sweeps run the board at once.
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const legacy = acquireLock(dirs[0], { account: 'old-sweep', ref: LEGACY_LOCK_REF });
    assert.equal(legacy.won, true);
    const mine = acquireLock(dirs[0], { account: 'new-sweep' });
    assert.equal(mine.won, false, 'must not win over a live legacy lock');
    assert.equal(mine.busy, true);
    assert.equal(mine.holder.account, 'old-sweep');
  } finally {
    cleanup();
  }
});

test('acquire after release wins again (solo regime: the lock never blocks without a sibling)', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const a = acquireLock(dirs[0], { account: 'home' });
    releaseLock(dirs[0], { sha: a.sha });
    const b = acquireLock(dirs[0], { account: 'home' });
    assert.equal(b.won, true);
    assert.notEqual(b.sha, a.sha); // a fresh parentless commit each firing
  } finally {
    cleanup();
  }
});

test('status: unheld → held:false; held → holder fields + age + staleness', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    assert.deepEqual(lockStatus(dirs[0]), { held: false });
    const startedNow = Date.now() - 30 * MIN;
    acquireLock(dirs[0], { account: 'home', nowMs: startedNow });
    const s = lockStatus(dirs[0]);
    assert.equal(s.held, true);
    assert.equal(s.account, 'home');
    assert.equal(s.stale, false);
    assert.ok(s.ageMinutes >= 29 && s.ageMinutes <= 31, `ageMinutes=${s.ageMinutes}`);
    const stale = lockStatus(dirs[0], { ttlMinutes: 10 });
    assert.equal(stale.stale, true);
  } finally {
    cleanup();
  }
});

// --- plan 4083: holder-identity token — idempotent re-acquire + token-keyed release -----

test('plan 4083: two acquireLock calls under ONE token (same session, different processes) — the second is a win, not busy', () => {
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    // Two SEPARATE working dirs (as the real incident had: one Bash call's acquire, then a
    // second acquire from the same cloud session that never saw the first's output) sharing
    // one identity token, exactly as two processes of the same run would.
    const first = acquireLock(dirs[0], { account: 'home', token: 'sess-2026-09-20-vet' });
    assert.equal(first.won, true);
    assert.equal(first.reacquired, undefined);
    const second = acquireLock(dirs[1], { account: 'home', token: 'sess-2026-09-20-vet' });
    assert.equal(second.won, true, 'must win, never busy, on our own live lock');
    assert.equal(second.reacquired, true);
    assert.equal(
      second.sha,
      first.sha,
      'the sha handed back is the HELD lock, for a later release --sha',
    );
  } finally {
    cleanup();
  }
});

test('plan 4083: a concurrent acquire under a DIFFERENT token still gets busy', () => {
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    const first = acquireLock(dirs[0], { account: 'home', token: 'sess-AAA' });
    assert.equal(first.won, true);
    const second = acquireLock(dirs[1], { account: 'vet', token: 'sess-BBB' });
    assert.equal(second.won, false);
    assert.equal(second.busy, true);
    assert.equal(second.reacquired, undefined);
    assert.equal(second.holder.account, 'home');
  } finally {
    cleanup();
  }
});

test('plan 4083: release with no --sha succeeds when the holder token is our own', () => {
  const { dirs, lsLock, cleanup } = makeBareOrigin();
  try {
    acquireLock(dirs[0], { account: 'home', token: 'sess-CCC' });
    const rel = releaseLock(dirs[0], { token: 'sess-CCC' }); // no sha at all
    assert.equal(rel.released, true);
    assert.notEqual(lsLock(), '', 'the ref survives the release (tombstone, plan 3756)');
    assert.equal(readLockHolder(dirs[0]), null, 'but nobody holds it');
  } finally {
    cleanup();
  }
});

test('plan 4083: release with no --sha and a DIFFERENT token is refused, naming the holder', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const a = acquireLock(dirs[0], { account: 'home', token: 'sess-DDD' });
    const rel = releaseLock(dirs[0], { token: 'sess-EEE' }); // wrong identity, no sha
    assert.equal(rel.released, false);
    assert.equal(rel.notHolder, true);
    assert.equal(rel.holder.account, 'home');
    assert.equal(rel.holder.sha, a.sha);
  } finally {
    cleanup();
  }
});

test('plan 4083: the --sha CAS release path is UNCHANGED even when a token is present', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    // A holder that DOES carry a token, released the ORIGINAL way (by sha) with no token
    // passed to release at all — must behave exactly like the pre-4083 sha-only contract.
    const a = acquireLock(dirs[0], { account: 'home', token: 'sess-FFF' });
    const rel = releaseLock(dirs[0], { sha: a.sha });
    assert.equal(rel.released, true);
    assert.equal(readLockHolder(dirs[0]), null);
    // …and a WRONG sha is still refused even though the token would have matched — sha, when
    // given, is the ground truth, never overridden by a token side-channel.
    const b = acquireLock(dirs[0], { account: 'home', token: 'sess-GGG' });
    const wrongSha = releaseLock(dirs[0], { sha: 'deadbeef', token: 'sess-GGG' });
    assert.equal(wrongSha.released, false);
    assert.equal(wrongSha.notHolder, true);
    assert.equal(readLockHolder(dirs[0]).sha, b.sha, 'the real lock is untouched');
  } finally {
    cleanup();
  }
});

test('plan 4083: the 2026-09-20 incident shape replayed — acquire, ignore the result, acquire again, release with NO --sha ends RELEASED', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const token = 'cse_01TGYfXmfpQQnLGswUjg2xAo';
    acquireLock(dirs[0], { account: 'vm', token }); // 18:03:44Z — result never seen
    const second = acquireLock(dirs[0], { account: 'vm', token }); // 18:03:58Z — the re-run
    assert.equal(
      second.won,
      true,
      'the incident session must win here instead of reading a sibling',
    );
    assert.equal(second.reacquired, true);
    const rel = releaseLock(dirs[0], { token }); // no --sha in hand, exactly like the incident
    assert.equal(rel.released, true);
    assert.equal(readLockHolder(dirs[0]), null, 'ends RELEASED, not held for the rest of the TTL');
  } finally {
    cleanup();
  }
});

test('plan 4083: a live LEGACY (token-less) holder never false-matches a caller token — mixed-version contention stays busy', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    // A pre-4083 sweep's lock message carries no `token=` line at all — parseLockMessage
    // gives it `token: null`. A post-4083 caller with a REAL token must still see busy, never
    // a false self-match (failure mode (ii) in the plan's execution notes).
    acquireLock(dirs[0], { account: 'old-sweep' }); // no token option → legacy-shaped message
    assert.equal(readLockHolder(dirs[0]).token, null);
    const mine = acquireLock(dirs[0], { account: 'new-sweep', token: 'sess-HHH' });
    assert.equal(mine.won, false);
    assert.equal(mine.busy, true);
    assert.equal(mine.reacquired, undefined);
  } finally {
    cleanup();
  }
});

test('plan 4083 regression guard: with no env token and the file-lane gate CLOSED, acquire/release behave byte-identically to today', () => {
  // makeBareOrigin's working clones are plain `git init` repos, never linked worktrees, so
  // isMainCheckout() reports `true` for them — exactly the "shared main checkout" gate-closed
  // case — with zero extra setup. Combined with the module-level session-env clear at the top
  // of this file, neither identity lane yields a token here.
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    assert.equal(resolveOwnToken(dirs[0]).token, null, 'file lane must be closed on this shape');
    const first = acquireLock(dirs[0], { account: 'home' });
    assert.equal(first.won, true);
    const second = acquireLock(dirs[1], { account: 'vet' });
    assert.equal(second.won, false);
    assert.equal(second.busy, true, 'never a self-match when no identity resolves at all');
    assert.equal(second.reacquired, undefined);
    assert.throws(
      () => releaseLock(dirs[0], {}),
      /release needs --sha/,
      'no sha, no token anywhere — the pre-4083 throw survives verbatim',
    );
  } finally {
    cleanup();
  }
});

// --- plan 4083: resolveOwnToken — the one made judgment call ----------------------------

test('plan 4083: resolveOwnToken prefers an env session id over the file lane, on any checkout shape', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    withSessionEnv('CLAUDE_CODE_SESSION_ID', 'env-wins', () => {
      assert.equal(resolveOwnToken(dirs[0]).token, 'env-wins');
    });
    withSessionEnv('CLAUDE_SESSION_ID', 'env-wins-2', () => {
      assert.equal(resolveOwnToken(dirs[0]).token, 'env-wins-2');
    });
    withSessionEnv('GROK_SESSION_ID', 'env-wins-3', () => {
      assert.equal(resolveOwnToken(dirs[0]).token, 'env-wins-3');
    });
  } finally {
    cleanup();
  }
});

test('plan 4083: resolveOwnToken closes the file lane on the shared main checkout (no env token)', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const r = resolveOwnToken(dirs[0]);
    assert.equal(r.token, null);
    assert.equal(r.persist, false);
  } finally {
    cleanup();
  }
});

test('plan 4083: resolveOwnToken opens the file lane off the shared main checkout, and persists across calls', () => {
  const { linked, cleanup } = makeMainWithLinkedWorktree();
  try {
    const before = resolveOwnToken(linked);
    assert.ok(before.token, 'a fresh token is minted when the file lane is open and empty');
    assert.equal(
      before.persist,
      true,
      'nothing cached yet — this call must persist it once it wins',
    );

    // A real acquire resolves (and, on a win, persists) its OWN token internally — not
    // `before.token` above, which was only a preview never written to disk. Standing in for
    // "a different process, same checkout" is the point of the file lane in the first place.
    const acquired = acquireLock(linked, { account: 'home' });
    assert.equal(acquired.won, true);

    const onDiskPath = join(linked, '.scratch', 'spec-sweep-lock-token.json');
    const onDisk = JSON.parse(readFileSync(onDiskPath, 'utf8'));
    assert.ok(onDisk.token, 'the winning acquire persisted a token to .scratch/');
    assert.equal(
      readLockHolder(linked).token,
      onDisk.token,
      'the live lock carries the persisted token',
    );

    const after = resolveOwnToken(linked);
    assert.equal(
      after.token,
      onDisk.token,
      'a later process in the same checkout reuses the persisted token',
    );
    assert.equal(after.persist, false, 'already on disk — nothing left to persist');
  } finally {
    cleanup();
  }
});

// --- plan 4083 fix-round: canonical coordination-identity resolver integration ---------

test('plan 4083 fix-round: COORD_SESSION_ID (the canonical override) wins over CLAUDE_CODE_SESSION_ID', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    withSessionEnv('CLAUDE_CODE_SESSION_ID', 'claude-should-lose', () => {
      withSessionEnv('COORD_SESSION_ID', 'coord-override-wins', () => {
        assert.equal(resolveOwnToken(dirs[0]).token, 'coord-override-wins');
      });
    });
  } finally {
    cleanup();
  }
});

test('plan 4083 fix-round: CLAUDE_SESSION_ID alone resolves via the fallback (the canonical resolver does not cover this var)', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    withSessionEnv('CLAUDE_SESSION_ID', 'legacy-only-token', () => {
      assert.equal(resolveOwnToken(dirs[0]).token, 'legacy-only-token');
    });
  } finally {
    cleanup();
  }
});

test('plan 4083 fix-round: two disagreeing native identity vars degrade to no token, and acquire/release never throw', () => {
  // coordinationSessionId() throws on this shape (ambiguous native identity). Every
  // caller here must degrade to today's busy behaviour instead of letting that escape —
  // the whole point of wrapping it in envSessionToken()'s try/catch.
  const { dirs, cleanup } = makeBareOrigin(2);
  try {
    withSessionEnv('CLAUDE_CODE_SESSION_ID', 'claude-value', () => {
      withSessionEnv('GROK_SESSION_ID', 'grok-value-different', () => {
        let resolved;
        assert.doesNotThrow(() => {
          resolved = resolveOwnToken(dirs[0]);
        });
        assert.equal(
          resolved.token,
          null,
          'ambiguous native identity degrades to no token, not a throw',
        );

        let first;
        assert.doesNotThrow(() => {
          first = acquireLock(dirs[0], { account: 'home' });
        });
        assert.equal(first.won, true);

        let second;
        assert.doesNotThrow(() => {
          second = acquireLock(dirs[1], { account: 'vet' });
        });
        assert.equal(second.won, false);
        assert.equal(
          second.busy,
          true,
          "no identity resolves, so today's busy behaviour — never a self-match, never a throw",
        );
        assert.equal(second.reacquired, undefined);

        assert.doesNotThrow(() => releaseLock(dirs[0], { sha: first.sha }));
      });
    });
  } finally {
    cleanup();
  }
});

test('plan 4083 fix-round round 2: ambiguous native identity is NOT rescued by CLAUDE_SESSION_ID — the ambiguity refusal wins', () => {
  // Regression guard for round-1's defect (a): catching coordinationSessionId()'s
  // ambiguity throw and then falling back to CLAUDE_SESSION_ID anyway would let an
  // ambiguous identity still yield a token — the exact failure mode this mutex exists
  // to prevent (two runs could each believe the live lock is their own and both
  // proceed). A throw must degrade straight to no token, with CLAUDE_SESSION_ID never
  // consulted at all.
  const { dirs, cleanup } = makeBareOrigin();
  try {
    withSessionEnv('CLAUDE_CODE_SESSION_ID', 'claude-value', () => {
      withSessionEnv('GROK_SESSION_ID', 'grok-value-different', () => {
        withSessionEnv('CLAUDE_SESSION_ID', 'should-never-be-used', () => {
          assert.equal(
            resolveOwnToken(dirs[0]).token,
            null,
            'the CLAUDE_SESSION_ID fallback must not rescue an ambiguous native identity',
          );
        });
      });
    });
  } finally {
    cleanup();
  }
});

test('plan 4083 fix-round round 2: a malformed CLAUDE_SESSION_ID (whitespace or control chars) is rejected, never reaches buildLockMessage', () => {
  const { dirs, cleanup } = makeBareOrigin();
  try {
    const bad = [
      'abc\nstarted=2099-01-01T00:00:00.000Z', // newline — would corrupt the key=value lock message
      'abc def', // plain space
      'abc\u0007def', // control character (BEL)
    ];
    for (const value of bad) {
      withSessionEnv('CLAUDE_SESSION_ID', value, () => {
        assert.equal(
          resolveOwnToken(dirs[0]).token,
          null,
          `must reject CLAUDE_SESSION_ID=${JSON.stringify(value)}`,
        );
        // End-to-end: an acquire under this env must never let the malformed value reach
        // the pushed lock message.
        const r = acquireLock(dirs[0], { account: 'home' });
        assert.equal(r.won, true);
        assert.equal(
          readLockHolder(dirs[0]).token,
          null,
          'a malformed CLAUDE_SESSION_ID must never be handed to buildLockMessage',
        );
        releaseLock(dirs[0], { sha: r.sha });
      });
    }
  } finally {
    cleanup();
  }
});

test('plan 4083 review round 3: an identity REFUSAL beats the file lane — no token is minted past it', () => {
  // The round-2 ambiguity guard above runs against a plain clone, where isMainCheckout()
  // is already true and the file lane is shut regardless — so it cannot see this hole.
  // A LINKED WORKTREE is the one harness where the file lane is genuinely OPEN, which is
  // exactly where collapsing "refused" and "absent" into one null let resolveOwnToken
  // mint a fresh token for an ambiguous-identity run, re-opening on the file side the
  // hole round 2 closed on the env side.
  const { linked, cleanup } = makeMainWithLinkedWorktree();
  try {
    // Control: with no identity configured at all, the file lane IS open here — so a
    // null below proves the refusal, not merely a closed lane.
    assert.ok(
      resolveOwnToken(linked).token,
      'precondition: the file lane must be open on a linked worktree',
    );

    withSessionEnv('CLAUDE_CODE_SESSION_ID', 'claude-value', () => {
      withSessionEnv('GROK_SESSION_ID', 'grok-value-different', () => {
        const r = resolveOwnToken(linked);
        assert.equal(r.token, null, 'an ambiguous native identity must not mint a file token');
        assert.equal(r.persist, false, 'and nothing may be queued for persistence');
      });
    });

    // A SET-but-malformed CLAUDE_SESSION_ID is a refusal too (readId() throws on one),
    // so it must not fall through to the file lane either.
    withSessionEnv('CLAUDE_SESSION_ID', 'has space', () => {
      assert.equal(
        resolveOwnToken(linked).token,
        null,
        'a malformed CLAUDE_SESSION_ID must not mint a file token',
      );
    });
  } finally {
    cleanup();
  }
});

test('default TTL is 90 minutes (the plan-1915 sizing: > a long sweep, < the 2 h cycle)', () => {
  assert.equal(DEFAULT_TTL_MINUTES, 90);
});
