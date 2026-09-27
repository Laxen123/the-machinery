#!/usr/bin/env node
// scripts/pre-yield-guard.mjs — protect loose uncommitted work in the shared
// main checkout ($MAIN) before a session yields (plan 230 Task 3).
//
// The clobber root cause (parallel-session collision review, 2026-05-30): a
// session held loose uncommitted edits in the shared main tree across a slow op
// (an AskUserQuestion wait, a long review), and a PARALLEL session's git op
// (reset/stash/checkout on the same `.git`) wiped them. Discipline can't fix it —
// both ops were legitimate. The fix: park the loose work in a NAMED stash
// (`wip-<slug>-<ts>`) before yielding, so (a) a sibling reset can't eat it and
// (b) sweep-stray-stashes.mjs can later find + surface/recover it by name.
//
// Operates on $MAIN only (the main checkout on master). Worktree sessions edit
// their OWN tree (a different working dir) and aren't exposed to this clobber —
// the victim is always a session working directly on master, typically the
// interactive operator. (Task 1's vetapp-op/ clone removes most of that
// exposure; this is the belt-and-suspenders for sessions still on master.)
//
// Usage:
//   node scripts/pre-yield-guard.mjs --slug <slug>            # stash dirty $MAIN as wip-<slug>-<ts>
//   node scripts/pre-yield-guard.mjs --slug <slug> --commit   # commit (not stash) — wip: <slug> pre-yield
//   node scripts/pre-yield-guard.mjs --slug <slug> --commit-safe --age-ms 90000
//                                                             # plan 977 Stop auto-park: idle PURE-DOC dirt
//                                                             # is committed+pushed to master, config/code is
//                                                             # stashed; dirt younger than --age-ms is left alone
//   node scripts/pre-yield-guard.mjs --slug <slug> --budget-ms 50000
//                                                             # plan 4026 kill-safety: yield (park nothing)
//                                                             # rather than start a stash/commit the caller's
//                                                             # deadline cannot finish. No flag = unlimited.
//   node scripts/pre-yield-guard.mjs --check                  # report only, change nothing (exit 3 if dirty)

import { execFileSync } from 'node:child_process';
import { statSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  resolveMain,
  gitWithLockRetry,
  pushMasterWithRebase,
  withCoordLock,
  readCoordOpJournal,
  LOCK_FREE_READ_ENV,
} from './coord-git.mjs';
import { COORDINATION_RX, coordinationRx } from './check-coordination-branch.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import {
  isCommitSafe,
  isJobOutput,
  jobOutputStashExcludesFor,
} from './main-checkout-allowlist.mjs';
import { scanForCorruption, corruptionWarning } from './corruption-guard.mjs';
import { findStageFolderViolations, STAGE_FOLDER_SCOPE } from './lint-plan-index.mjs';
import { walkPlanStatusDir, ARCHIVE_FOLDER } from './build-index-lib.mjs';
// plan 3968: the ONE truncated-index predicate — see its own header for the mechanism.
import { checkIndexSanity } from './index-sanity.mjs';

const PLANS_PREFIX = 'docs/superpowers/plans/';
const ARCHIVE_PREFIX = `${PLANS_PREFIX}${ARCHIVE_FOLDER}/`;

// plan 4026 — kill-safety for the Stop-hook park. The harness kills a Stop hook at its
// configured timeout, and a kill landing INSIDE `git stash push` leaves the working tree
// already rewritten to HEAD while the index still holds its pre-stash state: the stale-index
// wedge measured on the shared MAIN checkout 2026-09-14 (disk == HEAD, index older, a
// fast-forward pull blocked). Raising the timeout alone does not fix that — the stash step is
// non-atomic at ANY budget. So a caller that knows its own deadline passes `--budget-ms`, and
// the guard refuses to START a mutating step it cannot finish, leaving the dirt exactly as it
// found it. No budget (the default, and every caller but the Stop hook) = unlimited, i.e.
// today's behaviour unchanged.
//
// Measured from PROCESS start, not from guard() entry: the `git status` / `diff` / `ls-files`
// reads that precede the mutating step are exactly what eats the budget on a 132k-path
// checkout shared by 5–7 sessions.
export const PROCESS_START_MS = Date.now();

// How much wall time a `git stash push --include-untracked` (or the commitSafe commit+push)
// needs on this checkout. Calibrated from the coord-op journal (plan 4026 Part A: the two
// surviving pre-yield-guard runs took 7.1 s and 7.4 s END TO END, so the mutating tail alone
// sits well inside this). Deliberately generous in the safe direction — over-reserving costs
// one skipped park, under-reserving costs a torn index on the shared checkout.
export const STASH_RESERVE_MS = 10_000;

// null ⇒ the mutating step fits (or there is no budget); otherwise the elapsed ms, for the
// skip line. Kept as a pure function of its inputs so a test can pin the boundary without
// racing a real clock.
export function budgetShortfall({
  budgetMs = 0,
  startMs = PROCESS_START_MS,
  nowMs = Date.now(),
} = {}) {
  if (!budgetMs || budgetMs <= 0) return null;
  const elapsedMs = nowMs - startMs;
  return elapsedMs + STASH_RESERVE_MS > budgetMs ? elapsedMs : null;
}

// plan 4237 T3: the plan-4026 gate above covers the commit, but the commit's push can turn into
// fetch + REBASE + push on a non-ff — unbounded against the Stop hook's 60 s harness timeout. On
// 2026-09-26 that tail needed more than 50 s on the loaded box, the harness killed the hook
// mid-rebase, and the detached half-rebased MAIN it left is what heal-main then aborted and
// re-ran into the 30-path rollback commit. So the rebase itself is gated too: it starts only
// when the remaining budget covers a MEASURED rebase plus the stash reserve (the fetch before it
// and the push after it). The figure is the slowest closed `push-rebase` window among this
// host's most recent REBASE_SAMPLE_WINDOWS in the coord-op journal (slowest, not median: the
// wrong direction costs a killed rebase, the safe one costs a deferred push), or
// DEFAULT_REBASE_RESERVE_MS when the journal has none. When it does not fit, the hook keeps its
// local commit and LEAVES the push to the next heal-main pass, whose push carries the plan-4237
// replay guard — a local commit waiting for a heal is harmless, a killed rebase is not.
export const DEFAULT_REBASE_RESERVE_MS = 30_000;
export const REBASE_SAMPLE_WINDOWS = 20;

