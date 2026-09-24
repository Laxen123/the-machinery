// scripts/compute-push-diff.test.mjs — plan 1287.
//
// Unit-level coverage for the stdin-parse + range-computation logic that
// scopes pre-push tier selection to the PUSHED DELTA (the commits this push
// introduces) instead of `origin/master..HEAD` (which drifts under the
// parallel-session herd as siblings land unrelated commits — the 2026-07-02
// exit-143 kill cascade this plan fixes).
//
// Exercises the exported pure functions directly with injected `diff`/`base`
// fakes — no shell/process spawning, no real git — so each range-computation
// branch (multi-ref union, new-branch merge-base fallback, deleted-ref skip,
// coord-ref skip, empty-stdin fallback) is asserted precisely. The end-to-end
// shell wiring (the real hook actually calling this script and gating on its
// output) is covered separately in scripts/pre-push-hook.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRefLines,
  qualifyingRefs,
  computeChangedFiles,
  computeRanges,
  filesForRanges,
  isDrainStatusOnlyPush,
  isDrainStatusOnlyPushStdin,
  isSweepCheckpointOnlyPush,
  isSweepCheckpointOnlyPushStdin,
  renderStorePathRxFor,
} from './compute-push-diff.mjs';

// The real vetapp render-store regex, built the same way `main()` builds it — used wherever a
// test below needs the checkpoint exemption's render-store half to actually match (plan 4071 T3).
const RENDER_STORE_RX = renderStorePathRxFor([
  'backend/data/price-pipeline/render-fingerprints',
  'backend/data/price-pipeline/render-store',
  'backend/data/price-pipeline/removal-proposals',
]);

const Z40 = '0'.repeat(40);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

// Review fix I (plan batch-2026-07-05-coord-curation, on top of plan 1345):
// resolveRangeStart's `isAncestor` now answers TWO distinct questions —
// (1) is remoteSha an ancestor of localSha (not a force-push), and (2) is
// remoteSha itself already reachable from origin/master (the plan-1345
// freshen-staleness signal) — so a blanket `() => true`/`() => false` stub no
// longer distinguishes them. This helper stubs the ORDINARY fast-forward
// case: true only for the "is remoteSha an ancestor of localSha" call, false
// for every other pair (including the staleness check), matching a genuine
// unlanded branch tip that was never itself part of master's history.
const ordinaryFF = (remoteSha, localSha) => (a, b) => a === remoteSha && b === localSha;

test('parseRefLines: parses the standard `<local-ref> <local-sha> <remote-ref> <remote-sha>` stdin protocol', () => {
  const stdin = `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}\n`;
  const refs = parseRefLines(stdin);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], {
    localRef: 'refs/heads/worktree-x',
    localSha: SHA_A,
    remoteRef: 'refs/heads/worktree-x',
    remoteSha: SHA_B,
  });
});

test('parseRefLines: multiple refs, blank lines, and trailing whitespace are all handled', () => {
  const stdin = `\nrefs/heads/a ${SHA_A} refs/heads/a ${SHA_B}\n\nrefs/heads/b ${SHA_B} refs/heads/b ${SHA_C}   \n`;
  const refs = parseRefLines(stdin);
  assert.equal(refs.length, 2);
  assert.equal(refs[1].localRef, 'refs/heads/b');
});

test('parseRefLines: a malformed / short line is skipped rather than crashing', () => {
  const refs = parseRefLines('garbage\nrefs/heads/a\n');
  assert.deepEqual(refs, []);
});

test('qualifyingRefs: skips coordination refs (refs/claims/*, refs/coord/*) — plan 368', () => {
  const stdin = [
    `refs/claims/1287 ${SHA_A} refs/claims/1287 ${SHA_B}`,
    `refs/coord/session-counter ${SHA_A} refs/coord/session-counter ${SHA_B}`,
    `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}`,
  ].join('\n');
  const refs = qualifyingRefs(stdin);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].localRef, 'refs/heads/worktree-x');
});

