#!/usr/bin/env node
// scripts/compute-push-diff.mjs — plan 1287.
//
// Computes the set of files changed by THIS push, scoped to the commits the
// push actually introduces — not `origin/master..HEAD`, which drifts under the
// parallel-session herd as siblings land unrelated commits (the 2026-07-02
// exit-143 kill cascade: a docs-only push's origin/master..HEAD diff picked up
// a sibling's fresh backend/src/** commits and ran the full backend vitest
// suite on a push that changed zero backend files).
//
// Reads the standard git pre-push stdin protocol from stdin — one
// `<local-ref> <local-sha> <remote-ref> <remote-sha>` line per pushed ref —
// and for each qualifying ref computes a range `<START>..<local-sha>`, where
// START is:
//   - <remote-sha> itself, for the common case: a normal fast-forward push
//     where remote-sha is a genuine ancestor of local-sha (not a force-push)
//     AND is not itself already folded into origin/master's own history (see
//     the freshen case below) — resolved with two cheap `isAncestor` checks,
//     no merge-base VALUE computation.
//   - `git merge-base origin/master <local-sha>` (computed lazily, ONLY on
//     this less-common path) in every other case:
//       - remote-sha is all-zero (new branch, nothing on the remote yet);
//       - remote-sha is NOT an ancestor of local-sha (a force-push of a
//         rebased branch — the old tip would otherwise sweep in master-side
//         commits the branch was rebased onto);
//       - remote-sha IS itself reachable from origin/master (plan 1345: a
//         branch whose remote tip predates a `git fetch && git rebase
//         origin/master` freshen — remote-sha remains a genuine ancestor of
//         local-sha, so it LOOKS like an ordinary fast-forward, but
//         remote-sha..local-sha would then sweep in every master commit
//         landed since the freshen, none introduced by this push).
// A ref is skipped when it is a coordination ref (refs/claims/*, refs/coord/*
// — plan 368, carries no content diff) or the push is a deletion (local-sha
// all-zero — nothing introduced). The changed-file sets of all surviving refs
// are unioned (deduped, sorted) and printed to stdout, one path per line.
// With `--ranges` (plan 1289) the per-ref ranges themselves are printed
// instead (one per line), for the range-scoped pre-push guards.
//
// Falls back to `git diff --name-only origin/master..HEAD` when stdin carries
// no qualifying ref line (a manual/test invocation of the hook — a real
// `git push` always supplies at least one non-coord, non-delete ref line for
// a content-bearing push, and a done-worktree master-land push's ref line
// diffs exactly the commits the merge introduces, not unrelated origin
// drift).
//
// Exits non-zero (message on stderr) on any git failure, so the caller
// (scripts/hooks/pre-push.sh) can WARN + skip the diff-scoped gates rather than crash —
// mirrors the existing origin/master..HEAD transient-failure handling.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
// plan 2615: the shared reader (bounded EAGAIN retry + a temp-file diagnostic). Was a local
// `readFileSync(0)` in a bare catch, which made a Windows read failure indistinguishable from
// empty input — the silent-skip class this plan exists to close. Fail-open shape unchanged.
import { readStdin } from './stdin-read.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GIT_MAXBUFFER } from './coord-git.mjs';
// plan 4071 T3: RENDER_STORE_PATH_RX used to be a standalone vetapp literal. coord-config.mjs's
// `derivedShardDirs` (plan 1867) already carries the same path, so the regex is derived from it
// instead of adding a second copy that could drift — see renderStorePathRxFor below. `main()` is
// the CLI entry point (its only caller is the shell, via scripts/hooks/pre-push.sh), so per this
// plan's caller-injects rule it resolves the config ONCE, here, rather than every leaf reading it
// for itself; `repoRootFrom` never assumes a fixed `..` depth (this plan's own rule — every
// module here is one directory deeper than it used to be).
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
// plan 3682 review round 2 (finding 25a360): the canonical worktree-branch-name
// detector, reused below instead of a hand-rolled regex. `redgreen-lib.mjs` is a
// `scripts/` sibling (imports only `./landing-queue-lib.mjs` / `./board-lib.mjs`, neither
// of which imports this module back) so this stays legal under
// docs/coord/scripts-layout.md Rule 1 (no escape outside `scripts/`) and
// introduces no import cycle.
import { slugFromBranch } from './redgreen-lib.mjs';
// coord-refs.mjs imports nothing, so this adds no new cross-tree edge (plan 3756 step 2
// item 3). It is the JS-side OWNER of the coordination-namespace list that used to be a
// local `isCoordRef` here (plan 1287); scripts/hooks/pre-push.sh's shell `case` is the
// one remaining copy that must be kept in sync with it, since a shell pattern and a JS
// module cannot share a literal. The imported predicate also matches `refs/heads/coord/*`
// — the widening plan 3756 needs before its step 3, and inert until then because no ref
// exists in that namespace yet.
import { isCoordRef } from './coord-refs.mjs';

