#!/usr/bin/env node
// scripts/hooks/main-checkout-rebase-guard.mjs — PreToolUse hook (plan 3944).
//
// DENIES a hand-run `git rebase` / `git reset --hard` / `git pull --rebase` / non-fast-forward
// `git merge` whose git TARGET is the shared MAIN checkout — the one working tree ~5-7
// parallel sessions push to directly (every worktree checkout is exempt; a rewrite there is
// scoped to one session's own branch).
//
// § WHY. `vetapp/CLAUDE.md` and this hobby's memory both already say a MAIN-checkout wedge
// goes through `node scripts/heal-main.mjs`, never a hand rebase/reset/pull — that rule was
// prose, and prose gets skipped under pressure:
//   plan 3541  a MAIN-checkout wedge was hand-rebased directly instead of running the healer.
//   plan 3531  a git op was retried against the shared working tree instead of waiting on the
//              coord-write lock, racing a concurrent writer.
// `land-timeout-guard.mjs` (plan 3452) is the sibling precedent for turning a repeatedly-
// skipped prose rule into a DENY once a warning has already failed to hold: this hook follows
// the same shape (fail-open, environment-as-parameter, deny with the fix and the incidents
// inline) for the same reason.
//
// § THE VERDICT. Non-subagent Bash call, some pipeline segment is a `git` invocation (argv0
// basename in GIT_BASENAMES) whose verb is one of:
//   rebase          — ANY form, including `--abort` / `--continue` / `--skip`. There is no
//                      safe hand sub-form: even concluding a conflicted rebase by hand on the
//                      shared tree is the shape plan 3541 hand-ran.
//   reset --hard    — discards working-tree + index state other sessions may be mid-read of.
//   pull --rebase   — `pull` alone is a plain fetch+merge (usually a fast-forward, harmless);
//                      the `--rebase` flag is what turns it into the same hazard as `rebase`.
//   merge (not      — an ordinary `git merge` can create a merge commit or conflict-stop the
//     --ff-only)      shared tree; `--ff-only` can only fast-forward or cleanly refuse, so it
//                      is carved out (mirrors the plan-1259 `merge-base`/`merge-tree` carve-out
//                      in worktree-guard.sh, which this hook does not replace or overlap).
// …AND that segment's resolved target directory (every `-C <path>` folded CUMULATIVELY —
// resolved against the Bash command's OWN cwd, not this hook subprocess's, each one against
// wherever the PREVIOUS `-C` left off, matching git's own semantics; else the payload cwd) is
// BOTH (a) inside THIS repo family — vetapp's shared main checkout or one of its linked
// worktrees, never some other clone on the machine — AND (b) that family's MAIN checkout
// specifically.
//
// Both facts about the target are read from ONE scrubbed `git rev-parse --path-format=absolute
// --git-dir --git-common-dir` call (`resolveTargetGitDirs()` below — the two-value shape
// `scripts/clear-stale-worktree-lock.mjs:91` already uses for the identical need): (a) is
// `target's common-dir === this hook's OWN common-dir` (resolved via `scripts/coord/lock-path.mjs`'s
// `resolveCommonDirPath()`, the repo's existing anchor-to-common-dir resolver — reused rather
// than a third hand-rolled copy of that exact algorithm, the same lesson that module's own
// header cites); (b) is `target's git-dir === target's common-dir` (main checkout iff the two
// coincide — the same test `scripts/check-coordination-branch.mjs`'s `isMainCheckout()` makes,
// inlined here rather than imported so both facts about the target come from the SAME scrubbed
// call with the SAME env policy, instead of two calls under two different ones).
//
// Both git calls are scrubbed of every `GIT_*` env var (`resolveCommonDirPath()` internally,
// `resolveTargetGitDirs()` via the same `gitIsolatedEnv()` primitive) — an ambient `GIT_DIR` /
// `GIT_WORK_TREE` in the calling shell can otherwise redirect git's own repository discovery to
// a THIRD repo, silently defeating both checks regardless of what `-C`/cwd say.
//
// The repo-family check (a) is NOT `isMainCheckout()`'s job and never was: it only compares a
// checkout's git-dir with its own common-dir, a property true of the main working tree of EVERY
// ordinary git clone, not just this one. Without (a), a rebase run against the umbrella
// repo one directory up (`C:\Users\user\Desktop\Claude\Hobby`, a real git repo the operator
// works in directly) — or any other unrelated clone on the machine — was DENIED with a message
// telling the caller to run vetapp's own `scripts/heal-main.mjs`, which is wrong there and not
// this hook's call to make.
//
// "This hook's OWN common-dir" is anchored at `HOOK_DIR` (derived from `import.meta.url`), so it
// is vetapp's common dir regardless of whether this file is currently running from the main
// checkout or a linked worktree — every vetapp worktree shares the main checkout's common dir by
// construction, the same fact `isMainCheckout()` itself relies on one level up.
//
// § WHAT THIS GUARD DELIBERATELY DOES NOT POLICE. The first group are real bypasses, left open
// on purpose: the threat model is an ACCIDENTAL hand-run of a dangerous git op (the plan
// 3541/3531 shape), not a determined attempt to evade this hook — and `DONE_WORKTREE_AUTHORIZED=1`
// is the sanctioned bypass for the rare legitimate case anyway, so closing these would only add
// parsing surface against a threat that already has an easier way through.
//   - `--git-dir=<path>` / `--work-tree=<path>` as the TARGET selector. `scanGitPrefix()` skips
//     them correctly as value-taking global options (so they don't get misread as the verb or
//     swallow a real argument), but their VALUE is never read as an alternate target the way
//     `-C`'s is — a `git --git-dir=<main>/.git rebase` is not caught.
//   - `env -C <dir> git rebase origin/master` is the SAME gap as the bullet directly above, one
//     level further out: `land-timeout-guard.mjs`'s shared `WRAPPER_VALUE_FLAGS` (round 3) now
//     consumes `-C`/`--chdir`'s value correctly, so the wrapped `git rebase` IS found — but
//     `<dir>` is never read as an alternate TARGET the way the git-level `-C`'s value is. A
//     rebase run this way is graded against the payload cwd, not `<dir>`.
//   - Rebase CONFIGURED rather than flagged: `git -c pull.rebase=true pull` (or a `pull.rebase`
//     set in the checkout's own config) behaves exactly like `git pull --rebase` but carries no
//     `--rebase` token this guard's argv classification can see.
//   - A git command hidden inside a shell wrapper or command substitution (`bash -c "…"`,
//     `$(…)`) — this guard, like `land-timeout-guard.mjs`, only classifies TOP-LEVEL pipeline
//     segments, never recurses into a nested shell's own command line.
//   - `env -S '<whole command>'` is the SAME gap as the bullet directly above: the round-3
//     `WRAPPER_VALUE_FLAGS` change stops `<whole command>` from being MISREAD as the wrapped
//     command's own argv0 (progress — the segment no longer silently degrades to nonsense), but
//     nothing then PARSES what is inside that one token, which is itself a full command line
//     `env` will later split and exec.
//   - The `DONE_WORKTREE_AUTHORIZED=1` escape matches ANYWHERE in the command text, not only as
//     a prefix — deliberately identical to `worktree-guard.sh`'s own `grep -q` check, so the two
//     guards can never disagree about what counts as an escape.
//   The next two are UNFIXABLE without this hook running a shell itself, which it must never do
//     (it only ever classifies a proposed command's TEXT — see § FAIL-OPEN):
//   - Shell EXPANSION. This guard sees the literal token, not what the shell would substitute:
//     `MAIN=../main; git -C "$MAIN" reset --hard` is graded on the unexpanded string `"$MAIN"`,
//     which resolves to nothing and ALLOWS. Same class of limit as the wrapper/substitution
//     bullet above.
//   - A `cd` into the main checkout ahead of a later git segment (`cd ../main && git reset
//     --hard`) is not resolved either — this guard reads `-C`/payload cwd only, never a `cd`
//     earlier in the same command. Partial mitigation exists, but from a DIFFERENT guard for a
//     DIFFERENT reason: `bash-shape-guard.mjs` already refuses a command that opens with `cd` or
//     chains one after a separator on this platform (the "never open a Bash command with `cd`"
//     rule), so that exact shape stops earlier — but that is not this guard's own coverage, and
//     a `cd` reached some other way (a wrapper script, a sourced function) is not caught by
//     either.
//   Also, ordinarily rather than deliberately out of scope (see the other bullets further down):
//   - `git reset` without `--hard` (soft/mixed resets don't touch the working tree).
//   - `git pull` without `--rebase` (a plain fetch+merge — see above).
//   - `git merge --ff-only`, and `git merge-base` / `git merge-tree` (read-only plumbing;
//     matched as the exact verb token `merge`, so `merge-*` subcommands never match at all —
//     no allowlist-by-proxy needed the way worktree-guard.sh's shell-regex trigger requires).
//   - Any of the four forbidden shapes aimed at a WORKTREE checkout — the whole point is that
//     a worktree branch is scoped to one session, so a hand rewrite there is that session's
//     own business.
//   - Any of the four forbidden shapes aimed at a DIFFERENT repo entirely (the hobby umbrella
//     repo, tandapp, a personal clone, …) — not this hook's territory, see (a) above.
//   - A `git push` of any kind — that is `land-timeout-guard.mjs` / `worktree-guard.sh`'s
//     territory, not this hook's.
//   - Concurrent NON-git rewrites of the main checkout (a hand `rm -rf .git/...`, editing
//     tracked files directly). Out of scope — this hook only ever looks at `git` argv.
//
// § FAIL-OPEN, unconditionally — same posture and same reasoning as land-timeout-guard.mjs: a
// hook crash that blocks unrelated Bash commands across every parallel session is worse than
// the rare hand-rebase this hook exists to catch. The whole verdict runs inside a try/catch
// that exits 0 with no output on a throw; MAIN_CHECKOUT_REBASE_GUARD_FORCE_ERROR=1 is the test
// seam that exercises exactly that path (thrown BEFORE stdin is even read).
//
// An UNRESOLVABLE target (not a git checkout at all, or a `-C` path this process cannot stat, or
// a git older than 2.31 lacking `--path-format`) ALLOWS, deliberately the opposite of
// `isMainCheckout()`'s own conservative default. That default is tuned for consumers (the
// coordination-doc write guard) that already know they are looking at THIS repo and are only
// asking main-vs-worktree; here the target hasn't even cleared the repo-family check yet, so
// denying a path that cannot even be proven to be a git checkout, let alone vetapp's, would be
// pure friction with no rule behind it. `--path-format=absolute` itself is not a new dependency
// this hook introduces — it is already a hard requirement of this repo's critical path
// (`scripts/clear-stale-worktree-lock.mjs:91`, `scripts/done-worktree.mjs:3002`), so an
// environment old enough to lack it already fails those before it ever reaches this guard.
//
// § ESCAPE HATCH. `DONE_WORKTREE_AUTHORIZED=1` anywhere in the command passes — the same
// single-call bypass `worktree-guard.sh` already uses for the stale-lock-rm deny it carries.
//
// § COST DISCIPLINE. The forbidden-verb match is decided FIRST from pure string/argv parsing —
// no subprocess of any kind spawns until a segment's verb already matches one of the four
// forbidden shapes. From there, resolving a candidate costs at most two `git rev-parse`
// subprocesses: one `resolveCommonDirPath({ anchor: hookDir })` call for THIS HOOK's own
// checkout (cached per `hookDir`, so at most once per process regardless of how many candidates
// a single command carries), and one combined `--git-dir --git-common-dir` call for the target.
// This hook is registered UNCONDITIONALLY on the `Bash` matcher (no `"if"` gate) — matching
// `hand-rolled-step-guard.mjs`, `bash-shape-guard.mjs`, and `land-timeout-guard.mjs` in the same
// array — because a prefix-anchored `"if": "Bash(git *)"` condition never launches on a command
// that does not itself START with `git ` (`timeout 60 git -C <main> rebase`, `foo && git -C
// <main> reset --hard`, `X=1 git rebase`), which is exactly the chained/wrapped shape the
// multi-segment loop below exists to catch. The cost of launching unconditionally is one Node
// process start on a non-git Bash call, same as the three sibling guards above.
//
// § PATH COMPARISON is CASE-INSENSITIVE on win32 only (`pathsEqual()` below) — POSIX stays
// case-sensitive. Two strings naming the same Windows directory can differ in drive-letter or
// segment case (git itself is inconsistent about this across call sites), and a case-sensitive
// compare would silently ALLOW on a mismatch with no signal that anything was wrong — the guard
// would simply stop firing. `platform` is a parameter (vetapp/CLAUDE.md's platform-parameter
// rule) so both branches are exercised directly in tests without needing two host OSes.
//
// Refuted in review, twice, do not re-litigate: a finder claimed `scanGitPrefix()` misses git's
// attached short form `-C<path>`. Two independent example shapes were measured directly and both
// fail identically: `git -C"<path>" rev-parse` and `git -C..` (round-2's exact example) both
// answer `unknown option: -C<path>` / `unknown option: -C..` and print the usage block, exit 129.
// The attached form does not exist in real git — only the separate-token form below is real. The
// existing comment on that branch is correct.
//
// Bash only, matching land-timeout-guard.mjs — PowerShell has no relevant symmetry issue here
// either, but this hook is registered on the `Bash` matcher only, per the SCOPE for plan 3944.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdin } from './lib/loader-common.mjs';
import {
  classifyEnvironment,
  GIT_BASENAMES,
  GIT_VALUE_FLAGS,
  parseSegment,
  splitSegments,
} from './land-timeout-guard.mjs';
import { gitIsolatedEnv } from '../coord/child-env.mjs';
import { resolveCommonDirPath } from '../coord/lock-path.mjs';

