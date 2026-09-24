#!/usr/bin/env node
// scripts/coord/stamp-lib.mjs — the ONE atomic frontmatter-axis stamp core (plan 1797).
//
// stamp-exec-model.mjs (plan 1292) and stamp-cloud-exec.mjs (plan 1781) each carried a
// verbatim copy of the same ~55-line atomic coord-checkout stamp spine: snapshot bytes →
// mutate → pathspec commit with the Coord-Write trailer → push (masterPushSpec) → on ANY
// throw, path-scoped rollback (`reset --soft HEAD~1` + per-path resets + byte-exact
// restore) with non-ff detection for withRetry. That push/rollback path has been re-fixed
// repeatedly (plans 868, 492, 989) — every fix had to be applied and tested TWICE, and the
// next `stamp-<axis>` tool (stage/specReview are candidates) would have copy-pasted a
// third time. This module extracts the spine once; the per-axis tools keep only their CLI
// surface, their pure body-mutation helpers, and their output lines, and delegate the
// atomic core here via closures.
//
// stampFrontmatterAxis(opts) — resolve the plan, stamp it, commit + push atomically.
//   tool          — the CLI's name ('stamp-exec-model' | 'stamp-cloud-exec' | a future
//                   stamp-<axis>): prefixes every error, names the Coord-Write trailer,
//                   and attributes the assertStampableStatus refusal (plan-1781 review
//                   finding [3] — the hardcoded prefix misattributed a stamp-cloud-exec
//                   refusal to stamp-exec-model).
//   idOrName      — plan id or basename, resolved via resolvePlanRel(lsPlans(...)) among
//                   pending-approval/, ready/, waiting-*/ (in-progress/ and archive/ are
//                   REFUSED — assertStampableStatus, before any filesystem mutation: the
//                   plan-486 discipline that a disallowed status must never strand a
//                   half-applied rename).
//   dry           — print the planned ops (dryPreview lines + the shared regen/commit/push
//                   tail) and mutate nothing.
//   renameFor     — optional (basename) => newBasename, computed in the producer and
//                   applied via `git mv` before the body mutation (stamp-exec-model's
//                   FABLE- filename mirror). Omit for axes with no filename segment.
//   preflight     — optional (body, ctx) => void, THROW to refuse. A per-axis gate on the
//                   plan's own body (stamp-cloud-exec's plan-2151 `.claude/` gate). The lib
//                   owns only WHEN it runs; the rule itself stays in the axis tool. Three
//                   properties the axis tool cannot get by reading the plan itself, and the
//                   reason this hook exists rather than a pre-check in the CLI (plan 2151
//                   review, findings 1-3): it runs (a) AFTER ffMasterFromOrigin, so the body
//                   is the ff-synced copy inside the coord checkout, never MAIN's possibly
//                   stale working tree; (b) AFTER assertStampableStatus, so an in-progress/
//                   or archive/ plan gets the STATUS refusal rather than a misleading
//                   axis-gate one; (c) BEFORE the --dry branch and before any mutation, so a
//                   dry run reports the same refusal a real stamp would and a refusal can
//                   never strand a half-applied change. A throw here carries no
//                   `nonFastForward`, so withRetry rethrows it immediately.
//   postPush       — optional (ctx, result) => void, called ONCE after master's push succeeds,
//                   never on --dry. Plan 3919 puts cross-ref mutation here because preflight is
//                   re-entered after a non-ff race and sits outside rollback: mutating there could
//                   leave "origin renamed but the plan file was not." Durable plan bytes come
//                   first; dependent remote refs follow while the same guarded attempt still owns
//                   the failure boundary.
//   mutateBody    — (body, ctx) => newBody. The axis's whole content edit (frontmatter
//                   upsert + any body banner work), pure string→string.
//   commitSubject — (ctx) => the one-line commit subject; the lib appends the
//                   `Coord-Write: <tool>` trailer.
//   dryPreview    — (ctx) => string[] of axis-specific `[dry]` lines (set-key lines, the
//                   git-mv/no-rename line, banner lines). The lib prints them, then the
//                   shared `[dry] regenerate docs/INDEX.md` (when regenIndex) /
//                   `[dry] commit:` / `[dry] git push` tail.
//   regenIndex    — regenerate docs/INDEX.md in-process inside the same commit, roll it
//                   back on failure, and run the post-push healIndexDrift pass
//                   (stamp-exec-model: the FABLE- rename can move the INDEX bullet's
//                   path token; stamp-cloud-exec: cloudExec never feeds the bullet, so
//                   it skips all three).
//   healLabel     — optional (ctx) => string label for the post-push healIndexDrift
//                   commit (regenIndex only; defaults to commitSubject(ctx)).
//
// ctx (built by the withRetry producer, re-derived fresh on every non-ff retry):
//   { oldRel, newRel, basename, newBasename, status, renamed }.
// Returns that ctx plus { dry: true } or { pushed: true } — the caller prints its own
// final summary line from it.
//
// Isolation: the whole stamp runs inside withCoordCheckout (the disposable
// `.claude/coord-worktree` shadow move-plan uses, plan 989) with COORD_MAIN_DIR pointed
// at it, so resolveMain()/masterPushSpec()/ffMasterFromOrigin() inside the retry operate
// on the isolated tree — the stamp lands in the coord-checkout and pushes to origin,
// never touching MAIN.

import { readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveMain,
  gitWithLockRetry,
  git,
  withRetry,
  ffMasterFromOrigin,
  COORD_TRAILER,
  masterPushSpec,
  withCoordCheckout,
  isNonFastForward,
  ensureMvDestDir,
} from './coord-git.mjs';
// statusOf/PLANS_PREFIX come from move-plan.mjs too — the one source of truth for
// "which folder is this path in" (its own export rationale), never a re-rolled copy.
// plan 3973 (T2): the combined stamp+move form re-runs move-plan's OWN lane-entry gates
// and board-ref repathing rather than re-deriving them — see stampImpl's `opts.move`
// handling below and the plan's Design § T2 / Execution notes for the reuse contract.
// `assertBlockedByOk` (the --blocked-by argv-shape check) is deliberately NOT re-run
// here: it is a pure argv validation, not a body-dependent gate, and stays the CALLER's
// job (mirroring move-plan.mjs's own mainImpl, which runs it before resolveMain() even) —
// stamp-exec-model.mjs validates it in its own argv check before ever reaching this module.
import {
  lsPlans,
  resolvePlanRel,
  statusOf,
  PLANS_PREFIX,
  parseMoveTarget,
  assertTripConditionOk,
  assertUnblockOk,
  assertCostBannerOk,
  assertGrillQuestionsOk,
  assertGrillExitOk,
  assertSpecReviewOk,
  assertEvidenceFloorOk,
  syncBoardPlanRefs,
  rewriteBlockedByHeader,
  WAITING_RX,
  // plan 3973 review fix (round 2, R1 — findings e5c145/c6fc99): the claim-holder READ
  // sequence (claimedIdOfBasename → planStatus) lives in ONE place, shared with
  // move-plan.mjs's own guard, instead of a hand-duplicated copy here.
  // Round-3 review fix (finding e91eef): the MESSAGE is now built by that same module's
  // claimHolderError too — parameterized (tool/hasForceOverride/guidance) instead of this
  // module keeping a second copy (the retired combinedMoveClaimHolderError) of its
  // predicate and phrasing.
  readClaimHolderStatus,
  claimHolderError,
} from './move-plan.mjs';
// The SAME coordination-identity resolver move-plan.mjs's own guard uses, so a self-held
// claim is recognized identically by both the standalone and combined move paths.
import { coordinationSessionId } from './coord-session-id.mjs';
// The ONE authority for a claim ref's name (plan 3973 review fix) — never a hand-built
// `refs/claims/<id>` string.
import { claimRef } from './coord-refs.mjs';
// The move body-rewrite for a PROMOTION target (ready/in-progress) — the same authority
// move-plan.mjs's own promotion branch calls, imported directly from its true owner
// rather than re-exported through move-plan.mjs (no cycle: plan-body-state.mjs imports
// nothing from this file or from move-plan.mjs).
import { stampPromotedStatus, setUnblock } from './plan-body-state.mjs';
// The same board-invariant gate move-plan.mjs runs against its own post-mutation tree
// (plan 2378) — judged here against the SAME post-mutation tree, so a combined
// stamp+move can never leave a board/plan-state contradiction move-plan alone would
// have caught.
import { assertBoardInvariants } from './board-write-gate.mjs';
// The status-folder vocabulary a move target may name (never a second hand-typed list —
// VALID_TARGETS in move-plan.mjs is this plus 'archive'/'parked', which stampFrontmatterAxis's
// `opts.move` deliberately does NOT support: those two need machinery — terminal stamping,
// stale-archive-dup cleanup, and the plan-2818 "a terminal park releases its own claim" nudge —
// this combined-commit form doesn't carry. The ORDINARY claim-holder guard (plan 2082 — refuse
// a move of a plan another session holds) DOES run for every supported `opts.move` target; see
// the guard inside stampImpl's `needsPreflight` block below.
import { STATUS_ORDER } from './build-index-lib.mjs';
import { regenerateIndex, healIndexDrift } from './build-index.mjs';
import { assertStampableStatus } from './exec-model-stamp.mjs';
import { resolveConfigDir, loadCoordConfig } from './coord-config.mjs';

