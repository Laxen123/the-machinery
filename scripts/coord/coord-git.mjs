// scripts/coord/coord-git.mjs
// Shared git machinery for the atomic coordination-file tools (board.mjs,
// index.mjs). One mutation = resolve $MAIN (must be master) → pull → mutate →
// commit ONE file by pathspec → push → retry on non-ff, rolling back the local
// commit (scoped to that one file) on ANY push failure. Commits run with
// HUSKY=0: the pre-commit guard is a no-op on master, and lint-staged is pure
// overhead for a single tool-formatted file (and its stash dance is fragile
// against a dirty $MAIN — see plan-205 close-out). The committed files are in
// .prettierignore (plan-206 Task 1), so skipping lint-staged can't redden
// `prettier --check .`.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { installCoordRerouteOnce } from './ensure-coord-reroute.mjs';
import { resolveCommonDirPath } from './lock-path.mjs';
import { childEnv, gitRepoIsolatedEnv, GIT_REPO_SELECTOR_VARS } from './child-env.mjs';
// plan 4071 T2: the vetapp sparse-cone exclude lists (coordCheckoutExcludedTopLevel /
// planWorktreeExcludedPaths) moved to coord.config.json with an empty core default. This is a
// genuine import CYCLE (coord-config.mjs itself imports `git` from this module) but a safe one:
// both `git` and `loadCoordConfig` are hoisted function DECLARATIONS, and neither module calls the
// other at its own top level (only from inside later function bodies), so ESM's live-binding
// semantics resolve it without a TDZ hazard. `scripts/assert-scripts-self-contained.mjs` (Rule 3)
// only polices imports escaping `scripts/`, never cycles within it.
import { loadCoordConfig } from './coord-config.mjs';
// plan 4087 T2 (S3): derivedReadTimeoutMs (below) reuses T0's percentile fold rather than
// re-parsing the journal a second way. Another safe cycle, same shape as coord-config.mjs
// above: coord-op-stats.mjs imports `coordOpJournalPath` from THIS module, but only inside a
// function body (its `main()`), and `computeCoordOpStats`/`parseJournalText`/
// `listArchiveJournalPaths` are hoisted function declarations used only inside
// `readCoordOpJournalForStats`/`derivedReadTimeoutMs`'s own function bodies below — no top-level
// call on either side, so ESM's live bindings resolve it without a TDZ hazard.
// plan 4087 round-4 review: `readCoordOpJournalForStats` used to grow its archive window by
// re-calling coord-op-stats.mjs's `collectJournalEntries` with an ever-larger `maxArchives`, which
// re-reads every archive already in the window again from disk on every growth step. It now reads
// each archive's raw text itself (via `parseJournalText`, imported here instead), exactly once —
// `collectJournalEntries` is no longer used by this file at all.
import {
  computeCoordOpStats,
  parseJournalText,
  listArchiveJournalPaths,
} from './coord-op-stats.mjs';
import {
  existsSync,
  rmSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve, join, dirname, basename } from 'node:path';
import { hostname } from 'node:os';
// plan 2933: ONE definition of the pre-rebase exemption env, shared by every sanctioned
// MAIN rebase-retry loop (see pre-rebase-main-guard.mjs's own doc comment).
import { sanctionedRebaseEnv } from './pre-rebase-main-guard.mjs';
// plan 2948: the OS process-identity probe plan 2738 already owns (worktree-lock.mjs's
// `processStartToken`) and the `/proc/<pid>/stat` reader it in turn reuses from kill-tree.
// Deliberately imported rather than re-rolled — this repo keeps ONE convention for each, and a
// second copy is precisely the drift `excl-lock` / `atomic-write` were extracted to stop.
// Acyclic: worktree-lock imports lock-path / kill-tree / excl-lock, never coord-git.
import { processStartToken } from './worktree-lock.mjs';
// plan 4087 T1: killProcessTree is the SAME tree-reap primitive spawnWithTreeKill's exit handler
// uses — never a second copy (kill-tree.mjs's own file header names this exact drift class).
import { procStatFields, killProcessTree } from './kill-tree.mjs';

// Matches git's various "the index is locked by another process" messages.
// Deliberately does NOT match a bare "File exists" — git's lock message is
// "Unable to create '…/index.lock': File exists.", already covered by the
// `\.lock` alternatives; a standalone "File exists" could be an unrelated
// Windows filesystem error we must NOT mistake for lock contention.
export const LOCK_RX =
  /index\.lock|Unable to create '.*\.lock'|another git process|Another git process seems to be running/i;

// ── plan 960/980: transient index-WRITE failure (distinct from .lock CONTENTION) ──────────
// `git commit`/`git mv`/`git add` can complete their repository update (commit object + ref move,
// or the working-tree rename) and THEN fail to write `.git/index` with
//   "fatal: repository has been updated, but unable to write new index file."
// On this Windows host a brief antivirus / file-lock on `.git/index` makes the final
// `index.lock`→`index` rename fail transiently. This is NOT lock CONTENTION (git acquired the lock
// fine and DID the work; only the final write failed), so `gitWithLockRetry` retries it on the SAME
// backoff as a lock collision — a brief AV lock clears in ms, and the retry then either succeeds (an
// idempotent op) or surfaces an "already done" signal the call site tolerates (isNothingToCommit for
// the commit, isMvBadSource for the mv). plan 960 first added this for done-worktree's PRIVATE gitMain;
// plan 980 lifts the three classifiers to this single coord-git definition so EVERY coord script that
// routes through gitWithLockRetry / coordWrite / gitMoveCommit inherits the same self-healing (and
// done-worktree-lib.mjs now re-exports them rather than carrying a duplicate). Kept NARROW to git's
// exact wording so an unrelated FS "unable to write" (a genuinely full disk) is not mistaken for
// transient contention and retried — and even then it exhausts to the same clean error, never silent
// data loss.
export function isTransientIndexWrite(msg) {
  return /unable to write new index file/i.test(String(msg || ''));
}

// `git commit` half-land tolerance (plan 960/980). When a commit hits the transient index-write
// above, git has ALREADY created the commit object + moved HEAD ("repository has been updated, but …")
// — only the index write failed. gitWithLockRetry's retried `git commit -- <pathspec>` then finds the
// staged changes already consumed and reports "nothing to commit". That is NOT a real error: the
// commit landed (locally; it was never pushed — the throw unwound before the push). The commit call
// site treats this — AFTER confirming the intended commit is genuinely at HEAD (commitSubjectAtHead)
// — as success and proceeds to push the locally-created commit. Matched on git's exact wordings only.
export function isNothingToCommit(msg) {
  return /nothing to commit|no changes added to commit/i.test(String(msg || ''));
}

// `git mv` half-move tolerance (plan 960/980). The analogue for `git mv from to`: git renames the
// working-tree file (from→to on disk) and THEN fails the index write with the transient above.
// gitWithLockRetry's retried `git mv from to` then dies "fatal: bad source, source=…" because `from`
// is already gone from disk. The mv call site tolerates this ONLY when the move demonstrably already
// happened (`from` absent, `to` present) — the subsequent pathspec commit re-derives the rename from
// the on-disk state, so the lost index update is recovered. A "bad source" with `from` still present
// is a genuine error and surfaces.
export function isMvBadSource(msg) {
  return /bad source/i.test(String(msg || ''));
}

// `git commit -- <pathspec>` half-land (plan 980). When a pathspec commit half-lands (HEAD moved)
// and one of the named pathspecs no longer matches anything on the retry — gitMoveCommit's `from`,
// which is gone once the rename committed — git dies "pathspec '…' did not match any file(s) known
// to git" rather than "nothing to commit". Same already-done signal; the call site tolerates it ONLY
// once the commit is confirmed at HEAD. (coordWrite never hits this: its relPaths persist across the
// commit, so its retry reports the plain "nothing to commit".)
export function isPathspecNoMatch(msg) {
  return /did not match any file/i.test(String(msg || ''));
}

// ── plan 983: transient ref-lock-during-commit race (`cannot lock ref 'HEAD'`) ──────────────
// On the shared `.git` main checkout (~5–7 parallel sessions), a SIBLING session's coord commit can
// move local HEAD between our `git commit`'s HEAD-read and its own ref-write, so git aborts with a
// compare-and-swap mismatch:
//   "fatal: cannot lock ref 'HEAD': is at <new>… but expected <old>…"
// This is the ref-write analogue of `index.lock` CONTENTION: git did NOT move HEAD (the ref CAS
// failed) and did NOT consume the staged content, so the commit did not land — a plain retry, which
// re-reads the now-current HEAD as the parent, succeeds. Matched NARROWLY to the CAS-mismatch wording
// ("is at … but expected …") so a STALE `HEAD.lock` left by a crashed process ("…Unable to create
// '.git/HEAD.lock': File exists", which does NOT self-clear on retry) is NOT mistaken for this
// transient — it routes through LOCK_RX (whose `.lock` alternative matches it) or exhausts to a clean
// error. From the 2026-06-22 plan-977 land: the close-out commit died on exactly this race
// mid-teardown, leaving the merge on master but the worktree un-torn-down. NOTE on idempotence: a
// retried commit re-commits the pathspec's CURRENT working-tree content on the new HEAD. For the
// common mover (board.mjs, which touches board.md, not the committer's pathspec) the retried commit is
// correct; in the rare case the sibling touched our exact pathspec, the existing pre-push
// regenerate-and-diff lint (INDEX) and non-ff push guard reject a stale retry — never a silent land.
export function isRefLockRace(msg) {
  // No trailing space after "but expected" — git appends the sha, but a wrapped/truncated surface
  // that drops it still reads as the CAS-mismatch and should retry, not surface as a hard error.
  return /cannot lock ref .*: is at .* but expected/i.test(String(msg || ''));
}

// ── plan 2471: transient ref-UPDATE race during `git fetch` (distinct git surface from the
// commit-time isRefLockRace above) ──────────────────────────────────────────────────────────
// A sibling session advancing `origin/master` between our `fetch`'s read of the current
// remote-tracking ref and its own write of the updated value makes git abort ONE of the
// updated refs (fetch can still succeed for other refs in the same invocation) with:
//   error: fetching ref refs/remotes/origin/master failed: incorrect old value provided
// This is the fetch-side analogue of isRefLockRace's commit-side CAS mismatch — contention on
// the shared `.git`, not corruption — and self-heals on a plain re-fetch (the now-current
// remote-tracking ref becomes the retry's "old value"). Observed live 2026-07-25 crashing
// land-lib.mjs's `run()` at a bare, unretried `git fetch` (plan 2471). Matched narrowly to
// this exact wording so an unrelated fetch failure (network, auth, unknown ref) is never
// mistaken for the transient and retried.
export function isRefUpdateRace(msg) {
  return /fetching ref .* failed: incorrect old value provided/i.test(String(msg || ''));
}

// The residue sweeps (sweep-stray-stashes.mjs, sweep-acquire-residue.mjs) share ONE exit
// contract, and it lives here because heal-main.mjs delegates to BOTH and has to read it:
// 0 = nothing to surface, this code = residue was SURFACED for a human to inspect (never
// auto-dropped), any other non-zero = the tool itself broke. A caller that treats the
// surfaced code as a failure turns an advisory into a false "needs the operator".
export const SWEEP_SURFACED_EXIT = 3;

// Flatten an execFileSync error's channels into one searchable string for the classifiers above
// (git writes its fatal message to stderr, but message/stdout are included for robustness).
export function errText(e) {
  return `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
}

// The OPERATOR-facing companion to errText (plan 3205): the same channels flattened to ONE short
// line, for a warning or refusal that must NAME why a git step failed without pasting git's whole
// multi-line diagnostic into a gate's summary. errText stays the matching surface (the classifiers
// above grep it and must keep seeing everything); this is the printing surface. Lives here, beside
// errText, because three separate tools needed the identical "first meaningful line, truncated"
// formatting the moment they stopped swallowing their fetch failures — and three copies of an
// error-formatting rule is exactly the drift errText itself was extracted to stop.
export function errSummary(e, { max = 200 } = {}) {
  const first =
    errText(e)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) || 'unknown error';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

// A `--force-with-lease` compare-and-swap rejection ("stale info"): the remote ref moved
// between the caller's read and its push — CONTENTION (re-read and re-judge), never an
// infra failure. Shared by the ref-CAS family (release-claim's lease-pinned delete,
// spec-sweep-lock's takeover/release — plan 1915) so a future git rewording is fixed in
// exactly one place instead of silently splitting the two mutexes' behavior.
export function isStaleInfo(e) {
  return /stale info/i.test(errText(e));
}

// Read the commit object a REMOTE ref points at: { sha, body } | null when unheld.
// The four-step plumbing (ls-remote for the sha → fetch to bring the object local →
// cat-file commit → body after the first blank line) is the shared read half of every
// reserve-by-push lock (claim-plan's refs/claims/<id> readHolder, spec-sweep-lock's
// refs/coord/spec-sweep-lock — plan 1915). Tolerates the ref VANISHING between the
// ls-remote and the fetch (the holder released in that window): re-checks and returns
// null instead of surfacing a raw fetch error for a ref that is genuinely unheld now.
export function readRemoteRefCommit(mainDir, ref) {
  const env = { HUSKY: '0' }; // plan 2604: gitRaw's spawnEnv supplies+scrubs process.env
  const ls = git(mainDir, ['ls-remote', 'origin', ref]).trim();
  if (!ls) return null;
  const sha = ls.split('\t')[0];
  try {
    git(mainDir, ['fetch', '--quiet', 'origin', ref], { env });
    const raw = git(mainDir, ['cat-file', 'commit', sha]);
    const i = raw.indexOf('\n\n');
    return { sha, body: i === -1 ? '' : raw.slice(i + 2) };
  } catch (e) {
    if (!git(mainDir, ['ls-remote', 'origin', ref]).trim()) return null; // released mid-read
    throw e;
  }
}

// ── plan 1771: NUL-fill corruption of shared .git metadata (config / remote-tracking refs) ──
// Three incidents in one week (2026-07-07/09/13): a `.git` metadata text file becomes
// NUL-filled (the crash zero-fill class), and every session on the clone dies with one of
// exactly two confusing wordings — `fatal: bad config line 1` (corrupt `.git/config`; kills
// ALL git commands) or `did not send all necessary objects` (a NUL-filled remote-tracking
// ref poisoning fetch/pull — two steps removed from the cause). Matched NARROWLY to those
// two observed wordings so an unrelated failure is never blamed on corruption. Neither
// condition EVER self-heals by retrying, so gitWithLockRetry also short-circuits on it.
export function isMetadataCorruption(msg) {
  return /bad config line|did not send all necessary objects/i.test(String(msg || ''));
}

// The pointer appended wherever the corruption is recognised — appended, never a
// replacement: callers classify on the original error object's stdout/stderr/message
// channels (isNonFastForward etc.), which must survive intact.
export const METADATA_HEAL_HINT =
  '\n[coord-git] this matches the plan-1771 NUL-fill corruption of shared .git metadata — ' +
  'run `node scripts/git-metadata-heal.mjs --detect`, then `--repair` to heal the safe subset.';

// Annotate-and-return: appends the heal pointer to the error's message when the failure
// matches the corruption class (idempotent — a retry loop may pass the same error twice).
export function annotateMetadataCorruption(e) {
  if (isMetadataCorruption(errText(e)) && !String(e?.message || '').includes('git-metadata-heal'))
    e.message += METADATA_HEAL_HINT;
  return e;
}

export function parseArgs(argv) {
  const cmd = argv[0];
  const positionals = [];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positionals.push(a);
  }
  return { cmd, positionals, flags };
}

// plan 1769: the ONE shared value-aware flag parser, alongside (NOT replacing) the subcommand
// parseArgs above. Extracted to the ADOPTED module scripts/coord/parse-flags.mjs by plan 1777 (its
// header carries the full semantics + the import rule: adopted files import it from there,
// vetapp-only files may keep importing it from here) and re-exported so every pre-1777
// importer of this module is unchanged.
export { parseFlags, assertOneOf } from './parse-flags.mjs';

// plan 810: On this Windows host (`credential.helper=manager`, Git Credential Manager) an
// ephemeral `git fetch`/`push`/`ls-remote` can pop an INTERACTIVE GUI credential dialog even
// while a valid token is cached. The done-worktree spine runs non-interactively, so the dialog
// is cancelled → `fatal: User cancelled dialog` → `Authentication failed` → the spine crashes
// mid-merge (observed twice on plan 774, 2026-06-18). Pass this env to EVERY git child the spine
// spawns: `GCM_INTERACTIVE=never` tells GCM to never prompt (use the stored token or fail) and
// `GIT_TERMINAL_PROMPT=0` disables git's own terminal prompt. A valid cached token is then used
// silently; a genuinely-absent/expired one fails FAST with a clear non-interactive error instead
// of a GUI hang that crashes the land. (Probed empirically: GIT_TERMINAL_PROMPT alone still let
// GCM hang on a re-prompt — both vars are needed.) Single source of truth, imported by the
// done-worktree spine and land-lib so every git spawn carries it.
export const GIT_NONINTERACTIVE_ENV = { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };

// plan 844 / 850: a large-data land (the multi-page render store, 11k+ changed files) makes
// `git diff --name-only` / `git show --name-only` / `git ls-files` etc. exceed execFileSync's
// 1MB default stdout buffer → ENOBUFS, crashing the spine mid-land. 512 MB is the single,
// generous value every git/child runner in the landing toolchain uses — imported across the
// spine scripts so there is ONE place to bump it. A caller can still override per-call via opts.
export const GIT_MAXBUFFER = 512 * 1024 * 1024;

// ── plan 1863: the ONE stash-list read + parser every coordination script shares ──────────────
// `git stash list` is read tab-delimited (`%gd<TAB>%gs` — ref, subject) so a consumer can match
// a stash's SUBJECT exactly instead of regexing git's default `%gd: %gs` oneline rendering
// (the substring test over that rendering is how assertLandable's orphan-autostash guard
// false-positived on a park NAME that merely mentioned the word). Both the format literal and
// the parser live here — land-lib.mjs (pre-land guard) and sweep-stray-stashes.mjs (stray-WIP
// sweep) import them, so the two can never drift apart.
export const STASH_LIST_ARGS = Object.freeze(['stash', 'list', '--format=%gd%x09%gs']);

// Parse `git stash list --format=%gd%x09%gs` (ref<TAB>subject) into { ref, subject } objects.
export function parseStashList(raw) {
  return raw
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab === -1) return { ref: line.trim(), subject: '' };
      return { ref: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() };
    });
}

// ── plan 1455: fallback committer identity for an identity-less host ──────────────────────────
// Every coordWrite-routed commit (plan claim, done-worktree land, record-review, record-wiki)
// runs `git commit` through git() below, and git derives the author/committer from the AMBIENT
// git identity (`user.name`/`user.email`, local OR global config). On the operator's machine and
// the orchestrate Opus workers that identity always exists, but an identity-less host — a fresh
// container running `orchestrate`, a newly-provisioned contributor machine before its first
// `git config --global user.email`, another CI provider — hits `fatal: empty ident name` on ANY
// coord commit. Plan 1451 patched this in `.github/workflows/ci.yml` (a global identity step) for
// the one CI env; this is the STRUCTURAL fix in the canonical script every sibling repo inherits.
// The identity is the same github-actions[bot] pair ci.yml uses (plan 1451 review [6]: one
// canonical CI identity, not a second invented bot) — these coord commits are ephemeral bookkeeping
// on a host that has declined to configure authorship, so the cosmetic value is immaterial; what
// matters is that the commit SUCCEEDS instead of fatalling.
export const COORD_FALLBACK_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
});

// plan 4087 T5 review fix (keys gheyjr/1qx8goa/y2bcmu): gitRepoIsolatedEnv()'s own contract
// (child-env.mjs) is that its `settings` argument is a LITERAL CONSTANT written at the call
// site, never inherited environment — every OTHER caller in this repo honours that (a bare
// call, or one passed a hand-written object like GIT_NONINTERACTIVE_ENV). gitRaw below was the
// one place that contract was broken: it handed gitRepoIsolatedEnv the CALLER's whole opts.env,
// which most callers build as `{ ...process.env, HUSKY: '0' }` (move-plan.mjs, stamp-lib.mjs,
// drain-run.mjs, coord-edit.mjs, and most other callers of this seam — verified by grepping
// `...process.env` under scripts/ during this fix) — an ambient GIT_DIR/GIT_WORK_TREE/
// GIT_COMMON_DIR/GIT_INDEX_FILE copied along in that spread rides on TOP of
// gitRepoIsolatedEnv's own base-strip and reintroduces exactly the variable the strip removed.
//
// This strips a repo-selector key from the caller's env layer ONLY when its value is IDENTICAL
// to the CURRENT process.env value for that same key — the signature of "this was copied from
// process.env", not deliberately set. A caller with a genuinely different value (drain-status.mjs
// builds `{ GIT_INDEX_FILE: <fresh scratch path>, HUSKY: '0' }` as a literal object to redirect
// git's index work off the caller's real one — the ONE deliberate repo-selector override found by
// that same grep) keeps it, because a freshly-generated temp path can never equal whatever (if
// anything) process.env.GIT_INDEX_FILE already holds. This cannot be fooled by an omitted key
// (undefined !== a set ambient value) or an absent ambient var (undefined !== a caller-set value).
//
// plan 4087 round-2 review (finding: env scrub misses lowercase/mixed-case keys on Windows): the
// exact-uppercase name match above (`name in out`) is right on POSIX, where `Git_Dir` and
// `GIT_DIR` are two genuinely distinct variables, but wrong on win32, where environment variable
// NAMES are case-insensitive at the OS level — a caller's layer spreading an ambient var under a
// different case (`Git_Dir`, `git_dir`, …) still reaches the spawned git child as `GIT_DIR` once
// merged into the process env block, so the strip must match case-insensitively there too, or the
// inherited selector rides through untouched. `platform` is an injected PARAMETER (per this
// repo's platform-as-parameter test rule), defaulting to the real `process.platform`, so a test
// can exercise the win32 branch without running on Windows.
const GIT_REPO_SELECTOR_VARS_LOWER = new Set(GIT_REPO_SELECTOR_VARS.map((n) => n.toLowerCase()));
export function stripInheritedRepoSelectors(layer, { platform = process.platform } = {}) {
  const out = { ...layer };
  if (platform !== 'win32') {
    for (const name of GIT_REPO_SELECTOR_VARS) {
      if (name in out && out[name] === process.env[name]) delete out[name];
    }
    return out;
  }
  // win32: match case-insensitively on both sides — the caller's key (any case) against the
  // canonical selector names, and the ambient lookup (any case process.env happens to carry the
  // var under) against that same key. Built once per call; process.env is small (tens of
  // entries), so this costs nothing on the hot coord-checkout git path.
  const ambientLower = new Map();
  for (const k of Object.keys(process.env)) ambientLower.set(k.toLowerCase(), process.env[k]);
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase();
    if (!GIT_REPO_SELECTOR_VARS_LOWER.has(lower)) continue;
    if (out[key] === ambientLower.get(lower)) delete out[key];
  }
  return out;
}

// The low-level git runner — behaviour-identical to the pre-1455 git(): spawn `git -C <dir>` with
// the caller's opts, forcing GIT_NONINTERACTIVE_ENV last. git() wraps this with the identity probe;
// probeIdentityFallbackEnv itself calls gitRaw (NOT git) so the probe can never recurse.
function gitRaw(mainDir, args, opts = {}) {
  const { env, ...rest } = opts;
  // GIT_NONINTERACTIVE_ENV is passed LAST so the suppression is forced regardless of any ambient
  // or caller-supplied value, while a caller's other env (e.g. HUSKY=0) is preserved.
  // plan 2604: composed by spawnEnv, which merges the layers over process.env and scrubs the
  // RESULT. Neither a caller's pre-scrubbed object nor a scrub used as a BASE can achieve that —
  // absence loses to presence in a spread, so anything layered on afterwards re-supplies the very
  // var that was removed. See scripts/coord/child-env.mjs for both failed shapes.
  //
  // plan 4087 T5: spawnEnv's own scrub (CHILD_ENV_STRIP) is EMPTY of git vars, so
  // spawnEnv(env, GIT_NONINTERACTIVE_ENV) dropped no GIT_* names at all — an ambient GIT_DIR /
  // GIT_WORK_TREE / GIT_COMMON_DIR (a parent shell's, or one a git HOOK exports into every
  // subprocess) OVERRIDES the `-C mainDir` right above and silently redirects this call, and
  // EVERY coord git spawn goes through this function, at every claim CAS / board write / push.
  // gitRepoIsolatedEnv() strips exactly GIT_REPO_SELECTOR_VARS from `process.env` as the BASE,
  // THEN layers its `settings` argument on top — correct ONLY when that argument is a literal
  // constant, per its own contract (child-env.mjs). The caller's `env` here is NOT that: most
  // callers of this seam build it as `{ ...process.env, HUSKY: '0' }`, so passing it straight
  // into gitRepoIsolatedEnv's settings position re-supplies whatever ambient repo-selector value
  // that spread just copied, defeating the base-strip the same way the plan 2604 base-scrub
  // mistake did (see that paragraph above). plan 4087 T5 review fix: `env` is passed through
  // stripInheritedRepoSelectors() first (defined just above this function), which drops a
  // selector key ONLY when the caller's value is identical to the ambient process.env value for
  // that name — an inherited copy, not a deliberate override — so a caller that genuinely SETS
  // one (drain-status.mjs's `GIT_INDEX_FILE` redirect to a scratch index, a freshly-built literal
  // object, never a process.env spread) still wins, while a merely-inherited ambient one does
  // not survive. Transport/credential vars (GIT_SSH_COMMAND, GIT_HTTP_PROXY, GIT_CONFIG_*) are
  // deliberately left alone — this call must still push/fetch/pull — see GIT_REPO_SELECTOR_VARS'
  // own header for the incident that ruled out the blanket gitIsolatedEnv() strip here.
  // The outer childEnv() below is NOT redundant, and removing it re-opens plan 2604. Read the
  // 2604 paragraph above literally: its guarantee is that CHILD_ENV_STRIP is scrubbed from the
  // RESULT, so a var a CALLER supplies is dropped too — and a strip used as a BASE cannot do
  // that, because the caller's layer re-supplies it. gitRepoIsolatedEnv is exactly such a
  // base-strip, deliberately, because a caller's DELIBERATE repo selector must survive. The two
  // requirements point in opposite directions and are both real, so they COMPOSE rather than
  // replace: strip the selectors BEFORE the caller's layer (ambient loses, deliberate wins),
  // then strip CHILD_ENV_STRIP AFTER it (caller-supplied loses too).
  //
  // Today the outer call is a no-op only because CHILD_ENV_STRIP is currently `[]`. That is a
  // fact about the list's contents, not a property of the composition, and it is exactly why the
  // call stays: the first name added to that list would otherwise leak through a caller-supplied
  // value with nothing failing — the silent shape 2604 was written to end. Verified at plan 4087
  // T5: with a caller passing ALLOW_LANDED_REVERSION, the old spawnEnv shape and this one
  // produce the same child env.
  //
  // This paragraph lives ABOVE the call, not inside its options object, deliberately: T5's
  // enumeration test reads a fixed window around each git-spawn call site to decide whether the
  // spawn is env-guarded, and a comment block wedged between the call and its `env:` key pushes
  // the evidence out of that window — which is how this exact edit first turned the guard test
  // red against code that was already correct. Keep prose out of the options object here, and
  // keep it free of a literal spawn call the scanner would match as if it were code.
  return execFileSync('git', ['-C', mainDir, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER, // plan 844/850: see GIT_MAXBUFFER — large-data lands overflow the 1MB default
    ...rest,
    env: childEnv(
      gitRepoIsolatedEnv({ ...stripInheritedRepoSelectors(env ?? {}), ...GIT_NONINTERACTIVE_ENV }),
    ),
  });
}

// Cache the probe RESULT per checkout dir, not once globally (plan 1455). `user.name`/`user.email`
// is per-repo config, and a single process legitimately drives several checkouts (the shared MAIN
// and the disposable coord-checkout — and, in the test suite, many throwaway temp repos). A truly
// process-global cache would let the FIRST repo probed dictate every later repo's identity handling
// (an identity-ful repo suppressing the fallback for a later identity-less one, or vice-versa). The
// key is the raw dir string: distinct worktrees of one clone share config, so at worst they probe
// once each — never re-probed on every git() call (the "probe once" the spec asked for).
const _identityFallbackCache = new Map();

// Probe the MERGED (local + global) git identity for `dir` ONCE and cache it. Returns the fallback
// identity env when EITHER `user.name` or `user.email` is absent/empty (→ git() injects it), or null
// when both are configured (→ git() makes NO change, preserving the operator's real authorship — the
// spec's explicit requirement not to clobber a configured identity with an unconditional `-c`).
// `git config <key>` exits non-zero when the key is unset, so any throw ⇒ absent ⇒ fallback.
// Exported (plan 1455 review-fix) so the done-worktree spine — whose commits go through its own
// index.lock-retrying gitMain, NOT this module's git() — can inject the SAME identity fallback on
// an identity-less host instead of reimplementing the probe (the 1455 comment claimed to cover
// "done-worktree land" commits but git() was never on that path). Returns the fallback identity env
// when either user.name/user.email is absent (caller spreads it into the commit env), or null when
// both are configured (caller injects nothing, preserving the operator's real authorship).
export function probeIdentityFallbackEnv(dir) {
  if (_identityFallbackCache.has(dir)) return _identityFallbackCache.get(dir);
  let fallback = null;
  try {
    const email = gitRaw(dir, ['config', 'user.email']).trim();
    const name = gitRaw(dir, ['config', 'user.name']).trim();
    if (!email || !name) fallback = { ...COORD_FALLBACK_IDENTITY };
  } catch {
    fallback = { ...COORD_FALLBACK_IDENTITY }; // an unset key makes `git config` exit non-zero
  }
  _identityFallbackCache.set(dir, fallback);
  return fallback;
}

export function git(mainDir, args, opts = {}) {
  // plan 1770: git() is the single seam every coord push routes through (gitRaw is called only here +
  // by the config-read identity probe; pushMasterWithRebase and gitWithLockRetry both call git()), so
  // it is where the cloud coord-push reroute is installed — only on `push` (fetches MUST keep hitting
  // the proxy). installCoordRerouteOnce owns the once-per-process latch, the inner retry, and the
  // log/catch (shared with done-worktree's up-front call, single source of truth); it is a no-op
  // off-cloud and cheap once latched. See ensure-coord-reroute.mjs for the full mechanism.
  if (args[0] === 'push') installCoordRerouteOnce(mainDir);
  const fallback = probeIdentityFallbackEnv(mainDir);
  // Identity configured → behave EXACTLY as the pre-1455 git() did (no injected env at all).
  if (!fallback) return gitRaw(mainDir, args, opts);
  // Identity absent → inject the fallback identity for this spawn. Precedence (gitRaw spreads
  // process.env first, then this env, then NONINTERACTIVE): process.env < fallback < caller's env,
  // so a caller that genuinely supplies its own GIT_AUTHOR_*/GIT_COMMITTER_* still wins, while a
  // process.env that merely lacks an identity cannot defeat the fallback.
  const { env, ...rest } = opts;
  return gitRaw(mainDir, args, { ...rest, env: { ...fallback, ...env } });
}

// plan 1289: the ONE range-resolution policy for the range-scoped pre-push guards
// (lint-coord-trailer / assert-seed-io-seam / assert-price-gates-single-site).
// Explicit argv ranges (the pre-push hook passes the pushed-delta ranges
// compute-push-diff.mjs resolves; CI passes a single <BASE>..HEAD) are trusted
// verbatim. With no args (a manual invocation), default to origin/master..HEAD —
// or return null (caller SKIPs, fail-open) when origin/master is unresolvable.
// Extracted so the three guards cannot drift on the policy; each had hand-rolled
// its own copy in the first plan-1289 cut. `_git` is a test seam.
export function resolveGuardRanges(repoRoot, argv = process.argv.slice(2), { _git = git } = {}) {
  if (argv.length) return argv; // trust the caller's range(s)
  try {
    _git(repoRoot, ['rev-parse', '--verify', '--quiet', 'origin/master']);
  } catch {
    return null;
  }
  return ['origin/master..HEAD'];
}

// Truly-synchronous sleep (no event loop) — `git()` is execFileSync, so the
// retry loop around it must block the thread. Atomics.wait on a throwaway
// SharedArrayBuffer is the standard sync-sleep; OS-level child processes and
// other sessions' git ops keep running during the wait, so an index.lock held
// by a parallel session CAN clear mid-sleep.
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// plan 2479 finding 3: cache the resolved index.lock path per `dir`, same pattern as
// `_identityFallbackCache` above — a worktree's `.git` layout is stable FOR A GIVEN LIVE WORKTREE,
// so this is safe to memoize for the process lifetime as long as callers evict on a same-path
// remove+recreate (plan 2481's `invalidateIndexLockPath`, called at every site that does one) —
// without that eviction a worktree can be torn down and re-added at the identical `dir` under a
// DIFFERENT admin dir, and this cache would keep watching the dead one. Every `gitWithLockRetry`
// attempt (waitForIndexLock → indexLockPath) previously spawned a fresh `git rev-parse --git-path
// index.lock` child process for the SAME dir; land-lib's ~30 run()-per-land call sites now pay
// that cost once each per land instead of once per attempt. Only SUCCESSFUL resolutions are
// cached — a git failure (`dir` not yet a repo, e.g. mid `worktree add`) must not poison later
// calls once the repo exists.
const _indexLockPathCache = new Map();

// Absolute path to the index.lock for the repo backing `dir`. Uses
// `rev-parse --git-path` so it resolves correctly for both the main checkout
// (`.git/index.lock`) and linked worktrees (`.git/worktrees/<n>/index.lock`).
export function indexLockPath(dir) {
  if (_indexLockPathCache.has(dir)) return _indexLockPathCache.get(dir);
  const rel = git(dir, ['rev-parse', '--git-path', 'index.lock']).trim();
  const resolved = isAbsolute(rel) ? rel : resolve(dir, rel);
  _indexLockPathCache.set(dir, resolved);
  return resolved;
}

// plan 2481: a worktree at `dir` can be removed and recreated mid-process (resolveCoordCheckout's
// crash-recovery path, land-lib's ephemeral land worktrees) and land on a DIFFERENT admin dir (git
// auto-suffixes when the prior admin dir wasn't fully pruned) — evict the memoized entry so the
// next `indexLockPath(dir)` re-resolves instead of watching a path that no longer exists. A no-op
// if `dir` was never cached (never throws).
export function invalidateIndexLockPath(dir) {
  _indexLockPathCache.delete(dir);
}

// plan 871: an ownerless `index.lock` left by a crashed git process never clears on its
// own, so `waitForIndexLock` would poll its whole budget and then `gitWithLockRetry` would
// throw — blocking a commit indefinitely until someone removes the file by hand (observed
// 2026-06-19 session 752: a stale 11:16 lock blocked a data commit). git's index.lock is an
// EMPTY file (no PID inside), so there is no in-band owner to probe; mtime-staleness is the
// only portable signal. A lock that has not been touched in this long is treated as orphaned
// and removed. The threshold is deliberately CONSERVATIVE — a genuinely-active git op rewrites
// the index in well under a second, so a 30s-idle lock is overwhelmingly a crash leftover, and
// the cost of a false positive (removing a lock a live op is about to use) is one more turn
// of the same retry loop, not data loss.
export const STALE_LOCK_MS = 30_000;

// plan 4087 T4-C (ledger: clear-stale-worktree-lock-reports-a-failed-delete-as-a-fresh-lock).
// `clearStaleIndexLock` below used to fold FOUR distinct outcomes into a bare boolean:
// (1) lock path unresolvable, (2) lock gone/unstattable, (3) lock present but still FRESH,
// (4) lock present and provably STALE, but `rmSync` itself THREW (a live handle denies the
// delete — EPERM/EBUSY on Windows; `{force:true}` already swallows a plain "already gone",
// so reaching this catch means the delete genuinely failed, not a benign race). Every caller
// that only checked the `false` return then reported outcome 4 as "still fresh — a live op
// may hold it", which is a FALSE reason for a lock that is provably stale and simply could not
// be removed. This detailed form distinguishes the four so a caller can report the truth;
// `clearStaleIndexLock` stays a thin boolean wrapper (`removed` only) for callers that only
// ever needed the yes/no (heal-main.mjs, waitForIndexLock, healOwnWorktreeIndexLock) — their
// behaviour is unchanged.
export function clearStaleIndexLockDetailed(dir, { staleMs = STALE_LOCK_MS, lockPath } = {}) {
  let p = lockPath;
  if (!p) {
    try {
      p = indexLockPath(dir);
    } catch {
      return { removed: false, outcome: 'unresolvable', path: null, ageMs: null, error: null };
    }
  }
  let st;
  try {
    st = statSync(p);
  } catch {
    // gone between exists-check and stat, or unstattable
    return { removed: false, outcome: 'absent', path: p, ageMs: null, error: null };
  }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < staleMs) {
    return { removed: false, outcome: 'fresh', path: p, ageMs, error: null }; // still fresh — a live op may hold it
  }
  try {
    rmSync(p, { force: true });
    console.error(
      `[coord-git] removed ownerless stale index.lock ` +
        `(idle ${Math.round(ageMs / 1000)}s ≥ ${Math.round(staleMs / 1000)}s threshold): ${p}`,
    );
    return { removed: true, outcome: 'removed', path: p, ageMs, error: null };
  } catch (e) {
    // the lock is provably stale but the delete itself failed (a live handle denies it) —
    // this is NOT "still fresh" and callers must not report it that way (plan 4087 T4-C)
    return { removed: false, outcome: 'delete-failed', path: p, ageMs, error: e };
  }
}

