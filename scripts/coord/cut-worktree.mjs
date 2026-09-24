#!/usr/bin/env node
// scripts/cut-worktree.mjs — cut a plan worktree off the TRUE origin tip (plan 871).
//
// The pickup-plan worktree-creation step used to run `git worktree add … origin/master`
// WITHOUT a preceding fetch. In the shared-`.git` repo worked by ~5–7 parallel sessions, the
// local `origin/master` remote-tracking ref lags the real remote by minutes under load, so the
// new branch built on a STALE baseline — missing already-landed sibling plans (observed
// 2026-06-20 session 793: a worktree cut missing plan 823's merge had to be manually reset to
// the true tip). This tool makes the fetch unconditional and immediate: fetch origin master,
// THEN cut from the freshly-updated `origin/master`, THEN publish the empty branch. One choke
// point, lock-retry-wrapped, so the cut is always off the real remote head.
//
// ADOPT mode (plan 1957): `--adopt` takes over a DEAD cloud session's already-pushed
// branch instead of cutting fresh — the branch-hygiene "DEAD CLOUD SESSION variant"
// recipe (plan 1830) folded into one command. A fresh cut from origin/master would
// ORPHAN the cloud's pushed commits; adopt cuts the local worktree branch from
// `origin/worktree-<slug>` (or an explicit `--adopt=<branch>` override, e.g. a
// `claude/drain-<slug>` fallback branch a push-denied cloud run published), writes
// `.owner` with a `takenOverFrom` provenance marker, and installs deps. The claim
// gate is deliberately conservative: a claim held by ANOTHER session refuses at ANY
// age (the "is the holder actually dead?" call stays operator-gated — there is no
// machine-checkable 6h constant, see the plan-1957 spec pin) and prints the exact
// `release-claim <id> --force` remediation; a claim you hold YOURSELF proceeds (the
// plan-1830 recipe re-acquires the claim `--lock-only` BEFORE adopting, so a
// self-held claim is the sanctioned takeover flow, not a steal).
//
// SPARSE plan worktrees (plan 3956): a plan worktree used to be a DENSE checkout of every
// tracked file -- 131,025 of them, 4.1 GB, 71% under `backend/data/price-pipeline`, which
// most plans never read -- and git walked all of it on every status/add/commit/merge/reset in
// every worktree (measured 2026-09-12: `status --porcelain` 12.4 s in a plan worktree vs 1.6 s
// on the main checkout). The cut now decides a MODE per plan (planWorktreeMode) and, when the
// plan's class allows it, cuts a cone-mode sparse checkout that leaves
// PLAN_WORKTREE_EXCLUDED_PATHS -- the six heavy stores under that folder, 94% of its files; the
// folder's own contract files (display-policy.json, plausibility-bands.json, ...) stay on disk
// because code reads them at import time -- off disk (the plan-3802 machinery in coord-git.mjs,
// generalised). Dense stays the default for anything with a price/data smell: a 🟥 SEED-WRITE
// banner, a Pipe/DQ category, a body naming one of the stores or the pipeline, a plan file that
// cannot be resolved (a batch slug, a non-plan worktree) or an explicit `--dense`. A worktree cut
// sparse widens on demand with `--widen` (one `sparse-checkout disable`, never a re-cut), and
// plan 4020 added the mirror: `--narrow` drops the stores back off disk in a worktree that is
// dense right now -- including one cut dense BY CLASS that never carried a cone -- so a land's
// build phase can have the allowance back. It refuses rather than destroying when an excluded
// path is dirty.

import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename as pathBasename } from 'node:path';
import { hostname } from 'node:os';
import {
  gitWithLockRetry,
  resolveMain,
  lsRemoteTimed,
  parseFlags,
  ensurePlanSparseCheckout,
  widenPlanWorktree,
  narrowPlanWorktree,
  planNarrowBlockers,
} from './coord-git.mjs';
// plan 4071 T2: PLAN_WORKTREE_EXCLUDED_PATHS is no longer a coord-git.mjs module constant — it is
// coord.config.json's `planWorktreeExcludedPaths` key (empty core default). This CLI entry point
// is the "nearest caller that legitimately knows the project" (mainDir is already the resolved
// repo root by the time it reaches cutWorktree/widenWorktree/narrowWorktree below): each resolves
// `loadCoordConfig(mainDir).planWorktreeExcludedPaths` once and passes it down as `excludes`.
import { loadCoordConfig } from './coord-config.mjs';
// /gpt-review round-2 key 49589c: the byte formatter is disk-headroom.mjs's exported one, not a
// second local copy. (Its dirSizeBytes walker is NOT exported and returns no file count, which
// this module needs, so that half stays separate -- recorded as infra-debt by plan 4020.)
import { formatBytes } from './disk-headroom.mjs';
import { reclaimLandDirIfSafe } from './land-lib.mjs';
import { assertSlugCharset, planIdOf, isBatchSlug } from './claim-plan-lib.mjs';
import { planStatus, activePathFor } from './claim-plan.mjs';
// plan 3956: the dense-by-class rule reads the SEED-WRITE banner and the category segment through
// the same readers the INDEX, the mint gate and the evidence floor use -- never a re-rolled regex.
import { readSeedWriteValue, planCategoryOf } from './build-index-lib.mjs';
// plan 2599: adoptGates()'s batch branch reads the batch manifest's members[] through the
// EXISTING shape-validating parser (plan 1364/1467) rather than hand-rolling JSON.parse —
// it returns null on garbage/empty/non-object/missing-or-empty-members, which is exactly the
// "torn coord state" signal ruling 3 refuses on. batch-paths.mjs is a pure module (no
// fs/child_process at import, see its own header) so importing it here carries no IO cost.
// Manifest LOCATION resolution is also batch-paths' job: it owns the new-path-first /
// legacy-second precedence every manifest reader must agree on ("never re-roll the candidate
// loop in a consumer" — its own header). Hand-building the new path here would fork that
// policy and blind --adopt to grandfathered legacy manifests.
import {
  parseBatchManifest,
  resolveManifestRel,
  newManifestRel,
  legacyManifestRel,
} from './batch-paths.mjs';
// plan 1616: MAX_DIR_SLUG used to be an independently-declared local `40`, duplicating
// land-lib.mjs's MAX_LAND_DIR_SLUG — both now alias the one canonical constant.
import {
  truncateDirBasename,
  MAX_PATH_HEADROOM_DIR_SLUG as MAX_DIR_SLUG,
} from './dir-basename-truncate.mjs';
// plan 2218: cut time is a natural idle-ish moment to retry (once, no storm) any
// worktree dirs a prior teardown deferred as locked — including this very slug's own
// leftover dir, which would otherwise fail the `worktree add` below.
import { runSweepAndReport } from './sweep-deferred-worktrees.mjs';

export function branchFor(slug) {
  return `worktree-${slug}`;
}

// MAX_DIR_SLUG: the maximum length of the slug portion of the worktree DIRECTORY name
// (plan 909 — Windows MAX_PATH = 260). Turbopack writes SSR chunk source-map artifacts at
// paths like:
//   <repo>\.claude\worktrees\<dir-slug>\frontend\.next\server\chunks\ssr\<chunk>.js.map
// On this machine the fixed parts total ~189 chars (66 base + 18 .claude\worktrees\ +
// 1 separator + 104-char artifact tail). A slug of 71 chars (plan 903) pushed the total
// to 261 — 1 over the 260 limit — causing TurbopackInternalError mid-build even though
// the build is otherwise clean and Render/Linux is unaffected.
//
// Truncating the DIRECTORY name to 40 chars provides ~31 chars of headroom (total ≤ 230)
// while the BRANCH stays `worktree-<full-slug>`, which is what done-worktree's
// resolveWorktreeFromPorcelain uses as its primary resolution key — so a short dir is
// invisible to the spine. Uniqueness is preserved because plan IDs are unique and always
// appear at the start of the slug (e.g. `903-DQ-` → the first 40 chars always contain it).
// (plan 1616: the `40` value itself now lives in dir-basename-truncate.mjs's
// MAX_PATH_HEADROOM_DIR_SLUG, imported above — this is no longer an independent declaration.)

export function worktreePathFor(slug) {
  // plan 1286 ride-along: trim trailing hyphens left by a mid-word clip — the 1286 pickup
  // produced `…-heal-and-` (trailing dash), and the session's first `cd` to the FULL slug
  // path failed. The dir name is cosmetic to the spine (done-worktree resolves by BRANCH),
  // so tidying it is safe; the LOUD stderr note in cutWorktree is the real fix (the JSON
  // `worktreePath` is authoritative — callers must cd to it, not to the slug).
  // plan 1597: the cap-and-trim itself lives in the shared truncateDirBasename() helper.
  return `.claude/worktrees/${truncateDirBasename(slug, { maxLen: MAX_DIR_SLUG })}`;
}

