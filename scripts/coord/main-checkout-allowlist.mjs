// scripts/coord/main-checkout-allowlist.mjs — single source of truth for "which paths
// may exist as direct edits on the shared MAIN checkout" (plan 977).
//
// Two harness layers consume this ONE constant (point 2 of plan 977: reuse the
// Tier-1 allowlist as the single shared constant — never re-roll a second copy):
//   - Tier 1 — scripts/hooks/main-checkout-clean-guard.sh (a PreToolUse
//     Edit|Write|MultiEdit guard) DENIES an edit to a non-allowlisted, non-ignored
//     path on the main checkout, forcing it into a worktree. Allowlisted paths
//     (doc + config) are let through; gitignored paths (.scratch/, output/) never
//     dirty the tree so they are let through too.
//   - Tier 2 — scripts/pre-yield-guard.mjs `commitSafe` mode (the Stop auto-park
//     hook) AUTO-COMMITS+PUSHES idle 'doc' dirt to master (the clean self-heal a
//     human would do), but only STASHES idle 'config'/code dirt.
//
// The three classes encode the operator decision (2026-06-22):
//   'doc'    — bookkeeping docs that already land straight to master and are SAFE
//              to auto-commit+push: plans, specs, batches, handoff, INDEX, wiki,
//              runbook PAGES (plan 2692 — `docs/runbooks/**.md` only: prose with (dangling-ok: classification glob, not a literal path)
//              no lock/race hazard, and a stale runbook actively misleads sessions
//              reading it as ground truth; the committed .sh under runbooks stays
//              'other', see the DOC_RX note).
//   'config' — harness config editable on master but NEVER auto-pushed by a
//              background hook (a half-edited settings.json / hook would break
//              every session): .claude/settings.json and settings.local.json. Tier 1
//              ALLOWS the edit; Tier 2 STASHES idle dirt rather than pushing it.
//              Plan 3765 RETIRED the `.claude/hooks/**` member: hook logic moved to
//              scripts/hooks/**, so a hook is now ordinary review-gated app source and
//              classifies 'other' — edited in a worktree like every other scripts/ module,
//              never directly on the shared main checkout.
//   'other'  — everything else (app code, arbitrary docs like docs/research/**,
//              CLAUDE.md, docs/runbooks/*.sh): Tier 1 DENIES on master, Tier 2 stashes. (dangling-ok: classification glob, not a literal path)
//
// Related but deliberately NOT identical to worktree-guard.sh's ALLOWED_RE, the
// PUSH-side allowlist: the two answer different questions and are not enforced equal by
// any test. Since plan 3765 NEITHER admits a hook: hook logic moved into scripts/hooks/,
// so it is ordinary review-gated app source on both axes — worktree-only to edit, and
// landed through the spine rather than hand-pushed. Keep the distinction in mind when
// changing either. Paths are matched repo-relative with forward slashes.

// 'doc' — commit-safe (auto-commit + push to master is allowed).
export const DOC_RX = [
  /^docs\/superpowers\/plans\//,
  /^docs\/superpowers\/specs\//,
  /^docs\/superpowers\/batches\//,
  /^docs\/handoff\//,
  // plan 2692: `.md` ONLY, not the whole prefix — docs/runbooks/ also holds a committed
  // EXECUTABLE (cloud-drain-setup-script.sh, plan 1728). The 'doc' bucket means "prose a
  // background Stop hook may auto-commit+push"; a half-edited shell script auto-pushed to
  // master is the exact hazard that keeps every executable out of this bucket. So the script stays
  // 'other' (worktree-only) while every runbook page is editable + commit-safe on master.
  /^docs\/runbooks\/.*\.md$/,
  /^docs\/INDEX\.md$/,
  /^wiki\//,
  /^WIKI\.md$/,
];

// settings.local.json: tracked-but-personal config that is BOTH editable on master
// (CONFIG_RX) and commit-safe (isCommitSafe) — plan 1108. Defined once so the two
// consumers can never drift apart.
export const SETTINGS_LOCAL_RX = /^\.claude\/settings\.local\.json$/;

// 'config' — editable on master. Stash-only when auto-parked by a hook, EXCEPT
// settings.local.json which is also commit-safe (see isCommitSafe).
export const CONFIG_RX = [/^\.claude\/settings\.json$/, SETTINGS_LOCAL_RX];

// Live pipeline artefacts belong to the job writing them, not to the session editor whose
// loose work the Stop hook protects. This classification is deliberately separate from the
// edit allowlist below: job output must stay forbidden to hand-edit on the shared main
// checkout even though the auto-park leaves it in place.
//
// Plan 3962 P1: this module is a PURE, ZERO-IMPORT leaf (Rule 3 — scripts/coord/** carries
// no project knowledge, and this leaf must not import coord-config.mjs either), so the
// prefix list itself is no longer a module-load constant here — it is project data that
// lives in coord.config.json's `jobOutputPrefixes` key (core default `[]`; the adopting
// project's own row names its real job-output directory). The CALLER resolves that list (via
// `loadCoordConfig(mainDir).jobOutputPrefixes`) and passes it into the three functions
// below, which derive classification and stash exclusions from the SAME list so the two can
// never drift apart — divergence would silently re-open the plan-3498 clobber by
// classifying output as protected while still stashing it.
const escapeRx = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function jobOutputRxFor(prefixes) {
  return prefixes.map((prefix) => new RegExp(`^${escapeRx(prefix)}`));
}
export function jobOutputStashExcludesFor(prefixes) {
  return prefixes.map((prefix) => `:(exclude)${prefix}`);
}

// Repo-relative, forward-slashed, no leading "./".
export function normalizeRel(p) {
  return String(p == null ? '' : p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

export function isJobOutput(relPath, prefixes) {
  const p = normalizeRel(relPath);
  return jobOutputRxFor(prefixes).some((rx) => rx.test(p));
}

// 'doc' | 'config' | 'other' for a repo-relative path.
export function classifyAllowlist(relPath) {
  const p = normalizeRel(relPath);
  if (DOC_RX.some((rx) => rx.test(p))) return 'doc';
  if (CONFIG_RX.some((rx) => rx.test(p))) return 'config';
  return 'other';
}

// Commit-safe: idle dirt the Tier-2 Stop auto-park hook may auto-commit + push to
// master (the clean self-heal a human does), vs merely stash. = the 'doc' bookkeeping
// set PLUS .claude/settings.local.json. The latter is tracked and the operator already
// commits it by hand (decision 2026-06-27, spec 2026-06-27-settings-local-autocommit-
// sweep-fix), so auto-committing idle changes to it is the same clean heal — it stops
// the recurring wip-stop-hook-* park pile-up. settings.json stays stash-only on purpose:
// a half-edited MAIN settings auto-pushed by a background Stop hook would break every
// session. Hooks reach the same outcome through 'other' since plan 3765.
export function isCommitSafe(relPath) {
  const p = normalizeRel(relPath);
  return DOC_RX.some((rx) => rx.test(p)) || SETTINGS_LOCAL_RX.test(p);
}

// Tier 1 gate: may this repo-relative path be EDITED directly on the main
// checkout? (doc + config are allowlisted; 'other' is not.)
export function isAllowlistedForMainEdit(relPath) {
  return classifyAllowlist(relPath) !== 'other';
}