// Remove `dir`'s index.lock IFF it exists AND its mtime is older than `staleMs` (an ownerless
// crash leftover). Returns true when it removed a stale lock, false otherwise (no lock, lock
// still fresh, path/stat/remove failure, OR a stale lock whose delete itself failed — see
// `clearStaleIndexLockDetailed` above for a caller that needs to tell those apart). Never
// throws — a failure to clear simply falls back to the caller's normal lock-wait. Logs loudly
// when it does remove one so the action is never silent. `lockPath` may be passed to avoid
// re-resolving it inside the poll loop.
export function clearStaleIndexLock(dir, opts = {}) {
  return clearStaleIndexLockDetailed(dir, opts).removed;
}

// Poll until `dir`'s index.lock is absent, up to `attempts` × `delayMs`.
// Returns true if the lock is clear (or never existed / path unresolvable),
// false if it was still held after exhausting the budget. Never throws.
// plan 871: at each poll, if the lock exists but is mtime-stale (ownerless crash
// leftover) it is removed and we return true — so a stuck lock no longer burns the
// whole budget and then wedges the commit. Pass `staleMs: null` to disable the
// stale-clear and poll for absence only (the pre-871 behaviour).
export function waitForIndexLock(
  dir,
  { attempts = 10, delayMs = 500, staleMs = STALE_LOCK_MS } = {},
) {
  let lockPath;
  try {
    lockPath = indexLockPath(dir);
  } catch {
    return true; // can't resolve the lock path → don't block the caller
  }
  const tryStaleClear = () => staleMs != null && clearStaleIndexLock(dir, { staleMs, lockPath });
  for (let waited = 0; waited < attempts; waited++) {
    if (!existsSync(lockPath)) return true;
    if (tryStaleClear()) return true;
    sleepSync(delayMs);
  }
  if (!existsSync(lockPath)) return true;
  if (tryStaleClear()) return true;
  return !existsSync(lockPath);
}

// Run a git command, but first wait for any in-flight index.lock to clear
// (another parallel session mid add/commit/stash/pull on the SAME shared
// `.git` — the structural collision class plan 230 closes). If git still
// fails with a lock-contention message (the check→exec race: a sibling grabbed
// the lock between our `existsSync` and git's own acquisition), back off and
// retry the whole sequence. plan 980: ALSO retry a TRANSIENT index-WRITE failure
// (`unable to write new index file`) on the same backoff — git acquired the lock
// fine and DID the work, only the final `.git/index` write failed (a brief Windows
// AV/file-lock on the index). plan 983: ALSO retry a TRANSIENT ref-lock race
// (`cannot lock ref 'HEAD': is at X but expected Y`) — a sibling moved local HEAD between
// this commit's HEAD-read and its ref-write, so the commit did NOT land; the retry re-reads
// the now-current HEAD and succeeds. plan 2471: ALSO retry the fetch-side analogue
// (`fetching ref … failed: incorrect old value provided`) — a sibling advanced origin/master
// between our fetch's read and write of the remote-tracking ref; the retry re-fetches against
// the now-current value and succeeds. Surfaces a clean, attributable error if none clear.
// A non-lock, non-transient git failure is re-thrown immediately, untouched.
// opts: { attempts=10, delayMs=500, _git=git, ...execFileSyncOpts }. `_git` is a test
// seam (the real low-level git runner by default) so the retry loop can be driven
// without a real transient-index-write failure, which cannot be provoked on demand.
export function gitWithLockRetry(
  dir,
  args,
  { attempts = 10, delayMs = 500, _git = git, ...gitOpts } = {},
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    waitForIndexLock(dir, { attempts, delayMs });
    try {
      return _git(dir, args, gitOpts);
    } catch (e) {
      const out = errText(e);
      // plan 1771: corrupt shared .git metadata never self-heals by retrying — annotate with
      // the git-metadata-heal pointer and surface immediately instead of burning the backoff.
      if (isMetadataCorruption(out)) throw annotateMetadataCorruption(e);
      // not a lock problem AND not the transient index-write AND not a ref-lock/ref-update race — surface as-is
      if (
        !LOCK_RX.test(out) &&
        !isTransientIndexWrite(out) &&
        !isRefLockRace(out) &&
        !isRefUpdateRace(out)
      )
        throw e;
      lastErr = e;
      sleepSync(delayMs);
    }
  }
  const err = new Error(
    `coord-git: \`git ${args.join(' ')}\` blocked by index.lock / transient index-write / ref-lock race / ref-update race after ${attempts} attempts`,
  );
  err.cause = lastErr;
  // plan 2479 finding 2: lift the FINAL attempt's raw stdout/stderr onto the exhaustion error
  // alongside .cause — a caller composing an operator-facing detail from
  // `e.stdout || e.stderr || e.message` (land-lib.mjs's conflictDetail/pushDetail) previously
  // only ever saw this synthetic message on exhaustion, losing git's actual diagnostic. The
  // wording above is unchanged — callers and operators grep the "blocked by index.lock" text.
  err.stdout = lastErr?.stdout;
  err.stderr = lastErr?.stderr;
  throw err;
}

// ── plan 4087 T1: a hard deadline on every coord-checkout git child ──────────────────────────
// `resolveCoordCheckout`'s fetch/reset/clean and `runClaimProjectionRetryLoop`'s own copy of the
// same trio (claim-plan.mjs) run under the coord-write lock with NO outer timeout — a `fetch` or
// `reset --hard` that hangs on I/O or network holds the lock indefinitely (the 10-25 min wedge
// docs/handoff/infra-debt.md records eleven times between 2026-08-30 and 2026-09-13). Per-child
// cap derivation (S8, do not re-derive): git-dominated coord ops measured p95 ~26s over 20h of
// .git/coord-op-journal.jsonl (2026-09-22, plan 4087 T0/S8); 26 x 3 rounded up for headroom.
// NOT currently reused by T3 (review key 108u56a, 2026-09-22): coord-child-probe.mjs's
// HUNG_COORD_CHILD_KILL_AGE_MS is still `null` and heal-main's `--kill-hung-coord-children` CLI
// still requires an explicit `--kill-age-ms=<n>` override — verified by reading
// coord-child-probe.mjs, which neither imports nor reads this constant. Wiring T3's
// kill-eligibility ceiling to this value (coord-child-probe.mjs's own header names it as the plan)
// is future work, not something already done — do not restate it as done here until that file
// actually imports it.
export const COORD_CHECKOUT_GIT_TIMEOUT_MS = 90_000;

// Named failure seam (S7/T1). A coord-checkout git child that outlives COORD_CHECKOUT_GIT_TIMEOUT_MS
// is a WEDGE, not ordinary contention — callers distinguish it STRUCTURALLY (err.code /
// err.coordCheckoutTimeout), never by message text, matching every other named seam in this file
// (coordContention on acquireCoordLock's own timeout, pushUnverified, reacquireFailed).
export const COORD_CHECKOUT_TIMEOUT = 'COORD_CHECKOUT_TIMEOUT';

// The ONE shared bounded wrapper around gitWithLockRetry for a coord-checkout git child (S7 —
// supersedes the plan's own "## Execution notes" wording, which undercounted the unbounded sites).
// Both resolveCoordCheckout (this file) and claim-plan.mjs's runClaimProjectionRetryLoop call THIS
// function for their fetch/reset/clean steps — never a second, inline timeout+reap copy: that
// duplication is exactly the drift class kill-tree.mjs's own file header exists to prevent, and is
// how the 2026-09-11/09-13 ledger lines (claim-plan acquire trips a cap resolveCoordCheckout alone
// would never reach) happened in the first place.
//
// MECHANISM (verified empirically against this Node, not assumed — see coord-git.test.mjs).
// execFileSync/spawnSync accept a native `timeout` (ms) option: internally, Node polls a deadline
// and — on expiry — kills the DIRECT child and throws with `err.code === 'ETIMEDOUT'` and
// `err.pid` set to the killed child's pid (checkExecSyncError merges the spawnSync result's
// pid/signal/status onto the thrown Error; `err.killed` is NOT set on Windows, so `code` is the
// only reliable discriminator — do not key on `.killed`). gitWithLockRetry's own transient-error
// classifiers (LOCK_RX / isTransientIndexWrite / isRefLockRace / isRefUpdateRace /
// isMetadataCorruption) never match "ETIMEDOUT" text, so a timeout is never mistaken for lock
// contention and never silently retried into a second, equally long hang — it surfaces on the
// FIRST expiry, here.
//
// Native `timeout` kills only the DIRECT child. On Windows a `git fetch` also spawns
// `git-remote-https`, which is not in the same job/process-group the native kill reaches and keeps
// running (and keeps holding whatever made the fetch hang) — this is the exact "no tool can clear
// it" failure T1 exists to remove. killProcessTree (kill-tree.mjs) reaps the rest of the tree:
// win32 `taskkill /pid <pid> /T /F` against the dead child's own pid; POSIX a pid->ppid descendant
// walk + child-first SIGTERM. Passed a minimal ChildProcess-shaped object because execFileSync
// gives us only a pid, not a real ChildProcess — killProcessTree's own contract only reads
// `.pid`/`.killed`/`.exitCode`/`.signalCode` off its argument, so this satisfies it without lying
// about anything killProcessTree would otherwise infer from a live handle.
//
// SYNCHRONOUS BY CONSTRUCTION (the plan's own hard constraint): resolveCoordCheckout's whole
// caller chain (withCoordCheckout -> withCoordLock, and gitRaw's execFileSync) is synchronous, and
// converting any of it to async would ripple through the entire coordination spine — which is
// exactly why this is built on execFileSync's native `timeout` option and NOT on
// spawnWithTreeKill (kill-tree.mjs), which is spawn()-based and asynchronous.
//
// `timeoutMs` is a parameter (never a bare module-constant read) so tests inject a short cap
// instead of racing the real 90s one.
// Shared by boundedGitWithLockRetry and boundedGit below: given a caught error, either rethrow
// it untouched (not a timeout) or reap the child's whole process tree and re-raise it as the
// named COORD_CHECKOUT_TIMEOUT wedge. Extracted so the two callers — one wrapping a whole
// gitWithLockRetry invocation, the other bounding a single raw git() call for a `_git`-shaped
// seam (plan 4087 T2) — cannot drift on the kill+rename mechanics.
function raiseCoordCheckoutTimeout(e, { dir, args, timeoutMs, _killTree }) {
  if (e?.code !== 'ETIMEDOUT') throw e;
  if (Number.isInteger(e.pid)) {
    // Best-effort by contract (killProcessTree itself never throws) — but guard anyway: a
    // reap failure must never mask the timeout error we are about to throw.
    try {
      _killTree({ pid: e.pid, killed: false, exitCode: null, signalCode: null }, { force: true });
    } catch {
      /* killProcessTree already never throws; this is belt-and-braces for an injected seam */
    }
  }
  const err = new Error(
    `coord-git: \`git ${args.join(' ')}\` against ${dir} did not finish within ` +
      `${Math.round(timeoutMs / 1000)}s — killed (tree reaped). This is a coord-checkout WEDGE ` +
      `(${COORD_CHECKOUT_TIMEOUT}), not ordinary contention; if it recurs, inspect the box.`,
  );
  err.code = COORD_CHECKOUT_TIMEOUT;
  err.coordCheckoutTimeout = true;
  err.coordCheckoutTimeoutMs = timeoutMs;
  err.cause = e;
  throw err;
}

export function boundedGitWithLockRetry(
  dir,
  args,
  {
    env,
    _git = git,
    timeoutMs = COORD_CHECKOUT_GIT_TIMEOUT_MS,
    _killTree = killProcessTree,
    ...gitOpts
  } = {},
) {
  try {
    return gitWithLockRetry(dir, args, { env, _git, timeout: timeoutMs, ...gitOpts });
  } catch (e) {
    raiseCoordCheckoutTimeout(e, { dir, args, timeoutMs, _killTree });
  }
}

// plan 4087 T2 (plan S12 / S3's "T2" paragraph — bound the last unbounded coord-checkout git
// call). `ensureCoordSparseCheckout` → `ensureSparseCheckout` issues its OWN unbounded `_git`
// calls (the `rev-parse` read, `sparseConeDirs`'s tree walk, `readSparseState`, and the
// `sparse-checkout set`/`disable` calls routed through `gitWithLockRetry`) inside
// `resolveCoordCheckout`, under the coord-write lock — a hang in any of them reproduces the
// exact wedge T1 removed from the fetch/reset/clean trio. The best-effort try/catch around
// sparse-checkout failures does NOT cover this: a catch handles a THROW, and a hung child never
// throws, it just sits there holding the lock.
//
// A `_git`-shaped seam ((dir, args, opts) => string, the same signature `git`/every `_git`
// parameter in this file already uses) needs no change to ensureSparseCheckout's signature —
// it already accepts `_git` as an injectable parameter. Every individual git child spawned
// through this wrapper (not the function as a whole — `ensureSparseCheckout` makes several
// calls) is capped at `timeoutMs`; on expiry the tree is reaped and the same named
// COORD_CHECKOUT_TIMEOUT seam boundedGitWithLockRetry raises is raised here too, so a caller
// catching one catches both. Never used for `ensurePlanSparseCheckout` (plan-worktree cuts) —
// that caller keeps passing the plain `git` default, byte-for-byte unchanged.
export function boundedGit(
  dir,
  args,
  {
    timeoutMs = COORD_CHECKOUT_GIT_TIMEOUT_MS,
    _git = git,
    _killTree = killProcessTree,
    ...opts
  } = {},
) {
  try {
    return _git(dir, args, { ...opts, timeout: timeoutMs });
  } catch (e) {
    raiseCoordCheckoutTimeout(e, { dir, args, timeoutMs, _killTree });
  }
}

// Recognise a push rejected because origin advanced (a parallel session pushed
// to the shared master between our last sync and our push) — vs a hook/other
// failure we must surface. Covers both the push-reject wording and git's
// "Not possible to fast-forward" from a failed ff-only pull.
export function isNonFastForward(e) {
  const out = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
  return /non-fast-forward|fetch first|\[rejected\]|! \[remote rejected\]|not possible to fast-forward|cannot be fast-forwarded/i.test(
    out,
  );
}

// Recognise the transient FETCH_HEAD multi-branch race (plan 868). Under ~5–7 parallel
// sessions sharing one `.git`, concurrent `git fetch`es can leave MULTIPLE for-merge
// branches in FETCH_HEAD, so a subsequent `git pull --ff-only` / `git merge FETCH_HEAD`
// dies with `fatal: Cannot fast-forward to multiple branches.` This is NOT an index.lock
// and NOT a non-ff rejection — isNonFastForward deliberately does not match it — but a
// distinct, purely transient condition a clean re-fetch resolves (reproduced twice in one
// pickup, session 818). Kept separate so the retry stays scoped to exactly this error.
export function isMultiBranchFastForward(e) {
  const out = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
  return /fast-forward to multiple branches/i.test(out);
}

// Classify the assertCleanOutsidePathspec refusal (see below): a coordWrite bailed
// because the shared main checkout carried an uncommitted edit to a tracked file
// OUTSIDE the tool's pathspec — typically a sibling session's brief edit-then-commit
// window (e.g. a parallel done-worktree close-out). The refusal ITSELF is a correct
// HARD stop (committing/stashing a foreign edit is unsafe), but from an autonomous
// caller's view the condition is TRANSIENT: the dirt clears in seconds when the
// sibling commits, so a driver should back off and retry rather than die (the
// 2026-06-14 drain crash class, plan 618). Matched on two stable anchors so minor
// wording drift won't break it, and survives a subprocess round-trip (board.mjs
// exits non-zero with the text on stderr; execFileSync surfaces it in e.stderr).
export function isForeignDirtRefusal(e) {
  const out = `${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`;
  return /refusing to run/.test(out) && /OUTSIDE this tool's pathspec/.test(out);
}

// plan 987: the coordWrite-managed coord-doc surface — the files whose UNCOMMITTED dirt in the
// shared main checkout is, under ~5–7 parallel sessions, almost always a SIBLING session's
// transient sub-second coord-write commit-in-progress (a board row, a queue enqueue/dequeue, a
// pickup-plan claim Status-flip, a review marker) rather than the operator's own source edit.
// Mirrors the transient-churn subset of the auto-allowed set scripts/hooks/worktree-guard.sh uses:
// docs/handoff/** as a BLANKET (board.md and the session files live here; landing-queue.md — the
// file whose sub-second sibling dirt crashed the 2026-06-22 plan-981 land — is a one-line
// tombstone since plan 3973, the queue itself living on refs/heads/coord/landing-queue with no
// working-tree footprint at all), docs/INDEX.md, docs/superpowers/{plans,specs}/**,
// wiki/**, WIKI.md. It deliberately EXCLUDES the config member of the guard's set
// (.claude/settings.json): an edit to that IS a real config change a non-`--wait` land must
// hard-stop on, never silently wait out. (Plan 3765 retired the guard's other non-doc member,
// the worktree-guard.sh self-allow, when hook logic moved into review-gated scripts/hooks/.) Paths are git-porcelain
// rels (forward slashes on every platform).
export function isCoordDocPath(p) {
  const s = String(p || '');
  return (
    s.startsWith('docs/handoff/') ||
    s === 'docs/INDEX.md' ||
    s.startsWith('docs/superpowers/plans/') ||
    s.startsWith('docs/superpowers/specs/') ||
    s.startsWith('wiki/') ||
    s === 'WIKI.md'
  );
}

// plan 987: pull the foreign-dirty tracked paths out of an assertCleanOutsidePathspec refusal.
// The refusal lists each path as an indented porcelain entry ("  XY PATH" / "  XY orig -> dest")
// between the "OUTSIDE this tool's pathspec:" header and the "The freshen onto origin/master"
// trailer. Parses the error TEXT (not a structured property) so it survives the SUBPROCESS
// boundary — a coord tool (board.mjs / landing-queue.mjs) exits non-zero with the refusal on
// stderr, exactly as isForeignDirtRefusal already relies on. A rename ("orig -> dest") contributes
// BOTH sides. Returns [] when the text is not a foreign-dirt refusal or no entry parses (→
// classifyForeignDirt then reports not-coord-only, the safe immediate-hard-stop direction).
export function parseForeignDirtPaths(text) {
  const t = String(text || '');
  const marker = "OUTSIDE this tool's pathspec:";
  const hdr = t.indexOf(marker);
  if (hdr < 0) return [];
  let block = t.slice(hdr + marker.length);
  const trailer = block.indexOf('The freshen onto origin/master');
  if (trailer >= 0) block = block.slice(0, trailer);
  const unquote = (p) => {
    const s = p.trim();
    return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s;
  };
  const paths = [];
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Drop the leading porcelain status token ("M" / "MM" / "A" / "R" …) + its following spaces;
    // what remains is the path (or "orig -> dest" for a rename). A line with no status+space run
    // is not a porcelain entry — skip it (defends against stray prose leaking into the block).
    const rest = line.replace(/^\S+\s+/, '');
    if (!rest || rest === line) continue;
    for (const side of rest.includes(' -> ') ? rest.split(' -> ') : [rest]) {
      const p = unquote(side);
      if (p) paths.push(p);
    }
  }
  return paths;
}

// plan 987: classify the foreign dirt behind a refusal. coordOnly ⇔ there IS at least one foreign
// path AND every one is a coord doc (a sibling's transient coord-write — safe to wait out briefly).
// The moment ANY path is real source/config — or nothing parsed — coordOnly is false: the
// non-`--wait` caller then hard-stops immediately (the operator's own edit is never silently
// retried/clobbered; an unparseable refusal falls back to the same safe hard-stop).
export function classifyForeignDirt(paths) {
  const list = (paths || []).filter(Boolean);
  const nonCoord = list.filter((p) => !isCoordDocPath(p));
  return { coordOnly: list.length > 0 && nonCoord.length === 0, paths: list, nonCoord };
}

// Run a coordination op (a board.mjs / index.mjs / landing-queue.mjs shell-out, or any
// fn that drives coordWrite) that may TRANSIENTLY fail with assertCleanOutsidePathspec's
// foreign-dirt refusal — a sibling session's brief uncommitted coord-doc edit in the shared
// main checkout (the 2026-06-14 drain crash class, plan 618). The refusal fires BEFORE any
// mutation (the assert is the first thing coordWrite does), so re-running `fn` after the dirt
// clears is safe and idempotent — nothing partial was written. Jittered backoff (1–8 s, ~15–25 s
// total over the default 6 attempts) desyncs the parallel-session herd. On budget exhaustion
// (a sibling genuinely left an edit uncommitted) throw an error tagged `{ coordContention: true }`
// so the caller can stop CLEANLY rather than dying with a stack trace. Non-foreign-dirt errors
// propagate immediately. Seams (sleep/log/backoff) are injectable for tests. (Moved here from
// drain-run.mjs in plan 665 so both the drain AND the done-worktree --wait spine reuse ONE
// implementation — it lives with isForeignDirtRefusal + backoffMs, its only deps.)
export function retryOnForeignDirt(
  fn,
  {
    attempts = 6,
    label = 'coord op',
    sleep = sleepSync,
    log = (m) => console.error(`[coord] ${m}`),
    backoff = (a) => backoffMs(a, { base: 1000, cap: 8000 }),
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isForeignDirtRefusal(e)) throw e;
      if (attempt >= attempts - 1) {
        const err = new Error(
          `coord-git: ${label} still blocked by a foreign uncommitted edit in the main ` +
            `checkout after ${attempts} attempts — a sibling session left a tracked file ` +
            `uncommitted. Stopping cleanly. ${e.message}`,
        );
        err.coordContention = true;
        err.cause = e;
        throw err;
      }
      const ms = backoff(attempt);
      log(
        `  ${label}: foreign-dirt in main checkout (a sibling's coord write is mid-flight) — ` +
          `retry in ${Math.round(ms / 1000)}s (${attempt + 1}/${attempts})`,
      );
      sleep(ms);
    }
  }
}

