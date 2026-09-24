#!/usr/bin/env node
// Pre-push guard: enforce that handoff-board.md rows point at real plan
// files. Sibling to lint-plan-index.mjs — that script enforces
// INDEX.md ↔ plans/ consistency; this one enforces handoff-board.md ↔
// plans/ consistency.
//
// One check:
//
//   (A) BROKEN BOARD POINTER
//       Every 🔄 ACTIVE / 🟢 LANDING / ⏸ PAUSED row in handoff-board.md
//       must reference at least one plan filename that exists somewhere
//       under docs/superpowers/plans/. If the row names a subfolder
//       (e.g. `in-progress/170-…md`), the file must exist at that exact
//       subfolder path; otherwise SUBFOLDER_DRIFT is flagged.
//
//       Plans under plans/archive/ are NOT a valid target for an active
//       board row — once archived, the row should have been removed.
//
// What this DOESN'T check:
//   - Whether handoff.md's dual-write copy matches handoff-board.md
//     (Phase 2 — plan-171 — drops the copy entirely, so a drift check
//     would be obsolete by the time it'd be useful).
//   - Row formatting / column count / state vocabulary.
//
// Bootstrap safety: if handoff-board.md doesn't exist (pre-extraction
// projects, or legacy worktrees that pre-date plan-169), exit 0 silently
// — the legacy single-write path through handoff.md is still legitimate.
//
// Exit codes:
//   0 — clean (or handoff-board.md absent)
//   1 — drift detected (push blocked)

import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitBoard, findRowLineIndex, cellsOf, ACTIVE_STATE } from './board-lib.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { PLAN_FOLDER_ALT, PLAN_TAG_SOURCE } from './build-index-lib.mjs';
import {
  computeDriftIsInherited,
  checkWorktreeCoordDocStale,
  formatStaleWorktreeCoordDocMessage,
} from './drift-attribution-lib.mjs';
import { markPushTelemetryHit } from './push-telemetry-lib.mjs';

const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
const PLANS_DIR = join(REPO_ROOT, 'docs', 'superpowers', 'plans');
const BOARD_REL = loadCoordConfig(REPO_ROOT).paths.boardFile;
const BOARD_PATH = join(REPO_ROOT, BOARD_REL);

// Match a plan path (with optional subfolder) inside a table cell.
// Captures two naming conventions:
//   NNN-PX-Description.md  (numeric prefix, 3+ digits — covers 4-digit ids)
//   YYYY-MM-DD-description.md  (date-prefixed plans)
// with optional preceding "subfolder/". The numeric alternative requires `-[A-Z]`
// after the digits, so a date (where `\d{2}` follows) only matches the date alt.
// `parked` (plan 1426) is recognized here like `archive` — a parked plan is a legal
// move source/target, so a board row naming it must still parse; validateRows below
// flags a parked/-only reference the same way it flags an archive/-only one.
// Folder alternation is derived from build-index-lib's PLAN_FOLDER_ALT (plan 1447) —
// never hand-list folder names here again; add a folder to STATUS_ORDER/ALL_PLAN_FOLDERS
// there and every site (this one included) picks it up. The numeric alternative's tag
// shape (`\d{3,}-[A-Z][A-Za-z0-9]+-`) is build-index-lib's PLAN_TAG_SOURCE (plan 1945) —
// previously a THIRD hand-typed copy of the same literal, alongside a byte-identical
// (and unused) local PLAN_FILENAME_RX this file used to restate at this line.
// plan 2678: the subfolder capture admits an OPTIONAL one-level category folder between
// the status and the file (`parked/denmark/9-X-y.md`), and `subfolder` carries the whole
// `status[/category]` prefix. WITHOUT this the category ref would still LINT GREEN — but
// only by mis-parsing as a bare filename, which silently disarms the BOARD_SUBFOLDER_DRIFT
// check (the exact class plan 2082 added it for) for every categorised plan. Category
// shape is PLAN_CATEGORY_RX's `[a-z0-9-]+`, restated here as a source fragment because
// this is a `g`-flagged composite, not a standalone anchored test.
const PLAN_REF_RX = new RegExp(
  '(?:((?:' +
    PLAN_FOLDER_ALT +
    ')(?:\\/[a-z0-9-]+)?)\\/)?(' +
    PLAN_TAG_SOURCE +
    '[^\\s`)]+?\\.md|\\d{4}-\\d{2}-\\d{2}-[^\\s`)]+?\\.md)',
  'g',
);

async function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function planRelPath(absPath) {
  return relative(PLANS_DIR, absPath)
    .split(/[\\/]+/)
    .join('/');
}

