// scripts/drain-status.test.mjs — plan 3619.
//
// New test FILE justification (CLAUDE.md § "A new `scripts/*.test.mjs` FILE requires a one-line
// justification"): the name-pair of a genuinely new module, `scripts/drain-status.mjs`. There is no
// existing name-paired file to fold into.
//
// The module writes with git PLUMBING and reads from origin, so every test here injects `_git` and
// asserts on the exact argv the module would run — the same style `coord-git.test.mjs` uses for
// deadSeedVerdict. Two properties carry the weight and are asserted directly rather than inferred:
// the commit is PINNED TO ITS FORK SNAPSHOT (so the pre-push exemption keeps firing after master
// moves), and every unreadable/garbage status degrades to "no status" rather than to a state that
// could suspend a dead-seed clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  DRAIN_STATUS_REF_GLOB,
  buildStatusPayload,
  clearDrainStatus,
  parseStatusHeads,
  parseStatusPayload,
  planIdFromSlug,
  countHeldCommits,
  assertNoFlagShapedValues,
  readDrainStatuses,
  statusBranchFor,
  statusPathFor,
  statusRefFor,
  writeDrainStatus,
} from './drain-status.mjs';

const SLUG = '3595-SOL-Infra-recurring-oneoff-archive-sweep';
const SHA_MASTER = 'm'.repeat(40).replace(/m/g, 'a');
const SHA_PREV = 'b'.repeat(40);
const SHA_BLOB = 'c'.repeat(40);
const SHA_TREE = 'd'.repeat(40);
const SHA_COMMIT = 'e'.repeat(40);

test('naming: the slug decides the path, the branch and the ref', () => {
  assert.equal(statusPathFor(SLUG), `.drain-status/${SLUG}.json`);
  assert.equal(statusBranchFor(SLUG), `claude/status/${SLUG}`);
  assert.equal(statusRefFor(SLUG), `refs/heads/claude/status/${SLUG}`);
  assert.equal(DRAIN_STATUS_REF_GLOB, 'refs/heads/claude/status/*');
});