// plan 987: the non-`--wait` companion to retryOnForeignDirt. coordWrite's immediate hard-stop on
// ANY foreign dirt was justified (plan 665 G3.2) by "non-`--wait` dirt is most often the OPERATOR's
// own uncommitted edit" — a WRONG assumption under multi-session load, where the dirt is usually a
// SIBLING's transient coord-doc commit-in-progress (board row, queue enqueue/dequeue, claim
// Status-flip, review marker) that self-clears in ms-seconds. done-worktree lands run non-`--wait`
// (the detached-`--wait` refusal guard forbids backgrounded `--wait`), so a sub-second race crashed
// the land and forced a re-drive (the 2026-06-22 plan-981 crash on transient docs/handoff/
// landing-queue.md dirt). Fix: CLASSIFY the dirt by path. Bounded-retry ONLY when EVERY foreign
// path is a coord doc; hard-stop IMMEDIATELY (preserving G3.2) the moment ANY path is real
// source/config — that case IS usually the operator's own edit and must never be silently waited
// out/clobbered. Coord-doc dirt that never clears within the bounded budget → hard-stop tagged
// { coordContention } (done-worktree's clean resumable seam, same as the --wait exhaustion) and
// pointing at sweep-acquire-residue.mjs (a persistent coord-doc flip is an ORPHANED claim from a
// killed session, not a transient race). The budget is deliberately SHORT (default 4 attempts,
// ~3–6 s) — a sibling coordWrite commits in well under a second, so a few attempts absorb the
// window without stalling a land. Seams (attempts/sleep/log/backoff) are injectable for tests and
// composed by done-worktree's coordStep (which shrinks them in --dry-run).
export function retryTransientCoordDirt(
  fn,
  {
    attempts = 4,
    label = 'coord op',
    sleep = sleepSync,
    log = (m) => console.error(`[coord] ${m}`),
    backoff = (a) => backoffMs(a, { base: 700, cap: 3000 }),
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isForeignDirtRefusal(e)) throw e;
      const paths = parseForeignDirtPaths(errText(e));
      const { coordOnly } = classifyForeignDirt(paths);
      // ANY non-coord foreign path (or none parsed) ⇒ likely the operator's own source/config
      // edit ⇒ hard-stop NOW, untouched (the deliberate plan-665 G3.2 behaviour).
      if (!coordOnly) throw e;
      if (attempt >= attempts - 1) {
        const err = new Error(
          `coord-git: ${label} still blocked by uncommitted COORD-DOC dirt in the main checkout ` +
            `after ${attempts} attempts (${paths.join(', ')}). A sibling's transient coord write ` +
            `clears in well under a second, so persistent coord-doc dirt is most likely an ORPHANED ` +
            `claim-flip from a killed session — run \`node scripts/sweep-acquire-residue.mjs\` to GC ` +
            `it, then re-run. ${e.message}`,
        );
        err.coordContention = true;
        err.cause = e;
        throw err;
      }
      const ms = backoff(attempt);
      log(
        `  ${label}: transient coord-doc dirt in main checkout (${paths.join(', ')}) — a sibling's ` +
          `coord write is mid-flight; retry in ${Math.round(ms)}ms (${attempt + 1}/${attempts})`,
      );
      sleep(ms);
    }
  }
}

// Gate the foreign-dirt retry strategy on a `wait` flag (plan 665 G3, refined by plan 987). The
// done-worktree spine wraps its coordWrite-backed steps in this:
//   --wait      → retryOnForeignDirt: retry on ANY foreign dirt with a long budget (~15–25 s). An
//                 autonomous in-process land poll waits out a sibling's edit-then-commit window
//                 regardless of path (the 2026-06-15 plan-661 standalone-spine crash).
//   non-`--wait`→ retryTransientCoordDirt: retry ONLY transient coord-doc dirt with a SHORT bounded
//                 budget (~3–6 s); real source/config dirt still takes coordWrite's immediate
//                 hard-stop (G3.2 preserved). Closes the 2026-06-22 plan-981 crash where a land
//                 (always non-`--wait`) died on a sibling's sub-second coord-doc commit window.
// A thin pass-through so the gate is one testable choke point rather than an `if (wait)` scattered
// across every call site.
export function coordRetry(wait, fn, opts = {}) {
  return wait ? retryOnForeignDirt(fn, opts) : retryTransientCoordDirt(fn, opts);
}

// Fast-forward local master to the origin tip, resilient to the transient FETCH_HEAD
// multi-branch race (plan 868). The drop-in replacement for `git pull --ff-only origin
// master` in the coordination tools, with two changes:
//   1. fetch THEN `merge --ff-only origin/master` — merges a SINGLE ref (the remote-
//      tracking branch), never the possibly-multi-entry FETCH_HEAD, so the
//      "Cannot fast-forward to multiple branches" error cannot arise from the merge
//      itself. (This is the same two-step coordWrite uses for its freshen.)
//   2. the whole fetch+merge is retried on that error anyway — belt-and-suspenders: a
//      stray multi-branch FETCH_HEAD left by a racing fetch is cleared by our own fresh
//      fetch — with jittered backoff to desync the parallel-session herd. index.lock
//      contention is absorbed by the inner gitWithLockRetry.
// Behaviour is otherwise identical to `pull --ff-only`: a clean ff when behind, a no-op
// when up to date, and a surfaced "Not possible to fast-forward" when local master has
// diverged (commits origin lacks) — that is NOT the race, so it is surfaced, not retried.
// Seams (the fetch+merge step, the sleep) are injectable for unit tests.
export function ffMasterFromOrigin(
  mainDir,
  { attempts = 5, env, _ffStep, _sleep = sleepSync } = {},
) {
  const step =
    _ffStep ||
    (() => {
      gitWithLockRetry(mainDir, ['fetch', 'origin', 'master'], { env });
      gitWithLockRetry(mainDir, ['merge', '--ff-only', 'origin/master'], { env });
    });
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      step();
      return;
    } catch (e) {
      if (!isMultiBranchFastForward(e)) throw e; // any other error → surface immediately
      lastErr = e;
      _sleep(backoffMs(i, { base: 300, cap: 4000 }));
    }
  }
  const err = new Error(
    `coord-git: ff-sync of master blocked by the FETCH_HEAD multi-branch race after ${attempts} attempts`,
  );
  err.cause = lastErr;
  throw err;
}

// Push the current master HEAD to origin, surviving concurrent pushes from the
// ~6 parallel sessions on the shared `.git`. On a non-ff rejection: fetch +
// rebase our local commit(s) onto origin/master, then retry. Assumes a CLEAN
// working tree (the caller has already committed its change). A rebase conflict
// is aborted and re-thrown (the caller's commit touched a path a sibling also
// changed — rare for plan-file renames, which own unique paths). Throws if the
// retry budget is exhausted. This is the non-ff analogue of gitWithLockRetry
// (which handles index.lock, not divergence).
// CALLER CONTRACT (plan 1312 / F-002): the non-ff retry below runs `git rebase` DIRECTLY on
// `mainDir` — when that is the shared MAIN checkout, the caller MUST already be serialized
// (hold the coord-write lock — drain-run's makeRenameMoveSync, heal-main's locked core,
// pre-yield-guard — or run inside done-worktree's landing-lock / the disposable
// coord-checkout). This primitive cannot self-acquire the lock: withCoordLock is NOT
// reentrant, and its two heaviest callers (heal-main, pre-yield-guard) invoke it while
// already holding the lock — a self-lock here would deadlock them.
// Each rebase attempt is journaled as an OPEN `push-rebase` coord-op window (pid-stamped,
// closed on done/error), so heal-main's healRebaseResidue can tell a KILLED rebase (open
// window, dead pid → abort immediately) from a LIVE one (open window, live pid → spare)
// by process liveness instead of guessing from directory mtimes — git does not touch
// rebase-merge/rebase-apply mtimes while a rebase sits mid-conflict.
export function pushMasterWithRebase(mainDir, { retries = 8, _git = git } = {}) {
  const env = { HUSKY: '0' }; // plan 2604: gitRaw's spawnEnv supplies+scrubs process.env
  for (let i = 0; ; i++) {
    try {
      _git(mainDir, ['push', 'origin', 'master'], { env });
      return;
    } catch (e) {
      if (!isNonFastForward(e) || i >= retries) throw e;
      gitWithLockRetry(mainDir, ['fetch', 'origin', 'master'], { _git });
      const token = `push-rebase-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
      // plan 2948: stamp the OS process-identity token alongside the pid, so heal-main can
      // answer "is this window's owner still alive" without trusting either machine's clock.
      // Best-effort by construction (`null` on any platform or failure) — an entry without it
      // is exactly a pre-2948 entry, and the checker's clock fallback still reads it.
      journalCoordOp(mainDir, {
        tool: 'push-rebase',
        token,
        phase: 'start',
        processStartTime: selfRebaseOwnerToken(),
      });
      try {
        // plan 2933: mark this rebase as THE sanctioned one, so .husky/pre-rebase's guard
        // stays silent. Without it the guard would fire on every coord write that hits a
        // non-ff retry (edit-plan / index / board / coord-edit all land through here) and be
        // muted within a day — a guard that flags its own recommended replacement is
        // self-discrediting.
        //
        // Deliberately NOT `{ ...env, … }`: `env` here is the PUSH env `{ HUSKY: '0' }`, and
        // spreading it would disable the whole husky chain on this rebase — far broader than
        // the one exemption needed, and a behaviour change (this rebase ran with hooks live
        // before the guard existed). Pass only the exemption.
        gitWithLockRetry(mainDir, ['rebase', 'origin/master'], {
          _git,
          env: sanctionedRebaseEnv(),
        });
        journalCoordOp(mainDir, { tool: 'push-rebase', token, phase: 'done' });
      } catch (re) {
        const annotated = abortRebaseAndDiagnose(mainDir, re, { env, _git });
        journalCoordOp(mainDir, { tool: 'push-rebase', token, phase: 'error' });
        throw annotated;
      }
    }
  }
}

// Abort a failed rebase on `dir` and — when the ABORT ITSELF fails — say what state the
// checkout was left in, loudly, on the original error.
//
// plan 2391: the abort failure used to be swallowed unconditionally
// (`catch { /* nothing to abort */ }`) while only the ORIGINAL rebase error was rethrown.
// Both outcomes look identical to the caller — but they are not: if the abort genuinely
// failed, this checkout can be left DETACHED mid-rebase, and when `dir` is the shared MAIN
// checkout that state silently eats every subsequent commit made here (the rebase replays it
// onto the detached HEAD while refs/heads/master stays stranded; the next pull fast-forwards
// the work off the tip). "Nothing to abort" is still the common, benign case — so we
// distinguish them by ASKING git what state we ended in, rather than assuming the benign one.
//
// Plan 2391 REVIEW (finding 18b60jb): this lives here, as ONE primitive, because the identical
// rebase-retry-on-non-ff loop exists twice on the shared main checkout — pushMasterWithRebase
// above and drain-run's syncIndexOnMaster — and the first cut fixed only the instance. Both
// now call this; a third rebase-retry loop must call it too rather than re-roll the catch.
//
// Returns the (mutated) original error so the caller can `throw` it; never throws itself —
// a diagnosis must not replace the failure it is describing.
//
// Contract detail (review finding ghyvpz/12lthe5): the HEAD probe uses gitWithLockRetry, not
// the bare `git`, because under this repo's parallel-session load a plain rev-parse loses to
// index.lock/ref-lock contention often enough to matter — and if it fails anyway, the error is
// STILL annotated with an explicit "HEAD state could not be determined" diagnosis. Silence was
// the bug; an honest "unknown" beats it.
export function abortRebaseAndDiagnose(
  dir,
  originalErr,
  { env, _git = git, _reattach = reattachMainToMaster } = {},
) {
  let abortErr = null;
  try {
    _git(dir, ['rebase', '--abort'], { env });
  } catch (ae) {
    abortErr = ae;
  }
  if (!abortErr) return originalErr; // the common, benign case ("nothing to abort" / clean abort)

  let head = null;
  let headErr = null;
  try {
    head = gitWithLockRetry(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { env, _git }).trim();
  } catch (he) {
    headErr = he;
  }

  let state;
  let recovery;
  if (head === 'HEAD') {
    originalErr.detachedAfterFailedAbort = true;
    state =
      'this checkout was left DETACHED mid-rebase — a commit made here would be silently lost ' +
      'by the next pull --rebase.';
    // Self-heal through the EXISTING safe primitive rather than a bare `switch`: it reattaches
    // only when the detached HEAD is an ancestor of origin/master or master (nothing stranded)
    // and throws `detachedUnsafe` otherwise, so this can never discard unpushed work.
    try {
      const r = _reattach(dir, { env, _git });
      originalErr.reattached = !!r.reattached;
      recovery = 'Auto-reattach SUCCEEDED (HEAD is back on master).';
    } catch (rr) {
      originalErr.reattached = false;
      originalErr.detachedUnsafe = !!rr.detachedUnsafe;
      // Review finding 1rnavnv: reattachMainToMaster throws for TWO different reasons, and
      // only ONE of them means "unpushed work". `git switch master` also refuses when the
      // failed abort left a dirty working tree — telling that operator to hunt
      // `log master..HEAD` sends them after commits that do not exist. Claim stranded work
      // ONLY when the error actually carries `detachedUnsafe`.
      recovery = originalErr.detachedUnsafe
        ? 'Auto-reattach was REFUSED — the detached HEAD carries commits no branch has. Inspect ' +
          '`git -C <main> log master..HEAD`, push or discard those commits, then run ' +
          '`node scripts/heal-main.mjs`.'
        : 'Auto-reattach FAILED for a reason UNRELATED to stranded commits (most often a dirty ' +
          'working tree left by the failed abort, which makes `git switch master` refuse). ' +
          `Inspect \`git -C <main> status\`, clear it, then run \`node scripts/heal-main.mjs\`.\n` +
          `Reattach error: ${rr.message}`;
    }
  } else if (headErr) {
    originalErr.headStateUnknown = true;
    state = `this checkout's HEAD state could NOT be determined (\`git rev-parse --abbrev-ref HEAD\` also failed: ${headErr.message}).`;
    recovery =
      'Treat the checkout as SUSPECT: it may be DETACHED mid-rebase, where any commit is ' +
      'silently lost by the next pull --rebase. Run `git -C <main> status` and ' +
      '`node scripts/heal-main.mjs` BEFORE committing anything here.';
  } else {
    originalErr.detachedAfterFailedAbort = false;
    state = `HEAD is still attached (${head}), so nothing is stranded — but rebase state may remain on disk.`;
    recovery = 'Check `git -C <main> status` and run `node scripts/heal-main.mjs` if it is dirty.';
  }

  originalErr.abortFailed = true;
  originalErr.message +=
    `\n\ncoord-git (plan 2391): \`git rebase --abort\` ALSO failed and ${state}\n` +
    `${recovery}\nAbort error: ${abortErr.message}`;
  return originalErr;
}

// Did the commit we just attempted actually land at HEAD? The authoritative half-land signal
// (plan 960/980): when a `git commit` hits the transient index-write, git has ALREADY created the
// commit object + moved HEAD before the index write failed, so gitWithLockRetry's retry finds nothing
// staged and throws "nothing to commit". coordWrite + gitMoveCommit tolerate that ONLY when HEAD's
// subject matches the commit they intended — NEVER a bare "nothing to commit" (a no-op or a foreign
// commit could produce that too). `message`'s first line IS the commit subject. Conservative: any
// failure reading HEAD, or an empty subject, → false → the caller rethrows (the safe direction).
// This is the coord-git analogue of done-worktree's closeOutCommitAtHead (which keyed on a subject
// PREFIX because its message has an interpolated tail; here we match the full subject line exactly).
export function commitSubjectAtHead(mainDir, message) {
  try {
    const subject = String(message).split('\n')[0].trim();
    if (!subject) return false;
    const head = git(mainDir, ['log', '-1', '--format=%s']).trim();
    return head === subject;
  } catch {
    return false;
  }
}

// F-007 (plan 1312, 2026-07-02 coord audit): the subject-equality half-land check above is
// too weak for DETERMINISTIC messages — drain-run's claim message is a pure function of
// (slug, day), so two independently-launched drain processes racing the same plan produce
// IDENTICAL subjects, and the loser's "nothing to commit" tolerance then reads the winner's
// commit as its own → both report a successful claim → double dispatch. gitMoveCommit now
// stamps a per-invocation `Coord-Nonce:` trailer into the commit BODY and tolerates a
// half-land ONLY when HEAD's body carries OUR nonce — a racing sibling's identical-subject
// commit can never match. Conservative like commitSubjectAtHead: an empty nonce, a read
// failure, or a missing trailer → false → the caller rethrows (the safe direction).
export function commitNonceAtHead(mainDir, nonce) {
  try {
    if (!nonce) return false;
    const body = git(mainDir, ['log', '-1', '--format=%B']);
    return body.includes(`Coord-Nonce: ${nonce}`);
  } catch {
    return false;
  }
}

// F-003 (plan 1312): read the AUTHORITATIVE copy of a tracked file from origin/master
// (best-effort fetch first), falling back to the local working-tree copy when offline or
// the ref/path is unreadable. Generalizes board.mjs's plan-989 readBoardFresh — since coord
// writes land in the disposable coord-checkout, MAIN's working-tree copies of the coord docs
// are NO LONGER freshened by them and structurally drift behind origin; any read that judges
// a JUST-PUSHED coord write (drain-run's board-row verify/repath) must use this view, never
// a bare readFileSync of MAIN. Throws only when BOTH reads fail (e.g. the file exists in
// neither place) — callers that tolerate a missing file catch and map to their own sentinel.
// `fetch: false` skips the network round-trip and reads the LOCAL remote-tracking ref — correct
// (and much cheaper) when the caller's own just-completed `git push` already updated
// refs/remotes/origin/master in this same .git (a successful push moves the tracking ref).
export function readTrackedFileFresh(
  mainDir,
  rel,
  fallbackPath,
  { _git = git, fetch = true } = {},
) {
  if (fetch) {
    try {
      gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], { _git });
    } catch {
      /* offline — the local copy is the best available view */
    }
  }
  try {
    return _git(mainDir, ['show', `origin/master:${rel}`]);
  } catch {
    return readFileSync(fallbackPath, 'utf8');
  }
}

// plan 4087 T2 (S3, ledger: claim-plan-5s-read-cap-kills-acquire-under-machine-load /
// claim-read-5s-cap-vs-2s-baseline-github-latency / claim-plan-read-timeout-trips-under-load).
// The read cap used to be TWO hardcoded 5s constants (this function's own default below, and
// claim-plan.mjs's separate CLAIM_READ_TIMEOUT_MS) plus one hand-rolled bypass
// (heldClaimsMap's own `_git(..., ['ls-remote', ...])` call, which never touched this function
// at all) — three places that could each independently trip under load, none of them informed
// by how slow this box's git/network actually is right now. The ledger's measured GitHub
// baseline is ~2s, so a loaded box trips a bare 5s constant easily.
//
// This derives ONE shared cap instead: the coord-op journal's own recent p95 (the same
// journal T0's coord-op-stats.mjs already parses — reused here, not re-parsed a second way),
// bounded to [DERIVED_READ_TIMEOUT_FLOOR_MS, DERIVED_READ_TIMEOUT_CEILING_MS]. 5000 is kept
// ONLY as the floor for an empty/unreadable journal (a fresh checkout, or an offline probe) —
// it is not a second hardcoded default; every other read shares this exact value.
// Memoised per `dir` (like `_identityFallbackCache` above) so a hot caller does not re-parse
// the journal on every read, and so a test using a fresh temp repo per case never sees another
// test's cached value.
//
// plan 4087 T4 review fixes (keys 3qw0gd/1mtmw9g/tgj7vi/sfxu5y):
//  - BASIS (3qw0gd): reads `summary.p95DoneMs`, not `summary.p95Ms`. `p95Ms` deliberately mixes
//    in `error`- and `release`-closed windows (coord-op-stats.mjs's own header explains why, for
//    its operator-facing report) — neither represents a HEALTHY full round trip, so lumping them
//    in is the wrong population for "how long does the read actually being timed take when it
//    succeeds". `p95DoneMs` (done-closes only) is the closest thing this journal offers to that
//    question; there is no separately-journaled "read" tool to scope to instead — only
//    withCoordLock's WRITE-lock critical sections are journaled at all (verified by reading every
//    `tool:` literal under scripts/ during this fix), so tool-scoping isn't an available option.
//  - TTL (1mtmw9g): the cache now expires after DERIVED_READ_TIMEOUT_CACHE_MAX_AGE_MS instead of
//    living for the rest of the process. A long-running drain/orchestrate session can run for
//    hours, during which the box's actual load changes — a forever-cache keeps returning whatever
//    the FIRST call in the process happened to measure. Re-deriving costs one journal read+fold,
//    which the TTL keeps rare (default 5 minutes) while still serving the hot-caller case the
//    memoisation exists for (many reads in a short burst all sharing one derivation).
//  - ARCHIVES (tgj7vi/sfxu5y): `_readCoordOpJournal` reads the live journal PLUS its daily
//    archives (`rotateCoordOpJournal` writes them beside it), rather than `readCoordOpJournal`
//    (live file only) — a derivation taken right after a rotation used to silently lose whatever
//    history the rotation just moved out.
//  - BOUNDED ARCHIVE WINDOW (round-2 review, efficiency): archives accumulate forever — rotation
//    only ever ADDS a dated sibling, never deletes one — so reading the WHOLE archive history on
//    every cache miss (every DERIVED_READ_TIMEOUT_CACHE_MAX_AGE_MS, i.e. forever, for the lifetime
//    of the checkout) is a cost that grows without bound while the number this derivation actually
//    needs is a RECENT p95, not a lifetime one.
//  - SAMPLE-SIZE BOUND, not a fixed day count (round-3 review, key 270fdc/1ec367/altitude): a
//    fixed "last N days" window can hand this an empty or thin sample on a sparse day, or right
//    after a fresh rotation — exactly when a stable p95 matters most. Instead, `_readCoordOpJournal`
//    grows the window one archive at a time, NEWEST first, until the sample is big enough (chosen
//    as the smallest sample this derivation's own quantile() — nearest-rank over p95 — stops being
//    dominated by any single outlier: below it, one slow op can swing p95 more than reading one more
//    archive would cost to avoid) or the archive history runs out — so the read cost stays
//    proportional to what's actually needed instead of a guessed day count. The floor/ceiling clamp
//    below is still the fallback for a checkout whose FULL history is still thinner than that (a
//    fresh checkout, or one that has never rotated) — sample-size bounding narrows the read, it
//    never replaces that clamp. The operator-facing CLI (coord-op-stats.mjs's own `main()`) is
//    UNAFFECTED — a human asking for the full report still gets the full archive history; only this
//    internal, frequently-re-derived read is windowed.
//  - USABLE SAMPLES ONLY, EACH ARCHIVE READ ONCE (round-4 review, keys d54f6a/12e2ce/c20dbe): the
//    growth loop used to (a) stop once `closedBy.done` — every `done`-reason close, including one
//    whose start/close timestamps didn't parse and so never entered the duration sample at all —
//    reached the minimum, which could declare victory on a window with FEWER usable durations than
//    the minimum actually calls for; and (b) grow by re-calling `collectJournalEntries` with an
//    ever-larger `maxArchives`, which re-reads every archive already in the window again from disk
//    on every step. Fixed on both axes below: the stopping condition is `doneSampleCount` (the
//    ACTUAL size of the duration sample p95 is computed over — see computeCoordOpStats), and each
//    archive's raw text is read from disk exactly once, the moment it is first pulled into the
//    window, never again on a later growth step.
const DERIVED_READ_TIMEOUT_FLOOR_MS = 5000;
const DERIVED_READ_TIMEOUT_CEILING_MS = 30000;
const DERIVED_READ_TIMEOUT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DERIVED_READ_TIMEOUT_MIN_SAMPLE = 30;
const _derivedReadTimeoutCache = new Map();
// Exported — with injectable seams, same pattern as derivedReadTimeoutMs below — so the
// newest-first, sample-size-bounded growth (round-3 review, keys 270fdc/1ec367/altitude) is
// itself directly testable, not only observable through derivedReadTimeoutMs's own seams (which
// bypass this function entirely by overriding `_readCoordOpJournal`).
export function readCoordOpJournalForStats(
  mainDir,
  {
    _listArchiveJournalPaths = listArchiveJournalPaths,
    _readFileSync = readFileSync,
    _computeCoordOpStats = computeCoordOpStats,
    _parseJournalText = parseJournalText,
  } = {},
) {
  const journalPath = coordOpJournalPath(mainDir);
  const readLines = (p) => {
    try {
      return _readFileSync(p, 'utf8').split('\n').filter(Boolean);
    } catch {
      return []; // missing/unreadable — degrade to empty, never throw into a read
    }
  };
  const archivePaths = _listArchiveJournalPaths(journalPath); // oldest-first
  const liveLines = readLines(journalPath); // read once, reused by every growth step below

  const usableSampleCount = (lines) =>
    _computeCoordOpStats(_parseJournalText(lines.join('\n')).entries).summary.doneSampleCount;

  // Grow the window one archive at a time, NEWEST first, so each archive's file is read from disk
  // exactly once regardless of how many growth steps it takes to satisfy the minimum — unlike
  // re-calling collectJournalEntries({ maxArchives }) with an ever-larger count, which re-reads the
  // whole window again on every step. `windowLines` stays oldest-first (archives are pulled in
  // newest-first but PREPENDED), matching collectJournalEntries's own chronological order.
  let windowLines = liveLines;
  let pulled = 0;
  while (
    pulled < archivePaths.length &&
    usableSampleCount(windowLines) < DERIVED_READ_TIMEOUT_MIN_SAMPLE
  ) {
    pulled += 1;
    windowLines = [...readLines(archivePaths[archivePaths.length - pulled]), ...windowLines];
  }
  return _parseJournalText(windowLines.join('\n')).entries;
}
export function derivedReadTimeoutMs(
  dir,
  {
    _readCoordOpJournal = readCoordOpJournalForStats,
    _computeCoordOpStats = computeCoordOpStats,
    _now = () => Date.now(),
  } = {},
) {
  const nowMs = _now();
  const cached = _derivedReadTimeoutCache.get(dir);
  if (cached && nowMs - cached.computedAtMs < DERIVED_READ_TIMEOUT_CACHE_MAX_AGE_MS) {
    return cached.value;
  }
  let p95 = null;
  let samples = 0;
  try {
    const { summary } = _computeCoordOpStats(_readCoordOpJournal(dir));
    p95 = summary.p95DoneMs;
    samples = Number.isFinite(summary.doneSampleCount) ? summary.doneSampleCount : 0;
  } catch {
    p95 = null; // an unreadable/corrupt journal: no measurement, never throws into a read
  }
  // No measurement, or too thin a one, means we do NOT KNOW how slow this box is -- so the answer is
  // the generous CEILING, never the floor. Defaulting to the floor re-created the exact 5 s cap this
  // plan exists to retire: a fresh checkout, or a test fixture with no journal, got 5 s and tripped
  // under load (caught by this plan's own land battery, next-plan-id.test.mjs, 2026-09-23). The
  // floor only ever bounds a REAL, well-sampled p95 from below.
  const measured = Number.isFinite(p95) && samples >= DERIVED_READ_TIMEOUT_MIN_SAMPLE;
  const derived = measured
    ? Math.min(DERIVED_READ_TIMEOUT_CEILING_MS, Math.max(DERIVED_READ_TIMEOUT_FLOOR_MS, p95))
    : DERIVED_READ_TIMEOUT_CEILING_MS;
  _derivedReadTimeoutCache.set(dir, { value: derived, computedAtMs: nowMs });
  return derived;
}

// plan 1475 (item 3): the ONE timed `git ls-remote origin <ref>` every refs/claims consumer
// shares — reconcile-board's fetchClaimsMap, post-checkout-claim-guard's claimRefExists, and
// sweep-acquire-residue's hasClaimRef each hand-rolled an identical 5s-capped ls-remote (plan
// 1398 item 7 spread the timeout to all three; this folds the three copies into one). The cap
// makes an unreachable/offline origin fail fast instead of hanging on the OS-level TCP/DNS
// timeout — load-bearing for the two that run inside a SYNCHRONOUS git hook / automated heal
// sweep. Returns raw `git ls-remote` stdout; each caller keeps its own `.trim()`/parse (a glob
// ref yields multiple lines, an exact ref zero-or-one). `_git` is the test seam threaded through
// so the timeout wiring stays unit-testable without spawning a real git process. `timeout`
// defaults to the DERIVED cap (plan 4087 T2) rather than a bare constant — see
// derivedReadTimeoutMs's own header for the full mechanism.
export function lsRemoteTimed(dir, ref, { _git = git, timeout = derivedReadTimeoutMs(dir) } = {}) {
  // plan 3756: `ref` may be an ARRAY of patterns. Claim refs now live in two namespaces at
  // once (the branch-shaped one and the retired `refs/claims/*` still held by pre-flip
  // sessions), so a claim reader that queries only one of them is wrong — and querying them
  // in two calls would double the round trips on the hottest read in the spine. `git
  // ls-remote` takes any number of patterns natively. A plain string is unchanged.
  const refs = Array.isArray(ref) ? ref : [ref];
  return _git(dir, ['ls-remote', 'origin', ...refs], { timeout });
}

// plan 1452/1475 (item 2): `git mv` does NOT create the destination's parent directory, and git
// cannot track an empty dir — so a status lane that has never held a file (a fresh sibling's
// archive/, ready/, or a heartbeat's first waiting-date/) is simply absent from the checkout
// until the first file lands there, and the `git mv` fatals "destination directory does not
// exist". mkdir the parent first (recursive → a no-op once it exists). Plan 1452 landed this as
// three near-identical call-site copies (done-worktree's movePlanFileIdempotent +
// promoteWaitingBlocked, move-plan) while coord-git's OWN gitMoveCommit primitive stayed
// unguarded; this is the ONE definition all four now route through. INVARIANT (plan 1452): the
// dir is resolved against `mainDir` — the SAME tree the mv runs in (the disposable coord-checkout,
// or done-worktree's ephemeral worktree via COORD_MAIN_DIR) — never the wrong checkout. Callers
// pass the exact destination they hand to `git mv`.
export function ensureMvDestDir(mainDir, dest) {
  const destAbs = isAbsolute(dest) ? dest : resolve(mainDir, dest);
  mkdirSync(dirname(destAbs), { recursive: true });
}