// The move targets `opts.move` (stampImpl, below) accepts: `ready` (a promotion) or any
// `waiting-*` lane. Deliberately excludes `pending-approval`/`in-progress` (a stamp+move
// never re-enters or freezes there) and `archive`/`parked` (terminal machinery this combined
// form doesn't replicate — see the STATUS_ORDER import comment above).
const SUPPORTED_MOVE_TARGETS = new Set(
  STATUS_ORDER.filter((s) => s === 'ready' || WAITING_RX.test(s)),
);

// Round-3 review fix (finding e91eef): the combined stamp+move claim-holder refusal now
// reuses move-plan.mjs's own claimHolderError (parameterized for exactly this) instead of
// keeping a second hand-duplicated predicate/phrasing copy (the retired
// combinedMoveClaimHolderError) — only the two things that genuinely differ for this
// tool are supplied at the call site below: `tool` (the actual --move companion's name,
// never "move-plan:") and this guidance sentence, since the combined form has NO claim
// override of its own (see stamp-exec-model.mjs's own header on why that escape hatch
// stays on the standalone tool) — the real way through is dropping --move and running
// move-plan.mjs directly, which DOES have --force.
function combinedMoveGuidance(planId, targetStatus) {
  return (
    `The combined --move form has no claim override of its own — if the move is ` +
    `operator-directed, drop --move and run \`node scripts/move-plan.mjs ${planId} ` +
    `${targetStatus ?? '<target>'} --force\` directly instead; otherwise coordinate with ` +
    `the holder, or release a dead session's claim first: node scripts/release-claim.mjs ` +
    `release ${planId} --force`
  );
}

