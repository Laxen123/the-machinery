// scripts/coord/child-env.mjs — what a spawned child must NOT inherit from this process (plan 2604).
//
// A LEAF module on purpose: it imports nothing from the repo, so the two places that actually
// assemble a spawn env — coord-git.mjs's `gitRaw()` and done-worktree.mjs's `run()`/`gitEnv()` —
// can both use it without an import cycle (done-worktree-lib.mjs already re-exports FROM
// coord-git.mjs, so the scrub could not live in either of those and be shared).
//
// WHY THE SCRUB MUST LIVE AT THE SPAWN SEAM AND RUN *LAST* (two review rounds, 2026-07-28).
// The first cut scrubbed at done-worktree's callers and passed the cleaned object down. That is
// silently ineffective, because a "scrubbed" copy expresses absence, and absence loses:
//
//     { ...process.env, ...scrubbedCopy }   // → process.env's value WINS
//
// An absent key in a later spread cannot override a present key in an earlier one, so any callee
// that re-spreads `process.env` first — which `gitRaw()` did, and it is the seam every coord push
// routes through — silently re-supplied the very var the caller removed.
//
// The second cut moved the scrub into `gitRaw()` but used it as the BASE
// (`{ ...childEnv(process.env), ...env, … }`), which fails the mirror image of the same test: a
// CALLER passing its own `{ ...process.env, HUSKY: '0' }` re-supplies the var on top — and
// move-plan.mjs, stamp-lib.mjs and drain-run.mjs each build exactly that and push to master.
//
// So the scrub runs on the FULLY MERGED object, immediately before the spawn. That is the only
// formulation no caller can defeat, and it means callers need no discipline at all: pass whatever
// env you like — the seam alone decides what a child may not inherit.
//
// CASE-INSENSITIVE, and on win32 that is load-bearing rather than defensive (measured, not
// theorised): Windows env lookup is case-insensitive, but a spread copy of `process.env` is an
// ordinary case-SENSITIVE object. So `allow_landed_reversion=1 node …` gives a process whose
// `process.env.ALLOW_LANDED_REVERSION` reads '1', while `delete copy['ALLOW_LANDED_REVERSION']`
// removes nothing — the child inherits the lowercase key and reads it back through the same
// case-insensitive lookup. A case-sensitive scrub leaks on the one platform this spine lands
// from, and leaks INVISIBLY: the var looks scrubbed. On POSIX two casings are genuinely distinct
// vars, and the cost of matching both is at most scrubbing a same-named lowercase var nobody sets.

// Env vars meaningful to THIS PROCESS ONLY. The burden for adding a name is showing its consumer
// is in-process; a var with any CHILD consumer must NOT be listed.
//
// This list is EMPTY today, and the mechanism below is the point of the file. The motivating
// entry was `ALLOW_LANDED_REVERSION` (retired by plan 3832 with the landed-reversion halt it
// released): a land-scoped escape hatch whose only consumer was in-process, and which — inherited
// by the detached land-prep and the head-time push, whose `.husky/pre-push` battery runs
// done-worktree's own tests — silently turned off the very guard those tests cover, so the battery
// reported a real regression and the one land that needed the hatch was the one land the hatch
// broke (plan 2598, 2026-07-28; the same suite in a clean shell was 215/215). The var is gone; the
// hazard it taught is not, so the scrub stays and the next in-process-only override is one string
// away from being handled correctly.
//
// Checked and deliberately NOT listed, because each has a real child consumer:
// `PREPUSH_FULL_BATTERY` / `PREPUSH_FULL_PYTEST` / `PREPUSH_NO_BATTERY_CACHE` (read by
// scripts/hooks/pre-push.sh in the hook child), `DONE_WORKTREE_AUTHORIZED` (push-side guards),
// and the `DW_FAKE_*` test seams (injected explicitly by tests).
export const CHILD_ENV_STRIP = [];