function basename(p) {
  return p.split(/[\\/]+/).pop();
}

function extractBoardSection(content) {
  // Prefer sentinel-delimited window; fall back to the whole file.
  const start = content.indexOf('<!-- BOARD-START -->');
  const end = content.indexOf('<!-- BOARD-END -->');
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(start + '<!-- BOARD-START -->'.length, end);
  }
  return content;
}

function parseBoardRows(boardSection) {
  // Markdown table rows start with `|` and contain `|`-separated cells.
  // Skip the header row and the `|---|---|...` separator row.
  const rows = [];
  const lines = boardSection.split(/\r?\n/);
  let pastHeader = false;
  let pastSeparator = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (!pastHeader) {
      pastHeader = true;
      continue;
    }
    if (!pastSeparator) {
      // The `|---|---|...|` separator. Detect by all-dash cells.
      if (/^\|[\s|:-]+\|$/.test(line)) {
        pastSeparator = true;
        continue;
      }
      // Some boards skip the separator line; treat first data-looking row as start.
      pastSeparator = true;
    }
    // Strip leading + trailing `|`, split on `|`.
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    rows.push({ lineNumber: i + 1, cells, raw });
  }
  return rows;
}

function rowState(cells) {
  // State is column index 2 (0-based): | Worktree | Branch tip | State | Plan | LastTouched | Resume |
  return cells[2] || '';
}

export function extractPlanRefs(cellText) {
  const refs = [];
  let m;
  PLAN_REF_RX.lastIndex = 0;
  while ((m = PLAN_REF_RX.exec(cellText)) !== null) {
    const subfolder = m[1] || null;
    const filename = m[2];
    refs.push({ subfolder, filename, full: subfolder ? `${subfolder}/${filename}` : filename });
  }
  return refs;
}

