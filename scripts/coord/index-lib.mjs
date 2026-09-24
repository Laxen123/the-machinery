// scripts/coord/index-lib.mjs
// Pure, git-free mutation of docs/INDEX.md's Plans section.
// Active plan bullets are lines matching ^- (🟥|🟩) ; the active region ends at
// the first archive header (ACTIVE_END_RX). The legend, numbered design-rule
// items, and prose intro are NOT plan bullets and are never touched.
//
// In the generated (sentinel + `**status/**` subheading) format, addBullet /
// removeBullet / repathBullet stay canonical by re-rendering all records through
// build-index-lib's renderPlansBlock — the SAME generator `build-index --check`
// validates against — so a targeted mutation can never diverge from a full regen
// (plan 475). They fall back to the legacy text splice for pre-sentinel content.
import {
  INDEX_PLANS_START,
  INDEX_PLANS_END,
  renderPlansBlock,
  splicePlansBlock,
  STATUS_ORDER,
  PLAN_FOLDER_ALT,
  PLAN_TAG_SOURCE,
  classifyPlanRel,
} from './build-index-lib.mjs';
// CAP is the per-line ceiling lint-index-brevity (plan 639) enforces on the archive
// region. The writer imports it so a clamp here and the lint there can never drift.
// Import graph is acyclic: index-lib → lint-index-brevity → build-index-lib (which
// imports nothing local), so there is no cycle back to index-lib.
// plan 3971 review r3 (finding a9b8fc): archiveRegionBounds is the ONE fence-aware region
// scanner (delegates to build-index-lib's nextHeadingBoundary) — condenseArchiveRows below
// routes through it too, so the writer and the lint can never disagree on where the archive
// region ends.
import {
  CAP as ARCHIVE_BULLET_CAP,
  findOverlongArchiveBullets,
  archiveRegionBounds,
} from './lint-index-brevity.mjs';
// plan 3971 review r2: the archive-row matcher (condenseArchiveRow, EXEMPT_RX baked in) lives
// in this leaf module (no imports of its own) so it and lint-index-brevity.mjs can both
// import it without creating a cycle. Re-exported for index-lib.test.mjs, which imports it
// from here (its existing import path, unchanged across the move).
import { condenseArchiveRow } from './index-archive-row.mjs';
export { condenseArchiveRow };

export const ACTIVE_END_RX = /^\s*Moved to `docs\/superpowers\/plans\/archive\//;
// plan 2328: the marker token may carry a leading ⚡ (priority-stamped plan —
// build-index-lib parsePlanMeta renders `⚡🟥`/`⚡🟩` as ONE token, no space, so
// every `- <marker> <summary>` split below keeps working unchanged).
const BULLET_RX = /^- (⚡?(?:🟥|🟩)) /;

// Parse one canonical generated bullet `- <marker> <summary> → \`<status>/<basename>\``
// back into the record shape renderPlansBlock consumes. The path token is anchored to
// end-of-line and required to look like `<status>/<file>.md`, so a summary that itself
// contains backticks or a ` → ` arrow can't be mis-captured as the path. Returns null
// when the line isn't a canonical generated bullet (e.g. a legacy markdown-link bullet).
// The marker capture admits the plan-2328 ⚡ prefix so a priority bullet round-trips
// byte-identically through parse → renderBullet.
const GENERATED_BULLET_RX = /^- (⚡?(?:🟥|🟩)) (.+) → `([^`]+\/[^`]+\.md)`$/u;
const SUBHEADING_RX = /^\*\*[a-z-]+\/\*\*$/;

export function parseGeneratedBullet(line) {
  const m = line.match(GENERATED_BULLET_RX);
  if (!m) return null;
  const [, marker, summary, path] = m;
  // plan 2678: split via the shared classifier, so a categorised ref
  // (`parked/denmark/9-X-y.md`) yields a BARE basename + a category — not the
  // `denmark/9-X-y.md` a naive first-slash split produced, which would have made
  // every `records.findIndex(r => r.basename === slug)` below miss and every
  // `planIdOf(basename)` sort key read as Infinity.
  const { statusFolder, category, basename } = classifyPlanRel(path);
  return { marker, summary, status: statusFolder, category, basename };
}

// Extract the active-plan records from the generated (sentinel-fenced) region, in
// document order. Returns null when content is NOT sentinel-format, OR when the region
// holds a line we can't round-trip (e.g. a legacy markdown-link bullet) — both fall
// back to the legacy text mutators so a bullet is never silently dropped.
function readGeneratedRecords(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.includes(INDEX_PLANS_START));
  const end = lines.findIndex((l) => l.includes(INDEX_PLANS_END));
  if (start === -1 || end === -1 || end < start) return null;
  const records = [];
  for (let i = start + 1; i < end; i++) {
    const t = lines[i].trim();
    if (t === '' || SUBHEADING_RX.test(t)) continue;
    const rec = parseGeneratedBullet(lines[i]);
    if (!rec) return null;
    records.push(rec);
  }
  return records;
}

