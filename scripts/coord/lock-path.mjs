#!/usr/bin/env node
// scripts/coord/lock-path.mjs — the shared git-common-dir lock-path resolution behind
// `landing-lock.mjs`, `battery-lock.mjs`, and `worktree-lock.mjs` (plan 2478).
//
// WHY: all three locks independently resolve their lockfile to the same rendezvous — the
// SHARED `.git` common dir (`git rev-parse --git-common-dir`, absolutised) — so every worktree
// of one clone lands on the same file, and it is never git-tracked / never swept by
// `git clean -fdx`. Two of the three copies additionally scrub `GIT_*` out of the child env
// before resolving: this runs inside a git hook, where `GIT_DIR` / `GIT_INDEX_FILE` are exported
// into every child and can point at a worktree gitdir mid-operation — an unscrubbed
// `-C <anchor>` resolution lets `GIT_DIR` override repository discovery entirely and resolve a
// FOREIGN repo's common dir, while the scrubbed call is deterministic. There is no case where
// the scrub changes a correct result, so this shared helper always scrubs.
//
// SCOPE — deliberately narrow, the `excl-lock.mjs` precedent: this is ONLY the anchor-to-common-
// dir resolution. Each caller keeps its own lockfile filename (machine-global rendezvous — a
// rename orphans live locks) and its own identity/staleness/reap model.
//
// Found by /sonnet-review high on plan 2473 (finding [7]) — the third hand-rolled copy of this
// exact algorithm; see plan 1678 for the same pattern one layer down (the O_EXCL primitive).

import { execFileSync } from 'node:child_process';
import nodePath from 'node:path';
import { gitIsolatedEnv } from './child-env.mjs';

// Resolve the absolute path of the shared `.git` common dir anchored at `anchor`, with every
// `GIT_*` env var scrubbed from the child process first.
// `_path` is injectable (defaults to the real `node:path`) so the Windows separator/drive-letter
// semantics are regression-tested on any platform — see lock-path.test.mjs.
export function resolveCommonDirPath({ anchor, _exec = execFileSync, _path = nodePath }) {
  // plan 2604: the prefix match is CASE-INSENSITIVE via the shared childEnv primitive. The
  // hand-rolled `k.startsWith('GIT_')` here was case-sensitive, and on win32 — where env lookup
  // is case-insensitive but a spread copy of process.env is not — a `git_dir=…` in the ambient
  // shell survived the scrub and the child still resolved it as GIT_DIR, which is precisely the
  // cross-checkout misresolution this function exists to prevent. Same bug class as the hatch
  // leak this plan fixes, found by the same review; fixed here rather than left to recur.
  const env = gitIsolatedEnv();
  const common = _exec('git', ['-C', anchor, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    env,
  }).trim();
  // A single `resolve(anchor, common)` call covers both shapes git's `--git-common-dir` returns
  // on Windows: an ABSOLUTE MSYS-style forward-slash path from a linked worktree, or a RELATIVE
  // `.git` from the main checkout. `resolve()`'s own right-to-left absolute-path short-circuit
  // already discards `anchor` once `common` is absolute, so it normalizes (backslash-collapses)
  // that branch too — the old `isAbsolute(common) ? common : resolve(anchor, common)` ternary
  // instead returned the absolute branch UNCHANGED, so the same physical common dir resolved to
  // two different strings (raw forward slashes vs. backslash-normalized) depending on which
  // checkout you resolved from, silently defeating cross-checkout lock rendezvous.
  return _path.resolve(anchor, common);
}