test('qualifyingRefs: skips a deleted ref (all-zero local sha — nothing introduced)', () => {
  const stdin = [
    `(delete) ${Z40} refs/heads/worktree-old ${SHA_B}`,
    `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}`,
  ].join('\n');
  const refs = qualifyingRefs(stdin);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].localRef, 'refs/heads/worktree-x');
});

test('computeChangedFiles: a single real-branch ref diffs remote-sha..local-sha', () => {
  const stdin = `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}\n`;
  const calls = [];
  const diff = (range) => {
    calls.push(range);
    return range === `${SHA_B}..${SHA_A}` ? ['docs/INDEX.md'] : ['SHOULD-NOT-BE-CALLED'];
  };
  const changed = computeChangedFiles(stdin, {
    diff,
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.deepEqual(changed, ['docs/INDEX.md']);
  assert.deepEqual(calls, [`${SHA_B}..${SHA_A}`]);
});

test('computeChangedFiles: a new-branch push (all-zero remote sha) tiers via the merge-base fallback', () => {
  const stdin = `refs/heads/worktree-new ${SHA_A} refs/heads/worktree-new ${Z40}\n`;
  const baseCalls = [];
  const base = (a, b) => {
    baseCalls.push([a, b]);
    return SHA_C; // pretend origin/master and SHA_A converge at SHA_C
  };
  const diff = (range) => (range === `${SHA_C}..${SHA_A}` ? ['frontend/src/app/page.tsx'] : []);
  const changed = computeChangedFiles(stdin, { diff, base });
  assert.deepEqual(changed, ['frontend/src/app/page.tsx']);
  assert.deepEqual(baseCalls, [['origin/master', SHA_A]]);
});

test('computeChangedFiles: multiple pushed refs union their diffs (deduped, sorted)', () => {
  const stdin = [
    `refs/heads/a ${SHA_A} refs/heads/a ${SHA_B}`,
    `refs/heads/b ${SHA_B} refs/heads/b ${SHA_C}`,
  ].join('\n');
  const diff = (range) => {
    if (range === `${SHA_B}..${SHA_A}`) return ['backend/src/x.ts', 'shared/src/common.ts'];
    if (range === `${SHA_C}..${SHA_B}`) return ['shared/src/common.ts', 'frontend/src/y.tsx'];
    return [];
  };
  const changed = computeChangedFiles(stdin, {
    diff,
    base: () => 'unused',
    // Two ordinary ff refs: (remote=SHA_B, local=SHA_A) and (remote=SHA_C, local=SHA_B).
    isAncestor: (a, b) => (a === SHA_B && b === SHA_A) || (a === SHA_C && b === SHA_B),
  });
  assert.deepEqual(changed, ['backend/src/x.ts', 'frontend/src/y.tsx', 'shared/src/common.ts']);
});

test('computeChangedFiles: a deleted ref among the pushed refs contributes nothing to the union', () => {
  const stdin = [
    `(delete) ${Z40} refs/heads/worktree-old ${SHA_B}`,
    `refs/heads/a ${SHA_A} refs/heads/a ${SHA_B}`,
  ].join('\n');
  const diff = (range) => (range === `${SHA_B}..${SHA_A}` ? ['docs/x.md'] : ['SHOULD-NOT-APPEAR']);
  const changed = computeChangedFiles(stdin, {
    diff,
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.deepEqual(changed, ['docs/x.md']);
});

test('computeChangedFiles: a coord-only + delete-only mix (real push, zero qualifying refs) returns empty — no origin/master..HEAD fallback', () => {
  // A single `git push origin :refs/claims/1287 :old-worktree-branch` (a plausible
  // combined claim-release + branch-cleanup) carries ref lines but none qualify.
  // Falling back to origin/master..HEAD here would reintroduce the herd-drift bug
  // this script exists to eliminate — the fallback is reserved for stdin with NO
  // ref line at all (a manual/test invocation), asserted separately below.
  const stdin = [
    `refs/claims/1287 ${SHA_A} refs/claims/1287 ${SHA_B}`,
    `(delete) ${Z40} refs/heads/old ${SHA_B}`,
  ].join('\n');
  const diff = () => ['SHOULD-NOT-BE-CALLED'];
  const changed = computeChangedFiles(stdin, {
    diff,
    base: () => 'unused',
    isAncestor: () => true,
  });
  assert.deepEqual(changed, []);
});

test('computeChangedFiles: empty stdin (manual/test hook invocation) falls back to origin/master..HEAD', () => {
  const diff = (range) =>
    range === 'origin/master..HEAD' ? ['fallback.md'] : ['SHOULD-NOT-APPEAR'];
  const changed = computeChangedFiles('', { diff, base: () => 'unused', isAncestor: () => true });
  assert.deepEqual(changed, ['fallback.md']);
});

// --- plan 1289: computeRanges (the per-ref ranges themselves, for the range-scoped guards) ---

test('computeRanges: a single real-branch ref yields its remote-sha..local-sha range', () => {
  const stdin = `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}\n`;
  assert.deepEqual(
    computeRanges(stdin, { base: () => 'unused', isAncestor: ordinaryFF(SHA_B, SHA_A) }),
    [`${SHA_B}..${SHA_A}`],
  );
});

test('computeRanges: a new-branch push (all-zero remote sha) ranges from the merge-base', () => {
  const stdin = `refs/heads/worktree-new ${SHA_A} refs/heads/worktree-new ${Z40}\n`;
  const base = (a, b) => (a === 'origin/master' && b === SHA_A ? SHA_C : 'WRONG');
  assert.deepEqual(computeRanges(stdin, { base }), [`${SHA_C}..${SHA_A}`]);
});

test('computeRanges: multiple pushed refs yield one range each (deduped)', () => {
  const stdin = [
    `refs/heads/a ${SHA_A} refs/heads/a ${SHA_B}`,
    `refs/heads/b ${SHA_B} refs/heads/b ${SHA_C}`,
    `refs/heads/dup ${SHA_A} refs/heads/dup ${SHA_B}`, // same range as refs/heads/a
  ].join('\n');
  assert.deepEqual(
    computeRanges(stdin, {
      base: () => 'unused',
      // Two distinct ordinary ff refs: (remote=SHA_B, local=SHA_A) and
      // (remote=SHA_C, local=SHA_B); the third ref is a dup of the first pair.
      isAncestor: (a, b) => (a === SHA_B && b === SHA_A) || (a === SHA_C && b === SHA_B),
    }),
    [`${SHA_B}..${SHA_A}`, `${SHA_C}..${SHA_B}`],
  );
});

test('computeRanges: a FORCE-PUSHED rebased branch (remote tip not an ancestor) anchors at the merge-base, never the stale remote tip', () => {
  // Observed live in the plan-1289 land: after the spine rebased the branch, the
  // force-push's remote-sha was no longer in the local history, so
  // remote..local swept in every master-side commit the branch was rebased onto
  // — and the range guards flagged 7 of master's own already-landed commits.
  const stdin = `refs/heads/worktree-x ${SHA_A} refs/heads/worktree-x ${SHA_B}\n`;
  const base = (a, b) => (a === 'origin/master' && b === SHA_A ? SHA_C : 'WRONG');
  assert.deepEqual(computeRanges(stdin, { base, isAncestor: () => false }), [`${SHA_C}..${SHA_A}`]);
});

// --- plan 1345: exclude commits already reachable from origin/master ---
//
// The plan-1323 incident: a worktree branch's remote ref was pushed at cut
// time (its remote tip IS an old master commit, zero unique content yet).
// After the standard freshen (`git fetch && git rebase origin/master` —
// docs/runbooks/branch-hygiene.md), a no-op rebase (nothing to replay yet)
// left the local branch tip AT the new master tip; the session then added its
// own commit on top. remoteSha (old master) remains a perfectly good ancestor
// of localSha (no rewrite happened, so isAncestor is true) — so the "normal
// fast-forward" branch fired, but remoteSha..localSha then swept in every
// commit master gained between the old and new tips, none introduced by this
// push (81 of them in the incident; lint-coord-trailer flagged 4).

test('computeRanges: a branch whose remote tip predates a master freshen excludes the intervening master commits (plan 1345)', () => {
  const OLD_MASTER = 'd'.repeat(40); // the branch's remote ref, pushed at cut time
  const NEW_MASTER = 'e'.repeat(40); // origin/master's tip after a sibling land
  const OWN_COMMIT = 'f'.repeat(40); // the session's own new work, atop NEW_MASTER
  const stdin = `refs/heads/worktree-x ${OWN_COMMIT} refs/heads/worktree-x ${OLD_MASTER}\n`;
  const base = (ref, sha) =>
    ref === 'origin/master' && sha === OWN_COMMIT ? NEW_MASTER : 'WRONG-BASE-CALL';
  // OLD_MASTER genuinely IS an ancestor of OWN_COMMIT (no rewrite occurred) —
  // AND OLD_MASTER is itself an ancestor of origin/master's CURRENT tip (it IS
  // an old master commit, never rewritten) — review fix I's cheap staleness
  // signal (`isAncestor(remoteSha, 'origin/master')`), replacing the old
  // `isAncestor(masterBase, remoteSha)` check this test used to pin.
  const isAncestor = (a, b) => {
    if (a === OLD_MASTER && b === OWN_COMMIT) return true;
    if (a === OLD_MASTER && b === 'origin/master') return true;
    throw new Error(`unexpected isAncestor(${a}, ${b})`);
  };
  assert.deepEqual(computeRanges(stdin, { base, isAncestor }), [`${NEW_MASTER}..${OWN_COMMIT}`]);
});

test("computeRanges: a normal incremental push (no master drift) still anchors at the branch's own previous tip, so the branch's own new commits stay in range (plan 1345)", () => {
  // remoteSha is the branch's OWN prior commit — genuinely ahead of
  // origin/master's fork point, and (unlike the freshen case above) never
  // itself reachable from origin/master's current tip — so the fast path
  // fires and, per review fix I's laziness, `base()` (an actual merge-base
  // VALUE computation) must NEVER be spawned on this, the ordinary, path.
  // Making `base` throw here proves that: a regression that reintroduces the
  // old unconditional merge-base call would fail this test immediately.
  const PRIOR_COMMIT = 'b'.repeat(40); // the branch's own previously-pushed tip
  const NEW_COMMIT = 'c'.repeat(40); // the branch's newest commit (this push)
  const stdin = `refs/heads/worktree-x ${NEW_COMMIT} refs/heads/worktree-x ${PRIOR_COMMIT}\n`;
  const base = () => {
    throw new Error('base() must not be spawned on the ordinary fast-forward path');
  };
  const isAncestor = (a, b) => {
    if (a === PRIOR_COMMIT && b === NEW_COMMIT) return true;
    if (a === PRIOR_COMMIT && b === 'origin/master') return false;
    throw new Error(`unexpected isAncestor(${a}, ${b})`);
  };
  assert.deepEqual(computeRanges(stdin, { base, isAncestor }), [`${PRIOR_COMMIT}..${NEW_COMMIT}`]);
});

test('computeRanges: a coord-only + delete-only mix (zero qualifying refs) returns empty — no fallback', () => {
  const stdin = [
    `refs/claims/1289 ${SHA_A} refs/claims/1289 ${SHA_B}`,
    `(delete) ${Z40} refs/heads/old ${SHA_B}`,
  ].join('\n');
  assert.deepEqual(computeRanges(stdin, { base: () => 'unused', isAncestor: () => true }), []);
});

test('computeRanges: empty stdin (manual/test hook invocation) falls back to origin/master..HEAD', () => {
  assert.deepEqual(computeRanges('', { base: () => 'unused', isAncestor: () => true }), [
    'origin/master..HEAD',
  ]);
});

test('filesForRanges: unions the diffs of already-resolved ranges (deduped, sorted) — no re-resolution', () => {
  const diff = (range) => {
    if (range === 'a..b') return ['b.ts', 'shared.ts'];
    if (range === 'c..d') return ['shared.ts', 'a.ts'];
    return ['SHOULD-NOT-BE-CALLED'];
  };
  assert.deepEqual(filesForRanges(['a..b', 'c..d'], { diff }), ['a.ts', 'b.ts', 'shared.ts']);
  assert.deepEqual(filesForRanges([], { diff }), []);
});

test('computeChangedFiles: a done-worktree master-land push diffs the merge, not unrelated origin drift', () => {
  // The land push's ref line carries the real prior master tip as remote-sha (never
  // all-zero — master already exists), so it tiers on remote-sha..local-sha same as any
  // other ref — no branch-name special-casing needed for the land path to be correct.
  const stdin = `refs/heads/master ${SHA_A} refs/heads/master ${SHA_B}\n`;
  const calls = [];
  const diff = (range) => {
    calls.push(range);
    return range === `${SHA_B}..${SHA_A}`
      ? ['backend/src/data/seed-clinics.json']
      : ['SHOULD-NOT-APPEAR'];
  };
  const changed = computeChangedFiles(stdin, {
    diff,
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.deepEqual(changed, ['backend/src/data/seed-clinics.json']);
  assert.deepEqual(calls, [`${SHA_B}..${SHA_A}`]);
});

// ── The drain-status gate exemption (plan 3619) ─────────────────────────────
//
// The exemption is what makes the drain status channel work at all: a cloud drain's only channel
// for its own state is a successful push, and that channel sits behind the gate that can fail. It
// is granted by CONTENT — what the push actually changes — never by a flag, so the tests that
// matter are the NEGATIVE ones: a push carrying real code must not be able to ride it.

test('isDrainStatusOnlyPush: a status-only file set is exempt', () => {
  assert.equal(isDrainStatusOnlyPush(['.drain-status/3595-Infra-thing.json']), true);
  assert.equal(
    isDrainStatusOnlyPush(['.drain-status/a.json', '.drain-status/b.json']),
    true,
    'several status files in one push are still status-only',
  );
});

test('isDrainStatusOnlyPush: an EMPTY change set is NOT exempt', () => {
  // Fail-closed: "changed nothing" must fall through to the ordinary hook path, never be read as
  // "changed only status". The two existing pass-throughs already own the genuinely empty pushes
  // (coord-only, all-delete) by ref NAME, before this predicate is ever consulted.
  assert.equal(isDrainStatusOnlyPush([]), false);
  assert.equal(isDrainStatusOnlyPush(null), false);
});

test('isDrainStatusOnlyPush: ONE real-code file in the push defeats the exemption', () => {
  // The load-bearing negative. A drain that could smuggle code past the battery by attaching a
  // status file would be strictly worse than no channel at all.
  assert.equal(
    isDrainStatusOnlyPush(['.drain-status/3595-x.json', 'scripts/queue-drain.mjs']),
    false,
  );
  assert.equal(isDrainStatusOnlyPush(['.drain-status/3595-x.json', 'wiki/hot.md']), false);
  assert.equal(
    isDrainStatusOnlyPush(['.drain-status/3595-x.json', 'backend/src/data/seed/chains.json']),
    false,
  );
});

test('isDrainStatusOnlyPush: near-miss paths outside the status dir are NOT exempt', () => {
  // The regex is anchored at both ends and forbids a path separator inside the name, so neither a
  // look-alike sibling directory nor a nested path can widen the exemption.
  for (const path of [
    'drain-status/x.json', // no leading dot
    '.drain-status/x.mjs', // not JSON
    '.drain-status/nested/x.json', // nested — the writer never produces this
    'a/.drain-status/x.json', // not at the repo root
    '.drain-status/x.json.bak',
  ]) {
    assert.equal(isDrainStatusOnlyPush([path]), false, `${path} must not be exempt`);
  }
});

test('isDrainStatusOnlyPushStdin: a real status push (new branch) is exempt', () => {
  const stdin = `refs/heads/claude/status/3595-x ${SHA_A} refs/heads/claude/status/3595-x ${Z40}\n`;
  const exempt = isDrainStatusOnlyPushStdin(stdin, {
    diff: () => ['.drain-status/3595-x.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  });
  assert.equal(exempt, true);
});

test('isDrainStatusOnlyPushStdin: a heartbeat onto an EXISTING status branch is exempt', () => {
  // The fast-forward case, which is what every heartbeat after the first one actually is.
  const stdin = `refs/heads/claude/status/3595-x ${SHA_A} refs/heads/claude/status/3595-x ${SHA_B}\n`;
  const exempt = isDrainStatusOnlyPushStdin(stdin, {
    diff: (range) => (range === `${SHA_B}..${SHA_A}` ? ['.drain-status/3595-x.json'] : ['nope.ts']),
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, true);
});

test('isDrainStatusOnlyPushStdin: stdin with NO qualifying ref line is never exempt', () => {
  // The subtle one. `computeRanges` falls back to `origin/master..HEAD` when stdin carries no ref
  // line (a manual or test invocation of the hook). Were the exemption computed off that fallback,
  // a working tree that happens to differ from master by only a status file would skip the whole
  // battery on a push whose actual refs are unknown. Both no-ref shapes must be non-exempt even
  // when the diff itself looks perfectly status-only.
  const statusOnly = {
    diff: () => ['.drain-status/3595-x.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  };
  assert.equal(isDrainStatusOnlyPushStdin('', statusOnly), false, 'empty stdin');
  assert.equal(
    isDrainStatusOnlyPushStdin(`refs/claims/3595 ${SHA_A} refs/claims/3595 ${Z40}\n`, statusOnly),
    false,
    'coord-only stdin has no qualifying ref',
  );
  assert.equal(
    isDrainStatusOnlyPushStdin(
      `(delete) ${Z40} refs/heads/claude/status/3595-x ${SHA_B}\n`,
      statusOnly,
    ),
    false,
    'a deletion has no qualifying ref',
  );
});

test('isDrainStatusOnlyPushStdin: a push mixing a status file with code is NOT exempt', () => {
  const stdin = `refs/heads/worktree-3595-x ${SHA_A} refs/heads/worktree-3595-x ${SHA_B}\n`;
  const exempt = isDrainStatusOnlyPushStdin(stdin, {
    diff: () => ['.drain-status/3595-x.json', 'scripts/hooks/pre-push.sh'],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, false);
});

// ── The sweep-checkpoint gate exemption (plan 3682) ─────────────────────────
//
// Twin of the drain-status exemption above, same reasoning: a cadence firing every ~25
// targets across a multi-thousand-target corpus cannot pay the full battery, so the
// exemption is granted by CONTENT — what the push actually changes — never by a flag. The
// negative tests are the ones that matter: a push carrying real code must not ride it.

test('renderStorePathRxFor: matches paths under the configured render-store dir, bounded at the next segment', () => {
  const rx = renderStorePathRxFor(['backend/data/price-pipeline/render-store']);
  assert.equal(rx.test('backend/data/price-pipeline/render-store/clinic-1/x.json'), true);
  // A sibling directory sharing the prefix must NOT match — the regex requires a "/" right after
  // the configured dir, not merely a matching prefix string.
  assert.equal(rx.test('backend/data/price-pipeline/render-store-other/x.json'), false);
});

test('renderStorePathRxFor: an empty list, or a list with no render-store row, matches nothing (never throws)', () => {
  assert.equal(renderStorePathRxFor([]).test('backend/data/price-pipeline/render-store/x'), false);
  assert.equal(renderStorePathRxFor(undefined).test('anything'), false);
  assert.equal(
    renderStorePathRxFor(['backend/data/price-pipeline/render-fingerprints']).test(
      'backend/data/price-pipeline/render-store/x',
    ),
    false,
  );
});

test('isSweepCheckpointOnlyPush: a checkpoint-file-only set is exempt', () => {
  assert.equal(
    isSweepCheckpointOnlyPush([
      'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json',
    ]),
    true,
  );
});

test('isSweepCheckpointOnlyPush: a render-store-only set is exempt', () => {
  assert.equal(
    isSweepCheckpointOnlyPush(
      ['backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json'],
      { renderStoreRx: RENDER_STORE_RX },
    ),
    true,
  );
});

test('isSweepCheckpointOnlyPush: checkpoint + render-store together are exempt', () => {
  assert.equal(
    isSweepCheckpointOnlyPush(
      [
        'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json',
        'backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json',
        'backend/data/price-pipeline/render-store/clinic-2/playwright/h2/index.html',
      ],
      { renderStoreRx: RENDER_STORE_RX },
    ),
    true,
  );
});

// plan 4071 T3: with NO renderStoreRx supplied (the config-less-repo default), a render-store
// path is no longer exempt on its own — only the literal checkpoint path is. This is the
// caller-injects contract: the CALLER (main()) resolves coord.config.json and passes the derived
// regex in; a caller that does not is the generic-core posture, not a vetapp regression.
test('isSweepCheckpointOnlyPush: a render-store-only set is NOT exempt with no renderStoreRx supplied', () => {
  assert.equal(
    isSweepCheckpointOnlyPush([
      'backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json',
    ]),
    false,
  );
});

test('isSweepCheckpointOnlyPush: an EMPTY change set is NOT exempt', () => {
  assert.equal(isSweepCheckpointOnlyPush([]), false);
  assert.equal(isSweepCheckpointOnlyPush(null), false);
});

test('isSweepCheckpointOnlyPush: ONE real-code file in the push defeats the exemption', () => {
  assert.equal(
    isSweepCheckpointOnlyPush([
      'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json',
      'backend/scripts/price-pipeline/weekly-price-sweep.py',
    ]),
    false,
  );
  assert.equal(
    isSweepCheckpointOnlyPush([
      'backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json',
      'scripts/hooks/pre-push.sh',
    ]),
    false,
  );
});

test('isSweepCheckpointOnlyPush: near-miss paths outside the two allowed trees are NOT exempt', () => {
  for (const path of [
    'backend/data/price-pipeline/sweep-checkpoints/nested/weekly-sweep-2026-09-05.json', // nested
    'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.mjs', // not JSON
    'backend/data/render-store/clinic-1/playwright/h/_meta.json', // wrong render-store path (no price-pipeline/)
    'a/backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json', // not at repo root
    'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json.bak',
  ]) {
    assert.equal(isSweepCheckpointOnlyPush([path]), false, `${path} must not be exempt`);
  }
});

test('isSweepCheckpointOnlyPushStdin: a real checkpoint-only push (new branch) is exempt', () => {
  const stdin = `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${Z40}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  });
  assert.equal(exempt, true);
});

test('isSweepCheckpointOnlyPushStdin: a cadence push onto an EXISTING worktree branch is exempt', () => {
  // The fast-forward case, which is what every cadence push after the first one actually is.
  const stdin = `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${SHA_B}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: (range) =>
      range === `${SHA_B}..${SHA_A}`
        ? ['backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json']
        : ['nope.ts'],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
    renderStoreRx: RENDER_STORE_RX,
  });
  assert.equal(exempt, true);
});

test('isSweepCheckpointOnlyPushStdin: stdin with NO qualifying ref line is never exempt', () => {
  // Same subtle case as its drain-status twin: computeRanges' origin/master..HEAD fallback
  // (no ref line on stdin — a manual/test invocation) must never be trusted as the basis for
  // an exemption, even when the diff itself looks perfectly checkpoint-only.
  const checkpointOnly = {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  };
  assert.equal(isSweepCheckpointOnlyPushStdin('', checkpointOnly), false, 'empty stdin');
  assert.equal(
    isSweepCheckpointOnlyPushStdin(
      `refs/claims/3682 ${SHA_A} refs/claims/3682 ${Z40}\n`,
      checkpointOnly,
    ),
    false,
    'coord-only stdin has no qualifying ref',
  );
  assert.equal(
    isSweepCheckpointOnlyPushStdin(
      `(delete) ${Z40} refs/heads/worktree-3682-x ${SHA_B}\n`,
      checkpointOnly,
    ),
    false,
    'a deletion has no qualifying ref',
  );
});

test('isSweepCheckpointOnlyPushStdin: a push mixing a checkpoint file with code is NOT exempt', () => {
  const stdin = `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${SHA_B}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => [
      'backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json',
      'backend/scripts/price-pipeline/weekly-price-sweep.py',
    ],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, false);
});

// plan 3682 review round 1 (finding: the exemption was not restricted to worktree
// branches). A `--checkpoint-push` run from `master` (or any non-worktree branch) must
// never take this exemption, even when its diff is perfectly checkpoint-only content —
// the done-worktree land guard that would otherwise catch a stray checkpoint only ever
// watches `worktree-*` branches.
test('isSweepCheckpointOnlyPushStdin: a checkpoint-only-shaped push to master is NOT exempt', () => {
  const stdin = `refs/heads/master ${SHA_A} refs/heads/master ${SHA_B}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, false);
});

test('isSweepCheckpointOnlyPushStdin: a checkpoint-only-shaped push to a non-worktree branch is NOT exempt', () => {
  const stdin = `refs/heads/some-other-branch ${SHA_A} refs/heads/some-other-branch ${Z40}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/render-store/clinic-1/playwright/h/_meta.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  });
  assert.equal(exempt, false);
});

test('isSweepCheckpointOnlyPushStdin: multiple refs where ONE destination is not worktree-* is NOT exempt', () => {
  const stdin =
    `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${SHA_B}\n` +
    `refs/heads/master ${SHA_B} refs/heads/master ${SHA_C}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => 'unused',
    isAncestor: () => true,
  });
  assert.equal(exempt, false);
});

// plan 3682 review round 2 (finding 302d5a): a DELETION ref carries an all-zero
// localSha, so `qualifyingRefs` drops it (it contributes no content diff) — but the
// destination-restriction check was built on `qualifyingRefs` too, so a mixed push
// combining a genuine checkpoint-only worktree ref with a deletion of an unrelated ref
// (e.g. `:refs/heads/master`) saw ONLY the worktree ref, took the exemption, and let the
// deletion through with no gate at all. The destination check must cover every
// non-coord ref line, deletions included.
test('isSweepCheckpointOnlyPushStdin: a mixed push deleting master alongside a checkpoint-only worktree ref is NOT exempt', () => {
  const stdin =
    `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${SHA_B}\n` +
    `(delete) ${Z40} refs/heads/master ${SHA_C}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, false);
});

// plan 3682 review round 3 (finding 11): round 2 closed the deletion hole only for
// destinations that are not worktree branches. Deleting an UNRELATED `worktree-*` branch
// still satisfied `isWorktreeBranchRef`, so a push combining a real checkpoint cadence ref
// with `:refs/heads/worktree-9999-someone-elses-slug` took the exemption and removed
// another session's branch with the whole battery skipped. A deletion contributes no
// content, so no content check can ever vouch for it: this exemption refuses any push
// carrying one, whatever the destination looks like.
test('isSweepCheckpointOnlyPushStdin: deleting an unrelated worktree branch alongside a checkpoint ref is NOT exempt', () => {
  const stdin =
    `refs/heads/worktree-3682-x ${SHA_A} refs/heads/worktree-3682-x ${SHA_B}\n` +
    `(delete) ${Z40} refs/heads/worktree-9999-other ${SHA_C}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => 'unused',
    isAncestor: ordinaryFF(SHA_B, SHA_A),
  });
  assert.equal(exempt, false);
});

// plan 3682 review round 2 (finding 25a360): the round-1 `WORKTREE_BRANCH_REF_RX` matched
// the EMPTY slug (`refs/heads/worktree-`, no trailing text), while the canonical
// `slugFromBranch` (scripts/coord/redgreen-lib.mjs) — which the downstream `done-worktree.mjs`
// worktree-land guard is built on — rejects it. A checkpoint-only push to that empty-slug
// destination must not be exempt either, so the two layers agree on what "a worktree
// branch" means.
test('isSweepCheckpointOnlyPushStdin: a checkpoint-only-shaped push to the EMPTY-slug worktree ref is NOT exempt', () => {
  const stdin = `refs/heads/worktree- ${SHA_A} refs/heads/worktree- ${Z40}\n`;
  const exempt = isSweepCheckpointOnlyPushStdin(stdin, {
    diff: () => ['backend/data/price-pipeline/sweep-checkpoints/weekly-sweep-2026-09-05.json'],
    base: () => SHA_C,
    isAncestor: () => false,
  });
  assert.equal(exempt, false);
});
