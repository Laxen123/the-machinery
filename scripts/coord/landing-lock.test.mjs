// scripts/landing-lock.test.mjs — unit tests for the same-PC LANDING mutex
// (plan 234), scope-aware since plan 1300. Pure verdict/parse logic + fs
// acquire/release against an injectable temp path (no resolveMain / no real
// .git needed).
//
// Ownership is by SLUG, staleness by AGE — NOT pid (each CLI invocation is a
// fresh short-lived process, so the holder pid is always dead by the next
// command; pid-liveness can't discriminate ownership/staleness for a CLI lock).
// Contention is by SCOPE (plan 1300): global overlaps everything; clinic shard
// sets contend only on a non-empty intersection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanGitEnv } from '../test-helpers/clean-git-env.mjs';
import { trackedMkdtempSync } from '../test-helpers/tracked-tmpdir.mjs';
import {
  ageMinutes,
  parseRegistry,
  parseLockArgs,
  normalizeScope,
  scopesOverlap,
  scopeLabel,
  registryVerdict,
  acquireAt,
  releaseAt,
  readHolders,
  runAcquireLoop,
  resolveLockPath,
} from './landing-lock.mjs';

const ISO = '2026-05-31T10:00:00.000Z';
const now = (min) => Date.parse(ISO) + min * 60000;
const isoAt = (min) => new Date(now(min)).toISOString();

function tmpLock() {
  const dir = mkdtempSync(join(tmpdir(), 'landing-lock-'));
  return join(dir, 'landing-lock.json');
}

// --- ageMinutes -------------------------------------------------------------
test('ageMinutes: whole minutes since iso; clamps ≥0; null on unparseable', () => {
  assert.equal(ageMinutes(ISO, now(40)), 40);
  assert.equal(ageMinutes(ISO, now(0)), 0);
  assert.equal(ageMinutes(ISO, now(-5)), 0);
  assert.equal(ageMinutes('not-a-date', now(10)), null);
});

// --- parseRegistry ------------------------------------------------------------
test('parseRegistry: v2 shape → holder array; legacy single-holder → one entry', () => {
  const v2 = `{"v":2,"holders":[{"slug":"a","pid":1,"host":"h","iso":"${ISO}"}]}`;
  assert.equal(parseRegistry(v2).length, 1);
  assert.equal(parseRegistry(v2)[0].slug, 'a');
  // Legacy (pre-1300) single-holder record still parses — rollout compatibility.
  const legacy = `{"slug":"x","pid":7,"host":"h","iso":"${ISO}"}`;
  assert.deepEqual(parseRegistry(legacy), [{ slug: 'x', pid: 7, host: 'h', iso: ISO }]);
  assert.equal(parseRegistry('not json'), null);
  assert.equal(parseRegistry(''), null);
});

// --- parseLockArgs (boolean-aware) ------------------------------------------
test('parseLockArgs: boolean flags become true even at end-of-args', () => {
  const a = parseLockArgs(['acquire', 'my-slug', '--force-stale', '--wait']);
  assert.equal(a.cmd, 'acquire');
  assert.deepEqual(a.positionals, ['my-slug']);
  assert.equal(a.flags['force-stale'], true);
  assert.equal(a.flags.wait, true);
});
test('parseLockArgs: value flags still consume their value; booleans do not', () => {
  const a = parseLockArgs([
    'acquire',
    's',
    '--stale-min',
    '10',
    '--wait',
    '--scope',
    '{"global":true}',
  ]);
  assert.equal(a.flags['stale-min'], '10');
  assert.equal(a.flags.wait, true);
  assert.equal(a.flags.scope, '{"global":true}');
});
test('parseLockArgs: release --force at end registers as true', () => {
  const a = parseLockArgs(['release', 's', '--force']);
  assert.equal(a.flags.force, true);
});
// plan 1777 strictness pin: the old loop silently consumed an unknown `--x y` as a value
// pair; the spec'd parseFlags wrapper refuses it loudly (a typo'd flag must never be data).
test('parseLockArgs: unknown flag throws loudly under the default landing-lock spec', () => {
  assert.throws(
    () => parseLockArgs(['acquire', 's', '--waitt']),
    /landing-lock: unknown flag --waitt/,
  );
});
// plan 1777 review [4]: the shared subcommand mode peels LEADING booleans before the cmd,
// so a boolean-first invocation resolves the real subcommand instead of cmd='--force'.
test('parseLockArgs: a leading boolean flag does not displace the subcommand', () => {
  const a = parseLockArgs(['--force', 'release', 's']);
  assert.equal(a.cmd, 'release');
  assert.deepEqual(a.positionals, ['s']);
  assert.equal(a.flags.force, true);
});