// The one true move primitive: `git mv from to` + commit the rename BY PATHSPEC
// (`git commit -- from to`), surviving index.lock contention. Naming BOTH sides
// records the staged deletion (`from`) + the working-tree content of the addition
// (`to`) regardless of disk state — and `git commit -- to` takes `to`'s WORKING
// TREE content, so a working-tree edit made before the move rides along (no
// half-apply). NEVER `git add <from>`: the source path is gone from disk after the
// mv, so it fatals "pathspec did not match" and commits a bare rename while
// dropping the content edits (the recurring foot-gun this closes — plan 363).
// Commits run with HUSKY=0 (coord-file commits are pre-PUSH-linted, not
// pre-commit). Route ad-hoc `git mv` + commit sequences through this.
// plan 980: both steps tolerate a TRANSIENT index-write half-{move,land} (the coord-git analogue
// of done-worktree's archivePlanFile + close-out-commit fixes). `_git` is the test seam threaded
// into every gitWithLockRetry call so the transient sequence can be simulated.
// F-007 (plan 1312): every commit carries a per-invocation `Coord-Nonce:` trailer, and the
// half-land tolerance below verifies THAT at HEAD (commitNonceAtHead) instead of bare
// subject equality — so a racing sibling's identical deterministic message (drain's
// (slug, day)-keyed claim) can never be mistaken for our own landed commit. `_nonce` is a
// test seam only.
export function gitMoveCommit(mainDir, from, to, message, { env = {}, _git = git, _nonce } = {}) {
  const nonce = _nonce || randomUUID();
  const fullMessage = `${message}\n\nCoord-Nonce: ${nonce}`;
  let halfMoved = false;
  // plan 1475 (item 2): guard the destination lane exists before the mv — the primitive was the
  // one git-mv path plan 1452 never patched, so a new mv-into-an-empty-status-lane call site would
  // silently reproduce the "destination directory does not exist" failure. Same tree the mv runs in.
  ensureMvDestDir(mainDir, to);
  try {
    gitWithLockRetry(mainDir, ['mv', from, to], { _git });
  } catch (e) {
    // The `git mv` renamed the file on disk (from→to) and THEN failed the index write with the
    // transient; gitWithLockRetry's retried mv then dies "bad source" because `from` is already
    // gone. Tolerate ONLY when the move demonstrably happened (`from` absent, `to` present). A
    // "bad source" with `from` still present is a real error and surfaces.
    const out = errText(e);
    const fromAbs = isAbsolute(from) ? from : resolve(mainDir, from);
    const toAbs = isAbsolute(to) ? to : resolve(mainDir, to);
    const moved = !existsSync(fromAbs) && existsSync(toAbs);
    if (!(isMvBadSource(out) && moved)) throw e;
    halfMoved = true;
  }
  // plan 980: a half-move renamed the file on disk but the transient FAILED the index write, so the
  // rename is NOT staged — `to` is untracked and `from` is still a tracked, on-disk-absent entry.
  // `git commit -- from to` would then die "pathspec 'to' did not match" (commit does not auto-stage
  // an untracked path) and record NOTHING. Stage just the destination with `git add -- to` (`to`
  // always exists on disk — we asserted `moved` above); the subsequent `git commit -- from to` then
  // records `from`'s deletion via its working-tree overlay of that pathspec. This is the coord-git
  // analogue of done-worktree's archivePlanFile, which `git add`s the moved-to path before its
  // close-out commit. Both half-move variants are covered: the index-not-updated case (real
  // transient) and the index-already-updated case (a no-op `git add`), verified empirically. NOTE:
  // `git add -A -- from to` does NOT work — once the mv staged the rename, `from` is absent from both
  // index and working tree, so the `from` pathspec fatals "did not match".
  if (halfMoved) {
    gitWithLockRetry(mainDir, ['add', '--', to], { _git });
  }
  try {
    gitWithLockRetry(mainDir, ['commit', '-m', fullMessage, '--', from, to], {
      env: { HUSKY: '0', ...env }, // plan 2604: gitRaw's spawnEnv supplies+scrubs process.env
      _git,
    });
  } catch (e) {
    // Commit half-land tolerance: a transient index-write made git create the commit + move HEAD, so
    // the retried `git commit -- from to` found the work already done. For a RENAME that surfaces as
    // "pathspec 'from' did not match" (from is gone after the rename committed) rather than the
    // "nothing to commit" coordWrite sees — tolerate either, ONLY once HEAD's body carries our
    // per-invocation nonce, proving OUR commit genuinely landed (F-007: subject equality is not
    // proof — a racing sibling's deterministic message has the same subject); anything else surfaces.
    const out = errText(e);
    const alreadyDone = isNothingToCommit(out) || isPathspecNoMatch(out);
    if (!(alreadyDone && commitNonceAtHead(mainDir, nonce))) throw e;
  }
}

// plan 1184: after an archive operation, remove any untracked same-basename copy
// that remained in a non-archive plan subfolder. The auto-heal Stop-hook would
// otherwise re-track it on the next session end, restarting the archive-consistency
// wedge cycle. Uses gitWithLockRetry so a Windows Git-for-Windows fork() crash
// (leaving a stale index.lock) is retried rather than silently swallowing the error.
// Non-fatal: a git failure or a stubborn rm is caught and the caller proceeds.
// `_gitWithLockRetry` is a test seam (the real gitWithLockRetry by default) so unit
// tests can verify the retry path is wired, not bare execFileSync/run().
const PLANS_DIR = 'docs/superpowers/plans/';
const PLANS_ARCHIVE_DIR = 'docs/superpowers/plans/archive/';
export function deleteStaleArchiveDups(
  mainDir,
  base,
  { _gitWithLockRetry: glr = gitWithLockRetry } = {},
) {
  if (!base) return;
  try {
    const untrackedPlanFiles = glr(mainDir, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      PLANS_DIR,
    ])
      .split('\n')
      .filter(Boolean);
    for (const rel of untrackedPlanFiles) {
      const normRel = rel.replace(/\\/g, '/');
      if (!normRel.startsWith(PLANS_ARCHIVE_DIR) && normRel.split('/').pop() === base) {
        try {
          rmSync(resolve(mainDir, rel), { force: true });
        } catch (e) {
          // plan 1184: force:true only suppresses ENOENT; EPERM/EBUSY (Windows AV or deny-delete
          // share mode) still throws. Log so the operator can diagnose — never silently swallow.
          console.error(
            `[coord-git] deleteStaleArchiveDups: rm ${rel} failed (non-fatal, stale dup may remain): ${e.code ?? e.message}`,
          );
        }
      }
    }
  } catch (e) {
    // plan 1184: log misconfiguration (wrong mainDir, detached worktree, etc.) so the operator
    // can diagnose. The non-fatal contract must hold — we're inside a close-out call chain.
    console.error(
      `[coord-git] deleteStaleArchiveDups: ls-files failed, stale dup may remain: ${e.message}`,
    );
  }
}

export function resolveMain({ assertMaster = true } = {}) {
  // plan 971: an explicit override. done-worktree runs its POST-MERGE bookkeeping
  // (board/queue/mint coordWrites) against an EPHEMERAL detached worktree cut off
  // origin/master, so foreign dirt on the shared main checkout can never block a land.
  // It points each coord subprocess at that worktree via COORD_MAIN_DIR. The override is
  // a deliberate trust signal from the spine, so we skip the on-master assert below (the
  // finish worktree is detached HEAD, never on a `master` branch). UNSET in every other
  // caller → the porcelain resolution + master guard are exactly as before.
  const override = process.env.COORD_MAIN_DIR;
  if (override) return override;
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      maxBuffer: GIT_MAXBUFFER, // plan 850: many live worktrees can grow the porcelain past 1MB
      // plan 4087 T5: this call carries no `-C` at all, so it resolves the repo from `cwd` alone —
      // an ambient GIT_DIR is exactly as able to hijack it as it is gitRaw's `-C mainDir` above.
      // gitRepoIsolatedEnv() strips the repo-selector set; spawnEnv()'s CHILD_ENV_STRIP is empty
      // of git vars and dropped none.
      env: gitRepoIsolatedEnv(),
    });
  } catch (e) {
    // plan 1771: this is the FIRST git command most coord tools run, so a NUL-filled
    // `.git/config` dies right here with `fatal: bad config line 1` — annotate it with the
    // heal pointer instead of letting the raw confusion surface.
    throw annotateMetadataCorruption(e);
  }
  const first = out.split('\n').find((l) => l.startsWith('worktree '));
  if (!first) throw new Error('coord-git: cannot resolve main worktree');
  const dir = first.slice('worktree '.length).trim();
  // plan 1286: heal-main passes assertMaster:false — it must resolve MAIN precisely when MAIN
  // is in the broken state (detached HEAD) every other coord tool refuses to touch.
  if (assertMaster) {
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch !== 'master')
      throw new Error(
        `coord-git: main worktree is on "${branch}", expected master — refusing to mutate. ` +
          `(A detached MAIN is healed by \`node scripts/heal-main.mjs\`.)`,
      );
  }
  return dir;
}

// plan 1663 (review delta [1]): THE parse for an env-tunable staleness threshold — shared by
// WORKTREE_LOCK_STALE_MS below and land-lib's LAND_REGISTRATION_STALE_MS so a hardening fix
// can never land in one copy and not the other. Honours an explicit value INCLUDING 0
// (`Number(x) || fallback` would coerce a deliberate 0 to the fallback); falls back when
// unset/blank/NaN AND when whitespace-coerced or negative (Number(' ')===0 and Number('-1')
// are both finite — either would silently arm immediate clearing of possibly-live artifacts).
export function parseStaleMsEnv(raw, fallbackMs) {
  const v = (raw ?? '').trim();
  const n = Number(v);
  return v !== '' && Number.isFinite(n) && n >= 0 ? n : fallbackMs;
}

// plan 1286: the ONE parse of the worktree-lock staleness gate (env-tunable; a worktree's
// index is private, so a few seconds idle already proves orphaned — vs the shared index's
// 30 s STALE_LOCK_MS). Shared by clear-stale-worktree-lock.mjs, heal-main.mjs, and the sweep
// below so the three can never desync on the threshold semantics.
export const WORKTREE_LOCK_STALE_MS = parseStaleMsEnv(process.env.WORKTREE_LOCK_STALE_MS, 3_000);

// True iff `ancestor` is an ancestor of (or equal to) `ref` in `dir` — the shared boolean
// wrapper over `git merge-base --is-ancestor` (plan 1286: reattachMainToMaster and
// heal-main's master-sync must agree on what "safe" means, so there is exactly one impl).
export function isAncestorRef(dir, ancestor, ref, { env, _git = git } = {}) {
  try {
    _git(dir, ['merge-base', '--is-ancestor', ancestor, ref], { env });
    return true;
  } catch {
    return false;
  }
}

// A dead seed is an execution branch marker that never acquired a commit of its own — a session
// that was staked and then died before its first commit. Six hours of emptiness used to be taken
// as proof of that, on the premise that "every drain routine pushes after every commit". Plan 3619
// proved that premise FALSE: a drain whose pushes are being rejected by the pre-push gate holds
// real commits in its sandbox and produces the exact origin state of zero (the 2026-09-01 plan-3595
// stall — 4 finished commits held ~3.5h behind a failing scripts-battery gate). Since declaring a
// dead seed FREES the plan for a second drain to redo the work, that misreading is expensive in
// both directions. The age test below is therefore no longer the only evidence: a live drain that
// cannot push its work can still publish a heartbeat on the gate-exempt status channel
// (scripts/drain-status.mjs), and a fresh heartbeat suspends this clock. This is deliberately one
// named constant, not an environment knob.
export const DEAD_SEED_MIN_AGE_MS = 6 * 60 * 60 * 1000; // 6h

// Prove that an execution-branch tip is both empty and old enough to be a dead seed. The
// ancestry-path contains exactly commits descended from the tip AND ancestral to master, so
// its minimum committer time bounds when the marker could have been staked regardless of
// merge shape. A first-parent walk could reach the root after a history rewrite and call a
// fresh marker ancient.
//
// A stale local origin/master is conservative: its ancestors remain ancestors of the real
// head, while an unknown tip is kept. This predicate must not fetch; staleness can only keep
// blocking, never discard a branch less safely.
//
// `statusHeartbeatMs` (plan 3619) is the epoch-ms of the newest heartbeat this marker's drain
// published on the status channel, or null when it published none — the caller reads it (see
// scripts/drain-status.mjs § readDrainStatuses) and passes it in, so this predicate stays pure and
// still never fetches. A heartbeat FRESHER than the dead-seed threshold answers the question the
// age test is only guessing at — a live session is holding work it cannot push — so it short-
// circuits to `status-heartbeat` before any age reasoning. A STALE heartbeat is deliberately NOT a
// veto: it falls through to the ordinary test, so an abandoned status branch left behind by a dead
// sandbox cannot pin a plan out of selection forever. Absent, unparsable, or garbage status
// degrades to null upstream, i.e. to the pre-3619 behaviour exactly.
export function deadSeedVerdict(
  dir,
  tipSha,
  { nowMs = Date.now(), _git = git, env, statusHeartbeatMs = null } = {},
) {
  try {
    if (Number.isFinite(statusHeartbeatMs)) {
      const heartbeatAgeMs = nowMs - statusHeartbeatMs;
      if (heartbeatAgeMs >= 0 && heartbeatAgeMs < DEAD_SEED_MIN_AGE_MS) {
        return { dead: false, ageMs: heartbeatAgeMs, reason: 'status-heartbeat' };
      }
    }
    try {
      _git(dir, ['merge-base', '--is-ancestor', tipSha, 'origin/master'], { env });
    } catch {
      // This seam conflates exit 1 (carries work) with bad/missing objects and Git failures.
      // Fail toward keeping the branch in every case.
      return { dead: false, ageMs: null, reason: 'carries-work' };
    }

    let out;
    try {
      out = _git(dir, ['log', '--ancestry-path', '--format=%ct', `${tipSha}..origin/master`], {
        env,
      });
    } catch {
      return { dead: false, ageMs: null, reason: 'git-error' };
    }

    let minCt = Infinity;
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const ct = Number(line);
      if (Number.isFinite(ct) && ct < minCt) minCt = ct;
    }
    if (!Number.isFinite(minCt)) return { dead: false, ageMs: null, reason: 'age-unknown' };

    const ageMs = nowMs - minCt * 1000;
    if (ageMs >= DEAD_SEED_MIN_AGE_MS) return { dead: true, ageMs, reason: 'dead' };
    return { dead: false, ageMs, reason: 'fresh' };
  } catch {
    return { dead: false, ageMs: null, reason: 'git-error' };
  }
}

// plan 1663 (review): THE one resolution of the linked-worktree ADMIN root
// (`<git-common-dir>/worktrees`) — shared by sweepWorktreeIndexLocks below and land-lib's
// registration probes (registrationAdminDirFor), which was about to become the third inline
// copy of this walk. Throws on failure (not a repo / git missing); callers wrap.
// (clear-stale-worktree-lock.mjs keeps its own `--git-dir`+`--git-common-dir` resolve on
// purpose: it needs BOTH dirs for its structural linked-vs-main gate and must not import
// this module eagerly, to preserve its exit-0 guarantee.)
export function worktreeAdminRoot(mainDir) {
  return join(resolveCommonDirPath({ anchor: mainDir }), 'worktrees');
}

// plan 1286 (root cause D): enumerate every LINKED worktree's `.git/worktrees/<n>/index.lock`
// under the shared common dir and clear the provably-stale ones — the sweep
// clear-stale-worktree-lock.mjs could not do when invoked FROM the main checkout (its
// structural gate made that a silent no-op, which is what pushed a session to a blind manual
// delete during the 2026-07-02 incident). The shared MAIN `.git/index.lock` is deliberately
// NOT touched here (different contention class — heal-main clears it separately under the
// 30 s STALE_LOCK_MS gate). Returns one entry per lock found: { lockPath, ageMs, removed,
// deleteFailed, outcome } (removed=false ⇒ spared as fresh, dry, or the delete itself failed —
// check `deleteFailed` to tell a genuinely-failed delete apart from a merely-fresh lock; plan
// 4087 T4-C — existing consumers that only read `removed`/`ageMs`/`lockPath` are unaffected,
// this is an additive field). `outcome` (plan 4087 round-3 review, key b14495) carries
// `clearStaleIndexLockDetailed`'s own verdict — 'fresh' (idle < staleMs, never attempted),
// 'dry-stale' (idle >= staleMs but `dry` skipped the attempt), or, when a clear was actually
// attempted, whatever that attempt returned ('removed' / 'absent' / 'delete-failed';
// 'unresolvable' cannot occur here — `lockPath` is always passed in, never re-resolved) — so a
// caller can report the REAL reason a lock was left uncleared without re-probing the
// filesystem itself, which only re-opens the exact race this field exists to close. Never
// throws.
export function sweepWorktreeIndexLocks(
  mainDir,
  { staleMs = WORKTREE_LOCK_STALE_MS, dry = false } = {},
) {
  const results = [];
  let wtRoot;
  try {
    wtRoot = worktreeAdminRoot(mainDir);
  } catch {
    return results;
  }
  let names = [];
  try {
    names = readdirSync(wtRoot);
  } catch {
    return results; // no linked worktrees
  }
  for (const name of names) {
    const lockPath = join(wtRoot, name, 'index.lock');
    let st;
    try {
      st = statSync(lockPath);
    } catch {
      continue; // no lock for this worktree
    }
    const ageMs = Date.now() - st.mtimeMs;
    let removed = false;
    let deleteFailed = false;
    let outcome = ageMs < staleMs ? 'fresh' : 'dry-stale'; // 'dry-stale' only sticks if dry skips below
    if (!dry && ageMs >= staleMs) {
      const detail = clearStaleIndexLockDetailed(mainDir, { staleMs, lockPath });
      removed = detail.removed;
      deleteFailed = detail.outcome === 'delete-failed';
      outcome = detail.outcome;
    }
    results.push({ lockPath, ageMs, removed, deleteFailed, outcome });
  }
  return results;
}

// plan 2465: the land spine's own worktree-private heal, invoked from done-worktree's
// preflight — the entry point that hits an orphaned worktree index.lock but never called
// clearStaleIndexLock/sweepWorktreeIndexLocks, leaving a human to diagnose and `rm` it by
// hand (observed twice in one session, 28 min and 100 min idle, both with no holding
// process — plan 2432). This clears ONLY wtPath's own lock — never
// sweepWorktreeIndexLocks' all-worktrees sweep, and never the shared MAIN
// `.git/index.lock` (a different contention class, heal-main/coordWrite territory).
// Best-effort: any resolution failure (unresolvable git dir, no lock present) returns
// false and the caller's normal git op surfaces any real contention.
//
// The 30s floor (Math.max against STALE_LOCK_MS, over the CLI's raw
// WORKTREE_LOCK_STALE_MS default of 3s) matters because the spine runs UNATTENDED
// alongside a same-worktree subagent that may hold a live multi-second git op —
// index.lock mtime is set once at creation and never refreshed mid-op, so a live 10s
// rebase would read as "3s stale" under the CLI's aggressive human-invoked default. (A
// registered-but-torn worktree — e.g. cut-worktree's "already registered worktree"
// failure mode — is a DIFFERENT problem this function does not address; that is
// land-lib.mjs's reclaimLandDirIfSafe territory.)
export function healOwnWorktreeIndexLock(wtPath, mainDir) {
  const gate = Math.max(WORKTREE_LOCK_STALE_MS, STALE_LOCK_MS);
  let p;
  try {
    p = indexLockPath(wtPath);
  } catch {
    return false; // can't resolve — leave to the normal git-op error path
  }
  try {
    return clearStaleIndexLock(mainDir, { staleMs: gate, lockPath: p });
  } catch {
    return false;
  }
}

// plan 971: the push refspec for a coord-doc write. On the shared main checkout HEAD IS
// the `master` branch, so `master` and `HEAD:master` are equivalent. In done-worktree's
// EPHEMERAL detached finish worktree (resolved via COORD_MAIN_DIR) HEAD is DETACHED, so a
// bare `push origin master` would push the shared LOCAL master ref (stale, not our commit)
// — we must name the source explicitly as `HEAD:master`. Detected via `symbolic-ref -q HEAD`
// (exits non-zero when detached). Behaviour-preserving on the main checkout (returns 'master').
// plan 4136 review (e7126c): `_git` lets a caller with an injected git seam keep this probe
// inside it, so a fake-git test never spawns a real `git symbolic-ref` child.
export function masterPushSpec(mainDir, env, { _git = git } = {}) {
  try {
    _git(mainDir, ['symbolic-ref', '-q', 'HEAD'], { env });
    return 'master';
  } catch {
    return 'HEAD:master';
  }
}

// ── plan 989: isolate coord-doc writes from the shared MAIN working tree ──────────────────────
// The root fix the 987/970/973/980/675/sweep family all bandaid: coordWrite (and, phase 2,
// move-plan/claim-plan) used to mutate-commit-push INSIDE the shared MAIN checkout — the tree every
// session ALSO edits code in and that EVERY other coord write uses. That shared mutable tree is the
// structural source of (a) concurrent coord-write contention, (b) the foreign-dirt refusal (a
// sibling mid-write OR a session's own uncommitted code edit blocks the op — the 989-mint refusal),
// and (c) partial-failure residue (a half-pushed orphaned claim-flip + leftover MAIN dirt). The fix:
// coord writes run against a DEDICATED, DISPOSABLE coord-checkout (a long-lived detached worktree off
// origin/master, `reset --hard` + `clean` to the fresh tip at the START of every op — it never holds
// precious work), serialized by a coord-write lock. MAIN stays read-only to coord tools. coordWrite
// itself is UNCHANGED: it already operates on a detached worktree (plan 971's COORD_MAIN_DIR path),
// and on a freshly-reset clean tree its foreign-dirt guard never fires and its scoped rollback is a
// harmless no-op — so the whole crash class disappears without touching coordWrite's hardening.

// The coord-write lock file lives in the SHARED `.git` common dir (like landing-lock.json), so all
// worktrees of the one clone rendezvous on it and `git clean` never sweeps it.
export function coordLockPath(mainDir) {
  return join(resolveCommonDirPath({ anchor: mainDir }), 'coord-write.lock');
}

// The long-lived disposable coord-checkout path: a sibling of .claude/worktrees/ (gitignored via
// .claude/coord-worktree/ so MAIN's status never lists it, and worktree-guard's worktrees/ scan
// never counts it as an active session worktree).
export function coordCheckoutPath(mainDir) {
  return resolve(mainDir, '.claude', 'coord-worktree');
}

// -- plan 3802: the coord checkout is SPARSE -------------------------------------------------
// Every coord write pays, under the lock, for a working tree it never reads. The disposable
// checkout used to materialise all ~119,700 tracked files, of which `backend/` is ~101,900 (85%,
// `backend/data/` alone ~91,600) and `frontend/` ~5,800 -- and NO coordWrite/withCoordCheckout
// caller writes into either. resolveCoordCheckout's `reset --hard` + `clean -fd`, and coordWrite's
// own `status --porcelain`, `merge --ff-only`, `add` and `commit`, all walk that tree inside the
// critical section. Measured on this host (n=5, same repo, same commands, ms/iteration):
//   reset --hard 2414 -> 234 . clean 1017 -> 50 . status 1020 -> 118 . commit 877 -> 208
// i.e. the local git work in the critical section drops ~4.9x (~4.7s/attempt saved), against a
// measured mean per-op hold of 22.76s (median 16.47s) over 292 ops -- vs the 6.941s median plan
// 2429 recorded for this same start->release measurement. The network fetch is untouched and is
// the remaining floor. Nothing about correctness moves: refs, commits, the remote CAS, the
// pathspec-scoped rollback and the push path are identical -- only which blobs reach disk.
//
// EXCLUDE-list, not an include-list, and deliberately so: a new coordination target directory must
// never silently fall outside the cone. Only the two large application trees are named; everything
// else at the repo root (docs/, wiki/, output/, scripts/, coord/, ...) is included automatically,
// so the failure direction of an unknown new path is "materialised and correct", never "missing".
// Cone mode always materialises root-level FILES (package.json, pnpm-workspace.yaml, ...), so a
// tool resolving those from the checkout is unaffected. Enforced at runtime by
// assertCoordPathInCone, which coordWrite calls on every declared relPath.
//
// plan 4071 T2: the exclude list itself is no longer a module-load constant here -- it is project
// data that lives in coord.config.json's `coordCheckoutExcludedTopLevel` key (core default `[]`,
// meaning a config-less repo's coord checkout is cut DENSE -- no cone to apply; vetapp's row
// reproduces this former literal exactly: `["backend", "frontend"]`). `resolveCoordCheckout` and
// `coordWrite` are the two functions that already receive the repo root (`mainDir`) as a parameter,
// so each resolves `loadCoordConfig(mainDir).coordCheckoutExcludedTopLevel` ONCE and passes it down
// as `excludes` to `ensureCoordSparseCheckout` / `assertCoordPathInCone` below -- the same
// caller-injects shape `jobOutputPrefixes` established, applied at the nearest point in THIS module
// that already holds the root (coord-config.mjs itself imports `git` from this module, so a CLI
// entry point one layer further out would create no less of a cycle).

// Marker recording that THIS worktree has the plan-3802 cone applied. It lives in the worktree's
// own admin dir, so the recreate path in resolveCoordCheckout (rmSync + prune + add) drops it with
// the worktree and the cone is re-applied on the next op -- no stale-config window. Bump the
// version suffix when coord.config.json's coordCheckoutExcludedTopLevel changes, so existing
// checkouts re-apply.
//
// v1 -> v2 (plan 3956): a DELIBERATE bump with the exclude list unchanged. The marker is compared
// against the WANTED cone, never against what `git sparse-checkout list` actually says, so a hand
// widening survives every later call: on 2026-09-08 the live coord checkout was widened by hand
// (`git -C .claude/coord-worktree sparse-checkout add backend`, the wiki-commit seed-canary
// workaround recorded in docs/handoff/infra-debt.md) and stayed that way -- 112,665 backend files
// materialised, the entire plan-3802 win gone -- for four days after plan 3830 had made the canary
// sparse-aware. The bump re-applies the cone exactly once on the next coord op. A hand widening is
// therefore not durable across a marker bump, by design: the cone is the constant above, not the
// checkout's current state.
export const COORD_SPARSE_MARKER = 'coord-sparse-v2';

// plan 3956: the plan-worktree cone. A plan worktree keeps everything EXCEPT these paths, which are
// nested (not top-level) directories -- see sparseConeDirs for how a nested exclude becomes a cone.
// `backend/data/price-pipeline` is 93,095 of the repo's 131,025 tracked files (71%, 4.1 GB on disk
// per worktree) and no plan outside the Pipe/DQ/seed-write classes reads its STORES from the
// working tree -- those classes stay dense by rule (cut-worktree.mjs planWorktreeMode). The
// exclude is the six heavy stores under it, NOT the folder itself: its 22 top-level files are
// small CONTRACTS that code reads at IMPORT time from the tree -- `display-policy.json`
// (`lib_display_policy.load_display_policy`, a SystemExit on a missing file that took the whole
// pytest COLLECTION down in a sparse worktree, measured 2026-09-12), `plausibility-bands.json`
// (the price trust gate), `pricelist-scope.json`, `page-attribution.json` ... -- and cone mode
// materialises an ancestor's own files whenever any child directory is included, so keeping the
// small siblings (`rulings/`, `consensus/`, `every-row-read/`, ...) on disk keeps the contracts
// on disk too. The first six named stores are 87,313 of the 93,095 files (94%) and 3.7 GB of the
// 4.1 GB: `render-store` 66,051 / `batches` 9,190 / `render-archive` 4,179 / `prompt-bench` 3,966 /
// `llm-runs` 2,070 / `render-fingerprints` 1,837 (counts at origin/master 2026-09-12).
// A SEVENTH store joined 2026-09-22 (plan 4110): `page-extractions/` is `extract.py`'s on-disk
// per-page extraction cache -- like the six above, it is a cache that grows without bound (one
// record per distinct (model, page, prompt-fingerprint) it has ever billed) and no plan outside
// the Pipe/DQ/seed-write classes reads it from the working tree, so it excludes for the same
// reason they do.
// NOT excluded on purpose: `backend/src/data` (the seed: backend tests, the seed gates and
// `_seed_io` read it, and at 7,446 files / 167 MB it is not where the cost is), and the
// plans / handoff trees (coord tooling and done-worktree read them from the worktree).
//
// plan 4071 T2: like the coord-checkout list above, this is no longer a module-load constant --
// it is coord.config.json's `planWorktreeExcludedPaths` key (core default `[]`: a config-less
// repo's plan worktrees are cut DENSE, no cone; vetapp's row names the seven stores above).
// Every function here that used to read the module constant (`ensurePlanSparseCheckout`,
// `planNarrowBlockers`, `narrowPlanWorktree`) now takes the list as an `excludes` parameter; the
// CLI entry point that knows the project (`scripts/coord/cut-worktree.mjs`) resolves
// `loadCoordConfig(root).planWorktreeExcludedPaths` once and passes it down.

// Marker for the plan-worktree cone, same admin-dir mechanics as COORD_SPARSE_MARKER (a cache of
// "applied for this list", verified against git's own state on every call). Bump when
// coord.config.json's planWorktreeExcludedPaths changes (v1 -> v2 added page-extractions/).
// It is ALSO the positive identity of a
// sparse plan worktree (planWorktreeIsSparse), which is safe because a cone whose marker cannot be
// written is forced dense on the spot -- there is no "sparse but unmarked" state for a gate to miss.
export const PLAN_SPARSE_MARKER = 'plan-sparse-v2';

// gpt-review keys angle-B/angle-C/claude-data-grounding (plan 4110): the marker is written
// under the worktree's admin dir BY NAME, and `planWorktreeIsSparse` used to test for exactly
// PLAN_SPARSE_MARKER -- so the moment this constant is bumped, every worktree ALREADY CUT under
// the previous name reads dense, `widenPlanWorktree` silently no-ops on it, and the gates that
// widen before they run (the pytest gate, the price trust gate) execute against a tree whose
// heavy stores are still missing. That breaks OTHER live sessions' worktrees, not just the one
// landing the bump, and it does it silently -- the failure surfaces later as a store-shaped test
// error with no connection to the bump. The header above calls the marker "the positive identity
// of a sparse plan worktree", and that identity is "this tooling cut it sparse", which no version
// bump changes. So recognition matches ANY generation; only the WRITE uses the current name, and
// a stale generation is re-stamped on the next widen/narrow as ordinary housekeeping.
const PLAN_SPARSE_MARKER_RE = /^plan-sparse-v\d+$/;
export function planSparseMarkerIn(adminDir, { _readdirSync = readdirSync } = {}) {
  try {
    return _readdirSync(adminDir).find((n) => PLAN_SPARSE_MARKER_RE.test(n)) || null;
  } catch {
    return null;
  }
}