// --- plan 3609: spec-pass cost capture (E1/E2) -----------------------------
//
// The session's own token spend at stamp time, read from its Claude Code transcript. Lives
// HERE (not stamp-exec-model.mjs) because it is a per-stamp-axis-agnostic env/fs read — a
// future stamp-<axis> tool wanting the same figure gets it for free — and it needs nothing
// this module doesn't already import (it does NOT touch git; the coord-checkout isolation
// stays entirely on the caller's side).
//
// Resolution (plan body § E1, verified on this machine 2026-09-01):
//   ${CLAUDE_CONFIG_DIR ?? ~/.claude}/projects/<any-slug>/${CLAUDE_CODE_SESSION_ID}.jsonl
// The harness does not hand a Bash-invoked script its transcript path (that's a hook-only
// stdin field); CLAUDE_CODE_SESSION_ID is this exact env var name — plan 958 found the prior
// name, CLAUDE_SESSION_ID, is unset (see claim-plan.mjs's own citation of that finding). The
// project-slug directory is named for the session's LAUNCH cwd, which is not derivable from
// process.cwd() (a worktree-launched session's slug differs from its own cwd) — so every slug
// directory under projects/ is scanned rather than computed; the session id is globally
// unique, so the scan is unambiguous by construction, i.e. it is the glob the plan specifies.
//
// ANY failure — CLAUDE_CODE_SESSION_ID unset, the projects dir missing/unreadable, no matching
// transcript file, an unparsable transcript — returns `null`, WARNs once, and never throws:
// the caller (stamp-exec-model.mjs) writes that straight through as the literal `specCost:
// null`. A missing cost must NEVER be recorded as zero — the same lesson the spec-pass-effort
// miner already learned with `bouncesKnown`: a silently-zeroed unknown renders as a
// clean-looking lie, worse than an honest "don't know".
//
// Every fs access is injectable for the same reason every other helper here is (mid-walk-race
// testability elsewhere in this repo) — a fixture transcript in a temp dir, pointed to via the
// `configDir`/`sessionId` params, is the whole test surface; no real $HOME touch needed.
//
// Review round 1 finding [2]: the $CLAUDE_CONFIG_DIR-else-~/.claude decision is NOT hand-rolled
// here — `resolveConfigDir()` (coord-config.mjs) is the seam built to stop exactly that, after
// orchestrator-budget/orchestrator-usage-refresh/orchestrate-dryrun/claim-plan each carried their
// own copy and could drift apart. `configDir` stays injectable for the fixture tests; it simply
// DEFAULTS through the shared seam instead of re-deriving it. No cycle: coord-config.mjs imports
// only coord-git.mjs, which this module already depends on (orchestrator-budget.mjs does the same).
export function resolveSpecPassCost({
  sessionId = process.env.CLAUDE_CODE_SESSION_ID,
  configDir = resolveConfigDir(),
  readdir = readdirSync,
  readFile = readFileSync,
  exists = existsSync,
  warn = (msg) => console.error(msg),
} = {}) {
  try {
    if (!sessionId) throw new Error('CLAUDE_CODE_SESSION_ID is not set');
    const projectsDir = join(configDir, 'projects');
    let slugs;
    try {
      slugs = readdir(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch (e) {
      throw new Error(`cannot read ${projectsDir}: ${e.message}`);
    }
    let transcriptPath = null;
    for (const slug of slugs) {
      const candidate = join(projectsDir, slug.name, `${sessionId}.jsonl`);
      if (exists(candidate)) {
        transcriptPath = candidate;
        break;
      }
    }
    if (!transcriptPath)
      throw new Error(`no transcript found for session ${sessionId} under ${projectsDir}`);
    const text = readFile(transcriptPath, 'utf8');
    let inSum = 0;
    let outSum = 0;
    let cacheReadSum = 0;
    let cacheWriteSum = 0;
    // Most-frequent `message.model` among the summed records — a session can switch models
    // mid-run (a fallback, an explicit /model), and the cumulative sum below does not
    // separate by model, so a single representative label is the honest amount of precision.
    const modelCounts = new Map();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        // A partial/corrupt line — most plausibly the file's own last line, mid-append by the
        // still-live session reading itself — is SKIPPED, not fatal to the whole read.
        continue;
      }
      if (!rec || rec.type !== 'assistant') continue;
      const usage = rec.message && rec.message.usage;
      if (!usage) continue;
      inSum += usage.input_tokens || 0;
      outSum += usage.output_tokens || 0;
      cacheReadSum += usage.cache_read_input_tokens || 0;
      cacheWriteSum += usage.cache_creation_input_tokens || 0;
      const model = rec.message.model;
      if (model) modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    }
    let model = null;
    let best = -1;
    for (const [m, c] of modelCounts) {
      if (c > best) {
        best = c;
        model = m;
      }
    }
    return {
      in: inSum,
      out: outSum,
      cacheRead: cacheReadSum,
      cacheWrite: cacheWriteSum,
      model,
      sessionId,
    };
  } catch (e) {
    warn(
      `stamp-lib: WARN — could not resolve spec-pass cost (${e.message}) — recording specCost: null`,
    );
    return null;
  }
}

// The literal frontmatter VALUE text for a `specCost:` line (E2): a single-quoted JSON string
// (the same quoting `summary:` uses) when `usage` (resolveSpecPassCost()'s return) is known, or
// the bare literal `null` when it is not — never a quoted `"null"`, which would read back as the
// STRING "null" rather than the YAML null every consumer expects. `usd` stays `null` until a
// committed per-model price table exists (out of scope for this plan — see its § Out of scope).
export function specCostFrontmatterValue(usage) {
  if (!usage) return 'null';
  const { in: inTok, out, cacheRead, cacheWrite, model, sessionId } = usage;
  return `'${JSON.stringify({
    in: inTok,
    out,
    cacheRead,
    cacheWrite,
    model,
    sessionId,
    cumulative: true,
    usd: null,
  })}'`;
}

// The `docs(plans): stamp <basename> <axis-specific text>` prefix every axis's own
// `commitSubject(ctx)` produces today. Stripped off when combining >1 axis (or an axis
// plus a move) into one subject, so the combined line names the plan basename once —
// falls back to the WHOLE string when an axis's subject doesn't match the expected
// shape (never silently drops information).
function stripCommitPrefix(subject, basename) {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`^docs\\(plans\\): stamp ${escaped} `);
  return rx.test(subject) ? subject.replace(rx, '') : subject;
}

// The combined commit subject for N axes + an optional move. A single axis with no move
// is BYTE-IDENTICAL to that axis's own commitSubject(ctx) — the plan's backward-
// compatibility contract for the pre-3973 single-axis call shape.
function buildCommitSubject(ctx, axes, move) {
  if (axes.length === 1 && !move) return axes[0].commitSubject(ctx);
  const parts = axes.map((axis) => stripCommitPrefix(axis.commitSubject(ctx), ctx.basename));
  if (move) {
    const renamedTo = ctx.newRel.split('/').pop();
    parts.push(
      `move ${ctx.status}/ → ${ctx.move.targetPath}/` +
        (renamedTo === ctx.basename ? '' : ` (renamed to ${renamedTo})`),
    );
  }
  return `docs(plans): stamp+move ${ctx.basename} — ${parts.join('; ')}`;
}

