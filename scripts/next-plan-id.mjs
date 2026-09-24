#!/usr/bin/env node
// scripts/next-plan-id.mjs — race-safe plan-ID allocation (plan 230 Task 5).
//
// Plan IDs (`NNN-Category-slug`) used to be allocated by "read the plans/ folder,
// take max+1" — a TOCTOU race: two parallel sessions both read max=229 and both
// grab 230 (the exact collision that forced this pair of plans to be filed in
// dated form first). This is the same shared-counter race class board.mjs closed
// for board rows.
//
// Two entry points:
//   peek  (default) — fetch origin/master, print the next free ID. A *guess*:
//                     read-only, safe to call any time, but two simultaneous peeks
//                     return the same number. Use it to draft; the claim below is
//                     what actually wins the ID.
//   claim           — optimistic-concurrent: write the plan file (to ready/) + its
//                     INDEX bullet, commit both to master, push. On non-ff
//                     rejection → undo the local commit, fast-forward local master
//                     onto the fetched origin tip (plan 378 — without this the
//                     loser stays behind and every retry re-rejects), bump to the
//                     new max+1, recreate the file + INDEX entry, retry. The push
//                     winner owns the ID; the loser bumps. Works cross-PC (the
//                     operator runs multi-PC) — unlike an O_EXCL local lock.
//
// Usage:
//   node scripts/next-plan-id.mjs peek
//   node scripts/next-plan-id.mjs claim --category Other --slug my-slug \
//        --body path/to/body.md [--blurb "one-line INDEX blurb"]
//
// The INDEX bullet (its summary text AND its 🟥/🟩 marker) is derived from the plan
// BODY — the `summary:` frontmatter and the SEED-WRITE banner — the SAME single sources
// `build-index` regenerates from, so the claim-time bullet is byte-identical to a regen
// and blurb-vs-summary can never drift INDEX (plan 990, completing 959). `--blurb` is now
// only needed to BACK-FILL `summary:` when the body has none (plan 959); a `--blurb` that
// differs from an existing body summary is advisory — ignored with a WARN. `--seed-write`
// no longer drives the bullet marker (the body banner is build-index's source of truth).

import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseFlags,
  assertOneOf,
  resolveMain,
  git,
  gitWithLockRetry,
  coordWrite,
  withCoordCheckout,
  isNonFastForward,
} from './coord/coord-git.mjs';
import {
  addBullet,
  assertGeneratedRegionCanonical,
  parseGeneratedBullet,
} from './coord/index-lib.mjs';
import { assertBoardInvariants } from './coord/board-write-gate.mjs';
import {
  parsePlanMeta,
  renderBullet,
  readFrontmatterSummary,
  specReviewGateError,
  upsertFrontmatterKey,
  escapeRegex,
  PLAN_FILENAME_RX,
  idClaimPattern,
  SEED_BANNER_RX,
  H1_RX,
  spliceAtMatch,
  assertEvidenceFloorOk,
  cloudExecUnstampedWarning,
  priorityStampProblem,
  priorityStampFixHint,
  readPriorityBy,
  readPriorityTier,
  PRIORITY_BY_DIRECTIVES,
  READY_FOLDER,
  PENDING_APPROVAL_FOLDER,
} from './coord/build-index-lib.mjs';
// plan 2587: the ONE stage→Status-token mapping, shared with the promotion writer
// (stampPromotedStatus) so the two can never drift into disagreeing about one body.
import { statusTokenForStage, readStatusState, setStatusToken } from './coord/plan-body-state.mjs';
import { loadCoordConfig } from './coord/coord-config.mjs';
import { readyCostBannerError } from './coord/plan-cost-banner.mjs';
// Review fix round (4071 T2, one config snapshot per claim): a thin counting-testable seam
// over loadCoordConfig(mainDir) — buildClaimOps resolves the ONE config load a claim needs
// through this function, and doClaim reuses buildClaimOps's own resolved `planCategories`
// (via `ops.planCategories`) rather than calling loadCoordConfig a second time. Before this
// fix, buildClaimOps and doClaim each loaded coord.config.json independently, so a
// concurrent edit between the two reads could let category validation (buildClaimOps) and
// the evidence-floor gate (doClaim) judge the SAME claim against two different snapshots of
// policy. No module-level cache/memo here — this seam only COUNTS calls for the regression
// test (`next-plan-id.test.mjs`'s single-read pin); it still re-reads the file every call.
let _loadConfigCallCount = 0;
function _loadConfig(mainDir) {
  _loadConfigCallCount++;
  return loadCoordConfig(mainDir);
}
export function _getLoadConfigCallCount() {
  return _loadConfigCallCount;
}
export function _resetLoadConfigCallCount() {
  _loadConfigCallCount = 0;
}
// plan 3111: the shared adopt-stamp authority. Only its PURE arm is used here — see the call site
// for why a fresh mint needs no origin read.
import { applyAdoptBranchStamp } from './coord/plan-adopt-branch.mjs';
import { CLAIMED_LINE, MINT_BANNER_LINE } from './coord/mint-lines.mjs';
import { readExecModel, LANE_SEGMENTS } from './coord/lint-filename-execmodel-drift.mjs';
import { LANE_MARKER_ALTERNATION } from './coord/plan-lane-segments.mjs';
import {
  renameForExecModel,
  assertExecModelFilenameOk,
  ensureExecModelForCategory,
  ensureExecModelForExemptMechanical,
  stripExecModelSegment,
} from './coord/exec-model-stamp.mjs';
import { assertSlugCharset } from './coord/claim-plan-lib.mjs';
// plan 3341: the shared execModel enum — imported, never re-declared, so a --body file
// carrying a value this repo doesn't recognize is caught at mint time, the same hole
// closed in edit-plan.mjs.
import { VALID_EXEC_MODELS } from './stamp-exec-model.mjs';
// plan 2943: the evidence-floor vocabulary — imported (not re-listed) so a fresh mint's
// optional --evidence flag can never drift from the stamp tool's own valid-values list.
import { VALID_EVIDENCE } from './stamp-evidence.mjs';
// Review fix round (2943+2944, F5): `claim --ready --evidence latent --category DQ …` used to
// mint STRAIGHT into ready/ without ever calling `move-plan` — so move-plan's own
// assertEvidenceFloorOk ready-promotion gate never ran, and 2943's acceptance ("a Pipe/DQ/App/UI
// plan stamped evidence: latent cannot reach ready/") had a hole at THIS ingress.
// Review fix round (2943+2944, R7): assertEvidenceFloorOk now lives in build-index-lib.mjs (see
// the import above) rather than move-plan.mjs — pulling in a whole command module for one
// predicate was a layering smell; build-index-lib.mjs is the leaf both this module and
// move-plan.mjs already import (readFrontmatterScalar), so it is the
// natural shared home. move-plan.mjs re-exports the same name so its own callers/tests are
// unaffected.

// The plan-naming category taxonomy (plan 2329) MOVED to build-index-lib.mjs by plan 2719,
// then to `coord.config.json`'s `planCategories.allowlist` by plan 4071 (T2/D1/D2) — core
// default `[]`, read as "no category gate" rather than "reject everything" (an empty
// allowlist would otherwise leave a fresh coord-kit checkout unable to mint any plan at
// all). buildClaimOps below resolves `loadCoordConfig(mainDir).planCategories.allowlist`
// once and treats an empty list as allow-all; no module-level export survives to re-export.

// --- pure --------------------------------------------------------------------

