// scripts/coord/land-lib.mjs (plan 355)
// Land a worktree branch onto origin/master from a THROWAWAY worktree checked
// out off origin/master. This NEVER mutates the shared main working tree and
// NEVER uses git's autostash — a clean detached checkout carries zero foreign
// uncommitted dirt, so the autostash-pop conflict that wedged sessions 284/285/286
// on 2026-06-04 is structurally impossible here. Only .git index.lock contention
// remains, and that is handled by the spine's gitWithLockRetry wrapper.
//
// Two exports:
//   landBranchViaEphemeral(MAIN, branch, summary, opts) → new master tip sha
//   assertLandable(MAIN)                                → { ok:true } | throws .reason
//
// plan 2466: `landBranchViaEphemeral` no longer checks anything out in the common case — it
// merges in the OBJECT DATABASE (`git merge-tree --write-tree` + `git commit-tree`, ~94ms) and
// only falls back to the throwaway-worktree path (`landBranchViaCheckout`, 65.8s on this fleet's
// 62k-file tree) on a conflict or anomaly, where the recovery diagnostics live. The name is kept
// because it is the whole spine's entry point; "ephemeral" now means "no persistent state"
// rather than "an ephemeral worktree".
import {
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  git,
  gitWithLockRetry,
  worktreeAdminRoot,
  parseStaleMsEnv,
  attemptRmSyncWithBackoff,
  errText,
  isNonFastForward,
  invalidateIndexLockPath,
  GIT_MAXBUFFER,
  GIT_NONINTERACTIVE_ENV,
  LOCK_RX,
  sleepSync,
} from './coord-git.mjs';
import { classifyAllowlist } from './main-checkout-allowlist.mjs';
import { parseStashList, STASH_LIST_ARGS } from './coord-git.mjs';
// plan 2058: THE canonical `git worktree list --porcelain` parser now lives in the
// zero-dependency worktree-porcelain.mjs (cloud-checkout-preflight.mjs imports it too,
// and must stay node-builtins-only) — imported (for listWorktreeEntries below) and
// re-exported here to keep this module's public `parseWorktreePorcelain` surface
// unchanged for existing callers.
import { parseWorktreePorcelain } from './worktree-porcelain.mjs';
export { parseWorktreePorcelain };
import { gitRepoIsolatedEnv } from './child-env.mjs';
// plan 1616: MAX_LAND_DIR_SLUG used to be an independently-declared local `40`, duplicating
// cut-worktree.mjs's MAX_DIR_SLUG — both now alias the one canonical constant.
import {
  truncateDirBasename,
  MAX_PATH_HEADROOM_DIR_SLUG as MAX_LAND_DIR_SLUG,
} from './dir-basename-truncate.mjs';

// plan 810: route every ephemeral-lander git child through coord-git's git() so it carries the
// GCM-dialog suppression (GIT_NONINTERACTIVE_ENV) — landBranchViaEphemeral's `fetch`/`push` are
// the exact site that crashed plan 774's land twice on the Windows GCM credential dialog.
// plan 2471: `run()` delegates to gitWithLockRetry (one shared seam, not N call sites) so every
// read/mutate call below — including the bare `fetch`s that used to crash `recoverRebasedUnpushed`
// on a concurrent ref-update race — retries the lock/transient-index/ref-CAS transient families
// instead of surfacing a raw stack trace mid-land. `tryRun` deliberately does NOT get this: its
// callers (e.g. the non-fast-forward push classification below) classify errors themselves, and a
// hidden retry would change their contract. Exported (not just the module-local const) so tests
// can inject a fake `_git` via the third `opts` arg without a real transient being provoked on demand.
export const run = (cwd, args, opts) => gitWithLockRetry(cwd, args, opts).trim();
const tryRun = (cwd, args) => git(cwd, args, { stdio: 'pipe' });

// plan 1528 A1: one patch-id for a tip's whole content-diff vs its fork point —
// `git diff merge-base(baseRef, tip)..tip | git patch-id --stable`, first field.
// Two tips with EQUAL range patch-ids carry a byte-equivalent content change vs
// baseRef (whitespace/line-number-insensitive), which is exactly the "pure rebase,
// nothing re-authored" proof the mechanical marker re-pin (record-review/record-wiki
// `repin`, done-worktree-lib.repinDecision) gates on. An EMPTY diff hashes to the
// stable literal 'empty' (patch-id emits nothing on empty input — two empty ranges
// must still compare equal). Returns null on ANY failure (unresolvable tip, no
// merge-base, git error) — callers treat null as "cannot prove identity → refuse".
// The ONE base every patch-id on this family is computed against, AND the ref the plan-3447
// fetch policy below refreshes — kept as remote/branch COMPONENTS so the fetch never has to
// re-parse the joined name (review findings eee0b0 / 62524c: a `split('/')` silently truncated
// a multi-segment ref, and a literal default here would drift from the constant the composed
// thunk uses the moment either changed). Scoped to `master` on purpose: a bare `git fetch
// origin` would drag down every one of the 5-7 parallel sessions' in-flight worktree branches
// and coordination refs on every record call.
export const PATCH_ID_FETCH_REMOTE = 'origin';
export const PATCH_ID_FETCH_BRANCH = 'master';
export const PATCH_ID_FETCH_REF = `${PATCH_ID_FETCH_REMOTE}/${PATCH_ID_FETCH_BRANCH}`;