// Pure: the rebase figure from parsed journal entries (oldest first).
export function measuredRebaseMs(entries, { host = hostname() } = {}) {
  const starts = new Map();
  const durations = [];
  for (const e of entries || []) {
    if (e?.tool !== 'push-rebase' || (host && e.host && e.host !== host) || !e.token) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    if (e.phase === 'start') starts.set(e.token, t);
    else if (e.phase === 'done' && starts.has(e.token)) {
      durations.push(t - starts.get(e.token));
      starts.delete(e.token);
    }
  }
  const recent = durations.filter((d) => d >= 0).slice(-REBASE_SAMPLE_WINDOWS);
  return recent.length ? Math.max(...recent) : DEFAULT_REBASE_RESERVE_MS;
}

// Pure: may a rebase start now? No budget = unlimited (every caller but the Stop hook).
export function rebaseFitsBudget({
  budgetMs = 0,
  startMs = PROCESS_START_MS,
  nowMs = Date.now(),
  rebaseMs = DEFAULT_REBASE_RESERVE_MS,
} = {}) {
  if (!budgetMs || budgetMs <= 0) return true;
  return nowMs - startMs + rebaseMs + STASH_RESERVE_MS <= budgetMs;
}

// Compact, filesystem-safe timestamp for the stash/commit label.
export function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
}

// Lines from `git status --porcelain`; true if any tracked-or-untracked change.
export function isDirty(porcelain) {
  return porcelain.split('\n').some((l) => l.trim() !== '');
}

// Extract the working-tree path(s) a porcelain line touches. `XY path`, or for a
// rename/copy `XY orig -> dest` (both sides matter). git double-quotes a path with a
// space/special char — strip the quotes so the regex below matches plain strings.
function pathsOf(line) {
  const rest = line.slice(3); // 2-char status + 1 space
  const unquote = (p) => {
    const t = p.trim();
    return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t;
  };
  return (rest.includes(' -> ') ? rest.split(' -> ') : [rest]).map(unquote);
}

// Split once at the status-read boundary: every downstream classifier and mutator sees
// only loose session work, while live pipeline artefacts remain owned by their writer.
// Matching every path also handles rename/copy entries and git's collapsed untracked
// directory form (`?? backend/data/job-pipeline/batches/x/`).
export function partitionJobOutput(porcelain, jobOutputPrefixes) {
  const parkable = [];
  const jobOutput = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    (pathsOf(line).every((p) => isJobOutput(p, jobOutputPrefixes)) ? jobOutput : parkable).push(
      line,
    );
  }
  return { parkable: parkable.join('\n'), jobOutput: jobOutput.join('\n') };
}

// The coordination-doc paths (plans/**, INDEX, board, handoff/**) that are dirty in
// `$MAIN` — the deferred-commit hazard plan 533 names specifically. Reuses the SAME
// COORDINATION_RX the pre-commit branch guard uses, so the two guards agree on what
// "a coordination doc" is. Returns a de-duped, sorted path list.
export function coordDirt(porcelain, rx = COORDINATION_RX) {
  const hits = new Set();
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    for (const p of pathsOf(line)) {
      if (rx.test(p.replace(/\\/g, '/'))) hits.add(p);
    }
  }
  return [...hits].sort();
}

// All distinct working-tree paths touched by `git status --porcelain` (both sides of
// a rename), de-duped + sorted. Used by commitSafe to stage/classify the dirt.
export function dirtyPaths(porcelain) {
  const set = new Set();
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    for (const p of pathsOf(line)) set.add(p);
  }
  return [...set].sort();
}

// True if any porcelain entry is a DELETION / RENAME / COPY (status D|R|C on either
// side) OR an unmerged/conflict state. commitSafe refuses to auto-commit+push these
// even when all paths are docs: a deletion or rename landed on master is far harder to
// undo than an additive edit (no force-push allowed), and a conflict-marked file must
// never be auto-committed+pushed to shared master. Both are stashed for human review.
export function hasRiskyChange(porcelain) {
  return porcelain.split('\n').some((l) => {
    if (!l.trim()) return false;
    const x = l[0]; // index/staged side
    const y = l[1]; // worktree side
    // Deletion / rename / copy are hard to undo on master; unmerged (any 'U', or the
    // both-added 'AA' / both-deleted 'DD' that carry no 'U') are conflict states that
    // must never be auto-committed. Check the two status columns explicitly rather than
    // substring-matching the 2-char code (which misses 'AA'/'UU' — they contain no D/R/C).
    const risky = (c) => c === 'D' || c === 'R' || c === 'C';
    const xy = l.slice(0, 2);
    return risky(x) || risky(y) || x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD';
  });
}

// Untracked plan files in a non-archive subfolder whose basename is already tracked in
// docs/superpowers/plans/archive/ — the auto-heal archive-duplicate trap (plan 1175).
// When the auto-heal Stop-hook commits these it re-tracks a stale source-folder copy of
// an already-archived plan. The next push then trips lint-plan-index archive-consistency
// ("archived in INDEX but the file is tracked in pending-approval/"), wedging the push/land path
// for all parallel sessions.
//
// Returns normalised (forward-slash) repo-relative paths of stale archive-duplicates so
// the commitSafe branch can filter them before staging. Uses `git ls-files --others` to
// expand untracked directories — git status --porcelain collapses an entirely-untracked
// directory into a single `?? dir/` entry, which `pathsOf` would return verbatim without
// expansion, missing the individual files inside.
export function staleArchiveDuplicatePaths(mainDir, porcelain) {
  // Early exit: nothing untracked in this porcelain → skip the git calls.
  if (!porcelain.split('\n').some((l) => l.startsWith('?? '))) return [];
  // Expand every untracked file under docs/superpowers/plans/ (ls-files --others
  // recurses into untracked directories; porcelain only gives the dir-level `??` entry).
  let untrackedPlanFiles;
  try {
    untrackedPlanFiles = gitWithLockRetry(mainDir, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      PLANS_PREFIX,
    ])
      .split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, '/'));
  } catch {
    return []; // non-fatal: skip the guard if ls-files fails
  }
  const untrackedNonArchive = untrackedPlanFiles.filter((p) => !p.startsWith(ARCHIVE_PREFIX));
  if (!untrackedNonArchive.length) return [];
  let archiveTracked;
  try {
    archiveTracked = new Set(
      gitWithLockRetry(mainDir, ['ls-files', '--', ARCHIVE_PREFIX])
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/\\/g, '/').split('/').pop()),
    );
  } catch {
    return []; // non-fatal
  }
  if (!archiveTracked.size) return [];
  return untrackedNonArchive.filter((p) => archiveTracked.has(p.split('/').pop()));
}