// Repo-root-relative path -> its first segment, POSIX- and Windows-separator tolerant.
// Deliberately NOT main-checkout-allowlist.mjs's `normalizeRel` (/gpt-review key 407a39 proposed
// reusing it): that helper strips a SINGLE leading `./` and no leading `/`, which is exactly the
// bypass /gpt-review key 60f0c7 found -- `././backend/x` or `/backend/x` would not resolve to
// `backend` and would slip past the guard. A guard must not inherit a normalizer weaker than the
// property it enforces, so the leading-prefix strip loops here until it reaches a fixed point.
export function topLevelSegment(relPath) {
  let out = String(relPath).replace(/[\\/]+/g, '/');
  let prev;
  do {
    prev = out;
    out = out.replace(/^[.][/]/, '').replace(/^[/]+/, '');
  } while (out !== prev);
  return out.split('/')[0];
}

// Throw when a coord write targets a path the sparse cone does not materialise. Cheap (pure string
// work) and precise: without it the failure mode is a confusing `git add` pathspec error deep
// inside the retry loop, or -- worse -- a silently skipped file.
//
// plan 4071 T2: `excludes` is now a REQUIRED caller-injected parameter (coord.config.json's
// `coordCheckoutExcludedTopLevel`, resolved by `coordWrite` — the one caller — via
// `loadCoordConfig(mainDir)`) rather than the module-load `COORD_CHECKOUT_EXCLUDED_TOP_LEVEL`
// constant. An empty list means "nothing excluded" (a dense checkout) -- this never throws.
export function assertCoordPathInCone(relPath, { tool = 'coordWrite', excludes } = {}) {
  const top = topLevelSegment(relPath);
  if (!excludes.includes(top)) return;
  throw new Error(
    `coordWrite(${tool}): "${relPath}" lives under "${top}/", which the coord checkout does not ` +
      `materialise (plan 3802 sparse cone). Coordination writes are for coordination documents; ` +
      `an app-tree file belongs in a normal worktree commit. If this path genuinely must be ` +
      `coord-written, remove "${top}" from coord.config.json's coordCheckoutExcludedTopLevel and ` +
      `bump COORD_SPARSE_MARKER in coord-git.mjs -- do not widen it silently.`,
  );
}

// The cone is computed against the tip resolveCoordCheckout is about to `reset --hard` ONTO, not
// against the checkout's current HEAD. Those differ on exactly the case that matters: a sibling has
// just landed a new top-level coordination directory, the fetch above has brought it down, and HEAD
// still points at the tip before it. Coning against HEAD there would compute a list that lacks the
// new directory, match the marker, skip the re-apply, and then reset onto a tip whose new directory
// the cone excludes — the stale-cone bug the marker recompute exists to prevent, reintroduced one
// step earlier. Coning against origin/master keeps the cone and the tree in step.
const COORD_CONE_REF = 'origin/master';

// plan 3956: the ONE cone computation, shared by the coord checkout and plan worktrees. Cone mode
// takes a list of INCLUDED directories, so an EXCLUDE list is turned into its complement: every
// directory that is neither an excluded path nor an ancestor of one is included whole; an ancestor
// of an excluded path is descended into (`git ls-tree -d <ref> -- <ancestor>/`, one level) and its
// siblings included instead. For a top-level exclude like `backend` that walk never descends, so
// the coord cone is exactly what plan 3802 computed -- every top-level directory minus the excluded
// ones, in ls-tree order. For `backend/data/price-pipeline` it yields every top-level directory
// except `backend`, plus `backend/{scripts,src,tests}`, plus every `backend/data/*` except
// `price-pipeline`. Cone mode materialises the FILES of every ancestor of an included directory on
// its own, so `backend/package.json` and `backend/data/<files>` still land on disk.
//
// Excludes must be DIRECTORIES: a file cannot be excluded in cone mode (its parent's files come
// along with any included sibling), and `ls-tree -d` never lists it, so a file exclude is silently
// a no-op. Root-level FILES are omitted from the list deliberately -- cone mode always materialises
// those, so naming them would be noise. `ref` is tried first, then HEAD (a fresh test origin or an
// offline clone may have no `origin/master` yet). Returns null both when an empty exclude list
// means dense is genuinely wanted, and when the list cannot be read (a degenerate tip must never
// empty the checkout, plan 3808) -- ensureSparseCheckout (the one caller) tells the two apart by
// re-checking the input list itself: an empty list actively widens an already-sparse checkout back
// to dense, any other null reason leaves the checkout in whatever state it is already in (plan
// 4071 review round 2).
export function sparseConeDirs(dir, { excludes, env, _git = git, ref = COORD_CONE_REF } = {}) {
  const ex = [...excludes].map((p) =>
    String(p)
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, ''),
  );
  // plan 4071 review round 1 (finding 31e460): an EMPTY exclude list means DENSE (no cone),
  // not "a cone listing every current top-level directory". Without this early return, the
  // walk below finds nothing to exclude and pushes every top-level dir into `include`, which
  // is non-empty and so was returned as a real cone -- one pinned to TODAY's top-level
  // directories. A later rebase/merge that adds a new top-level source directory would then
  // never be admitted into an already-cut worktree: `sparse-checkout set --cone` only ever
  // widens on a subsequent CALL with a wider list, and a config-less repo's plan worktrees
  // are documented (coord.config.json's core default `planWorktreeExcludedPaths: []`) to be
  // cut fully dense.
  if (ex.length === 0) return null;
  const lsDirs = (useRef, prefix) => {
    const args = ['ls-tree', '--name-only', '-d', useRef];
    if (prefix) args.push('--', `${prefix}/`);
    return _git(dir, args, { env })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  };
  let useRef = ref;
  let top;
  try {
    top = lsDirs(useRef, '');
  } catch {
    try {
      useRef = 'HEAD';
      top = lsDirs(useRef, '');
    } catch {
      return null;
    }
  }
  const include = [];
  const walk = (kids) => {
    for (const k of kids) {
      if (ex.includes(k)) continue;
      if (ex.some((e) => e.startsWith(`${k}/`))) walk(lsDirs(useRef, k));
      else include.push(k);
    }
  };
  try {
    walk(top);
  } catch {
    // A cone is all-or-nothing. An ancestor whose subtree could not be listed would leave every
    // sibling under it out of the include list, and a worktree cut on that list would silently
    // lack files the tip carries -- the failure mode is missing-file errors in tests and gates
    // that look like real breaks. null means "no cone" (the caller leaves the checkout dense);
    // a partial cone is never returned (/gpt-review keys f66338, c3c8f7, 0cf542 -- three
    // finders, one root cause).
    return null;
  }
  return include.length ? include : null;
}

// What git itself says about `dir`'s sparse state: whether sparse checkout is enabled in this
// worktree's config, and the cone directories it currently holds (`sparse-checkout list`; empty
// when disabled or unreadable). This is the ground truth the marker files below are only a cache
// of -- see ensureSparseCheckout for why both are consulted.
export function readSparseState(dir, { env, _git = git } = {}) {
  let enabled = false;
  try {
    // `--worktree`: the scope `sparse-checkout set`/`disable` write to (config.worktree when
    // extensions.worktreeConfig is on, else the repo-local config) -- never the global/system
    // layers, so an inherited host-level `core.sparseCheckout` cannot make a dense tree read
    // sparse. `--type=bool`: git normalises 1/yes/on/true to `true`, so no spelling is missed
    // (/gpt-review keys c4339f, 7b167b).
    enabled =
      _git(dir, ['config', '--worktree', '--type=bool', '--get', 'core.sparseCheckout'], {
        env,
      }).trim() === 'true';
  } catch {
    /* unset reads as exit 1: not sparse */
  }
  if (!enabled) return { enabled: false, dirs: [] };
  let dirs = [];
  try {
    dirs = _git(dir, ['sparse-checkout', 'list'], { env })
      .split('\n')
      .map((l) => l.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  } catch {
    /* enabled but no readable pattern list: treat as "no cone", which forces a re-apply */
  }
  return { enabled, dirs };
}

const sameDirSet = (a, b) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

// Force `dir` back to a DENSE checkout. Called whenever the cone could not be applied cleanly:
// `sparse-checkout set --cone` can fail partway through, leaving a checkout narrowed to some
// subset of dirs but NOT the full want-list -- which would break the very coordination writes
// this speedup exists to serve (/gpt-review keys 98cdbd, 3192cf, 1b9a05, 775e24, be892b, all one
// root cause). Dense is the only safe fallback state.
// The disable goes through gitWithLockRetry, not a bare `_git` (/gpt-review key 606a54): this
// runs inside the coord-write lock right after two `set` attempts already failed, and index-lock
// contention is by far the likeliest reason all three would fail together. A bare call swallowed
// that transient error and left the checkout narrowed -- the one state this function exists to
// prevent. The retry only covers lock / transient-index-write / ref-race errors and rethrows
// everything else immediately, so a git that genuinely cannot do sparse-checkout still falls
// straight through to the catch below at no added cost, and the best-effort contract is unchanged.
// Returns true when the disable went through, false when git refused it -- the caller decides
// what that means (the coord checkout stays best-effort and is guarded downstream by coordWrite's
// own cone check on every written path; a plan-worktree cut re-runs the disable itself and fails
// the cut loudly if git still refuses, so a partially narrowed tree is never handed to a session
// as "dense" -- /gpt-review key 2657c5).
function forceCoordDense(dir, { env, _git = git } = {}) {
  try {
    gitWithLockRetry(dir, ['sparse-checkout', 'disable'], { env, _git });
    return true;
  } catch {
    return false;
  }
}

// Apply a cone to `dir` when it is not already applied for the CURRENT tip. Returns true when the
// cone was (re)applied. plan 3956 generalised this from the coord-only helper: `excludes` and
// `markerName` are the two things that differ between the coord checkout and a plan worktree;
// everything below -- the marker recompute, the --sparse-index fallback, the dense fallback -- is
// shared. ensureCoordSparseCheckout / ensurePlanSparseCheckout are the two call sites.
//
// The marker records the exact directory list it was written for, and that list is recomputed and
// compared on every call rather than trusted. An early draft treated the marker's mere EXISTENCE as
// "already correct", which froze the cone at first-apply time: a NEW top-level coordination
// directory added later would never be materialised, and a coord write targeting it would fail on a
// tree that silently lacked it (/gpt-review keys 1ff2b5, 65ccc5, 841f15, 061186, f8b732, 4e2f4c,
// 44b4b2, ecd81c, f9bd14 -- nine finders, one root cause). That defeated the whole point of keying
// the cone off an EXCLUDE list. The recompute is one `ls-tree -d` on the root tree, measured at
// ~70ms on this host against the ~4.7s the cone saves, so correctness here is close to free.
//
// Best-effort by contract: a git too old for `--sparse-index`, or any other sparse-checkout
// failure, must never break a coordination write -- we fall back to `set --cone` without
// `--sparse-index`, and on any failure past that we force the checkout DENSE and leave the marker
// unwritten so a later healthy call retries. A dense checkout is slow, not wrong.
//
// Retrying forever on a PERSISTENT failure is deliberate (/gpt-review key fd76f4). The cost is one
// `ls-tree` plus a couple of failing git calls per write (~a few hundred ms); the alternative — a
// "gave up" marker — would freeze a TRANSIENT failure into permanent dense operation, which is the
// far worse outcome given a transient index-lock collision is the likeliest failure here and the
// steady-state win is ~4.7s per write. Cheap-and-self-healing beats sticky-and-fast.
export function ensureSparseCheckout(
  dir,
  {
    excludes,
    markerName,
    ref = COORD_CONE_REF,
    env,
    _git = git,
    _existsSync = existsSync,
    _writeFileSync = writeFileSync,
  } = {},
) {
  // plan 4071 review round 3 (finding 5dbf97): materialise `excludes` into an array ONCE, here at
  // the top, and thread THAT array to every downstream use (sparseConeDirs below, the empty-list
  // check). `excludes` may be a one-shot iterable (a generator) -- consuming it twice, once inside
  // sparseConeDirs's own `[...excludes]` and again for the empty-list check that used to read
  // `excludes` directly, made the SECOND read see an already-exhausted iterable as empty regardless
  // of what the caller actually passed, which could force an already-sparse checkout dense even
  // when the real exclude list was non-empty.
  const excludesArr = [...excludes];
  let adminDir;
  try {
    adminDir = _git(dir, ['rev-parse', '--absolute-git-dir'], { env }).trim();
  } catch {
    return false; // not a usable worktree yet -- the caller's own error path owns this
  }
  const dirs = sparseConeDirs(dir, { excludes: excludesArr, env, _git, ref });
  if (!dirs) {
    // plan 4071 review round 2 (keys 26b7de, 504c8b, 51f33d): sparseConeDirs returns null for
    // two different reasons, and they need different responses here. When the CALLER handed an
    // empty exclude list, dense is what was actually asked for -- so an already-sparse checkout
    // (a config that used to carry excludes, since emptied) must be actively widened back to
    // dense, the same operation `cut-worktree.mjs --widen` performs, not merely left alone.
    // Every OTHER null reason (an unreadable/degenerate tip, a partial-walk failure) still means
    // "leave the checkout in whatever state it is already in" -- the pre-existing contract this
    // function must not disturb.
    if (excludesArr.length === 0) {
      const live = readSparseState(dir, { env, _git });
      if (!live.enabled) return false; // already dense: nothing to do, no git call
      const disabled = forceCoordDense(dir, { env, _git });
      if (disabled) {
        const marker = join(adminDir, markerName);
        try {
          if (_existsSync(marker)) unlinkSync(marker);
        } catch {
          /* a stale marker over a dense tree only costs one wasted re-apply attempt */
        }
      }
      return disabled;
    }
    return false;
  }
  const want = `${dirs.join('\n')}\n`;
  const marker = join(adminDir, markerName);
  if (_existsSync(marker)) {
    try {
      // A matching marker says the cone was applied for this list ONCE; it does not say the
      // checkout still carries it. An interrupted apply, or a hand `sparse-checkout add` since
      // (the 2026-09-08 coord-checkout incident), leaves a matching marker over a different
      // cone, and trusting the marker alone would skip the repair forever (/gpt-review keys
      // f63998, 941d78). So the steady-state check is marker AND git's own pattern list --
      // two file reads, ~80 ms on this host -- and any mismatch re-applies.
      if (readFileSync(marker, 'utf8') === want) {
        const live = readSparseState(dir, { env, _git });
        if (live.enabled && sameDirSet(live.dirs, dirs)) return false; // correct for this tip
      }
    } catch {
      /* unreadable marker -- fall through and re-apply */
    }
  }
  try {
    try {
      gitWithLockRetry(dir, ['sparse-checkout', 'set', '--cone', '--sparse-index', ...dirs], {
        env,
        _git,
      });
    } catch (e) {
      // plan 4087 T4 (review key 1ou5528): a COORD_CHECKOUT_TIMEOUT from the first attempt means
      // the child already hung and was reaped by boundedGit/boundedGitWithLockRetry (when `_git`
      // is coordBoundedGit — resolveCoordCheckout's coord-checkout callers) — retrying the SAME
      // operation without --sparse-index just re-runs into the same lock/I-O wedge for a SECOND
      // full COORD_CHECKOUT_GIT_TIMEOUT_MS, which is exactly the ~3-minute double-hold this key
      // measured. Propagate it immediately instead of retrying; only a genuine sparse-checkout
      // failure (old git, a corrupt cone spec, …) falls through to the plain --cone retry.
      if (e?.code === COORD_CHECKOUT_TIMEOUT) throw e;
      gitWithLockRetry(dir, ['sparse-checkout', 'set', '--cone', ...dirs], { env, _git });
    }
  } catch (e) {
    // Same reasoning for the outer catch-all: a genuine sparse-checkout failure is exactly what
    // the dense-fallback below exists for, but a COORD_CHECKOUT_TIMEOUT is a WEDGE, not a
    // sparse-checkout defect — forceCoordDense below issues its OWN unbounded git children, so
    // swallowing the timeout here and falling into it would extend the hold instead of ending it.
    // Let it surface as the named seam so a caller can tell "stayed dense, harmlessly" apart from
    // "the lock is still wedged".
    if (e?.code === COORD_CHECKOUT_TIMEOUT) throw e;
    forceCoordDense(dir, { env, _git });
    try {
      if (_existsSync(marker)) unlinkSync(marker);
    } catch {
      /* a stale marker over a dense tree only costs one wasted re-apply attempt */
    }
    return false;
  }
  try {
    _writeFileSync(marker, want, 'utf8');
  } catch {
    // No marker, no cone. The marker is what makes a sparse tree RECOGNISABLE as one this
    // tooling cut (planWorktreeIsSparse below keys on it), so a cone left standing with the
    // marker unwritten would be a sparse worktree the widening gates cannot see. Dense is slow,
    // not wrong; the next healthy call re-applies (/gpt-review keys 28ea89, a9653c, 5d6a7d).
    forceCoordDense(dir, { env, _git });
    return false;
  }
  return true;
}

// The coord checkout's call site (plan 3802): the top-level exclude list, coned against
// origin/master (see COORD_CONE_REF), marker COORD_SPARSE_MARKER.
//
// plan 4071 T2: `excludes` is caller-injected (coord.config.json's `coordCheckoutExcludedTopLevel`)
// rather than the former module constant -- resolveCoordCheckout, the one caller, resolves it.
export function ensureCoordSparseCheckout(
  dir,
  { excludes, env, _git = git, _existsSync = existsSync } = {},
) {
  return ensureSparseCheckout(dir, {
    excludes,
    markerName: COORD_SPARSE_MARKER,
    ref: COORD_CONE_REF,
    env,
    _git,
    _existsSync,
  });
}

// A plan worktree's call site (plan 3956): the nested exclude list, coned against the worktree's
// OWN HEAD -- at cut time that is the tip just cut (origin/master, or the adopted branch for a
// `--adopt` cut), which is exactly the tree about to be checked out; there is no reset-onto-a-newer-
// tip step here as there is in resolveCoordCheckout. Applied ONCE, between `worktree add
// --no-checkout` and the populating `checkout` (the plan-3802 sequence, so the dense tree is never
// written and then deleted again). A later merge/rebase that brings NEW directories under an
// excluded path's ancestors leaves them skip-worktree (git's normal sparse behaviour, no error);
// `widenPlanWorktree` materialises the excluded folder on demand.
//
// plan 4071 T2: `excludes` is caller-injected (coord.config.json's `planWorktreeExcludedPaths`) --
// every caller (cut-worktree.mjs's cutWorktree, and narrowPlanWorktree below) resolves it once and
// passes it down.
export function ensurePlanSparseCheckout(
  dir,
  { excludes, env, _git = git, _existsSync = existsSync, _writeFileSync = writeFileSync } = {},
) {
  return ensureSparseCheckout(dir, {
    excludes,
    markerName: PLAN_SPARSE_MARKER,
    ref: 'HEAD',
    env,
    _git,
    _existsSync,
    _writeFileSync,
  });
}

// True when `dir` is a plan worktree that is SPARSE right now: git's own worktree config says
// sparse AND the plan marker is present. Both halves carry meaning. The config is the live
// state -- a widened worktree (`sparse-checkout disable` flips it to false) reads dense even if
// a marker lingers. The marker is the POSITIVE identity -- it is written only by
// ensurePlanSparseCheckout, and only when the cone applied (a marker that could not be written
// forces the cut dense, see ensureSparseCheckout), so a hand-narrowed checkout, the coord
// checkout, or any sparse tree this tooling did not cut reads false and is never widened by a
// gate (/gpt-review keys a9653c, 9e0599, 5d6a7d: an earlier round keyed on "sparse and not the
// coord checkout", which would have disabled ANY sparse checkout a pytest-scoped push ran
// from). Best-effort: an unreadable worktree reads false (dense is the safe answer for every
// caller).
export function planWorktreeIsSparse(
  dir,
  { env, _git = git, _existsSync = existsSync, _readdirSync = readdirSync } = {},
) {
  try {
    const adminDir = _git(dir, ['rev-parse', '--absolute-git-dir'], { env }).trim();
    // Any marker GENERATION counts -- see PLAN_SPARSE_MARKER_RE's own comment for why testing
    // the current name alone orphaned every in-flight worktree on each bump. The fast path is
    // still a single existsSync for the overwhelmingly common current-generation case.
    if (
      !_existsSync(join(adminDir, PLAN_SPARSE_MARKER)) &&
      !planSparseMarkerIn(adminDir, { _readdirSync })
    )
      return false;
    return readSparseState(dir, { env, _git }).enabled;
  } catch {
    return false;
  }
}

// Make a sparse plan worktree DENSE ("widen"): one `sparse-checkout disable`, which materialises
// everything the tip carries -- the six excluded stores AND any directory a later merge/rebase
// brought in under their ancestors (a fixed `sparse-checkout add` of the six paths would leave
// such a newcomer skip-worktree while the worktree already read as dense: /gpt-review key
// 941d78). Idempotent; a no-op (returns false) on a dense worktree. The marker is removed
// afterwards as housekeeping only -- git's config, not the marker, is what planWorktreeIsSparse
// reads. Never re-cut a worktree to get the folder back; this is the sanctioned door.
export function widenPlanWorktree(dir, { env, _git = git, _existsSync = existsSync } = {}) {
  if (!planWorktreeIsSparse(dir, { env, _git, _existsSync })) return false;
  // `advice.sparseIndexExpanded=false`: the disable legitimately expands the sparse index once,
  // and git's eight-line hint about it is noise on a deliberate widen.
  gitWithLockRetry(dir, ['-c', 'advice.sparseIndexExpanded=false', 'sparse-checkout', 'disable'], {
    env,
    _git,
  });
  try {
    const adminDir = _git(dir, ['rev-parse', '--absolute-git-dir'], { env }).trim();
    // Whichever GENERATION this worktree was cut under (plan 4110) — unlinking only the current
    // name would leave a bumped-past marker behind on an older tree, which now still reads as
    // the sparse identity, so the widen would not fully clear it.
    const marker = planSparseMarkerIn(adminDir) || PLAN_SPARSE_MARKER;
    unlinkSync(join(adminDir, marker));
  } catch {
    /* the worktree reads dense by git's own config either way; the marker is only the identity half */
  }
  return true;
}

// True iff `dir` is the repository's MAIN checkout rather than a linked worktree: a linked
// worktree's admin dir is `.git/worktrees/<name>` while the common dir is `.git`; in the main
// checkout the two are the same directory.
//
// Both sides are canonicalised with realpathSync before comparison (/gpt-review round-2 keys
// 2197b9, f50ea4, 10a5ed, 3b1e2d, d4dcb1): a bare resolve() is lexical, so any alias for the same
// directory -- a symlinked path, a Windows 8.3 name, a case difference on a case-insensitive
// volume -- compared unequal and walked straight past a guard whose entire job is to keep a
// destructive operation off a checkout every session shares. `--git-common-dir` may come back
// relative, and it is relative to the command's cwd, which is `dir`.
//
// Canonicalisation that CANNOT silently degrade (/gpt-review round-3 keys 6092f3, 349c7f, 2d66ce,
// a3a7a2): an earlier draft fell back to a lexical resolve() when realpathSync threw, which put
// straight back the alias bypass the canonicalisation exists to close. Nothing is swallowed now —
// a realpath or git failure propagates, and narrowPlanWorktree turns it into a REFUSAL. The two
// error directions are not symmetric: a wrong refuse costs one loud, recoverable failed narrow,
// while a wrong allow runs a destructive sparse-checkout over a checkout every session in the
// sandbox shares. Both paths come from git and therefore exist, so a throw here is exceptional.
//
// Deliberately NOT check-coordination-branch.mjs's `isMainCheckout`: that module imports THIS one
// (GIT_MAXBUFFER), so reusing it here would be a circular import — and it takes a cwd with no
// `_git` seam and fails OPEN to "main", the opposite of what this caller needs.
function isMainCheckoutDir(dir, { env, _git = git, _realpathSync = realpathSync } = {}) {
  const adminDir = _realpathSync(_git(dir, ['rev-parse', '--absolute-git-dir'], { env }).trim());
  const commonDir = _realpathSync(
    resolve(dir, _git(dir, ['rev-parse', '--git-common-dir'], { env }).trim()),
  );
  return adminDir === commonDir;
}

// The whole-repo operations that make a narrow unsafe at ANY path. Each is a state whose working
// tree is mid-edit and whose resolution may not be committed yet, so `sparse-checkout set` dropping
// a file outside the new cone could destroy a conflict resolution that exists nowhere else. These
// live in the WORKTREE's own admin dir (`rev-parse --absolute-git-dir`), not the common dir, so a
// sibling worktree's rebase never blocks this one.
const NARROW_BLOCKING_GIT_STATES = Object.freeze([
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
]);

// What stands between `dir` and a safe narrow, split into the two classes that differ in kind:
//   blockers  — tracked content that `sparse-checkout set` WOULD DESTROY: an uncommitted change or
//               staged content under an excluded path, or an in-progress merge/rebase/cherry-pick/
//               revert. Unrecoverable if we get it wrong, so the caller refuses on any hit.
//   untracked — content sparse-checkout does NOT manage and therefore does NOT free. It never
//               blocks (nothing is at risk) but it is REPORTED, because it is the difference
//               between "the stores are off disk" and "the allowance is back": render output and
//               scratch written into a store during the run survive the narrow untouched.
// Ignored files are untracked too and are deliberately NOT enumerated here — `status` would need
// `--ignored` and the honest residual measurement is a size walk of what is left on disk after the
// narrow (cut-worktree's `narrowWorktree` does that), not a file list. What this reports is the
// cheap, precise half: files git can name.
//
// plan 4071 T2: `excludes` is caller-injected (coord.config.json's `planWorktreeExcludedPaths`)
// rather than the former module constant.
export function planNarrowBlockers(
  dir,
  { excludes, env, _git = git, _existsSync = existsSync } = {},
) {
  const blockers = [];
  const untracked = [];
  let adminDir = null;
  try {
    adminDir = _git(dir, ['rev-parse', '--absolute-git-dir'], { env }).trim();
  } catch {
    // Not a usable worktree. Report it as a blocker rather than narrowing something we cannot
    // even interrogate — the whole point of this gate is that being wrong is unrecoverable.
    return { blockers: ['(not a readable git worktree)'], untracked, adminDir: null };
  }
  for (const state of NARROW_BLOCKING_GIT_STATES) {
    if (_existsSync(join(adminDir, state)))
      blockers.push(`(${state} present: an operation is in progress)`);
  }
  let out = '';
  try {
    // `--untracked-files=all` so an untracked file deep inside a store is named individually
    // rather than collapsed to its directory — the residual report is only useful if it points
    // at something. Pathspec-scoped to the six stores: a dirty file ELSEWHERE in the worktree is
    // none of this gate's business (the narrow does not touch it), and blocking on it would make
    // the door unusable from exactly the mid-land moment it exists for.
    out = _git(dir, ['status', '--porcelain', '--untracked-files=all', '--', ...excludes], { env });
  } catch {
    // A status we cannot read is not evidence of a clean tree. Same reasoning as above: refuse.
    return {
      blockers: [...blockers, '(git status over the excluded paths failed)'],
      untracked,
      adminDir,
    };
  }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // Porcelain v1: two status chars then a space then the path ("?? path" for untracked).
    // Anything that is not `??` is tracked content git would drop with the cone — including
    // `R  a -> b` renames and `D ` deletions, which are edits we must not silently discard.
    if (line.startsWith('??')) untracked.push(line.slice(3).trim());
    else blockers.push(line.trim());
  }
  return { blockers, untracked, adminDir };
}

