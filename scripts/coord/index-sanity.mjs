#!/usr/bin/env node
// scripts/coord/index-sanity.mjs — the ONE truncated-index predicate (plan 3968).
//
// A pathspec commit run through lint-staged on the shared MAIN checkout can leave
// `.git/index` torn: lint-staged 17's "Updating Git index again" step runs `git
// update-index --again` TWICE (once against the active index, once against the default
// lock when they differ), and a death mid-write on a 131k-entry index can leave a few
// KB where 25 MB used to be. With `feature.manyFiles`'s `index.skipHash` in effect the
// torn write reads back as a "valid" tiny index instead of git refusing it as corrupt —
// so `git status` reports the WHOLE tree as deleted plus untracked, and every tool that
// reads status (heal-main, the Stop-hook auto-park, done-worktree preflight) sees a
// catastrophically dirty MAIN that isn't real.
//
// This predicate is read-only and cheap (a handful of `git` invocations plus one `stat`).
// Both heal-main.mjs (repair) and pre-yield-guard.mjs (refuse to park) call it before doing
// anything else — see their own headers for where.
//
// Gated on a FLOOR (plan 3968 task 3, pinned at spec-pass): a tree under 1,000 tracked
// paths never trips this predicate at all, however small or unreadable its index is —
// a legitimately tiny repo (an isolated-plan-repo test fixture, a brand-new project)
// naturally carries a small index, and this guard exists to catch a SPECIFIC pathology
// on a large shared checkout, not to police every repo's index for well-formedness.
// Below the floor there is nothing this predicate can safely say, so it says "not
// truncated" and gives the reason.
//
// TWO-SIGNAL RULE for the ratio branch (plan 3968 review, findings 136533/a4160a): a low
// index-count-to-HEAD ratio alone is not proof of truncation — a SPARSE checkout
// legitimately materializes only a slice of HEAD's tree, and a `git reset` "fix" over one
// would destroy the sparse selection. So (1) a sparse checkout is never even considered —
// `not-applicable`, reported and never reset, regardless of its ratio (sparse is proven by
// `core.sparseCheckout=true` OR a non-empty `sparse-checkout list`, NEVER by `index.sparse`
// alone — round 2 of this same review, findings 188436/c24117/6e0c97: `index.sparse` is a
// performance flag a normal DENSE checkout can also carry, so it cannot stand as proof on
// its own); (2) otherwise BOTH the count ratio (<10% of HEAD by count) AND a staged-deletion
// ratio (≥90% of HEAD's paths showing as `D` in `git diff --cached --diff-filter=D` against
// the index) must hold. A torn index shows the WHOLE tree missing, so both signals fire
// together; a deliberate `git rm -r --cached <subtree>` that still leaves the bulk of HEAD
// represented in the index does not reach the 90% deletion floor. (A `git rm -r --cached` of
// the ENTIRE tree is indistinguishable from a torn index by either signal — there is no way
// to tell "the user meant to untrack everything" from "the index died" using git's own
// bookkeeping alone; this predicate is deliberately conservative there, same as before this
// review.) If the staged-deletion probe itself cannot be run (round 2, finding 6f8265: a
// `git diff --cached` failure used to be swallowed to ratio `0`, i.e. "healthy" — the exact
// fail-OPEN this predicate exists to avoid), the verdict is `unknown: true`, never a plain
// `truncated: false` — see computeIndexSanity's own comment on that branch. Round 3 (finding
// 8e0d39) applies the same rule one probe earlier: if the SPARSE-checkout signals themselves
// both fail unexpectedly (as opposed to running and reporting an ordinary "not configured"),
// this predicate has no way to tell "genuinely sparse" from "dense and torn" either, so that
// is `unknown: true` too — never silently read as "not sparse" and allowed to fall through to
// the ratio/deletion branch, which could reset a real sparse checkout's selection. Round 3
// (findings 259857/9881c6) extends the same principle upstream of the ratio branch entirely: a
// FAILED index-file stat or a FAILED `git ls-files --cached` proves nothing about the index's
// actual state — only a SUCCESSFUL read that shows the index missing/too-small, or the ratio
// math itself, is `truncated: true`.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_MAXBUFFER } from './coord-git.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';
import { gitIsolatedEnv } from './child-env.mjs';

