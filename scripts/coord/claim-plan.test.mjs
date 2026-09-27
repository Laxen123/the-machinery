// scripts/claim-plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRef,
  readHolder,
  readClaimRefTip,
  releaseOwnClaimRef,
  heldClaimsMap,
  planStatus,
  mintSessionNumber,
  mirrorLegacyCounter,
  runClaimProjectionRetryLoop,
  COORD_PUSH_TIMEOUT_MS,
  doAcquire,
  doAcquireBatch,
  doDerail,
  projectDerail,
  activePathFor,
  writeSessionEntryExclusive,
  regenIndexContent,
  indexIsCurrent,
  healIndexDriftAfterMove,
  classifyTakeoverRows,
  classifyTakeoverRowsLines,
  takeoverSupersededResume,
  freshenOriginOnce,
  gcProbeRefs,
} from './claim-plan.mjs';
for (const name of [
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
])
  delete process.env[name];
import { parseClaimMessage, refForPlan } from './claim-plan-lib.mjs';
import {
  CLAIM_GLOBS,
  claimRef,
  legacyClaimRef,
  coordRef,
  legacyCoordRef,
  PROBE_GLOB,
} from './coord-refs.mjs';
import {
  INDEX_PLANS_START,
  INDEX_PLANS_END,
  INDEX_SPECS_START,
  INDEX_SPECS_END,
  ARCHIVE_FOLDER,
} from './build-index-lib.mjs';
import { splitBoard } from './board-lib.mjs';
import { releaseClaim } from './release-claim.mjs';
import { editClaimHolderError } from '../edit-plan.mjs';
import { claimHolderError } from './move-plan.mjs';
import { COORD_CHECKOUT_TIMEOUT } from './coord-git.mjs';
import { MUTATION_BANNER_LABEL } from './build-index-lib.mjs';

const CLAIM_PLAN_CLI = fileURLToPath(new URL('./claim-plan.mjs', import.meta.url));

// plan 4071 D3: GATE1_PIPELINE_FIELDS was removed from claim-plan-lib.mjs — the historical
// Gate-1 field list now lives in coord.config.json's `land.specReviewGatedFields[]`, and
// doAcquire/doAcquireBatch pass it through as `cfg.land.specReviewGatedFields` (read from
// whatever coord.config.json the test fixture below writes) instead of an implicit
// hardcoded literal. PIPELINE_FIELDS is a purely synthetic TEST FIXTURE constant (plan 3958:
// this module ships as-is into the public coord-kit, so a shipped core test must not pin THIS
// repo's real coord.config.json value) these Gate-2 fixtures stamp into their OWN throwaway
// coord.config.json, so none of them depend on this repo's actual config content.
const PIPELINE_FIELDS = ['acceptsAcuteCases', 'acuteCapability'];
// plan 3958: same rationale as build-index-lib.test.mjs's own `sw()` — MUTATION_BANNER_LABEL is
// the kit's neutral 'DATA-WRITE' default there, not vetapp's real 'SEED-WRITE' row, and is the
// IDENTITY function on vetapp itself (where the label really is 'SEED-WRITE').
const sw = (s) => s.replaceAll('SEED-WRITE', MUTATION_BANNER_LABEL);

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

// A bare "origin" + a working clone with one pushed master commit.
function makeBareOrigin() {
  const origin = mkdtempSync(join(tmpdir(), 'claim-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), 'claim-work-'));
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
    // plan 3756: sweeps BOTH claim namespaces, so a test asserting "the claim ref exists"
    // keeps meaning that regardless of which namespace the spine is writing to.
    lsClaims: () => g('ls-remote', origin, ...CLAIM_GLOBS),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

// plan 3756: a claim ref now lives in the branch-shaped namespace, so tests that assert
// "plan <id> is held" build their pattern from the seam instead of pinning a literal.
const claimRx = (id) => new RegExp(claimRef(id).replace(/[/]/g, '\\/'));

const COORD_ID_ENV_NAMES = [
  'COORD_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'GROK_SESSION_ID',
];

function withCoordIdentityEnv(values, fn) {
  const previous = Object.fromEntries(COORD_ID_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of COORD_ID_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const name of COORD_ID_ENV_NAMES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('codex parity identity: derail rejects conflicts before any projection, including force', () => {
  withCoordIdentityEnv(
    { CLAUDE_CODE_SESSION_ID: 'claude-owner', CODEX_THREAD_ID: 'codex-owner' },
    () => {
      for (const force of [false, true]) {
        const calls = [];
        assert.throws(
          () =>
            doDerail(
              '/unused',
              '3753',
              { force },
              {
                projectDerail: () => {
                  calls.push('project');
                  return { changed: true };
                },
                releaseClaim: () => {
                  calls.push('release');
                  return { released: true };
                },
              },
            ),
          /Ambiguous coordination identity/,
        );
        assert.deepEqual(calls, []);
      }
    },
  );
});

test('codex parity identity: Claude-held claim is foreign to Codex status, edit, move, and release', () => {
  const r = makeBareOrigin();
  try {
    withCoordIdentityEnv({ CLAUDE_CODE_SESSION_ID: 'claude-owner' }, () => {
      assert.equal(
        doAcquire(r.dir, '9375-Coord-parity', {
          slug: '9375-Coord-parity',
          'lock-only': true,
        }).won,
        true,
      );
    });

    withCoordIdentityEnv(
      { CODEX_SESSION_ID: 'codex-other', CODEX_THREAD_ID: 'codex-other' },
      () => {
        const status = planStatus(r.dir, '9375');
        assert.equal(status.youAreHolder, false);
        assert.match(
          editClaimHolderError(status, { basename: '9375-Coord-parity.md' }),
          /another session/i,
        );
        assert.match(
          claimHolderError(status, { basename: '9375-Coord-parity.md' }),
          /refusing to move/i,
        );
        const released = releaseClaim(r.dir, '9375');
        assert.equal(released.released, false);
        assert.equal(released.reason, 'foreign');
      },
    );
    assert.match(r.lsClaims(), claimRx('9375'));
  } finally {
    withCoordIdentityEnv({ COORD_SESSION_ID: 'cleanup' }, () =>
      releaseClaim(r.dir, '9375', { force: true }),
    );
    r.cleanup();
  }
});

test('codex parity identity: Codex-held claim is self for status/edit/move/release and foreign to another identity', () => {
  const r = makeBareOrigin();
  try {
    const codexEnv = { CODEX_SESSION_ID: 'codex-tree', CODEX_THREAD_ID: 'codex-owner' };
    withCoordIdentityEnv(codexEnv, () => {
      assert.equal(
        doAcquire(r.dir, '9376-Coord-parity', {
          slug: '9376-Coord-parity',
          'lock-only': true,
        }).won,
        true,
      );
      const status = planStatus(r.dir, '9376');
      assert.equal(status.youAreHolder, true);
      assert.equal(editClaimHolderError(status, { basename: '9376-Coord-parity.md' }), null);
      assert.equal(claimHolderError(status, { basename: '9376-Coord-parity.md' }), null);
    });

    for (const foreignEnv of [
      { CLAUDE_CODE_SESSION_ID: 'claude-other' },
      { CODEX_SESSION_ID: 'codex-tree', CODEX_THREAD_ID: 'sibling-thread' },
    ])
      withCoordIdentityEnv(foreignEnv, () => {
        const status = planStatus(r.dir, '9376');
        assert.equal(status.youAreHolder, false);
        assert.match(
          editClaimHolderError(status, { basename: '9376-Coord-parity.md' }),
          /another session/i,
        );
        assert.match(
          claimHolderError(status, { basename: '9376-Coord-parity.md' }),
          /refusing to move/i,
        );
        assert.equal(releaseClaim(r.dir, '9376').reason, 'foreign');
      });

    withCoordIdentityEnv(codexEnv, () => {
      const released = releaseClaim(r.dir, '9376');
      assert.equal(released.released, true);
      assert.equal(released.reason, 'owner');
    });
  } finally {
    r.cleanup();
  }
});

test('codex parity identity: conflicts refuse before acquire and forced release', () => {
  const r = makeBareOrigin();
  const conflict = {
    CLAUDE_CODE_SESSION_ID: 'claude-owner',
    CODEX_SESSION_ID: 'codex-owner',
    CODEX_THREAD_ID: 'codex-owner',
  };
  try {
    withCoordIdentityEnv(conflict, () => {
      assert.throws(
        () =>
          doAcquire(r.dir, '9377-Coord-parity', {
            slug: '9377-Coord-parity',
            'lock-only': true,
          }),
        /Ambiguous coordination identity/,
      );
    });
    // plan 3756: a release leaves a tombstone rather than deleting the ref, so "released" is
    // asserted through planStatus (which reads the tip), never by the ref's absence.
    assert.equal(planStatus(r.dir, '9377').held, false);

    withCoordIdentityEnv({ CODEX_SESSION_ID: 'owner', CODEX_THREAD_ID: 'owner' }, () => {
      doAcquire(r.dir, '9378-Coord-parity', {
        slug: '9378-Coord-parity',
        'lock-only': true,
      });
    });
    withCoordIdentityEnv(conflict, () => {
      assert.throws(() => releaseClaim(r.dir, '9378', { force: true }), /Ambiguous/);
    });
    assert.match(r.lsClaims(), claimRx('9378'));
  } finally {
    withCoordIdentityEnv({ COORD_SESSION_ID: 'cleanup' }, () =>
      releaseClaim(r.dir, '9378', { force: true }),
    );
    r.cleanup();
  }
});

test('codex parity identity: explicit override resolves native conflict and headless remains anonymous', () => {
  const r = makeBareOrigin();
  try {
    withCoordIdentityEnv(
      {
        COORD_SESSION_ID: 'explicit-owner',
        CLAUDE_CODE_SESSION_ID: 'claude-different',
        CODEX_SESSION_ID: 'codex-different',
      },
      () => {
        doAcquire(r.dir, '9379-Coord-parity', {
          slug: '9379-Coord-parity',
          'lock-only': true,
        });
        assert.equal(planStatus(r.dir, '9379').youAreHolder, true);
        assert.equal(releaseClaim(r.dir, '9379').reason, 'owner');
      },
    );

    withCoordIdentityEnv({}, () => {
      doAcquire(r.dir, '9380-Coord-parity', {
        slug: '9380-Coord-parity',
        'lock-only': true,
      });
      assert.equal(planStatus(r.dir, '9380').youAreHolder, false);
      assert.equal(releaseClaim(r.dir, '9380').reason, 'foreign');
    });
    assert.match(r.lsClaims(), claimRx('9380'));
  } finally {
    withCoordIdentityEnv({ COORD_SESSION_ID: 'cleanup' }, () =>
      releaseClaim(r.dir, '9380', { force: true }),
    );
    r.cleanup();
  }
});

test('acquireRef: first acquire of a plan creates the ref and wins', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    const r = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=A\nhost=H\niso=I\n',
    });
    assert.equal(r.won, true);
    assert.match(lsClaims(), new RegExp(claimRef('365').replace(/[/]/g, '\\/')));
  } finally {
    cleanup();
  }
});

// ───────────── plan 3756: the tombstone round-trip ─────────────
// The property the whole namespace move rests on. Release stopped deleting the ref (the
// proxy 403s deletes by verb), so a released claim is a ref pointing at a tombstone — and
// the plan-368 CAS, which read "the ref exists" as "someone holds it", would otherwise make
// every plan claimable exactly once for the lifetime of the repo.

test('plan 3756: a released claim can be RE-acquired — the ref survives, the lock does not', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    const first = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=A\niso=I1\n',
    });
    assert.equal(first.won, true);
    assert.equal(releaseOwnClaimRef(dir, '365', first.sha, { reason: 'landed' }), true);

    // The ref is STILL THERE — that is the whole difference from a delete...
    assert.match(lsClaims(), claimRx('365'), 'the ref survives the release');
    // ...but nobody holds it.
    assert.equal(readHolder(dir, '365'), null, 'a tombstoned ref reads as unheld');

    const second = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=B\niso=I2\n',
    });
    assert.equal(second.won, true, 'a re-claim of a released plan must WIN');
    assert.match(readHolder(dir, '365').body, /session=B/);
  } finally {
    cleanup();
  }
});

test('plan 3756: only ONE of two racing re-acquires over the same tombstone wins', () => {
  // The CAS still has to hold when the ref is a chain rather than a create. Both claimants
  // read the same tombstone tip and parent on it; the second push is non-ff and loses.
  const { dir, origin, cleanup } = makeBareOrigin();
  const dir2 = mkdtempSync(join(tmpdir(), 'claim-rival-'));
  try {
    const g2 = (...a) => execFileSync('git', ['-C', dir2, ...a], { encoding: 'utf8' });
    g2('init', '-q', '-b', 'master');
    g2('config', 'user.email', 't@t.t');
    g2('config', 'user.name', 'T');
    g2('config', 'commit.gpgsign', 'false');
    g2('remote', 'add', 'origin', origin);

    const first = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=A\niso=I1\n',
    });
    releaseOwnClaimRef(dir, '365', first.sha, { reason: 'landed' });

    const a = acquireRef(dir, { planId: '365', message: 'claim plan=365\nsession=A2\niso=I2\n' });
    const b = acquireRef(dir2, { planId: '365', message: 'claim plan=365\nsession=B2\niso=I3\n' });
    assert.equal(a.won, true);
    assert.equal(b.won, false, 'the second re-acquire must LOSE, not double-claim');
    assert.equal(b.lost, true);
    assert.match(readHolder(dir, '365').body, /session=A2/);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
    cleanup();
  }
});

test('plan 3756: releasing a claim a rival already re-acquired is REFUSED, not clobbered', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const first = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=A\niso=I1\n',
    });
    releaseOwnClaimRef(dir, '365', first.sha, { reason: 'landed' });
    const rival = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=RIVAL\niso=I2\n',
    });
    assert.equal(rival.won, true);

    // Our stale rollback, pinned to the claim commit WE pushed. The tip has moved past it,
    // so the append is no longer a fast-forward and origin rejects it — the same protection
    // --force-with-lease gave the old delete.
    assert.equal(releaseOwnClaimRef(dir, '365', first.sha, { reason: 'stale rollback' }), false);
    assert.match(readHolder(dir, '365').body, /session=RIVAL/, "the rival's claim survived");
  } finally {
    cleanup();
  }
});

test('plan 3756: a LEGACY claim still reads as held, and blocks a new-namespace acquire', () => {
  // The dual-read window. A session running pre-flip code holds refs/claims/<id> and cannot
  // see the branch-shaped ref at all, so the new code must yield to it rather than both
  // believing they hold the plan.
  const { dir, cleanup } = makeBareOrigin();
  try {
    const tree = execFileSync('git', ['-C', dir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const legacySha = execFileSync(
      'git',
      ['-C', dir, 'commit-tree', tree, '-m', 'claim plan=365\nsession=OLD\niso=I0\n'],
      { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['-C', dir, 'push', 'origin', `${legacySha}:${legacyClaimRef('365')}`], {
      encoding: 'utf8',
    });

    const holder = readHolder(dir, '365');
    assert.ok(holder, 'a pre-flip claim must still read as held');
    assert.equal(holder.ref, legacyClaimRef('365'));
    assert.match(holder.body, /session=OLD/);

    const mine = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=NEW\niso=I1\n',
    });
    assert.equal(mine.won, false, 'must not win over a live legacy claim');
    assert.equal(mine.lost, true);
    // and having yielded, it left no live claim of its own behind
    assert.equal(readHolder(dir, '365').ref, legacyClaimRef('365'));
  } finally {
    cleanup();
  }
});

test('plan 3756: heldClaimsMap reports live claims and hides released ones', () => {
  // The sweep readers (reconcile-board, the boards, wake-stalls) cannot use ls-remote alone
  // any more: it reports names and shas, and a tombstoned ref looks exactly like a live one.
  // This is the seam that resolves the tips for them.
  const { dir, cleanup } = makeBareOrigin();
  try {
    const a = acquireRef(dir, { planId: '365', message: 'claim plan=365\nsession=A\niso=I1\n' });
    acquireRef(dir, { planId: '366', message: 'claim plan=366\nsession=B\niso=I2\n' });

    let map = heldClaimsMap(dir);
    assert.deepEqual(Object.keys(map).sort(), ['365', '366']);
    assert.equal(map['365'].ref, claimRef('365'));

    releaseOwnClaimRef(dir, '365', a.sha, { reason: 'landed' });
    map = heldClaimsMap(dir);
    assert.deepEqual(Object.keys(map), ['366'], 'a released claim must drop out of the sweep');
  } finally {
    cleanup();
  }
});

test('plan 3756: heldClaimsMap THROWS on an unreadable origin — it never fails open', () => {
  // The direction matters more than the message. Every caller reads a missing id as "this plan
  // is free", so returning a partial or empty map on a failed read would let a drain take a
  // held plan, or invite an operator to delete a claimed branch. An error is the safe answer.
  const boom = () => {
    throw new Error('origin unreachable');
  };
  assert.throws(() => heldClaimsMap('/fake', { _git: boom }), /could not read the claim namespace/);
});

test('plan 3756: heldClaimsMap still sees a pre-flip legacy claim', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const tree = execFileSync('git', ['-C', dir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
    const sha = execFileSync(
      'git',
      ['-C', dir, 'commit-tree', tree, '-m', 'claim plan=369\nsession=OLD\niso=I0\n'],
      { encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['-C', dir, 'push', 'origin', `${sha}:${legacyClaimRef('369')}`], {
      encoding: 'utf8',
    });
    const map = heldClaimsMap(dir);
    assert.deepEqual(Object.keys(map), ['369']);
    assert.equal(
      map['369'].ref,
      legacyClaimRef('369'),
      'reported at the ref that actually holds it',
    );
  } finally {
    cleanup();
  }
});

test('acquireRef: a second, different acquire of the same plan LOSES (non-ff), ref unchanged', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const first = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=A\niso=I1\n',
    });
    const second = acquireRef(dir, {
      planId: '365',
      message: 'claim plan=365\nsession=B\niso=I2\n',
    });
    assert.equal(first.won, true);
    assert.equal(second.won, false);
    assert.equal(second.lost, true);
    // the ref still points at the FIRST winner's sha
    const holder = readHolder(dir, '365');
    assert.match(holder.body, /session=A/);
  } finally {
    cleanup();
  }
});

test('acquireRef: two DIFFERENT plans both win (no false contention)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.equal(
      acquireRef(dir, { planId: '365', message: 'claim plan=365\nsession=A\n' }).won,
      true,
    );
    assert.equal(
      acquireRef(dir, { planId: '366', message: 'claim plan=366\nsession=B\n' }).won,
      true,
    );
  } finally {
    cleanup();
  }
});

test('readHolder: null when the plan is unheld', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.equal(readHolder(dir, '999'), null);
  } finally {
    cleanup();
  }
});

test('mintSessionNumber: sequential mints are monotonic from 1', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.equal(mintSessionNumber(dir), 1);
    assert.equal(mintSessionNumber(dir), 2);
    assert.equal(mintSessionNumber(dir), 3);
  } finally {
    cleanup();
  }
});

test('doAcquire --lock-only: winner gets won+sessionNum+claimSha; same-plan rival LOSES with holder', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const won = doAcquire(dir, '368-Other-x', {
      slug: '368-Other-x',
      'lock-only': true,
      host: 'H1',
    });
    assert.equal(won.won, true);
    assert.equal(won.planId, '368');
    assert.equal(won.sessionNum, 1); // first mint
    assert.match(won.claimSha, /^[0-9a-f]{7,40}$/);
    assert.equal(won.projected, false);

    const lost = doAcquire(dir, '368-Other-x', {
      slug: '368-Other-x',
      'lock-only': true,
      host: 'H2',
    });
    assert.equal(lost.won, false);
    assert.equal(lost.planId, '368');
    assert.equal(lost.holder.host, 'H1'); // reports the FIRST winner as the holder
  } finally {
    cleanup();
  }
});

test('doAcquire: a winning claim for a DIFFERENT plan mints the next session number', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.equal(doAcquire(dir, '368-x', { slug: '368-x', 'lock-only': true }).sessionNum, 1);
    assert.equal(doAcquire(dir, '369-x', { slug: '369-x', 'lock-only': true }).sessionNum, 2);
  } finally {
    cleanup();
  }
});

// --- plan 1627: execModel surfaced in the acquire result (the CLI's doctrine-block seat) ----

test('doAcquire: result carries execModel:fable from the plan frontmatter', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlanOnOrigin(dir, 'ready', '460-Infra-fable-plan.md', [
      'summary: "x"',
      'stage: specced',
      'specReview: abc1234',
      'execModel: fable',
    ]);
    const r = doAcquire(dir, '460-Infra-fable-plan', {
      slug: '460-Infra-fable-plan',
      'lock-only': true,
    });
    assert.equal(r.won, true);
    assert.equal(r.execModel, 'fable');
  } finally {
    cleanup();
  }
});

test('doAcquire: execModel is null with no resolvable plan file, "sonnet" when frontmatter says so', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const noFile = doAcquire(dir, '461-x', { slug: '461-x', 'lock-only': true });
    assert.equal(noFile.execModel, null);
    assert.equal(noFile.frontmatterUnreadable, true); // read failed → the CLI's warn case
    seedPlanOnOrigin(dir, 'ready', '462-Infra-sonnet-plan.md', [
      'summary: "x"',
      'stage: specced',
      'specReview: abc1234',
      'execModel: sonnet',
    ]);
    const r = doAcquire(dir, '462-Infra-sonnet-plan', {
      slug: '462-Infra-sonnet-plan',
      'lock-only': true,
    });
    assert.equal(r.execModel, 'sonnet');
    assert.equal(r.frontmatterUnreadable, false);
  } finally {
    cleanup();
  }
});