// plan 3956: the plan classes that keep a DENSE worktree. Every rule is deliberately generous --
// a false "dense" costs ~12 s per status, a false "sparse" could let a land-time gate pass on a
// folder that is not there (the failure mode is silence, not a crash; see the T3 reader census
// in the plan body). `Price` is NOT matched: it is retired, absorbed into `Pipe`.
export const DENSE_CATEGORIES = Object.freeze(['Pipe', 'DQ']);
// The store NAMES are derived from the exclude list itself, so a store added there is a dense
// term here in the same edit -- a second hand-kept list drifted by construction (/gpt-review key
// 022ae0). The two extra terms name the folder and the sweep that reads it.
//
// plan 4071 T2: `excludes` (coord.config.json's `planWorktreeExcludedPaths`) is no longer a
// coord-git.mjs module constant, so this is now a function OF that list rather than a module-load
// constant computed from it — the caller (planWorktreeMode below) resolves the list once and
// passes it in.
export function denseBodyTermsFor(excludes) {
  return Object.freeze([
    ...new Set([...excludes.map((p) => pathBasename(p)), 'price-pipeline', 'weekly-price-sweep']),
  ]);
}

// The pure decision: DENSE or SPARSE, and which rule decided it (logged at cut time, carried in
// the result JSON). `planText` is the plan body (null when the plan file could not be resolved),
// `basename` its file name (category comes from it), `dense` the explicit CLI override, `excludes`
// the plan-worktree sparse-cone exclude list (plan 4071 T2 — caller-injected, coord.config.json's
// `planWorktreeExcludedPaths`). Order matters only for WHICH rule is named; every dense rule wins
// over the sparse default.
//
// plan 4071 review round 1 (finding c76ab7): `excludes` defaults to `[]`, matching the core
// contract everywhere else in this plan's caller-injects rule ("empty = no exclusions", the
// same default `sparseConeDirs`/`ensureSparseCheckout` now treat as DENSE). The one production
// caller (cutWorktree below) always resolves and passes a real list, so this default is never
// exercised there — it exists so a caller that omits the parameter gets the documented
// empty-list behavior (an unqualified sparse verdict, no dense body-term match) instead of a
// `TypeError: excludes is not iterable` out of `denseBodyTermsFor`.
export function planWorktreeMode({
  planText = null,
  basename = null,
  dense = false,
  excludes = [],
} = {}) {
  if (dense) return { dense: true, rule: '--dense' };
  if (typeof planText !== 'string')
    return { dense: true, rule: 'plan file not resolved (batch slug or non-plan worktree)' };
  // readSeedWriteValue, not readSeedMarker: the latter renders a MISSING banner as 🟩, which its
  // own header calls display-side only (queue-drain treats a missing banner as seed-write for
  // the mutex, and so does this rule -- unknown is dense, never sparse; /gpt-review key b79e4e).
  const seedWrite = readSeedWriteValue(planText);
  if (seedWrite === null) return { dense: true, rule: 'no SEED-WRITE banner (unknown is dense)' };
  if (seedWrite !== 'no') return { dense: true, rule: `SEED-WRITE banner is ${seedWrite} (🟥)` };
  const category = basename ? planCategoryOf(basename) : null;
  if (category && DENSE_CATEGORIES.includes(category))
    return { dense: true, rule: `category ${category}` };
  const term = denseBodyTermsFor(excludes).find((t) => planText.includes(t));
  if (term) return { dense: true, rule: `body mentions "${term}"` };
  return {
    dense: false,
    rule: `sparse cone (${excludes.join(', ')} left off disk)`,
  };
}

// Resolve the plan file for `slug` from the MAIN checkout's index. At cut time (pickup-plan step
// 6, after the step-0 `claim-plan.mjs acquire` projection) the plan already sits in
// `in-progress/`, so the search includes it; a batch slug, a slug with no numeric id, a plan
// not tracked in any claimable folder, or an unreadable file all resolve to null -- and null is
// DENSE by rule above, never sparse-by-default on a missing input.
export function resolvePlanForSlug(mainDir, slug) {
  if (isBatchSlug(slug)) return null;
  let rel;
  try {
    rel = activePathFor(mainDir, planIdOf(slug), { includeInProgress: true });
  } catch {
    return null;
  }
  try {
    return { rel, basename: rel.split('/').pop(), text: readFileSync(join(mainDir, rel), 'utf8') };
  } catch {
    return null;
  }
}

