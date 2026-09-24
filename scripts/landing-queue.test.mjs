// scripts/landing-queue.test.mjs (plan 504)
// Integration: the landing-queue CLI against a real bare origin + two clones
// (two parallel sessions). Proves the done-criteria queue semantics:
//   - FIFO ordering survives a moving master (push order = queue order, zero leapfrog)
//   - dequeue promotes the next waiter; enqueue is idempotent (position retained)
//   - a fresh head refuses a steal; a stale head is stolen WITH an audit line
//   - every queue-doc commit carries the Coord-Write trailer (lint-guard food)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// plan 3459: the pinned-snapshot seam. `groundTruthSource`/`pruneAllLanded` are exported for
// exactly one reason — the pinning property (an answer that is a function of the SHA alone)
// can only be asserted by building two sources at two known commits over one unchanged tree.
import { parseQueueArgs, groundTruthSource, pruneAllLanded } from './landing-queue.mjs';
// plan 2603: HEARTBEAT_REF_PREFIX is the only extra thing these integration tests need
// from the new module — everything else is exercised through the CLI (`lq`) exactly like
// every other verb in this file.
import { HEARTBEAT_REF_PREFIX } from './coord/queue-heartbeat-ref.mjs';
// plan 3973: the queue doc lives on the coord ref; these tests read it back the way the accessor
// does (fetch by explicit refspec, show the doc at the tracking ref's tip) and write a RAW doc
// the way an older CLI or a hand edit would (a child commit pushed onto the ref).
import {
  QUEUE_REF,
  QUEUE_REF_LOCAL,
  QUEUE_FETCH_REFSPEC,
  QUEUE_DOC_NAME,
} from './coord/landing-queue-ref.mjs';
// plan 3000: the operator-override's PURE surface (the reason normalizer and the two
// now-disjoint audit counters) is asserted directly — the rest of the override rides the
// CLI like every other verb here.
import {
  normalizeOverrideReason,
  OVERRIDE_REASON_MAX,
  parseAuditLine,
  demoteAuditCount,
  operatorDemoteAuditCount,
  applyDemote,
  OPERATOR_AXIS,
  deadLandVerdict,
  IN_LAND_STATE,
  DEFAULT_DEMOTE_STALE_MIN,
} from './coord/landing-queue-lib.mjs';
// plan 3000 review fix: the land-duration reader is the OTHER production consumer of the
// audit grammar, so its knowledge of the new verb is pinned here beside the writer's.
import { parseQueueAudit } from './land-duration-lib.mjs';
// plan 3459 (review): the board/queue paths are CONFIG, never hard-coded in a fixture.
import { loadCoordConfig } from './coord/coord-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'landing-queue.mjs');
const LOCK_CLI = join(HERE, 'landing-lock.mjs');
const BOARD_CLI = join(HERE, 'board.mjs');

// --- parseQueueArgs (plan 1777: spec'd wrapper over coord-git parseFlags) ------------------
// The old hand-rolled loop had no direct pins; these hold the surface the spine relies on
// (done-worktree passes --lane/--host/--note/--json) plus the new loud unknown-flag refusal.
test('parseQueueArgs: cmd + positionals + value and boolean flags', () => {
  const a = parseQueueArgs(['enqueue', 's1', '--lane', 'seed', '--host', 'PC', '--json']);
  assert.equal(a.cmd, 'enqueue');
  assert.deepEqual(a.positionals, ['s1']);
  assert.deepEqual(a.flags, { lane: 'seed', host: 'PC', json: true });
});
test('parseQueueArgs: booleans register true at end-of-args; unknown flag throws loudly', () => {
  const a = parseQueueArgs(['steal', 's1', '--stale-min', '45', '--confirm-holder-gone']);
  assert.equal(a.flags['stale-min'], '45');
  assert.equal(a.flags['confirm-holder-gone'], true);
  assert.throws(
    () => parseQueueArgs(['enqueue', 's1', '--lan', 'seed']),
    /landing-queue: unknown flag --lan/,
  );
});

// plan 338: clear inherited GIT_* so temp-repo git ops honour cwd, not the real repo.
for (const k of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
])
  delete process.env[k];

function makeOriginAndClones() {
  const root = mkdtempSync(join(tmpdir(), 'landing-queue-test-'));
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
  // plan 989: ignore the disposable coord-checkout (withCoordCheckout creates .claude/coord-worktree
  // under a clone) so `git add -A` here never sweeps it — mirrors the real repo's .gitignore.
  writeFileSync(join(A, '.gitignore'), '.claude/\n');
  execFileSync('git', ['-C', A, 'add', '-A']);
  execFileSync('git', ['-C', A, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', A, 'push', '-q', 'origin', 'master']);
  const B = clone('B');
  return { root, origin, A, B, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The queue doc as origin holds it (plan 3973): fetch the ref, show the doc at its tip.
function queueDocOnOrigin(cloneDir) {
  execFileSync('git', ['-C', cloneDir, 'fetch', '-q', 'origin', QUEUE_FETCH_REFSPEC]);
  return execFileSync('git', ['-C', cloneDir, 'show', `${QUEUE_REF_LOCAL}:${QUEUE_DOC_NAME}`], {
    encoding: 'utf8',
  });
}
// Push a RAW doc onto the ref as a child of its current tip — the shape a hand edit / an older
// CLI leaves behind, bypassing every CLI-side guard (the mirror of the old `git add + commit +
// push origin master` of the master-doc era).
function writeRawQueueDocOnOrigin(cloneDir, text, message = 'raw queue doc') {
  const g = (args, opts = {}) =>
    execFileSync('git', ['-C', cloneDir, ...args], { encoding: 'utf8', ...opts }).trim();
  g(['fetch', '-q', 'origin', QUEUE_FETCH_REFSPEC]);
  const parent = g(['rev-parse', '--verify', QUEUE_REF_LOCAL]);
  const blob = g(['hash-object', '-w', '--stdin'], { input: text });
  const tree = g(['mktree'], { input: `100644 blob ${blob}\t${QUEUE_DOC_NAME}\n` });
  const commit = g(['commit-tree', tree, '-p', parent, '-m', message]);
  g(['push', '-q', 'origin', `${commit}:${QUEUE_REF}`]);
  g(['update-ref', QUEUE_REF_LOCAL, commit]);
  return commit;
}

// Run the CLI from `cwd` (a clone, on master → resolveMain() resolves that clone).
function lq(cwd, args, env = {}) {
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
const lqJson = (cwd, args, env) => JSON.parse(lq(cwd, [...args, '--json'], env));

// Simulate a land archiving its plan: commit plans/archive/<slug>.md + push.
// After this, slugIsLanded(clone, slug) is true for any clone freshened to origin.
function archivePlan(cloneDir, slug) {
  // plan 989: a coord op (lq enqueue) now pushes via the disposable coord-checkout, so cloneDir's
  // own local master falls behind origin — re-sync before this DIRECT push or it is non-ff.
  execFileSync('git', ['-C', cloneDir, 'pull', '-q', '--rebase', 'origin', 'master']);
  const dir = join(cloneDir, 'docs', 'superpowers', 'plans', 'archive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), `# ${slug}\n`);
  execFileSync('git', ['-C', cloneDir, 'add', '-A']);
  execFileSync('git', ['-C', cloneDir, 'commit', '-qm', `archive ${slug}`]);
  execFileSync('git', ['-C', cloneDir, 'push', '-q', 'origin', 'master']);
}

// Simulate a batch land: write the claim manifest (claim-plan.mjs batch), or delete it
// (done-worktree.mjs closeOutBatch's SAME-commit manifest delete). Mirrors archivePlan's
// pattern above but for the batch ground truth (manifest presence, not plans/archive/<slug>.md
// — a batch slug never has one). plan 1467: the manifest moved to
// docs/superpowers/batches/<slug>/manifest.json; `where` selects the new folder path
// (default) or the legacy docs/handoff/batches/<slug>.json (a grandfathered in-flight batch)
// so the dual-read ground truth is exercised on both.
function manifestRelFor(slug, where) {
  return where === 'legacy'
    ? `docs/handoff/batches/${slug}.json`
    : `docs/superpowers/batches/${slug}/manifest.json`;
}
function writeBatchManifest(cloneDir, slug, where = 'new') {
  execFileSync('git', ['-C', cloneDir, 'pull', '-q', '--rebase', 'origin', 'master']);
  const rel = manifestRelFor(slug, where);
  const abs = join(cloneDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify({ slug, members: ['1', '2'] }));
  execFileSync('git', ['-C', cloneDir, 'add', '-A']);
  execFileSync('git', ['-C', cloneDir, 'commit', '-qm', `batch claim ${slug}`]);
  execFileSync('git', ['-C', cloneDir, 'push', '-q', 'origin', 'master']);
}
function removeBatchManifest(cloneDir, slug, where = 'new') {
  execFileSync('git', ['-C', cloneDir, 'pull', '-q', '--rebase', 'origin', 'master']);
  execFileSync('git', ['-C', cloneDir, 'rm', '-q', manifestRelFor(slug, where)]);
  execFileSync('git', ['-C', cloneDir, 'commit', '-qm', `batch close-out ${slug}`]);
  execFileSync('git', ['-C', cloneDir, 'push', '-q', 'origin', 'master']);
}

function movingMaster(s, n) {
  // an unrelated sibling push between queue ops — the "moving master" the queue must survive
  execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
  writeFileSync(join(s.A, `noise-${n}.txt`), `${n}\n`);
  execFileSync('git', ['-C', s.A, 'add', '-A']);
  execFileSync('git', ['-C', s.A, 'commit', '-qm', `noise-${n}`]);
  execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
}

test('FIFO across two clones against a moving master; idempotent re-enqueue; dequeue promotes', () => {
  const s = makeOriginAndClones();
  try {
    // A enqueues a 🟥 lander
    lq(s.A, ['enqueue', 'seed-alpha', '--lane', 'seed', '--session', '431', '--host', 'PC-A']);
    // master moves under everyone
    movingMaster(s, 1);
    // B (a different session/PC) enqueues a 🟩 lander — must land BEHIND alpha
    lq(s.B, ['enqueue', 'free-beta', '--lane', 'free', '--session', '432', '--host', 'PC-B']);
    movingMaster(s, 2);
    // and a third waiter from A
    lq(s.A, ['enqueue', 'seed-gamma', '--lane', 'seed', '--session', '433', '--host', 'PC-A']);

    // both clones agree on the order — zero leapfrog
    for (const dir of [s.A, s.B]) {
      const st = lqJson(dir, ['status']);
      assert.deepEqual(
        st.entries.map((e) => e.slug),
        ['seed-alpha', 'free-beta', 'seed-gamma'],
        'push order on origin = queue order',
      );
      assert.equal(st.head, 'seed-alpha');
    }

    // re-enqueue of a queued slug keeps its position (idempotent — the resume path)
    lq(s.B, ['enqueue', 'free-beta', '--lane', 'free']);
    assert.equal(lqJson(s.A, ['status', 'free-beta']).position, 2);

    // head dequeues (landed) → next waiter promotes, visible from the OTHER clone
    lq(s.A, ['dequeue', 'seed-alpha']);
    const st = lqJson(s.B, ['status']);
    assert.equal(st.head, 'free-beta');
    assert.equal(st.total, 2);

    // dequeue of an absent slug is a no-op, exit 0 (abort paths must never crash)
    lq(s.B, ['dequeue', 'ghost']);
  } finally {
    s.cleanup();
  }
});

test('reenter: always re-enters at the TAIL — no preserved position, idempotent, head never displaced (plan 2517)', () => {
  const s = makeOriginAndClones();
  try {
    const T1 = '2026-07-20T10:01:00.000Z';
    const T2 = '2026-07-20T10:02:00.000Z';
    const T3 = '2026-07-20T10:03:00.000Z';
    lq(s.A, ['enqueue', 'p-one', '--lane', 'free'], { LQ_FAKE_NOW: T1 });
    lq(s.A, ['enqueue', 'p-two', '--lane', 'free'], { LQ_FAKE_NOW: T2 });
    lq(s.A, ['enqueue', 'p-three', '--lane', 'free'], { LQ_FAKE_NOW: T3 });

    // the middle waiter dequeues for rework, then re-enters — lands at the TAIL, not back
    // between one and three (no back-of-queue starvation exemption, plan 2517), visible
    // from the OTHER clone
    lq(s.A, ['dequeue', 'p-two']);
    const r = lqJson(s.B, ['reenter', 'p-two', '--lane', 'free']);
    assert.equal(r.position, 3, 'a plan carries no priority — re-entry is a plain tail append');
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['p-one', 'p-three', 'p-two'],
    );

    // the HEAD dequeues for rework — re-entry is STILL the tail (never displaces the new
    // in-flight head, but that's now a trivial consequence of appending at the tail, not a
    // special clamp)
    lq(s.A, ['dequeue', 'p-one']);
    const rh = lqJson(s.A, ['reenter', 'p-one', '--lane', 'free']);
    assert.equal(rh.position, 3, 'the former head re-enters at the tail like anyone else');
    assert.equal(lqJson(s.A, ['status']).head, 'p-three');

    // reenter while already queued is idempotent (crash-safe re-run)
    const ri = lqJson(s.A, ['reenter', 'p-one', '--lane', 'free']);
    assert.equal(ri.position, 3);
    assert.equal(ri.total, 3);
  } finally {
    s.cleanup();
  }
});

test('plan 2328: enqueue --priority inserts at position 2 (head never displaced), FIFO among ⚡, persisted cross-clone', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head', '--lane', 'seed']);
    lq(s.A, ['enqueue', 'w1', '--lane', 'free']);
    lq(s.A, ['enqueue', 'w2', '--lane', 'free']);
    // a ⚡ enqueue from the OTHER clone inserts behind the head, ahead of both waiters
    const p1 = lqJson(s.B, ['enqueue', 'urgent-1', '--lane', 'free', '--priority']);
    assert.equal(p1.position, 2, '⚡ inserts immediately behind the head');
    assert.equal(p1.head, 'head', 'the head is never displaced');
    // a second ⚡ stays FIFO among priority entries — after urgent-1, before the normals
    const p2 = lqJson(s.A, ['enqueue', 'urgent-2', '--lane', 'free', '--priority']);
    assert.equal(p2.position, 3);
    const st = lqJson(s.B, ['status']);
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['head', 'urgent-1', 'urgent-2', 'w1', 'w2'],
    );
    // the ⚡ field is PERSISTED in the doc (round-trips through render/parse cross-clone)
    assert.equal(st.entries[1].priority, true);
    assert.equal(st.entries[3].priority, false);
    // idempotent re-enqueue keeps the position (the resume path)
    const again = lqJson(s.B, ['enqueue', 'urgent-1', '--lane', 'free', '--priority']);
    assert.equal(again.position, 2);
    // plan 2517: a priority reenter no longer re-enters the front block — a plan carries
    // no priority on re-entry, so it lands at the tail like any other reenter
    lq(s.A, ['dequeue', 'urgent-1']);
    const re = lqJson(s.A, ['reenter', 'urgent-1', '--lane', 'free', '--priority']);
    assert.equal(re.position, re.total, 'the ⚡ flag carries no standing on re-entry');
  } finally {
    s.cleanup();
  }
});

test('heartbeat refreshes own row; status reports position for a slug', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'one', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'two', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    const T_NEW = '2026-06-10T01:00:00.000Z';
    lq(s.A, ['heartbeat', 'one'], { LQ_FAKE_NOW: T_NEW });
    const st = lqJson(s.B, ['status']);
    const one = st.entries.find((e) => e.slug === 'one');
    const two = st.entries.find((e) => e.slug === 'two');
    assert.equal(one.heartbeatIso, T_NEW);
    assert.equal(two.heartbeatIso, T_OLD, 'sibling row untouched');
    assert.equal(lqJson(s.A, ['status', 'two']).position, 2);
  } finally {
    s.cleanup();
  }
});

test('steal: fresh head refused; stale head stolen only with --confirm-holder-gone + audit line', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z'; // 60 min later — over the 45-min default
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // fresh head (age 0) → refused, exit 2
    assert.throws(
      () => lq(s.B, ['steal', 'waiter', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_OLD }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
    );

    // stale head WITHOUT the holder-gone confirmation → refused, exit 2, says how
    assert.throws(
      () => lq(s.B, ['steal', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /--confirm-holder-gone/.test(`${e.stderr}`),
    );

    // stale + confirmed → stolen; waiter is the new head; audit line written
    lq(s.B, ['steal', 'waiter', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_STALE });
    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'waiter');
    const doc = queueDocOnOrigin(s.A);
    assert.match(doc, /- .*waiter stole the head slot from dead-head/);
  } finally {
    s.cleanup();
  }
});

test('steal: F-008 — a ghost slug that was never enqueued is refused, real second-in-line untouched', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z'; // over the 45-min default
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'real-second', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['steal', 'ghost', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /not queued/i.test(`${e.stderr}`),
    );
    // the head must be UNCHANGED — a refused steal must never mutate the queue
    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'dead-head', 'a non-member steal attempt leaves the queue untouched');
  } finally {
    s.cleanup();
  }
});