test('doAcquire: readable frontmatter with NO execModel key -> execModel null but NOT frontmatterUnreadable (no crying wolf)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlanOnOrigin(dir, 'ready', '463-Infra-keyless-plan.md', [
      'summary: "x"',
      'stage: specced',
      'specReview: abc1234',
    ]);
    const r = doAcquire(dir, '463-Infra-keyless-plan', {
      slug: '463-Infra-keyless-plan',
      'lock-only': true,
    });
    assert.equal(r.execModel, null);
    assert.equal(r.frontmatterUnreadable, false); // readable, key just absent → CLI stays silent
  } finally {
    cleanup();
  }
});

test('doAcquire: fenced frontmatter that fails to parse stage -> frontmatterUnreadable (malformed, not key-absent)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    // A `---` fence is present but `stage:` parses empty — a fenced plan always carries
    // stage (plan 1292), so this shape means the frontmatter is malformed and the
    // execModel:null next to it cannot be trusted (review r3). specReview keeps Gate 2 open.
    seedPlanOnOrigin(dir, 'ready', '464-Infra-malformed-plan.md', [
      'summary: "x"',
      'specReview: abc1234',
    ]);
    const r = doAcquire(dir, '464-Infra-malformed-plan', {
      slug: '464-Infra-malformed-plan',
      'lock-only': true,
    });
    assert.equal(r.execModel, null);
    assert.equal(r.frontmatterUnreadable, true); // CLI warns instead of silently skipping the block
  } finally {
    cleanup();
  }
});

// ───────────────────── plan 2395: Gate-2 reads origin/master, not mainDir's stale index ──────
// Every coord writer (move-plan.mjs, next-plan-id.mjs, edit-plan.mjs, projectClaim itself)
// commits through the disposable coord-checkout and pushes straight to origin WITHOUT ever
// touching the main checkout's working tree — a `git worktree add` off the SAME shared .git
// (exactly like the real main-checkout + coord-checkout topology) reproduces that: the
// plan lands on origin/master and is visible via origin/master's object store, but `dir`'s
// own on-disk index/working tree never saw it.

// Simulate the disposable coord-checkout: a SEPARATE worktree of `dir`'s SAME shared .git
// that seeds+commits+pushes a plan straight to origin, never touching `dir`'s own working
// tree/index. Returns the coordDir path (caller owns cleanup via rmSync — the worktree admin
// data lives under `dir`'s own .git, cleaned up when `dir` itself is removed).
function seedPlanViaCoordCheckoutSim(dir, folder, basename, fmLines) {
  const coordDir = mkdtempSync(join(tmpdir(), 'claim-coord-'));
  execFileSync(
    'git',
    ['-C', dir, 'worktree', 'add', '-q', '-b', `coord-sim-${basename}`, coordDir, 'master'],
    {
      encoding: 'utf8',
    },
  );
  seedPlan(coordDir, folder, basename, fmLines);
  execFileSync('git', ['-C', coordDir, 'commit', '-qm', `seed ${basename}`], { encoding: 'utf8' });
  execFileSync('git', ['-C', coordDir, 'push', '-q', 'origin', `coord-sim-${basename}:master`], {
    encoding: 'utf8',
  });
  return coordDir;
}

test("plan 2395: Gate-2 read resolves via origin/master even when mainDir's own index is stale (post-move-plan state)", () => {
  const { dir, cleanup } = makeBareOrigin();
  let coordDir;
  try {
    coordDir = seedPlanViaCoordCheckoutSim(dir, 'ready', '470-Infra-stale-index.md', [
      'summary: "x"',
      'stage: specced',
      'specReview: abc1234',
      'execModel: fable',
    ]);

    // `dir`'s OWN index/working tree never saw the file — the OLD `git ls-files`-based
    // activePathFor(dir, …) finds nothing here, which is exactly the bug (plan 2395).
    assert.throws(() => activePathFor(dir, '470'), /no claimable plan file/);

    const r = doAcquire(dir, '470-Infra-stale-index', {
      slug: '470-Infra-stale-index',
      'lock-only': true,
    });
    assert.equal(r.won, true);
    assert.equal(r.execModel, 'fable');
    assert.equal(r.frontmatterUnreadable, false);
  } finally {
    if (coordDir) rmSync(coordDir, { recursive: true, force: true });
    cleanup();
  }
});

test('plan 2395: Gate-2 stub refusal FIRES for a stage:stub plan in that same stale-index state', () => {
  const { dir, cleanup } = makeBareOrigin();
  let coordDir;
  try {
    // stage: stub, no specReview — Gate 2 must refuse, and it can only refuse if the
    // read actually resolves the plan despite dir's stale index.
    coordDir = seedPlanViaCoordCheckoutSim(dir, 'ready', '471-Infra-stale-stub.md', [
      'summary: "x"',
      'stage: stub',
    ]);

    assert.throws(() => activePathFor(dir, '471'), /no claimable plan file/);
    assert.throws(
      () =>
        doAcquire(dir, '471-Infra-stale-stub', {
          slug: '471-Infra-stale-stub',
          'lock-only': true,
        }),
      /no specReview/,
    );
  } finally {
    if (coordDir) rmSync(coordDir, { recursive: true, force: true });
    cleanup();
  }
});

// Simulate a SINGLE disposable coord-checkout commit that pushes BOTH an updated
// coord.config.json AND the target plan file straight to origin/master, never touching
// `dir`'s own working tree/index — the shape a sibling coord write takes in production
// (plan 2502: coord.config.json is an ordinary tracked file, so any coord-checkout commit
// touching it lands on origin exactly like a plan-body edit does).
// Thin single-plan wrapper over the batch-plural pushConfigAndPlansViaCoordCheckoutSim
// (~line 2463, defined below — function declarations hoist) — plan 2561: the two duplicated
// the same worktree/commit/push plumbing; the plural form already handles a one-element list.
function pushConfigAndPlanViaCoordCheckoutSim(dir, configObj, folder, basename, bodyText) {
  return pushConfigAndPlansViaCoordCheckoutSim(dir, configObj, [{ folder, basename, bodyText }]);
}

test('plan 2502: Gate-2 seedLane read is pinned to the SAME origin/master sha as the plan-file read', () => {
  const { dir, cleanup } = makeBareOrigin();
  let coordDir;
  try {
    // `dir`'s own on-disk tree has NO coord.config.json (never fetched) — under the plan-2502
    // bug, loadCoordConfig(dir) would read that absence as seedLane=false, forcing readSeedMarker
    // to 🟩 regardless of the banner below, and letting the exempt-mechanical claim PASS.
    assert.equal(existsSync(join(dir, 'coord.config.json')), false);

    // A sibling coord write flips seedLane ON and stamps the plan's 🟥 banner in the SAME
    // commit, straight on origin/master — `dir`'s own working tree never sees either.
    coordDir = pushConfigAndPlanViaCoordCheckoutSim(
      dir,
      { seedShardDir: 'backend/src/data/seed', land: { specReviewGatedFields: PIPELINE_FIELDS } },
      'ready',
      '473-Infra-stale-config.md',
      [
        '---',
        'summary: "x"',
        'stage: stub',
        'specReview: exempt-mechanical',
        '---',
        '',
        '# 473-Infra-stale-config.md',
        '',
        sw('> 🟥 **SEED-WRITE: YES** — flips acceptsAcuteCases.'),
        '',
        'Demotes acceptsAcuteCases on rec-1097.',
        '',
      ].join('\n'),
    );

    // `dir`'s own working tree still has no coord.config.json at all — proving any refusal
    // below can only come from a FRESH origin/master read, not a locally-cached copy.
    assert.equal(existsSync(join(dir, 'coord.config.json')), false);

    assert.throws(
      () =>
        doAcquire(dir, '473-Infra-stale-config', {
          slug: '473-Infra-stale-config',
          'lock-only': true,
        }),
      /exempt-mechanical.*cannot cover/,
    );
  } finally {
    if (coordDir) rmSync(coordDir, { recursive: true, force: true });
    cleanup();
  }
});

test('doAcquire loss-path: a throwing readHolder still returns a clean loss (no error)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    doAcquire(dir, '368-x', { slug: '368-x', 'lock-only': true }); // winner holds the ref
    const lost = doAcquire(
      dir,
      '368-x',
      { slug: '368-x', 'lock-only': true },
      {
        readHolder: () => {
          throw new Error('transient git');
        },
      },
    );
    assert.equal(lost.won, false);
    assert.equal(lost.holder, null); // holder unknown, but still a clean loss
  } finally {
    cleanup();
  }
});

test('doAcquire won-path: a throwing mintSessionNumber RELEASES the just-won ref (no leak)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    assert.throws(
      () =>
        doAcquire(
          dir,
          '368-x',
          { slug: '368-x', 'lock-only': true },
          {
            mintSessionNumber: () => {
              throw new Error('counter unreachable');
            },
          },
        ),
      /counter unreachable/,
    );
    // the ref must NOT be left held — a retry starts clean
    assert.doesNotMatch(lsClaims(), /refs\/claims\/368/);
  } finally {
    cleanup();
  }
});

test('doAcquire won-path: a throwing projectClaim RELEASES the just-won ref (no leak)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    assert.throws(
      () =>
        doAcquire(
          dir,
          '368-x',
          { slug: '368-x' },
          {
            mintSessionNumber: () => 1,
            projectClaim: () => {
              throw new Error('projection aborted mid-flight');
            },
          },
        ),
      /projection aborted mid-flight/,
    );
    // the ref must NOT be left held — a retry starts clean (symmetry with the
    // session-counter rollback)
    assert.doesNotMatch(lsClaims(), /refs\/claims\/368/);
  } finally {
    cleanup();
  }
});

test('plan 872: doAcquire REJECTS a bare/prefix-less slug BEFORE acquiring the ref (no leak)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    // plan 869's mistake: slug `akut-card-…` lacks the `869-` prefix. The landing spine
    // later cannot derive the plan id from it (the plan-872 post-merge crash). The guard
    // must throw, and must do so BEFORE acquireRef so a retry starts with a clean ref.
    assert.throws(
      () =>
        doAcquire(dir, '869-UI-akut-card-emergency-red-unify', {
          slug: 'akut-card-emergency-red-unify',
          'lock-only': true,
        }),
      /must begin with the plan id "869-"/,
    );
    // no ref was created — the guard ran before acquireRef
    assert.doesNotMatch(lsClaims(), /refs\/claims\/869/);
  } finally {
    cleanup();
  }
});

test('plan 872: doAcquire ACCEPTS a correctly-prefixed slug (the guard is not over-strict)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const won = doAcquire(dir, '869-UI-x', { slug: '869-UI-x', 'lock-only': true });
    assert.equal(won.won, true);
    assert.equal(won.planId, '869');
  } finally {
    cleanup();
  }
});

test('F-004 (plan 1313): doAcquire REJECTS an apostrophe in --slug BEFORE acquiring the ref (PowerShell-injection charset)', () => {
  const { dir, lsClaims, cleanup } = makeBareOrigin();
  try {
    assert.throws(
      () => doAcquire(dir, '869-UI-x', { slug: "869-UI-rec's-fix", 'lock-only': true }),
      /--slug/,
    );
    assert.doesNotMatch(lsClaims(), /refs\/claims\/869/, 'no ref leaked — the guard ran first');
  } finally {
    cleanup();
  }
});

test('F-004 (plan 1313): doAcquire REJECTS a non-ASCII/space slug too', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.throws(
      () => doAcquire(dir, '869-UI-x', { slug: '869-UI-öäå plan', 'lock-only': true }),
      /--slug/,
    );
  } finally {
    cleanup();
  }
});

test('mintSessionNumber: picks up an existing counter value from origin', () => {
  const { dir, origin, cleanup } = makeBareOrigin();
  const { dir: dir2, cleanup: cleanup2 } = (() => {
    // a SECOND clone of the same origin sees the same counter
    const d = mkdtempSync(join(tmpdir(), 'claim-work2-'));
    const g = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'master');
    g('config', 'user.email', 't@t.t');
    g('config', 'user.name', 'T');
    g('config', 'commit.gpgsign', 'false');
    g('remote', 'add', 'origin', origin);
    return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) };
  })();
  try {
    assert.equal(mintSessionNumber(dir), 1);
    assert.equal(mintSessionNumber(dir), 2);
    // the other clone continues the same global sequence, not its own
    assert.equal(mintSessionNumber(dir2), 3);
  } finally {
    cleanup();
    cleanup2();
  }
});

// --- plan 446: activePathFor resolves ready/ + waiting-*/ (resume support) ----

// Track a plan file at docs/superpowers/plans/<folder>/<basename> in `dir`'s index
// so `git ls-files` (which activePathFor reads) sees it. Returns the forward-slash
// rel path (git's output form) for direct assertion. Optional `fmLines` prepends a
// frontmatter block (the plan-1627 execModel tests need stage/specReview/execModel
// to clear Gate 2; hoisting lets earlier tests call this).
function seedPlan(dir, folder, basename, fmLines) {
  const rel = `docs/superpowers/plans/${folder}/${basename}`;
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  const body = fmLines
    ? ['---', ...fmLines, '---', '', `# ${basename}`, ''].join('\n')
    : `# ${basename}\n\n**Status:** READY\n`;
  writeFileSync(abs, body);
  execFileSync('git', ['-C', dir, 'add', '--', rel], { encoding: 'utf8' });
  return rel;
}

// plan 2395: seedPlan only STAGES a file in `dir`'s own index/working tree — enough for the
// OLD `git ls-files`-based activePathFor, but not for Gate-2's origin/master-based
// resolution, which needs the plan actually committed AND pushed. Wraps seedPlan with
// exactly that for the doAcquire Gate-2 tests below.
function seedPlanOnOrigin(dir, folder, basename, fmLines) {
  const rel = seedPlan(dir, folder, basename, fmLines);
  execFileSync('git', ['-C', dir, 'commit', '-qm', `seed ${basename}`], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master'], { encoding: 'utf8' });
  return rel;
}

test('activePathFor: finds a plan in ready/', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const rel = seedPlan(dir, 'ready', '450-Other-x.md');
    assert.equal(activePathFor(dir, '450'), rel);
  } finally {
    cleanup();
  }
});

test('activePathFor: finds a plan in pending-approval/ (plan 1371 default mint target — claimable)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const rel = seedPlan(dir, 'pending-approval', '455-Infra-draft.md');
    assert.equal(activePathFor(dir, '455'), rel);
  } finally {
    cleanup();
  }
});

// plan 1371 (D5): drafting/ is retired from the taxonomy WHOLE, so it must no longer be
// claimable — a plan somehow still sitting there (it never legitimately will again; no
// mint targets it) must NOT be picked up as if it were a normal resting state.
// --- plan 2678: category subfolders --------------------------------------------
// A git pathspec glob crosses `/` only when a `*` PRECEDES the literal, so the old
// `<folder>/<id>-*.md` pathspec matched FLAT files only: a plan clumped into a category
// subfolder was unclaimable — `acquire`/`pickup-plan` died on noClaimableFileError while
// the origin-store resolver (`git ls-tree -r` + basename match) found it fine.
test('activePathFor: finds a plan inside a category subfolder (plan 2678)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const rel = seedPlan(dir, 'ready/infra', '457-Infra-nested.md');
    assert.equal(activePathFor(dir, '457'), rel);
  } finally {
    cleanup();
  }
});

// The basename match uses the shared idClaimPattern, so a longer id whose leading digits
// merely READ as the requested one is not a hit — the plan-1002 collision class, which
// the old `<id>-*` pathspec also happened to avoid and must keep avoiding.
test('activePathFor: an id does not match a longer id sharing its digit prefix', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'ready', '4580-Infra-longer.md');
    assert.throws(() => activePathFor(dir, '458'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

test('activePathFor: does NOT find a plan in drafting/ (retired by plan 1371)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'drafting', '456-Infra-orphan.md');
    assert.throws(() => activePathFor(dir, '456'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

test('activePathFor: finds a plan parked in waiting-operator/ (resume support)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const rel = seedPlan(dir, 'waiting-operator', '451-DQ-y.md');
    assert.equal(activePathFor(dir, '451'), rel);
  } finally {
    cleanup();
  }
});

test('activePathFor: ready/ wins precedence over a waiting-*/ copy of the same id', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const readyRel = seedPlan(dir, 'ready', '452-x.md');
    seedPlan(dir, 'waiting-date', '452-x.md');
    assert.equal(activePathFor(dir, '452'), readyRel);
  } finally {
    cleanup();
  }
});

test('activePathFor: a plan only in in-progress/ is NOT claimable (throws)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'in-progress', '453-x.md');
    assert.throws(() => activePathFor(dir, '453'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

test('activePathFor: a plan only in archive/ is NOT claimable (throws)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'archive', '454-x.md');
    assert.throws(() => activePathFor(dir, '454'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

// plan 1426: parked/ is a recognized-but-EXCLUDED status folder — a deliberate
// long-term freeze, never claimable. CLAIMABLE_FOLDERS is derived from STATUS_ORDER
// (build-index-lib.mjs), which deliberately never lists `parked`, so this is really a
// regression pin on that omission — mirrors the archive/ test above.
test('activePathFor: a plan only in parked/ is NOT claimable (throws)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'parked', '457-x.md');
    assert.throws(() => activePathFor(dir, '457'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

// ───────────────────── plan 2353: `--resume` takeover resolution ─────────────
// The default in-progress/ refusal above is load-bearing (only an explicit --resume may
// take over a dead holder's plan), so these pin the OPT-IN half: resolution widens, and
// the refusal message points at the flag instead of dead-ending.

test('plan 2353: activePathFor with includeInProgress FINDS a plan only in in-progress/', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'in-progress', '2353-x.md');
    assert.equal(
      activePathFor(dir, '2353', { includeInProgress: true }),
      'docs/superpowers/plans/in-progress/2353-x.md',
    );
  } finally {
    cleanup();
  }
});

test('plan 2353: in-progress/ is searched LAST — a ready/ copy still wins (a resume degrades to a fresh claim)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'in-progress', '2353-x.md');
    seedPlan(dir, 'ready', '2353-x.md');
    assert.equal(
      activePathFor(dir, '2353', { includeInProgress: true }),
      'docs/superpowers/plans/ready/2353-x.md',
    );
  } finally {
    cleanup();
  }
});

test('plan 2353: the default refusal POINTS AT --resume (the takeover dead-end this plan fixes)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    seedPlan(dir, 'in-progress', '2353-x.md');
    assert.throws(() => activePathFor(dir, '2353'), /acquire --resume/);
    // …and the opt-in path's own failure message must NOT dangle the flag hint at a caller
    // that already passed it.
    assert.throws(
      () => activePathFor(dir, '999', { includeInProgress: true }),
      (e) => /in-progress\//.test(e.message) && !/acquire --resume/.test(e.message),
    );
  } finally {
    cleanup();
  }
});

test('activePathFor: throws for an unknown plan id', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    assert.throws(() => activePathFor(dir, '999'), /no claimable plan file/);
  } finally {
    cleanup();
  }
});

// ───────────────────── plan 868: no residue survives a failed acquire ─────────
// Reproduces the session-818 incident: a foreign uncommitted edit in the SHARED main
// checkout blocked the projection AFTER move-plan had pushed, stranding a half-claim and
// wedging every parallel session's coordWrite. The fix: a pre-move dirt guard + a
// rollback that leaves NO orphaned plan-body dirt / committed half-claim.

// A bare origin + a working clone with a committed ready/ (or in-progress/) plan whose
// basename carries an UPPERCASE category tag (so the board "Plan / claim" cell passes the
// board lint) and a real **Status:** line (so flipStatusToInProgress / the revert round-trip).
function makeRepoWithPlan({
  folder = 'ready',
  basename = '050-Infra-foo.md',
  foreign = false,
  full = false,
  // plan 1427 Gate 2: override the default `full` frontmatter/body wholesale — used by
  // the stub-claim-gate tests, which need a `stage`/`specReview` combination the
  // default `full` block (always stage:specced + a real specReview sha) can't express.
  frontmatterLines = null,
  bodyExtra = '',
  // plan 1427 Gate 2: force seedLane ON (coord.config.json's derived seedLane is
  // false with no config file at all) so a test can exercise the 🟥/🟩 SEED-WRITE
  // banner distinction without needing the whole `full` board/INDEX scaffold.
  seedLane = false,
} = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'claim-resid-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), 'claim-resid-work-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  g('remote', 'add', 'origin', origin);
  const planRel = `docs/superpowers/plans/${folder}/${basename}`;
  const planAbs = join(dir, ...planRel.split('/'));
  mkdirSync(dirname(planAbs), { recursive: true });
  writeFileSync(
    planAbs,
    [
      // plan 989: `full` repos give the plan a summary frontmatter so the regenerated INDEX bullet
      // has a blurb (the atomic projection regenerates the whole plans block from frontmatter).
      // plan 1427 Gate 2: also stamp a specReview sha so these projection-mechanics tests (not
      // about the stub-claim gate) pass it without needing --stub-ok. `frontmatterLines`
      // overrides this wholesale for the Gate-2 tests below.
      ...(frontmatterLines
        ? ['---', ...frontmatterLines, '---', '']
        : full
          ? ['---', 'summary: "Foo plan"', 'stage: specced', 'specReview: abc1234', '---', '']
          : []),
      '# ' + basename,
      '',
      '**Status:** 📋 READY — opened 2026-06-20.',
      '',
      'Body.',
      bodyExtra,
      '',
    ].join('\n'),
  );
  if (foreign) writeFileSync(join(dir, 'foreign.md'), 'original\n');
  if (seedLane && !full) {
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({
        seedShardDir: 'backend/src/data/seed',
        // plan 4071 D3: doAcquire's checkStubClaimGate call takes cfg.land.specReviewGatedFields
        // rather than an implicit literal, so a Gate-1 fixture must stamp this itself.
        land: { specReviewGatedFields: PIPELINE_FIELDS },
      }),
    );
  }
  if (full) {
    // plan 989: a production-faithful repo so the ATOMIC projection (flip + mv + INDEX + board +
    // session entry, ONE commit) has everything it touches: a sessions-layout coord.config, an
    // INDEX with the splice sentinels, a board with the row sentinels, and the sessions dir.
    writeFileSync(
      join(dir, 'coord.config.json'),
      JSON.stringify({ handoffDir: 'docs/handoff', handoffLayout: 'sessions' }),
    );
    writeFileSync(
      join(dir, 'docs', 'INDEX.md'),
      [
        '# Index',
        '',
        INDEX_SPECS_START,
        '',
        INDEX_SPECS_END,
        '',
        '## Plans',
        '',
        INDEX_PLANS_START,
        '',
        INDEX_PLANS_END,
        '',
      ].join('\n'),
    );
    const boardAbs = join(dir, 'docs', 'handoff', 'board.md');
    mkdirSync(dirname(boardAbs), { recursive: true });
    writeFileSync(
      boardAbs,
      [
        '# Board',
        '<!-- BOARD-START -->',
        '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
        '|---|---|---|---|---|---|',
        '<!-- BOARD-END -->',
        '',
      ].join('\n'),
    );
    mkdirSync(join(dir, 'docs', 'handoff', 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'handoff', 'sessions', '.gitkeep'), '');
  }
  g('add', '-A');
  g('commit', '-qm', 'seed plan');
  g('push', '-q', 'origin', 'master');
  return {
    dir,
    g,
    planRel,
    planAbs,
    // plan 4087 T4-A: the bare origin path, for tests that need to install a pre-receive
    // hook on it (a rejected-push fixture) — not previously exposed here.
    origin,
    // plan 3756: sweeps BOTH claim namespaces, so a test asserting "the claim ref exists"
    // keeps meaning that regardless of which namespace the spine is writing to.
    lsClaims: () => g('ls-remote', origin, ...CLAIM_GLOBS),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

test('doAcquire: projects the WHOLE claim as ONE atomic commit on origin (plan 989 — no orphan window)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H' });
    assert.equal(res.won, true);
    assert.equal(res.projected, true);
    assert.match(r.lsClaims(), claimRx('050'), 'the claim ref is held');
    r.g('fetch', '-q', 'origin', 'master');
    // (a) the plan MOVED to in-progress/ on origin (ready/ gone)
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /in-progress\/050-Infra-foo\.md/, 'plan landed in in-progress/');
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md/, 'plan no longer in ready/');
    // (b) the board ACTIVE row, the repathed INDEX bullet, and the session entry ALL landed —
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.match(board, /050-Infra-foo/);
    assert.match(board, /🔄 ACTIVE/);
    assert.match(r.g('show', 'origin/master:docs/INDEX.md'), /in-progress\/050-Infra-foo\.md/);
    assert.match(tree, /docs\/handoff\/sessions\/.*session-\d/, 'session entry written');
    // (c) … in ONE commit (atomic — the half-pushed orphan window is gone)
    const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
    assert.match(subjects[0], /chore\(claim\): project 050-Infra-foo/);
    assert.equal(
      subjects.filter((s) => /project 050-Infra-foo/.test(s)).length,
      1,
      'exactly one projection commit — flip+move+board+index+session are atomic',
    );
    // the plan body Status was flipped in that commit
    assert.match(
      r.g('show', 'origin/master:docs/superpowers/plans/in-progress/050-Infra-foo.md'),
      /🔄 IN PROGRESS/,
    );
  } finally {
    r.cleanup();
  }
});