// Belt-and-suspenders (plan 475): throw if the generated region is NOT what build-index
// would emit for its own bullets — i.e. a non-canonical region is about to be committed.
// addBullet/removeBullet/repathBullet make this unreachable on their own output; the
// guard catches a hand-edit or a future divergence at the coord write site, BEFORE it
// reaches origin/master where the next session's build-index --check push gate would
// trip. No-op on pre-sentinel / unparseable content (nothing to canonicalise).
export function assertGeneratedRegionCanonical(content) {
  const records = readGeneratedRecords(content);
  if (records === null) return; // pre-sentinel / unparseable → nothing to canonicalise
  const canonical = splicePlansBlock(content, renderPlansBlock(records));
  if (canonical !== content) {
    throw new Error(
      'index-lib: INDEX generated region is not canonical (build-index would rewrite it) — refusing to commit drift',
    );
  }
}

function activeEndIndex(lines) {
  const i = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  return i === -1 ? lines.length : i;
}

// Index of the active plan bullet whose path token contains `<slug>` (a plan
// basename, e.g. "101-P07-beta.md"). Only lines in the active region and only
// BULLET_RX lines are considered. -1 if not found.
export function findBulletIndexBySlug(lines, slug) {
  const end = activeEndIndex(lines);
  for (let i = 0; i < end; i++) {
    if (!BULLET_RX.test(lines[i])) continue;
    if (lines[i].includes(slug)) return i;
  }
  return -1;
}

// Tag shape derived from build-index-lib's PLAN_TAG_SOURCE (plan 1945) — was a
// hand-typed copy of the same literal until this fold.
const SLUG_TOKEN_RX = new RegExp('`([^`]*' + PLAN_TAG_SOURCE + '[^`]*\\.md)`', 'g');

function slugOf(bullet) {
  // last backticked `...NNN-PX-....md` token in the bullet
  const m = [...bullet.matchAll(SLUG_TOKEN_RX)].pop();
  if (!m) return null;
  return m[1].split('/').pop();
}

// Add (or idempotently replace) a plan bullet. In the generated sentinel format the
// bullet is placed by re-rendering all records through renderPlansBlock, so the result
// is byte-identical to what `build-index` would emit — fixing the plan-475 tail-append
// drift (a `ready/` bullet appended after a `waiting-trip/` group). Pre-sentinel content
// uses the legacy append.
export function addBullet(content, bullet) {
  const rec = parseGeneratedBullet(bullet);
  const records = rec ? readGeneratedRecords(content) : null;
  if (rec && records !== null) {
    // renderPlansBlock silently drops records of an unknown status — fail loud instead
    // of letting a mis-pathed bullet vanish from INDEX while its plan file persists.
    if (!STATUS_ORDER.includes(rec.status)) {
      throw new Error(`index-lib: bullet path status "${rec.status}" is not a known plan folder`);
    }
    const i = records.findIndex((r) => r.basename === rec.basename);
    if (i === -1) records.push(rec);
    else records[i] = rec; // idempotent replace
    return splicePlansBlock(content, renderPlansBlock(records));
  }
  return addBulletLegacy(content, bullet);
}