// healIndexDrift's label: the LAST axis that declares one (mirrors the old
// per-tool default of "this axis's own label"), else the combined commit subject.
function buildHealLabel(result, axes) {
  for (let i = axes.length - 1; i >= 0; i--) {
    if (axes[i].healLabel) return axes[i].healLabel(result);
  }
  return buildCommitSubject(result, axes, result.move);
}

// The move's own body rewrite (T2): a waiting-*/ target gets the Blocked-by header (+
// unblock for waiting-operator/), exactly `rewriteBlockedByHeader`/`setUnblock` — the
// SAME authorities move-plan.mjs's own waiting-*/ branch calls. Any other supported
// target (today only `ready`) is a PROMOTION — `stampPromotedStatus`, the same authority
// move-plan.mjs's own promotion branch calls. Runs AFTER every axis's mutateBody, so it
// reads whatever `stage:`/frontmatter those axes just wrote (mirrors stamp-exec-model's
// own preflight, which projects its OWN stage flip before judging promotability).
function applyLaneMoveBody(body, ctx, move) {
  const targetStatus = ctx.move.targetStatus;
  if (WAITING_RX.test(targetStatus)) {
    body = rewriteBlockedByHeader(body, targetStatus, move.blockedBy, { seedLane: true });
    if (targetStatus === 'waiting-operator' && move.unblock !== undefined)
      body = setUnblock(body, move.unblock);
    return body;
  }
  const date = new Date().toISOString().slice(0, 10);
  return stampPromotedStatus(body, { target: targetStatus, fromStatus: ctx.status, date });
}

// The move-specific `[dry]` lines — the axis-specific lines (including the `git mv`/
// no-rename line, since ctx.oldRel/ctx.newRel already reflect the move's destination
// folder) come from each axis's own `dryPreview(ctx)`. Reads the board file for a true
// preview of `syncBoardPlanRefs` (mirrors move-plan.mjs's own `boardSyncFor`) rather
// than guessing whether a row would change.
function moveDryPreview(ctx, move, mainDir) {
  const lines = [];
  const targetStatus = ctx.move.targetStatus;
  if (WAITING_RX.test(targetStatus)) {
    lines.push(`[dry] rewrite body: set Blocked-by: "${move.blockedBy}"`);
    if (targetStatus === 'waiting-operator' && move.unblock !== undefined)
      lines.push(`[dry] rewrite body: set unblock: ${move.unblock}`);
  } else {
    lines.push(
      `[dry] rewrite body: Status → promotion stamp (${targetStatus}/), drop stale Blocked-by`,
    );
  }
  try {
    const cfg = loadCoordConfig(mainDir);
    const boardAbs = join(mainDir, cfg.paths.boardFile);
    if (existsSync(boardAbs)) {
      const synced = syncBoardPlanRefs(readFileSync(boardAbs, 'utf8'), {
        oldBasename: ctx.basename,
        newBasename: ctx.newBasename,
        target: ctx.move.targetPath,
      });
      if (synced.changed)
        lines.push(
          `[dry] board row sync: ${synced.rows} row(s) in ${cfg.paths.boardFile} → ${ctx.move.targetPath}/${ctx.newRel.split('/').pop()}`,
        );
    }
  } catch (e) {
    lines.push(`[dry] board row sync: could not preview (${e.message})`);
  }
  return lines;
}