// plan 4087 T4-A: the 2026-09-06 ledger incident
// (claim-plan-acquire-reports-projected-true-after-rejected-master-push). The spec-pass
// established the bug is NOT in coordLandCommit (which asserts push-reached-origin) but on
// projectClaim's OWN master push inside runClaimProjectionRetryLoop, which has no such
// verification — it only trusts `git push`'s exit code. This reproduces with a REAL rejected
// push (a bare-origin pre-receive hook that permanently declines refs/heads/master, distinct
// from a self-healing non-ff race the retry loop exists to survive) rather than a fake
// projectClaim, because a fake that merely throws already proves nothing (see the adjacent
// "a throwing projectClaim RELEASES the just-won ref" test above) — the open question is
// whether the REAL projection path can ever return success after a push the remote refused.
// VERDICT (2026-09-22): DID NOT REPRODUCE. This test PASSES on the code it was written
// against — a rejected master push makes doAcquire throw, release the claim ref, and leave
// the plan in ready/. The ledger line is retired as ALREADY-FIXED and this test is kept as
// the standing proof. ONE SHAPE REMAINS UNTESTED and is deliberately not claimed as covered:
// a push whose transport reports SUCCESS while origin silently did not update. There is no
// injectable git seam reaching runClaimProjectionRetryLoop or withCoordCheckout, so it could
// not be constructed. If the real 2026-09-06 incident was that shape, this test does not
// rule it out; see plan 4087 S9.
test('plan 4087 T4-A: a REJECTED master push never reports projected:true (ledger line does NOT reproduce)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    // A pre-receive hook that unconditionally rejects any update to refs/heads/master —
    // simulating a permanently-rejected master push (branch protection / policy decline).
    // The claim-ref push (refs/heads/coord/claims/<id>) targets a different ref and is
    // untouched, so acquireRef still wins cleanly; only the projection's master push dies.
    const hooksDir = join(r.origin, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'pre-receive'),
      [
        '#!/bin/sh',
        'while read oldrev newrev refname; do',
        '  case "$refname" in',
        '    refs/heads/master) echo "rejected by policy" >&2; exit 1 ;;',
        '  esac',
        'done',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    let threw = null;
    let result;
    try {
      result = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H' });
    } catch (e) {
      threw = e;
    }
    // CORRECT behaviour, asserted so this test fails now (reproduction) and turns green once
    // the fix lands: doAcquire must never report a projection as landed when the remote
    // rejected the master push that was supposed to carry it.
    assert.ok(
      threw,
      `doAcquire must throw when the master projection push is rejected by the remote — ` +
        `instead it returned ${JSON.stringify(result)}`,
    );
    // The claim ref must be RELEASED on this failure path (doAcquire's own rollback
    // contract) — a leaked ref would strand the plan as claimed with no visible claim and
    // no projection to show for it. Under tombstone release (plan 3756) the ref still
    // EXISTS on origin (a raw ls-remote match is not the right check) — `readHolder` is the
    // seam that filters a tombstone out, so a null result here is what "released" means.
    assert.equal(readHolder(r.dir, '050'), null, 'a failed projection must release the claim ref');
    // The plan must still be in ready/ on origin — nothing landed.
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/050-Infra-foo\.md/, 'plan never moved on origin');
    assert.doesNotMatch(
      tree,
      /in-progress\/050-Infra-foo\.md/,
      'plan never landed in in-progress/',
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 2460 Phase 2: executor-provenance stamp threaded end-to-end ---------

test('doAcquire: --model-id/--dispatch-mode land in the board cell AND the session stub (Executor line right after Host)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      'model-id': 'claude-opus-5',
      'dispatch-mode': 'orchestrate-worker',
    });
    assert.equal(res.won, true);
    assert.equal(res.modelId, 'claude-opus-5');
    assert.equal(res.dispatchMode, 'orchestrate-worker');

    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.match(board, /exec=`orchestrate-worker` model=`claude-opus-5`/);

    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    const sessionFile = tree
      .split('\n')
      .find((p) => /docs\/handoff\/sessions\/.*session-\d/.test(p));
    const stub = r.g('show', `origin/master:${sessionFile}`);
    const lines = stub.split('\n');
    const hostIdx = lines.findIndex((l) => l.startsWith('**Host:**'));
    assert.ok(hostIdx >= 0, 'stub carries a Host line');
    assert.equal(
      lines[hostIdx + 1],
      '**Executor:** `orchestrate-worker` · model `claude-opus-5`',
      'the Executor line lands immediately after Host',
    );
  } finally {
    r.cleanup();
  }
});

test('doAcquire: omitting --model-id/--dispatch-mode still stamps an explicit interactive/unlabeled arm', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H' });
    assert.equal(res.modelId, 'unlabeled');
    assert.equal(res.dispatchMode, 'interactive');
    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.match(board, /exec=`interactive` model=`unlabeled`/);
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    const sessionFile = tree
      .split('\n')
      .find((p) => /docs\/handoff\/sessions\/.*session-\d/.test(p));
    const stub = r.g('show', `origin/master:${sessionFile}`);
    assert.match(stub, /\*\*Executor:\*\* `interactive` · model `unlabeled`/);
  } finally {
    r.cleanup();
  }
});

test('doAcquire: an invalid --dispatch-mode throws BEFORE any ref is acquired (fail-fast)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          host: 'H',
          'dispatch-mode': 'typo-mode',
        }),
      /invalid --dispatch-mode/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref was left held after the throw');
  } finally {
    r.cleanup();
  }
});

// plan 2844 Task 1: `--date` used to be taken verbatim and concatenated into the
// session-entry filename — a malformed value minted a name rankSessionFiles cannot order.
test('doAcquire: a malformed --date (non-ISO shape) throws BEFORE any ref is acquired (fail-fast)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          host: 'H',
          date: '20260804',
        }),
      /--date "20260804" must be YYYY-MM-DD/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref was left held after the throw');
  } finally {
    r.cleanup();
  }
});

// plan 2844 review [6dd84a]/[d69c41]/[0c6427]: the shapes a TYPO actually produces. parseFlags
// sets the `date` key with `undefined` when the flag runs off the end of argv, and with `''` for
// `--date=`; the original `flags.date || <today>` fallback swallowed both into today's date, so
// the validator above never saw them and a malformed request silently succeeded against the
// wrong date. Absent-vs-present-but-valueless is `'date' in flags`, never falsiness.
for (const [label, date] of [
  ['valueless (--date at end of argv)', undefined],
  ['explicitly empty (--date=)', ''],
]) {
  test(`doAcquire: a ${label} --date is REFUSED, not defaulted to today`, () => {
    const r = makeRepoWithPlan({ full: true });
    try {
      assert.throws(
        () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H', date }),
        /must be YYYY-MM-DD/,
      );
      assert.doesNotMatch(r.lsClaims(), claimRx('050'), 'no ref was left held after the throw');
    } finally {
      r.cleanup();
    }
  });
}

test('doAcquire: an ABSENT --date still falls back to today (the plan-2844 Task 1 carve-out)', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H' });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /docs\/handoff\/sessions\/\d{4}-\d{2}-\d{2}-session-\d+\.md/);
  } finally {
    r.cleanup();
  }
});

test('doAcquire: a well-formed --date is accepted and used verbatim for the session entry', () => {
  const r = makeRepoWithPlan({ full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      date: '2026-08-04',
    });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /docs\/handoff\/sessions\/2026-08-04-session-\d+\.md/);
  } finally {
    r.cleanup();
  }
});

// --- plan 2353: `acquire --resume` projects a TAKEOVER ------------------------
// The gap this closes: before --resume, `acquire` on an in-progress plan won the ref-CAS and
// then rolled it back (unresolvable path), so a takeover's only route was `--lock-only` + a
// hand-rolled projection — and the session-entry file it must create has NO sanctioned writer
// (coord-edit refuses untracked paths; the plan-1279 pre-commit guard blocks a hand commit).

test('plan 2353: acquire --resume projects an in-progress plan WITHOUT moving it (board + session entry + takeover note, ONE commit)', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      resume: true,
    });
    assert.equal(res.won, true);
    assert.equal(res.projected, true);
    assert.equal(res.resumed, true, 'the projection reports it took the resume path');
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    // (a) the plan STAYED in in-progress/ — no move, and critically no `git mv x x` crash
    assert.match(tree, /in-progress\/050-Infra-foo\.md/, 'plan still in in-progress/');
    // (b) the session-entry stub — the ONE artifact a takeover previously could not write
    assert.match(tree, /docs\/handoff\/sessions\/.*session-\d/, 'session entry written');
    // (c) board ACTIVE row + a Status carrying the takeover audit line
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.match(board, /050-Infra-foo/);
    assert.match(board, /🔄 ACTIVE/);
    const body = r.g('show', 'origin/master:docs/superpowers/plans/in-progress/050-Infra-foo.md');
    assert.match(body, /🔄 IN PROGRESS/);
    assert.match(body, /\*\*Takeover:\*\*/, 'the takeover is recorded in the plan body');
    assert.match(body, /acquire --resume/);
    // (d) still exactly ONE projection commit — atomicity is not weakened by the resume path
    const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
    assert.equal(subjects.filter((s) => /project 050-Infra-foo/.test(s)).length, 1);
  } finally {
    r.cleanup();
  }
});

test('plan 2353: --resume on a plan genuinely still in ready/ degrades to an ordinary fresh claim (moves it, resumed:false)', () => {
  // The mv-skip is derived from where the file RESOLVES, not from the flag — so passing
  // --resume when no takeover is happening must not silently skip a move that was needed.
  const r = makeRepoWithPlan({ folder: 'ready', full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      resume: true,
    });
    assert.equal(res.resumed, false, 'not a takeover — the plan was in ready/');
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /in-progress\/050-Infra-foo\.md/, 'the move still happened');
    assert.doesNotMatch(tree, /ready\/050-Infra-foo\.md/);
    const body = r.g('show', 'origin/master:docs/superpowers/plans/in-progress/050-Infra-foo.md');
    assert.doesNotMatch(body, /\*\*Takeover:\*\*/, 'no takeover note on a fresh claim');
  } finally {
    r.cleanup();
  }
});

test('plan 2353: --resume + --lock-only is REFUSED before the ref is acquired (contradictory intent, no leak)', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          resume: true,
          'lock-only': true,
        }),
      /mutually exclusive/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

// The board row whose SLUG COLUMN (cell 0) is `slug`. Not a substring scan: once a takeover
// demotes a row, that row's Resume cell NAMES the superseding slug, so `includes(newSlug)`
// finds the demoted row first — the same column-vs-substring trap board-lib's landingRows
// documents.
function boardRowFor(board, slug) {
  return board.split('\n').find((l) => l.trim().startsWith(`| ${slug} |`));
}

// plan 2394 UPDATED this test. It previously pinned the plan-2353 print-only behaviour
// deliberately ("REPORTS the dead holder's row and leaves it in place"); the whole point of
// 2394 is that an unattended caller cannot act on a printed hint, so the row is now demoted
// inside the same projection commit. The 2353 invariant that survives verbatim: the ROW stays
// on the board (it is not removed/renamed away) so the old worktree survives its own teardown.
test('plan 2394: a takeover under a NEW slug DEMOTES the dead holder’s row to ⏸ PAUSED in the same projection commit', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    // Seed the dead holder's row under a DIFFERENT slug for the same plan id.
    const boardRel = 'docs/handoff/board.md';
    const boardAbs = join(r.dir, ...boardRel.split('/'));
    writeFileSync(
      boardAbs,
      readFileSync(boardAbs, 'utf8').replace(
        '<!-- BOARD-END -->',
        '| 050-Infra-foo-oldslug | `PENDING` | 🔄 ACTIVE | `in-progress/050-Infra-foo.md` · session 1 · host=`DEAD` | 2026-07-24 02:30 | — |\n<!-- BOARD-END -->',
      ),
    );
    r.g('add', '-A');
    r.g('commit', '-qm', 'dead holder row');
    r.g('push', '-q', 'origin', 'master');

    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo-newslug',
      host: 'H',
      resume: true,
    });
    assert.equal(res.resumed, true);
    assert.deepEqual(
      res.demotedRowSlugs,
      ['050-Infra-foo-oldslug'],
      'the differently-slugged row was retired by the tool, not left for a human',
    );
    assert.deepEqual(res.keptRows, [], 'nothing was exempt here');
    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    // BOTH rows present: the old one survives on purpose (its worktree must survive teardown).
    assert.match(board, /050-Infra-foo-oldslug/, 'old row left in place, not renamed away');
    assert.match(board, /050-Infra-foo-newslug/, 'the takeover row was added');
    // …but the old one is no longer a second 🔄 ACTIVE row — that double-claim reading is the
    // whole point of the plan.
    const oldRow = boardRowFor(board, '050-Infra-foo-oldslug');
    assert.match(oldRow, /⏸ PAUSED/, 'the dead holder’s row is demoted');
    assert.match(
      oldRow,
      /superseded by `050-Infra-foo-newslug` \(takeover \d{4}-\d{2}-\d{2}\)/,
      'the Resume cell records WHO superseded it (lineage the printed note used to carry)',
    );
    assert.match(
      oldRow,
      /`in-progress\/050-Infra-foo\.md`/,
      'the demoted row keeps its plan pointer — the plan did not move, and rewriting the cell risks lint-board poison',
    );
    const newRow = boardRowFor(board, '050-Infra-foo-newslug');
    assert.match(newRow, /🔄 ACTIVE/, 'exactly one ACTIVE row for the plan id — ours');
    // ONE commit: the demotion rides in the claim projection, never a second push.
    const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
    assert.equal(
      subjects.filter((s) => /project 050-Infra-foo-newslug/.test(s)).length,
      1,
      'exactly one projection commit — the demote is folded into it, not pushed separately',
    );
    assert.equal(
      subjects.filter((s) => /^chore\(handoff\)/.test(s)).length,
      0,
      'no separate board.mjs write was made',
    );
    // Review finding [0]: the session entry's **Plan:** pointer must name the plan's REAL
    // on-disk basename, never `<slug>.md`. A takeover is where this bites — the new session
    // picks its own slug (that is why staleRowSlugs exists at all), so a slug-derived pointer
    // links to a file that does not exist, in the one artifact plan 2353 exists to make
    // writable. Every other pointer in this same claim already resolved realBasename.
    const entryRel = r
      .g('show', '--stat', '--name-only', '--format=', 'origin/master')
      .split('\n')
      .map((s) => s.trim())
      .find((s) => /^docs\/handoff\/sessions\/.*\.md$/.test(s));
    assert.ok(entryRel, 'a session entry was written by the takeover');
    const entry = r.g('show', `origin/master:${entryRel}`);
    assert.match(
      entry,
      /\*\*Plan:\*\* `docs\/superpowers\/plans\/in-progress\/050-Infra-foo\.md`/,
      'the **Plan:** pointer names the real basename',
    );
    assert.doesNotMatch(
      entry,
      /in-progress\/050-Infra-foo-newslug\.md/,
      'never the slug-derived path — that file does not exist',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2353: a same-slug takeover demotes nothing (its own row is upserted, not retired)', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      resume: true,
    });
    assert.equal(res.resumed, true);
    assert.deepEqual(res.demotedRowSlugs, []);
    assert.deepEqual(res.keptRows, []);
  } finally {
    r.cleanup();
  }
});

// ───────── plan 2394: which same-plan-id rows a takeover may retire ─────────
// A second row for one plan id is not always stale. The spec-pass ruled option 1: spare rows
// carrying the `batch=` marker. The 🟢 LANDING carve-out is the same fail-safe applied to the
// other class of provably-live row (that row IS the cross-session land mutex).

// Board rows for plan 050 in the shapes classifyTakeoverRows must tell apart.
const ROW_2394 = {
  dead: '| 050-Infra-foo-oldslug | `PENDING` | 🔄 ACTIVE | `in-progress/050-Infra-foo.md` · session 1 · host=`DEAD` · 🟩 | 2026-07-24 02:30 | — |',
  batch:
    '| 050-Infra-foo-member | `PENDING` | 🔄 ACTIVE | `in-progress/050-Infra-foo.md` · session 2 · host=`H` · 🟩 · batch=`batch-2026-07-25-coord` | 2026-07-25 09:00 | — |',
  landing:
    '| 050-Infra-foo-landing | `abc1234` | 🟢 LANDING | `in-progress/050-Infra-foo.md` · session 3 · host=`H` · 🟩 | 2026-07-25 09:00 | — |',
  other:
    '| 999-Other-unrelated | `PENDING` | 🔄 ACTIVE | `in-progress/999-Other-unrelated.md` · session 4 · host=`H` · 🟩 | 2026-07-25 09:00 | — |',
};

function boardWithRows(rows) {
  return [
    '# Board',
    '<!-- BOARD-START -->',
    '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
    '|---|---|---|---|---|---|',
    ...rows,
    '<!-- BOARD-END -->',
    '',
  ].join('\n');
}

test('plan 2394: classifyTakeoverRows demotes a plain stale row, SPARES a batch member and a LANDING row, ignores other plans', () => {
  const board = boardWithRows([ROW_2394.dead, ROW_2394.batch, ROW_2394.landing, ROW_2394.other]);
  assert.deepEqual(classifyTakeoverRows(board, { planId: '050', slug: '050-Infra-foo-newslug' }), {
    demote: ['050-Infra-foo-oldslug'],
    kept: [
      { slug: '050-Infra-foo-landing', reason: 'landing' },
      { slug: '050-Infra-foo-member', reason: 'batch-member' },
    ],
  });
});

test('plan 2394: classifyTakeoverRows never demotes OUR OWN row (it is upserted, not retired)', () => {
  const board = boardWithRows([ROW_2394.dead]);
  assert.deepEqual(classifyTakeoverRows(board, { planId: '050', slug: '050-Infra-foo-oldslug' }), {
    demote: [],
    kept: [],
  });
});

test('plan 2394: classifyTakeoverRows is fail-closed on an unparseable board (demotes nothing)', () => {
  assert.deepEqual(classifyTakeoverRows('not a board', { planId: '050', slug: 'x' }), {
    demote: [],
    kept: [],
  });
});

test('plan 2394: takeoverSupersededResume records the superseding slug and the takeover date', () => {
  assert.equal(
    takeoverSupersededResume('050-Infra-foo-newslug', '2026-07-26'),
    'superseded by `050-Infra-foo-newslug` (takeover 2026-07-26)',
  );
});