// Cut the worktree for `slug` off the fresh origin tip. Steps, in order:
//   1. fetch origin master   — refresh the remote-tracking ref so the cut is never stale
//   2. worktree add -b worktree-<slug> .claude/worktrees/<dir-slug> origin/master
//      where <dir-slug> is the first MAX_DIR_SLUG chars of <slug> (plan 909 MAX_PATH fix).
//      plan 3956: a SPARSE cut adds `--no-checkout`, applies the plan cone, then populates
//      with a plain `checkout` -- the dense tree is never written and then deleted again.
//   3. push -u origin worktree-<slug>   — publish the empty branch (skip with push:false)
// `run` is the git runner (injectable for tests); it defaults to gitWithLockRetry so the
// fetch/add/push survive index.lock contention from parallel sessions. Returns the branch
// and worktree path that were created.
// `runInstall(cwd)` is the deps installer (injectable for tests — the default spawns the real
// `pnpm install`). It runs in the new worktree's directory and may throw on failure; cutWorktree
// treats a throw as non-fatal (loud WARN + depsInstalled:false).
//
// Adopt mode (plan 1957): `adopt: true` cuts the local `worktree-<slug>` branch from an
// EXISTING origin branch (default `origin/worktree-<slug>`; `adoptBranch` overrides) instead
// of origin/master, after two refusal gates — see adoptGates(). `takenOverFrom` is the
// provenance string written into `.owner` (default 'unknown' — the prior holder's claim
// record is normally gone by the time a released claim is adopted; the refusal message
// pre-fills it while the record still exists). `planStatusFn` is a test seam over the real
// refs/claims/<id> read.
export function cutWorktree(
  mainDir,
  slug,
  {
    run,
    push = true,
    installDeps = true,
    runInstall,
    adopt = false,
    adoptBranch = null,
    takenOverFrom = null,
    planStatusFn = planStatus,
    // plan 3956: `dense` is the CLI override; `resolvePlan` / `applySparse` / `runInWorktree`
    // are test seams over the real plan lookup, the real cone application and the real
    // in-worktree git call. A mocked `run` with no `resolvePlan` resolves nothing → DENSE, so
    // every pre-3956 test sees the byte-identical dense argv it always did.
    dense = false,
    resolvePlan,
    applySparse = ensurePlanSparseCheckout,
    runInWorktree,
  } = {},
) {
  if (!slug) throw new Error('cut-worktree: a <slug> is required');
  // F-004 (plan 1313 coord audit): reject a slug outside the shared ASCII charset before it is
  // baked into a branch name / worktree path — done-worktree's teardown later interpolates this
  // SAME slug into an unescaped PowerShell `-like` kill-command pattern.
  assertSlugCharset(slug, 'slug');
  // plan 4071 T2: resolved ONCE from the repo root this function already receives
  // (coord.config.json's `planWorktreeExcludedPaths`, empty core default).
  const { planWorktreeExcludedPaths: sparseExcludes } = loadCoordConfig(mainDir);
  const exec = run || ((args) => gitWithLockRetry(mainDir, args));
  const branch = branchFor(slug);
  const wtPath = worktreePathFor(slug);
  const srcBranch = adopt ? adoptBranch || branch : null;
  // Review 1957 [6]: the 'unknown' fallback is computed ONCE — `.owner` and the result JSON
  // must never disagree on the provenance string.
  const takenOver = adopt ? takenOverFrom || 'unknown' : null;
  // Review 1957 [3]: ls-remote probes go through the shared TIMED helper (plan 1475's
  // lsRemoteTimed — a 5s fail-fast cap instead of an OS-level TCP/DNS hang). That real path
  // is adoptGates' own signature default; a mock wrapper is built ONLY when a test injected
  // `run`, so exactly one definition of each wrapper exists (review r2 [6-8]).
  // plan 3767 (gpt-review round 2): `ref` may be an ARRAY, matching `lsRemoteTimed`'s own
  // plan-3756 contract — `git ls-remote` takes any number of patterns natively, and the retire
  // block below needs BOTH tips from ONE call so the two are a coherent snapshot rather than two
  // reads a concurrent force-push can straddle. Spread it here so the mocked and real paths take
  // an array identically; adoptGates' single-ref calls are unaffected.
  const lsRemote = run
    ? (ref) =>
        String(run(['ls-remote', 'origin', ...(Array.isArray(ref) ? ref : [ref])]) ?? '').trim()
    : undefined;
  const gate = adopt
    ? adoptGates(mainDir, slug, srcBranch, { exec, planStatusFn, lsRemote })
    : null;
  // plan 1286: when the dir name is a truncation of the slug, SAY so loudly — a session that
  // `cd`s to `.claude/worktrees/<full-slug>` instead of the returned worktreePath gets ENOENT
  // (observed at this very plan's pickup). stderr, NOT stdout — main() prints result JSON.
  if (wtPath !== `.claude/worktrees/${slug}`) {
    process.stderr.write(
      `cut-worktree: NOTE — dir name truncated to ${MAX_DIR_SLUG} chars (Windows MAX_PATH headroom, plan 909): ` +
        `cd to "${wtPath}", NOT the full slug. The branch keeps the full name (${branch}).\n`,
    );
  }
  // 0. plan 2218: best-effort idle sweep of teardown-deferred locked worktree dirs
  //    (runSweepAndReport never throws). Skipped whenever a caller injected `run` —
  //    that is the mocked test seam, and the sweep's git/fs work is real.
  //    plan 3092: this is NO LONGER a pure existsSync probe when the marker file is
  //    absent — the husk scan runs marker-independently, so every call now also shells
  //    out to `git worktree list --porcelain` once. It still mutates nothing (the husk
  //    scan is report-only; see sweep-deferred-worktrees.mjs's header for why it must
  //    not prune another session's registration), so the added cost is one git read.
  if (!run) runSweepAndReport(mainDir, 'cut-worktree');
  // plan 2465: best-effort self-heal of a torn prior teardown's leftover registration at
  // wtPath, before `worktree add` below claims this same path. review fix: an orphaned
  // index.lock is not the only (or even the main) failure mode here — a torn teardown can
  // leave wtPath REGISTERED (`.git/worktrees/<name>` present, admin dir name NOT derivable
  // from basename(wtPath) once git has uniquified it on a prior collision), and `worktree
  // add` refuses outright with "already registered worktree" regardless of any lock file
  // inside it. reclaimLandDirIfSafe (land-lib.mjs) is the existing, already-tested primitive
  // for exactly this: it resolves the registration via `git worktree list --porcelain`
  // (never a basename guess), refuses to touch a DIFFERENT branch's live registration, and
  // clears a dead one via `worktree remove --force` + `worktree prune` (which also removes
  // any lock file inside — no separate lock-clear needed). A registration for the SAME
  // `branch` we are about to create here can only be a torn remnant of this same slug (the
  // claim mutex rules out a live sibling on the identical branch), so it is reclaimed
  // unconditionally, not gated on idleness. Same posture + mocked-`run` skip as the sweep
  // just above; never throws (best-effort — a failed reclaim falls through to the normal
  // `worktree add` error path, unchanged from before this heal existed).
  // review fix (surfaced by this plan's own regression test): a torn teardown can be
  // interrupted BEFORE its `git branch -D` step, leaving the OLD local `branch` ref intact
  // even after the registration above is reclaimed — `worktree add -b <branch>` then
  // refuses with "a branch named '<branch>' already exists". Reusing (not re-creating) an
  // already-existing SAME-name branch is safe for the identical reason the reclaim above
  // is: branch names are unique per plan slug, so an existing `branch` ref can only be
  // this exact slug's own leftover — never a different plan's. Restricted to the plain
  // (non-adopt) cut: adopt mode already has its own comprehensive dead-session divergence
  // machinery (adoptGates) for exactly this class of recovery, and reusing an untouched
  // stale branch here would bypass that origin-alignment check. Real-git only; every
  // mocked-`run` test's asserted call shape expects the unconditional `-b`, matching the
  // common (non-torn) case where the branch never existed.
  let branchExists = false;
  if (!run) {
    try {
      // reclaimLandDirIfSafe matches against git's OWN `worktree list --porcelain` output,
      // which reports absolute paths — wtPath here is relative to mainDir, so it must be
      // resolved to absolute first or the match silently misses (worktreeEntryAt finds
      // nothing, and existsSync(wtPath) itself resolves against the wrong cwd too).
      reclaimLandDirIfSafe(mainDir, join(mainDir, wtPath), branch);
    } catch {
      /* best-effort — fall through to the normal worktree-add error path */
    }
    if (!adopt) {
      try {
        exec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        branchExists = true;
      } catch {
        branchExists = false;
      }
    }
  }
  // 1. ALWAYS fetch first — this is the whole point. A stale local origin/master would
  //    otherwise seed the new branch with an outdated baseline. In adopt mode the same
  //    rule applies to the ADOPTED branch: fetch it so the cut is off the cloud's true tip
  //    — unless the divergence gate ALREADY fetched it this invocation (review r2 [3]:
  //    nothing changes origin between the two calls, so the re-fetch was pure waste).
  if (!gate?.srcFetched) exec(['fetch', 'origin', adopt ? srcBranch : 'master']);
  // 1b. plan 3233: bound the branchExists reuse above by DISTANCE from the now-fresh
  // origin/master. Must run HERE — after the fetch, before the `worktree add` below —
  // because origin/master is only trustworthy post-fetch; probing before it would silently
  // re-create the exact bug this bound exists to close. The branchExists reuse was authored
  // for a torn teardown interrupted seconds ago, where "the land-time rebase reconciles any
  // staleness" holds. It does NOT hold for a `heartbeat:` plan: its slug (and therefore
  // `branch`) is stable across ticks BY DESIGN, so "this exact slug's own leftover" can be an
  // arbitrarily old tick rather than a torn teardown — and the land-time rebase happens at the
  // END, after the whole plan has already run against the stale base. Measured 2026-08-16
  // (plan 1823): a reused branch sat 8 days / 6,615 commits behind origin/master, caught only
  // by luck (a pre-push guard happened to name a file the stale base still carried).
  //   own===0 && behind>0  → the branch is a PURE stale pointer — nothing of its own to lose
  //                          (rev-list origin/master..branch is empty by the very condition
  //                          being tested) — re-point the ref onto the fresh tip. A ref-only
  //                          `branch -f`, never `reset --hard`: no worktree is checked out for
  //                          `branch` yet, so there is nothing to reset.
  //   own>0 && behind>0    → AMBIGUOUS — may be real unpushed work from a torn teardown.
  //                          Never silently reset; refuse with the --adopt remediation.
  //   behind===0 (at tip, or own>0 ahead — the authored torn-teardown case) → reuse as-is,
  //                          completely unchanged.
  if (branchExists) {
    // ONE symmetric traversal, never two separate `rev-list --count` walks (review finding on
    // this plan; same class already fixed in nightly-windows-suite.mjs `ahead-behind-count` and
    // used by cloud-checkout-preflight.mjs). Two sequential walks read origin/master at two
    // different instants, and on this repo's SHARED .git a sibling session's `git fetch` between
    // them can advance the ref mid-measurement — yielding an inconsistent (own, behind) pair that
    // either refuses an ahead-only branch as AMBIGUOUS or lets a genuinely ambiguous one through
    // as a clean re-point (losing local work). `--left-right --count A...B` prints
    // "<A-only>\t<B-only>" from a single graph read, so with A=origin/master, B=branch the two
    // numbers are BEHIND then OWN — necessarily consistent with each other.
    const [behindCount, ownCount] = exec([
      'rev-list',
      '--left-right',
      '--count',
      `origin/master...${branch}`,
    ])
      .trim()
      .split(/\s+/)
      .map((n) => Number(n) || 0);
    if (ownCount === 0 && behindCount > 0) {
      exec(['branch', '-f', branch, 'origin/master']);
    } else if (ownCount > 0 && behindCount > 0) {
      throw new Error(
        `cut-worktree: leftover local branch "${branch}" is AMBIGUOUS — it is ${behindCount} ` +
          `commit(s) behind origin/master AND carries ${ownCount} commit(s) of its own. This ` +
          `could be real unpushed work from a torn teardown, so it is never silently reset. ` +
          `If the branch's own commits are disposable, delete the local branch by hand ` +
          `(\`git -C ${mainDir} branch -D ${branch}\`) and re-run this cut. If they are real ` +
          `work, push the branch to origin first, then take it over explicitly:\n` +
          `  node scripts/cut-worktree.mjs ${slug} --adopt=${branch}`,
      );
    }
    // own>0 && behind===0 (ahead — the authored torn-teardown case), or own===0 && behind===0
    // (already at origin/master): reuse as-is, unchanged from before this bound existed.
  }
  // 2. Cut from the now-fresh remote-tracking ref (origin/master — NOT local master, which
  //    can carry a sibling session's unpushed commits in a shared .git). Adopt mode cuts
  //    from origin/<srcBranch> instead: the pushed commits ARE the point (a fresh
  //    origin/master cut here is exactly the work-orphaning mistake plan 1957 closes).
  //    branchExists: attach to the existing leftover branch as-is (no `-b`, no origin ref
  //    needed — the normal land-time rebase-onto-master step reconciles any staleness).
  //    plan 3956: decide DENSE/SPARSE from the plan's class BEFORE the add (the decision needs
  //    only the main checkout), apply the cone right AFTER a successful `--no-checkout` add and
  //    BEFORE the populating checkout. The cone is best-effort by contract: if applySparse could
  //    not apply it (it forces the checkout dense itself), the plain `checkout` below simply
  //    materialises the full tree and the worktree is dense -- slow, never wrong.
  const plan = resolvePlan
    ? resolvePlan(mainDir, slug)
    : run
      ? null
      : resolvePlanForSlug(mainDir, slug);
  const mode = planWorktreeMode({
    planText: plan?.text ?? null,
    basename: plan?.basename ?? null,
    dense,
    excludes: sparseExcludes,
  });
  const absWt = join(mainDir, wtPath);
  const wtExec = runInWorktree || ((args) => gitWithLockRetry(absWt, args));
  const noCheckout = mode.dense ? [] : ['--no-checkout'];
  exec(
    branchExists
      ? ['worktree', 'add', ...noCheckout, wtPath, branch]
      : [
          'worktree',
          'add',
          ...noCheckout,
          '-b',
          branch,
          wtPath,
          adopt ? `origin/${srcBranch}` : 'origin/master',
        ],
  );
  let sparse = false;
  if (!mode.dense) {
    sparse = Boolean(applySparse(absWt, { excludes: sparseExcludes }));
    if (!sparse) {
      mode.rule = `cone could not be applied, checkout left DENSE (wanted: ${mode.rule})`;
      // "Left DENSE" must be true, not assumed: the helper's own dense fallback is best-effort
      // (the coord checkout's contract), so a `set` that failed partway with the disable refused
      // too would hand over a PARTIALLY narrowed tree labelled dense. Disable again here -- a
      // no-op on a tree that is already dense -- and let a refusal fail the cut loudly rather
      // than mislabel it (/gpt-review key 2657c5).
      wtExec(['sparse-checkout', 'disable']);
    }
    wtExec(['checkout']);
  }
  process.stderr.write(
    `cut-worktree: worktree is ${sparse ? 'SPARSE' : 'DENSE'} — rule: ${mode.rule}` +
      (plan ? ` (plan ${plan.rel})` : '') +
      '\n',
  );
  // 2b. Plan 958: stamp a creator-only `.owner` so the worktree-owner-guard
  //     PreToolUse hook can bind ownership trust-on-first-write. `sessionUuid`
  //     stays null here — cut-worktree (run via Bash) has no access to the harness
  //     `session_id` (no env var; it's delivered only to hooks on stdin), so the
  //     hook claims `sessionUuid` on the owning session's FIRST Edit/Write into the
  //     worktree, and denies a later write by any other session. The file is removed
  //     with the worktree at done-worktree teardown. Best-effort: if the write
  //     fails (e.g. a mocked `run` in tests didn't create the dir), the hook's TOFU
  //     still binds on first write when `.owner` is absent.
  //
  //     Plan 985: `.owner` is NOT covered by the main repo's `.claude/worktrees/`
  //     gitignore from INSIDE the linked worktree — gitignore patterns are matched
  //     relative to the worktree root, and `.owner` sits AT that root (not under
  //     `.claude/worktrees/`). So `git -C <wtPath> status --porcelain` reports a lone
  //     `?? .owner`, which tripped done-worktree's preflight clean-check with
  //     PREFLIGHT_FAIL for EVERY cut-worktree land. Fix: add the marker to the worktree's
  //     effective exclude file so git stops reporting it. `git rev-parse --git-path
  //     info/exclude` resolves to the shared common-dir `info/exclude` (git treats
  //     `info/exclude` as common, not per-worktree), which IS honoured from the linked
  //     worktree — verified `git status` goes clean after the append. The pattern is
  //     ANCHORED (`/.owner`, leading slash) so it only ever hides a worktree-ROOT marker:
  //     because the shared exclude is applied relative to EACH working tree's own root,
  //     `/.owner` matches `<wtRoot>/.owner` in every worktree without shadowing a
  //     hypothetical nested `*/.owner` elsewhere in the repo. Idempotent.
  try {
    // Plan 1957: an adopted worktree carries `takenOverFrom` — the dead prior holder's
    // identity when known (`--taken-over-from`, pre-filled by the held-claim refusal
    // message), else the literal 'unknown' (the spec-pinned fallback: a released claim's
    // record is already gone, so failing here would be worse than a lossy marker).
    const owner = { host: hostname(), createdAt: new Date().toISOString(), sessionUuid: null };
    if (adopt) owner.takenOverFrom = takenOver;
    writeFileSync(join(mainDir, wtPath, '.owner'), JSON.stringify(owner) + '\n');
    const excludePath = String(
      exec(['-C', wtPath, 'rev-parse', '--git-path', 'info/exclude']),
    ).trim();
    if (excludePath) {
      const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      if (!/^\/\.owner$/m.test(existing)) {
        const sep = existing && !existing.endsWith('\n') ? '\n' : '';
        writeFileSync(excludePath, `${existing}${sep}/.owner\n`);
      }
    }
  } catch (e) {
    // Best-effort — see note above. Correctness is preserved either way (the hook
    // TOFU-binds when `.owner` is absent; done-worktree's preflight tolerates a lone
    // `?? .owner` if the exclude write was skipped). But warn to stderr so a silent no-op
    // of the primary fix is observable. stderr, NOT stdout — main() prints the result JSON
    // to stdout and callers (pickup-plan) parse it.
    process.stderr.write(
      `cut-worktree: .owner marker/exclude setup best-effort failed: ${e?.message || e}\n`,
    );
  }
  // 3. Publish the empty branch so cross-PC /state sees the worktree exists. In adopt
  //    mode this is an up-to-date no-op that just sets the upstream (local tip ==
  //    origin/worktree-<slug>) — except when adopting an override branch (a
  //    `claude/drain-<slug>` fallback), where it NORMALIZES the work onto the spine's
  //    canonical `worktree-<slug>` branch name on origin.
  if (push) exec(['push', '-u', 'origin', branch]);
  // 3b. plan 3767: an OVERRIDE adopt (srcBranch !== branch, e.g. a `claude/drain-<slug>`
  // fallback branch) still has that SOURCE branch sitting on origin even after the push
  // above NORMALIZED the adopted work onto the canonical `worktree-<slug>` spine branch —
  // the SAME commits now sit at TWO origin execution branches, exactly the "N branches for
  // one id" shape queue-drain.mjs / plan-adopt-branch.mjs otherwise treat as ambiguous
  // forever (the plan-3652 incident this plan fixes). Retire the source once the spine push
  // has landed it: re-read BOTH tips from origin (never trust the push call's own return —
  // a mocked/lying `run`, or plain eventual consistency, could disagree with the remote),
  // confirm the spine tip now equals the source tip, THEN guard the delete itself with an
  // ancestor-or-equal check (merge-base --is-ancestor treats an equal tip as its own
  // ancestor, so this also re-covers the tip-equality check by a second, independent path).
  // "Failure mode T1 avoids" (plan 3767 execution notes): never delete on a name match
  // alone — the guard is what stands between an override adopt and losing the only copy of
  // the work if the normalization push silently failed to actually land.
  // NON-FATAL: the cloud sandbox proxy refuses every git DELETE by verb (plan 3756), so a
  // refused delete here is the EXPECTED outcome inside a cloud drain, not a bug — WARN with
  // the exact manual command and record `sourceRetired: false` rather than throwing (T2/T3's
  // same-sha collapse is what actually keeps such a plan drainable, not this delete).
  // A plain `--adopt` (srcBranch === branch — the spine IS the source) skips this block
  // entirely: `sourceRetired` stays absent, and the spine branch is never a delete
  // candidate either way.
  let sourceRetired;
  // `srcTip` and `proven` are hoisted for the catch. `proven` is the load-bearing one: it says
  // the spine was SHOWN to carry the source tip, which is the only state in which advertising a
  // manual retire command is safe (gpt-review round 3).
  let srcTip;
  let proven = false;
  if (adopt && push && srcBranch !== branch) {
    try {
      // The probe goes through the SAME timed reader the rest of this file uses (`lsRemote` —
      // adoptGates' own seam, defaulting to plan 1475's `lsRemoteTimed` with its 5s fail-fast
      // cap). A raw `exec(['ls-remote', …])` runs untimed through gitWithLockRetry and can hang
      // on a TCP/DNS stall until the OS gives up — and the stalling proxy is the exact
      // environment this retirement targets (plan 3756), so the non-fatal catch below would
      // never be reached in the one case it exists for.
      //
      // ONE ls-remote carrying BOTH refs, never two calls: two reads are not a coherent
      // snapshot. A force-push landing between them lets the spine be read at tip A and the
      // source read at that same A afterwards, so equality passes even though the spine no
      // longer carries A — and the delete then removes the only remote ref holding it.
      const readRefs = lsRemote || ((refs) => String(lsRemoteTimed(mainDir, refs) ?? '').trim());
      const tips = new Map(
        String(readRefs([`refs/heads/${branch}`, `refs/heads/${srcBranch}`]) ?? '')
          .split('\n')
          .map((line) => line.trim().split(/\s+/))
          .filter((cols) => cols.length >= 2)
          .map(([sha, ref]) => [ref, sha]),
      );
      const branchTip = tips.get(`refs/heads/${branch}`);
      srcTip = tips.get(`refs/heads/${srcBranch}`);
      if (!branchTip || branchTip !== srcTip) {
        throw new Error(
          `origin/${branch} tip (${branchTip || '<absent>'}) does not match the adopted ` +
            `source tip (${srcTip || '<absent>'}) — refusing to retire "${srcBranch}"`,
        );
      }
      // gpt-review fix (plan 3767): the ancestor guard runs on the SHAS the probes above just
      // read from the remote, never on the `origin/<branch>` LOCAL tracking refs. Adopt mode
      // fetches only the SOURCE ref (step 1), so `origin/<spine>` here is a snapshot that can be
      // absent or stale even while the two remote tips genuinely agree — merge-base would then
      // throw, the catch would report `sourceRetired: false`, and the duplicate branch this whole
      // change exists to retire would survive. Against equal shas this is trivially true, which
      // is the point: it is a second, independent expression of the invariant, cheap enough to
      // keep as a guard against a future refactor loosening the equality check above.
      exec(['merge-base', '--is-ancestor', srcTip, branchTip]);
      proven = true;
      // The delete is a two-ref CAS against the snapshot above, not a delete by NAME.
      //
      // A plain `--delete <name>` destroys whatever the name points at, so a commit pushed to
      // the source between the probe and this call — a still-running predecessor's last one — is
      // lost while `sourceRetired: true` claims a clean retirement. A lease on the SOURCE alone
      // (gpt-review round 1) fixes only half of it: the danger is symmetric, and the worse half
      // is the SPINE moving. If the spine is force-pushed away from the verified tip after the
      // probe, deleting the source removes the last ref carrying those commits, and a
      // source-only lease still says yes.
      //
      // So both refs ride ONE atomic push: a write of the spine back to the tip just verified,
      // plus the source's delete refspec. `:refs/heads/<src>` rather than `--delete`, because
      // git refuses `--delete` alongside a value refspec and the two must share a push for the
      // atomicity to mean anything.
      //
      // What that buys, exactly — measured against real git rather than assumed, because the two
      // cases differ and the difference is easy to overstate:
      //   * Spine ALREADY moved when the push is prepared → the spine refspec is a non-ff update,
      //     its lease is checked, and the whole atomic push is rejected: `! [rejected] (delete)
      //     -> src (atomic push failed)`, source intact. This is the real window — it spans the
      //     ls-remote round trip, which is where a concurrent force-push would actually land.
      //   * Spine still at the verified tip when the push is prepared, and force-pushed in the
      //     instant before send-pack → git treats `<tip>:refs/heads/<spine>` as UP TO DATE and
      //     OMITS it from the push, so the server never sees that lease and the delete proceeds
      //     under the source lease alone. Confirmed by experiment: a deliberately WRONG spine
      //     lease on an up-to-date refspec does not reject the push.
      // The residual is therefore a microsecond tail, not the round trip, and git offers no
      // cross-ref CAS that would close it (see docs/handoff/infra-debt.md, plan 3767). The SOURCE
      // lease below is enforced unconditionally — that one is a real CAS.
      exec([
        'push',
        'origin',
        '--atomic',
        `--force-with-lease=refs/heads/${srcBranch}:${srcTip}`,
        `--force-with-lease=refs/heads/${branch}:${branchTip}`,
        `${branchTip}:refs/heads/${branch}`,
        `:refs/heads/${srcBranch}`,
      ]);
      sourceRetired = true;
      process.stderr.write(
        `cut-worktree: retired source branch "${srcBranch}" on origin — its tip is now on ` +
          `"${branch}" (plan 3767).\n`,
      );
    } catch (e) {
      sourceRetired = false;
      // gpt-review round 3 (plan 3767): a copy-pasteable retire command is printed ONLY when the
      // proof above actually PASSED and the push itself is what failed (`proven` — the cloud
      // proxy's 403-by-verb, plan 3756, is the expected instance). Round 2 printed one whenever
      // `srcTip` happened to be known, which included the case the equality gate REFUSED: there
      // the spine was never shown to carry the source, yet the advertised lease matched the live
      // remote and would therefore SUCCEED — advice that deletes the only copy of the adopted
      // work. When the proof did not pass there is no safe command to give, so we say what is
      // wrong instead of printing a shell line with a `<placeholder>` in it (angle brackets are
      // redirections, so such a line is unrunnable anyway, and guessing a value around it is
      // exactly the unguarded delete this is meant to prevent).
      const manual = proven
        ? `retire it by hand if appropriate:\n` +
          `  git push origin --atomic ` +
          `--force-with-lease=refs/heads/${srcBranch}:${srcTip} ` +
          `--force-with-lease=refs/heads/${branch}:${srcTip} ` +
          `${srcTip}:refs/heads/${branch} :refs/heads/${srcBranch}\n`
        : `origin/${branch} was NOT shown to carry "${srcBranch}"'s tip, so there is no safe ` +
          `retire command to give: deleting the source here could drop the only copy of the ` +
          `adopted work. Re-check both tips by hand before retiring anything.\n`;
      process.stderr.write(
        `cut-worktree: WARN — could not retire source branch "${srcBranch}" on origin ` +
          `(${e?.message || e}). ${manual}`,
      );
    }
  }
  // 4. plan 1723 E1: install node deps in the NEW worktree, UNCONDITIONALLY. node_modules is
  //    gitignored, so `git worktree add` carries NONE over — a fresh worktree has empty deps until
  //    an install runs. Any land whose diff drifts into frontend/**/backend/**/shared/**/scripts/**
  //    then fails the done-worktree build preflight, the pre-push prettier check, and vitest — none
  //    can run without deps (the 1710/1711 lands, 2026-07-11; it also let workers falsely self-
  //    report those gates green). A REAL install per worktree, never a shared junction of MAIN's
  //    node_modules: that junction pattern is deliberately reserved for the ephemeral FINISH
  //    worktree (done-worktree's linkNodeModulesIntoFinishWorktree, which only needs bin resolution
  //    for prettier and never builds); a node_modules shared across 5–7 parallel worktrees running
  //    `next build`/vitest concurrently risks cache-dir write collisions. Warm-store cost is ~1–25s,
  //    noise against a land failure. NON-FATAL: a failed install is a loud WARN + depsInstalled:false
  //    in the JSON (done-worktree's E2 preflight is the safety net), never a hard cut failure.
  let depsInstalled = false;
  if (installDeps) {
    const doInstall =
      runInstall ||
      ((cwd) =>
        execFileSync('pnpm', ['install', '--prefer-offline'], {
          cwd,
          stdio: 'inherit',
          // plan 1723 review: a 10-min ceiling so a stalled install (registry hiccup, corrupted
          // store, a wedged pnpm) fails INTO the non-fatal WARN + depsInstalled:false path rather
          // than hanging the whole pickup-plan cut flow forever. Matches runBuildPreflight's
          // timeout discipline; a warm install is ~1s and a cold one ~3min, so 600s is ample.
          timeout: 600_000,
          shell: process.platform === 'win32', // pnpm is pnpm.cmd on Windows
        }));
    try {
      doInstall(join(mainDir, wtPath));
      depsInstalled = true;
    } catch (e) {
      process.stderr.write(
        `cut-worktree: WARN — \`pnpm install\` in the new worktree FAILED: ${e?.message || e}\n` +
          `  Frontend/backend/shared/scripts gates cannot run without deps. Run \`pnpm install\` in ` +
          `"${wtPath}" before landing (done-worktree preflight will otherwise fail-fast on it).\n`,
      );
    }
  }
  const result = {
    branch,
    worktreePath: wtPath,
    depsInstalled,
    // plan 3956: which cone the worktree got and the rule that decided it.
    sparse,
    modeRule: mode.rule,
  };
  if (adopt) {
    result.adopted = true;
    result.adoptedFrom = `origin/${srcBranch}`;
    result.takenOverFrom = takenOver;
    // plan 3767: absent for a plain --adopt (no retirement attempted) or when `push` was
    // off; otherwise true/false per the retirement outcome above.
    if (sourceRetired !== undefined) result.sourceRetired = sourceRetired;
  }
  return result;
}