export function rangePatchId(dir, tip, baseRef = PATCH_ID_FETCH_REF) {
  try {
    const base = run(dir, ['merge-base', baseRef, tip]);
    if (!base) return null;
    const diff = git(dir, ['diff', `${base}..${tip}`]);
    if (!diff.trim()) return 'empty';
    // through the hardened coord-git wrapper like every other git child in this file
    // (its opts spread carries `input` as the child's stdin — review 1528 [14]).
    const out = git(dir, ['patch-id', '--stable'], { input: diff }).trim();
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

// plan 2743: the ONE lazy-memoized wrapper over rangePatchId — `git diff | git patch-id` over a
// whole branch range is the most expensive call in the marker flows, and the rebase-stable marker
// identity needs it at several points per invocation (the repin pre-check AND its gate; a marker
// read across two session-doc candidates AND three family rows). Returns a THUNK so the cost is
// paid only if something actually asks, and at most once: the overwhelmingly common case — a
// marker whose sha already pins HEAD — never calls it at all.
//
// Lives here, beside rangePatchId, rather than being hand-rolled per consumer: it was written
// twice in the first cut of plan 2743 (record-marker-cli + done-worktree), which is exactly the
// two-copies-drift shape this repo keeps paying for. No try/catch — rangePatchId already returns
// null on ANY failure, so wrapping it would only hide a real programming error.
// Memoization is PER RETURNED THUNK — deliberately NOT a process-wide Map keyed on
// (dir, tip, baseRef). That shared-cache form was written and then REVERTED (operator ruling
// 2026-08-03, plan 2743 grill Q1): `rangePatchId` returns null on ANY failure, so with a shared
// cache ONE transient git-spawn failure on this repo's shared multi-session `.git` is stored and
// re-read as "this tip has no computable patch-id" — i.e. every marker stale — for the whole
// process, where independent thunks each retry on their own. (Keying on a ref NAME rather than a
// resolved commit was the second, weaker objection.) Shared mutable state on the land spine is
// not worth a perf win on a path that only runs when a marker is already stale.
//
// The cost of that choice is stated and accepted, not overlooked: done-worktree builds more than
// one thunk for the same (worktree, HEAD) in a single land — the review-marker read, the
// wiki/conclusion reads, the marker status table, the findings gate — so a STALE marker can pay
// `git diff | git patch-id` more than once. The common case pays nothing at all (a marker whose
// sha pins HEAD never invokes the thunk), and the alternative fix — threading ONE thunk through
// six signatures for a pure perf property — is the worse trade. If it is ever judged to matter,
// thread the thunk explicitly; do NOT re-introduce a process-wide cache here.
export function rangePatchIdOnce(dir, tip, baseRef = PATCH_ID_FETCH_REF) {
  let value;
  let computed = false;
  return () => {
    if (!computed) {
      value = rangePatchId(dir, tip, baseRef);
      computed = true;
    }
    return value;
  };
}

// plan 3447: ONE shared fetch-before-patch-id policy, called by both the record path
// (record-review.mjs, immediately before its rangePatchIdOnce call) and the repin path
// (record-marker-cli.mjs's `repin` command). rangePatchIdOnce/rangePatchId above default
// baseRef to 'origin/master' — the LOCAL tracking ref — and nothing on the record path ever
// refreshed it before this: a marker's cached patch-id could be computed against a stale
// base, so its identity means something different than what the land gate reads it to mean.
// Semantics deliberately MIRROR gpt-review.mjs's fetchOriginForLandedGuard (that module's own
// do-not-touch surface — this is a mirror, not a shared import, since gpt-review.mjs already
// imports FROM both land-lib.mjs and record-marker-cli.mjs, so an import the other direction
// would cycle): `git fetch --no-tags origin master`, non-interactive env, a 30s timeout, and
// NON-FATAL on any failure — an unreachable remote must degrade to "proceed on the best
// available local ref", never crash a record/repin call that was otherwise fine to run.
export const PATCH_ID_FETCH_TIMEOUT_MS = 30_000;

export function fetchOriginBeforePatchId(
  dir,
  {
    noFetch = false,
    runGit = (args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: GIT_MAXBUFFER,
        timeout: PATCH_ID_FETCH_TIMEOUT_MS,
        // See GIT_NONINTERACTIVE_ENV's own definition: GIT_TERMINAL_PROMPT alone still lets
        // GCM re-prompt on Windows — GCM_INTERACTIVE is the half a hand-rolled copy forgets.
        // plan 4135: gitRepoIsolatedEnv() also drops the ambient repo-selector vars so this
        // fetch (against `dir`, a real network call) can't be silently redirected onto a
        // different repo; GIT_NONINTERACTIVE_ENV rides through as a settings layer applied
        // AFTER that strip, same as every other caller of this seam.
        env: gitRepoIsolatedEnv(GIT_NONINTERACTIVE_ENV),
      }),
  } = {},
) {
  if (noFetch) return { ok: true, skipped: true };
  try {
    // --no-tags: tags are never consulted by patch-id computation and are pure transfer cost.
    // The remote/branch COMPONENTS, never a re-parse of the joined ref: the ref this refreshes
    // is the ref rangePatchIdOnceWithFetch compares against by construction, not by habit.
    runGit(['fetch', '--no-tags', PATCH_ID_FETCH_REMOTE, PATCH_ID_FETCH_BRANCH]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The policy above COMPOSED with rangePatchIdOnce, for the callers whose patch-id is a lazy
// memoized thunk — which is every RECORD path (record-review.mjs, and record-marker-cli.mjs's
// shared runRecordMain behind record-wiki/record-conclusion).
//
// Why compose rather than let each caller fetch inline above its rangePatchIdOnce (plan 3447 fix
// round 1, review findings 98ab0c / d52c68): those thunks are lazy ON PURPOSE — `git diff |
// git patch-id` over a whole branch is the most expensive call in that module, and every refusal
// that precedes the write (a malformed --findings file above all) must still cost nothing. An
// eager fetch above the thunk silently converts "refuses cheaply" into "refuses after a network
// round-trip", so the fetch has to be as lazy as the computation it protects. Fetching INSIDE
// the thunk also means a caller that never needs the patch-id never touches the network at all.
//
// The fetch runs at most once per thunk even though rangePatchIdOnce memoizes independently:
// coordWrite re-runs mutateIn on a freshen-and-retry, and re-fetching there would pay the
// round-trip again for a value already computed. NON-FATAL throughout — a failed fetch degrades
// to the local ref exactly as the bare policy does, never crashing an otherwise-valid record.
//
// NOTE the repin path deliberately does NOT use this: its fetch must be EAGER, because the
// pre-gate below it reads origin/master directly rather than through a patch-id.
// Deliberately NO baseRef option (review finding 5e31ef / 176415): the policy above refreshes
// `origin/master` and nothing else, so a wrapper that let a caller compute against, say,
// origin/release would fetch the wrong ref and hand back a patch-id against a stale base — the
// exact failure this whole plan exists to remove, reintroduced through a configuration knob no
// caller wants. The refreshed ref and the compared-against ref are ONE decision here; a future
// caller that genuinely needs another base must teach the fetch about it in the same change.
export function rangePatchIdOnceWithFetch(dir, tip, { noFetch = false, runGit } = {}) {
  const patchIdOnce = rangePatchIdOnce(dir, tip, PATCH_ID_FETCH_REF);
  let fetched = false;
  return () => {
    if (!fetched) {
      fetched = true;
      fetchOriginBeforePatchId(dir, { noFetch, runGit });
    }
    return patchIdOnce();
  };
}

// git porcelain unmerged-path codes (one spelling, shared by the sync + the health-guard)
const UNMERGED_RE = /^(DD|AU|UD|UA|DU|AA|UU)/m;

// ── plan 3974 T2a: bounded retry for a rebase/merge that lost the shared worktree's
// index.lock to a sibling poller (or a `git status` inside the SAME session's own statusline/
// hook), instead of surfacing LAND_BLOCKED for a purely transient race. Deliberately its OWN
// schedule, not gitWithLockRetry's flat 500ms/10-attempt one or done-worktree's exponential
// LOCK_RETRY_DELAYS_MS (that constant lives in done-worktree-lib.mjs, which imports THIS module —
// importing it back here would cycle): a rebase retry either re-runs the WHOLE multi-pick replay
// from scratch or resumes a single already-open pick via `--continue`, both cheap, so ≤5 tries
// with a short ramp is plenty for a lock that clears on its own within seconds, while still
// bounded so a genuinely wedged sibling cannot spin this forever.
const REBASE_LOCK_RETRY_DELAYS_MS = [300, 600, 1200, 2400, 4800];
// ±20% jitter so several sessions retrying the same contended lock don't all wake on the same
// tick and re-collide immediately.
function jitteredDelayMs(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

// Which rebase state directory (`rebase-merge` or `rebase-apply`) does this worktree currently
// carry under its OWN git-path? Returns the absolute directory path, or null when neither exists.
// This is the ONE probe for "mid-rebase" on both spines: done-worktree.mjs's `worktreeMutationKind`
// 'rebase' arm consumes it (gpt-review dc0877/0efdd2 asked for a single definition, and this module
// is the right home — done-worktree-lib.mjs already imports land-lib, so the shared probe has to
// live on this side of that edge). `rebase-apply` is also where `git am` keeps its state; a caller
// that needs to tell the two apart looks for `<dir>/applying` (git am) itself.
//
// plan 3974 T2b (gpt-review 955de4): deliberately `tryRun`, NOT `run`/`gitWithLockRetry` — this
// is a bare `rev-parse --git-path`, which never touches the index and so never needs the retry
// wrapper's lock-contention handling; routing it through `run` would still pay `gitWithLockRetry`'s
// own `waitForIndexLock` pre-poll on EVERY call (twice per invocation, once per state dir) while a
// sibling holds the lock, burning retry-budget time this probe has no reason to spend. Best-effort:
// a probe failure reads as "no rebase state".
export function rebaseStateDir(wtPath) {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    try {
      const p = tryRun(wtPath, ['rev-parse', '--path-format=absolute', '--git-path', d]).trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* best-effort probe */
    }
  }
  return null;
}

// Positive proof that NO rebase state exists: every `rev-parse --git-path` probe succeeded and
// neither directory is present. Differs from `rebaseStateDir(...) === null`, which is also what a
// FAILED probe returns — a caller that deletes something on "no rebase state" (done-worktree's
// stale-marker sweep, round 3 c8c57e) must use this, never the fail-open null.
export function rebaseStateKnownAbsent(wtPath) {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    let p;
    try {
      p = tryRun(wtPath, ['rev-parse', '--path-format=absolute', '--git-path', d]).trim();
    } catch {
      return false;
    }
    if (!p || existsSync(p)) return false;
  }
  return true;
}

// Positive proof that NO mutation of any kind is in progress: rebase state known absent (above)
// AND the MERGE_HEAD git-path resolved and is not present. `mergeHeadExists` cannot serve here —
// `rev-parse --verify MERGE_HEAD` fails identically for "absent" and "git could not answer" — so
// this goes through `--git-path`, whose failure is distinguishable. A caller that will MUTATE the
// worktree on "nothing is in progress" (done-worktree's pre-queue freshen, gpt-review round 4
// 98caaf / 25c270 / 246be0 / 2974e2 / ba4258) uses this, never the fail-open `worktreeMutationKind`.
export function mutationKnownAbsent(wtPath) {
  if (!rebaseStateKnownAbsent(wtPath)) return false;
  let p;
  try {
    p = tryRun(wtPath, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']).trim();
  } catch {
    return false;
  }
  return !!p && !existsSync(p);
}

// Boolean form of rebaseStateDir for the retry loop below: a rescheduled-pick retry `--continue`s
// only when real rebase state survived on disk, and restarts from scratch otherwise (a probe
// failure therefore just means the slower, still-correct restart path).
export function rebaseStateExists(wtPath) {
  return rebaseStateDir(wtPath) !== null;
}

// The merge-bearing sibling of rebaseStateExists above: does this worktree currently have an
// in-flight (uncommitted) `git merge` — a MERGE_HEAD that resolves? plan 3974 T2b (gpt-review
// 71a161): a merge-bearing branch's lock-shaped retry needs this to decide whether a previous
// `git merge --no-ff` attempt left MERGE_HEAD behind before it can safely restart (see the
// retry loop below). Same `tryRun` reasoning as rebaseStateExists — a bare ref-resolve, no
// index involved, no reason to pay the lock-retry wrapper's wait.
export function mergeHeadExists(wtPath) {
  try {
    tryRun(wtPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return true;
  } catch {
    return false;
  }
}

// plan 3974 (gpt-review round 2: 69df5c / bb3c7a / a0f071 / a400a4 / 9d27ba / 382952 / ffe707 —
// "pick-only todo state does not prove the rebase belongs to the land spine"): the spine's OWN
// rebase is marked by an invocation-owned sidecar in the worktree's private git-dir, written
// right before `git rebase <onto>` and removed on EVERY exit of syncBranchOntoMaster (success,
// conflict halt, syncFailed). Only a spine process KILLED mid-rebase leaves it behind — and that
// is the one shape done-worktree's preflight may resume: marker present, its `onto` equal to the
// leftover `rebase-merge/onto`, clean tree. A human's interrupted rebase (plain or -i), a
// sibling process's rebase (coord-git's pushMasterWithRebase runs on MAIN, never here), or a
// conflict the author is mid-way through resolving has NO marker and halts exactly as plan
// 3422 D4 always did. The marker is provenance, not state: git's own rebase-merge dir stays the
// single source of truth for where the rebase is.
export const SPINE_REBASE_MARKER_FILE = 'land-spine-rebase.json';

// Absolute path of the marker inside THIS worktree's git-dir (null when git cannot say). The
// git-dir is resolved once per worktree per process (round 3, f09b21): it cannot move underneath
// a running land, and the write/clear pair around every rebase would otherwise pay two extra
// `rev-parse` spawns each.
const gitDirByWorktree = new Map();
export function spineRebaseMarkerPath(wtPath) {
  if (!gitDirByWorktree.has(wtPath)) {
    try {
      const dir = tryRun(wtPath, ['rev-parse', '--path-format=absolute', '--git-dir']).trim();
      if (!dir) return null;
      gitDirByWorktree.set(wtPath, dir);
    } catch {
      return null;
    }
  }
  return join(gitDirByWorktree.get(wtPath), SPINE_REBASE_MARKER_FILE);
}

// Parsed marker, or null when absent/unreadable/malformed (all read as "not ours").
export function readSpineRebaseMarker(wtPath) {
  const p = spineRebaseMarkerPath(wtPath);
  if (!p || !existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const str = (v) => typeof v === 'string' && v.length > 0;
    return m && str(m.onto) && str(m.origHead) && str(m.branch) ? m : null;
  } catch {
    return null;
  }
}

function writeSpineRebaseMarker(wtPath, marker) {
  const p = spineRebaseMarkerPath(wtPath);
  if (!p) return;
  try {
    writeFileSync(
      p,
      JSON.stringify({ ...marker, pid: process.pid, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* best-effort: no marker just means a killed run's leftover halts instead of resuming */
  }
}

export function clearSpineRebaseMarker(wtPath) {
  const p = spineRebaseMarkerPath(wtPath);
  if (!p) return;
  try {
    unlinkSync(p);
  } catch {
    /* absent already */
  }
}

// plan 1240 Group B: an ahead-of-origin commit is "queue-exempt" when it touches ONLY paths that
// may legitimately sit as a DIRECT edit on the shared master checkout (doc + config), so such a
// commit rides to origin OUTSIDE the landing queue and must NEVER gate a land (operator decision
// 2026-07-01); anything else — a seed or code path (allowlist class 'other') — is the real
// "unpushed remnant" assertLandable must still block on.
//
// The queue-exempt SET is the CANONICAL `classifyAllowlist` from main-checkout-allowlist.mjs (plan
// 977) — the ONE authority for "which paths may exist as direct edits on master" — reused here as
// the single source of truth (reviews [3]/[5] + delta [1]). 'doc' (plans/specs/handoff/INDEX/wiki/
// runbooks — the last added by plan 2692) AND 'config' (`.claude/settings.json`,
// `.claude/settings.local.json`) are both sanctioned direct-master surfaces, so
// both are exempt; only 'other' (app code, seed, CLAUDE.md, arbitrary docs like docs/research/**)
// blocks. NOTE: `.claude/settings.json` IS exempt here (a
// COMMITTED config change is done and rides to origin) — this is deliberately DIFFERENT from
// coord-git's `isCoordDocPath`, which excludes it: that predicate governs UNCOMMITTED foreign dirt
// (a half-edit mid-land must hard-stop), a different question from a committed ahead commit.
//
// Classify ONE ahead commit's touched paths. A commit is exempt ONLY when it touches at least one
// path and EVERY path is a sanctioned direct-master surface. An EMPTY path set is NOT exempt
// (review [0]): an empty / no-op ahead commit (e.g. `git commit --allow-empty`, a no-op `--no-ff`
// merge) is an unexplained divergence on the shared local master — exactly the half-reconciled-
// master hazard the guard exists to catch — and its payload is invisible to a path-diff, so it must
// BLOCK, not slip through the exempt door. Returns { exempt, empty, nonExempt }.
export function classifyAheadCommit(paths) {
  const uniq = [...new Set((paths || []).map((p) => (p || '').trim()).filter(Boolean))];
  if (uniq.length === 0) return { exempt: false, empty: true, nonExempt: [] };
  const nonExempt = uniq.filter((p) => classifyAllowlist(p) === 'other');
  return { exempt: nonExempt.length === 0, empty: false, nonExempt };
}

// plan 1573: Windows MAX_PATH (260) headroom for the ephemeral land checkout, mirroring the
// plan-909 cut-worktree convention — the DIRECTORY basename is capped, the BRANCH stays full
// length (landBranchViaEphemeral's git operations always address `branch`, never the dir name).
// A long slug's `_land-worktree-<slug>` dir plus a deep committed path (e.g.
// backend/data/job-pipeline/render-store/record-NNN/chrome-devtools-mcp/<64-char sha256>/…)
// exceeded MAX_PATH on an untruncated dir (session 1436 incident, 2026-07-07); capping the
// basename to MAX_LAND_DIR_SLUG chars restores the same ~30-char headroom cut-worktree relies on.
// (plan 1616: the `40` value itself now lives in dir-basename-truncate.mjs's
// MAX_PATH_HEADROOM_DIR_SLUG, imported above — this is no longer an independent declaration.)

// Derive the ephemeral land checkout's directory BASENAME (not a full path), capped at
// MAX_LAND_DIR_SLUG chars, trimming a trailing hyphen left by a mid-word clip (mirrors
// cut-worktree's worktreePathFor, plan 1286). Plan ids are unique and always lead the slug, so
// two DIFFERENT branches truncating to the identical basename is vanishingly rare — but the
// caller passes `collided: true` when a live (non-stale) dir already occupies the plain
// truncation, and a short deterministic hash of the FULL branch name is appended instead
// (still re-clipped to the same MAX_LAND_DIR_SLUG budget), so a genuine collision can never
// silently clobber a sibling's in-flight ephemeral checkout.
export function landDirBaseFor(branch, collided = false) {
  // plan 1597: the cap-and-trim itself lives in the shared truncateDirBasename() helper
  // (mirrors cut-worktree's worktreePathFor).
  if (!collided) return truncateDirBasename(`_land-${branch}`, { maxLen: MAX_LAND_DIR_SLUG });
  const suffix = `-${createHash('sha1').update(branch).digest('hex').slice(0, 8)}`;
  return truncateDirBasename(`_land-${branch}`, { maxLen: MAX_LAND_DIR_SLUG, suffix });
}

// plan 1663: how long a `_land-*` registration's admin metadata must sit idle before it is
// judged DEAD debris of a killed land rather than a live sibling's in-flight ephemeral
// checkout. State alone cannot discriminate: a sibling mid-`worktree add` and a killed add
// both present as a branchless (detached) registration locked "initializing", and after the
// add both are branchless-detached — only ACTIVITY distinguishes them. Every git op inside a
// linked worktree rewrites its admin-dir `index` (`.git/worktrees/<name>/index`), so the max
// file mtime under the admin dir is a genuine liveness signal: a live land's fetch→reset→
// merge loop keeps touching it, dead debris never does.
//
// KNOWN RESIDUAL (review 1663 [0], accepted): mtime idleness cannot distinguish dead debris
// from a live sibling stalled ≥ threshold on ONE git op that never progresses (a hung fetch,
// a pathological merge) — such a sibling would be reaped. Accepted because the exposure needs
// a conjunction of rarities: a DIFFERENT branch truncating to the identical 40-char basename
// (plan ids lead every slug — see landDirBaseFor) AND that sibling stalled with ZERO admin-dir
// writes for the whole window (same-branch concurrent lands cannot happen: the landing queue
// FIFO-serializes them). Pre-1663 code force-removed such a sibling UNCONDITIONALLY, so the
// gate is a strict improvement, and the 20 min default doubles the plan's original margin.
// A false "fresh" merely sends the land to the hash-suffixed fallback path (it still lands);
// hence the deliberate bias toward "fresh".
//
// Honour an explicit value INCLUDING 0 (tests force unconditional staleness); the guard
// against blank/NaN/whitespace-coerced/negative values (review 1663 [3]) is coord-git's
// shared parseStaleMsEnv — one parse for this constant and WORKTREE_LOCK_STALE_MS, so a
// hardening fix can never land in one copy and not the other (review delta [1]).
export const LAND_REGISTRATION_STALE_MS = parseStaleMsEnv(
  process.env.LAND_REGISTRATION_STALE_MS,
  1_200_000,
);

const normPath = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// All registration entries for MAIN's repo, or null when the porcelain probe itself failed
// (callers must not conflate "probe failed" with "no registrations").
function listWorktreeEntries(MAIN) {
  try {
    return parseWorktreePorcelain(run(MAIN, ['worktree', 'list', '--porcelain']));
  } catch {
    return null;
  }
}

// plan 1663: the FULL registration entry for the worktree at `dir` (path-normalised,
// Windows-safe), or null when `dir` is not a currently-registered worktree (or the porcelain
// probe itself failed). Distinguishes what worktreeBranchAt conflates: a branchless (detached /
// mid-`add`) REGISTERED entry returns { branch: null, ... }, not null — the distinction
// reclaimLandDirIfSafe needs, because a missing-but-registered entry is NOT clean (git refuses
// `worktree add` over it: "missing but locked worktree", the plan-1663 incident) while a
// truly-unregistered path is.
export function worktreeEntryAt(MAIN, dir) {
  const entries = listWorktreeEntries(MAIN);
  if (!entries) return null;
  const target = normPath(dir);
  return entries.find((e) => normPath(e.path) === target) ?? null;
}

// True branch name registered as the worktree at `dir` (path-normalised, Windows-safe), or:
//   null           — `dir` is not a currently-registered worktree at all (an orphaned directory,
//                     or nothing there), OR it is registered but branchless (detached)
// Exported for direct unit testing (land-lib.test.mjs) — a real-git seam, not test-only surface.
export function worktreeBranchAt(MAIN, dir) {
  return worktreeEntryAt(MAIN, dir)?.branch ?? null;
}

// plan 1663: resolve the git ADMIN directory (`<git-common-dir>/worktrees/<name>`) backing the
// registration for the worktree at `dir`, or null. Matched by each candidate's `gitdir` file
// content (which points at `<dir>/.git`), NOT by basename — git uniquifies admin-dir names on
// collision, so the name is not derivable from the path. The admin ROOT resolution is the shared
// coord-git `worktreeAdminRoot` (review [6]: no third inline copy of that walk); a caller looping
// over many dirs pre-resolves it ONCE and passes `wtRoot` (review [4]). Exported for tests (they
// backdate the admin dir's mtimes to simulate dead debris).
export function registrationAdminDirFor(MAIN, dir, { wtRoot } = {}) {
  if (!wtRoot) {
    try {
      wtRoot = worktreeAdminRoot(MAIN);
    } catch {
      return null;
    }
  }
  const targetGit = normPath(join(dir, '.git'));
  let names;
  try {
    names = readdirSync(wtRoot);
  } catch {
    return null; // no linked worktrees at all
  }
  for (const name of names) {
    const admin = join(wtRoot, name);
    let content;
    try {
      content = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
    } catch {
      continue;
    }
    if (normPath(content) === targetGit) return admin;
  }
  return null;
}

// plan 1663: milliseconds since the registration's admin metadata was last touched (max file
// mtime directly under the admin dir — `index`, `HEAD`, `gitdir`, `locked`, …), or null when
// the admin dir cannot be resolved/read or holds no files. Callers treat null as "cannot prove
// dead → refuse". A found-file flag (not `newest` truthiness) decides null, so a legitimate
// epoch-0 mtime reads as ~56 years idle (stale), never as "unprovable" (review [1]).
export function registrationIdleMs(MAIN, dir, { wtRoot } = {}) {
  const admin = registrationAdminDirFor(MAIN, dir, { wtRoot });
  if (!admin) return null;
  let entries;
  try {
    entries = readdirSync(admin, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest = null;
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = statSync(join(admin, e.name));
      if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      /* raced away — skip */
    }
  }
  return newest === null ? null : Date.now() - newest;
}

// plan 1663 (review [7]): the one unlock-a-dead-registration step, shared by the per-path
// reclaim and the sweep. `worktree remove --force` refuses a locked entry and `worktree prune`
// skips locked entries by design, so a dead locked registration MUST be unlocked before either
// can clear it. Failure is tolerated (the caller's clear-then-VERIFY decides the outcome).
function tryUnlockRegistration(MAIN, dir) {
  try {
    run(MAIN, ['worktree', 'unlock', dir]);
  } catch {
    /* tolerate — the caller's remove/prune + verify decide the outcome */
  }
}

// Reclaim `dir` for `branch`'s ephemeral land checkout IF AND ONLY IF it is safe: either nothing
// is there (path clear AND no registration), it's an orphaned (unregistered) leftover directory,
// it's a registered worktree for THIS SAME branch (a stale remnant of a crashed prior land attempt
// of the identical branch), or it's a branchless (detached/initializing) registration whose admin
// metadata is provably idle (dead debris of an externally-killed land, plan 1663).
// Returns true if `dir` AND its registration are now clear/usable. Returns false WITHOUT touching
// anything when:
//   - `dir` is registered for a DIFFERENT branch — a live sibling land that happens to truncate
//     to the same basename (plan 1573; never weakened), or
//   - `dir` carries a branchless registration whose metadata is FRESH (< staleMs idle) — a
//     concurrent sibling mid-`worktree add` (locked "initializing") or mid-merge (detached) looks
//     IDENTICAL to dead debris by state; only idleness proves death. The caller falls back to the
//     hash-suffixed path, so refusing costs nothing but a rename.
// plan 1663 closes two holes here: (1) a MISSING directory no longer short-circuits `return true`
// — git refuses `worktree add` over a missing-but-registered entry ("missing but locked worktree",
// the 2026-07-09 incident that crash-looped every land of plan 1631's branch), so the registration
// must be consulted regardless of the directory; (2) a LOCKED registration judged dead is now
// UNLOCKED first — `worktree remove --force` refuses a locked entry and `worktree prune` skips
// locked entries by design, so without the unlock step the old sequence left the debris untouched.
// plan 1640: bounded attempts for the rmSync retry below, matching resolveCoordCheckout's
// (coord-git.mjs) retry budget for the same Windows file-lock error class.
const RM_RETRY_ATTEMPTS = 6;

export function reclaimLandDirIfSafe(
  MAIN,
  dir,
  branch,
  { staleMs = LAND_REGISTRATION_STALE_MS, _rmSync } = {},
) {
  // plan 2481: evict any memoized indexLockPath(dir) unconditionally at entry — evicting a dir
  // owned by a live sibling process is harmless (the cache is process-local), and this is the
  // one call site every remove-then-reclaim path (per-path reclaim, the sweep, teardown-then-
  // relaunch) funnels through before `dir` might get a new admin dir under the same path.
  invalidateIndexLockPath(dir);
  const entry = worktreeEntryAt(MAIN, dir);
  if (!existsSync(dir) && !entry) return true; // truly clean: no directory, no registration
  if (entry) {
    if (entry.branch !== null && entry.branch !== branch) return false; // live sibling — do not touch
    if (entry.branch === null) {
      // Branchless registration: ephemeral land checkouts are created `--detach`, and a killed
      // `worktree add` is locked "initializing" — BOTH shapes are also what a LIVE sibling looks
      // like mid-flight. Discriminate by admin-metadata idleness; unprovable (null) refuses.
      const idle = registrationIdleMs(MAIN, dir);
      if (idle === null || idle < staleMs) return false; // possibly live — caller falls back
    }
    if (entry.locked) tryUnlockRegistration(MAIN, dir);
  }
  try {
    run(MAIN, ['worktree', 'remove', '--force', dir]);
  } catch {
    /* fall through to prune / rmSync below */
  }
  try {
    run(MAIN, ['worktree', 'prune']);
  } catch {
    /* best-effort */
  }
  if (existsSync(dir)) {
    // plan 1621 (coord-git.mjs's resolveCoordCheckout) hit the identical rmSync EBUSY/EPERM/
    // ENOTEMPTY class here — a killed process leaving an open handle under
    // `.git/worktrees/<name>/` (docs/coord/worktrees.md). Generalized by plan 1640:
    // retry with backoff via the shared helper instead of giving up on the first throw. A
    // still-locked dir after exhausting the budget, or any non-transient rmSync error, falls
    // through unchanged to the existing best-effort contract below — caller re-checks and
    // falls back to the hash-suffixed path if still present.
    try {
      for (let i = 0; i < RM_RETRY_ATTEMPTS; i++) {
        const rmErr = attemptRmSyncWithBackoff(dir, { recursive: true, force: true }, i, {
          _rmSync,
        });
        if (!rmErr) break; // success
      }
    } catch {
      /* non-transient rmSync error — leave it, caller re-checks and falls back if still present */
    }
  }
  return !existsSync(dir) && worktreeEntryAt(MAIN, dir) === null;
}

// plan 1663: sweep EVERY dead `_land-*` registration, not just the one truncation path the
// current land is about to use — a crashed land's debris must not wait for the SAME branch to
// land again to get cleaned (a DIFFERENT branch truncating to the same basename would collide
// with it too). A candidate is dead only when ALL of: its path basename is in the `_land-`
// namespace (never plan worktrees or the main checkout), it carries NO branch (ephemeral
// checkouts are detached; a branch-carrying entry is not ours to judge), its DIRECTORY is
// missing (a present directory is the per-path reclaim's job, with the same liveness gate),
// and its admin metadata is idle ≥ staleMs. Unlocks each dead candidate (prune skips locked
// entries), then one `worktree prune` clears them all, then RE-LISTS and reports only the
// candidates verifiably gone — a failed unlock/prune surfaces as a loud survivor line, never
// as a claimed success (review [2]). Returns the VERIFIED-cleared entries; never throws.
export function sweepDeadLandRegistrations(MAIN, { staleMs = LAND_REGISTRATION_STALE_MS } = {}) {
  const entries = listWorktreeEntries(MAIN);
  if (!entries) return [];
  // Pure in-memory pre-filter FIRST — the common healthy land (no `_land-*` debris at all)
  // must not pay any subprocess beyond the porcelain list itself (review delta [2]).
  const prospects = entries.filter((entry) => {
    const base = entry.path.replace(/\\/g, '/').split('/').pop() || '';
    return (
      base.startsWith('_land-') && // only the ephemeral land namespace
      entry.branch === null && // branch-carrying — not ours to judge
      !existsSync(entry.path) // directory present — per-path reclaim territory
    );
  });
  if (!prospects.length) return [];
  let wtRoot = null;
  try {
    // once per sweep, not per candidate (review [4]); on failure fall back to null so
    // registrationIdleMs resolves per-candidate — one transient hiccup must not abort the
    // whole sweep and strand every provably-dead candidate for a cycle (review delta [0]).
    wtRoot = worktreeAdminRoot(MAIN);
  } catch {
    wtRoot = null;
  }
  const candidates = [];
  for (const entry of prospects) {
    const idle = registrationIdleMs(MAIN, entry.path, { wtRoot });
    if (idle === null || idle < staleMs) continue; // fresh/unprovable — possibly a sibling mid-add
    if (entry.locked) tryUnlockRegistration(MAIN, entry.path);
    candidates.push({ path: entry.path, idleMs: idle });
  }
  if (!candidates.length) return [];
  try {
    run(MAIN, ['worktree', 'prune']);
  } catch {
    /* best-effort — the verify below decides what actually cleared */
  }
  const after = listWorktreeEntries(MAIN);
  // an unreadable post-prune list proves nothing cleared — report nothing as swept
  const remaining = new Set((after ?? entries).map((e) => normPath(e.path)));
  const cleared = candidates.filter((c) => !remaining.has(normPath(c.path)));
  const survivors = candidates.filter((c) => remaining.has(normPath(c.path)));
  if (cleared.length) {
    console.error(
      `[land-lib] swept ${cleared.length} dead _land-* worktree registration(s) left by killed land(s): ` +
        cleared.map((s) => `${s.path} (idle ${Math.round(s.idleMs / 1000)}s)`).join(', '),
    );
  }
  if (survivors.length) {
    console.error(
      `[land-lib] WARNING: ${survivors.length} dead _land-* registration(s) SURVIVED unlock+prune ` +
        `(clear them by hand: git worktree unlock <path> && git worktree prune): ` +
        survivors.map((s) => s.path).join(', '),
    );
  }
  return cleared;
}

// plan 2479 finding 1: since plan 2471, `run()` delegates to gitWithLockRetry, so the
// `worktree add --detach` call just below CAN be retried after a transient lock/ref race fires
// mid-completion (the worktree registers on disk, then the classifier still matches and
// gitWithLockRetry retries the identical command). The retried `worktree add` then dies "fatal:
// '<tmp>' already exists" — a message none of gitWithLockRetry's classifiers recognize, so it
// surfaces raw looking like a genuine path collision instead of the transient that actually
// caused it.
//
// review fix (sonnet-review high, 2x CONFIRMED): an earlier version of this fix tolerated the
// collision as SUCCESS whenever the registered `tmp` pointed at origin/master's sha — but EVERY
// ephemeral land worktree is created `--detach` at origin/master, so that check cannot
// distinguish "my own retried attempt already succeeded" from "a different sibling branch that
// truncated to the identical `_land-<slug>` basename (the plan-1573 collision landDirBaseFor's
// own comments call a KNOWN RESIDUAL) won the race to create tmp first" — silently treating a
// live sibling's worktree as our own would corrupt/hijack that sibling's in-flight land. It also
// re-read `origin/master` LIVE inside the catch, so it could reject a legitimately-succeeded
// retry under ordinary concurrent-fetch drift on this shared `.git`.
//
// Neither failure mode is possible with this design: on ANY "already exists" collision at `tmp`,
// unconditionally switch to the hash-suffixed fallback path (`landDirBaseFor(branch, true)`) —
// the SAME fallback this function already uses a few lines up when `reclaimLandDirIfSafe` refuses
// the primary path for a live sibling. No ownership judgment call is needed: a worktree add that
// succeeds at the freshly-computed fallback path is unconditionally safe regardless of whether
// the primary collision was our own retry debris or a genuine sibling. Returns the fallback path
// (with `reclaimLandDirIfSafe` already applied, in case that path is itself stale debris from an
// earlier collision-fallback land of this SAME branch) when `err` is an "already exists"
// collision, or `null` when `err` is a different failure the caller must rethrow unchanged.
// Exported for direct unit testing (land-lib.test.mjs) — the real retry race that triggers this
// at the call site cannot be provoked on demand.
export function worktreeAddCollisionFallback(MAIN, branch, err) {
  if (!/already exists/i.test(errText(err))) return null;
  const fallback = join(MAIN, '.claude', 'worktrees', landDirBaseFor(branch, true));
  reclaimLandDirIfSafe(MAIN, fallback, branch);
  return fallback;
}

// THE single owner of the plan-2411 push-exhaustion contract (extracted by plan 2466).
//
// Both land paths — the object-db fast path and the checkout fallback — push and must react to a
// failed push identically. review fix (/sonnet-review xhigh, CONFIRMED): plan 2466 first shipped
// this as two verbatim copies, and the duplication had ALREADY drifted inside its own diff (one
// loop re-fetched per iteration, the other did not). This is precisely the code plan 2411 had to
// patch after a real incident — a raw throw on the last attempt escaped to done-worktree's crash
// path and RELEASED the landing-queue slot — so a second literal copy is a standing invitation to
// fix the incident once and leave the other copy broken.
//
// Returns 'retry' when the caller should loop again; otherwise THROWS:
//   - the typed `ephemeral-push-nonff-exhausted` when every attempt lost the same race (the branch
//     is NOT on origin/master, so the queue slot is HELD and a resume is safe), or
//   - the raw error for a non-race failure (auth, network, hook-shaped) — not a race, and retrying
//     would just burn attempts on a failure mode retrying cannot fix.
export function isRetryablePushFailure(e) {
  const error = typeof e === 'string' ? { message: e } : e;
  return isNonFastForward(error) || /failed to push/i.test(errText(error));
}

export function classifyPushFailure(e, { i, branch, attempts = 6 }) {
  const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
  const isNonFfRace = isRetryablePushFailure(e);
  if (isNonFfRace && i < attempts - 1) {
    console.error(
      `[land-lib] non-ff race on ephemeral push of ${branch}, attempt ${i + 1}/${attempts} — ` +
        `re-deriving on the fresh origin/master tip`,
    );
    return 'retry';
  }
  if (isNonFfRace && i === attempts - 1) {
    const exhausted = new Error(
      `land-lib: push of ${branch} lost the non-ff race on all ${attempts} attempts — the branch ` +
        `is NOT on origin/master; safe to resume with the queue slot held.`,
    );
    exhausted.reason = 'ephemeral-push-nonff-exhausted';
    exhausted.attempts = attempts;
    exhausted.branch = branch;
    // plan 2411 review fix: carry the last attempt's raw message (truncated to conflictDetail's
    // 400-char budget) so an operator reading the LAND_BLOCKED_HOLDING seam can tell "6 genuine
    // races" apart from a PERMANENT rejection (branch protection, a stale ref) that matches the
    // same broad regex and will never clear on a bare --resume.
    exhausted.pushDetail = msg.replace(/\s+/g, ' ').trim().slice(0, 400);
    throw exhausted;
  }
  throw e;
}

// Land `branch` onto origin/master via a fresh DETACHED worktree off origin/master.
// Retries the whole fetch→reset→merge→push on a non-ff race (a sibling landed
// between our fetch and our push). Returns the new master tip sha.
//
// plan 2466: this is now the FALLBACK path, not the default one. It is reached only when
// the object-database fast path (landBranchViaEphemeral below) cannot produce a clean merge
// — i.e. on a conflict or any anomaly. It is kept BYTE-FOR-BYTE as it was, deliberately:
// this is where the spine's conflict recovery diagnostics live (unmergedPathsFromPorcelain,
// conflictCulpritsFor, attribution against the merge-base), and re-deriving them from
// `merge-tree`'s output would fork a second, less-tested recovery seam. Conflicts are rare,
// so paying the 65.8s checkout there costs nothing at the median.
//
// opts._injectRaceOnce(originUrl) is a test seam: it is invoked exactly once,
// AFTER the first merge but BEFORE the first push, with the RESOLVED origin URL
// (the bare remote the ephemeral worktree pushes to). A test uses it to push a
// sibling commit onto that same origin so iteration 0's push is rejected non-ff
// and iteration 1 re-fetches/re-merges onto the sibling tip and succeeds.
// gpt-review 3972 r1 findings 1d260f / 189cf4 / 269ee4: the spine pins the branch tip it
// REVIEWED, QUEUED and GATED (`opts.expectedHead`, the worktree's HEAD) and both land paths refuse
// to merge any other `origin/<branch>`. Before this, the tip the merge landed was whatever
// `origin/<branch>` resolved to at fetch time — and the push below is `--no-verify`, justified
// (plan 768) only because the branch's OWN push already ran the full hook on identical content.
// A force-push to the branch between the spine's last check and this fetch (another session, a
// stray prep, a hand `git push -f`) would otherwise land unreviewed, ungated content on master.
// The old rebase path re-published the local HEAD right before the merge and so mostly hid the
// window; the plan-3972 sync skip removes that republish, which is why the pin is now explicit —
// and structural: it guards the rebase path too, not just the skip. Typed `.reason`
// `branch-tip-moved` (the same contract every other land-lib halt uses); the branch is NOT on
// origin/master when it throws. An unset `expectedHead` (legacy callers, tests) skips the check.
export function assertExpectedBranchTip(branch, actualHead, expectedHead) {
  if (!expectedHead) return;
  const actual = String(actualHead || '').trim();
  const expected = String(expectedHead).trim();
  if (actual === expected) return;
  const err = new Error(
    `land-lib: origin/${branch} is at ${actual || '(absent)'} but the land expected the reviewed ` +
      `tip ${expected} — the branch was pushed by someone else after review; NOT merged.`,
  );
  err.reason = 'branch-tip-moved';
  err.branch = branch;
  err.expectedHead = expected;
  err.actualHead = actual || null;
  throw err;
}

export function landBranchViaCheckout(MAIN, branch, summary, opts = {}) {
  const wtDir = join(MAIN, '.claude', 'worktrees');
  // plan 1663: every land first sweeps ANY dead _land-* registration (missing dir + provably-idle
  // metadata), so a killed land's debris is cleared by the NEXT land regardless of branch. A sweep
  // failure must never block the land — the per-path reclaim below is the functional gate.
  try {
    sweepDeadLandRegistrations(MAIN);
  } catch {
    /* best-effort */
  }
  let tmp = join(wtDir, landDirBaseFor(branch));
  // plan 1573 + review fix: reclaim `tmp` ONLY when it's safe — an orphaned leftover directory,
  // or a registered worktree for THIS SAME branch (a stale remnant of a crashed prior land of the
  // identical branch). A path registered for a DIFFERENT branch is a LIVE sibling's in-flight
  // ephemeral checkout that happens to truncate to the same basename; reclaimLandDirIfSafe
  // refuses to touch it and we fall back to the hash-suffixed name instead, so this land can never
  // remove/clobber a concurrent sibling's worktree out from under it.
  if (!reclaimLandDirIfSafe(MAIN, tmp, branch)) {
    tmp = join(wtDir, landDirBaseFor(branch, true));
    // the hash-suffixed fallback path can itself be a stale leftover from an earlier crashed
    // collision-fallback land of this SAME branch — best-effort-reclaim it too.
    reclaimLandDirIfSafe(MAIN, tmp, branch);
  }
  run(MAIN, ['fetch', 'origin', 'master', branch]);
  // plan 3972: the fallback fetches `branch` ONCE here, and the tip it checks is the tip it
  // MERGES — captured as a sha and merged by sha on every retry below (gpt-review 3972 r2
  // findings 070dc9 / 35d2ce / 8013b4 / 043a43: merging `origin/<branch>` BY NAME would re-resolve the
  // ref on each iteration, so a branch push landing mid-retry could slip past the one-time
  // check). Parity with landBranchViaEphemeral's pinned `head`.
  const head = run(MAIN, ['rev-parse', `origin/${branch}`]);
  assertExpectedBranchTip(branch, head, opts.expectedHead);
  try {
    run(MAIN, ['worktree', 'add', '--detach', tmp, 'origin/master']);
  } catch (e) {
    const fallback = worktreeAddCollisionFallback(MAIN, branch, e);
    if (!fallback) throw e;
    tmp = fallback;
    run(MAIN, ['worktree', 'add', '--detach', tmp, 'origin/master']);
  }
  // the bare remote that BOTH the ephemeral worktree and any racing sibling push to
  const originUrl = run(tmp, ['config', '--get', 'remote.origin.url']);
  let raced = false;
  try {
    for (let i = 0; i < 6; i++) {
      run(tmp, ['fetch', 'origin', 'master']);
      run(tmp, ['reset', '--hard', 'origin/master']);
      // plan 1239: the merge is the crash site. `git merge --no-ff` throws a RAW git error on any
      // failure — a 3-way CONTENT conflict (a whole-file seed rewrite vs a sibling seed land that
      // reached origin/master between our reset and this merge, or a Fix-2 add/add batch-dir
      // collision) OR a non-content refusal (e.g. stray debris → "untracked working tree files would
      // be overwritten by merge"). Left BARE, that raw throw escaped past the inner push try/catch,
      // hit landBranchViaEphemeral's cleanup-only finally, and propagated to done-worktree main()'s
      // finally → dequeueQueueIfHeld → the head FIFO slot was RELEASED (the plan-1174 land lost its
      // slot ~4×). EVERY merge failure is recoverable and must HOLD the slot (that is the whole point
      // of this plan — never crash-and-lose-the-slot on a merge failure), so ALWAYS convert it to a
      // TYPED `ephemeral-merge-conflict` error (the .reason contract assertLandable uses); NEVER
      // rethrow raw (that drops to done-worktree's crash path and releases the slot). The RECOVERY
      // MESSAGE differs by subtype (content conflict vs no-unmerged-paths failure), classified from
      // the WORKTREE STATE (unmerged paths) not the stderr text — the reason builder branches on it.
      try {
        run(tmp, ['merge', '--no-ff', head, '-m', `Merge ${branch}: ${summary}`]);
      } catch (e) {
        let status = '';
        try {
          status = run(tmp, ['status', '--porcelain']);
        } catch {
          /* status itself failed — treat as a no-unmerged-paths (non-content) failure */
        }
        const conflictedPaths = unmergedPathsFromPorcelain(status);
        // Attribution + merge-base are computed LAZILY, only on the CONTENT-conflict path — the
        // common (successful) land never pays for the merge-base spawn. HEAD is still origin/master
        // here (the conflicted merge is uncommitted), so the base is the pre-merge merge-base.
        // Reuse conflictCulpritsFor (the plan-1000 helper syncBranchOntoMaster uses) so the two
        // conflict seams share ONE base-guard + attributeConflict path and cannot drift.
        let culprits = [];
        if (conflictedPaths.length) {
          let base = null;
          try {
            base = run(tmp, ['merge-base', 'HEAD', `origin/${branch}`]);
          } catch {
            /* attribution is best-effort — a missing base just yields no culprits */
          }
          culprits = conflictCulpritsFor(tmp, base, status, conflictedPaths);
        }
        const err = new Error(
          conflictedPaths.length
            ? `ephemeral merge of ${branch} onto origin/master hit a CONFLICT in ` +
                `${conflictedPaths.join(', ')} — the branch does not cleanly merge onto the current ` +
                `origin/master tip (a sibling land moved a file this branch also rewrote). The branch ` +
                `is NOT on origin/master, so this is safe to recover with the queue slot held.`
            : `ephemeral merge of ${branch} onto origin/master FAILED with no content conflict ` +
                `(no unmerged paths) — the branch is NOT on origin/master; safe to recover with the ` +
                `queue slot held.`,
        );
        err.reason = 'ephemeral-merge-conflict';
        err.conflictedPaths = conflictedPaths;
        err.culprits = culprits;
        err.conflictDetail = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        throw err;
      }
      // opts._injectRaceEvery(originUrl, i) is a test seam: unlike _injectRaceOnce (fires
      // exactly once, guarded by `raced`), it fires on EVERY iteration — used to force all
      // 6 push attempts to lose the race (plan 2411 exhaustion coverage) or to simulate a
      // non-retryable push failure on the first attempt.
      if (opts._injectRaceEvery) {
        opts._injectRaceEvery(originUrl, i);
      } else if (opts._injectRaceOnce && !raced) {
        raced = true;
        opts._injectRaceOnce(originUrl);
      }
      try {
        // plan 768: push the ephemeral merge with the pre-push hook SKIPPED
        // (--no-verify). The ephemeral worktree is a throwaway detached checkout
        // off origin/master with NO node_modules (it is never `pnpm install`ed),
        // so the master-landing hook's binary-based gates — `pnpm exec prettier
        // --check`, the frontend/backend `tsc`, `pnpm validate-seed` — resolve no
        // local binary, fall through to PATH, and crash the land with
        // `'prettier' is not recognized` (hit landing plan 763, 2026-06-17). The
        // spine ALREADY treats this push as hook-free by design: the build +
        // mobile preflights run in the WORKTREE (which has node_modules) precisely
        // because "the ephemeral merge push runs NO pre-push hook" (see
        // runBuildPreflight / runMobilePreflight in done-worktree.mjs),
        // and the branch's own worktree-branch push already ran the FULL hook on
        // identical content. Re-running it here is therefore both broken and
        // redundant — --no-verify makes the code match that design.
        tryRun(tmp, ['push', '--no-verify', 'origin', 'HEAD:master']);
        const sha = run(tmp, ['rev-parse', 'HEAD']);
        run(MAIN, ['fetch', 'origin', 'master']); // refresh MAIN's origin/master ref only
        return sha;
      } catch (e) {
        // plan 2466: ONE owner for this contract — see classifyPushFailure above. It either
        // returns 'retry' or throws (typed on exhaustion, raw on a non-race failure).
        classifyPushFailure(e, { i, branch });
        continue;
      }
    }
    throw new Error(`land-lib: could not push ${branch} after 6 attempts`);
  } finally {
    // plan 2481: evict any memoized indexLockPath(tmp) alongside the teardown removal below — a
    // later land in this same process can re-add an ephemeral worktree at this same slug-truncated
    // `tmp` path (landDirBaseFor), and without this the cache would keep watching an admin dir this
    // teardown is about to make stale.
    invalidateIndexLockPath(tmp);
    try {
      run(MAIN, ['worktree', 'remove', '--force', tmp]);
    } catch {
      /* fall through */
    }
    if (existsSync(tmp)) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* honest */
      }
    }
    try {
      run(MAIN, ['worktree', 'prune']);
    } catch {
      /* best-effort */
    }
  }
}

// plan 2466: produce the merge tree in the OBJECT DATABASE — no working tree, no index, no
// checkout. Returns the tree oid on a clean merge, or null on ANY non-clean outcome (a content
// conflict, an unsupported merge, a git error). Deliberately null-on-anything-odd rather than
// throwing a classified error: the ONLY caller's response to every non-clean outcome is the same
// — fall back to the full-checkout path, which then re-derives the real diagnostics.
//
// THE TRAP this guards (measured 2026-07-26, git 2.53): on a CONFLICT, `git merge-tree
// --write-tree` still prints a tree oid on stdout line 1 — a tree whose conflicted paths carry
// stage-1/2/3 entries — and signals the conflict ONLY through a non-zero exit status. Parsing
// line 1 without checking the exit code would therefore push a CONFLICTED tree to master and
// call it a successful land. `run()` throws on non-zero, so the catch below IS the exit-code
// check; the oid shape assertion is the second belt.
export function mergeTreeWriteTree(MAIN, ours, theirs, { run: _run = run } = {}) {
  let out;
  try {
    out = _run(MAIN, ['merge-tree', '--write-tree', ours, theirs]);
  } catch {
    return null; // conflict (exit 1) or error (exit 128) — caller falls back
  }
  const oid = String(out).split('\n')[0].trim();
  return /^[0-9a-f]{40,}$/.test(oid) ? oid : null;
}

// Land `branch` onto origin/master WITHOUT checking anything out (plan 2466).
//
// The old path created a throwaway worktree off origin/master to run `git merge --no-ff` in.
// Measured on this fleet's Windows host: `git worktree add --detach` 43.9s + `git worktree
// remove --force` 21.9s = 65.8s of fixed cost, on every land, to check out all 62,066 tracked
// files for a merge that touches a handful of paths. `git merge-tree --write-tree` does the
// same 3-way merge in the object db in ~94ms, and `git commit-tree` seals it with the same two
// parents and the same message.
//
// WHY THIS IS SAFE, and how it was established rather than assumed (2026-07-26, git 2.53.0):
//   - Tree equivalence is not taken on faith. This module's own ephemeral-merge-equivalence test
//     pins byte-identical trees across renames, binaries, a CUSTOM merge driver, the `union`
//     attribute, and conflict-detection parity — and drives the REAL lander, not raw git.
//   - Custom merge drivers DO run under merge-tree. This mattered: the repo registers
//     `merge=wiki-updated` (.git/info/attributes) and `merge=union` on wiki/log.md and both
//     data-pipeline observations .jsonl files — and that observations log rides inside
//     concurrent seed lands, i.e. exactly the merge this path performs. Measured: merge-tree
//     invokes the driver and yields the identical tree oid. Had it silently fallen back to the
//     built-in 3-way merge, this path would have pushed a DIFFERENTLY-merged tree with nothing
//     to flag it — which is why it is a pinned regression test and not a comment.
//   - The plan-355 guarantee is strengthened, not weakened: merge-tree, commit-tree, fetch and
//     push touch no working tree and no index, so this mutates the shared main checkout even
//     less than the old path did (which at least wrote a sibling directory under it).
//
// Everything the callers depend on is preserved: the 6-attempt non-ff retry loop, both typed
// errors (`ephemeral-merge-conflict` via the fallback, `ephemeral-push-nonff-exhausted` here),
// the `_injectRaceOnce`/`_injectRaceEvery` test seams, and the returned new-master-tip sha.
export function landBranchViaEphemeral(MAIN, branch, summary, opts = {}) {
  // plan 1663: keep sweeping dead _land-* registrations on EVERY land. The fast path creates no
  // worktree of its own, but it is now the common case — if the sweep moved into the fallback
  // only, a killed land's debris would sit until the next CONFLICTING land, which may be never.
  try {
    sweepDeadLandRegistrations(MAIN);
  } catch {
    /* best-effort */
  }
  const fallback = () => landBranchViaCheckout(MAIN, branch, summary, opts);

  let originUrl;
  let head;
  try {
    run(MAIN, ['fetch', 'origin', 'master', branch]);
    originUrl = run(MAIN, ['config', '--get', 'remote.origin.url']);
    // The branch tip is PINNED here, ONCE, and deliberately never refreshed inside the retry loop
    // below — matching landBranchViaCheckout, which fetches `branch` once before its loop and
    // thereafter only re-fetches `master`.
    //
    // review fix (/sonnet-review xhigh, CONFIRMED): re-resolving `origin/<branch>` per iteration
    // was a TOCTOU that could land content nobody verified. The push is `--no-verify`, justified
    // (plan 768) by "the branch's own push already ran the FULL hook on identical content" — an
    // assumption that holds ONLY for the tip that was reviewed, queued and preflighted. If the
    // worktree session pushed one more commit while this land sat in a non-ff retry, the old code
    // would have picked that newer tip up on iteration 1 and pushed hook-unverified, unreviewed
    // content to master. Pinning the tip makes the plan-768 justification true again.
    head = run(MAIN, ['rev-parse', `origin/${branch}`]);
  } catch {
    return fallback(); // can't even fetch — let the fallback surface it the established way
  }
  // plan 3972: refuse any tip but the one the spine reviewed — deliberately OUTSIDE the try above,
  // so the typed throw reaches the caller instead of being read as "can't fetch" and routed into
  // the checkout fallback (which carries the same check and would merely repeat the refusal).
  assertExpectedBranchTip(branch, head, opts.expectedHead);

  let raced = false;
  for (let i = 0; i < 6; i++) {
    let base;
    try {
      // ONLY master is refreshed per iteration — a non-ff race means master moved, never that the
      // branch did. (Re-fetching `branch` here is what the review flagged; do not reinstate it.)
      if (i > 0) run(MAIN, ['fetch', 'origin', 'master']);
      base = run(MAIN, ['rev-parse', 'origin/master']);
    } catch {
      return fallback();
    }

    // ALREADY-MERGED SHORT-CIRCUIT — a real behavioural difference between the two mechanisms,
    // not a micro-optimisation (found by the plan-2466 merge-base experiment, 2026-07-26).
    // `git merge --no-ff` REFUSES to create a commit when the other side is already an ancestor
    // ("Already up to date."); the old path then pushed a no-op and returned the existing master
    // tip. `merge-tree` has no such signal — it cheerfully returns the base tree, and
    // `commit-tree` would seal a DEGENERATE merge commit (a second parent that contributes
    // nothing, and in the tip==tip case two identical parents) and ADVANCE master with it. That
    // is reachable in practice: a land re-run after a successful land whose marker did not record
    // sees exactly this shape. Reproduce the old contract exactly — return the current tip.
    let alreadyMerged = false;
    try {
      run(MAIN, ['merge-base', '--is-ancestor', head, base]);
      alreadyMerged = true;
    } catch {
      /* exit 1 = not an ancestor, the normal case */
    }
    if (alreadyMerged) return base;

    // Parent ORDER is load-bearing: the checkout path resets to origin/master and merges the
    // branch into it, so first-parent is master and second is the branch. `git log --first-parent
    // master`, the conflict attribution's `Merge worktree-<id>: …` subject scan, and every
    // "what landed when" query downstream all assume that orientation.
    const tree = mergeTreeWriteTree(MAIN, base, head);
    if (!tree) return fallback();

    let sha;
    try {
      sha = run(MAIN, [
        'commit-tree',
        tree,
        '-p',
        base,
        '-p',
        head,
        '-m',
        `Merge ${branch}: ${summary}`,
      ]);
    } catch {
      return fallback();
    }

    if (opts._injectRaceEvery) {
      opts._injectRaceEvery(originUrl, i);
    } else if (opts._injectRaceOnce && !raced) {
      raced = true;
      opts._injectRaceOnce(originUrl);
    }

    try {
      // --no-verify for the same plan-768 reason the checkout path documents: the branch's own
      // push already ran the FULL hook on identical content, and re-running it here is both
      // redundant and (historically) broken.
      tryRun(MAIN, ['push', '--no-verify', 'origin', `${sha}:master`]);
      run(MAIN, ['fetch', 'origin', 'master']); // refresh MAIN's origin/master ref only
      return sha;
    } catch (e) {
      // Identical contract to the checkout path, and now literally the same code — see
      // classifyPushFailure. Note it deliberately does NOT fall back to the checkout path: a
      // non-race push failure is not something a 65.8s re-merge can fix.
      classifyPushFailure(e, { i, branch });
      continue;
    }
  }
  throw new Error(`land-lib: could not push ${branch} after 6 attempts`);
}

// plan 507: pre-land branch sync (the spine's "rebase" step). A branch carrying
// freshen-merges of origin/master (the sanctioned way to absorb sibling landings
// mid-flight) must NOT be rebase-linearized: the replay discards the merge commits'
// conflict resolutions, so the rebase stops on the SAME conflicts the author already
// resolved — and under fleet contention master advances between attempts, so every
// retry re-fights the full set (the 479 land needed three invocations + a manual
// squash). Detect merge-bearing history and sync with ONE final freshen-merge
// instead: prior resolutions are already shared history, so only genuinely-new
// conflicts (master moved past the last freshen) surface, exactly once — and a
// re-run after resolution is an idempotent "Already up to date", never a re-fight.
// Linear branches keep the plain rebase (the common drain case).
// Returns { conflicted, conflictCommits, abortedOnce, mergeBearing, pushBlocked?, pushDetail?,
// culprits? } — `culprits` (plan 1000) is the per-conflicted-file plan attribution, present only
// on a conflicted return; holdingReason renders it into the LAND_BLOCKED_HOLDING seam.
// plan 1000 (Task 3): attribute a land conflict to the sibling plan(s) that actually moved
// each conflicted file, so done-worktree NAMES the culprit instead of the driver guessing
// (the 2026-06-23 incident reported 996 when 993 was the real clobberer). For each conflicted
// path, list the commits on origin/master since `base` (the branch's merge-base) that touched
// it and pull the landing plan id out of each merge subject (`Merge worktree-<NNN-…>: …`, the
// shape landBranchViaEphemeral writes). --full-history is REQUIRED: default simplification
// prunes the landing merge (TREESAME to the side branch), and only the merge subject carries
// the plan id — the plan's own work commits do not. Returns
//   [{ path, plans:[{id, sha, subject}], commits:[{sha, subject}] }]
// `plans` is the de-duped attribution (first sha per id wins); `commits` is EVERY touching
// commit, so a direct-to-master commit with no plan tag is still surfaced, never dropped.
// `run` is injected for tests. NEVER throws — a git failure for a path yields an empty
// attribution for it (a diagnostic must never crash an already-blocked land).
export function attributeConflict(wtPath, conflictedPaths, base, { run: _run = run } = {}) {
  const SEP = '\u0000';
  return conflictedPaths.map((path) => {
    let raw;
    try {
      raw = _run(wtPath, [
        'log',
        `${base}..origin/master`,
        '--full-history',
        // LITERAL "%x00" — a real null byte in a command arg makes child_process throw.
        '--format=%H%x00%s',
        '--',
        path,
      ]);
    } catch {
      return { path, plans: [], commits: [] };
    }
    const commits = (raw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(SEP);
        return i === -1 ? { sha: l, subject: '' } : { sha: l.slice(0, i), subject: l.slice(i + 1) };
      });
    const byId = new Map();
    for (const c of commits) {
      const m = c.subject.match(/worktree-(\d{3,})/);
      if (m && !byId.has(m[1])) byId.set(m[1], { id: m[1], sha: c.sha, subject: c.subject });
    }
    return { path, plans: [...byId.values()], commits };
  });
}

// plan 1000 (Task 3): render attributeConflict() output as compact operator-facing lines for
// the LAND_BLOCKED_HOLDING seam. An attributable path names the plan(s); an unattributable one
// reports the raw commit(s) rather than guessing.
export function formatConflictCulprits(attributions) {
  return (attributions || [])
    .map((a) => {
      if (a.plans && a.plans.length) {
        const who = a.plans
          .map((p) => `plan ${p.id} (${p.sha.slice(0, 9)} "${p.subject}")`)
          .join(', ');
        return `conflict in ${a.path} — landed by ${who}`;
      }
      if (a.commits && a.commits.length) {
        const who = a.commits.map((c) => `${c.sha.slice(0, 9)} "${c.subject}"`).join(', ');
        return `conflict in ${a.path} — touched on master by ${who} (no plan-tagged land found)`;
      }
      return `conflict in ${a.path} — no commit on origin/master since base touched it`;
    })
    .join('\n');
}

// plan 1000: the unmerged (conflicted) paths from `git status --porcelain` output. We parse
// the SAME porcelain string syncBranchOntoMaster already captured to decide `conflicted`,
// rather than a second `git diff --diff-filter=U` call — one source of truth (no divergence
// between the gate and the path list) and one fewer git invocation. Unmerged porcelain codes
// (DD/AU/UD/UA/DU/AA/UU) are a 2-char status then a space then the path.
export function unmergedPathsFromPorcelain(status) {
  return (status || '')
    .split('\n')
    .filter((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

// plan 1000: attribute each conflicted path to its landing plan(s). Best-effort — any git failure
// yields [] so callers never re-throw. `paths` may be passed PRE-PARSED (plan 1239:
// landBranchViaEphemeral already parsed the porcelain for the seam message — pass it so the same
// string is not walked twice AND the operator-facing path list can't diverge from the attribution's);
// omitted (syncBranchOntoMaster), it parses `status` itself.
function conflictCulpritsFor(wtPath, base, status, paths = null) {
  if (!base) return [];
  try {
    const p = paths ?? unmergedPathsFromPorcelain(status);
    return p.length ? attributeConflict(wtPath, p, base) : [];
  } catch {
    return [];
  }
}

// plan 3080 — the local-master twin of done-worktree's `foreignStackedBranch` backstop.
//
// The incident (2026-08-05, ledger `keep-hot-prep-grafted-another-plans-unlanded-commits-onto-
// my-branch`): a queue-wait prep left plan 2883's branch carrying plan 2721's 15 unlanded
// commits, so `origin/master...HEAD` was 19 files / 1,689 insertions of which only 11 / 274 were
// the branch's own. Landing it would have merged another plan's unreviewed work under this
// plan's merge. Two guards caught it by redundancy (the unpushed-commit preflight and
// `record-review repin`'s patch-id pin) — neither is a guard against the graft itself, and both
// fire only AFTER the force-push has already published it.
//
// Plan 3080's root-cause pass could NOT reproduce the ledger's stated mechanism ("the prep
// rebased onto local master"): every prep/keep-hot rebase already pins `origin/master` after a
// fetch (see `rebasedOntoSha` below, plan 2433), and the one seam that deliberately rebases onto
// another plan's branch — plan 2463's speculative stack — is ruled out by the committed queue
// snapshots (2883 sat at position 10 then 7, never at SPECULATIVE_POS). The branch and its reflog
// died with the worktree, so the seam is not recoverable.
//
// So this guards the OUTPUT invariant instead of the input, which is what the incident actually
// violated and what holds no matter which seam moved the branch — including one that no longer
// exists, or has not been written yet:
//
//   after the rebase/freshen and BEFORE the force-push that publishes it, no commit in
//   `<ontoSha>..HEAD` may be reachable from the shared local `master`.
//
// In the healthy state this is a NO-OP: this repo only ever fast-forwards local `master` to
// `origin/master` (`opportunisticFfMain`, `heal-main.mjs`, `cloud-checkout-preflight.mjs`), so
// `master ^origin/master` is empty and the intersection cannot be non-empty. It fires exactly in
// the hazard state the ledger describes — a sibling land that merged into the shared local master
// and never completed its push — and only when those commits actually reached OUR branch.
//
// Deliberately NOT keyed on "local master is ahead of origin/master" alone (the ledger's literal
// fix shape): that condition is common and harmless on a shared checkout, and refusing on it
// would guard the input seam the evidence has just ruled out. The graft is the thing to refuse.
//
// Returns the offending commits (newest first) as {sha, subject}, or [] — never throws, because a
// missing local `master` ref (a detached or single-branch checkout) is a legitimate no-foreign
// state, not an error.
// Returns { commits, cleanCutoff } — `commits` newest-first (empty ⇒ no graft), `cleanCutoff`
// true when every foreign commit sits BELOW every commit of our own, so the one-line
// `rebase --onto origin/master <newest-foreign>` recovery is safe (see rebaseSeam).
//
// Throws `GraftCheckError` when the check cannot be EVALUATED (a git failure other than "there is
// no local master ref"). Fail-CLOSED is deliberate: this is the guard standing between a session
// and merging another plan's unreviewed work, so "I could not tell" must not read as "all clear"
// (gpt-review 91a6c1/e0f561/272b33/d2be47). A genuinely absent local `master` — a detached or
// single-branch checkout — is a real no-foreign state and returns cleanly.
export class GraftCheckError extends Error {}

export function graftedForeignCommits(wtPath, ontoSha) {
  const none = { commits: [], cleanCutoff: true };
  if (!ontoSha) return none;
  // Is there a local master ref at all? Distinguishing "absent" (legitimate) from "unreadable"
  // (unknown) is what lets everything below fail closed without making a single-branch checkout
  // un-landable — and the probe itself must make that distinction, or it reintroduces the very
  // fail-open it exists to remove (gpt-review round 2: 5ef0ea/b63ebb/012a1c/969ced/d02ad1/c6a754,
  // caught after round 1 fixed the ENUMERATION but left this probe swallowing every error).
  // `rev-parse --verify --quiet` and `show-ref --quiet` both exit non-zero for "absent" AND for
  // "repo is broken", which is exactly the conflation to avoid. `for-each-ref` does not: it exits
  // 0 with EMPTY output when the ref simply is not there, and non-zero only on a real failure.
  let localMaster;
  try {
    localMaster = run(wtPath, ['for-each-ref', '--format=%(objectname)', 'refs/heads/master']);
  } catch (e) {
    throw new GraftCheckError(`could not read refs/heads/master: ${errText(e) || e}`);
  }
  if (!localMaster) return none; // genuinely absent — a detached / single-branch checkout

  let ours;
  let foreignList;
  try {
    // --topo-order: the recovery cutoff below is "the newest foreign commit", and default
    // rev-list ordering is by commit DATE, which in a merge/criss-cross history can emit a
    // non-tipward commit first (gpt-review 166fac). Topological order makes index 0 genuinely
    // the tipward-most entry.
    ours = run(wtPath, ['rev-list', '--topo-order', `${ontoSha}..HEAD`])
      .split('\n')
      .filter(Boolean);
    // Commits carried by the shared local master that have NOT landed on origin/master. Normally
    // empty. `refs/heads/master` explicitly: a bare `master` could resolve to a remote-tracking
    // ref under some ambiguity, and this check must speak about the LOCAL ref or nothing.
    foreignList = run(wtPath, ['rev-list', 'refs/heads/master', `^${ontoSha}`])
      .split('\n')
      .filter(Boolean);
  } catch (e) {
    throw new GraftCheckError(
      `could not enumerate the branch/local-master ranges against ${String(ontoSha).slice(0, 9)}: ` +
        `${errText(e) || e}`,
    );
  }
  if (!ours.length || !foreignList.length) return none;

  const foreign = new Set(foreignList);
  const flags = ours.map((sha) => foreign.has(sha));
  if (!flags.some(Boolean)) return none;
  // `ours` is newest-first, so a "clean cutoff" is every foreign commit occupying the OLDEST
  // stretch with no commit of ours beneath any of them — i.e. the flags read [false…, true…].
  // When our own work is interleaved below a foreign commit, the one-line recovery would drop it
  // along with the graft (gpt-review 14f336), so the seam prints the explicit recipe instead.
  //
  // On a LINEAR range that positional test is exact, because "reachable from local master" is
  // ancestor-closed: if a commit is foreign, everything below it in the range is foreign too. With
  // a MERGE in the range it is not — topo order is only one of several valid linearisations, so
  // adjacency in the list proves nothing about ancestry (gpt-review round 2: 67ada6/485424).
  // Refuse to claim a clean cutoff there rather than infer one from list positions; the explicit
  // cherry-pick recipe is always correct, just wordier.
  let hasMerges = true;
  try {
    hasMerges = !!run(wtPath, ['rev-list', '-1', '--merges', `${ontoSha}..HEAD`]);
  } catch (e) {
    throw new GraftCheckError(`could not test the range for merges: ${errText(e) || e}`);
  }
  const firstForeign = flags.indexOf(true);
  const cleanCutoff = !hasMerges && flags.slice(firstForeign).every(Boolean);
  const commits = ours
    .filter((_, i) => flags[i])
    .map((sha) => {
      let subject = '';
      try {
        subject = run(wtPath, ['log', '-1', '--format=%s', sha]);
      } catch {
        /* naming is best-effort — the sha alone is already actionable */
      }
      return { sha, subject };
    });
  // `ownAbove` names OUR commits sitting above the graft, and it is read from the same topo-list
  // positions that `cleanCutoff` deliberately refuses to trust once the range contains a merge
  // (gpt-review round 3: a73095). Positions are exact on a linear range and meaningless across a
  // merge, so it is populated only in the case where it can be proved — omitted rather than
  // guessed, and the seam simply drops that clause when it is empty.
  const ownAbove = hasMerges
    ? []
    : ours.filter((_, i) => !flags[i] && i < firstForeign).map((sha) => sha.slice(0, 9));
  return { commits, cleanCutoff, ownAbove, mergeBearing: hasMerges };
}

// `opts._rebaseOrMerge` is a TEST SEAM ONLY (mirrors `run`'s `_git` opts convention elsewhere in
// this file): a real git rebase/merge failure at the EXACT mid-replay "rescheduled pick" instant
// (a sibling's `git status` grabbing the index.lock between two picks) cannot be provoked
// deterministically from outside — a plain PRE-existing lock file only ever blocks the rebase's
// very FIRST step (proven empirically: git leaves no `rebase-merge` state behind then, so it is a
// different, from-scratch-retriable shape). Letting a test substitute this ONE call lets it
// exercise the reschedule classification against the REAL captured error text (plan 3974's
// evidence log) while still driving a REAL `git rebase --continue` against a genuinely-built
// resumable rebase-merge state — only the FAILURE MESSAGE is synthetic, the resume is real.
export function syncBranchOntoMaster(wtPath, branch, opts = {}) {
  run(wtPath, ['fetch', 'origin']);
  // plan 2433: resolve origin/master ONCE, right after this fetch and before the rebase/merge
  // below mutates HEAD — the repo's .git is shared by ~7 sessions, so a SIBLING's later
  // fetch/land can move this same local ref while the rebase's own push gates run (~15-27
  // min). Returning the sha resolved HERE lets a caller pin a later check (the plan-2274
  // landed-reversion lint) to the exact tip this sync rebased onto, instead of re-resolving
  // origin/master after the race window has had time to move it.
  const rebasedOntoSha = run(wtPath, ['rev-parse', 'origin/master']);
  // plan 2433 review fix: every git call below that decides WHAT gets rebased onto now
  // addresses rebasedOntoSha directly, never the literal 'origin/master' ref name — a
  // ref-by-name re-resolves dynamically, so a sibling's fetch landing between the
  // rev-parse above and the rebase/merge call below would otherwise rebase onto a NEWER
  // tip than the one just captured, silently decoupling the returned sha from what
  // actually happened (the exact gap the pin exists to close).
  // plan 3080: the graft check runs BEFORE the rebase/merge, not after.
  //
  // The first cut checked after, which gpt-review d03b97 showed is unsound: when origin/master has
  // ADVANCED past the graft point, the rebase REWRITES the foreign commits onto the new tip, so
  // their SHAs no longer match the ones on local master and the intersection comes out empty —
  // the guard would miss exactly the busy-fleet case it exists for. Before the rebase the SHAs are
  // still the ones local master carries, so the comparison is sound.
  //
  // Checking first is also strictly safer in two other ways the post-rebase placement was not:
  // a graft whose rebase CONFLICTS used to return on the conflict arm without ever reaching the
  // guard (gpt-review 762884/182288), and a grafted branch no longer has its history rewritten by
  // a rebase we are about to refuse anyway. A rebase/freshen onto `rebasedOntoSha` cannot itself
  // introduce a local-master-only commit, so nothing is lost by not re-checking afterwards.
  let graft;
  try {
    graft = graftedForeignCommits(wtPath, rebasedOntoSha);
  } catch (e) {
    // Fail closed — see GraftCheckError.
    return {
      conflicted: false,
      conflictCommits: 0,
      abortedOnce: false,
      mergeBearing: false,
      rebasedOntoSha,
      graftBlocked: true,
      graftUnverifiable: true,
      graftCommits: [],
      graftDetail: e.message || String(e),
    };
  }
  if (graft.commits.length) {
    return {
      conflicted: false,
      conflictCommits: 0,
      abortedOnce: false,
      mergeBearing: false,
      rebasedOntoSha,
      graftBlocked: true,
      graftCommits: graft.commits,
      graftCleanCutoff: graft.cleanCutoff,
      graftOwnAbove: graft.ownAbove,
      graftMergeBearing: graft.mergeBearing,
    };
  }

  const mergeBearing = !!run(wtPath, ['rev-list', '-1', '--merges', `${rebasedOntoSha}..HEAD`]);
  // plan 1000: capture the merge-base BEFORE the merge/rebase, while HEAD is still the clean
  // branch tip (mid-rebase HEAD is ambiguous). Used only for conflict attribution.
  let base = null;
  try {
    base = run(wtPath, ['merge-base', 'HEAD', rebasedOntoSha]);
  } catch {
    /* attribution is best-effort — a missing base just yields no culprits */
  }
  const runRebaseOrMerge =
    opts._rebaseOrMerge ||
    (() => {
      if (mergeBearing) {
        // --no-ff: always a true merge here (mergeBearing ⇒ HEAD has own commits), and it
        // neutralizes a user-global `merge.ff=only` config that would otherwise abort the
        // sync silently ("Already up to date" still short-circuits to a no-op).
        tryRun(wtPath, [
          'merge',
          '--no-ff',
          rebasedOntoSha,
          '-m',
          `freshen ${branch} onto origin/master (pre-land)`,
        ]);
      } else {
        tryRun(wtPath, ['rebase', rebasedOntoSha]);
      }
    });
  // plan 3974 T2a: classify a failed attempt (real conflict vs a lock/reschedule race worth
  // retrying vs anything else) off the SAME `status` porcelain each time — one call site, no
  // divergence between the first attempt and a retry's own failure.
  // Test seam for the merge-abort inside the retry loop (mirrors `_rebaseOrMerge`): the abort is
  // real git with no other injection point, so its failure branches are pinned deterministically
  // through this rather than by racing the filesystem from a second process.
  const runMergeAbort = opts._mergeAbort || (() => tryRun(wtPath, ['merge', '--abort']));
  const classifyFailure = (e) => {
    // plan 3974 T2b (gpt-review 6155b4/124aae/6b2dfc/547d0a): this status read must not itself
    // take the SAME index.lock this whole retry loop exists to survive, and must not let its own
    // failure escape uncaught — an uncaught throw here would skip the lockish/resumable decision
    // below entirely and crash the land instead of retrying or reporting a classified result.
    // `--no-optional-locks` (a GLOBAL option, must precede the subcommand) makes git skip
    // acquiring the lock for this read outright, so it is called directly via `tryRun` — not
    // `run`/`gitWithLockRetry`, whose own `waitForIndexLock` pre-poll would otherwise still sit
    // and wait on a lock this read no longer needs — and wrapped in its OWN try/catch as the
    // remaining belt-and-braces for whatever narrow failure gets through anyway (the lock held
    // long enough to blow past even this lock-free read, or an unrelated transient).
    //
    // Safe-default choice when the read itself fails: STOP, never continue. An unreadable status
    // could be masking a genuine unmerged path, so the loop below must not retry or `--continue`
    // over it (silent data loss). But it is NOT reported as a merge conflict either: that arm
    // would run conflictCulpritsFor over garbage and tell the author to resolve a conflict that
    // does not exist. It halts as `syncFailed` (LAND_BLOCKED "failed WITHOUT a merge conflict")
    // with the unreadable-status text in syncDetail — the accurate label, and the keep-hot
    // watcher simply re-preps it once the lock holder is gone. Recoverable, never silently wrong.
    let status = '';
    let statusUnknown = false;
    try {
      status = tryRun(wtPath, ['--no-optional-locks', 'status', '--porcelain']).trim();
    } catch (statusErr) {
      statusUnknown = true;
      status = `<status unreadable: ${errText(statusErr).trim() || String(statusErr)}>`;
    }
    // conflictCommits is a REPORTING field only — it never gates the retry/resume decision below
    // — so a failed read here just degrades to 'unknown count' (defaults to 1) instead of needing
    // the same fail-closed treatment as `conflicted`.
    // a merge is ONE conflict pass however long the branch is — never escalate it to
    // REBASE_UGLY on commit count (that heuristic measures rebase replay length)
    let conflictCommits = 1;
    if (!mergeBearing) {
      try {
        conflictCommits =
          (tryRun(wtPath, ['rev-list', '--count', `${rebasedOntoSha}..HEAD`]).trim() || '1') | 0;
      } catch {
        /* best-effort — a missing count just reports 1 rather than throwing past classification */
      }
    }
    const conflicted = !statusUnknown && UNMERGED_RE.test(status);
    return { e, status, conflictCommits, conflicted, statusUnknown };
  };
  // plan 3974 T2a: bounded retry loop. `pending` picks the NEXT command: 'start' re-runs the
  // whole rebase/merge from scratch (git aborted it outright — nothing to resume), 'continue'
  // resumes a pick git left RESCHEDULED mid-replay (the `rebase-merge` state directory survived
  // with its todo intact, so restarting from scratch would re-walk already-applied picks and
  // risk re-colliding on each one). A genuine merge conflict is NEVER retried or auto-continued —
  // classified and returned to the caller for author resolution, exactly as before this plan.
  // plan 3974 (gpt-review round 2, 4060f6): the merge-bearing retry below aborts a leftover
  // MERGE_HEAD on the assumption that it is ITS OWN failed attempt's. That holds only if no merge
  // was in flight when the sync began — so a pre-existing MERGE_HEAD is refused here, never
  // aborted (done-worktree's preflight halts on it earlier; this is the belt-and-braces for any
  // other caller). After this point the spine holds the worktree (plan 2473's worktree lock),
  // so a MERGE_HEAD that appears after a failed attempt is the attempt's.
  // Ungated on `mergeBearing` (round 3, 851c95/a3eccb): a LINEAR branch can carry someone's
  // in-progress merge too, and a plain `git rebase` over it would fail with a generic message
  // instead of this ownership-preserving refusal.
  if (mergeHeadExists(wtPath)) {
    return {
      conflicted: false,
      conflictCommits: [],
      abortedOnce: false,
      mergeBearing,
      rebasedOntoSha,
      syncFailed: true,
      syncDetail:
        'a merge is already in progress in this worktree (MERGE_HEAD exists) — not started by ' +
        'this sync, so it is left untouched: finish it (`git commit`) or discard it ' +
        '(`git merge --abort`) first',
      lockRetry: 0,
    };
  }
  // The marker pins the whole rebase identity git itself records — `onto` (rebase-merge/onto),
  // the pre-rebase tip (rebase-merge/orig-head) and the branch (rebase-merge/head-name) — so
  // done-worktree's resume matches all three, not the destination sha alone (round 3, 9e9c0e /
  // fbf68e / c0c94a / a8b176 / 7489e0 / c19015).
  if (!mergeBearing) {
    let origHead = null;
    try {
      origHead = tryRun(wtPath, ['rev-parse', '--verify', 'HEAD']).trim();
    } catch {
      /* no marker then — a killed run's leftover halts instead of resuming */
    }
    if (origHead) writeSpineRebaseMarker(wtPath, { onto: rebasedOntoSha, origHead, branch });
  }
  let lockRetry = 0;
  let pending = 'start';
  let failure = null; // set only when the loop gives up (conflict, exhausted, or non-lock error)
  for (;;) {
    try {
      if (pending === 'continue') {
        tryRun(wtPath, ['rebase', '--continue']);
      } else {
        runRebaseOrMerge();
      }
      failure = null;
      break;
    } catch (e) {
      const c = classifyFailure(e);
      if (c.conflicted || c.statusUnknown) {
        failure = c;
        break; // a real conflict is the author's halt — never retried, never auto-continued;
        // an UNREADABLE tree is stopped the same way (it may hide one), see classifyFailure
      }
      const msg = errText(e);
      // plan 3974 T0 (2026-09-12 repro, 100% hit rate): the SAME mid-replay index.lock
      // collision surfaces as EITHER git's sequencer catching it and printing an
      // "It has been rescheduled" hint, OR a bare `fatal:` with NO hint at all — same
      // index.lock text, same leftover rebase-merge/rebase-apply state either way. The
      // hint is therefore NOT a reliable signal (an earlier cut of this code keyed the
      // resume decision on it and silently misclassified the no-hint half of real cases
      // as a from-scratch restart) — so it is not tested for at all here. Any index.lock-
      // shaped failure (LOCK_RX) is retriable, and whether to RESUME (`--continue`) or
      // RESTART depends only on whether real rebase state survived. `!c.conflicted`
      // (already established above) is exactly `git diff --name-only --diff-filter=U`
      // being empty; only a plain `git rebase` can leave that resumable state, so gate on
      // !mergeBearing too.
      const lockish = LOCK_RX.test(msg);
      const resumable = lockish && !mergeBearing && rebaseStateExists(wtPath);
      if (lockish && lockRetry < REBASE_LOCK_RETRY_DELAYS_MS.length) {
        sleepSync(jitteredDelayMs(REBASE_LOCK_RETRY_DELAYS_MS[lockRetry]));
        lockRetry++;
        // plan 3974 T2b (gpt-review 71a161): a merge-bearing branch is never `resumable` above
        // (`git merge --continue`/`git commit` on unverified partial index state risks silently
        // committing an INCOMPLETE merge — MERGE_HEAD can survive a lock-shaped failure whether
        // or not the content merge itself actually finished writing the merged tree, and there is
        // no cheap way to tell those two cases apart from here), so every merge-bearing retry
        // restarts with a fresh `git merge --no-ff`. But git refuses to START a new merge while a
        // previous one's MERGE_HEAD still exists ("You have not concluded your merge") — a message
        // that matches neither LOCK_RX nor UNMERGED_RE, so left unhandled it would fall straight
        // through to syncFailed on the very next attempt instead of retrying. `git merge --abort`
        // is the verified-safe way to clear that stale state: it resets the index/tree back to
        // the pre-merge HEAD (equivalent to `reset --merge`) regardless of how far the failed
        // merge got, so the restart below re-attempts the WHOLE merge fresh — exactly mirroring
        // the rebase side's true restart-from-scratch case, just paying the merge's cost twice
        // instead of trusting unverifiable partial state.
        // plan 3974 (gpt-review round 2, 85b322/581629): the abort can hit the SAME lock the
        // retry is waiting out. Swallowing that would let the next `git merge` fail on "You have
        // not concluded your merge" — a message that matches neither LOCK_RX nor UNMERGED_RE — and
        // fall straight through to syncFailed with retry budget unspent. So a lock-shaped abort
        // failure is itself a counted, backed-off retry of the abort, and any OTHER abort failure
        // is reported as the sync failure it is (with the abort's own text), never masked.
        let abortFailure = null;
        while (mergeBearing && mergeHeadExists(wtPath)) {
          try {
            runMergeAbort();
          } catch (abortErr) {
            const abortMsg = errText(abortErr);
            if (LOCK_RX.test(abortMsg) && lockRetry < REBASE_LOCK_RETRY_DELAYS_MS.length) {
              sleepSync(jitteredDelayMs(REBASE_LOCK_RETRY_DELAYS_MS[lockRetry]));
              lockRetry++;
              continue;
            }
            abortFailure = { ...c, e: abortErr, conflicted: false };
            break;
          }
        }
        if (abortFailure) {
          failure = abortFailure;
          break;
        }
        pending = resumable ? 'continue' : 'start';
        continue;
      }
      failure = c;
      break;
    }
  }
  // plan 3974: the marker is provenance for a KILLED run only — every classified exit clears it,
  // a conflict halt included (the author now owns that rebase state, not the spine).
  clearSpineRebaseMarker(wtPath);
  if (failure) {
    if (!failure.conflicted) {
      // plan 3090: the rebase/freshen failed WITHOUT leaving unmerged paths — an
      // index.lock/ref-lock race on the shared .git, a rerere failure, a hook error, a
      // killed child. This is NOT "no conflict" (which would silently read as a clean
      // sync via `conflicted: false` alone) — it is a distinct failure that must be
      // surfaced, not swallowed. Never throw from here — the caller expects a
      // classified result. Channel-flattening goes through coord-git's `errText`
      // (already imported + used 4x in this file) rather than a third inline copy of
      // the idiom: a later fix to how git error channels are rendered then lands in
      // ONE place instead of silently missing this diagnostic path.
      const syncDetail = [
        errText(failure.e).trim(),
        // plan 3974: the classifier could not read the tree, so the halt names that too
        failure.statusUnknown ? failure.status : '',
      ]
        .filter(Boolean)
        .join('\n');
      return {
        conflicted: false,
        conflictCommits: failure.conflictCommits,
        abortedOnce: false,
        mergeBearing,
        rebasedOntoSha,
        syncFailed: true,
        syncDetail,
        lockRetry,
      };
    }
    return {
      conflicted: true,
      conflictCommits: failure.conflictCommits,
      abortedOnce: false,
      mergeBearing,
      rebasedOntoSha,
      // plan 1000: name the sibling plan(s) that landed each conflicted file (the seam
      // reporter renders this), so the driver no longer guesses the culprit. Paths come from
      // the SAME `status` porcelain that set `conflicted` — no second git call, no divergence.
      culprits: conflictCulpritsFor(wtPath, base, failure.status),
      lockRetry,
    };
  }
  // plan 3090: belt-and-braces post-condition — the sync's contract is that
  // rebasedOntoSha (the origin/master tip captured BEFORE the rebase/freshen above,
  // plan 2433) is now an ancestor of HEAD. A rebase/merge that returns success but
  // silently did not take (e.g. a swallowed no-op) must not read as a clean sync via
  // any future path either. Address rebasedOntoSha directly, NEVER the literal
  // 'origin/master' ref name — see the plan-2433 comment above `rebasedOntoSha`'s
  // capture: a sibling's fetch landing here would re-resolve a NEWER tip and
  // silently decouple this check from what the rebase/freshen actually rebased onto.
  try {
    tryRun(wtPath, ['merge-base', '--is-ancestor', rebasedOntoSha, 'HEAD']);
  } catch (e) {
    const syncDetail = (
      `sync post-condition failed: captured origin/master tip is not an ancestor of HEAD — ` +
      `the rebase/freshen did not take. ` +
      errText(e)
    ).trim();
    return {
      conflicted: false,
      conflictCommits: 0,
      abortedOnce: false,
      mergeBearing,
      rebasedOntoSha,
      syncFailed: true,
      syncDetail,
      lockRetry,
    };
  }
  // plan 502: the pre-push hooks (lint-board / lint-plan-index) validate the
  // COMMITTED board/INDEX on origin/master, so a SIBLING's drift there rejects
  // OUR push — classify it (rebaseSeam → recoverable LAND_BLOCKED) instead of
  // letting the raw git exit escape as a stack trace.
  try {
    tryRun(wtPath, ['push', '--force-with-lease', 'origin', branch]);
  } catch (e) {
    const pushDetail = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`.trim();
    return {
      conflicted: false,
      conflictCommits: 0,
      abortedOnce: false,
      mergeBearing,
      rebasedOntoSha,
      pushBlocked: true,
      pushDetail,
      lockRetry,
    };
  }
  return {
    conflicted: false,
    conflictCommits: 0,
    abortedOnce: false,
    mergeBearing,
    rebasedOntoSha,
    lockRetry,
  };
}

// plan 988: classify the output of
//   git range-diff origin/master..origin/<branch>  origin/master..<branch>
// (origin's recorded work vs the local branch's work, BOTH relative to the live
// origin/master). A PURE rebase — the SAME reviewed patches re-applied onto a newer
// base — yields one entry PER work commit and EVERY entry pairs as '=' (identical).
// Any other op means the local branch is NOT a clean rebase of origin's work:
//   '!'  a patch changed content, '>'  a commit exists only locally (new work),
//   '<'  a commit was dropped vs origin. Empty / unparseable output ⇒ 'new-work'
// (conservative — never auto-discard commits we cannot prove redundant).
// Returns 'rebase-unpushed' | 'new-work'.
export function classifyAheadRangeDiff(rangeDiffOutput) {
  const lines = (rangeDiffOutput || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return 'new-work';
  for (const line of lines) {
    // each entry line: "<n>:  <sha> <op> <n>:  <sha> <subject>", op ∈ {= ! < >};
    // a '<'/'>' entry carries a "-:  -------" placeholder on the absent side. A '!'
    // entry is followed by an interdiff body whose lines do NOT match this shape →
    // they are caught as unparseable below (we have already returned by then anyway).
    const m = line.match(/^[\d-]+:\s+\S+\s+([=!<>])\s+[\d-]+:/);
    if (!m || m[1] !== '=') return 'new-work';
  }
  return 'rebase-unpushed';
}

// plan 3503 gpt-review round 2 (45f0e7/84f6f3): the READ-ONLY classification half shared by
// ordinary land recovery and `--prep --no-rebase`. This helper has NO reset (or any other
// worktree/branch write) path: it may refresh remote-tracking refs when `mayFetch` is true, then
// only reads the ahead range + range-diff. Keeping that one classifier prevents prep from banking
// proofs under a recovery classification the land itself would reject. A failed range-diff is
// deliberately `new-work`, the safe refusal direction.
export function inspectRebasedUnpushed(wtPath, branch, { mayFetch = true } = {}) {
  if (mayFetch) run(wtPath, ['fetch', 'origin']);
  const aheadShas = run(wtPath, ['rev-list', `origin/${branch}..${branch}`]);
  if (!aheadShas) return { ahead: false, classification: 'not-ahead', aheadShas: '' };
  try {
    const rd = run(wtPath, [
      'range-diff',
      '--no-color',
      `origin/master..origin/${branch}`,
      `origin/master..${branch}`,
    ]);
    return { ahead: true, classification: classifyAheadRangeDiff(rd), aheadShas };
  } catch {
    return { ahead: true, classification: 'new-work', aheadShas };
  }
}

// plan 988: self-recover a rebased-but-unpushed worktree branch left by a crashed land.
// A prior land attempt can rebase the branch onto an advanced origin/master and then DIE
// before the rebased tip is pushed — origin/<branch> stays at the pre-crash rebase while
// the local branch is ahead. The next land's preflight then sees `origin/<branch>..<branch>`
// non-empty and would hard-fail "branch has unpushed commits", even though it is the SAME
// reviewed diff on a newer base (NOT new un-reviewed work). Distinguish the two via
// range-diff (classifyAheadRangeDiff): a pure rebase is recovered by resetting the branch
// to origin/<branch>, so the subsequent syncBranchOntoMaster redoes the rebase + force-push
// and the land proceeds; genuinely-new/changed unpushed work is left untouched and the
// caller still blocks. Idempotent: a plain re-run after a crash self-clears.
// Returns:
//   { ahead:false }                                   — origin/<branch> == <branch>, nothing to do
//   { ahead:true,  recovered:true }                   — pure rebase; branch reset to origin/<branch>
//   { ahead:true,  recovered:false, aheadShas:'…' }   — real unpushed work; caller must BLOCK
export function recoverRebasedUnpushed(wtPath, branch) {
  const inspection = inspectRebasedUnpushed(wtPath, branch, { mayFetch: true });
  if (!inspection.ahead) return { ahead: false };
  if (inspection.classification !== 'rebase-unpushed') {
    return { ahead: true, recovered: false, aheadShas: inspection.aheadShas };
  }
  // drop the unpushed rebase; syncBranchOntoMaster re-rebases onto the live origin/master
  // and force-pushes, so origin/<branch> == <branch> again — the land is idempotent.
  run(wtPath, ['reset', '--hard', `origin/${branch}`]);
  return { ahead: true, recovered: true };
}

// Pre-land health-guard. Hard-stops (throws, with .reason) when the shared main
// tree is in any state that historically COMPOUNDED the wedge instead of failing
// loudly. The caller converts the throw into a named HANDOFF:LAND_BLOCKED seam.
//   orphan-autostash : a REAL git autostash entry is undropped — the stash SUBJECT is
//                      literally `autostash` (the shape rebase/merge `git stash store -m
//                      autostash` writes). Matched subject-exact via parseStashList ON
//                      PURPOSE (plan 1863): a human/hook-named park whose message merely
//                      MENTIONS the word (`wip-park-orphan-autostash-completed-…`) must NOT
//                      block — the old `/autostash/i` substring test over the raw list
//                      false-positived on exactly that, machine-wide, twice in session 1713.
//   unmerged-paths   : the tree has UU/AA/DD/… conflict markers
//   unpushed-master  : local master is ahead of origin/master by an empty/opaque commit OR a
//                      commit carrying a non-allowlisted ('other') path (plan 1240 Group B:
//                      ahead-commits touching ONLY sanctioned direct-master surfaces — the
//                      main-checkout-allowlist 'doc' + 'config' classes — no longer block; only a
//                      genuine unpushed seed/code remnant or an unexplained empty commit does, and
//                      the exempt sibling commit is preserved)
// opts.run is an injection seam for tests; defaults to the real git runner.
export function assertLandable(MAIN, { run: _run = run } = {}) {
  const stashes = _run(MAIN, [...STASH_LIST_ARGS]);
  if (parseStashList(stashes).some((s) => /^autostash$/i.test(s.subject))) {
    const e = new Error(
      'orphan autostash present on the shared main tree — a prior landing left a `git stash` ' +
        "undropped. Resolve manually: `git stash show --name-only 'stash@{N}'`, " +
        "`git restore --source='stash@{N}' -- <paths>` (keep newer working-tree copies on " +
        "overlap), then `git stash drop 'stash@{N}'` — see docs/coord/land-spine.md " +
        '(the pre-land guard, `assertLandable`) — before re-landing.',
    );
    e.reason = 'orphan-autostash';
    throw e;
  }
  const status = _run(MAIN, ['status', '--porcelain']);
  if (UNMERGED_RE.test(status)) {
    const e = new Error(
      'shared main tree has unmerged paths (UU/AA/DD/…) — resolve the conflict + commit (or ' +
        '`git merge --abort` / `git rebase --abort`) before re-landing.',
    );
    e.reason = 'unmerged-paths';
    throw e;
  }
  _run(MAIN, ['fetch', 'origin', 'master']);
  // plan 1240 Group B: don't block on the RAW ahead-count. Classify the paths the ahead commits
  // touch — a land only blocks when an ahead commit carries a non-allowlisted ('other') path (a
  // genuine unpushed seed/code remnant) OR is empty/opaque. Ahead commits touching ONLY sanctioned
  // direct-master surfaces (a sibling's hand-committed wiki / handoff / plan-lifecycle / INDEX /
  // .claude config edit) ride to origin outside the queue and must NOT gate the land — nor be
  // dropped: the land itself never pushes local master (syncMain:false since plan 971), so the
  // exempt sibling commit is preserved untouched.
  const aheadShas = (_run(MAIN, ['rev-list', 'origin/master..master']) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (aheadShas.length) {
    const blockingPaths = new Set();
    let opaqueCommit = false; // an empty/no-path ahead commit — cannot be proven queue-exempt
    for (const sha of aheadShas) {
      // Diff each ahead commit against its FIRST parent (`<sha>^`): a normal commit yields its own
      // changes; a MERGE yields the full first-parent diff (everything the merge introduced), where
      // `git diff-tree --name-only` alone would collapse to empty and hide a seed/code payload.
      // core.quotepath=false keeps non-ASCII paths literal. Classify PER COMMIT (not a flat union)
      // so an empty/no-op commit is caught as opaque rather than washing into an all-exempt union.
      const out =
        _run(MAIN, ['-c', 'core.quotepath=false', 'diff', '--name-only', `${sha}^`, sha]) || '';
      const cls = classifyAheadCommit(out.split('\n'));
      if (cls.exempt) continue; // cls.exempt is the block authority (review [0]: no dead field)
      if (cls.empty) opaqueCommit = true;
      else for (const p of cls.nonExempt) blockingPaths.add(p);
    }
    if (blockingPaths.size || opaqueCommit) {
      const nonExempt = [...blockingPaths];
      const bits = [];
      if (nonExempt.length) {
        const sample = nonExempt.slice(0, 5).join(', ') + (nonExempt.length > 5 ? ', …' : '');
        bits.push(
          `an unpushed SEED/CODE remnant (${nonExempt.length} non-exempt path(s): ${sample})`,
        );
      }
      if (opaqueCommit)
        bits.push(
          'an empty/no-op ahead commit (no file changes — an unexplained divergence that cannot be ' +
            'proven queue-exempt)',
        );
      const e = new Error(
        `local master is ${aheadShas.length} commit(s) ahead of origin/master and carries ` +
          `${bits.join(' and ')} — a prior landing that pushed nothing, or un-landed local work. The ` +
          'branch was NOT merged, so this is safe to retry: push/reconcile master (or land the ' +
          'remnant), then re-run done-worktree.',
      );
      e.reason = 'unpushed-master';
      e.aheadShas = aheadShas.join(' ');
      e.blockingPaths = nonExempt;
      throw e;
    }
    // else: EVERY ahead commit touches only queue-exempt docs → allow the land (sibling preserved).
  }
  return { ok: true };
}

// plan 495: land `branch` AND advance the shared local master to the new tip,
// GUARDED against a diverged local master — the structural fix for the plan-493
// raw-crash + half-land (2026-06-09).
//
// The spine's preflight assertLandable runs BEFORE tryRebase and (on the seed lane)
// `landing-lock acquire --wait`; in this shared `.git` a sibling session routinely
// commits to the SHARED local master during that window (a handoff/coord commit), so
// by the time the land runs, local master has diverged from origin/master. The old
// path then merged the branch via landBranchViaEphemeral FIRST (the code reached
// origin) and only afterwards ran `merge --ff-only origin/master` — which aborts on a
// diverged master, throwing a RAW git error from the IO shell with the branch already
// landed → a half-land (code on origin, bookkeeping undone) + confusing stack trace.
//
// This re-asserts landability at the LAST safe moment — BEFORE the ephemeral merge —
// so a divergence halts with the branch UN-merged (assertLandable throws .reason; the
// caller converts it to a recoverable LAND_BLOCKED seam). The post-merge ff-only is
// also wrapped (belt-and-suspenders): if a sibling commits in the residual micro-window
// after the re-check but before the sync, the branch is already on origin, so a typed
// `master-diverged-post-land` error (carrying .landedSha) lets the caller seam cleanly
// with a rebase-then-finish recovery instead of a raw crash.
//
// opts.run injects the MAIN git runner (the spine passes its index.lock-retrying
// gitMain); opts.landFn injects the ephemeral lander (tests stub it). Returns the new
// master tip sha.
//
// plan 971: opts.syncMain (default true) controls whether to advance the SHARED local
// master via syncLocalMaster after the ephemeral merge. done-worktree now runs its WHOLE
// post-merge bookkeeping (close-out commit + board/queue/mint coordWrites) in a dedicated
// ephemeral worktree off origin/master, so the shared main checkout is never the source of
// any push — its local master is advanced OPPORTUNISTICALLY by the spine afterward (skipped
// if dirty) instead of here, where a sibling commit on local master would throw
// `master-diverged-post-land` and needlessly block a land that is already on origin. With
// syncMain:false the merge lands on origin and returns; the shared local master is left to
// the spine's best-effort fast-forward. Default true keeps every other caller + the existing
// land-lib tests unchanged.
export function mergeBranchToMaster(
  MAIN,
  branch,
  summary,
  { run: _run = run, landFn = landBranchViaEphemeral, syncMain = true, expectedHead = null } = {},
) {
  // plan 502: resume-after-merge — if origin/<branch> is ALREADY an ancestor of
  // origin/master, a prior invocation landed it and only the bookkeeping is left
  // (the spine re-enters the merge step on EVERY resume). SKIP the re-merge —
  // assertLandable would otherwise re-block the resume on contention/divergence
  // that the landed branch no longer cares about — and just sync local master.
  if (branchAlreadyLanded(MAIN, branch, { run: _run, tip: expectedHead })) {
    const sha = landedMergeSha(MAIN, branch, { run: _run });
    if (syncMain) syncLocalMaster(MAIN, branch, sha, _run);
    return sha;
  }
  // TOCTOU re-check — throws .reason on a diverged/dirty master BEFORE the branch lands.
  assertLandable(MAIN, { run: _run });
  // plan 3972: `expectedHead` (the tip the spine reviewed and gated) rides into the lander, which
  // refuses to merge any other `origin/<branch>` — see assertExpectedBranchTip.
  const sha = landFn(MAIN, branch, summary, { expectedHead });
  if (syncMain) syncLocalMaster(MAIN, branch, sha, _run);
  return sha;
}

// plan 502: is origin/<branch> already contained in origin/master? True ⇒ a prior
// land merged it (resume case). Any failure (fetch, missing ref) ⇒ false — the
// caller proceeds down the normal land path, which fails loudly on a real problem.
// gpt-review 3972 r2 findings 0c0a29 / ee86ea / e204d3: `tip` — when the caller knows WHICH
// content it means (the spine's reviewed tip / the worktree HEAD) — is what must be contained in
// origin/master, not whatever `origin/<branch>` resolves to now. Without it a branch REWOUND on
// origin to an already-landed commit would read as "landed" and skip the merge (and its
// expectedHead refusal) for content that never reached master. Omitted ⇒ the ref, as before.
// gpt-review 3972 r3 findings 623dee / 7e5442 / 674b1c / bd650b: with `tip`, "landed" ALSO requires
// `origin/<branch>` to still BE that tip. The shortcut returns before the lander, and the lander is
// where assertExpectedBranchTip lives — so a reviewed tip A already on master with the remote
// branch force-pushed to an unreviewed B used to read as landed and close out with B silently
// discarded. Now it reads as NOT landed, the normal path reaches the lander, and the typed
// `branch-tip-moved` refusal fires (the spine routes it to a slot-releasing LAND_BLOCKED).
export function branchAlreadyLanded(MAIN, branch, { run: _run = run, tip = null } = {}) {
  try {
    _run(MAIN, ['fetch', 'origin', 'master', branch]);
    _run(MAIN, ['merge-base', '--is-ancestor', tip || `origin/${branch}`, 'origin/master']);
    if (tip) {
      const remote = String(_run(MAIN, ['rev-parse', `origin/${branch}`]) || '').trim();
      if (remote !== String(tip).trim()) return false; // the branch moved on origin: not landed
    }
    return true;
  } catch {
    return false; // exit 1 = not an ancestor; other failures fall through to the land path
  }
}

// plan 502: best-effort recovery of the ORIGINAL merge sha for the archive note —
// the spine's merge commits are always `Merge <branch>: …` (--no-ff), so a subject
// grep finds it; fall back to the branch tip (still identifies the landed content).
export function landedMergeSha(MAIN, branch, { run: _run = run } = {}) {
  try {
    // --fixed-strings: a branch name with regex metachars must match literally,
    // never be interpreted as a (basic-regex) pattern.
    const found = _run(MAIN, [
      'log',
      'origin/master',
      '--merges',
      '-1',
      '--fixed-strings',
      `--grep=Merge ${branch}:`,
      '--format=%H',
    ]);
    if (found) return found;
  } catch {
    /* fall through to the branch tip */
  }
  return _run(MAIN, ['rev-parse', `origin/${branch}`]);
}

// Post-land sync of the SHARED local master (extracted for the plan-502 skip path).
// Throws the typed `master-diverged-post-land` error (carrying .landedSha) when a
// sibling commit sits on local master — the spine converts it to a recoverable
// LAND_BLOCKED seam; the branch itself is already safe on origin.
function syncLocalMaster(MAIN, branch, sha, _run) {
  _run(MAIN, ['switch', 'master']);
  let detail = null;
  try {
    _run(MAIN, ['merge', '--ff-only', 'origin/master']);
  } catch (e) {
    detail = `${e.stderr || ''}${e.message || ''}`.trim();
  }
  if (detail === null) {
    // plan 502: on the already-landed skip path a sibling commit can leave local
    // master strictly AHEAD of origin/master — the ff-only then SUCCEEDS ("already
    // up to date") but the close-out's pushMaster would push the sibling's unpushed
    // commit. Same hazard class as diverged → same typed error + recovery.
    const ahead = parseInt(
      (_run(MAIN, ['rev-list', '--count', 'origin/master..master']) || '0').trim(),
      10,
    );
    if (!ahead) return;
    detail = `local master is ${ahead} commit(s) ahead of origin/master after the sync`;
  }
  const err = new Error(
    `local master diverged from origin/master AFTER ${branch} landed — the merge IS already on ` +
      `origin/master (${sha}); only the post-merge fast-forward sync of the shared local master ` +
      `failed (a sibling commit landed on it mid-land). The branch is safe; the bookkeeping ` +
      `(archive/board/claim/teardown) is unfinished. Recover: ` +
      `\`git -C "${MAIN}" rebase origin/master && git -C "${MAIN}" push origin master\` — this replays ` +
      `the sibling commit onto the landed tip and pushes it (already-authored work), so local master ` +
      `is no longer ahead; THEN re-run done-worktree --resume LAND_BLOCKED to finish the bookkeeping. ` +
      `(A bare rebase WITHOUT the push leaves local master ahead → the resume re-blocks on unpushed-master.) (${detail})`,
  );
  err.reason = 'master-diverged-post-land';
  err.landedSha = sha;
  throw err;
}
