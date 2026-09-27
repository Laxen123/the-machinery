#!/usr/bin/env node
// scripts/batches-view.mjs (plan 1373, Task 5)
//
// READ-ONLY render helper for the operator-approved batch roster
// (`docs/superpowers/batches/proposed.md`, plan 1364; moved from
// `docs/handoff/batches/` by plan 1430 — see PROPOSED_REL/LEGACY_PROPOSED_REL
// below for the transition-window fallback). Twin of
// `scripts/landing-queue-board.mjs`: it never mutates its input, it only
// parses + pretty-prints. Renders one row per proposed batch:
//
//   slug · lane(🟩/🟥) · members · model-per-member(🟢 sonnet/🟣 fable) ·
//   dependencies · drift-flag
//
// The `/batches` skill (D5, a separate coord-skill deliverable in the parent
// umbrella repo — NOT part of this project's slice) is the operator-facing entry that shells
// this script; this file is the parser + table.
//
// ── The `## Dependencies` block format (D4) ─────────────────────────────────
// board-pass (edited separately, in the parent umbrella repo) is expected to EMIT this
// format into proposed.md; this script is written FIRST and DEFINES it, since
// the live proposed.md at authoring time carries no such section yet — the
// parser below is REQUIRED to degrade gracefully (empty deps, no crash) when
// the heading is absent, and every caller of this module should keep relying
// on that rather than asserting the section exists.
//
// Shape:
//
//   ## Dependencies
//
//   ```dependencies
//   <left> <relation> <right> [: <free-text reason>]
//   ```
//
//   - One edge per line inside a SINGLE fenced block whose info-string is
//     exactly `dependencies`, directly under a `## Dependencies` heading
//     (matched loosely — trailing prose on the heading line is fine).
//   - `<left>` / `<right>` are each either a batch slug
//     (`batch-2026-07-05-seed-heavy`) or a bare plan id (`1371`) — whichever
//     the edge concerns. A batch-vs-batch edge, a batch-vs-non-batched-plan
//     edge (e.g. `1371 overlaps 1362`), and a plan-vs-plan edge (an explicit
//     Blocked-by inside one batch) are all the same shape.
//   - `<relation>` is one of `blocked-by` | `overlaps` | `order-after`
//     (land-ordering). Edges are recorded as board-pass computed them —
//     directional relations (`blocked-by`, `order-after`) are NOT
//     auto-reversed by this parser; write both directions explicitly if both
//     are meaningful.
//   - An optional ` : <reason>` suffix is free text (rendered verbatim,
//     never parsed further) — e.g. the specific shard/file that collided.
//   - Blank lines and `#`-prefixed comment lines inside the fence are
//     ignored. A line that doesn't match the 2-or-3-part shape is SKIPPED
//     (not fatal) — a malformed edge must never crash the view.
//
// Example:
//
//   ## Dependencies
//
//   ```dependencies
//   1373 blocked-by 1371
//   batch-2026-07-05-seed-heavy overlaps batch-2026-07-05-seed-small : record-034
//   1371 order-after 1362
//   ```
//
// ── Flags + the non-sonnet LANE label ────────────────────────────────────
// Two different axes, deliberately separated by plan 2556.
//
// The non-sonnet LANE label (🟣/🔶, `row.hasNonSonnetMember` + the per-lane
// `row.nonSonnetIds` map) — any member's EFFECTIVE execModel is fable/sol;
// effective model = frontmatter `execModel:` OR the `FABLE-`/`SOL-` filename
// segment, via the shared lint-filename-execmodel-drift helpers (single source
// of truth, plan 1362, extended to `sol` by plan 3341) — never a re-rolled
// read. This is ROUTING, not a defect: a Sonnet `batch-train` conductor cannot
// ride these members, so the train needs a heavy session (/local-drain's
// Modification 3), the fable-full cloud routine's Fable-batch section, or an
// Opus-orchestrated interactive session (sol) instead. Before plan 2556 no
// such executor existed and this set `flagged`, so a perfectly runnable fable
// pair was counted in "(N flagged ⚠)" and listed under "drift flags" —
// reading as broken when it was only differently-conducted.
//
// plan 3341 review (finding A, keys 65921f/19fad0/6ffba7/6d2ef3): this field
// used to be named `fableLane` and carry a boolean while the per-member tally
// below generalised to `nonSonnetIds` — so an all-sol batch still rendered
// "(N flagged ⚠) (N 🟣 fable-lane)" in the terminal summary, actively
// misrouting the operator to Fable when the train actually needs the Sol
// executor. Renamed to `hasNonSonnetMember`/no bare fable count so the name
// matches what it means, and the terminal summary below now reports each
// non-sonnet lane present by its own name/icon, lane-keyed like `nonSonnetIds`
// — a fourth lane needs no new counter here either.
//
// A batch is FLAGGED (⚠) when:
//   - any member's CURRENT plan folder (found by scanning
//     docs/superpowers/plans/*/ live, not the roster's snapshot) is anything
//     other than `ready/` — the roster's own header contract is "all members
//     ready + specced", so anything else is drift since the roster was written
//     (claimed → in-progress/, re-parked → waiting-*/, landed → archive/, or
//     simply not found). The header's historical "+ sonnet" clause is NOT a
//     drift condition and never was one here — since plan 2556 the claim gate
//     asks for lane HOMOGENEITY (all-sonnet or all-fable, never mixed) rather
//     than sonnet-only, and an all-fable roster is a legitimate runnable batch.
//
// Usage: node scripts/batches-view.mjs [--html [outPath]]
//   --html [outPath]  render the same parsed model to a self-contained HTML
//                      file instead of the terminal table (default
//                      .scratch/batches-view.html; an explicit outPath
//                      overrides). No external fetches, no JS — read-only.
// Exit codes: 0 always (a missing/empty proposed.md is reported, not fatal).
//
// ── Ready-plan roster section (plan 1496) ────────────────────────────────
// Besides the proposed-batch table, both renderers append a LIVE-scanned
// "Ready plans by category" section: every plan currently in ready/ (via the
// same canonical lsPlans/statusOf helpers the drift check uses — never the
// roster doc, which only knows what the last board-pass wrote), grouped by
// its filename category prefix (`<id>-(FABLE-)?<Category>-<slug>.md` → DQ /
// UI / Infra / Reuse / Fix / Other / …), one line per plan:
//
//   <id> 🟢/🟣 <H1 title = what it does> — <💰 cost-forecast line, condensed>
//   [in <batch-slug>]   (when the id rides a proposed batch)
//
// The cost line is the plan's own mandatory 💰 banner — i.e. spend BEYOND the
// executing session (API/scraping/claude -p dollars), not the session itself.
// Graceful degrade throughout: no 💰 line → "no 💰 line", unparseable
// basename → category `?`, unreadable file → title falls back to the slug.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
// plan 3341 delta-review follow-up (key 2740d4): hasFableSegment/hasSolSegment are no longer
// imported by NAME — effectiveLane's fallback and parsePlanBasename's segment-strip both drive
// off LANE_SEGMENTS generically now, which already carries each lane's `test` predicate.
import { readExecModel, LANE_SEGMENTS } from './coord/lint-filename-execmodel-drift.mjs';
// The fail-closed lane resolver (plan 3341) — the ONE seam a lane ternary migrates to, never a
// re-rolled `=== 'fable' ? … : 'sonnet'` binary. See `effectiveLaneOf` below for how this
// READ-ONLY view stays crash-proof against a genuinely unrecognized execModel value.
// EXEC_LANE_TABLE also supplies this module's lane glyphs (see LANE_ICON below, review finding
// C) — imported alongside resolveExecLane since both come from the same canonical table.
import { resolveExecLane, EXEC_LANE_TABLE } from './coord/claim-plan-lib.mjs';
import { resolvePlanRel, lsPlans, statusOf } from './coord/move-plan.mjs';
import { canonicalRepoRoot } from './coord/coord-share-lib.mjs';
// Canonical plan-metadata parses (review 1496): H1 + plan-id shape from
// build-index-lib, the 💰 cost-banner line from queue-drain's parsePlanMeta
// (the plan-1260 "SINGLE authority" the drain/lint already branch on) — never
// re-rolled copies that could drift from what the other surfaces read.
import {
  readH1,
  planIdOf,
  sectionBounds,
  multiSectionBounds,
  READY_FOLDER,
} from './coord/build-index-lib.mjs';
import { parsePlanMeta } from './coord/queue-drain.mjs';
// Canonical HTML escape — import this instead of copying (review F8: this module used
// to carry its own byte-identical copy). Re-exported so existing callers/tests importing
// escapeHtml from batches-view.mjs keep working unchanged.
// plan 4096 T6: from the core helper, not the dossier renderer — that import was this command's
// only blocked closure edge at the coord-kit gate.
import { escapeHtml } from './coord/html-escape.mjs';
export { escapeHtml };
// plan 1467: the batch-folder ABI (per-batch folders + batch.md grammar). The folder tree is
// now the PRIMARY roster source; proposed.md is the transition-window fallback (below).
import {
  BATCHES_DIR_REL,
  LEGACY_BATCH_MANIFEST_DIR_REL,
  walkBatchFolders,
} from './coord/batch-paths.mjs';
// The emoji-width accounting (plan 2524) lives in box-table.mjs — this module used to carry
// its own copy (dispWidth + padCell + a local WIDE_BMP_GLYPHS set), reimplemented "so this
// module has no coupling to the landing-queue family". That rationale went stale once
// box-table.mjs became neutral primitives owned by no board (plan 2526): ⚠/❓, the two glyphs
// this module's own set carried that box-table's didn't, are now unioned into box-table's
// WIDE_BMP, so all three coordination boards (/landing-queue, /ready-plans, /batches) share one
// width rule. `renderTable` below now calls box-table's `renderBox` directly (plan 2561) —
// `renderBox` grew a `headerAlign` option for exactly this module's one real difference: its
// header row is left-aligned, where the other two boards always center headers.
import { dispWidth, renderBox } from './coord/box-table.mjs';
export { dispWidth };