// plan 3956: materialise PLAN_WORKTREE_EXCLUDED_PATHS in an EXISTING sparse plan worktree
// (`--widen`). One `sparse-checkout disable`, idempotent, a no-op on a dense worktree. This is the
// sanctioned door when a sparse worktree turns out to need the folder (a script that stages
// under it, a gate that walks it) -- never a re-cut, which would lose the branch's local state.
// `dir` names the worktree directly (`--widen --dir <path>`), for a caller that has a checkout
// but no slug — scripts/hooks/pre-push.sh's pytest gate widens `git rev-parse --show-toplevel`
// this way before the suite runs (see runPytestPreflight in done-worktree.mjs for the why).
export function widenWorktree(mainDir, slug, { widen = widenPlanWorktree, dir = null } = {}) {
  let wtPath;
  let absWt;
  if (dir) {
    absWt = dir;
    wtPath = dir;
  } else {
    assertSlugCharset(slug, 'slug');
    wtPath = worktreePathFor(slug);
    absWt = join(mainDir, wtPath);
  }
  if (!existsSync(absWt))
    throw new Error(`cut-worktree: --widen found no worktree at "${wtPath}" (cut it first)`);
  // plan 4071 review round 1 (finding 18eb34): widen() itself (widenPlanWorktree) needs no
  // excludes -- it disables sparse mode wholesale -- so it runs FIRST, unconditionally. The
  // config read below is only for the human-readable message naming what came back, and a
  // malformed coord.config.json in the worktree must never stop the widen that already ran:
  // the old order (config read, then widen) meant a bad config threw BEFORE the widen call
  // and left the excluded stores off disk -- the opposite of what --widen is for.
  const widened = Boolean(widen(absWt, {}));
  // Resolved from absWt (the worktree itself), NOT mainDir -- a `--dir <path>` caller passes
  // mainDir=null (see main() below), but the worktree always carries its own root-level
  // coord.config.json.
  let excludesLabel = '(exclude list unavailable — coord.config.json unreadable)';
  try {
    const { planWorktreeExcludedPaths: sparseExcludes } = loadCoordConfig(absWt);
    excludesLabel = sparseExcludes.join(', ');
  } catch {
    // message-only best-effort: the widen above has already happened either way.
  }
  process.stderr.write(
    widened
      ? `cut-worktree: widened "${wtPath}" — ${excludesLabel} now on disk\n`
      : `cut-worktree: "${wtPath}" is not a sparse plan worktree (dense, already widened, or not cut by this tool) — nothing to widen\n`,
  );
  return { branch: slug ? branchFor(slug) : null, worktreePath: wtPath, widened };
}