// Validate EVERY board row's plan pointer — not just 🔄 ACTIVE / 🟢 LANDING /
// ⏸ PAUSED. The old TRACKED_STATES filter let ✅ DONE-ON-BRANCH / 🧹 SUPERSEDED
// rows keep dangling pointers at archived/missing plans (the 163 orphan class).
// Returns the array of error objects ({ kind, path, hint }). State is used only
// for context in error messages now, never to skip a row.
export function validateRows(rows, byBasename) {
  const errors = [];

  for (const row of rows) {
    const state = rowState(row.cells);
    const planCell = row.cells[3] || '';
    const refs = extractPlanRefs(planCell);

    if (refs.length === 0) {
      errors.push({
        kind: 'NO_PLAN_REF',
        path: `${BOARD_REL} row state=${state}`,
        hint:
          `Board row contains no plan filename in the "Plan / claim" cell. ` +
          `Add a backticked or bare reference like \`in-progress/NNN-PX-Description.md\`. ` +
          `Cell snippet: ${planCell.slice(0, 120)}...`,
      });
      continue;
    }

    for (const ref of refs) {
      const candidates = byBasename.get(ref.filename) || [];
      if (candidates.length === 0) {
        errors.push({
          kind: 'BROKEN_BOARD_POINTER',
          path: ref.full,
          hint:
            `Board row (state=${state}) references \`${ref.full}\` but no such plan exists ` +
            `anywhere under docs/superpowers/plans/. Either restore the file or remove the board row.`,
        });
        continue;
      }

      // Archived AND parked (plan 1426) plans should not be referenced from a board
      // row — both are frozen, not active work. `nonFrozen` excludes both folders;
      // if nothing else remains, flag which frozen folder it actually lives in.
      const nonFrozen = candidates.filter(
        (c) => !c.startsWith('archive/') && !c.startsWith('parked/'),
      );
      if (nonFrozen.length === 0) {
        const onlyParked = candidates.every((c) => c.startsWith('parked/'));
        errors.push({
          kind: onlyParked ? 'PARKED_PLAN_ACTIVE_ROW' : 'ARCHIVED_PLAN_ACTIVE_ROW',
          path: ref.full,
          hint: onlyParked
            ? `Board row (state=${state}) references \`${ref.filename}\` which only exists under parked/. ` +
              `A parked plan must not keep an active board row — remove the row or un-park the plan ` +
              `(node scripts/move-plan.mjs <id> <lane>).`
            : `Board row (state=${state}) references \`${ref.filename}\` which only exists under archive/. ` +
              `Archived plans should not have a board row — remove the row or restore the plan to an active subfolder.`,
        });
        continue;
      }

      // plan 2929: a row stamped 🔄 ACTIVE whose plan resolves ONLY under waiting-*/
      // folders is stale — the plan is parked pending an external event (an operator
      // decision, a date, a trip), not actually being worked, so the board is lying
      // about live progress. Distinct from the frozen (archive/parked) check above:
      // nonFrozen here is non-empty (waiting-* plans are legitimate move targets, not
      // frozen), so this must be a separate check, not folded into the nonFrozen
      // filter itself — doing so would misroute waiting-lane plans into the
      // ARCHIVED/PARKED kinds. A plan present under BOTH a waiting-*/ folder and an
      // active folder (e.g. in-progress/) stays CLEAN — "every nonFrozen candidate"
      // preserves the existing "only exists under" semantics.
      if (
        state === ACTIVE_STATE &&
        nonFrozen.length > 0 &&
        nonFrozen.every((c) => /^waiting-/.test(c))
      ) {
        errors.push({
          kind: 'WAITING_PLAN_ACTIVE_ROW',
          path: ref.full,
          hint:
            `Board row (state=${state}) references \`${ref.filename}\` which only exists under ` +
            `${nonFrozen.join(', ')} — a waiting-lane plan is parked pending an external event, not ` +
            `active work. If \`worktree-<slug>\` still exists on origin, flip the row to ⏸ PAUSED ` +
            `(a resumable tree is worth showing); otherwise remove the row ` +
            `(node scripts/board.mjs update <slug> --state '⏸ PAUSED', or remove the row entirely).`,
        });
      }

      if (ref.subfolder && !candidates.includes(ref.full)) {
        // Cell named a specific subfolder, but the file is somewhere else.
        // Tolerant: if the cell prose itself flags an in-flight move
        // (e.g. "ready/foo.md (moving to in-progress/)"), accept any active
        // subfolder. Strict subfolder match is in scope only when the file
        // really isn't found.
        const moveAnnotated = /\(moving to|→\s*`?(?:in-progress|ready|waiting-)/i.test(planCell);
        if (!moveAnnotated) {
          // plan 2082: print the exact ready-to-run heal so a blocked autonomous
          // session can heal-and-retry without operator judgment (this drift blocks
          // EVERY session's push via .husky/pre-push until someone fixes the row).
          // board.mjs update is the sanctioned atomic mutator; the healed cell only
          // repoints the drifted path — state/claim/prose stay byte-identical.
          // Single-quoted (cells carry backticks, which double quotes would let the
          // shell command-substitute). Only when the basename resolves to EXACTLY ONE
          // non-frozen location (review r1): with duplicates, an arbitrary
          // nonFrozen[0] pick would hand a blocked session an authoritative-looking
          // command that repoints the row at the wrong copy — the plan-1002 ambiguity
          // hazard resolvePlanRel refuses for the same reason — so the ambiguous case
          // lists the candidates and demands a human pick instead.
          const slug = row.cells[0] || '<slug>';
          const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
          const heal =
            nonFrozen.length === 1
              ? `Self-heal (any session, from the MAIN checkout), then re-push:\n` +
                `      node scripts/board.mjs update ${slug} --plan-claim ${sq(planCell.split(ref.full).join(nonFrozen[0]))}`
              : `AMBIGUOUS basename (${nonFrozen.length} non-frozen copies) — no auto-heal command; ` +
                `pick the correct location yourself and run: node scripts/board.mjs update ${slug} --plan-claim '<cell with the right path>'`;
          errors.push({
            kind: 'BOARD_SUBFOLDER_DRIFT',
            path: ref.full,
            hint:
              `Board row (state=${state}) references \`${ref.full}\` but the file is actually at ${nonFrozen.join(', ')}. ` +
              `Update the board path to match the current subfolder (status changed without board update). ` +
              heal,
          });
          continue;
        }
      }
    }
  }

  return errors;
}

// Sync basename → [relative plan paths] map over a plans dir — the same shape
// main() builds (there async). Shared by board.mjs (write-time cell lint, plan
// 511) and drain-run.mjs (post-write row verify, plan 506); missing dir → empty
// map, mirroring walkMarkdown's tolerance.
export function planBasenameMap(plansDir) {
  const map = new Map();
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return map;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (e.name.endsWith('.md')) {
        if (!map.has(e.name)) map.set(e.name, []);
        map.get(e.name).push(r);
      }
    }
  };
  walk(plansDir, '');
  return map;
}

