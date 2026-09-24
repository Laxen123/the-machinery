#!/usr/bin/env node
// scripts/edit-plan.mjs  (plan 533, Task 1)
// ONE-command edit of a plan BODY on master ($MAIN), committed + pushed atomically
// via coordWrite — no cp-to-master relocate, no deferrable gap.
//
// Why this exists: the "commit coordination-doc edits immediately" discipline used
// to depend on the agent hand-running a multi-step ritual — edit on the worktree
// branch is blocked by the check-coordination-branch pre-commit guard, which FORCES
// a `cp`-relocate of the plan body into the shared main checkout, and that relocate
// has a deferrable gap. Session 450 (plan 527) deferred that commit ~15 min; a
// parallel session then swept this session's entry into ITS coord commit
// (non-deterministic attribution). Every OTHER coord ritual is already one atomic
// command (claim-plan / move-plan / board / index / record-review / done-worktree).
// Plan-body editing during execution was the one that wasn't — so it's now this.
//
// The rule it enforces: coordination docs (`plans/**`, the INDEX generated region,
// `handoff-board.md`, `handoff/**`) are edited ON MASTER and committed in the SAME
// breath — never on a worktree branch. You call this from inside your worktree and it
// lands on master. Since plan 1286 the edit runs against the DISPOSABLE coord-checkout
// under the coord-write lock (withCoordCheckout, the plan-989 machinery) — never the
// shared MAIN checkout — so foreign dirt on MAIN can't refuse it and no retry ever
// moves MAIN's HEAD.
//
// Two edit modes (exactly one required):
//   --body <file>                replace the whole plan body with <file>'s content
//   --find <s> --replace <s>     single literal find→replace ([--all] for every hit)
//
// --find/--replace is idempotent against coordWrite's freshen-and-retry: it re-applies
// against the fresh base on EVERY mutate() attempt and no-ops once the find string is gone
// (coordWrite short-circuits an empty diff) — so it can never clobber a parallel session's
// edit; the worst case is a no-op "find string not found".
//
// --body is a FULL-FILE replace, which historically just rewrote the SAME fixed content on
// every coordWrite retry regardless of what changed on master underneath — a stale-base
// lost-update (plan 1642, proven 2026-07-09 on plan 1635: a --body replace authored against
// an old base silently REVERTED a parallel session's spec-pass stamps, because coordWrite's
// freshen-and-retry re-applies identical content and wins the race by construction no matter
// what changed). --body now carries a stale-base guard: a base fingerprint — REQUIRED as
// --base-sha <blob-sha> (plan 3244; the caller-supplied sha of the blob they actually READ and
// authored --body's content from) — is compared against master's CURRENT content on every
// mutate() attempt (not just the first). Plan 1642 review fix [A] originally let --base-sha be
// OMITTED and auto-captured the base from origin/master's CURRENT tip at INVOCATION time
// instead — but that base was captured seconds before the SAME-ref comparison it fed, so the
// two always matched trivially and the guard degenerated to a race check on the
// invocation→commit window: it caught nothing about whether the content --body was actually
// authored from was still current. Both measured incidents this guard exists to prevent (the
// 2026-08-12 plan-2339 sequential-edit content loss and the 2026-08-08 plan-2977 lane-move
// revert) happened WITH that auto-capture in place — plan 3244 retired it and made --base-sha
// mandatory instead (missingBaseShaRefusalMessage teaches the read-time-capture flow). A
// mismatch REFUSES loudly (staleBaseRefusalMessage, naming which frontmatter keys changed —
// stage/specReview called out as the worst-case clobber) instead of silently overwriting; the
// caller re-reads and re-authors, or switches to --find/--replace. Standalone from
// wiki-commit.mjs's plan-1622 guard for the identical class on wiki pages (car 2/plan 1641
// in the same batch train touched that file's guard
// functions): the two surfaces differ enough — wiki-commit batches N pages against a real
// git merge-base on a caller CHECKOUT with its own branch history; edit-plan edits exactly
// one plan body authored by an agent with no comparable git-history relationship to
// origin/master — to justify a separate, simpler implementation rather than forcing a
// shared abstraction onto a caller (mainDir, not a branched checkout) plan 1622 was never
// designed for.
//
// plan 3079: --body also carries a FRONTMATTER-DROP guard, orthogonal to the stale-base guard
// above (this one is a caller-authoring bug — an incoming --body file with no frontmatter
// fence — the stale-base guard covers a race instead). If the FRESH master content HAS a
// frontmatter fence and the incoming --body content has NONE, the write refuses loudly
// (frontmatterDropRefusalMessage, naming every key that would be lost) instead of silently
// de-stamping the plan (stage/execModel/specReview/cloudExec/evidence/summary/loop/priority —
// the exact 2026-08-09 incident this guard closes). `--allow-frontmatter-drop` is the explicit
// escape hatch when dropping the stamps is intentional.
//
// Usage:
//   node scripts/edit-plan.mjs <id|basename> --body .scratch/533-body.md --base-sha <sha>
//     [--allow-frontmatter-drop]
//   node scripts/edit-plan.mjs <id|basename> --find '- [ ] **T1**' --replace '- [x] **T1**'
//   node scripts/edit-plan.mjs <id|basename> --find OLD --replace NEW --all
//   [--message "<commit subject>"] [--dry] [--force] [--claimed-override "<reason>"]
//
// plan 3244: --base-sha is REQUIRED for --body (except under --dry, which skips the capture
// entirely — a --dry preview stays cheap and contention-free). Missing it exits 2 with
// missingBaseShaRefusalMessage, which is the SINGLE source for the read-time-capture
// procedure's wording — read it there rather than restating its steps here, since a second
// hand-kept copy is exactly what drifts out of sync with the message a caller actually reads.
//
// --force waives ONLY the plan-2378 axis-A refusal (adding a LIVE **Blocked-by:** line to
// a plan sitting in ready/ or in-progress/). The sanctioned alternative is almost always
// `node scripts/move-plan.mjs <id> waiting-blocked`, which files the plan where a live
// blocker belongs AND writes the header in the same commit. The stage/folder invariant is
// never waivable by --force.
//
// plan 2729: a plan whose refs/claims/<id> is held by ANOTHER session refuses to be
// edited (mirrors move-plan.mjs's plan-2082 claim-holder guard verbatim in predicate and
// failure handling — self-held and unheld proceed). The sanctioned ways through are
// sending the change to the executor (SendMessage/board), or `--claimed-override
// "<reason>"` — a REQUIRED reason, stamped into the coordWrite commit subject so an
// override always carries provenance. Deliberately NOT `--force` (unlike move-plan's bare
// override) — the operator wants a reason on record for this specific escape hatch.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveMain,
  coordWrite,
  withCoordCheckout,
  gitWithLockRetry,
  GIT_MAXBUFFER,
  parseFlags,
  ensureMvDestDir,
} from './coord/coord-git.mjs';
import { resolvePlanRel, lsPlans, statusOf, describeClaimHolder } from './coord/move-plan.mjs';
// plan 2729: the claimed-plan edit guard reads the claim through claim-plan's OWN
// planStatus (ref read + message parse + youAreHolder in one shared place) — the exact
// same source move-plan's claim-holder guard (plan 2082) reads, never a re-rolled copy.
import { planStatus } from './coord/claim-plan.mjs';
import { assertBoardInvariants } from './coord/board-write-gate.mjs';
import {
  parsePlanMeta,
  frontmatterEnd,
  claimedIdOfBasename,
  readFrontmatterScalar,
} from './coord/build-index-lib.mjs';
import { loadCoordConfig } from './coord/coord-config.mjs';
import {
  canRenameForStatus,
  stampedRelForExecModel,
  assertExecModelFilenameOk,
} from './coord/exec-model-stamp.mjs';
// plan 3341: the shared execModel enum — imported, never re-declared, so this file's
// validation can never drift from the CLI stamping tool's own vocabulary (which is
// exactly what happened before this plan: edit-plan had ZERO references to it and
// could write any string via --body/--find-replace).
import { VALID_EXEC_MODELS } from './stamp-exec-model.mjs';
import { coordinationSessionId } from './coord/coord-session-id.mjs';
// plan 3973 review fix (finding a369c3): the ONE authority for a claim ref's name — never a
// hand-built `refs/claims/<id>` string (the retired namespace; claims are branch-shaped under
// refs/heads/coord/claims/ since plan 3756).
import { claimRef } from './coord/coord-refs.mjs';