// plan 2512: classifyTakeoverRowsLines is the Lines-level core applyMutations now calls
// directly (threading the ONE line array it already split, instead of re-parsing board
// content); classifyTakeoverRows became a thin fail-closed wrapper over it. Pin that the two
// stay in lockstep on the SAME fixture the 2394 demote/spare tests above use.
test('plan 2512: classifyTakeoverRowsLines agrees with classifyTakeoverRows on the same board (content-wrapper is a pure projection)', () => {
  const board = boardWithRows([ROW_2394.dead, ROW_2394.batch, ROW_2394.landing, ROW_2394.other]);
  const viaContent = classifyTakeoverRows(board, { planId: '050', slug: '050-Infra-foo-newslug' });
  const viaLines = classifyTakeoverRowsLines(splitBoard(board).body.split('\n'), {
    planId: '050',
    slug: '050-Infra-foo-newslug',
  });
  assert.deepEqual(viaLines, viaContent);
  assert.deepEqual(viaContent, {
    demote: ['050-Infra-foo-oldslug'],
    kept: [
      { slug: '050-Infra-foo-landing', reason: 'landing' },
      { slug: '050-Infra-foo-member', reason: 'batch-member' },
    ],
  });
});

test('plan 2512: classifyTakeoverRows stays fail-closed on an unparseable board even though it now delegates to classifyTakeoverRowsLines', () => {
  assert.deepEqual(classifyTakeoverRows('not a board', { planId: '050', slug: 'x' }), {
    demote: [],
    kept: [],
  });
  // classifyTakeoverRowsLines itself has no content to fail on — an empty/garbage line array
  // simply matches no rows (planIdRowMatcher requires digit-only ids; '050' is digits, so this
  // exercises the "no rows found" branch, not a thrown error).
  assert.deepEqual(classifyTakeoverRowsLines([], { planId: '050', slug: 'x' }), {
    demote: [],
    kept: [],
  });
});

// The MANDATORY verification from the plan body: a LIVE batch-member row must survive a
// takeover untouched. Demoting it would pause live work and silently detach the member from a
// running batch train — the hazard that made this plan non-trivial.
test('plan 2394: a LIVE batch-member row for the same plan id is NOT demoted by a takeover (end-to-end)', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    const boardAbs = join(r.dir, 'docs', 'handoff', 'board.md');
    writeFileSync(
      boardAbs,
      readFileSync(boardAbs, 'utf8').replace(
        '<!-- BOARD-END -->',
        `${ROW_2394.dead}\n${ROW_2394.batch}\n<!-- BOARD-END -->`,
      ),
    );
    r.g('add', '-A');
    r.g('commit', '-qm', 'dead holder row + live batch member row');
    r.g('push', '-q', 'origin', 'master');

    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo-newslug',
      host: 'H',
      resume: true,
    });
    assert.deepEqual(res.demotedRowSlugs, ['050-Infra-foo-oldslug']);
    assert.deepEqual(res.keptRows, [{ slug: '050-Infra-foo-member', reason: 'batch-member' }]);

    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    const memberRow = boardRowFor(board, '050-Infra-foo-member');
    assert.equal(
      memberRow.trim(),
      ROW_2394.batch,
      'the batch member row is byte-identical — state, resume cell and all',
    );
    assert.match(
      boardRowFor(board, '050-Infra-foo-oldslug'),
      /⏸ PAUSED/,
      'the non-batch stale row WAS demoted in the same pass (the spare is targeted, not a blanket skip)',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2394: a 🟢 LANDING row for the same plan id is NOT demoted (that row is the land mutex)', () => {
  const r = makeRepoWithPlan({ folder: 'in-progress', full: true });
  try {
    const boardAbs = join(r.dir, 'docs', 'handoff', 'board.md');
    writeFileSync(
      boardAbs,
      readFileSync(boardAbs, 'utf8').replace(
        '<!-- BOARD-END -->',
        `${ROW_2394.landing}\n<!-- BOARD-END -->`,
      ),
    );
    r.g('add', '-A');
    r.g('commit', '-qm', 'mid-land row');
    r.g('push', '-q', 'origin', 'master');

    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo-newslug',
      host: 'H',
      resume: true,
    });
    assert.deepEqual(res.demotedRowSlugs, []);
    assert.deepEqual(res.keptRows, [{ slug: '050-Infra-foo-landing', reason: 'landing' }]);

    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.equal(
      boardRowFor(board, '050-Infra-foo-landing').trim(),
      ROW_2394.landing,
      'the mid-land row survives byte-identical — dropping 🟢 LANDING would free the mutex a sibling shard preflight reads',
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 1427 Gate 2: claim-time stub gate ----------------------------------

test('Gate 2: single acquire of a stub plan (no specReview) is REFUSED before the ref is acquired', () => {
  const r = makeRepoWithPlan({ frontmatterLines: ['stage: stub'] });
  try {
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /stage "stub" with no specReview/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('Gate 2: a stub plan with no stage at all (absent) is treated the same as stub and REFUSED', () => {
  const r = makeRepoWithPlan(); // no frontmatter at all — stage absent, specReview absent
  try {
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /stage "\(absent\)" with no specReview/,
    );
  } finally {
    r.cleanup();
  }
});

test('Gate 2: --stub-ok "<note>" WINS over the stub refusal and the Override note lands in the projected body', () => {
  const r = makeRepoWithPlan({ full: true, frontmatterLines: ['stage: stub'] });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      'stub-ok': 'operator green-lit this stub 2026-07-05',
    });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    const projected = r.g(
      'show',
      'origin/master:docs/superpowers/plans/in-progress/050-Infra-foo.md',
    );
    assert.match(projected, /\*\*Override:\*\* claimed via `--stub-ok`/);
    assert.match(projected, /operator green-lit this stub 2026-07-05/);
  } finally {
    r.cleanup();
  }
});

test('Gate 2: an empty --stub-ok note is rejected (must be a real authorization, not just present)', () => {
  const r = makeRepoWithPlan({ frontmatterLines: ['stage: stub'] });
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          'lock-only': true,
          'stub-ok': '   ',
        }),
      /--stub-ok.*non-empty/,
    );
  } finally {
    r.cleanup();
  }
});

// plan 1427 review F3: the shared coord-git parseArgs greedily consumes the NEXT argv
// token as `--stub-ok`'s value, so `--stub-ok --seed-write yes` binds
// stubOk="--seed-write" (non-empty — the check above alone would accept it) while
// swallowing --seed-write's own value. Reject a flag-shaped value explicitly.
test('Gate 2: --stub-ok swallowing a following flag (a value starting with "-") is rejected (F3)', () => {
  const r = makeRepoWithPlan({ frontmatterLines: ['stage: stub'] });
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          'lock-only': true,
          'stub-ok': '--seed-write',
        }),
      /--stub-ok requires a non-flag authorization note/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('Gate 2: a stub WITH a real specReview sha PASSES (gate keys on specReview presence, stage is advisory)', () => {
  const r = makeRepoWithPlan({ frontmatterLines: ['stage: stub', 'specReview: 9f8e7d6'] });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Gate 2: specReview: exempt-mechanical on a 🟩 (non-seed-write) plan PASSES', () => {
  const r = makeRepoWithPlan({
    frontmatterLines: ['stage: stub', 'specReview: exempt-mechanical'],
    bodyExtra: sw('\n> 🟩 **SEED-WRITE: NO** — coord tooling only.\n'),
    seedLane: true,
  });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Gate 2: specReview: exempt-mechanical on a 🟥 plan mentioning a Gate-1 pipeline field (acceptsAcuteCases) is REFUSED', () => {
  const r = makeRepoWithPlan({
    frontmatterLines: ['stage: stub', 'specReview: exempt-mechanical'],
    bodyExtra: sw(
      '\n> 🟥 **SEED-WRITE: YES** — flips acceptsAcuteCases.\n\nDemotes acceptsAcuteCases on rec-1097.\n',
    ),
    seedLane: true,
  });
  try {
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /exempt-mechanical.*cannot cover/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked');
  } finally {
    r.cleanup();
  }
});

test('Gate 2: specReview: exempt-mechanical on a 🟥 plan NOT mentioning any Gate-1 field PASSES', () => {
  const r = makeRepoWithPlan({
    frontmatterLines: ['stage: stub', 'specReview: exempt-mechanical'],
    bodyExtra: sw('\n> 🟥 **SEED-WRITE: YES** — adds a new record shard.\n'),
    seedLane: true,
  });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

// --- plan 3943: a stamp of unknown provenance cannot be drained ----------------------

test('Gate 2 (3943): specReview set with specReviewBy: undeclared is REFUSED — provenance of unknown quality', () => {
  const r = makeRepoWithPlan({
    frontmatterLines: ['stage: specced', 'specReview: 9f8e7d6', 'specReviewBy: undeclared'],
  });
  try {
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /specReviewBy: undeclared/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('Gate 2 (3943): --stub-ok "<note>" WINS over the specReviewBy: undeclared refusal', () => {
  const r = makeRepoWithPlan({
    full: true,
    frontmatterLines: ['stage: specced', 'specReview: 9f8e7d6', 'specReviewBy: undeclared'],
  });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      'stub-ok': 'operator green-lit this undeclared provenance 2026-09-11',
    });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Gate 2 (3943): a real specReview sha with a DECLARED specReviewBy (or none at all — legacy/grandfathered) PASSES', () => {
  const declared = makeRepoWithPlan({
    frontmatterLines: ['stage: specced', 'specReview: 9f8e7d6', 'specReviewBy: fable-5.1/high'],
  });
  try {
    const res = doAcquire(declared.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      'lock-only': true,
    });
    assert.equal(res.won, true);
  } finally {
    declared.cleanup();
  }

  // no specReviewBy key at all (every plan stamped before plan 3004 introduced the
  // field) is a grandfathered legacy shape, not the "undeclared" provenance gap.
  const legacy = makeRepoWithPlan({
    frontmatterLines: ['stage: specced', 'specReview: 9f8e7d6'],
  });
  try {
    const res = doAcquire(legacy.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      'lock-only': true,
    });
    assert.equal(res.won, true);
  } finally {
    legacy.cleanup();
  }
});

test('doAcquire: foreign dirt in MAIN does NOT block a claim — it projects via the coord-checkout (plan 989)', () => {
  const r = makeRepoWithPlan({ foreign: true, full: true });
  try {
    // a sibling session left a tracked file uncommitted in the shared main checkout
    writeFileSync(join(r.dir, 'foreign.md'), 'original\nSIBLING UNCOMMITTED EDIT\n');
    // 989: the projection runs in the DISPOSABLE coord-checkout, so MAIN foreign dirt — or a
    // session's own uncommitted code — can no longer abort a claim (the old hard-stop is gone).
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', host: 'H' });
    assert.equal(res.won, true, 'the claim succeeds despite foreign dirt in MAIN');
    assert.match(r.lsClaims(), claimRx('050'));
    // the plan landed in in-progress/ on origin
    r.g('fetch', '-q', 'origin', 'master');
    assert.match(
      r.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /in-progress\/050-Infra-foo\.md/,
    );
    // the foreign edit in MAIN is UNTOUCHED — the projection never touched MAIN's working tree
    assert.equal(
      readFileSync(join(r.dir, 'foreign.md'), 'utf8'),
      'original\nSIBLING UNCOMMITTED EDIT\n',
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 2459 Task 2: runnable-batch hold gate (single-plan claim path) -----

// plan 4246 review fix (b35525): the solo gate reads the roster at the ORIGIN commit it resolved
// the plan against, so the fixture commits and pushes batch.md unless told not to (`push: false`
// leaves it on local disk only — the stale-local-roster cases below).
function writeBatchMdFixture(
  dir,
  slug,
  { members, gate = null, status = 'proposed', push = true },
) {
  const rel = `docs/superpowers/batches/${slug}/batch.md`;
  const abs = join(dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    [
      '---',
      `slug: ${slug}`,
      'lane: 🟩',
      `members: [${members.join(', ')}]`,
      `gate: ${gate == null ? 'null' : gate}`,
      `status: ${status}`,
      '---',
      '',
      `# ${slug}`,
      '',
      'Test batch.',
      '',
    ].join('\n'),
  );
  if (!push) return;
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('add', '--', rel);
  g('commit', '-qm', `batch ${slug}`, '--', rel);
  g('push', '-q', 'origin', 'master');
}

test('Batch-solo guard: single acquire of a runnable-batch member is REFUSED before the ref is acquired (plan 2459 Task 2)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['050'] });
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /member of runnable batch "batch-x"[\s\S]*claim-plan\.mjs batch[\s\S]*--override-batch-solo/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a gate:non-null batch does not refuse — members stay individually claimable (plan 2459 item 5)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-gated', { members: ['050'], gate: 'plan 999 lands' });
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: --override-batch-solo "<note>" WINS, and the note lands in BOTH the projected body Override line and the coord commit message (plan 2459 Task 2)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['050'] });
    const res = doAcquire(r.dir, '050-Infra-foo', {
      slug: '050-Infra-foo',
      host: 'H',
      'override-batch-solo': 'operator wants this landed ahead of its train',
    });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    const projected = r.g(
      'show',
      'origin/master:docs/superpowers/plans/in-progress/050-Infra-foo.md',
    );
    assert.match(projected, /\*\*Override:\*\* claimed solo via `--override-batch-solo`/);
    assert.match(projected, /operator wants this landed ahead of its train/);
    // the human-readable audit trail (NOT the machine-parsed ref-CAS claim message, which
    // stays a 4-line lock contract) also carries the override note.
    const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
    assert.match(
      subjects[0],
      /OVERRIDE batch-solo: "operator wants this landed ahead of its train"/,
    );
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: an empty --override-batch-solo note is rejected (must be a real authorization, not just present)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['050'] });
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          'lock-only': true,
          'override-batch-solo': '   ',
        }),
      /--override-batch-solo.*non-empty/,
    );
  } finally {
    r.cleanup();
  }
});

// Mirrors the --stub-ok F3 guard: the shared coord-git parseFlags greedily consumes the
// NEXT argv token as a value flag's value, so a flag-shaped value must be rejected
// explicitly rather than silently swallowing the following flag.
test('Batch-solo guard: --override-batch-solo swallowing a following flag (a value starting with "-") is rejected', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['050'] });
    assert.throws(
      () =>
        doAcquire(r.dir, '050-Infra-foo', {
          slug: '050-Infra-foo',
          'lock-only': true,
          'override-batch-solo': '--seed-write',
        }),
      /--override-batch-solo requires a non-flag authorization note/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/050/, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a plan with no batches dir at all is unaffected (byte-identical to pre-2459)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a batch roster naming a DIFFERENT plan id does not refuse this claim', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-other', { members: ['999'] });
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

// --- plan 4246: an ARCHIVED co-member dissolves the hold at the claim gate too ------------
// The gate must answer exactly as queue-drain does (batch-paths.mjs's batchLiveness): a batch
// left with fewer than two live members holds nothing, a batch with ≥2 live members still holds
// them, and a co-member that is merely parked (waiting-*) — not archived — changes nothing.
// The gate reads archive membership at the ORIGIN commit it resolved the plan against (review
// finding 47956f), so the fixture PUSHES the archived file unless told not to.
function writeArchivedPlanFixture(r, basename, { push = true } = {}) {
  const rel = `docs/superpowers/plans/${ARCHIVE_FOLDER}/${basename}`;
  const abs = join(r.dir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '# landed\n\n**Status:** ✅ COMPLETED — test.\n');
  if (!push) return;
  r.g('add', '--', rel);
  r.g('commit', '-qm', `archive ${basename}`, '--', rel);
  r.g('push', '-q', 'origin', 'master');
}

test('Batch-solo guard: the survivor of a 2-member batch whose co-member is ARCHIVED passes without --override-batch-solo (plan 4246)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050'] });
    // A date-slugged archive name (review finding b6ad2d) must still count as archived.
    writeArchivedPlanFixture(r, '049-2026-05-21-landed-solo.md');
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a 3-member batch with 1 ARCHIVED member still holds its 2 live members (plan 4246)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050', '051'] });
    writeArchivedPlanFixture(r, '049-Infra-landed-solo.md');
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /member of runnable batch "batch-x"/,
    );
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a co-member archived only on LOCAL disk (not on origin) keeps the hold (plan 4246, review 47956f)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050'] });
    writeArchivedPlanFixture(r, '049-Infra-archived-locally.md', { push: false });
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /member of runnable batch "batch-x"/,
    );
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a co-member parked in waiting-* (NOT archived) keeps the hold (plan 4246 rule 4)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050'] });
    const parked = join(r.dir, 'docs', 'superpowers', 'plans', 'waiting-operator');
    mkdirSync(parked, { recursive: true });
    writeFileSync(join(parked, '049-Infra-parked.md'), '# parked\n');
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /member of runnable batch "batch-x"/,
    );
  } finally {
    r.cleanup();
  }
});

// Review finding b35525: the roster must come from the SAME origin commit as the archive list.
// Origin lists 3 members with 1 archived (still a live 2-car train → held); a stale LOCAL batch.md
// that lists only 2 members (which would read as dissolved) must be ignored.
test('Batch-solo guard: a stale LOCAL batch.md is ignored — the origin roster (3 members, 1 archived) still holds (plan 4246, review b35525)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050', '051'] });
    writeArchivedPlanFixture(r, '049-Infra-landed-solo.md');
    writeBatchMdFixture(r.dir, 'batch-x', { members: ['049', '050'], push: false });
    assert.throws(
      () => doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true }),
      /member of runnable batch "batch-x"/,
    );
  } finally {
    r.cleanup();
  }
});

test('Batch-solo guard: a batch.md that exists only on LOCAL disk (never pushed) holds nothing (plan 4246, review b35525)', () => {
  const r = makeRepoWithPlan({ full: true, basename: '050-Infra-foo.md' });
  try {
    writeBatchMdFixture(r.dir, 'batch-local', { members: ['050', '051'], push: false });
    const res = doAcquire(r.dir, '050-Infra-foo', { slug: '050-Infra-foo', 'lock-only': true });
    assert.equal(res.won, true);
  } finally {
    r.cleanup();
  }
});

// --- plan 871: writeSessionEntryExclusive (no-clobber session entry) ----------

function makeSessionsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'session-entry-'));
  mkdirSync(join(dir, 'handoff', 'sessions'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('writeSessionEntryExclusive: writes the bare path when free', () => {
  const { dir, cleanup } = makeSessionsDir();
  try {
    const rel = writeSessionEntryExclusive(dir, {
      date: '2026-06-20',
      sessionNum: 828,
      content: 'STUB\n',
      handoffLayout: 'sessions',
    });
    assert.equal(rel, 'handoff/sessions/2026-06-20-session-828.md');
    assert.equal(readFileSync(join(dir, rel), 'utf8'), 'STUB\n');
  } finally {
    cleanup();
  }
});

test('writeSessionEntryExclusive: bumps to -Nb when the bare path is taken (never clobbers)', () => {
  const { dir, cleanup } = makeSessionsDir();
  try {
    // a sibling CLAIM stub already occupies the bare number (the 775b/777b incident shape)
    const taken = join(dir, 'handoff', 'sessions', '2026-06-20-session-828.md');
    writeFileSync(taken, 'SIBLING CLAIM — must survive\n');
    const rel = writeSessionEntryExclusive(dir, {
      date: '2026-06-20',
      sessionNum: 828,
      content: 'OUR STUB\n',
      handoffLayout: 'sessions',
    });
    assert.equal(
      rel,
      'handoff/sessions/2026-06-20-session-828b.md',
      'fell through to the b suffix',
    );
    assert.equal(
      readFileSync(taken, 'utf8'),
      'SIBLING CLAIM — must survive\n',
      'sibling untouched',
    );
    assert.equal(readFileSync(join(dir, rel), 'utf8'), 'OUR STUB\n');
  } finally {
    cleanup();
  }
});

test('writeSessionEntryExclusive: cascades b→c when both are taken', () => {
  const { dir, cleanup } = makeSessionsDir();
  try {
    const s = (suf) => join(dir, 'handoff', 'sessions', `2026-06-20-session-828${suf}.md`);
    writeFileSync(s(''), 'x\n');
    writeFileSync(s('b'), 'y\n');
    const rel = writeSessionEntryExclusive(dir, {
      date: '2026-06-20',
      sessionNum: 828,
      content: 'z\n',
      handoffLayout: 'sessions',
    });
    assert.equal(rel, 'handoff/sessions/2026-06-20-session-828c.md');
  } finally {
    cleanup();
  }
});

test('writeSessionEntryExclusive: single layout keeps the plain handoff.md write', () => {
  const { dir, cleanup } = makeSessionsDir();
  try {
    const rel = writeSessionEntryExclusive(dir, {
      date: '2026-06-20',
      sessionNum: 1,
      content: 'HANDOFF\n',
      handoffLayout: 'single',
    });
    assert.equal(rel, 'handoff.md');
    assert.equal(readFileSync(join(dir, 'handoff.md'), 'utf8'), 'HANDOFF\n');
  } finally {
    cleanup();
  }
});

// --- plan 871: mint-session CLI (race-safe number for non-pickup writers) -----

test('mint-session CLI: returns a monotonic session number from the CAS counter', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const run = () =>
      JSON.parse(
        execFileSync(process.execPath, [CLAIM_PLAN_CLI, 'mint-session'], {
          cwd: dir,
          encoding: 'utf8',
        }).trim(),
      );
    const a = run();
    const b = run();
    assert.equal(a.sessionNum, 1);
    assert.equal(b.sessionNum, 2, 'second mint advances the counter — no collision');
  } finally {
    cleanup();
  }
});