// Canonical path since plan 1430 (the roster is plan-lifecycle material, reads
// better next to docs/superpowers/plans/ than in session-handoff state). The
// LEGACY path is kept as a one-transition-window fallback — parallel sessions
// may still hold stale skill text pointing at the old location — and should be
// removed by a follow-up once every reference has been repointed.
const PROPOSED_REL = 'docs/superpowers/batches/proposed.md';
const LEGACY_PROPOSED_REL = 'docs/handoff/batches/proposed.md';

// ── Section slicing ──────────────────────────────────────────────────────
// `## Batches`, `## Fable lane`, `## Not batched`, `## Dependencies` — each
// heading's section runs to the next heading of the same-or-shallower level,
// fence-aware (or EOF) — the shared build-index-lib scanner (plan 2052; see
// its header comment for why fence-awareness is load-bearing here in
// particular: dependencies.md's own ` ```dependencies ` fence carries
// `# Reconciled …` comment lines that a fence-blind scan would misread as H1
// terminators). Loose match on the trailing heading text (proposed.md's
// headings carry parenthetical commentary), anchored on the fixed leading
// words only.
const BATCHES_HEADING_RX = /^## Batches\b.*$/m;
const FABLE_HEADING_RX = /^## Fable lane\b.*$/m;
const NOT_BATCHED_HEADING_RX = /^## Not batched\b.*$/m;
const DEPENDENCIES_HEADING_RX = /^## Dependencies\b.*$/m;

function sliceAfterHeading(text, headingRx) {
  const bounds = sectionBounds(text, headingRx);
  return bounds ? text.slice(bounds.start, bounds.end) : null;
}