// Arg surface (via the shared coord-git parseFlags, plan 1769 — the F1 semantics this file
// pioneered now live there): a value-flag consumes its next token unconditionally (so
// `--replace --dry` correctly yields replace='--dry'); a boolean sets true; an unknown
// flag is a loud error (catches `--mesage` typos the generic parseArgs silently dropped).
// DELIBERATE strictness change vs the pre-1769 loop: a single-dash token (`-dry`, a typo
// for `--dry`) now ALSO refuses loudly — the old parser silently discarded it as an extra
// positional, so a typo'd dry-run flag ran a REAL edit. Pinned by test.
export function parseEditArgs(argv) {
  const { positionals, flags } = parseFlags(argv, {
    label: 'edit-plan',
    // `claimed-override` (plan 2729): the claim-holder guard's escape hatch — a REQUIRED
    // reason string, never a bare boolean, so it must be a value flag like --message.
    value: ['find', 'replace', 'body', 'message', 'base-sha', 'claimed-override', 'also'],
    // `force` (plan 2378): waives ONLY the axis-A live-Blocked-by write-time refusal.
    // `allow-frontmatter-drop` (plan 3079): waives ONLY the frontmatter-drop guard on
    // --body (a --body file with no frontmatter fence replacing a stamped master copy).
    // Must be declared here — parseFlags is a strict allowlist, so an undeclared flag
    // errors rather than being silently ignored (the same pinning that stopped a typo'd
    // --dry from running a REAL edit).
    boolean: ['all', 'dry', 'force', 'allow-frontmatter-drop'],
  });
  // extra positionals are ignored (the id is the only one)
  return { idOrName: positionals[0] ?? null, flags };
}

// Decide the edit mode from parsed flags. Exactly one of {--body} | {--find+--replace}
// must be present; throws (caller maps to exit 2) on none, both, or a half-specified
// find/replace. `--replace` may legitimately be an empty string (delete the match), so
// presence is tested with `!= null`, not truthiness; `--all` is a real boolean here.
export function selectMode(flags) {
  const hasBody = flags.body != null;
  const hasFind = flags.find != null;
  const hasReplace = flags.replace != null;
  // plan 3973 (T2): --also <path-or-id> applies the SAME --find/--replace to a second plan
  // inside the same coordWrite commit — a body replace is per-file content, so combining it
  // with a second TARGET plan is a usage error rather than a silent no-op on the second file.
  if (hasBody && flags.also != null)
    throw new Error(
      'edit-plan: --body cannot be combined with --also — a body replace is per-file content ' +
        '(there is no second file to replace it with). Use --find/--replace with --also, or ' +
        'edit the second plan with its own edit-plan call.',
    );
  if (hasBody && (hasFind || hasReplace))
    throw new Error('edit-plan: --body cannot be combined with --find/--replace');
  if (hasBody) return { mode: 'body', file: flags.body };
  if (hasFind || hasReplace) {
    if (!hasFind || !hasReplace)
      throw new Error('edit-plan: --find and --replace must be given together');
    return { mode: 'replace', find: flags.find, replace: flags.replace, all: flags.all === true };
  }
  throw new Error('edit-plan: need --body <file> OR --find <s> --replace <s>');
}

// plan 2729: --claimed-override "<reason>" footgun guard — mirrors move-plan's
// assertBlockedByOk shape for the identical parseFlags hazard (a value flag consumes its
// NEXT token unconditionally, so `--claimed-override --dry` would otherwise silently
// swallow --dry as the "reason"). Takes the whole `flags` object (not just the value) so
// a BARE trailing flag — `--claimed-override` as the last argv token, which parseFlags
// resolves to an explicit `undefined` value rather than an absent key — is distinguishable
// from the flag never being given at all (`flags['claimed-override']` reads `undefined`
// either way; `hasOwnProperty` does not). A flag genuinely absent is fine (nothing to
// override); present-but-empty or flag-shaped refuses loudly. Exported for the tests.
export function assertClaimedOverrideOk(flags) {
  if (!Object.prototype.hasOwnProperty.call(flags, 'claimed-override')) return; // not given
  const reason = flags['claimed-override'];
  if (!String(reason ?? '').trim())
    throw new Error('edit-plan: --claimed-override requires a non-empty "<reason>"');
  if (String(reason).startsWith('--'))
    throw new Error(
      `edit-plan: --claimed-override got "${reason}" — looks like a flag, not a reason. ` +
        'Quote the value: --claimed-override "<reason>"',
    );
}

// plan 3973 review fix (finding c8ff04): --also shares the identical parseFlags footgun as
// --claimed-override above — a BARE trailing `--also` (last argv token, nothing after it)
// resolves to an explicit `undefined` value rather than an absent key, and the downstream
// `alsoIdOrName != null` check then reads that as "flag not given" and silently skips the
// second plan entirely while the primary edit still commits and reports success. Same
// hasOwnProperty distinction as assertClaimedOverrideOk: a flag genuinely absent is fine
// (no --also requested); present-but-empty or flag-shaped refuses loudly instead of
// silently no-op'ing half the requested edit. Exported for the tests.
export function assertAlsoOk(flags) {
  if (!Object.prototype.hasOwnProperty.call(flags, 'also')) return; // not given
  const value = flags.also;
  if (!String(value ?? '').trim())
    throw new Error('edit-plan: --also requires a non-empty "<id|basename>"');
  if (String(value).startsWith('--'))
    throw new Error(
      `edit-plan: --also got "${value}" — looks like a flag, not a plan id/basename. ` +
        'Quote the value if needed: --also <id|basename>',
    );
}

// plan 2729: claimed-plan edit guard — the pure verdict half over claim-plan's
// planStatus result, mirroring move-plan.mjs's claimHolderError (plan 2082) VERBATIM in
// predicate and failure handling: unheld or self-held → proceed (null); a foreign hold, or
// a held ref whose claim message failed to parse (holder null, self-hold unprovable) →
// refuse. `selfIdKnown=false` (no coordination identity in the environment) cannot
// distinguish self from foreign, so it refuses CONSERVATIVELY, same as move-plan's guard.
// The ONLY divergence from move-plan's wording is the sanctioned way through: edit-plan
// names BOTH channels (send the change to the executor, or the reasoned override) and
// points at `--claimed-override "<reason>"`, never move-plan's bare `--force`.
export function editClaimHolderError(status, { basename, selfIdKnown = true } = {}) {
  if (!status?.held) return null; // unheld
  if (status.youAreHolder) return null; // self-held
  const who = describeClaimHolder(status);
  const unprovable = selfIdKnown
    ? ''
    : ' NOTE: this environment has no coordination session identity, so a self-held claim cannot ' +
      'be proven yours — if you are the holder, --claimed-override "<reason>" is the ' +
      'sanctioned way through.';
  return (
    `edit-plan: ${basename} is CLAIMED by ${who} — refusing to edit a plan another session ` +
    `is executing (plan 2729; ${claimRef(status.planId)}). Send the change to the ` +
    `executor instead (SendMessage or the board), or re-run with --claimed-override ` +
    `"<reason>" (the reason is stamped into the commit subject).${unprovable}`
  );
}

// Pure literal find→replace. String#replace with a STRING pattern hits only the first
// occurrence AND honours `$&`/`$1` in the replacement — so we pass a FUNCTION replacer
// (treated literally) for the first-only case, and split/join (fully literal) for --all.
export function applyFindReplace(content, find, replace, all) {
  if (find === '') throw new Error('edit-plan: --find must be a non-empty string');
  if (all) return content.split(find).join(replace);
  return content.includes(find) ? content.replace(find, () => replace) : content;
}