test('the status namespace does NOT collide with the execution-branch glob', () => {
  // Load-bearing, not cosmetic: `queue-drain.mjs` and `reconcile-worktree-branches.mjs` both read
  // `refs/heads/claude/drain-*` and mine a plan id out of every name they match. A status branch
  // under that glob would be parsed as an EXECUTION branch — i.e. as work awaiting adoption.
  assert.equal(statusBranchFor(SLUG).startsWith('claude/drain-'), false);
  assert.match(statusBranchFor(SLUG), /^claude\/status\//);
});

test('planIdFromSlug: the same id grammar the execution-branch regexes use', () => {
  assert.equal(planIdFromSlug(SLUG), '3595');
  assert.equal(planIdFromSlug('3595'), '3595');
  // A legacy date-slugged name must NOT yield `2026` — the exact false-id trap
  // ORIGIN_EXECUTED_BRANCH_RXS documents, mirrored here so the two cannot drift.
  assert.equal(planIdFromSlug('2026-05-17-vetpris-thing'), null);
  assert.equal(planIdFromSlug('batch-2026-07-05-coord'), null);
  assert.equal(planIdFromSlug(''), null);
});

test('parseStatusHeads: reads its own refs out of a MIXED ls-remote payload', () => {
  // The whole namespace rides queue-drain's single ls-remote alongside the drain markers and the
  // worktree branches, so this parser must ignore everything that is not its own.
  const heads = parseStatusHeads(
    [
      `${SHA_PREV}\trefs/heads/claude/drain-3595-SOL-Infra-x`,
      `${SHA_MASTER}\trefs/heads/worktree-3600-Coord-y`,
      `${SHA_COMMIT}\trefs/heads/claude/status/${SLUG}`,
      `${SHA_TREE}\trefs/heads/claude/status/0912-Pipe-padded`,
      'garbage line with no tab',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    heads.map((h) => [h.slug, h.planId, h.sha]),
    [
      [SLUG, '3595', SHA_COMMIT],
      ['0912-Pipe-padded', '0912', SHA_TREE],
    ],
  );
});

test('buildStatusPayload: carries heartbeat, held commits and the failing gate', () => {
  const payload = buildStatusPayload({
    slug: SLUG,
    branch: 'claude/drain-3595-SOL-Infra-x',
    blockedOn: 'scripts-battery',
    heldCommits: 4,
    session: 'cse_01DypFRSuzjnWGnLodeBDWiC',
    nowMs: Date.parse('2026-09-01T20:40:00Z'),
  });
  assert.equal(payload.planId, '3595', 'the plan id is derived from the slug when not passed');
  assert.equal(payload.heartbeatAt, '2026-09-01T20:40:00.000Z');
  assert.equal(payload.heldCommits, 4);
  assert.equal(payload.blockedOn, 'scripts-battery');
});

test('parseStatusPayload: a well-formed payload round-trips to epoch ms', () => {
  const raw = JSON.stringify(
    buildStatusPayload({
      slug: SLUG,
      blockedOn: 'pytest-backend-scripts',
      heldCommits: 2,
      nowMs: Date.parse('2026-09-01T20:40:00Z'),
    }),
  );
  const parsed = parseStatusPayload(raw);
  assert.equal(parsed.heartbeatMs, Date.parse('2026-09-01T20:40:00Z'));
  assert.equal(parsed.blockedOn, 'pytest-backend-scripts');
  assert.equal(parsed.heldCommits, 2);
  assert.equal(parsed.planId, '3595');
});

for (const [label, raw] of [
  ['not JSON at all', 'not json {{{'],
  ['a JSON scalar', '"just a string"'],
  ['null', 'null'],
  ['an object with no heartbeat', '{"slug":"3595-x"}'],
  ['an unparsable heartbeat', '{"slug":"3595-x","heartbeatAt":"whenever"}'],
]) {
  test(`parseStatusPayload: ${label} degrades to NO status`, () => {
    // A published status is EVIDENCE, not a flag. Anything that does not parse must land on null,
    // because the caller turns a parsed heartbeat into a SUSPENDED dead-seed clock — suspending
    // that clock on garbage is how a plan gets pinned out of selection by a corrupt file.
    assert.equal(parseStatusPayload(raw), null);
  });
}

test('parseStatusPayload: hostile field TYPES are dropped, not trusted through', () => {
  const parsed = parseStatusPayload(
    JSON.stringify({
      slug: SLUG,
      heartbeatAt: '2026-09-01T20:40:00Z',
      heldCommits: 'lots',
      blockedOn: { gate: 'battery' },
      session: 42,
    }),
  );
  assert.equal(parsed.heldCommits, null);
  assert.equal(parsed.blockedOn, null);
  assert.equal(parsed.session, null);
  assert.equal(parsed.heartbeatMs, Date.parse('2026-09-01T20:40:00Z'));
});

// ── write ───────────────────────────────────────────────────────────────────

// A stub that behaves like a COMPLIANT git seam: it forwards `opts.env` (so the `git var` identity
// probe sees the injected author name) and, like real `read-tree`, creates the index file that
// GIT_INDEX_FILE points at. `writeDrainStatus` refuses to build a tree without both, because a seam
// that silently drops env would run the index work against the caller's REAL index and stage a
// stray `.drain-status/*.json` into the very commit a drain is about to push.
function recordingGit(responses, { honourEnv = true, createIndex = true } = {}) {
  const calls = [];
  const _git = (_dir, args, opts = {}) => {
    calls.push(args);
    if (args[0] === 'var') {
      return honourEnv
        ? `${opts.env?.GIT_AUTHOR_NAME ?? ''} <x> 0 +0000`
        : 'someone else <x> 0 +0000';
    }
    if (args[0] === 'read-tree' && createIndex && opts.env?.GIT_INDEX_FILE) {
      writeFileSync(opts.env.GIT_INDEX_FILE, '');
    }
    for (const [match, out] of responses) if (match(args)) return out;
    return '';
  };
  return { calls, _git };
}

test('writeDrainStatus: a FIRST write parents on origin/master and pushes the status ref', () => {
  const { calls, _git } = recordingGit([
    [(a) => a[0] === 'ls-remote', ''], // no status branch yet
    [(a) => a[0] === 'rev-parse', `${SHA_MASTER}\n`],
    [(a) => a[0] === 'hash-object', `${SHA_BLOB}\n`],
    [(a) => a[0] === 'write-tree', `${SHA_TREE}\n`],
    [(a) => a[0] === 'commit-tree', `${SHA_COMMIT}\n`],
  ]);
  const r = writeDrainStatus(
    '/repo',
    SLUG,
    { blockedOn: 'scripts-battery', heldCommits: 4, nowMs: Date.parse('2026-09-01T20:40:00Z') },
    { _git },
  );

  const readTree = calls.find((a) => a[0] === 'read-tree');
  assert.deepEqual(readTree.slice(0, 2), ['read-tree', SHA_MASTER]);
  const commitTree = calls.find((a) => a[0] === 'commit-tree');
  assert.deepEqual(commitTree.slice(0, 4), ['commit-tree', SHA_TREE, '-p', SHA_MASTER]);
  const updateIndex = calls.find((a) => a[0] === 'update-index');
  assert.equal(updateIndex[3], `100644,${SHA_BLOB},${statusPathFor(SLUG)}`);
  const push = calls.find((a) => a[0] === 'push');
  assert.deepEqual(push, ['push', '--quiet', 'origin', `${SHA_COMMIT}:${statusRefFor(SLUG)}`]);
  assert.equal(r.branch, statusBranchFor(SLUG));
  assert.equal(r.commit, SHA_COMMIT);
});

test('writeDrainStatus: a HEARTBEAT pins its tree to the previous status tip, never to origin/master', () => {
  // THE load-bearing property of the whole channel. Re-reading origin/master on each heartbeat is
  // the tempting shape: once master advances, the branch's fork-point diff would then carry every
  // intervening master change, the content-based pre-push exemption would stop firing, and the
  // status push — the one push that must get out while the gate is red — would start running the
  // full battery. Pinning to the fork snapshot keeps the branch's entire diff equal to one file.
  const { calls, _git } = recordingGit([
    [(a) => a[0] === 'ls-remote', `${SHA_PREV}\trefs/heads/claude/status/${SLUG}\n`],
    [(a) => a[0] === 'hash-object', `${SHA_BLOB}\n`],
    [(a) => a[0] === 'write-tree', `${SHA_TREE}\n`],
    [(a) => a[0] === 'commit-tree', `${SHA_COMMIT}\n`],
  ]);
  writeDrainStatus('/repo', SLUG, { blockedOn: 'pytest-backend-scripts' }, { _git });

  assert.deepEqual(
    calls.find((a) => a[0] === 'read-tree').slice(0, 2),
    ['read-tree', SHA_PREV],
    'the tree comes from the previous status tip',
  );
  assert.deepEqual(
    calls.find((a) => a[0] === 'commit-tree').slice(2, 4),
    ['-p', SHA_PREV],
    'and so does the parent — the push stays a fast-forward',
  );
  assert.equal(
    calls.some((a) => a[0] === 'rev-parse' && a.includes('origin/master')),
    false,
    'origin/master is never consulted once the branch exists',
  );
});

test('writeDrainStatus: nothing in the caller working tree is touched', () => {
  // A drain heartbeats mid-gate, from inside a dirty worktree holding the very commits it is
  // trying to push. A checkout, a branch switch or a bare `git add` here would disturb the work.
  const { calls, _git } = recordingGit([
    [(a) => a[0] === 'ls-remote', ''],
    [(a) => a[0] === 'rev-parse', `${SHA_MASTER}\n`],
    [(a) => a[0] === 'hash-object', `${SHA_BLOB}\n`],
    [(a) => a[0] === 'write-tree', `${SHA_TREE}\n`],
    [(a) => a[0] === 'commit-tree', `${SHA_COMMIT}\n`],
  ]);
  writeDrainStatus('/repo', SLUG, {}, { _git });
  for (const forbidden of ['checkout', 'switch', 'add', 'commit', 'stash', 'reset', 'branch']) {
    assert.equal(
      calls.some((a) => a[0] === forbidden),
      false,
      `writeDrainStatus must never run \`git ${forbidden}\``,
    );
  }
});

test('clearDrainStatus: deletes the ref, and is a no-op when there is nothing to delete', () => {
  const present = recordingGit([
    [(a) => a[0] === 'ls-remote', `${SHA_PREV}\trefs/heads/claude/status/${SLUG}\n`],
  ]);
  assert.deepEqual(clearDrainStatus('/repo', SLUG, { _git: present._git }), { deleted: true });
  assert.deepEqual(
    present.calls.find((a) => a[0] === 'push'),
    ['push', '--quiet', 'origin', `:${statusRefFor(SLUG)}`],
  );

  const absent = recordingGit([[(a) => a[0] === 'ls-remote', '']]);
  assert.deepEqual(clearDrainStatus('/repo', SLUG, { _git: absent._git }), { deleted: false });
  assert.equal(
    absent.calls.some((a) => a[0] === 'push'),
    false,
    'no ref, no push — clear is idempotent',
  );
});

// ── read ────────────────────────────────────────────────────────────────────

test('readDrainStatuses: ONE fetch for the whole namespace, then local reads', () => {
  const heads = parseStatusHeads(
    [
      `${SHA_COMMIT}\trefs/heads/claude/status/${SLUG}`,
      `${SHA_PREV}\trefs/heads/claude/status/3600-Coord-other`,
    ].join('\n'),
  );
  const calls = [];
  const statuses = readDrainStatuses('/repo', heads, {
    log: () => {},
    _git: (_dir, args) => {
      calls.push(args);
      if (args[0] === 'fetch') return '';
      return JSON.stringify(
        buildStatusPayload({
          slug: args[1].includes('3600') ? '3600-Coord-other' : SLUG,
          blockedOn: 'scripts-battery',
          heldCommits: 4,
          nowMs: Date.parse('2026-09-01T20:40:00Z'),
        }),
      );
    },
  });
  assert.equal(calls.filter((a) => a[0] === 'fetch').length, 1, 'exactly one network round trip');
  assert.deepEqual([...statuses.keys()], ['3595', '3600']);
  assert.equal(statuses.get('3595').heartbeatMs, Date.parse('2026-09-01T20:40:00Z'));
  assert.equal(statuses.get('3595').blockedOn, 'scripts-battery');
});

test('readDrainStatuses: no heads means no fetch at all', () => {
  // The normal case — nobody is gate-blocked — must cost nothing.
  let called = false;
  const statuses = readDrainStatuses('/repo', [], {
    _git: () => {
      called = true;
      return '';
    },
  });
  assert.equal(statuses.size, 0);
  assert.equal(called, false);
});

test('readDrainStatuses: a failed fetch fails OPEN and LOUDLY', () => {
  // Fail-open in the same direction as the gate it feeds: an unreadable status namespace degrades
  // to the pre-3619 behaviour (the ordinary dead-seed age test), never to a silent suspension.
  const logged = [];
  const statuses = readDrainStatuses(
    '/repo',
    parseStatusHeads(`${SHA_COMMIT}\trefs/heads/claude/status/${SLUG}`),
    {
      log: (m) => logged.push(m),
      _git: (_dir, args) => {
        if (args[0] === 'fetch') throw new Error('network is down');
        return '';
      },
    },
  );
  assert.equal(statuses.size, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /WARNING/);
  assert.match(logged[0], /network is down/);
});

test('readDrainStatuses: one unreadable status does not lose the others', () => {
  const heads = parseStatusHeads(
    [
      `${SHA_COMMIT}\trefs/heads/claude/status/${SLUG}`,
      `${SHA_PREV}\trefs/heads/claude/status/3600-Coord-other`,
    ].join('\n'),
  );
  const logged = [];
  const statuses = readDrainStatuses('/repo', heads, {
    log: (m) => logged.push(m),
    _git: (_dir, args) => {
      if (args[0] === 'fetch') return '';
      if (args[1].includes('3600')) throw new Error('object missing');
      return JSON.stringify(buildStatusPayload({ slug: SLUG, nowMs: 1_700_000_000_000 }));
    },
  });
  assert.deepEqual([...statuses.keys()], ['3595']);
  assert.equal(logged.length, 1);
});

test('readDrainStatuses: a head whose slug yields no plan id is skipped', () => {
  const statuses = readDrainStatuses(
    '/repo',
    parseStatusHeads(`${SHA_COMMIT}\trefs/heads/claude/status/2026-05-17-legacy-slug`),
    {
      log: () => {},
      _git: () => JSON.stringify(buildStatusPayload({ slug: 'x', nowMs: 1_700_000_000_000 })),
    },
  );
  assert.equal(statuses.size, 0);
});

test('writeDrainStatus: REFUSES a git seam that drops opts.env, before mutating anything', () => {
  // The guarantee this module sells is "nothing in the caller's working tree is touched", and it
  // rests entirely on `opts.env` reaching git so GIT_INDEX_FILE redirects the index. A seam that
  // drops env would instead run read-tree/update-index against the caller's REAL index, staging a
  // stray status file into the commit a drain is about to push — the exact pollution this design
  // avoided by keeping status off the work marker. So it is checked, not assumed. Found by
  // exercising the module against a scratch remote with a lying stub, which did precisely that.
  const { calls, _git } = recordingGit([], { honourEnv: false });
  assert.throws(
    () => writeDrainStatus('/repo', SLUG, {}, { _git }),
    /does not pass `opts.env` through/,
  );
  assert.deepEqual(
    calls.map((a) => a[0]),
    ['var'],
    'it refuses BEFORE touching the index',
  );
});

test('writeDrainStatus: REFUSES when GIT_INDEX_FILE was not honoured, before write-tree', () => {
  // Belt-and-braces behind the probe: real `read-tree` creates the index it writes, so an absent
  // temp file after it proves the redirect did not take — abort rather than commit a tree built
  // from the caller's real index.
  const { calls, _git } = recordingGit([[(a) => a[0] === 'rev-parse', `${SHA_MASTER}\n`]], {
    createIndex: false,
  });
  assert.throws(
    () => writeDrainStatus('/repo', SLUG, {}, { _git }),
    /GIT_INDEX_FILE was not honoured/,
  );
  assert.equal(
    calls.some((a) => a[0] === 'write-tree' || a[0] === 'commit-tree' || a[0] === 'push'),
    false,
    'nothing is written or pushed once the redirect is known to have failed',
  );
});

test('countHeldCommits: counts what this sandbox holds unpushed, and is ADVISORY on failure', () => {
  // Regression pin (delta-review finding, 10 finders): swapping the hand-rolled flag parser for the
  // shared one deleted this helper and left its call site behind, so `write` WITHOUT an explicit
  // `--held-commits` — the way the routine prompt actually calls it — died with a ReferenceError.
  // The live probe missed it because it passed the flag. This walks the default path instead.
  const calls = [];
  assert.equal(
    countHeldCommits('/repo', 'claude/drain-3595-x', {
      _exec: (cmd, args) => {
        calls.push(args);
        return '4\n';
      },
    }),
    4,
  );
  assert.deepEqual(calls[0], [
    '-C',
    '/repo',
    'rev-list',
    '--count',
    'origin/claude/drain-3595-x..HEAD',
  ]);

  // No branch ⇒ the tracking upstream.
  countHeldCommits('/repo', null, { _exec: (_c, args) => (calls.push(args), '0\n') });
  assert.deepEqual(calls[1], ['-C', '/repo', 'rev-list', '--count', '@{u}..HEAD']);

  // Advisory: a failure yields null, never a throw — the heartbeat matters more than the count.
  assert.equal(
    countHeldCommits('/repo', null, {
      _exec: () => {
        throw new Error('no upstream configured');
      },
    }),
    null,
  );
});

test('assertNoFlagShapedValues: a flag-shaped value is REFUSED, not published (round 3)', () => {
  // `requireValues` does not cover this shape: `--blocked-on --session cse_x` is a MISSING value,
  // but the shared parser consumes the next token, so the run published `blockedOn: "--session"` —
  // a heartbeat naming a gate that does not exist, written by an unattended drain with nobody
  // watching to notice. Reproduced live before this guard existed.
  assert.throws(
    () => assertNoFlagShapedValues({ 'blocked-on': '--session' }),
    /--blocked-on was given the flag-shaped value/,
  );
  assert.doesNotThrow(() => assertNoFlagShapedValues({ 'blocked-on': 'scripts-battery' }));
  assert.doesNotThrow(() => assertNoFlagShapedValues({ note: 'a note - with a dash' }));
});