// --- scopes -------------------------------------------------------------------
test('normalizeScope: null/undefined → global (the conservative pre-1300 meaning)', () => {
  assert.deepEqual(normalizeScope(null), { global: true });
  assert.deepEqual(normalizeScope(undefined), { global: true });
  assert.deepEqual(normalizeScope({ global: true }), { global: true });
});
test('normalizeScope: clinic sets dedupe + sort; empty set escalates to global', () => {
  assert.deepEqual(normalizeScope({ clinics: ['clinic-2', 'clinic-1', 'clinic-2'] }), {
    clinics: ['clinic-1', 'clinic-2'],
  });
  assert.deepEqual(normalizeScope({ clinics: [] }), { global: true });
});
test('normalizeScope: malformed shapes throw (a caller bug must not silently unlock)', () => {
  assert.throws(() => normalizeScope('global'));
  assert.throws(() => normalizeScope({ clinics: [42] }));
});
test('scopesOverlap: global contends with everything; sets contend on intersection', () => {
  assert.equal(scopesOverlap({ global: true }, { clinics: ['clinic-1'] }), true);
  assert.equal(scopesOverlap({ clinics: ['clinic-1'] }, { global: true }), true);
  assert.equal(scopesOverlap({ clinics: ['clinic-1'] }, { clinics: ['clinic-2'] }), false);
  assert.equal(
    scopesOverlap({ clinics: ['clinic-1', 'clinic-3'] }, { clinics: ['clinic-3'] }),
    true,
  );
  // A holder record with no scope (pre-1300 rollout) reads as global.
  assert.equal(scopesOverlap(undefined, { clinics: ['clinic-9'] }), true);
});
test('scopeLabel: global / comma-joined clinics', () => {
  assert.equal(scopeLabel({ global: true }), 'global');
  assert.equal(scopeLabel({ clinics: ['clinic-1', 'clinic-2'] }), 'clinic-1,clinic-2');
});

// --- registryVerdict (pure decision) -------------------------------------------
const GLOBAL = { global: true };
const holderAt = (slug, iso, scope = GLOBAL) => ({ slug, pid: 200, host: 'PC1', iso, scope });
const base = { slug: 'me', scope: GLOBAL, nowMs: now(50), staleMin: 35 };

test('registryVerdict: empty registry → ACQUIRE', () => {
  assert.equal(registryVerdict({ ...base, holders: [] }).action, 'ACQUIRE');
});
test('registryVerdict: own slug (any pid) with no other blocker → REENTRANT', () => {
  const holders = [holderAt('me', ISO)];
  assert.equal(registryVerdict({ ...base, holders }).action, 'REENTRANT');
});
test('registryVerdict: overlapping young holder → BUSY', () => {
  const holders = [holderAt('other', ISO)];
  const v = registryVerdict({ ...base, holders, nowMs: now(10) });
  assert.equal(v.action, 'BUSY');
  assert.equal(v.ageMin, 10);
});
test('registryVerdict: overlapping holder older than staleMin → STALE', () => {
  const holders = [holderAt('other', ISO)];
  const v = registryVerdict({ ...base, holders, nowMs: now(50) });
  assert.equal(v.action, 'STALE');
  assert.equal(v.ageMin, 50);
  assert.equal(v.staleHolders.length, 1);
});
test('registryVerdict: overlapping holder with unparseable iso → STALE (cannot prove healthy)', () => {
  const holders = [holderAt('other', 'bad')];
  assert.equal(registryVerdict({ ...base, holders }).action, 'STALE');
});
test('registryVerdict: DISJOINT clinic scopes do NOT contend (plan 1300 narrowing)', () => {
  const holders = [holderAt('other', ISO, { clinics: ['clinic-2'] })];
  const v = registryVerdict({ ...base, scope: { clinics: ['clinic-1'] }, holders, nowMs: now(10) });
  assert.equal(v.action, 'ACQUIRE');
});
test('registryVerdict: SAME-clinic scopes still serialize', () => {
  const holders = [holderAt('other', ISO, { clinics: ['clinic-1', 'clinic-9'] })];
  const v = registryVerdict({ ...base, scope: { clinics: ['clinic-1'] }, holders, nowMs: now(10) });
  assert.equal(v.action, 'BUSY');
});
test('registryVerdict: a GLOBAL acquire contends with a clinic-scoped holder (and vice versa)', () => {
  const holders = [holderAt('other', ISO, { clinics: ['clinic-1'] })];
  assert.equal(registryVerdict({ ...base, scope: GLOBAL, holders, nowMs: now(10) }).action, 'BUSY');
});
test('registryVerdict: BUSY reports the FRESHEST overlapping holder; STALE only when ALL blockers stale', () => {
  const holders = [holderAt('old', ISO), holderAt('young', isoAt(45))];
  const v = registryVerdict({ ...base, holders, nowMs: now(50) });
  assert.equal(v.action, 'BUSY'); // young (5m) is fresh even though old (50m) is stale
  assert.equal(v.holder.slug, 'young');
});
test('registryVerdict: REENTRANT with a WIDENED scope is still overlap-checked against others', () => {
  // Our own entry exists, but the new scope now overlaps a fresh sibling → BUSY, not REENTRANT.
  const holders = [
    holderAt('me', ISO, { clinics: ['clinic-1'] }),
    holderAt('other', isoAt(45), { clinics: ['clinic-2'] }),
  ];
  const v = registryVerdict({
    ...base,
    scope: { clinics: ['clinic-1', 'clinic-2'] },
    holders,
    nowMs: now(50),
  });
  assert.equal(v.action, 'BUSY');
});