// Highest plan id found across the given strings (filenames, index refs, anything),
// +1, zero-padded. Matches only a real plan-FILENAME shape — `NNN-Category-….md` at a
// path/backtick/space boundary — so the counter is NOT inflated by digit runs that
// aren't plan ids: clinic refs in INDEX archive prose (`clinic-783`, no `.md`), counts
// ("120 req/min"), or a number embedded mid-filename (`077-Other-claude-haiku-429-…md`
// → only 077, never the inner 429, which isn't boundary-preceded). (plan 230 — caught
// dogfooding.) `\d{3,}` (not `\d{3}`) so a 4-digit id (plan 1000+) is SEEN — else the
// counter caps at 999 and the next mint re-mints 1000, colliding with the live plan.
export function computeNextId(names) {
  let max = 0;
  for (const n of names) {
    // F-015 (plan 1313, 2026-07-02 coord audit): the body class is Unicode-aware (`\p{L}\p{N}`,
    // `u` flag) — aligned with idTakenByOther's tolerant `[^/]*` dup-guard so a legitimately
    // non-ASCII (e.g. Swedish öäå) slug that reaches a filename is still SEEN here. Mint-time
    // charset validation (assertSlugCharset, called from buildClaimOps below) now REJECTS a bad
    // slug before it can ever reach a filename, so this is defense-in-depth: the pre-fix
    // scan/guard mismatch let a bad file's id be invisible to this scanner (bare ASCII `\w`)
    // while idTakenByOther could still see it — every future mint's retry re-collided on the
    // same id and allocatePlanId exhausted its budget (repro: `scan:001, taken:true`) until a
    // manual rename. Kept NARROWER than idTakenByOther's fully-permissive `[^/]*`: this class
    // still EXCLUDES whitespace/slash/backtick/paren (the boundary chars in the lookbehind
    // alternation below), so a greedy match can't swallow past a real word boundary and hide a
    // LATER digit-run in the same scanned blob — a real risk in INDEX.md's multi-bullet text.
    for (const m of String(n).matchAll(/(?:^|[/`\s([])(\d{3,})-[\p{L}][\p{L}\p{N}_.-]*\.md\b/gu)) {
      const v = Number(m[1]);
      if (v > max) max = v;
    }
  }
  return String(max + 1).padStart(3, '0');
}

// Defense-in-depth for the ref-CAS claim crash (plan 371): a hand-filed plan
// body with NO `**Status:**` line crashes `claim-plan acquire`'s projection. Make
// every plan well-formed at birth by INSERTING a stage-derived `📋 <TOKEN> — opened
// <date>.` status line when the body lacks one, anchored after the cost-forecast banner
// (fall back to the SEED-WRITE banner, then the H1, then prepend). A body that
// already carries a Status line keeps it, EXCEPT that a token contradicting the stage
// the mint is about to stamp is reconciled in place (plan 2587 — see below). The
// presence test, the token read, and the token rewrite all go through
// plan-body-state.mjs's hasStatusLine/readStatusToken/setStatusToken — the same helpers
// board-write-gate's Check A reads, so the two can never disagree about which Status line
// is the plan's own (plan 2587; it replaced a local STATUS_LINE_RX presence test that did
// NOT strip frontmatter, which was itself the plan-2409 replacement for a local
// NPI_STATUS_RX — the third independent hand-roll of the same shape, found during plan
// 2353's 2392-reconcile). SEED_BANNER_RX and H1_RX are imported too (both used to be
// byte-for-byte local copies — the same drift class this plan exists to close). NPI_COST_RX stays local and deliberately strict
// (unlike the shared insertion-anchor pair in build-index-lib.mjs): a fresh mint's
// OWN cost banner is always the literal blockquote+bold shape this module itself
// templates, so there is no corpus tolerance to consolidate for that one.
const NPI_COST_RX = /^>.*\*\*Cost forecast:\*\*.*$/m;
// The stage `ensureStageFrontmatter` (below) stamps when the body carries none. Named
// once, and READ by ensureReadyStatusLine, because that heal runs FIRST and its token has
// to anticipate what the later stamp will write — two independent `'stub'` literals were
// a plan-2587 review finding.
export const MINT_DEFAULT_STAGE = 'stub';
export function ensureReadyStatusLine(body, date) {
  // plan 1292: a fresh mint's Status line carries a trailing note flagging that no
  // spec-pass has reviewed it yet — paired with the `stage: stub` frontmatter below
  // (ensureStageFrontmatter), this is the human-visible half of the same signal.
  //
  // plan 2587: the TOKEN is derived from the stamp instead of hardcoded `READY`. It used
  // to be `📋 READY` on every mint while `ensureStageFrontmatter` stamped `stage: stub`
  // three lines later — i.e. the mint template ITSELF authored the exact `stage: stub` /
  // `**Status:** READY` contradiction plan 2587 measured on plan 2563 (the only corpus
  // instance of that direction, and it was a fresh mint). board-write-gate's
  // `stage-status-prose` check refuses that pair, so leaving the hardcode would have
  // bricked `claim` outright. Per plan 2587 acceptance #5, the TOOL carries the prose fix.
  // `statusTokenForStage` is the shared mapping (plan-body-state.mjs) — the promotion
  // writer uses the same one, so the two can never drift apart.
  const token = statusTokenForStage(body, { defaultStage: MINT_DEFAULT_STAGE });

  // plan 2587 review finding (CONFIRMED): the early `return body` on an existing Status
  // line used to be unconditional, which re-opened the very hole the token derivation
  // closes. `--body` files are routinely copy-pasted from existing plans, and every plan
  // authored before this change carries a literal `**Status:** 📋 READY` — so such a body,
  // with no `stage:` of its own, sailed past this heal untouched, then got `stage: stub`
  // stamped by ensureStageFrontmatter, and the mint's OWN `assertBoardInvariants` call
  // refused the write and rolled the whole claim back. Reconcile instead: rewrite ONLY the
  // state token, and ONLY for the two pairs Check A actually polices — every other Status
  // line (SPECCED, WAITING-*, IN PROGRESS, COMPLETED, a bare token-less line) is still
  // returned byte-identical, and the author's `— …` remainder is always preserved.
  // This is prose the AUTHORING TOOL fixes, which plan 2587 step 4 sanctions; it is not
  // the general prose auto-rewriter that step rules out.
  //
  // Line selection AND token extraction both go through plan-body-state's shared
  // `hasStatusLine` / `readStatusToken` / `setStatusToken` (re-review finding, CONFIRMED):
  // board-write-gate's Check A reads the token through the SAME helpers, so the reconcile and
  // the gate can never disagree about WHICH `**Status:**` line is the plan's own. A
  // disagreement is not a cosmetic split — the heal would "fix" one line while the gate judged
  // another, leaving the real line contradicting and the gate silent, i.e. exactly the bug
  // this heal exists to prevent, now invisible. The selection rule (frontmatter-STRIPPED
  // first match, spliced by index) is `setStatusLine`'s, hardened by plans 2360/2392 against a
  // `summary:`-quoted decoy; the old raw whole-body `STATUS_LINE_RX.test` here did not strip
  // frontmatter and so could disagree with the gate on exactly such a body.
  // ONE resolver pass, not two (re-review round 2): `readStatusState` returns both halves,
  // and the distinction matters — a Status line with no state word yields `token: null` but
  // `hasLine: true`, and must NOT fall through to the insert path below (that would give the
  // body a SECOND Status line).
  const { hasLine, token: stated } = readStatusState(body);
  if (hasLine) {
    const wanted = token.replace(/^\S+\s*/, ''); // '📋 STUB' → 'STUB'
    if ((stated === 'STUB' || stated === 'READY') && stated !== wanted) {
      return setStatusToken(body, token);
    }
    return body;
  }

  const statusLine = `**Status:** ${token} — opened ${date}. <!-- spec-pass pending -->`;
  // Index/length-based splice (spliceAtMatch), not a literal body.replace(anchor, …)
  // — a body whose anchor text ALSO occurs verbatim earlier (a quoted example, a
  // copy-pasted duplicate banner) would otherwise splice into that earlier
  // occurrence instead of the real match (review finding, plan 2409; mirrors why
  // the sibling writers — flipStatusToInProgress, setStatusLine — already use
  // spliceAtMatch instead of a string search, plan 2392 finding 3).
  const match = body.match(NPI_COST_RX) || body.match(SEED_BANNER_RX) || body.match(H1_RX);
  if (!match) return `${statusLine}\n\n${body}`;
  return spliceAtMatch(body, match, `${match[0]}\n\n${statusLine}`);
}

// Persist the `--blurb` as `summary:` frontmatter at mint time (plan 959). Without
// this, claim writes the blurb ONLY into the transient INDEX bullet, never into the
// plan body — so the first later `build-index` regen (any plan edit/move) reads
// `summary:` (else falls back to the H1 with a WARN) and silently discards the
// author's one-liner. Mirror `ensureReadyStatusLine`: a pure auto-heal that makes
// every minted plan carry a `summary:` by construction.
//
//   • body already has a `summary:` key in a leading `---` block → unchanged (a
//     hand-written, richer author summary wins over the terse INDEX blurb).
//   • leading `---` block but no `summary:` (the 954 shape, e.g. an `unblock:` key)
//     → insert a `summary:` line into the block, preserving the existing keys.
//   • no leading `---` block → create one carrying just `summary:`, body after it.
//
// The value is single-quoted YAML with `''` escaping (matching how existing
// summaries are written and exactly what build-index's `unquoteYaml` reads back),
// so a blurb with `:`/quotes/`→`/brackets still parses. `summary:` is emitted at
// column 0 because build-index's frontmatter parser anchors the key at line start.
function quoteYamlSingle(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
// Delegates to the shared upsertFrontmatterKey (plan 1304) with keepExisting —
// merge/create/unterminated-block edge cases live there, once.
export function ensureSummaryFrontmatter(body, blurb) {
  return upsertFrontmatterKey(body, 'summary', quoteYamlSingle(blurb), { keepExisting: true });
}

// plan 1292: stamp `stage: stub` into every freshly minted plan's frontmatter — the
// lifecycle-gate scripts (move-plan's ready-promotion gate, the orchestrator drain's
// execModel filter) read this field as the routing source of truth, so it must exist
// on every mint by construction, not by author discipline. Mirrors ensureSummaryFrontmatter's
// merge-preserving shape exactly (same three cases), so both keys always end up inside a
// SINGLE leading `---` block regardless of call order:
//
//   • leading `---` block already carries a `stage:` key → unchanged (never overwrite an
//     existing stamp — e.g. a spec-pass already promoted it to `specced`).
//   • leading `---` block without `stage:` → merge `stage: stub` in, preserving other keys.
//   • no leading `---` block → create one carrying just `stage: stub`.
//
// Called AFTER ensureSummaryFrontmatter in buildClaimOps, so when the body had no
// frontmatter at all, ensureSummaryFrontmatter has already created the block (carrying
// `summary:`) and this function merges `stage: stub` into that SAME block rather than
// prepending a second one.
// Delegates to the shared upsertFrontmatterKey (plan 1304) with keepExisting.
export function ensureStageFrontmatter(body) {
  return upsertFrontmatterKey(body, 'stage', MINT_DEFAULT_STAGE, { keepExisting: true });
}

// --- repo scan ---------------------------------------------------------------

// All allocated plan ids as seen from `ref` (default origin/master): every plan
// filename under docs/superpowers/plans/** PLUS every NNN- ref in docs/INDEX.md.
export function scanAllocatedNames(mainDir, ref = 'origin/master') {
  let names = [];
  try {
    names = git(mainDir, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/superpowers/plans'])
      .split('\n')
      .filter(Boolean);
  } catch {
    /* ref may not exist (fresh repo) → fall through to working tree below */
  }
  let indexContent = '';
  try {
    indexContent = git(mainDir, ['show', `${ref}:docs/INDEX.md`]);
  } catch {
    try {
      indexContent = readFileSync(join(mainDir, 'docs', 'INDEX.md'), 'utf8');
    } catch {
      /* no INDEX → ignore */
    }
  }
  return [...names, ...indexContent.split('\n')];
}

export function nextIdFromRepo(mainDir, { fromOrigin = true } = {}) {
  if (fromOrigin) {
    try {
      git(mainDir, ['fetch', '--quiet', 'origin', 'master']);
    } catch {
      /* offline → fall back to whatever ref resolves below */
    }
  }
  const ref = fromOrigin ? 'origin/master' : 'HEAD';
  return computeNextId(scanAllocatedNames(mainDir, ref));
}

// Fast-forward duplicate-id guard (plan 777). The reserve-by-push bump only fires
// on a NON-ff push REJECTION, but a sibling's same-id claim can land on origin in
// the window between our max-id read and our push: it touches a DIFFERENT filename,
// so coordWrite's freshen pulls it as a CLEAN fast-forward and our subsequent push
// is ALSO a clean ff — accepted, no rejection, no bump. Two files then share the id
// (the real 772 collision, 2026-06-17) until a later move-plan/acquire fails
// "ambiguous", wedging both sessions. So inside the freshened tree (mutate runs
// AFTER coordWrite's ff-merge onto origin/master) we re-check directly: does any
// tracked plan file OTHER than the one we're about to write already carry our id?
// `planPaths` is the repo-relative plan-file list (e.g. `git ls-files -z
// docs/superpowers/plans`); a hit means bump + re-author + retry.
//
// The match is "a path SEGMENT (basename) that genuinely claims id `id` and ends
// `.md`" — anchored on `(?:^|/)` + idClaimPattern (build-index-lib.mjs, plan 2039),
// the ONE shared assertion also used by move-plan.mjs's resolvePlanRel, so a
// longer id sharing the 3-digit prefix never collides (`1000-…` ≠ `100`, `2300-…`
// ≠ `230`) AND a dateless legacy archive basename (`archive/2026-05-17-(...).md`,
// whose leading digits merely READ as a plausible id) is never mistaken for a real
// claim — that mistake is what livelocked every mint once the id counter reached
// 2026 (2026-07-18): the old `[^/]*` guard read the legacy basename as "id 2026
// taken" while computeNextId (correctly) kept proposing 2026, exhausting the
// attempt budget repo-wide. `[^/]*` (not `[\w.-]*`) is the trailing body: every
// entry here is already a real plan-file path, so only the id-claim prefix +
// `.md` suffix matter, and `\w` (no `u` flag) would miss a non-ASCII basename —
// pair that with the `-z` read so quoting can't hide one either. If idClaimPattern
// itself changes, both call sites move together automatically; claim-plan.mjs:708
// is a separate, inverted given-slug-vs-given-id check, unaffected either way.
export function idTakenByOther(planPaths, id, ownRelPath) {
  const rx = new RegExp(`(?:^|/)${idClaimPattern(id)}[^/]*\\.md$`, 'u');
  return planPaths.some((p) => p !== ownRelPath && rx.test(p));
}

// --- slug/content-dup guard (plan 882) ---------------------------------------

// The id-guards above (378 reserve-by-push bump, 777 idTakenByOther) keep every
// id UNIQUE but never ask "does a plan with this category+slug already exist?".
// So a SECOND claim for the SAME plan — an operator double-run, a skill retry, or
// a push that lands on origin yet reports failure so the caller re-runs — freshly
// scans, sees the first id taken, picks the next, and authors a byte-identical
// copy under a new id. That is the recurring 878/879 (+ archived 638/639, 723/724,
// 820/821, 864/865) duplicate: same slug, consecutive ids, identical bytes.

// First tracked plan path whose BASENAME is
// `NNN-<optional lane marker><category>-<slug>.md` for ANY id (≥3 digits, incl.
// 4-digit plan 1000+), else null. The optional marker grammar is imported from
// plan-lane-segments.mjs so this duplicate guard cannot drift from the writers
// that stamp lane-marked basenames. Anchored on `(?:^|/)` + id digits + the
// literal `-` (so a longer id sharing the prefix never matches, mirroring
// idTakenByOther), with category/slug regex-escaped so a `.`-bearing slug can't
// widen the match. `ownRelPath` (the file this claim is authoring) is excluded.
export function findExistingSlugPlan(planPaths, category, slug, ownRelPath) {
  // The lane marker is stripped from BOTH sides, never matched literally: off the
  // haystack by the optional group, and off the needle by stripExecModelSegment (the
  // same normalization the category-allowlist gate below already applies to `category`).
  // Stripping only the haystack side leaves the MARKER-SWAP case broken — `--category
  // FABLE-DQ` with an explicit `execModel: sol` lands as `NNN-SOL-DQ-<slug>.md`, which
  // `(?:FABLE-|SOL-)?FABLE-DQ-<slug>` can never match (plan 3463 delta-review, key
  // 277249). Marker-agnostic on both sides is also the semantically right question for a
  // DUPLICATE guard: two plans with the same category and slug that differ only in lane
  // are exactly the same-slug/consecutive-ids duplicate this exists to catch.
  const rx = new RegExp(
    `(?:^|/)\\d{3,}-(?:${LANE_MARKER_ALTERNATION})?${escapeRegex(stripExecModelSegment(category))}-${escapeRegex(slug)}\\.md$`,
  );
  return planPaths.find((p) => p !== ownRelPath && rx.test(p)) || null;
}

// Layer 1 — pre-flight, before allocating. Fetch origin/master (the shared truth)
// and look for an already-existing plan with this category+slug:
//   • identical body  → return { id } so the caller returns the EXISTING id (an
//                       idempotent re-claim — NO second file, NO commit). This is
//                       what makes a retried/double-fired claim harmless.
//   • different body  → throw (the CLI exits non-zero): a real slug collision, so
//                       the author must pick a distinct slug or edit the existing
//                       plan rather than silently fork it.
//   • none / offline / no origin ref → null: proceed to the normal allocate loop.
// Layer 2 (writeArtifacts, post-coordWrite-freshen) covers the tiny window between
// this read and our push, so an offline pre-flight here is not a correctness hole.
export function preflightSlugGuard(mainDir, { category, slug, planBody }) {
  try {
    git(mainDir, ['fetch', '--quiet', 'origin', 'master']);
  } catch {
    /* offline — Layer 2 still guards post-freshen */
  }
  let originPaths;
  try {
    originPaths = git(mainDir, [
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      'origin/master',
      '--',
      'docs/superpowers/plans',
    ])
      .split('\0')
      .filter(Boolean);
  } catch {
    return null; // no origin/master ref (fresh repo) → nothing to dedup against
  }
  const hit = findExistingSlugPlan(originPaths, category, slug);
  if (!hit) return null;
  // the id is the FULL leading digit-run (4-digit for plan 1000+), NOT the first 3 chars —
  // a `.slice(0, 3)` would report/throw the wrong plan ("100" for a 1002-* dup) (plan 1002).
  const id = (hit
    .split('/')
    .pop()
    .match(/^(\d{3,})/) || [])[1];
  let existing;
  try {
    existing = git(mainDir, ['show', `origin/master:${hit}`]);
  } catch {
    return null; // vanished between ls-tree and show → let allocate proceed
  }
  // Normalize line endings + trailing whitespace before comparing. `git show`
  // returns the LF blob (`.gitattributes` `* text=auto eol=lf`), but planBody comes
  // from readFileSync of the --body file, which can carry CRLF (a `.scratch` body is
  // not .gitattributes-normalized) — a raw byte compare would then false-negative an
  // IDENTICAL re-claim into a hard-fail, defeating the idempotency this guard exists for.
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (norm(existing) === norm(planBody)) return { id };
  throw new Error(
    `next-plan-id: a plan with category+slug "${category}-${slug}" already exists as ${id} ` +
      `(${hit}) with DIFFERENT content — choose a distinct slug, or edit plan ${id} directly. ` +
      `Refusing to author a duplicate.`,
  );
}

// --- optimistic-concurrent claim (state machine; git ops injected for tests) -

// scanIds()           → returns the next id guess (re-scans fresh each call)
// onPick(id)          → materialises artefacts for `id`; returns { cleanup? }
// tryCommitPush(id)   → commits+pushes; throws an error with .nonFastForward=true
//                       if the push was rejected (someone else landed first)
export async function allocatePlanId({ scanIds, onPick, tryCommitPush, maxAttempts = 6 }) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const id = scanIds();
    const picked = onPick(id) || {};
    try {
      tryCommitPush(id);
      return { id, attempts: attempt };
    } catch (e) {
      picked.cleanup?.();
      if (!e.nonFastForward) throw e;
      lastErr = e;
    }
  }
  const err = new Error(`next-plan-id: could not allocate an id after ${maxAttempts} attempts`);
  err.cause = lastErr;
  throw err;
}

// --- CLI ---------------------------------------------------------------------

// Build the { scanIds, onPick, tryCommitPush } op-set that drives allocatePlanId
// for a `claim`. Extracted from doClaim (plan 777) so a test can wrap `scanIds`
// to land a sibling same-id file in the read→push window and assert the
// fast-forward-dup guard bumps the id rather than producing a duplicate.
// `config`, when given, is an ALREADY-LOADED coord.config.json snapshot (from `_loadConfig`)
// that this call reuses instead of reading the file again — review fix round 2 (4071, finding
// 65b196): the CLI's `main()` must resolve `mutationBanner.flag` (to build parseFlags' accepted
// value-flag list) BEFORE flags even exist, i.e. before buildClaimOps can run, so it always
// read coord.config.json a SECOND time on top of buildClaimOps' own load — the exact same
// cross-read hazard the 4071-T2 fix (below) closed between buildClaimOps and doClaim, just one
// call frame further out. `main()` now passes its own snapshot down through doClaim into here.
export function buildClaimOps(mainDir, flags, config) {
  const { category, slug, body, blurb } = flags;
  if (!category || !slug || !body) {
    throw new Error('claim needs --category, --slug, --body <file>');
  }
  // plan 4071 (T2/D1/D2): ONE config load for this call — the category allowlist below AND
  // seedLane/mutationBanner further down (previously a separate loadCoordConfig(mainDir) call)
  // now share it, so a fresh mint reads coord.config.json exactly once per invocation. Routed
  // through the _loadConfig counting seam (review fix round, 4071 T2) rather than
  // loadCoordConfig directly, so a test can pin that ONE claim (buildClaimOps + doClaim
  // together) never reads coord.config.json more than once. A caller that already resolved a
  // snapshot (main(), review fix round 2) passes it in via `config` and this skips the reload
  // entirely — zero additional _loadConfig calls, not even one that would still count as "one".
  const { planCategories, seedLane, mutationBanner } = config ?? _loadConfig(mainDir);
  // F-015 (plan 1313 coord audit): validate BOTH --category and --slug's charset at mint time —
  // see assertSlugCharset's doc comment (claim-plan-lib.mjs) for the wedge this closes.
  assertSlugCharset(category, 'category');
  assertSlugCharset(slug, 'slug');
  // Mint gate (plan 1945): assertSlugCharset above allows a lowercase-leading category
  // (`tooling` passes SLUG_CHARSET_RX fine) — but build-index.mjs's PLAN_FILENAME_RX
  // requires an UPPERCASE-led category tag, and a mismatch is the exact plan-1928
  // failure: minted, spec-passed, board-passed, routed to ready/, and completely
  // invisible to docs/INDEX.md (the regenerate-and-diff pre-push lint stays green
  // because the regen skips the bad file too). Validate the COMPOSED basename against
  // the SAME regex build-index uses — a placeholder id stands in since the real id
  // isn't allocated yet and doesn't affect the tag-shape check.
  const placeholderBasename = `000-${category}-${slug}.md`;
  // The marker-STRIPPED category (also used below at the allowlist check): a leading
  // `FABLE-`/`SOL-` exec-model segment on `--category` is orthogonal routing, never a
  // taxonomy tag of its own.
  const baseCategory = stripExecModelSegment(category);
  if (!PLAN_FILENAME_RX.test(placeholderBasename)) {
    // sonnet-review finding: a bare `charAt(0).toUpperCase()` suggestion is a no-op
    // (and therefore misleading — the same rejected value again) for a category that
    // already starts with an uppercase letter but is too SHORT for PLAN_FILENAME_RX's
    // `[A-Z][A-Za-z0-9]+` (2+ chars, e.g. a single-letter "T"), or that starts with a
    // digit (uppercasing a digit is a no-op too, e.g. "123tooling"). Only offer the
    // capitalize-and-retry suggestion when it would ACTUALLY pass the same regex —
    // verified by construction, not guessed — else explain the real shape requirement.
    const upperFirst = category.charAt(0).toUpperCase() + category.slice(1);
    const fixHint =
      upperFirst !== category && PLAN_FILENAME_RX.test(`000-${upperFirst}-${slug}.md`)
        ? `Try --category ${upperFirst}.`
        : `The category tag must be an uppercase ASCII letter followed by at least one more ` +
          `letter/digit (e.g. "Infra", "DQ") — "${category}" doesn't fit that shape, so simply ` +
          `capitalizing it won't fix this; pick a different category.`;
    throw new Error(
      `next-plan-id: --category "${category}" would mint a plan invisible to docs/INDEX.md ` +
        `(the plan-1928 failure mode) — ${fixHint}`,
    );
  }
  // Category allowlist (plan 2329): a NEW mint's category must be a known taxonomy tag so
  // the board/spec-pass checklists can reason about it — an unknown tag hard-fails here
  // rather than proliferating one-off categories. A leading `FABLE-`/`SOL-` exec-model
  // segment is orthogonal routing (plan 1362; sol added by plan 3341); stripExecModelSegment
  // (exec-model-stamp.mjs, the owner of that convention — table-driven over every
  // segment-bearing lane) removes whichever one is present so the allowlist can't drift
  // from the segment shape. Before plan 3341 this called stripFableSegment only, so
  // `--category SOL-Pipe` reached the allowlist check with the `SOL-` prefix still
  // attached and was refused as an unrecognized category — never reaching the mint at
  // all. NEW mints only: existing basenames stay valid for move/edit/land tooling
  // (forward-only). (baseCategory computed above.)
  // plan 4071 D1: an EMPTY allowlist means "no category gate" (allow all) — the safe
  // degrade direction for a config-less repo, never "reject everything".
  if (planCategories.allowlist.length && !planCategories.allowlist.includes(baseCategory)) {
    throw new Error(
      `next-plan-id: --category "${category}" is not an allowed plan category. ` +
        `Valid categories: ${planCategories.allowlist.join(', ')} ` +
        `(a leading FABLE- or SOL- exec-model segment is allowed on any of them). ` +
        `See docs/runbooks/plans-workflow.md § Plan naming.`,
    );
  }
  // plan 2943: the OPTIONAL --evidence flag validated up front (fail fast, before any
  // artefact is written) against the SAME five-value vocabulary stamp-evidence.mjs enforces
  // — one source of truth, never a second copy of the list here. Omitted ⇒ the key stays
  // absent on the fresh mint (forward-only stamping, the grandfathered-pool default: a mint
  // with no --evidence reads exactly like every plan minted before plan 2943 existed).
  if (flags.evidence !== undefined) {
    assertOneOf(flags.evidence, VALID_EVIDENCE, {
      label: '--evidence value',
      prefix: 'next-plan-id',
    });
  }
  if (!existsSync(body)) throw new Error(`claim: --body file not found: ${body}`);
  // plan 1371 (D1/D2): mint into pending-approval/ by DEFAULT (not auto-drainable, and
  // deliberately NOT requiring same-session routing — pending-approval/ IS the sanctioned
  // resting spot, D4), or ready/ when the caller passes --ready (the explicit "orchestrator,
  // take this" opt-in). The autonomous drain (queue-drain.mjs) reads ready/ ONLY, so a default
  // mint is safe from being grabbed by the orchestrator before its minter claims it (the
  // 2026-06-23 plan-1013 race). 'pending-approval' is in STATUS_ORDER so the bullet renders +
  // the plan is pickup-claimable from pending-approval/ exactly like ready/. (Formerly
  // `drafting/` — retired whole from the taxonomy by plan 1371 D5.)
  const mintFolder = flags.mintFolder === READY_FOLDER ? READY_FOLDER : PENDING_APPROVAL_FOLDER;
  const date = flags.date || new Date().toISOString().slice(0, 10);
  // Auto-heal the body at mint time with a `**Status:**` line (ref-CAS, plan 371).
  // LF-normalize the authored body FIRST (plan 1650): a Windows-authored `.scratch` body
  // arrives CRLF, and writeArtifacts's writeFileSync would put those raw bytes into the
  // coord-checkout — git normalizes the committed BLOB to LF (`* text=auto eol=lf`) but
  // never re-smudges the unchanged working copy, so the CRLF residue persists there and
  // every later regen reading that working tree sees byte-variant content (the 1647
  // H1-bullet drift). The parse seam is CRLF-safe now (build-index-lib), so this is
  // belt-and-suspenders: the tree we commit from should carry the bytes we commit.
  const bodyWithStatus = ensureReadyStatusLine(
    readFileSync(body, 'utf8').replace(/\r\n/g, '\n'),
    date,
  );
  // plan 990: the INDEX bullet summary is the plan body's `summary:` frontmatter — the
  // SAME single source `build-index` regenerates from. `--blurb` only BACK-FILLS that
  // frontmatter when the body lacks its own `summary:` (plan 959); when the body already
  // carries one, `--blurb` is advisory. So validate the two cases up front:
  //   • no body `summary:` AND no `--blurb` → nothing to derive the bullet from → error.
  //   • body `summary:` present AND a differing `--blurb` → WARN, the body summary wins.
  const authorSummary = readFrontmatterSummary(bodyWithStatus);
  if (!authorSummary && !blurb) {
    throw new Error(
      'claim needs --blurb "<text>" when the --body has no `summary:` frontmatter ' +
        '(it back-fills both the plan body summary and the INDEX bullet)',
    );
  }
  if (authorSummary && blurb && blurb !== authorSummary) {
    console.error(
      'next-plan-id: WARN --blurb differs from the body `summary:` frontmatter — ' +
        'using the body summary for the INDEX bullet; --blurb ignored.',
    );
  }
  // ensureSummaryFrontmatter is a no-op when the body already has a `summary:` key (author
  // wins), else it back-fills from --blurb (959). `blurb ?? ''` keeps the back-fill path
  // safe even if a future caller omits --blurb on a no-summary body (the guard above already
  // makes that combination unreachable today). NOTE: a body with an EMPTY `summary: ''` key
  // is left as-is and the bullet below falls back to the H1 — but that is exactly what
  // build-index regenerates too, so it stays drift-free (the plan's invariant); it just is
  // not back-filled from --blurb.
  // plan 1292: stamp `stage: stub` (merge-preserving, never clobbers an existing stamp)
  // AFTER the summary back-fill, so a body with no frontmatter at all gets ONE block
  // carrying both `summary:` and `stage:` — never two separate `---` blocks.
  // plan 1561: LAST, back-fill `execModel: fable` when `--category` itself carries the
  // FABLE- segment (e.g. `--category FABLE-DQ`) but the frontmatter doesn't say so yet —
  // otherwise onPick mints a filename that already carries the segment (from category
  // text alone) while planBody's execModel stays unset, and writeArtifacts's belt-and-
  // suspenders assertExecModelFilenameOk throws its "should be unreachable" drift error
  // on every such mint, frontmatter-less or not.
  let planBody = ensureExecModelForCategory(
    ensureStageFrontmatter(ensureSummaryFrontmatter(bodyWithStatus, blurb ?? '')),
    category,
  );
  if (mintFolder === READY_FOLDER) planBody = ensureExecModelForExemptMechanical(planBody);
  // plan 2943: write the validated --evidence value straight into the fresh mint's
  // frontmatter, merge-preserving like every other ensure*/upsert step above — never
  // clobbers a value the authored --body already carried (keepExisting mirrors
  // ensureStageFrontmatter's own contract, so an author-supplied `evidence:` always wins
  // over the flag).
  if (flags.evidence !== undefined) {
    planBody = upsertFrontmatterKey(planBody, 'evidence', flags.evidence, { keepExisting: true });
  }
  // plan 3111: writer 2 of 3 into ready/, routed through the SAME adopt-stamp authority
  // (plan-adopt-branch.mjs) the other two call — but through its PURE arm, deliberately, and with
  // an empty branch list. `--ready` mints a BRAND-NEW id reserved by push (never a reuse), so
  // origin cannot possibly hold an execution branch for it: the truthful `adoptBranch` value on a
  // fresh mint is ALWAYS absent, and an `ls-remote` here would be a network round trip on every
  // mint whose answer is fixed in advance. What the call is genuinely for is the one live case — an
  // authored `--body` draft that hand-carries an `adoptBranch:` key. Such a stamp is necessarily
  // false (it would have to name a branch for an id that did not exist until this moment) and would
  // reach the drain's carve-out as a lie, so it is STRIPPED here by the same code path that strips a
  // dead stamp anywhere else. Applied on every mint folder, not just `--ready`: a pending-approval/
  // plan carrying the same false stamp would simply become a ready/ one later.
  {
    const stripped = applyAdoptBranchStamp(planBody, []);
    if (stripped.action === 'stripped') {
      planBody = stripped.content;
      console.error(
        `next-plan-id: WARN — dropped a hand-written \`adoptBranch: ${stripped.branch}\` from the ` +
          `plan body. A fresh mint reserves a NEW id, so no execution branch can exist for it yet; ` +
          `the stamp is written by \`node scripts/plan-adopt-branch.mjs <id>\` once one does.`,
      );
    }
  }
  // plan 3341: refuse a mint whose FINAL planBody carries an execModel this repo doesn't
  // recognize — checked here, after every ensure*/upsert step above has finished touching
  // planBody, so this judges the value that will actually reach disk. The only way an
  // invalid value can be sitting in planBody at this point is an author-supplied
  // `execModel:` in the authored --body file: ensureExecModelForCategory's backfill above
  // only ever writes a value out of its own SEGMENT_CHECK_FOR_EXEC_MODEL table (always
  // valid by construction), and `keepExisting: true` there means it never touches an
  // author-supplied value regardless — so a typo'd or bogus value passes straight
  // through untouched until now. This is the same hole edit-plan.mjs's --body/
  // --find-replace paths had before this plan.
  {
    const mintedExecModel = readExecModel(planBody);
    if (mintedExecModel && !VALID_EXEC_MODELS.includes(mintedExecModel)) {
      throw new Error(
        `next-plan-id: refusing to mint with execModel: "${mintedExecModel}" — must be one of ` +
          `${VALID_EXEC_MODELS.join(' / ')} (or absent, which reads as sonnet). Likely a typo in ` +
          `the --body frontmatter; fix it and re-run claim.`,
      );
    }
  }
  // plan 3999 review fix round 1 (key 8116d5): the priority-stamp gate used to live HERE —
  // moved to doClaim, run AFTER preflightSlugGuard's idempotent-re-claim short-circuit (mirrors
  // the evidence-floor gate's own R5 relocation below, and its rationale: buildClaimOps has no
  // knowledge of origin state, so a check here cannot tell a genuine fresh mint from a harmless
  // re-claim of an already-filed plan). Unlike the evidence-floor gate, this one runs for EVERY
  // mint folder, not just `--ready` — see doClaim's own comment at the call site.
  // Review fix round (2943+2944, F5): refuse a `--ready` mint outright when the EFFECTIVE
  // evidence value — the `--evidence` flag above, or an `evidence:` key the authored `--body`
  // already carried (keepExisting means planBody now reflects whichever won) — is `latent` and
  // the category is one of the evidence-floor's product families. Reuses the shared gate
  // (build-index-lib.mjs's assertEvidenceFloorOk — same category allowlist, same self-explaining
  // refusal message naming both return paths) against the SAME placeholder basename shape the
  // plan-1928 filename-taxonomy check above already builds (the real id isn't allocated yet).
  // Review fix round (2943+2944, R5): moved OUT of buildClaimOps and into doClaim, run AFTER
  // preflightSlugGuard's idempotent-re-claim short-circuit — this used to run HERE, before that
  // check, so a re-claim of an ALREADY-FILED `evidence: latent` plan (a clean no-op every other
  // claim path treats as harmless) was wrongly refused instead of returning the existing id.
  // `mintFolder` rides on the returned `ops` below so doClaim can gate on it without re-deriving
  // it. Still fails BEFORE any artefact is written on a genuine fresh mint — writeArtifacts hasn't
  // run at that point either.
  // seedLane decides whether the bullet marker reads the body SEED-WRITE banner (vetapp)
  // or is always 🟩 (a no-seed-lane repo) — matched to build-index's collectPlans so the
  // marker is byte-identical to a regen too. The `--seed-write` flag (accepted for back-
  // compat) no longer drives the bullet: the body banner is build-index's source of truth.
  // (seedLane/mutationBanner come from the ONE loadCoordConfig(mainDir) call at the top of
  // this function, plan 4071.)
  // Derive the bullet's summary + 🟥/🟩 marker ONCE (planBody is fixed for the whole claim)
  // via the SAME reader build-index's collectPlans uses, so the committed bullet equals a
  // later regen by construction (plan 990). writeArtifacts closes over this `meta`.
  const meta = parsePlanMeta(planBody, { seedLane });
  // --seed-write is advisory now. When the seed lane is active and the flag disagrees with
  // the body banner, WARN — so a forgotten or contradicting banner is loud at mint time
  // rather than a SILENT 🟥→🟩 downgrade that mis-signals the LANDING mutex (mirrors the
  // --blurb WARN above). The body banner, not --seed-write, stays the single source of truth.
  // plan 3961 review fix: a repo configuring a different mutationBanner.flag (e.g.
  // --data-write) gets the SAME advisory check under its own flag name, IN ADDITION TO
  // --seed-write (never instead of it — main()'s parser accepts both). --seed-write wins
  // when both are passed; the configured flag is read only as a fallback.
  const mutationBannerFlagKey = mutationBanner.flag.replace(/^--/, '');
  const seedWriteFlagPassed = flags['seed-write'] !== undefined;
  const seedWriteFlagName = seedWriteFlagPassed ? '--seed-write' : `--${mutationBannerFlagKey}`;
  const seedWriteFlagRaw = seedWriteFlagPassed
    ? flags['seed-write']
    : mutationBannerFlagKey !== 'seed-write'
      ? flags[mutationBannerFlagKey]
      : undefined;
  const seedWriteFlag = seedWriteFlagRaw ? String(seedWriteFlagRaw).toLowerCase() : null;
  // endsWith, not ===: the marker may carry a plan-2328 ⚡ priority prefix (`⚡🟥`).
  if (seedLane && seedWriteFlag && (seedWriteFlag === 'yes') !== meta.marker.endsWith('🟥')) {
    console.error(
      `next-plan-id: WARN ${seedWriteFlagName} ${seedWriteFlag} disagrees with the body ` +
        `SEED-WRITE banner (bullet marker ${meta.marker}) — fix the body banner if the marker ` +
        `is wrong; the banner, not ${seedWriteFlagName}, drives the INDEX bullet + the landing ` +
        `lane.`,
    );
  }
  const env = { ...process.env, HUSKY: '0' };

  let current = null; // { id, relPath } of the attempt's written artefacts
  // plan 989: the working tree the artefacts are materialised in. Set per attempt by
  // tryCommitPush's withCoordCheckout to the DISPOSABLE coord-checkout; defaults to mainDir (only
  // reached on the COORD_MAIN_DIR short-circuit, where mainDir IS the isolated finish tree).
  let workdir = mainDir;

  const cleanup = () => {
    if (!current) return;
    // plan 989: when the artefacts were written in the disposable coord-checkout, the NEXT attempt's
    // resolveCoordCheckout `reset --hard` discards them — and touching that shared tree HERE (in
    // allocatePlanId's catch, OUTSIDE the coord-write lock) would race a sibling. So skip the manual
    // rollback; only the COORD_MAIN_DIR finish-worktree (no reset, single-session) still needs it.
    if (process.env.COORD_MAIN_DIR) {
      // Unstage first — a failure between `add` and a successful commit can leave this attempt's
      // plan file + INDEX edit staged; without this the next retry starts with a dirty index.
      try {
        gitWithLockRetry(workdir, ['restore', '--staged', current.relPath, 'docs/INDEX.md']);
      } catch {
        /* nothing staged → fine */
      }
      const abs = join(workdir, current.relPath);
      if (existsSync(abs)) rmSync(abs);
      // revert any uncommitted INDEX edit from this attempt
      try {
        gitWithLockRetry(workdir, ['checkout', '--', 'docs/INDEX.md']);
      } catch {
        /* INDEX may be unchanged */
      }
    }
    current = null;
  };

  // (Re)materialise this attempt's artefacts: the plan file + its INDEX bullet.
  // Runs inside coordWrite's mutate AFTER the fresh-base merge, so the bullet is
  // re-applied on top of the freshened INDEX (the merge can revert an earlier
  // edit). Idempotent for a given `current.id`.
  const writeArtifacts = () => {
    const { id, relPath, filename } = current;
    // Fast-forward dup guard (plan 777): coordWrite has just freshened the tree
    // onto origin/master, so a sibling's same-id claim that landed in our
    // read→push window is now visible here. If any tracked plan file OTHER than
    // ours already carries this id, bump rather than push a duplicate. Surfaced
    // as `idTaken`; tryCommitPush converts it to the nonFastForward bump signal.
    // `-z` (NUL-delimited) emits pathnames VERBATIM — without it git C-quotes any
    // path with a quote/backslash/control/non-ASCII byte (`"230-Other-x\"y.md"`),
    // which the bare regex would miss → a false-negative dup slips through.
    const tracked = git(workdir, ['ls-files', '-z', '--', 'docs/superpowers/plans'])
      .split('\0')
      .filter(Boolean);
    if (idTakenByOther(tracked, id, relPath)) {
      const e = new Error(
        `next-plan-id: id ${id} was taken by a sibling claim (fast-forward dup race) — bumping`,
      );
      e.idTaken = true;
      throw e;
    }
    // Layer 2 slug-dup guard (plan 882): a same-category+slug sibling that landed
    // in our read→push window is now visible in the freshened tree. Unlike idTaken
    // (bump to a free id), a slug match means the PLAN already exists — bumping
    // would just re-create the duplicate, so HARD-ABORT (a plain error, NOT the
    // nonFastForward bump signal). The operator re-runs and Layer 1 returns the
    // existing id idempotently.
    const slugHit = findExistingSlugPlan(tracked, category, slug, relPath);
    if (slugHit) {
      throw new Error(
        `next-plan-id: category+slug "${category}-${slug}" already exists at ${slugHit} ` +
          `(slug-dup race) — refusing to author a duplicate. Re-run claim to get the existing id.`,
      );
    }
    // ready/ vanishes whenever the last ready plan is picked up (git drops
    // empty dirs) — without this the claim dies ENOENT (2026-06-12).
    mkdirSync(dirname(join(workdir, relPath)), { recursive: true });
    writeFileSync(join(workdir, relPath), planBody);
    const indexPath = join(workdir, 'docs', 'INDEX.md');
    // plan 990: the bullet's summary + marker come from `meta` (parsed from the plan body
    // above via the SAME reader build-index's collectPlans uses), rendered through
    // build-index's own renderBullet — so the committed bullet is byte-identical to what a
    // later `build-index` regen emits. blurb-vs-summary can then NEVER drift INDEX (the
    // 987/988 drift that stalled the 972 land). Never re-roll a `${blurb}` template here, or
    // the fix just moves the drift.
    const bullet = renderBullet({
      marker: meta.marker,
      summary: meta.summary,
      status: mintFolder,
      basename: filename,
    });
    const nextIndex = addBullet(readFileSync(indexPath, 'utf8'), bullet);
    // Refuse to commit a non-canonical INDEX (plan 475) — fail loudly here rather than
    // push drift that trips the next session's build-index --check push gate.
    assertGeneratedRegionCanonical(nextIndex);
    // Belt-and-suspenders (plan 990): the bullet that LANDED must still carry the body's
    // summary + marker. True by construction above; assert it so a future re-rolled-template
    // regression (e.g. reverting to `${blurb}`) fails the mint loudly instead of silently
    // shipping the next blurb/summary drift.
    const landed = nextIndex
      .split('\n')
      .map((l) => parseGeneratedBullet(l))
      .find((r) => r && r.basename === filename);
    if (!landed || landed.summary !== meta.summary || landed.marker !== meta.marker) {
      throw new Error(
        `next-plan-id: INDEX bullet for ${filename} drifted from the plan body summary/marker — ` +
          `refusing to mint INDEX drift (plan 990)`,
      );
    }
    writeFileSync(indexPath, nextIndex);
    // Belt-and-suspenders (plan 1362, D2): the mint filename was already computed
    // (in onPick) to carry the FABLE- segment whenever planBody's execModel is
    // fable — this re-confirms the written file agrees, via the SAME check the
    // pre-push lint runs. Should be unreachable now that ensureExecModelForCategory
    // (plan 1561) backfills execModel to match a FABLE- category at planBody
    // construction time — a throw here means a genuine residual conflict (e.g. the
    // body explicitly set execModel to something other than fable). `writeArtifacts`
    // runs inside the DISPOSABLE coord-checkout (plan 989): a throw here discards
    // that checkout before it is ever committed/pushed, so `relPath` never lands on
    // any real branch — findExecModelDrift's message (baked in by
    // assertExecModelFilenameOk) still suggests `stamp-exec-model.mjs <basename>
    // fable`, which is only valid for an ALREADY-LANDED plan file; reframe it here so
    // the mint failure doesn't send the caller chasing a file that was never written.
    try {
      assertExecModelFilenameOk(relPath, planBody);
    } catch (e) {
      throw new Error(
        `next-plan-id: mint of ${relPath} was rolled back (the disposable coord-checkout is ` +
          `discarded on this throw — the suggested stamp-exec-model.mjs command below will report ` +
          `"no plan matches"). Fix the --body frontmatter (or --category) and re-run claim instead:\n` +
          `${e.message}`,
      );
    }
    // plan 2378 step 2: the LAST thing mutate() does — board invariants against the
    // post-mutation tree, because the push coordWrite is about to make runs NO git hooks
    // (mechanism in board-write-gate.mjs's header). This is the gate that plans 2373 and
    // 2375 walked straight past on 2026-07-25: each was minted in a SINGLE commit already
    // carrying `stage: specced` into pending-approval/, three weeks after that invariant
    // landed (dfa892aae5, 2026-07-04) — and the failure surfaced hours later on an
    // unrelated docs-only push from a real checkout, which could not land until both were
    // hand-corrected. Note the class is NOT cloud-specific: 2373 was authored by a cloud
    // session, 2375 locally.
    //
    // A throw here discards the disposable coord-checkout before any commit or push, so
    // the rejected mint never lands on any branch — the same rollback contract the
    // assertExecModelFilenameOk arm above relies on. The mint's own id reservation is
    // likewise never pushed, so no id is burned.
    assertBoardInvariants(workdir, [relPath], { tool: 'next-plan-id claim' });
  };

  // onPick only RECORDS the attempt's id/path; coordWrite's mutate is the sole
  // writer. Writing here too would leave a dirty INDEX before coordWrite's
  // opening `merge --ff-only`, which would then refuse to advance — wedging every
  // retry on a stale base. Keeping the tree clean between attempts is what lets
  // the fresh-base merge land.
  //
  // plan 1362 (D2; generalized to `sol` by plan 3341): mint the filename WITH its
  // FABLE-/SOL- segment from the start when planBody's (already-finalized) execModel is
  // a segment-bearing lane — reusing renameForExecModel (the SAME transform
  // stamp-exec-model.mjs's manual CLI uses, D4) so the mint never needs a follow-up
  // rename. planBody is fixed for the whole claim (computed once above), so this is
  // stable across every retry attempt; only `id` varies per attempt.
  //
  // plan 3341 fix: before this, the check was hardcoded to `=== 'fable'` only, so a body
  // carrying `execModel: sol` under a PLAIN category (no `SOL-` prefix baked into the
  // category text itself) minted a filename with NO marker at all — a mismatch the
  // pre-push drift lint would then hard-block on the very next unrelated push. Confirmed
  // via a direct probe against the pre-fix code (`onPick` returning
  // `230-Other-<slug>.md` for an `execModel: sol` body under `--category Other`) before
  // writing this fix. `EXEC_MODELS_WITH_SEGMENT` names the two lanes renameForExecModel
  // actually has a marker for. Plan 3341 review round 3 (key 0dff51): this used to be a
  // hardcoded `['fable', 'sol']`, mirrored from exec-model-stamp.mjs's module-private
  // MARKER_FOR_TARGET. That list going stale is a real failure: a recognized new lane with a
  // plain category would mint an UNMARKED filename here, which the drift lint then rejects at
  // close-out — the successor plan cannot be created and the operator has no way to clear it
  // from this side. Derived from LANE_SEGMENTS (the one place a marker string is spelled) so a
  // fourth segment-bearing lane needs no edit here at all.
  //
  // `sonnet` and any unrecognized value fall through UNCHANGED, which is deliberately
  // asymmetric: it never STRIPS a category-embedded marker just because the
  // (already-validated) execModel disagrees toward a non-segment-bearing lane, so a genuine
  // category-vs-frontmatter conflict still surfaces at assertExecModelFilenameOk below
  // instead of being silently papered over.
  const EXEC_MODELS_WITH_SEGMENT = LANE_SEGMENTS.map(({ lane }) => lane);
  const onPick = (id) => {
    const baseFilename = `${id}-${category}-${slug}.md`;
    const execModel = readExecModel(planBody);
    const filename = EXEC_MODELS_WITH_SEGMENT.includes(execModel)
      ? renameForExecModel(baseFilename, execModel)
      : baseFilename;
    current = { id, relPath: `docs/superpowers/plans/${mintFolder}/${filename}`, filename };
    return { cleanup };
  };

  const tryCommitPush = (id) => {
    const { relPath } = current;
    const msg = `docs(plans): add ${id}-${category}-${slug} (race-safe ID claim)`;
    // coordWrite owns freshen → mutate → pathspec-commit (with the Coord-Write
    // trailer) → push, and reverts our paths on a non-ff. attempts:1 = single
    // shot: a non-ff here means the id was taken by a sibling, so we surface it as
    // the nonFastForward signal and let allocatePlanId bump the id + retry. The
    // per-378 fresh-base recovery is now coordWrite's opening fetch+merge, no
    // longer duplicated here.
    try {
      // plan 989: author the plan + INDEX in the DISPOSABLE coord-checkout (under the coord-write
      // lock), never the shared MAIN tree — so a session's uncommitted code edit can never block a
      // mint (the 989-mint refusal). writeArtifacts materialises into `workdir` (= cdir here).
      withCoordCheckout(mainDir, (cdir) => {
        workdir = cdir;
        coordWrite(cdir, {
          relPaths: [relPath, 'docs/INDEX.md'],
          mutate: writeArtifacts,
          message: msg,
          tool: 'next-plan-id',
          attempts: 1,
        });
      });
    } catch (e) {
      // A sibling landed our id as a clean fast-forward (writeArtifacts threw
      // idTaken) OR origin advanced and the push was non-ff: both mean "this id
      // is no longer free" → surface the bump signal so allocatePlanId re-scans
      // + retries on the next id. (plan 777 added the idTaken arm — the non-ff
      // arm alone missed the ff-dup window.)
      if (e.idTaken || isNonFastForward(e) || (e.cause && isNonFastForward(e.cause))) {
        const nf = new Error(e.idTaken ? 'id-taken (ff-dup race)' : 'non-ff');
        nf.nonFastForward = true;
        throw nf;
      }
      throw e;
    }
  };

  return {
    scanIds: () => nextIdFromRepo(mainDir, { fromOrigin: true }),
    onPick,
    tryCommitPush,
    // Exposed for doClaim's Layer-1 pre-flight (plan 882): the slug-dup guard needs
    // the resolved category/slug and the post-ensureReadyStatusLine body to compare.
    category,
    slug,
    planBody,
    // Review fix round (4071 T2): the SAME planCategories this function already resolved
    // ONE config load ago (see the plan-4071 comment at the top of this function) — exposed
    // so doClaim's evidence-floor gate reuses it instead of a second loadCoordConfig(mainDir)
    // call. A concurrent coord.config.json edit between two separate reads inside ONE claim
    // could otherwise let category validation (here) and the evidence-floor gate (doClaim)
    // disagree about the SAME invocation's policy.
    planCategories,
    // R5: exposed so doClaim can run the evidence-floor gate itself, AFTER the idempotent
    // re-claim short-circuit — see the R5 comment above this function's evidence-flag handling.
    mintFolder,
    placeholderBasename,
    // Round 3 fix: exposes onPick's own `current.filename` (the REAL minted basename, already
    // carrying any FABLE- segment onPick applied) so a post-allocation caller can name the
    // ACTUAL file instead of re-deriving the `${id}-${category}-${slug}.md` shape itself —
    // a re-derivation that silently drops the FABLE- segment onPick adds when the plan body's
    // execModel is fable (round-3 finding). A closure accessor, not a plain field, because
    // `current` is only populated once onPick has run for the winning attempt.
    mintedFilename: () => current?.filename,
  };
}

// A `claim` = Layer-1 pre-flight (idempotent re-claim / slug-collision hard-fail)
// then the optimistic-concurrent allocate loop. `idempotent: true` means an
// identical plan already existed and we returned its id without authoring a second.
// `async` so the return is uniformly a Promise regardless of which branch is taken
// (the idempotent branch returns a plain object; without async a caller that forgot
// to await would get a Promise on one path and an object on the other). Exported
// (review fix round, 4071 T2) so a test can pin the single-config-read invariant this
// function and buildClaimOps now share (`ops.planCategories`, never a second
// loadCoordConfig(mainDir) call) — previously the CLI was the only caller and tests
// exercised buildClaimOps/allocatePlanId directly, which cannot observe a discrepancy
// between the two functions' own independent config reads. `config`, when given, is an
// ALREADY-LOADED snapshot (review fix round 2, finding 65b196) that this call passes straight
// through to buildClaimOps instead of letting it load one of its own — see buildClaimOps' own
// comment on the parameter for why `main()` needs to resolve one before flags even exist.
export async function doClaim(mainDir, flags, config) {
  const ops = buildClaimOps(mainDir, flags, config);
  // plan 4071 (T2/D1/D2): evidenceGated comes from coord.config.json's
  // planCategories.evidenceGated (core default `[]` — no category gated) rather than the
  // removed EVIDENCE_GATED_CATEGORIES literal. Review fix round (4071 T2): reuse the SAME
  // planCategories buildClaimOps already resolved from its OWN single loadCoordConfig(mainDir)
  // call — a second independent load here could see a DIFFERENT snapshot of coord.config.json
  // than the one buildClaimOps validated --category against, if the file changed between the
  // two reads mid-claim.
  const { planCategories } = ops;
  const existing = preflightSlugGuard(mainDir, {
    category: ops.category,
    slug: ops.slug,
    planBody: ops.planBody,
  });
  if (existing) return { id: existing.id, attempts: 0, idempotent: true };
  // plan 3999 review fix round 1 (key 8116d5): refuse a mint whose FINAL planBody carries a
  // broken `priority:`/`priorityBy:` pairing — run AFTER the idempotent-re-claim short-circuit
  // just above, exactly like the evidence-floor gate below, and for the SAME reason: this used
  // to live in buildClaimOps, which has no knowledge of origin state, so a RE-claim of an
  // already-filed plan carrying a bare `priority: high` (one of the ten grandfathered plans, say)
  // was wrongly refused instead of returning the existing id. Unlike the evidence-floor gate,
  // this runs for EVERY mint folder (not only `--ready`) — a `priority: high` stamp is exactly as
  // illegitimate un-authorized in pending-approval/ as it is in ready/, so there is no folder this
  // gate can skip. Still fails BEFORE any id is reserved / writeArtifacts runs on a genuine fresh
  // mint — nothing below this point has executed yet. Uses the SAME shared validator
  // (priorityStampProblem, build-index-lib.mjs) the push-time lint (lint-plan-priority.mjs's
  // findUnbackedHigh) uses, and the SAME shared fix-sentence builder (priorityStampFixHint), so
  // the two can never disagree about what counts as a violation or how to fix it. Deliberately NO
  // allowlist here, unlike the lint: a fresh mint is never grandfathered — the ten-plan
  // grandfathering is a dated, lint-only escape hatch for the EXISTING corpus (see
  // BARE_HIGH_GRANDFATHERED_2026_09_13, lint-plan-priority.mjs), and admitting a brand-new bare
  // `high` here would just grow that corpus instead of letting it shrink to zero at the operator
  // sitting.
  {
    const problem = priorityStampProblem(ops.planBody);
    if (problem === 'stale-priorityBy') {
      throw new Error(
        `next-plan-id: refusing to mint with a \`priorityBy:\` stamp on a plan whose priority ` +
          `is not high — that is a stale leftover. Remove the \`priorityBy:\` line, or set ` +
          `\`priority: high\` if that was intended.`,
      );
    }
    if (problem === 'unbacked-high' || problem === 'bad-priorityBy-value') {
      const tier = readPriorityTier(ops.planBody);
      const hint = priorityStampFixHint(problem, tier);
      const demoteSuffix = hint.demoteApplicable ? ', or drop back to `priority: medium`' : '';
      if (problem === 'unbacked-high') {
        throw new Error(
          `next-plan-id: refusing to mint with priority: high and no priorityBy: — the stamp ` +
            `must be operator-set, never the authoring session's own call. Fix: ` +
            `${hint.guidance}${demoteSuffix}.`,
        );
      }
      const rawBy = readPriorityBy(ops.planBody);
      const shown = rawBy ? `\`priorityBy: ${rawBy}\`` : '`priorityBy:` (present, no value)';
      throw new Error(
        `next-plan-id: refusing to mint with ${shown} — does not parse. Fix: ` +
          `${hint.guidance}${demoteSuffix}.`,
      );
    }
  }
  // plan 1260: gate the banner ONLY on a genuine FRESH mint into ready/ — AFTER the
  // idempotent short-circuit above, so a re-claim of an already-existing (bannerless)
  // plan stays the safe no-op it always was, never a hard throw (it never actually enters
  // ready/ on that path). A --ready mint lands the plan DIRECTLY in ready/, where the drain
  // reads it and lint-plan-cost-forecast enforces a parseable banner repo-wide; the SAME
  // shared gate move-plan + the lint use catches a bannerless one at mint time rather than
  // as a push-blocking lint failure for the next unrelated pusher. Default pending-approval/
  // is exempt — the drain never reads pending-approval/; a stub is fleshed out (or bounced
  // back by spec-pass, D9) before it is released.
  if (flags.mintFolder === READY_FOLDER) {
    // Review fix round (2943+2944, R5): the evidence-floor refusal — moved here from
    // buildClaimOps so it runs AFTER the idempotent-re-claim short-circuit just above (an
    // already-filed `evidence: latent` plan re-claims as a clean no-op, exactly like every other
    // claim path already treats a re-claim, instead of being wrongly refused).
    assertEvidenceFloorOk(
      READY_FOLDER,
      ops.planBody,
      ops.placeholderBasename,
      planCategories.evidenceGated,
      'next-plan-id',
    );
    const msg = readyCostBannerError(
      `${ops.category}-${ops.slug}.md`,
      ops.planBody,
      'next-plan-id: a --ready mint requires a parseable 💰 Cost forecast banner in the plan ' +
        'body (it enters ready/, which the autonomous drain reads and lint-plan-cost-forecast ' +
        'gates repo-wide). Add one, then re-mint:',
    );
    if (msg) throw new Error(msg);
    // plan 1292 bugfix: `claim --ready` used to skip the stage/specReview gate entirely —
    // move-plan.mjs's assertSpecReviewOk only runs on a pending-approval/ → ready/ PROMOTE, so a
    // `--ready` mint went straight into ready/ with a fresh `stage: stub` (ensureStageFrontmatter
    // always stamps that unless the --body already carries a `stage`/`specReview` key) and NO
    // spec-pass had ever challenged it — an unreviewed stub the autonomous drain could pick up
    // immediately. Run the SAME shared gate move-plan uses, against the FINAL stamped body
    // (ops.planBody, post ensureStageFrontmatter/ensureSummaryFrontmatter), so a bare `--ready`
    // mint now refuses just like a bare promote would.
    const specMsg = specReviewGateError(
      `${ops.category}-${ops.slug}.md`,
      ops.planBody,
      'next-plan-id: refusing a --ready mint —',
    );
    if (specMsg)
      throw new Error(
        `${specMsg} Mint to the default (pending-approval/) instead and promote via move-plan ` +
          `after /spec-pass.`,
      );
  }
  const result = await allocatePlanId(ops);
  if (flags.mintFolder === READY_FOLDER) {
    // Plan 2973 fix round 2 (review): a `--ready` mint writes DIRECTLY into ready/ — a FOURTH
    // ready/-entry point the cloudExecUnstampedWarning composer's three original call sites
    // (move-plan.mjs's promote path, done-worktree.mjs's 6b close-out promoter,
    // stamp-exec-model.mjs's post-stamp check) all miss, so a plan minted here without a
    // cloudExec: stamp lands cloud-invisible with nothing said. Unlike a `waiting-*` route —
    // where an absent stamp is the normal mid-4c state, still catchable by a LATER step in the
    // same flow — a `--ready` mint goes STRAIGHT to the autonomous drain queue, so there is no
    // later step to catch it here. WARN only, same contract as the composer's other three call
    // sites: never throw, never change the exit code, never gate the mint.
    //
    // MUST run AFTER allocatePlanId, not before (round-1 bug): `ops.placeholderBasename` is
    // literally `000-${category}-${slug}.md` (see its own comment above, in buildClaimOps) —
    // it exists only to probe PLAN_FILENAME_RX before a real id is allocated. Warning off it
    // pre-allocation baked the string "000" into the remediation command
    // (`node scripts/stamp-cloud-exec.mjs 000 true`), naming a plan that never exists.
    //
    // Round-3 fix: the real basename is NOT re-derived here as `${result.id}-${category}-
    // ${slug}.md` — that reconstruction silently dropped the FABLE- segment onPick (above)
    // mints into the filename whenever the plan body's execModel is fable, so the warning
    // named a file (`NNNN-Cat-slug.md`) that never existed on disk (the real one was
    // `NNNN-FABLE-Cat-slug.md`). Read the ACTUAL minted filename off `ops.mintedFilename()` —
    // onPick's own closure variable, exposed by buildClaimOps for exactly this — so this
    // warning can never drift from onPick's FABLE- handling again. After a successful
    // allocatePlanId, onPick has always run and `current` is populated; the truthiness guard
    // below is belt-and-suspenders only — if it were ever undefined, skip the warning
    // silently (never throw, never change the exit code) rather than print a wrong name.
    const realBasename = ops.mintedFilename();
    if (realBasename) {
      const cloudExecWarn = cloudExecUnstampedWarning(realBasename, ops.planBody);
      if (cloudExecWarn) console.error(`next-plan-id: WARN — ${cloudExecWarn}`);
    }
  }
  return result;
}

// plan 1022 (A), reworded by plan 1371 (D2/D4/D9): a loud banner printed (to STDERR —
// stdout stays the bare id) after a successful mint. The default pending-approval/ mint is
// NOT auto-drainable; a --ready mint IS auto-drainable immediately. Either way the message
// hammers the one rule the 2026-06-23 plan-1013 incident broke: claim via pickup-plan, NEVER
// `git worktree add` by hand. Since plan 1371, the DEFAULT branch no longer frames this as a
// same-session decision to make — pending-approval/ is the sanctioned resting spot (D4); a
// board-pass/spec-pass is the normal exit, `pickup-plan` remains a legitimate override. What
// the banner DOES press on now (D9): context is cheapest at mint time, so write the fullest
// plan body you can before you move on — a thin stub costs the board-pass reviewer far more
// to reconstruct later, and spec-pass bounces a skeletal body back with a 'thin mint' note
// instead of finishing the draft for you.
export function mintBanner(id, mintFolder) {
  const bar = '='.repeat(74);
  if (mintFolder === READY_FOLDER) {
    return [
      '',
      bar,
      ` next-plan-id: plan ${id} minted into ready/ — it IS auto-drainable by the`,
      ' autonomous orchestrator RIGHT NOW (you passed --ready).',
      ` • If YOU intend to work plan ${id}, claim it via pickup-plan immediately.`,
      ' • NEVER run `git worktree add` by hand — that skips the claim (plan-1013 race).',
      bar,
      '',
    ].join('\n');
  }
  return [
    '',
    bar,
    // Shared template (mint-lines.mjs) — kept for transcript-scrape callers; reword it
    // THERE, never inline here.
    ` ${MINT_BANNER_LINE(id)}`,
    ' pending-approval/ is the sanctioned resting spot (plan 1371) — a board-pass reviews +',
    ' routes it; you do NOT need to route it yourself this session. Write the FULLEST plan',
    ' body you can RIGHT NOW while your context is cheapest — problem + evidence, concrete',
    ' file paths, a candidate design, open questions listed explicitly (D9) — a thin stub',
    ' costs the reviewer far more to reconstruct later, and spec-pass bounces one back.',
    `   • Working it yourself right now?  ->  pickup-plan ${id}   (promotes pending-approval/ -> in-progress/)`,
    `   • Already fully specced?          ->  node scripts/move-plan.mjs ${id} ready`,
    ' NEVER `git worktree add` by hand — that skips the claim (the plan-1013 race).',
    bar,
    '',
  ].join('\n');
}

async function main() {
  // plan 1777: the shared spec'd parser (coord-git parseFlags, plan 1769) replaces the
  // value-only parseArgs + its `--ready` argv pre-strip — `--ready` (plan 1022: mint into
  // ready/ instead of the default pending-approval/, plan 1371) is a real boolean now,
  // and an unknown flag throws instead of being silently swallowed (a typo'd
  // `--seed-wrte yes` used to mint with the default seed-write banner). `subcommand: true`
  // semantics live in parse-flags.mjs's header; the property THIS caller depends on is
  // that a flag-shaped leading token comes back as cmd verbatim, so a malformed invocation
  // hits the loud unknown-command exit below and can NEVER fall through to the silent
  // 'peek' default and print an id without minting (review 1777 [1]).
  // plan 3961 review fix: resolveMain() FIRST — the CLI's accepted --value flags below now
  // include coord.config.json's mutationBanner.flag (stripped of its leading --), so the config
  // must be readable before parseFlags runs. resolveMain() never looks at argv (env-var override,
  // else `git worktree list`), so moving it ahead of parseFlags changes nothing about the loud
  // unknown-flag guarantee the comment above describes.
  // Review fix round 2 (4071, finding 65b196): routed through the `_loadConfig` counting seam
  // and the resulting snapshot is threaded down into `doClaim` (below) rather than loaded again
  // there — this read used to be a bare `loadCoordConfig(mainDir)` call sitting on top of
  // buildClaimOps' own load, the exact cross-read hazard the 4071-T2 fix closed one call frame
  // in, just one frame further out.
  const mainDir = resolveMain();
  const config = _loadConfig(mainDir);
  const { mutationBanner } = config;
  const mutationBannerFlagKey = mutationBanner.flag.replace(/^--/, '');
  // This CLI's fixed flag table. Kept as two named consts (rather than inlined straight into
  // the parseFlags() call below) so the collision check right after it can derive its reserved
  // set FROM these two lists — never a hand-copied name list that a future built-in flag
  // addition could silently fall out of sync with.
  const FIXED_VALUE_FLAGS = ['category', 'slug', 'body', 'blurb', 'seed-write', 'date', 'evidence'];
  const FIXED_BOOLEAN_FLAGS = ['ready'];
  // Review round 3 (4071, key 11ac94): a project config whose mutationBanner.flag names one of
  // this CLI's OWN fixed flags (e.g. `--ready`) used to reach parseFlags() below with that name
  // pushed into the value list while it was ALSO declared boolean — parseFlags throws "declared
  // as both value and boolean (ambiguous spec)" before any subcommand (peek/claim) can dispatch,
  // taking down the whole CLI for that repo. Catch it here instead, as a loud, named config
  // error, before the collision ever reaches parseFlags. `seed-write` is exempt: it is the one
  // name a configured flag is INTENDED to coincide with (see the migration comment below), so
  // both are accepted side by side rather than rejected as a collision.
  if (mutationBannerFlagKey !== 'seed-write') {
    const reservedFlagNames = new Set([...FIXED_VALUE_FLAGS, ...FIXED_BOOLEAN_FLAGS]);
    if (reservedFlagNames.has(mutationBannerFlagKey)) {
      throw new Error(
        `coord.config.json's mutationBanner.flag ("--${mutationBannerFlagKey}") collides with ` +
          `this CLI's built-in --${mutationBannerFlagKey} flag — choose a different ` +
          `mutationBanner.flag name`,
      );
    }
  }
  const valueFlags = [...FIXED_VALUE_FLAGS];
  // A repo that configures a different mutationBanner.flag (e.g. --data-write) must be able to
  // pass it without parseFlags throwing "unknown flag" — accepted IN ADDITION TO --seed-write,
  // never instead of it, so a repo mid-migration between the two names has both accepted.
  if (mutationBannerFlagKey !== 'seed-write') {
    valueFlags.push(mutationBannerFlagKey);
  }
  const { cmd, flags } = parseFlags(process.argv.slice(2), {
    label: 'next-plan-id',
    subcommand: true,
    value: valueFlags,
    boolean: FIXED_BOOLEAN_FLAGS,
  });
  flags.mintFolder = flags.ready === true ? READY_FOLDER : PENDING_APPROVAL_FOLDER;
  const sub = cmd || 'peek';

  if (sub === 'peek') {
    console.log(nextIdFromRepo(mainDir, { fromOrigin: true }));
    return 0;
  }
  if (sub === 'claim') {
    const { id, attempts, idempotent } = await doClaim(mainDir, flags, config);
    if (idempotent) {
      console.error(
        `next-plan-id: plan ${flags.category}-${flags.slug} already exists as ${id} — ` +
          `returning existing id (idempotent re-claim, no new file)`,
      );
      // plan 1022: a re-claim does NOT move an existing plan, so `--ready` on an
      // already-minted draft is a silent no-op (the release valve is move-plan, not
      // re-claim). Say so loudly rather than let the operator believe the draft was released.
      if (flags.mintFolder === READY_FOLDER)
        console.error(
          `next-plan-id: WARN --ready had NO effect — plan ${id} already exists and was not moved. ` +
            `To release an existing draft to the orchestrator, run: node scripts/move-plan.mjs ${id} ready`,
        );
    } else {
      // Shared template (mint-lines.mjs) — see mint-lines.mjs header for why
      // this line is centralized there instead of inlined here.
      console.error(CLAIMED_LINE(id, attempts));
      console.error(mintBanner(id, flags.mintFolder));
    }
    console.log(id);
    return 0;
  }
  console.error(`next-plan-id: unknown command "${sub}" (use peek | claim)`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('next-plan-id:', e.message);
      process.exit(2);
    },
  );
}