// Make a DENSE plan worktree sparse again ("narrow") -- the missing half of widenPlanWorktree
// (plan 4020). Applies the plan cone via ensurePlanSparseCheckout, so it works on a worktree that
// was cut dense BY CLASS (every 🟥 SEED-WRITE and every Pipe/DQ plan, per planWorktreeMode) and
// never carried a cone at all, not only on one that was widened. That is the whole point: plan
// 3982 built and pushed clean and then could not land, because `next build` ENOSPC'd in a sandbox
// whose dense worktree was holding 3.7 GB of stores it never needed, and there was no door back.
//
// REFUSES rather than destroys. `sparse-checkout set` removes tracked files outside the new cone,
// so a narrow over an uncommitted change under a store deletes work that exists nowhere else --
// the one failure here that cannot be undone. planNarrowBlockers is therefore a GATE, not a
// warning: on any hit this throws and changes nothing.
//
// Returns `false` (no-op) when the worktree is already narrowed TO THIS CONE, mirroring
// widenPlanWorktree's idempotent contract -- so a retry loop cannot report a second phantom
// saving. Otherwise returns what it excluded plus the untracked residual sparse-checkout did NOT
// free. "Already narrowed" is decided by ensurePlanSparseCheckout, which compares git's live
// pattern list against the wanted one, NOT by the marker alone: the marker only records that a
// cone was applied once, so a hand `sparse-checkout add` would otherwise leave a marked, sparse
// worktree with a store back on disk being waved through as "nothing to do" -- the silent miss
// this whole function exists to prevent (see the `!applied` branch below).
//
// plan 4071 T2: `excludes` is caller-injected (coord.config.json's `planWorktreeExcludedPaths`) --
// threaded through to planNarrowBlockers, ensurePlanSparseCheckout and sparseConeDirs below, and
// into every message/return value that used to read the module constant.
export function narrowPlanWorktree(
  dir,
  { excludes, env, _git = git, _existsSync = existsSync, _writeFileSync = writeFileSync } = {},
) {
  // plan 4071 review round 3 (finding 5dbf97): materialise `excludes` into an array ONCE, before
  // its very first use below -- `excludes` may be a one-shot iterable (a generator), and this
  // function reads it repeatedly (planNarrowBlockers's status pathspec, ensurePlanSparseCheckout,
  // the direct sparseConeDirs call for the postcondition, the length/spread in the throw and
  // return below). A generator consumed by the first of those would read as empty to every later
  // one, silently mis-narrowing or mis-reporting. Every reference below reads THIS array.
  const excludesArr = [...excludes];
  // The MAIN checkout is never a narrow target (/gpt-review keys 3239fa, e489c2). Unlike
  // widenPlanWorktree, this function deliberately does NOT require the plan marker -- it has to
  // work on a worktree cut dense BY CLASS that never carried a cone -- so the marker cannot be
  // what keeps it off a shared tree, and `--narrow --dir <path>` hands it a directory from a
  // caller with no slug. Narrowing the main checkout's `backend/data` is named OUT OF SCOPE by
  // plan 4020 for a reason: every session in the sandbox shares it. A linked worktree's admin dir
  // (`.git/worktrees/<name>`) differs from the common dir (`.git`); the main checkout's is the
  // common dir. `--git-common-dir` can come back relative, so it is resolved against `dir` --
  // `_git` runs with cwd=dir, which is what that relative path is relative to.
  let isMain;
  try {
    isMain = isMainCheckoutDir(dir, { env, _git });
  } catch (e) {
    // Cannot PROVE this is a plan worktree ⇒ refuse (see isMainCheckoutDir on the asymmetry).
    throw new Error(
      `narrowPlanWorktree: REFUSED — could not establish whether "${dir}" is the MAIN checkout ` +
        `(${e.message}). Refusing rather than risk narrowing a checkout every session shares.`,
    );
  }
  if (isMain)
    throw new Error(
      `narrowPlanWorktree: REFUSED — "${dir}" is the MAIN checkout, not a plan worktree. ` +
        `Narrowing a checkout every session shares is out of scope (plan 4020); narrow the plan worktree instead.`,
    );
  const { blockers, untracked } = planNarrowBlockers(dir, {
    excludes: excludesArr,
    env,
    _git,
    _existsSync,
  });
  if (blockers.length) {
    throw new Error(
      `narrowPlanWorktree: REFUSED — narrowing would discard uncommitted work under the excluded stores.\n` +
        `${blockers.map((b) => `  ${b}`).join('\n')}\n` +
        `Commit or stash the listed path(s) (or finish the in-progress operation), then narrow again.`,
    );
  }
  const applied = ensurePlanSparseCheckout(dir, {
    excludes: excludesArr,
    env,
    _git,
    _existsSync,
    _writeFileSync,
  });
  // plan 4071 review round 3 (findings f2e5cf/b33832): an EMPTY exclude list means the WANTED end
  // state is DENSE, not a cone -- ensureSparseCheckout above already treats it that way (forcing an
  // already-sparse checkout back to dense, or no-oping on an already-dense one). The postcondition
  // below must ask the matching question for that case: is the checkout dense, not "is a cone in
  // place" -- sparseConeDirs legitimately returns null for an empty list (see its own comment), so
  // asserting `wantDirs` truthy for THIS case would throw on every successful dense outcome,
  // including a no-op on an already-dense worktree. The core default (`planWorktreeExcludedPaths:
  // []`) hits this path on every non-vetapp checkout's `--narrow`.
  if (excludesArr.length === 0) {
    const liveDense = readSparseState(dir, { env, _git });
    if (liveDense.enabled) {
      throw new Error(
        `narrowPlanWorktree: "${dir}" still reads SPARSE after the attempt, but the exclusion list ` +
          `is empty (dense was wanted) — the sparse-checkout config was not disabled.`,
      );
    }
    // Dense achieved (or already was). `applied` says only whether THIS call did the work.
    return applied ? { narrowed: true, excluded: [], untracked } : false;
  }
  // The POST-CONDITION is VERIFIED, never inferred from `applied` alone (/gpt-review round-1 keys
  // cba137/98e984/0ce9f3/a3f9ae/415ad8 and round-2 keys 75fe1f/556aa0/35e7e6/2cfba2/bb379d -- ten
  // finders across two rounds, one root cause that survived the first fix). Both earlier designs
  // asked a WEAKER proxy: "is the marker there", then "is it sparse afterwards". Each has a state
  // that answers yes over a worktree still carrying a store -- a hand `sparse-checkout add` for
  // the first, and for the second an ensureSparseCheckout failure path that returns false having
  // touched neither config nor marker (a cone it could not compute).
  //
  // What is checked is the cone ITSELF -- git's live pattern list against a freshly recomputed
  // want-list -- which is the same comparison ensureSparseCheckout uses to decide its own
  // short-circuit, and is authoritative in a way neither proxy was. An uncomputable want-list is
  // itself a failure: if we cannot say what the cone should be, we cannot claim it is applied.
  //
  // NOT a disk check (`existsSync` on the six paths): that conflates two different things and was
  // wrong. Sparse-checkout removes TRACKED files; a store directory holding untracked or ignored
  // content survives the narrow by design -- which is precisely the residual this function
  // reports rather than pretends away -- so "the directory is still there" is a normal successful
  // narrow, not a failure. The repo's own untracked-residual test caught this.
  const wantDirs = sparseConeDirs(dir, {
    excludes: excludesArr,
    env,
    _git,
    ref: 'HEAD',
  });
  const live = readSparseState(dir, { env, _git });
  // The MARKER is part of the post-condition, not housekeeping (/gpt-review round-3 key cb7f5e):
  // widenPlanWorktree is gated on planWorktreeIsSparse, which needs marker AND config, so a cone
  // applied without the marker would be a worktree this tooling could narrow but never widen
  // again by the sanctioned door. Asserting it here is what makes the narrow REVERSIBLE.
  const marked = planWorktreeIsSparse(dir, { env, _git, _existsSync });
  if (!wantDirs || !live.enabled || !sameDirSet(live.dirs, wantDirs) || !marked) {
    throw new Error(
      `narrowPlanWorktree: the sparse cone is NOT in place on "${dir}" after the attempt — nothing was freed, ` +
        `and the ${excludesArr.length} heavy stores are still checked out. ` +
        `(${
          !wantDirs
            ? 'the cone could not be computed from HEAD'
            : !live.enabled
              ? 'the worktree reads DENSE'
              : !sameDirSet(live.dirs, wantDirs)
                ? "git's cone does not match the wanted one"
                : 'the plan-sparse marker is missing, so --widen could never reverse this'
        })`,
    );
  }
  // Cone verified. `applied` now says only WHICH of the two good outcomes this was: the cone was
  // (re)applied by this call, or it was already correct and nothing needed doing.
  return applied ? { narrowed: true, excluded: excludesArr, untracked } : false;
}

// A coord-write holds the lock for ONE op (sub-second normally; up to coordWrite's full retry budget
// under cross-PC contention). A crashed holder's lock never self-clears, so a holder older than this
// is reclaimed. Generous vs the worst-case legit hold so a slow-but-live op is never stolen from.
// staleMs must comfortably exceed the WORST-CASE legit hold so a slow-but-live op is never stolen
// (withCoordCheckout holds the lock across coordWrite's / claim-plan's full multi-attempt retry loop
// — under cross-PC network contention that can run tens of seconds), yet stay BELOW timeoutMs so a
// waiter still reclaims a genuinely-crashed holder within its own wait budget. 150s/240s gives a
// wide margin over the realistic worst hold (~tens of s) while bounding the post-crash wedge.
export const COORD_LOCK_STALE_MS = 150_000;
export const COORD_LOCK_TIMEOUT_MS = 240_000;

// True iff `dir` is a registered worktree of the repo at `mainDir` (path-normalised for Windows).
// plan 4087 T4 (review key 34au14): `_git` is bounded by the caller (resolveCoordCheckout passes
// coordBoundedGit) so this probe can no longer hang the coord-write lock indefinitely — but a
// bare catch that mapped ANY failure to `false` ("not registered") would turn a mere timeout into
// a false "unregistered" verdict, which sends resolveCoordCheckout into the DESTRUCTIVE
// rmSync+recreate branch on a hang instead of surfacing the wedge — the exact class of mistake
// finding 1ou5528 named for the sparse-checkout fallback. A COORD_CHECKOUT_TIMEOUT must propagate;
// every OTHER failure (a git too old for `--porcelain`, a corrupt/missing dir, …) still degrades
// to `false`, unchanged.
function isRegisteredWorktree(mainDir, dir, _git = git) {
  let out;
  try {
    out = _git(mainDir, ['worktree', 'list', '--porcelain']);
  } catch (e) {
    if (e?.code === COORD_CHECKOUT_TIMEOUT) throw e;
    return false;
  }
  const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();
  const target = norm(dir);
  return out
    .split('\n')
    .some((l) => l.startsWith('worktree ') && norm(l.slice('worktree '.length).trim()) === target);
}

// True iff `dir`'s internal git metadata is intact (plan 1606). A worktree can be registered AND
// present on disk yet still unusable when that metadata is corrupt — e.g. a truncated/null-byte
// `.git/worktrees/<name>/HEAD` from an interrupted git op (the fork()-crash class already
// documented for `index.lock`, hitting `HEAD` instead). Deliberately a pure fs check, NOT a git
// subprocess: `dir` is always a linked worktree, so its `.git` is a one-line `gitdir: <path>`
// pointer file (never a real `.git` dir) — reading it plus the target HEAD is enough to detect the
// corruption. A `git rev-parse` probe here would run through git()'s identity-fallback cache
// (probeIdentityFallbackEnv), which memoizes per-dir and is never invalidated: probing a corrupt
// worktree would permanently poison that dir's cache entry with the CI-bot fallback identity, so
// the very next commit into the freshly-recreated worktree at the same path would misattribute
// authorship even on a host with a real configured identity. Reading files also avoids adding a
// subprocess spawn to every resolveCoordCheckout call, which runs inside withCoordLock's
// cross-session critical section.
function isWorktreeLive(dir) {
  try {
    const gitFile = readFileSync(join(dir, '.git'), 'utf8');
    const gitDirLine = /^gitdir:\s*(.+)$/m.exec(gitFile);
    if (!gitDirLine) return false;
    const head = readFileSync(join(gitDirLine[1].trim(), 'HEAD'), 'utf8');
    return head.trim().length > 0;
  } catch {
    return false;
  }
}

// Acquire the coord-write lock via O_EXCL create. `token` uniquely identifies THIS op so release
// only ever unlinks our own lock. On EEXIST: reclaim a holder older than staleMs (or a corrupt
// file), else BUSY → jittered short poll until timeoutMs, then throw a { coordContention } error.
// Seams (sleep/now) injected for tests. Returns the token on success.
// F-006 (plan 1313, 2026-07-02 coord audit): TOCTOU-safe reclaim of a stale/orphaned coord-write
// lock. A plain `unlinkSync(lockPath)` right after deciding "stale" races two concurrent
// reclaimers: [B reads stale holder → A unlinks+creates a FRESH lock → B (still acting on its OLD
// stale read) unlinks A's fresh lock too → B creates its own] leaves TWO concurrent holders of the
// mutex that guards the single shared coord-checkout (`reset --hard`/`clean -fd`) — a silent
// double-mutation. This closes the window: re-read the file immediately before removing it, and
// remove it ONLY when its content is still BYTE-IDENTICAL to `capturedRaw` (the exact text the
// caller decided was stale). A mismatch means a racing reclaimer already acted (or a legitimate
// new holder appeared in the interim) — leave it untouched so the caller's retry loop re-evaluates
// against whatever is there now. Mirrors releaseCoordLock's token-compare-before-unlink pattern,
// generalized to the pre-JSON-parse raw text (an empty/corrupt lock has no token to compare).
// Never throws; returns true iff THIS call removed the file. Exported so the exact race can be
// unit-tested directly (acquireCoordLock's own retry loop is otherwise single-threaded JS and
// can't be made to interleave without this seam).
export function reclaimStaleLock(lockPath, capturedRaw) {
  let currentRaw;
  try {
    currentRaw = readFileSync(lockPath, 'utf8');
  } catch {
    currentRaw = null; // already gone — nothing left to reclaim
  }
  if (currentRaw !== capturedRaw) return false; // changed under us — a racing reclaimer won
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false; // a racer removed it between our compare and unlink — harmless
  }
}

// plan 1398 (item 4): the ONE shared lock-age clamp — `nowMs - refMs`, floored at 0 so a
// skewed/future reference timestamp (cross-host clock skew making a FRESH holder's iso read
// slightly ahead of `now`) is never read as "already stale" and reclaimed out from under a
// live holder. Returns NaN (never throws, never silently coerces) when `refMs` is not a
// finite number — a garbage/unparseable timestamp — so the caller's own "non-finite age stays
// reclaimable" policy (both acquireCoordLock below and landing-lock's corruptFileAgeMinutes)
// still applies; the vanished-file case (a stat that throws) is the caller's own try/catch,
// not this function's concern. Exported so the two lock subsystems' stale/corrupt-file-age
// semantics — previously two independently hand-derived copies of this exact clamp — can
// never silently diverge on the next edit (the plan-1313 TOCTOU/steal-race class that
// reintroduces if one copy is updated and the other isn't).
export function clampedAgeMs(nowMs, refMs) {
  if (!Number.isFinite(refMs)) return NaN;
  const ageMs = nowMs - refMs;
  return ageMs < 0 ? 0 : ageMs;
}

export function acquireCoordLock(
  lockPath,
  token,
  {
    staleMs = COORD_LOCK_STALE_MS,
    timeoutMs = COORD_LOCK_TIMEOUT_MS,
    sleep = sleepSync,
    now = Date.now,
    _reclaimStaleLock = reclaimStaleLock,
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx'); // O_EXCL: create-or-fail — the EEXIST IS the mutex
      try {
        // Stamp the holder iso from the SAME clock the staleness check reads (`now`), so the age
        // math is clock-consistent (prod: now=Date.now ⇒ identical to new Date(); tests inject now).
        writeSync(
          fd,
          JSON.stringify({
            token,
            pid: process.pid,
            host: hostname(),
            iso: new Date(now()).toISOString(),
          }),
        );
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Lock held — read the holder (raw text, THEN parsed) and decide reclaim vs wait.
    let holderRaw = null;
    try {
      holderRaw = readFileSync(lockPath, 'utf8');
    } catch {
      holderRaw = null; // vanished between the EEXIST and this read
    }
    let holder = null;
    if (holderRaw != null) {
      try {
        holder = JSON.parse(holderRaw);
      } catch {
        /* empty/unparseable — see the mtime fallback below */
      }
    }
    // CRITICAL (mutual exclusion): the O_EXCL create precedes the holder-JSON write by a microsecond,
    // so a racing acquirer can read the lock file while it is still EMPTY. We must NOT treat that as
    // reclaimable (an Infinity age) — doing so unlinks the winner's just-created lock and lets BOTH
    // proceed (observed: two concurrent worktree-adds racing HEAD). For an unparseable holder, fall
    // back to the FILE mtime: a just-created lock reads FRESH (→ BUSY, wait for the JSON), and only a
    // genuinely orphaned empty lock (old mtime, a writer that crashed mid-create) is reclaimed.
    // F-005 (plan 1313): the mtime fallback reads `now()` — the SAME injected clock the holder.iso
    // branch above uses — not a hardcoded `Date.now()`, so the whole function's age math stays
    // clock-consistent (the documented guarantee this branch used to quietly break under an
    // injected/skewed test clock).
    // Cross-host clock skew can make a FRESH holder's iso read as slightly in the FUTURE → a
    // negative age. That is a LIVE lock, not a stale one — clampedAgeMs (plan 1398 item 4, the
    // shared coord-git/landing-lock lock-age helper) floors it to 0 (fresh) so a skewed
    // sibling's lock is NEVER reclaimed. A non-finite age (NaN from a garbage iso, Infinity from a
    // vanished lock) stays reclaimable — genuinely corrupt/orphaned.
    let ageMs;
    if (holder?.iso) {
      ageMs = clampedAgeMs(now(), Date.parse(holder.iso));
    } else {
      try {
        ageMs = clampedAgeMs(now(), statSync(lockPath).mtimeMs);
      } catch {
        ageMs = Infinity; // lock vanished between read and stat — treat as free, retry the create
      }
    }
    if (!Number.isFinite(ageMs) || ageMs > staleMs) {
      // Stale (or a vanished/orphaned lock): reclaim via reclaimStaleLock (F-006), which re-reads
      // the file and removes it ONLY if unchanged since `holderRaw` was captured above — see its
      // doc comment for the two-reclaimer race this closes. Retry the O_EXCL create either way: if
      // WE reclaimed, the path is now vacant; if a racer beat us to it (or recreated it), the next
      // create EEXISTs and we re-evaluate fresh — only one create ever wins.
      _reclaimStaleLock(lockPath, holderRaw);
      continue;
    }
    if (now() >= deadline) {
      // holder may be null (an empty/unparseable lock that stayed mtime-fresh until the deadline) —
      // never deref it for the message, or the clean { coordContention } seam becomes a TypeError.
      const who = holder
        ? `${holder.token} (pid ${holder.pid}, host ${holder.host})`
        : 'an empty/unparseable lock file';
      const err = new Error(
        `coord-git: coord-write lock held by ${who}, age ${Math.round(ageMs / 1000)}s — timed out ` +
          `after ${Math.round(timeoutMs / 1000)}s. This is NORMAL transient contention; just re-run. ` +
          `If it persists, a coord write is wedged (inspect ${lockPath}).`,
      );
      err.coordContention = true;
      throw err;
    }
    sleep(backoffMs(attempt, { base: 50, cap: 500 }));
  }
}

// Release the coord-write lock iff WE own it (token match). Idempotent — a missing or foreign lock
// is left untouched. Never throws (close-out must never be blocked by a release).
export function releaseCoordLock(lockPath, token) {
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return; // gone or corrupt — nothing of ours to release
  }
  if (holder && holder.token === token) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already removed by a stale-reclaim */
    }
  }
}

// plan 1621: a single rmSync attempt against a Windows file-lock class error (EBUSY|EPERM|ENOTEMPTY
// — a killed process left an open handle under `.git/worktrees/<name>/`, the incident class
// docs/runbooks/branch-hygiene.md documents). On that class, sleeps for `backoff(attempt)` and
// returns the caught error so the CALLER's own retry loop can decide to try again; any other error
// is not transient and rethrows immediately. Returns `null` on success. Generalized by plan 1640 out
// of resolveCoordCheckout's inline try/catch so land-lib.mjs's reclaimLandDirIfSafe can share the
// exact same transient-classification + backoff instead of duplicating it — resolveCoordCheckout's
// recreate loop calls this once per outer iteration (its own attempt counter also drives the
// worktree-add retry below), while reclaimLandDirIfSafe wraps it in its own small bounded loop.
// Seams `_rmSync`/`_sleep`/`backoff` for tests.
export function attemptRmSyncWithBackoff(
  path,
  rmOpts,
  attempt,
  {
    _rmSync = rmSync,
    _sleep = sleepSync,
    backoff = (a) => backoffMs(a, { base: 100, cap: 1000 }),
  } = {},
) {
  try {
    _rmSync(path, rmOpts);
    return null;
  } catch (e) {
    if (!/EBUSY|EPERM|ENOTEMPTY/i.test(`${e?.code || ''}${e?.message || ''}`)) throw e;
    _sleep(backoff(attempt));
    return e;
  }
}

// Ensure the disposable coord-checkout exists and is reset to the FRESH origin/master tip, then
// return its absolute path. Created lazily (detached off origin/master) on first use; thereafter
// `reset --hard` + `clean -fd` to the fetched tip — it only ever holds transient coord-doc state, so
// a hard reset is always safe and leaves ZERO residue from a crashed prior op. MUST be called under
// the coord-write lock (it mutates the single shared coord-checkout). Seam `_git` for tests.
export function resolveCoordCheckout(
  mainDir,
  { env, _git = git, _rmSync = rmSync, timeoutMs = COORD_CHECKOUT_GIT_TIMEOUT_MS } = {},
) {
  const dir = coordCheckoutPath(mainDir);
  // plan 4071 T2: resolved ONCE per call from the repo root this function already receives, and
  // passed down to both ensureCoordSparseCheckout call sites below (coord.config.json's
  // `coordCheckoutExcludedTopLevel`, empty core default -- see the constant's former definition
  // above for the full rationale).
  const { coordCheckoutExcludedTopLevel: excludes } = loadCoordConfig(mainDir);
  // plan 4087 T2: the `_git` handed to BOTH ensureCoordSparseCheckout call sites below, never to
  // the plain `_git()`/`gitWithLockRetry` calls elsewhere in this function — those already go
  // through boundedGitWithLockRetry (the fetch above, the reset/clean below) or are short,
  // already-classified worktree-admin calls this plan does not touch. See boundedGit's own
  // header for why a per-call bound here (not one deadline around the whole function) is right.
  const coordBoundedGit = (d, a, o) => boundedGit(d, a, { ...o, timeoutMs, _git });
  // plan 4087 T1: bounded — see boundedGitWithLockRetry's own header for the full mechanism. This
  // fetch runs against mainDir (not the disposable checkout, which may not exist yet), so it is
  // called directly rather than through the syncCoordCheckoutToOriginMaster-shaped combinator the
  // reset+clean pair below could otherwise share — the worktree recreate/sparse-checkout logic
  // between this call and the reset/clean below is essential control flow, not duplicated timeout
  // wrapping (see the plan's own S7 note on why the trio is ONE shared PRIMITIVE, not one bundled
  // call, at every site).
  boundedGitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], {
    env,
    _git,
    timeoutMs,
  });
  // Recreate when NOT registered OR when its metadata isn't LIVE — dir gone (OS temp cleanup, a
  // manual rm, a crash mid-create) or present-but-corrupt (plan 1606: e.g. a truncated HEAD from an
  // interrupted op — isRegisteredWorktree alone passes in that case; isWorktreeLive's own fs read
  // already fails closed when `dir` doesn't exist, so no separate existsSync check is needed):
  // otherwise the `reset --hard` below would run against a dir git can't operate in and fatal (not
  // a lock/ref race → not retried), wedging EVERY subsequent coord write until a hand repair.
  // ── plan 2435 item 1: reachability verdict for "a sibling's RECREATION races our push" ───────
  // Plan 2393 lever 1 lets a sibling's entire coordWrite run inside our released window, so this
  // recreate branch (rmSync + prune + add) can in principle run while OUR `git push` subprocess has
  // this very directory as its cwd. Audited 2026-07-26 and judged NOT REACHABLE through the
  // concurrency path — recorded here so it is not re-litigated from first principles:
  //   * Entering this branch needs the checkout unregistered/absent/metadata-corrupt. Our own op
  //     resolved it registered+live under the lock moments earlier, so a sibling can only see it
  //     otherwise if an INDEPENDENT external event intervenes inside the ~4s window: an OS temp
  //     cleanup, a manual rm, or a crash truncating .git/worktrees/coord-worktree/HEAD. Concurrent
  //     coord writes alone cannot produce it — the common branch is `reset --hard` + `clean -fd`,
  //     which never touches the worktree's `.git` pointer file or its admin HEAD.
  //   * Measured: the files `git worktree add` writes at creation (commondir, gitdir, refs/) carried
  //     mtime 2026-07-13 — 13 days of continuous ~5-7-session operation with ZERO recreates. In the
  //     observable journal window alone (2026-07-25T19:44 → 2026-07-26T12:48) that is 478 coord ops,
  //     129 of them with a lever-1 released window, and no recreate.
  //   * The one sub-case that WOULD bite if this branch were ever entered concurrently is bounded
  //     and already correct: attemptRmSyncWithBackoff spends 6 jittered attempts (1.75-3.5s, ~2.6s
  //     expected — backoffMs halves-and-jitters) against a ~4s push holding an open handle, so the
  //     budget CAN expire; when it does the SIBLING throws with `lastStage` already naming rmSync as
  //     the culprit, and the next op self-heals. A loud, correctly-attributed, recoverable failure
  //     in the sibling — not a corrupted push in us.
  // Therefore NO guard is added here (per the plan: a guard on an unreachable path is tech debt with
  // a comment attached). The structural remedy if the precondition ever changes is recorded in
  // docs/runbooks/branch-hygiene.md § The coord-write critical section: run coordWrite's push +
  // verify against the git COMMON DIR rather than this disposable checkout, which deletes the class
  // outright. Trip-wire to revisit: a `metadata-corruption` or rmSync-exhaustion `reason` appearing
  // on error lines in .git/coord-op-journal.jsonl (minable since item 2 of this same plan).
  // plan 4087 T4 (review key 34au14): bounded via coordBoundedGit, not the raw `_git` — see
  // isRegisteredWorktree's own header for why its catch must also distinguish the timeout.
  if (!isRegisteredWorktree(mainDir, dir, coordBoundedGit) || !isWorktreeLive(dir)) {
    // plan 2481: evict any memoized indexLockPath(dir) BEFORE the recreate below — a failed or
    // partial removal must never leave a stale entry behind (over-eviction is always safe; one
    // extra `rev-parse` subprocess on the next call, vs. under-eviction silently defeating the
    // stale-lock auto-heal for the rest of this process).
    invalidateIndexLockPath(dir);
    // Ensure the parent (.claude/) exists — always true in the real repo, but a fresh clone (a test
    // origin) lacks it, and `git worktree add` into a missing parent dir flakes on this Windows host
    // ("cannot lock ref 'HEAD'" during the worktree's HEAD setup).
    mkdirSync(dirname(dir), { recursive: true });
    // Not a registered worktree: prune any stale registration, drop a leftover dir, add fresh.
    // `git worktree add` transiently fails on this shared-.git Windows host with
    // "cannot lock ref 'HEAD'" / "unable to resolve reference 'HEAD'" (a brief ref-lock race during
    // the new worktree's HEAD setup — the same transient class plan 980/983 retry for commits).
    // Retry a few times, pruning + dropping the half-created worktree between attempts so the retry
    // doesn't die "already exists"; surface a non-transient failure immediately.
    let added = false;
    let lastErr;
    // review fix: track which retry step actually failed last, so an all-6-exhausted error
    // names its real cause — the rmSync EBUSY/EPERM retry below can exhaust all 6 attempts on
    // its own (via `continue`, never reaching `worktree add` at all), and the error must not
    // always blame `worktree add` in that case.
    let lastStage = 'worktree add';
    for (let i = 0; i < 6 && !added; i++) {
      // Order matters: rm the (possibly half-created) dir FIRST, THEN prune — so prune sees the dir
      // gone and clears the dangling registration. Pruning BEFORE the rm leaves the registration
      // (its dir still present), and the retry's `add` then auto-suffixes a NEW worktree
      // (coord-worktree1) instead of reusing the intended path.
      // Windows file-lock class (a killed process left an open handle under
      // .git/worktrees/<name>/, e.g. a crashed coord op — the same incident class
      // docs/runbooks/branch-hygiene.md documents): retry with backoff instead of throwing
      // uncaught, matching the worktree-add catch below. attemptRmSyncWithBackoff (plan 1621,
      // extracted for reuse by plan 1640) already slept on a transient hit and rethrows
      // anything non-transient itself, so this call site doesn't need its own try/catch.
      if (existsSync(dir)) {
        const rmErr = attemptRmSyncWithBackoff(dir, { recursive: true, force: true }, i, {
          _rmSync,
        });
        if (rmErr) {
          lastErr = rmErr;
          lastStage = 'rmSync (Windows file lock)';
          continue;
        }
      }
      try {
        // plan 4087 T4 (review keys 1y6wcqv/1jxdbcr/1v3sg4d/5f0a0w/1awyotd): bounded, same
        // primitive as every other coord-checkout git child in this function — an unbounded
        // `worktree prune` under the coord-write lock is exactly the wedge class T1 exists to
        // remove. A COORD_CHECKOUT_TIMEOUT must still surface (never silently read as "nothing to
        // prune"), so it is rethrown before the catch-all below.
        coordBoundedGit(mainDir, ['worktree', 'prune'], { env });
      } catch (e) {
        if (e?.code === COORD_CHECKOUT_TIMEOUT) throw e;
        /* nothing to prune */
      }
      try {
        // `--no-checkout` (/gpt-review key eedd67): without it this materialises the ENTIRE
        // dense tree first and the cone then deletes ~90% of it again -- on this repo that is a
        // measured ~10 MINUTES of full-tree checkout, all of it under the coord-write lock, on
        // the one path that already only runs after something went wrong. Create the worktree
        // empty, narrow it, then populate: the same end state for a few seconds of work.
        // plan 4087 T4 (review keys 1y6wcqv/1jxdbcr/1v3sg4d/5f0a0w/1awyotd): bounded — this and
        // the `checkout` below were the last two unbounded git children on the recreate branch;
        // ensureCoordSparseCheckout in between already receives coordBoundedGit.
        coordBoundedGit(
          mainDir,
          ['worktree', 'add', '--no-checkout', '--detach', dir, 'origin/master'],
          {
            env,
          },
        );
        ensureCoordSparseCheckout(dir, { excludes, env, _git: coordBoundedGit });
        boundedGitWithLockRetry(dir, ['checkout'], { env, _git, timeoutMs });
        added = true;
      } catch (e) {
        // A COORD_CHECKOUT_TIMEOUT's message never matches either pattern below, so it already
        // falls through to `throw e` here untouched -- named explicitly so a future edit to this
        // catch doesn't accidentally fold it into the transient-retry path.
        if (e?.code === COORD_CHECKOUT_TIMEOUT) throw e;
        const out = errText(e);
        if (!/cannot lock ref|unable to resolve reference/i.test(out) && !LOCK_RX.test(out))
          throw e;
        lastErr = e;
        lastStage = 'worktree add';
        sleepSync(backoffMs(i, { base: 100, cap: 1000 }));
      }
    }
    if (!added) {
      const err = new Error(`coord-git: ${lastStage} for the coord-checkout failed after retries`);
      err.cause = lastErr;
      throw err;
    }
  }
  // plan 3802: narrow the checkout BEFORE the reset/clean below, so those two -- the most
  // expensive steps in the critical section -- already run against the cone on the first op.
  ensureCoordSparseCheckout(dir, { excludes, env, _git: coordBoundedGit });
  // plan 4087 T1: bounded, same primitive as the fetch above — see boundedGitWithLockRetry's header.
  boundedGitWithLockRetry(dir, ['reset', '--hard', 'origin/master'], { env, _git, timeoutMs });
  boundedGitWithLockRetry(dir, ['clean', '-fd'], { env, _git, timeoutMs });
  return dir;
}

