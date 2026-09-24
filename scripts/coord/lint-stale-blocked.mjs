#!/usr/bin/env node
// scripts/lint-stale-blocked.mjs — surface waiting-blocked/ plans whose every named
// plan-blocker has ALREADY archived: the plan is unblocked but was never re-filed to
// ready/. This is the backstop for the 484-class miss (a plan stranded in
// waiting-blocked/ for hours after its last blocker landed, 2026-06-13) on any path
// that does NOT go through done-worktree's auto-promoter — a hand `git mv` to archive/,
// a land that predates the plan-569 matcher fix, or simply a routine push that should
// flag the backlog.
//
// Reuses the SAME matcher the auto-promoter uses (blocked-by-lib.classifyBlocked), so
// "flagged here" means exactly "promotable / review there" — one source of truth.
//
// Default mode is ADVISORY: it prints findings and exits 0, so it never blocks a push
// (wired non-blocking into .husky/pre-push, gated on a plans/ diff). `--check` exits 1
// when any stale plan is found, for a caller that wants it to gate (CI).
//
// Source of plan paths: `git ls-files` (TRACKED only) — an untracked foreign plan a
// parallel session dropped in waiting-blocked/ is invisible and never flagged, the
// same orphan-immunity as build-index.mjs / lint-plan-cost-forecast.mjs.
//
// Exit codes:  0 clean (or advisory with findings) · 1 --check with findings · 2 error.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gitRepoIsolatedEnv } from './child-env.mjs';
import {
  classifyBlocked,
  makeArchiveIsShipped,
  blockedByLines,
  tailOnlyBlockedByLines,
} from './blocked-by-lib.mjs';
import { getUnblock } from './plan-body-state.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';
import {
  STATUS_ORDER,
  READY_FOLDER,
  IN_PROGRESS_FOLDER,
  PENDING_APPROVAL_FOLDER,
  WAITING_BLOCKED_FOLDER,
  WAITING_OPERATOR_FOLDER,
} from './build-index-lib.mjs';

const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
const PLANS_PREFIX = 'docs/superpowers/plans/';
const ACTIVE_STATUS_FOLDERS = new Set(STATUS_ORDER);

// A tracked `NNN-Category-…` plan path under a status folder → [_, folder, id].
// Exported (plan 2378 review fix) so board-write-gate.mjs uses THIS literal instead of a
// second copy: the `(?=[A-Za-z])` lookahead is the plan-1002 guard (a legacy full-date
// plan `2026-05-17-…` must not mint a phantom id key "2026", which would ground a bare
// year in a Blocked-by line as a real archived blocker), and two independently-maintained
// copies of a guard that subtle WILL drift.
// plan 2678: an OPTIONAL one-level lowercase category folder may sit between the status
// and the file (`waiting-blocked/denmark/2678-Coord-x.md`). Without the extra segment this
// regex simply did not match a categorised plan, and every consumer `continue`d it out of
// its corpus — so a nested waiting-blocked/ plan was never staleness-checked, and a nested
// plan named as somebody ELSE's blocker resolved to `null` (i.e. never clearable). Capture
// group 1 stays the STATUS (the only thing consumers read); the category is uncaptured.
export const PLAN_PATH_RE =
  /^docs\/superpowers\/plans\/([^/]+)\/(?:[a-z0-9-]+\/)?(\d{3,})-(?=[A-Za-z])[^/]*\.md$/;

// pure: given waiting-blocked entries [{ basename, content }] + an id→folder resolver
// (+ optional isShipped(id) — plan 1836: an archived blocker only counts as cleared
// when it carries the ✅ COMPLETED stamp; defaults to classifyBlocked's own strict
// `() => false` when omitted), return findings whose every named blocker has cleared
// ('promotable' = safe to move, 'review' = a non-plan gate also remains). 'blocked' /
// 'none' are not surfaced.
export function findStaleBlocked(entries, statusOf, isShipped) {
  const out = [];
  for (const e of entries) {
    const selfId = (e.basename.match(/^(\d{3,})/) || [])[1] || null;
    const c = classifyBlocked(e.content, statusOf, selfId, isShipped);
    if (c.kind === 'promotable' || c.kind === 'review') {
      out.push({ basename: e.basename, id: selfId, kind: c.kind, ids: c.ids, gate: c.gate });
    }
  }
  return out;
}