// --- readHolders: transient read errors (plan 1678 batch review finding [0]/round-3) ----------
test('readHolders: a non-ENOENT read error (EISDIR) PROPAGATES — never silently free, never routed through the corrupt/STALE sentinel', () => {
  // Full rationale in readHolders' own doc comment (scripts/landing-lock.mjs) — kept in one place
  // rather than restated here to avoid the two copies drifting apart.
  const p = tmpLock();
  mkdirSync(p);
  assert.throws(() => readHolders(p), /EISDIR/);
});

test('acquireAt: a transient read error on an EXISTING registry propagates (never silently ACQUIREs, never classified as corrupt/STALE)', () => {
  const p = tmpLock();
  mkdirSync(p);
  assert.throws(
    () => acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO }),
    /EISDIR/,
    'never a silent ACQUIRE, and never silently reclassified as a corrupt/STALE registry',
  );
});

// --- acquireAt / releaseAt (fs) --------------------------------------------
test('acquireAt: fresh path → ACQUIRE, writes v2 registry with the scope', () => {
  const p = tmpLock();
  const r = acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO, scope: GLOBAL });
  assert.equal(r.action, 'ACQUIRE');
  const holders = readHolders(p);
  assert.equal(holders.length, 1);
  assert.deepEqual(holders[0], { slug: 'me', pid: 100, host: 'PC1', iso: ISO, scope: GLOBAL });
});
test('acquireAt: re-acquire same slug from a DIFFERENT pid → REENTRANT, entry refreshed', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
  const r = acquireAt(p, { slug: 'me', pid: 555, host: 'PC1', nowIso: isoAt(1) });
  assert.equal(r.action, 'REENTRANT');
  assert.equal(readHolders(p).length, 1);
  assert.equal(readHolders(p)[0].pid, 555);
});
test('acquireAt: held by another slug (young, overlapping) → BUSY, registry untouched', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'other', pid: 200, host: 'PC1', nowIso: ISO });
  const r = acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: isoAt(5) });
  assert.equal(r.action, 'BUSY');
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['other'],
  );
});
test('acquireAt: TWO disjoint clinic-scoped holders coexist (plan 1300)', () => {
  const p = tmpLock();
  const a = acquireAt(p, {
    slug: 'plan-a',
    pid: 1,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-1'] },
  });
  const b = acquireAt(p, {
    slug: 'plan-b',
    pid: 2,
    host: 'PC1',
    nowIso: isoAt(1),
    scope: { clinics: ['clinic-2'] },
  });
  assert.equal(a.action, 'ACQUIRE');
  assert.equal(b.action, 'ACQUIRE');
  assert.deepEqual(
    readHolders(p)
      .map((h) => h.slug)
      .sort(),
    ['plan-a', 'plan-b'],
  );
  // …and a third acquire overlapping ONE of them blocks on exactly that one.
  const c = acquireAt(p, {
    slug: 'plan-c',
    pid: 3,
    host: 'PC1',
    nowIso: isoAt(2),
    scope: { clinics: ['clinic-2', 'clinic-3'] },
  });
  assert.equal(c.action, 'BUSY');
  assert.equal(c.holder.slug, 'plan-b');
});
test('acquireAt: stale holder WITHOUT --force-stale → STALE, not stolen', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'other', pid: 200, host: 'PC1', nowIso: ISO });
  const r = acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: isoAt(50) });
  assert.equal(r.action, 'STALE');
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['other'],
  ); // surfaced, NOT auto-stolen
});
test('acquireAt: stale + forceStale → RECLAIMED, holder replaced', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'stale-one', pid: 200, host: 'PC1', nowIso: ISO });
  const r = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(50),
    forceStale: true,
    scope: GLOBAL,
  });
  assert.equal(r.action, 'RECLAIMED');
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['me'],
  );
});
test('acquireAt: force-stale evicts only the stale OVERLAPPING blocker, never a disjoint entry', () => {
  const p = tmpLock();
  // A stale clinic-1 holder and a stale clinic-7 holder; our clinic-1 acquire with
  // forceStale evicts the clinic-1 blocker but must leave the DISJOINT clinic-7
  // entry in place (its land is not ours to reclaim).
  acquireAt(p, {
    slug: 'stale-c1',
    pid: 1,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-1'] },
  });
  acquireAt(p, {
    slug: 'stale-c7',
    pid: 2,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-7'] },
  });
  const r = acquireAt(p, {
    slug: 'me',
    pid: 3,
    host: 'PC1',
    nowIso: isoAt(50),
    forceStale: true,
    scope: { clinics: ['clinic-1'] },
  });
  assert.equal(r.action, 'RECLAIMED');
  assert.deepEqual(
    readHolders(p)
      .map((h) => h.slug)
      .sort(),
    ['me', 'stale-c7'],
  );
});
test('acquireAt: corrupt lock file WITHOUT force → STALE (surface), not stolen', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'x', pid: 1, host: 'PC1', nowIso: ISO });
  writeFileSync(p, 'corrupt{');
  // F-019: the corrupt file's real (wall-clock) mtime is irrelevant to this synthetic-ISO suite —
  // pin its AGE via the injected _statMs so the test is deterministic regardless of when it runs.
  // An OLD corrupt file (well past staleMin) must still surface STALE, unchanged from before.
  const r = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    _statMs: () => now(-40),
  });
  assert.equal(r.action, 'STALE');
});