// Summed LOGICAL size of every regular file under `root`, recursively (0 when absent).
// Deliberately a size WALK rather than a git query: what a narrow frees is a property of the
// filesystem, not of the index, and the residual we owe the caller is "everything still there" --
// tracked, untracked and ignored alike -- which no `git status` shape reports.
//
// Logical, not allocated (/gpt-review key e3ca7d): this sums `stat().size`, so it under-reports
// what the filesystem actually gives back when a tree is many small files. Measured on the real
// repo 2026-09-14 the six stores walk to 3.40 GB while `df` moved 3.77 GiB -- block overhead on
// 87k files. Under-reporting is the right direction for a number a caller uses to decide whether
// a narrow bought enough room, and the CLI labels it as logical rather than implying otherwise.
// Matching `disk-headroom.mjs`'s private `dirSizeBytes` is deliberate-but-unshared: that one is
// not exported and returns no file count (see this plan's infra-debt line).
//
// Symlinks are not followed: `withFileTypes` dirents are lstat-based, so a symlinked directory is
// neither recursed nor counted twice. Best-effort per entry, because a file vanishing mid-walk
// (a live render writing into a store) must not fail a measurement that is only ever a log line.
function dirBytesOnDisk(root) {
  let bytes = 0;
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // absent (the normal case for an excluded store after a narrow) or unreadable
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        const st = statSync(p, { throwIfNoEntry: false });
        if (st) {
          bytes += st.size;
          files += 1;
        }
      }
    }
  }
  return { bytes, files };
}

