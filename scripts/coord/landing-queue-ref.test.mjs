// scripts/landing-queue-ref.test.mjs — name-pair of landing-queue-ref.mjs (plan 3973).
// Justification for a new test FILE: the name-pair of a genuinely new module (the queue
// document's coord-ref transport). Unit half: every git call goes through the injected
// `gitImpl`, so the CAS loop's win / non-ff-retry / exhaustion / absent-vs-fault / bootstrap-race
// branches are driven without a network or a real origin. End-to-end half: a bare origin with
// two clones proves that the queue verbs write ZERO commits on master and advance the ref.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUEUE_REF,
  QUEUE_REF_LOCAL,
  QUEUE_FETCH_REFSPEC,
  QUEUE_DOC_NAME,
  QUEUE_ATTEMPT_TRAILER,
  readQueueRef,
  readQueueDoc,
  readMasterQueueDoc,
  writeQueueRefCAS,
  bootstrapQueueRef,
  mutateQueueRef,
  migrateNeededMessage,
  masterDocDivergence,
} from './landing-queue-ref.mjs';
import {
  initialQueueDoc,
  parseQueue,
  QUEUE_START,
  QUEUE_END,
  AUDIT_START,
  AUDIT_END,
  renderQueue,
  enqueueEntry,
  QUEUE_TOMBSTONE,
  isQueueTombstone,
} from './landing-queue-lib.mjs';
import { coordRef } from './coord-refs.mjs';
import { scriptFile } from '../test-helpers/repo-script-path.mjs';

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

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = scriptFile('landing-queue.mjs', HERE);

// ── constants ───────────────────────────────────────────────────────────────────────────────

test('the ref names come from coord-refs.mjs and the local view is the remote-tracking ref (D1)', () => {
  assert.equal(QUEUE_REF, coordRef('landing-queue'));
  assert.equal(QUEUE_REF, 'refs/heads/coord/landing-queue');
  assert.equal(QUEUE_REF_LOCAL, 'refs/remotes/origin/coord/landing-queue');
  assert.equal(QUEUE_FETCH_REFSPEC, `+${QUEUE_REF}:${QUEUE_REF_LOCAL}`);
  assert.equal(QUEUE_DOC_NAME, 'landing-queue.md');
});

test('the tombstone round-trips through isQueueTombstone and names the ref + the verb', () => {
  assert.equal(isQueueTombstone(QUEUE_TOMBSTONE), true);
  assert.equal(isQueueTombstone(QUEUE_TOMBSTONE.replace('\n', '\r\n')), true);
  assert.equal(isQueueTombstone(initialQueueDoc()), false);
  assert.match(QUEUE_TOMBSTONE, /refs\/heads\/coord\/landing-queue/);
  assert.match(migrateNeededMessage('docs/handoff/landing-queue.md'), /landing-queue\.mjs migrate/);
});

// ── the fake git ────────────────────────────────────────────────────────────────────────────
// An in-memory origin: `remote.tip` is the ref's sha on origin (null = absent), `local.tip`
// the tracking ref, `docs` sha → doc text. Every command the module issues is modelled; anything
// else throws so a new git call cannot slip in untested. `origin.down` makes fetch + ls-remote
// fail (connectivity), `remote.rejectNext` counts non-ff rejections to inject.
function fakeGit({
  remoteTip = null,
  docs = {},
  masterDoc = null,
  down = false,
  masterShowFails = false,
  masterLsTreeFails = false,
  masterFetchFails = false,
  noOriginMaster = false,
} = {}) {
  const st = {
    remote: { tip: remoteTip, rejectNext: 0 },
    local: { tip: null },
    docs: { ...docs },
    master: masterDoc, // text of origin/master:<queueFile>, or null for absent
    masterShowFails, // ls-tree finds the path, `show` cannot read it (a fault, not an absence)
    masterLsTreeFails, // the path probe itself fails
    masterFetchFails, // the master-only fallback fetch fails while ls-remote still answers
    noOriginMaster, // …and origin/master does not even resolve (a fresh repo: an ABSENCE)
    down,
    calls: [],
    nextSha: 1,
  };
  const sha = () => `${String(st.nextSha++).padStart(40, 'a')}`;
  const nonFf = () =>
    Object.assign(new Error('push failed'), {
      stderr: ` ! [rejected]        abc -> coord/landing-queue (fetch first)\nerror: failed to push some refs\n`,
    });
  const gitImpl = (dir, args, opts = {}) => {
    st.calls.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'rev-parse' && args[1] === '--git-path') return 'index.lock';
    if (cmd === 'fetch') {
      if (st.down)
        throw Object.assign(new Error('fetch failed'), { stderr: 'fatal: unable to access' });
      if (args.includes(QUEUE_FETCH_REFSPEC)) {
        if (!st.remote.tip)
          throw Object.assign(new Error('fetch failed'), {
            stderr: `fatal: couldn't find remote ref ${QUEUE_REF}`,
          });
        st.local.tip = st.remote.tip;
        return '';
      }
      // the master-only fallback the accessor takes when the combined fetch failed
      if (st.masterFetchFails)
        throw Object.assign(new Error('fetch failed'), { stderr: 'fatal: unable to access' });
      return '';
    }
    if (cmd === 'ls-remote') {
      if (st.down)
        throw Object.assign(new Error('ls-remote failed'), { stderr: 'fatal: unable to access' });
      return st.remote.tip ? `${st.remote.tip}\t${QUEUE_REF}\n` : '';
    }
    if (cmd === 'for-each-ref') return st.local.tip ? `${st.local.tip}\n` : '';
    if (cmd === 'rev-parse' && args.includes('origin/master')) {
      if (st.noOriginMaster)
        throw Object.assign(new Error('rev-parse failed'), { stderr: 'fatal: bad revision' });
      return 'master-sha\n';
    }
    if (cmd === 'ls-tree') {
      if (st.masterLsTreeFails)
        throw Object.assign(new Error('ls-tree failed'), { stderr: 'fatal: not a tree object' });
      return st.master == null ? '' : `100644 blob deadbeef\t${args[3]}\n`;
    }
    if (cmd === 'show') {
      const [ref, path] = args[1].split(':');
      if (ref === 'origin/master') {
        if (st.master == null || st.masterShowFails)
          throw Object.assign(new Error('show failed'), { stderr: 'fatal: path' });
        return st.master;
      }
      if (path === QUEUE_DOC_NAME && st.docs[ref] != null) return st.docs[ref];
      throw Object.assign(new Error('show failed'), {
        stderr: `fatal: invalid object name ${ref}`,
      });
    }
    if (cmd === 'hash-object') return `blob-${sha()}`;
    if (cmd === 'mktree') return `tree-${sha()}`;
    if (cmd === 'commit-tree') {
      const s = sha();
      // the doc text rode hash-object's stdin; recover it from the caller's last write
      st.docs[s] = st.pendingDoc;
      st.commitMsg = args[args.indexOf('-m') + 1];
      st.parentOf = {
        ...(st.parentOf || {}),
        [s]: args.includes('-p') ? args[args.indexOf('-p') + 1] : null,
      };
      return s;
    }
    if (cmd === 'push') {
      const [commit, ref] = args[args.length - 1].split(':');
      assert.equal(ref, QUEUE_REF, 'every push targets the queue ref');
      assert.equal(args.includes('--force'), false, 'never a force push');
      if (st.remote.rejectNext > 0) {
        st.remote.rejectNext--;
        throw nonFf();
      }
      // origin's own CAS: the pushed commit's parent must be the current tip
      if ((st.parentOf?.[commit] ?? null) !== (st.remote.tip ?? null)) throw nonFf();
      st.remote.tip = commit;
      return '';
    }
    if (cmd === 'update-ref') {
      if (args[1] === '-d') {
        st.local.tip = null;
        return '';
      }
      // `update-ref <ref> <new> <old>` is a CAS: git refuses when the ref is not at <old>
      // (the all-zero oid meaning "must not exist"). Modelled, because the writer relies on
      // that refusal to avoid rewinding a sibling's newer tracking ref.
      const [, , value, expected] = args;
      if (expected !== undefined) {
        const want = expected === '0'.repeat(40) ? null : expected;
        if ((st.local.tip ?? null) !== want) {
          throw Object.assign(new Error('update-ref failed'), {
            stderr: `fatal: cannot lock ref: is at ${st.local.tip}, expected ${expected}`,
          });
        }
      }
      st.local.tip = value;
      return '';
    }
    throw new Error(`fakeGit: unmodelled git ${args.join(' ')}`);
  };
  // hash-object's stdin carries the doc; capture it where the fake can see it
  const wrapped = (dir, args, opts = {}) => {
    if (args[0] === 'hash-object') st.pendingDoc = opts.input;
    return gitImpl(dir, args, opts);
  };
  return { st, gitImpl: wrapped };
}