// settings.local.json (the only commit-safe CONFIG path) is auto-committed + pushed to
// shared master, so never push a syntactically-broken one (plan 1108 review): if any
// .claude/*.json among the dirt does not parse, the whole batch is STASHED for human
// review instead of committed+pushed. Docs need no such gate. Reads from $MAIN on disk;
// a missing/unreadable file is treated as invalid (conservative → stash).
export function commitSafeJsonValid(mainDir, paths) {
  for (const p of paths) {
    if (!(p.startsWith('.claude/') && p.endsWith('.json'))) continue;
    try {
      JSON.parse(readFileSync(join(mainDir, p), 'utf8'));
    } catch {
      return false;
    }
  }
  return true;
}

// Plan 2553: the auto-heal commit below runs with HUSKY=0 (no pre-push), so it is the
// ONE writer that never runs lint-plan-index's stage/folder invariant (plan 1371 D7:
// pending-approval/ may hold only stage: stub) — yet a plan-doc commit is exactly what
// can violate it (a board-pass stamps stage: specced before routing the plan out of
// pending-approval/, and the auto-heal can land that stamp in the gap between stamp and
// route). This delegates to the REAL check — findStageFolderViolations, imported from
// lint-plan-index.mjs, never a re-implemented copy of the rule.
//
// Review fix (post-2553): findStageFolderViolations only ever flags entries whose
// top-level folder is STAGE_FOLDER_SCOPE ('pending-approval/') — every other folder is
// `continue`d past unconditionally (see lint-plan-index.mjs). So there is no need to
// enumerate the whole tracked plan corpus via `git ls-files` (~2500 files, mostly
// archive/) at all; this reads ONLY docs/superpowers/plans/pending-approval/ straight off
// disk in `mainDir` via readdirSync, which — unlike `git ls-files` — sees BOTH tracked
// and UNTRACKED files. That untracked-blind-spot mattered: `guardMutate`'s `git add`
// only runs AFTER this check, inside the `if (allCommitSafe)` block, so a brand-new,
// never-`git add`-ed plan file freshly authored under pending-approval/ with
// `stage: specced` was previously invisible to the corpus scan and would ride the
// auto-heal commit+push straight to master unstashed — the more natural trigger for
// this incident class than a pre-existing tracked violation. Reading the one in-scope
// folder off disk also cuts I/O by roughly two orders of magnitude vs. reading every
// tracked plan file repo-wide on this hot Stop-hook path.
//
// Cost short-circuit unchanged: skip entirely (no filesystem access at all) unless the
// dirt itself touches docs/superpowers/plans/ — nothing under pending-approval/ could
// have changed by any OTHER path being committed.
//
// Fail-open/fail-closed reasoning: a MISSING pending-approval/ folder is a legitimate
// "nothing there to violate" reading (not every mainDir has ever minted a plan resting
// in the stub pen) — returning `true` (no violation) for that specific case is correct,
// not a fail-open compromise. But that ENOENT is indistinguishable, by itself, from
// `mainDir` not existing at all (a "something is badly wrong" signal that must still
// fail CLOSED, per the existing test using a nonexistent mainDir). So on ENOENT we
// explicitly check whether `mainDir` itself exists: if it does, the subfolder is simply
// absent (true); if `mainDir` itself is missing/unreachable, fail closed (false), same
// as any other unexpected scan error — mirroring staleArchiveDuplicatePaths /
// commitSafeJsonValid's conservative pattern of never letting an error push a tree
// nobody actually checked.
export function commitSafeStageFolderOk(mainDir, paths) {
  if (!paths.some((p) => p.replace(/\\/g, '/').startsWith(PLANS_PREFIX))) return true;
  const scopeDir = join(mainDir, PLANS_PREFIX, STAGE_FOLDER_SCOPE);
  let names;
  try {
    // plan 2678: RECURSIVE — `pending-approval/` may hold one level of optional category
    // subfolders, and a `stage: specced` plan resting in one is exactly the violation this
    // Stop-hook gate exists to catch pre-commit. `names` are scope-relative POSIX paths
    // (`x.md`, `denmark/x.md`); the ENOENT/fail-closed contract below is unchanged, and the
    // walker's own readdir seam re-throws so that contract still sees the real errno.
    names = walkPlanStatusDir({
      statusFolder: STAGE_FOLDER_SCOPE,
      readdir: (segments) => readdirSync(join(scopeDir, ...segments), { withFileTypes: true }),
    }).map((e) => e.relInStatus);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Disambiguate "pending-approval/ legitimately doesn't exist" (empty scope, no
      // violation) from "mainDir itself is missing" (fail closed) — both throw the same
      // ENOENT on scopeDir, so check mainDir's own existence explicitly.
      try {
        statSync(mainDir);
        return true; // mainDir is real; the pending-approval/ subfolder just isn't there
      } catch {
        return false; // mainDir itself doesn't exist — something is badly wrong
      }
    }
    return false; // any other readdir error (permissions, ENOTDIR, …) — fail closed
  }
  const entries = [];
  for (const name of names) {
    try {
      entries.push({
        path: `${PLANS_PREFIX}${STAGE_FOLDER_SCOPE}/${name}`,
        content: readFileSync(join(scopeDir, ...name.split('/')), 'utf8'),
      });
    } catch {
      // Half-staged mv / deleted mid-read — not this check's concern, mirrors
      // lint-plan-index.mjs's own checkStageFolderInvariant IO wrapper tolerance.
    }
  }
  try {
    return findStageFolderViolations(entries).length === 0;
  } catch {
    return false; // fail closed
  }
}

// Plan 1634: splits `paths` (working-tree relative) into `clean` and `corrupted` — a
// disk-corruption signature (same-size all-NUL, or a text→binary flip vs the file's HEAD
// blob) is never a legitimate edit. Every mutating mode in guardMutate excludes `corrupted`
// from whatever it does (commit, stash, or the commitSafe auto-push) — it is left exactly
// as-is on disk for a human/heal to find. Thin wrapper over corruption-guard.mjs's shared
// scanForCorruption, injecting this module's own fs/git access.
export function partitionCorruptPaths(mainDir, paths) {
  return scanForCorruption(
    paths,
    (p) => readFileSync(join(mainDir, p), 'utf8'),
    (p) => gitWithLockRetry(mainDir, ['show', `HEAD:${p}`]),
  );
}