// A raw (pre-strip) Blocked-by line carrying literal `~~`, or LEADING with the bare
// `cleared` token (mirrors queue-drain.mjs's BLOCKED_CLEARED_RX exactly — same
// anchor) — the spec-sweep/board-pass idiom that "clears" a stale blocker by
// striking it through instead of erasing it (plan 2174). queue-drain.mjs and
// blocked-by-lib.mjs now both strip-then-classify this idiom correctly, but it is
// still parseable-yet-noisy (queue-drain's staleBlockedBy warning) or an attractor
// for a future variant either oracle doesn't anticipate — flag it at write time in
// ANY active status folder, regardless of which actor produced it, instead of only
// reacting to it downstream. The `cleared` half MUST stay leading-anchored (`^`):
// an un-anchored `\bcleared\b` false-positives on a correctly-normalized line whose
// evidence prose merely mentions the word ("none — 2096 landed (cleared per code
// review)."), which the review's own template (spec-sweep.md) can legitimately
// produce (sonnet-review CONFIRMED finding).
const STRIKETHROUGH_OR_CLEARED_RX = /~~|^cleared\b/i;

// pure: given plan entries [{ basename, content }] from any active status folder,
// return those whose **Blocked-by:** line(s) still carry the raw `~~…~~` / `cleared`
// idiom (see STRIKETHROUGH_OR_CLEARED_RX above).
export function findStrikethroughBlocked(entries) {
  const out = [];
  for (const e of entries) {
    const lines = blockedByLines(e.content).filter((l) => STRIKETHROUGH_OR_CLEARED_RX.test(l));
    if (lines.length) {
      const id = (e.basename.match(/^(\d{3,})/) || [])[1] || null;
      out.push({ basename: e.basename, id, lines });
    }
  }
  return out;
}

// --- plan 2446: a Blocked-by line parked in a close-out tail --------------------------
//
// blocked-by-lib.mjs's classifyBlocked (and therefore this lint's other buckets, and
// done-worktree's auto-promoter) never counts a **Blocked-by:** line that sits inside a
// `closeoutTailSpans` close-out tail — same split-don't-sink reading plan 2368 already
// applies to the operator gates: the tail is deferred operator-local follow-up, not the
// drainable body. The unsafe direction (an author mistakenly parks the plan's REAL
// blocker in a tail, and it silently never gates) is answered here with visibility —
// this bucket is purely advisory (like the strikethrough one above), any active folder,
// so an author sees the note on the very next push regardless of which folder the plan
// currently sits in.
export function findTailBlockedBy(entries) {
  const out = [];
  for (const e of entries) {
    const lines = tailOnlyBlockedByLines(e.content);
    if (lines.length) {
      const id = (e.basename.match(/^(\d{3,})/) || [])[1] || null;
      out.push({ basename: e.basename, id, lines });
    }
  }
  return out;
}

// --- plan 2378: a Blocked-by line in an ACTIVE, NON-waiting folder -----------------
//
// The mirror of findStaleBlocked above. That one polices "stranded in waiting-blocked/
// though every blocker cleared"; this one polices the OTHER direction — a plan carrying
// a **Blocked-by:** line while sitting in a folder that means "takeable".
//
// Two sub-buckets, one predicate, because the two shapes have different owners:
//   LIVE  (axis A) — some named blocker is still open, or a genuine non-plan gate
//                    remains. The plan is genuinely blocked but its FOLDER says it is
//                    not. `queue-drain.mjs` honours the body line regardless of folder
//                    (extractBlockedByLine reads the BODY), so the drain stays safe and
//                    no wrong work happens — the damage is informational and cumulative:
//                    ready/ stops meaning "a drain can take this", so every drain cycle
//                    and /cloud-eligibility report re-surfaces it as BLOCKED and a human
//                    re-reads the line to conclude "still fine". And if the line were
//                    ever dropped or mis-struck, the plan would silently become drainable
//                    with its constraint still live — the folder would not catch it.
//                    Fix: `node scripts/move-plan.mjs <id> waiting-blocked`.
//   STALE (axis B) — every named blocker archived AND shipped, no gate: a dead line the
//                    promotion should have erased. `move-plan`'s promote path calls
//                    dropBlockedBy; done-worktree's auto-promoter did not until plan 2378
//                    step 4, so a close-out-promoted dependent kept its now-dead line
//                    (2358 after 2357 archived, 2026-07-25). Functionally tolerated
//                    (queue-drain's staleBlockedBy path lets it through) but the body lies.
//                    Fix: erase the line.
//
// FOLDER SCOPE (spec-pass recommendation 3, board-pass 2026-07-25):
//   LIVE  — `ready/` + `in-progress/` only. `pending-approval/` is EXEMPT from LIVE: a
//           stub noting a known upstream before anyone has filed it is legitimate, and
//           the folder is not a takeable queue.
//   STALE — `ready/` + `in-progress/` + `pending-approval/` (a dead line is noise
//           anywhere it survives).
//   `parked/` is exempt from both, and gets that for free: it is deliberately absent
//   from STATUS_ORDER (build-index-lib), so ACTIVE_STATUS_FOLDERS never admits it and a
//   parked plan is not in `activeEntries` at all. The `waiting-*` lanes are exempt by
//   construction — a Blocked-by line there is the REQUIRED header, not a finding.
//
// NON-GOALS this must not false-positive on (all covered by cases below):
//   - struck-through / leading-`cleared` lines → owned by findStrikethroughBlocked;
//     skipped here so the two never double-report the same line.
//   - cost-only rationale → classifyBlocked returns 'none' (hasNonPlanGate strips
//     cost-only clauses per plan 1065), so it is never bucketed.
//   - a waiting-*/ plan's Status line → out of folder scope entirely.
export const LIVE_BLOCKED_FOLDERS = new Set([READY_FOLDER, IN_PROGRESS_FOLDER]);
export const STALE_BLOCKED_FOLDERS = new Set([
  READY_FOLDER,
  IN_PROGRESS_FOLDER,
  PENDING_APPROVAL_FOLDER,
]);