// ───────────────────── plan 924: INDEX-repath drift heal ─────────────────────
// The claim's move-plan step can commit a plan-file rename together with a STALE
// docs/INDEX.md (a sibling coord process overwrote the working-tree INDEX in the
// window between move-plan's build-index write and its commit), leaving the file in
// in-progress/ but its bullet in ready/ — which then wedged the next cut-worktree push
// on lint-plan-index --check. healIndexDriftAfterMove must idempotently repair that.

// A bare origin + working clone carrying ONE committed plan and a docs/INDEX.md whose
// generated PLANS bullet points at `bulletFolder/` while the file actually lives in
// `planFolder/`. When the two differ, the INDEX is drifted exactly as the incident left it.
function makeRepoWithIndex({
  planFolder = 'in-progress',
  bulletFolder = 'ready',
  seedBanner = false,
} = {}) {
  const origin = mkdtempSync(join(tmpdir(), 'idx-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), 'idx-work-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  g('remote', 'add', 'origin', origin);

  const basename = '855-Infra-x.md';
  const planRel = `docs/superpowers/plans/${planFolder}/${basename}`;
  const planAbs = join(dir, ...planRel.split('/'));
  mkdirSync(dirname(planAbs), { recursive: true });
  writeFileSync(
    planAbs,
    [
      '---',
      'summary: "Demo plan for the heal test"',
      '---',
      '',
      `# ${basename}`,
      '',
      ...(seedBanner ? [sw('> 🟥 **SEED-WRITE: yes** — touches seed.'), ''] : []),
      'Body.',
      '',
    ].join('\n'),
  );

  const bullet = `- 🟩 Demo plan for the heal test → \`${bulletFolder}/${basename}\``;
  const indexAbs = join(dir, 'docs', 'INDEX.md');
  writeFileSync(
    indexAbs,
    [
      '# Index',
      '',
      INDEX_SPECS_START,
      '',
      '**Active** (`docs/superpowers/specs/`)',
      '',
      '**Archive** (`docs/superpowers/specs/archive/`)',
      '',
      INDEX_SPECS_END,
      '',
      '## Plans',
      '',
      INDEX_PLANS_START,
      '',
      `**${bulletFolder}/**`,
      '',
      bullet,
      '',
      INDEX_PLANS_END,
      '',
      'Moved to `docs/superpowers/plans/archive/` — older plans live here.',
      '',
    ].join('\n'),
  );
  g('add', '-A');
  g('commit', '-qm', 'seed plan + index');
  g('push', '-q', 'origin', 'master');
  return {
    dir,
    g,
    planRel,
    indexAbs,
    head: () => g('rev-parse', 'HEAD').trim(),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

test('regenIndexContent + indexIsCurrent: detect a bullet whose folder ≠ the file folder', () => {
  const r = makeRepoWithIndex({ planFolder: 'in-progress', bulletFolder: 'ready' });
  try {
    // the file is tracked in in-progress/ but the INDEX bullet still says ready/ → drifted
    assert.equal(indexIsCurrent(r.dir), false);
    const regen = regenIndexContent(r.dir);
    assert.match(regen, /\*\*in-progress\/\*\*/, 'regen places the bullet under in-progress/');
    assert.match(regen, /→ `in-progress\/855-Infra-x\.md`/);
    assert.doesNotMatch(regen, /→ `ready\/855-Infra-x\.md`/, 'no stale ready/ bullet survives');
  } finally {
    r.cleanup();
  }
});

test('regenIndexContent: reads seedLane from mainDir, not build-index REPO_ROOT (review Bug 1)', () => {
  // A config-less mainDir has seedLane=false → readSeedMarker forces 🟩 for EVERY plan,
  // even one carrying a `🟥 SEED-WRITE: yes` banner. If the seed marker were instead read
  // from build-index.mjs's own REPO_ROOT (the live vetapp checkout, seedLane=true), the
  // banner would render 🟥. Asserting 🟩 proves the loadConfig seam reads mainDir's config.
  const r = makeRepoWithIndex({
    planFolder: 'in-progress',
    bulletFolder: 'in-progress',
    seedBanner: true,
  });
  try {
    const regen = regenIndexContent(r.dir);
    assert.match(
      regen,
      /^- 🟩 .*→ `in-progress\/855-Infra-x\.md`$/m,
      'marker forced 🟩 by mainDir config',
    );
    assert.doesNotMatch(regen, /^- 🟥 /m, 'no 🟥 — REPO_ROOT seedLane was NOT used');
  } finally {
    r.cleanup();
  }
});

test('healIndexDriftAfterMove: repairs the drifted bullet and commits the fix', () => {
  const r = makeRepoWithIndex({ planFolder: 'in-progress', bulletFolder: 'ready' });
  try {
    const before = r.head();
    const res = healIndexDriftAfterMove(r.dir, { planId: '855' });
    assert.equal(res.healed, true);
    assert.equal(indexIsCurrent(r.dir), true, 'INDEX is consistent after heal');
    const idx = readFileSync(r.indexAbs, 'utf8');
    assert.match(idx, /→ `in-progress\/855-Infra-x\.md`/, 'bullet now points at in-progress/');
    assert.doesNotMatch(idx, /→ `ready\/855-Infra-x\.md`/);
    assert.notEqual(r.head(), before, 'a heal commit was made');
  } finally {
    r.cleanup();
  }
});

test('healIndexDriftAfterMove: no-op (zero commits) when INDEX is already consistent', () => {
  const r = makeRepoWithIndex({ planFolder: 'in-progress', bulletFolder: 'ready' });
  try {
    // First make it consistent by writing the canonical regen + committing, so the heal
    // entry-check sees a clean INDEX and must NOT commit again.
    writeFileSync(r.indexAbs, regenIndexContent(r.dir));
    r.g('commit', '-qam', 'normalize index');
    assert.equal(indexIsCurrent(r.dir), true);
    const before = r.head();
    const res = healIndexDriftAfterMove(r.dir, { planId: '855' });
    assert.equal(res.healed, false, 'nothing to heal');
    assert.equal(res.attempts, 0);
    assert.equal(r.head(), before, 'no commit was made on an already-consistent INDEX');
  } finally {
    r.cleanup();
  }
});

test('healIndexDriftAfterMove: throws after exhausting attempts if INDEX never converges', () => {
  const r = makeRepoWithIndex({ planFolder: 'in-progress', bulletFolder: 'ready' });
  try {
    // Inject a coordWrite that never actually fixes anything, so isCurrent stays false:
    // proves the bounded loop surfaces a clear error instead of looping forever.
    let calls = 0;
    assert.throws(
      () =>
        healIndexDriftAfterMove(
          r.dir,
          { planId: '855', attempts: 3 },
          {
            indexIsCurrent: () => false,
            coordWrite: () => {
              calls++;
            },
          },
        ),
      /still drifted for plan 855 after 3 heal attempts/,
    );
    assert.equal(calls, 3, 'attempted exactly the bounded number of heals');
  } finally {
    r.cleanup();
  }
});

// plan 958 — planStatus: a read-only holder report with a deterministic youAreHolder.
test('planStatus: an unheld plan reports { held:false }', () => {
  const r = makeBareOrigin();
  try {
    const s = planStatus(r.dir, '900');
    assert.equal(s.held, false);
    assert.equal(s.planId, '900');
  } finally {
    r.cleanup();
  }
});

test('planStatus: a held plan reports holder fields + ageSec (and youAreHolder=false for a stranger)', () => {
  const r = makeBareOrigin();
  try {
    acquireRef(r.dir, {
      planId: '901',
      message: 'claim plan=901\nsession=sid-XYZ\nhost=H1\niso=2026-06-22T10:00:00.000Z\n',
    });
    const s = planStatus(r.dir, '901', {
      now: new Date('2026-06-22T10:00:30.000Z'),
      selfId: 'someone-else',
    });
    assert.equal(s.held, true);
    assert.equal(s.holder.sessionUuid, 'sid-XYZ');
    assert.equal(s.holder.host, 'H1');
    assert.equal(s.holder.ageSec, 30);
    assert.equal(s.youAreHolder, false);
  } finally {
    r.cleanup();
  }
});

test('planStatus: youAreHolder=true when this session id matches the stored claim session', () => {
  const r = makeBareOrigin();
  try {
    acquireRef(r.dir, {
      planId: '902',
      message: 'claim plan=902\nsession=mine-123\nhost=H\niso=2026-06-22T10:00:00.000Z\n',
    });
    const s = planStatus(r.dir, '902', { now: new Date(), selfId: 'mine-123' });
    assert.equal(s.youAreHolder, true);
  } finally {
    r.cleanup();
  }
});

test('planStatus: youAreHolder=false (never a guess) when no session id is available', () => {
  const r = makeBareOrigin();
  try {
    acquireRef(r.dir, {
      planId: '903',
      message: 'claim plan=903\nsession=x\nhost=H\niso=2026-06-22T10:00:00.000Z\n',
    });
    const s = planStatus(r.dir, '903', { now: new Date(), selfId: null });
    assert.equal(s.youAreHolder, false);
  } finally {
    r.cleanup();
  }
});

// ───────────────────── plan 1364 Ship 1: batch claim (2-8 plans, one worktree) ─────
// A production-faithful repo (coord.config.json with a seed lane so the SEED-WRITE
// homogeneity gate is live, docs/INDEX.md with the splice sentinels, a board with the
// row sentinels, and the sessions dir) carrying N ready/ plans, each with
// stage/execModel frontmatter and a SEED-WRITE banner — everything doAcquireBatch's
// eligibility gate and projectBatchClaim's projection touch.
function makeRepoWithPlans(planSpecs) {
  const origin = mkdtempSync(join(tmpdir(), 'batch-origin-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin]);
  const dir = mkdtempSync(join(tmpdir(), 'batch-work-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'master');
  g('config', 'user.email', 't@t.t');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  g('remote', 'add', 'origin', origin);

  for (const spec of planSpecs) {
    const {
      folder = 'ready',
      basename,
      stage = 'specced',
      execModel = 'sonnet',
      seedWrite = 'NO',
      // plan 2426: a Blocked-by line to gate on, and an archive/ ✅ COMPLETED stamp so a
      // blocker can be made genuinely SHIPPED (archive presence alone never clears one).
      bodyExtra = '',
      status = '**Status:** 📋 READY — opened 2026-07-01.',
    } = spec;
    const planRel = `docs/superpowers/plans/${folder}/${basename}`;
    const planAbs = join(dir, ...planRel.split('/'));
    mkdirSync(dirname(planAbs), { recursive: true });
    writeFileSync(
      planAbs,
      [
        '---',
        `summary: "${basename} summary"`,
        `stage: ${stage}`,
        `execModel: ${execModel}`,
        '---',
        '',
        `# ${basename}`,
        '',
        `> ${seedWrite === 'YES' ? '🟥' : '🟩'} **${MUTATION_BANNER_LABEL}: ${seedWrite}** — desc.`,
        '',
        status,
        '',
        bodyExtra,
        '',
        'Body.',
        '',
      ].join('\n'),
    );
  }
  writeFileSync(
    join(dir, 'coord.config.json'),
    JSON.stringify({
      handoffDir: 'docs/handoff',
      handoffLayout: 'sessions',
      seedShardDir: 'backend/src/data/seed',
    }),
  );
  writeFileSync(
    join(dir, 'docs', 'INDEX.md'),
    [
      '# Index',
      '',
      INDEX_SPECS_START,
      '',
      INDEX_SPECS_END,
      '',
      '## Plans',
      '',
      INDEX_PLANS_START,
      '',
      INDEX_PLANS_END,
      '',
    ].join('\n'),
  );
  const boardAbs = join(dir, 'docs', 'handoff', 'board.md');
  mkdirSync(dirname(boardAbs), { recursive: true });
  writeFileSync(
    boardAbs,
    [
      '# Board',
      '<!-- BOARD-START -->',
      '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
      '|---|---|---|---|---|---|',
      '<!-- BOARD-END -->',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'docs', 'handoff', 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'handoff', 'sessions', '.gitkeep'), '');
  g('add', '-A');
  g('commit', '-qm', 'seed plans');
  g('push', '-q', 'origin', 'master');
  return {
    dir,
    g,
    origin,
    // plan 3756: sweeps BOTH claim namespaces, so a test asserting "the claim ref exists"
    // keeps meaning that regardless of which namespace the spine is writing to.
    lsClaims: () => g('ls-remote', origin, ...CLAIM_GLOBS),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    },
  };
}

test('doAcquireBatch: happy path — N refs won, ONE projection commit, N in-progress + N board rows + ONE session entry + a manifest', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-03-x',
      host: 'H',
    });
    assert.equal(res.won, true);
    assert.equal(res.batch, true);
    assert.equal(res.projected, true);
    assert.equal(res.members.length, 2);
    assert.deepEqual(
      res.members.map((m) => m.planId),
      ['1362', '1365'],
    );
    for (const m of res.members) {
      assert.match(m.claimSha, /^[0-9a-f]{7,40}$/);
      assert.match(m.path, /^docs\/superpowers\/plans\/in-progress\//);
    }

    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /in-progress\/1362-DQ-a\.md/);
    assert.match(tree, /in-progress\/1365-Infra-b\.md/);
    assert.doesNotMatch(tree, /ready\/1362-DQ-a\.md/);
    assert.doesNotMatch(tree, /ready\/1365-Infra-b\.md/);

    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.match(board, /1362-DQ-a/);
    assert.match(board, /1365-Infra-b/);
    assert.match(board, /batch=`batch-2026-07-03-x`/g);
    assert.equal((board.match(/🔄 ACTIVE/g) || []).length, 2, 'two ACTIVE board rows');

    const sessionFiles = tree
      .split('\n')
      .filter((p) => /^docs\/handoff\/sessions\/.*session-\d/.test(p));
    assert.equal(sessionFiles.length, 1, 'exactly one session-entry stub for the whole batch');
    const stub = r.g('show', `origin/master:${sessionFiles[0]}`);
    assert.match(stub, /1362-DQ-a\.md/);
    assert.match(stub, /1365-Infra-b\.md/);

    // plan 1467: the manifest lands in the batch FOLDER, not docs/handoff/batches/.
    const manifest = JSON.parse(
      r.g('show', 'origin/master:docs/superpowers/batches/batch-2026-07-03-x/manifest.json'),
    );
    assert.equal(manifest.slug, 'batch-2026-07-03-x');
    assert.deepEqual(manifest.members, ['1362', '1365']);
    assert.equal(manifest.sessionNum, res.sessionNum);
    assert.equal(manifest.host, 'H');

    // plan 1467: an ad-hoc batch (no pre-existing roster folder) gets a batch.md synthesized
    // at claim, stamped status: claimed.
    const batchMd = r.g(
      'show',
      'origin/master:docs/superpowers/batches/batch-2026-07-03-x/batch.md',
    );
    assert.match(batchMd, /^slug: batch-2026-07-03-x$/m);
    assert.match(batchMd, /^status: claimed$/m);
    assert.match(batchMd, /^members: \[1362, 1365\]$/m);

    const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
    assert.equal(
      subjects.filter((s) => /project batch batch-2026-07-03-x/.test(s)).length,
      1,
      'exactly one projection commit for the whole batch',
    );
  } finally {
    r.cleanup();
  }
});

// plan 2460 Phase 2: the batch analogue of the single-plan executor-provenance test above —
// every member's board row gets the stamp AND the ONE batch session stub carries it.
test('doAcquireBatch: --model-id/--dispatch-mode stamp every member board row + the ONE batch session stub', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-26-x',
      host: 'H',
      'model-id': 'claude-sonnet-5',
      'dispatch-mode': 'cloud-drain',
    });
    assert.equal(res.won, true);
    assert.equal(res.modelId, 'claude-sonnet-5');
    assert.equal(res.dispatchMode, 'cloud-drain');

    r.g('fetch', '-q', 'origin', 'master');
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.equal(
      (board.match(/exec=`cloud-drain` model=`claude-sonnet-5`/g) || []).length,
      2,
      'both member rows carry the stamp',
    );

    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    const sessionFile = tree
      .split('\n')
      .find((p) => /docs\/handoff\/sessions\/.*session-\d/.test(p));
    const stub = r.g('show', `origin/master:${sessionFile}`);
    const lines = stub.split('\n');
    const hostIdx = lines.findIndex((l) => l.startsWith('**Host:**'));
    assert.ok(hostIdx >= 0);
    assert.equal(
      lines[hostIdx + 1],
      '**Executor:** `cloud-drain` · model `claude-sonnet-5`',
      'the Executor line lands immediately after Host in the batch stub too',
    );
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: a PRE-EXISTING batch.md roster entry is STAMPED status: claimed, not re-synthesized (plan 1467)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    // seed a proposed batch.md folder (what a board-pass writes) BEFORE the claim.
    const batchMdRel = 'docs/superpowers/batches/batch-2026-07-03-x/batch.md';
    const batchMdAbs = join(r.dir, ...batchMdRel.split('/'));
    mkdirSync(dirname(batchMdAbs), { recursive: true });
    writeFileSync(
      batchMdAbs,
      [
        '---',
        'slug: batch-2026-07-03-x',
        'lane: 🟩',
        'members: [1362, 1365]',
        'gate: null',
        'status: proposed',
        '---',
        '',
        '# batch-2026-07-03-x',
        '',
        'A distinctive theme that must survive the claim stamp.',
        '',
      ].join('\n'),
    );
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed proposed batch folder');
    r.g('push', '-q', 'origin', 'master');

    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-03-x',
      host: 'H',
    });
    assert.equal(res.won, true);

    const batchMd = r.g('show', `origin/master:${batchMdRel}`);
    assert.match(batchMd, /^status: claimed$/m);
    assert.doesNotMatch(batchMd, /status: proposed/);
    // lane + theme preserved (stamped in place, not regenerated as an ad-hoc entry)
    assert.match(batchMd, /^lane: 🟩$/m);
    assert.match(batchMd, /A distinctive theme that must survive the claim stamp\./);
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: all-or-release — a pre-claimed member LOSES the whole batch and releases the other ref', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  const dir2 = mkdtempSync(join(tmpdir(), 'batch-work2-'));
  try {
    // a second clone pre-claims 1365 before our batch runs
    const g2 = (...a) => execFileSync('git', ['-C', dir2, ...a], { encoding: 'utf8' });
    g2('init', '-q', '-b', 'master');
    g2('config', 'user.email', 't@t.t');
    g2('config', 'user.name', 'T');
    g2('config', 'commit.gpgsign', 'false');
    g2('remote', 'add', 'origin', r.origin);
    acquireRef(dir2, {
      planId: '1365',
      message: 'claim plan=1365\nsession=RIVAL\nhost=RIVAL-HOST\niso=2026-07-03T00:00:00Z\n',
    });

    const res = doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-03-y', host: 'H' });
    assert.equal(res.won, false);
    assert.equal(res.batch, true);
    assert.equal(res.lostOn, '1365');
    assert.equal(res.holder.host, 'RIVAL-HOST');

    // plan 3756: releasing leaves a TOMBSTONE on the ref rather than deleting it, so
    // "released" is asserted through readHolder (which reads a tombstone as unheld), never
    // by the ref's absence — that would now pass whether or not the release happened.
    assert.equal(readHolder(r.dir, '1362'), null, '1362 ref was released — no leak');
    assert.match(r.lsClaims(), claimRx('1365'), "1365's ref is still held by the rival, untouched");
  } finally {
    rmSync(dir2, { recursive: true, force: true });
    r.cleanup();
  }
});

test('doAcquireBatch: rejects a count outside 2-8, no ref acquired', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362'], { slug: 'batch-x' }),
      /must claim 2-8 plans \(got 1\)/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: rejects more than 8 plans, no ref acquired', () => {
  const ids = ['1362', '1363', '1364', '1365', '1366', '1367', '1368', '1369', '1370'];
  const r = makeRepoWithPlans(ids.map((id) => ({ basename: `${id}-DQ-a.md` })));
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ids, { slug: 'batch-x' }),
      /must claim 2-8 plans \(got 9\)/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: rejects a non-specced member (no --force), no ref acquired', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md', stage: 'stub' },
  ]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-x' }),
      /plan 1365 has stage "stub", batch requires "specced"/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

// plan 2844 Task 1: the batch path's own `--date` site needs the same fail-fast validation
// as doAcquire's — without it, the batch path mints the same malformed session-entry names.
test('doAcquireBatch: a malformed --date (non-ISO shape) throws BEFORE any ref is acquired (fail-fast)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    assert.throws(
      () =>
        doAcquireBatch(r.dir, ['1362', '1365'], {
          slug: 'batch-2026-08-04-x',
          date: '20260804',
        }),
      /--date "20260804" must be YYYY-MM-DD/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//, 'no ref was left held after the throw');
  } finally {
    r.cleanup();
  }
});

// plan 2844 review: the batch path shares doAcquire's `'date' in flags` discrimination, so it
// must refuse the same two typo shapes rather than defaulting them to today.
for (const [label, date] of [
  ['valueless (--date at end of argv)', undefined],
  ['explicitly empty (--date=)', ''],
]) {
  test(`doAcquireBatch: a ${label} --date is REFUSED, not defaulted to today`, () => {
    const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
    try {
      assert.throws(
        () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-08-04-x', date }),
        /must be YYYY-MM-DD/,
      );
      assert.doesNotMatch(r.lsClaims(), /refs\/claims\//, 'no ref was left held after the throw');
    } finally {
      r.cleanup();
    }
  });
}

test('doAcquireBatch: rejects mixed SEED-WRITE banners (no --force), no ref acquired', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', seedWrite: 'NO' },
    { basename: '1365-Infra-b.md', seedWrite: 'YES' },
  ]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-x' }),
      /mixed SEED-WRITE banners/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: --force bypasses execModel/seed-write mismatch (both members specced) and still projects', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', seedWrite: 'NO' },
    { basename: '1365-Infra-b.md', execModel: 'fable', seedWrite: 'YES' },
  ]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-03-z',
      force: true,
    });
    assert.equal(res.won, true);
    assert.equal(res.members.length, 2);
  } finally {
    r.cleanup();
  }
});

