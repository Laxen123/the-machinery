// scripts/queue-heartbeat-ref.test.mjs (plan 2603)
// New test FILE — justified as the name-pair of the new scripts/coord/queue-heartbeat-ref.mjs
// module (plan 2530 growth valve: a genuinely new scripts/<name>.mjs module earns its own
// name-paired test file). Covers the module in isolation: slug-safety, the stamp
// encode/decode grammar, and — via a real bare origin + two clones (same harness shape as
// landing-queue.test.mjs's makeOriginAndClones) — the cross-clone visibility and
// fail-closed-on-unreadable-origin properties the whole ref-transport design rests on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HEARTBEAT_REF_PREFIX,
  HEARTBEAT_FETCH_REFSPEC,
  heartbeatRefFor,
  encodeStamp,
  decodeStamp,
  readLocalHeartbeatRef,
  writeHeartbeatRef,
  deleteHeartbeatRef,
  readHeartbeatRefs,
} from './queue-heartbeat-ref.mjs';

// plan 338 (mirrors landing-queue.test.mjs): clear inherited GIT_* so temp-repo git ops
// honour cwd, not the real repo.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

// Same shape as landing-queue.test.mjs's makeOriginAndClones: a real bare origin plus two
// independent clones (A, B) — this module's whole reason to exist is a cross-HOST channel,
// so its tests must exercise a real second clone, not just a single local repo.
function makeOriginAndClones() {
  const root = mkdtempSync(join(tmpdir(), 'queue-heartbeat-ref-test-'));
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  const clone = (name) => {
    const dir = join(root, name);
    execFileSync('git', ['clone', '-q', origin, dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', `${name}@t.t`]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', name]);
    return dir;
  };
  const A = clone('A');
  writeFileSync(join(A, 'base.txt'), 'base\n');
  execFileSync('git', ['-C', A, 'add', '-A']);
  execFileSync('git', ['-C', A, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', A, 'push', '-q', 'origin', 'master']);
  const B = clone('B');
  return { root, origin, A, B, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

// ── heartbeatRefFor: slug-safety ────────────────────────────────────────────────────
test('heartbeatRefFor: a real slug produces refs/coord/queue-heartbeat/<slug>', () => {
  assert.equal(heartbeatRefFor('2603-fable-thing'), `${HEARTBEAT_REF_PREFIX}2603-fable-thing`);
});

test('heartbeatRefFor: throws on a slug carrying a space, a leading -, .., a /, or a non-string', () => {
  // a space would break a bare `git ...` refname
  assert.throws(() => heartbeatRefFor('foo bar'), /unsafe slug/);
  // a leading - could be parsed as a flag by a naive git invocation
  assert.throws(() => heartbeatRefFor('-foo'), /unsafe slug/);
  // .. is a git refname path-traversal construct
  assert.throws(() => heartbeatRefFor('foo..bar'), /unsafe slug/);
  // a / would nest a namespace level the caller never asked for
  assert.throws(() => heartbeatRefFor('foo/bar'), /unsafe slug/);
  // non-string callers (a stray object/number) must be rejected, not coerced
  assert.throws(() => heartbeatRefFor(42), /unsafe slug/);
  assert.throws(() => heartbeatRefFor(null), /unsafe slug/);
  assert.throws(() => heartbeatRefFor(undefined), /unsafe slug/);
});

// ── encodeStamp / decodeStamp ────────────────────────────────────────────────────────
test('encodeStamp/decodeStamp round-trip, including progressIso: null', () => {
  const ts = '2026-07-30T12:00:00.000Z';
  assert.deepEqual(decodeStamp(encodeStamp({ ts, progressIso: null })), { ts, progressIso: null });
  const progressIso = '2026-07-30T11:55:00.000Z';
  assert.deepEqual(decodeStamp(encodeStamp({ ts, progressIso })), { ts, progressIso });
  // progressIso omitted entirely defaults to null on the encode side too
  assert.deepEqual(decodeStamp(encodeStamp({ ts })), { ts, progressIso: null });
});

test('decodeStamp returns null on non-JSON, on JSON lacking ts, and on a non-string ts', () => {
  assert.equal(decodeStamp('not json at all'), null);
  assert.equal(decodeStamp('{}'), null, 'JSON with no ts field');
  assert.equal(decodeStamp(JSON.stringify({ progressIso: null })), null, 'ts entirely absent');
  assert.equal(decodeStamp(JSON.stringify({ ts: 12345 })), null, 'ts is a number, not a string');
  assert.equal(decodeStamp(JSON.stringify({ ts: null })), null, 'ts is null');
  assert.equal(decodeStamp('null'), null, 'JSON.parse succeeds but yields a non-object');
});

// ── writeHeartbeatRef + readHeartbeatRefs: the cross-clone visibility property ──────
test('writeHeartbeatRef then readHeartbeatRefs from a SECOND clone sees the stamp (the whole design rests on this)', () => {
  const s = makeOriginAndClones();
  try {
    const ts = '2026-07-30T12:00:00.000Z';
    writeHeartbeatRef(s.A, 'my-slug', { ts, progressIso: null });
    // Assert from B, not A — A already has the ref locally from writing it; the property
    // that matters is that a DIFFERENT session (a different host, in production) can read
    // it back off origin.
    const read = readHeartbeatRefs(s.B);
    assert.equal(read.ok, true);
    assert.deepEqual(read.map['my-slug'], { ts, progressIso: null });
  } finally {
    s.cleanup();
  }
});

test('writeHeartbeatRef: a later write with progressIso: null CARRIES FORWARD the previously-stamped progressIso', () => {
  const s = makeOriginAndClones();
  try {
    const t1 = '2026-07-30T12:00:00.000Z';
    const progressIso = '2026-07-30T11:55:00.000Z';
    writeHeartbeatRef(s.A, 'my-slug', { ts: t1, progressIso });
    // the common case — a flagless liveness ping — passes progressIso: null (or omits it),
    // and must NOT blank out the progress stamp a --progress heartbeat wrote earlier.
    const t2 = '2026-07-30T12:05:00.000Z';
    writeHeartbeatRef(s.A, 'my-slug', { ts: t2, progressIso: null });
    const read = readHeartbeatRefs(s.B);
    assert.deepEqual(
      read.map['my-slug'],
      { ts: t2, progressIso },
      'a flagless re-write must carry the original progressIso forward, not null it out',
    );
  } finally {
    s.cleanup();
  }
});

test('readLocalHeartbeatRef reads the LOCAL ref without a fetch (no stamp yet -> null)', () => {
  const s = makeOriginAndClones();
  try {
    assert.equal(readLocalHeartbeatRef(s.A, 'never-written'), null);
    const ts = '2026-07-30T12:00:00.000Z';
    writeHeartbeatRef(s.A, 'my-slug', { ts, progressIso: null });
    assert.deepEqual(readLocalHeartbeatRef(s.A, 'my-slug'), { ts, progressIso: null });
  } finally {
    s.cleanup();
  }
});

// ── deleteHeartbeatRef ───────────────────────────────────────────────────────────────
// NOTE on the assertion shape below: a plain `git fetch` of a forced (`+src:dst`) refspec
// does NOT prune a ref that vanished upstream from a clone that already fetched it once —
// only `--prune` does, and neither readHeartbeatRefs nor readFresh's fetch passes that
// flag (by design: the module header says a leftover LOCAL ref is harmless, since
// decorateWithHeartbeatRefs's enqueuedIso guard is what makes a stale stamp inert, not the
// ref's disappearance). So "B no longer sees it" is proven against a FRESH clone C that
// never held the ref locally (its first-ever fetch reflects origin's current state
// faithfully) — checking a clone that already has the stale local ref would test a git
// fetch/prune nuance, not this module's contract.
test('deleteHeartbeatRef removes the ref from origin (a FRESH second clone no longer sees it after a re-read)', () => {
  const s = makeOriginAndClones();
  try {
    const ts = '2026-07-30T12:00:00.000Z';
    writeHeartbeatRef(s.A, 'my-slug', { ts, progressIso: null });
    // confirm it landed on origin itself, not just A's local ref
    assert.match(
      git(s.origin, ['for-each-ref', '--format=%(refname)', HEARTBEAT_REF_PREFIX]),
      /my-slug/,
    );
    deleteHeartbeatRef(s.A, 'my-slug');
    assert.equal(
      git(s.origin, ['for-each-ref', '--format=%(refname)', HEARTBEAT_REF_PREFIX]).trim(),
      '',
      'the ref must be gone from origin itself after delete',
    );
    // a brand-new clone that has NEVER fetched this ref before sees a namespace with
    // nothing in it — the true cross-session view of "this slug's ref is gone".
    const C = join(s.root, 'C');
    execFileSync('git', ['clone', '-q', s.origin, C]);
    const after = readHeartbeatRefs(C);
    assert.equal(after.ok, true);
    assert.ok(!('my-slug' in after.map), 'a fresh clone must not see the deleted ref');
  } finally {
    s.cleanup();
  }
});

test('deleteHeartbeatRef returns without throwing when the ref does not exist', () => {
  const s = makeOriginAndClones();
  try {
    assert.doesNotThrow(() => deleteHeartbeatRef(s.A, 'never-written-at-all'));
  } finally {
    s.cleanup();
  }
});

// ── readHeartbeatRefs: fail-closed on an unreadable origin ──────────────────────────
test('readHeartbeatRefs on a repo whose origin is unreachable returns {ok:false} with an empty map (fail-closed)', () => {
  const root = mkdtempSync(join(tmpdir(), 'queue-heartbeat-ref-bogus-'));
  try {
    const dir = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'master', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'x@t.t']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'x']);
    // a plausible-looking but nonexistent remote — the fetch this triggers must fail
    execFileSync('git', [
      '-C',
      dir,
      'remote',
      'add',
      'origin',
      join(root, 'nonexistent-origin.git'),
    ]);
    const read = readHeartbeatRefs(dir);
    assert.equal(
      read.ok,
      false,
      'an unfetchable origin must fail CLOSED, not read an empty map cheerfully',
    );
    assert.deepEqual(read.map, {});
    assert.match(read.error, /fetch failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readHeartbeatRefs: {ok:true, map:{}} (origin fine, no stamps yet) is distinguishable from the {ok:false} failure case', () => {
  const s = makeOriginAndClones();
  try {
    // B has never written or fetched any stamp — the namespace is genuinely empty, not
    // unreadable. This must read as a NORMAL state, not an error.
    const read = readHeartbeatRefs(s.B);
    assert.equal(read.ok, true);
    assert.deepEqual(read.map, {});
    assert.equal(read.error, undefined, 'a healthy empty read must carry no error field at all');
  } finally {
    s.cleanup();
  }
});

// ── readHeartbeatRefs: one corrupt ref must not sink the whole read ─────────────────
test('readHeartbeatRefs: a ref whose subject is undecodable is DROPPED, other slugs still read', () => {
  const s = makeOriginAndClones();
  try {
    // a genuinely valid stamp for one slug
    writeHeartbeatRef(s.A, 'good-slug', { ts: '2026-07-30T12:00:00.000Z', progressIso: null });
    // hand-craft a malformed ref for a second slug — bypassing writeHeartbeatRef/encodeStamp
    // entirely, so the commit subject is plain garbage rather than JSON.
    const tree = execFileSync('git', ['-C', s.A, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['-C', s.A, 'commit-tree', tree, '-m', 'this is not json'], {
      encoding: 'utf8',
    }).trim();
    const badRef = `${HEARTBEAT_REF_PREFIX}bad-slug`;
    git(s.A, ['update-ref', badRef, commit]);
    git(s.A, ['push', '-q', 'origin', `${commit}:${badRef}`]);

    const read = readHeartbeatRefs(s.B);
    assert.equal(read.ok, true, 'one corrupt ref must not fail-close the whole namespace read');
    assert.ok('good-slug' in read.map, 'the OTHER slug must still be present');
    assert.ok(
      !('bad-slug' in read.map),
      'the undecodable stamp must be dropped, not surfaced as garbage',
    );
  } finally {
    s.cleanup();
  }
});

// sanity: the fetch refspec exported for readFresh to fold into its own `git fetch` is the
// forced, double-glob shape the module's own header comment promises (a slug re-enqueued
// after a delete must still overwrite the local ref, hence `+`).
test('HEARTBEAT_FETCH_REFSPEC is the forced glob refspec for the whole namespace', () => {
  assert.equal(HEARTBEAT_FETCH_REFSPEC, `+${HEARTBEAT_REF_PREFIX}*:${HEARTBEAT_REF_PREFIX}*`);
});