// A Blocked-by line whose TEXT leads with a cleared-declaration token: the line's own
// first word says "this plan is NOT blocked". Leading-anchored for the same reason
// STRIKETHROUGH_OR_CLEARED_RX's `cleared` half is (an un-anchored match false-positives
// on evidence prose that merely mentions the word).
//
// `none` is NOT optional here — it is the runbook's OWN concrete template
// (`**Blocked-by:** none — <id> landed <date> (<evidence>).`, the replacement
// lint-stale-blocked itself recommends three buckets down). Without this skip the new
// buckets below would report every correctly-normalized plan in the corpus: the template
// names the cleared blocker's id in its evidence clause, referencedBlockerIds grounds
// that id, and the plan lands in STALE. The lint would then be loudest at exactly the
// plans that followed its own advice.
//
// `resolved` is the same declaration in different words — observed live on
// 2403-Infra-cloud-session-hygiene (`RESOLVED — plan 2382 archived 2026-07-25; …`).
// Deliberately NOT folded into STRIKETHROUGH_OR_CLEARED_RX: that bucket answers a
// different question ("is this line written in the noisy strikethrough idiom?"), and
// widening it would change an existing advisory bucket's output beyond this plan's scope.
const CLEARED_DECLARATION_RX = /^(?:none|resolved|cleared)\b/i;

/**
 * pure: given active-folder entries [{ basename, content, folder }] + the same
 * id→folder resolver and isShipped predicate findStaleBlocked uses, return
 * `{ live: [...], stale: [...] }`.
 *
 * Reuses classifyBlocked (no second Blocked-by parser) and maps its four kinds:
 *   'blocked'    → LIVE   (a named blocker is still open)
 *   'review'     → LIVE   (blockers cleared but a genuine non-plan gate remains)
 *   'promotable' → STALE  (every blocker archived+shipped, no gate — a dead line)
 *   'none'       → not reported (no plan ids and no non-cost gate: a pure
 *                  trip/calendar/cost line is not this bucket's concern)
 */
export function findBlockedByInActiveFolder(entries, statusOf, isShipped) {
  const live = [];
  const stale = [];
  for (const e of entries) {
    const folder = e.folder;
    if (!STALE_BLOCKED_FOLDERS.has(folder) && !LIVE_BLOCKED_FOLDERS.has(folder)) continue;
    const lines = blockedByLines(e.content);
    if (!lines.length) continue;
    // Skip when EVERY declaration line either uses the strikethrough idiom (owned by
    // findStrikethroughBlocked — never double-report one line from two buckets) or
    // self-declares cleared (see CLEARED_DECLARATION_RX). A body that stacks a cleared
    // line AND a still-live one is classified normally: the live line is the point.
    const inert = (l) => STRIKETHROUGH_OR_CLEARED_RX.test(l) || CLEARED_DECLARATION_RX.test(l);
    if (lines.every(inert)) continue;
    const id = (e.basename.match(/^(\d{3,})/) || [])[1] || null;
    const c = classifyBlocked(e.content, statusOf, id, isShipped);
    const finding = { basename: e.basename, id, folder, kind: c.kind, ids: c.ids, gate: c.gate };
    if (c.kind === 'blocked' || c.kind === 'review') {
      if (LIVE_BLOCKED_FOLDERS.has(folder)) live.push(finding);
    } else if (c.kind === 'promotable') {
      if (STALE_BLOCKED_FOLDERS.has(folder)) stale.push(finding);
    }
  }
  return { live, stale };
}