const ESCAPE_TOKEN = 'DONE_WORKTREE_AUTHORIZED=1';

// This hook module's OWN directory — used only to anchor the repo-family check below to
// wherever this file is actually running from (vetapp's main checkout or one of its linked
// worktrees), never a hardcoded path.
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

// Resolve `target`'s absolute git-dir AND git-common-dir in ONE scrubbed call — the two-value
// shape `scripts/clear-stale-worktree-lock.mjs:91` already uses for the identical need
// (main-vs-worktree, from `git-dir === common-dir`). Scrubbed via `gitIsolatedEnv()` for the
// same reason `resolveCommonDirPath()` is: an ambient `GIT_DIR`/`GIT_WORK_TREE` in the shell can
// redirect git's own repository discovery to a FOREIGN repo, defeating both checks this hook
// makes. `--path-format=absolute` (git >= 2.31) means neither value needs a manual
// `resolve(cwd, …)` the way a bare `--git-common-dir` would (unlike `resolveCommonDirPath()`'s
// own anchor-relative case, which predates `--path-format` in its call sites and keeps that
// form for its other callers). Returns null on ANY failure (not a repo, git missing, ancient
// git) — the caller's fail-toward-ALLOW direction, see header § on unresolvable targets.
function resolveTargetGitDirs(target) {
  try {
    const lines = execFileSync(
      'git',
      ['-C', target, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', env: gitIsolatedEnv() },
    )
      .trim()
      .split(/\r?\n/);
    const gitDir = (lines[0] || '').trim();
    const commonDir = (lines[1] || '').trim();
    if (!gitDir || !commonDir) return null;
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

// Case-insensitive on win32 only; POSIX stays case-sensitive. `platform` is a parameter — see
// header § PATH COMPARISON — so both branches are directly testable without two host OSes.
//
// Backslash-to-slash normalization is ALSO win32-only (review round 2, four independent
// findings): a backslash is a legal POSIX filename character, so folding it unconditionally
// made `/tmp/a\b` and `/tmp/a/b` compare EQUAL there — a real bypass in one direction (an
// unrelated repo containing a literal backslash in its path treated as this family) and a real
// false-positive in the other. Only win32 ever needs the fold (git itself mixes `\` and `/`
// there depending on call site), so only win32 gets it.
export function pathsEqual(a, b, platform = process.platform) {
  const norm = (p) => {
    let s = String(p ?? '');
    if (platform === 'win32') {
      s = s.replace(/\\/g, '/').toLowerCase();
    }
    return s.replace(/\/+$/, ''); // trailing-slash trim is harmless dedup on either platform
  };
  return norm(a) === norm(b);
}

// Lazily computed and cached PER hookDir for the lifetime of this process (one hook invocation
// = one process, so in production there is exactly one key — `HOOK_DIR` — ever computed, and
// only once, and never at all when a command carries no candidate verb, § COST DISCIPLINE). The
// `hookDir` parameter (default `HOOK_DIR`, derived from `import.meta.url`) is a test seam only —
// vetapp/CLAUDE.md's platform-parameter idiom, mirroring `classifyEnvironment(payload, env =
// process.env)` elsewhere in this file — so a test can point "this hook's own repo" at an
// isolated temp fixture instead of the real checkout. `null` in the cache means "attempted and
// failed" (should not happen in production — see the header note); a key simply absent means
// "not yet attempted".
const ownCommonDirCache = new Map();
function ownCommonDir(hookDir = HOOK_DIR) {
  if (!ownCommonDirCache.has(hookDir)) {
    let val = null;
    try {
      val = resolveCommonDirPath({ anchor: hookDir });
    } catch {
      val = null;
    }
    ownCommonDirCache.set(hookDir, val);
  }
  return ownCommonDirCache.get(hookDir);
}

// Both facts evaluate() needs about `target`, from ONE resolution: whether it is in the SAME
// repo family as `hookDir` (own common-dir) and whether it IS that family's main checkout
// (git-dir === common-dir). Returns `{ sameFamily: false, isMain: false }` on any resolution
// failure on either side — the caller's fail-toward-ALLOW direction (see header §).
function classifyTarget(target, hookDir = HOOK_DIR, platform = process.platform) {
  const own = ownCommonDir(hookDir);
  if (!own) return { sameFamily: false, isMain: false };
  const resolved = resolveTargetGitDirs(target);
  if (!resolved) return { sameFamily: false, isMain: false };
  return {
    sameFamily: pathsEqual(resolved.commonDir, own, platform),
    isMain: pathsEqual(resolved.gitDir, resolved.commonDir, platform),
  };
}

// The four forbidden verbs, keyed by the verdict key emitted for each.
const FORBIDDEN_LABEL = {
  rebase: 'git rebase',
  'reset-hard': 'git reset --hard',
  'pull-rebase': 'git pull --rebase',
  'merge-non-ff': 'git merge (not --ff-only)',
};

// `--rebase=<value>` spellings that explicitly ask for a MERGE, not a rebase. Measured directly
// against a real diverged repo (review round 3, `git pull --rebase=<value>` for each): `false`,
// `no`, `off`, `0`, and the EMPTY string (`--rebase=`) all parse without error and disable
// rebase (confirmed by a resulting MERGE COMMIT, not a linear rebase); `--rebase=bogus` is the
// discriminator that proves the boundary — it errors `invalid value for '--rebase': 'bogus'`,
// so anything git accepts silently belongs in this set and anything it rejects does not.
// Case-insensitive, matching git's own bool parsing. Denying `git pull --rebase=false` would
// block the exact command someone used to AVOID the banned behaviour — the worst kind of false
// positive.
const REBASE_FALSY_VALUES = new Set(['false', 'no', 'off', '0', '']);

// `--rebase` on `git pull` — judges only the LAST `-r`/`--rebase`/`--rebase=<value>`/
// `--no-rebase` occurrence, matching git's own last-flag-wins semantics (measured directly,
// review round 3: a diverged repo pulled with `--rebase=false --rebase` REBASES — linear
// history, no merge commit — while the same repo pulled with `--rebase --rebase=false` MERGES —
// a merge commit is created). Grading `.some()` over every occurrence (the round-2 shape) would
// have denied the safe `--rebase=false --rebase` ordering's mirror image, `--rebase
// --rebase=false`, purely because an EARLIER truthy flag was present — exactly backwards. Any
// truthy spelling behaves the same (`true`, `interactive`, `merges`, … all still count — grading
// "not explicitly falsy" rather than an allowlist of truthy spellings, matching how loosely git
// itself accepts this value). Rebase configured via `pull.rebase` (no flag at all) is a known,
// deliberate gap — see header §.
//
// `--no-rebase` added (review round 4) — measured directly: `git pull --no-rebase` parses fine
// (a plain merge) while `git pull --no-rebasex` errors `unknown option`, so `--no-rebase` is a
// REAL, and in practice the MOST common, way to ask for a merge — rounds 2/3 chased only
// `--rebase=<falsy value>`, which denied the single most likely compliant command. It is FALSY
// like `--rebase=false`, but tracked as its own last-flag CANDIDATE (not folded into
// `--rebase=`'s value parsing) because it carries no `=` to slice — `--no-rebase --rebase` must
// still DENY (the LAST flag, `--rebase`, wins) and `--rebase --no-rebase` must still ALLOW.
function pullIsRebase(verbArgs) {
  let last = null;
  for (const a of verbArgs) {
    const t = String(a ?? '');
    if (t === '-r' || t === '--rebase' || t.startsWith('--rebase=') || t === '--no-rebase') {
      last = t;
    }
  }
  if (last === null) return false;
  if (last === '--no-rebase') return false;
  if (last === '-r' || last === '--rebase') return true;
  const value = last.slice('--rebase='.length).toLowerCase();
  return !REBASE_FALSY_VALUES.has(value);
}

// Walk a git segment's ARGS (everything after argv0) past its own global options, collecting
// EVERY `-C <path>` value seen IN ORDER (never just the last — see the fold in evaluate()
// below for why). Stops at the first positional token, which is the git VERB. Returns
// `verbIndex: -1` when the segment carries no verb at all (bare `git -C x` with nothing after
// it, or bare `git`).
//
// `-C` has no attached short form in real git (measured: `git -C"<path>" rev-parse` answers
// `unknown option: -C<path>`, exit 129) — only the separate-token form below is real, so there
// is no `-C<path>` case to also handle here.
function scanGitPrefix(args) {
  const cPaths = [];
  let i = 0;
  while (i < args.length) {
    const t = String(args[i] ?? '');
    if (!t.startsWith('-')) return { cPaths, verbIndex: i };
    const bare = t.split('=')[0];
    if (bare === '-C') {
      // `-C` is a separate-token option in git's own grammar (never `-C=<path>`); an
      // attached-looking `-C=x` has no value token to skip and is left as an unresolvable
      // flag rather than mis-consuming the next real token.
      if (!t.includes('=') && i + 1 < args.length) {
        cPaths.push(args[i + 1]);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (GIT_VALUE_FLAGS.has(bare) && !t.includes('=') && i + 1 < args.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return { cPaths, verbIndex: -1 };
}

// Pure string/argv classification of ONE parsed segment: which forbidden verdict key (if any)
// this segment's git invocation matches, and the ORDERED list of `-C` paths it carries (empty
// if none), UNRESOLVED — the caller folds them against the Bash command's own cwd (see
// evaluate() below). Never touches disk or spawns a process — that is deliberately deferred to
// the caller, which only resolves the target once this returns a real key (§ COST DISCIPLINE).
export function classifyGitSegment(parsed) {
  if (!GIT_BASENAMES.has(parsed.argv0Base)) return null;
  const { cPaths, verbIndex } = scanGitPrefix(parsed.args);
  if (verbIndex === -1) return null;
  const verb = String(parsed.args[verbIndex] ?? '');
  const verbArgs = parsed.args.slice(verbIndex + 1);

  let key = null;
  if (verb === 'rebase') {
    key = 'rebase'; // any form, including --abort/--continue/--skip
  } else if (verb === 'reset' && verbArgs.includes('--hard')) {
    key = 'reset-hard';
  } else if (verb === 'pull' && pullIsRebase(verbArgs)) {
    key = 'pull-rebase';
  } else if (verb === 'merge' && !verbArgs.includes('--ff-only')) {
    key = 'merge-non-ff';
  }
  if (!key) return null;
  return { key, cPaths };
}

// ── the verdict ──────────────────────────────────────────────────────────────

// Returns null (ALLOW) or { key, target } (DENY). `env` is a parameter (vetapp/CLAUDE.md's
// platform-parameter rule), kept symmetric with land-timeout-guard.mjs's `evaluate(payload,
// env)` signature. The third argument is test-only: `{ hookDir, platform }` override which
// checkout counts as "this hook's own repo" and which OS's path-comparison rules apply —
// production callers (`main()` below) never pass it, so both always default to the real values.
export function evaluate(
  payload,
  env = process.env,
  { hookDir = HOOK_DIR, platform = process.platform } = {},
) {
  if (String(payload?.tool_name ?? '') !== 'Bash') return null;
  const input = payload?.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;

  // Subagent shape is silent, full stop — this rule is aimed at a top-level session hand-
  // running recovery, not at anything a dispatched worker does (a worker never touches the
  // main checkout directly; it operates inside its own worktree).
  if (classifyEnvironment(payload, env) === 'subagent') return null;

  if (command.includes(ESCAPE_TOKEN)) return null;

  const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd : process.cwd();

  for (const segment of splitSegments(command)) {
    const parsed = parseSegment(segment);
    const candidate = classifyGitSegment(parsed);
    if (!candidate) continue; // cheap string/argv check FIRST — no subprocess spawned yet
    // Fold every `-C` CUMULATIVELY, starting from the Bash command's own cwd — never this hook
    // subprocess's. Git resolves each relative `-C` against wherever the PREVIOUS `-C` left
    // off, not against the original cwd (`git -C ../main -C . rebase` targets `../main`, not
    // `.` relative to cwd) — "last -C wins" alone would land back in the wrong directory for
    // that shape. `resolve()`'s own absolute-path short-circuit makes this the same fold that
    // correctly handles a single `-C`, a later ABSOLUTE `-C` overriding an earlier relative
    // one, and no `-C` at all (the reduce initial value passes through unchanged).
    const target = candidate.cPaths.reduce((acc, raw) => resolve(acc, raw), cwd);
    const { sameFamily, isMain } = classifyTarget(target, hookDir, platform);
    // (a) a DIFFERENT repo entirely (or an unresolvable path) → not ours to police → ALLOW.
    if (!sameFamily) continue;
    // (b) this repo family, but a WORKTREE checkout rather than the main one → ALLOW.
    if (!isMain) continue;
    return { key: candidate.key, target };
  }
  return null;
}

// ── block text ───────────────────────────────────────────────────────────────

export function formatBlock(verdict) {
  const label = FORBIDDEN_LABEL[verdict.key] ?? verdict.key;
  return [
    `main-checkout-rebase-guard: this \`${label}\` targets the shared MAIN checkout`,
    `  (${verdict.target}).`,
    '',
    '  ~5-7 parallel sessions share this ONE working tree. A hand rebase/reset/pull-rebase/',
    "  merge there can discard or strand another session's unpushed commit mid-rewrite —",
    '  exactly what happened in plan 3541 (a MAIN wedge hand-rebased instead of healed) and',
    '  plan 3531 (a git op retried against the shared tree instead of waiting on the lock).',
    '',
    '  Use the sanctioned path instead:',
    '    node scripts/heal-main.mjs        — the ONE recovery tool for a wedged MAIN checkout',
    '                                         (stale locks, leftover rebase state, detached',
    '                                         HEAD, master out of sync with origin).',
    '  An ordinary push already rebases for you via `pushMasterWithRebase`',
    '  (scripts/coord/coord-git.mjs) — it fetches, rebases onto origin/master, and ABORTS on any',
    '  real conflict rather than trying to push through one by hand.',
    '',
    `  To force this exact command anyway, prefix it with ${ESCAPE_TOKEN}.`,
  ].join('\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(env = process.env) {
  // Fail-open test seam — see § FAIL-OPEN in the header. Throws BEFORE reading stdin so the
  // test exercises the outermost catch, not a parse branch.
  if (String(env?.MAIN_CHECKOUT_REBASE_GUARD_FORCE_ERROR ?? '') === '1') {
    throw new Error('main-checkout-rebase-guard: forced error (fail-open test seam)');
  }

  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed → fail open
  }

  const verdict = evaluate(payload, env);
  if (!verdict) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: formatBlock(verdict),
      },
    }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}

export { main };
