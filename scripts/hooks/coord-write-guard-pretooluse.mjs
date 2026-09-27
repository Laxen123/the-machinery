#!/usr/bin/env node
// scripts/hooks/coord-write-guard-pretooluse.mjs — PreToolUse hook (plan 1655).
//
// Proactive twin of scripts/check-coordination-branch.mjs's husky pre-commit
// guard: intercepts a `git add`/`git commit` touching a guarded coordination
// path (docs/handoff/**, docs/INDEX.md, docs/superpowers/plans/**, wiki/**,
// WIKI.md) BEFORE the Bash tool call even runs, importing the SAME
// classification (coordinationRx/WIKI_RX/classifyBlock/classifyDetachedMain/
// isMainCheckout/filterMergeInheritedPaths) and messages (formatBlockMessage,
// formatDetachedMainMessage) as the real guard — zero drift, and the
// sanctioned-tools cheat sheet reaches the model before it wastes a round-trip
// on a doomed `git commit`, instead of only after husky rejects it (the
// plan-1542 landing-session detour this hook exists to shorten).
//
// TWO refuses, both mirrored from the pre-commit guard:
//   - the coordination/wiki PATH block (classifyBlock), and
//   - the plan-2391 DETACHED-MAIN block (classifyDetachedMain), which is
//     path-INDEPENDENT: on a detached main checkout every commit is silently
//     lost by the next `pull --rebase`, whatever it touches. Mirroring it here
//     is what keeps the "zero drift" claim above true (plan-2391 review
//     finding koku0o: the guard grew the refuse and this hook did not).
//
// Scope: only `git add` / `git commit`. NOT `git push`/`merge` — those are
// already covered by worktree-guard.sh, and by the time a push happens the
// commit decision is already made, so this hook's job is done earlier.
//
// Trigger is boundary-anchored (start of command, or right after a
// separator `; & | (`, with an optional env-assignment prefix) — mirrors
// worktree-guard.sh's own anchoring so prose mentioning "git commit" inside
// a quoted commit MESSAGE doesn't arm the guard. The MESSAGE ITSELF (a
// `-m`/`--message` argument) is additionally blanked out before any
// flag/trigger/override regex runs (stripCommitMessages) — free-form prose
// in a commit message must never be mistaken for a real flag (`-a`) or the
// override sentinel (plan-1655 review findings).
//
// Candidate paths checked:
//   - explicit `git add <path...>` targets (flags dropped), rebased onto
//     REPO_ROOT so an ABSOLUTE path target (this repo's own CLAUDE.md
//     mandates full paths) still matches the repo-relative guard patterns
//     instead of silently missing them (plan-1655 review finding [normPath
//     never strips an absolute prefix]);
//   - a BROAD add (-A/-u/--all/--update/.) additionally checks the real
//     working tree (`git status --porcelain` in the resolved cwd) — unlike
//     a future push, the current tree is directly inspectable, so this is
//     precise rather than a blanket deny;
//   - any `git commit` unions in the currently STAGED set
//     (`git diff --cached --name-only`, MERGE_HEAD-inherited paths dropped
//     via filterMergeInheritedPaths — the plan-507 conflicted freshen-merge
//     conclusion exemption check-coordination-branch.mjs's own hook applies),
//     plus the unstaged tracked-modified set when `-a`/`-am`/`--all` is
//     present.
//
// cwd resolution: a leading `git -C <dir>` or `cd <dir> &&` in the command
// (same heuristic as worktree-guard.sh) — otherwise the hook's own cwd. A
// resolved cwd outside THIS repo (a sibling checkout — tandapp, petfood,
// board-games, or an unrelated vault) is not evaluated at all, mirroring
// worktree-guard.sh's own cross-repo skip: this hook only protects vetapp's
// coordination docs, never a sibling repo's independent commit.
//
// Fails OPEN on any parse/git error — a tool hook must never break the turn.