test('acquireAt: F-019 — a FRESH corrupt/empty registry (the writeRegistry in-flight window) → BUSY, not STALE', () => {
  const p = tmpLock();
  writeFileSync(p, ''); // the create-then-content-write window a sibling's writeRegistry can leave
  const r = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    _statMs: () => now(1), // the file's mtime reads as the SAME moment as nowIso — fresh
  });
  assert.equal(r.action, 'BUSY', 'a fresh corrupt file is presumed an in-flight write, not stale');
});

test('acquireAt: F-019 — an OLD corrupt registry still requires --force-stale to reclaim', () => {
  const p = tmpLock();
  writeFileSync(p, 'corrupt{');
  const stale = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    _statMs: () => now(-40),
  });
  assert.equal(stale.action, 'STALE');
  const reclaimed = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    forceStale: true,
    _statMs: () => now(-40),
  });
  assert.equal(reclaimed.action, 'RECLAIMED');
});

test('acquireAt: F-019 — an unstattable corrupt file (age unknown) stays conservative — STALE, not BUSY', () => {
  const p = tmpLock();
  writeFileSync(p, 'corrupt{');
  const r = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    _statMs: () => {
      throw new Error('stat failed');
    },
  });
  assert.equal(r.action, 'STALE', 'an unknown age must never be optimistically treated as fresh');
});

// plan 1398 (item 4) — corruptFileAgeMinutes's clamp mirrors coord-git's shared clampedAgeMs
// formula (the same helper acquireCoordLock uses) rather than importing it — see the source
// comment for why (this file is byte-identical-synced to tandapp, whose own independent
// coord-git.mjs doesn't export clampedAgeMs). A corrupt file whose mtime reads slightly in the
// FUTURE relative to nowIso (clock skew) must still floor to age 0 — fresh, not stale.
test('acquireAt: F-019 — a future-dated corrupt file (clock skew) floors to age 0 → BUSY, not STALE', () => {
  const p = tmpLock();
  writeFileSync(p, 'corrupt{');
  const r = acquireAt(p, {
    slug: 'me',
    pid: 100,
    host: 'PC1',
    nowIso: isoAt(1),
    _statMs: () => now(5), // mtime reads 4 min AHEAD of nowIso — clock skew, not staleness
  });
  assert.equal(r.action, 'BUSY', 'a future mtime must floor to age 0, never read as stale');
});