// plan 1642: stale-base guard helpers for --body. Minimal, single-line-scalar frontmatter
// diffing — reuses build-index-lib's frontmatterEnd (the one shared fence rule) rather than
// re-deriving it, but does NOT need full YAML fidelity (unquoteYaml etc.): this is diagnostic
// text for a refusal message, not a comparison input (the actual stale/fresh decision in
// mutate() below is a byte-exact full-content compare, never a frontmatter-only one — a body
// that changed OUTSIDE the frontmatter block, e.g. a checkbox tick, must still refuse).
function frontmatterMap(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  const end = frontmatterEnd(lines);
  const map = new Map();
  if (end === -1) return map;
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

// Every frontmatter key whose value differs between `baseContent` and `masterContent`
// (added, removed, or changed) — sorted for stable message text. `baseValue`/`masterValue`
// are `null` when the key is absent on that side (vs. present with an empty scalar).
export function diffFrontmatterKeys(baseContent, masterContent) {
  const baseMap = frontmatterMap(baseContent);
  const masterMap = frontmatterMap(masterContent);
  const keys = new Set([...baseMap.keys(), ...masterMap.keys()]);
  const diffs = [];
  for (const key of keys) {
    const baseValue = baseMap.has(key) ? baseMap.get(key) : null;
    const masterValue = masterMap.has(key) ? masterMap.get(key) : null;
    if (baseValue !== masterValue) diffs.push({ key, baseValue, masterValue });
  }
  return diffs.sort((x, y) => x.key.localeCompare(y.key));
}

// Frontmatter stamp keys whose clobber is the worst case this guard exists to prevent (the
// plan-1635 incident: a --body replace reverted a spec-pass's `stage`/`specReview` stamps) —
// called out on their own loud line, separate from any other (lower-stakes) frontmatter drift.
const LOUD_STAMP_KEYS = new Set(['stage', 'specReview']);

// The refusal thrown from mutate() when master's copy of the plan changed since the base the
// caller's --body content was authored against, AND the caller's content doesn't already
// match master (an idempotent re-run / already-applied edit) — see the module header comment
// for the full incident this closes. Not a caught error class: mutate()'s throw propagates
// straight out of coordWrite/withCoordCheckout to main()'s top-level catch, which prints
// `.message` and exits 1 — a loud, attributable refusal, never a silent clobber.
export function staleBaseRefusalMessage(basename, baseContent, masterContent) {
  const diffs = diffFrontmatterKeys(baseContent, masterContent);
  const loud = diffs.filter((d) => LOUD_STAMP_KEYS.has(d.key));
  const rest = diffs.filter((d) => !LOUD_STAMP_KEYS.has(d.key));
  const fmt = (d) => `${d.key}: ${d.baseValue ?? '(absent)'} → ${d.masterValue ?? '(absent)'}`;
  const lines = [];
  if (loud.length)
    lines.push(`  CLOBBER RISK — frontmatter stamp(s) changed: ${loud.map(fmt).join(', ')}`);
  if (rest.length) lines.push(`  other frontmatter changes: ${rest.map(fmt).join(', ')}`);
  if (!diffs.length)
    lines.push('  (no frontmatter-key changes detected — the body prose itself differs)');
  return (
    `edit-plan: refusing --body replace of ${basename} (plan 1642 stale-base guard) — ` +
    `master's copy changed since your base and your new content does not already match it. ` +
    `A --body replace is a full-file overwrite; coordWrite's freshen-and-retry would ` +
    `otherwise re-apply your STALE content over whatever landed on master since you read it, ` +
    `silently reverting it (the exact 2026-07-09 plan-1635 incident this guard exists to ` +
    `prevent).\n` +
    lines.join('\n') +
    `\nRe-read ${basename} from current origin/master, re-author --body from that fresh copy, ` +
    `or use --find/--replace instead (it re-applies against the fresh base on every retry and ` +
    `no-ops if its target text is already gone — safe by construction).`
  );
}

// plan 3079: does an incoming --body replace DROP frontmatter that the fresh master content
// currently has? True only when the body has NO frontmatter fence at all while master HAS
// one — a body that carries its OWN (possibly different) frontmatter block is a deliberate
// wholesale replace and is left alone (current contract unchanged, per the spec-pass). Reuses
// build-index-lib's frontmatterEnd — the one shared fence rule — rather than re-deriving it.
export function wouldDropFrontmatter(bodyContent, masterContent) {
  const bodyLines = String(bodyContent ?? '').split(/\r?\n/);
  const masterLines = String(masterContent ?? '').split(/\r?\n/);
  return frontmatterEnd(bodyLines) === -1 && frontmatterEnd(masterLines) !== -1;
}

// The refusal thrown from mutate() when wouldDropFrontmatter(bodyBytes, freshMasterContent) is
// true and the caller didn't pass --allow-frontmatter-drop — see the module header comment
// (plan 3079) for the full incident this closes. Names every frontmatter key `masterContent`
// currently carries (via the module-private frontmatterMap — no new parser), so the caller
// sees exactly what a blind --body replace would delete.
export function frontmatterDropRefusalMessage(basename, masterContent) {
  const keys = [...frontmatterMap(masterContent).keys()].sort();
  return (
    `edit-plan: refusing --body replace of ${basename} (plan 3079 frontmatter-drop guard) — ` +
    `the incoming --body file has no frontmatter fence, but master's current copy has one. ` +
    `A --body replace is a full-file overwrite, so this would silently DELETE every ` +
    `frontmatter stamp: ${keys.join(', ')}.\n` +
    `Add a frontmatter fence (---\\n...\\n---) to the top of your --body file carrying the ` +
    `keys you want to keep, or re-run with --allow-frontmatter-drop if dropping them is ` +
    `intentional.`
  );
}

// plan 3341: does the post-edit body's `execModel:` value survive validation against
// the shared VALID_EXEC_MODELS enum? Neither --body nor --find/--replace previously
// checked this at all — either mode can write ANY string into the frontmatter, so a
// typo (or a hand-authored lane nothing recognizes) would silently defeat the
// fail-closed lane resolver claim-plan-lib.mjs's resolveExecLane exists to be (that
// resolver THROWS on an unrecognized value rather than defaulting it to sonnet — an
// edit-plan write that skipped validation was the one path that could still hand it
// a bad value). Pure — exported for the test, mirroring the shape of this file's
// other refusal-message helpers (staleBaseRefusalMessage, frontmatterDropRefusalMessage)
// rather than inlining the string at the call site. An absent/blank value is fine
// (reads as sonnet, same default resolveExecLane documents) — only a NON-EMPTY,
// unrecognized value is refused.
export function invalidExecModelMessage(basename, value) {
  return (
    `edit-plan: refusing to write execModel: "${value}" to ${basename} — must be one of ` +
    `${VALID_EXEC_MODELS.join(' / ')} (or absent, which reads as sonnet). Likely a typo; fix ` +
    `the value, or if this is a genuinely new lane, teach it to stamp-exec-model.mjs's ` +
    `VALID_EXEC_MODELS first (plan 3341).`
  );
}

// plan 696 — would this body edit change the plan's GENERATED docs/INDEX.md bullet?
// The bullet is `- <marker> <summary> → `<status>/<basename>``; edit-plan never MOVES the
// file, so `status`/`basename` are fixed and only the `marker` (from the SEED-WRITE banner)
// or the `summary` (frontmatter, else the H1 fallback) can shift. We run the EXACT derivation
// build-index uses — parsePlanMeta — and compare the two fields it feeds renderBullet, NOT a
// looser frontmatter-only check, so the answer matches the rendered bullet (incl. the H1
// summary fallback for a frontmatter-less plan). INDEX resyncs iff the bullet's rendered text
// would actually change: a summary-frontmatter edit (the trap this plan closes), an H1 rewrite
// on a frontmatter-less plan, or a SEED-WRITE flip all return true; a no-op-for-the-bullet edit
// (a checkbox tick, a Status-line tweak) returns false and stays body-only. The caller MUST
// pass the seedLane from master's coord config (the SAME source the subprocess build-index in
// resyncIndex resolves) so the marker comparison agrees with the regenerated bullet.
export function indexBulletAffected(beforeBody, afterBody, { seedLane = true } = {}) {
  const a = parsePlanMeta(beforeBody, { seedLane });
  const b = parsePlanMeta(afterBody, { seedLane });
  return a.marker !== b.marker || a.summary !== b.summary;
}

// plan 3973 review fix (finding 928ae6, "writer-trace" b1bedd/29d432/f2d35a): the --find
// presence check, run identically for the primary plan and for --also's second plan — a
// shared function so the two call sites cannot drift into different wording or, worse,
// one of them silently skipping the check. `alsoTag` is the "(--also)" suffix the second
// plan's message carries so a scraped stderr always says WHICH plan the refusal is about.
export function requireFindPresent(basename, body, find, { alsoTag = '' } = {}) {
  if (body.includes(find)) return;
  throw new Error(
    `edit-plan: --find string not found in ${basename}${alsoTag} — nothing applied. ` +
      `(Check the find string; or, if you already applied this edit, that's expected.)`,
  );
}

// plan 3973 review fix (findings 29d432/f2d35a/b1bedd/928ae6): ONE per-plan finalize step —
// execModel validation + FABLE-/SOL- filename normalization + INDEX-bullet-affected check —
// applied identically to the primary plan's edit and to --also's second plan. Before this
// fix, --also's own path (main(), below) skipped both: a replacement could write an
// unrecognized `execModel:` value to the second plan (no VALID_EXEC_MODELS check) or leave
// its basename's FABLE-/SOL- marker stale against a changed execModel (no
// stampedRelForExecModel call) — the exact asymmetry the review flagged. Pure — throws on
// an invalid execModel, otherwise returns the rename/resync verdict for the caller's
// mutate()/relPaths wiring. `rel` must be the plan's CURRENT (pre-this-edit) path; `status`
// is derived from it (not passed in) so a caller can never accidentally judge renameability
// against the wrong plan's folder.
export function finalizeExecModelEdit(rel, beforeBody, afterBody, { seedLane = true } = {}) {
  const basename = rel.split('/').pop();
  const newExecModel = readFrontmatterScalar(afterBody, 'execModel').trim().toLowerCase();
  if (newExecModel && !VALID_EXEC_MODELS.includes(newExecModel)) {
    throw new Error(invalidExecModelMessage(basename, newExecModel));
  }
  const status = statusOf(rel);
  const stampedRel = canRenameForStatus(status) ? stampedRelForExecModel(rel, afterBody) : null;
  const renaming = Boolean(stampedRel);
  const finalRel = stampedRel || rel;
  const resyncsIndex = indexBulletAffected(beforeBody, afterBody, { seedLane });
  return { finalRel, renaming, resyncsIndex };
}

// plan 1398 (item 1): the pure self-heal decision, split out of mutate() so the sibling-vs-
// own-attempt logic is unit-testable without staging a real concurrent-session race.
// `movedRelThisLoop` is loop-local state (declared in the closure enclosing mutate(), reset
// only per invocation of the whole withCoordCheckout callback — NEVER module/global — so a
// retry within the SAME coordWrite call correctly remembers a prior successful `git mv`).
// `absPlanMissing` is the existsSync(absPlan) check at self-heal time (already inverted by
// the caller so this function reads naturally). Returns 'heal' (recreate rel from the
// pre-edit snapshot — a prior attempt in THIS loop moved it away, then failed a later step)
// or 'abort' (a sibling session's concurrent edit-plan/move-plan renamed or removed this same
// plan since coordWrite's freshen — resurrecting from our stale beforeBody would recreate a
// file the sibling already moved, or fork two divergent copies under different paths) or
// `null` when the file isn't actually missing (no self-heal decision needed).
export function decideSelfHeal(movedRelThisLoop, absPlanMissing) {
  if (!absPlanMissing) return null;
  return movedRelThisLoop ? 'heal' : 'abort';
}

// Regenerate docs/INDEX.md's generated bullet region by running the repo's CANONICAL
// generator — scripts/build-index.mjs — as a subprocess, pinned to the target checkout's own
// copy (NOT the worktree edit-plan was launched from). build-index derives its REPO_ROOT — and
// from it the git ls-files root, the readFile root, AND its loadCoordConfig/seedLane — from its
// OWN script path, so invoking the target dir's copy roots the ENTIRE regen there: it
// regenerates that checkout's INDEX from its plans with its seedLane, byte-identical to the
// `build-index --check` the land later runs (same script, same root, BY CONSTRUCTION), and
// reuses the canonical regen instead of re-implementing render/splice in-process. Since plan
// 1286 the target is the DISPOSABLE coord-checkout (freshly reset to origin/master), so the
// regen always reflects the true master tip. Runs INSIDE coordWrite's mutate, AFTER the freshen
// + the body write, so it reflects the fresh origin/master tip plus this edit on every retry;
// idempotent, so coordWrite's no-op short-circuit stages nothing when the INDEX is already
// current.
function resyncIndex(dir) {
  execFileSync('node', [join(dir, 'scripts', 'build-index.mjs')], {
    cwd: dir,
    stdio: 'inherit',
  });
}

// plan 3244: the message printed (exit 2) when --body is given with no --base-sha — the
// mandatory-flag refusal that replaced plan 1642 review fix [A]'s auto-capture (see the module
// header for the full incident history). Exported so the exact wording is unit-testable,
// mirroring staleBaseRefusalMessage/frontmatterDropRefusalMessage above. Pure — takes only the
// id/basename the caller typed, no filesystem or git reads, so it can fire BEFORE mainDir is
// even touched.
//
// Known residual (plan 3244 item 4, deliberately not chased further in this plan): a caller
// that runs `rev-parse` at WRITE time instead of at the moment they actually READ the plan
// recreates the auto-capture hole behaviorally — tooling has no way to see when the author
// truly read the content --body was composed from, so this wording ("the sha you authored
// from", read-time not write-time) is the mitigation, not a structural fix. Content heuristics
// (section-drop detection etc.) are explicitly out of scope here — plan-3079's frontmatter-drop
// guard already covers the worst structural clobber.
export function missingBaseShaRefusalMessage(idOrName) {
  return (
    `edit-plan: --body requires --base-sha <blob-sha> (plan 3244) — the auto-capture that used ` +
    `to fill this in resolved the base at INVOCATION time, seconds before the mutate()-time ` +
    `comparison it fed, so the two always matched trivially and the guard never caught a base ` +
    `that had already gone stale by the time you actually authored --body's content (the ` +
    `2026-08-12 plan-2339 and 2026-08-08 plan-2977 incidents — both happened WITH auto-capture ` +
    `in place).\n` +
    `What's needed is the sha you authored from, captured AT READ TIME, never recomputed later:\n` +
    `  1. Read the plan:              git show origin/master:<plan-path>\n` +
    `  2. Record its sha RIGHT THEN:  git rev-parse origin/master:<plan-path>\n` +
    `  3. Author --body's content from exactly that copy — nothing fresher.\n` +
    `  4. Pass the recorded sha:      --base-sha <sha-from-step-2>\n` +
    `Re-running rev-parse just before this command recreates the exact hole auto-capture had — ` +
    `the sha must be the one you actually read and authored --body from, not a fresh one taken ` +
    `at write time.\n` +
    `Resolve ${idOrName}'s current plan-path first if you don't already have it: ` +
    `git -C <mainDir> ls-tree -r --name-only origin/master -- docs/superpowers/plans | grep ${idOrName}`
  );
}

// plan 3973 (T2): the plan-2729 claim-holder guard, factored so `--also`'s second plan gets
// the SAME protection as the primary one instead of a hand-duplicated copy. `overrideReason`
// skips the check entirely for BOTH plans (mirrors the pre-3973 single-plan behavior — a
// caller who already asserted --claimed-override accepts the risk for whichever plan(s) this
// edit touches). Returns the refusal message string, or `null` when clear to proceed
// (unheld, self-held, or a transient read failure — fail-open, WARNing to stderr).
function claimGuardMessage(cdir, basenameX, { overrideReason, coordinationId }) {
  if (overrideReason) return null;
  const claimsId = claimedIdOfBasename(basenameX);
  if (!claimsId) return null;
  let status = null;
  let readOk = false;
  try {
    status = planStatus(cdir, claimsId, { selfId: coordinationId });
    readOk = true;
  } catch (e) {
    console.error(
      `edit-plan: WARN — claim-holder read failed for ${claimRef(claimsId)} ` +
        `(${(e.message || '').trim().slice(0, 200)}); proceeding unguarded.`,
    );
  }
  if (!readOk) return null;
  return editClaimHolderError(status, {
    basename: basenameX,
    selfIdKnown: Boolean(coordinationId),
  });
}

async function main() {
  let idOrName, flags;
  try {
    ({ idOrName, flags } = parseEditArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  const dry = flags.dry === true;
  if (!idOrName) {
    console.error(
      'usage: edit-plan.mjs <id|basename> (--body <file> --base-sha <sha> | --find <s> ' +
        '--replace <s> [--all] [--also <id|basename>]) [--message "<subj>"] [--dry] ' +
        '[--claimed-override "<reason>"]',
    );
    return 2;
  }

  let sel;
  try {
    sel = selectMode(flags);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  // plan 2729: validate the override reason BEFORE anything else looks at it — same
  // fail-fast-in-the-producer discipline as move-plan's --blocked-by footgun check.
  try {
    assertClaimedOverrideOk(flags);
    // plan 3973 review fix (finding c8ff04): same fail-fast-before-anything-else timing as
    // the override check above — a bare/flag-shaped --also must refuse before any coord
    // lock or plan resolution, never silently degrade to "no --also given".
    assertAlsoOk(flags);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const mainDir = resolveMain();

  // --body's source is an INDEPENDENT file (a scratch the caller wrote), not the plan
  // base — its bytes are read ONCE here, OUTSIDE the coord lock (the scratch lives in the
  // caller's checkout, not the coord-checkout), and replayed verbatim on every coordWrite
  // retry — GUARDED, since plan 1642, by baseContent below. (The --find/--replace path
  // below differs: it reads the FRESHENED plan inside writeBody each attempt, because its
  // transform depends on the base content, which is what already makes it stale-base-safe.)
  let bodyBytes = null;
  // plan 1642: the stale-base guard's reference point for --body — see the module header
  // comment. Captured ONCE here, OUTSIDE the coord lock, same timing as bodyBytes, so it
  // reflects "what the caller's checkout showed right as this command started" — NOT
  // master's live tip (that's read fresh inside mutate() below, on every retry).
  let baseContent = null;
  if (sel.mode === 'body') {
    const bodyAbs = join(mainDir, sel.file);
    const srcPath = existsSync(sel.file) ? sel.file : existsSync(bodyAbs) ? bodyAbs : null;
    if (!srcPath) {
      console.error(`edit-plan: --body file not found: ${sel.file}`);
      return 2;
    }
    bodyBytes = readFileSync(srcPath, 'utf8');

    // plan 1642 review fix [E] / plan 3244: the capture below is ONLY consumed inside the real
    // coordWrite mutate() path further down — the `dry` branch (next block) returns before ever
    // reaching it. Skip the whole --base-sha requirement + resolve when `dry` is true, so "a
    // --dry must stay cheap and contention-free" (see the dry branch's own comment) actually
    // holds for --body too, instead of paying for a git subprocess whose result is immediately
    // discarded — and a --dry preview never refuses over a flag it never needed.
    if (!dry) {
      const baseSha = flags['base-sha'];
      // plan 3244: --base-sha is now REQUIRED — the auto-capture fallback that used to fill
      // this in (plan 1642 review fix [A]) is retired; see the module header for why it never
      // actually protected anything. Refuse HERE, before withCoordCheckout is ever entered —
      // exit 2, no coord lock taken, no plan-2729 claim check run on an edit that can never
      // proceed.
      if (!baseSha) {
        console.error(missingBaseShaRefusalMessage(idOrName));
        return 2;
      }
      // The caller asserts they authored --body's content against THIS blob — resolved via
      // `git -C <mainDir> rev-parse origin/master:<path>` AT READ TIME (see
      // missingBaseShaRefusalMessage). `git cat-file -p` reads it straight from the object
      // store — works regardless of whether that sha is reachable from any live ref right now,
      // as long as it's still in this repo's local object database (the ordinary case: it was
      // origin/master or an ancestor recently).
      try {
        baseContent = execFileSync('git', ['-C', mainDir, 'cat-file', '-p', baseSha], {
          encoding: 'utf8',
          maxBuffer: GIT_MAXBUFFER, // plan 1642 review fix [D]: match every other blob-read call site
        });
      } catch (e) {
        console.error(
          `edit-plan: --base-sha ${baseSha} did not resolve to a readable blob in ${mainDir} ` +
            `— check the sha (it must be a BLOB sha still in this repo's local object store, ` +
            `e.g. from \`git rev-parse origin/master:<plan-path>\`). ${e.message}`,
        );
        return 2;
      }
    }
  }

  if (dry) {
    // Dry preview resolves against the caller's MAIN checkout (no lock, no coord-checkout):
    // close enough for a preview, and a --dry must stay cheap and contention-free.
    let rel;
    try {
      rel = resolvePlanRel(lsPlans(mainDir), idOrName);
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    const message = flags.message || `docs(plans): edit ${rel.split('/').pop()}`;
    console.log(`[dry] edit ${rel} (${sel.mode}) → commit "${message}" + push via coordWrite`);
    return 0;
  }

  // Resolve before entering the mutating coord checkout, including claimed-override.
  // Ambiguity must not be caught as a remote-read failure and allowed through.
  let coordinationId;
  try {
    coordinationId = coordinationSessionId();
  } catch (e) {
    console.error(`edit-plan: ${e.message}`);
    return 2;
  }

  // plan 1286: the whole edit — plan resolution, body read, INDEX-resync decision, coordWrite —
  // runs against the DISPOSABLE coord-checkout (freshly reset to origin/master) under the
  // coord-write lock, never the shared MAIN checkout. So a sibling's uncommitted dirt on MAIN
  // (or our own) can never refuse the edit, and no retry ever rebases/moves MAIN's HEAD.
  // Resolving the plan INSIDE the checkout also means we resolve against the TRUE master state
  // (a sibling may have moved/archived the plan since MAIN last fast-forwarded).
  return withCoordCheckout(
    mainDir,
    // plan 2393 lever 1: `lockCtx` lets coordWrite release the coord lock after its commit, so the
    // push + verify leave the critical section. Safe here — coordWrite is the last mutation of the
    // coord-checkout in this callback (only the console summary follows).
    (cdir, lockCtx) => {
      let rel;
      try {
        rel = resolvePlanRel(lsPlans(cdir), idOrName);
      } catch (e) {
        console.error(e.message);
        return 2;
      }
      const basename = rel.split('/').pop();
      const absPlan = join(cdir, rel);

      // plan 2729: claimed-plan edit guard — refuse to mutate a plan whose
      // refs/claims/<id> is held by ANOTHER session (see editClaimHolderError above for
      // the full rationale: the 2026-08-02 plan-2724 incident). Runs ONCE per invocation,
      // here — after plan resolution and BEFORE either edit-mode path below, NOT inside
      // mutate() (coordWrite's internal push-race retry loop) — matching move-plan's
      // "one check per invocation, planStatus does its own remote read" discipline.
      // `--claimed-override "<reason>"` (already validated above) skips the check
      // entirely, mirroring move-plan's `--force` — its reason is stamped into the
      // commit subject below regardless of what the guard would have found. A transient
      // claim-read failure WARNS and proceeds unguarded (fail-open, same as move-plan) —
      // this guard is coordination defense-in-depth, not the sole line of defense.
      const overrideReason = flags['claimed-override'];
      {
        const err = claimGuardMessage(cdir, basename, { overrideReason, coordinationId });
        if (err) {
          console.error(err);
          return 2;
        }
      }

      // plan 3973 (T2): --also <id|basename> — resolve the SECOND plan this edit applies the
      // same --find/--replace to, guarded exactly like the primary (claim-holder check),
      // BEFORE either plan's body is touched. selectMode already refused --body + --also, so
      // sel.mode === 'replace' here whenever alsoIdOrName is set.
      const alsoIdOrName = flags.also;
      let alsoRel = null;
      let alsoBasename = null;
      let absAlso = null;
      if (alsoIdOrName != null) {
        try {
          alsoRel = resolvePlanRel(lsPlans(cdir), alsoIdOrName);
        } catch (e) {
          console.error(e.message);
          return 2;
        }
        if (alsoRel === rel) {
          console.error(`edit-plan: --also "${alsoIdOrName}" resolves to the SAME plan (${rel})`);
          return 2;
        }
        alsoBasename = alsoRel.split('/').pop();
        absAlso = join(cdir, alsoRel);
        const err = claimGuardMessage(cdir, alsoBasename, { overrideReason, coordinationId });
        if (err) {
          console.error(err);
          return 2;
        }
      }

      // Read the current body ONCE: it is both the replace-mode find-presence check AND the
      // baseline `afterBody` is compared against to decide whether the INDEX bullet resyncs.
      const beforeBody = readFileSync(absPlan, 'utf8');
      let afterBody; // the body this edit yields — compared to beforeBody to decide INDEX resync
      if (sel.mode === 'body') {
        afterBody = bodyBytes;
      } else {
        // Find-absent is ambiguous — it could be a wrong find string OR an already-applied
        // re-run. A coordination tool must NEVER report success without actually applying an
        // edit, so we fail loud (exit 2) rather than guess "already done" from a coincidental
        // --replace substring (the silent-no-apply hazard the reviewers flagged). The message
        // names both causes so a genuine re-run isn't alarming.
        try {
          requireFindPresent(basename, beforeBody, sel.find);
        } catch (e) {
          console.error(e.message);
          return 2;
        }
        afterBody = applyFindReplace(beforeBody, sel.find, sel.replace, sel.all);
      }

      const { seedLane } = loadCoordConfig(cdir);

      // plan 696: if this edit changes the plan's generated INDEX bullet (its `summary:`
      // frontmatter or SEED-WRITE marker), resync docs/INDEX.md in the SAME coordWrite, so the
      // commit can never leave INDEX STALE against the new body — the trap that stalled the
      // 676/686 lands at the pre-push `build-index --check` and forced a manual heal mid-land.
      // Co-committed via Mechanism 2 (one coordWrite over [plan, INDEX], like move-plan), so
      // there is no body-updated-but-INDEX-stale window. A no-op-for-the-bullet edit (checkbox
      // tick, Status-line tweak) stays body-only, exactly as before this plan.
      //
      // The resync decision is computed ONCE here, pre-freshen, and fixes relPaths for the whole
      // coordWrite (relPaths can't change across its non-ff retries). That is safe because a plan
      // is SINGLE-OWNER while claimed: the ref-CAS claim (refs/claims/<id>) means only its holder
      // edits this plan's body — no longer a bare assumption (the 2026-08-02 plan-2724 incident
      // was exactly a coordinator editing a claimed plan out from under its executor), but an
      // ENFORCED invariant as of plan 2729's claimed-plan edit guard above: an edit from anyone
      // but the holder refuses before this point is ever reached, unless the caller explicitly
      // overrides with --claimed-override. So no sibling can change its summary/marker between
      // this read and a retry's freshen — the one scenario where a freshened body could differ
      // from `afterBody` and flip the answer. (build-index regenerates the WHOLE region from the
      // freshened tip each retry, so the INDEX content is always correct against the fresh base;
      // only the include-or-not decision is pinned, and single-ownership pins it correctly.)
      //
      // plan 1362 (D2; generalized to `sol` by plan 3341): auto-stamp the FABLE-/SOL-
      // filename segment when THIS edit's resulting body carries a segment-bearing
      // execModel and the current basename doesn't already have the matching one —
      // never for in-progress/archive (canRenameForStatus mirrors stamp-exec-model.mjs's
      // restriction: the basename is worktree-coupled / the plan is closed there). Computed
      // once here (same single-ownership argument as above), so it's stable across every
      // coordWrite retry. plan 3341: refuse an execModel write the shared enum doesn't
      // recognize BEFORE any git mutation happens, so a bad value never reaches
      // origin/master. Both checks now live in finalizeExecModelEdit (plan 3973 review fix,
      // findings 29d432/f2d35a/b1bedd/928ae6) so the primary plan and --also's second plan
      // get IDENTICAL treatment — see that function's header for the asymmetry it closes.
      let primaryFinal;
      try {
        primaryFinal = finalizeExecModelEdit(rel, beforeBody, afterBody, { seedLane });
      } catch (e) {
        console.error(e.message);
        return 2;
      }
      const { finalRel, renaming, resyncsIndex } = primaryFinal;

      // plan 3973 (T2): the --also plan's own find-presence check + post-edit body, run
      // through the SAME finalizeExecModelEdit pipeline as the primary — no --body mode
      // (selectMode already refuses --body + --also), but otherwise identical treatment:
      // execModel validation, FABLE-/SOL- rename normalization, INDEX-bullet-affected check.
      let alsoBeforeBody = null;
      let alsoAfterBody = null;
      let alsoFinalRel = null;
      let alsoRenaming = false;
      let alsoResyncsIndex = false;
      if (alsoRel) {
        alsoBeforeBody = readFileSync(absAlso, 'utf8');
        try {
          requireFindPresent(alsoBasename, alsoBeforeBody, sel.find, { alsoTag: ' (--also)' });
        } catch (e) {
          console.error(e.message);
          return 2;
        }
        alsoAfterBody = applyFindReplace(alsoBeforeBody, sel.find, sel.replace, sel.all);
        let alsoFinal;
        try {
          alsoFinal = finalizeExecModelEdit(alsoRel, alsoBeforeBody, alsoAfterBody, { seedLane });
        } catch (e) {
          console.error(e.message);
          return 2;
        }
        alsoFinalRel = alsoFinal.finalRel;
        alsoRenaming = alsoFinal.renaming;
        alsoResyncsIndex = alsoFinal.resyncsIndex;
      }

      // A rename always changes the bullet's basename → always resyncs INDEX too.
      const indexWillResync = resyncsIndex || renaming || alsoResyncsIndex || alsoRenaming;
      const relPaths = [
        ...(renaming ? [rel, finalRel] : [rel]),
        ...(alsoRel ? (alsoRenaming ? [alsoRel, alsoFinalRel] : [alsoRel]) : []),
        ...(indexWillResync ? ['docs/INDEX.md'] : []),
      ];
      const absFinal = renaming ? join(cdir, finalRel) : absPlan;
      const absAlsoFinal = alsoRenaming ? join(cdir, alsoFinalRel) : absAlso;

      // plan 1398 (item 1): loop-local sentinel — NOT a HEAD-oid comparison. Tracks
      // whether THIS invocation's `git mv` has already succeeded at least once, so the
      // self-heal below can tell "my own failed prior attempt in this same retry loop
      // left rel missing" (heal) apart from "a SIBLING session's concurrent edit-plan/
      // move-plan renamed or removed this same plan between coordWrite's freshen and now"
      // (do NOT heal — resurrecting from our stale beforeBody would recreate a file the
      // sibling already moved, or fork two divergent copies under different paths).
      let movedRelThisLoop = false;
      // plan 3973 review fix (findings f2d35a/928ae6): the --also plan's own rename-loop
      // sentinel, mirroring `movedRelThisLoop` above — needed now that --also can trigger a
      // FABLE-/SOL- rename via finalizeExecModelEdit too.
      let alsoMovedRelThisLoop = false;

      const mutate = () => {
        // plan 1642 review fix [B]: decide (and, if needed, perform) any SELF-HEAL before the
        // stale-base check below — a self-heal must recreate absPlan's on-disk content before
        // there's anything for the check to read — but defer the actual RENAME (`git mv`)
        // until AFTER the check has had a chance to throw. Pre-fix, the rename ran
        // UNCONDITIONALLY here and the stale-base check ran only afterward (reading the
        // POST-rename path); a refusal then left `cdir` with an uncommitted `git mv` that
        // nothing rolls back (coordWrite's throw-path has no catch/rollback for a mutate()
        // throw — only a push-rejection retry reverts relPaths) — self-healing only via the
        // NEXT invocation's `resolveCoordCheckout` hard-reset, which never runs under the
        // COORD_MAIN_DIR short-circuit (done-worktree's detached finish worktree).
        if (renaming) {
          // Self-heal (see scripts/coord/exec-model-stamp.mjs header): coordWrite's generic
          // revertPathsToHead cannot undo a rename — finalRel is never at HEAD, so its
          // combined `restore --source=HEAD` call fails wholesale and rel's WORKING TREE
          // copy is never recreated (only its index entry gets unstaged). decideSelfHeal
          // (plan 1398) distinguishes "my own failed prior attempt in this same retry loop
          // left rel missing" (heal — recreate from the untouched pre-edit snapshot) from
          // "a sibling session's concurrent edit-plan/move-plan renamed or removed this same
          // plan since coordWrite's freshen" (abort loud — never resurrect a file a sibling
          // already moved).
          const heal = decideSelfHeal(movedRelThisLoop, !existsSync(absPlan));
          if (heal === 'abort') {
            throw new Error(
              `edit-plan: ${basename} vanished — moved/renamed by a concurrent session; ` +
                're-run edit-plan to re-resolve.',
            );
          }
          if (heal === 'heal') writeFileSync(absPlan, beforeBody);
        }
        // plan 3973 review fix: the SAME self-heal safety net for --also's rename — a
        // non-ff retry that already git-mv'd alsoRel in a prior loop attempt must recreate
        // it before this attempt's own git mv, exactly like the primary above.
        if (alsoRenaming) {
          const heal = decideSelfHeal(alsoMovedRelThisLoop, !existsSync(absAlso));
          if (heal === 'abort') {
            throw new Error(
              `edit-plan: ${alsoBasename} (--also) vanished — moved/renamed by a concurrent ` +
                'session; re-run edit-plan to re-resolve.',
            );
          }
          if (heal === 'heal') writeFileSync(absAlso, alsoBeforeBody);
        }
        if (sel.mode === 'body') {
          // plan 1642: stale-base guard — now checked BEFORE any rename (review fix [B]), read
          // from `absPlan` (the PRE-rename path — `git mv` never touches file BYTES, so this is
          // content-identical to reading `absFinal` after the mv, and `absPlan` is guaranteed to
          // exist here: either it always did, or the self-heal above just recreated it — the
          // 'abort' case already threw). Read FRESH on every mutate() call — i.e. once per
          // coordWrite attempt/retry, never memoized — so a sibling's write landing DURING this
          // invocation's retry window is caught exactly like one that landed before this
          // invocation even started. Compares against `bodyBytes` too so an idempotent re-run
          // (content already matches master) is never mistaken for a conflict; coordWrite's own
          // diff-cached check turns that into a clean no-op below.
          const freshContent = readFileSync(absPlan, 'utf8');
          if (freshContent !== baseContent && freshContent !== bodyBytes) {
            throw new Error(staleBaseRefusalMessage(basename, baseContent, freshContent));
          }
          // plan 3079: frontmatter-drop guard — INDEPENDENT of the stale-base compare above
          // (that one is a race, this one is a caller-authoring bug: a --body file with no
          // frontmatter fence at all). Judged against `freshContent` (fresh MASTER, just read
          // above — same read, every mutate() attempt) rather than `baseContent`
          // (invocation-time base): another session can stamp frontmatter between coordWrite
          // retries, and the refusal must protect what would ACTUALLY be clobbered on this
          // attempt, not what was true when this command started.
          if (!flags['allow-frontmatter-drop'] && wouldDropFrontmatter(bodyBytes, freshContent)) {
            throw new Error(frontmatterDropRefusalMessage(basename, freshContent));
          }
        }
        if (renaming) {
          // `git mv` (not a plain fs rename) so `git ls-files` — what resyncIndex's spawned
          // build-index reads — reflects the new path immediately, before this attempt's
          // `git add`. Runs only now — AFTER the stale-base check above had its chance to
          // throw — so a refusal never leaves `cdir` with an uncommitted rename.
          ensureMvDestDir(cdir, finalRel);
          gitWithLockRetry(cdir, ['mv', rel, finalRel]);
          movedRelThisLoop = true;
        }
        // plan 3973 review fix: the --also plan's own rename, run the same way and at the
        // same point in the sequence as the primary's above.
        //
        // Round-2 review fix (finding e5ce1e): the two renames are ONE transaction, not two
        // independent operations — if THIS `git mv` throws (its most likely cause: the
        // destination basename already exists), the PRIMARY rename just above has already
        // succeeded, and nothing downstream would ever undo it: mutate() has no enclosing
        // catch here (only the assertBoardInvariants catch further below rolls anything
        // back, and a throw here never reaches it), so a bare rethrow would strand the
        // primary plan at its NEW name while --also's own plan never moved at all — exactly
        // the half-applied-rename state the plan-486 discipline exists to prevent. Reverse
        // the primary's `git mv` (best-effort, mirroring the assertBoardInvariants catch's
        // own rollback style below) before rethrowing. `movedRelThisLoop` is reset to false
        // on a successful reversal so a re-entrant mutate() (a non-ff retry) applies the
        // pair fresh rather than reading a stale "already moved" sentinel.
        if (alsoRenaming) {
          try {
            ensureMvDestDir(cdir, alsoFinalRel);
            gitWithLockRetry(cdir, ['mv', alsoRel, alsoFinalRel]);
            alsoMovedRelThisLoop = true;
          } catch (e) {
            if (movedRelThisLoop) {
              try {
                ensureMvDestDir(cdir, rel);
                gitWithLockRetry(cdir, ['mv', finalRel, rel]);
                movedRelThisLoop = false;
              } catch {
                /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
              }
            }
            throw e;
          }
        }
        // plan 2378 step 2 / plan 3973 round-3 review fix (findings 615a49/afc5c1/a47216):
        // EVERYTHING from here through assertBoardInvariants runs inside ONE try, because
        // any of it can throw AFTER both renames have already succeeded above (the write
        // itself, the --also filename/execModel check, the INDEX resync, the un-stage
        // resets, or the board-invariant check board-write-gate runs at the very end) —
        // not just assertBoardInvariants, which is the only step the pre-fix catch here
        // covered. coordWrite invokes mutate() with NO enclosing try/catch, so a bare
        // throw from any of these would leave `rel` gone from disk and `finalRel` (and,
        // when --also renamed too, `alsoRel`/`alsoFinalRel`) holding the new content, both
        // uncommitted. On the standalone path the next coord op's resolveCoordCheckout
        // hard-reset repairs that; under COORD_MAIN_DIR (done-worktree's detached finish
        // worktree) withCoordCheckout short-circuits to `fn(mainDir)` with no reset, so
        // nothing ever heals it — the catch below (round-4 review fix, findings f7556a/
        // 510106) now restores BYTES too, not just paths, since that "next op heals it"
        // premise never holds under COORD_MAIN_DIR and even on the standalone path only
        // holds for a LATER, separate invocation — never this one.
        let indexBeforeResync = null; // snapshot right before resyncIndex; restored in the catch
        try {
          // plan 3973 review fix (round 4, finding 2286b7): a test-only, env-gated failure
          // injection point — mirrors done-worktree.mjs's DW_TEST_THROW convention — so
          // edit-plan.test.mjs can exercise "a write failure AFTER both renames succeed"
          // deterministically on every platform instead of relying on a chmod-read-only trick
          // (ambient filesystem permission enforcement differs by platform; the repo rule
          // requires the environment be a parameter, not assumed). No-op outside tests.
          if (process.env.EDIT_PLAN_TEST_THROW === 'after-rename')
            throw new Error('EDIT_PLAN_TEST_THROW after-rename injected');
          // plan 3973 review fix (round 4, finding de5c83): with --also, this whole block
          // reruns fresh on every mutate() attempt/retry, including the find/replace itself —
          // which silently no-ops for a plan whose find text is already gone, safe-by-
          // construction for an idempotent single-plan re-run (see this module's header). But
          // if only ONE of the two plans' find text vanished by this attempt (the other still
          // has it) — a concurrent session's own edit, not our own re-run — applying anyway
          // would commit half the requested multi-plan edit while silently skipping the other.
          // Refuse that asymmetric case loud; both-gone (a genuine idempotent re-run of the
          // pair) still no-ops quietly, same as a single plan always has.
          if (alsoRel) {
            const primaryHasFind = readFileSync(absFinal, 'utf8').includes(sel.find);
            const alsoHasFind = readFileSync(absAlsoFinal, 'utf8').includes(sel.find);
            if (primaryHasFind !== alsoHasFind) {
              throw new Error(
                `edit-plan: refusing --also edit of ${basename} + ${alsoBasename} — --find is ` +
                  `present in only one of the two plans as of this retry (a concurrent session ` +
                  `likely changed the other since coordWrite's last freshen). Re-run edit-plan ` +
                  `to re-resolve against current content rather than committing half the ` +
                  `requested multi-plan edit.`,
              );
            }
          }
          if (sel.mode === 'body') {
            writeFileSync(absFinal, bodyBytes);
          } else {
            writeFileSync(
              absFinal,
              applyFindReplace(readFileSync(absFinal, 'utf8'), sel.find, sel.replace, sel.all),
            );
          }
          // plan 3973 (T2): the --also plan's own write — re-applied against ITS fresh base on
          // every mutate() attempt, same idempotent-against-retry shape as the primary
          // find/replace write just above (never a --body mode). Targets `absAlsoFinal` (the
          // POST-rename path when alsoRenaming, else identical to absAlso) — plan 3973 review
          // fix — same reasoning as the primary's `absFinal` above: `git mv` never changes the
          // bytes, so reading/writing the post-rename path here is content-identical.
          if (alsoRel) {
            writeFileSync(
              absAlsoFinal,
              applyFindReplace(readFileSync(absAlsoFinal, 'utf8'), sel.find, sel.replace, sel.all),
            );
          }
          if (renaming) assertExecModelFilenameOk(finalRel, readFileSync(absFinal, 'utf8'));
          // plan 3973 review fix: the same filename/execModel agreement check for --also's
          // rename — a plan whose basename carries a FABLE-/SOL- marker that disagrees with
          // its frontmatter is exactly the drift lint-filename-execmodel-drift.mjs polices.
          if (alsoRenaming)
            assertExecModelFilenameOk(alsoFinalRel, readFileSync(absAlsoFinal, 'utf8'));
          if (indexWillResync) {
            indexBeforeResync = readFileSync(join(cdir, 'docs/INDEX.md'), 'utf8');
            resyncIndex(cdir);
          }
          if (renaming) {
            // coordWrite's OWN subsequent `git add -- relPaths` (called right after mutate()
            // returns) still names `rel` — and by now `git mv` has fully removed it from the
            // INDEX too (not just the working tree), so it matches NOTHING and a plain
            // `git add -- rel` would hard-fail ("pathspec did not match any files"). This is
            // exactly what move-plan.mjs avoids by never re-`add`ing its own oldRel. Un-stage
            // JUST rel's removal (restore its ORIGINAL HEAD blob into the index) while leaving
            // it physically absent from disk — turning it back into an ordinary tracked-but-
            // deleted path, which `git add` handles like any other pending deletion. MUST run
            // AFTER resyncIndex (which needs `git ls-files` to already reflect the rename).
            gitWithLockRetry(cdir, ['reset', '-q', '--', rel]);
          }
          // plan 3973 review fix: the same un-stage-the-old-path step for --also's rename.
          if (alsoRenaming) gitWithLockRetry(cdir, ['reset', '-q', '--', alsoRel]);
          // plan 2378 step 2: board invariants are checked HERE — the last statement of
          // mutate(), against the post-mutation tree — because the push coordWrite is about
          // to make runs no git hooks (mechanism in board-write-gate.mjs's header). Throwing
          // from mutate() propagates straight out of coordWrite BEFORE its `git add`/commit/
          // push, so a violating edit never reaches origin/master. Scoped to the plan file
          // this edit touches; a pre-existing violation elsewhere never blocks you.
          //
          // `--force` waives ONLY the axis-A live-Blocked-by refusal (this is the authoring
          // moment for that misfile: 2358 and 2367 both acquired their Blocked-by line via
          // exactly this path, in place, with the folder left alone). The stage/folder
          // invariant is never waivable — routing a specced plan out is a one-command fix.
          assertBoardInvariants(cdir, relPaths, {
            tool: 'edit-plan',
            allowLiveBlockedBy: !!flags.force,
          });
        } catch (e) {
          if (movedRelThisLoop) {
            try {
              // `git mv` back: reverses both the working-tree move and the staged rename.
              // Best-effort — a failure here must never mask the refusal being reported.
              ensureMvDestDir(cdir, rel);
              gitWithLockRetry(cdir, ['mv', finalRel, rel]);
              movedRelThisLoop = false;
            } catch {
              /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
            }
          }
          // plan 3973 review fix: the same best-effort rollback for --also's rename.
          if (alsoMovedRelThisLoop) {
            try {
              ensureMvDestDir(cdir, alsoRel);
              gitWithLockRetry(cdir, ['mv', alsoFinalRel, alsoRel]);
              alsoMovedRelThisLoop = false;
            } catch {
              /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
            }
          }
          // plan 3973 review fix (round 4, findings f7556a/510106): restore BYTES too, not
          // just paths. Under COORD_MAIN_DIR (done-worktree's detached finish worktree)
          // withCoordCheckout short-circuits straight to `fn(mainDir, NO_COORD_LOCK)`
          // (coord-git.mjs) with NO resolveCoordCheckout hard-reset — and even on the
          // standalone path, that reset only runs on the NEXT separate coord op, not this
          // one — so this catch is the only thing that can undo a write THIS attempt already
          // made before throwing. Left uncleaned, the replacement bytes or a stale INDEX.md
          // would sit as uncommitted dirt a LATER, unrelated coord write sharing this checkout
          // could pick up and commit under its own message. Targets whichever path the file
          // actually sits at after the rename-reversal above succeeded or failed. Best-effort,
          // mirroring that reversal — a failure here must never mask the refusal being
          // reported.
          try {
            writeFileSync(movedRelThisLoop ? absFinal : absPlan, beforeBody);
          } catch {
            /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
          }
          if (alsoRel) {
            try {
              writeFileSync(alsoMovedRelThisLoop ? absAlsoFinal : absAlso, alsoBeforeBody);
            } catch {
              /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
            }
          }
          if (indexBeforeResync !== null) {
            try {
              writeFileSync(join(cdir, 'docs/INDEX.md'), indexBeforeResync);
            } catch {
              /* leave it to resolveCoordCheckout's reset; the refusal is what matters */
            }
          }
          throw e;
        }
      };

      // plan 2729: a supplied --claimed-override reason is stamped into the commit
      // subject regardless of --message, so the override always carries provenance —
      // whether or not the guard above would actually have refused (e.g. a caller who
      // supplies it pre-emptively on a self-held or unheld plan still gets the stamp).
      const baseMessage =
        flags.message || `docs(plans): edit ${basename}${alsoRel ? ` + ${alsoBasename}` : ''}`;
      const message = overrideReason
        ? `${baseMessage} [claimed-override: ${overrideReason}]`
        : baseMessage;

      const res = coordWrite(cdir, { relPaths, mutate, message, tool: 'edit-plan', lockCtx });
      const renameNote = renaming ? ` (renamed to ${finalRel.split('/').pop()})` : '';
      const alsoRenameNote = alsoRenaming ? ` (renamed to ${alsoFinalRel.split('/').pop()})` : '';
      const alsoNote = alsoRel ? ` + ${alsoBasename}${alsoRenameNote}` : '';
      console.log(
        res?.noop
          ? `edit-plan: ${basename}${alsoNote} — already up to date (no change to push).`
          : `edit-plan: ${basename}${alsoNote} — committed + pushed${indexWillResync ? ' (INDEX bullet resynced)' : ''}${renameNote}.`,
      );
      return 0;
    },
    { tool: 'edit-plan' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('edit-plan:', e.message);
      process.exit(1);
    },
  );
}