import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coordinationRx,
  classifyBlock,
  classifyDetachedMain,
  formatDetachedMainMessage,
  isMainCheckout,
  filterMergeInheritedPaths,
  formatBlockMessage,
} from '../coord/check-coordination-branch.mjs';
import { normalizeRel } from '../coord/main-checkout-allowlist.mjs';
import { loadCoordConfig } from '../coord/coord-config.mjs';
import { denyEnvelope, runHookCli } from './lib/loader-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// `git -C <dir>` may sit between `git` and the subcommand — every pattern
// below that anchors on `git\s+(add|commit)` tolerates an optional one so
// `git -C <dir> add/commit ...` isn't a silent miss (resolveCwd already
// special-cases `-C` for the cwd itself; the subcommand match must agree).
// The value alternation is shared as its own fragment (DASH_C_VALUE) so
// resolveCwd's own `-C` match can reuse the identical pattern instead of a
// second hand-written copy (plan-1655 review: the two had drifted apart).
const DASH_C_VALUE = '(?:"[^"]*"|\'[^\']*\'|\\S+)';
const DASH_C = `(?:-C\\s+${DASH_C_VALUE}\\s+)?`;

// Boundary-anchored trigger — see file header for why the anchor matters.
const TRIGGER_RE = new RegExp(
  `(^|[;&|(])\\s*([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*git\\s+${DASH_C}(add|commit)\\b`,
);

const BROAD_ADD_RE = new RegExp(`git\\s+${DASH_C}add\\s+(-A|-u|--all|--update|\\.)(\\s|$|&|;|\\|)`);
const COMMIT_ALL_RE = new RegExp(`git\\s+${DASH_C}commit\\b[^&|;]*\\s(-a\\b|-am\\b|--all\\b)`);
const GIT_COMMIT_RE = new RegExp(`git\\s+${DASH_C}commit\\b`);