test('releaseAt: held by my slug (different pid) → RELEASED — survives across processes', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
  const r = releaseAt(p, { slug: 'me' }); // no pid — ownership is slug-only
  assert.equal(r.action, 'RELEASED');
  assert.equal(existsSync(p), false); // last holder out unlinks the registry
});
test('releaseAt: releasing ONE of two disjoint holders keeps the other', () => {
  const p = tmpLock();
  acquireAt(p, {
    slug: 'plan-a',
    pid: 1,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-1'] },
  });
  acquireAt(p, {
    slug: 'plan-b',
    pid: 2,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-2'] },
  });
  const r = releaseAt(p, { slug: 'plan-a' });
  assert.equal(r.action, 'RELEASED');
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['plan-b'],
  );
});
test('releaseAt: missing file → idempotent NOOP (never throws)', () => {
  assert.equal(releaseAt(tmpLock(), { slug: 'me' }).action, 'NOOP');
});
test('releaseAt: a non-ENOENT read error on an EXISTING registry propagates (never silently NOOP/FOREIGN, never a --force whole-registry wipe)', () => {
  // The CLI `release` command catches this at its own boundary and exits 0 with the registry
  // UNTOUCHED (its documented invariant: "release always exits 0 — idempotent close-out must
  // never block a push") — but releaseAt() itself must never silently guess at ownership it
  // can't verify by reading.
  const p = tmpLock();
  mkdirSync(p);
  assert.throws(() => releaseAt(p, { slug: 'me', force: true }), /EISDIR/);
});
test('releaseAt: --force on a slug matching NO holder → NOT_FOUND, registry untouched (plan-1300 review)', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'real-holder', pid: 200, host: 'PC1', nowIso: ISO });
  const r = releaseAt(p, { slug: 'mistyped-slug', force: true });
  assert.equal(r.action, 'NOT_FOUND'); // NOT the reassuring NOOP — an operator recovery must see the truth
  assert.deepEqual(
    (r.holders || []).map((h) => h.slug),
    ['real-holder'],
  );
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['real-holder'], // untouched
  );
});
test('releaseAt: held only by ANOTHER slug → FOREIGN, registry kept', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'other', pid: 200, host: 'PC1', nowIso: ISO });
  const r = releaseAt(p, { slug: 'me' });
  assert.equal(r.action, 'FOREIGN');
  assert.ok(existsSync(p));
});
test('releaseAt: --force removes the NAMED holder only (targeted stranded-lock reclaim)', () => {
  const p = tmpLock();
  acquireAt(p, {
    slug: 'stranded',
    pid: 200,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-9'] },
  });
  acquireAt(p, {
    slug: 'live',
    pid: 300,
    host: 'PC1',
    nowIso: ISO,
    scope: { clinics: ['clinic-1'] },
  });
  const r = releaseAt(p, { slug: 'stranded', force: true });
  assert.equal(r.action, 'RELEASED');
  assert.deepEqual(
    readHolders(p).map((h) => h.slug),
    ['live'],
  );
});
test('releaseAt: --force clears a corrupt registry whole', () => {
  const p = tmpLock();
  writeFileSync(p, 'corrupt{');
  const r = releaseAt(p, { slug: 'me', force: true });
  assert.equal(r.action, 'RELEASED');
  assert.equal(existsSync(p), false);
});

// --- runAcquireLoop: --wait retry through a transient read error (plan 1703) --
//
// Deterministic harness — a fake clock the fake sleep advances (no real AV
// timing, no real sleeping), a scripted _acquireAt, and captured output. The
// loop under test is the REAL exported CLI loop main() delegates to.
function loopHarness({ acquireResults, timeoutSec = 30, pollSec = 3, lockPath, ...opts }) {
  const clock = { t: 0 };
  const calls = { acquires: 0, sleeps: 0 };
  const out = { log: [], err: [] };
  const run = () =>
    runAcquireLoop({
      lockPath: lockPath ?? tmpLock(), // lazy — only mkdtemp when the caller didn't supply one
      slug: 'me',
      scope: null,
      wait: false,
      timeoutSec,
      pollSec,
      pid: 1,
      host: 'PC1',
      _nowIso: () => ISO,
      _now: () => clock.t,
      _sleep: (ms) => {
        calls.sleeps++;
        clock.t += ms;
      },
      _acquireAt: (lockPath, args) => {
        const step = acquireResults[Math.min(calls.acquires++, acquireResults.length - 1)];
        if (typeof step === 'function') return step(lockPath, args);
        if (step instanceof Error) throw step;
        return step;
      },
      log: (m) => out.log.push(m),
      logError: (m) => out.err.push(m),
      ...opts,
    });
  return { run, clock, calls, out };
}
const fsError = (code) => Object.assign(new Error(`${code}: transient read glitch`), { code });

