#!/usr/bin/env node
// scripts/sweep-stray-stashes.mjs — clean up orphaned WIP stashes left on the
// shared `.git` (plan 230 Task 4).
//
// Two sources of stray stashes:
//   1. lint-staged's stash-dance orphans a `WIP on master: …` stash when the
//      pre-commit hook dies mid-flight (e.g. on an index.lock collision).
//   2. The pre-yield safety net (plan 230 Task 3) creates named
//      `wip-<slug>-<ts>` stashes when a session yields with a dirty tree.
//
// Policy: a stray stash whose diff is already SUBSUMED by HEAD (reverse-applies
// cleanly) is safe to drop — its content has since been committed. A stray
// stash that is NOT subsumed holds real un-landed work and is SURFACED to the
// operator, never auto-dropped. Anything we can't classify with confidence is
// treated as not-subsumed (surface, don't drop) — the safe direction.
//
// Usage:
//   node scripts/sweep-stray-stashes.mjs            # act: drop subsumed, surface the rest
//   node scripts/sweep-stray-stashes.mjs --dry-run  # report only, change nothing

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  GIT_MAXBUFFER,
  STASH_LIST_ARGS,
  SWEEP_SURFACED_EXIT,
  parseStashList,
} from './coord-git.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

// A stash subject is "stray" if it's an auto WIP (`WIP on <branch>: …`) or one
// of our named pre-yield stashes (`… wip-<slug>-<ts>`).
export function isStrayStash(subject) {
  return /\bWIP on \S+:/.test(subject) || /\bwip-[A-Za-z0-9._-]+/.test(subject);
}

// parseStashList + STASH_LIST_ARGS moved to coord-git.mjs (plan 1863) so the pre-land
// orphan-autostash guard (land-lib.mjs) and this sweep share ONE format + parser.

function git(dir, args, opts = {}) {
  // plan 850: `git stash show -p` of a stash snapshotting a large working tree can exceed the
  // 1MB execFileSync default → ENOBUFS. Match the spine's shared GIT_MAXBUFFER (a caller can override).
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
    env: gitRepoIsolatedEnv(),
    ...opts,
  });
}

// git's canonical empty-tree object id — what a `--include-untracked` ^3 parent
// resolves to when nothing was untracked at park time.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// True if the stash's TRACKED changes are already present in HEAD — i.e. dropping it
// loses nothing. Two guards keep it safe (plan 1108):
//   1. A `--include-untracked` stash (what pre-yield-guard creates) carries its
//      untracked files in a THIRD parent (ref^3) the tracked comparison can't see, so a
//      NON-EMPTY ^3 → surface (never drop). pre-yield-guard ALWAYS parks with
//      --include-untracked, so it synthesizes a ^3 even with nothing untracked (then ^3
//      == git's empty tree); an empty ^3 holds nothing, so evaluate the tracked changes.
//      On ANY inability to determine ^3 contents → surface (the safe direction).
//   2. Subsumption is judged against HEAD, NOT the working tree. The old check did a
//      `git apply --check --reverse` (no --cached) which applies against the WORKING
//      TREE — so an uncommitted edit that merely RE-presents the stashed change made the
//      stash look subsumed and get dropped, losing work that was never committed.
// Any failure (no tracked diff, git error) → false (surface, don't drop).
export function isSubsumedByHead(dir, ref) {
  let hasCaret3 = false;
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^3`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    hasCaret3 = true;
  } catch {
    /* no ^3 → tracked-only stash, safe to evaluate below */
  }
  if (hasCaret3) {
    let tree;
    try {
      tree = git(dir, ['rev-parse', `${ref}^3^{tree}`]).trim();
    } catch {
      return false; // can't determine ^3 contents → surface, never drop
    }
    if (tree !== EMPTY_TREE_SHA) return false; // real untracked work → surface
  }
  // The tracked paths the stash changed (its base ^1 → the stash commit). --no-renames
  // so a rename lists BOTH sides (delete source + add dest) — default rename detection
  // would emit only the destination, hiding the source deletion and letting a
  // partially-landed rename look subsumed and get dropped (plan 1108 re-review).
  let names;
  try {
    names = git(dir, ['diff', '--name-only', '--no-renames', `${ref}^1`, ref])
      .split('\n')
      .map((s) => s.replace(/\r$/, ''))
      .filter(Boolean);
  } catch {
    return false;
  }
  if (!names.length) return false; // no tracked diff → nothing to reason about
  // Subsumed iff the stash's post-state for those paths already equals HEAD.
  try {
    git(dir, ['diff', '--quiet', ref, 'HEAD', '--', ...names], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true; // no diff between stash and HEAD on changed paths → subsumed
  } catch {
    return false; // differs from HEAD (or git error) → surface, never drop
  }
}

// Plan 3206 Task 3: true if a stray stash holds NOTHING AT ALL — the shape a line-ending-
// only rewrite produces (`.gitattributes`'s `* text=auto eol=lf` normalizes it away on the
// way INTO the stash, so the resulting commit's tree is byte-identical to the commit it was
// parked on top of). Distinct from isSubsumedByHead above: a no-op stash has NO tracked diff
// to reverse-apply in the first place (`git diff --name-only ref^1 ref` is empty), so
// isSubsumedByHead's `if (!names.length) return false;` guard reports it as "cannot
// classify" — exactly backwards for this shape (measured 2026-08-15: the dry run offered to
// drop 2 of 466 stray stashes and surfaced 464 as "un-landed work", when those 464 were the
// empty ones). Droppable iff:
//   1. the stash's own tree (working-tree snapshot, `ref^{tree}`) equals its base's tree
//      (`ref^1^{tree}`) — nothing changed in the working tree relative to the commit it was
//      parked on top of.
//   2. the INDEX parent (`ref^2^{tree}`) also equals the base tree — nothing was staged
//      either.
//   3. the untracked parent (`ref^3`, present only on a `--include-untracked` stash — what
//      pre-yield-guard always creates) is ABSENT or resolves to the canonical empty tree —
//      nothing untracked was carried either.
// Any failure to resolve a tree → false (surface, the safe direction — mirrors
// isSubsumedByHead's own failure handling above).
export function isNoOpStash(dir, ref) {
  let baseTree;
  try {
    baseTree = git(dir, ['rev-parse', `${ref}^1^{tree}`]).trim();
  } catch {
    return false;
  }
  let stashTree;
  try {
    stashTree = git(dir, ['rev-parse', `${ref}^{tree}`]).trim();
  } catch {
    return false;
  }
  if (stashTree !== baseTree) return false; // working-tree snapshot differs from base → real
  let indexTree;
  try {
    indexTree = git(dir, ['rev-parse', `${ref}^2^{tree}`]).trim();
  } catch {
    return false;
  }
  if (indexTree !== baseTree) return false; // staged snapshot differs from base → real
  let hasCaret3 = false;
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^3`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    hasCaret3 = true;
  } catch {
    /* no ^3 → nothing untracked was carried, consistent with "no-op" */
  }
  if (hasCaret3) {
    let untrackedTree;
    try {
      untrackedTree = git(dir, ['rev-parse', `${ref}^3^{tree}`]).trim();
    } catch {
      return false;
    }
    if (untrackedTree !== EMPTY_TREE_SHA) return false; // real untracked content → not a no-op
  }
  return true;
}