function addBulletLegacy(content, bullet) {
  const lines = content.split('\n');
  const slug = slugOf(bullet);
  if (slug) {
    const existing = findBulletIndexBySlug(lines, slug);
    if (existing !== -1) {
      lines[existing] = bullet; // idempotent replace
      return lines.join('\n');
    }
  }
  // insert after the last active plan bullet (or just before the archive header
  // / active-region end if there are none yet)
  const end = activeEndIndex(lines);
  let insertAt = end;
  for (let i = end - 1; i >= 0; i--) {
    if (BULLET_RX.test(lines[i])) {
      insertAt = i + 1;
      break;
    }
  }
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

// Remove a plan bullet. In the sentinel format, removing the only bullet of a group
// would orphan its `**status/**` subheading; re-rendering through renderPlansBlock drops
// the now-empty group, staying canonical (plan 475). Pre-sentinel content uses the
// legacy line splice.
export function removeBullet(content, slug) {
  const records = readGeneratedRecords(content);
  if (records !== null) {
    const i = records.findIndex((r) => r.basename === slug);
    if (i === -1) throw new Error(`index-lib: active bullet not found for "${slug}"`);
    records.splice(i, 1);
    return splicePlansBlock(content, renderPlansBlock(records));
  }
  return removeBulletLegacy(content, slug);
}

function removeBulletLegacy(content, slug) {
  const lines = content.split('\n');
  const idx = findBulletIndexBySlug(lines, slug);
  if (idx === -1) throw new Error(`index-lib: active bullet not found for "${slug}"`);
  lines.splice(idx, 1);
  return lines.join('\n');
}

// Status-subfolder segment shared by both bullet path conventions. Used to split
// off whatever directory prefix preceded it so a repath preserves that prefix.
// `parked` (plan 1426) is recognized here like `archive` — a `parked/NNN-…md` ref
// is a legal repath target/source even though parked/ never gets its own INDEX bullet.
// Folder alternation is derived from build-index-lib's PLAN_FOLDER_ALT (plan 1447) —
// never hand-list folder names here again; add a folder to STATUS_ORDER/ALL_PLAN_FOLDERS
// there and every site (this one included) picks it up.
const STATUS_SUBFOLDER_RX = new RegExp(`(?:${PLAN_FOLDER_ALT})/`);

// Rebuild a path token from the caller's subfolder-rooted `newPath` (e.g.
// "in-progress/x.md"), re-attaching whatever prefix preceded the status subfolder
// in the OLD token. Backtick bullets root paths at plans/ ("ready/x.md", prefix "");
// older markdown-link bullets root at docs/ ("superpowers/plans/ready/x.md").
function rebuildPath(oldPath, newPath) {
  const m = oldPath.match(STATUS_SUBFOLDER_RX);
  const prefix = m ? oldPath.slice(0, m.index) : '';
  return prefix + newPath;
}

// Repath a plan bullet (e.g. `ready/` → `in-progress/`). In the sentinel format a
// repath moves the bullet to a different `**status/**` group; re-rendering through
// renderPlansBlock relocates it canonically (plan 475). Pre-sentinel / markdown-link
// content uses the legacy in-place token rewrite.
export function repathBullet(content, slug, newPath) {
  const records = readGeneratedRecords(content);
  if (records !== null) {
    const i = records.findIndex((r) => r.basename === slug);
    if (i === -1) throw new Error(`index-lib: active bullet not found for "${slug}"`);
    // plan 2678: newPath is `<status>/[<category>/]<basename>` (or a bare basename,
    // which keeps the record's current status AND clears no category — a bare rename
    // has never carried folder intent). classifyPlanRel is the same splitter the
    // bullet parser uses, so a categorised repath round-trips.
    const slash = newPath.indexOf('/');
    const parsed = slash === -1 ? null : classifyPlanRel(newPath);
    const status = parsed ? parsed.statusFolder : records[i].status;
    const category = parsed ? parsed.category : (records[i].category ?? null);
    const basename = parsed ? parsed.basename : newPath;
    // newPath must be `<status>/…` with a known status (callers pass the
    // subfolder-rooted form). A docs-rooted path mis-parses its status and would make
    // renderPlansBlock drop the bullet silently — throw instead.
    if (!STATUS_ORDER.includes(status)) {
      throw new Error(
        `index-lib: repath newPath "${newPath}" status "${status}" is not a known plan folder`,
      );
    }
    records[i] = { ...records[i], status, category, basename };
    return splicePlansBlock(content, renderPlansBlock(records));
  }
  return repathBulletLegacy(content, slug, newPath);
}

function repathBulletLegacy(content, slug, newPath) {
  const lines = content.split('\n');
  const idx = findBulletIndexBySlug(lines, slug);
  if (idx === -1) throw new Error(`index-lib: active bullet not found for "${slug}"`);
  // Replace the path token whose basename === slug, in either form the index uses:
  //   backtick form:      `…/<slug>`
  //   markdown-link form: [label](…/<slug>)
  lines[idx] = lines[idx]
    .replace(/`([^`]*\.md)`/g, (full, p) =>
      p.split('/').pop() === slug ? `\`${rebuildPath(p, newPath)}\`` : full,
    )
    .replace(/\]\(([^)]*\.md)\)/g, (full, p) =>
      p.split('/').pop() === slug ? `](${rebuildPath(p, newPath)})` : full,
    );
  return lines.join('\n');
}