test('runAcquireLoop: --wait retries through a transient read error and acquires once the glitch clears', () => {
  const h = loopHarness({
    wait: true,
    acquireResults: [fsError('EACCES'), fsError('EBUSY'), { action: 'ACQUIRE' }],
  });
  assert.equal(h.run(), 0);
  assert.equal(h.calls.acquires, 3);
  assert.equal(h.calls.sleeps, 2); // one poll-sleep per transient glitch, same cadence as BUSY
  assert.match(h.out.err.join('\n'), /transient registry read error \(EACCES\)/);
  assert.match(h.out.log.join('\n'), /^ACQUIRE me /);
});

test('runAcquireLoop: a non-wait caller fails closed IMMEDIATELY on the same error (propagates → exit 5), unchanged', () => {
  const h = loopHarness({ wait: false, acquireResults: [fsError('EACCES')] });
  assert.throws(h.run, /EACCES/);
  assert.equal(h.calls.acquires, 1); // never retried
  assert.equal(h.calls.sleeps, 0);
});

test('runAcquireLoop: the "registry mutex wedged" throw (plain Error, no .code) surfaces immediately even under --wait, never retried', () => {
  const wedged = new Error('landing-lock: registry mutex wedged at /x — inspect and remove it');
  const h = loopHarness({ wait: true, acquireResults: [wedged] });
  assert.throws(h.run, /registry mutex wedged/);
  assert.equal(h.calls.acquires, 1); // the attempt-1 bug: a broad retry-on-any-exception would have swallowed this
  assert.equal(h.calls.sleeps, 0);
});

test('runAcquireLoop: deadline exhaustion with the registry still unreadable fails CLOSED (throws the fs error — exit 5), never BUSY exit 2', () => {
  const h = loopHarness({
    wait: true,
    timeoutSec: 10,
    pollSec: 6,
    acquireResults: [fsError('EBUSY')], // persists on every attempt
  });
  assert.throws(h.run, /EBUSY/);
  // t=0 retry (sleep→6000), t=6000 retry (sleep→12000), t=12000 ≥ deadline(10000) → throw.
  assert.equal(h.calls.acquires, 3);
  assert.match(
    h.out.err.join('\n'),
    /--wait window exhausted .* failing CLOSED, no acquire recorded/,
  );
});

test('runAcquireLoop: a non-finite/negative staleMin, timeoutSec, or pollSec throws BEFORE the first attempt (exit 5) — NaN must never warp the STALE age check or disable the --wait deadline', () => {
  for (const bad of [{ timeoutSec: NaN }, { staleMin: NaN }]) {
    const h = loopHarness({ wait: true, acquireResults: [{ action: 'ACQUIRE' }], ...bad });
    assert.throws(h.run, /expected a non-negative number/);
    assert.equal(h.calls.acquires, 0); // validated up front, never reaches acquireAt
  }
  // pollSec is stricter — 0 would busy-loop the shared registry for the whole --wait window.
  for (const bad of [{ pollSec: 0 }, { pollSec: NaN }, { pollSec: -1 }]) {
    const h = loopHarness({ wait: true, acquireResults: [{ action: 'ACQUIRE' }], ...bad });
    assert.throws(h.run, /expected a positive number/);
    assert.equal(h.calls.acquires, 0);
  }
});

test('runAcquireLoop: transient path never reaches STALE/--force-stale — a real unreadable registry with forceStale set propagates untouched', () => {
  // Real acquireAt + a directory as the lock path (EISDIR — the same deterministic injection the
  // readHolders/acquireAt propagation tests use). Even with forceStale, the loop must throw the
  // fs error (attempt-2 bug: the null/corrupt sentinel would have made this a RECLAIMED wipe).
  const p = tmpLock();
  mkdirSync(p);
  const h = loopHarness({
    lockPath: p,
    wait: true,
    forceStale: true,
    timeoutSec: 5,
    pollSec: 6, // first sleep already passes the deadline → second attempt throws
    acquireResults: [acquireAt], // the seam calls step(lockPath, args) — acquireAt's own signature
  });
  assert.throws(h.run, /EISDIR/);
  assert.ok(existsSync(p)); // registry path untouched — no --force-stale whole-registry wipe
  assert.ok(
    !h.out.err.join('\n').includes('STALE'),
    'STALE branch must be unreachable via this path',
  );
});