// plan 4020: drop PLAN_WORKTREE_EXCLUDED_PATHS back off disk in an EXISTING plan worktree
// (`--narrow`) -- the missing half of `--widen`. Works on a worktree cut DENSE by class, not only
// on a widened one, which is the whole ask: a 🟥/Pipe/DQ plan's worktree carries the six stores
// for its entire life, including the land's build phase, which is the one phase that needs the
// disk most (plan 3982 ENOSPC'd there with 4.8 GB free and had no door back).
//
// REFUSES on a dirty excluded path rather than destroying it -- the library gate throws and the
// CLI surfaces it as exit 2, changing nothing.
//
// The freed/residual numbers are MEASURED here, not in the library: the walk costs a stat per file
// (~87k files across the six stores on the real repo) and the library is called from gates that
// must stay cheap. `residual` is what survives the narrow -- untracked and ignored render output
// and scratch written into a store during the run, which sparse-checkout does not manage and
// therefore does not free. Printing it is the difference between "the stores are off disk" and an
// honest "this much of the allowance actually came back". `freedBytes`/`residualBytes` are
// LOGICAL sizes (see dirBytesOnDisk) and the printed line says so.
// `dir` names the worktree directly (`--narrow --dir <path>`), mirroring `--widen --dir`, for a
// land-time caller that has a checkout but no slug — without it the narrow is unreachable from
// exactly the phase it exists for.
export function narrowWorktree(
  mainDir,
  slug,
  { narrow = narrowPlanWorktree, blockers = planNarrowBlockers, dir = null } = {},
) {
  let wtPath;
  let absWt;
  if (dir) {
    absWt = dir;
    wtPath = dir;
  } else {
    assertSlugCharset(slug, 'slug');
    wtPath = worktreePathFor(slug);
    absWt = join(mainDir, wtPath);
  }
  if (!existsSync(absWt))
    throw new Error(`cut-worktree: --narrow found no worktree at "${wtPath}" (cut it first)`);
  // plan 4071 T2: resolved from absWt (the worktree itself), NOT mainDir -- a `--dir <path>` caller
  // passes mainDir=null (see main() below), but the worktree always carries its own root-level
  // coord.config.json.
  const { planWorktreeExcludedPaths: sparseExcludes } = loadCoordConfig(absWt);
  // Probe the gate BEFORE the size walk (/gpt-review key ce6471): a refusal would otherwise pay
  // for a full stat of ~87k files it is about to throw away. The library re-checks independently
  // -- it must stay safe when called directly, not only through this CLI -- and that second check
  // is one pathspec-scoped `git status`, far cheaper than the walk it saves. (The no-op path
  // needs no such guard: once a worktree is narrowed the six directories are absent, so the walk
  // is six failed readdirs.)
  const pre = blockers(absWt, { excludes: sparseExcludes });
  if (pre.blockers.length)
    throw new Error(
      `cut-worktree: --narrow REFUSED — uncommitted work under the excluded stores in "${wtPath}".\n` +
        `${pre.blockers.map((b) => `  ${b}`).join('\n')}\n` +
        `Commit or stash the listed path(s) (or finish the in-progress operation), then narrow again.`,
    );
  // plan 4071 review round 3: an EMPTY `planWorktreeExcludedPaths` (the core default) means dense
  // is the wanted end state, not a cone — narrowPlanWorktree treats it that way (a no-op on an
  // already-dense worktree, or actively widening an already-sparse one back to dense). Report that
  // outcome truthfully: neither "already a sparse plan worktree" (untrue — the config carries no
  // stores to speak of) nor a byte-freed cone summary (there is no store list to size) fit here.
  if (sparseExcludes.length === 0) {
    const res = narrow(absWt, { excludes: sparseExcludes });
    if (!res) {
      process.stderr.write(
        `cut-worktree: "${wtPath}" is already dense by config (planWorktreeExcludedPaths is empty) — nothing to narrow\n`,
      );
      return { branch: slug ? branchFor(slug) : null, worktreePath: wtPath, narrowed: false };
    }
    process.stderr.write(
      `cut-worktree: "${wtPath}" widened back to DENSE — planWorktreeExcludedPaths is empty, so no stores are held off disk\n`,
    );
    return {
      branch: slug ? branchFor(slug) : null,
      worktreePath: wtPath,
      narrowed: true,
      freedBytes: 0,
      residualBytes: 0,
      residualFiles: 0,
      untracked: res.untracked ?? [],
    };
  }
  const before = sparseExcludes
    .map((p) => dirBytesOnDisk(join(absWt, p)))
    .reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), {
      bytes: 0,
      files: 0,
    });
  const res = narrow(absWt, { excludes: sparseExcludes });
  if (!res) {
    process.stderr.write(
      `cut-worktree: "${wtPath}" is already a sparse plan worktree — nothing to narrow\n`,
    );
    return { branch: slug ? branchFor(slug) : null, worktreePath: wtPath, narrowed: false };
  }
  const after = sparseExcludes
    .map((p) => dirBytesOnDisk(join(absWt, p)))
    .reduce((a, b) => ({ bytes: a.bytes + b.bytes, files: a.files + b.files }), {
      bytes: 0,
      files: 0,
    });
  const freed = Math.max(0, before.bytes - after.bytes);
  process.stderr.write(
    `cut-worktree: narrowed "${wtPath}" — ${sparseExcludes.join(', ')} off disk\n` +
      `cut-worktree: freed ~${formatBytes(freed)} logical (${before.files - after.files} files; the filesystem ` +
      `typically returns more, block overhead on many small files); ` +
      `residual ${formatBytes(after.bytes)} in ${after.files} file(s) sparse-checkout does not manage\n`,
  );
  // The residual COUNT above comes from the post-narrow walk, so it includes gitignored files;
  // the NAMES below come from git and therefore cover the untracked-but-not-ignored ones only
  // (/gpt-review key 0c6183). Naming the ignored ones too would need a second `status --ignored`
  // over the same paths, and the walk already carries them in the number that matters.
  if (res.untracked?.length)
    process.stderr.write(
      `cut-worktree: untracked content SURVIVES the narrow and still costs disk` +
        `${after.files > res.untracked.length ? ' (git-named subset; the residual count above also includes ignored files)' : ''}:\n` +
        `${res.untracked.map((p) => `  ${p}`).join('\n')}\n`,
    );
  return {
    branch: slug ? branchFor(slug) : null,
    worktreePath: wtPath,
    narrowed: true,
    freedBytes: freed,
    residualBytes: after.bytes,
    residualFiles: after.files,
    untracked: res.untracked ?? [],
  };
}