// ── plan 1286: pre-flight op journal for mutating coord ops ──────────────────────────────────
// A tool-call timeout can SIGKILL a coord op anywhere (the 2026-07-02 thrash logged 12+ exit-143
// kills of mutating git on one machine). The lock stale-steal and the coord-checkout hard-reset
// already make the NEXT op self-heal; what was missing is EVIDENCE — heal-main needs to know an
// op was interrupted (vs never ran) to finish/abort it knowingly instead of guessing. Every
// withCoordLock/withCoordCheckout op appends a `start` line before running and a `done`/`error`
// line after; a `start` with no closing line and a dead pid IS the interrupted-op signal.
// Journal lives in the SHARED git common dir (like the coord-write lock), is size-rotated, and
// every journal write is best-effort — evidence must never break the op it describes.
const COORD_OP_JOURNAL_BASENAME = 'coord-op-journal.jsonl';
export function coordOpJournalPath(mainDir) {
  return join(resolveCommonDirPath({ anchor: mainDir }), COORD_OP_JOURNAL_BASENAME);
}

const JOURNAL_ROTATE_BYTES = 256 * 1024;
// Exported (plan 4087 round-3 review, finding 1) so coord-op-stats.mjs's overlap-only journal
// trim can bound its match window to the SAME 200 lines rotation actually copies, instead of a
// second hardcoded copy of this number drifting from it.
export const JOURNAL_KEEP_LINES = 200;

// ── plan 2948: clock-free process identity for the journal's liveness signal ─────────────
// A journal entry's `pid` alone cannot answer "is the owner still alive": the OS recycles
// pids, so a long-dead window whose number was reissued reads as live forever. The wall
// clock was the only thing bounding that hazard (REBASE_WINDOW_RECENT_MS), which put the
// whole signal at the mercy of a wrong clock — the oscillation plan 2939 measured across
// three review rounds and refused to patch a fourth time.
//
// The fix is to stop asking TIME and ask IDENTITY, which is the SAME question plan 2738
// already answered for the worktree lock and for the same reason ("existence is not
// identity" — its own header). The OS probe is therefore `processStartToken`, reused
// verbatim, never a second copy: it already reads `/proc/<pid>/stat` field 22 through
// kill-tree's one `procStatFields` parsing convention, already prefers PowerShell's
// FILETIME over `tasklist` on win32, and already memoises this process's own token so a
// hot path pays for it once.
//
// What this layer ADDS is the one property the lock does not need and the journal does: a
// coord-op journal entry OUTLIVES A REBOOT (the residue it describes is still on disk after
// one), while a worktree lock does not. Linux's field 22 is ticks-SINCE-BOOT, so across a
// reboot a recycled pid can land on the same tick count and read as live. So the token is
// qualified before it is stored:
//
//   linux  →  `linux:<boot_id>:<starttime-ticks>`   boot_id from /proc/sys/kernel/random/boot_id
//   win32  →  `win32:<FILETIME int64>`              absolute already; a reboot cannot repeat it
//   else   →  null
//
// If the boot id cannot be read, this returns NULL rather than an unqualified token. That is
// the safe direction and the whole reason the qualifier exists: an unqualified Linux token is
// exactly the across-reboot collision above, and a collision here SPARES dead residue, which
// is the MAIN-wedging failure this plan was written to remove. `null` means "no identity
// evidence", which the caller degrades to the wall-clock path (grill ruling 6) — a bounded
// answer, never a wrong one.
//
// `darwin` and other BSDs return null deliberately. `processStartToken` does answer there, via
// `ps -o lstart=`, but only to one-SECOND resolution — a pid recycled inside the same second
// yields an identical token. The worktree lock accepts that because its fallback is an age
// CEILING that still reaps; ours would be a false spare. The repo's two real hosts are Windows
// and Linux, so this costs nothing real and keeps the fail direction honest.
export function rebaseOwnerToken(
  pid,
  {
    platform = process.platform,
    _startToken = processStartToken,
    _procStatFields = procStatFields,
    _readFile = readFileSync,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const start = _startToken(pid);
    return start ? `win32:${start}` : null;
  }
  if (platform !== 'linux') return null;
  // ONE `/proc` snapshot answers both questions, deliberately — `processStartToken` is NOT used
  // on this path, for two reasons its own callers do not have:
  //   • Its POSIX branch falls back to `ps -o lstart=` when /proc is unreadable, which resolves
  //     only to the SECOND. Labelling that as a `linux:<boot>:<ticks>` token would quietly
  //     promote a one-second-resolution value into a reboot-qualified identity, and a pid
  //     recycled inside that second would read as the SAME process — a false spare, which is the
  //     MAIN-wedging direction. The worktree lock can accept it (its fallback is an age ceiling
  //     that still reaps); we cannot.
  //   • A separate state probe and start probe are two reads of a moving target: a process can
  //     exit and be reaped between them, so the pair could describe two different moments.
  // `procStatFields` — the shared parsing convention, still reused — gives state and starttime
  // from the same read: [0] = state, and /proc field N is index N-3, so field 22 → index 19.
  const fields = _procStatFields(pid);
  if (!fields) return null; // no /proc, or the pid is gone — no identity evidence
  // A ZOMBIE is dead but not yet reaped, so it keeps its pid AND its start time; identity alone
  // would read it as live forever. Its liveness is settled by `pidAlive` (which reads the same
  // state field), not here — this only refuses to MINT an identity for a corpse.
  if (fields[0] === 'Z') return null;
  const ticks = String(fields[19] ?? '').trim();
  if (!/^\d+$/.test(ticks)) return null; // not the shape we can byte-compare
  let boot;
  try {
    boot = _readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    boot = '';
  }
  return boot ? `linux:${boot}:${ticks}` : null;
}

// This process's own token, memoised for the same reason `selfStartToken` is: our start time
// cannot change, and the writer sits inside `pushMasterWithRebase`'s retry loop, where a fresh
// subprocess per attempt would be pure waste on win32. A null is cached too — a probe that
// failed once for this process will keep failing.
let _selfRebaseToken;
export function selfRebaseOwnerToken({ _token = rebaseOwnerToken } = {}) {
  if (_selfRebaseToken === undefined) _selfRebaseToken = _token(process.pid);
  return _selfRebaseToken;
}

// plan 4087 T0/T1 (S8's own measurement nearly died to this): rotation used to DISCARD every line
// before the truncation point, so the journal's real retention was whatever fit in
// JOURNAL_ROTATE_BYTES — measured ~1-2 days under normal load (see the ledger line
// `coord-op-journal-truncates-in-place-so-no-multi-day-measurement-is-possible`, 2026-08-05). Now
// the pre-rotation content is appended to a DAILY file beside the live journal
// (coord-op-journal-YYYY-MM-DD.jsonl, dated by the day rotation happens, in the same dir as `p`)
// before the live file is truncated to its tail — a week of ops survives across many rotations, and
// the live file's tail contract (readCoordOpJournal / heal-main's openCoordOps fold) is unchanged.
// Exported so a stats script (T0) or a test can point at the archive directly. Best-effort like
// every journal write — an archive failure must never block the live rotation, and journalCoordOp's
// own outer try/catch means neither can ever throw into the op being journaled.
//
// plan 4087 round-4 review (keys c67d42/00ed01/5840c6/4ef78b/3a6139): archiving used to copy the
// WHOLE pre-rotation file, then truncate the live file to its own last JOURNAL_KEEP_LINES lines —
// so the kept tail existed in BOTH places at once, and every reader needed an ever-more-clever
// overlap trim to avoid double-counting it (three review rounds of that trim each found a new edge
// case it missed). The fix is at the SOURCE: archive only the lines being REMOVED (everything
// before the kept tail), never the tail itself. With that, "every archive, oldest first, then the
// live file" is the exact history with no line ever appearing twice — the reader needs no
// dedup logic at all (see collectJournalEntries's own header, coord-op-stats.mjs).
//
// Not atomic across its two writes (append-to-archive, then rewrite-live) — a crash in between
// leaves the removed lines archived AND still sitting in the (not-yet-truncated) live file, so the
// NEXT rotation would archive them a second time. That is a DUPLICATE, never a LOSS: the order is
// chosen deliberately so the failure mode is the recoverable direction. No repair machinery is
// added for that window — a duplicate is cheap to tolerate and the crash window itself is tiny.
// plan 4087 round-3 review (finding 3, key c69e0c) — the ONE place that splits a journal path
// into "everything before the extension" and "the extension itself" (the dot plus whatever
// follows it, or '' when there is none). `coordOpJournalDailyPath` and `coordOpJournalArchiveRegex`
// both derive from this instead of each re-deciding independently how to handle a custom journal
// path that doesn't end in `.jsonl` — before this they disagreed: the writer appended the dated
// suffix with NO `.jsonl` for such a path (`${p}-${dated}`) while the reader's regex still
// required a trailing `.jsonl` unconditionally, so a custom `--journal` path's archives were
// written under one name and matched under another and never found.
function splitJournalPathExt(p) {
  const m = /\.[^./\\]+$/.exec(p); // trailing "." + non-separator chars, e.g. ".jsonl"
  return m ? { stem: p.slice(0, -m[0].length), ext: m[0] } : { stem: p, ext: '' };
}

export function coordOpJournalDailyPath(p, { now = () => new Date() } = {}) {
  const dated = now().toISOString().slice(0, 10);
  const { stem, ext } = splitJournalPathExt(p);
  return `${stem}-${dated}${ext}`;
}

// plan 4087 round-2 review (finding: archive naming duplicated) — the ONE definition of "does
// this filename match `journalPath`'s daily-archive convention", shared by the writer
// (coordOpJournalDailyPath, immediately above) and the reader (coord-op-stats.mjs's
// listArchiveJournalPaths). Previously the reader reimplemented this regex by hand, on the
// reasoning that a read-only journal reporter should keep its import surface to node builtins
// plus `coordOpJournalPath`; that reasoning still holds for the WRITE-side machinery in this
// file, but not for a second copy of a string convention the writer already owns — two copies of
// a filename pattern is exactly the drift class this file's other "ONE definition" comments
// (isTransientIndexWrite, STASH_LIST_ARGS, …) exist to prevent. Takes the live journal PATH (not
// the dir), matching `coordOpJournalDailyPath`'s own input shape, and shares the same
// `splitJournalPathExt` split so the two can never describe two different filenames for the
// same journal path again (round-3 review, finding 3).
export function coordOpJournalArchiveRegex(journalPath) {
  const { stem, ext } = splitJournalPathExt(basename(journalPath));
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escapedStem}-\\d{4}-\\d{2}-\\d{2}${escapedExt}$`);
}

function rotateCoordOpJournal(
  p,
  { _readFileSync = readFileSync, _appendFileSync = appendFileSync } = {},
) {
  let full;
  try {
    full = _readFileSync(p, 'utf8');
  } catch {
    return; // can't read what's there — nothing to archive, leave rotation to the caller's own catch
  }
  const allLines = full.split('\n').filter(Boolean);
  // `slice(0, -JOURNAL_KEEP_LINES)` degrades to `slice(0, 0)` (empty) when there are fewer than
  // JOURNAL_KEEP_LINES lines total — nothing removed, the whole file is the kept tail — for free,
  // via plain JS negative-index clamping.
  const removed = allLines.slice(0, -JOURNAL_KEEP_LINES);
  const tail = allLines.slice(-JOURNAL_KEEP_LINES);
  try {
    if (removed.length) _appendFileSync(coordOpJournalDailyPath(p), removed.join('\n') + '\n');
  } catch {
    /* best-effort — losing the daily archive must never block the live-file truncation below */
  }
  // Archive-then-truncate, deliberately: a crash between these two writes leaves `removed` both
  // archived AND still present in the (un-truncated) live file, so a later rotation archives it a
  // SECOND time — a tolerable duplicate, never a loss. See this function's header comment.
  writeFileSync(p, tail.join('\n') + '\n');
}

export function journalCoordOp(mainDir, entry, { path } = {}) {
  try {
    // `path` lets a caller that journals repeatedly (withCoordLock: start + done/error)
    // resolve the git-common-dir ONCE instead of re-spawning rev-parse per line.
    const p = path || coordOpJournalPath(mainDir);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        host: hostname(),
        ...entry,
      }) + '\n';
    try {
      if (statSync(p).size > JOURNAL_ROTATE_BYTES) rotateCoordOpJournal(p);
    } catch {
      /* no journal yet */
    }
    appendFileSync(p, line);
  } catch {
    /* best-effort — journaling must never break the op */
  }
}

// Parsed journal entries, oldest first; corrupt lines are skipped. Read-only (heal-main).
export function readCoordOpJournal(mainDir) {
  try {
    return readFileSync(coordOpJournalPath(mainDir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// plan 2435 item 2: a SHORT, bounded classification token for an error-phase journal entry.
// The journal's whole value is being minable after the fact, but until now an `error` line carried
// only {ts,pid,host,tool,token,phase} — so the failure signature item 2 needs to measure ("a
// coordWrite that exhausted its 8 attempts claiming origin kept advancing, while origin was in fact
// quiet") was indistinguishable from every other error line. This is deliberately a fixed VOCABULARY
// rather than the error text: journal lines are appended on every op and the file rotates at 256KB,
// so an unbounded message would shrink the retained window (already only ~17h) and could leak a
// path into a file that is never scrubbed. Forward-only — readCoordOpJournal skips unknown keys, and
// every historical line simply has no `reason`.
export function coordErrorReason(e) {
  if (!e) return 'unknown';
  if (e.pushUnverified) return 'push-unverified';
  if (e.coordContention) return 'lock-contention';
  if (e.reacquireFailed) return 'reacquire-failed';
  // Keyed on a STRUCTURED flag coordWrite sets, NEVER on the message text (review 2026-07-26,
  // finding 6). "blocked after N attempts — origin/master kept advancing" is not unique to
  // coordWrite: claim-plan.mjs's claim-projection retry loop and coord-edit.mjs's coordEditApply
  // loop each throw their OWN exhaustion carrying that same wording, and both run inside a
  // withCoordCheckout → withCoordLock callback — so a text match labelled them `exhausted-nonff`
  // and silently polluted the very signature this field exists to measure. (The first cut also
  // justified testing this before isNonFastForward on the grounds that the exhaustion "carries its
  // non-ff cause"; that was simply wrong — errText reads only stdout/stderr/message, never
  // `.cause` — so the ordering never did what the comment claimed.)
  if (e.coordWriteExhausted) {
    // The discriminator item 2 exists to create: an exhaustion that ALSO saw foreign dirt is a
    // different bug from one that genuinely lost every race to a busy origin.
    return e.foreignDirtAtExhaustion?.length ? 'exhausted-foreign-dirt' : 'exhausted-nonff';
  }
  const out = errText(e);
  if (isForeignDirtRefusal(e)) return 'foreign-dirt';
  if (isNonFastForward(e)) return 'non-ff';
  if (isMetadataCorruption(out)) return 'metadata-corruption';
  if (LOCK_RX.test(out) || isTransientIndexWrite(out)) return 'transient-git-lock';
  return 'other';
}

// Serialize `fn` on the coord-write lock WITHOUT resolving the coord-checkout (plan 1286).
// For the rare op that is legitimately MAIN-scoped by nature (the Stop-hook dirt heal, whose
// job IS the main checkout's working tree; heal-main's single-actor repair pass) but must
// still never interleave with a coord write mid-flight. Everything that WRITES a coord doc
// wants withCoordCheckout below, not this.
//
// COORD_MAIN_DIR short-circuit: done-worktree's spine already serializes via the landing-lock,
// so a nested acquire here would only add a second mutex (and a deadlock surface).
// The lock handle for the paths that hold NO coord lock (done-worktree's COORD_MAIN_DIR spine,
// already serialized by the landing lock, and coordWrite called without a wrapper). Release and
// reacquire are no-ops: there is no critical section to shrink, so lever 1 is inert there rather
// than conditional at every call site.
export const NO_COORD_LOCK = Object.freeze({
  release: () => {},
  reacquire: () => {},
  held: false,
});

export function withCoordLock(mainDir, fn, lockOpts = {}) {
  if (process.env.COORD_MAIN_DIR) return fn(NO_COORD_LOCK); // already serialized by done-worktree's landing lock
  const lockPath = coordLockPath(mainDir);
  const token = `${process.pid}-${hostname()}-${Math.floor(Math.random() * 1e9)}`;
  // plan 4136 E2: measure wall-clock time spent INSIDE acquireCoordLock (queued behind a
  // sibling's held lock) using the exact same clock seam acquireCoordLock itself reads
  // (`lockOpts.now`, defaulting to `Date.now` — the same default acquireCoordLock's own `now`
  // parameter uses), so a test that injects `now` sees a wait consistent with the age math
  // acquireCoordLock already does internally, and prod pays no new clock source. Before this,
  // the journal's `start` line was written only AFTER acquireCoordLock returned, so time spent
  // queued behind a busy lock (as opposed to time spent holding it) was invisible to the journal.
  const nowFn = lockOpts.now || Date.now;
  const acquireStart = nowFn();
  acquireCoordLock(lockPath, token, lockOpts);
  const waitMs = clampedAgeMs(nowFn(), acquireStart);
  const tool = lockOpts.tool || 'coord';
  // The journal lives beside the lock in the same common dir — derive its path from the
  // already-resolved lockPath so the start AND close lines cost zero extra rev-parse spawns.
  // ONE shared basename constant with coordOpJournalPath (review 2026-07-02: a second
  // literal here could silently drift the writer away from readCoordOpJournal's reader).
  const journalPath = join(dirname(lockPath), COORD_OP_JOURNAL_BASENAME);
  // `waitMs` (plan 4136 E2): 0 for an uncontended acquire, >0 for one that queued behind a
  // sibling. A journal line written before this change carries no `waitMs` at all — readers
  // (coord-op-stats.mjs) must treat its absence as "no data", never as a measured zero.
  journalCoordOp(mainDir, { tool, token, phase: 'start', waitMs }, { path: journalPath });
  // plan 2393 lever 1: the lock may be handed back EARLY by the inner fn (coordWrite releases it
  // after its commit so the push + verify round-trips run unserialized), and re-taken if that push
  // is rejected non-ff and the scoped rollback has to run. So `held` tracks ownership and every
  // close is idempotent — a double release would drop a lock a SIBLING has since acquired, which
  // is worse than leaking one (releaseCoordLock is token-checked, but only against the file's
  // current holder, so re-releasing after a sibling took over would be a silent cross-session
  // unlock). Journal phases stay pair-wise foldable for heal-main's openCoordOps (any non-start
  // line closes the token, a fresh `start` re-opens it): start → release → start → done. A crash
  // in the released window leaves NOTHING to heal — no lock held, and our commit is an unreferenced
  // object the next default-expiry `git gc` collects — so reporting the op closed there is honest.
  let held = true;
  // plan 2435 item 2: `reason` is written ONLY on the error phase (see coordErrorReason) — a
  // start/release/done line's shape is unchanged, so every existing journal reader and the
  // pair-wise phase fold above are untouched.
  // `extra` (plan 4136 E2) lets `reacquire` below attach `waitMs` to its re-opened `start` line
  // without a second journaling code path — every other caller omits it and gets the old shape.
  const journal = (phase, reason, extra) =>
    journalCoordOp(
      mainDir,
      { tool, token, phase, ...(reason ? { reason } : {}), ...(extra || {}) },
      { path: journalPath },
    );
  // Journaling the op's OUTCOME and owning the lock are separate concerns (review 2026-07-25,
  // findings 4+5): an early `ctx.release()` must not swallow the terminal `done`/`error` line, or
  // every lever-1-wired op would journal `start → release` and NEVER record how it ended — silently
  // undercounting completions for anything that keys on `done` (coord-git.test.mjs already does
  // exactly that for push-rebase) and, worse, losing the `error` line when assertPushReachedOrigin
  // throws AFTER the release. So `close` always journals; it releases only if we still hold.
  const close = (phase, reason) => {
    journal(phase, reason);
    if (!held) return;
    held = false;
    releaseCoordLock(lockPath, token);
  };
  const release = () => close('done');
  // The handle handed to fn. `reacquire` re-takes the SAME lockPath with the SAME token (so the
  // release below still matches) and re-opens the journal entry, because the window it guards —
  // the non-ff rollback — mutates the shared coord-checkout again.
  const lockCtx = {
    // The EARLY hand-back: journal `release` and drop the lock, but leave the op open so `close`
    // can still record its terminal phase. Idempotent — a double release would drop a lock a
    // SIBLING has since acquired (releaseCoordLock is token-checked only against the file's
    // current holder), which is worse than leaking one.
    release: () => {
      if (!held) return;
      held = false;
      journal('release');
      releaseCoordLock(lockPath, token);
    },
    reacquire: () => {
      if (held) return;
      // Same wait measurement as the initial acquire above (plan 4136 E2) — the non-ff rollback
      // window can itself queue behind a sibling that grabbed the lock during the released gap.
      const reacquireStart = nowFn();
      acquireCoordLock(lockPath, token, lockOpts);
      const waitMs = clampedAgeMs(nowFn(), reacquireStart);
      held = true;
      journal('start', undefined, { waitMs }); // re-opens the entry for heal-main's openCoordOps fold
    },
    get held() {
      return held;
    },
  };
  let result;
  try {
    result = fn(lockCtx);
  } catch (e) {
    close('error', coordErrorReason(e));
    throw e;
  }
  // Promise-aware: a SYNC fn (board/index/queue/next-plan-id/claim-plan) releases the lock now and
  // returns its value directly; an ASYNC fn (move-plan/coord-edit, whose main() awaits withRetry)
  // releases only AFTER the promise settles, so the lock is held for the whole op. A bare
  // try/finally would release on the synchronous return of the promise — i.e. before the work runs.
  if (result && typeof result.then === 'function') {
    return result.then(
      (v) => {
        release();
        return v;
      },
      (e) => {
        close('error', coordErrorReason(e));
        throw e;
      },
    );
  }
  release();
  return result;
}

// The coord-doc write entrypoint: serialize on the coord-write lock, resolve+reset the disposable
// coord-checkout, run `fn(coordCheckoutDir)` against it, and ALWAYS release the lock. A coord tool
// wraps its coordWrite/move/commit in this and does ALL its file ops relative to the dir `fn`
// receives — so the write lands in the disposable tree, never the shared MAIN checkout.
//
// COORD_MAIN_DIR short-circuit: done-worktree's post-merge spine already isolates its coord writes
// in a per-land ephemeral detached worktree (plan 971) and serializes via the landing-lock, so when
// that override is set we run `fn` directly on it — NO nested coord-checkout, NO second lock.
export function withCoordCheckout(
  mainDir,
  fn,
  { env, _git = git, timeoutMs = COORD_CHECKOUT_GIT_TIMEOUT_MS, ...lockOpts } = {},
) {
  if (process.env.COORD_MAIN_DIR) return fn(mainDir, NO_COORD_LOCK); // already isolated + serialized by done-worktree
  // plan 2393: `fn` receives the lock handle as its SECOND arg and passes it to coordWrite as
  // `lockCtx`, which is what lets the push + verify leave the critical section. A caller that
  // ignores the arg keeps today's behaviour (lock held across the whole op) — the seam is opt-in.
  // plan 4087 T1: `timeoutMs` threads to resolveCoordCheckout's own bounded fetch/reset/clean —
  // a plain pass-through default (COORD_CHECKOUT_GIT_TIMEOUT_MS), overridable by a test.
  return withCoordLock(
    mainDir,
    (lockCtx) => fn(resolveCoordCheckout(mainDir, { env, _git, timeoutMs }), lockCtx),
    lockOpts,
  );
}

// Reattach a DETACHED main-checkout HEAD to the `master` branch (plan 1286). A shared MAIN left
// detached — a killed rebase inside pushMasterWithRebase, or a done-worktree land whose
// opportunistic ff was skipped by foreign dirt — breaks resolveMain's on-master assert for EVERY
// sanctioned coord writer until healed. Reattaching is safe ONLY when the detached HEAD holds no
// unique work:
//   - HEAD already on a branch → no-op ({ reattached: false }).
//   - detached HEAD an ANCESTOR of origin/master (after a best-effort fetch) or of local master →
//     nothing is stranded by moving to the branch; `git switch master` performs the reattach (git
//     itself refuses if a dirty file would be clobbered — that refusal is surfaced, not swallowed).
//   - anything else (the detached HEAD carries commits no branch has) → throw loudly with
//     `detachedUnsafe: true`; auto-reattaching would strand unpushed work on an unnamed ref.
export function reattachMainToMaster(mainDir, { env, _git = git } = {}) {
  const head = _git(mainDir, ['rev-parse', '--abbrev-ref', 'HEAD'], { env }).trim();
  if (head !== 'HEAD') return { reattached: false, reason: `attached (${head})` };
  const sha = _git(mainDir, ['rev-parse', 'HEAD'], { env }).trim();
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], { env, _git });
  } catch {
    /* offline — judge against whatever refs we have locally */
  }
  const isAncestorOf = (ref) => isAncestorRef(mainDir, sha, ref, { env, _git });
  if (!isAncestorOf('origin/master') && !isAncestorOf('master')) {
    const err = new Error(
      `coord-git: main checkout HEAD is detached at ${sha.slice(0, 9)}, which is NOT an ancestor ` +
        `of origin/master or master — it may carry unpushed work. Refusing to auto-reattach; ` +
        `inspect \`git -C <main> log master..HEAD\`, push or discard those commits, then re-run ` +
        `\`node scripts/heal-main.mjs\`.`,
    );
    err.detachedUnsafe = true;
    throw err;
  }
  gitWithLockRetry(mainDir, ['switch', 'master'], { env, _git });
  return { reattached: true, from: sha };
}

export async function withRetry(producer, pushFn, { max = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    const payload = producer();
    try {
      return pushFn(payload);
    } catch (e) {
      if (!e.nonFastForward) throw e;
      lastErr = e;
    }
  }
  const err = new Error(`coord-git: push still rejected after ${max} attempts`);
  err.cause = lastErr;
  throw err;
}

export const COORD_TRAILER = 'Coord-Write';

// Jittered exponential backoff (ms) to DESYNC the parallel-session herd: synchronized
// fixed-delay retries collide forever; jitter spreads them. Returns 50–100% of the
// capped exponential so two waiters waking on the same lock-clear rarely re-collide.
export function backoffMs(attempt, { base = 150, cap = 2000 } = {}) {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

// Refuse to start a coordWrite when the shared main checkout carries an uncommitted
// edit to a TRACKED file OUTSIDE the tool's own pathspec (plan 487). coordWrite's
// freshen — `git fetch` + `git merge --ff-only origin/master` (just below) — is
// NON-destructive: git ABORTS a fast-forward that would overwrite a dirty file rather
// than discarding it. But that abort is SWALLOWED by the freshen's try/catch, so a
// parallel session that left an uncommitted plan-body edit in the main checkout (the
// 2026-06-09 plan-478 scope-note loss) gets no signal: coordWrite then either proceeds
// on a stale base or burns its whole retry budget and throws the misleading "origin
// kept advancing" error. We fail LOUD and EARLY instead — naming the file so the caller
// commits or stashes it. The edit is never silently lost OR silently fought.
//
// Untracked files are tolerated (`--untracked-files=no`): they are not "edits", and a
// fast-forward aborts rather than overwriting them — the same `??`-tolerance the
// pickup-plan GATE probe uses. relPaths (the files this coordWrite is about to write)
// are excluded; in every live caller (board/index/next-plan-id) the tree is clean
// outside relPaths at entry because `mutate` is the sole writer and runs AFTER this.
export function assertCleanOutsidePathspec(mainDir, relPaths, { env, tool = 'coordWrite' } = {}) {
  const rel = new Set(relPaths);
  const out = git(mainDir, ['status', '--porcelain', '--untracked-files=no'], { env });
  const foreign = [];
  // git quotes paths containing a space / special char in double-quotes — strip them
  // so the membership check matches the plain JS strings callers pass as relPaths.
  const unquote = (p) => {
    const t = p.trim();
    return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t;
  };
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const rest = line.slice(3); // strip the 2-char "XY" status + 1 space
    // rename/copy entries read "orig -> dest"; BOTH sides are touched (the source is
    // removed, the dest created), so the entry is foreign unless EVERY path it names
    // is one of ours — keying only on `dest` would miss a foreign rename ONTO a relPath.
    const sides = (rest.includes(' -> ') ? rest.split(' -> ') : [rest]).map(unquote);
    if (sides.some((p) => !rel.has(p))) foreign.push(line.trim());
  }
  if (foreign.length) {
    throw new Error(
      `coordWrite(${tool}): refusing to run — the main checkout has uncommitted changes to tracked ` +
        `file(s) OUTSIDE this tool's pathspec:\n` +
        foreign.map((f) => `  ${f}`).join('\n') +
        `\nThe freshen onto origin/master would fight these and an uncommitted edit must never be ` +
        `risked silently. Commit or stash them first (\`git commit\` / \`git stash -k\`), then re-run — ` +
        `your edit is intact, this is a safe early stop, not a wedge.`,
    );
  }
}