// Kinds the ROW-SCOPED write-time lint deliberately does NOT enforce (plan 2929).
// `WAITING_PLAN_ACTIVE_ROW` is a STATE-column finding, not a "Plan / claim" CELL
// contract one, and the write-time callers below (board.mjs's plan-511 cell gate,
// drain-run's verifyBoardRowLintClean) are only ever setting the CELL — they cannot
// fix a state finding, so raising it there can only refuse an otherwise-legal write.
// Concretely: drain-run's park sequence moves a plan to waiting-operator/ and repaths
// the row's cell via `board.mjs update --plan-claim` BEFORE flipBoardPaused flips the
// state, so enforcing it here would refuse the repath, make orderedPlanMove roll the
// file move back, and break quarantine / blocked / cost-pause parking outright. The
// PUSH-time full-board lint (validateRows via main()) still gates the kind — which is
// where this plan's gate was always meant to fire.
const CELL_LINT_EXEMPT_KINDS = new Set(['WAITING_PLAN_ACTIVE_ROW']);

// validateRows scoped to ONE row of a full handoff-board.md text, found by slug
// — so a sibling's pre-existing drift can't fail the caller's own write (the
// full-board lint above still gates every push). Returns the errors array;
// a missing row is reported as ROW_NOT_FOUND, not thrown (callers decide).
export function validateRowInContent(content, slug, byBasename) {
  const { body } = splitBoard(content);
  const lines = body.split('\n');
  const idx = findRowLineIndex(lines, slug);
  if (idx === -1) {
    return [
      {
        kind: 'ROW_NOT_FOUND',
        path: slug,
        hint: `No board row found for slug "${slug}" inside the BOARD-START/END sentinels.`,
      },
    ];
  }
  return validateRows(
    [{ lineNumber: idx + 1, cells: cellsOf(lines[idx]), raw: lines[idx] }],
    byBasename,
  ).filter((e) => !CELL_LINT_EXEMPT_KINDS.has(e.kind));
}

// ── Foreign-drift attribution (plan 1664 — extends plan-1650's lint-plan-index.mjs
// tolerance to this sibling gate; see docs/superpowers/plans/archive/1650-*.md and
// drift-attribution-lib.mjs for the full rationale). A worktree branch inherits
// docs/handoff/board.md verbatim at cut/rebase time and cannot heal it (coord docs
// are never committed on a worktree branch) — a sibling's transient board/plan
// mismatch must not wedge every other session's push through this gate the same
// way plan 1650 already fixed for lint-plan-index.mjs.
//
// Pathspec set mirrors lint-plan-index.mjs's INDEX_INPUT_PATHSPECS shape: the board
// file itself (BOARD_REL — dynamic, so a config-less repo's `handoff-board.md` is
// covered too, not a hardcoded vetapp path), the plans tree this gate cross-checks
// board rows against, and every file this gate's OWN detection logic reads — a
// branch that edits board-lib.mjs / coord-config.mjs / build-index-lib.mjs's
// PLAN_FOLDER_ALT / this file can make `validateRows` disagree with a committed
// board it never touched, and that drift is the branch's OWN doing (plan 1650
// review [0] precedent).
export const BOARD_INPUT_PATHSPECS = [
  BOARD_REL,
  'docs/superpowers/plans',
  'coord.config.json',
  'scripts/coord/board-lib.mjs',
  'scripts/coord/coord-config.mjs',
  'scripts/coord/build-index-lib.mjs',
  'scripts/lint-board.mjs',
  // plan 1664 review [0]/[1]: the git-attribution engine this gate calls into lives in
  // drift-attribution-lib.mjs, not inline here — it MUST be an input for the same reason
  // lint-board.mjs itself is: a branch that weakens the fail-closed logic must not get to
  // grade its own change as "inherited" via the very logic it just edited.
  'scripts/coord/drift-attribution-lib.mjs',
];

// `env` (plan 1669) defaults to `{}`, NOT `process.env` — same rationale as
// lint-plan-index.mjs's driftIsInherited: keeps every test in this file (which calls
// `driftIsInherited({ _exec })` with no `env`) immune to whatever `.husky/pre-push` may
// have exported into the ambient process environment; only the real call site below
// opts in by passing `env: process.env` explicitly.
export function driftIsInherited({ repoRoot = REPO_ROOT, _exec = execFileSync, env = {} } = {}) {
  return computeDriftIsInherited({ repoRoot, pathspecs: BOARD_INPUT_PATHSPECS, _exec, env });
}

