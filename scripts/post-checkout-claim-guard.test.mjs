// scripts/post-checkout-claim-guard.test.mjs  (plan 1022, B)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRefCandidates } from './coord/coord-refs.mjs';
import {
  deriveSlugId,
  evaluateCheckout,
  warnMessage,
  claimRefExists,
} from './post-checkout-claim-guard.mjs';

test('deriveSlugId: parses a worktree-* branch into slug + leading NNN id', () => {
  assert.deepEqual(deriveSlugId('worktree-1022-Infra-harden-mint'), {
    slug: '1022-Infra-harden-mint',
    id: '1022',
  });
  assert.deepEqual(deriveSlugId('worktree-007-P07-scrape'), { slug: '007-P07-scrape', id: '007' });
});

test('deriveSlugId: null for a non-worktree branch', () => {
  assert.equal(deriveSlugId('master'), null);
  assert.equal(deriveSlugId('main'), null);
  assert.equal(deriveSlugId(''), null);
  assert.equal(deriveSlugId(undefined), null);
});

test('deriveSlugId: id null for a worktree branch with no NNN prefix (e.g. staging)', () => {
  assert.deepEqual(deriveSlugId('worktree-staging-maptune'), {
    slug: 'staging-maptune',
    id: null,
  });
});

const BASE = {
  branchCheckout: true,
  branch: 'worktree-1022-Infra-harden-mint',
  inWorktreeDir: true,
  claimRefExists: false,
  boardHasActiveRow: false,
};

test('evaluateCheckout: WARN naming slug+id for an unclaimed worktree checkout', () => {
  const r = evaluateCheckout(BASE);
  assert.equal(r.warn, true);
  assert.match(r.message, /1022-Infra-harden-mint/);
  assert.match(r.message, /refs\/claims\/1022/);
  assert.match(r.message, /pickup-plan/);
});

test('evaluateCheckout: no warn on a file (non-branch) checkout', () => {
  assert.equal(evaluateCheckout({ ...BASE, branchCheckout: false }).warn, false);
});

test('evaluateCheckout: no warn outside a worktree dir (e.g. the main checkout)', () => {
  assert.equal(evaluateCheckout({ ...BASE, inWorktreeDir: false }).warn, false);
});

test('evaluateCheckout: no warn for a non-worktree branch', () => {
  assert.equal(evaluateCheckout({ ...BASE, branch: 'master' }).warn, false);
});

test('evaluateCheckout: no warn for a non-plan worktree (slug has no NNN id)', () => {
  assert.equal(evaluateCheckout({ ...BASE, branch: 'worktree-staging-maptune' }).warn, false);
});

test('evaluateCheckout: no warn when the claim ref exists (the legit pickup-plan flow)', () => {
  assert.equal(evaluateCheckout({ ...BASE, claimRefExists: true }).warn, false);
});

test('evaluateCheckout: no warn when the board carries an ACTIVE row for the slug', () => {
  assert.equal(evaluateCheckout({ ...BASE, boardHasActiveRow: true }).warn, false);
});

test('claimRefExists: F-012 — probes the REMOTE ref via ls-remote (the local show-ref probe could never fire)', () => {
  let seenArgs = null;
  const fakeGit = (dir, args) => {
    seenArgs = args;
    return 'abc123def\trefs/claims/999\n';
  };
  assert.equal(claimRefExists('999', { cwd: '/some/worktree', _git: fakeGit }), true);
  assert.deepEqual(seenArgs, ['ls-remote', 'origin', ...claimRefCandidates('999')]);
});

test('claimRefExists: empty ls-remote output (no such ref on origin) → false', () => {
  const fakeGit = () => '';
  assert.equal(claimRefExists('999', { _git: fakeGit }), false);
});

test('claimRefExists: bounds the ls-remote with a timeout (review 2026-07-04) — an offline checkout must fail fast, not hang the hook', () => {
  let seenOpts;
  const fakeGit = (_dir, _args, opts) => {
    seenOpts = opts;
    return 'sha\trefs/claims/999\n';
  };
  assert.equal(claimRefExists('999', { _git: fakeGit }), true);
  assert.ok(
    seenOpts && typeof seenOpts.timeout === 'number' && seenOpts.timeout > 0,
    'ls-remote must carry a positive timeout so an unreachable origin fails fast to the boardHasActiveRow fallback',
  );
});

test('claimRefExists: a git/network failure → false (falls back to boardHasActiveRow only)', () => {
  const fakeGit = () => {
    throw new Error('network unreachable');
  };
  assert.equal(claimRefExists('999', { _git: fakeGit }), false);
});

test('warnMessage: contains the slug, the claim ref, and the no-hand-worktree rule', () => {
  const m = warnMessage('999-Other-foo', '999');
  assert.match(m, /999-Other-foo/);
  assert.match(m, /refs\/claims\/999/);
  assert.match(m, /`git worktree add` by hand/);
});