// plan 1427 Gate 2: --force USED TO also bypass a stub-stage member — that was a
// batch-shaped escape hatch around the exact self-pickup bypass Gate 2 closes for
// single-plan acquire (a stage:stub plan self-claimed with no heavy-model review).
// --force alone no longer reaches stage; only --stub-ok does (below).
test('doAcquireBatch: a stub member + --force alone is REFUSED (changed semantics, plan 1427 Gate 2), no ref acquired', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', stage: 'stub' },
    { basename: '1365-Infra-b.md' },
  ]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-03-z', force: true }),
      /plan 1362 has stage "stub", batch requires "specced"/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch: a stub member + --stub-ok "<note>" is ACCEPTED and still projects', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', stage: 'stub' },
    { basename: '1365-Infra-b.md' },
  ]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-03-z',
      'stub-ok': 'operator-authorized 2026-07-05, plan 1427 dry run',
    });
    assert.equal(res.won, true);
    assert.equal(res.members.length, 2);
  } finally {
    r.cleanup();
  }
});

// plan 1427 review F3: same swallowed-flag guard as the single-plan acquire test above.
test('doAcquireBatch: --stub-ok swallowing a following flag (a value starting with "-") is rejected (F3)', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', stage: 'stub' },
    { basename: '1365-Infra-b.md' },
  ]);
  try {
    assert.throws(
      () =>
        doAcquireBatch(r.dir, ['1362', '1365'], {
          slug: 'batch-2026-07-03-z',
          'stub-ok': '--force',
        }),
      /--stub-ok requires a non-flag authorization note/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//, 'no ref leaked — the guard ran first');
  } finally {
    r.cleanup();
  }
});

// Simulate a SINGLE disposable coord-checkout commit that pushes an updated
// coord.config.json AND N target plan files straight to origin/master, never touching
// `dir`'s own working tree/index — the batch-shaped generalization of
// pushConfigAndPlanViaCoordCheckoutSim above (plan 2536: doAcquireBatch's own twin of the
// plan-2502 single-plan staleness scenario, but with N members instead of one).
function pushConfigAndPlansViaCoordCheckoutSim(dir, configObj, plans) {
  const coordDir = mkdtempSync(join(tmpdir(), 'claim-coord-batch-cfg-'));
  execFileSync(
    'git',
    ['-C', dir, 'worktree', 'add', '-q', '-b', `coord-sim-batch-${Date.now()}`, coordDir, 'master'],
    { encoding: 'utf8' },
  );
  writeFileSync(join(coordDir, 'coord.config.json'), JSON.stringify(configObj));
  for (const { folder, basename, bodyText } of plans) {
    const rel = `docs/superpowers/plans/${folder}/${basename}`;
    const abs = join(coordDir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bodyText);
  }
  execFileSync('git', ['-C', coordDir, 'add', '-A'], { encoding: 'utf8' });
  execFileSync('git', ['-C', coordDir, 'commit', '-qm', `seed batch members + coord.config.json`], {
    encoding: 'utf8',
  });
  const branch = execFileSync('git', ['-C', coordDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', coordDir, 'push', '-q', 'origin', `${branch}:master`], {
    encoding: 'utf8',
  });
  return coordDir;
}

test('plan 2536: doAcquireBatch eligibility gate reads member bodies AND coord.config.json seedLane at the SAME origin/master sha', () => {
  const { dir, cleanup } = makeBareOrigin();
  let coordDir;
  try {
    // `dir`'s own on-disk tree has NO coord.config.json and NEVER saw either member file —
    // under the pre-2536 bug, doAcquireBatch would read loadCoordConfig(dir) (seedLane=false,
    // forcing 🟩 regardless of the banner below) and activePathFor(dir, …) (which would not
    // even resolve these members, since dir's own tree never had them).
    assert.equal(existsSync(join(dir, 'coord.config.json')), false);

    // A sibling coord write flips seedLane ON and lands BOTH batch members — one carrying a
    // stage:stub + specReview:exempt-mechanical claim over a 🟥 Gate-1 pipeline field flip,
    // the other an ordinary specced member — in the SAME commit, straight on origin/master.
    coordDir = pushConfigAndPlansViaCoordCheckoutSim(
      dir,
      { seedShardDir: 'backend/src/data/seed', land: { specReviewGatedFields: PIPELINE_FIELDS } },
      [
        {
          folder: 'ready',
          basename: '2536-Infra-batch-a.md',
          bodyText: [
            '---',
            'summary: "x"',
            // checkBatchEligibility's own stage gate (batch requires "specced" unless
            // --stub-ok) runs BEFORE checkStubClaimGate — a stage:"stub" member would be
            // refused on the stage check alone, never reaching the exempt-mechanical
            // narrowing this test targets. "specced" + a lingering specReview:
            // exempt-mechanical is the unusual-but-schema-legal combination that reaches it.
            'stage: specced',
            'execModel: sonnet',
            'specReview: exempt-mechanical',
            '---',
            '',
            '# 2536-Infra-batch-a.md',
            '',
            sw('> 🟥 **SEED-WRITE: YES** — flips acceptsAcuteCases.'),
            '',
            'Demotes acceptsAcuteCases on rec-1097.',
            '',
          ].join('\n'),
        },
        {
          folder: 'ready',
          basename: '2537-Infra-batch-b.md',
          bodyText: [
            '---',
            'summary: "y"',
            'stage: specced',
            'execModel: sonnet',
            '---',
            '',
            '# 2537-Infra-batch-b.md',
            '',
            sw('> 🟩 **SEED-WRITE: NO** — no record data.'),
            '',
            'Body.',
            '',
          ].join('\n'),
        },
      ],
    );

    // `dir`'s own working tree still has no coord.config.json at all — proving any refusal
    // below can only come from a FRESH origin/master read, not a locally-cached copy.
    assert.equal(existsSync(join(dir, 'coord.config.json')), false);

    assert.throws(
      () =>
        doAcquireBatch(dir, ['2536', '2537'], {
          slug: 'batch-2026-07-27-cfg-fresh',
          'lock-only': true,
        }),
      /plan 2536: .*exempt-mechanical.*cannot cover/,
    );
    assert.doesNotMatch(
      execFileSync('git', ['-C', dir, 'ls-remote', 'origin', 'refs/claims/*'], {
        encoding: 'utf8',
      }),
      /refs\/claims\//,
      'no ref leaked — the eligibility gate ran before any ref was acquired',
    );
  } finally {
    if (coordDir) rmSync(coordDir, { recursive: true, force: true });
    cleanup();
  }
});

test('plan 2536: a batch member with a STALE local mainDir copy is judged against the FRESH origin/master content, not the stale local one', () => {
  const { dir, cleanup } = makeBareOrigin();
  let coordDir;
  try {
    // `dir` commits + pushes an INITIAL, SAFE version of the plan (no exempt-mechanical, no
    // pipeline-field mention) — dir and origin agree at this point in time.
    const rel1 = 'docs/superpowers/plans/ready/2536-Infra-batch-stale.md';
    const abs1 = join(dir, ...rel1.split('/'));
    mkdirSync(dirname(abs1), { recursive: true });
    writeFileSync(
      abs1,
      [
        '---',
        'summary: "x"',
        'stage: specced',
        'execModel: sonnet',
        '---',
        '',
        '# 2536-Infra-batch-stale.md',
        '',
        sw('> 🟩 **SEED-WRITE: NO** — no record data.'),
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    const rel2 = 'docs/superpowers/plans/ready/2537-Infra-batch-stale-b.md';
    const abs2 = join(dir, ...rel2.split('/'));
    writeFileSync(
      abs2,
      [
        '---',
        'summary: "y"',
        'stage: specced',
        'execModel: sonnet',
        '---',
        '',
        '# 2537-Infra-batch-stale-b.md',
        '',
        sw('> 🟩 **SEED-WRITE: NO** — no record data.'),
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed initial safe plan bodies'], {
      encoding: 'utf8',
    });
    execFileSync('git', ['-C', dir, 'push', '-q', 'origin', 'master'], { encoding: 'utf8' });

    // A sibling coord write REPLACES the first member's body with a stage:stub +
    // specReview:exempt-mechanical claim over a 🟥 Gate-1 pipeline field flip, AND flips
    // seedLane ON — landing straight on origin/master. `dir`'s own working tree/index is
    // NEVER touched: its on-disk copy of 2536-Infra-batch-stale.md and its (absent)
    // coord.config.json stay exactly as committed above — genuinely stale relative to origin.
    coordDir = pushConfigAndPlansViaCoordCheckoutSim(
      dir,
      { seedShardDir: 'backend/src/data/seed', land: { specReviewGatedFields: PIPELINE_FIELDS } },
      [
        {
          folder: 'ready',
          basename: '2536-Infra-batch-stale.md',
          bodyText: [
            '---',
            'summary: "x"',
            // See the sibling test above: "specced" (not "stub") is required so
            // checkBatchEligibility's outer stage gate doesn't refuse before the
            // exempt-mechanical narrowing this test targets ever runs.
            'stage: specced',
            'execModel: sonnet',
            'specReview: exempt-mechanical',
            '---',
            '',
            '# 2536-Infra-batch-stale.md',
            '',
            sw('> 🟥 **SEED-WRITE: YES** — flips acceptsAcuteCases.'),
            '',
            'Demotes acceptsAcuteCases on rec-1097.',
            '',
          ].join('\n'),
        },
      ],
    );

    // Sanity: dir's own local copy is still the OLD, safe content — proving the local file on
    // disk was never touched by the sibling coord push.
    assert.match(readFileSync(abs1, 'utf8'), /stage: specced/);
    assert.doesNotMatch(readFileSync(abs1, 'utf8'), /exempt-mechanical/);
    assert.equal(existsSync(join(dir, 'coord.config.json')), false);

    // Under the pre-2536 bug, doAcquireBatch would read dir's own stale local copy (stage:
    // specced, no pipeline-field mention) and the claim would PASS. The fix reads origin/master
    // fresh instead, so it must REFUSE on the updated content.
    assert.throws(
      () =>
        doAcquireBatch(dir, ['2536', '2537'], {
          slug: 'batch-2026-07-27-stale',
          'lock-only': true,
        }),
      /plan 2536: .*exempt-mechanical.*cannot cover/,
    );
  } finally {
    if (coordDir) rmSync(coordDir, { recursive: true, force: true });
    cleanup();
  }
});

test('doAcquireBatch: rejects a batch slug that does not start with "batch-", no ref acquired', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: '1362-DQ-not-a-batch-slug' }),
      /must start with "batch-"/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

test('F-004 (plan 1313): doAcquireBatch REJECTS a batch slug outside the ASCII charset, no ref acquired', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: "batch-2026-07-03-record's" }),
      /--slug/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\//);
  } finally {
    r.cleanup();
  }
});

test('doAcquireBatch --lock-only: wins refs + mints ONE session number, defers projection', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-03-w',
      'lock-only': true,
    });
    assert.equal(res.won, true);
    assert.equal(res.projected, false);
    assert.equal(res.members.length, 2);
    assert.match(r.lsClaims(), claimRx('1362'));
    assert.match(r.lsClaims(), claimRx('1365'));
    // nothing projected — origin/master is untouched
    r.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(
      r.g('ls-tree', '-r', '--name-only', 'origin/master'),
      /in-progress\/1362-DQ-a\.md/,
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 1478: derail (mid-train batch-member reconcile) ---------------------

// Set a stable session id so the batch claim STORES it and doDerail's non-force release
// (owner-checked) matches it. Restores the prior value.
function withSessionId(id, fn) {
  const names = [
    'COORD_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_SESSION_ID',
    'CODEX_THREAD_ID',
    'GROK_SESSION_ID',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.CLAUDE_CODE_SESSION_ID = id;
  try {
    return fn();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('doDerail: drops the member from the manifest + removes its board row in ONE commit, releases its claim, survivor untouched (plan 1478)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    withSessionId('derail-test-sess', () => {
      const claimed = doAcquireBatch(r.dir, ['1362', '1365'], {
        slug: 'batch-2026-07-03-x',
        host: 'H',
      });
      assert.equal(claimed.won, true);
      assert.match(r.lsClaims(), claimRx('1362'));

      const res = doDerail(r.dir, '1362', {});
      assert.equal(res.changed, true);
      assert.equal(res.slug, 'batch-2026-07-03-x');
      assert.equal(res.rowSlug, '1362-DQ-a');
      assert.equal(res.released.released, true, 'claim ref released (owner match)');

      r.g('fetch', '-q', 'origin', 'master');
      // (a) manifest members now only the survivor; other fields preserved.
      const manifest = JSON.parse(
        r.g('show', 'origin/master:docs/superpowers/batches/batch-2026-07-03-x/manifest.json'),
      );
      assert.deepEqual(manifest.members, ['1365'], 'derailed member dropped, survivor kept');
      assert.equal(manifest.slug, 'batch-2026-07-03-x');
      assert.equal(manifest.host, 'H');

      // (b) board row for the derailed member gone; survivor's row intact.
      const board = r.g('show', 'origin/master:docs/handoff/board.md');
      assert.doesNotMatch(board, /1362-DQ-a/, 'derailed member board row removed');
      assert.match(board, /1365-Infra-b/, 'surviving member board row intact');

      // (c) manifest + board landed in exactly ONE derail projection commit.
      const subjects = r.g('log', 'origin/master', '--format=%s').trim().split('\n');
      assert.equal(
        subjects.filter((s) => /chore\(derail\): drop 1362 from batch batch-2026-07-03-x/.test(s))
          .length,
        1,
        'exactly one atomic derail commit (manifest + board)',
      );

      // (d) claim ref released; survivor's claim untouched.
      assert.equal(readHolder(r.dir, '1362'), null, 'derailed claim released');
      assert.match(r.lsClaims(), claimRx('1365'), 'survivor claim untouched');
    });
  } finally {
    r.cleanup();
  }
});

test('doDerail: idempotent — a second run finds NO manifest listing the member, no-op (changed:false), no crash, no extra commit (plan 1478)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    withSessionId('derail-test-sess', () => {
      doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-03-x', host: 'H' });
      doDerail(r.dir, '1362', {});
      r.g('fetch', '-q', 'origin', 'master');
      const commitsAfterFirst = r.g('rev-list', '--count', 'origin/master').trim();

      const res2 = doDerail(r.dir, '1362', {});
      assert.equal(res2.changed, false, 'no manifest still lists 1362 → no-op');
      // idempotent release: the ref is already gone → releaseClaim reports already-gone/unheld,
      // never throws.
      assert.equal(res2.released.released ? true : res2.released.reason !== undefined, true);

      r.g('fetch', '-q', 'origin', 'master');
      const commitsAfterSecond = r.g('rev-list', '--count', 'origin/master').trim();
      assert.equal(commitsAfterSecond, commitsAfterFirst, 'no extra commit on the no-op re-run');
    });
  } finally {
    r.cleanup();
  }
});

test('doDerail: derailing the LAST surviving member DISSOLVES the batch — manifest + batch.md folder deleted, not left members:[] (review-fix)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    withSessionId('derail-dissolve-sess', () => {
      // Seed a proposed batch.md folder so the dissolve exercises the folder-removal path too.
      const batchMdRel = 'docs/superpowers/batches/batch-2026-07-03-x/batch.md';
      const batchMdAbs = join(r.dir, ...batchMdRel.split('/'));
      mkdirSync(dirname(batchMdAbs), { recursive: true });
      writeFileSync(
        batchMdAbs,
        [
          '---',
          'slug: batch-2026-07-03-x',
          'lane: 🟩',
          'members: [1362, 1365]',
          'gate: null',
          'status: proposed',
          '---',
          '',
          '# batch-2026-07-03-x',
          '',
          'Theme.',
          '',
        ].join('\n'),
      );
      r.g('add', '-A');
      r.g('commit', '-qm', 'seed proposed batch folder');
      r.g('push', '-q', 'origin', 'master');

      doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-03-x', host: 'H' });
      const manifestRel = 'docs/superpowers/batches/batch-2026-07-03-x/manifest.json';

      // Derail the first member — ordinary path, batch survives with one member.
      const res1 = doDerail(r.dir, '1362', {});
      assert.equal(res1.dissolved, false, 'batch survives while a member remains');
      r.g('fetch', '-q', 'origin', 'master');
      assert.deepEqual(JSON.parse(r.g('show', `origin/master:${manifestRel}`)).members, ['1365']);

      // Derail the LAST member — DISSOLVES the batch.
      const res2 = doDerail(r.dir, '1365', {});
      assert.equal(res2.changed, true);
      assert.equal(res2.dissolved, true, 'last-member derail dissolves the batch');
      assert.equal(res2.slug, 'batch-2026-07-03-x');

      r.g('fetch', '-q', 'origin', 'master');
      // (a) manifest deleted — NOT written as a stuck members:[] (landing-queue's manifestExists
      // now reads false, so no permanently-stuck queue slot; no future done-worktree hard-error).
      assert.throws(
        () => r.g('show', `origin/master:${manifestRel}`),
        'the dissolved batch manifest must be gone, not an empty-members artifact',
      );
      // (b) the batch.md folder file is gone too — the batch drops off the live roster.
      assert.throws(
        () => r.g('show', `origin/master:${batchMdRel}`),
        'the dissolved batch.md must be removed so the folder leaves the roster',
      );
      // (c) both member board rows removed.
      const board = r.g('show', 'origin/master:docs/handoff/board.md');
      assert.doesNotMatch(board, /1362-DQ-a/);
      assert.doesNotMatch(board, /1365-Infra-b/);
      // (d) both claim refs released.
      assert.doesNotMatch(r.lsClaims(), /refs\/claims\/136[25]/, 'both claims released');
    });
  } finally {
    r.cleanup();
  }
});

test('doDerail: a member RENAMED while claimed (execModel Infra→FABLE stamp) still gets its board row removed — keyed by plan id, no orphan (plan 1801)', () => {
  const r = makeRepoWithPlans([{ basename: '1362-Infra-a.md' }, { basename: '1365-Infra-b.md' }]);
  try {
    withSessionId('derail-rename-sess', () => {
      doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-13-x', host: 'H' });

      // The acquire projected onto origin/master via the disposable coord-checkout — sync the
      // fixture's working tree before renaming the (now in-progress/) plan file locally.
      r.g('fetch', '-q', 'origin', 'master');
      r.g('reset', '-q', '--hard', 'origin/master');

      // Mid-train re-verdict: the edit-plan execModel stamp RENAMES the claimed plan's file.
      // The board row, created at claim time, still carries the OLD slug `1362-Infra-a` —
      // the exact coord-spine9 1785 desync this plan pins.
      r.g(
        'mv',
        'docs/superpowers/plans/in-progress/1362-Infra-a.md',
        'docs/superpowers/plans/in-progress/1362-FABLE-a.md',
      );
      r.g('commit', '-qm', 'docs(plans): stamp 1362 execModel fable (renames the file)');
      r.g('push', '-q', 'origin', 'master');

      const res = doDerail(r.dir, '1362', {});
      assert.equal(res.changed, true);
      assert.deepEqual(
        res.removedRowSlugs,
        ['1362-Infra-a'],
        'the OLD-slug row is found via the stable plan id and removed',
      );

      r.g('fetch', '-q', 'origin', 'master');
      const board = r.g('show', 'origin/master:docs/handoff/board.md');
      assert.doesNotMatch(board, /1362-Infra-a/, 'no orphaned old-slug row (the 1785 incident)');
      assert.match(board, /1365-Infra-b/, 'survivor row untouched');
      const manifest = JSON.parse(
        r.g('show', 'origin/master:docs/superpowers/batches/batch-2026-07-13-x/manifest.json'),
      );
      assert.deepEqual(manifest.members, ['1365']);
    });
  } finally {
    r.cleanup();
  }
});

test('projectDerail: reconciles a GRANDFATHERED legacy-path manifest (docs/handoff/batches/<slug>.json) (plan 1467/1478)', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md', folder: 'in-progress' },
    { basename: '1365-Infra-b.md', folder: 'in-progress' },
  ]);
  try {
    // Seed a batch whose manifest lives at the LEGACY path (a batch claimed before plan 1467's
    // folder migration) + the two member board rows.
    const legacyRel = 'docs/handoff/batches/batch-legacy-x.json';
    const legacyAbs = join(r.dir, ...legacyRel.split('/'));
    mkdirSync(dirname(legacyAbs), { recursive: true });
    writeFileSync(
      legacyAbs,
      JSON.stringify(
        {
          slug: 'batch-legacy-x',
          sessionNum: 9,
          host: 'H',
          created: 'x',
          members: ['1362', '1365'],
        },
        null,
        2,
      ) + '\n',
    );
    const boardAbs = join(r.dir, 'docs', 'handoff', 'board.md');
    writeFileSync(
      boardAbs,
      [
        '# Board',
        '<!-- BOARD-START -->',
        '| Worktree | Branch tip | State | Plan / claim | Last touched | Resume |',
        '|---|---|---|---|---|---|',
        '| 1362-DQ-a | `PENDING` | 🔄 ACTIVE | [in-progress/1362-DQ-a.md] | 2026 | — |',
        '| 1365-Infra-b | `PENDING` | 🔄 ACTIVE | [in-progress/1365-Infra-b.md] | 2026 | — |',
        '<!-- BOARD-END -->',
        '',
      ].join('\n'),
    );
    r.g('add', '-A');
    r.g('commit', '-qm', 'seed legacy batch');
    r.g('push', '-q', 'origin', 'master');

    const res = projectDerail(r.dir, { planId: '1362' });
    assert.equal(res.changed, true);
    assert.equal(res.slug, 'batch-legacy-x');
    assert.equal(res.manifestRel, legacyRel, 'resolved the legacy manifest path');

    r.g('fetch', '-q', 'origin', 'master');
    const manifest = JSON.parse(r.g('show', `origin/master:${legacyRel}`));
    assert.deepEqual(manifest.members, ['1365']);
    const board = r.g('show', 'origin/master:docs/handoff/board.md');
    assert.doesNotMatch(board, /1362-DQ-a/);
    assert.match(board, /1365-Infra-b/);
  } finally {
    r.cleanup();
  }
});