test('runAcquireLoop: ordinary BUSY contention behavior is unchanged (non-wait exit 2; --wait times out at exit 2)', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'other', pid: 9, host: 'PC1', nowIso: ISO }); // fresh global holder
  const real = [acquireAt];
  const immediate = loopHarness({ lockPath: p, wait: false, acquireResults: real });
  assert.equal(immediate.run(), 2);
  assert.equal(immediate.calls.sleeps, 0);
  assert.match(immediate.out.err.join('\n'), /^BUSY — landing lock held by other /);
  const waited = loopHarness({
    lockPath: p,
    wait: true,
    timeoutSec: 10,
    pollSec: 6,
    acquireResults: real,
  });
  assert.equal(waited.run(), 2);
  assert.ok(waited.calls.sleeps > 0);
  assert.match(waited.out.err.join('\n'), /Timed out after 10s\./);
});

// --- writeRegistry: atomic replace (plan 1733) --------------------------------
// writeRegistry is internal — exercised through acquireAt/releaseAt, whose every
// registry mutation routes through it. The hazard being closed: the pre-1733
// writeFileSync opened with O_TRUNC, so a mid-write fs error left the registry
// TRUNCATED — readHolders would classify it via the corrupt (null) sentinel and
// the CLI would offer --force-stale (a whole-registry wipe) against holders that
// were healthy one write earlier.

test('writeRegistry: successful write is byte-identical to the pre-1733 format (no schema change)', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO, scope: GLOBAL });
  assert.equal(
    readFileSync(p, 'utf8'),
    JSON.stringify({
      v: 2,
      holders: [{ slug: 'me', pid: 100, host: 'PC1', iso: ISO, scope: { global: true } }],
    }),
  );
});

test('writeRegistry: an injected mid-write failure leaves the previous registry fully intact', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
  const before = readFileSync(p, 'utf8');
  // A directory squatting on THIS process's temp path makes openSync(tmp, 'w') throw — a
  // deterministic stand-in for the AV/EIO/disk-full class, striking at the point where the old
  // code had ALREADY truncated the registry. Fresh mtime, so the age-gated orphan SWEEP leaves it
  // alone — it's the error-path rmSync that must clean it up.
  const tmp = `${p}.tmp.${process.pid}`;
  mkdirSync(tmp);
  assert.throws(
    () => acquireAt(p, { slug: 'me', pid: 555, host: 'PC1', nowIso: isoAt(1) }), // REENTRANT refresh → writeRegistry
    (e) => typeof e.code === 'string', // propagates fail-closed, exactly like the old direct-write error
  );
  assert.equal(readFileSync(p, 'utf8'), before); // never truncated
  assert.equal(readHolders(p).length, 1); // still parseable — never the corrupt (null) sentinel
  // The error-path cleanup removed the squatter (rmSync handles directories too — review 1733
  // [1]): the SAME pid's next write is not wedged.
  assert.equal(existsSync(tmp), false);
  const retry = acquireAt(p, { slug: 'me', pid: 555, host: 'PC1', nowIso: isoAt(1) });
  assert.equal(retry.action, 'REENTRANT');
});

test('writeRegistry: no orphaned temp files accumulate across repeated acquire/release cycles', () => {
  const p = tmpLock();
  for (let i = 0; i < 5; i++) {
    // Two disjoint clinic scopes → acquire/acquire/release/release exercises the single-holder
    // write, the multi-holder rewrite, the shrink rewrite, AND the empty-registry unlink.
    acquireAt(p, {
      slug: 'a',
      pid: 1,
      host: 'PC1',
      nowIso: isoAt(i),
      scope: { clinics: ['clinic-1'] },
    });
    acquireAt(p, {
      slug: 'b',
      pid: 2,
      host: 'PC1',
      nowIso: isoAt(i),
      scope: { clinics: ['clinic-2'] },
    });
    releaseAt(p, { slug: 'a' });
    releaseAt(p, { slug: 'b' });
  }
  assert.equal(existsSync(p), false); // fully released
  assert.deepEqual(
    readdirSync(dirname(p)).filter((n) => n.includes('.tmp.')),
    [],
  );
});

test('writeRegistry: a stale orphaned temp is reaped on the next write; a fresh one is left alone', () => {
  const p = tmpLock();
  const stale = `${p}.tmp.11111`;
  const fresh = `${p}.tmp.22222`;
  writeFileSync(stale, 'orphan');
  const past = (Date.now() - 120_000) / 1000; // older than the 60s MUTEX_STALE_MS threshold
  utimesSync(stale, past, past);
  writeFileSync(fresh, 'in-flight');
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO }); // any registry write sweeps
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