async function stampImpl({ idOrName, dry, axes, move }) {
  const mainDir = resolveMain();
  const toolLabel = axes.map((a) => a.tool).join('+');
  const regenIndex = axes.some((a) => a.regenIndex) || Boolean(move);

  const result = await withRetry(
    () => {
      // ff-sync resilient to the transient FETCH_HEAD multi-branch race (plan 868).
      ffMasterFromOrigin(mainDir);
      const oldRel = resolvePlanRel(lsPlans(mainDir), idOrName);
      const basename = oldRel.split('/').pop();
      const status = statusOf(oldRel);
      // Fail BEFORE any filesystem mutation (plan-486 discipline): a disallowed status
      // must never strand a half-applied rename.
      assertStampableStatus(status, basename, toolLabel);
      let newBasename = basename;
      for (const axis of axes) if (axis.renameFor) newBasename = axis.renameFor(newBasename);
      // plan 3973 (T2): fold a lane move into the SAME rename/commit — the destination
      // folder becomes the move's target instead of the axis's origin status.
      let moveCtx = null;
      if (move) {
        const parsed = parseMoveTarget(move.target);
        if (parsed.category)
          throw Object.assign(
            new Error(
              `${toolLabel}: --move does not support a category suffix ("${move.target}") — ` +
                'pass a bare status.',
            ),
            { fatal: true },
          );
        if (!SUPPORTED_MOVE_TARGETS.has(parsed.status))
          throw Object.assign(
            new Error(
              `${toolLabel}: --move ${move.target} is not supported here — only ` +
                `${[...SUPPORTED_MOVE_TARGETS].join('|')} (archive/parked/in-progress/pending-approval ` +
                'carry terminal-stamp/claim-holder machinery this combined stamp+move does not ' +
                'replicate; use move-plan.mjs directly for those).',
            ),
            { fatal: true },
          );
        moveCtx = { targetStatus: parsed.status, targetPath: parsed.path };
      }
      const destStatus = moveCtx ? moveCtx.targetPath : status;
      const newRel = `${PLANS_PREFIX}${destStatus}/${newBasename}`;
      return {
        oldRel,
        newRel,
        basename,
        newBasename,
        status,
        renamed: newRel !== oldRel,
        move: moveCtx,
      };
    },
    (ctx) => {
      const { oldRel, newRel, renamed } = ctx;
      const env = { ...process.env, HUSKY: '0' };
      const msg = buildCommitSubject(ctx, axes, move);
      const commitMsg = `${msg}\n\n${COORD_TRAILER}: ${toolLabel}`;

      // Axes with a `preflight` (plan 2151's `.claude/` gate) or a `move` (T2's own lane-
      // entry gates) need oldRel's bytes ahead of the --dry branch, so every gate sees the
      // same ff-synced body a real stamp would mutate and a dry run is gated identically
      // to a real one. Neither read this early when nothing here needs it (plan 2151
      // review, finding 5) — every `--dry` invocation used to pay a disk read whose result
      // it never used.
      let oldBytes = null;
      const needsPreflight = axes.some((a) => a.preflight) || Boolean(move);
      if (needsPreflight) {
        oldBytes = readFileSync(join(mainDir, oldRel));
        const body = oldBytes.toString('utf8');
        for (const axis of axes) if (axis.preflight) axis.preflight(body, ctx);
        if (move) {
          // Judge the body AS IT WILL BE WRITTEN — every axis's own mutateBody projected
          // first (mirrors stamp-exec-model's own --spec-review preflight), so a plan
          // stamped `stage: specced`/`specReview:` in THIS SAME call is judged promotable
          // against the value it is about to carry, not the one it arrived with.
          let projected = body;
          for (const axis of axes) projected = axis.mutateBody(projected, ctx);
          const targetStatus = ctx.move.targetStatus;
          assertTripConditionOk(targetStatus, projected);
          assertUnblockOk(targetStatus, projected, move.unblock);
          assertCostBannerOk(targetStatus, projected, ctx.newBasename);
          assertSpecReviewOk(targetStatus, projected, ctx.newBasename);
          assertEvidenceFloorOk(
            targetStatus,
            projected,
            ctx.newBasename,
            loadCoordConfig(mainDir).planCategories.evidenceGated,
            toolLabel,
          );
          assertGrillQuestionsOk(targetStatus, projected);
          assertGrillExitOk(targetStatus, projected);
          // plan 3973 review fix (finding 330895/0b905d): the SAME claim-holder guard
          // move-plan.mjs runs (plan 2082) before ANY move — a plan whose claim ref is
          // held by ANOTHER session must refuse here too, or a combined stamp+move can
          // re-file a plan out from under its holder. Unlike move-plan.mjs's own
          // producer-side latch (which runs at most once per invocation because its
          // gates sit in withRetry's re-entrant producer callback), this preflight
          // already lives inside withRetry's pushFn, which is NOT re-entered on its
          // own — only a whole producer+pushFn retry re-runs it — so no separate latch
          // is needed here for correctness, only for read-count symmetry with
          // move-plan.mjs's optimization (out of scope for this fix).
          //
          // Round-2 review fix (R1/R2 — findings e5c145/c6fc99/8f28cd): the READ half is
          // the shared readClaimHolderStatus (move-plan.mjs), never a re-rolled copy.
          // Round-3 review fix (finding e91eef): the REFUSAL message is now built by that
          // same module's claimHolderError, parameterized for this combined form (never
          // branded "move-plan:", never pointing at a --force flag this tool doesn't have)
          // instead of a second hand-duplicated copy — see combinedMoveGuidance above.
          const {
            claimsId,
            status: claimStatus,
            readFailed,
          } = readClaimHolderStatus(mainDir, ctx.basename, {
            selfId: coordinationSessionId(),
            warn: (e, id) =>
              console.error(
                `${toolLabel}: WARN — claim-holder read failed for ${claimRef(id)} ` +
                  `(${(e.message || '').slice(0, 200)}); proceeding unguarded.`,
              ),
          });
          if (claimsId && !readFailed) {
            const err = claimHolderError(claimStatus, {
              tool: toolLabel,
              basename: ctx.basename,
              hasForceOverride: false,
              guidance: combinedMoveGuidance(claimStatus.planId, ctx.move.targetStatus),
              selfIdKnown: Boolean(coordinationSessionId()),
            });
            if (err) throw Object.assign(new Error(err), { fatal: true });
          }
        }
      }

      if (dry) {
        for (const axis of axes) for (const line of axis.dryPreview(ctx)) console.log(line);
        if (move) for (const line of moveDryPreview(ctx, move, mainDir)) console.log(line);
        if (regenIndex) console.log(`[dry] regenerate docs/INDEX.md (in-process)`);
        console.log(`[dry] commit: ${msg}`);
        console.log(`[dry] git push origin master`);
        return { ...ctx, dry: true };
      }

      // Snapshot oldRel's bytes BEFORE any `git mv` (plan-492 discipline: preserve any
      // uncommitted edit `git mv` would carry, and give the rollback below something
      // byte-exact to restore). The body mutation decodes this same buffer — `git mv`
      // never changes content, so it IS the post-rename file. A preflight/move axis
      // already read these bytes above; others read them here, still ahead of the
      // rename that would otherwise make oldRel unreadable.
      if (oldBytes === null) oldBytes = readFileSync(join(mainDir, oldRel));

      if (renamed) {
        ensureMvDestDir(mainDir, newRel);
        gitWithLockRetry(mainDir, ['mv', oldRel, newRel]);
      }

      let committed = false;
      let boardTouched = false;
      let pushed = false;
      // Resolved lazily (only when a move is in play — a bare axis stamp never touches
      // the board file, same as before this plan).
      const boardRel = move ? loadCoordConfig(mainDir).paths.boardFile : null;
      try {
        let body = oldBytes.toString('utf8');
        for (const axis of axes) body = axis.mutateBody(body, ctx);
        if (move) body = applyLaneMoveBody(body, ctx, move);
        writeFileSync(join(mainDir, newRel), body);
        const addPaths = [newRel];
        // The commit pathspec also names oldRel so the rename's deletion side is always
        // covered (a plain no-rename stamp dedupes to the single path).
        const commitPaths = renamed ? [oldRel, newRel] : [newRel];
        if (regenIndex) {
          // Regenerate docs/INDEX.md IN-PROCESS (mirrors move-plan's plan-926 rationale):
          // normally a no-op diff, but it heals any residual drift at negligible cost.
          writeFileSync(join(mainDir, 'docs/INDEX.md'), regenerateIndex(mainDir));
          addPaths.push('docs/INDEX.md');
          commitPaths.push('docs/INDEX.md');
        }
        if (move && boardRel) {
          // Board-row path sync (plan 2082's invariant, reused here): a moved plan must
          // never strand a board row pointing at its OLD subfolder/basename.
          const boardAbs = join(mainDir, boardRel);
          if (existsSync(boardAbs)) {
            const synced = syncBoardPlanRefs(readFileSync(boardAbs, 'utf8'), {
              oldBasename: ctx.basename,
              newBasename: ctx.newBasename,
              target: ctx.move.targetPath,
            });
            if (synced.changed) {
              writeFileSync(boardAbs, synced.content);
              boardTouched = true;
              addPaths.push(boardRel);
              commitPaths.push(boardRel);
              console.log(
                `${toolLabel}: board row sync — ${synced.rows} row(s) in ${boardRel} repathed to ${ctx.move.targetPath}/`,
              );
            }
          }
          // Same invariant gate move-plan.mjs runs against its own post-mutation tree
          // (plan 2378) — judged here identically, so a combined stamp+move can never
          // leave a board/plan-state contradiction move-plan alone would have caught.
          assertBoardInvariants(mainDir, [newRel], { tool: toolLabel });
        }
        gitWithLockRetry(mainDir, ['add', '-f', '--', ...addPaths]);
        gitWithLockRetry(mainDir, ['commit', '-m', commitMsg, '--', ...commitPaths], { env });
        committed = true;

        git(mainDir, ['push', 'origin', masterPushSpec(mainDir, env)], { env });
        pushed = true;
        const pushedResult = { ...ctx, pushed: true };
        for (const axis of axes) if (axis.postPush) axis.postPush(ctx, pushedResult);
        return pushedResult;
      } catch (e) {
        // Once master accepted the plan-file commit it is the durable truth. Rolling the disposable
        // checkout back after a dependent postPush ref mutation fails would make it lie about origin;
        // rethrow unchanged and without nonFastForward so withRetry cannot re-enter preflight.
        if (pushed) throw e;
        const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
        // Path-scoped rollback — never nukes a sibling session's uncommitted work.
        if (committed) gitWithLockRetry(mainDir, ['reset', '--soft', 'HEAD~1']);
        gitWithLockRetry(mainDir, ['reset', '-q', '--', oldRel]);
        if (renamed) gitWithLockRetry(mainDir, ['reset', '-q', '--', newRel]);
        if (renamed) rmSync(join(mainDir, newRel), { force: true });
        writeFileSync(join(mainDir, oldRel), oldBytes);
        if (regenIndex) gitWithLockRetry(mainDir, ['checkout', 'HEAD', '--', 'docs/INDEX.md']);
        if (boardTouched) gitWithLockRetry(mainDir, ['checkout', 'HEAD', '--', boardRel]);
        if (committed) {
          if (isNonFastForward(e))
            throw Object.assign(new Error('non-ff'), { nonFastForward: true });
          throw new Error(
            `${toolLabel}: push rejected (not non-ff — likely a pre-push hook):\n${out.trim()}`,
          );
        }
        throw e;
      }
    },
  );

  // Same post-move heal move-plan runs (plan 926): a ZERO-commit no-op on the common
  // clean path; a corrective commit on the rare residual clobber. Never fails the
  // already-committed(+pushed) stamp.
  if (!result.dry && result.pushed && regenIndex) {
    try {
      healIndexDrift(mainDir, {
        label: buildHealLabel(result, axes),
      });
    } catch (e) {
      console.error(`${toolLabel}: WARN — INDEX heal after stamp did not converge: ${e.message}`);
    }
  }

  return result;
}