test('a landed plan is reaped from the queue on the next op — teardown-crash AND re-add race (plan 574)', () => {
  const s = makeOriginAndClones();
  const docOf = () => queueDocOnOrigin(s.A);
  try {
    // two waiters queued; then 'landed-x' lands (its plan file moves to archive/) but
    // its queue row survives — the orphan/wedge scenario (561 teardown crash).
    lq(s.A, ['enqueue', 'landed-x', '--lane', 'free']);
    lq(s.A, ['enqueue', 'live-y', '--lane', 'free']);
    archivePlan(s.A, 'landed-x'); // the land archives the plan; the queue row is now an orphan

    // `status` alone (no mutate yet) reaps the orphan from the DISPLAY — the persisted
    // doc still lists landed-x, but the status view prunes it. (plan 574 status-prune)
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['live-y'],
      'status display reaps the landed orphan',
    );
    assert.match(docOf(), /\blanded-x\b/, 'but the persisted doc still has it until a mutate runs');

    // any subsequent queue mutation self-heals by GROUND TRUTH: the orphan is pruned and
    // the reap PERSISTS to the doc, so it never reaches the head and never wedges the queue.
    lq(s.A, ['enqueue', 'another-z', '--lane', 'free']);
    assert.ok(!/\blanded-x\b/.test(docOf()), 'teardown-crash orphan reaped from the persisted doc');
    const st = lqJson(s.A, ['status']);
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['live-y', 'another-z'],
      'live waiters preserved in order',
    );
    assert.equal(st.head, 'live-y', 'the landed orphan never reaches the head');

    // the 570 re-add race: a racing post-land invoke re-enqueues the landed slug. enqueue
    // still succeeds (the spine's gate relies on it), but the re-added orphan is reaped on
    // the very NEXT op — so it can never climb to the head either.
    lq(s.A, ['enqueue', 'landed-x', '--lane', 'free']); // racing post-land re-enqueue
    // plan 2603: a FLAGLESS heartbeat is a ref stamp, not a doc write, so it is no longer
    // one of the "next ops" that can persist the reap - pin that directly, since this test
    // used to rely on it and the reliance is exactly what the transport change removed.
    lq(s.A, ['heartbeat', 'live-y']);
    assert.match(
      docOf(),
      /landed-x/,
      'a flagless heartbeat writes no doc, so nothing is persisted',
    );
    lq(s.A, ['heartbeat', 'live-y', '--pid', '4242']); // a CONTENT heartbeat still mutates the doc
    assert.ok(!/\blanded-x\b/.test(docOf()), 're-added landed orphan reaped on the next op');
    assert.equal(lqJson(s.A, ['status']).head, 'live-y');
  } finally {
    s.cleanup();
  }
});

test('steal still works against a stale ORPHAN head — steal opts out of the prune (plan 574)', () => {
  // Regression guard for the review finding: mutateQueue prunes landed orphans, but
  // steal passes {prune:false}. Run steal from the checkout that HAS the archive file
  // (so a prune, if it ran, WOULD fire) — the stealer must still be promoted, NOT throw
  // "already head" from a pruned-then-re-verdicted queue.
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z'; // 60 min — over the 45-min default
    lq(s.A, ['enqueue', 'orphan-head', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    archivePlan(s.A, 'orphan-head'); // head is now a landed orphan (A's tree has the archive file)

    lq(s.A, ['steal', 'waiter', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_STALE });
    const st = lqJson(s.A, ['status']);
    assert.equal(
      st.head,
      'waiter',
      'orphan head stolen; waiter promoted (no "already head" throw)',
    );
    assert.equal(st.total, 1);
  } finally {
    s.cleanup();
  }
});

// plan 1364 review R1 (F1, CONFIRMED — the severe finding): pruneLandedBatches was
// defined + unit-tested in landing-queue-lib.mjs but never WIRED into landing-queue.mjs's
// real prune call sites, so a landed batch's queue entry was a PERMANENT phantom head
// (no status/enqueue/dequeue/heartbeat call could ever reap it). This drives the real CLI
// end to end — not just the pure lib function — to prove the wiring actually fires.
test('a landed BATCH entry is reaped from the queue via the real CLI — manifest absence is the ground truth (plan 1364 review R1 F1)', () => {
  const s = makeOriginAndClones();
  const docOf = () => queueDocOnOrigin(s.A);
  try {
    // the batch is claimed (manifest written) BEFORE it enqueues — a live batch entry.
    writeBatchManifest(s.A, 'batch-2026-07-03-x');
    lq(s.A, ['enqueue', 'batch-2026-07-03-x', '--lane', 'free']);
    lq(s.A, ['enqueue', 'live-y', '--lane', 'free']);

    // still live (manifest present) — status must NOT prune it yet.
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['batch-2026-07-03-x', 'live-y'],
      'a batch entry with a live manifest is never pruned',
    );

    // the batch LANDS: done-worktree's closeOutBatch deletes the manifest in the same
    // commit that archives every member — no plans/archive/<slug>.md ever exists for a
    // batch slug, so ONLY the manifest-absence ground truth can reap this entry.
    removeBatchManifest(s.A, 'batch-2026-07-03-x');

    // `status` alone (no mutate) reaps it from the DISPLAY, mirroring the single-plan orphan
    // behavior (plan 574) — proves the SAME real code path pruneLandedBatches feeds is live.
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['live-y'],
      'status display reaps the landed batch orphan',
    );
    assert.match(
      docOf(),
      /batch-2026-07-03-x/,
      'but the persisted doc still has it until a mutate runs',
    );

    // any subsequent queue mutation self-heals the PERSISTED doc — without this the batch
    // entry would wedge the FIFO head forever (the exact severity the finding named).
    lq(s.A, ['enqueue', 'another-z', '--lane', 'free']);
    assert.ok(
      !/batch-2026-07-03-x/.test(docOf()),
      'landed batch orphan reaped from the persisted doc via the real mutate call site',
    );
    const st = lqJson(s.A, ['status']);
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['live-y', 'another-z'],
    );
    assert.equal(st.head, 'live-y', 'the landed batch orphan never reaches the head');
  } finally {
    s.cleanup();
  }
});

// plan 1467: the same ground truth, but the manifest is grandfathered at the LEGACY path
// (docs/handoff/batches/<slug>.json) — an in-flight batch claimed before the folder
// migration. manifestExists reads both paths, so a legacy-path live manifest must still
// read as live, and its legacy-path deletion must still reap the entry.
test('a landed BATCH grandfathered at the LEGACY manifest path is still reaped (plan 1467 dual-read)', () => {
  const s = makeOriginAndClones();
  try {
    writeBatchManifest(s.A, 'batch-2026-07-03-old', 'legacy');
    lq(s.A, ['enqueue', 'batch-2026-07-03-old', '--lane', 'free']);
    lq(s.A, ['enqueue', 'live-y', '--lane', 'free']);
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['batch-2026-07-03-old', 'live-y'],
      'a legacy-path manifest still reads as a live batch entry',
    );
    removeBatchManifest(s.A, 'batch-2026-07-03-old', 'legacy');
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['live-y'],
      'deleting the legacy-path manifest reaps the landed batch orphan',
    );
  } finally {
    s.cleanup();
  }
});

test('every queue-doc write is a commit on the queue REF (never on master) carrying the Coord-Write + Queue-Attempt trailers (plan 3973)', () => {
  const s = makeOriginAndClones();
  try {
    const masterBefore = originMasterSha(s.origin);
    lq(s.A, ['enqueue', 'x', '--lane', 'free']);
    // plan 2603: --pid makes this a CONTENT heartbeat, which still rides the doc write; the
    // flagless form writes only refs/coord/queue-heartbeat/x and so contributes no
    // queue-doc commit for this invariant to cover.
    lq(s.A, ['heartbeat', 'x', '--pid', '99']);
    lq(s.A, ['dequeue', 'x']);
    assert.equal(originMasterSha(s.origin), masterBefore, 'zero commits on master');
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin', QUEUE_FETCH_REFSPEC]);
    const log = execFileSync('git', ['-C', s.A, 'log', '--format=%B', QUEUE_REF_LOCAL], {
      encoding: 'utf8',
    });
    assert.match(log, /coord\(queue\): enqueue x/);
    assert.match(log, /coord\(queue\): heartbeat x/);
    assert.match(log, /coord\(queue\): dequeue x/);
    assert.equal(
      (log.match(/Coord-Write: landing-queue/g) || []).length,
      3,
      'each commit carries the trailer',
    );
    assert.equal((log.match(/Queue-Attempt: 1/g) || []).length, 3, 'uncontended: one attempt each');
  } finally {
    s.cleanup();
  }
});

// ── plan 1682: demote — waiter-side move-to-tail of a stale, not-landing head ──────
// The liveness-keyed "release on reopen" enforcement (the 1674 hog). A demote MOVES
// the head entry to the tail (total unchanged) — contrast the steal, which removes it.

// Commit + push a board (legacy config-less path: handoff-board.md at the repo root —
// coord-config's fallback boardFile) so readBoardFresh sees it on origin/master.
function writeBoard(cloneDir, rows) {
  execFileSync('git', ['-C', cloneDir, 'pull', '-q', '--rebase', 'origin', 'master']);
  const content = [
    '# board',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan/claim | Last touched | Resume |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '<!-- BOARD-END -->',
    '',
  ].join('\n');
  writeFileSync(join(cloneDir, 'handoff-board.md'), content);
  execFileSync('git', ['-C', cloneDir, 'add', '-A']);
  execFileSync('git', ['-C', cloneDir, 'commit', '-qm', 'board update']);
  execFileSync('git', ['-C', cloneDir, 'push', '-q', 'origin', 'master']);
}

test('demote: fresh head refused; ghost demoter refused; stale not-landing head MOVED to tail + audit line', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_FRESH = '2026-06-10T00:10:00.000Z'; // 10 min — under the 15-min default
    const T_STALE = '2026-06-10T00:20:00.000Z'; // 20 min — over it
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // fresh head → refused, exit 2, no write
    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_FRESH }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'a refused demote never mutates');

    // a demoter that is not queued behind the head → refused
    assert.throws(
      () => lq(s.B, ['demote', 'ghost'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /not queued behind/i.test(`${e.stderr}`),
    );

    // stale + not landing → moved to the tail, waiter promoted, total unchanged
    const out = lqJson(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(out.demoted, 'busy-head');
    assert.equal(out.head, 'waiter');
    assert.equal(out.total, 2, 'moved, never removed');
    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'waiter');
    assert.equal(st.entries[1].slug, 'busy-head');
    assert.equal(st.entries[1].heartbeatIso, T_STALE, 'fresh tail residency timestamps');
    const doc = queueDocOnOrigin(s.A);
    assert.match(
      doc,
      /auto-demote: busy-head → tail \(heartbeat age 20m > 15m, not landing\) by waiter/,
    );
  } finally {
    s.cleanup();
  }
});

test('demote: a 🟢 LANDING head is refused even when heartbeat-stale (mid-land battery gap)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    writeBoard(s.A, ['| busy-head | abc123 | 🟢 LANDING | plan | 2026-06-10 | — |']);
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /LANDING/.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'the mid-land head keeps its slot');
  } finally {
    s.cleanup();
  }
});