// Plan-1733 constraint: rename-over-existing semantics verified on a REAL file. A read-only
// target (chmod 444 maps to the Windows read-only attribute) makes MoveFileEx +
// MOVEFILE_REPLACE_EXISTING fail ACCESS_DENIED — the closest deterministic stand-in for an
// AV-held target. On POSIX the rename over a read-only file legally SUCCEEDS (directory
// permissions govern), so this failure-mode test is win32-only.
test(
  'writeRegistry: rename onto a locked (read-only) target throws but leaves the OLD registry intact (win32)',
  { skip: process.platform !== 'win32' },
  () => {
    const p = tmpLock();
    acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
    const before = readFileSync(p, 'utf8');
    chmodSync(p, 0o444);
    try {
      assert.throws(
        () => acquireAt(p, { slug: 'me', pid: 555, host: 'PC1', nowIso: isoAt(1) }),
        (e) => typeof e.code === 'string',
      );
      assert.equal(readFileSync(p, 'utf8'), before);
    } finally {
      chmodSync(p, 0o666);
    }
    // the failed writer cleaned up its own temp on the error path
    assert.deepEqual(
      readdirSync(dirname(p)).filter((n) => n.includes('.tmp.')),
      [],
    );
  },
);

test('writeRegistry: a STALE squatter DIRECTORY at a temp path is reaped (rmSync) and the write proceeds', () => {
  const p = tmpLock();
  // The review-1733 [1] wedge: a directory at THIS pid's temp path would survive unlinkSync
  // forever and fail every later openSync from the same pid. The age-gated sweep must rm it.
  const squatter = `${p}.tmp.${process.pid}`;
  mkdirSync(squatter);
  const past = (Date.now() - 120_000) / 1000;
  utimesSync(squatter, past, past);
  const r = acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
  assert.equal(r.action, 'ACQUIRE');
  assert.equal(existsSync(squatter), false);
  assert.equal(readHolders(p).length, 1);
});

test('writeRegistry: the release-to-zero write also sweeps a stale orphan (no early-return skip)', () => {
  const p = tmpLock();
  acquireAt(p, { slug: 'me', pid: 100, host: 'PC1', nowIso: ISO });
  // Plant the orphan AFTER the acquire — the only remaining write on this path is the terminal
  // release-to-zero, which pre-review-1733-[2] skipped the sweep entirely.
  const stale = `${p}.tmp.33333`;
  writeFileSync(stale, 'orphan');
  const past = (Date.now() - 120_000) / 1000;
  utimesSync(stale, past, past);
  const r = releaseAt(p, { slug: 'me' });
  assert.equal(r.action, 'RELEASED');
  assert.equal(existsSync(p), false);
  assert.equal(existsSync(stale), false);
});

// --- lock path resolution (plan 2478) -------------------------------------
// resolveLockPath() used to resolve the common dir via coord-git's UNSCRUBBED git() helper —
// this test pins the plan-2478 convergence (adopts the GIT_*-scrub from lock-path.mjs while
// keeping the resolveMain() anchor): a poisoned GIT_DIR must never redirect it to a foreign repo.
test('resolveLockPath: GIT_*-scrubbed, anchored at resolveMain() — a poisoned GIT_DIR is ignored', () => {
  const trackedMkdtemp = trackedMkdtempSync();
  const repo = trackedMkdtemp(join(tmpdir(), 'landing-lock-main-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: cleanGitEnv() });
  const foreign = trackedMkdtemp(join(tmpdir(), 'landing-lock-foreign-'));
  execFileSync('git', ['init', '-q'], { cwd: foreign, env: cleanGitEnv() });

  const priorMain = process.env.COORD_MAIN_DIR;
  const priorGitDir = process.env.GIT_DIR;
  process.env.COORD_MAIN_DIR = repo; // resolveMain() override — short-circuits the master-branch assert
  process.env.GIT_DIR = join(foreign, '.git');
  try {
    const p = resolveLockPath();
    assert.equal(
      p.replaceAll('\\', '/'),
      join(repo, '.git', 'landing-lock.json').replaceAll('\\', '/'),
    );
  } finally {
    if (priorMain === undefined) delete process.env.COORD_MAIN_DIR;
    else process.env.COORD_MAIN_DIR = priorMain;
    if (priorGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = priorGitDir;
  }
});