// git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE into every hook subprocess, so anything
// that spawns git against a DIFFERENT repo than the ambient one must drop them or the child
// silently targets the wrong repo. Named here because the scrub loop had drifted into four
// independently-maintained copies (lock-path.mjs, test-helpers/clean-git-env.mjs,
// pass-cache-kernel.mjs, and pre-push.sh) — precisely the plan-1678 failure mode
// clean-git-env.mjs's own header warns about, where a hardening reaches one copy and not the rest.
// Case handling now lives in ONE place, so fixing it fixes every caller.
export const GIT_ENV_PREFIXES = ['GIT_'];

// THE composer every spawn seam uses. `layers` are merged over `process.env` in order (later
// wins, exactly as the hand-written spreads did), and the scrub runs on the RESULT.
//
// This exists so the ordering cannot be got wrong twice. Both earlier cuts of this plan were
// order bugs — scrub-at-caller, then scrub-as-base — and a third one hid for a whole round in
// `gitMain()`, whose `{ ...gitEnv(), ...extraEnv, … }` spread a scrubbed object and then layered
// on top of it, which is the base-scrub defect wearing a different shape. There is no way to
// express that mistake through this function: it takes the layers, not an assembled object.
//
// A `null`/`undefined` layer is skipped, so a caller with an optional layer (the identity
// fallback) can pass it directly instead of the `(x || {})` dance that made the bug hard to see.
export function spawnEnv(...layers) {
  return childEnv(Object.assign({}, process.env, ...layers.filter(Boolean)));
}

// For a child that must be blind to the AMBIENT repo: every inherited `GIT_*` dropped, then the
// caller's own explicit git settings applied on top.
//
// The after-the-strip ordering is REQUIRED, not an oversight: a setting the caller chooses is
// itself usually a `GIT_*` name (GIT_OPTIONAL_LOCKS), so applying it before the strip would erase
// it. That is the one place layering-after-a-scrub is correct, and it is safe for the reason the
// general case is not: `settings` are literal constants written at the call site, never inherited
// environment, so nothing unscrubbed can ride in on them. Naming it here keeps that reasoning in
// one place instead of leaving a bare `{ ...scrub(), GIT_X: … }` at each call site — a shape a
// reader cannot distinguish from the base-scrub defect this plan spent three rounds removing.
//
// This drops the WHOLE `GIT_*` namespace, transport and credential variables included
// (GIT_SSH_COMMAND, GIT_ASKPASS, GIT_HTTP_PROXY/GIT_HTTPS_PROXY, GIT_CONFIG_GLOBAL, the
// GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*/GIT_CONFIG_VALUE_* proxy-injection trio, …), so it is only
// correct for a child that does local, network-free git reads — its existing callers
// (lock-path.mjs, pass-cache-kernel.mjs) all are. A child that must also reach the NETWORK wants
// [[gitRepoIsolatedEnv]] instead, which drops only the vars that rebind which repository a git
// command acts on and leaves transport/credentials alone (gpt-review.mjs plan 3503 review round
// 3 — this function's blanket strip broke exactly that child; see GIT_REPO_SELECTOR_VARS below).
export function gitIsolatedEnv(settings = {}) {
  return Object.assign(childEnv(process.env, { prefixes: GIT_ENV_PREFIXES }), settings);
}