// Clamp `note` so the RENDERED archive bullet `- \`<slug>\` — <note>` stays within
// `cap` chars (plan 645). done-worktree builds the note from a plan's full summary
// frontmatter, which is routinely 600–1000+ chars; written verbatim it produced a
// >CAP archive bullet that crashed the close-out push on lint-index-brevity and
// wedged the shared landing queue (641 @910, 640 @755, 635 @1054 — all on
// 2026-06-15). The clamp lives at the insertArchiveNarrativeLine choke point so
// BOTH writers (index.mjs `archive` + done-worktree close-out) inherit it.
//
// The slug-prefix length counts against the budget (a long slug leaves less room
// for the note). A note that already fits is returned BYTE-IDENTICAL — so existing
// callers, idempotency, and tests are untouched; only an over-budget note is
// whitespace-collapsed to one physical line, truncated on a SENTENCE-or-word
// boundary (plan 652 — never mid-word), and ellipsised. Full detail still lives in
// the archived plan file + git history.
export function clampArchiveNote(slug, note, cap = ARCHIVE_BULLET_CAP) {
  const s = String(note ?? '');
  const prefixLen = `- \`${slug}\` — `.length;
  const budget = cap - prefixLen;
  if (s.length <= budget) return s; // fits as-is → leave bytes untouched
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= budget) return oneLine;
  // reserve 1 char for the ellipsis, then back the cut up to a boundary
  const room = Math.max(0, budget - 1);
  return `${truncateToBoundary(oneLine, room)}…`;
}

// Truncate `text` to at most `room` chars, ending on a boundary so the result reads
// as a coherent fragment rather than a half-word (plan 652 — "…the budg…"). Order of
// preference, all WITHIN `room`:
//   1. a sentence boundary (`.`/`!`/`?` + whitespace) that keeps at least half the
//      room — so the archive bullet shows the summary's first whole sentence(s) as
//      the blurb (the metadata "archived … merged `sha`." is itself sentence one, so
//      this naturally lands on the summary's first sentence);
//   2. otherwise the last whole word;
//   3. otherwise (a single token longer than `room`) a hard char-cut — nothing to
//      back up to.
// A trailing terminator/space on the kept fragment is stripped so the appended
// ellipsis reads cleanly. Caller appends the `…`.
function truncateToBoundary(text, room) {
  if (room <= 0) return '';
  if (text.length <= room) return stripFragmentTail(text);
  const head = text.slice(0, room);
  const sentenceEnd = lastSentenceBoundary(head);
  if (sentenceEnd >= room / 2) return stripFragmentTail(head.slice(0, sentenceEnd));
  const wordEnd = head.lastIndexOf(' ');
  if (wordEnd > 0) return stripFragmentTail(head.slice(0, wordEnd));
  return stripFragmentTail(head); // one unbroken token wider than room → hard cut
}

// Index just PAST the last sentence-terminator (`.`/`!`/`?`) followed by whitespace
// within `head`, or -1 if there is none. The "followed by whitespace" guard keeps
// decimals ("7.08") and code tokens ("`sha`.x") from registering as boundaries.
function lastSentenceBoundary(head) {
  let idx = -1;
  for (let i = 0; i < head.length - 1; i++) {
    if (/[.!?]/.test(head[i]) && /\s/.test(head[i + 1])) idx = i + 1;
  }
  return idx;
}