// plan 2034: waiting-grill/ (the batched operator-grilling lane) joins STATUS_ORDER,
// so a plan parked there is claimable via activePathFor — the same operator-directed
// override posture as every other waiting lane (a normal exit is a /grill-lane session
// recording rulings and routing it out, not a direct pickup).
test('activePathFor: finds a plan parked in waiting-grill/ (plan 2034)', () => {
  const { dir, cleanup } = makeBareOrigin();
  try {
    const rel = seedPlan(dir, 'waiting-grill', '458-Infra-grillme.md');
    assert.equal(activePathFor(dir, '458'), rel);
  } finally {
    cleanup();
  }
});

// --- plan 2426: the write-time board gate on the claim paths -------------------------
//
// Acceptance criteria 1 + 2, demonstrated against the real bare-origin sandbox (the plan
// asks for a test, "not an argument"): a claim of a plan carrying a LIVE **Blocked-by:**
// line is REFUSED; `--blocked-ok "<note>"` overrides it and keeps the live line verbatim;
// a now-STALE line is dropped by the claim itself.

// ONE declaration line for both cases on purpose: whether it is LIVE or STALE is decided
// entirely by plan 2357's own folder + shipped-stamp below, never by how the line is worded.
const BLOCKED_BY_2357 = '**Blocked-by:** plan 2357 — must land first.';

// A shipped blocker: archived AND carrying the ✅ COMPLETED stamp. Archive presence alone
// is deliberately not enough (plan 1836), so the stamp is what makes the line STALE.
const shippedBlocker = {
  folder: 'archive',
  basename: '2357-Pipe-blocker.md',
  status: '**Status:** ✅ COMPLETED — landed 2026-07-25.',
};
const openBlocker = { folder: 'ready', basename: '2357-Pipe-blocker.md' };

test('2426 A1: acquire of a plan with a LIVE Blocked-by is REFUSED by the board gate', () => {
  const r = makeRepoWithPlans([
    openBlocker,
    { basename: '2358-Coord-x.md', bodyExtra: BLOCKED_BY_2357 },
  ]);
  try {
    assert.throws(
      () => doAcquire(r.dir, '2358', { slug: '2358-Coord-x', host: 'H' }),
      (e) => {
        assert.match(e.message, /REFUSING this write/);
        assert.match(e.message, /open blockers: 2357/);
        return true;
      },
    );
    // The refusal releases the just-won ref (doAcquire's projection-failure rollback), so a
    // retry after the operator re-files the plan starts clean instead of fighting a leak.
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/2358/, 'no leaked claim ref');
    // …and NOTHING reached origin/master: the plan is still in ready/, un-flipped.
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.match(tree, /ready\/2358-Coord-x\.md/);
    assert.doesNotMatch(tree, /in-progress\/2358-Coord-x\.md/);
  } finally {
    r.cleanup();
  }
});

test('2426 A1: --blocked-ok "<note>" claims through, keeps the LIVE line VERBATIM, records the Override', () => {
  const r = makeRepoWithPlans([
    openBlocker,
    { basename: '2358-Coord-x.md', bodyExtra: BLOCKED_BY_2357 },
  ]);
  try {
    const res = doAcquire(r.dir, '2358', {
      slug: '2358-Coord-x',
      host: 'H',
      'blocked-ok': 'working the un-blocked half — operator 2026-07-26',
    });
    assert.equal(res.won, true);
    assert.equal(res.projected, true);
    r.g('fetch', '-q', 'origin', 'master');
    const body = r.g('show', 'origin/master:docs/superpowers/plans/in-progress/2358-Coord-x.md');
    assert.match(body, /🔄 IN PROGRESS/);
    assert.match(
      body,
      /\*\*Blocked-by:\*\* plan 2357 — must land first\./,
      'a LIVE line stays verbatim on an override claim — the plan really IS part-blocked',
    );
    assert.match(
      body,
      /\*\*Override:\*\* claimed via `--blocked-ok`[\s\S]*working the un-blocked half/,
      'the note is the audit trail',
    );
  } finally {
    r.cleanup();
  }
});

test('2426 A1: --blocked-ok rejects a flag-shaped or empty note (mirrors --stub-ok)', () => {
  const r = makeRepoWithPlans([{ basename: '2358-Coord-x.md' }]);
  try {
    assert.throws(
      () =>
        doAcquire(r.dir, '2358', {
          slug: '2358-Coord-x',
          'blocked-ok': '--host',
          'lock-only': true,
        }),
      /--blocked-ok requires a non-flag authorization note/,
    );
    assert.throws(
      () =>
        doAcquire(r.dir, '2358', { slug: '2358-Coord-x', 'blocked-ok': '  ', 'lock-only': true }),
      /--blocked-ok "<authorization note>" must be a non-empty note/,
    );
    assert.doesNotMatch(r.lsClaims(), /refs\/claims\/2358/, 'validated before any ref is touched');
  } finally {
    r.cleanup();
  }
});

test('2426 A2: a now-STALE Blocked-by is DROPPED by the claim itself (no --blocked-ok needed)', () => {
  const r = makeRepoWithPlans([
    shippedBlocker,
    { basename: '2408-Coord-y.md', bodyExtra: BLOCKED_BY_2357 },
  ]);
  try {
    const res = doAcquire(r.dir, '2408', { slug: '2408-Coord-y', host: 'H' });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    const body = r.g('show', 'origin/master:docs/superpowers/plans/in-progress/2408-Coord-y.md');
    assert.doesNotMatch(body, /Blocked-by/, 'the dead line does not ride into in-progress/');
    assert.match(body, /🔄 IN PROGRESS/);
    assert.doesNotMatch(body, /--blocked-ok/, 'a stale line is not an override — no note recorded');
  } finally {
    r.cleanup();
  }
});

test('2426 A1: batch claim is gated too — one blocked member refuses the WHOLE batch, no ref leaks', () => {
  const r = makeRepoWithPlans([
    openBlocker,
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md', bodyExtra: BLOCKED_BY_2357 },
  ]);
  try {
    assert.throws(
      () => doAcquireBatch(r.dir, ['1362', '1365'], { slug: 'batch-2026-07-26-x', host: 'H' }),
      /REFUSING this write[\s\S]*open blockers: 2357/,
    );
    // doAcquireBatch's releaseAll runs on a projection throw — the CLEAN member's ref must
    // not be stranded by its sibling's refusal.
    assert.equal(readHolder(r.dir, '1362'), null);
    assert.equal(readHolder(r.dir, '1365'), null);
    r.g('fetch', '-q', 'origin', 'master');
    const tree = r.g('ls-tree', '-r', '--name-only', 'origin/master');
    assert.doesNotMatch(tree, /in-progress\/1362-DQ-a\.md/, 'nothing half-projected');
  } finally {
    r.cleanup();
  }
});

test('2426 A2: batch claim drops a STALE line on the member that has one', () => {
  const r = makeRepoWithPlans([
    shippedBlocker,
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md', bodyExtra: BLOCKED_BY_2357 },
  ]);
  try {
    const res = doAcquireBatch(r.dir, ['1362', '1365'], {
      slug: 'batch-2026-07-26-y',
      host: 'H',
    });
    assert.equal(res.won, true);
    r.g('fetch', '-q', 'origin', 'master');
    assert.doesNotMatch(
      r.g('show', 'origin/master:docs/superpowers/plans/in-progress/1365-Infra-b.md'),
      /Blocked-by/,
    );
  } finally {
    r.cleanup();
  }
});

// --- plan 2891 T5 item (3): freshen origin ONCE before the pin; release won refs on a THROW ---

test('plan 2891 T5(3): doAcquireBatch releases every ref already won when a later acquire THROWS', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md' },
    { basename: '1366-Infra-c.md' },
  ]);
  try {
    // A clean CAS LOSS was already all-or-release; a THROWN acquire (the transient network /
    // ref-lock failure, i.e. the one that most plausibly interrupts a train mid-acquire) was
    // not — it escaped with every earlier member's ref still held, reading 🔒 CLAIMED to every
    // drain until someone force-released it by hand.
    let calls = 0;
    const acquireRefThatDiesOnTheThird = (dir, opts) => {
      if (++calls === 3) throw new Error('simulated transient ref push failure');
      return acquireRef(dir, opts);
    };
    assert.throws(
      () =>
        doAcquireBatch(
          r.dir,
          ['1362', '1365', '1366'],
          { slug: 'batch-2026-08-05-throw', host: 'H' },
          { acquireRef: acquireRefThatDiesOnTheThird },
        ),
      /simulated transient ref push failure/,
    );
    assert.equal(readHolder(r.dir, '1362'), null, '1362 was released, not leaked');
    assert.equal(readHolder(r.dir, '1365'), null, '1365 was released, not leaked');
    assert.equal(readClaimRefTip(r.dir, '1366'), null, 'the throwing member never won a ref');
  } finally {
    r.cleanup();
  }
});

test('plan 2891 T5(3): the origin freshen runs BEFORE the eligibility pin, and exactly once per claim', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md' },
    { basename: '1366-Infra-c.md' },
  ]);
  try {
    // The pin-once design (plan 2395) is preserved — the fetch is a strict PREFIX of it, never a
    // mid-flow re-resolution — so all the spy has to prove is ordering and arity.
    const seen = [];
    doAcquire(
      r.dir,
      '1362-DQ-a',
      { slug: '1362-DQ-a', 'lock-only': true },
      { freshenOrigin: (d) => seen.push(d) },
    );
    assert.deepEqual(seen, [r.dir], 'doAcquire freshens origin exactly once, for this checkout');

    // The batch path pins ONE sha for every member's body AND coord.config.json, so it needs the
    // same prefix freshen.
    const seenBatch = [];
    doAcquireBatch(
      r.dir,
      ['1365', '1366'],
      { slug: 'batch-2026-08-05-freshen', host: 'H', 'lock-only': true },
      { freshenOrigin: (d) => seenBatch.push(d) },
    );
    assert.deepEqual(seenBatch, [r.dir], 'doAcquireBatch freshens origin exactly once too');
  } finally {
    r.cleanup();
  }
});

// --- plan 2891 review round 2 (CONFIRMED) --------------------------------------------------