// The two adopt-mode refusal gates (plan 1957), checked BEFORE any mutating git op.
// Both throw with an actionable message (the CLI surfaces them as exit 2):
//   1. Claim gate — refs/claims/<id> held by ANOTHER session (or by an unprovable one:
//      no CLAUDE_CODE_SESSION_ID in a headless run, or an unparseable claim body) →
//      REFUSE at any age, printing the holder record + the exact `release-claim --force`
//      remediation + a re-run line with `--taken-over-from` PRE-FILLED from the still-
//      readable claim record (the spec pin: read the prior holder BEFORE printing the
//      release remediation, so the operator's release doesn't lose the provenance).
//      Held by YOURSELF proceeds — the plan-1830 takeover recipe re-acquires the claim
//      (`acquire --lock-only`) before adopting, so self-held is the sanctioned flow.
//   2. Branch gate — no `origin/<srcBranch>` → REFUSE and point at the plain fresh-cut
//      path (that is the zero-work-death case: nothing to preserve, use plain pickup).
//   3. Divergence gate (override adopts only, review 1957 [0]) — origin ALSO has a
//      `worktree-<slug>` whose tip is neither equal to nor an ancestor of the override
//      branch's tip → the final normalization push would be rejected non-fast-forward
//      AFTER the worktree was already created. REFUSE up front with both tips named;
//      which branch is the truth is an operator call, never an auto-force.
// `lsRemote(ref)` returns the trimmed `git ls-remote origin <ref>` output. The real path
// (the timed shared helper, plan 1475) is the signature DEFAULT — the one definition —
// and cutWorktree passes an override only when a test injected `run` (review r2 [6-8]).
// Returns `{ srcFetched }` so cutWorktree can skip re-fetching a branch this gate
// already fetched for the ancestry check (review r2 [3]).
export function adoptGates(
  mainDir,
  slug,
  srcBranch,
  {
    exec,
    planStatusFn = planStatus,
    lsRemote = (ref) => String(lsRemoteTimed(mainDir, ref) ?? '').trim(),
  } = {},
) {
  let srcFetched = false;
  const spineBranch = branchFor(slug);
  // The exact flag to repeat on a re-run — an override must never silently degrade to the
  // bare default (review 1957 [1]: the pre-fix remediation dropped `=<branch>`, sending the
  // operator's copy-paste re-run to a nonexistent worktree-<slug> and from there to the
  // work-orphaning fresh-cut fallback). Computed once, shared by both the solo and batch
  // claim-gate branches below (plan 2599).
  const adoptFlag = srcBranch === spineBranch ? '--adopt' : `--adopt=${srcBranch}`;
  // ONE provenance-formatting helper, shared by the solo and batch claim gates so a held
  // holder's line never drifts between the two (plan 2599: was inline in the solo branch
  // only; the batch branch needs it once per member).
  const holderLine = (h) => {
    const provenance = h ? `session=${h.sessionUuid} host=${h.host} iso=${h.iso}` : null;
    const who = provenance
      ? provenance + (h.ageSec != null ? ` (age ${Math.round(h.ageSec / 3600)}h)` : '')
      : 'UNPARSEABLE claim record';
    return { provenance, who };
  };
  if (isBatchSlug(slug)) {
    // plan 2599 — batch adopt: `refs/claims/<batch-slug>` never exists (claims are per
    // MEMBER only, never per batch — execution note b2), so the gate reads the batch
    // manifest's members[] and runs the SAME held-claim check once per member, collecting
    // every violation before throwing once (refuse-before-mutate, ruling 1).
    // Resolution goes through batch-paths' SHARED resolver (review 2599 [0]) — new-path-first,
    // legacy-second — never a hand-built path. A batch claimed before the plan-1467 migration
    // still carries its manifest at the legacy `docs/handoff/batches/<slug>.json`, and
    // done-worktree's own readBatchManifest still reads both; a new-path-only probe here would
    // REFUSE a grandfathered dead batch as "manifest not found" — i.e. reintroduce, for exactly
    // the batches most likely to need it, the recovery failure this plan exists to fix.
    const resolved = resolveManifestRel(mainDir, slug);
    // Read ONCE and treat an unreadable file as absent (review 2599 [5]): resolveManifestRel's
    // existsSync and a follow-up readFileSync are two syscalls with a window between them, and
    // both outcomes route to the SAME refusal anyway (ruling 3), so there is nothing to branch on.
    let manifest = null;
    if (resolved.rel) {
      try {
        manifest = parseBatchManifest(readFileSync(join(mainDir, resolved.rel), 'utf8'));
      } catch {
        manifest = null;
      }
    }
    if (!manifest) {
      // Ruling 3: missing OR unparseable manifest both refuse — a torn manifest means the
      // batch's coord state is already torn, and falling back to a branch-only adopt would
      // skip the held-claim gate for every member (the exact steal the gate prevents).
      // Both candidate paths are named so the operator can see which two were probed. Derived
      // ONCE (review 2599 r2 [2]) so the displayed "Probed" list and the copy-pasteable
      // git-log hint below can never drift apart.
      const candidateRels = [newManifestRel(slug), legacyManifestRel(slug)];
      const probed = candidateRels.map((rel) => join(mainDir, rel)).join('\n  ');
      throw new Error(
        `--adopt REFUSED — batch manifest not found or unparseable. Probed (new-first, ` +
          `legacy-second):\n  ${probed}\n` +
          `A dead batch's coord state is already torn: restore the manifest from ` +
          `origin/master history (\`git log --all -- ${candidateRels.join(' ')}\`) ` +
          `before re-running --adopt. There is no branch-only fallback — the manifest is how ` +
          `this gate knows which member claims to check.`,
      );
    }
    // parseBatchManifest only guarantees members[] is a non-empty array of strings — NOT that
    // each entry is a plan id. planStatus calls planIdOf internally and throws on garbage, so a
    // malformed member would otherwise escape as a raw low-level error instead of the
    // torn-manifest refusal above (review 2599 r1 [1]).
    //
    // The SHAPE check is deliberately separate from the claim probe (review 2599 r2 [0]): a
    // blanket try/catch around planStatusFn would relabel a transient `git ls-remote` failure —
    // network blip, proxy timeout — as "the manifest is torn", sending the operator into
    // manifest archaeology when the real remedy is to retry. planIdOf is a pure local regex, so
    // it can only fail on a genuinely malformed entry; the probe runs OUTSIDE the catch and its
    // errors surface as themselves.
    // ONE pass, with the catch scoped to the planIdOf call alone (review 2599 r3 [1]) — the
    // probe is the very next statement, still outside it. A second pass just to pre-validate
    // would iterate members twice for no added safety.
    const held = [];
    for (const memberId of manifest.members) {
      try {
        planIdOf(memberId);
      } catch (e) {
        throw new Error(
          `--adopt REFUSED — batch manifest at "${join(mainDir, resolved.rel)}" has an ` +
            // The regex's own reason travels with the refusal (review 2599 r3 [0]): "not a
            // plan id" alone leaves an operator to re-derive WHY a stray-whitespace or
            // wrong-delimiter entry was rejected before they can repair the manifest.
            `unusable member entry ${JSON.stringify(memberId)} — ${e?.message ?? e}. ` +
            `The manifest's coord state is torn — restore it from origin/master history ` +
            `before re-running --adopt. There is no branch-only fallback.`,
        );
      }
      const status = planStatusFn(mainDir, memberId);
      if (status.held && !status.youAreHolder) {
        held.push({ memberId, ...holderLine(status.holder) });
      }
    }
    if (held.length > 0) {
      const holderLines = held.map((v) => `  refs/claims/${v.memberId} — HELD by [${v.who}]`);
      const releaseLines = held.map(
        (v) => `  node scripts/release-claim.mjs release ${v.memberId} --force`,
      );
      // Ruling 2: the re-claim gap is out of scope, but the per-member `--lock-only`
      // recipe (plan-1830 recipe, generalized per member) is printed here so it is
      // discoverable at the point of need. Scoped to the HELD members only (review 2599 [3]):
      // an unheld member needs no re-acquisition, and printing a line for one contradicts the
      // message's own HELD list. The manifest carries member plan ids, not each member's own
      // canonical basename slug, so the id-only form is printed and the operator is told the
      // slug is each member's own canonical basename.
      const lockOnlyLines = held.map(
        (v) =>
          `  node scripts/claim-plan.mjs acquire ${v.memberId} --slug <that member's own canonical slug> --lock-only`,
      );
      // ONE combined re-run line — a single worktree/branch serves the whole batch, so
      // there is one `.owner` provenance to carry over. Pre-fill from the first held member
      // whose claim record is actually READABLE (review 2599 [2]: keying on held[0] printed
      // `--taken-over-from "unknown"` whenever the first member in manifest order happened to
      // be the unparseable one, discarding provenance the very same message displays two lines
      // above). 'unknown' only when NO held member's record parsed.
      const reRunProvenance = held.find((v) => v.provenance)?.provenance || 'unknown';
      throw new Error(
        `--adopt REFUSED — batch "${slug}" has still-HELD member claims. Adopt never steals ` +
          `a held claim, at any age, and partial adoption cannot exist (one worktree/branch ` +
          `serves the whole batch):\n` +
          `${holderLines.join('\n')}\n` +
          `Confirm every holder is actually dead (operator judgment — no machine 6h gate), ` +
          `then release EVERY held member:\n` +
          `${releaseLines.join('\n')}\n` +
          `and re-run this adopt with the provenance carried over:\n` +
          `  node scripts/cut-worktree.mjs ${slug} ${adoptFlag} --taken-over-from "${reRunProvenance}"\n` +
          `Before re-running, each member's own claim can be re-acquired lock-only ` +
          `(the plan-1830 recipe, generalized per member):\n` +
          `${lockOnlyLines.join('\n')}`,
      );
    }
  } else {
    let planId;
    try {
      planId = planIdOf(slug);
    } catch {
      throw new Error(
        `--adopt needs a plan slug with a leading numeric id (got "${slug}") — ` +
          `the claim gate is keyed on refs/claims/<id>.`,
      );
    }
    const status = planStatusFn(mainDir, planId);
    if (status.held && !status.youAreHolder) {
      const { provenance, who } = holderLine(status.holder); // null holder → still a refusal
      throw new Error(
        `--adopt REFUSED — refs/claims/${planId} is still HELD by another session ` +
          `[${who}]. Adopt never steals a held claim, at any age: confirm the holder is actually ` +
          `dead (operator judgment — there is no machine 6h gate), then run\n` +
          `  node scripts/release-claim.mjs release ${planId} --force\n` +
          `and re-run this adopt with the provenance carried over:\n` +
          `  node scripts/cut-worktree.mjs ${slug} ${adoptFlag} --taken-over-from "${provenance || 'unknown'}"`,
      );
    }
  }
  // Branch-existence gate: ls-remote on the fully-qualified ref returns an empty string
  // when the branch does not exist on origin (never an error), so empty IS the signal.
  const srcLs = lsRemote(`refs/heads/${srcBranch}`);
  if (!srcLs) {
    throw new Error(
      `--adopt REFUSED — origin has no branch "${srcBranch}" (nothing to adopt: ` +
        `the zero-work-death case). Use the plain fresh-cut path instead: pickup-plan, or ` +
        `node scripts/cut-worktree.mjs ${slug}`,
    );
  }
  // Divergence gate (gate 3 above) — only reachable on an override adopt.
  if (srcBranch !== spineBranch) {
    const spineLs = lsRemote(`refs/heads/${spineBranch}`);
    if (spineLs) {
      const srcSha = srcLs.split(/\s+/)[0];
      const spineSha = spineLs.split(/\s+/)[0];
      if (srcSha !== spineSha) {
        // Ancestry needs the objects locally; fetch both tips, then let a fast-forwardable
        // spine tip through (the later `push -u` will ff it onto the override's history).
        // NOT coord-git's isAncestorRef: its bare catch reports ANY failure as "not an
        // ancestor", which is exactly the misdiagnosis this gate must avoid (review r2 [0]
        // — a lock-retry exhaustion must surface as the real error, never as a divergence
        // verdict pointing the operator at a fold/delete decision). merge-base's own
        // "not an ancestor" answer is precisely exit 1; everything else rethrows.
        exec(['fetch', 'origin', srcBranch, spineBranch]);
        srcFetched = true;
        let ffSafe = false;
        try {
          exec(['merge-base', '--is-ancestor', spineSha, srcSha]);
          ffSafe = true;
        } catch (e) {
          if (e?.status !== 1) throw e;
        }
        if (!ffSafe) {
          throw new Error(
            `--adopt REFUSED — origin ALSO has "${spineBranch}" (tip ${spineSha.slice(0, 10)}) and it is ` +
              `NOT an ancestor of "${srcBranch}" (tip ${srcSha.slice(0, 10)}): the normalization push onto ` +
              `${spineBranch} would be rejected non-fast-forward mid-adopt. Decide which branch is the ` +
              `truth first (operator call): adopt the spine branch directly (--adopt), or fold/delete the ` +
              `stale origin/${spineBranch}, then re-run with ${adoptFlag}.`,
          );
        }
      }
    }
  }
  return { srcFetched };
}