function stripFragmentTail(s) {
  return s.replace(/[\s.!?]+$/, '');
}

// Insert `- \`<slug>\` — <note>` as the first entry directly beneath the archive
// header. The sole owner of the archive-narrative line format — reused by both
// archiveBullet (here) and done-worktree's atomic close-out (plan 399) so the
// format can never drift between the two call sites. The note is clamped to the
// lint-index-brevity CAP here (plan 645) so neither caller can write an over-long
// bullet that wedges the landing queue.
export function insertArchiveNarrativeLine(content, slug, note) {
  const lines = content.split('\n');
  const headerIdx = lines.findIndex((l) => ACTIVE_END_RX.test(l));
  if (headerIdx === -1) throw new Error('index-lib: archive header not found');
  // skip a single blank line directly under the header, then insert
  let insertAt = headerIdx + 1;
  if (lines[insertAt] !== undefined && lines[insertAt].trim() === '') insertAt++;
  lines.splice(insertAt, 0, `- \`${slug}\` — ${clampArchiveNote(slug, note)}`);
  return lines.join('\n');
}

// Remove the active bullet for `slug` and insert `- \`<slug>\` — <note>` as the
// first entry directly beneath the archive header.
// plan 3971 review r1 (A): a caller can still hand this a narrative `note` (the generic
// `index.mjs archive --note "..."` CLI is not itself restricted to the prefix-only shape) —
// condense the freshly inserted row immediately, so it can never land narrative even though
// insertArchiveNarrativeLine itself stays a plain, unopinionated inserter (done-worktree
// calls it directly and already only ever passes a prefix-only note).
export function archiveBullet(content, slug, note) {
  const withNarrative = insertArchiveNarrativeLine(removeBullet(content, slug), slug, note);
  const lines = withNarrative.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`- \`${slug}\` — `));
  if (idx === -1) return withNarrative; // shouldn't happen — insertArchiveNarrativeLine just wrote it
  const { line: next, changed } = condenseArchiveRow(lines[idx]);
  if (!changed) return withNarrative;
  lines[idx] = next;
  return lines.join('\n');
}

// One canonical archive bullet `- \`<slug>\` — <note>` (a single physical line, so
// `.` not `[\s\S]`). The path/slug token is anchored to the backticks, so a note
// that itself contains backticks or an em-dash can't be mis-captured.
const ARCHIVE_BULLET_RX = /^- `([^`]+)` — (.*)$/u;

// Belt-and-suspenders last-resort cap (plan 665, G1.3). `clampArchiveNote` at the
// `insertArchiveNarrativeLine` choke point is the PRIMARY clamp — every archive-bullet
// writer (`index.mjs archive` → `archiveBullet`, and the done-worktree close-out →
// `idempotentArchiveIndex`) already routes through it. This re-clamps any archive-region
// bullet that STILL exceeds CAP, covering the one case the choke point structurally can't:
// a worktree whose copy of these scripts was cut BEFORE the clamp landed (the spine runs
// the WORKTREE's scripts, which is why the 2026-06-15 646 land wrote an 895-char bullet
// despite the clamp being on master 14 min earlier), or a future clampArchiveNote regression.
// Without it, an over-CAP bullet rides into the close-out commit and the pre-push
// `lint-index-brevity` REJECTS the push AFTER merge + board-remove + archive + dequeue —
// poison-pilling the land (orphan worktree + half-archived master). Pure; reuses the SAME
// `findOverlongArchiveBullets` region detector the lint uses and the SAME `clampArchiveNote`
// truncation, so the belt can never disagree with the lint or truncate differently from the
// primary clamp. Returns { content, fixed } — `fixed` lists every bullet it had to truncate
// (a non-empty `fixed` means the primary clamp didn't fire; the caller logs it).
//
// plan 3971 review r2 (findings d9dc50, ae3bbe): findOverlongArchiveBullets(content) with no
// `baseContent` returns EVERY spine-shaped row still carrying a narrative as a 'narrative'
// offender too, now that the lint checks shape as well as length — at land time that's every
// row the one-time condense hasn't reached yet, thousands of them. The belt's own contract is
// the LENGTH cap only (plan 645/652); narrative rows are the lint + `index.mjs
// condense-archive`'s job, never rewritten at land time (rewriting one here would silently
// perform an uncoordinated partial condense on every single land). Filter to 'overlong'
// before clamping.
export function clampOverlongArchiveBullets(content) {
  const offenders = findOverlongArchiveBullets(content).filter((o) => o.reason === 'overlong');
  if (!offenders.length) return { content, fixed: [] };
  const lines = content.split('\n');
  const fixed = [];
  for (const o of offenders) {
    const idx = o.line - 1; // findOverlongArchiveBullets reports 1-based line numbers
    const raw = lines[idx];
    if (raw === undefined) continue;
    // plan 3971 review r3 (finding f81505): CRLF-safe, matching condenseArchiveRow's own
    // convention — strip a trailing \r before matching ARCHIVE_BULLET_RX (whose `.`/`$`
    // don't span `\r`), splice it back onto the clamped line, so a CRLF-sourced INDEX.md
    // doesn't silently lose the \r off any overlong row this belt touches.
    const hasCr = raw.endsWith('\r');
    const line = hasCr ? raw.slice(0, -1) : raw;
    const m = line.match(ARCHIVE_BULLET_RX);
    if (!m) continue; // non-canonical shape (grandfathered/hand-written) — leave for a human
    const [, slug, note] = m;
    const nextBody = `- \`${slug}\` — ${clampArchiveNote(slug, note)}`;
    const next = hasCr ? `${nextBody}\r` : nextBody;
    if (next !== raw) {
      fixed.push({ slug, before: raw.length, after: next.length });
      lines[idx] = next;
    }
  }
  return { content: fixed.length ? lines.join('\n') : content, fixed };
}