// git's canonical empty-tree object id — what a stash's untracked (^3) parent resolves to
// when `--include-untracked` was passed but nothing was actually untracked at park time.
// Same constant sweep-stray-stashes.mjs defines independently for its own no-op classifier
// (plan 3206 Task 3) — duplicated rather than imported, matching this repo's existing
// pattern of each git-shelling module owning its own small plumbing constants (each file
// already carries its own `git`/`gitWithLockRetry` call convention and error handling).
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Plan 3206: distinguish REAL dirt — content that SURVIVES git's own line-ending
// normalization — from a line-ending-only rewrite that `.gitattributes`'s
// `* text=auto eol=lf` erases on the way into a stash/commit. `git status --porcelain`
// flags a CRLF-rewritten tracked file as modified (the on-disk BYTES differ from the
// index), but `git diff --quiet HEAD` answers CLEAN once git applies the SAME clean
// filter to both sides for comparison — verified 2026-08-15 in a throwaway repro (see the
// plan body's reproduction): `git status --porcelain` reports `" M a.txt"` while
// `git diff --quiet HEAD` exits 0, for the exact same file. 465 no-op stashes accumulated
// 2026-08-12→15 from exactly this disagreement (the plan's measured blast radius).
// Scoped to `paths` (the caller's already corrupted-excluded set) so a stray corrupted
// file elsewhere in the tree can never mask a genuine "nothing here" verdict for the paths
// actually headed into the stash — see the corrupted-path exclusion (plan 1634) this
// predicate runs AFTER, per the plan's execution notes.
export function hasRealDirt(mainDir, paths) {
  if (!paths.length) return false;
  try {
    gitWithLockRetry(mainDir, ['diff', '--quiet', 'HEAD', '--', ...paths], {
      env: LOCK_FREE_READ_ENV,
    });
    // exit 0 → every one of these paths' tracked content is identical to HEAD once
    // normalized; fall through to the untracked check below.
  } catch (e) {
    // `git diff --quiet` uses its EXIT CODE as the signal (1 = differences found), not an
    // error condition. gitWithLockRetry only retries lock-contention / transient-index-
    // write / ref-lock / ref-update wording and re-throws everything else untouched, so
    // `e.status` here is git's real exit code, not a synthetic wrapper value.
    if (e.status === 1) return true; // a tracked diff survives normalization → real dirt
    throw e; // any other exit (git itself failed) is a genuine error, not "clean"
  }
  const untracked = gitWithLockRetry(mainDir, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...paths,
  ]);
  return untracked.split('\n').some((l) => l.trim() !== '');
}