export function sweep(dir, { dryRun = false, log = console.log } = {}) {
  const raw = git(dir, STASH_LIST_ARGS);
  const all = parseStashList(raw);
  const stray = all.filter((s) => isStrayStash(s.subject));

  // plan 3206 Task 3: classify a true no-op FIRST, alongside the existing subsumption test
  // — a no-op stash has no tracked diff for isSubsumedByHead to reason about at all, so it
  // must never fall through to that check (which would report it "cannot classify" and
  // surface it forever). Every other unclassifiable case keeps the existing conservative
  // default (surface, don't drop).
  const subsumed = [];
  const noOp = [];
  const surfaced = [];
  for (const s of stray) {
    if (isNoOpStash(dir, s.ref)) noOp.push(s);
    else if (isSubsumedByHead(dir, s.ref)) subsumed.push(s);
    else surfaced.push(s);
  }

  if (!stray.length) {
    log('sweep-stray-stashes: no stray WIP stashes found — clean.');
    return { dropped: [], droppedNoOp: [], surfaced: [], dryRun };
  }

  // Drop subsumed + no-op stashes from highest index to lowest so stash@{N} refs don't
  // shift under us mid-loop — both buckets are drop-safe, so they share one combined pass,
  // sorted together; only the LOG output (below) keeps them in separate buckets so an
  // operator reading the run can tell an empty park from a subsumed one (plan 3206 Task 3).
  const dropped = [];
  const droppedNoOp = [];
  if (!dryRun) {
    const combined = [
      ...subsumed.map((s) => ({ s, noOp: false })),
      ...noOp.map((s) => ({ s, noOp: true })),
    ].sort((a, b) => stashIndex(b.s.ref) - stashIndex(a.s.ref));
    for (const { s, noOp: isNoOp } of combined) {
      git(dir, ['stash', 'drop', s.ref]);
      (isNoOp ? droppedNoOp : dropped).push(s);
    }
  }

  for (const s of subsumed) {
    log(
      `${dryRun ? '[dry-run] would drop' : 'dropped'} (subsumed by HEAD): ${s.ref} — ${s.subject}`,
    );
  }
  for (const s of noOp) {
    log(
      `${dryRun ? '[dry-run] would drop' : 'dropped'} (no-op, nothing stored): ${s.ref} — ${s.subject}`,
    );
  }
  if (surfaced.length) {
    log('\n⚠ NON-SUBSUMED stray stashes — these hold un-landed work, NOT dropped:');
    for (const s of surfaced) log(`   ${s.ref} — ${s.subject}`);
    log(
      '   Inspect with `git stash show -p <ref>`; recover with `git stash pop <ref>` or drop manually.',
    );
  }
  return {
    dropped: dryRun ? [] : dropped,
    droppedNoOp: dryRun ? [] : droppedNoOp,
    surfaced,
    dryRun,
  };
}

function stashIndex(ref) {
  const m = /stash@\{(\d+)\}/.exec(ref);
  return m ? Number(m[1]) : 0;
}

export function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dir = process.cwd();
  const { surfaced } = sweep(dir, { dryRun });
  // Non-zero exit if there's un-landed work the operator must look at, so a
  // handoff wrapper can prompt. Dropping subsumed stashes is not a failure.
  process.exit(surfaced.length > 0 ? SWEEP_SURFACED_EXIT : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