// A real (empty) git dir so coord-git's index.lock resolution has something to probe.
function scratchDir() {
  const d = mkdtempSync(join(tmpdir(), 'lq-ref-unit-'));
  execFileSync('git', ['init', '-q', d]);
  return d;
}

// Fresh stamps: the CLI's post-enqueue sweep (plan 3450) demotes a head whose heartbeat is
// 15+ min stale, which would reorder the end-to-end fixtures below.
function docWith(slugs) {
  const now = new Date().toISOString();
  let entries = [];
  for (const slug of slugs) {
    entries = enqueueEntry(entries, {
      slug,
      lane: '🟩',
      session: '?',
      host: 'h',
      enqueuedIso: now,
      heartbeatIso: now,
    });
  }
  return renderQueue(initialQueueDoc(), entries, []);
}
const slugsOf = (doc) => parseQueue(doc).entries.map((e) => e.slug);

// ── readQueueRef: absent vs fault (D3) ──────────────────────────────────────────────────────

test('readQueueRef: an ls-remote that lists nothing proves ABSENT; a fetch that fails while origin is down is a FAULT', () => {
  const dir = scratchDir();
  try {
    const absent = fakeGit();
    assert.deepEqual(readQueueRef(dir, { gitImpl: absent.gitImpl }), {
      state: 'absent',
      fetched: true,
      // the combined fetch failed on the missing ref, so master was fetched on its own
      masterFetched: true,
    });
    assert.ok(
      absent.st.calls.some((c) => c.startsWith('ls-remote origin')),
      'ABSENT is proven by ls-remote, never inferred from the failed fetch alone',
    );
    const down = fakeGit({ down: true });
    const r = readQueueRef(dir, { gitImpl: down.gitImpl });
    assert.equal(r.state, 'fault');
    assert.equal(r.fetchFailed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readQueueRef: present on origin → fetched into the tracking ref → the doc at its tip; fetch:false reads the local tip only', () => {
  const dir = scratchDir();
  try {
    const doc = docWith(['a']);
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: doc } });
    const noFetch = readQueueRef(dir, { fetch: false, gitImpl: f.gitImpl });
    assert.deepEqual(
      noFetch,
      { state: 'absent', local: true },
      'nothing tracked locally yet, and fetch:false must not fetch — but the absence is flagged ' +
        'as only LOCALLY proven',
    );
    assert.equal(
      f.st.calls.some((c) => c.startsWith('fetch')),
      false,
    );
    // fetchIfAbsent: exactly one fetch, and then the ref IS there — a missing tracking ref is
    // never read as a proven empty queue by a caller that asks for this.
    const healed = readQueueRef(dir, { fetch: false, fetchIfAbsent: true, gitImpl: f.gitImpl });
    assert.equal(healed.state, 'present');
    assert.equal(healed.sha, 'tip1');
    assert.equal(
      f.st.calls.filter((c) => c.startsWith('fetch')).length,
      1,
      'one fetch, only because the ref was locally absent',
    );
    f.st.calls.length = 0;
    readQueueRef(dir, { fetch: false, fetchIfAbsent: true, gitImpl: f.gitImpl });
    assert.equal(
      f.st.calls.some((c) => c.startsWith('fetch')),
      false,
      'and none once the tracking ref exists',
    );
    const r = readQueueRef(dir, { gitImpl: f.gitImpl });
    assert.equal(r.state, 'present');
    assert.equal(r.sha, 'tip1');
    assert.equal(r.doc, doc);
    assert.equal(f.st.local.tip, 'tip1');
    assert.equal(readQueueRef(dir, { fetch: false, gitImpl: f.gitImpl }).sha, 'tip1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readQueueRef: a stale local tracking ref is dropped once origin proves the ref absent', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit();
    f.st.local.tip = 'ghost';
    assert.deepEqual(readQueueRef(dir, { gitImpl: f.gitImpl }), {
      state: 'absent',
      fetched: true,
      masterFetched: true,
    });
    assert.equal(f.st.local.tip, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (keys c0bd5b / ad2818 / b03ae5 / 07876e / f19b59 / ebcc3e): the `fetchIfAbsent`
// fetch is not fire-and-forget. Its FAILURE goes through the same arbiter every other fetch
// failure does, so an unproven local absence can never be handed back as data.
test('readQueueRef: a fetchIfAbsent fetch that FAILS is a fault when origin is unreachable, and a proven absence when origin has no such ref', () => {
  const dir = scratchDir();
  try {
    // origin unreachable: the fetch fails AND ls-remote faults → fault, flagged as an absence
    // this read could not verify.
    const down = fakeGit({ down: true });
    const f = readQueueRef(dir, { fetch: false, fetchIfAbsent: true, gitImpl: down.gitImpl });
    assert.equal(f.state, 'fault');
    assert.equal(f.fetchFailed, true);
    assert.equal(f.unverifiedLocalAbsence, true);
    assert.notEqual(f.state, 'absent', 'a failed fetch must never read as an empty queue');

    // origin simply has no such ref (the pre-cut-over state): the fetch fails the same way, but
    // ls-remote PROVES the absence, so it stays data — and it is no longer only locally proven.
    const none = fakeGit();
    const a = readQueueRef(dir, { fetch: false, fetchIfAbsent: true, gitImpl: none.gitImpl });
    assert.equal(a.state, 'absent');
    assert.equal(a.local, undefined, 'proven on origin, not just locally');
    assert.ok(none.st.calls.some((c) => c.startsWith('ls-remote origin')));

    // …and the accessor turns each into its contract: a refusal, vs the D3 seed view.
    const q = readQueueDoc(dir, {
      fetch: false,
      fetchIfAbsent: true,
      gitImpl: fakeGit({ down: true }).gitImpl,
    });
    assert.equal(q.source, 'none');
    assert.equal(q.fetched, false);
    assert.ok(q.fault, 'the hot-path readers see a fault, never a synthesized empty queue');
    const seed = readQueueDoc(dir, {
      fetch: false,
      fetchIfAbsent: true,
      gitImpl: fakeGit({ masterDoc: docWith(['from-master']) }).gitImpl,
    });
    assert.equal(seed.source, 'master');
    assert.equal(seed.fault, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── readQueueDoc: the accessor's sources + the D4 loud fail ─────────────────────────────────

test('readQueueDoc: ref absent + master table → source master (the D3 seed view); ref absent + tombstone/absent master → empty', () => {
  const dir = scratchDir();
  try {
    const seed = docWith(['from-master']);
    const a = readQueueDoc(dir, { gitImpl: fakeGit({ masterDoc: seed }).gitImpl });
    assert.equal(a.source, 'master');
    assert.equal(a.sha, null);
    assert.deepEqual(slugsOf(a.doc), ['from-master']);
    assert.equal(a.fault, null);
    const b = readQueueDoc(dir, { gitImpl: fakeGit({ masterDoc: QUEUE_TOMBSTONE }).gitImpl });
    assert.equal(b.source, 'empty');
    assert.deepEqual(slugsOf(b.doc), []);
    const c = readQueueDoc(dir, { gitImpl: fakeGit().gitImpl });
    assert.equal(c.source, 'empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readQueueDoc: ref present + a master doc that is not byte-identical to it is the D4 loud fail naming `migrate`; an identical doc, a tombstone and loudFail:false do not fault', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 't', docs: { t: docWith(['x']) }, masterDoc: docWith(['old']) });
    const r = readQueueDoc(dir, { gitImpl: f.gitImpl });
    assert.equal(r.source, 'ref');
    assert.deepEqual(
      slugsOf(r.doc),
      ['x'],
      'the doc is still the ref’s — the fault is the refusal',
    );
    assert.match(r.fault.message, /landing-queue\.mjs migrate/);
    assert.match(
      r.fault.message,
      /entry old the ref lacks/,
      'the refusal names what the ref lacks',
    );
    const healer = readQueueDoc(dir, { gitImpl: f.gitImpl, loudFail: false });
    assert.equal(healer.fault, null);
    const tomb = fakeGit({
      remoteTip: 't',
      docs: { t: docWith(['x']) },
      masterDoc: QUEUE_TOMBSTONE,
    });
    assert.equal(readQueueDoc(dir, { gitImpl: tomb.gitImpl }).fault, null);
    // The seeded copy — byte-identical in both regions — is the ONE non-tombstone master doc
    // that does not fault (the seed-to-tombstone window stays usable).
    const same = docWith(['x', 'y']);
    const seeded = fakeGit({ remoteTip: 't', docs: { t: same }, masterDoc: same });
    assert.equal(readQueueDoc(dir, { gitImpl: seeded.gitImpl }).fault, null);
    // …and CRLF is not a difference.
    const crlf = fakeGit({
      remoteTip: 't',
      docs: { t: same },
      masterDoc: same.replace(/\n/g, '\r\n'),
    });
    assert.equal(readQueueDoc(dir, { gitImpl: crlf.gitImpl }).fault, null);
    const garbage = fakeGit({
      remoteTip: 't',
      docs: { t: docWith(['x']) },
      masterDoc: '# not a queue doc\n',
    });
    assert.match(
      readQueueDoc(dir, { gitImpl: garbage.gitImpl }).fault.message,
      /cannot parse|landing-queue\.mjs migrate/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The three old-code writes the SUBSET rule used to wave through (plan 3973 review, keys
// 0ad6b9 / 78d384 / 987e1d / bc0fc5 / acb542): a dequeue, a same-slug row update, a reorder.
// Each one leaves the ref wrong in a way `migrate` must reconcile, so each must fault.
test('readQueueDoc: a master-side dequeue, a same-slug row change and a reorder all fault (no subset carve-out)', () => {
  const dir = scratchDir();
  try {
    const refDoc = docWith(['head', 'tail']);
    const withFault = (masterDoc) =>
      readQueueDoc(dir, {
        gitImpl: fakeGit({ remoteTip: 't', docs: { t: refDoc }, masterDoc }).gitImpl,
      }).fault;

    // (1) old code DEQUEUED `head`: master is a strict subset of the ref.
    const dequeued = withFault(docWith(['tail']));
    assert.match(dequeued.message, /landing-queue\.mjs migrate/);
    assert.match(dequeued.message, /head the ref has and it lacks/);

    // (2) old code HEARTBEATED `head`: same slug set, same audit lines, a different row.
    const parsed = parseQueue(refDoc);
    const beat = renderQueue(
      refDoc,
      parsed.entries.map((e) =>
        e.slug === 'head' ? { ...e, heartbeatIso: '2099-01-01T00:00:00.000Z', pid: '4242' } : e,
      ),
      parsed.auditLines,
    );
    const changed = withFault(beat);
    assert.match(changed.message, /changed row/);
    assert.match(changed.message, /head/);

    // (3) old code REORDERED the table: same rows, different FIFO order.
    const flipped = renderQueue(refDoc, [...parsed.entries].reverse(), parsed.auditLines);
    assert.match(withFault(flipped).message, /different row order/);

    // (4) an audit line only master carries.
    const extraAudit = renderQueue(refDoc, parsed.entries, ['- 2099-01-01 — someone did a thing']);
    assert.match(withFault(extraAudit).message, /audit line/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// C4: an unreadable master doc is a FAULT, never an absence — with the ref absent too, reading
// it as "no queue" is what lets the next write bootstrap an empty ref over live waiters.
test('readMasterQueueDoc / readQueueDoc: an unreadable master doc faults instead of bootstrapping an empty queue', () => {
  const dir = scratchDir();
  try {
    const unreadable = () =>
      fakeGit({ masterDoc: docWith(['live-waiter']), masterShowFails: true }).gitImpl;
    const m = readMasterQueueDoc(dir, { gitImpl: unreadable() });
    assert.equal(
      m.state,
      'fault',
      'ls-tree found the path, so a failed show is unreadable content',
    );

    const q = readQueueDoc(dir, { gitImpl: unreadable() });
    assert.equal(q.source, 'none', 'never source empty — nothing readable was proven');
    assert.ok(q.fault, 'and the fault is the refusal a writer honours');
    assert.match(q.fault.message, /could not be read/);

    // The same fault while the REF is present: the D4 check could not be answered, so a reader
    // that carries it refuses rather than pass it vacuously.
    const withRef = fakeGit({
      remoteTip: 't',
      docs: { t: docWith(['x']) },
      masterDoc: docWith(['old']),
      masterShowFails: true,
    });
    const r = readQueueDoc(dir, { gitImpl: withRef.gitImpl });
    assert.equal(r.source, 'ref');
    assert.ok(r.fault);
    assert.equal(
      readQueueDoc(dir, { gitImpl: withRef.gitImpl, loudFail: false }).fault,
      null,
      'the healer, which is about to rewrite that doc, does not',
    );

    // A path probe that fails because there is no origin/master at all IS an absence (a fresh
    // repo before its first push) — that is the only ls-tree failure that is an answer.
    const fresh = fakeGit({ masterLsTreeFails: true, noOriginMaster: true });
    assert.equal(readMasterQueueDoc(dir, { gitImpl: fresh.gitImpl }).state, 'absent');
    const broken = fakeGit({ masterLsTreeFails: true });
    assert.equal(readMasterQueueDoc(dir, { gitImpl: broken.gitImpl }).state, 'fault');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (keys 597d2e / 738e52): the coord config tells this reader WHERE the pre-3973
// doc lives. A config it cannot read is an unknown path, not a repo without a queue file — and
// with the ref absent too, "absent" is what lets the next write bootstrap over live waiters.
test('readMasterQueueDoc: a malformed coord.config.json is a FAULT, not an absent master doc', () => {
  const dir = scratchDir();
  try {
    // No config at all → the DEFAULTS, so the read proceeds and finds no doc: a real absence.
    assert.equal(readMasterQueueDoc(dir, { gitImpl: fakeGit().gitImpl }).state, 'absent');

    writeFileSync(join(dir, 'coord.config.json'), '{ this is not json');
    const m = readMasterQueueDoc(dir, { gitImpl: fakeGit().gitImpl });
    assert.equal(m.state, 'fault');
    assert.equal(m.configFailed, true);

    const q = readQueueDoc(dir, { gitImpl: fakeGit().gitImpl });
    assert.equal(q.source, 'none');
    assert.match(q.fault.message, /coord\.config\.json could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (key fb32a3): with master tombstoned the D4 comparison never runs, so a
// malformed doc on the REF reaches every reader unexamined. It is a fault, never an empty queue.
test('readQueueDoc: a malformed document on the ref is a fault, never an empty queue', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({
      remoteTip: 't',
      docs: { t: '# not a queue doc\n' },
      masterDoc: QUEUE_TOMBSTONE,
    });
    const r = readQueueDoc(dir, { gitImpl: f.gitImpl });
    assert.equal(r.source, 'none');
    assert.ok(r.fault, 'the malformed doc is a refusal, not a parseable-looking empty queue');
    assert.match(r.fault.message, /could not be read as a queue table/);
    assert.deepEqual(slugsOf(r.doc), []);
    // The hot-path readers (no D4 check at all) see the same refusal.
    const hot = readQueueDoc(dir, { fetch: false, gitImpl: f.gitImpl });
    assert.ok(hot.fault);
    // …and a writer refuses rather than overwrite a queue it could not read.
    assert.throws(
      () =>
        mutateQueueRef(dir, {
          message: 'coord(queue): test',
          gitImpl: f.gitImpl,
          sleep: () => {},
          mutate: (doc) => doc,
        }),
      /could not be read as a queue table/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review round 2 (key 288fc9): the ref-absent branch's master-read fault must honour
// `loudFail: false` exactly as the ref-present branch does. `migrate` is the one caller that
// passes it — it read origin/master's doc itself and folds THAT copy — so a transient failure of
// the accessor's second, redundant master read must not abort the one bounded heal.
test('readQueueDoc: with the ref absent, an unreadable master doc faults only for a loudFail reader', () => {
  const dir = scratchDir();
  try {
    const unreadable = () =>
      fakeGit({ masterDoc: docWith(['live-waiter']), masterShowFails: true }).gitImpl;
    assert.ok(readQueueDoc(dir, { gitImpl: unreadable() }).fault, 'the ordinary reader refuses');
    const healer = readQueueDoc(dir, { gitImpl: unreadable(), loudFail: false });
    assert.equal(healer.fault, null, 'the heal proceeds on its own copy of the master doc');
    assert.equal(healer.source, 'empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readQueueDoc: a failed fetch degrades to the CACHED tracking ref with fetched:false; with no cache it is source none + fault', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 't', docs: { t: docWith(['cached']) } });
    readQueueDoc(dir, { gitImpl: f.gitImpl }); // warm the tracking ref
    f.st.down = true;
    const r = readQueueDoc(dir, { gitImpl: f.gitImpl });
    assert.equal(r.fetched, false);
    assert.equal(r.source, 'ref-cached');
    assert.deepEqual(slugsOf(r.doc), ['cached']);
    assert.equal(r.fault, null);
    const cold = fakeGit({ down: true });
    const c = readQueueDoc(dir, { gitImpl: cold.gitImpl });
    assert.equal(c.fetched, false);
    assert.equal(c.source, 'none');
    assert.ok(c.fault);
    assert.deepEqual(slugsOf(c.doc), [], 'a synthesized empty doc, flagged as such');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readQueueDoc: a no-fetch read of a PRESENT ref never touches the master doc (the hot-path readers pay no D4 probe)', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 't', docs: { t: docWith(['x']) }, masterDoc: docWith(['old']) });
    readQueueDoc(dir, { gitImpl: f.gitImpl }); // warm the tracking ref (and D4-faults, by design)
    f.st.calls.length = 0;
    const r = readQueueDoc(dir, { fetch: false, gitImpl: f.gitImpl });
    assert.equal(r.source, 'ref');
    assert.equal(r.fault, null, 'no D4 check on the no-fetch path');
    assert.equal(
      f.st.calls.some((c) => c.startsWith('ls-tree') || c.includes('origin/master')),
      false,
      'the master doc is not probed when the ref is present and no check is carried',
    );
    // …but an ABSENT ref still consults it for the D3 seed view, fetch or not.
    const g = fakeGit({ masterDoc: docWith(['seed']) });
    assert.equal(readQueueDoc(dir, { fetch: false, gitImpl: g.gitImpl }).source, 'master');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readMasterQueueDoc: tri-state over the pre-3973 transport', () => {
  const dir = scratchDir();
  try {
    assert.equal(readMasterQueueDoc(dir, { gitImpl: fakeGit().gitImpl }).state, 'absent');
    assert.equal(
      readMasterQueueDoc(dir, { gitImpl: fakeGit({ masterDoc: QUEUE_TOMBSTONE }).gitImpl }).state,
      'tombstone',
    );
    const p = readMasterQueueDoc(dir, { gitImpl: fakeGit({ masterDoc: docWith(['m']) }).gitImpl });
    assert.equal(p.state, 'present');
    assert.deepEqual(slugsOf(p.raw), ['m']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── writeQueueRefCAS / bootstrap / mutateQueueRef ──────────────────────────────────────────

test('writeQueueRefCAS: blob → tree → commit(parent = tip) → non-force push; a non-ff is reported, any other push error throws', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: docWith(['a']) } });
    const w = writeQueueRefCAS(dir, {
      parentSha: 'tip1',
      doc: docWith(['a', 'b']),
      message: 'm',
      gitImpl: f.gitImpl,
    });
    assert.equal(w.ok, true);
    assert.equal(f.st.remote.tip, w.sha);
    assert.equal(f.st.local.tip, w.sha, 'the local tracking ref is pinned to the accepted push');
    assert.equal(f.st.parentOf[w.sha], 'tip1');
    // a rival moved the tip: our parent is stale → non-ff, reported not thrown
    const lost = writeQueueRefCAS(dir, {
      parentSha: 'tip1',
      doc: docWith(['c']),
      message: 'm',
      gitImpl: f.gitImpl,
    });
    assert.deepEqual({ ok: lost.ok, nonFf: lost.nonFf }, { ok: false, nonFf: true });
    // a genuine failure (auth/network) throws
    const bad = (d, a, o) => {
      if (a[0] === 'push')
        throw Object.assign(new Error('boom'), { stderr: 'fatal: Authentication failed' });
      return f.gitImpl(d, a, o);
    };
    assert.throws(
      () =>
        writeQueueRefCAS(dir, {
          parentSha: f.st.remote.tip,
          doc: docWith(['z']),
          message: 'm',
          gitImpl: bad,
        }),
      /boom/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// key 58b143: the post-push pin of the LOCAL tracking ref is a CAS, so a sibling that advanced
// it between our push and our update is never rewound — a no-fetch reader must not lose a
// sibling's queue entry to our bookkeeping.
test('writeQueueRefCAS: the local tracking-ref pin is a CAS — a sibling that moved it first is not rewound', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: docWith(['a']) } });
    f.st.local.tip = 'tip1';
    // A sibling advances the tracking ref the moment our push lands.
    const racing = (d, a, o) => {
      if (a[0] === 'push') {
        const out = f.gitImpl(d, a, o);
        f.st.local.tip = 'sibling-newer';
        return out;
      }
      return f.gitImpl(d, a, o);
    };
    const w = writeQueueRefCAS(dir, {
      parentSha: 'tip1',
      doc: docWith(['a', 'b']),
      message: 'm',
      gitImpl: racing,
    });
    assert.equal(w.ok, true);
    assert.notEqual(f.st.local.tip, 'tip1', 'the local view was never rewound to our parent');
    assert.equal(
      f.st.local.tip,
      f.st.remote.tip,
      'the refused CAS re-fetched instead, leaving the local view at least as new as origin',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrapQueueRef: a parentless seed wins on an absent ref; a lost race hands back the winner’s view', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit();
    const b = bootstrapQueueRef(dir, docWith(['seed']), { gitImpl: f.gitImpl });
    assert.equal(b.ok, true);
    assert.equal(f.st.parentOf[b.sha], null, 'parentless');
    const again = bootstrapQueueRef(dir, docWith(['rival']), { gitImpl: f.gitImpl });
    assert.equal(again.ok, false);
    assert.equal(again.nonFf, true);
    assert.equal(again.winner.state, 'present');
    assert.deepEqual(slugsOf(again.winner.doc), ['seed']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: CAS win on the first attempt, commit message carries the attempt trailer, unchanged doc is a no-op', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: docWith(['a']) } });
    const seen = [];
    const r = mutateQueueRef(dir, {
      message: 'coord(queue): enqueue b',
      gitImpl: f.gitImpl,
      sleep: () => assert.fail('no sleep on a first-attempt win'),
      mutate: (doc, ctx) => {
        seen.push(ctx);
        return docWith([...slugsOf(doc), 'b']);
      },
    });
    assert.deepEqual(
      { attempts: r.attempts, unchanged: r.unchanged, bootstrapped: r.bootstrapped },
      { attempts: 1, unchanged: false, bootstrapped: false },
    );
    assert.equal(r.sha, f.st.remote.tip);
    assert.deepEqual(slugsOf(f.st.docs[r.sha]), ['a', 'b']);
    assert.deepEqual(seen, [{ queueSha: 'tip1', attempt: 1, source: 'ref' }]);
    assert.match(
      f.st.commitMsg,
      new RegExp(`^coord\\(queue\\): enqueue b\\n\\n${QUEUE_ATTEMPT_TRAILER}: 1\\n`),
    );
    const before = f.st.remote.tip;
    const noop = mutateQueueRef(dir, { message: 'noop', gitImpl: f.gitImpl, mutate: (doc) => doc });
    assert.equal(noop.unchanged, true);
    assert.equal(f.st.remote.tip, before, 'an unchanged doc pushes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: a non-ff re-reads and RE-RUNS the transform against the winner’s doc (enqueues commute), then wins', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: docWith(['a']) } });
    let attempts = 0;
    let slept = 0;
    const r = mutateQueueRef(dir, {
      message: 'coord(queue): enqueue mine',
      gitImpl: f.gitImpl,
      sleep: () => slept++,
      mutate: (doc) => {
        attempts++;
        if (attempts === 1) {
          // a rival lands its enqueue between our read and our push
          const rival = writeQueueRefCAS(dir, {
            parentSha: 'tip1',
            doc: docWith(['a', 'rival']),
            message: 'rival',
            gitImpl: f.gitImpl,
          });
          assert.equal(rival.ok, true);
        }
        return docWith([...slugsOf(doc), 'mine']);
      },
    });
    assert.equal(r.attempts, 2);
    assert.equal(slept, 1, 'one jittered sleep between the two attempts');
    assert.deepEqual(
      slugsOf(f.st.docs[r.sha]),
      ['a', 'rival', 'mine'],
      'FIFO push order = queue order',
    );
    assert.match(f.st.commitMsg, new RegExp(`${QUEUE_ATTEMPT_TRAILER}: 2\\n`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: exhausts its bounded attempts on permanent contention and throws a clear error', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 'tip1', docs: { tip1: docWith(['a']) } });
    f.st.remote.rejectNext = 99;
    let runs = 0;
    let sleeps = 0;
    assert.throws(
      () =>
        mutateQueueRef(dir, {
          message: 'm',
          attempts: 3,
          gitImpl: f.gitImpl,
          sleep: () => sleeps++,
          mutate: (doc) => {
            runs++;
            return docWith([...slugsOf(doc), 'x']);
          },
        }),
      /contended after 3 attempts/,
    );
    assert.equal(runs, 3);
    assert.equal(sleeps, 2, 'no sleep after the last attempt');
    assert.equal(f.st.remote.tip, 'tip1', 'nothing landed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: while the master TABLE is still live, an ordinary write refuses and names `migrate` — only the heal may seed the ref from it', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ masterDoc: docWith(['from-master']) });
    assert.throws(
      () => mutateQueueRef(dir, { message: 'm', gitImpl: f.gitImpl, mutate: (d) => d }),
      /landing-queue\.mjs migrate/,
      'seeding from a doc that stays live would split the queue in two one write later',
    );
    assert.equal(f.st.remote.tip, null, 'and nothing was written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: the heal bootstraps an ABSENT ref from the master doc (D3), and a lost bootstrap race re-runs on the winner', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ masterDoc: docWith(['from-master']) });
    let attempts = 0;
    const r = mutateQueueRef(dir, {
      message: 'coord(queue): enqueue mine',
      gitImpl: f.gitImpl,
      sleep: () => {},
      loudFail: false, // the heal (`migrate`) — the only caller allowed to seed from master
      mutate: (doc, ctx) => {
        attempts++;
        if (attempts === 1) {
          assert.equal(ctx.source, 'master');
          assert.equal(ctx.queueSha, null);
          // a sibling bootstraps first — from the same master seed, plus its own entry
          assert.equal(
            bootstrapQueueRef(dir, docWith(['from-master', 'sibling']), { gitImpl: f.gitImpl }).ok,
            true,
          );
        } else {
          assert.equal(ctx.source, 'ref');
        }
        return docWith([...slugsOf(doc), 'mine']);
      },
    });
    assert.equal(r.attempts, 2);
    assert.equal(
      r.bootstrapped,
      false,
      'the sibling won the bootstrap; ours is a child of its seed',
    );
    assert.deepEqual(slugsOf(f.st.docs[r.sha]), ['from-master', 'sibling', 'mine']);
    // and with nobody racing, the first write IS the bootstrap, from the master seed
    const g = fakeGit({ masterDoc: docWith(['from-master']) });
    const b = mutateQueueRef(dir, {
      message: 'm',
      gitImpl: g.gitImpl,
      loudFail: false,
      mutate: (doc) => doc,
    });
    assert.equal(b.bootstrapped, true);
    assert.deepEqual(
      slugsOf(g.st.docs[b.sha]),
      ['from-master'],
      'an unchanged doc still materializes an absent ref',
    );
    assert.equal(g.st.parentOf[b.sha], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mutateQueueRef: refuses to write over a faulted or unfetched read (never writes a queue it could not read)', () => {
  const dir = scratchDir();
  try {
    const down = fakeGit({ down: true });
    assert.throws(
      () => mutateQueueRef(dir, { message: 'm', gitImpl: down.gitImpl, mutate: (d) => d }),
      /could not be fetched|cannot write the queue/,
    );
    const stale = fakeGit({
      remoteTip: 't',
      docs: { t: docWith(['x']) },
      masterDoc: docWith(['old']),
    });
    assert.throws(
      () => mutateQueueRef(dir, { message: 'm', gitImpl: stale.gitImpl, mutate: (d) => d }),
      /landing-queue\.mjs migrate/,
    );
    assert.equal(stale.st.remote.tip, 't');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── review round 3: ONE validation point, and a fetch that refreshes BOTH sides ───────────

// Keys da94f5 / 61f4ff: the D4 comparison's other side is origin/master, so refreshing only the
// queue refspec left it at whatever this checkout last saw — an old-code master write that landed
// since could pass the guard unseen. One fetch, both refs.
test('readQueueDoc: a fetching read names master AND the queue refspec in the SAME fetch', () => {
  const dir = scratchDir();
  try {
    const f = fakeGit({ remoteTip: 't', docs: { t: docWith(['x']) }, masterDoc: QUEUE_TOMBSTONE });
    readQueueDoc(dir, { gitImpl: f.gitImpl });
    const fetches = f.st.calls.filter((c) => c.startsWith('fetch '));
    assert.equal(fetches.length, 1, 'one round trip, not two');
    assert.ok(fetches[0].includes(' master '), fetches[0]);
    assert.ok(fetches[0].includes(QUEUE_FETCH_REFSPEC), fetches[0]);

    // With the ref ABSENT the combined fetch fails as a whole (git cannot find the remote ref),
    // master included — so the master doc, which is the live queue until `migrate` runs, is
    // fetched on its own rather than read at an unknown age.
    const pre = fakeGit({ masterDoc: docWith(['pre-cutover']) });
    const r = readQueueDoc(dir, { gitImpl: pre.gitImpl });
    assert.equal(r.source, 'master');
    assert.equal(r.fetched, true, 'the master fallback IS fresh: its own fetch succeeded');
    assert.deepEqual(
      pre.st.calls.filter((c) => c.startsWith('fetch ')),
      [`fetch --quiet origin master ${QUEUE_FETCH_REFSPEC}`, 'fetch --quiet origin master'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Keys 166f06 / 4d7903: `fetched` describes the DOC that came back. The ref's absence being
// proven says nothing about the age of this checkout's origin/master, and a master fallback
// presented as freshened is what let a close-out skip a live slug's dequeue.
test('readQueueDoc: the master fallback reports the MASTER fetch as its freshness, never the ref probe', () => {
  const dir = scratchDir();
  try {
    const stale = fakeGit({ masterDoc: docWith(['waiter']), masterFetchFails: true });
    const r = readQueueDoc(dir, { gitImpl: stale.gitImpl });
    assert.equal(r.source, 'master');
    assert.equal(r.fetched, false, 'origin/master could not be refreshed — the doc may be stale');
    // …and a WRITE refuses on it rather than seed the ref from a master table it never refreshed.
    assert.throws(
      () =>
        mutateQueueRef(dir, {
          message: 'coord(queue): test',
          loudFail: false, // the heal's own flag: only `migrate` may seed from the master doc
          gitImpl: stale.gitImpl,
          sleep: () => {},
          mutate: (doc) => doc,
        }),
      /could not be fetched from origin/,
    );
    // A no-fetch reader never freshened anything either.
    const noFetch = fakeGit({ masterDoc: docWith(['waiter']) });
    const n = readQueueDoc(dir, { fetch: false, gitImpl: noFetch.gitImpl, loudFail: false });
    assert.equal(n.source, 'master');
    assert.equal(n.fetched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Keys d38ef3 / db4f11 / 7b7642 / c9d223 / 79758c / d836ca / 4d7903: every document the accessor
// can hand back goes through the SAME check — the fetched ref, the cached tracking ref after a
// failed fetch, and the pre-cut-over master table — and a document whose sentinels survived
// while the table header did not is a fault, not an empty queue.
test('readQueueDoc: the cached ref, the master fallback and a headerless doc all meet the one validation point', () => {
  const dir = scratchDir();
  const headerless = [QUEUE_START, QUEUE_END, '', AUDIT_START, AUDIT_END, ''].join('\n');
  try {
    // (a) a malformed doc CACHED on the tracking ref, read while origin is unreachable
    const cached = fakeGit({
      remoteTip: 't',
      docs: { t: '# not a queue doc' },
      masterDoc: QUEUE_TOMBSTONE,
    });
    readQueueDoc(dir, { gitImpl: cached.gitImpl }); // warm the tracking ref
    cached.st.down = true;
    const c = readQueueDoc(dir, { gitImpl: cached.gitImpl });
    assert.equal(c.source, 'none', 'never `ref-cached` with fault:null over unreadable text');
    assert.match(c.fault.message, /could not be read as a queue table/);
    assert.deepEqual(slugsOf(c.doc), [], 'a synthesized doc that PARSES, flagged as unreadable');

    // (b) the pre-cut-over master table, malformed
    const master = fakeGit({ masterDoc: '# not a queue doc' });
    const m = readQueueDoc(dir, { gitImpl: master.gitImpl });
    assert.equal(m.source, 'none');
    assert.match(m.fault.message, /pre-3973 queue doc/);

    // (c) sentinels intact, header and every row gone — `parseQueue` returns `entries: []` and
    // does not throw, which is byte-for-byte the answer an empty queue gives.
    for (const [where, f] of [
      ['ref', fakeGit({ remoteTip: 't', docs: { t: headerless }, masterDoc: QUEUE_TOMBSTONE })],
      ['master', fakeGit({ masterDoc: headerless })],
    ]) {
      const r = readQueueDoc(dir, { gitImpl: f.gitImpl });
      assert.equal(r.source, 'none', `${where}: a headerless doc is a fault, not an empty queue`);
      assert.match(r.fault.message, /no table header row/);
    }

    // …while a genuinely empty queue (header present, no rows) is data, not a fault.
    const ok = fakeGit({
      remoteTip: 't',
      docs: { t: initialQueueDoc() },
      masterDoc: QUEUE_TOMBSTONE,
    });
    const good = readQueueDoc(dir, { gitImpl: ok.gitImpl });
    assert.equal(good.fault, null);
    assert.equal(good.source, 'ref');
    // The validation's own parse rides back with it, so no caller parses the same text twice.
    assert.deepEqual(good.parsed.entries, []);
    const one = fakeGit({
      remoteTip: 't',
      docs: { t: docWith(['only']) },
      masterDoc: QUEUE_TOMBSTONE,
    });
    assert.deepEqual(
      readQueueDoc(dir, { gitImpl: one.gitImpl }).parsed.entries.map((e) => e.slug),
      ['only'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round 4 (keys c6fdd6 / 91cf4a / 1b2fc7 / 5af1eb / 4915ec / 574172 / 4c907e): the corrupt shape
// round 3's validation still accepted — the header gone while a LIVE waiter row remains. The
// waiter is consumed in the header's place, so the document reads as a valid SHORTER queue on
// every transport, and beside an empty ref the master side of the D4 check compares equal to it.
test('readQueueDoc: a headerless doc that still carries a waiter is a fault on every transport', () => {
  const dir = scratchDir();
  const live = docWith(['still-waiting']);
  const headerless = live
    .split('\n')
    .filter((l) => !l.startsWith('| slug |'))
    .join('\n');
  try {
    // the shape itself: the waiter is gone from the parse without the parser throwing
    assert.deepEqual(parseQueue(headerless).entries, []);
    for (const [where, f] of [
      ['ref', fakeGit({ remoteTip: 't', docs: { t: headerless }, masterDoc: QUEUE_TOMBSTONE })],
      ['master', fakeGit({ masterDoc: headerless })],
    ]) {
      const r = readQueueDoc(dir, { gitImpl: f.gitImpl });
      assert.equal(r.source, 'none', `${where}: a headerless doc is a fault, not a short queue`);
      assert.match(r.fault.message, /no table header row/);
    }
    // …and as the MASTER side of the D4 comparison beside a live (empty) ref, where the old path
    // compared two `entries: []` parses and passed the check in silence.
    const d4 = fakeGit({ remoteTip: 't', docs: { t: initialQueueDoc() }, masterDoc: headerless });
    assert.match(
      readQueueDoc(dir, { gitImpl: d4.gitImpl }).fault.message,
      /landing-queue\.mjs migrate/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round 4 (keys bfd914 / 90e33f / 96d4e9): ORDER means the sequence of what both sides carry.
// The old full-row / full-audit-text comparison called a heartbeat stamp and an appended audit
// line "a different order", and `migrate` then advised `overtake`/`demote` over them.
test('masterDocDivergence: a metadata change is a changed ROW and an appended audit line a missing LINE — neither is a reorder', () => {
  const base = docWith(['head-slug', 'tail-slug']);
  const parsed = parseQueue(base);
  const reparse = (entries, audit) => parseQueue(renderQueue(base, entries, audit));

  const beat = reparse(
    parsed.entries.map((e) =>
      e.slug === 'head-slug' ? { ...e, heartbeatIso: '2099-01-01T00:00:00.000Z' } : e,
    ),
    parsed.auditLines,
  );
  const changed = masterDocDivergence(beat, parsed);
  assert.equal(changed.diverged, true, 'still a divergence — just not an ordering one');
  assert.deepEqual(changed.changed, ['head-slug']);
  assert.equal(changed.orderDiffers, false, 'the FIFO did not move');

  const appended = masterDocDivergence(reparse(parsed.entries, ['- 2099-01-01 — a thing']), parsed);
  assert.equal(appended.diverged, true);
  assert.equal(appended.masterOnlyAudit, 1);
  assert.equal(appended.auditOrderDiffers, false, 'an appended line is not a reshuffled region');

  // A genuine reorder of either region still reports as one, and identical docs as nothing.
  assert.equal(
    masterDocDivergence(reparse([...parsed.entries].reverse(), parsed.auditLines), parsed)
      .orderDiffers,
    true,
  );
  const two = reparse(parsed.entries, ['- 2099-01-01 — a', '- 2099-01-02 — b']);
  const flippedAudit = reparse(parsed.entries, ['- 2099-01-02 — b', '- 2099-01-01 — a']);
  const ad = masterDocDivergence(flippedAudit, two);
  assert.equal(ad.auditOrderDiffers, true);
  assert.equal(ad.diverged, true);
  assert.equal(masterDocDivergence(parsed, parsed).diverged, false);
  // a master document that did not validate cannot be proven equal to anything
  assert.deepEqual(masterDocDivergence(null, parsed).diverged, true);
});

// Round 4 (keys b96256 / 7ed479 / 714a0e): "there is no queue anywhere" rests on the MASTER read
// — the tombstone (or the missing path) comes off this checkout's origin/master. With that fetch
// failed the answer may predate every waiter the live master doc carries, so it is not fresh and
// a write must refuse rather than bootstrap an empty ref over them.
test('readQueueDoc: the EMPTY answer reports the MASTER fetch as its freshness, never the ref probe', () => {
  const dir = scratchDir();
  try {
    for (const masterDoc of [QUEUE_TOMBSTONE, null]) {
      const stale = fakeGit({ masterDoc, masterFetchFails: true });
      const r = readQueueDoc(dir, { gitImpl: stale.gitImpl });
      assert.equal(r.source, 'empty');
      assert.equal(r.fetched, false, `${masterDoc ? 'tombstone' : 'absent'}: read off a stale ref`);
      assert.throws(
        () =>
          mutateQueueRef(dir, {
            message: 'coord(queue): test',
            loudFail: false,
            gitImpl: stale.gitImpl,
            sleep: () => {},
            mutate: (doc) => doc,
          }),
        /could not be fetched from origin/,
      );
    }
    // …and when origin/master WAS refreshed, the same answer is ordinary data.
    const ok = readQueueDoc(dir, { gitImpl: fakeGit({ masterDoc: QUEUE_TOMBSTONE }).gitImpl });
    assert.equal(ok.source, 'empty');
    assert.equal(ok.fetched, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── end to end: a bare origin, two clones, the real CLI ─────────────────────────────────────

function makeOriginAndClones() {
  const root = mkdtempSync(join(tmpdir(), 'lq-ref-e2e-'));
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
  writeFileSync(join(A, '.gitignore'), '.claude/\n');
  execFileSync('git', ['-C', A, 'add', '-A']);
  execFileSync('git', ['-C', A, 'commit', '-qm', 'init']);
  execFileSync('git', ['-C', A, 'push', '-q', 'origin', 'master']);
  const B = clone('B');
  return { root, origin, A, B, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const lq = (cwd, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`lq ${args.join(' ')} exit ${r.status}: ${r.stderr}`);
  return r.stdout;
};
const originSha = (origin, ref) =>
  execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', '--quiet', ref], {
    encoding: 'utf8',
  }).trim();
const originHas = (origin, ref) => {
  try {
    return Boolean(originSha(origin, ref));
  } catch {
    return false;
  }
};

test('END TO END: enqueue/dequeue/status over a bare origin land ZERO commits on master and advance the queue ref (plan 3973 acceptance)', () => {
  const s = makeOriginAndClones();
  try {
    const masterBefore = originSha(s.origin, 'refs/heads/master');
    assert.equal(originHas(s.origin, QUEUE_REF), false, 'no queue ref before the first verb');

    lq(s.A, ['enqueue', 'slug-a', '--lane', 'free']);
    assert.equal(originHas(s.origin, QUEUE_REF), true, 'the first write bootstraps the ref');
    const afterA = originSha(s.origin, QUEUE_REF);

    lq(s.B, ['enqueue', 'slug-b', '--lane', 'seed']);
    const afterB = originSha(s.origin, QUEUE_REF);
    assert.notEqual(afterB, afterA, 'the ref advances on the second clone’s enqueue');

    const st = JSON.parse(lq(s.A, ['status', '--json']));
    assert.deepEqual(
      st.entries.map((e) => e.slug),
      ['slug-a', 'slug-b'],
      'FIFO across two clones, read back through the ref',
    );

    lq(s.A, ['dequeue', 'slug-a']);
    const st2 = JSON.parse(lq(s.B, ['status', '--json']));
    assert.deepEqual(
      st2.entries.map((e) => e.slug),
      ['slug-b'],
    );

    assert.equal(
      originSha(s.origin, 'refs/heads/master'),
      masterBefore,
      'three queue verbs, zero commits on master — the whole point of plan 3973',
    );
    const log = execFileSync('git', ['--git-dir', s.origin, 'log', '--format=%s%n%b', QUEUE_REF], {
      encoding: 'utf8',
    });
    assert.match(log, /coord\(queue\): dequeue slug-a/);
    assert.match(log, /coord\(queue\): enqueue slug-b/);
    assert.match(log, /coord\(queue\): enqueue slug-a/);
    assert.equal(
      (log.match(new RegExp(`${QUEUE_ATTEMPT_TRAILER}: 1`, 'g')) || []).length,
      3,
      'uncontended: attempt=1 on every commit',
    );
    const tree = execFileSync('git', ['--git-dir', s.origin, 'ls-tree', '--name-only', QUEUE_REF], {
      encoding: 'utf8',
    }).trim();
    assert.equal(tree, QUEUE_DOC_NAME, 'the ref’s tree holds exactly the queue doc');
  } finally {
    s.cleanup();
  }
});

test('END TO END: migrate folds a pre-cut-over master doc into the ref and tombstones master; a second run is a no-op', () => {
  const s = makeOriginAndClones();
  try {
    // A pre-3973 world: the queue table committed on master (legacy config-less path).
    writeFileSync(join(s.A, 'landing-queue.md'), docWith(['legacy-1', 'legacy-2']));
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): enqueue legacy (pre-3973)']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // A new-code reader BEFORE the heal: ref absent → the master table is the seed view (D3).
    const st0 = JSON.parse(lq(s.B, ['status', '--json']));
    assert.deepEqual(
      st0.entries.map((e) => e.slug),
      ['legacy-1', 'legacy-2'],
    );

    // The pre-land seeding form: fold/bootstrap only, master untouched.
    const seeded = JSON.parse(lq(s.B, ['migrate', '--no-tombstone', '--json']));
    assert.equal(seeded.bootstrapped, true);
    assert.equal(seeded.tombstoned, false);
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    assert.equal(
      isQueueTombstone(
        execFileSync('git', ['-C', s.A, 'show', 'origin/master:landing-queue.md'], {
          encoding: 'utf8',
        }),
      ),
      false,
      '--no-tombstone leaves the master doc alone',
    );

    // The ref now exists beside the master doc it was seeded from — BYTE-IDENTICAL, so readers
    // do NOT fault (the seed-to-tombstone window must stay usable): the demote below is refused
    // on the ordinary staleness gate, not on the D4 rule.
    const fresh = spawnSync(process.execPath, [CLI, 'demote', 'legacy-2', '--stale-min', '999'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.notEqual(fresh.status, 0);
    assert.doesNotMatch(
      fresh.stderr,
      /landing-queue\.mjs migrate/,
      'a subset master doc is not the D4 case',
    );
    assert.match(fresh.stderr, /heartbeat is fresh/);

    // Then an old-code session writes the master doc again — adding one entry AND dequeuing
    // one. Both directions matter: the added row must be folded, and the row only the ref
    // still has must survive the tombstone (reported, never dropped).
    execFileSync('git', ['-C', s.A, 'pull', '-q', '--rebase', 'origin', 'master']);
    writeFileSync(join(s.A, 'landing-queue.md'), docWith(['legacy-2', 'late-old-code']));
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', [
      '-C',
      s.A,
      'commit',
      '-qm',
      'coord(queue): enqueue late-old-code (old code)',
    ]);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // …and NOW every ordinary reader loud-fails naming the heal (D4): the master doc carries an
    // entry the ref lacks. A displacement verb refuses, and so does a plain write.
    const stale = spawnSync(process.execPath, [CLI, 'demote', 'legacy-2', '--stale-min', '0.01'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /landing-queue\.mjs migrate/, 'the refusal names the heal');
    assert.match(stale.stderr, /late-old-code/, 'and what the ref lacks');
    const blockedWrite = spawnSync(
      process.execPath,
      [CLI, 'enqueue', 'blocked', '--lane', 'free'],
      { cwd: s.B, encoding: 'utf8' },
    );
    assert.notEqual(blockedWrite.status, 0, 'no silent merge: a write refuses too');
    assert.match(blockedWrite.stderr, /landing-queue\.mjs migrate/);

    // The full heal: fold the missing entry onto the tail, tombstone master — ONE coordWrite.
    const healRun = spawnSync(process.execPath, [CLI, 'migrate', '--json'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.equal(healRun.status, 0, healRun.stderr);
    const healed = JSON.parse(healRun.stdout);
    assert.equal(healed.migrated, true);
    assert.equal(healed.folded, 1);
    assert.equal(healed.tombstoned, true);
    assert.match(
      healRun.stderr,
      /WARNING.*legacy-1/s,
      'the entry only the ref still carries is reported, not silently dropped',
    );
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    const masterDoc = execFileSync('git', ['-C', s.A, 'show', 'origin/master:landing-queue.md'], {
      encoding: 'utf8',
    });
    assert.equal(isQueueTombstone(masterDoc), true, 'the master doc is the tombstone now');
    const st1 = JSON.parse(lq(s.B, ['status', '--json']));
    assert.deepEqual(
      st1.entries.map((e) => e.slug),
      ['legacy-1', 'legacy-2', 'late-old-code'],
    );

    // Idempotent: nothing left to migrate.
    const again = JSON.parse(lq(s.A, ['migrate', '--json']));
    assert.deepEqual(
      { migrated: again.migrated, reason: again.reason },
      { migrated: false, reason: 'tombstone' },
    );

    // And the ordinary verbs work again — with no master commit.
    const masterAfterHeal = originSha(s.origin, 'refs/heads/master');
    lq(s.B, ['enqueue', 'new-code', '--lane', 'free']);
    assert.equal(originSha(s.origin, 'refs/heads/master'), masterAfterHeal);
    assert.deepEqual(
      JSON.parse(lq(s.A, ['status', '--json'])).entries.map((e) => e.slug),
      ['legacy-1', 'legacy-2', 'late-old-code', 'new-code'],
    );
  } finally {
    s.cleanup();
  }
});

// Review round 2 (keys 4f5837 / a9af40 / 0fc891): a master doc the heal could not READ is a
// refusal, never "nothing to migrate, exit 0" — that report tells the operator the cut-over is
// done while the ref is unseeded and every ordinary queue write still refuses.
test('END TO END: migrate REFUSES (exit 2) when the master queue doc cannot be read', () => {
  const s = makeOriginAndClones();
  try {
    writeFileSync(join(s.A, 'landing-queue.md'), docWith(['legacy-1']));
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): enqueue legacy (pre-3973)']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // The config says WHERE that doc lives; unreadable config = unknown path, which is a fault
    // (key 597d2e), not a repo without a queue file.
    writeFileSync(join(s.B, 'coord.config.json'), '{ not json');
    const r = spawnSync(process.execPath, [CLI, 'migrate', '--json'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot read the pre-3973 queue doc/);
    assert.equal(r.stdout.trim(), '', 'no success report on a refusal');
    assert.equal(originHas(s.origin, QUEUE_REF), false, 'and nothing was seeded');

    // With the config healed the same command migrates for real.
    rmSync(join(s.B, 'coord.config.json'));
    const ok = JSON.parse(lq(s.B, ['migrate', '--json']));
    assert.equal(ok.migrated, true);
    assert.equal(ok.tombstoned, true);
  } finally {
    s.cleanup();
  }
});

// Review round 2 (keys 906a8e / 65fa01): the same rows in a different ORDER are a real
// divergence — an old-code overtake/demote. The ref is the live FIFO and keeps its order, but
// the discarded one must be SAID, because the tombstone erases it.
test('END TO END: migrate keeps the ref’s FIFO order over a reordered master doc and warns with both orders', () => {
  const s = makeOriginAndClones();
  try {
    const base = docWith(['head-slug', 'tail-slug']);
    const parsed = parseQueue(base);
    // The SAME rows, byte for byte, in the other order — an old-code reorder, not a row change.
    const flipped = renderQueue(base, [...parsed.entries].reverse(), parsed.auditLines);

    writeFileSync(join(s.A, 'landing-queue.md'), base);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): pre-3973 table']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    lq(s.B, ['migrate', '--no-tombstone', '--json']); // seed the ref from it

    writeFileSync(join(s.A, 'landing-queue.md'), flipped);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): old-code overtake']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // A reader whose origin/master is fresh refuses on exactly this (the D4 "a different row
    // order" wording) — `status` fetches master, an ordinary write does not.
    execFileSync('git', ['-C', s.B, 'fetch', '-q', 'origin', 'master']);
    const blocked = spawnSync(process.execPath, [CLI, 'enqueue', 'blocked', '--lane', 'free'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.notEqual(blocked.status, 0, 'no silent merge: a reorder is a divergence too');
    assert.match(blocked.stderr, /different row order/);

    // … and the heal resolves it: nothing folded, the ref's order kept, master tombstoned, and
    // the discarded order printed slug-by-slug beside the way to re-apply it.
    const run = spawnSync(process.execPath, [CLI, 'migrate', '--json'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const healed = JSON.parse(run.stdout);
    assert.equal(healed.folded, 0);
    assert.equal(healed.auditFolded, 0);
    assert.equal(healed.tombstoned, true);
    assert.match(run.stderr, /differ in row order/);
    assert.match(run.stderr, /ref \(kept\): head-slug, tail-slug/);
    assert.match(run.stderr, /master:\s+tail-slug, head-slug/);
    assert.match(run.stderr, /overtake <slug>/);
    assert.match(run.stderr, /demote <slug>/);

    assert.deepEqual(
      JSON.parse(lq(s.B, ['status', '--json'])).entries.map((e) => e.slug),
      ['head-slug', 'tail-slug'],
      'the ref is the live FIFO — the heal never reorders it',
    );
    execFileSync('git', ['-C', s.A, 'fetch', '-q', 'origin']);
    assert.equal(
      isQueueTombstone(
        execFileSync('git', ['-C', s.A, 'show', 'origin/master:landing-queue.md'], {
          encoding: 'utf8',
        }),
      ),
      true,
      'still tombstoned — a reorder is reported, not a reason to leave two live transports',
    );
  } finally {
    s.cleanup();
  }
});

// Review round 3 (keys 9e10de / 35e276 / d80584 / 44d85f / 2ea1c8): the reorder report is NOT
// gated on the rest of the fold being empty. A master doc that reordered the FIFO *and* carried
// one extra row used to discard its order in silence, and an AUDIT-line reorder — which is what
// the shared comparator faulted on, sending the operator here — was never mentioned at all.
test('END TO END: migrate reports a discarded ROW order even when it also folds a master-only row', () => {
  const s = makeOriginAndClones();
  try {
    const base = docWith(['head-slug', 'tail-slug']);
    const parsed = parseQueue(base);
    writeFileSync(join(s.A, 'landing-queue.md'), base);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): pre-3973 table']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    lq(s.B, ['migrate', '--no-tombstone', '--json']); // seed the ref from it

    // An old-code session BOTH reordered the table and enqueued a row the ref never saw.
    const extra = parseQueue(docWith(['late-slug'])).entries[0];
    const both = renderQueue(base, [...parsed.entries].reverse().concat(extra), parsed.auditLines);
    writeFileSync(join(s.A, 'landing-queue.md'), both);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): old-code overtake + enqueue']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    const run = spawnSync(process.execPath, [CLI, 'migrate', '--json'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const healed = JSON.parse(run.stdout);
    assert.equal(healed.folded, 1, 'the master-only row is folded');
    assert.equal(healed.tombstoned, true);
    assert.match(run.stderr, /differ in row order/, 'the discarded order is SAID, fold or no fold');
    assert.match(run.stderr, /ref \(kept\): head-slug, tail-slug/);
    assert.match(run.stderr, /master:\s+tail-slug, head-slug, late-slug/);
    assert.deepEqual(
      JSON.parse(lq(s.B, ['status', '--json'])).entries.map((e) => e.slug),
      ['head-slug', 'tail-slug', 'late-slug'],
      'the ref keeps its own FIFO and appends what it lacked',
    );
  } finally {
    s.cleanup();
  }
});

test('END TO END: migrate reports a discarded AUDIT-LINE order, the one divergence with nothing to fold', () => {
  const s = makeOriginAndClones();
  try {
    const audit = ['- 2026-09-12 — steal: a → head', '- 2026-09-13 — auto-demote: b → tail'];
    const base = renderQueue(docWith(['only-slug']), parseQueue(docWith(['only-slug'])).entries, [
      ...audit,
    ]);
    writeFileSync(join(s.A, 'landing-queue.md'), base);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): pre-3973 table']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);
    lq(s.B, ['migrate', '--no-tombstone', '--json']); // seed the ref from it

    // Same rows, same audit LINES — only their order differs. Set-based folding finds nothing
    // missing, so this run writes no commit at all; the warning is the whole output.
    const flippedAudit = renderQueue(base, parseQueue(base).entries, [...audit].reverse());
    writeFileSync(join(s.A, 'landing-queue.md'), flippedAudit);
    execFileSync('git', ['-C', s.A, 'add', 'landing-queue.md']);
    execFileSync('git', ['-C', s.A, 'commit', '-qm', 'coord(queue): old-code audit rewrite']);
    execFileSync('git', ['-C', s.A, 'push', '-q', 'origin', 'master']);

    // It is a real divergence for every reader: the D4 refusal names it in its own words.
    execFileSync('git', ['-C', s.B, 'fetch', '-q', 'origin', 'master']);
    const blocked = spawnSync(process.execPath, [CLI, 'enqueue', 'blocked', '--lane', 'free'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /different audit-line order/);

    const run = spawnSync(process.execPath, [CLI, 'migrate', '--json'], {
      cwd: s.B,
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const healed = JSON.parse(run.stdout);
    assert.equal(healed.folded, 0);
    assert.equal(healed.auditFolded, 0);
    assert.equal(healed.tombstoned, true);
    assert.match(run.stderr, /differ in audit-line order/);
    assert.doesNotMatch(run.stderr, /ref \(kept\):/, 'no row list: the rows did not move');
    // Round 4 (keys 00891a / cad6ef): the remediation matches the divergence. `overtake`/`demote`
    // move queue ROWS, so advising them over a reshuffled audit region would change the live FIFO
    // for history that carries no FIFO meaning.
    assert.doesNotMatch(run.stderr, /overtake <slug>/);
    assert.doesNotMatch(run.stderr, /demote <slug>/);
    assert.match(run.stderr, /append-only history, not FIFO order/);
  } finally {
    s.cleanup();
  }
});