// git's own index format opens with a 12-byte header ("DIRC" + 4-byte version + 4-byte
// entry count); anything shorter cannot even hold that and is unambiguously torn.
export const GIT_INDEX_HEADER_BYTES = 12;

// The tree-size floor and the entry-count ratio task 3 pins, plus the deletion-ratio floor
// the two-signal rule above adds. These are exported so a test can construct a fixture that
// sits exactly at a boundary without hand-copying the numbers.
export const TRUNCATED_INDEX_HEAD_FLOOR = 1000;
export const TRUNCATED_INDEX_RATIO = 0.1;
export const TRUNCATED_INDEX_DELETION_RATIO = 0.9;

// plan 3968 review (6dfcad/4661b5/d12eb5): NEVER honour an ambient `GIT_INDEX_FILE` /
// `GIT_DIR` / `GIT_WORK_TREE` / … — this predicate must always read `dir`'s own DEFAULT
// index, even when invoked from inside a git hook that has one of these set for a different
// (temp pathspec-commit, or linked-worktree) index. `gitIsolatedEnv` is the shared seam
// lock-path.mjs already uses for this exact genre of local, network-free git read.
function git(dir, args, { exec = execFileSync } = {}) {
  return exec('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER, // a 131k-path ls-tree/ls-files listing overflows the 1MB default
    env: gitIsolatedEnv(),
  });
}

function countNonBlankLines(text) {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}

function firstErrLine(e) {
  return String(e?.message || e)
    .split('\n')[0]
    .trim();
}