const USAGE =
  'cut-worktree: usage: node scripts/cut-worktree.mjs <slug> [--no-push] [--no-install] ' +
  '[--adopt[=<origin-branch>]] [--taken-over-from "<who>"] [--dense] | <slug> --widen | ' +
  '--widen --dir <worktree-path> | <slug> --narrow | --narrow --dir <worktree-path>';

export function main() {
  // plan 1957 / review [2]: parse through the ONE shared value-aware parser (parseFlags,
  // plan 1769) so a typo'd flag throws LOUDLY instead of being silently swallowed — a
  // mistyped --taken-over-from would otherwise silently drop the dead session's provenance.
  // `--adopt[=<branch>]` is an `optional`-kind flag (plan 1968): bare → true, `=`-joined →
  // the override branch, never the next token (a bare positional branch would be ambiguous
  // with the slug, which is why the override is `=`-joined at the CLI in the first place).
  let parsed;
  try {
    parsed = parseFlags(process.argv.slice(2), {
      label: 'cut-worktree',
      boolean: ['no-push', 'no-install', 'dense', 'widen', 'narrow'],
      optional: ['adopt'],
      value: ['taken-over-from', 'dir'],
    });
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  const { flags, positionals } = parsed;
  const slug = positionals[0];
  // Unset-shell-var guard on the flag that names a DIRECTORY (/gpt-review key 8c43a6), checked
  // BEFORE the usage test below: `--narrow --dir=$WT` with an empty expansion is falsy, so
  // without this it either falls through into the slug branch and narrows whatever the positional
  // names, or (with no positional) reports a generic usage error for a command the caller
  // believes it gave a target. Both hide the real mistake; name it instead.
  if (flags.dir === '') {
    console.error('cut-worktree: --dir requires a non-empty path');
    console.error(USAGE);
    return 2;
  }
  if (!slug && !((flags.widen || flags.narrow) && flags.dir)) {
    console.error(USAGE);
    return 2;
  }
  // The two doors are exact opposites; asking for both is always a mistake, never a sequence.
  // Checked BEFORE either branch runs so neither is half-applied.
  if (flags.widen && flags.narrow) {
    console.error('cut-worktree: --widen and --narrow are opposites — pass exactly one');
    console.error(USAGE);
    return 2;
  }
  // `--adopt=` with an empty value is almost always an unset shell variable
  // (`--adopt=$BRANCH`) — silently falling back to the default spine branch would adopt
  // the wrong thing; refuse loudly instead.
  if (flags.adopt === '') {
    console.error(
      'cut-worktree: --adopt= requires a non-empty branch (use bare --adopt for the default spine branch)',
    );
    console.error(USAGE);
    return 2;
  }
  // Review 1968 [0]: same unset-shell-var failure mode for the provenance flag —
  // `--taken-over-from=$PRIOR_HOLDER` with an empty expansion would otherwise fall
  // through `?? null` (empty string is not nullish) into cutWorktree's `|| 'unknown'`
  // fallback, silently recording 'unknown' where a real identity was intended. Covers
  // both the `=`-joined and next-token forms.
  if (flags['taken-over-from'] === '') {
    console.error(
      'cut-worktree: --taken-over-from requires a non-empty value (omit the flag for the default "unknown")',
    );
    console.error(USAGE);
    return 2;
  }
  // `--widen --dir <path>` needs no main checkout at all, and must not ask for one: it runs from
  // inside a gate (pre-push.sh, the pytest arm) while the shared main tree may legitimately sit
  // detached mid-land, where resolveMain() refuses -- and the gate's `|| true` would then turn a
  // skipped widen into a red pytest run on the missing stores (/gpt-review key 5f5858).
  const mainDir = (flags.widen || flags.narrow) && flags.dir ? null : resolveMain();
  // plan 3956: `--widen` is a second entry point over an EXISTING worktree, not a cut flag.
  // plan 4020: `--narrow` is its mirror, and shares the same "no other flag" contract.
  if (flags.widen || flags.narrow) {
    const door = flags.widen ? '--widen' : '--narrow';
    if (flags.dense || 'adopt' in flags || flags['no-push'] || flags['no-install']) {
      console.error(
        `cut-worktree: ${door} takes no other flag (it only ${flags.widen ? 'widens' : 'narrows'} an existing worktree)`,
      );
      console.error(USAGE);
      return 2;
    }
    const run = flags.widen ? widenWorktree : narrowWorktree;
    console.log(JSON.stringify(run(mainDir, slug ?? null, { dir: flags.dir ?? null })));
    return 0;
  }
  const r = cutWorktree(mainDir, slug, {
    // plan 1723: --no-install skips the automatic `pnpm install` (escape hatch for a
    // pure-docs/pure-Python worktree, or a caller that installs itself). Default is install.
    push: !flags['no-push'],
    installDeps: !flags['no-install'],
    adopt: 'adopt' in flags,
    adoptBranch: typeof flags.adopt === 'string' ? flags.adopt : null,
    takenOverFrom: flags['taken-over-from'] ?? null,
    dense: Boolean(flags.dense),
  });
  console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('cut-worktree:', e.message);
    process.exit(2);
  }
}