// plan 3971: docs/INDEX.md's plan-archive region shrinks every existing spine-shaped row to
// the new prefix-only shape (`file — archived DATE (session N), merged SHA.` plus the batch
// tag when present) — the plan's own summary already lives in the archived plan FILE, so the
// INDEX row is a pointer, not a narrative. This is the repair tool for rows written by the
// pre-3971 spine (or a not-yet-updated worktree copy of done-worktree.mjs); it is NOT run at
// land time — `node scripts/index.mjs condense-archive` is the sanctioned one-time (and
// on-demand repeat) invocation, via coordWrite on master.
//
// Region = archiveRegionBounds (plan 3971 review r3, finding a9b8fc — the SAME fence-aware
// scanner findOverlongArchiveBullets uses, so a `## `-shaped line inside a fenced code block
// doesn't wrongly end this region either). Every non-matching line in the region
// (hand-authored closures with no `merged` clause, blanks, the "Moved to ..." intro) passes
// through byte-identical, and so does an EXEMPT_RX grandfathered row (its narrative IS the
// sole surviving record — checked INSIDE condenseArchiveRow itself since review r2, so this
// loop no longer needs its own EXEMPT check). When `archivedFiles` (a Set of archive/
// basenames) is supplied, a row whose backticked file isn't in it is ALSO passed through
// untouched (plan 3971 review r1, B): that row's file was never landed (or has since been
// removed), so its narrative is the only explanation left; `index.mjs condense-archive`
// supplies this set from a live `git ls-files`, while a bare library call (tests, or no set)
// stays shape-only, matching the pre-review-r1 behavior.
// Idempotent: re-running on already-condensed output rewrites nothing (`rewritten === 0`).
export function condenseArchiveRows(content, { archivedFiles } = {}) {
  const { lines, regionStart, regionEnd } = archiveRegionBounds(content);
  if (regionStart === -1) return { content, rewritten: 0 };
  let rewritten = 0;
  for (let i = regionStart; i < regionEnd; i++) {
    const raw = lines[i];
    if (archivedFiles) {
      const fileMatch = raw.match(/^- `([^`]+)`/);
      // spine-shaped but the archived file isn't tracked — the row IS the sole record.
      if (fileMatch && !archivedFiles.has(fileMatch[1])) continue;
    }
    const { line: next, changed } = condenseArchiveRow(raw);
    if (changed) {
      lines[i] = next;
      rewritten++;
    }
  }
  return { content: rewritten ? lines.join('\n') : content, rewritten };
}