// ── Batches table ────────────────────────────────────────────────────────
// `| Batch slug | Lane | Members | Theme |` markdown table under `## Batches`.
// Row 0 = header, row 1 = separator, row 2+ = data (the fixed shape every
// proposed.md revision to date has used — plan 1364's own template).
//
// Split into an already-sliced-section inner parse plus the slicing public
// wrapper (plan 2083) so parseProposedMd can share ONE multi-heading scan
// across all four sub-parsers below instead of each one re-slicing via its
// own single-heading sectionBounds call.
function parseBatchesTableSection(section) {
  if (!section) return [];
  const tableLines = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'));
  return tableLines.slice(2).map((line) => {
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    const [slugRaw, lane, membersRaw, theme] = cells;
    const slug = (slugRaw || '').replace(/`/g, '');
    const members = (membersRaw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { slug, lane: (lane || '').trim(), members, theme: (theme || '').trim() };
  });
}

export function parseBatchesTable(text) {
  return parseBatchesTableSection(sliceAfterHeading(text, BATCHES_HEADING_RX));
}

// Fable lane / Not-batched sections: plain bullet lists, kept as raw text
// (context for the operator; not part of the D5 table columns).
function parseBulletSectionFromSlice(section) {
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
}

function parseBulletSection(text, headingRx) {
  return parseBulletSectionFromSlice(sliceAfterHeading(text, headingRx));
}

export function parseFableLane(text) {
  return parseBulletSection(text, FABLE_HEADING_RX);
}

export function parseNotBatched(text) {
  return parseBulletSection(text, NOT_BATCHED_HEADING_RX);
}

// ── Dependencies block (D4 format, defined above) ───────────────────────
const DEP_FENCE_RX = /```dependencies\s*\n([\s\S]*?)```/m;
const DEP_LINE_RX = /^(\S+)\s+(blocked-by|overlaps|order-after)\s+(\S+)(?:\s*:\s*(.*))?$/;

function parseDependenciesBlockFromSlice(section) {
  if (!section) return []; // graceful degrade: no heading at all, or no section slice
  const fence = DEP_FENCE_RX.exec(section);
  if (!fence) return []; // heading present but no parseable fenced block yet
  const edges = [];
  for (const raw of fence[1].split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = DEP_LINE_RX.exec(line);
    if (!m) continue; // tolerate junk — a malformed edge must never crash the view
    edges.push({ left: m[1], relation: m[2], right: m[3], reason: (m[4] || '').trim() });
  }
  return edges;
}

export function parseDependenciesBlock(text) {
  return parseDependenciesBlockFromSlice(sliceAfterHeading(text, DEPENDENCIES_HEADING_RX));
}

// The four sub-parsers above each independently re-slice the FULL text via their
// own sectionBounds call — four full fence-aware scans of the same document per
// parseProposedMd invocation. multiSectionBounds resolves all four headings'
// bounds from ONE shared scan instead (plan 2083; see its build-index-lib.mjs
// header comment); each section is then sliced and handed to the matching
// slice-only inner parser above.
const PROPOSED_MD_HEADINGS = [
  BATCHES_HEADING_RX,
  FABLE_HEADING_RX,
  NOT_BATCHED_HEADING_RX,
  DEPENDENCIES_HEADING_RX,
];

// Shared by every multi-heading-on-one-text call site below (parseProposedMd's
// four sections, loadFolderRoster's fable-lane/not-batched pair) — slices one
// resolved heading's section out of a multiSectionBounds() Map, or null when
// that regex had no match (mirrors sliceAfterHeading's null-on-absent).
function sliceFromBounds(text, bounds, headingRx) {
  const b = bounds.get(headingRx);
  return b ? text.slice(b.start, b.end) : null;
}

export function parseProposedMd(text) {
  const bounds = multiSectionBounds(text, PROPOSED_MD_HEADINGS);
  return {
    batches: parseBatchesTableSection(sliceFromBounds(text, bounds, BATCHES_HEADING_RX)),
    fableLane: parseBulletSectionFromSlice(sliceFromBounds(text, bounds, FABLE_HEADING_RX)),
    notBatched: parseBulletSectionFromSlice(sliceFromBounds(text, bounds, NOT_BATCHED_HEADING_RX)),
    dependencies: parseDependenciesBlockFromSlice(
      sliceFromBounds(text, bounds, DEPENDENCIES_HEADING_RX),
    ),
  };
}

// ── Member plan lookup (drift + model detection) ────────────────────────
// Resolves live (never the roster's snapshot) via the SAME canonical
// id→path/status helpers edit-plan.mjs already composes for the identical
// question (plan-id → current rel path + status folder) — `lsPlans`/
// `resolvePlanRel`/`statusOf` (scripts/move-plan.mjs), reading the git index
// rather than a re-rolled readdirSync scan. Folder-name-agnostic on purpose —
// new status folders (e.g. plan 1371's `pending-approval/`) need no update
// here: statusOf just reads whatever segment follows PLANS_PREFIX.
// plan 3341 review (finding C, key ba580c): this used to be this module's OWN icon literal
// (🟢/🟣/🔶), independently typed from ready-board.mjs's LANE_LABEL — which is how the two
// boards ended up disagreeing on the sonnet glyph (this file 🟢, ready-board.mjs 🔵) for the
// SAME lane. Both now derive their glyph from EXEC_LANE_TABLE's `icon` field (claim-plan-lib.mjs)
// — the one place a lane's glyph is spelled out — so a third display can never introduce a
// fourth spelling, and adding a lane there is the only edit either board needs.
const LANE_ICON = Object.fromEntries(
  Object.entries(EXEC_LANE_TABLE).map(([lane, { icon }]) => [lane, icon]),
);

// Effective execModel key for a member: frontmatter execModel, falling back to a FABLE-/SOL-
// filename segment ONLY when the frontmatter carries no execModel value at all (shared
// lint-filename-execmodel-drift helpers — plan 1362 single source of truth, extended to `sol`
// by plan 3341), resolved through the shared fail-closed lane table (claim-plan-lib.mjs)
// rather than a re-rolled `=== 'fable' ? … : 'sonnet'` binary — so a `sol` member reports its
// own lane instead of being silently folded into sonnet.
//
// plan 3341 review (finding D, key c40606): this used to let a FABLE-/SOL- filename segment
// override an EXPLICIT, disagreeing frontmatter value (`raw === 'fable' || hasFableSegment(…)`
// — the segment check ran regardless of what `raw` said), so a display could silently show a
// lane the plan does not actually execute in. lint-filename-execmodel-drift.mjs's own header
// states the rule this repo already committed to: "the orchestrator drain's execModel filter
// reads the FRONTMATTER field, never the filename (filename is display, frontmatter is
// truth)". That lint's "what to fix" suggestion sometimes points at renaming the filename
// TOWARD an explicit frontmatter value and sometimes at re-stamping frontmatter TOWARD an
// explicit filename segment — it is choosing the cheaper repair, not asserting which side is
// semantically authoritative. A read-only display has no such repair to make, so it follows
// the stated truth: an explicit frontmatter value always wins, and the filename segment is
// consulted only to label a plan whose frontmatter carries none.
//
// plan 3341 delta-review follow-up (key 2740d4): the filename-segment fallback used to be a
// hardcoded two-marker ternary (`hasFableSegment(basename) ? 'fable' : hasSolSegment(basename)
// ? 'sol' : raw`) — a THIRD segment-bearing lane (one new LANE_SEGMENTS row) would fall through
// to `raw` here (which is `''`, since this branch only runs when frontmatter carries no
// execModel at all), so a plan correctly marked with that new marker in its filename would
// still resolve to sonnet instead of its real lane. Driven by LANE_SEGMENTS generically
// instead — the SAME (lane, marker, test) table parsePlanBasename already reads above — so a
// fourth segment-bearing lane needs one new LANE_SEGMENTS row, never a new branch here.
function effectiveLane(content, basename) {
  const raw = readExecModel(content);
  const key = raw !== '' ? raw : (LANE_SEGMENTS.find(({ test }) => test(basename))?.lane ?? raw);
  try {
    return resolveExecLane(key).lane;
  } catch {
    return null;
  }
}

export function findMemberPlan(mainDir, id) {
  const notFound = { id, found: false, folder: null, basename: null, execModel: null };
  let plans;
  try {
    plans = lsPlans(mainDir);
  } catch {
    return notFound;
  }
  let rel;
  try {
    rel = resolvePlanRel(plans, String(id));
  } catch {
    // not found OR ambiguous (multiple matches) — either way, flag as drift
    // rather than crash the view (a malformed roster must never wedge it).
    return notFound;
  }
  const folder = statusOf(rel);
  const basename = rel.split('/').pop();
  let content = '';
  try {
    content = readFileSync(join(mainDir, rel), 'utf8');
  } catch {
    /* unreadable — treat as found with unknown model below */
  }
  const execModel = effectiveLane(content, basename);
  return { id, found: true, folder, basename, execModel };
}

export function modelIcon(memberInfo) {
  if (!memberInfo.found) return '❓';
  return LANE_ICON[memberInfo.execModel] ?? '❓';
}

// Dependency edges that mention this batch's slug OR any of its member ids,
// on either side. Rendered verbatim (left relation right [reason]) — no
// direction-flipping, since `blocked-by`/`order-after` are directional and a
// mechanical flip would silently invert their meaning.
export function depsForBatch(dependencies, batch) {
  const keys = new Set([batch.slug, ...batch.members]);
  return dependencies.filter((d) => keys.has(d.left) || keys.has(d.right));
}

export function renderDepsCell(deps) {
  if (!deps.length) return '—';
  return deps
    .map((d) => `${d.left} ${d.relation} ${d.right}${d.reason ? ` (${d.reason})` : ''}`)
    .join('; ');
}

// One annotated row per proposed batch: live member lookups + matched deps +
// the two flag classes (non-sonnet member / drifted-out-of-ready member). `mainDir`
// is the repo root findMemberPlan resolves plan ids against (git ls-files).
export function annotateBatch(mainDir, batch, dependencies = []) {
  const memberInfo = batch.members.map((id) => findMemberPlan(mainDir, id));
  // plan 3341: ONE lane-keyed tally, not a fable-only counter — a `sol` member is neither
  // fable nor sonnet, so folding it into either bucket (or adding a parallel `solIds`
  // counter) would misreport or not scale to a fourth lane. `nonSonnetIds` maps each
  // non-sonnet lane present to its member ids, in first-seen order.
  const nonSonnetIds = {};
  for (const m of memberInfo) {
    if (m.found && m.execModel && m.execModel !== 'sonnet') {
      (nonSonnetIds[m.execModel] ||= []).push(m.id);
    }
  }
  const driftIds = memberInfo.filter((m) => !m.found || m.folder !== READY_FOLDER).map((m) => m.id);
  const deps = depsForBatch(dependencies, batch);
  return {
    ...batch,
    memberInfo,
    nonSonnetIds,
    driftIds,
    deps,
    // plan 2556: `flagged` is the WARNING axis — drift only. A non-sonnet-lane member is a
    // routing LABEL, not a defect: since plan 2556 a fable batch has an executor (a heavy
    // local session, or the fable-full cloud routine's Fable-batch section), and a sol batch
    // an Opus-orchestrated session, so counting it in "(N flagged ⚠)" and listing it under
    // "drift flags" told the operator a runnable train was broken. `hasNonSonnetMember` carries
    // that fact separately — renamed from the old `fableLane` boolean (plan 3341 review finding
    // A) once a `sol`-only batch started tripping it too: the old name said "fable" while
    // meaning "any non-sonnet member", which is exactly how it got rendered as Fable work below.
    hasNonSonnetMember: Object.keys(nonSonnetIds).length > 0,
    flagged: driftIds.length > 0,
  };
}

export function renderFlagCell(row) {
  const parts = [];
  // Same glyph the Model column uses for that lane's member (plan 2556, extended by plan
  // 3341), not ⚠ — the cell reads "this train runs in the fable/sol lane" rather than "this
  // train is broken". The distinction it marks is real and worth keeping: `batch-train` is a
  // Sonnet-only mechanical conductor and cannot ride these members; a heavy session (fable)
  // or an Opus-orchestrated session (sol) must take them instead.
  for (const [lane, ids] of Object.entries(row.nonSonnetIds ?? {})) {
    parts.push(`${LANE_ICON[lane] ?? '❓'} ${lane}(${ids.join(',')})`);
  }
  if (row.driftIds.length) parts.push(`⚠ drift(${row.driftIds.join(',')})`);
  // plan 1467: a gated batch (batch.md `gate:` set) is claimable only once its blocker
  // lands — surface the gate so its members-not-in-ready/ drift reads as "gated", not rot.
  if (row.gate) parts.push(`⛔ gate(${row.gate})`);
  return parts.length ? parts.join(' ') : '—';
}

// ── Ready-plan roster: category + title + cost (plan 1496) ───────────────
// Live view of everything in ready/, independent of the roster doc (which
// only lists what the last board-pass sweep chose to mention). Category is
// the filename prefix segment; "what it does" is the plan's H1; cost is the
// plan's mandatory 💰 banner condensed to one line.

// `<id>-(FABLE-|SOL-)?<Category>-<rest>.md` — the vetapp plan-filename convention.
// The id rule is planIdOf's (build-index-lib — `\d{3,}` + letter lookahead, so
// legacy date-prefixed names fall through), NOT a second regex encoding of it;
// FABLE-/SOL- are model segments, not a category (the shared hasFableSegment/
// hasSolSegment helpers own model detection, and the two are mutually exclusive
// by construction — plan 3341); the category is the token after whichever (if
// any) is present.
const CATEGORY_RX = /^([A-Za-z][A-Za-z0-9]*)-(.+)\.md$/;

export function parsePlanBasename(basename) {
  const idNum = planIdOf(basename);
  const bare = String(basename || '');
  const noMatch = { id: null, category: '?', rest: bare.replace(/\.md$/, '') };
  if (!Number.isFinite(idNum)) return noMatch;
  // plan 3341 fix: this used to strip ONLY a hardcoded `^FABLE-`, so a `SOL-` lane segment fell
  // through to CATEGORY_RX untouched and was misread as the CATEGORY itself (e.g.
  // `102-SOL-DQ-x.md` parsed as category `SOL`, rest `DQ-x` — grouping a sol plan under a bogus
  // "SOL" bucket in groupReadyPlans/renderReadyRoster instead of its real category, `DQ`). The
  // two markers are mutually exclusive by construction, so at most one entry below ever
  // matches.
  let after = bare.replace(/^\d+-/, '');
  // LANE_SEGMENTS (lint-filename-execmodel-drift.mjs) is the single source for the
  // (lane, marker, detector) triple: `test` is the canonical predicate, `marker` supplies the
  // one fact it does not expose — how many characters to skip once it says yes. `test` runs
  // against the ORIGINAL basename, id prefix intact (it matches `^\d{3,}-FABLE-`), never the
  // post-id `after` string below.
  const segment = LANE_SEGMENTS.find(({ test }) => test(bare));
  if (segment) after = after.slice(segment.marker.length);
  const m = CATEGORY_RX.exec(after);
  if (!m) return { ...noMatch, id: String(idNum) };
  return { id: String(idNum), category: m[1], rest: m[2] };
}

// The banner line itself comes from parsePlanMeta (queue-drain) — the exact
// signal the drain's cost-pause and the pre-push cost lint branch on, so this
// view can never disagree with them about WHICH line is the banner. cost is
// content-only in that parse (plan-cost-banner precedent), so the placeholder
// basename is fine. The one display-only cleanup: a parenthetical label
// variant ("Cost forecast (per pass):") leaves its parenthetical + colon/bold
// at the head of cost.raw — strip it here, it's presentation, not parsing.
export function extractCostLine(content) {
  const raw = parsePlanMeta('0-placeholder.md', content).cost.raw;
  if (raw == null) return null;
  return raw
    .replace(/^\([^)]*\)[:*\s]*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Codepoint-aware (spread, not .slice-by-code-unit): a surrogate-pair emoji
// landing exactly on the boundary must not be split into a lone surrogate.
export function truncateText(s, max) {
  const chars = [...s];
  return chars.length <= max
    ? s
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

export function scanReadyPlans(mainDir) {
  let plans;
  try {
    plans = lsPlans(mainDir);
  } catch {
    return []; // no git index reachable — degrade to an empty roster, never crash
  }
  const entries = [];
  for (const rel of plans) {
    if (statusOf(rel) !== READY_FOLDER) continue;
    const basename = rel.split('/').pop();
    const { id, category, rest } = parsePlanBasename(basename);
    let content = '';
    try {
      content = readFileSync(join(mainDir, rel), 'utf8');
    } catch {
      /* unreadable — title/cost fall back below */
    }
    const execModel = effectiveLane(content, basename);
    entries.push({
      id,
      category,
      basename,
      execModel,
      title: readH1(content) || rest,
      cost: extractCostLine(content),
    });
  }
  entries.sort((a, b) => Number(a.id ?? Infinity) - Number(b.id ?? Infinity));
  return entries;
}

// Category groups ordered biggest-first (ties alphabetical) — the operator
// scans "where is the bulk of the ready work" before individual rows.
export function groupReadyPlans(entries) {
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.category)) byCat.set(e.category, []);
    byCat.get(e.category).push(e);
  }
  return [...byCat.entries()]
    .map(([category, group]) => ({ category, entries: group }))
    .sort((a, b) => b.entries.length - a.entries.length || a.category.localeCompare(b.category));
}

// id → first proposed-batch slug it rides (roster order), for the [in <slug>]
// annotation.
export function batchMembershipMap(batches) {
  const map = new Map();
  for (const b of batches) {
    for (const id of b.members) if (!map.has(id)) map.set(id, b.slug);
  }
  return map;
}

const NO_COST_LINE = 'no 💰 line';
const TITLE_MAX = 88;
const COST_MAX = 110;

export function renderReadyRoster(entries, memberBatch = new Map()) {
  if (!entries.length) return 'Ready plans: none in ready/.';
  // plan 3341: ONE lane-keyed tally, not a fable-only counter — a `sol` entry must count as
  // its own lane, not be folded into "fable" or vanish uncounted from "sonnet". `fable`
  // always renders (even at 0) to keep this header byte-identical for every pre-3341 caller;
  // any OTHER non-sonnet lane (sol, or a future one) only renders when present.
  const nonSonnetCounts = new Map();
  for (const e of entries) {
    if (e.execModel && e.execModel !== 'sonnet') {
      nonSonnetCounts.set(e.execModel, (nonSonnetCounts.get(e.execModel) ?? 0) + 1);
    }
  }
  const fableCount = nonSonnetCounts.get('fable') ?? 0;
  const otherLaneSummary = [...nonSonnetCounts]
    .filter(([lane]) => lane !== 'fable')
    .map(([lane, n]) => `${n} ${LANE_ICON[lane] ?? '❓'} ${lane}`)
    .join('; ');
  const lines = [
    `Ready plans by category (${entries.length} total, ${fableCount} 🟣 fable; ` +
      (otherLaneSummary ? `${otherLaneSummary}; ` : '') +
      'cost = spend beyond the executing session):',
  ];
  for (const g of groupReadyPlans(entries)) {
    lines.push(`  ${g.category} (${g.entries.length}):`);
    for (const e of g.entries) {
      const icon = LANE_ICON[e.execModel] ?? '❓';
      const inBatch =
        e.id !== null && memberBatch.has(e.id) ? ` [in ${memberBatch.get(e.id)}]` : '';
      lines.push(
        `    ${e.id ?? '?'} ${icon} ${truncateText(e.title, TITLE_MAX)} — ` +
          `${truncateText(e.cost ?? NO_COST_LINE, COST_MAX)}${inBatch}`,
      );
    }
  }
  return lines.join('\n');
}

// ── Path resolution (new canonical path + legacy fallback, plan 1430) ──────
// Pure: takes the repo root and reports which of the two candidate paths (if
// either) exists on disk, so the CLI's deprecation-warning decision is a
// single readable branch and the resolution itself stays unit-testable
// without shelling out or mocking canonicalRepoRoot.
export function resolveProposedPath(root) {
  const primary = join(root, PROPOSED_REL);
  if (existsSync(primary)) return { path: primary, legacy: false };
  const legacy = join(root, LEGACY_PROPOSED_REL);
  if (existsSync(legacy)) return { path: legacy, legacy: true };
  return { path: null, legacy: false };
}

export function legacyDeprecationMessage() {
  return `batches-view: reading legacy ${LEGACY_PROPOSED_REL} — the roster moved to ${PROPOSED_REL} (plan 1430)`;
}

// ── Batch-folder source (plan 1467, the PRIMARY roster surface) ────────────
// Since plan 1467 each batch is a FOLDER docs/superpowers/batches/<slug>/ with a
// batch.md (frontmatter: slug, lane, members, gate, status; body: theme). This
// tree is the primary source; proposed.md (above) is only the transition-window
// fallback for a repo not yet migrated. Global cross-batch edges live in a single
// dependencies.md; fable-lane / not-batched prose lives in README.md (neighbors of
// the batch folders). All three parse with the SAME helpers proposed.md used, so
// annotate/render below are source-agnostic.
const DEPENDENCIES_REL = `${BATCHES_DIR_REL}/dependencies.md`;
const README_REL = `${BATCHES_DIR_REL}/README.md`;

function readTextIfExists(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// Every batch.md under docs/superpowers/batches/<slug>/ → the same
// {slug, lane, members, theme} shape parseBatchesTable produces, PLUS gate/status
// (folder-only fields). Missing/unreadable dir → [] (graceful degrade, mirrors the
// proposed.md parsers).
//
// Ordered by FOLDER NAME, which is what the walk sorts on — not by the `slug` column this
// view renders (plan 2518 review). The two agree for every batch in the tree today, since
// a folder is created as <slug>/ and its frontmatter repeats that slug; they can only
// diverge if a batch.md's `slug:` is edited without renaming its folder, which nothing
// enforces. Named here so the row order is not mistaken for a guarantee about the column.
export function loadBatchFolders(root) {
  const rows = [];
  // The readdir + reserved-dir skip + read + parseBatchMd walk lives in batch-paths.mjs
  // (plan 2518 item 5) — the module that already owns the batch-folder ABI — rather than
  // being re-rolled here. The `onSkip` hook keeps THIS caller's behaviour: name the folder
  // it dropped, mirroring the other graceful-degrade skips in this file, where the guard
  // path stays silent. Missing/unreadable dir still yields [] (the walk just ends).
  for (const { name, batch } of walkBatchFolders(join(root, BATCHES_DIR_REL), {
    onSkip: (folder) =>
      console.warn(`batches-view: skipping batch folder ${folder}/ — no readable batch.md`),
  })) {
    rows.push({
      slug: batch.slug || name,
      lane: batch.lane,
      members: batch.members,
      theme: batch.theme,
      gate: batch.gate,
      status: batch.status,
    });
  }
  return rows;
}

// True iff the folder tree carries at least one batch.md — the signal to prefer it
// over the proposed.md fallback.
export function hasBatchFolders(root) {
  return loadBatchFolders(root).length > 0;
}

// Parse the folder-source roster into the SAME {batches, fableLane, notBatched,
// dependencies} model parseProposedMd yields, so main()/renderers stay
// source-agnostic. Only PROPOSED batches populate the claimable table (claimed /
// landed folders are lifecycle history, not the roster) — the drift check's
// "members must be in ready/" contract only makes sense for a claimable batch.
export function loadFolderRoster(root) {
  const batches = loadBatchFolders(root).filter((b) => b.status === 'proposed');
  const depsText = readTextIfExists(join(root, DEPENDENCIES_REL));
  const readmeText = readTextIfExists(join(root, README_REL));
  // README_REL carries BOTH the fable-lane and not-batched bullet sections — share
  // one scan across them (plan 2083 review finding) instead of each of
  // parseFableLane/parseNotBatched independently re-scanning the same text.
  const readmeBounds = readmeText
    ? multiSectionBounds(readmeText, [FABLE_HEADING_RX, NOT_BATCHED_HEADING_RX])
    : null;
  return {
    batches,
    fableLane: readmeBounds
      ? parseBulletSectionFromSlice(sliceFromBounds(readmeText, readmeBounds, FABLE_HEADING_RX))
      : [],
    notBatched: readmeBounds
      ? parseBulletSectionFromSlice(
          sliceFromBounds(readmeText, readmeBounds, NOT_BATCHED_HEADING_RX),
        )
      : [],
    dependencies: depsText ? parseDependenciesBlock(depsText) : [],
  };
}

// Transition-window fallback (plan 1467): slugs of any manifest still at the legacy
// docs/handoff/batches/*.json path — a grandfathered in-flight batch claimed before
// the folder migration. Surfaced as a deprecation note only when the folder tree is
// the active source. [] on a missing/unreadable dir.
export function legacyManifestSlugs(root) {
  const dir = join(root, LEGACY_BATCH_MANIFEST_DIR_REL);
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

// ── Table rendering ──────────────────────────────────────────────────────
// `renderTable` calls box-table.mjs's `renderBox` (plan 2561) — see the header comment on the
// import above.

export function renderTable(rows) {
  const headers = ['Batch slug', 'Lane', 'Members', 'Model', 'Dependencies', 'Flag'];
  const dataRows = rows.map((r) => [
    r.slug,
    r.lane,
    r.members.join(', '),
    r.memberInfo.map(modelIcon).join(' '),
    renderDepsCell(r.deps),
    renderFlagCell(r),
  ]);
  // plan 2561: every column here is left-aligned (including the header row), unlike
  // renderBox's own centred default — pass centerCols: [] and headerAlign: 'left' to match.
  return renderBox(headers, dataRows, { centerCols: [], headerAlign: 'left' });
}

// ── HTML overview renderer (`--html`, plan 1430) ────────────────────────
// A second, self-contained renderer over the SAME parsed model the text
// table uses (parse-once, render-twice) — no external fetches, no JS, purely
// a static read-only view. Every string sourced from the roster is escaped;
// batch themes routinely carry backticks/angle-bracket-ish prose that would
// otherwise break the page or (worse) inject markup. escapeHtml itself is
// imported from lib/decision-dossier/inline.mjs above (review F8) — NOTE its
// escape set is `&<>"` only, no single quote, so every attribute this module
// interpolates escaped data into MUST be double-quoted (never single-quoted).

const HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f5f7; color: #1c1e21; margin: 0; padding: 2rem 2.5rem; line-height: 1.5; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8eb; }
    .card, .section { background: #1f2228 !important; border-color: #33363d !important; }
    .chip { background: #2a2d34 !important; }
  }
  h1 { font-size: 1.4rem; margin: 0 0 0.15rem; }
  .meta { color: #6b7280; font-size: 0.85rem; margin: 0 0 1.75rem; }
  .section { background: #fff; border: 1px solid #e2e4e8; border-radius: 8px;
    padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
  .section > h2 { font-variant: small-caps; letter-spacing: 0.04em; font-size: 0.8rem;
    text-transform: uppercase; color: #6b7280; margin: 0 0 0.75rem; }
  .card { border: 1px solid #e2e4e8; border-radius: 8px; padding: 0.85rem 1.1rem; margin-bottom: 0.85rem; }
  .card:last-child { margin-bottom: 0; }
  .card h3 { margin: 0 0 0.4rem; font-size: 1.02rem; }
  .theme { margin: 0.5rem 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0.5rem 0; }
  .chip { background: #eef0f3; border-radius: 999px; padding: 0.15rem 0.6rem; font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .section h3 { font-size: 0.95rem; margin: 0.85rem 0 0.4rem; }
  .row-meta { font-size: 0.85rem; color: #6b7280; }
  .flag-warn { color: #b45309; }
  ul { margin: 0; padding-left: 1.2rem; }
  li { margin-bottom: 0.3rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

function renderBatchCardHtml(row) {
  const chips = row.memberInfo
    .map((m, i) => `<span class="chip">${modelIcon(m)} ${escapeHtml(row.members[i])}</span>`)
    .join('');
  return `<div class="card">
    <h3>${escapeHtml(row.lane)} <code>${escapeHtml(row.slug)}</code></h3>
    <div class="chips">${chips}</div>
    <p class="theme">${escapeHtml(row.theme)}</p>
    <p class="row-meta"><strong>Dependencies:</strong> ${escapeHtml(renderDepsCell(row.deps))}</p>
    <p class="row-meta"><strong>Flags:</strong> <span${row.flagged ? ' class="flag-warn"' : ''}>${escapeHtml(renderFlagCell(row))}</span></p>
  </div>`;
}

function renderBulletListHtml(items) {
  if (!items.length) return '<p>None.</p>';
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function renderDriftFlagsHtml(rows) {
  const flagged = rows.filter((r) => r.flagged);
  if (!flagged.length) return '<p>No drift flags.</p>';
  return `<ul>${flagged
    .map((r) => `<li><code>${escapeHtml(r.slug)}</code> — ${escapeHtml(renderFlagCell(r))}</li>`)
    .join('')}</ul>`;
}

function renderDependenciesListHtml(deps) {
  if (!deps.length) return '<p>No <code>## Dependencies</code> block in the roster.</p>';
  return `<ul>${deps
    .map(
      (d) =>
        `<li><code>${escapeHtml(d.left)}</code> ${escapeHtml(d.relation)} <code>${escapeHtml(d.right)}</code>${d.reason ? ` — ${escapeHtml(d.reason)}` : ''}</li>`,
    )
    .join('')}</ul>`;
}

// Ready-plan roster as HTML: one sub-list per category group, mirroring the
// text renderer line-for-line (same truncation constants, same fallbacks).
function renderReadyRosterHtml(readyEntries, memberBatch) {
  if (!readyEntries.length) return '<p>None in <code>ready/</code>.</p>';
  return groupReadyPlans(readyEntries)
    .map((g) => {
      const items = g.entries
        .map((e) => {
          const icon = LANE_ICON[e.execModel] ?? '❓';
          const inBatch =
            e.id !== null && memberBatch.has(e.id)
              ? ` <code>[in ${escapeHtml(memberBatch.get(e.id))}]</code>`
              : '';
          return `<li>${escapeHtml(e.id ?? '?')} ${icon} ${escapeHtml(truncateText(e.title, TITLE_MAX))} — <span class="row-meta">${escapeHtml(truncateText(e.cost ?? NO_COST_LINE, COST_MAX))}</span>${inBatch}</li>`;
        })
        .join('');
      return `<h3>${escapeHtml(g.category)} (${g.entries.length})</h3><ul>${items}</ul>`;
    })
    .join('\n');
}

// `sourceRel` is the roster path actually read (new or legacy) for the
// generated-from note; `generatedAt` is a Date (system clock — this is a
// local render, not workflow code, so reading it here is fine).
// `readyEntries`/`memberBatch` (plan 1496) feed the ready-plan roster section;
// both default empty so pre-1496 callers/tests keep working unchanged.
export function renderRosterHtml({
  rows,
  parsed,
  sourceRel,
  generatedAt,
  readyEntries = [],
  memberBatch = new Map(),
}) {
  const cards = rows.length
    ? rows.map(renderBatchCardHtml).join('\n')
    : '<p>No batches in the roster.</p>';
  const dateStr = generatedAt.toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Proposed batch roster</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<h1>Proposed batch roster</h1>
<p class="meta">Generated from <code>${escapeHtml(sourceRel)}</code> on ${escapeHtml(dateStr)}. Read-only view — edit the roster via coord-edit.mjs.</p>
<div class="section"><h2>Batches</h2>${cards}</div>
<div class="section"><h2>Drift flags</h2>${renderDriftFlagsHtml(rows)}</div>
<div class="section"><h2>Fable lane</h2>${renderBulletListHtml(parsed.fableLane)}</div>
<div class="section"><h2>Not batched</h2>${renderBulletListHtml(parsed.notBatched)}</div>
<div class="section"><h2>Ready plans by category</h2>${renderReadyRosterHtml(readyEntries, memberBatch)}</div>
<div class="section"><h2>Dependencies</h2>${renderDependenciesListHtml(parsed.dependencies)}</div>
</body>
</html>
`;
}

// Resolve the active roster source (plan 1467): the batch-FOLDER tree first, else the
// proposed.md fallback (new path, then legacy). Returns the parsed {batches, fableLane,
// notBatched, dependencies} model plus provenance (source / sourceRel / legacy), or
// source 'none' when nothing exists. Source-agnostic so main() + renderers don't branch.
export function resolveRoster(root) {
  if (hasBatchFolders(root)) {
    return {
      parsed: loadFolderRoster(root),
      sourceRel: BATCHES_DIR_REL,
      legacy: false,
      source: 'folders',
    };
  }
  const resolved = resolveProposedPath(root);
  if (!resolved.path) return { parsed: null, sourceRel: null, legacy: false, source: 'none' };
  return {
    parsed: parseProposedMd(readFileSync(resolved.path, 'utf8')),
    sourceRel: resolved.legacy ? LEGACY_PROPOSED_REL : PROPOSED_REL,
    legacy: resolved.legacy,
    source: 'proposed',
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────
function main() {
  let root;
  try {
    root = canonicalRepoRoot();
  } catch (e) {
    // Exit codes: 0 always (file header contract) — this is a read-only view
    // helper, so a repo-root resolution failure is reported, not fatal.
    console.error('batches-view: could not resolve repo root:', e.message);
    return 0;
  }
  const roster = resolveRoster(root);
  const readyEntries = scanReadyPlans(root);

  if (roster.source === 'none') {
    // Still show the live ready roster — it comes from the plans tree, not the
    // roster surface, so a missing roster must not hide it.
    console.log(
      `batches-view: no ${BATCHES_DIR_REL}/<slug>/batch.md folders and no ${PROPOSED_REL} found — nothing proposed.`,
    );
    console.log('\n' + renderReadyRoster(readyEntries, new Map()));
    return 0;
  }
  if (roster.source === 'proposed') {
    if (roster.legacy) console.error(legacyDeprecationMessage());
    else
      console.error(
        `batches-view: reading legacy roster ${PROPOSED_REL} — batches are now folders under ${BATCHES_DIR_REL}/<slug>/ (plan 1467)`,
      );
  }

  const parsed = roster.parsed;
  const rows = parsed.batches.map((b) => annotateBatch(root, b, parsed.dependencies));
  const memberBatch = batchMembershipMap(parsed.batches);
  // Transition-window (plan 1467): any manifest still at the legacy path is a
  // grandfathered in-flight batch — note it so the operator knows the old dir isn't empty yet.
  const legacySlugs = roster.source === 'folders' ? legacyManifestSlugs(root) : [];

  const args = process.argv.slice(2);
  const htmlIdx = args.indexOf('--html');
  if (htmlIdx !== -1) {
    const outArg = args[htmlIdx + 1];
    const outPath =
      outArg && !outArg.startsWith('--')
        ? resolvePath(outArg)
        : join(root, '.scratch', 'batches-view.html');
    const html = renderRosterHtml({
      rows,
      parsed,
      sourceRel: roster.sourceRel,
      generatedAt: new Date(),
      readyEntries,
      memberBatch,
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, 'utf8');
    console.log(outPath);
    return 0;
  }

  if (!rows.length) {
    console.log('batches-view: no proposed batches.');
  } else {
    const flagged = rows.filter((r) => r.flagged).length;
    // plan 2556: non-sonnet-lane rows are COUNTED SEPARATELY, never inside "flagged ⚠". They
    // are runnable trains that need a different conductor, not broken ones.
    // plan 3341 review (finding A): lane-keyed, like `nonSonnetIds` — each non-sonnet lane
    // actually present gets its own name/icon in the summary, so an all-sol batch reports
    // "(N 🔶 sol-lane)" rather than being folded into a hardcoded "fable-lane" count. A fourth
    // lane needs no new branch here.
    const nonSonnetLaneRowCounts = new Map();
    for (const r of rows) {
      for (const lane of Object.keys(r.nonSonnetIds ?? {})) {
        nonSonnetLaneRowCounts.set(lane, (nonSonnetLaneRowCounts.get(lane) ?? 0) + 1);
      }
    }
    const laneSummary = [...nonSonnetLaneRowCounts]
      .map(([lane, n]) => `${n} ${LANE_ICON[lane] ?? '❓'} ${lane}-lane`)
      .join(', ');
    console.log(
      `Proposed batches: ${rows.length}${flagged ? ` (${flagged} flagged ⚠)` : ''}` +
        `${laneSummary ? ` (${laneSummary})` : ''}.` +
        (parsed.dependencies.length ? '' : ' [no ## Dependencies block]'),
    );
    console.log(renderTable(rows));
  }

  if (parsed.fableLane.length) {
    // plan 2556: "not batch-TRAIN" stays exact (that conductor is Sonnet-only), but these
    // plans are no longer barred from co-execution as such — a fable BATCH has an executor
    // now. The header says which conductor is excluded, not that grouping is impossible.
    console.log("\nFable lane (NOT batch-train — the Sonnet conductor can't ride these):");
    for (const l of parsed.fableLane) console.log(`  - ${l}`);
  }
  if (parsed.notBatched.length) {
    console.log('\nNot batched (ready/ singles):');
    for (const l of parsed.notBatched) console.log(`  - ${l}`);
  }
  if (legacySlugs.length) {
    console.error(
      `batches-view: ${legacySlugs.length} manifest(s) still at the legacy ${LEGACY_BATCH_MANIFEST_DIR_REL}/ path ` +
        `(grandfathered in-flight, deleted at land): ${legacySlugs.join(', ')}`,
    );
  }
  console.log('\n' + renderReadyRoster(readyEntries, memberBatch));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