test('plan 2891 review round 2: a FAILED origin fetch does not latch — a later claim retries it', () => {
  const r = makeRepoWithPlans([{ basename: '1362-DQ-a.md' }]);
  try {
    // Latching BEFORE the fetch meant one transient failure suppressed every later refresh for
    // the life of the process, silently reinstating the stale-ref judgement this closes. Drive
    // the real function (the latch lives in it, not in the injectable seam the call sites take):
    // origin is broken first, then repaired, and the repaired fetch must actually happen.
    const good = execFileSync('git', ['-C', r.dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['-C', r.dir, 'remote', 'set-url', 'origin', join(r.dir, 'no-such-remote')],
      {
        encoding: 'utf8',
      },
    );
    freshenOriginOnce(r.dir); // swallowed failure — must NOT latch
    execFileSync('git', ['-C', r.dir, 'remote', 'set-url', 'origin', good], { encoding: 'utf8' });

    // Prove the second call really fetched: advance origin/master from a sibling clone and check
    // that this checkout's remote-tracking ref moves.
    const before = execFileSync('git', ['-C', r.dir, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
    }).trim();
    const sib = mkdtempSync(join(tmpdir(), 'freshen-sib-'));
    execFileSync('git', ['clone', '-q', r.origin, sib]);
    execFileSync('git', ['-C', sib, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', sib, 'config', 'user.name', 'T']);
    writeFileSync(join(sib, 'advance.txt'), 'x\n');
    execFileSync('git', ['-C', sib, 'add', 'advance.txt']);
    execFileSync('git', ['-C', sib, 'commit', '-qm', 'advance origin']);
    execFileSync('git', ['-C', sib, 'push', '-q', 'origin', 'master']);
    rmSync(sib, { recursive: true, force: true });

    freshenOriginOnce(r.dir);
    assert.notEqual(
      execFileSync('git', ['-C', r.dir, 'rev-parse', 'origin/master'], { encoding: 'utf8' }).trim(),
      before,
      'the retry actually fetched — a latch set by the failed attempt would have skipped it',
    );
  } finally {
    r.cleanup();
  }
});

test('plan 2891 review round 2: batch release is a LEASED delete — it cannot clobber a ref re-acquired in the window', () => {
  const r = makeRepoWithPlans([
    { basename: '1362-DQ-a.md' },
    { basename: '1365-Infra-b.md' },
    { basename: '1366-Infra-c.md' },
  ]);
  const dir2 = mkdtempSync(join(tmpdir(), 'batch-rival-'));
  try {
    const g2 = (...a) => execFileSync('git', ['-C', dir2, ...a], { encoding: 'utf8' });
    g2('init', '-q', '-b', 'master');
    g2('config', 'user.email', 't@t.t');
    g2('config', 'user.name', 'T');
    g2('config', 'commit.gpgsign', 'false');
    g2('remote', 'add', 'origin', r.origin);

    let calls = 0;
    const acquireThenRivalSteals = (dir, opts) => {
      const res = acquireRef(dir, opts);
      calls += 1;
      if (calls === 1) {
        // 1362 is ours. Now simulate the exact race the lease exists for: it is released by
        // some other cleanup and a RIVAL re-acquires it before our rollback runs.
        //
        // plan 3756: releasing is a tombstone append, not a delete (the proxy 403s deletes),
        // and the rival's re-acquire fast-forwards over that tombstone. The lease survives
        // the change in a new shape — our rollback tombstone is parented on OUR claim commit,
        // so once the rival has appended, it is no longer a fast-forward and origin rejects
        // it, exactly as --force-with-lease refused the old delete.
        releaseOwnClaimRef(dir, '1362', res.sha, { reason: 'simulated foreign cleanup' });
        acquireRef(dir2, {
          planId: '1362',
          message: 'claim plan=1362\nsession=RIVAL\nhost=RIVAL-HOST\niso=2026-08-05T00:00:00Z\n',
        });
      }
      if (calls === 2) throw new Error('simulated transient ref push failure');
      return res;
    };
    assert.throws(
      () =>
        doAcquireBatch(
          r.dir,
          ['1362', '1365'],
          { slug: 'batch-2026-08-05-lease', host: 'H' },
          { acquireRef: acquireThenRivalSteals },
        ),
      /simulated transient ref push failure/,
    );
    const holder = parseClaimMessage(readHolder(r.dir, '1362').body);
    assert.equal(
      holder.sessionUuid,
      'RIVAL',
      "the rival's live claim survived our rollback — a bare delete would have clobbered it",
    );
  } finally {
    rmSync(dir2, { recursive: true, force: true });
    r.cleanup();
  }
});

// ───────────── plan 3554: verify unique ref sha after a push transport failure ─────────────

const PLAN_3554_SHA = '1111111111111111111111111111111111111111';
// plan 3756: these assertions are about the VERIFY-after-a-thrown-push behaviour, not about
// which namespace the claim lives in, so they take the ref from the seam and follow the flip.
const PLAN_3554_REF = refForPlan('3554');
const PLAN_3554_REF_RX = PLAN_3554_REF.replace(/[/]/g, '\\/');

function plan3554PushError(message = 'transport failed after send') {
  const error = new Error(message);
  error.stderr = message;
  return error;
}

function plan3554AcquireGit(lsRemoteResult) {
  const calls = [];
  const gitImpl = (_dir, args) => {
    calls.push(args);
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw plan3554PushError();
    if (args[0] === 'ls-remote') {
      if (lsRemoteResult instanceof Error) throw lsRemoteResult;
      return lsRemoteResult;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  return { calls, gitImpl };
}

test('plan 3554: acquireRef recovers a landed win after the push transport throws', () => {
  const ref = refForPlan('3554');
  const fake = plan3554AcquireGit(`${PLAN_3554_SHA}\t${ref}\n`);
  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(
      acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
      { won: true, ref, sha: PLAN_3554_SHA },
    );
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      new RegExp(`WARNING.*${PLAN_3554_REF_RX}.*transport failed after send`, 's'),
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('plan 3554: acquireRef reports lost when verification finds a foreign sha', () => {
  const ref = refForPlan('3554');
  const fake = plan3554AcquireGit(`${'2'.repeat(40)}\t${ref}\n`);
  assert.deepEqual(
    acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
    { won: false, lost: true, ref },
  );
});

test('plan 3554: acquireRef preserves the push failure when verification finds no ref', () => {
  const fake = plan3554AcquireGit('');
  assert.throws(
    () => acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
    new RegExp(`push to ${PLAN_3554_REF_RX} failed.*transport failed after send`, 's'),
  );
});

test('plan 3554: acquireRef names both failures when verification also throws', () => {
  const fake = plan3554AcquireGit(new Error('ls-remote unavailable'));
  assert.throws(
    () => acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
    (error) => {
      assert.match(error.message, /transport failed after send/);
      assert.match(error.message, /ls-remote unavailable/);
      return true;
    },
  );
});

test('plan 3554: acquireRef does not verify a normal non-ff loss', () => {
  const fake = plan3554AcquireGit('must not be read');
  const nonFastForward = plan3554PushError('[rejected] claim -> claim (non-fast-forward)');
  fake.gitImpl = (_dir, args) => {
    fake.calls.push(args);
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw nonFastForward;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.deepEqual(
    acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
    { won: false, lost: true, ref: PLAN_3554_REF },
  );
  // plan 3554's point was that an ORDINARY contention loss must not do recovery work. That
  // still holds, but plan 3756 changed what "ordinary" costs: a non-ff no longer proves a
  // live holder, since a released claim is now a tombstone the ref still points at, so the
  // tip is read once to tell the two apart. What must NOT happen is a second push — no
  // re-acquire, no verification write — and that is what this now asserts.
  assert.equal(fake.calls.filter((args) => args[0] === 'push').length, 1);
});

function plan3554CounterGit(verificationResult) {
  let lsRemoteCalls = 0;
  return (_dir, args) => {
    if (args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      // The counter is ABSENT at mint time — that is this fixture's premise. Since plan
      // 3756 "absent" takes TWO reads, not one: the live counter ref, then the retired
      // `refs/coord/session-counter` the new one seeds itself from. Both must answer
      // empty, or the seed path would fetch a ref this fake does not serve. Reads from
      // the third on are the post-push verification the tests are actually about.
      return lsRemoteCalls <= 2 ? '' : verificationResult;
    }
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw plan3554PushError('counter transport failed');
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

test('plan 3554: mintSessionNumber returns its number when the thrown push landed', () => {
  const gitImpl = plan3554CounterGit(`${PLAN_3554_SHA}\t${coordRef('session-counter')}\n`);
  assert.equal(mintSessionNumber('/fake', { gitImpl }), 1);
});

test('plan 3554: mintSessionNumber preserves the push failure when the counter ref is absent', () => {
  const gitImpl = plan3554CounterGit('');
  assert.throws(() => mintSessionNumber('/fake', { gitImpl }), /counter transport failed/);
});

test('plan 3554 rework F1: verification ignores other refs, peel lines, and noise', () => {
  const requestedRef = PLAN_3554_REF;
  const fake = plan3554AcquireGit(
    [
      `${PLAN_3554_SHA}\trefs/claims/other`,
      `${PLAN_3554_SHA}\t${requestedRef}^{}`,
      'remote helper diagnostic noise',
      '',
    ].join('\n'),
  );
  assert.throws(
    () => acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
    new RegExp(`push to ${PLAN_3554_REF_RX} failed.*transport failed after send`, 's'),
  );
});

test('plan 3554 rework F2: failed-push verification caps ls-remote', () => {
  let lsRemoteOptions;
  const gitImpl = (_dir, args, options) => {
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw plan3554PushError();
    if (args[0] === 'ls-remote') {
      lsRemoteOptions = options;
      return '';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.throws(
    () => acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl }),
    /transport failed after send/,
  );
  // plan 4087 T2 (S3): ls-remote is now capped by the ONE derived cap (derivedReadTimeoutMs),
  // not a bare CLAIM_READ_TIMEOUT_MS/lsRemoteTimed-default constant. For '/fake' (no real
  // journal) there is no measurement, so the derivation answers with its CEILING (30000) — an
  // unknown box gets the generous cap, never the retired 5s one. See the source-check test and
  // the T2 retry test below for the parts a numeric-equality assertion alone cannot show.
  assert.equal(lsRemoteOptions.timeout, 30000);
});

// plan 4087 T2 (S3): CLAIM_READ_TIMEOUT_MS retired — every former site now shares the ONE
// derived cap, either via lsRemoteTimed's own default or by calling derivedReadTimeoutMs(mainDir)
// directly for the fetch-shaped calls lsRemoteTimed's ls-remote-only shape cannot cover.
test('plan 4087 T2 (S3): CLAIM_READ_TIMEOUT_MS no longer exists as a module constant (source check)', () => {
  const src = readFileSync(new URL('./claim-plan.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src,
    /CLAIM_READ_TIMEOUT_MS/,
    'every former site must route through the shared derived cap, never a second hardcoded constant',
  );
});

// plan 4087 T2 (S3): the ONE retry with a doubled cap, at the read whose failure used to make
// `acquireRef` throw a hard "push failed AND verification failed" error instead of degrading to
// a plain `lost` — see verifyRemoteRef's own header comment for why this is the read the ledger's
// acquire-gives-up incidents are actually about. A single ETIMEDOUT on the first read must not
// fail the claim when the retry (at 2x the cap) succeeds.
test('plan 4087 T2 (S3): acquireRef retries a timed-out verification ONCE with a doubled cap, and still wins', () => {
  const ref = refForPlan('3554');
  const lsRemoteOpts = [];
  let lsRemoteAttempt = 0;
  const gitImpl = (_dir, args, opts) => {
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw plan3554PushError();
    if (args[0] === 'ls-remote') {
      lsRemoteAttempt += 1;
      lsRemoteOpts.push(opts);
      if (lsRemoteAttempt === 1) {
        const e = new Error('ls-remote ETIMEDOUT');
        e.code = 'ETIMEDOUT';
        throw e;
      }
      return `${PLAN_3554_SHA}\t${ref}\n`;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(
      acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl }),
      { won: true, ref, sha: PLAN_3554_SHA },
      'a timed-out-then-successful verification must still report the real win, never a false loss or a thrown error',
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(
    lsRemoteAttempt,
    2,
    'exactly ONE retry — never zero (the timeout must not be swallowed) and never more than one',
  );
  assert.ok(
    lsRemoteOpts[1].timeout > lsRemoteOpts[0].timeout,
    'the retry must use a STRICTLY larger (doubled) cap than the first attempt',
  );
  assert.equal(
    lsRemoteOpts[1].timeout,
    lsRemoteOpts[0].timeout * 2,
    "the retry cap must be exactly double the first attempt's cap",
  );
});

test('plan 4087 T2 (S3): a NON-timeout verification failure is never retried', () => {
  const realErr = new Error('ls-remote: permission denied');
  let lsRemoteCalls = 0;
  const gitImpl = (_dir, args) => {
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') throw plan3554PushError();
    if (args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      throw realErr;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.throws(
    () => acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl }),
    (error) => {
      assert.match(error.message, /permission denied/);
      return true;
    },
  );
  assert.equal(
    lsRemoteCalls,
    1,
    'an ordinary (non-timeout) failure must surface immediately, never retried',
  );
});

test('plan 3554 rework F3: unchanged counter tip preserves the original push failure', () => {
  const oldSha = '3'.repeat(40);
  let pushCalls = 0;
  let lsRemoteCalls = 0;
  const original = plan3554PushError('counter permission denied');
  const gitImpl = (_dir, args) => {
    if (args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      return `${oldSha}\trefs/coord/session-counter\n`;
    }
    if (args[0] === 'fetch') return '';
    if (args[0] === 'cat-file') return 'tree tree\n\nsession=8\n';
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${PLAN_3554_SHA}\n`;
    if (args[0] === 'push') {
      pushCalls += 1;
      throw original;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.throws(
    () => mintSessionNumber('/fake', { gitImpl }),
    (error) => error === original,
  );
  assert.equal(pushCalls, 1);
  // plan 3756: three reads, not two — the live counter, the RETIRED counter (whose value is
  // taken into account on every mint so a pre-flip session that ran ahead cannot have its
  // numbers reissued), and the post-failure verification this test is about.
  assert.equal(lsRemoteCalls, 3);
});

test('plan 3554 rework F4: identical counter inputs produce unique parseable commit bodies', async () => {
  const messages = [];
  let commitNumber = 0;
  const gitImpl = (_dir, args) => {
    if (args[0] === 'ls-remote') return '';
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') {
      messages.push(args[args.indexOf('-m') + 1]);
      commitNumber += 1;
      return `${String(commitNumber).repeat(40)}\n`;
    }
    if (args[0] === 'push') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.equal(mintSessionNumber('/fake', { gitImpl }), 1);
  assert.equal(mintSessionNumber('/fake', { gitImpl }), 1);
  const { nextSessionNumber: parseCounterMessage } = await import('./claim-plan-lib.mjs');
  assert.equal(parseCounterMessage(messages[0]), 2);
  assert.equal(parseCounterMessage(messages[1]), 2);
  assert.notEqual(messages[0], messages[1]);
});

test('plan 3554 rework F5: verified foreign holder warns once while returning lost', () => {
  const ref = refForPlan('3554');
  const fake = plan3554AcquireGit(`${'4'.repeat(40)}\t${ref}\n`);
  const warnings = [];
  const originalConsoleError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  try {
    assert.deepEqual(
      acquireRef('/fake', { planId: '3554', message: 'claim', gitImpl: fake.gitImpl }),
      { won: false, lost: true, ref },
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    new RegExp(`WARNING.*${PLAN_3554_REF_RX}.*transport failed after send`, 's'),
  );
});

// --- plan 4136 E5: the three coord push sites get a measured deadline ------------
//
// 4087's review (findings 1g1m81 mirror / 1s9uvj1 counter / 149q8uz projection) flagged all
// three as still uncapped. Every case below drives the timeout purely through the injectable
// `gitImpl`/`_git` seam — a real ETIMEDOUT-shaped Error, exactly like coord-git.test.mjs's own
// boundedGit fixtures — never a real clock or a real git process.
function etimedout(message) {
  const e = new Error(message);
  e.code = 'ETIMEDOUT';
  return e;
}

test('plan 4136 E5 (1g1m81): mirrorLegacyCounter push timeout is swallowed — best-effort mirror unaffected', () => {
  const legacySha = 'a'.repeat(40);
  const legacyRef = legacyCoordRef('session-counter');
  const calls = [];
  const gitImpl = (_dir, args, opts) => {
    calls.push(args[0]);
    if (args[0] === 'ls-remote') return `${legacySha}\t${legacyRef}\n`;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'cat-file') return 'tree tree\n\nsession=3\nnonce=x\n'; // nextSessionNumber -> 4
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${'b'.repeat(40)}\n`;
    if (args[0] === 'push') throw etimedout('legacy counter push ETIMEDOUT');
    throw new Error(`unexpected git call: ${args.join(' ')} (opts=${JSON.stringify(opts)})`);
  };
  // n=5 > nextSessionNumber(body)=4, so the early "never lower it" return does not fire and
  // the push actually gets attempted — the case this test needs to exercise the timeout.
  assert.doesNotThrow(() => mirrorLegacyCounter('/fake', 5, { gitImpl }));
  assert.ok(calls.includes('push'), 'the mirror push must actually have been attempted');
});

test('plan 4136 E5 (1s9uvj1): counter push timeout -> verifyRemoteRef says ours -> mintSessionNumber returns n', () => {
  const ref = coordRef('session-counter');
  let lsRemoteCalls = 0;
  const commitSha = 'c'.repeat(40);
  const gitImpl = (_dir, args) => {
    if (args[0] === 'ls-remote') {
      lsRemoteCalls += 1;
      // First two reads: live counter absent, legacy counter absent (mirrorLegacyCounter's own
      // read, reached only after a successful — here, verified-successful — counter push).
      // Third: the post-timeout verification this test is about.
      return lsRemoteCalls <= 2 ? '' : `${commitSha}\t${ref}\n`;
    }
    if (args[0] === 'mktree') return 'tree\n';
    if (args[0] === 'commit-tree') return `${commitSha}\n`;
    if (args[0] === 'push') throw etimedout('counter push ETIMEDOUT');
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.equal(mintSessionNumber('/fake', { gitImpl }), 1);
});

// runClaimProjectionRetryLoop's push-timeout branch, driven directly (plan 4136 E5 exported it
// for exactly this — see its own header comment on why no injectable seam previously reached
// it). `applyMutations` is a no-op: the projection commit/board/index logic belongs to
// projectClaim/projectBatchClaim/projectDerail, all out of scope here. Each test below builds
// its own inline `gitImpl` — `symbolic-ref` always fails (masterPushSpec falls back to
// 'HEAD:master' deterministically, without a real repo) and `rev-parse HEAD` stands in for
// "the commit this attempt tried to push".

test('plan 4136 E5 (149q8uz): projection push timeout, origin master == our commit -> success, no second push', () => {
  const masterSha = 'd'.repeat(40);
  let pushAttempt = 0;
  const calls = [];
  const gitImpl = (_dir, args) => {
    calls.push(args[0]);
    if (args[0] === 'symbolic-ref') throw new Error('detached HEAD (fixture)');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${masterSha}\n`;
    if (args[0] === 'push') {
      pushAttempt += 1;
      throw etimedout('projection push ETIMEDOUT');
    }
    if (args[0] === 'ls-remote') return `${masterSha}\trefs/heads/master\n`; // landed despite the kill
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  let onSuccessCalls = 0;
  runClaimProjectionRetryLoop(
    '/fake',
    {},
    {
      applyMutations: () => {},
      onSuccess: () => {
        onSuccessCalls += 1;
      },
      buildBlockedError: (lastErr) => new Error(`blocked: ${lastErr?.message}`),
      gitImpl,
    },
  );
  assert.equal(pushAttempt, 1, 'exactly one push — a verified-landed timeout must never re-push');
  assert.equal(onSuccessCalls, 1);
});

test('plan 4136 E5 (149q8uz): projection push timeout, origin master is a genuinely FOREIGN sha (not an ancestor) -> retries and succeeds on attempt 2', () => {
  const masterSha1 = 'd'.repeat(40);
  const masterSha2 = 'e'.repeat(40);
  const foreignSha = 'f'.repeat(40);
  let pushAttempt = 0;
  let revParseCalls = 0;
  const resetCalls = [];
  const mergeBaseCalls = [];
  const gitImpl = (_dir, args) => {
    if (args[0] === 'symbolic-ref') throw new Error('detached HEAD (fixture)');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      revParseCalls += 1;
      // attempt 1 builds masterSha1; the loop's reset --hard + re-apply (attempt 2) builds a
      // fresh commit, masterSha2 — a real reset would also change what HEAD resolves to.
      return `${revParseCalls === 1 ? masterSha1 : masterSha2}\n`;
    }
    if (args[0] === 'push') {
      pushAttempt += 1;
      if (pushAttempt === 1) throw etimedout('projection push ETIMEDOUT');
      return ''; // attempt 2's push succeeds outright
    }
    if (args[0] === 'ls-remote') return `${foreignSha}\trefs/heads/master\n`; // NOT ours -> ancestry check
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      mergeBaseCalls.push(args);
      // foreignSha shares no history with masterSha1 — git's own exit code for "not an
      // ancestor" is 1 (distinct from every other merge-base failure, which this loop must
      // fail closed on instead — see the sibling-descendant test below for that positive case).
      const e = new Error(`fatal: no ancestor relationship between ${args[2]} and ${args[3]}`);
      e.status = 1;
      throw e;
    }
    if (['fetch', 'reset', 'clean'].includes(args[0])) {
      resetCalls.push(args[0]);
      return '';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  let onSuccessCalls = 0;
  const applyMutationsCalls = [];
  runClaimProjectionRetryLoop(
    '/fake',
    {},
    {
      applyMutations: () => applyMutationsCalls.push(1),
      onSuccess: () => {
        onSuccessCalls += 1;
      },
      buildBlockedError: (lastErr) => new Error(`blocked: ${lastErr?.message}`),
      gitImpl,
    },
  );
  assert.equal(pushAttempt, 2, 'a genuinely-not-landed timeout must be retried, not swallowed');
  assert.equal(mergeBaseCalls.length, 1, 'the ancestry check must actually run once');
  assert.deepEqual(
    resetCalls,
    ['fetch', 'fetch', 'reset', 'clean'],
    'the ancestry-check fetch runs once (verification), then the SAME reset-hard-and-reapply ' +
      'step any other recoverable push failure gets',
  );
  assert.equal(applyMutationsCalls.length, 2, 'applyMutations re-runs on the retried attempt');
  assert.equal(onSuccessCalls, 1);
});

test('plan 4136 E5 (149q8uz): projection push timeout, origin master is a DESCENDANT of our commit (sibling pushed on top) -> success, no second push, no reset', () => {
  const localCommit = 'd'.repeat(40);
  const siblingSha = 'e'.repeat(40); // a sibling's commit, pushed on top of ours, after our push landed
  let pushAttempt = 0;
  const mergeBaseCalls = [];
  const resetCalls = [];
  const gitImpl = (_dir, args) => {
    if (args[0] === 'symbolic-ref') throw new Error('detached HEAD (fixture)');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${localCommit}\n`;
    if (args[0] === 'push') {
      pushAttempt += 1;
      throw etimedout('projection push ETIMEDOUT');
    }
    // origin/master now points at the sibling's commit, not ours -> plain sha equality (the
    // 'ours' fast path) says "not landed". It DID land: the sibling built on top of it.
    if (args[0] === 'ls-remote') return `${siblingSha}\trefs/heads/master\n`;
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      mergeBaseCalls.push(args);
      return ''; // exit 0: localCommit IS an ancestor of siblingSha
    }
    if (['fetch', 'reset', 'clean'].includes(args[0])) {
      resetCalls.push(args[0]);
      return '';
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  let onSuccessCalls = 0;
  runClaimProjectionRetryLoop(
    '/fake',
    {},
    {
      applyMutations: () => {},
      onSuccess: () => {
        onSuccessCalls += 1;
      },
      buildBlockedError: () => new Error('must not reach the blocked-after-N-attempts path'),
      gitImpl,
    },
  );
  assert.equal(pushAttempt, 1, 'a verified-landed-via-ancestry timeout must never re-push');
  assert.equal(mergeBaseCalls.length, 1);
  assert.deepEqual(
    mergeBaseCalls[0],
    ['merge-base', '--is-ancestor', localCommit, siblingSha],
    "must test whether OUR commit is an ancestor of ORIGIN's tip, in that order",
  );
  assert.deepEqual(
    resetCalls,
    ['fetch'],
    'only the ancestry-check fetch runs — the top-of-loop reset --hard + re-apply must never ' +
      'fire for an attempt this loop treats as landed',
  );
  assert.equal(onSuccessCalls, 1);
});

test('plan 4136 E5 (149q8uz): projection push timeout, verification read itself fails -> the ORIGINAL timeout propagates', () => {
  const masterSha = 'd'.repeat(40);
  const verifyReadError = new Error('ls-remote: permission denied');
  let pushAttempt = 0;
  const gitImpl = (_dir, args) => {
    if (args[0] === 'symbolic-ref') throw new Error('detached HEAD (fixture)');
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${masterSha}\n`;
    if (args[0] === 'push') {
      pushAttempt += 1;
      throw etimedout('projection push ETIMEDOUT');
    }
    if (args[0] === 'ls-remote') throw verifyReadError;
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  assert.throws(
    () =>
      runClaimProjectionRetryLoop(
        '/fake',
        {},
        {
          applyMutations: () => {},
          onSuccess: () => {
            throw new Error('onSuccess must never run when the push never verifiably landed');
          },
          buildBlockedError: () => new Error('must not reach the blocked-after-N-attempts path'),
          gitImpl,
        },
      ),
    (error) => {
      // boundedGit wraps the raw ETIMEDOUT into the named COORD_CHECKOUT_TIMEOUT seam before
      // this loop ever sees it — that wrapped error (not the read failure) is what must
      // propagate, with the original ETIMEDOUT preserved as .cause (boundedGit's own contract).
      assert.equal(
        error.code,
        COORD_CHECKOUT_TIMEOUT,
        'the propagated error must be the ORIGINAL push timeout (COORD_CHECKOUT_TIMEOUT), never the read failure',
      );
      assert.equal(error.cause?.code, 'ETIMEDOUT');
      assert.match(error.cause?.message, /projection push ETIMEDOUT/);
      assert.notEqual(
        error,
        verifyReadError,
        'must not propagate the verification read failure itself',
      );
      return true;
    },
  );
  assert.equal(pushAttempt, 1, 'a fail-closed verification failure must not be retried');
});

// --- gcProbeRefs (plan 3812) ------------------------------------------------------
//
// The sibling sweep to gcReleasedClaimRefs, for the probe namespace coord-probe.mjs
// writes to. Unlike a claim ref, a probe ref carries no tombstone requirement — nothing
// ever reads a probe ref back, so ANY ref matching PROBE_GLOB is reap-eligible. Hermetic
// throughout: every case drives the injectable `_git` seam, no network, no real push.

function fakeGcGit({ lsOut = '', pushImpl } = {}) {
  const calls = [];
  const _git = (dir, args, opts) => {
    calls.push(args);
    if (args[0] === 'ls-remote') return lsOut;
    if (args[0] === 'push') {
      if (pushImpl) return pushImpl(args, opts);
      return '';
    }
    throw new Error(`fakeGcGit: unexpected git call: ${args.join(' ')}`);
  };
  return { _git, calls };
}

test('gcProbeRefs: dry run (no --apply) lists candidates and deletes nothing', () => {
  const lsOut = [
    `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t${PROBE_GLOB.replace('*', 'zzz-111')}`,
    `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\t${PROBE_GLOB.replace('*', 'zzz-222')}`,
  ].join('\n');
  const { _git, calls } = fakeGcGit({ lsOut });

  const r = gcProbeRefs('/fake', { _git });

  assert.equal(r.applied, false);
  assert.equal(r.reaped.length, 0);
  assert.equal(r.candidates.length, 2);
  assert.ok(!calls.some((c) => c[0] === 'push'), 'a dry run must never push');
});

test('gcProbeRefs: no PROBE_GLOB refs on origin is a clean no-op', () => {
  const { _git, calls } = fakeGcGit({ lsOut: '' });
  const r = gcProbeRefs('/fake', { _git, apply: true });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.reaped, []);
  assert.ok(!calls.some((c) => c[0] === 'push'));
});

test('gcProbeRefs: --apply deletes each candidate leased to the sha the sweep observed', () => {
  const ref = PROBE_GLOB.replace('*', 'zzz-abc');
  const sha = 'c'.repeat(40);
  const { _git, calls } = fakeGcGit({ lsOut: `${sha}\t${ref}` });

  const r = gcProbeRefs('/fake', { _git, apply: true });

  assert.equal(r.applied, true);
  assert.equal(r.reaped.length, 1);
  assert.deepEqual(r.reaped[0], { ref, sha });
  const pushCall = calls.find((c) => c[0] === 'push');
  assert.ok(pushCall, 'must push a delete for the candidate');
  // Leased to the observed sha, never a blind force — a probe that were somehow
  // re-created between the read and the delete must not have its fresh ref clobbered.
  assert.ok(pushCall.includes(`--force-with-lease=${ref}:${sha}`));
  assert.ok(pushCall.includes(`:${ref}`), 'the refspec must be a delete (":<ref>")');
});

test('gcProbeRefs: a failed delete is reported in `failed`, not silently dropped', () => {
  const ref = PROBE_GLOB.replace('*', 'zzz-fail');
  const sha = 'd'.repeat(40);
  const { _git } = fakeGcGit({
    lsOut: `${sha}\t${ref}`,
    pushImpl: () => {
      throw new Error('fatal: unable to access - 403');
    },
  });

  const r = gcProbeRefs('/fake', { _git, apply: true });

  assert.equal(r.reaped.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].ref, ref);
  assert.match(r.failed[0].error, /403/);
});

test('gcProbeRefs: reuses HUSKY0 for the delete push env, same as gcReleasedClaimRefs', () => {
  const ref = PROBE_GLOB.replace('*', 'zzz-env');
  const sha = 'e'.repeat(40);
  let seenEnv;
  const { _git } = fakeGcGit({
    lsOut: `${sha}\t${ref}`,
    pushImpl: (_args, opts) => {
      seenEnv = opts?.env;
      return '';
    },
  });

  gcProbeRefs('/fake', { _git, apply: true });

  assert.ok(seenEnv, 'the delete push must pass an explicit env');
  assert.equal(seenEnv.HUSKY, '0');
});

test('gcProbeRefs: ignores an ls-remote line that is not actually a probe ref', () => {
  // Defensive: a hermetic caller could stub a wildcard ls-remote and return junk.
  const { _git } = fakeGcGit({ lsOut: `aaaa\trefs/heads/coord/claims/3756\n` });
  const r = gcProbeRefs('/fake', { _git });
  assert.deepEqual(r.candidates, []);
});

// plan 3812 round 2: coordProbe already accepts `--remote` (a probe can be pushed to a
// non-default remote), but gcProbeRefs hard-coded 'origin' on both the ls-remote and the
// delete push — a probe pushed to a non-default remote was never reaped. `remote` defaults to
// 'origin' so the CLI's existing call (which passes nothing) is byte-identical.
test('gcProbeRefs: honours a non-default `remote` option on BOTH the ls-remote and the delete push', () => {
  const ref = PROBE_GLOB.replace('*', 'zzz-remote');
  const sha = 'f'.repeat(40);
  const calls = [];
  const _git = (dir, args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'ls-remote') return `${sha}\t${ref}`;
    if (args[0] === 'push') return '';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const r = gcProbeRefs('/fake', { _git, apply: true, remote: 'upstream' });

  assert.equal(r.reaped.length, 1);
  const lsCall = calls.find((c) => c.args[0] === 'ls-remote');
  assert.ok(lsCall, 'must ls-remote');
  assert.ok(lsCall.args.includes('upstream'), 'ls-remote must target the given remote');
  assert.ok(
    !lsCall.args.includes('origin'),
    'ls-remote must NOT default to origin when given a remote',
  );
  const pushCall = calls.find((c) => c.args[0] === 'push');
  assert.ok(pushCall, 'must push a delete');
  assert.ok(pushCall.args.includes('upstream'), 'delete push must target the given remote');
  assert.ok(
    !pushCall.args.includes('origin'),
    'delete push must NOT default to origin when given a remote',
  );
});

test('gcProbeRefs: default remote stays "origin" when the option is omitted', () => {
  const ref = PROBE_GLOB.replace('*', 'zzz-default');
  const sha = 'a'.repeat(40);
  const { _git, calls } = fakeGcGit({ lsOut: `${sha}\t${ref}` });

  gcProbeRefs('/fake', { _git, apply: true });

  const lsCall = calls.find((c) => c[0] === 'ls-remote');
  assert.ok(lsCall.includes('origin'));
  const pushCall = calls.find((c) => c[0] === 'push');
  assert.ok(pushCall.includes('origin'));
});