// The raw `.git/index` file's own health, independent of anything `git` reports: absent
// is a legitimate empty-index state (not itself evidence of truncation — the ratio check
// below is what judges an empty index against a populated HEAD); shorter than the format's
// own header is unambiguous corruption (a SUCCESSFUL stat that read back too few bytes).
// Also returns the file's mtime+size where readable — used only as part of the memo key
// below, never as evidence.
//
// plan 3968 review round 3 (259857): a `statSync` failure that is NOT `ENOENT` — a transient
// EPERM/EBUSY, an I/O error — proves nothing about the index's actual content; it only proves
// the probe itself could not run. Treating that the same as a positive "the file is too small"
// read used to let a transient filesystem hiccup masquerade as confirmed truncation (see
// computeIndexSanity's `unreadable` handling below). Kept as its own state (not folded into
// `too-small`) so the caller can tell "a real read said this" from "the read never happened".
function rawIndexFileCheck(indexPath, { statFn = statSync } = {}) {
  let stat;
  try {
    stat = statFn(indexPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent' };
    return { state: 'stat-failed', detail: firstErrLine(e) };
  }
  if (stat.size < GIT_INDEX_HEADER_BYTES) return { state: 'too-small', size: stat.size };
  return { state: 'ok', size: stat.size, mtimeMs: stat.mtimeMs };
}

// plan 3968 review (188436/c24117/6e0c97, round 2): sparse is proven by `core.sparseCheckout`
// OR a non-empty `sparse-checkout list` — NEVER by `index.sparse` alone. `index.sparse` is a
// PERFORMANCE flag (sparse-index representation, git ≥ 2.35) that a normal DENSE checkout can
// carry too (set globally, or inherited from a template) with sparse-checkout itself never
// enabled — in that shape the index legitimately holds every HEAD path, and treating
// `index.sparse=true` alone as proof of narrowing let a genuinely torn low-entry index on a
// dense tree read as `not-applicable` and skip heal-main's reset. `core.sparseCheckout=true` and
// a populated pattern list are both direct evidence that the checkout is ACTUALLY narrowed;
// `index.sparse` is consulted nowhere in this predicate any more, only as informational context
// callers may log alongside the other two.
// plan 3968 review round 3 (8e0d39): a probe FAILURE — the git process erroring in a way
// neither signal's own "not configured" shape predicts (a corrupt config file, an unexpected
// exec-layer error) — is not the same as a probe that RAN and reported "not sparse via this
// signal". `git config --bool core.sparseCheckout` exits 1 with NO stderr when the key is
// simply unset — the ordinary negative answer; `git sparse-checkout list` exits non-zero with
// a "not sparse" message when sparse-checkout was never initialized — also an ordinary
// negative. Anything else (a different exit code, unexpected stderr) is a genuine failure this
// predicate did not expect and cannot silently read as "not sparse": doing so let a real sparse
// checkout's legitimately low-entry index reach the ratio/deletion branch below and get reset,
// destroying the sparse selection (the exact failure mode this finding names). Returns
// `{ sparse, unknown }` — `unknown` only when BOTH signals failed unexpectedly, since either
// signal succeeding (in either direction) is a decisive answer on its own.
function isSparseCheckout(dir, { exec = execFileSync } = {}) {
  let configProbeFailed = false;
  try {
    if (git(dir, ['config', '--bool', 'core.sparseCheckout'], { exec }).trim() === 'true') {
      return { sparse: true, unknown: false };
    }
  } catch (e) {
    if (e?.status !== 1 || String(e?.stderr || '').trim() !== '') configProbeFailed = true;
  }
  let listProbeFailed = false;
  try {
    // Errors ("fatal: this worktree is not sparse") when sparse-checkout was never
    // initialized; succeeds with a non-empty pattern list when it was.
    if (git(dir, ['sparse-checkout', 'list'], { exec }).trim() !== '') {
      return { sparse: true, unknown: false };
    }
  } catch (e) {
    if (!/not sparse/i.test(String(e?.stderr || e?.message || ''))) listProbeFailed = true;
  }
  return { sparse: false, unknown: configProbeFailed && listProbeFailed };
}

// plan 3968 review (136533/a4160a, signal 2): the fraction of HEAD's tracked paths that show
// as staged DELETIONS in `dir`'s index relative to HEAD. See the module header's TWO-SIGNAL
// RULE for what this does and does not distinguish.
//
// plan 3968 review round 2 (finding 6f8265): this used to catch a `git diff --cached` failure
// and return `0` — "no deletions found" — which reads as a HEALTHY two-signal verdict below
// (deletionRatio 0 < the 0.9 floor ⇒ "deliberate partial untrack, not a torn index"). That is
// a fail-OPEN: an index too damaged for `git diff --cached` to even run is exactly the kind of
// state this predicate exists to catch, not wave through as fine because one of its two probes
// happened to error. So this now PROPAGATES the error — the caller (computeIndexSanity) is
// responsible for turning "the probe itself failed" into an `unknown` verdict, never a plain
// `truncated: false`.
function stagedDeletionRatio(dir, headCount, { exec = execFileSync } = {}) {
  if (headCount <= 0) return 0;
  const text = git(dir, ['diff', '--cached', '--name-only', '--diff-filter=D'], { exec });
  return countNonBlankLines(text) / headCount;
}

// Per-process memo (plan 3968 review, c4ee3d): heal-main's own step 0 (healTruncatedIndex)
// and its later healDirt→pre-yield-guard arm both call this on the SAME mainDir within one
// run, each re-listing a 131k-path HEAD tree and index — twice the cost for the same answer.
// Keyed on (dir, HEAD sha, raw index file state+size+mtime): a `git reset` between the two
// calls rewrites the index file, which changes its mtime/size and busts the cache
// automatically — no manual invalidation needed, and a HEAD change (a commit landing
// mid-run) busts it the same way via the sha component. Safe as a module-level, never-evicted
// Map ONLY because every caller of this module is entrypoint-guarded and runs as its own
// short-lived process (heal-main.mjs, pre-yield-guard.mjs) — see
// main-checkout-rebase-guard.mjs's header for the same per-process-cache precedent.
const _sanityMemo = new Map();

// → { truncated, headCount, indexCount, why, unknown? }. `unknown: true` (always paired with
// `truncated: false`) is a THIRD verdict — the two-signal ratio branch's staged-deletion probe
// itself failed, so this predicate cannot tell truncated from deliberate-partial-untrack at
// all; every caller must check `unknown` explicitly rather than reading a bare `truncated`
// (see the TWO-SIGNAL RULE comment above and finding 6f8265). Never throws — an unreadable HEAD (a
// brand-new repo with no commits yet, a detached checkout mid-repair) is a DIFFERENT
// problem than this predicate exists to catch, so it reports `unknown: true` (round 4, findings
// 96d27f/c7e645 — a failed HEAD/HEAD-tree probe used to report a bare `truncated: false`,
// indistinguishable from a probe that ran and found the index healthy) with the reason rather
// than crashing a caller that runs this first, before anything else, on every heal-main pass and
// every pre-yield-guard commit-safe park.
//
// `exec` is injectable (default `execFileSync`) so a test can prove the memo actually skips
// the expensive listing on a cache hit — review finding f38c5d removed the previous
// `headFloor`/`ratio` override options (no production caller used them, and the override was
// a bypass surface: `{ headFloor: 0, ratio: 0 }` makes any non-empty index read healthy); this
// is the one remaining option, and it is a testability seam, not a policy knob. `statFn`
// (default `statSync`) is the same kind of seam, added round 3 (finding 259857) so a test can
// pin the stat-failure branch without needing a real EPERM/EIO on disk.
export function checkIndexSanity(mainDir, { exec = execFileSync, statFn = statSync } = {}) {
  let headSha;
  try {
    headSha = git(mainDir, ['rev-parse', 'HEAD'], { exec }).trim();
  } catch (e) {
    // Review findings 96d27f/c7e645: a FAILED HEAD probe used to report a plain
    // `truncated: false` — indistinguishable from a probe that actually RAN and found the
    // index healthy — so a caller (heal-main's `healTruncatedIndex`, pre-yield-guard's
    // commit-safe park) could proceed as though the index had been verified when it had not
    // been checked at all. Same third verdict every other failed probe in this module already
    // uses: `unknown: true`, never a bare healthy result.
    return {
      truncated: false,
      unknown: true,
      headCount: null,
      indexCount: null,
      why: `probe-error: cannot read HEAD (${firstErrLine(e)}) — index state unknown, treating as unsafe`,
    };
  }

  const commonDir = resolveCommonDirPath({ anchor: mainDir });
  const indexPath = join(commonDir, 'index');
  const raw = rawIndexFileCheck(indexPath, { statFn });
  const memoKey = [mainDir, headSha, raw.state, raw.size ?? '', raw.mtimeMs ?? ''].join(' ');
  const cached = _sanityMemo.get(memoKey);
  if (cached) return cached;

  const result = computeIndexSanity(mainDir, raw, { exec });
  _sanityMemo.set(memoKey, result);
  return result;
}

function computeIndexSanity(mainDir, raw, { exec }) {
  let headCount;
  try {
    headCount = countNonBlankLines(
      git(mainDir, ['ls-tree', '-r', 'HEAD', '--name-only'], { exec }),
    );
  } catch (e) {
    // Review findings 96d27f/c7e645: same principle as the HEAD-sha probe above — a failed
    // `ls-tree HEAD` proves nothing about the index's actual state, only that this probe could
    // not run, so it must never be reported as a healthy `truncated: false`.
    return {
      truncated: false,
      unknown: true,
      headCount: null,
      indexCount: null,
      why: `probe-error: cannot read HEAD's tree (${firstErrLine(e)}) — index state unknown, treating as unsafe`,
    };
  }
  if (headCount < TRUNCATED_INDEX_HEAD_FLOOR) {
    return {
      truncated: false,
      headCount,
      indexCount: null,
      why: `HEAD has only ${headCount} path(s), below the ${TRUNCATED_INDEX_HEAD_FLOOR}-path floor`,
    };
  }

  // plan 3968 review round 3 (259857): a FAILED stat is never evidence of truncation — it is
  // only evidence that this predicate could not read the index at all. Only a SUCCESSFUL read
  // that shows the index missing/too-small (below) is `truncated: true`; a failed one is
  // `unknown: true`, the same third verdict the staged-deletion probe already uses.
  if (raw.state === 'stat-failed') {
    return {
      truncated: false,
      unknown: true,
      headCount,
      indexCount: null,
      why: `probe-error: could not stat the index file (${raw.detail}) — index state unknown, treating as unsafe`,
    };
  }
  if (raw.state === 'too-small') {
    return {
      truncated: true,
      headCount,
      indexCount: null,
      why: `index file is ${raw.size} byte(s), below the ${GIT_INDEX_HEADER_BYTES}-byte git-index header`,
    };
  }

  let indexCount;
  try {
    indexCount = countNonBlankLines(git(mainDir, ['ls-files', '--cached'], { exec }));
  } catch (e) {
    // plan 3968 review round 3 (9881c6): same principle as the stat-failure branch above — a
    // FAILED `ls-files --cached` proves nothing about the index's actual entry count, only that
    // the probe itself could not run. `unknown: true`, never a plain `truncated: true`.
    return {
      truncated: false,
      unknown: true,
      headCount,
      indexCount: null,
      why: `probe-error: git ls-files --cached failed (${firstErrLine(e)}) — index state unknown, treating as unsafe`,
    };
  }
  const threshold = Math.floor(headCount * TRUNCATED_INDEX_RATIO);
  if (indexCount < threshold) {
    const sparseCheck = isSparseCheckout(mainDir, { exec });
    // plan 3968 review round 3 (8e0d39): a probe FAILURE on both sparse signals is not proof of
    // "not sparse" — a low-entry index on a genuinely sparse checkout must never fall through
    // to the deletion-ratio branch and get reset just because this predicate could not confirm
    // sparseness. `unknown: true`, same as every other probe-failure branch in this function.
    if (sparseCheck.unknown) {
      return {
        truncated: false,
        unknown: true,
        headCount,
        indexCount,
        why: `index holds ${indexCount}/${headCount} path(s), below the ratio floor, but the sparse-checkout probe itself failed — index state unknown, treating as unsafe`,
      };
    }
    if (sparseCheck.sparse) {
      return {
        truncated: false,
        headCount,
        indexCount,
        why: `index holds ${indexCount}/${headCount} path(s), below the ratio floor, but this is a SPARSE checkout — not-applicable, never reset`,
      };
    }
    let deletionRatio;
    try {
      deletionRatio = stagedDeletionRatio(mainDir, headCount, { exec });
    } catch (e) {
      // plan 3968 review round 2 (6f8265): the probe itself failed — this predicate has no
      // way to tell "deliberate partial untrack" from "torn index" without it, so it must NOT
      // fall back to either verdict. `unknown: true` is a THIRD state callers must check
      // explicitly (heal-main skips its reset and says so; pre-yield-guard refuses to park,
      // same as `truncated: true`) — never conflated with a plain healthy `truncated: false`.
      return {
        truncated: false,
        unknown: true,
        headCount,
        indexCount,
        why: `probe-error: could not compute the staged-deletion ratio (${firstErrLine(e)}) — index state unknown, treating as unsafe`,
      };
    }
    if (deletionRatio < TRUNCATED_INDEX_DELETION_RATIO) {
      return {
        truncated: false,
        headCount,
        indexCount,
        why:
          `index holds ${indexCount}/${headCount} path(s), below the ratio floor, but only ` +
          `${Math.round(deletionRatio * 100)}% of HEAD shows as staged deletions (below the ` +
          `${Math.round(TRUNCATED_INDEX_DELETION_RATIO * 100)}% two-signal floor) — looks like ` +
          `a deliberate partial untrack, not a torn index`,
      };
    }
    return {
      truncated: true,
      headCount,
      indexCount,
      why: `index holds ${indexCount} path(s), below ${Math.round(TRUNCATED_INDEX_RATIO * 100)}% of HEAD's ${headCount}`,
    };
  }
  return {
    truncated: false,
    headCount,
    indexCount,
    why: `index holds ${indexCount}/${headCount} path(s)`,
  };
}