// Self-diagnosis (plan 2099): is THIS worktree's own copy of BOARD_REL simply behind
// origin/master's copy? Orthogonal to driftIsInherited above — see
// drift-attribution-lib.mjs's checkWorktreeCoordDocStale doc comment for why a
// worktree that authored/moved its own plan file can go strict there even when
// board.md itself was never touched by this branch. `localContent` is the caller's
// already-read board.md text (main() reads it once for validateRows; no double read).
export function checkBoardStale({
  repoRoot = REPO_ROOT,
  localContent,
  _exec = execFileSync,
  env = {},
}) {
  return checkWorktreeCoordDocStale({ repoRoot, relPath: BOARD_REL, localContent, _exec, env });
}

// Telemetry (plan 1731): marks the "board" hit, THEN consults driftIsInherited —
// regardless of whether that resolves inherited or strict. main() calls this instead of
// inlining both calls, so the "mark at the consult point, before the outcome" contract is
// pinned by a unit test without an end-to-end git-repo drive of main(). No-op on
// telemetry unless .husky/pre-push exported COORD_PUSH_TELEMETRY_HITS_FILE (see
// push-telemetry-lib.mjs). Mirrors lint-plan-index.mjs's makeInheritedDriftChecker.
export function checkDriftIsInheritedWithTelemetry({ env = process.env, ...opts } = {}) {
  markPushTelemetryHit('board', env);
  return driftIsInherited({ env, ...opts });
}

// Shared WARN wording for a tolerated inherited violation — loud, so the pass is
// never mistaken for "no drift", and it names the master-side heal. Mirrors
// lint-plan-index.mjs's warnInherited (plan 1650 layer 2).
function warnInherited(errorCount) {
  console.error('');
  console.error(
    `lint-board: WARN — ${errorCount} drift issue${errorCount === 1 ? '' : 's'} in ${BOARD_REL} ` +
      `(the drift listed above IS that violation), but this branch's own commits touched no ` +
      `board/plan inputs since its merge-base with origin/master and the working tree is clean ` +
      `over them: the violation is INHERITED master drift, not this push's doing. Passing ` +
      `(plan 1664, mirroring plan 1650 layer 2).`,
  );
  console.error(
    `  Heal master (from the MAIN checkout): fix the board row (node scripts/board.mjs …) then ` +
      `commit via coordWrite.`,
  );
  console.error('');
}

export async function main() {
  if (!existsSync(BOARD_PATH)) {
    // Pre-extraction project / legacy worktree — single-write through handoff.md is still valid.
    console.log(`lint-board: ${BOARD_REL} absent — skipping (legacy single-write project)`);
    return 0;
  }

  const planPaths = await walkMarkdown(PLANS_DIR);
  const planRels = planPaths.map(planRelPath);
  const byBasename = new Map();
  for (const rel of planRels) {
    const b = basename(rel);
    if (!byBasename.has(b)) byBasename.set(b, []);
    byBasename.get(b).push(rel);
  }

  const boardContent = await readFile(BOARD_PATH, 'utf8');
  const boardSection = extractBoardSection(boardContent);
  const rows = parseBoardRows(boardSection);

  const errors = validateRows(rows, byBasename);

  if (errors.length === 0) {
    const refCount = rows.reduce((n, r) => n + extractPlanRefs(r.cells[3] || '').length, 0);
    console.log(`lint-board: clean (${rows.length} rows checked, ${refCount} plan refs)`);
    return 0;
  }

  console.error('');
  console.error(
    `lint-board: ${errors.length} drift issue${errors.length === 1 ? '' : 's'} in ${BOARD_REL} vs docs/superpowers/plans/\n`,
  );
  for (const e of errors) {
    console.error(`  [${e.kind}] ${e.path}`);
    console.error(`    ${e.hint}\n`);
  }

  if (checkDriftIsInheritedWithTelemetry({ env: process.env })) {
    warnInherited(errors.length);
    return 0;
  }

  // plan 2099: before telling the user to hand-fix a coord row, check whether their
  // OWN checkout's board.md is simply stale vs. origin/master — the common case when
  // this branch's own plan-file churn (pickup-plan/move-plan) disqualified the
  // inherited-drift tolerance above even though board.md itself was never touched.
  const staleness = checkBoardStale({ localContent: boardContent, env: process.env });
  if (staleness.stale) {
    console.error(formatStaleWorktreeCoordDocMessage(BOARD_REL, staleness));
  }

  console.error('Fix the drift, then re-attempt the push.');
  console.error(
    'To skip this check in an emergency: git push --no-verify (but consider why first).',
  );
  return 1;
}

// Only run main() when invoked as a CLI (not when imported by tests).
import { pathToFileURL } from 'node:url';
import { repoRootFrom } from './scripts-anchor.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('lint-board: unexpected error', err);
      process.exit(2);
    },
  );
}