// Git binary + leading argv prefix, e.g. ['git'] in production. Test-only
// override: PRE_PUSH_DIFF_GIT_BIN='["node","/path/fake-git-cli.mjs"]' lets a
// test point this at an in-repo fake WITHOUT going through OS PATH-based
// executable resolution (which, on Windows, cannot run a non-.exe fake `git`
// without `shell: true` — deprecated as of the 2024 Windows batch-file
// argument-injection hardening, so this seam avoids it entirely rather than
// relying on that pattern). No override ⇒ a plain execFileSync of `git`,
// unchanged from before this seam existed.
const GIT_BIN = process.env.PRE_PUSH_DIFF_GIT_BIN
  ? JSON.parse(process.env.PRE_PUSH_DIFF_GIT_BIN)
  : ['git'];

function runGit(args) {
  const [cmd, ...prefix] = GIT_BIN;
  // plan 844/850 (scripts/coord/coord-git.mjs): a large push's diff/merge-base output
  // can exceed execFileSync's 1MB default stdout buffer (ENOBUFS) — reuse the
  // same generous constant every other git-spawning script in this toolchain
  // uses, so a large diff can't silently crash the tier computation and, via
  // the hook's swallowed-error fallback, skip every gate on exactly the push
  // most likely to carry a real regression.
  return execFileSync(cmd, [...prefix, ...args], { encoding: 'utf8', maxBuffer: GIT_MAXBUFFER });
}