// pure: given waiting-operator entries [{ basename, content }], return those whose
// frontmatter is `unblock: cost` — a MISFILE. Cost is never an operator hold (plan
// 1065): spend is governed by the 💰 Cost-forecast banner + the drain's pause-on->$5,
// so a cost-gated plan belongs in ready/ (the drain stops before spending), not parked
// here. move-plan auto-routes a new one; this catches any that slipped in via edit-plan.
export function findCostMisfiledOperator(entries) {
  const out = [];
  for (const e of entries) {
    if (getUnblock(e.content) === 'cost') {
      const id = (e.basename.match(/^(\d{3,})/) || [])[1] || null;
      out.push({ basename: e.basename, id });
    }
  }
  return out;
}

function loadCorpus() {
  const all = execFileSync('git', ['ls-files', `${PLANS_PREFIX}*.md`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: gitRepoIsolatedEnv(),
  })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const statusMap = new Map();
  // plan 1836: id -> tracked rel path, so an id resolving to 'archive' can have its
  // content lazily read (isShipped below) without a second corpus scan.
  const relById = new Map();
  // plan 2174: every active-folder plan is read from disk exactly ONCE here (folder
  // tagged alongside), instead of once per folder-specific list — waiting-blocked/
  // and waiting-operator/ are both members of ACTIVE_STATUS_FOLDERS, so a naive
  // three-list-three-readFileSync split was re-reading those two folders' files a
  // second and third time for content already loaded (sonnet-review CONFIRMED
  // efficiency finding).
  const activeRels = [];
  for (const rel of all) {
    // `(?=[A-Za-z])`: capture the id ONLY for an `NNN-Category-…` plan, so a legacy
    // full-date plan (`2026-05-17-…`) does NOT mint a phantom id key "2026" — which would
    // ground a bare year in a Blocked-by line as a real archived blocker (plan 1002).
    const m = rel.match(PLAN_PATH_RE);
    if (!m) continue;
    statusMap.set(m[2], m[1]); // id → folder
    relById.set(m[2], rel);
    if (ACTIVE_STATUS_FOLDERS.has(m[1])) activeRels.push({ rel, folder: m[1] });
  }
  const activeEntries = activeRels.map(({ rel, folder }) => ({
    basename: basename(rel),
    content: readFileSync(join(REPO_ROOT, rel), 'utf8'),
    folder,
  }));
  return {
    statusOf: (id) => statusMap.get(id) ?? null,
    // plan 1836: an archived blocker only counts as CLEARED when its body carries the
    // ✅ COMPLETED stamp (archive/ holds "shipped OR closed" plans). Lazy + memoized —
    // reads at most one file per referenced-and-archived blocker id.
    isShipped: makeArchiveIsShipped(relById, (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')),
    entries: activeEntries.filter((e) => e.folder === WAITING_BLOCKED_FOLDER),
    operatorEntries: activeEntries.filter((e) => e.folder === WAITING_OPERATOR_FOLDER),
    activeEntries,
  };
}

export function main() {
  const check = process.argv.slice(2).includes('--check');
  let corpus;
  try {
    corpus = loadCorpus();
  } catch (e) {
    console.error('lint-stale-blocked: could not list plans:', e.message);
    return 2;
  }
  const findings = findStaleBlocked(corpus.entries, corpus.statusOf, corpus.isShipped);
  const costMisfiled = findCostMisfiledOperator(corpus.operatorEntries);
  const strikethroughFindings = findStrikethroughBlocked(corpus.activeEntries);
  const misfiled = findBlockedByInActiveFolder(
    corpus.activeEntries,
    corpus.statusOf,
    corpus.isShipped,
  );
  const tailBlockedByFindings = findTailBlockedBy(corpus.activeEntries);
  if (
    findings.length === 0 &&
    costMisfiled.length === 0 &&
    strikethroughFindings.length === 0 &&
    misfiled.live.length === 0 &&
    misfiled.stale.length === 0 &&
    tailBlockedByFindings.length === 0
  ) {
    console.log(
      `lint-stale-blocked: no stale waiting-blocked/ plans (${corpus.entries.length} checked); ` +
        `no waiting-operator/ unblock:cost misfiles (${corpus.operatorEntries.length} checked); ` +
        `no strikethrough Blocked-by lines, no misfiled/stale Blocked-by in an active ` +
        `non-waiting folder, no close-out-tail Blocked-by lines ` +
        `(${corpus.activeEntries.length} active plans checked).`,
    );
    return 0;
  }
  if (findings.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: waiting-blocked/ plan(s) whose every named blocker has ARCHIVED (unblocked):',
    );
    for (const f of findings) {
      const tag =
        f.kind === 'promotable' ? 'PROMOTE → ready/' : 'REVIEW (a non-plan gate also remains)';
      console.error(`  - ${f.basename}  [${tag}]  blockers: ${f.ids.join(', ')}`);
    }
    console.error('');
    console.error(
      '  These are unblocked. Re-file a PROMOTE one with:  node scripts/move-plan.mjs <id> ready',
    );
  }
  if (costMisfiled.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: waiting-operator/ plan(s) with `unblock: cost` — a MISFILE (cost is never an operator hold, plan 1065):',
    );
    for (const f of costMisfiled) console.error(`  - ${f.basename}  [MISFILE → ready/]`);
    console.error('');
    console.error(
      '  Cost is governed by the 💰 Cost-forecast banner + the drain pause-on->$5, never a hold. Move to ready/:  node scripts/move-plan.mjs <id> ready',
    );
  }
  if (strikethroughFindings.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: **Blocked-by:** line(s) using the strikethrough/CLEARED idiom instead of an erase — parseable but noisy (plan 2174):',
    );
    for (const f of strikethroughFindings) {
      for (const line of f.lines) console.error(`  - ${f.basename}  "${line}"`);
    }
    console.error('');
    console.error(
      '  Replace with the concrete template:  **Blocked-by:** none — <id> landed <date> (<evidence>).',
    );
  }
  if (misfiled.live.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: LIVE **Blocked-by:** line(s) in an active NON-waiting folder — a MISFILE (plan 2378 axis A):',
    );
    for (const f of misfiled.live) {
      const why =
        f.kind === 'review' ? 'a non-plan gate remains' : `open blockers: ${f.ids.join(', ')}`;
      console.error(`  - ${f.folder}/${f.basename}  [${why}]`);
    }
    console.error('');
    console.error(
      '  A live Blocked-by belongs in waiting-*/, not a takeable folder:  node scripts/move-plan.mjs <id> waiting-blocked',
    );
    console.error(
      '  (Use move-plan — NOT an in-place edit-plan that adds the line and leaves the folder alone.)',
    );
  }
  if (misfiled.stale.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: STALE **Blocked-by:** line(s) left behind by a promotion (plan 2378 axis B):',
    );
    for (const f of misfiled.stale) {
      console.error(
        `  - ${f.folder}/${f.basename}  [all blockers archived+shipped: ${f.ids.join(', ')}]`,
      );
    }
    console.error('');
    console.error(
      '  The blockers cleared — erase the line so the body stops lying:  node scripts/edit-plan.mjs <id> --find "<the line>" --replace ""',
    );
  }
  if (tailBlockedByFindings.length) {
    console.error('');
    console.error(
      'lint-stale-blocked: **Blocked-by:** line(s) parked inside a close-out-tail section — NOT counted toward the drainable body (plan 2446):',
    );
    for (const f of tailBlockedByFindings) {
      for (const line of f.lines) console.error(`  - ${f.basename}  "${line}"`);
    }
    console.error('');
    console.error(
      '  If this IS the plan’s real blocker, move it into the drainable body (above the tail); if it genuinely belongs to the deferred tail work only, this note is informational.',
    );
  }
  // Only the stale-blocked findings gate under --check; the cost-misfile,
  // strikethrough, plan-2378 misfile/stale, and plan-2446 tail-Blocked-by scans are
  // purely ADVISORY.
  //
  // Advisory is a deliberate choice for the 2378 buckets, not an oversight (spec-pass
  // recommendation 2, adopting the plan body's own reasoning): this lint runs in
  // .husky/pre-push, so a hard fail would block whichever innocent session next pushes
  // ordinary work — reproducing the exact "someone else's misfile wedges my push"
  // dynamic plan 2378 exists to END. The hard gate for these lives at WRITE time
  // instead (scripts/coord/board-write-gate.mjs), where it refuses only the write that
  // introduces the violation, and only to the session that authored it.
  console.error(
    check && findings.length
      ? '  (--check: exiting 1)'
      : '  (advisory — does not block this push.)',
  );
  return check && findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