// The REPOSITORY-SELECTION set: the git env vars that answer "which repository, working tree,
// index file, or object database does this git command act on?" — as opposed to *how* it reaches
// a remote (transport: GIT_SSH_COMMAND, GIT_ASKPASS, GIT_HTTP_PROXY/GIT_HTTPS_PROXY) or *what
// config it layers in* (GIT_CONFIG_GLOBAL, the GIT_CONFIG_COUNT/GIT_CONFIG_KEY_*/
// GIT_CONFIG_VALUE_* trio a cloud drain uses to inject proxy settings), which are separate
// concerns entirely and are deliberately NOT members.
//
// MEMBERSHIP TEST for a future addition: does this variable change WHICH repository, working
// tree, index file, or object store a git command reads or writes — i.e. could an ambient value
// silently redirect a command away from the repo named on its command line? If yes, it belongs
// here. If it instead controls how git reaches a remote or which config it loads, it does not,
// no matter how git-internal it looks.
//
// Source: `git(1)` ENVIRONMENT VARIABLES, "Repository locations" (GIT_DIR, GIT_WORK_TREE,
// GIT_NAMESPACE, GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM, GIT_COMMON_DIR) plus
// the standalone entries for GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, and GIT_PREFIX — https://git-scm.com/docs/git#_environment_variables.
//
// Named here, not inline in gitRepoIsolatedEnv, so this comment's membership test and incident
// history survive independent of that function's own header (gpt-review.mjs plan 3503 review
// round 3, 2026-08-28): round 2 fixed a real bug — an ambient GIT_DIR could redirect a named-repo
// git child at the LAUNCHER's checkout — by routing that child through gitIsolatedEnv() above.
// But gitIsolatedEnv's blanket strip took GIT_HTTP_PROXY/GIT_CONFIG_* down with GIT_DIR, so on a
// checkout that gets its remote access through any of them, the landed-range guard's fetch
// FAILED — and that failure is deliberately non-fatal, so the guard silently fell back to a
// stale `origin/master` instead of erroring. Round 2 and round 3 were each right about their own
// half: the variable set that must be dropped to fix the round-2 bug is the repo-selection set,
// not the whole `GIT_*` namespace.
export const GIT_REPO_SELECTOR_VARS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_PREFIX',
]);

// For a child that must be blind to the AMBIENT repo while still reaching the NETWORK as this
// machine is normally configured to: drop only GIT_REPO_SELECTOR_VARS, then apply the caller's
// own explicit git settings on top — same after-the-strip ordering as gitIsolatedEnv above, and
// for the same reason (a caller setting is a literal constant written at the call site, never
// inherited environment, so applying it after the strip cannot reintroduce anything the strip
// removed).
//
// Use this, not gitIsolatedEnv, for a child that must push, pull, or fetch: gitIsolatedEnv's
// blanket `GIT_*` strip takes transport and credential-injection variables down along with the
// repo selectors (see GIT_REPO_SELECTOR_VARS above for the incident this fixes). gitIsolatedEnv
// stays correct — and unchanged — for its existing callers (lock-path.mjs, pass-cache-kernel.mjs):
// they do local, network-free git reads, where dropping transport variables costs nothing and
// narrowing the drop list would be unnecessary churn on code that isn't broken.
export function gitRepoIsolatedEnv(settings = {}) {
  return Object.assign(childEnv(process.env, { names: GIT_REPO_SELECTOR_VARS }), settings);
}

// The parent env as a child should see it. Pure — the spawn seams stay assertable without
// spawning anything.
//
// CHILD_ENV_STRIP is ALWAYS applied; `prefixes` and `names` are additive (prefix match vs exact
// name match — GIT_REPO_SELECTOR_VARS is an exact-name list, since a prefix match on it would
// also catch GIT_CONFIG_* names it must NOT touch). There is deliberately no way to opt out of
// the base list: a caller that could pass `strip: []` would be re-creating the leak this module
// exists to close, and "this particular child is harmless" is a judgement that rots the first
// time someone adds a hook-running spawn next to it.
//
// Prefer spawnEnv() at a spawn seam. This is the primitive underneath it, exported for the
// callers that need the prefix form (via gitIsolatedEnv) or the exact-name form (via
// gitRepoIsolatedEnv), and for the tests.
export function childEnv(parentEnv = process.env, { prefixes = [], names = [] } = {}) {
  const out = { ...parentEnv };
  const drop = new Set([...CHILD_ENV_STRIP, ...names].map((n) => n.toUpperCase()));
  const dropPrefixes = prefixes.map((p) => p.toUpperCase());
  for (const k of Object.keys(out)) {
    const K = k.toUpperCase();
    if (drop.has(K) || dropPrefixes.some((p) => K.startsWith(p))) delete out[k];
  }
  return out;
}