// plan 1578: generalize the plan-1508 "did the push actually reach origin" guarantee — which
// landed as a one-off post-hoc check bolted onto done-worktree's closeOut (verifyCloseOutOnOrigin)
// — into the shared coordWrite seam so EVERY coord-write caller (board.mjs, next-plan-id.mjs,
// edit-plan.mjs, move-plan.mjs, claim-plan.mjs — all route through coordWrite/withCoordCheckout)
// inherits it with no per-tool code. A local `git push` returning success only proves OUR process
// believes the ref update happened — coordWrite's push runs against a DISPOSABLE coord-checkout
// (plan 989), a different tree/process from anything reading the result, so a silent partial push
// or a racing clobber is invisible to the caller otherwise (the plan-1384 ~2.5h
// ARCHIVED_PLAN_ACTIVE_ROW drift this generalizes). Checks the CHEAP primitive first — `git
// ls-remote origin <ref>` (a genuine network round-trip against origin, not our local
// tracking-ref) — and only falls back to a fetch + `merge-base --is-ancestor` when the remote sha
// differs from ours, which correctly tolerates the benign race where a SIBLING pushed further
// while we were mid-flight (our commit is still an ancestor of the new tip, not necessarily the
// tip itself). Throws loudly, tagged `.pushUnverified`, on genuine non-reachability — never
// silently returns success. Per the plan-1508 diagnosis: the realistic failure mode is a
// git-level crash (fork()/index.lock family) killing the process BEFORE this even runs, which no
// in-process check can catch either way — this guards the silent-partial-push / racing-clobber
// class specifically, and converts either failure mode into a caller-visible nonzero exit. `_git`
// is the test seam (see coord-git.test.mjs's fake-push fixture, which intercepts only the `push`
// verb so this function's own git calls hit a REAL bare origin).
// review fix: the shared shape behind assertPushReachedOrigin's 4 throw sites — a `.pushUnverified`
// error, optionally carrying `.cause`. Factored out so the message text (byte-identical to before)
// is the only thing each call site varies.
function throwPushUnverified(message, cause) {
  const err = new Error(message);
  err.pushUnverified = true;
  if (cause !== undefined) err.cause = cause;
  throw err;
}

// plan 2393: `sha` pins WHICH commit is being verified. It used to be read as `rev-parse HEAD`
// here, which was only correct while the caller still held the coord lock across the push — once
// lever 1 moved the push + verify OUT of the critical section, a sibling's resolveCoordCheckout
// (`reset --hard origin/master`) can move the shared coord-checkout's HEAD in that window, and this
// would then verify the WRONG commit: a false PASS on a sibling's tip that origin legitimately
// contains, while our own commit never landed. Callers that pin nothing keep the old HEAD read.
// The ONE parse of a pushspec's destination ref ('master' → 'master'; 'HEAD:master' → 'master';
// '<sha>:refs/heads/master' → 'refs/heads/master'). Extracted (review 2026-07-25) so coordWrite's
// push target and this verify's ls-remote target can never drift apart.
export function remoteRefOf(pushSpec) {
  return pushSpec.includes(':') ? pushSpec.split(':')[1] : pushSpec;
}

// plan 2580: the ONE default caller label for the shared coord-land protocol. coordWrite was the
// only caller when these diagnoses were written, so its name was the literal baked into each of
// them; it stays the default so every pre-existing message and unit test is unchanged. Kept as one
// constant rather than three identical default parameters (review 2026-07-28, finding 4) — a
// fourth caller or a rename must not be able to leave one default behind, which is precisely the
// misattribution class the `label` parameter exists to fix.
export const DEFAULT_COORD_LABEL = 'coordWrite';

// plan 2580: `label` names the CALLER in every diagnosis. It used to be the hardcoded literal
// "coordWrite:", which was accurate while coordWrite was the only caller; plan 2519's coordEditApply
// port inherited the prefix verbatim, so a push-verify failure from a coord-edit land misdirected
// debugging toward board.mjs/index.mjs instead of the coord-edit that actually failed. Defaults to
// the historical string so coordWrite and the direct unit-test call sites are unchanged.
export function assertPushReachedOrigin(
  mainDir,
  pushSpec,
  env,
  { _git = git, sha: pinned, label = DEFAULT_COORD_LABEL } = {},
) {
  const remoteRef = remoteRefOf(pushSpec);
  const sha = (pinned || _git(mainDir, ['rev-parse', 'HEAD'], { env })).trim();
  let remoteLine;
  try {
    remoteLine = lsRemoteTimed(mainDir, remoteRef, { _git }).trim();
  } catch (e) {
    throwPushUnverified(
      `${label}: pushed ${sha.slice(0, 9)} but could not verify it reached origin/${remoteRef} ` +
        `(ls-remote failed: ${errText(e)}) — treating as UNVERIFIED, never silent success.`,
      e,
    );
  }
  if (!remoteLine) {
    throwPushUnverified(
      `${label}: pushed ${sha.slice(0, 9)} to origin/${remoteRef} but origin reports NO such ref ` +
        `— the push did not reach origin.`,
    );
  }
  const remoteSha = remoteLine.split('\t')[0].trim();
  if (remoteSha === sha) return; // exact match — the common case, zero extra round-trips
  // Remote tip differs from ours: could be a sibling that pushed PAST us in the gap between our
  // push and this ls-remote (benign — our commit is still an ancestor), or our push genuinely
  // never landed. `merge-base --is-ancestor` needs the remote's objects locally, so fetch first.
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', remoteRef], { env, _git });
  } catch (e) {
    throwPushUnverified(
      `${label}: pushed ${sha.slice(0, 9)} but could not fetch origin/${remoteRef} (now reported ` +
        `at ${remoteSha.slice(0, 9)}) to verify reachability: ${errText(e)}.`,
      e,
    );
  }
  if (!isAncestorRef(mainDir, sha, `origin/${remoteRef}`, { env, _git })) {
    throwPushUnverified(
      `${label}: pushed ${sha.slice(0, 9)} but origin/${remoteRef} (now at ${remoteSha.slice(0, 9)}) ` +
        `does NOT contain it — the push did not reach origin (or was silently clobbered). This is ` +
        `the plan-1384/1508 failure class, generalized to every coord land caller (plan 1578).`,
    );
  }
}

// plan 2580 (gap 3 of plan 2572, re-scoped): prove a NO-OP against origin before reporting it as
// success. Both land callers short-circuit to `{noop:true}` when nothing is staged for relPaths —
// i.e. "the desired content already equals local HEAD". That inference is only sound while local
// HEAD is CONTAINED in origin. It normally is (the freshen at the top of each attempt merges
// origin/master ff-only), but that freshen sits in a bare catch, and the rollback path deliberately
// declines to `reset --soft` when HEAD moved under the released lock — so a local-only commit can
// survive, the next attempt's `merge --ff-only` then fails into that same bare catch (diverged, not
// behind), and the staged-diff probe sees our content already at a HEAD that origin has never seen.
// The result was `{noop:true}` for an edit living ONLY in the disposable coord-checkout, which the
// next sibling's `reset --hard` discards: a silent lost write, the exact class assertPushReachedOrigin
// exists to prevent on the push path.
//
// Cheap by construction: the common case is ONE `merge-base --is-ancestor` against the already-fetched
// local ref and zero network. Containment in a STALE local origin ref is still proof — shared master
// only ever fast-forwards here, so anything reachable from an older origin tip is reachable from the
// current one. Only when that fails do we spend a fetch, and only then can this throw.
export function assertNoopReachedOrigin(
  mainDir,
  pushSpec,
  env,
  { relPaths, _git = git, label = DEFAULT_COORD_LABEL } = {},
) {
  if (!relPaths?.length) throw new Error('assertNoopReachedOrigin: relPaths required');
  const remoteRef = remoteRefOf(pushSpec);
  // The question is NOT "is HEAD on origin" — it is "does origin ALREADY carry the content we were
  // about to report as landed". Those come apart, and the difference is not academic (review
  // 2026-07-28, finding 1): a HEAD-containment test also fails whenever the checkout carries local
  // commits that have nothing to do with relPaths — most sharply in done-worktree's DETACHED finish
  // worktree, whose HEAD is the not-yet-pushed merge commit, where every coord no-op would suddenly
  // have thrown. Comparing the PATHS answers the actual question, is immune to unrelated unpushed
  // commits, and stays a single local ref read.
  const originHasOurContent = () => {
    try {
      _git(mainDir, ['diff', '--quiet', `origin/${remoteRef}`, 'HEAD', '--', ...relPaths], { env });
      return true; // exit 0 ⇒ origin's copy of these paths is identical to ours
    } catch {
      return false; // exit 1 (or an unreadable ref) ⇒ not proven; fall through
    }
  };
  if (originHasOurContent()) return;
  // No origin remote at all ⇒ nothing to verify against and nothing this no-op could be lying
  // about reaching (a real land here would fail at the push). Local-only repos are unit-test and
  // scratch territory, not the shared coord-checkout this guard is about.
  try {
    _git(mainDir, ['remote', 'get-url', 'origin'], { env });
  } catch {
    return;
  }
  // The local origin ref may simply be stale (an earlier freshen swallowed its failure). Refresh
  // once before accusing the checkout of holding content origin has never seen. Only a checkout
  // whose relPaths genuinely differ from origin's reaches this fetch, so the ordinary no-op — a
  // sibling landed our exact edit, or an idempotent re-run — never spends a network round-trip.
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', remoteRef], { env, _git });
  } catch (e) {
    throwPushUnverified(
      `${label}: nothing to commit for [${relPaths.join(', ')}], but origin/${remoteRef} could not ` +
        `be read to confirm origin already carries that content (fetch failed: ${errText(e)}) — ` +
        `treating as UNVERIFIED, never silent success.`,
      e,
    );
  }
  if (originHasOurContent()) return;
  throwPushUnverified(
    `${label}: refusing to report a no-op — [${relPaths.join(', ')}] already match this checkout's ` +
      `HEAD, but origin/${remoteRef} carries DIFFERENT content for them, so the edit exists only ` +
      `locally and would be discarded by the next hard reset of the shared checkout. Re-run once ` +
      `the local commit(s) have landed (or drop them); never trust this as success.`,
  );
}

// The staged-nothing probe both land callers gate their no-op on. Shared for the same reason the
// land protocol itself is (review 2026-07-28, finding 3): a copy-pasted step is exactly what
// diverges next. `git diff --cached --quiet` exits 0 when NOTHING is staged for the pathspec.
export function nothingStagedFor(mainDir, relPaths, env) {
  try {
    git(mainDir, ['diff', '--cached', '--quiet', '--', ...relPaths], { env });
    return true;
  } catch {
    return false;
  }
}

// ── plan 2580: THE one coord-land protocol ────────────────────────────────────────────────────
// commit (half-land tolerant) → pin sha → release the lock → push BY PINNED SHA → on failure
// reacquire + conditionally roll back → verify the push actually reached origin.
//
// This is the hardened sequence coordWrite grew over plans 980 / 1578 / 2393 / 2435. Plan 2519
// ported it into coordEditApply as a COPY, which had already silently diverged twice (a bare `git`
// push, a missing assertPushReachedOrigin — both since fixed) and still lacked the half-land
// tolerance and the new-file rollback cleanup. One implementation, two callers: a hardening fix
// applied here now benefits both by construction.
//
// Deliberately scoped to the LAND half only. Everything upstream — how the content gets STAGED —
// is genuinely different work per caller (coordWrite regenerates via an idempotent `mutate()` then
// `add`; coordEditApply replays a fixed patch via `apply --cached --3way` then `checkout`) and is
// not duplication to remove. The retry/backoff loop and its exhaustion diagnosis also stay with
// each caller, so this returns `{pushed, commitSha, error}` on a retryable non-ff instead of
// looping itself; anything NOT retryable still throws straight out, exactly as before.
//
// `onBeforePush` is coordEditApply's test seam (undefined in production and unused by coordWrite):
// a synchronous loop has no per-attempt callback like coordWrite's `mutate`, so it is the only hook
// a test can use to land a sibling commit between our commit and our push and force a non-ff.
export function coordLandCommit(
  mainDir,
  {
    relPaths,
    fullMsg,
    env,
    pushSpec,
    lockCtx = NO_COORD_LOCK,
    label = DEFAULT_COORD_LABEL,
    onBeforePush,
    attempt = 0,
    _git = git,
  },
) {
  try {
    gitWithLockRetry(mainDir, ['commit', '-m', fullMsg, '--', ...relPaths], { env, _git });
  } catch (e) {
    // plan 980: the commit can hit the transient `unable to write new index file` AFTER git already
    // created the commit object + moved HEAD; gitWithLockRetry's retry (now also retrying the
    // transient) then finds nothing staged → "nothing to commit". That is NOT a failure — the commit
    // landed locally (never pushed; the throw unwound before the push). Tolerate it ONLY once HEAD's
    // subject CONFIRMS our commit is genuinely at HEAD — never a bare "nothing to commit", which a
    // hypothetical staged drain could also produce (each caller's diff-cached guard already excluded
    // the ordinary no-op). Then fall through to push the locally-created commit; anything else surfaces.
    const out = errText(e);
    if (!(isNothingToCommit(out) && commitSubjectAtHead(mainDir, fullMsg))) throw e;
  }
  onBeforePush?.(attempt); // test seam (no-op in production)
  // ── plan 2393 lever 1: the critical section ENDS here ────────────────────────────────────────
  // Everything above (freshen → stage → commit) mutates the shared coord-checkout and MUST stay
  // serialized. The push and its verify are pure network round-trips against origin — measured at
  // ~4s of every op's ~9s hold, under a mutex all ~7 sessions queue on. Pin the commit we just made
  // and hand the lock back before spending them.
  //
  // Pinning the sha is what MAKES this safe: the pushspec no longer names a moving symbol. Once the
  // lock is out of our hands a sibling's resolveCoordCheckout resets this very checkout to
  // origin/master, so `HEAD:master` (or `master`) would push whatever landed there instead of our
  // commit. `<sha>:refs/heads/master` names the immutable object, which lives in the shared object
  // store and is pushable from any checkout regardless of what HEAD now points at. The ref-update
  // rules are unchanged, so a stale base is still rejected non-fast-forward exactly as before, and
  // isNonFastForward still classifies it.
  const commitSha = _git(mainDir, ['rev-parse', 'HEAD'], { env }).trim();
  const remoteRef = remoteRefOf(pushSpec);
  lockCtx.release();
  try {
    // gitWithLockRetry, NOT a bare _git (review 2026-07-25, finding 2): releasing the lock before
    // the push is exactly what makes a CONCURRENT local git write to this shared checkout possible
    // for the first time, and a successful push also updates refs/remotes/origin/master — so it can
    // now collide with a sibling's `fetch` on that same ref-lock. That error is a retryable race,
    // not a failure: unretried it fell through `isNonFastForward` and surfaced as a hard CLI exit,
    // and it gets MORE likely exactly when contention is high. gitWithLockRetry retries only the
    // LOCK_RX / transient-index-write / ref-lock classes and rethrows everything else untouched, so
    // non-ff classification below is unaffected; re-pushing the same pinned sha is idempotent
    // ("Everything up-to-date").
    gitWithLockRetry(mainDir, ['push', 'origin', `${commitSha}:refs/heads/${remoteRef}`], {
      env,
      _git,
    });
  } catch (e) {
    // The rollback mutates the shared checkout again, so it goes back INSIDE the lock (the spec-pass
    // pin: only push + verify leave the critical section). Re-taking the lock costs a second
    // acquire, paid only on the non-ff path — 1 of 841 ops in the 26h baseline. If we CANNOT re-take
    // it (a sibling held it past the acquire budget), the push error is the diagnosis worth keeping
    // (review 2026-07-25, finding 3): never let a lock-timeout mask it, and never continue the loop
    // unlocked — the next attempt would re-freshen and re-stage the shared checkout with no mutual
    // exclusion at all. Skipping the rollback is safe: the next op's resolveCoordCheckout hard-resets
    // this checkout anyway.
    try {
      lockCtx.reacquire();
    } catch (reErr) {
      e.reacquireFailed = reErr;
      throw e;
    }
    // Rollback under concurrency: while the lock was released a sibling may have reset this shared
    // checkout, so `reset --soft HEAD~1` is only OURS to undo while HEAD is still the commit we
    // made. If it moved, our commit is already unreferenced — an object the next default-expiry gc
    // collects — and resetting would amputate a SIBLING's commit instead. Skipping the undo is safe
    // either way: the next attempt re-freshens onto the origin tip.
    if (_git(mainDir, ['rev-parse', 'HEAD'], { env }).trim() === commitSha) {
      // undo our local commit and revert ONLY our paths (never touch foreign dirt). --soft keeps our
      // paths staged; restoring index+worktree from HEAD reverts existing files to their pre-edit
      // content and drops paths we newly created.
      gitWithLockRetry(mainDir, ['reset', '--soft', 'HEAD~1'], { env });
      revertPathsToHead(mainDir, relPaths, env);
    }
    if (!isNonFastForward(e)) throw e; // real error (hook, auth, network) → surface
    return { pushed: false, commitSha, error: e };
  }
  // plan 1578: verify AFTER the push the loop believes succeeded — deliberately not inside the catch
  // above, so a verify failure never gets mistaken for a non-ff rejection (no spurious
  // rollback/retry) and instead throws straight out to the caller. plan 2393: it runs with the lock
  // RELEASED and therefore verifies the PINNED sha, never `rev-parse HEAD` (which a sibling's
  // checkout reset may have moved). A verify failure still throws — the tool exits non-zero — and is
  // never downgraded to a warning.
  assertPushReachedOrigin(mainDir, pushSpec, env, { _git, sha: commitSha, label });
  return { pushed: true, commitSha };
}

// The ONE sanctioned shared-doc mutation path. Freshen local master onto the origin tip,
// run `mutate` (which MUST be idempotent — it regenerates/sets content, never appends),
// commit ONLY relPaths by pathspec with a `Coord-Write: <tool>` trailer, push. On a non-ff
// rejection: undo our commit, revert ONLY our paths to HEAD, jittered-sleep, and loop —
// freshening onto the new tip and RE-running mutate so generated docs reflect it. Silent on
// non-ff until the budget is exhausted, then one clean attributable error. Non-ff is the
// ONLY retried failure; any other push error is surfaced immediately (after undo). plan 1578:
// AFTER a push the loop believes succeeded, assertPushReachedOrigin proves it against a FRESH
// read of origin before returning success — deliberately OUTSIDE the non-ff undo+retry above (a
// verify failure is not a non-ff condition and must not spuriously burn the retry budget or roll
// back a commit that may well be sitting on origin already); it throws straight out of coordWrite.
//
// plan 2891 T2: `mutate` MAY return the path list this attempt actually wrote. When it does, that
// list is what gets staged/committed for this attempt; the declared `relPaths` stays the
// foreign-dirt pre-check's yardstick and the fallback for the (usual) mutate that returns nothing.
// It exists for writers whose path set is only knowable AFTER the freshen — the marker re-pin,
// whose sidecar can appear or vanish inside the retry window.
export function coordWrite(
  mainDir,
  { relPaths, mutate, message, tool, attempts = 8, _git = git, lockCtx = NO_COORD_LOCK },
) {
  if (!relPaths?.length) throw new Error('coordWrite: relPaths required');
  // plan 4071 T2: resolved ONCE per call from the repo root this function already receives
  // (coord.config.json's `coordCheckoutExcludedTopLevel`, empty core default).
  const { coordCheckoutExcludedTopLevel: coneExcludes } = loadCoordConfig(mainDir);
  // plan 3802: fail fast and legibly when a target is outside the sparse cone (see
  // assertCoordPathInCone) rather than deep inside the retry loop on a git pathspec error.
  for (const rel of relPaths) assertCoordPathInCone(rel, { tool, excludes: coneExcludes });
  const env = { HUSKY: '0' }; // plan 2604: gitRaw's spawnEnv supplies+scrubs process.env
  // plan 487: before the first freshen, refuse loudly if a parallel session left an
  // uncommitted edit to a tracked file outside our pathspec in the shared main checkout.
  // The dirty-foreign state is a stable pre-condition (coordWrite only ever touches
  // relPaths, and reverts them scoped on retry), so one check before the loop suffices.
  assertCleanOutsidePathspec(mainDir, relPaths, { env, tool });
  // plan 971: 'master' on the main checkout; 'HEAD:master' in done-worktree's detached
  // finish worktree (COORD_MAIN_DIR). Stable for this checkout → computed once.
  const pushSpec = masterPushSpec(mainDir, env);
  const fullMsg = `${message}\n\n${COORD_TRAILER}: ${tool}`;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      // The freshen. `merge --ff-only` is non-destructive — it ABORTS rather than
      // overwriting a dirty file — and the guard above already rejected foreign dirt,
      // so a swallowed failure here is only the legit offline / locally-ahead case
      // (the push non-ff guard below is the backstop for those).
      gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], { env });
      gitWithLockRetry(mainDir, ['merge', '--ff-only', 'origin/master'], { env });
    } catch {
      /* offline / locally-ahead — proceed; the push non-ff guard below is the backstop */
    }
    // plan 2891 T2: `mutate()` MAY return the definitive path list for THIS attempt, and when
    // it does that list — not the one the caller declared before the loop — is what gets staged,
    // committed and no-op-probed. The declared `relPaths` is fixed before the freshen, so it
    // cannot know about a path that appeared or vanished inside the retry window: staging it
    // blind either misses that path's change, or hands `git add` a pathspec that no longer
    // matches anything and fails the whole write. A mutate that returns nothing (every caller
    // but the marker re-pin) keeps the declared list verbatim — unchanged behaviour.
    //
    // The declared list stays authoritative for assertCleanOutsidePathspec above: that check
    // runs once, before any mutation, on state that predates it, so a post-mutate list would be
    // the wrong question. Declare the superset there; narrow here.
    const mutated = mutate();
    // An ARRAY is authoritative even when EMPTY (review round 1, CONFIRMED): `[]` means "this
    // attempt wrote nothing", and falling back to the declared list there would stage — and
    // COMMIT — whatever pre-existing dirt those declared paths happen to carry, under a message
    // describing a write that never happened. Nothing written is a clean no-op; return as such
    // without an `add`/`commit` at all (`git add --` with zero pathspecs is not even a legal
    // narrowing). Only a NON-array return (every caller but the marker re-pin) keeps the
    // declared list verbatim — unchanged behaviour for all of them.
    if (Array.isArray(mutated) && mutated.length === 0) return { attempts: i + 1, noop: true };
    const staged = Array.isArray(mutated) ? mutated : relPaths;
    // plan 3802 (/gpt-review keys 1b9bb4, 862d6e, 63bc7c): the DECLARED list was already checked
    // before the loop, but `mutate()` may return an authoritative list that replaces it (plan 2891
    // T2) -- and that one is what actually gets staged. Re-check here so the dynamic path cannot
    // route around the cone; when the list is the declared one this is a repeat of a cheap
    // string test, which is the right price for closing the hole.
    for (const rel of staged) assertCoordPathInCone(rel, { tool, excludes: coneExcludes });
    gitWithLockRetry(mainDir, ['add', '--', ...staged], { env });
    // No-op short-circuit: if mutate produced content identical to the freshened
    // base (an idempotent re-run, or a sibling already landed an equivalent edit),
    // NOTHING is staged. `git commit -- relPaths` would then fatal ("nothing to
    // commit") OUTSIDE the push try/catch and crash the caller. The desired state
    // already exists on origin, so this is success — return without committing.
    if (nothingStagedFor(mainDir, staged, env)) {
      // plan 2580: "already at HEAD" only means "already on origin" once origin is shown to carry
      // the same content for these paths — prove it before reporting success. Deliberately NOT
      // inside the probe's own try/catch (which means "there are staged changes"): swallowing a
      // verification failure into it would resurrect the silent-success this guard exists to kill.
      assertNoopReachedOrigin(mainDir, pushSpec, env, { relPaths: staged, _git });
      return { attempts: i + 1, noop: true };
    }
    // plan 2580: commit → pin → release → push → reacquire/rollback → verify now lives in the ONE
    // shared coord-land protocol helper that coordEditApply also calls. A non-ff comes back as
    // `{pushed:false}` for this loop to retry; anything else throws straight out, as before.
    const landed = coordLandCommit(mainDir, {
      relPaths: staged,
      fullMsg,
      env,
      pushSpec,
      lockCtx,
      attempt: i,
      _git,
    });
    if (landed.pushed) return { attempts: i + 1 };
    lastErr = landed.error;
    sleepSync(backoffMs(i));
  }
  // ── plan 2435 item 2: name foreign dirt in the exhaustion error ──────────────────────────────
  // assertCleanOutsidePathspec runs ONCE, before the loop, on the premise (plan 487) that foreign
  // dirt is a "stable pre-condition". Plan 2393 lever 1 weakened that premise: a sibling's ENTIRE
  // coordWrite can now run inside our released window, and a sibling mutate() that THROWS leaves
  // uncommitted dirt whose self-heal is deferred to the next resolveCoordCheckout hard-reset. Dirt
  // that appears after our entry check aborts our `merge --ff-only` (swallowed by the freshen's
  // try/catch), pushing us onto a stale base → non-ff → retry: self-correcting, but capable of
  // burning the whole attempt budget for a reason the error never mentions.
  //
  // The plan weighed re-checking the precondition per attempt against this, and chose this:
  // re-checking would turn a TRANSIENT sibling state into a hard refusal (and reintroduce the
  // plan-618 drain-crash class the retryOnForeignDirt wrapper exists to absorb), whereas naming the
  // dirt costs one `git status` on a path we are already failing, and adds no new refusal.
  //
  // Deliberately does NOT reuse assertCleanOutsidePathspec's wording: isForeignDirtRefusal matches
  // on "refusing to run" + "OUTSIDE this tool's pathspec", and retryOnForeignDirt retries anything
  // that matches. An exhaustion error is NOT a pre-mutation refusal — it is terminal, and up to 8
  // attempts have already run — so making it match would silently multiply the retry budget. The
  // paths ride on a structured property; the text is diagnosis only.
  let foreignAtExhaustion = [];
  try {
    assertCleanOutsidePathspec(mainDir, relPaths, { env, tool });
  } catch (dirtErr) {
    foreignAtExhaustion = parseForeignDirtPaths(errText(dirtErr));
  }
  const err = new Error(
    `coordWrite(${relPaths.join(',')}) blocked after ${attempts} attempts — origin/master kept advancing. ` +
      `This is NORMAL transient contention; just re-run. If it persists, a sibling push is wedged (check \`git ls-remote origin master\`).` +
      (foreignAtExhaustion.length
        ? `\n\nNOTE: the main checkout ALSO carries uncommitted tracked change(s) outside this tool's pathspec, ` +
          `which appeared AFTER this op's entry check and would have aborted each freshen (leaving every attempt on a stale base):\n` +
          foreignAtExhaustion.map((p) => `  ${p}`).join('\n') +
          `\nThat is the more likely cause than origin contention. If it is a sibling's in-flight coord write it clears on its own; ` +
          `if it persists, commit or stash it and re-run.`
        : ''),
  );
  err.cause = lastErr;
  // The structured marker coordErrorReason classifies on. Sibling tools (claim-plan's claim
  // projection, coord-edit's apply loop) have their OWN retry loops that exhaust with the same
  // "kept advancing" prose, so only this flag identifies a coordWrite freshen-exhaustion.
  err.coordWriteExhausted = true;
  if (foreignAtExhaustion.length) err.foreignDirtAtExhaustion = foreignAtExhaustion;
  throw err;
}

// Revert relPaths to HEAD after an undone commit, handling BOTH paths that exist
// in HEAD (board/INDEX edits → restored to pre-edit content) and paths newly
// created by this attempt (a freshly-authored plan file → unstaged + removed from
// the worktree). `git restore -SW --source=HEAD` reverts the tracked ones; a path
// not in HEAD is then merely unstaged, so we delete its worktree leftover. Scoped
// to relPaths — a sibling session's uncommitted work in OTHER files is untouched.
// Exported since plan 1286: the routed hand-edit writers (wiki-commit) use it to clear
// MAIN's now-redundant dirt AFTER their coord-checkout land succeeded.
//
// plan 2580: this is now the ONE revert used by BOTH land callers. coord-edit.mjs used to keep a
// private near-twin (`restorePathsToHead`) that had the `checkout HEAD` middle rung below but NOT
// the new-file cleanup loop, so a rolled-back coordEditApply attempt that created a brand-new file
// left it dangling untracked in the shared checkout (plan 2572 gap). Rather than pick one of the
// two, this is their SUPERSET: the middle rung is what makes it tolerant of the conflicted
// (unmerged stage-1/2/3) index a failed `git apply --3way` leaves — a state coordWrite never
// reaches but coord-edit cleans on every patch-conflict probe — and the cleanup loop is what stops
// a new file surviving a rollback. Both rungs are inert for the caller that does not need them.
export function revertPathsToHead(mainDir, relPaths, env) {
  try {
    gitWithLockRetry(
      mainDir,
      ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...relPaths],
      {
        env,
      },
    );
  } catch {
    // A path absent from HEAD makes `restore --source=HEAD` fatal ("pathspec did not
    // match"); fall back to unstaging whatever is staged, then drop new files below.
    try {
      gitWithLockRetry(mainDir, ['checkout', 'HEAD', '--', ...relPaths], { env });
    } catch {
      try {
        gitWithLockRetry(mainDir, ['reset', '-q', '--', ...relPaths], { env });
      } catch {
        /* nothing staged */
      }
    }
  }
  for (const rel of relPaths) {
    let inHead = true;
    try {
      git(mainDir, ['cat-file', '-e', `HEAD:${rel}`], { env });
    } catch {
      inHead = false; // path did not exist at HEAD → it was newly created this attempt
    }
    if (!inHead) {
      const abs = isAbsolute(rel) ? rel : resolve(mainDir, rel);
      if (existsSync(abs)) rmSync(abs, { force: true });
    }
  }
}

// Build a pushFn that writes `content` to `relPath` under mainDir, commits ONLY
// that path (pathspec — never sweeps a pre-staged sibling), pushes, and rolls
// back scoped to that one path on any failure. Commits run with HUSKY=0.
export function makePushFn({ mainDir, relPath, message, writeFile }) {
  const env = { HUSKY: '0' }; // plan 2604: gitRaw's spawnEnv supplies+scrubs process.env
  const rollback = () => {
    gitWithLockRetry(mainDir, ['reset', '--soft', 'HEAD~1']);
    gitWithLockRetry(mainDir, ['restore', '--source=HEAD', '--staged', '--worktree', relPath]);
  };
  return (content) => {
    writeFile(content);
    gitWithLockRetry(mainDir, ['add', relPath]);
    gitWithLockRetry(mainDir, ['commit', '-m', message, '--', relPath], { env });
    try {
      git(mainDir, ['push', 'origin', 'master'], { env });
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
      rollback();
      if (isNonFastForward(e)) {
        const err = new Error('non-ff');
        err.nonFastForward = true;
        throw err;
      }
      throw new Error(
        `coord-git: push rejected (not a non-ff — likely a pre-push hook):\n${out.trim()}`,
      );
    }
    return content;
  };
}