function gitDiffNameOnly(range) {
  const out = runGit(['diff', '--name-only', range]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function mergeBase(a, b) {
  return runGit(['merge-base', a, b]).trim();
}

// True iff `a` is an ancestor of `b`. `merge-base --is-ancestor` exits non-zero
// (throws) when not; a transient failure also lands on false, which routes the
// caller to the merge-base fallback — the conservative, still-correct range.
function gitIsAncestor(a, b) {
  try {
    runGit(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

function isZeroSha(sha) {
  return /^0+$/.test(sha);
}

export function parseRefLines(stdin) {
  return stdin
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

export function qualifyingRefs(stdin) {
  return parseRefLines(stdin).filter((r) => !isCoordRef(r.remoteRef) && !isZeroSha(r.localSha));
}

// The per-ref push ranges themselves (plan 1289) — the same ranges the
// changed-file union below diffs, exposed so the range-scoped guards
// (lint-coord-trailer / assert-seed-io-seam / assert-price-gates-single-site)
// can check exactly the commits THIS push introduces instead of each
// self-defaulting to origin/master..HEAD. Deduped, insertion-ordered.
export function computeRanges(stdin, { base = mergeBase, isAncestor = gitIsAncestor } = {}) {
  const allRefs = parseRefLines(stdin);
  if (allRefs.length === 0) {
    // Fallback: stdin carried NO ref line at all — a manual/test invocation of
    // the hook (a real `git push` always supplies at least one).
    return ['origin/master..HEAD'];
  }

  const refs = qualifyingRefs(stdin);
  // A real push whose every ref is coord/delete (e.g. a single
  // `git push origin :refs/claims/1287 :old-worktree-branch` combining a
  // claim release with a branch cleanup) introduces zero content — return
  // empty rather than falling back to origin/master..HEAD, which would
  // reintroduce the herd-drift bug this script exists to eliminate.
  const ranges = new Set();
  for (const { localSha, remoteSha } of refs) {
    ranges.add(`${resolveRangeStart(localSha, remoteSha, { base, isAncestor })}..${localSha}`);
  }
  return [...ranges];
}

// plan 1345 (review fix I, plan batch-2026-07-05-coord-curation): the range
// START — the boundary such that `start..localSha` contains exactly the
// commits THIS push introduces, excluding anything origin/master already
// carries. A worktree branch's "freshen" (`git fetch && git rebase
// origin/master`, the standard procedure — docs/coord/worktrees.md) can
// leave remoteSha itself sitting BEHIND origin/master's current tip whenever
// the branch's remote ref was last pushed before the freshen (e.g. a branch
// published empty at cut time, so its remote tip IS an old master commit) —
// remoteSha then remains a perfectly good ANCESTOR of localSha (no
// force-push/rewrite occurred), so the "normal fast-forward" branch below still
// fires, but remoteSha..localSha then sweeps in every master commit landed
// between remoteSha and origin/master's tip: foreign, already-reviewed content
// this push never introduced (the plan-1323 incident — 81 intervening master
// commits, 4 flagged by lint-coord-trailer; recurred on plan 1342's pickup).
//
// LAZY by design: this runs in `scripts/hooks/pre-push.sh` on every push across ~5-7
// parallel sessions, and the overwhelming majority are ordinary fast-forwards
// — so `base()` (an actual merge-base VALUE computation, a git subprocess) is
// spawned ONLY on the less-common paths below, never on the fast-forward fast
// path. The staleness signal is instead a single cheap `isAncestor(remoteSha,
// 'origin/master')` check: TRUE means remoteSha is itself reachable from
// origin/master's CURRENT tip — i.e. remoteSha is (an old point on) master's
// own line, the freshen-stale case — FALSE means remoteSha sits on the
// branch's own line, genuinely ahead of the fork point (the ordinary case,
// its own unlanded work, never to be excluded). Under this repo's
// rebase-only freshen discipline (never merge — branch-hygiene.md bans `git
// merge` outside a land) remoteSha and origin/master, when remoteSha is an
// ancestor of localSha, always lie on ONE line relative to each other, so
// this dichotomy is exhaustive (the one edge case — remoteSha sitting EXACTLY
// at the fork point — is itself an ancestor of origin/master too, so it takes
// the slow path and still resolves correctly, just without the fast-path
// shortcut). A masterBase that is itself unresolvable or a transient failure
// propagates like any other git failure here (the caller, scripts/hooks/pre-push.sh,
// already fails open on a non-zero exit from this script).
function resolveRangeStart(localSha, remoteSha, { base, isAncestor }) {
  // The remote sha anchors the range ONLY when it is an ancestor of the local
  // sha (a normal fast-forward push) AND is not itself stale relative to
  // origin/master. On a FORCE-PUSH of a rebased branch the old remote tip is
  // NOT in the local history at all, so remote..local would sweep in every
  // master-side commit the branch was rebased onto — foreign, already-landed
  // content (observed live in the plan-1289 land: a post-rebase force-push
  // flagged 7 of master's own claim-projection commits). Fall back to the
  // merge-base against origin/master, the same anchor a brand-new branch uses:
  // the range is then exactly the branch's own commits.
  if (
    !isZeroSha(remoteSha) &&
    isAncestor(remoteSha, localSha) &&
    !isAncestor(remoteSha, 'origin/master')
  ) {
    return remoteSha;
  }
  return base('origin/master', localSha);
}

export function computeChangedFiles(
  stdin,
  { diff = gitDiffNameOnly, base = mergeBase, isAncestor = gitIsAncestor } = {},
) {
  return filesForRanges(computeRanges(stdin, { base, isAncestor }), { diff });
}

// ── The drain-status gate exemption (plan 3619) ─────────────────────────────
//
// A cloud drain's ONLY channel for its own state is a successful push to origin — and that channel
// sits behind the very gate that can fail, which is why a gate-blocked drain is invisible to every
// observability surface (the 2026-09-01 plan-3595 stall: 4 finished commits held ~3.5h behind a
// failing scripts-battery gate, indistinguishable from a drain that never started). The status
// channel (`scripts/drain-status.mjs`, branch `claude/status/<slug>`) fixes that only if its own
// pushes can get out while the gate is red — so the pre-push hook exempts a push whose ENTIRE diff
// is drain-status files.
//
// Exemption is by CONTENT, never by a flag or an env knob: there is nothing a push can SAY to earn
// it, only what it actually changes. `.drain-status/<slug>.json` is machine-written by that module
// alone, is never imported by app code, and never reaches master (the status branch is its own
// namespace and is deleted when the drain finishes), so a diff confined to it carries no risk the
// battery exists to catch. Anything else in the same push — one line of `scripts/**`, a doc, a
// seed shard — fails `every()` and the full gate runs, which is the property the tests pin.
export const DRAIN_STATUS_PATH_RX = /^\.drain-status\/[^/\\]+\.json$/;

export function isDrainStatusOnlyPush(files) {
  return (
    Array.isArray(files) && files.length > 0 && files.every((f) => DRAIN_STATUS_PATH_RX.test(f))
  );
}

// The whole-hook predicate behind `--drain-status-only`, fail-CLOSED at every step: an empty change
// set is not exempt, and — the one that matters — a stdin carrying NO qualifying ref line is not
// exempt either, so `computeRanges`' `origin/master..HEAD` fallback (a manual or test invocation of
// the hook, where the pushed refs are unknown) can never be the basis for skipping the battery.
export function isDrainStatusOnlyPushStdin(
  stdin,
  { diff = gitDiffNameOnly, base = mergeBase, isAncestor = gitIsAncestor } = {},
) {
  if (qualifyingRefs(stdin).length === 0) return false;
  return isDrainStatusOnlyPush(computeChangedFiles(stdin, { diff, base, isAncestor }));
}

// ── The sweep-checkpoint gate exemption (plan 3682) ─────────────────────────
//
// A second content-based exemption, modeled exactly on the drain-status one above. Plan
// 3682's `--checkpoint-push` (`weekly-price-sweep.py`) commits + pushes the weekly-sweep
// render-pass checkpoint plus the render-store delta rendered so far, every ~25 targets
// across a multi-thousand-target corpus — a cadence the full battery cannot be paid on.
// Exemption is by CONTENT, never by a flag: a push is exempt only when its entire diff is
// confined to the checkpoint file(s) under `sweep-checkpoints/` and/or the render-store
// tree. Anything else in the same push fails `every()` and the full gate runs — the
// branch's real land-time push, over the WHOLE accumulated delta, still runs the full
// battery unconditionally, so this exemption only ever skips the INTERMEDIATE heartbeats,
// never the branch's actual review.
// plan 4172: the checkpoint path is coord.config.json's `sweepCheckpointPattern` (a regex SOURCE,
// null = no such batch job), resolved by the CALLER exactly like renderStoreRx below — this
// module carries no project path of its own. It supersedes plan 4071 T3's "stays a literal"
// ruling, which predates the project-word lint that made the literal a shipped leak.

// A regex that can never match a real repo-relative path — the empty/absent-row degrade for
// renderStorePathRxFor below. Never throws, never matches: a config-less repo (or one whose
// derivedShardDirs dropped its render-store row) simply never takes the render-store half of the
// checkpoint exemption, which is the safe direction (narrower coverage, not a crash and not a
// false exemption).
const NEVER_MATCH_RX = /(?!)/;

function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// plan 4071 T3: RENDER_STORE_PATH_RX used to hardcode the render-store directory as a second
// copy of a path coord-config.mjs's `derivedShardDirs` (plan 1867) already carries.
// Derive it instead: find the ONE derivedShardDirs row whose basename is `render-store` and
// return a `^<dir>/` regex over it. Byte-identical on vetapp today (see the test asserting the
// derived `.source` against the pre-4071 literal); an empty list or a list with no such row
// degrades to NEVER_MATCH_RX rather than throwing — see that constant's own comment.
export function renderStorePathRxFor(derivedShardDirs) {
  const dirs = Array.isArray(derivedShardDirs) ? derivedShardDirs : [];
  const row = dirs.find((d) => typeof d === 'string' && d.split('/').pop() === 'render-store');
  if (!row) return NEVER_MATCH_RX;
  return new RegExp(`^${escapeRegexLiteral(row)}\\/`);
}

// plan 4172: the checkpoint twin of renderStorePathRxFor — compile the configured
// `sweepCheckpointPattern`, or match nothing when the project configures none.
export function sweepCheckpointRxFor(pattern) {
  if (typeof pattern !== 'string' || !pattern) return NEVER_MATCH_RX;
  return new RegExp(pattern);
}

// `renderStoreRx` follows this plan's caller-injects rule: this module carries no project
// knowledge of its own, so the CALLER (main(), the CLI entry point below) resolves
// coord.config.json's derivedShardDirs once and passes the derived regex in. Default
// NEVER_MATCH_RX is the config-less-repo posture, not a real fallback value.
export function isSweepCheckpointOnlyPush(
  files,
  { renderStoreRx = NEVER_MATCH_RX, sweepCheckpointRx = NEVER_MATCH_RX } = {},
) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => sweepCheckpointRx.test(f) || renderStoreRx.test(f))
  );
}

// plan 3682 review round 1 (finding: the exemption was not restricted to worktree
// branches): weekly-price-sweep.py's `_push_checkpoint` only ever targets its OWN
// `worktree-*` branch (it refuses to push anywhere else — see that function's branch
// check), but this hook-side predicate must independently enforce the same restriction,
// never trust the caller. Without it, a checkpoint-only-shaped diff pushed to
// `refs/heads/master` (or any non-worktree ref) would take this exemption while
// `done-worktree.mjs`'s `sweepCheckpointOnWorktreeBranch` guard — itself `worktree-*`-
// scoped — never sees it, so the checkpoint reaches master with no safeguard downstream.
//
// plan 3682 review round 2 (finding 25a360): built on the canonical `slugFromBranch`
// (scripts/coord/redgreen-lib.mjs) rather than a hand-rolled regex — a round-1
// `/^refs\/heads\/worktree-/` matched the EMPTY slug (`refs/heads/worktree-`), which
// `slugFromBranch` correctly rejects (and which the `done-worktree.mjs` land guard,
// itself `slugFromBranch`-based, does not recognize either), so an empty-slug
// destination could take this exemption with no worktree guard on the other end.
const REFS_HEADS_PREFIX = 'refs/heads/';

export function isWorktreeBranchRef(ref) {
  return (
    ref.startsWith(REFS_HEADS_PREFIX) &&
    slugFromBranch(ref.slice(REFS_HEADS_PREFIX.length)) !== null
  );
}

// The whole-hook predicate behind `--sweep-checkpoint-only`, fail-CLOSED at every step —
// same reasoning as isDrainStatusOnlyPushStdin: an empty change set is not exempt, and a
// stdin with NO qualifying ref line (computeRanges' `origin/master..HEAD` fallback, a
// manual/test invocation of the hook) can never be the basis for skipping the battery,
// because that fallback's diff cannot be trusted as "this push's actual delta". A
// non-coord ref whose DESTINATION is not a worktree branch is never exempt either,
// regardless of how checkpoint-only its content looks.
//
// plan 3682 review round 2 (finding 302d5a): the destination check runs over every
// non-coord ref line from `parseRefLines`, DELETIONS INCLUDED — `qualifyingRefs` (used
// just above, and for the content diff) drops a deletion because it carries no content,
// but that same drop used to blind this destination check to it too: a mixed push
// combining a genuine checkpoint-only worktree ref with `:refs/heads/master` saw only
// the worktree ref, took the exemption, and let the deletion through ungated. Coord refs
// (refs/claims/*, refs/coord/*) stay excluded from the destination check, unchanged from
// round 1 — they are a separate, content-free namespace this exemption was never meant
// to gate on.
//
// plan 3682 review round 3 (finding 11): round 2 stopped only the deletions whose
// DESTINATION failed `isWorktreeBranchRef`, which left `:refs/heads/worktree-<other slug>`
// — another session's branch — exempt alongside a genuine cadence ref. A deletion carries
// no content by construction, so no content check can ever vouch for it; the exemption
// therefore refuses ANY non-coord deletion outright rather than judging its destination.
export function isSweepCheckpointOnlyPushStdin(
  stdin,
  {
    diff = gitDiffNameOnly,
    base = mergeBase,
    isAncestor = gitIsAncestor,
    renderStoreRx = NEVER_MATCH_RX,
    sweepCheckpointRx = NEVER_MATCH_RX,
  } = {},
) {
  const refs = qualifyingRefs(stdin);
  if (refs.length === 0) return false;
  const destinationRefs = parseRefLines(stdin).filter((r) => !isCoordRef(r.remoteRef));
  if (destinationRefs.some((r) => isZeroSha(r.localSha))) return false;
  if (!destinationRefs.every((r) => isWorktreeBranchRef(r.remoteRef))) return false;
  return isSweepCheckpointOnlyPush(computeChangedFiles(stdin, { diff, base, isAncestor }), {
    renderStoreRx,
    sweepCheckpointRx,
  });
}

// The changed-file union over ALREADY-RESOLVED ranges (plan 1289). The hook
// resolves the push's ranges ONCE (--ranges) and derives $CHANGED from those
// SAME ranges via --files-for, so the range-scoped guards and the $CHANGED tier
// gates can never scope to two different commit sets for one push (a sibling
// advancing origin/master between two independent merge-base resolutions used
// to make that possible), and the new-branch merge-base is resolved once, not
// twice.
export function filesForRanges(ranges, { diff = gitDiffNameOnly } = {}) {
  const changed = new Set();
  for (const range of ranges) {
    for (const f of diff(range)) changed.add(f);
  }
  return [...changed].sort();
}

export function main() {
  // `--files-for <range>...` (plan 1289): no stdin — print the changed-file
  // union over the given, already-resolved ranges.
  const argv = process.argv.slice(2);
  if (argv[0] === '--files-for') {
    const files = filesForRanges(argv.slice(1));
    process.stdout.write(files.length ? files.join('\n') + '\n' : '');
    return;
  }

  const stdin = readStdin();

  // `--drain-status-only` (plan 3619): no stdout — the EXIT STATUS is the answer, so the shell
  // hook can branch on it with a bare `if node scripts/compute-push-diff.mjs --drain-status-only`.
  // Any git failure throws out of here and exits non-zero, which reads as "not exempt" — the
  // fail-closed direction: a push that cannot be proven status-only always runs the full battery.
  if (argv.includes('--drain-status-only')) {
    process.exitCode = isDrainStatusOnlyPushStdin(stdin) ? 0 : 1;
    return;
  }

  // `--sweep-checkpoint-only` (plan 3682): same no-stdout, exit-status-is-the-answer shape
  // as `--drain-status-only` above, so `scripts/hooks/pre-push.sh` can branch on it with a bare
  // `if node scripts/compute-push-diff.mjs --sweep-checkpoint-only`. Any git failure throws
  // out of here and exits non-zero — fail-closed, same as its twin.
  //
  // plan 4071 T3: this is the CLI entry point the render-store regex's caller-injects rule names
  // — its only caller is the shell — so it resolves coord.config.json ONCE here and derives the
  // regex from `derivedShardDirs`, rather than a leaf module reading the config for itself. A
  // config-load failure (like a git failure just above) propagates uncaught and exits non-zero:
  // the same fail-closed direction this flag already documents.
  if (argv.includes('--sweep-checkpoint-only')) {
    const repoRoot = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
    const cfg = loadCoordConfig(repoRoot);
    const renderStoreRx = renderStorePathRxFor(cfg.derivedShardDirs);
    const sweepCheckpointRx = sweepCheckpointRxFor(cfg.sweepCheckpointPattern);
    process.exitCode = isSweepCheckpointOnlyPushStdin(stdin, { renderStoreRx, sweepCheckpointRx })
      ? 0
      : 1;
    return;
  }

  // `--ranges` (plan 1289): print the per-ref ranges (one per line) instead of
  // the changed-file union — consumed by scripts/hooks/pre-push.sh to feed the
  // range-scoped guards AND (via --files-for) the $CHANGED tier computation.
  // Default (no flag) stdin mode is byte-identical to the plan-1287 behavior
  // (kept as the hook's fallback when the range computation failed, and for CI
  // or manual callers).
  const out = argv.includes('--ranges') ? computeRanges(stdin) : computeChangedFiles(stdin);
  process.stdout.write(out.length ? out.join('\n') + '\n' : '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