// plan 3973 review (keys eabd36 / 5af627 / ef8569): the CAS retry re-reads the BOARD, not only
// the queue doc. A retry happens exactly when a sibling wrote the queue first — which is also
// when the head's land may have just published its 🟢 LANDING row. Judging the freshened queue
// against the snapshot taken before the first attempt is plan 3450 G3's race, re-opened.
//
// Forced deterministically with a one-shot `pre-push` hook in the demoting clone: the moment its
// first CAS push is about to go out, the other clone publishes the LANDING row AND advances the
// queue ref, so that push is rejected non-fast-forward and the retry must see both changes.
test('plan 3973: a head that goes 🟢 LANDING between CAS attempts is NOT demoted (ground truth is re-read per attempt)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // What the racing clone does, once, while B's first push is in flight. Deliberately NOT a
    // heartbeat of the head: that would refuse the demote on freshness and prove nothing.
    const racer = join(s.root, 'racer.mjs');
    writeFileSync(
      racer,
      [
        `import { execFileSync } from 'node:child_process';`,
        `import { writeFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `const A = ${JSON.stringify(s.A)};`,
        `const g = (args) => execFileSync('git', ['-C', A, ...args], { encoding: 'utf8' });`,
        `g(['pull', '-q', '--rebase', 'origin', 'master']);`,
        `writeFileSync(join(A, 'handoff-board.md'), [`,
        `  '# board', '<!-- BOARD-START -->',`,
        `  '| Worktree | Branch tip | State | Plan/claim | Last touched | Resume |',`,
        `  '| --- | --- | --- | --- | --- | --- |',`,
        `  '| busy-head | abc123 | 🟢 LANDING | plan | 2026-06-10 | — |',`,
        `  '<!-- BOARD-END -->', '',`,
        `].join('\\n'));`,
        `g(['add', '-A']);`,
        `g(['commit', '-qm', 'board: busy-head went LANDING']);`,
        `g(['push', '-q', 'origin', 'master']);`,
        `execFileSync(process.execPath, [${JSON.stringify(CLI)}, 'enqueue', 'third', '--lane', 'free'], {`,
        `  cwd: A, encoding: 'utf8', env: { ...process.env, LQ_FAKE_NOW: ${JSON.stringify(T_OLD)} },`,
        `});`,
      ].join('\n'),
    );
    const hooksDir = join(s.B, '.git', 'hooks');
    // Pin the hooks dir for THIS clone: a machine whose global config sets `core.hooksPath`
    // (husky does it per-repo, but the setting is inheritable) would otherwise ignore the hook
    // and the test would pass vacuously.
    execFileSync('git', ['-C', s.B, 'config', 'core.hooksPath', hooksDir.replace(/\\/g, '/')]);
    const hook = join(hooksDir, 'pre-push');
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'marker="$(git rev-parse --git-dir)/racer-fired"',
        '[ -e "$marker" ] && exit 0',
        ': > "$marker"',
        `"${process.execPath.replace(/\\/g, '/')}" "${racer.replace(/\\/g, '/')}" >&2 || exit 1`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /LANDING/.test(`${e.stderr}`),
      'the retry judged the head against the board as it is NOW, not as it was before attempt 1',
    );
    assert.equal(
      lqJson(s.A, ['status']).head,
      'busy-head',
      'the actively-landing head keeps its slot',
    );
  } finally {
    s.cleanup();
  }
});

test('demote: starvation cap — a third auto-demote of the same slug within 24h is refused', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'hog', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'w1', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    // demote #1 at +20m → [w1, hog]; w1 "lands" (dequeue) → [hog] head again
    lq(s.B, ['demote', 'w1'], { LQ_FAKE_NOW: '2026-06-10T00:20:00.000Z' });
    lq(s.B, ['dequeue', 'w1']);
    // demote #2 (hog heartbeat re-stamped 00:20 by the move) at +40m → [w2, hog]
    lq(s.B, ['enqueue', 'w2', '--lane', 'free'], { LQ_FAKE_NOW: '2026-06-10T00:20:00.000Z' });
    lq(s.B, ['demote', 'w2'], { LQ_FAKE_NOW: '2026-06-10T00:40:00.000Z' });
    lq(s.B, ['dequeue', 'w2']);
    // demote #3 → refused by the cap, and the refusal names the steal recourse
    lq(s.B, ['enqueue', 'w3', '--lane', 'free'], { LQ_FAKE_NOW: '2026-06-10T00:40:00.000Z' });
    assert.throws(
      () => lq(s.B, ['demote', 'w3'], { LQ_FAKE_NOW: '2026-06-10T01:00:00.000Z' }),
      (e) =>
        e.status === 2 && /starvation cap/i.test(`${e.stderr}`) && /steal/i.test(`${e.stderr}`),
    );
    assert.equal(
      lqJson(s.A, ['status']).head,
      'hog',
      'capped head holds — the steal is the recourse',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2414: self-demote refusal + the IN_LAND free-lane liveness token ──────────
// The 2026-07-25 incident this plan fixes: a free-lane land never sets the 🟢 LANDING
// board row (only 🟥 does), so a healthy gate-phase battery outliving the 15-min demote
// staleMin was demote-eligible on heartbeat age ALONE — and the demoter that fired was
// owned by the SAME session as the head, evicting its own other land.

test('demote: same-session demoter is refused even when the head is genuinely stale', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'my-other-land', '--lane', 'free', '--session', 'sess-9'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', 'sess-9'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) =>
        e.status === 2 &&
        /same session/i.test(`${e.stderr}`) &&
        /sess-9/.test(`${e.stderr}`) &&
        /my-other-land/.test(`${e.stderr}`) &&
        /waiter/.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'my-other-land', 'a refused demote never mutates');
  } finally {
    s.cleanup();
  }
});

test('demote: two entries BOTH defaulting to the "?" session placeholder are NOT treated as a match', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    // neither enqueue passes --session — both default to '?' (the pre-2414 status quo
    // for any caller that omits it); this must NEVER read as "same session".
    lq(s.A, ['enqueue', 'hog', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    const out = lqJson(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(out.demoted, 'hog', 'two unknown-session entries demote normally');
  } finally {
    s.cleanup();
  }
});

test('plan 2414: mark-in-land is head-gated and visible via status headState', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    // a non-head slug may never be stamped IN_LAND
    assert.throws(
      () => lq(s.B, ['mark-in-land', 'waiter'], { LQ_FAKE_NOW: T }),
      (e) => e.status !== 0 && /not the queue head/i.test(`${e.stderr}`),
    );
    lq(s.A, ['mark-in-land', 'holder'], { LQ_FAKE_NOW: T });
    // bare `status --json` has no top-level headState (that's the <slug>-scoped
    // payload — see printStatus); the per-entry `state` cell is where it lives here.
    assert.equal(lqJson(s.A, ['status']).entries[0].state, 'IN_LAND');
    assert.equal(lqJson(s.A, ['status', 'holder']).headState, 'IN_LAND');
  } finally {
    s.cleanup();
  }
});

// plan 2437: `heartbeat --state IN_LAND` composes heartbeatEntry + setEntryState (with
// mark-in-land's assertIsHead preserved) in the SAME mutateQueue transform — the fold
// markHeadAcquired/markQueueInLand (done-worktree.mjs) rides at head-acquisition, one
// coordWrite instead of two. These tests hit the CLI/lib layer directly (the folded
// call is invisible in a done-worktree.mjs DRY trace — see the done-worktree.test.mjs
// plan 2437 tests for that side of the change).
test('plan 2437: heartbeat --pid X --state IN_LAND stamps BOTH in one call — equivalent to heartbeat --pid then mark-in-land separately', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.A, ['heartbeat', 'holder', '--pid', '4242', '--state', 'IN_LAND'], { LQ_FAKE_NOW: T });
    const view = lqJson(s.A, ['status', 'holder']);
    assert.equal(view.headState, 'IN_LAND', 'IN_LAND rode the composed call');
    assert.equal(lqJson(s.A, ['status']).entries[0].pid, '4242', 'pid rode the SAME call');
  } finally {
    s.cleanup();
  }
});

test('plan 2437: heartbeat --state IN_LAND is head-gated exactly like standalone mark-in-land — a non-head slug refuses the state stamp', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    assert.throws(
      () =>
        lq(s.B, ['heartbeat', 'waiter', '--pid', '99', '--state', 'IN_LAND'], { LQ_FAKE_NOW: T }),
      (e) => e.status !== 0 && /not the queue head/i.test(`${e.stderr}`),
    );
    assert.equal(
      lqJson(s.B, ['status', 'waiter']).headState,
      null,
      'IN_LAND never lands on a non-head entry',
    );
  } finally {
    s.cleanup();
  }
});

// plan 2437 (review fix): before this diff, `heartbeat --pid` (no --state) had no
// head-gate and always committed via its own mutateQueue call — the pid stamp was
// "Deliberately UNCONDITIONAL" (plan 2266) so a later waiter's mechanical steal-verdict
// always sees the true current pid, even for an entry that just lost the head race.
// Folding IN_LAND's head-gate into the SAME transform must not make a head-gate
// refusal drag that unconditional pid write down with it.
test('plan 2437 (review fix): a --state IN_LAND head-gate refusal still commits the pid stamp — the pid write stays unconditional (plan 2266) despite the fold', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    assert.throws(
      () =>
        lq(s.B, ['heartbeat', 'waiter', '--pid', '99', '--state', 'IN_LAND'], { LQ_FAKE_NOW: T }),
      (e) => e.status !== 0 && /not the queue head/i.test(`${e.stderr}`),
    );
    const waiterEntry = lqJson(s.A, ['status']).entries.find((e) => e.slug === 'waiter');
    assert.equal(
      waiterEntry.pid,
      '99',
      'the pid stamp commits even though the state stamp was refused — no collateral loss',
    );
  } finally {
    s.cleanup();
  }
});

test('plan 2437: heartbeat --state only supports IN_LAND — any other value is rejected', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    assert.throws(
      () => lq(s.A, ['heartbeat', 'holder', '--state', 'BOGUS'], { LQ_FAKE_NOW: T }),
      (e) => e.status === 5 && /only supports IN_LAND/.test(`${e.stderr}`),
    );
  } finally {
    s.cleanup();
  }
});

test('plan 2437: a plain heartbeat (no --state) never touches the state cell — composed flag is opt-in only', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.A, ['mark-in-land', 'holder'], { LQ_FAKE_NOW: T });
    lq(s.A, ['heartbeat', 'holder', '--pid', '77'], { LQ_FAKE_NOW: T });
    assert.equal(
      lqJson(s.A, ['status', 'holder']).headState,
      'IN_LAND',
      'an ordinary heartbeat (plan 2266 pattern) never clears a prior IN_LAND stamp',
    );
  } finally {
    s.cleanup();
  }
});

test('demote: IN_LAND head with a LIVE same-host pid is immune past staleMin (the gate-phase gap)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_PAST_DEMOTE = '2026-06-10T00:20:00.000Z'; // 20m > 15m demote staleMin
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-in-land', 'busy-head'], { LQ_FAKE_NOW: T_OLD });
    // this TEST PROCESS's own pid is guaranteed alive for the duration of the assertion
    // (mirrors the mechanical-steal "LIVE pid" test above) — heartbeat carries it the
    // same way markHeadAcquired's real call does.
    lq(s.A, ['heartbeat', 'busy-head', '--pid', String(process.pid)], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_DEMOTE }),
      (e) =>
        e.status === 2 &&
        /IN_LAND/.test(`${e.stderr}`) &&
        /pid is verified alive/i.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'immune head keeps its slot');
  } finally {
    s.cleanup();
  }
});

test('demote: IN_LAND head with a DEAD same-host pid loses immunity (provably gone, not just stale)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_PAST_DEMOTE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'crashed-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-in-land', 'crashed-head'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['heartbeat', 'crashed-head', '--pid', String(deadPid())], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    const out = lqJson(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_DEMOTE });
    assert.equal(out.demoted, 'crashed-head', 'IN_LAND never means unconditional immunity');
  } finally {
    s.cleanup();
  }
});

test('demote: IN_LAND head with an UNPROBEABLE pid (cross-host) keeps a longer leash to the 45-min steal threshold', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_PAST_DEMOTE = '2026-06-10T00:20:00.000Z'; // 20m > 15m demote staleMin, < 45m steal
    const T_PAST_STEAL = '2026-06-10T00:50:00.000Z'; // 50m > 45m steal threshold
    lq(s.A, ['enqueue', 'cloud-head', '--lane', 'free', '--host', 'cloud-runner-9'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.A, ['mark-in-land', 'cloud-head'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // still within the 45-min leash → immune, even though it's past the 15-min demote staleMin
    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_DEMOTE }),
      (e) =>
        e.status === 2 && /IN_LAND/.test(`${e.stderr}`) && /steal threshold/i.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'cloud-head');

    // past the 45-min leash → the free-standing immunity finally expires (bounded, not forever)
    const out = lqJson(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_STEAL });
    assert.equal(out.demoted, 'cloud-head');
  } finally {
    s.cleanup();
  }
});

test('plan 2414 review fix: a same-host LIVE pid does NOT grant unconditional IN_LAND immunity — it expires at the 45-min leash too', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_PAST_STEAL = '2026-06-10T00:50:00.000Z'; // 50m > 45m leash
    lq(s.A, ['enqueue', 'wedged-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-in-land', 'wedged-head'], { LQ_FAKE_NOW: T_OLD });
    // this TEST PROCESS's own pid stays alive for the whole test — a genuinely wedged
    // (never crashing, never progressing) process, the exact case the first draft left
    // unconditionally immune.
    lq(s.A, ['heartbeat', 'wedged-head', '--pid', String(process.pid)], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    const out = lqJson(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_STEAL });
    assert.equal(
      out.demoted,
      'wedged-head',
      'a verified-alive pid no longer blocks demote once the 45-min leash has expired',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2266: mechanical steal — a same-host, verifiably-dead pid needs no
// --confirm-holder-gone, and (unlike the pre-existing manual steal) also releases the
// landing-lock + flips the head's board row LANDING → IN-PROGRESS (the 2208 incident's
// dangling-tenure gap).
//
// spawnSync blocks until the child exits, so `dead.pid` is a real, definitely-terminated
// pid on THIS host by the time the assertion runs — no sleep/poll needed.
// A pid these tests can rely on being NOT RUNNING for the whole test body.
//
// The obvious fixture — spawn a process, let it exit, reuse its pid — is racy, and it cost
// plan 3341 a land: it was the sole red in 8644 battery tests and passed 62/62 in isolation.
// A pid is only dead until the OS RECYCLES that number, and the full battery spawns thousands
// of short-lived processes, so a live one can claim it before the assertion. The queue's
// isPidAlive() then answers "alive" CORRECTLY and the test fails on an artefact of its own
// fixture. Probing the pid harder does NOT fix that: every lq() call below spawns another node
// process, so the window that matters runs from the probe here to the queue's own probe inside
// a LATER process, and any pid the OS is free to hand out can be taken inside it.
//
// So don't use an allocatable pid at all. A pid far above anything an OS allocates
// (Windows hands out small DWORDs; Linux's pid_max caps well below this) can never be claimed
// mid-test, which makes the fixture recycling-IMMUNE rather than merely recycling-unlucky. It
// is still verified absent with the SAME probe landing-queue.mjs uses (`process.kill(pid, 0)`,
// where ESRCH alone is the unambiguous "no such process" and anything else — EPERM included —
// means still running), so a platform that disagrees fails loudly here instead of silently
// weakening the assertion. The spawn-and-exit trick stays as a fallback for such a platform,
// retried until it yields a provably-absent pid.
const NEVER_ALLOCATED_PID = 0x7ffffffe; // 2147483646

function pidProvablyAbsent(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e?.code === 'ESRCH';
  }
}

function deadPid() {
  if (pidProvablyAbsent(NEVER_ALLOCATED_PID)) return NEVER_ALLOCATED_PID;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    if (Number.isFinite(pid) && pid > 0 && pidProvablyAbsent(pid)) return pid;
  }
  throw new Error(
    `deadPid: pid ${NEVER_ALLOCATED_PID} did not probe as ESRCH on this platform and no ` +
      'spawned-and-exited pid stayed absent across 25 attempts — the fixture, not the queue, is broken',
  );
}

test('steal: MECHANICAL — same-host dead pid reaps without --confirm-holder-gone, releasing landing-lock + board row', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z'; // over the 45-min default
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed'], { LQ_FAKE_NOW: T_OLD });
    // stamp the head's pid — mirrors markHeadAcquired's own heartbeat(..., --pid) call
    lq(s.A, ['heartbeat', 'dead-head', '--pid', String(deadPid())], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // seed the tenure this reap must clean up: a landing-lock holder + a board LANDING row.
    // plan 989: the `lq` calls above pushed via a disposable coord-checkout, so s.A's own
    // local master fell behind origin — re-sync before this DIRECT push (mirrors archivePlan).
    execFileSync('node', [LOCK_CLI, 'acquire', 'dead-head'], { cwd: s.A, encoding: 'utf8' });
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    writeFileSync(
      join(s.A, 'handoff-board.md'),
      [
        '# board',
        '<!-- BOARD-START -->',
        '| Worktree | Branch tip | State | Plan/claim | Last touched | Resume |',
        '| --- | --- | --- | --- | --- | --- |',
        '| dead-head | abc1234 | 🟢 LANDING | plan | 2026-06-10 | — |',
        '<!-- BOARD-END -->',
      ].join('\n'),
    );
    execFileSync('git', ['-C', s.A, 'add', '-A']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'seed board LANDING row']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // landing-lock is scoped to ONE shared `.git` (production: one host, one clone, many
    // worktrees — landing-lock.mjs's own header) — the steal that reaps it must run from
    // THAT SAME clone (s.A), unlike an ordinary steal, which is clone-agnostic (the queue
    // itself is cross-clone via git). s.B stays a separate independent clone in this
    // harness precisely to prove landing-lock does NOT accidentally cross clones.
    // no --confirm-holder-gone at all — the mechanical path takes it on {host, pid} alone
    const out = lq(s.A, ['steal', 'waiter'], { LQ_FAKE_NOW: T_STALE });
    assert.match(out, /MECHANICAL/);

    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'waiter');

    const lockStatus = execFileSync('node', [LOCK_CLI, 'status'], { cwd: s.A, encoding: 'utf8' });
    assert.doesNotMatch(lockStatus, /dead-head/, 'landing-lock released on a mechanical reap');

    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    const boardRow = execFileSync('node', [BOARD_CLI, 'get', 'dead-head'], {
      cwd: s.A,
      encoding: 'utf8',
    });
    assert.match(
      boardRow,
      /IN.PROGRESS/,
      'board row flipped LANDING → IN-PROGRESS on a mechanical reap',
    );
    assert.doesNotMatch(boardRow, /LANDING/, 'no dangling LANDING row survives the reap');
  } finally {
    s.cleanup();
  }
});

test('steal: a LIVE pid on the same host is NOT mechanically reaped — falls back to the manual path', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z';
    lq(s.A, ['enqueue', 'live-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    // this TEST PROCESS's own pid is guaranteed alive for the duration of the assertion
    lq(s.A, ['heartbeat', 'live-head', '--pid', String(process.pid)], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    assert.throws(
      () => lq(s.B, ['steal', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) =>
        e.status === 2 &&
        /--confirm-holder-gone/.test(`${e.stderr}`) &&
        /still running/.test(`${e.stderr}`),
    );
    // the existing manual path still works unchanged
    const out = lq(s.B, ['steal', 'waiter', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_STALE });
    assert.doesNotMatch(out, /MECHANICAL/);
    assert.equal(lqJson(s.A, ['status']).head, 'waiter');
  } finally {
    s.cleanup();
  }
});

test('steal: a stale head on a DIFFERENT host is never mechanically reaped, even with a dead pid — falls back to manual', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z';
    lq(s.A, ['enqueue', 'foreign-head', '--lane', 'free', '--host', 'some-other-pc'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.A, ['heartbeat', 'foreign-head', '--pid', String(deadPid())], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    assert.throws(
      () => lq(s.B, ['steal', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) =>
        e.status === 2 &&
        /--confirm-holder-gone/.test(`${e.stderr}`) &&
        /differs/.test(`${e.stderr}`),
    );
    assert.doesNotMatch(
      execFileSync('node', [LOCK_CLI, 'status'], { cwd: s.A, encoding: 'utf8' }),
      /foreign-head/,
    );
  } finally {
    s.cleanup();
  }
});

test('heartbeat --pid stamps the queue entry pid; a plain heartbeat afterward never blanks it', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'one', '--lane', 'seed'], { LQ_FAKE_NOW: T0 });
    lq(s.A, ['heartbeat', 'one', '--pid', '12345'], { LQ_FAKE_NOW: T0 });
    const before = lqJson(s.B, ['status']);
    assert.equal(before.entries.find((e) => e.slug === 'one').pid, '12345');
    lq(s.A, ['heartbeat', 'one'], { LQ_FAKE_NOW: '2026-06-10T00:05:00.000Z' });
    const after = lqJson(s.B, ['status']);
    assert.equal(
      after.entries.find((e) => e.slug === 'one').pid,
      '12345',
      'a plain heartbeat preserves pid',
    );
  } finally {
    s.cleanup();
  }
});

test('status <slug> --json (plan 2280): round-trips headHost/headPid — null on a pid-less head, populated after a --pid heartbeat', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'head-slug', '--lane', 'free', '--host', 'host-a'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });

    // pre-2266-shaped entry (no pid column stamped yet) — both fields readable, pid null
    const beforePid = lqJson(s.B, ['status', 'waiter']);
    assert.equal(beforePid.head, 'head-slug');
    assert.equal(beforePid.headHost, 'host-a');
    assert.equal(beforePid.headPid, null);

    lq(s.A, ['heartbeat', 'head-slug', '--pid', '54321'], { LQ_FAKE_NOW: T0 });
    const afterPid = lqJson(s.B, ['status', 'waiter']);
    assert.equal(afterPid.headHost, 'host-a');
    assert.equal(afterPid.headPid, '54321');
  } finally {
    s.cleanup();
  }
});

test('status <slug> --json (plan 2280): headHost/headPid are null on an empty queue rather than throwing', () => {
  const s = makeOriginAndClones();
  try {
    const empty = lqJson(s.B, ['status', 'nobody-queued']);
    assert.equal(empty.head, null);
    assert.equal(empty.headHost, null);
    assert.equal(empty.headPid, null);
  } finally {
    s.cleanup();
  }
});

test('status <slug> --json (plan 2334): exposes headHeartbeatIso — tracks the head heartbeat, null on an empty queue', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-07-25T08:00:00.000Z';
    const T1 = '2026-07-25T08:30:00.000Z';
    // an empty queue has no head to report an age for — null, never a throw (same shape as
    // headHost/headPid above), and the waiter's local pre-check reads that as "not fresh"
    assert.equal(lqJson(s.B, ['status', 'nobody-queued']).headHeartbeatIso, null);

    lq(s.A, ['enqueue', 'head-slug', '--lane', 'free', '--host', 'host-a'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    assert.equal(
      lqJson(s.B, ['status', 'waiter']).headHeartbeatIso,
      T0,
      'the enqueue stamp is the head heartbeat a waiter ages locally',
    );

    // a later heartbeat moves it — this is the field that makes the local demote/reap
    // pre-checks (landing-queue-lib demoteLocallyEligible / reapLocallyEligible) possible
    lq(s.A, ['heartbeat', 'head-slug'], { LQ_FAKE_NOW: T1 });
    assert.equal(lqJson(s.B, ['status', 'waiter']).headHeartbeatIso, T1);

    // it is the HEAD's stamp, not the queried slug's own
    assert.equal(lqJson(s.A, ['status', 'head-slug']).headHeartbeatIso, T1);
  } finally {
    s.cleanup();
  }
});

// ── plan 2275: mark-holding + overtake ─────────────────────────────────────────────

// Push a worktree-<slug> branch off origin/master touching exactly `file` — the raw
// material for the overtake path-disjointness probe. Returns to master so resolveMain
// keeps resolving the clone.
function pushBranchWithFile(cloneDir, branch, file, content = 'x\n') {
  execFileSync('git', ['-C', cloneDir, 'fetch', '-q', 'origin', 'master']);
  execFileSync('git', ['-C', cloneDir, 'checkout', '-q', '-B', branch, 'origin/master']);
  writeFileSync(join(cloneDir, file), content);
  execFileSync('git', ['-C', cloneDir, 'add', '-A']);
  execFileSync('git', ['-C', cloneDir, 'commit', '-qm', `${branch}: touch ${file}`]);
  execFileSync('git', ['-C', cloneDir, 'push', '-qf', 'origin', branch]);
  execFileSync('git', ['-C', cloneDir, 'checkout', '-q', 'master']);
}

test('plan 2275: mark-holding is position-1-gated both directions; status exposes headState', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-07-24T08:00:00.000Z';
    lq(s.A, ['enqueue', 'holder', '--lane', 'seed'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    // a non-head slug cannot be marked HOLDING
    assert.throws(
      () => lq(s.B, ['mark-holding', 'waiter', 'on'], { LQ_FAKE_NOW: T }),
      /not the queue head/,
    );
    // the head can; status --json exposes headState + the queried slug's own lane
    lq(s.A, ['mark-holding', 'holder', 'on'], { LQ_FAKE_NOW: T });
    const stw = lqJson(s.B, ['status', 'waiter'], { LQ_FAKE_NOW: T });
    assert.equal(stw.headState, 'HOLDING');
    assert.equal(stw.lane, '🟩', 'slug-scoped payload carries the waiter own lane (plan 2275)');
    lq(s.A, ['mark-holding', 'holder', 'on'], { LQ_FAKE_NOW: T });
    // clear while at head works and status reads null again
    lq(s.A, ['mark-holding', 'holder', 'off'], { LQ_FAKE_NOW: T });
    assert.equal(lqJson(s.B, ['status', 'waiter'], { LQ_FAKE_NOW: T }).headState, null);
  } finally {
    s.cleanup();
  }
});

test('plan 2275: overtake — disjoint 🟩 waiter swaps past a HOLDING head; holder keeps position 2 + its stamp; resume clear is settlement-gated', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-07-24T08:00:00.000Z';
    pushBranchWithFile(s.A, 'worktree-holder', 'seed-thing.txt');
    pushBranchWithFile(s.B, 'worktree-waiter', 'docs-thing.txt');
    lq(s.A, ['enqueue', 'holder', '--lane', 'seed'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    // an ACTIVE (non-HOLDING) head is never overtakable
    assert.throws(
      () => lq(s.B, ['overtake', 'waiter'], { LQ_FAKE_NOW: T }),
      /not parked at LAND_BLOCKED_HOLDING/,
    );
    lq(s.A, ['mark-holding', 'holder', 'on'], { LQ_FAKE_NOW: T });
    const out = lqJson(s.B, ['overtake', 'waiter'], { LQ_FAKE_NOW: T });
    assert.equal(out.position, 1);
    assert.equal(out.past, 'holder');
    const st = lqJson(s.A, ['status'], { LQ_FAKE_NOW: T });
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['waiter', 'holder'],
    );
    assert.equal(st.entries[1].state, 'HOLDING', 'holder keeps its stamp through the swap');
    // the holder's resume must NOT clear HOLDING while displaced (settlement gate)…
    assert.throws(
      () => lq(s.A, ['mark-holding', 'holder', 'off'], { LQ_FAKE_NOW: T }),
      /not the queue head/,
    );
    // …and a second overtaker cannot pass the overtaker (its head is not HOLDING)
    lq(s.A, ['enqueue', 'late', '--lane', 'free'], { LQ_FAKE_NOW: T });
    assert.throws(
      () => lq(s.A, ['overtake', 'late'], { LQ_FAKE_NOW: T }),
      /not parked at LAND_BLOCKED_HOLDING/,
    );
    // overtaker lands (dequeues) → holder is head again and may clear + resume
    lq(s.B, ['dequeue', 'waiter'], { LQ_FAKE_NOW: T });
    lq(s.A, ['mark-holding', 'holder', 'off'], { LQ_FAKE_NOW: T });
    assert.equal(lqJson(s.A, ['status', 'late'], { LQ_FAKE_NOW: T }).headState, null);
  } finally {
    s.cleanup();
  }
});

test('plan 2275: overtake refuses on path overlap and on an unprovable diff (missing branch); 🟥 waiters never overtake', () => {
  const s = makeOriginAndClones();
  try {
    const T = '2026-07-24T08:00:00.000Z';
    pushBranchWithFile(s.A, 'worktree-holder', 'shared.txt', 'holder\n');
    lq(s.A, ['enqueue', 'holder', '--lane', 'seed'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'red-waiter', '--lane', 'seed'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'overlap-waiter', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.B, ['enqueue', 'branchless', '--lane', 'free'], { LQ_FAKE_NOW: T });
    lq(s.A, ['mark-holding', 'holder', 'on'], { LQ_FAKE_NOW: T });
    // 🟥 lane refused outright (pure verdict, before any git probing)
    assert.throws(
      () => lq(s.B, ['overtake', 'red-waiter'], { LQ_FAKE_NOW: T }),
      /only a 🟩 free-lane land may overtake/,
    );
    // overlapping changed-path sets refused, naming the culprit
    pushBranchWithFile(s.B, 'worktree-overlap-waiter', 'shared.txt', 'waiter\n');
    assert.throws(
      () => lq(s.B, ['overtake', 'overlap-waiter'], { LQ_FAKE_NOW: T }),
      /overlaps the holding head holder .*shared\.txt/s,
    );
    // no pushed branch → disjointness unprovable → refused (fail-safe)
    assert.throws(
      () => lq(s.B, ['overtake', 'branchless'], { LQ_FAKE_NOW: T }),
      /cannot fetch|cannot compute/,
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 2331: reap — arm-then-fire mechanical dequeue of a dead, NOT-landing head ──

test('reap: fresh head refused; ghost waiter refused; stale head ARMS (no write mutation of the queue length), then refuses while grace is pending, then FIRES (removed + audit line)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-07-24T00:00:00.000Z';
    const T_FRESH = '2026-07-24T00:10:00.000Z'; // 10m — under the 45m default
    const T_STALE = '2026-07-24T00:50:00.000Z'; // 50m — over it, ARMS
    const T_GRACE_PENDING = '2026-07-24T00:55:00.000Z'; // armed 5m ago — grace (10m) pending
    const T_FIRES = '2026-07-24T01:00:00.000Z'; // armed 10m ago — fires
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });

    // fresh head → refused, exit 2, no write
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_FRESH }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'a refused reap never mutates');

    // a waiter not queued behind the head → refused
    assert.throws(
      () => lq(s.B, ['reap', 'ghost'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /not queued behind/i.test(`${e.stderr}`),
    );

    // stale, not yet armed → ARMS (exit 2, entry stays — total unchanged — but the doc now
    // carries the arm stamp, visible on the full-queue --json payload)
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /ARMED/.test(`${e.stderr}`),
    );
    let st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'busy-head', 'armed but not yet fired — still head');
    assert.equal(st.total, 2, 'arming never removes anything');
    assert.equal(st.entries[0].reapArmedIso, T_STALE);

    // armed, grace not yet elapsed → still refused, still no removal, arm stamp untouched
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_GRACE_PENDING }),
      (e) =>
        e.status === 2 && /grace/i.test(`${e.stderr}`) && /not yet elapsed/i.test(`${e.stderr}`),
    );
    st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'busy-head');
    assert.equal(
      st.entries[0].reapArmedIso,
      T_STALE,
      'the arm stamp is untouched by a grace-pending re-check',
    );

    // grace elapsed → fires: head removed, waiter promoted, total shrinks, audit line
    const out = lqJson(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_FIRES });
    assert.equal(out.reaped, 'busy-head');
    assert.equal(out.head, 'waiter');
    assert.equal(out.total, 1, 'reap REMOVES the head — never moves it like demote');
    st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'waiter');
    assert.equal(st.total, 1);
    const doc = queueDocOnOrigin(s.A);
    assert.match(doc, /reap: busy-head removed by waiter \(heartbeat \d+m stale, armed 10m ago\)/);
  } finally {
    s.cleanup();
  }
});

test('reap: a 🟢 LANDING head is refused even when heartbeat-stale — never even arms', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-07-24T00:00:00.000Z';
    const T_STALE = '2026-07-24T00:50:00.000Z';
    writeBoard(s.A, ['| busy-head | abc123 | 🟢 LANDING | plan | 2026-07-24 | — |']);
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_STALE }),
      (e) => e.status === 2 && /LANDING/.test(`${e.stderr}`),
    );
    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'busy-head', 'the mid-land head keeps its slot');
    assert.equal(st.entries[0].reapArmedIso, null, 'a LANDING head never even arms');
  } finally {
    s.cleanup();
  }
});

test('reap: a HOLDING head is refused (overtake is the recourse), even comfortably past stale + grace', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-07-24T00:00:00.000Z';
    const T_LONG_AFTER = '2026-07-24T02:00:00.000Z'; // 2h — well past stale + grace
    lq(s.A, ['enqueue', 'holder', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-holding', 'holder', 'on'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_LONG_AFTER }),
      (e) =>
        e.status === 2 &&
        /LAND_BLOCKED_HOLDING/.test(`${e.stderr}`) &&
        /overtake/.test(`${e.stderr}`),
    );
    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'holder', 'a HOLDING head keeps its slot — reap is not the recourse');
    assert.equal(st.entries[0].reapArmedIso, null, 'a HOLDING head never even arms');
  } finally {
    s.cleanup();
  }
});

// ── plan 2414 review fix: reap needed the SAME IN_LAND + self-session closes as demote
// (reap is a more destructive verb — full removal, not move-to-tail).

test('reap: an IN_LAND head is refused (demote/steal are the recourse), even comfortably past stale + grace', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-07-24T00:00:00.000Z';
    const T_LONG_AFTER = '2026-07-24T02:00:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-in-land', 'busy-head'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_LONG_AFTER }),
      (e) =>
        e.status === 2 &&
        /IN_LAND/.test(`${e.stderr}`) &&
        /demote/.test(`${e.stderr}`) &&
        /steal/.test(`${e.stderr}`),
    );
    const st = lqJson(s.A, ['status']);
    assert.equal(
      st.head,
      'busy-head',
      'an IN_LAND head keeps its slot — reap is never the recourse',
    );
    assert.equal(st.entries[0].reapArmedIso, null, 'an IN_LAND head never even arms');
  } finally {
    s.cleanup();
  }
});

test('reap: same-session waiter is refused from reaping its own other queued land', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-07-24T00:00:00.000Z';
    const T_LONG_AFTER = '2026-07-24T02:00:00.000Z';
    lq(s.A, ['enqueue', 'my-other-land', '--lane', 'free', '--session', 'sess-9'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', 'sess-9'], { LQ_FAKE_NOW: T_OLD });
    assert.throws(
      () => lq(s.B, ['reap', 'waiter'], { LQ_FAKE_NOW: T_LONG_AFTER }),
      (e) => e.status === 2 && /same session/i.test(`${e.stderr}`) && /sess-9/.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'my-other-land');
  } finally {
    s.cleanup();
  }
});

// ── plan 2603: the heartbeat-ref transport, integration ─────────────────────────────
function originRefShas(origin, ref) {
  return execFileSync('git', ['ls-remote', origin, ref], { encoding: 'utf8' }).trim();
}
function originMasterSha(origin) {
  return originRefShas(origin, 'refs/heads/master');
}

test('heartbeat: a FLAGLESS ping writes NO new commit on origin/master but DOES create the heartbeat ref', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'my-slug', '--lane', 'free']);
    const shaBefore = originMasterSha(s.origin);
    // no ref for this slug yet
    assert.equal(originRefShas(s.origin, `${HEARTBEAT_REF_PREFIX}my-slug`), '');

    lq(s.A, ['heartbeat', 'my-slug']);

    assert.equal(
      originMasterSha(s.origin),
      shaBefore,
      'a flagless heartbeat must not push any new commit onto origin/master — this is the ' +
        'whole point of moving it off the coord-write spine',
    );
    assert.notEqual(
      originRefShas(s.origin, `${HEARTBEAT_REF_PREFIX}my-slug`),
      '',
      'the ref must exist on origin after a flagless heartbeat',
    );
  } finally {
    s.cleanup();
  }
});

test('heartbeat: --pid / --state IN_LAND still ride the doc write (a commit lands on the queue ref, none on master)', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'my-slug', '--lane', 'free']);
    const masterBefore = originMasterSha(s.origin);
    const refBefore = originRefShas(s.origin, QUEUE_REF);
    lq(s.A, ['heartbeat', 'my-slug', '--pid', String(process.pid), '--state', 'IN_LAND']);
    assert.notEqual(
      originRefShas(s.origin, QUEUE_REF),
      refBefore,
      'a heartbeat carrying --pid/--state is genuine doc content and must still commit (on the ref)',
    );
    assert.equal(originMasterSha(s.origin), masterBefore, 'never on master (plan 3973)');
    // A flag-carrying heartbeat writes the doc ONLY — it deliberately does not also stamp
    // the ref (see "THE WRITE SEAM" in cmdHeartbeat). Nothing is lost: the two channels are
    // read through decorateWithHeartbeatRefs' max(), so this fresher doc stamp already wins
    // every staleness verdict, and a second push would only add a failure mode. Pinned
    // because the opposite (stamping both) is the tempting "for symmetry" change, and this
    // assertion is what would fail and force the reader back to the max() rationale.
    assert.equal(
      originRefShas(s.origin, `${HEARTBEAT_REF_PREFIX}my-slug`),
      '',
      'a --pid/--state heartbeat writes the doc only; the reader-side max() covers it',
    );
  } finally {
    s.cleanup();
  }
});

test("THE CENTRAL BEHAVIOUR: a flagless ref-only heartbeat from the head keeps a waiter's demote refused — cross-session liveness survived the transport change", () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-07-30T00:00:00.000Z';
    // A enqueues the head; B queues in behind it — same shape as the plain demote test
    // above ('demote: fresh head refused; ...'), which proves that WITHOUT any further
    // heartbeat, a demote 20 minutes later (past DEFAULT_DEMOTE_STALE_MIN = 15m) succeeds.
    // This test's whole point is that a flagless (ref-only, no coordWrite) heartbeat in
    // between must be enough to keep that same demote refused — proving the doc-only
    // fallback the plan-2603 diff removed was never load-bearing for cross-session
    // liveness, because the ref now carries it.
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });

    // A pings — flagless, ref-only — 18 minutes in (still within the 15m window measured
    // from THIS ping, even though it is already past 15m since the original enqueue).
    const T_PING = '2026-07-30T00:18:00.000Z';
    lq(s.A, ['heartbeat', 'busy-head'], { LQ_FAKE_NOW: T_PING });

    // B attempts the demote at the SAME wall-clock time the plain (no-further-heartbeat)
    // test proves would succeed (20 minutes after the original enqueue, i.e. only 2
    // minutes after the ref ping) — it must now be REFUSED as fresh.
    const T_DEMOTE_ATTEMPT = '2026-07-30T00:20:00.000Z';
    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_DEMOTE_ATTEMPT }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
      'a ref-only heartbeat must fold into the effective heartbeat age and refuse the demote',
    );
    assert.equal(
      lqJson(s.A, ['status']).head,
      'busy-head',
      'the head must have kept its slot — the ref ping alone was enough to save it',
    );
  } finally {
    s.cleanup();
  }
});

test("dequeue removes the slug's heartbeat ref from origin", () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'my-slug', '--lane', 'free']);
    lq(s.A, ['heartbeat', 'my-slug']); // flagless — stamps the ref
    assert.notEqual(
      originRefShas(s.origin, `${HEARTBEAT_REF_PREFIX}my-slug`),
      '',
      'precondition: the ref exists before dequeue',
    );
    lq(s.A, ['dequeue', 'my-slug']);
    assert.equal(
      originRefShas(s.origin, `${HEARTBEAT_REF_PREFIX}my-slug`),
      '',
      "dequeue must remove the slug's heartbeat ref from origin",
    );
  } finally {
    s.cleanup();
  }
});

// plan 2656 (review finding on 2603, fix 1): before this fix, readFresh ran ONE combined
// `git fetch origin master +refs/coord/queue-heartbeat/*:...` under ONE try/catch, so a
// broken heartbeat ref threw the whole fetch and poisoned the UNRELATED master-doc read
// too. Reproduce the exact mechanism VERIFIER 16 used: a D/F path conflict scoped only to
// the heartbeat wildcard refspec (a local ref at `.../dfconflict` collides with an
// incoming `.../dfconflict/oops`), which makes ONLY that refspec's fetch fail.
test('a heartbeat-ref D/F conflict must not poison the master-doc fetch (readFresh split, fix 1)', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'live-slug', '--lane', 'free']);
    // B never wrote a heartbeat ping for 'dfconflict', but plants a LOCAL ref at that
    // exact path, then a nested one arrives from origin on the next fetch — the classic
    // git D/F (directory/file) ref collision, scoped to the heartbeat namespace only.
    execFileSync('git', [
      '-C',
      s.A,
      'update-ref',
      `${HEARTBEAT_REF_PREFIX}dfconflict/oops`,
      'refs/heads/master',
    ]);
    execFileSync('git', [
      '-C',
      s.B,
      'update-ref',
      HEARTBEAT_REF_PREFIX + 'dfconflict',
      'refs/heads/master',
    ]);
    execFileSync('git', ['-C', s.B, 'push', '-q', 'origin', `${HEARTBEAT_REF_PREFIX}dfconflict`]);
    // A's local tree now has .../dfconflict/oops while origin has .../dfconflict (a file
    // where A has a directory) — A's next heartbeat-refspec fetch must fail on this ref
    // alone. The master-doc read must survive it regardless: `status` must still see the
    // live entry enqueued above, not an empty/failed doc.
    const st = lqJson(s.A, ['status']);
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['live-slug'],
      'the master doc read must succeed even though the heartbeat-ref fetch for a sibling path failed',
    );
  } finally {
    s.cleanup();
  }
});

// plan 2656 round-3 review finding: the in-mutate re-probe left the manual path open —
// `--confirm-holder-gone` short-circuited it. The guard added for that is keyed on the
// head's pid IDENTITY changing mid-steal (a resumed land re-stamping the same entry), not
// on liveness, precisely so the flag keeps overriding a live-but-wedged pid — the
// behaviour the 'a LIVE pid on the same host is NOT mechanically reaped' test above pins
// and which this must not regress. Like `assertHeadUnchanged` and cmdOvertake's identical
// guard, the pid-change branch itself ships untested: forcing a write onto origin strictly
// BETWEEN two lines of one synchronous CLI invocation needs a pause hook this file does
// not have. What IS pinned here is the no-race path — the flag still works, and the pid
// comparison does not spuriously refuse a steal where nothing changed.
test('steal: the mid-steal residency guard does not disturb a normal --confirm-holder-gone steal', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T01:00:00.000Z'; // over the 45-min default
    lq(s.A, ['enqueue', 'live-head', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    // a live pid on this host: the mechanical path must refuse, the manual one must not
    lq(s.A, ['heartbeat', 'live-head', '--pid', String(process.pid)], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T_OLD });
    const out = lq(s.B, ['steal', 'waiter', '--confirm-holder-gone'], { LQ_FAKE_NOW: T_STALE });
    assert.doesNotMatch(out, /MECHANICAL/, 'a forced steal is never reported as mechanical');
    assert.equal(lqJson(s.A, ['status']).head, 'waiter', 'the forced steal still took the slot');
  } finally {
    s.cleanup();
  }
});

// plan 2656 SELF-REVIEW regressions. The first cut of the readFresh split above collapsed
// the `git fetch origin master` and the `git show origin/master:<doc>` into ONE try/catch,
// which silently traded the fixed bug for two new ones. Both are pinned here.
//
// [1] A failed fetch must NOT skip the show. origin/master stays readable from the last
// successful fetch, and that cached view is authoritative for a queue five-to-seven
// sessions share; this checkout's own working-tree copy is not (coord writes push through
// a disposable checkout and never touch it). Falling straight to the local file on a
// transient fetch failure silently reverts the queue to a private, older view.
test('readFresh reads the CACHED origin/master when this call’s own fetch fails', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'a-slug', '--lane', 'free']);
    lq(s.B, ['enqueue', 'b-slug', '--lane', 'free']);
    // Freshen A's origin/master cache while origin is still reachable.
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['a-slug', 'b-slug'],
      'precondition: both entries are visible on origin/master',
    );
    // Origin goes away. refs/remotes/origin/master still holds BOTH entries; A's own
    // working tree holds neither.
    execFileSync('git', ['-C', s.A, 'remote', 'set-url', 'origin', join(s.root, 'gone.git')]);
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['a-slug', 'b-slug'],
      'a failed fetch must still read the last-known origin/master, not the local file',
    );
  } finally {
    s.cleanup();
  }
});

// [2] …and a failed fetch must still FAIL CLOSED for the three displacing verbs. Before
// the split, an unfetchable origin forced hb.ok=false (one combined fetch) and every
// staleness-keyed verb refused. Splitting the fetches let the heartbeat half succeed
// independently, so without docReadRefusal a steal/demote/reap would compute its verdict
// against whatever stale queue snapshot was on hand and displace a head on it.
test('steal REFUSES when origin/master could not be fetched (fail-closed doc read)', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-slug', '--lane', 'free']);
    lq(s.A, ['enqueue', 'me', '--lane', 'free']);
    // Freshen A's origin/master cache while origin is reachable — and assert it, so this
    // is a stated precondition rather than a bare CLI call run for its side effect.
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['head-slug', 'me'],
      'precondition: both entries are on origin/master before origin goes away',
    );
    execFileSync('git', ['-C', s.A, 'remote', 'set-url', 'origin', join(s.root, 'gone.git')]);
    const r = spawnSync('node', [CLI, 'steal', 'me', '--stale-min', '0'], {
      cwd: s.A,
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, 'a steal against an unfetchable origin must not succeed');
    assert.match(
      r.stderr,
      /origin\/master could not be fetched/,
      'the refusal must name the stale DOC, not only the heartbeat namespace',
    );
  } finally {
    s.cleanup();
  }
});

// plan 2656 fix 2 (cmdSteal's stale-mech-reuse guard, mirroring cmdOvertake's identical
// `v.head.slug !== pre.head.slug` check) ships WITHOUT a dedicated integration test here,
// matching this file's own existing precedent: cmdOvertake's guard for the SAME race (a
// head changing between the pre-verdict fetch and the in-mutate re-verdict) has no test
// of its own either — reproducing it deterministically needs an action to land on origin
// strictly BETWEEN two lines of one synchronous CLI invocation, which no test hook in this
// file currently provides (LQ_FAKE_NOW freezes the clock, not the git timeline). Verified
// instead by direct code reading against cmdOvertake's working, precedented pattern.

// ── plan 3000: the operator-authority override on demote ───────────────────────────
// The 2026-08-08 ruling: "even on my demand, we should be able to move around our demote
// plans in the planning queue." Every displacement verb is keyed on the head being provably
// stale or provably gone, and for a LIVE head that axis is unreachable by construction — a
// head re-heartbeating every 45 s never leaves age 0m, so no positive --stale-min clears it.
// These pin the override that obeys, and — just as load-bearing — the gates it still keeps.

// The two demote refusals reproduced live on 2026-08-08, then the override that gets past
// them. `--stale-min 0.01` stands in for "the smallest gate the CLI will even accept":
// --stale-min 0 is rejected outright, so this is genuinely the tightest reachable setting.
test('plan 3000: --operator-override moves a live, freshly-heartbeating head no --stale-min can clear', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    const T_NOW = '2026-06-10T00:00:30.000Z'; // 30s later — the head's age never leaves 0m
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.A, ['heartbeat', 'busy-head'], { LQ_FAKE_NOW: T_NOW });

    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_NOW }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
      'the default gate refuses a live head',
    );
    assert.throws(
      () => lq(s.B, ['demote', 'waiter', '--stale-min', '0.01'], { LQ_FAKE_NOW: T_NOW }),
      (e) => e.status === 2 && /fresh/i.test(`${e.stderr}`),
      'and so does the tightest --stale-min the CLI accepts — the axis is unreachable',
    );

    const reason = 'operator ruling: waiter lands first';
    const r = spawnSync(
      'node',
      [CLI, 'demote', 'waiter', '--operator-override', reason, '--json'],
      {
        cwd: s.B,
        encoding: 'utf8',
        env: { ...process.env, LQ_FAKE_NOW: T_NOW },
      },
    );
    assert.equal(r.status, 0, `override must succeed (stderr: ${r.stderr})`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.demoted, 'busy-head');
    assert.equal(out.head, 'waiter');
    assert.equal(out.total, 2, 'a demote MOVES, never removes — override included');
    assert.equal(out.axis, 'operator', 'the axis names AUTHORITY, not a staleness reading');
    assert.equal(out.operatorOverride, true);
    assert.equal(out.operatorReason, reason);

    // execution note 5: the cost is printed BEFORE the move, not discovered afterwards.
    assert.match(r.stderr, /OPERATOR OVERRIDE/);
    assert.match(r.stderr, /busy-head/);
    assert.match(r.stderr, /heartbeat age/i);
    assert.match(r.stderr, /DISCARDED/);
    assert.match(r.stderr, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // execution note 2: audited in BOTH durable records — the audit region and the commit
    // subject — under the separate `operator-demote` template, never the auto one.
    // (s.A pushed nothing here, so its origin/master tracking ref must be freshened first.)
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    const doc = queueDocOnOrigin(s.A);
    assert.match(
      doc,
      /operator-demote: busy-head → tail \(operator override: operator ruling: waiter lands first\) by waiter/,
    );
    assert.doesNotMatch(doc, /auto-demote: busy-head/, 'never recorded as an automatic demote');
    // plan 3973: the queue commit is on the queue ref (queueDocOnOrigin fetched it), not master.
    const subject = execFileSync('git', ['-C', s.A, 'log', '--format=%s', '-1', QUEUE_REF_LOCAL], {
      encoding: 'utf8',
    });
    assert.match(subject, /OPERATOR-OVERRIDE/);
    assert.match(subject, /reason: operator ruling: waiter lands first/);
  } finally {
    s.cleanup();
  }
});

// Execution note 3's ONE residual refusal. The 🟢 LANDING row means the spine is inside the
// merge window, where the refusal protects the MERGE rather than the head's queue position —
// so it survives the override, and says so with a retry that is actually actionable.
test('plan 3000: the 🟢 LANDING merge window is the one axis an operator override does NOT clear', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    writeBoard(s.A, ['| busy-head | abc123 | 🟢 LANDING | plan | 2026-06-10 | — |']);
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    assert.throws(
      () =>
        lq(s.B, ['demote', 'waiter', '--operator-override', 'force it'], { LQ_FAKE_NOW: T_STALE }),
      (e) =>
        e.status === 2 &&
        /LANDING/.test(`${e.stderr}`) &&
        /does NOT clear/.test(`${e.stderr}`) &&
        /MINUTES/i.test(`${e.stderr}`) &&
        /retry/i.test(`${e.stderr}`),
    );
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'the merge-window head keeps its slot');
  } finally {
    s.cleanup();
  }
});

// The override is authority over BUSYNESS, never over well-formedness: a caller that is not
// behind the head, or that owns the head itself, is refused exactly as before.
test('plan 3000: an operator override keeps every structural gate — same-session and not-queued-behind', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'my-other-land', '--lane', 'free', '--session', 'sess-9'], {
      LQ_FAKE_NOW: T0,
    });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', 'sess-9'], { LQ_FAKE_NOW: T0 });
    assert.throws(
      () =>
        lq(s.B, ['demote', 'waiter', '--operator-override', 'just force it'], { LQ_FAKE_NOW: T0 }),
      (e) => e.status === 2 && /same session/i.test(`${e.stderr}`),
      'a session still never evicts its own other land',
    );
    assert.throws(
      () =>
        lq(s.B, ['demote', 'ghost', '--operator-override', 'just force it'], { LQ_FAKE_NOW: T0 }),
      (e) => e.status === 2 && /not queued behind/i.test(`${e.stderr}`),
      'an unqueued slug still cannot demote',
    );
    assert.equal(lqJson(s.A, ['status']).head, 'my-other-land', 'no refused path mutates');
  } finally {
    s.cleanup();
  }
});

// The IN_LAND immunity is the SECOND gate a fresh-heartbeat head passes, so an override that
// stopped at the staleness axis would be reachable in name only.
test('plan 3000: an operator override clears the IN_LAND immunity a verified-alive pid would hold', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    const T_PAST_DEMOTE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.A, ['mark-in-land', 'busy-head'], { LQ_FAKE_NOW: T0 });
    // this test process's own pid — guaranteed alive, mirroring the plan-2414 tests above
    lq(s.A, ['heartbeat', 'busy-head', '--pid', String(process.pid)], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });

    assert.throws(
      () => lq(s.B, ['demote', 'waiter'], { LQ_FAKE_NOW: T_PAST_DEMOTE }),
      (e) => e.status === 2 && /IN_LAND/.test(`${e.stderr}`),
      'the automatic path is still immune',
    );
    const r = spawnSync(
      'node',
      [CLI, 'demote', 'waiter', '--operator-override', 'operator: reorder now', '--json'],
      { cwd: s.B, encoding: 'utf8', env: { ...process.env, LQ_FAKE_NOW: T_PAST_DEMOTE } },
    );
    assert.equal(r.status, 0, `override must clear IN_LAND (stderr: ${r.stderr})`);
    assert.equal(JSON.parse(r.stdout).demoted, 'busy-head');
    assert.match(r.stderr, /stamped IN_LAND/, 'and must say so in the discarded-work warning');
  } finally {
    s.cleanup();
  }
});

// Execution note 2, at the argument boundary: an override is never anonymous. Exit 5 (a
// malformed request), not 2 (a refused verdict) — and nothing is written either way.
test('plan 3000: the override reason is mandatory — a blank or missing one is refused before any write', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    for (const args of [
      ['demote', 'waiter', '--operator-override', '   '],
      ['demote', 'waiter', '--operator-override='],
      ['demote', 'waiter', '--operator-override'], // value runs off the end of argv
    ]) {
      const r = spawnSync('node', [CLI, ...args], {
        cwd: s.B,
        encoding: 'utf8',
        env: { ...process.env, LQ_FAKE_NOW: T0 },
      });
      assert.equal(r.status, 5, `${args.join(' ')} must be an arg error, not a verdict`);
      assert.match(r.stderr, /requires a reason/);
    }
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'no reasonless override ever wrote');
  } finally {
    s.cleanup();
  }
});

// Execution note 4: the operator budget and the automatic one are separate counters. An
// override is neither spent by the cap nor spends it — proven in one sequence, because
// asserting only one half would leave the other free to regress.
test('plan 3000: an operator override neither spends nor is blocked by the ≤2/24h starvation cap', () => {
  const s = makeOriginAndClones();
  try {
    // minutes-since-midnight, so a round that crosses the hour still advances the clock
    const T = (m) =>
      `2026-06-10T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`;
    // enqueue a fresh waiter at `atMin`, then demote 20 min later — past the 15-min staleMin,
    // so only the CAP (or the override) decides the outcome.
    const round = (waiter, atMin, extra = []) => {
      lq(s.B, ['enqueue', waiter, '--lane', 'free'], { LQ_FAKE_NOW: T(atMin) });
      return spawnSync('node', [CLI, 'demote', waiter, ...extra, '--json'], {
        cwd: s.B,
        encoding: 'utf8',
        env: { ...process.env, LQ_FAKE_NOW: T(atMin + 20) },
      });
    };
    const OVERRIDE = ['--operator-override', 'operator: reorder'];
    lq(s.A, ['enqueue', 'hog', '--lane', 'free'], { LQ_FAKE_NOW: T(0) });

    // auto #1 — allowed; then the demoter "lands" so hog is head again
    assert.equal(round('w1', 0).status, 0, 'auto-demote #1');
    lq(s.B, ['dequeue', 'w1']);
    // an OVERRIDE in the middle — must not consume the automatic budget
    assert.equal(round('w2', 20, OVERRIDE).status, 0, 'override');
    lq(s.B, ['dequeue', 'w2']);
    // auto #2 — still allowed, which is only true if the override above counted separately
    assert.equal(round('w3', 40).status, 0, 'auto-demote #2 (override did not spend the cap)');
    lq(s.B, ['dequeue', 'w3']);
    // auto #3 — the cap bites
    const capped = round('w4', 60);
    assert.equal(capped.status, 2, 'auto-demote #3 is capped');
    assert.match(capped.stderr, /starvation cap/i);
    // and the override is not bound by a cap it never spent
    const forced = spawnSync('node', [CLI, 'demote', 'w4', ...OVERRIDE, '--json'], {
      cwd: s.B,
      encoding: 'utf8',
      env: { ...process.env, LQ_FAKE_NOW: T(80) },
    });
    assert.equal(forced.status, 0, `override past the cap (stderr: ${forced.stderr})`);

    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    const doc = queueDocOnOrigin(s.A);
    assert.equal(
      (doc.match(/auto-demote: hog → tail/g) || []).length,
      2,
      'exactly the two automatic demotes are counted as automatic',
    );
    assert.equal(
      (doc.match(/operator-demote: hog → tail/g) || []).length,
      2,
      'and both overrides are recorded under the operator template',
    );
  } finally {
    s.cleanup();
  }
});

// The audit region is line-oriented and the detail is captured as `[^)]*`, so a reason
// carrying a newline or a paren would break the template and silently zero the operator
// counter. Normalization is what keeps an operator's own phrasing from doing that.
test('plan 3000: an override reason with parens and newlines still yields one parseable audit line', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['demote', 'waiter', '--operator-override', 'ruling (2026-08-08):\n  just force'], {
      LQ_FAKE_NOW: T0,
    });
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    const doc = queueDocOnOrigin(s.A);
    assert.match(
      doc,
      /^- \S+ — operator-demote: busy-head → tail \(operator override: ruling \[2026-08-08\]: just force\) by waiter( · attempt=\d+)?$/m,
      'one line, parens mapped to brackets, template intact',
    );
  } finally {
    s.cleanup();
  }
});

// The pure half: the normalizer's own contract, and the fact that the two counters read
// disjoint sets of lines rather than one being inferred from the other's absence.
test('plan 3000 (pure): normalizeOverrideReason bounds the reason; the two demote counters are disjoint', () => {
  assert.equal(normalizeOverrideReason('  a\n\tb  (c)  '), 'a b [c]');
  assert.equal(normalizeOverrideReason(''), '', 'blank is the "no reason" sentinel');
  assert.equal(normalizeOverrideReason(null), '');
  const long = normalizeOverrideReason('x'.repeat(OVERRIDE_REASON_MAX + 50));
  assert.equal(long.length, OVERRIDE_REASON_MAX, 'truncated to the bound');
  assert.ok(long.endsWith('…'), 'and visibly elided rather than silently cut');

  const iso = '2026-06-10T00:00:00.000Z';
  const lines = [
    `- ${iso} — auto-demote: hog → tail (heartbeat age 20m > 15m, not landing) by w1`,
    `- ${iso} — operator-demote: hog → tail (operator override: operator ruling) by w2`,
  ];
  assert.deepEqual(
    lines.map((l) => parseAuditLine(l).verb),
    ['demote', 'operator-demote'],
    'the shared grammar tells the two templates apart',
  );
  const nowMs = Date.parse(iso);
  assert.equal(demoteAuditCount(lines, 'hog', nowMs), 1, 'the cap counts only automatic demotes');
  assert.equal(
    operatorDemoteAuditCount(lines, 'hog', nowMs),
    1,
    'and the twin counts only overrides',
  );
});

// ── plan 3000 review fixes ─────────────────────────────────────────────────────────
// A `value` flag consumes the next token unconditionally, so the reason is exactly where a
// missing argument turns into a plausible-looking one — and here the value IS the
// accountability record, so a swallowed flag would produce an override justified by "--json".
test('plan 3000 (review fix): a flag-shaped override reason is a missing reason, not a justification', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free'], { LQ_FAKE_NOW: T0 });
    // both spellings — a `value` flag swallows the next token whatever its shape, and this
    // CLI declares no short aliases, so `-m` is a mistake exactly as `--json` is
    for (const swallowed of ['--json', '-m']) {
      const r = spawnSync('node', [CLI, 'demote', 'waiter', '--operator-override', swallowed], {
        cwd: s.B,
        encoding: 'utf8',
        env: { ...process.env, LQ_FAKE_NOW: T0 },
      });
      assert.equal(r.status, 5, `swallowed ${swallowed} must be an arg error, not a reason`);
      assert.match(r.stderr, /flag-shaped value/);
    }
    assert.equal(lqJson(s.A, ['status']).head, 'busy-head', 'nothing was written');
  } finally {
    s.cleanup();
  }
});

// The writer half of "an override is never anonymous": demoteVerdict refuses a reasonless
// override, so a reasonless OPERATOR_AXIS apply means the verdict was bypassed. It must fail
// loudly rather than record a placeholder that satisfies the template and defeats the rule.
test('plan 3000 (review fix, pure): applyDemote refuses to write an anonymous operator audit line', () => {
  const entries = [
    { slug: 'head', lane: '🟩', heartbeatIso: '2026-06-10T00:00:00.000Z' },
    { slug: 'waiter', lane: '🟩', heartbeatIso: '2026-06-10T00:00:00.000Z' },
  ];
  assert.throws(
    () =>
      applyDemote(entries, 'waiter', '2026-06-10T00:05:00.000Z', 0, 15, {
        staleAxis: OPERATOR_AXIS,
      }),
    /never anonymous/,
  );
  // and the same call WITH a reason writes the operator template
  const ok = applyDemote(entries, 'waiter', '2026-06-10T00:05:00.000Z', 0, 15, {
    staleAxis: OPERATOR_AXIS,
    operatorReason: 'operator ruling',
  });
  assert.match(ok.auditLine, /operator-demote: head → tail \(operator override: operator ruling\)/);
});

// The land-duration reader's whole job is "did this land LOSE the head mid-window" — the
// authority behind the release is irrelevant to it, but missing the event re-admits that
// land's unattributable waiters into the headline aggregate.
test('plan 3000 (review fix, pure): the land-duration audit reader counts an operator-demote as a head release', () => {
  const doc = [
    '<!-- QUEUE-START -->',
    '| slug | lane | session | host | enqueued | heartbeat |',
    '| --- | --- | --- | --- | --- | --- |',
    '<!-- QUEUE-END -->',
    '<!-- AUDIT-START -->',
    '- 2026-06-10T00:05:00.000Z — operator-demote: hog → tail (operator override: ruling) by w1',
    '<!-- AUDIT-END -->',
  ].join('\n');
  const events = parseQueueAudit(doc);
  assert.equal(events.length, 1, 'the release event must not be skipped');
  assert.equal(events[0].slug, 'hog', 'and it names the DISPLACED head, not the actor');
  assert.equal(events[0].verb, 'operator-demote');
});

// ── plan 3422 D5: the dead-land watchdog verdict ──────────────────────────────────────
// The 2026-08-24 audit's class 4: plan 2347's land died at a session boundary and went ~9h
// unnoticed; plan 3407's undersized timeout killed its land and nobody noticed ~50 min. The
// queue read IN_LAND throughout and nothing said otherwise.
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const deadBase = {
  headSlug: '2347-slug',
  headState: IN_LAND_STATE,
  headHost: 'WORKSTATION-TESTBOX1', // personal-data-ok: a synthetic hostname-shaped fixture, not a real machine
  thisHost: 'WORKSTATION-TESTBOX1', // personal-data-ok: a synthetic hostname-shaped fixture, not a real machine
  headHeartbeatIso: minsAgo(540), // 9 hours
  holderPidAlive: false, // the landing process is provably gone
  sidecar: null,
  nowMs: NOW,
};

test('plan 3422 D5: a stale heartbeat + a provably-dead landing process + no terminal record ⇒ ALARM', () => {
  const v = deadLandVerdict(deadBase);
  assert.equal(v.alarm, true);
  assert.match(v.reason, /landing process is GONE/);
});

test('plan 3422 D5: a FRESH queue heartbeat is never an alarm', () => {
  const v = deadLandVerdict({ ...deadBase, headHeartbeatIso: minsAgo(2) });
  assert.equal(v.alarm, false);
  assert.match(v.reason, /still fresh/);
});

test('plan 3422 D5: a land inside one LONG step is quiet, not dead — the live pid vetoes the alarm', () => {
  // A 47-minute pytest battery stamps no heartbeat while it runs, so heartbeat staleness alone
  // would cry wolf on exactly the lands that take longest. The process liveness is what separates
  // "quiet" from "dead", and it is immune to that problem.
  const v = deadLandVerdict({ ...deadBase, holderPidAlive: true });
  assert.equal(v.alarm, false);
  assert.match(v.reason, /still alive/);
});

test('plan 3422 D5: an UNPROBEABLE pid abstains — a death that cannot be proven is not alarmed', () => {
  const v = deadLandVerdict({ ...deadBase, holderPidAlive: null });
  assert.equal(v.alarm, false);
  assert.match(v.reason, /not probeable/);
});

test('plan 3422 D5: a head that is not IN_LAND is not a dead land', () => {
  assert.equal(deadLandVerdict({ ...deadBase, headState: null }).alarm, false);
  assert.equal(deadLandVerdict({ ...deadBase, headState: 'HOLDING' }).alarm, false);
});

test('plan 3422 D5: a cross-host head ABSTAINS — its sidecar is not readable from here', () => {
  const v = deadLandVerdict({ ...deadBase, thisHost: 'OTHER-PC' });
  assert.equal(v.alarm, false);
  assert.match(v.reason, /another host/);
  // …but the first DNS label is compared case-insensitively (Windows hostname()/`hostname` drift)
  assert.equal(
    deadLandVerdict({ ...deadBase, thisHost: 'workstation-testbox1.local' }).alarm, // personal-data-ok: synthetic hostname fixture
    true,
    'the same machine spelled differently must still alarm',
  );
});

test('plan 3422 D5: a terminal record for THIS residency is a stuck slot, not a death', () => {
  const v = deadLandVerdict({
    ...deadBase,
    sidecarMtimeMs: NOW - 600 * 60_000,
    sidecar: { code: 'LANDED_REVERSION', timestamp: minsAgo(500) }, // newer than the heartbeat
  });
  assert.equal(v.alarm, false);
  assert.match(v.reason, /terminal outcome/);
});

test('plan 3422 D5: a PREVIOUS attempt’s stale sidecar does not suppress the alarm (plan 2917)', () => {
  // plan 2917: a sidecar can hold the PRIOR attempt's outcome while the current land is running.
  // Reading that as "this land finished" is exactly the documented mistake. A record older than
  // the head's current heartbeat belongs to an earlier residency and must not silence the alarm.
  const v = deadLandVerdict({
    ...deadBase,
    sidecarMtimeMs: NOW - 900 * 60_000,
    sidecar: { code: 'LANDED_REVERSION', timestamp: minsAgo(900) }, // older than the heartbeat
  });
  assert.equal(v.alarm, true);
});

test('plan 3422 D5: every unknown resolves to NO alarm (fail-safe)', () => {
  assert.equal(deadLandVerdict({ ...deadBase, headSlug: null }).alarm, false);
  assert.equal(deadLandVerdict({ ...deadBase, headHeartbeatIso: null }).alarm, false);
  assert.equal(deadLandVerdict({ ...deadBase, headHeartbeatIso: 'not-a-date' }).alarm, false);
  assert.equal(deadLandVerdict({ ...deadBase, headHost: null }).alarm, false);
});

test('plan 3422 D5: the threshold is the plan-1682 demote clock, and the boundary is inclusive-fresh', () => {
  const atThreshold = deadLandVerdict({
    ...deadBase,
    headHeartbeatIso: minsAgo(DEFAULT_DEMOTE_STALE_MIN),
  });
  assert.equal(atThreshold.alarm, false, 'exactly at the threshold is still fresh');
  const past = deadLandVerdict({
    ...deadBase,
    headHeartbeatIso: minsAgo(DEFAULT_DEMOTE_STALE_MIN + 1),
  });
  assert.equal(past.alarm, true);
});

test('plan 3422 D5: the result sidecar is NOT a liveness signal — only a terminal one', () => {
  // The defect gpt-review caught across six angles in the first cut: `writeResultSidecar` runs
  // only on process EXIT, so its mtime can never corroborate a RUNNING land. A recent sidecar
  // that records no terminal outcome must therefore change nothing — the pid is what decides.
  const running = deadLandVerdict({ ...deadBase, sidecar: { timestamp: minsAgo(1) } });
  assert.equal(running.alarm, true, 'a codeless sidecar is not evidence of life');
  // …and with the pid alive, the same input is NOT an alarm — proving the pid, not the sidecar,
  // is what carries the liveness judgement.
  assert.equal(
    deadLandVerdict({ ...deadBase, holderPidAlive: true, sidecar: { timestamp: minsAgo(1) } })
      .alarm,
    false,
  );
});

test('plan 3422 D5: a SECOND death of the same slug is a new residency and alarms again', () => {
  // The latch the watcher keeps is keyed `<slug>@<headHeartbeatIso>`, not the slug alone: a slug
  // that lands, dies, is demoted, and later returns to the head is a NEW question. requeueEntry
  // refreshes heartbeatIso on every move, so the returning residency carries a different key.
  const first = `${deadBase.headSlug}@${deadBase.headHeartbeatIso}`;
  const laterIso = minsAgo(300);
  const second = `${deadBase.headSlug}@${laterIso}`;
  assert.notEqual(first, second, 'a later residency must not reuse the first one’s latch key');
  // …and the verdict itself still alarms on that later residency.
  assert.equal(deadLandVerdict({ ...deadBase, headHeartbeatIso: laterIso }).alarm, true);
});

// ── plan 3450: eviction without a live waiter (the 2026-08-25 dead-head wedge) ──────
// Head 3435 and its sole waiter 3424 were both dead cloud sessions. Every threshold was
// crossed, and nothing ran the verdicts: demote/steal/reap fire only from inside a live
// waiter's landing-queue-watch poll loop. The wedge cleared 65 min later only because an
// unrelated local session happened to enqueue. These pin both halves of the fix — the sweep
// that rides every MUTATE (Phase A) and the waiter-independent `sweep` verb (Phase C) —
// and, just as load-bearing, every gate the ghost caller does NOT get past.

test('plan 3450 Phase A: a dead head with a dead sole waiter is evicted by ONE fresh enqueue', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z'; // past the 15-min demote threshold
    // the incident shape: both entries stamped once at enqueue and never heartbeated again
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    assert.equal(lqJson(s.A, ['status']).head, 'dead-head', 'precondition: the corpse holds head');

    // a THIRD session arrives. No watcher runs anywhere — this single enqueue must evict.
    const out = lq(s.B, ['enqueue', 'newcomer', '--lane', 'free', '--session', '3'], {
      LQ_FAKE_NOW: T_STALE,
    });
    assert.match(out, /enqueued newcomer/, 'the caller still gets its own report first');

    const st = lqJson(s.A, ['status']);
    assert.equal(st.head, 'dead-waiter', 'the dead head was demoted by the enqueue itself');
    assert.equal(st.total, 3, 'a demote MOVES the head — nothing was removed');
    assert.equal(st.entries.at(-1).slug, 'dead-head');
    const doc = queueDocOnOrigin(s.A);
    assert.match(doc, /auto-demote: dead-head → tail \(.*\) by \(sweep\)/, 'audited as the ghost');
  } finally {
    s.cleanup();
  }
});

test('plan 3450 Phase A: the flagless heartbeat sweeps too — a live waiter evicts without its watcher', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'live-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    // the waiter's own timer tick — a ref stamp, no queue write of its own.
    // LQ_SWEEP_THROTTLE_MIN=0 takes the burst throttle out of the picture (production: at
    // most one mutate-path sweep per 5 min per checkout-family).
    lq(s.B, ['heartbeat', 'live-waiter'], { LQ_FAKE_NOW: T_STALE, LQ_SWEEP_THROTTLE_MIN: '0' });
    assert.equal(
      lqJson(s.A, ['status']).head,
      'live-waiter',
      'the heartbeat path ran the same verdicts a watcher poll would have',
    );
  } finally {
    s.cleanup();
  }
});

test('plan 3450: status never mutates, even with a dead head past every threshold', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_DEAD = '2026-06-10T02:00:00.000Z'; // past demote AND reap thresholds
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    for (const i of [1, 2]) {
      assert.equal(
        lqJson(s.A, ['status'], { LQ_FAKE_NOW: T_DEAD }).head,
        'dead-head',
        `read ${i}: status is a reporter, never a sweeper`,
      );
    }
    const doc = queueDocOnOrigin(s.A);
    assert.doesNotMatch(doc, /auto-demote|reap:/, 'no audit line — status wrote nothing at all');
  } finally {
    s.cleanup();
  }
});

test('plan 3450 Phase C: sweep evicts a dead head with ZERO live waiters and no new enqueue', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });

    // nobody enqueues, nobody heartbeats — the scheduled sweep is the only actor
    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(out.action, 'demoted');
    // review round 1 (F4): `head` is the head AFTER the sweep; the evicted slug is `target`.
    // Reporting the demoted entry as the current head told an operator (and any parser) that
    // the corpse still held the slot the sweep had just moved it off.
    assert.equal(out.target, 'dead-head', 'the payload names the slug it evicted');
    assert.equal(out.head, 'dead-waiter', 'and `head` is who holds the slot NOW');
    assert.equal(lqJson(s.B, ['status']).head, 'dead-waiter');

    // The promoted waiter is dead too, so the next sweep evicts IT — and that is where the
    // rotation STOPS: a demote re-stamps the moved entry's heartbeat as a fresh tail
    // residency, so a third sweep on the same clock finds nothing stale and exits 0 quietly.
    // (A sweep can never spin a queue of corpses; each pass costs each corpse one threshold.)
    const second = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(second.action, 'demoted');
    assert.equal(second.target, 'dead-waiter');
    assert.equal(second.head, 'dead-head', 'the rotation put the first corpse back at the front');
    const third = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(third.action, 'none', 'idempotent — nothing is stale any more');
    assert.equal(third.target, null, 'a no-op sweep evicted nothing, so it names nothing');
    assert.equal(third.refusal, null, 'and it JUDGED the head — a clean no-op, not a blind one');
  } finally {
    s.cleanup();
  }
});

test('plan 3450: sweep REFUSES (exit 2) when the fail-closed read cannot judge the queue', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-slug', '--lane', 'free']);
    assert.equal(lqJson(s.A, ['status']).head, 'head-slug', 'precondition: origin is reachable');
    execFileSync('git', ['-C', s.A, 'remote', 'set-url', 'origin', join(s.root, 'gone.git')]);
    const r = spawnSync('node', [CLI, 'sweep'], { cwd: s.A, encoding: 'utf8' });
    assert.equal(r.status, 2, 'a scheduled sweep must SEE that it could not judge, not report ok');
    assert.match(r.stderr, /could not be (fetched|read)/, 'the refusal names the unreadable half');
  } finally {
    s.cleanup();
  }
});

test('plan 3450: sweep never displaces a 🟢 LANDING head (the merge window is absolute)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_DEAD = '2026-06-10T02:00:00.000Z'; // past demote AND reap
    writeBoard(s.A, ['| busy-head | abc123 | 🟢 LANDING | plan | 2026-06-10 | — |']);
    lq(s.A, ['enqueue', 'busy-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_DEAD });
    assert.equal(out.action, 'none');
    assert.equal(lqJson(s.B, ['status']).head, 'busy-head', 'a mid-land head keeps its slot');
  } finally {
    s.cleanup();
  }
});

test('plan 3450: sweep never displaces an IN_LAND head (the free-lane liveness token)', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z'; // stale for demote, inside the IN_LAND leash
    lq(s.A, ['enqueue', 'lander', '--lane', 'free', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['mark-in-land', 'lander'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(
      out.action,
      'none',
      'demote is immunity-blocked and reap refuses IN_LAND outright',
    );
    assert.equal(lqJson(s.B, ['status']).head, 'lander');
  } finally {
    s.cleanup();
  }
});

test('plan 3450: sweep respects the DEMOTE_CAP starvation cap — the ghost spends the same budget', () => {
  const s = makeOriginAndClones();
  try {
    const T0 = '2026-06-10T00:00:00.000Z';
    lq(s.A, ['enqueue', 'hog', '--lane', 'free', '--session', '1'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['enqueue', 'w1', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T0 });
    lq(s.B, ['demote', 'w1'], { LQ_FAKE_NOW: '2026-06-10T00:20:00.000Z' });
    lq(s.B, ['dequeue', 'w1']);
    lq(s.B, ['enqueue', 'w2', '--lane', 'free', '--session', '2'], {
      LQ_FAKE_NOW: '2026-06-10T00:20:00.000Z',
    });
    lq(s.B, ['demote', 'w2'], { LQ_FAKE_NOW: '2026-06-10T00:40:00.000Z' });
    lq(s.B, ['dequeue', 'w2']);
    // the cap is spent. The sweep is not a way around it — and reap's own 45-min clock has
    // not run out on the freshly re-stamped tail residency either, so nothing fires.
    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: '2026-06-10T01:00:00.000Z' });
    assert.equal(out.action, 'none');
    assert.equal(
      lqJson(s.A, ['status']).head,
      'hog',
      'capped head holds — the steal is the recourse',
    );
  } finally {
    s.cleanup();
  }
});

test('plan 3450: a live head with a fresh heartbeat is untouched by every new path', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_NOW = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'live-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    // the head is alive: a REF heartbeat, the transport a live session actually uses
    lq(s.A, ['heartbeat', 'live-head'], { LQ_FAKE_NOW: T_NOW, LQ_SWEEP_THROTTLE_MIN: '0' });
    lq(s.B, ['enqueue', 'newcomer', '--lane', 'free', '--session', '3'], { LQ_FAKE_NOW: T_NOW });
    assert.equal(lqJson(s.A, ['status']).head, 'live-head', 'the mutate-path sweep left it alone');
    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_NOW });
    assert.equal(out.action, 'none', 'and so did the verb');
    assert.equal(lqJson(s.B, ['status']).head, 'live-head');
  } finally {
    s.cleanup();
  }
});

// ── plan 3450, review round 1 ───────────────────────────────────────────────────────
// Five defects the first cut shipped, each one a way for the sweep to report a healthy queue
// it had not actually cleaned: a fail-closed refusal collapsed into a clean `none`, a `pruned`
// count that was really the survivor count, the EVICTED head reported as the current one, the
// ghost resolving to "position 0", and the ghost name accepted at enqueue.
// (The sixth, a TOCTOU window before the board-row flip, is gone with the board half itself —
// that class now belongs to plan 3443's row reaper, not to this verb.)

// Write a queue row the CLI itself now refuses to create (F6) — the shape an older CLI, or a
// hand edit, could still leave behind. Duplicates the existing head row and renames it, so the
// row parses exactly like a real entry.
function injectRawQueueRow(cloneDir, copyOf, newSlug) {
  const doc = queueDocOnOrigin(cloneDir);
  const row = doc.split('\n').find((l) => l.startsWith(`| ${copyOf} |`));
  assert.ok(row, `precondition: a row for ${copyOf} exists to copy`);
  writeRawQueueDocOnOrigin(
    cloneDir,
    doc.replace(row, `${row}\n| ${newSlug} |${row.slice(row.indexOf('|', 2))}`),
    `inject ${newSlug}`,
  );
}

// F2. A queue holding a real `(sweep)` entry makes withGhostWaiter throw inside BOTH ghost
// verbs. That is the "unexpected internal error" class: the sweep evicted nothing and proved
// nothing, and it used to exit 0 reporting `action: none` — a scheduled task would have
// recorded a healthy run on a permanently wedged queue.
test('plan 3450 (review F2): a sweep that could not judge the head exits 2, never a clean `none`', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    injectRawQueueRow(s.A, 'dead-head', '(sweep)');

    const r = spawnSync('node', [CLI, 'sweep', '--json'], {
      cwd: s.A,
      encoding: 'utf8',
      env: { ...process.env, LQ_FAKE_NOW: T_STALE },
    });
    assert.equal(r.status, 2, 'the run could not judge the head — that is a failure, not a no-op');
    assert.match(r.stderr, /could not judge the queue head/);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.action, 'none', 'nothing was evicted…');
    assert.notEqual(payload.refusal, null, '…and the payload says WHY, not just "none"');
    assert.match(payload.refusal, /reserved ghost caller/);
    assert.equal(
      lqJson(s.B, ['status']).head,
      'dead-head',
      'the wedged head is still there — exactly what exit 0 would have hidden',
    );
  } finally {
    s.cleanup();
  }
});

// F2, the piggyback half: the mutate-path sweep KEEPS its never-fail-the-caller wrap (an
// enqueue reports a position the operator is waiting on), but a swallowed refusal must still
// be said out loud on stderr.
test('plan 3450 (review F2): the mutate-path sweep logs a swallowed refusal, and still never fails its caller', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    injectRawQueueRow(s.A, 'dead-head', '(sweep)');

    const r = spawnSync('node', [CLI, 'enqueue', 'newcomer', '--lane', 'free', '--session', '3'], {
      cwd: s.B,
      encoding: 'utf8',
      env: { ...process.env, LQ_FAKE_NOW: T_STALE },
    });
    assert.equal(r.status, 0, 'the enqueue itself is unaffected — by design');
    assert.match(r.stdout, /enqueued newcomer/);
    assert.match(r.stderr, /sweep could not judge the head/, 'no longer silent');
    assert.equal(lqJson(s.A, ['status']).total, 3, 'and the caller’s own write landed');
  } finally {
    s.cleanup();
  }
});

// F3. `pruned` reported the SURVIVING entries, so a queue with nothing to clean up claimed a
// cleanup of everything still in it.
test('plan 3450 (review F3): `pruned` counts the landed orphans removed, not the entries left', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'live-one', '--lane', 'free', '--session', '1']);
    lq(s.B, ['enqueue', 'live-two', '--lane', 'free', '--session', '2']);
    const clean = lqJson(s.A, ['sweep']);
    assert.equal(clean.pruned, 0, 'two live entries and no orphans is a prune of ZERO');
    assert.equal(clean.queued, 2, 'the survivors are `queued` — a separate number');

    // now one of them lands (its plan is archived) and its dequeue crashes: a landed orphan
    archivePlan(s.A, 'live-one');
    const swept = lqJson(s.A, ['sweep']);
    assert.equal(swept.pruned, 1, 'exactly the one orphan removed');
    assert.equal(swept.queued, 1);
    assert.equal(lqJson(s.B, ['status']).head, 'live-two');
  } finally {
    s.cleanup();
  }
});

// F5. `positionOf` returns 0 for an absent entry, and the ghost is absent from the real queue
// by construction — so the captured demote line said "(sweep) at position 0/2" beside a demote
// that had in fact succeeded.
test('plan 3450 (review F5): the ghost never appears as a queue position in the sweep’s output', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });

    // human output: the captured verb text is printed, so this is where the ghost leaked
    const r = spawnSync('node', [CLI, 'sweep'], {
      cwd: s.A,
      encoding: 'utf8',
      env: { ...process.env, LQ_FAKE_NOW: T_STALE },
    });
    assert.equal(r.status, 0);
    const all = `${r.stdout}\n${r.stderr}`;
    assert.match(all, /demoted dead-head/, 'precondition: the eviction happened');
    assert.doesNotMatch(all, /at position 0/, 'no absent-entry position is ever printed');
    assert.doesNotMatch(all, /\(sweep\) at position/, 'and least of all for the ghost');
    assert.match(all, /asked by the sweep, which is not a queue member/);
  } finally {
    s.cleanup();
  }
});

// F6. The collision guard that keeps the ghost safe was asserted only where the queue is
// JUDGED. Enforce it where entries are CREATED, or the assert only ever fires too late.
test('plan 3450 (review F6): the reserved ghost name is refused by every entry-creating verb', () => {
  const s = makeOriginAndClones();
  try {
    for (const args of [
      ['enqueue', '(sweep)', '--lane', 'free'],
      ['reenter', '(sweep)', '--lane', 'free'],
      ['requeue', '(sweep)', '--lane', 'free'],
    ]) {
      const r = spawnSync('node', [CLI, ...args], { cwd: s.A, encoding: 'utf8' });
      assert.equal(r.status, 5, `${args[0]} must refuse the ghost name (a malformed request)`);
      assert.match(r.stderr, /cannot be a queue entry/);
    }
    assert.equal(lqJson(s.A, ['status']).total, 0, 'nothing was written by any of them');
    // the guard is scoped to the writing verbs: a read/no-op verb keeps its old behaviour
    assert.equal(
      spawnSync('node', [CLI, 'dequeue', '(sweep)'], { cwd: s.A, encoding: 'utf8' }).status,
      0,
      'dequeue of a name that cannot exist stays the documented idempotent no-op',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 3450, review round 2 ───────────────────────────────────────────────────────
// Four more ways the sweep could report more (or less) than it had actually established: a
// prune count that saw only its own first mutate, a stage failure discarded because a later
// stage worked, a post-sweep report filtered against this checkout's mutable working tree
// instead of origin/master, and a failed sweep buying itself five minutes of immunity from
// the retry that would have fixed the queue.

// G1. `pruned` is the number of landed orphans THE SWEEP removed. It is summed across every
// mutate the sweep performs — step 1's explicit prune plus the eviction ladder's own, since
// mutateQueue prunes before every transform. (The under-count that motivated the fix needs a
// plan to land BETWEEN step 1 and the ladder, which a single-process test cannot stage; what
// is pinned here is the arithmetic that makes the sum right either way — an orphan removed
// once is reported once, never twice, even when an eviction runs in the same sweep.)
test('plan 3450 (review round 2, G1): `pruned` sums the whole sweep and never double-counts one orphan', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'landed-head', '--lane', 'free', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '3'], { LQ_FAKE_NOW: T_OLD });
    // the head landed and its dequeue crashed: one orphan for step 1, and the corpse behind it
    // is stale enough for the eviction ladder to run its own mutate in the same sweep.
    archivePlan(s.A, 'landed-head');

    const out = lqJson(s.A, ['sweep'], { LQ_FAKE_NOW: T_STALE });
    assert.equal(out.pruned, 1, 'exactly one orphan was removed by this sweep, counted once');
    assert.equal(out.action, 'demoted', 'and the eviction ladder ran its own mutate as well');
    assert.equal(out.target, 'dead-head');
    assert.equal(out.queued, 2, 'the survivors are a separate number from the removals');
    assert.equal(lqJson(s.B, ['status']).head, 'dead-waiter');
  } finally {
    s.cleanup();
  }
});

// G2. `unjudged` is the sweep's refusal channel, and it must be read on EVERY exit — not only
// the `none` one. A demote that threw an unexpected internal error followed by a reap that
// happened to work returned `refusal: null`, so a scheduled sweep recorded a clean success
// over a rung that had proved nothing. Both stages' failures are retained and named.
test('plan 3450 (review round 2, G2): a failed demote stage is retained on the refusal channel, named per stage', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.B, ['enqueue', 'dead-waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    injectRawQueueRow(s.A, 'dead-head', '(sweep)');

    const r = spawnSync('node', [CLI, 'sweep', '--json'], {
      cwd: s.A,
      encoding: 'utf8',
      env: { ...process.env, LQ_FAKE_NOW: T_STALE },
    });
    assert.equal(r.status, 2);
    const payload = JSON.parse(r.stdout);
    assert.match(
      payload.refusal,
      /demote:/,
      'the demote stage failed and says so — it is never dropped for what a later stage did',
    );
    assert.match(payload.refusal, /reap:/, 'and the reap stage is named separately, not merged');
    assert.equal(
      lqJson(s.B, ['status']).head,
      'dead-head',
      'nothing was evicted, which is exactly what the refusal is reporting',
    );
  } finally {
    s.cleanup();
  }
});

// G5. The throttle stamp is the record of a sweep that JUDGED the head. Stamped before the
// verdicts ran, one transient fault bought the wedge five more minutes of immunity from every
// heartbeat-triggered retry — the opposite of what a failed sweep should cost.
test('plan 3450 (review round 2, G5): a sweep that could not judge leaves the throttle unstamped, so the next mutate retries', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T00:20:00.000Z';
    lq(s.A, ['enqueue', 'dead-head', '--lane', 'seed', '--session', '1'], { LQ_FAKE_NOW: T_OLD });
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2'], { LQ_FAKE_NOW: T_OLD });
    injectRawQueueRow(s.A, 'dead-head', '(sweep)');
    // NO LQ_SWEEP_THROTTLE_MIN override: the production 5-minute window is in force, and both
    // pings sit on the same frozen clock inside it.
    const ping = () =>
      spawnSync('node', [CLI, 'heartbeat', 'waiter'], {
        cwd: s.A,
        encoding: 'utf8',
        env: { ...process.env, LQ_FAKE_NOW: T_STALE },
      });
    const first = ping();
    assert.equal(first.status, 0, 'the heartbeat itself is never failed by its piggyback sweep');
    assert.match(first.stderr, /sweep could not judge the head/, 'precondition: the sweep failed');
    const second = ping();
    assert.equal(second.status, 0);
    assert.match(
      second.stderr,
      /sweep could not judge the head/,
      'the failed sweep did not spend the throttle — the very next ping tries the wedge again',
    );
  } finally {
    s.cleanup();
  }
});

// ── plan 3459: one pinned origin snapshot for every displacement verdict ────────────────
// Every verb reads the queue doc at origin/master and then filters it through two OTHER
// questions — "has this plan landed?" and "does this batch still hold a claim manifest?".
// Those two used to be answered against the MUTABLE working tree, and issued independently
// of the doc read. These pin the fix on all three axes the plan names: a behind checkout
// (both directions), an unreadable read (a refusal, never a prune), and the pinning itself.

// Delete the git object backing `pathAtOrigin` in `cloneDir` — a TREE (so any walk through
// that directory faults) or a BLOB (so the path still lists but its content cannot be read).
// The commit itself still resolves either way. This is deliberately a real store corruption,
// not a mocked reader: the whole defect is that `git show` cannot tell an absent path from an
// unreadable one, so a fake reader would be asserting the seam against the very abstraction
// under test.
//
// Stable rather than flaky, for two reasons. (1) These fixtures are tiny, so git keeps every
// transferred object LOOSE (well under transfer.unpackLimit); the post-condition below asserts
// the object really became unreadable, so a future git that packs them fails LOUDLY here
// instead of silently turning these tests into no-ops. (2) A later `git fetch origin master`
// is a no-op once the refs already match, so the corruption survives the fetch every verb
// performs. (Injecting a fake refs/remotes/origin/master instead does NOT survive: an explicit
// `git fetch origin master` opportunistically updates the remote-tracking ref, measured here.)
function breakObjectAt(cloneDir, spec) {
  const pathAtOrigin = spec.includes(':') ? spec : `origin/master:${spec}`;
  const sha = execFileSync('git', ['-C', cloneDir, 'rev-parse', pathAtOrigin], {
    encoding: 'utf8',
  }).trim();
  rmSync(join(cloneDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true });
  // The property the fixture actually needs, asserted directly rather than inferred from the
  // loose-file layout: the object is now UNREADABLE. If a git version or config kept a packed
  // copy, this fails here — a loud fixture failure, never a test that quietly proves nothing.
  const probe = spawnSync('git', ['-C', cloneDir, 'cat-file', '-e', sha], { encoding: 'utf8' });
  assert.notEqual(
    probe.status,
    0,
    `fixture precondition: ${pathAtOrigin}'s object ${sha} must be unreadable after deleting ` +
      `its loose file (a packed copy would leave this test asserting nothing — unpack first)`,
  );
}

const lqRaw = (cwd, args, env = {}) =>
  spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

test('plan 3459: a clone whose WORKING TREE is behind origin/master judges the head identically to an up-to-date one', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'landed-head', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'real-head', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    // A lands its plan: docs/superpowers/plans/archive/landed-head.md is now on origin/master.
    archivePlan(s.A, 'landed-head');
    // B has never pulled, so its working tree has no archive/ directory at all — the exact
    // shape that made the pre-3459 existsSync ground truth report a landed plan as still live.
    assert.equal(
      existsSync(join(s.B, 'docs', 'superpowers', 'plans', 'archive')),
      false,
      'fixture precondition: B is BEHIND — nothing on disk says landed-head landed',
    );
    for (const [name, dir] of [
      ['A (up to date)', s.A],
      ['B (behind)', s.B],
    ]) {
      const st = lqJson(dir, ['status']);
      assert.equal(st.head, 'real-head', `${name}: the landed orphan must not hold the slot`);
      assert.equal(st.total, 1, `${name}: the landed orphan is pruned from the view`);
    }
  } finally {
    s.cleanup();
  }
});

test('plan 3459: an archive entry present ONLY in the local working tree never prunes a LIVE queue entry', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'live-head', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    // B writes the archive marker locally and NEVER commits it — a half-finished land, a
    // stray file, a branch checked out in this tree. origin/master has never seen it.
    mkdirSync(join(s.B, 'docs', 'superpowers', 'plans', 'archive'), { recursive: true });
    writeFileSync(join(s.B, 'docs', 'superpowers', 'plans', 'archive', 'live-head.md'), '# x\n');
    // This is the direction that PRUNES A LIVE ENTRY: pre-3459 the existsSync read this as
    // "live-head landed" and handed the slot to `waiter` on nothing but local dirt.
    const st = lqJson(s.B, ['status']);
    assert.equal(st.head, 'live-head', 'a local-only archive file must not evict the real head');
    assert.equal(st.total, 2);
    assert.deepEqual(
      lqJson(s.A, ['status']).entries.map((e) => e.slug),
      ['live-head', 'waiter'],
    );
  } finally {
    s.cleanup();
  }
});

test('plan 3459: an UNREADABLE archive tree refuses (exit 2) rather than pruning, and never reports a clean "none"', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-x', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    // Put a docs/ tree on origin (an unrelated land), then let B fetch it…
    archivePlan(s.A, 'some-other-plan');
    lq(s.B, ['status']);
    // …and corrupt B's copy of it. The commit still resolves and the queue doc still reads;
    // only the walk into docs/ faults.
    breakObjectAt(s.B, 'docs');

    // status is a read-only reporter: it DEGRADES (exit 0, nothing pruned) and says so.
    const st = lqRaw(s.B, ['status', '--json']);
    assert.equal(st.status, 0, 'status never becomes a blocker');
    assert.match(st.stderr, /status could not judge landed-ness/);
    assert.equal(JSON.parse(st.stdout).total, 2, 'unjudgeable ⇒ every entry survives the view');

    // The PRUNING displacement verbs REFUSE instead. Each refuses on the landed-ness axis
    // before it ever reaches its staleness verdict, so no clock fixture is needed.
    //
    // `steal` is deliberately absent from this list: it is the one verb that does NOT prune
    // (mutateQueue prune:false — pruning before its inside-mutate re-verdict would make a
    // stealer whose only blocker was a reaped orphan throw "already head" and discard the
    // write, plan 574). Its ground-truth reads are the batch manifest and the board, and
    // those DO refuse — see the manifest test below.
    for (const args of [
      ['demote', 'waiter'],
      ['reap', 'waiter'],
      ['overtake', 'waiter'],
    ]) {
      const r = lqRaw(s.B, args);
      assert.equal(r.status, 2, `${args[0]} must refuse an unjudgeable queue`);
      assert.match(
        r.stderr,
        /cannot judge which queue entries have landed/,
        `${args[0]} names the axis it could not read`,
      );
    }

    // …and the scheduled caller must see a refusal, never "nothing to do".
    const sw = lqRaw(s.B, ['sweep', '--json']);
    assert.equal(sw.status, 2);
    assert.doesNotMatch(sw.stdout, /"action":"none"/, 'a fault is never a clean none');
  } finally {
    s.cleanup();
  }
});

test('plan 3459: an UNREADABLE batch manifest refuses — it must never read as "the batch landed"', () => {
  const s = makeOriginAndClones();
  try {
    // The manifest goes in FIRST: a batch entry with no manifest is "landed" by definition, so
    // enqueueing before writing it would have the enqueue's own self-heal prune reap the entry
    // on the spot — and this test would then pass for entirely the wrong reason.
    writeBatchManifest(s.A, 'batch-live');
    lq(s.A, ['enqueue', 'batch-live', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    lq(s.B, ['status']);
    // Corrupt ONLY the batches tree, so the archive axis still answers cleanly and this test
    // isolates the manifest axis — the worse of the two, because `[]` members also makes the
    // batch-aware 🟢 LANDING gate a no-op and lets a steal double-land the lane.
    breakObjectAt(s.B, 'docs/superpowers/batches');

    const st = lqRaw(s.B, ['status', '--json']);
    assert.equal(st.status, 0);
    assert.equal(
      JSON.parse(st.stdout).head,
      'batch-live',
      'an unreadable manifest must never demote the batch to a phantom',
    );

    const d = lqRaw(s.B, ['demote', 'waiter']);
    assert.equal(d.status, 2);
    assert.match(d.stderr, /batch-live's claim manifest/);
    // The legacy candidate is NOT consulted after a fault at the new path: once the first
    // read faulted the batch's liveness is genuinely unknown, and "the legacy path is also
    // absent" would be exactly the false "it landed" conclusion this plan closes.
    assert.doesNotMatch(d.stderr, /docs\/handoff\/batches/);
  } finally {
    s.cleanup();
  }
});

test('plan 3459: the prune answers from the PINNED SHA alone — not the working tree, not "now"', () => {
  const s = makeOriginAndClones();
  try {
    // Two commits: before and after a land of `plan-x`.
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    const before = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    archivePlan(s.A, 'plan-x');
    const after = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    assert.notEqual(before, after);

    const entries = [{ slug: 'plan-x' }, { slug: 'waiter' }];
    const slugsAt = (sha) =>
      pruneAllLanded(groundTruthSource(s.A, sha), entries).entries.map((e) => e.slug);

    // The SAME checkout, the SAME call, the SAME instant — two answers, decided purely by the
    // sha each source was pinned to. That is the property: a land that happens between two
    // reads of one verdict cannot change the answer, because the second read is not addressed
    // at a moving ref at all.
    assert.deepEqual(slugsAt(before), ['plan-x', 'waiter'], 'not landed at the earlier commit');
    assert.deepEqual(slugsAt(after), ['waiter'], 'landed at the later commit');

    // And mutating the working tree under both moves neither answer.
    rmSync(join(s.A, 'docs', 'superpowers', 'plans', 'archive', 'plan-x.md'), { force: true });
    assert.deepEqual(slugsAt(before), ['plan-x', 'waiter']);
    assert.deepEqual(slugsAt(after), ['waiter'], 'the pinned read ignores the working tree');
  } finally {
    s.cleanup();
  }
});

test('plan 3459: a working-tree fallback DROPS the sha — a source is never "pinned" to a snapshot its doc did not come from', () => {
  const s = makeOriginAndClones();
  try {
    const sha = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(groundTruthSource(s.A, sha).sha, sha, 'a pinned source carries its commit');
    // readFresh nulls originSha on every fallback path; a null sha must degrade to the working
    // tree rather than silently claiming a pin. Carrying a non-null sha beside a working-tree
    // doc is the one shape that defeats the whole property (plan 3450 round-4 finding).
    assert.equal(groundTruthSource(s.A, null).sha, null);
    mkdirSync(join(s.A, 'docs', 'superpowers', 'plans', 'archive'), { recursive: true });
    writeFileSync(join(s.A, 'docs', 'superpowers', 'plans', 'archive', 'uncommitted.md'), '#\n');
    assert.equal(groundTruthSource(s.A, null).landed('uncommitted').state, 'present');
    assert.equal(groundTruthSource(s.A, sha).landed('uncommitted').state, 'absent');
  } finally {
    s.cleanup();
  }
});

// ── plan 3459, review round 1 fixes ─────────────────────────────────────────────────────
// Eleven of the round's twenty-three findings said one thing in eleven ways: the seam
// advertises a tri-state ground truth, but three of its reads could still only ever answer
// present/absent — so an unreadable one silently became "not there", which is the exact
// collapse the plan exists to close, just applied to the queue doc, the working-tree source
// and the board instead of to the archive.

test('plan 3459 (review): an UNREADABLE queue doc at a resolvable sha refuses — it is not a working-tree fallback', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-x', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    lq(s.B, ['status']); // B fetches the doc blob…
    // plan 3973: …on the queue ref. Break THAT blob: the ref still resolves, its doc does not.
    breakObjectAt(s.B, `${QUEUE_REF_LOCAL}:${QUEUE_DOC_NAME}`);

    // `docFetched` is still true (the fetch succeeded and the ref resolves), so the
    // pre-existing doc refusal cannot see this. Absent-at-a-commit would be data; unreadable
    // is not.
    for (const args of [
      ['demote', 'waiter'],
      ['reap', 'waiter'],
      ['overtake', 'waiter'],
    ]) {
      const r = lqRaw(s.B, args);
      assert.equal(r.status, 2, `${args[0]} must refuse an unreadable queue doc`);
      assert.match(
        r.stderr,
        /could not be trusted from the queue ref/,
        `${args[0]} names the fault`,
      );
    }
    // status stays a reporter: it says the doc could not be read and that the empty queue it
    // prints is empty BECAUSE nothing could be read (plan 3973: there is no working-tree copy
    // to fall back to any more — the doc has no working-tree footprint at all).
    const st = lqRaw(s.B, ['status', '--json']);
    assert.equal(st.status, 0);
    assert.match(st.stderr, /could not be trusted from refs\/heads\/coord\/landing-queue/);
    assert.match(st.stderr, /EMPTY because nothing could be read/);
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review): the WORKING-TREE source can report a fault too — it is a degraded source, not a fault-free one', () => {
  const s = makeOriginAndClones();
  try {
    const src = groundTruthSource(s.A, null);
    // A path that exists but cannot be read AS A FILE (EISDIR) is the deterministic
    // root-proof stand-in for any read fault — chmod proves nothing when the suite runs as
    // root, which it does in every cloud drain. The board path comes from the repo's own
    // config, never hard-coded: a config-less fixture uses the legacy root-level path.
    const boardAbs = join(s.A, loadCoordConfig(s.A).paths.boardFile);
    rmSync(boardAbs, { force: true });
    mkdirSync(boardAbs, { recursive: true });
    assert.equal(src.board().state, 'fault', 'an unreadable board is a fault, never "no rows"');

    mkdirSync(join(s.A, 'docs', 'superpowers', 'batches', 'batch-x'), { recursive: true });
    mkdirSync(join(s.A, 'docs', 'superpowers', 'batches', 'batch-x', 'manifest.json'), {
      recursive: true,
    });
    assert.ok(src.manifest('batch-x').fault, 'an unreadable manifest is a fault, never absent');

    // And an archive ENTRY that is not a file is not a landed plan — `existsSync` said it was.
    mkdirSync(join(s.A, 'docs', 'superpowers', 'plans', 'archive', 'live.md'), {
      recursive: true,
    });
    assert.equal(src.landed('live').state, 'absent', 'a directory is not a landed plan file');
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review): the PINNED archive probe requires a blob — a directory of that name is not a landed plan', () => {
  const s = makeOriginAndClones();
  try {
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    const dir = join(s.A, 'docs', 'superpowers', 'plans', 'archive', 'live-head.md');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'inner.md'), '# not the archive entry\n');
    execFileSync('git', ['-C', s.A, 'add', '-A']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'a directory shaped like an archive entry']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    const sha = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    // `ls-tree -- <rel>` reports the directory entry, so a name-only probe would call this
    // landed and the self-heal would prune a LIVE queue entry off it.
    assert.equal(groundTruthSource(s.A, sha).landed('live-head').state, 'absent');
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review): the pinned source resolves coord paths at ITS OWN sha, not from mutable local config', () => {
  const s = makeOriginAndClones();
  try {
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    mkdirSync(join(s.A, 'coord-at-sha'), { recursive: true });
    const cfg = (handoffDir) => JSON.stringify({ handoffLayout: 'sessions', handoffDir });
    writeFileSync(join(s.A, 'coord.config.json'), cfg('coord-at-sha'));
    writeFileSync(join(s.A, 'coord-at-sha', 'board.md'), '# board at the pinned sha\n');
    execFileSync('git', ['-C', s.A, 'add', '-A']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord config + board']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    const sha = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    // Now the LOCAL config disagrees with the committed one — a stale checkout, a
    // half-applied path migration. Reading the board path from it would probe a path that
    // does not exist at the pinned commit, read "absent", and vacuously clear the one
    // refusal protecting an actively-landing head.
    writeFileSync(join(s.A, 'coord.config.json'), cfg('somewhere-else'));
    const board = groundTruthSource(s.A, sha).board();
    assert.equal(board.state, 'present');
    assert.match(board.raw, /board at the pinned sha/);
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review r2): an unreadable coord.config.json, and an unreadable local queue doc, are faults — not a quiet fall-back', () => {
  const s = makeOriginAndClones();
  try {
    // (1) The PINNED config. Falling back to this checkout's coord.config.json when the
    // committed one cannot be READ re-creates the very collapse round 1 closed, one level
    // further out: the seam would then probe whatever paths the local file names, miss the
    // board at the pinned commit, read "absent", and vacuously clear the 🟢 LANDING refusal.
    // Absent at the commit is still data (a repo that has no coord.config.json) and still
    // falls back.
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    mkdirSync(join(s.A, 'coord.config.json'), { recursive: true });
    writeFileSync(join(s.A, 'coord.config.json', 'inner'), 'not a config\n');
    execFileSync('git', ['-C', s.A, 'add', '-A']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord.config.json as a directory']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    const sha = execFileSync('git', ['-C', s.A, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    const pinned = groundTruthSource(s.A, sha);
    assert.equal(pinned.board().state, 'fault', 'an unreadable pinned config is a fault');
    // plan 3973: the queue doc is no longer a member of the snapshot (it lives on its own ref,
    // read through landing-queue-ref.mjs — its own tri-state is pinned in that name-paired
    // suite), so the (2) working-tree queue-doc cases of this test are gone with it.
    assert.equal('queueDoc' in pinned, false);

    // The local config goes back to readable first: `loadCoordConfig` is the LOCAL read and
    // throws outright on an unreadable file (coord-config.mjs's own behaviour, out of this
    // seam's scope), so leaving the directory in place would crash the fixture, not the code.
    rmSync(join(s.A, 'coord.config.json'), { recursive: true, force: true });

    // (3) ENOTDIR — a wrong-type PARENT component — is a fault for a content read too. The
    // file is not merely missing: something is sitting in its path that should not be. The
    // manifest path is docs/superpowers/batches/<slug>/manifest.json, so making `batches` a
    // FILE puts a non-directory mid-path and readFileSync raises ENOTDIR, not ENOENT.
    const batchesDir = join(s.A, 'docs', 'superpowers', 'batches');
    rmSync(batchesDir, { force: true, recursive: true });
    mkdirSync(join(batchesDir, '..'), { recursive: true });
    // A genuinely missing manifest first — that direction must stay plain data.
    assert.equal(groundTruthSource(s.A, null).manifest('batch-x').fault, null, 'absent ⇒ data');
    writeFileSync(batchesDir, 'a file where the batches directory should be\n');
    // Windows and POSIX genuinely DISAGREE about this errno: reading through a file-as-directory
    // raises ENOTDIR on POSIX but ENOENT on Windows (probed 2026-08-26). `readFile` can only
    // classify what the platform reports, so on Windows a wrong-type parent is INDISTINGUISHABLE
    // from an absent manifest. Pinning the POSIX answer made this suite pass on the Linux cloud
    // drains and fail on every Windows land — the exact half-injection vetapp/CLAUDE.md forbids
    // ("a test exercising a platform-specific branch must make the platform a PARAMETER"), and it
    // blocked unrelated local lands until 2026-08-26. So probe what THIS platform can express and
    // assert the corresponding contract; the residual Windows behavioural gap (the code cannot
    // raise the fault it would like to) is recorded in docs/handoff/infra-debt.md for this test's
    // owning plan to decide on — papering over it here would hide it.
    const wrongTypeParentIsDistinguishable = (() => {
      try {
        readFileSync(join(batchesDir, 'probe', 'manifest.json'), 'utf8');
        return false; // unreachable in practice; a successful read is certainly not a fault
      } catch (error) {
        return error?.code !== 'ENOENT';
      }
    })();
    const wrongTypeParent = groundTruthSource(s.A, null).manifest('batch-x');
    if (wrongTypeParentIsDistinguishable) {
      assert.ok(
        wrongTypeParent.fault,
        'a wrong-type parent component (ENOTDIR) is a fault, never an absent manifest',
      );
    } else {
      assert.equal(
        wrongTypeParent.fault,
        null,
        'on a platform reporting ENOENT for a wrong-type parent, the read degrades to absent — see docs/handoff/infra-debt.md',
      );
    }
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review r2) + 3973: readFresh REFUSES on an unreadable queue doc — there is no working-tree copy to fall back to', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-x', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '2', '--host', 'PC-B']);
    lq(s.B, ['status']);
    // The ref's doc unreadable → there is no usable queue anywhere (plan 3973: the doc has no
    // working-tree footprint) and the verb must say so rather than judging an empty one (which
    // reads as "nobody is queued" — every entry silently gone).
    breakObjectAt(s.B, `${QUEUE_REF_LOCAL}:${QUEUE_DOC_NAME}`);
    const r = lqRaw(s.B, ['demote', 'waiter']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot judge the queue/);
  } finally {
    s.cleanup();
  }
});

test('plan 3459 (review r4) + 3973: when the queue doc faults, status says so — it never calls an empty queue "your copy"', () => {
  const s = makeOriginAndClones();
  try {
    lq(s.A, ['enqueue', 'head-x', '--lane', 'seed', '--session', '1', '--host', 'PC-A']);
    lq(s.B, ['status']);
    breakObjectAt(s.B, `${QUEUE_REF_LOCAL}:${QUEUE_DOC_NAME}`); // the ref's doc is unreadable
    const st = lqRaw(s.B, ['status', '--json']);
    assert.equal(st.status, 0, 'status stays a reporter');
    assert.equal(JSON.parse(st.stdout).total, 0, 'there is genuinely nothing readable to show');
    // The message is the whole point: an operator debugging a wedge must not read this empty
    // queue as "nobody is queued" and act on it.
    assert.match(st.stderr, /EMPTY because nothing could be read, NOT because nobody is queued/);
    assert.doesNotMatch(st.stderr, /showing this checkout's own copy instead/);
  } finally {
    s.cleanup();
  }
});

test('plan 2331 + 3459: reap judges the LIVE queue — a landed orphan at head is pruned from its verdict, not reaped as if live', () => {
  const s = makeOriginAndClones();
  try {
    const T_OLD = '2026-06-10T00:00:00.000Z';
    const T_STALE = '2026-06-10T02:00:00.000Z';
    lq(s.A, ['enqueue', 'landed-orphan', '--lane', 'seed', '--session', '1', '--host', 'PC-A'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.A, ['enqueue', 'real-head', '--lane', 'free', '--session', '2', '--host', 'PC-B'], {
      LQ_FAKE_NOW: T_OLD,
    });
    lq(s.A, ['enqueue', 'waiter', '--lane', 'free', '--session', '3', '--host', 'PC-C'], {
      LQ_FAKE_NOW: T_OLD,
    });
    archivePlan(s.A, 'landed-orphan');
    // `reap` prunes landed orphans BEFORE its verdict (plan 2331's own cmdReap body) so the
    // verdict describes the LIVE queue. Asserted through the reap verb itself rather than only
    // through status/demote: the three verbs share one prune core, but this is the call site
    // plan 2331 authored, and the adversarial landed-reversion review of the plan-3459 refactor
    // flagged it as the one dropped-line pair whose coverage was indirect. `real-head`, not the
    // orphan, must be the entry the reap is judged against.
    const r = lqRaw(s.B, ['reap', 'waiter', '--stale-min', '1', '--grace-min', '1', '--json'], {
      LQ_FAKE_NOW: T_STALE,
    });
    const said = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(said, /landed-orphan/, 'the reap never judges an already-landed entry');
    assert.match(said, /real-head/, 'it judges the entry that actually holds the slot');
    // …and the orphan is gone from the queue either way.
    assert.doesNotMatch(
      JSON.stringify(lqJson(s.A, ['status']).entries.map((e) => e.slug)),
      /landed-orphan/,
    );
  } finally {
    s.cleanup();
  }
});