// A command-boundary anchor matching TRIGGER_RE's own (start-of-string or
// right after a separator, not bare mid-prose whitespace) — the override
// must be a real inline env-assignment prefix, not text that merely sits
// somewhere in the command (plan-1655 review: the old `[\s;&|(]` boundary
// let "...BOARD_GUARD_OVERRIDE=1..." embedded in a quoted commit MESSAGE
// silently disarm the guard).
const OVERRIDE_RE = /(^|[;&|(])\s*BOARD_GUARD_OVERRIDE=1(?=\s|$)/;

function stripQuotes(tok) {
  const t = tok.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Repo-relative, forward-slashed path for classifyBlock's anchors. An
// ABSOLUTE token (or a relative one that resolves outside `repoRoot` once
// rebased onto `cwd`) is rebased onto `repoRoot` first — normalizeRel()
// alone only normalizes slashes, it never strips a drive letter / repo
// prefix, so an absolute `git add C:\...\docs\INDEX.md` target used to sail
// through unmatched (plan-1655 review, most severe finding).
function normPath(p, cwd, repoRoot) {
  const rel = normalizeRel(stripQuotes(p));
  if (!/^([A-Za-z]:)?\//.test(rel)) return rel; // already repo-relative
  const abs = resolve(cwd, stripQuotes(p));
  return normalizeRel(relative(repoRoot, abs));
}

// Blank out the CONTENT of a `-m`/`--message` argument before any
// flag/trigger/override regex runs. A commit message is free-form prose to
// git — it must never be misread as a real flag (`-a`) or the
// BOARD_GUARD_OVERRIDE sentinel (plan-1655 review: both were confirmed
// false-positive/false-negative vectors via a crafted -m string).
function stripCommitMessages(cmd) {
  return cmd.replace(
    /(-m|--message)(\s+)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    (_m, flag, ws) => `${flag}${ws}""`,
  );
}

// Resolve the cwd a `git -C <dir>` or leading `cd <dir> &&` in the command
// targets. Best-effort; falls back to this hook's own cwd (the repo root).
function resolveCwd(cmd, repoRoot) {
  const dashC = cmd.match(new RegExp(`git\\s+-C\\s+(${DASH_C_VALUE})`));
  if (dashC) {
    try {
      return resolve(repoRoot, normalizeRel(stripQuotes(dashC[1])));
    } catch {
      /* fall through */
    }
  }
  const cd = cmd.match(/(^|[;&|(])\s*cd\s+("[^"]*"|'[^']*'|[^&|;]+?)(\s*(&&|;|\||$))/);
  if (cd) {
    try {
      return resolve(repoRoot, normalizeRel(stripQuotes(cd[2])));
    } catch {
      /* fall through */
    }
  }
  return process.cwd();
}

// `--no-optional-locks` is prepended UNCONDITIONALLY (plan 3974 T1) rather than at each call site:
// this hook is a read-only PreToolUse classifier with no write path, so every caller below (status,
// diff, rev-parse) is safe to make lock-free with one edit. It is a GLOBAL git option and must
// precede the subcommand on the argv, hence the array literal position — an unconditional dynamic
// passthrough with no such literal is exactly the shape scripts/assert-lock-free-git-polls.mjs
// flags, in a file that (like this one) also spawns `status`/`diff` somewhere.
function git(args, cwd, { nullOnError = false } = {}) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return nullOnError ? null : '';
  }
}

// The resolved absolute git-common-dir for `cwd`, or null if it isn't a git
// repo at all (fail-open — the caller treats null as "can't tell, skip").
function commonDir(cwd) {
  const out = git(['rev-parse', '--git-common-dir'], cwd, { nullOnError: true });
  if (out == null) return null;
  return resolve(cwd, out.trim());
}

// worktree-guard.sh only ever protects THIS repo's guarded paths — a `cd
// ../tandapp && git commit ...` for a SIBLING repo's own coord doc is none
// of vetapp's business (plan-1655 review: the hook was blocking/inspecting
// arbitrary sibling repos with no such skip). Case-insensitive compare on
// Windows, since the same directory can round-trip through git with
// different drive-letter casing.
function isSameRepo(cwd, repoRoot) {
  // The overwhelming common case (no `-C`/`cd` override in the command) —
  // trivially the same repo, no git spawn needed at all.
  if (resolve(cwd) === resolve(repoRoot)) return true;
  const a = commonDir(repoRoot);
  const b = commonDir(cwd);
  if (a == null || b == null) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// `git add <targets...>` argument tokens across every `add` invocation in the
// command (chained commands each get their own match), flags dropped.
function explicitAddTargets(cmd, cwd, repoRoot) {
  const out = [];
  const re = new RegExp(`git\\s+${DASH_C}add\\s+([^&|;]+)`, 'g');
  let m;
  while ((m = re.exec(cmd))) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok || tok.startsWith('-')) continue;
      out.push(normPath(tok, cwd, repoRoot));
    }
  }
  return out;
}

// `git status --porcelain` paths (staged + unstaged + untracked) — used for
// a broad add (can't scope-validate the flag itself, but the tree it would
// stage IS inspectable) and for `-a`/`-am` commits.
function workingTreePaths(cwd, repoRoot) {
  const out = git(['status', '--porcelain'], cwd);
  return out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
    .map((p) => normPath(p, cwd, repoRoot));
}

function stagedPaths(cwd, repoRoot) {
  return git(['diff', '--cached', '--name-only'], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => normPath(p, cwd, repoRoot));
}

function unstagedModifiedPaths(cwd, repoRoot) {
  return git(['diff', '--name-only'], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => normPath(p, cwd, repoRoot));
}

export function candidatePaths(cmd, cwd, repoRoot = REPO_ROOT) {
  const paths = new Set();
  for (const p of explicitAddTargets(cmd, cwd, repoRoot)) paths.add(p);
  if (BROAD_ADD_RE.test(cmd)) {
    for (const p of workingTreePaths(cwd, repoRoot)) paths.add(p);
  }
  if (GIT_COMMIT_RE.test(cmd)) {
    // pass 1307 parity: a conflicted freshen-merge conclusion (the
    // documented LAND_BLOCKED_HOLDING recovery flow) hand-commits a staged
    // set that inherits master's coord/plan files verbatim from MERGE_HEAD
    // — drop those before classifying, exactly like the real pre-commit
    // guard does (plan-1655 review: this hook used to skip that exemption
    // entirely and would block the plan-507 recovery flow).
    for (const p of filterMergeInheritedPaths(stagedPaths(cwd, repoRoot), cwd)) paths.add(p);
    if (COMMIT_ALL_RE.test(cmd)) {
      for (const p of unstagedModifiedPaths(cwd, repoRoot)) paths.add(p);
    }
  }
  return [...paths];
}

// The override is an inline env-var PREFIX on the not-yet-run command
// ("BOARD_GUARD_OVERRIDE=1 git commit ..."), not a variable of THIS hook's
// own process — a plain `env.BOARD_GUARD_OVERRIDE` check (what the real
// pre-commit hook does, correctly, since it runs AS the git subprocess)
// would never see it here. Detect it in the command text instead and fold
// it into a synthetic env for classifyBlock, so the one override path stays
// single-sourced in classifyBlock itself rather than duplicated as an
// early-return.
function envWithInlineOverride(cmd, baseEnv) {
  if (OVERRIDE_RE.test(cmd)) {
    return { ...baseEnv, BOARD_GUARD_OVERRIDE: '1' };
  }
  return baseEnv;
}

// `repoRoot` defaults to this hook's own repo (the real invocation path);
// tests override it to make a synthetic temp repo stand in as "this repo"
// so the cross-repo skip (isSameRepo) can be exercised without touching the
// real vetapp checkout.
export function evaluate(cmd, env = process.env, { repoRoot = REPO_ROOT } = {}) {
  const scanCmd = stripCommitMessages(cmd);
  if (!TRIGGER_RE.test(scanCmd)) return null;
  const effectiveEnv = envWithInlineOverride(scanCmd, env);
  const cwd = resolveCwd(scanCmd, repoRoot);
  if (!isSameRepo(cwd, repoRoot)) return null; // a sibling/unrelated repo — not this hook's business
  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { nullOnError: true });
  if (branchRaw == null) return null; // not a git repo / rev-parse can't resolve HEAD — allow
  const branch = branchRaw.trim();

  // plan 2391 review (finding koku0o): this hook's header promises the SAME classification as
  // scripts/check-coordination-branch.mjs, "zero drift". The pre-commit guard gained an
  // unconditional detached-MAIN refuse; without mirroring it here the hook stopped refusing a
  // doomed commit proactively — the exact wasted round-trip it exists to shorten. Note it is
  // deliberately PATH-INDEPENDENT (mirroring the real guard's own ordering, where the refuse
  // comes BEFORE the staged-set scan): on a detached main checkout ANY commit is lossy, not
  // only one touching a coordination path. Scoped to `git commit` — a bare `git add` stages
  // nothing lossy, and blocking it would be noise.
  if (GIT_COMMIT_RE.test(scanCmd)) {
    const detached = classifyDetachedMain(branch, effectiveEnv, {
      mainCheckout: isMainCheckout(cwd),
    });
    if (detached) {
      const readRef = (ref) => {
        const out = git(['rev-parse', '--verify', '--quiet', ref], cwd, { nullOnError: true });
        return out ? out.trim() || null : null;
      };
      return {
        res: { ...detached, headSha: readRef('HEAD'), masterSha: readRef('refs/heads/master') },
        branch,
      };
    }
  }

  const paths = candidatePaths(scanCmd, cwd, repoRoot);
  if (paths.length === 0) return null;
  const rx = coordinationRx(loadCoordConfig(repoRoot).paths);
  // isMainCheckout is only consulted by classifyBlock on a non-worktree
  // branch (the wiki/** guard extension) — skip its two extra git spawns on
  // the common worktree-branch path (plan-1655 review efficiency finding).
  const mainCheckout = branch.startsWith('worktree-') ? undefined : isMainCheckout(cwd);
  const res = classifyBlock(branch, paths, effectiveEnv, rx, { mainCheckout });
  if (!res) return null;
  return { res, branch };
}

// One message per block MODE, both single-sourced from check-coordination-branch.mjs so the
// PreToolUse text and the husky rejection text stay byte-identical (plan 2391 finding koku0o).
export function formatHitMessage(hit) {
  return hit.res.mode === 'detached-main'
    ? formatDetachedMainMessage(hit.res.headSha, hit.res.masterSha).join('\n')
    : formatBlockMessage(hit.res, hit.branch).join('\n');
}

// The hook's whole outcome as DATA (plan 4238): the deny envelope it would print, or
// null for silence. The in-process PreToolUse dispatcher (pretool-dispatch.mjs) calls
// this; the CLI below is a thin wrapper that prints it.
export function evaluateHook(payload) {
  const cmd = String(payload?.tool_input?.command ?? '');
  if (!cmd) return null;

  const hit = evaluate(cmd);
  if (!hit) return null;

  return denyEnvelope(formatHitMessage(hit));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