// The public entrypoint: acquire the coord-checkout shadow, point COORD_MAIN_DIR at it
// (resolveMain()/masterPushSpec()/ffMasterFromOrigin() are COORD_MAIN_DIR-aware), run the
// stamp, restore. Callers validate their own argv (usage errors exit 2 BEFORE the coord
// lock is ever touched) and print their own summary from the returned ctx.
//
// plan 3973 (T2): accepts a MULTI-axis form — `opts.axes = [{ tool, renameFor, preflight,
// postPush, mutateBody, commitSubject, dryPreview, regenIndex, healLabel }, …]` — applied
// to the same plan inside ONE withCoordCheckout and ONE commit+push, plus an optional
// `opts.move = { target, blockedBy, unblock }` that folds a lane move (ready/waiting-*)
// into that same commit (see stampImpl's `move` handling above). `opts.idOrName`/`opts.dry`
// stay top-level regardless of shape.
//
// BACKWARD COMPATIBLE: the pre-3973 single-axis call shape — `opts` itself carrying `tool`/
// `renameFor`/`preflight`/… alongside `idOrName`/`dry` — keeps working UNCHANGED. Internally
// it becomes `axes: [opts]`; with no `move`, stampImpl's combined-subject builder is
// byte-identical to that one axis's own `commitSubject(ctx)` (see buildCommitSubject above),
// so every existing caller (stamp-cloud-exec.mjs, stamp-evidence.mjs, plan-adopt-branch.mjs,
// stamp-exec-model.mjs's own non-`--move` invocations) is unaffected.
export async function stampFrontmatterAxis(opts) {
  const mainDir = resolveMain();
  const axes = opts.axes ?? [opts];
  const { idOrName, dry, move } = opts;
  return withCoordCheckout(mainDir, async (cdir) => {
    const prev = process.env.COORD_MAIN_DIR;
    process.env.COORD_MAIN_DIR = cdir;
    try {
      return await stampImpl({ idOrName, dry, axes, move });
    } finally {
      if (prev === undefined) delete process.env.COORD_MAIN_DIR;
      else process.env.COORD_MAIN_DIR = prev;
    }
  });
}