// Plan 3206 Task 2 (belt and braces): true if stash `ref` holds NOTHING AT ALL — whatever
// produced it, a stash whose working-tree snapshot AND index snapshot are both identical to
// the commit it was parked on top of, with no (or empty) untracked parent, stores no
// recoverable content. Mirrors the shape sweep-stray-stashes.mjs's own no-op classifier
// (Task 3) checks — the SAME predicate, duplicated rather than shared because it runs here
// on a bare stash ref immediately after creation, under this module's gitWithLockRetry
// convention, before sweep-stray-stashes' separate stray-subject-driven sweep would ever
// see it. Any failure to resolve a tree → false (surface/keep, the safe direction — mirrors
// hasRealDirt's and isSubsumedByHead's own failure handling).
export function isEmptyStash(mainDir, ref) {
  let baseTree;
  try {
    baseTree = gitWithLockRetry(mainDir, ['rev-parse', `${ref}^1^{tree}`]).trim();
  } catch {
    return false;
  }
  let stashTree;
  try {
    stashTree = gitWithLockRetry(mainDir, ['rev-parse', `${ref}^{tree}`]).trim();
  } catch {
    return false;
  }
  if (stashTree !== baseTree) return false; // working-tree snapshot differs from base → real
  let indexTree;
  try {
    indexTree = gitWithLockRetry(mainDir, ['rev-parse', `${ref}^2^{tree}`]).trim();
  } catch {
    return false;
  }
  if (indexTree !== baseTree) return false; // staged snapshot differs from base → real
  let hasCaret3 = false;
  try {
    gitWithLockRetry(mainDir, ['rev-parse', '--verify', '--quiet', `${ref}^3`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    hasCaret3 = true;
  } catch {
    /* no ^3 → nothing untracked was carried, consistent with "empty" */
  }
  if (hasCaret3) {
    let untrackedTree;
    try {
      untrackedTree = gitWithLockRetry(mainDir, ['rev-parse', `${ref}^3^{tree}`]).trim();
    } catch {
      return false;
    }
    if (untrackedTree !== EMPTY_TREE_SHA) return false; // real untracked content → not empty
  }
  return true;
}

// Plan 3206 Task 2: right after a stash push THIS guard issued, inspect what actually got
// parked and drop it if it turns out to hold nothing — catches any OTHER producer of an
// empty stash (not just the CRLF-only shape Task 1's pre-check already prevents upstream)
// without needing to know its cause. Called from inside the SAME withCoordLock window as
// the push (guardMutate is the coord-locked mutating tail — see guard()), so there is no
// unlocked gap between "stash created" and "stash inspected here". Guards against dropping
// a RACING sibling's stash by first confirming stash@{0}'s subject is demonstrably the one
// just pushed (it carries `label` verbatim, per the `git stash push -m label` call site).
// Never throws: an inspection failure just leaves the stash as-is — it is safely
// recoverable either way; dropping it is an optimization, not a correctness requirement.
// Returns true iff it dropped the stash.
export function dropIfEmptyStash(mainDir, { label, log }) {
  try {
    const raw = gitWithLockRetry(mainDir, ['stash', 'list', '--format=%gs']);
    const topSubject = (raw.split('\n')[0] || '').trim();
    if (!topSubject.includes(label)) return false; // a sibling raced us into slot 0 — leave it
    if (!isEmptyStash(mainDir, 'stash@{0}')) return false;
    gitWithLockRetry(mainDir, ['stash', 'drop', 'stash@{0}']);
    log(`pre-yield-guard: stash "${label}" turned out to hold nothing — dropped it.`);
    return true;
  } catch (e) {
    log(
      `pre-yield-guard: post-push empty-stash check failed (${e.message}) — leaving the stash as-is.`,
    );
    return false;
  }
}

// Age (ms) of the FRESHEST dirty file = now - max(mtime). Plan 977 gates the Stop
// auto-park on this so an ACTIVE in-progress edit (just touched) and the sub-second
// coordWrite transient window (a board/index/queue mid-commit) are never parked —
// only persisted dirt is acted on. Deleted/missing paths have no mtime and are
// ignored; if NOTHING dirty exists on disk (pure deletions) the dirt is treated as
// stale (Infinity) so it is acted on.
export function dirtAgeMs(mainDir, porcelain, now = new Date()) {
  let newest = -Infinity;
  for (const rel of dirtyPaths(porcelain)) {
    try {
      const m = statSync(join(mainDir, rel)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* deleted / missing on disk — not an active edit, ignore */
    }
  }
  if (newest === -Infinity) return Infinity;
  return now.getTime() - newest;
}

export function guard(
  mainDir,
  {
    slug = 'session',
    commit = false,
    commitSafe = false,
    check = false,
    ageThresholdMs = 0,
    // plan 4026: 0 = unlimited (every caller but the Stop hook). `startMs` is a seam so a test
    // can place the deadline without sleeping; production always measures from process entry.
    budgetMs = 0,
    startMs = PROCESS_START_MS,
    // plan 4237 T3: a test seam for the rebase figure; production measures it from the journal.
    rebaseReserveMs = null,
    now = new Date(),
    log = console.log,
    exec = execFileSync,
  } = {},
) {
  // plan 3968: the commit-safe path is what the Stop-hook auto-park
  // (scripts/hooks/park-master-dirt-on-stop.sh → --commit-safe) runs unattended, with no
  // heal-main pass ahead of it to have already rebuilt a torn index. A truncated index
  // reads to `git status` as "the whole tree deleted plus untracked" — never park that as
  // if it were real work; send the operator/session at heal-main instead.
  //
  // plan 3968 review (73114a): this used to run ONLY when commitSafe — but every mode below
  // reads `git status --porcelain` unconditionally right after, so a truncated index makes
  // ANY mode's read lie identically, not just commitSafe's. heal-main's own `--dry` preview
  // calls guard(mainDir, { check: true }) WITHOUT commitSafe specifically to preview what a
  // real run would do; gating this on commitSafe alone left that preview reading raw (still
  // torn) status and printing a misleading "MAIN has uncommitted work" report instead of the
  // true "index looks TRUNCATED" one a real run's own step 0 would already have fixed before
  // healDirt ever ran. So this check now runs unconditionally, before any mode branches.
  // plan 3968 review round 2 (6f8265): `unknown` (the staged-deletion probe itself failed) is
  // treated exactly like `truncated` here — this guard has no way to tell "the index is fine"
  // from "the index is torn" in that state, and the whole point of this check is to never let
  // an unverified index drive a commit/stash decision.
  // `exec` is a testability seam only (mirrors index-sanity.mjs's own `exec` option) — no
  // production caller passes it.
  const sanity = checkIndexSanity(mainDir, { exec });
  if (sanity.truncated || sanity.unknown) {
    const verb = sanity.unknown ? 'could not be verified' : 'looks TRUNCATED';
    log(
      `pre-yield-guard: $MAIN's .git/index ${verb} (${sanity.why}) — refusing to ` +
        `commit/stash what would read as "the whole tree deleted"; run \`node scripts/heal-main.mjs\` ` +
        `to rebuild the index first, then re-run.`,
    );
    return {
      protected: false,
      dirty: true,
      skipped: sanity.unknown ? 'index-state-unknown' : 'truncated-index',
      indexSanity: sanity,
    };
  }
  // plan 4237 T2: this read runs BEFORE the coord lock is taken, on the shared MAIN checkout —
  // never let it write the index back (see LOCK_FREE_READ_ENV).
  const statusPorcelain = gitWithLockRetry(mainDir, ['status', '--porcelain'], {
    env: LOCK_FREE_READ_ENV,
  });
  const { jobOutputPrefixes } = loadCoordConfig(mainDir);
  const { parkable: porcelain, jobOutput } = partitionJobOutput(statusPorcelain, jobOutputPrefixes);
  const jobOutputPaths = dirtyPaths(jobOutput);
  if (jobOutputPaths.length) {
    const shown = jobOutputPaths.slice(0, 5);
    const more = jobOutputPaths.length - shown.length;
    log(
      `pre-yield-guard: leaving ${jobOutputPaths.length} live pipeline-output path(s) in place ` +
        `(${jobOutputPrefixes.join(', ')} is job-owned, never parked): ${shown.join(', ')}` +
        (more ? `, +${more} more` : ''),
    );
  }
  if (!isDirty(porcelain)) {
    if (jobOutputPaths.length) {
      if (check) {
        log('pre-yield-guard: live pipeline output (not loose work at risk — --check):');
        log(jobOutput.trimEnd());
      }
      return { protected: false, dirty: true, skipped: 'job-output-only' };
    }
    log('pre-yield-guard: $MAIN clean — nothing to protect.');
    return { protected: false, dirty: false };
  }
  if (check) {
    if (jobOutputPaths.length) {
      log('pre-yield-guard: live pipeline output (not loose work at risk — --check):');
      log(jobOutput.trimEnd());
      log('');
    }
    log('pre-yield-guard: $MAIN has uncommitted work (not parked — --check):');
    log(porcelain.trimEnd());
    // plan 533 T3: a dirty COORDINATION doc (plan body / INDEX / board / handoff) in
    // $MAIN is the deferred-commit hazard — name it explicitly with the remedy, since
    // it must NOT be left for a parallel session to sweep. (Generic dirt is fine to
    // stash; a coord-doc edit belongs on master via its coord tool, committed now.)
    const coord = coordDirt(porcelain, coordinationRx(loadCoordConfig(mainDir).paths));
    if (coord.length) {
      log('');
      log(
        '  ⚠ uncommitted COORDINATION doc(s) in $MAIN — commit these on master NOW, do not defer:',
      );
      coord.forEach((p) => log(`     ${p}`));
      log(
        '     plan body → `node scripts/edit-plan.mjs <id> …`; board → `board.mjs`; INDEX → `index.mjs`/`move-plan.mjs`;',
      );
      log(
        '     rolling handoff / session entries → commit directly on master (`git -C $MAIN commit -- <path>`).',
      );
    }
    // Plan 1634: preview which dirty paths look disk-corrupted, so a --dry/--check reader
    // (heal-main.mjs) doesn't promise a commit/stash that a real run would refuse to do.
    const { corrupted } = partitionCorruptPaths(mainDir, dirtyPaths(porcelain));
    const corruptedPaths = corrupted.map((c) => c.path);
    if (corruptedPaths.length) {
      log('');
      log(
        '  ⚠ corrupted (disk-zeroed / unreadable / binary-flip) file(s) — a real run excludes these from any commit/stash:',
      );
      corrupted.forEach(({ path: p, reason }) => log(`     ${p} (${reason})`));
    }
    return {
      protected: false,
      dirty: true,
      coordDirty: coord.length > 0,
      coord,
      corrupted: corruptedPaths,
    };
  }

  // plan 977 age gate: leave an ACTIVE in-progress edit (just touched) and the
  // sub-second coordWrite transient window alone — only persisted dirt is acted on.
  if (ageThresholdMs > 0) {
    const ageMs = dirtAgeMs(mainDir, porcelain, now);
    // Skip only genuinely-fresh dirt: modified within ±threshold of `now`. A SMALL
    // negative age is just clock granularity (mtime has sub-ms precision; Date.now() is
    // integer-ms, so a just-written file reads ~-1ms) and IS a fresh active edit. But a
    // LARGE negative age — a mtime dated far in the FUTURE (clock/FAT skew) — must NOT
    // count as fresh, or skewed dirt is left loose; act on it. `abs < threshold` keeps
    // the granularity case fresh while treating beyond-threshold future-dating as skew.
    if (Math.abs(ageMs) < ageThresholdMs) {
      log(
        `pre-yield-guard: $MAIN dirt is ${Math.round(ageMs / 1000)}s old (< ${Math.round(
          ageThresholdMs / 1000,
        )}s threshold) — likely an active edit or a live coordWrite window; not parking.`,
      );
      return { protected: false, dirty: true, skipped: 'too-fresh', ageMs };
    }
  }

  // plan 1286: the commit/stash step below MUTATES the shared main checkout (that is its
  // job — the dirt lives there), so it serializes on the coord-write lock: a coord write
  // mid-flight, a sibling Stop-hook heal, or heal-main must never interleave with the
  // stash/commit dance. The read-only --check and age-gate paths above stay lock-free.
  return withCoordLock(
    mainDir,
    () =>
      guardMutate(mainDir, porcelain, {
        slug,
        commit,
        commitSafe,
        budgetMs,
        startMs,
        rebaseReserveMs,
        now,
        log,
      }),
    { tool: 'pre-yield-guard' },
  );
}

// The mutating tail of guard() — runs UNDER the coord-write lock (plan 1286).
function guardMutate(
  mainDir,
  porcelain,
  {
    slug,
    commit,
    commitSafe,
    budgetMs = 0,
    startMs = PROCESS_START_MS,
    rebaseReserveMs = null,
    now,
    log,
  },
) {
  const label = `wip-${slug}-${stamp(now)}`;
  const { jobOutputPrefixes } = loadCoordConfig(mainDir);

  // plan 4026: the budget gate. Deliberately consulted at each MUTATING step rather than once
  // on entry — the lock is already held here, so a yield leaves nothing half-done, and every
  // read this function does first (the corruption scan, the `ls-files --others` expansion, the
  // still-dirty re-read) is wall time the caller's deadline is really spending.
  const skipForBudget = (elapsedMs) => {
    log(
      `pre-yield-guard: park skipped: budget (elapsed ${elapsedMs} ms of ${budgetMs} ms, ` +
        `reserve ${STASH_RESERVE_MS} ms) — dirt left untouched for the next run.`,
    );
    return { protected: false, dirty: true, skipped: 'budget', elapsedMs, budgetMs };
  };

  // plan 977 commitSafe (operator decision 2026-06-22, extended 2026-06-27 by plan
  // 1108): idle COMMIT-SAFE dirt (plans/specs/handoff/INDEX/wiki + .claude/settings.local.json
  // — everything isCommitSafe accepts) is auto-committed + pushed to master, the clean
  // self-heal a human would do and nothing left to `git stash pop`. ANYTHING else —
  // .claude/settings.json, app code (hooks under scripts/hooks/** included since plan
  // 3765), a MIX, or a deletion/rename
  // (harder to undo on master) — is STASHED: a Stop hook must never auto-push a
  // half-edited main settings.json/hook (breaks every session), arbitrary code, or a
  // hard-to-reverse removal.
  // Plan 1634: scan ALL dirty paths for a corruption signature ONCE, before branching on
  // mode — commitSafe, --commit, and the bare default stash all mutate $MAIN's working
  // tree from the SAME dirty set, so a disk-corrupted file must be excluded from every
  // one of them (a review-caught gap: the first cut only wired this into commitSafe).
  // Excluded paths never reach a commit or a stash; they are left exactly as-is on disk
  // for a human/heal to find.
  const allDirtyPaths = dirtyPaths(porcelain);
  const { corrupted } = partitionCorruptPaths(mainDir, allDirtyPaths);
  for (const { path: p, reason } of corrupted) log(corruptionWarning(p, reason));
  const corruptPaths = corrupted.map((c) => c.path);
  const corruptSet = new Set(corruptPaths);

  if (commitSafe) {
    // Detect stale archive-duplicates — untracked plan files whose basename is already
    // tracked in archive/ (plan 1175). Must use ls-files --others (not porcelain) to
    // expand collapsed `?? dir/` entries into individual files.
    const staleDups = staleArchiveDuplicatePaths(mainDir, porcelain);
    const staleDupSet = new Set(staleDups); // already normalised (forward slashes)
    // Rebuild the paths list to exclude stale archive-duplicates. git status --porcelain
    // can collapse an entirely-untracked plan subdir into a single `?? dir/` entry; a
    // plain `git add -- dir/` would sweep in the stale dup. So when stale dups were found
    // we expand any collapsed directory entries to their individual constituent files,
    // then filter. Paths without stale dups are left as-is (cheaper, common case).
    let paths;
    let expansionFailed = false;
    if (staleDups.length) {
      log(
        `pre-yield-guard: skipping ${staleDups.length} stale archive-duplicate plan file(s) ` +
          `(archive-consistency would fail if committed): ${staleDups.join(', ')}`,
      );
      paths = [];
      for (const p of allDirtyPaths) {
        const norm = p.replace(/\\/g, '/');
        if (norm.startsWith(PLANS_PREFIX) && norm.endsWith('/')) {
          // Collapsed untracked directory: expand to individual files, drop stale dups.
          try {
            const files = gitWithLockRetry(mainDir, [
              'ls-files',
              '--others',
              '--exclude-standard',
              '--',
              p,
            ])
              .split('\n')
              .filter(Boolean)
              .map((f) => f.replace(/\\/g, '/'));
            paths.push(...files.filter((f) => !staleDupSet.has(f)));
          } catch {
            // Expansion failed — flag it. We cannot safely add the raw directory (it
            // contains the stale dup), so we skip it here. The expansionFailed flag
            // prevents the stale-dups-only early-exit below from firing, ensuring any
            // real new plans inside the directory are still captured by the stash.
            expansionFailed = true;
          }
        } else if (!staleDupSet.has(norm)) {
          paths.push(p);
        }
      }
    } else {
      paths = allDirtyPaths;
    }
    // If the ONLY dirty content was stale archive-duplicate plan files (all real paths
    // filtered out, no expansion failure that might have hidden real work), skip the
    // stash entirely. Stale dups are not real work; stashing them causes
    // sweep-stray-stashes to surface the stash as real un-landed work, which an
    // operator popping would re-introduce the stale dup and restart the
    // archive-consistency wedge cycle. Leave them on disk — done-worktree cleanup or
    // move-plan archive will delete them on the next landing.
    if (staleDups.length > 0 && paths.length === 0 && !expansionFailed) {
      log(
        `pre-yield-guard: only stale archive-duplicate(s) in working tree — nothing real to protect; skipping stash.`,
      );
      return { protected: false, dirty: false };
    }
    // Exclude disk-corrupted paths from the commit-safe candidate set (scanned once, above).
    paths = paths.filter((p) => !corruptSet.has(p));
    const allCommitSafe =
      paths.length > 0 &&
      !hasRiskyChange(porcelain) &&
      paths.every(isCommitSafe) &&
      commitSafeJsonValid(mainDir, paths) &&
      commitSafeStageFolderOk(mainDir, paths);
    if (allCommitSafe) {
      // plan 4026: commit + pushMasterWithRebase is the OTHER non-atomic mutating step here
      // (a kill between the local commit and the push leaves an unpushed master commit), so
      // it takes the same gate as the stash below.
      const overBudget = budgetShortfall({ budgetMs, startMs });
      if (overBudget !== null) return skipForBudget(overBudget);
      let committed = false;
      try {
        gitWithLockRetry(mainDir, ['add', '--', ...paths]);
        gitWithLockRetry(
          mainDir,
          [
            'commit',
            '-m',
            `auto-heal: commit idle commit-safe dirt (${slug}) ${stamp(now)}`,
            '--',
            ...paths,
          ],
          { env: { ...process.env, HUSKY: '0' } },
        );
        committed = true;
        // Rebase-replays our commit onto origin/master on a non-ff, preserving the
        // content (unlike coordWrite, whose retry reverts paths to be regenerated).
        // plan 4237 T3: …but only when the budget left covers a measured rebase.
        pushMasterWithRebase(mainDir, {
          beforeRebase: () =>
            rebaseFitsBudget({
              budgetMs,
              startMs,
              rebaseMs: rebaseReserveMs ?? measuredRebaseMs(readCoordOpJournal(mainDir)),
            }),
        });
        log(
          `pre-yield-guard: committed + pushed ${paths.length} idle commit-safe file(s) to master (${paths.join(
            ', ',
          )}).`,
        );
        return {
          protected: true,
          dirty: true,
          mode: 'commit-safe',
          paths,
          ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
        };
      } catch (e) {
        // plan 4237 T3: the push needed a rebase the budget cannot cover. Keep the commit —
        // heal-main's master sync pushes it (through the replay guard) on its next pass.
        if (committed && e?.code === 'PUSH_REBASE_DEFERRED') {
          log(
            `pre-yield-guard: committed ${paths.length} idle commit-safe file(s) to LOCAL master; ` +
              `the push needs a rebase this run's budget cannot finish, so it is left to the next ` +
              `heal-main pass (\`node scripts/heal-main.mjs\`).`,
          );
          return {
            protected: true,
            dirty: true,
            mode: 'commit-push-deferred',
            paths,
            ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
          };
        }
        // Push failed: undo the local commit so the dirt returns to the working tree,
        // then fall through to STASH — never leave an unpushed local master commit (it
        // would diverge from origin and break sibling cuts).
        if (committed) {
          try {
            gitWithLockRetry(mainDir, ['reset', '--soft', 'HEAD~1']);
          } catch {
            // reset ALSO failed: the auto-heal commit is still on LOCAL master,
            // unpushed. The content is SAFE (it is committed) and will ride the next
            // push; do NOT stash (the tree is clean — there is nothing to park, and a
            // no-op stash would mislead). Surface loudly so it gets pushed.
            log(
              `pre-yield-guard: commitSafe committed the docs but could neither push nor undo (${e.message}); they are a LOCAL unpushed commit on master — push it manually (\`git -C <main> push origin master\`).`,
            );
            return {
              protected: true,
              dirty: true,
              mode: 'commit-unpushed',
              ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
            };
          }
        }
        log(
          `pre-yield-guard: commitSafe could not land the docs (${e.message}); stashing instead.`,
        );
      }
    }
    // Falls through to the shared corrupted-only / stash handling below — the bare
    // default stash IS commitSafe's fallback; it must never run its own duplicate stash.
  }

  // Plan 1634: re-read the CURRENT dirty set — a commitSafe attempt above may have
  // partially committed+pushed some paths (or rolled back after a failed push), so the
  // original `porcelain` snapshot could be stale. If the corrupted path(s) are the ONLY
  // thing left dirty, there is nothing left to commit/stash — a fully-excluded `git stash
  // push` errors ("no local changes to save"). Leave the corrupted file(s) exactly as-is
  // on disk and return without touching anything further.
  const stillDirty = dirtyPaths(
    partitionJobOutput(
      gitWithLockRetry(mainDir, ['status', '--porcelain'], { env: LOCK_FREE_READ_ENV }),
      jobOutputPrefixes,
    ).parkable,
  );
  if (corruptPaths.length && stillDirty.every((p) => corruptSet.has(p))) {
    log(
      `pre-yield-guard: only corrupted file(s) remain dirty (${corruptPaths.join(
        ', ',
      )}) — leaving as-is for a human/heal; nothing to stash.`,
    );
    return { protected: false, dirty: true, mode: 'corrupted-only', corrupted: corruptPaths };
  }

  // Plan 3206 Task 1 (the primary fix): before parking ANYTHING, prove there is something
  // REAL to park. This sits ABOVE the `commit` branch on purpose, so it is the ONE choke
  // point EVERY mutating path passes through — `--commit`, the bare default stash, and
  // commitSafe's fall-through into that stash (whose own comment above already says "the
  // bare default stash IS commitSafe's fallback"). Guarding only the stash would leave
  // `--commit` to `git add` a CRLF-only rewrite that normalizes to nothing and then die on
  // git's real exit-1 "nothing to commit, working tree clean" — gitWithLockRetry does not
  // treat that as retryable, so it would propagate out of withCoordLock and crash main()
  // with exit 2 (review finding, plan 3206 fix round). `stashCandidatePaths` is the SAME
  // corrupted-excluded set both branches below use, per the plan's execution notes: the
  // predicate runs on the already-filtered path set, after corrupted paths (plan 1634) are
  // excluded.
  // plan 4026 — the budget gate, checked TWICE around the last expensive read. The rounds
  // pinned both halves: round 1 wanted it late enough to cover the renormalising `git checkout`
  // below (finding e2aaf2), round 2 wanted the `hasRealDirt` scan's own cost counted before any
  // mutation (findings at :853/:869), and round 3 wanted the already-exhausted case to skip that
  // scan rather than pay for it (findings at :847). Cheap early-out first, authoritative check
  // after — `budgetShortfall` is pure arithmetic, so the second call costs nothing. Below the
  // second one, every remaining path mutates $MAIN: the checkout, `--commit`, commitSafe's
  // fall-through, and the stash. The coord lock is held throughout, so a yield leaves nothing
  // half-done.
  const earlyOverBudget = budgetShortfall({ budgetMs, startMs });
  if (earlyOverBudget !== null) return skipForBudget(earlyOverBudget);

  const stashCandidatePaths = stillDirty.filter((p) => !corruptSet.has(p));
  const realDirtPresent = hasRealDirt(mainDir, stashCandidatePaths);

  const overBudget = budgetShortfall({ budgetMs, startMs });
  if (overBudget !== null) return skipForBudget(overBudget);

  if (!realDirtPresent) {
    log(
      'pre-yield-guard: nothing survives normalization; not parking (renormalizing on disk instead).',
    );
    // Keep the normalization side effect the accidental stash-then-never-pop behavior used
    // to provide: `git checkout -- <paths>` re-materializes each path from the index with
    // the SAME clean/smudge filters a stash would apply, so a tracked CRLF-only rewrite
    // comes back as normalized LF bytes and the tree genuinely goes clean — the next
    // turn-end does not re-trip this same file. If this fails for any reason, leave the
    // file(s) exactly as-is: a clean skip with the dirt still flagged is acceptable, a
    // stash that stores nothing is not (plan 3206 execution notes).
    try {
      gitWithLockRetry(mainDir, ['checkout', '--', ...stashCandidatePaths]);
    } catch (e) {
      log(
        `pre-yield-guard: could not renormalize on disk (${e.message}); the file(s) remain flagged dirty by \`git status\` but hold no real change.`,
      );
    }
    // heal-main.mjs's healDirt() recognises this return by its `skipped` value, in an arm
    // that runs BEFORE its `res.mode` switch; `mode` is carried too so the shape matches
    // every other return here (and so the mode switch's catch-all — which resolves to
    // `blocked` whenever `protected` is false — could never silently claim this case if
    // that arm were ever removed). Do NOT drop healDirt's `skipped` arm on the strength of
    // `mode` alone: nothing switches on `mode: 'normalizes-clean'`, so removing the arm
    // reinstates the exit-1 "blocked on a tree we just cleaned" bug (re-review finding).
    // `corrupted` rides along per plan 1634 whenever a corrupted path was excluded — the
    // corrupted-only early return above fires only when EVERY still-dirty path is corrupted,
    // so a corrupted file can still be sitting dirty here beside the line-ending-only one,
    // and heal-main must be able to see it rather than report a false clean.
    return {
      protected: false,
      dirty: true,
      mode: 'normalizes-clean',
      skipped: 'normalizes-clean',
      ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
    };
  }

  if (commit) {
    const cleanPaths = stillDirty.filter((p) => !corruptSet.has(p));
    gitWithLockRetry(mainDir, ['add', '--', ...cleanPaths]);
    gitWithLockRetry(
      mainDir,
      ['commit', '-m', `wip: ${slug} pre-yield ${stamp(now)}`, '--', ...cleanPaths],
      { env: { ...process.env, HUSKY: '0' } },
    );
    log(
      `pre-yield-guard: committed loose $MAIN work as "wip: ${slug} pre-yield ${stamp(now)}"` +
        (corruptPaths.length ? ` (excluding corrupted: ${corruptPaths.join(', ')})` : '') +
        '.',
    );
    return {
      protected: true,
      dirty: true,
      mode: 'commit',
      label,
      ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
    };
  }
  // Named stash incl. untracked so sweep-stray-stashes can find + recover it, EXCEPT live
  // pipeline output and any corrupted path (plan 1634). The pipeline exclusion is always
  // present as a belt against git stash otherwise sweeping the whole working tree.
  const stashExcludes = [
    ...jobOutputStashExcludesFor(jobOutputPrefixes),
    ...corruptPaths.map((p) => `:(exclude)${p}`),
  ];
  gitWithLockRetry(mainDir, [
    'stash',
    'push',
    '--include-untracked',
    '-m',
    label,
    '--',
    '.',
    ...stashExcludes,
  ]);
  // Plan 3206 Task 2 (belt and braces): hasRealDirt above only knows what IT can see; if
  // some OTHER mechanism still produced an empty stash, catch it here before reporting
  // success. Runs inside the same withCoordLock window as the push above (see guard()).
  if (dropIfEmptyStash(mainDir, { label, log })) {
    // Same shape as the pre-check's own skip return above, `corrupted` included — see the
    // contract note there (plan 3206 fix round + re-review finding).
    return {
      protected: false,
      dirty: true,
      mode: 'normalizes-clean',
      skipped: 'normalizes-clean',
      ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
    };
  }
  log(
    `pre-yield-guard: parked loose $MAIN work in stash "${label}" (recover with \`git stash pop\`).`,
  );
  return {
    protected: true,
    dirty: true,
    mode: 'stash',
    label,
    ...(corruptPaths.length ? { corrupted: corruptPaths } : {}),
  };
}

export function main() {
  const argv = process.argv.slice(2);
  const slugIdx = argv.indexOf('--slug');
  const slug = slugIdx !== -1 ? argv[slugIdx + 1] : 'session';
  const ageIdx = argv.indexOf('--age-ms');
  const ageThresholdMs = ageIdx !== -1 ? Number(argv[ageIdx + 1]) || 0 : 0;
  const budgetIdx = argv.indexOf('--budget-ms');
  const budgetMs = budgetIdx !== -1 ? Number(argv[budgetIdx + 1]) || 0 : 0;
  const check = argv.includes('--check');
  const mainDir = resolveMain();
  const res = guard(mainDir, {
    slug,
    commit: argv.includes('--commit'),
    commitSafe: argv.includes('--commit-safe'),
    ageThresholdMs,
    budgetMs,
    check,
  });
  // Exit 3 on a --check that found dirt, so a wrapper can branch on it.
  process.exit(check && res.dirty && !res.protected && res.skipped !== 'job-output-only' ? 3 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error('pre-yield-guard:', e.message);
    process.exit(2);
  }
}
