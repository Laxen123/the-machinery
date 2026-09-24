#!/usr/bin/env node
// scripts/coord/wiki-log-lint.mjs — structural lint + one-shot dedupe for the append-only
// wiki journal `wiki/log.md` (plan 2764).
//
// ── THE MECHANISM THIS EXISTS TO STOP (established by git archaeology, plan 2764) ──────────
//
// By 2026-08-03 `wiki/log.md` carried EIGHT concatenated copies of its own history —
// ~5 900 entry lines for ~850 unique entries, the `# Wiki action log` heading repeated 8×.
// Every session that reads the journal paid that ~7× redundancy in context.
//
// The copy count doubled exactly three times, and every doubling is a SINGLE-PARENT
// `chore(wiki):` commit carrying the `Coord-Write: wiki-commit` trailer — i.e. a
// `scripts/wiki-commit.mjs` write, never a merge:
//
//     777 →  1554 lines   694cc15702  2026-07-28   (1 heading → 2)
//    1576 →  3148 lines   b1e0aa4b66  2026-07-29   (2 → 4)
//    3173 →  6347 lines   477c66d277  2026-07-30   (4 → 8)
//
// All three have the SAME byte shape: the new blob is
//     [the committing session's on-disk copy of the page] ++ [origin/master's blob, VERBATIM]
// — in each case the trailing block is byte-identical to the parent commit's blob, and the
// leading block is that same content ±the session's own new entries.
//
// It is NOT the sanctioned `merge=union` driver (.gitattributes:54, plan 1099) and NOT
// wiki-commit's own `git merge-file --union` path (plan 1697): those were the standing
// suspicion, and both are REFUTED. A union merge of two near-identical sides does not
// concatenate them — xdiff aligns the common region and merges cleanly (verified: replaying
// the 2026-07-28 doubling through `git merge-file --union` with an EMPTY base yields 778
// lines, not 1554), and replaying it against all 309 historical blobs of this file as the
// base reproduces the result with NONE of them. The duplication was therefore already in the
// CALLER's working copy when wiki-commit read it — the byte-identical trailing block is the
// signature of master's blob being APPENDED to a copy that already held it (the shape the
// plans-workflow post-refusal rebuild recipe produces when its `>` redirect is run as `>>`,
// on the hottest page in the vault, which is also the page most likely to hit a refusal).
//
// ── WHY THE GUARD LIVES AT WRITE TIME, NOT IN A PRE-PUSH LINT ───────────────────────────────
//
// A pre-push lint CANNOT catch this class. Wiki pages reach master through
// `wiki-commit.mjs` → `withCoordCheckout` → `coordWrite`, and **that push executes no git
// hooks at all** (docs/runbooks/branch-hygiene.md § "The coord-checkout push runs NO git
// hooks": the `.husky/_/` shim is never installed in the disposable checkout, and coordWrite
// additionally sets `HUSKY=0`). All eight copies arrived through exactly that path. So the
// load-bearing guard is `checkJournalOrThrow`, called from wiki-commit's mutate() beside the
// page-budget check — post-merge, on the content that will actually be committed, on every
// coordWrite retry. The pre-push tier keeps a second, ABSOLUTE copy of the lint for any other
// route (a hand `git add`, a future tool), but it is the belt, not the braces — and because
// it is absolute where the write-time guard is a delta, it is scoped to a push that changes
// `wiki/log.md` ITSELF, never to any `wiki/**` diff. Otherwise a residual duplication the
// write-time guard deliberately tolerates would hard-refuse someone's unrelated wiki-page
// push, re-inflicting the very flag day the delta form exists to avoid.
//
// ── THE GUARD IS A DELTA, NOT AN ABSOLUTE ──────────────────────────────────────────────────
//
// `checkJournalOrThrow` refuses a write that INTRODUCES duplication relative to master's
// current blob, exactly as plan 1697's `checkContainment` refuses a write that introduces
// content LOSS. It is deliberately not an absolute "the file must be clean" assertion at
// that seat: an absolute guard would have been a flag day — it fails on master until the
// dedupe lands, which would refuse every sibling session's journal append in the window
// between the two. The delta form is correct in both regimes (before the dedupe a normal
// append keeps the duplicate count flat and passes, while a doubling still jumps it and is
// refused) and needs no ordering between the guard and the cleanup.
//
// ── THE ENTRY MODEL (why an entry is not simply a line) ────────────────────────────────────
//
// The journal is *mostly* one line per entry, but not entirely: three entries in the live
// corpus wrap across physical lines (a code span containing a newline), and there is one
// stray `---` rule and one orphaned continuation fragment. Nor is it uniformly
// blank-separated — whole regions carry consecutive `- ` lines with no blank between them,
// so "a block is a run of non-blank lines" is NOT a usable entry boundary (it fuses hundreds
// of distinct entries into one block, and the dedupe then finds almost nothing to collapse).
//
// So an ENTRY opens at a line matching `- ` and runs until the next such line, the heading,
// the intro, or EOF; any non-entry line in between is a CONTINUATION and is carried with its
// entry (blank separators preserved verbatim inside the entry, so a wrapped entry round-trips
// byte-for-byte). That way a wrapped entry's tail travels with its entry through the sort
// instead of being orphaned or dropped. The dedupe asserts set equality on the non-blank LINE
// multiset, so no shape of entry can lose content silently.
//
// Pure functions are exported for scripts/coord/wiki-log-lint.test.mjs; main() runs only when
// invoked directly.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one page this module governs. */
export const JOURNAL_REL = 'wiki/log.md';
export const JOURNAL_HEADING = '# Wiki action log';
export const JOURNAL_INTRO =
  'Append-only. Newest first. One line per event. Used by `wiki-fold` for rollups.';

/** An entry block opens with a markdown list bullet. */
const ENTRY_OPEN_RX = /^- /;
/** Leading ISO date on an entry's first line, used as the newest-first sort key. */
const ENTRY_DATE_RX = /^-\s+(\d{4}-\d{2}-\d{2})\b/;

/**
 * Parse the journal into { headings, intros, entries, orphans }.
 *
 * Line-driven (see the ENTRY MODEL note in the header): an entry opens at a `- ` line and
 * absorbs every following non-entry line, blank separators included, until the next `- `
 * line / the heading / the intro / EOF. Trailing blanks are trimmed off an entry so two
 * occurrences that differ only in how much whitespace followed them still compare equal.
 * `orphans` holds any non-entry content that appeared BEFORE the first entry and is neither
 * the heading nor the intro — empty on the live corpus, kept so nothing can be dropped.
 */
export function parseJournal(text) {
  const headings = [];
  const intros = [];
  const entries = [];
  const orphans = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    while (cur.lines.length && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    entries.push(cur);
    cur = null;
  };
  // Review finding [2]: a heading/intro line counts as STRUCTURAL only when it opens a block
  // — at file start, or after a blank line. Without that qualifier, an entry that quotes the
  // heading or the intro verbatim on a wrapped continuation line (an entry ABOUT this file,
  // e.g. one recording a rename of the heading) would truncate its own entry, inflate
  // headingCount, and get the commit refused as introduced duplication. Verified safe against
  // the live 8-copy corpus: all 8 structural headings and all 8 intros are blank-line
  // preceded, so the qualifier costs no real detection.
  //
  // Two consequences of that rule, both ACCEPTED and pinned by tests (re-review [1], [2]):
  //  - A bare line byte-identical to the heading/intro that IS blank-preceded still counts as
  //    structural, even inside an entry. That is not a bug to route around: positionally it
  //    is indistinguishable from a real heading, because it is exactly what one looks like.
  //    An entry meaning to quote the heading writes it in a code span, as the rest of this
  //    journal's prose does; the refusal message says so.
  //  - Conversely, a doubling in which BOTH the repeated heading AND the repeated intro are
  //    glued slips both structural arms. It is then carried by the duplicate-entry arm alone:
  //    the boundary entry absorbs the glued heading+intro and stops matching its twin, so an
  //    N-entry doubling scores N-1 duplicates and is refused from N = 3 up. The residual is
  //    therefore a journal of at most TWO entries; this one has held hundreds since
  //    2026-05-18.
  let prevBlank = true;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const opensBlock = prevBlank;
    prevBlank = line === '';
    if (opensBlock && line === JOURNAL_HEADING) {
      close();
      headings.push(line);
      continue;
    }
    if (opensBlock && line === JOURNAL_INTRO) {
      close();
      intros.push(line);
      continue;
    }
    if (ENTRY_OPEN_RX.test(line)) {
      close();
      const m = ENTRY_DATE_RX.exec(line);
      cur = { lines: [line], date: m ? m[1] : null, order: entries.length };
      continue;
    }
    if (cur) {
      // Blank lines are only carried INSIDE an entry (they may sit between an entry and its
      // continuation); a run of them before the next entry is trimmed off by close().
      cur.lines.push(line);
      continue;
    }
    if (line.trim() !== '') orphans.push(line);
  }
  close();
  for (const e of entries) e.text = e.lines.join('\n');
  return { headings, intros, entries, orphans };
}

/** Non-blank line multiset of a text, for the loss-free assertions. */
export function lineMultiset(text) {
  const m = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') continue;
    m.set(line, (m.get(line) ?? 0) + 1);
  }
  return m;
}

/**
 * Absolute structural verdict for one journal text.
 * Returns { headingCount, entryCount, uniqueEntryCount, duplicateEntryCount, violations[] }.
 * `duplicateEntryCount` counts REDUNDANT entry blocks (occurrences beyond the first).
 *
 * `detail` (default false) opts into the top-3 "worst offenders" list on the duplicate-entry
 * violation. It is off by default because the write-time guard calls this on every coordWrite
 * retry and never reads that list — computing it there means a sort over every duplicated
 * entry of a 5 900-line file for output nobody sees (review finding [7]). `parsed` lets a
 * caller that has already run parseJournal skip a second full parse (review finding [6]).
 */
export function scanJournal(text, { detail = false, parsed = null } = {}) {
  const { headings, intros, entries } = parsed ?? parseJournal(text);
  const seen = new Map();
  for (const e of entries) seen.set(e.text, (seen.get(e.text) ?? 0) + 1);
  const duplicateEntryCount = [...seen.values()].reduce((a, c) => a + (c - 1), 0);
  const violations = [];
  if (headings.length > 1) {
    violations.push({
      kind: 'multiple-heading',
      count: headings.length,
      detail: `${headings.length} copies of "${JOURNAL_HEADING}" (expected exactly 1)`,
    });
  }
  if (duplicateEntryCount > 0) {
    const violation = {
      kind: 'duplicate-entry',
      count: duplicateEntryCount,
      detail: `${duplicateEntryCount} redundant entry block(s) over ${seen.size} unique`,
    };
    if (detail) {
      violation.worst = [...seen.entries()]
        .filter(([, c]) => c > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, c]) => `${c}× ${t.split('\n')[0].slice(0, 90)}`);
    }
    violations.push(violation);
  }
  return {
    headingCount: headings.length,
    introCount: intros.length,
    entryCount: entries.length,
    uniqueEntryCount: seen.size,
    duplicateEntryCount,
    violations,
  };
}

/**
 * How many redundant entries a write may add before it reads as STRUCTURAL duplication.
 *
 * Review finding [1]: entries are compared by exact text, so two sessions independently
 * appending a byte-identical line (a short templated note, the same day) would score +1 and
 * be refused — a false positive on a hot page, for something that is at worst a cosmetic
 * copy-paste. One repeated line is not structural duplication. A repeated BLOCK always is:
 * every doubling in the plan-2764 record duplicated a heading (caught unconditionally below)
 * and hundreds of entries, and even a partial re-append of a two-entry tail scores +2. So the
 * entry-duplication arm tolerates exactly one, while any heading OR intro increase still
 * refuses immediately.
 *
 * The intro arm is what makes that tolerance safe at any journal size. A doubling that
 * concatenates with no blank line before the second heading leaves that heading glued to the
 * boundary entry (so it is deliberately not structural, per finding [2]) — but the intro one
 * line further down IS blank-preceded, so it still counts.
 *
 * THE TOLERANCE IS AN ABSOLUTE FLOOR, NOT A PER-WRITE ALLOWANCE (re-review finding [0]).
 * Written as `after > before + TOLERANCE` it would be a RATCHET: each write re-baselines on
 * the last one's tolerated duplicate, so six successive writes could add six duplicates and
 * none of them would ever look anomalous — defeating the whole point of a guard against
 * unbounded reaccumulation. `after > max(before, TOLERANCE)` instead says: you may never push
 * the count above the floor, and if it is already above the floor (a journal not yet cleaned
 * up) you may not raise it at all. One accidental byte-identical entry is admitted; a second
 * one is refused until the first is cleaned up.
 */
export const DUP_ENTRY_TOLERANCE = 1;

/**
 * DELTA verdict — the write-time guard's question: does `next` carry MORE structural
 * duplication than `prev` (master's current blob)? Returns a violation object or null.
 *
 * `prev` may be null (page absent on master), which scores as scanJournal's own zero state
 * (re-review finding [4]) rather than a hand-written stand-in that has to be kept in sync
 * with it by eye — the `Math.max(…, 1)` below is what keeps a brand-new one-heading page from
 * reading as growth.
 */
export function checkNoNewDuplication(prev, next) {
  const before = scanJournal(prev == null ? '' : prev);
  const after = scanJournal(next);
  // A page with no heading/intro at all is not a regression to police here (an empty/new
  // file); only an INCREASE is.
  const headingGrew = after.headingCount > Math.max(before.headingCount, 1);
  const introGrew = after.introCount > Math.max(before.introCount, 1);
  const dupsGrew =
    after.duplicateEntryCount > Math.max(before.duplicateEntryCount, DUP_ENTRY_TOLERANCE);
  if (!headingGrew && !introGrew && !dupsGrew) return null;
  return {
    kind: 'introduced-duplication',
    before: {
      headingCount: before.headingCount,
      introCount: before.introCount,
      duplicateEntryCount: before.duplicateEntryCount,
    },
    after: {
      headingCount: after.headingCount,
      introCount: after.introCount,
      duplicateEntryCount: after.duplicateEntryCount,
    },
    headingGrew,
    introGrew,
    dupsGrew,
  };
}

/** Human-readable rendering of a delta violation, shared by every caller. */
export function formatDuplicationRefusal(rel, v) {
  const parts = [];
  if (v.headingGrew) {
    parts.push(
      `the "${JOURNAL_HEADING}" heading count would rise ${v.before.headingCount} → ${v.after.headingCount}`,
    );
  }
  if (v.introGrew) {
    parts.push(
      `the intro-paragraph count would rise ${v.before.introCount} → ${v.after.introCount}`,
    );
  }
  if (v.dupsGrew) {
    parts.push(
      `redundant entry blocks would rise ${v.before.duplicateEntryCount} → ${v.after.duplicateEntryCount}`,
    );
  }
  return (
    `refusing to commit ${rel} — the write would ADD structural duplication to the ` +
    `append-only journal (${parts.join('; ')}). This is the plan-2764 whole-file-doubling ` +
    `signature: a working copy that already holds master's content having master's content ` +
    `appended to it again. Re-read ${rel} from current origin/master with a REPLACING ` +
    `redirect (\`git show origin/master:${rel} > ${rel}\`, never \`>>\`), re-apply your entry ` +
    `at the top, and retry — your copy is left intact. ` +
    `If your entry genuinely quotes the journal's heading or intro, write it in a code span ` +
    `— a bare blank-separated line identical to the heading IS a heading. ` +
    `Repair an already-duplicated file with \`node scripts/coord/wiki-log-lint.mjs --fix\`.`
  );
}

/**
 * Rebuild the journal: exactly one heading + intro, then every UNIQUE entry block, strict
 * newest-first by leading ISO date (stable by first appearance within a date; undated
 * entries sort last, also stable), blank-line separated.
 *
 * Returns { text, stats, lost } — `lost` is the set-equality proof obligation: any non-blank
 * line present in the input that the output does not carry. The caller must refuse to write
 * when it is non-empty.
 */
export function dedupeJournalText(text) {
  const parsed = parseJournal(text);
  const { headings, intros, entries, orphans } = parsed;
  const seen = new Set();
  const unique = [];
  for (const e of entries) {
    if (seen.has(e.text)) continue;
    seen.add(e.text);
    unique.push(e);
  }
  const sorted = [...unique].sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return a.order - b.order;
  });

  const out = [];
  if (headings.length) out.push(JOURNAL_HEADING);
  if (intros.length) out.push(JOURNAL_INTRO);
  for (const o of orphans) out.push(o);
  for (const e of sorted) out.push(e.text);
  const rebuilt = out.join('\n\n') + '\n';

  // Set-equality proof: every distinct non-blank line of the input must survive, and the
  // output must carry each exactly once (blocks are deduped whole, so a line shared by two
  // genuinely different entries is legitimately allowed to repeat — report it, don't assert
  // it away).
  const inSet = lineMultiset(text);
  const outSet = lineMultiset(rebuilt);
  const lost = [...inSet.keys()].filter((l) => !outSet.has(l));
  // Reuse the parse above rather than re-tokenizing the same input (review finding [6]).
  const before = scanJournal(text, { parsed });
  const after = scanJournal(rebuilt);
  return {
    text: rebuilt,
    lost,
    stats: {
      linesBefore: String(text).split(/\r?\n/).length,
      linesAfter: rebuilt.split(/\r?\n/).length,
      headingsBefore: before.headingCount,
      headingsAfter: after.headingCount,
      entriesBefore: before.entryCount,
      entriesAfter: after.entryCount,
      uniqueEntries: before.uniqueEntryCount,
      duplicatesRemoved: before.duplicateEntryCount,
      distinctLinesBefore: inSet.size,
      distinctLinesAfter: outSet.size,
    },
  };
}

/**
 * Write-time guard for wiki-commit (plan 2764). `prev` is master's current blob and `next`
 * the content about to be written, both Buffer|string|null. Throws when the write would add
 * structural duplication; returns silently otherwise — including for a deletion
 * (`next === null`), which the plan-1622/1697 guards own.
 *
 * Scalar rather than a rel→{prev,next} Map (review finding [5]): exactly one page is ever
 * guarded, so the caller passes that page's two buffers directly instead of retaining every
 * written page's content in a Map for a check that filters all but one of them out.
 */
export function checkJournalOrThrow(prev, next) {
  if (next == null) return;
  const v = checkNoNewDuplication(prev == null ? null : String(prev), String(next));
  if (v) throw new Error(`wiki-commit: ${formatDuplicationRefusal(JOURNAL_REL, v)}`);
}

export function main(argv) {
  const args = argv.slice(2);
  const fix = args.includes('--fix');
  const dry = args.includes('--dry');
  const fileIdx = args.indexOf('--file');
  const rel = JOURNAL_REL;
  const abs =
    fileIdx !== -1 && args[fileIdx + 1] ? args[fileIdx + 1] : join(process.cwd(), JOURNAL_REL);
  if (!existsSync(abs)) {
    console.log(`wiki-log-lint: ${abs} not present — nothing to check`);
    return 0;
  }
  const text = readFileSync(abs, 'utf8');

  if (!fix) {
    const scan = scanJournal(text, { detail: true });
    for (const v of scan.violations) {
      console.error(`wiki-log-lint: FAIL  ${rel}: ${v.detail}`);
      for (const w of v.worst ?? []) console.error(`wiki-log-lint:       ${w}`);
    }
    console.log(
      `wiki-log-lint: ${rel} — ${scan.entryCount} entry blocks, ${scan.uniqueEntryCount} unique, ` +
        `${scan.headingCount} heading(s), ${scan.duplicateEntryCount} redundant`,
    );
    if (scan.violations.length) {
      console.error(
        `wiki-log-lint: repair with \`node scripts/coord/wiki-log-lint.mjs --fix\` (add --dry to preview). ` +
          `Mechanism + why this is guarded at write time: this file's header comment (plan 2764).`,
      );
      return 1;
    }
    return 0;
  }

  const { text: rebuilt, lost, stats } = dedupeJournalText(text);
  console.log(
    `wiki-log-lint --fix: ${abs}\n` +
      `  lines            ${stats.linesBefore} → ${stats.linesAfter}\n` +
      `  headings         ${stats.headingsBefore} → ${stats.headingsAfter}\n` +
      `  entry blocks     ${stats.entriesBefore} → ${stats.entriesAfter} (${stats.uniqueEntries} unique, ` +
      `${stats.duplicatesRemoved} redundant removed)\n` +
      `  distinct lines   ${stats.distinctLinesBefore} → ${stats.distinctLinesAfter}`,
  );
  if (lost.length) {
    console.error(
      `wiki-log-lint: ABORT — the rebuild would LOSE ${lost.length} distinct line(s); nothing written.`,
    );
    for (const l of lost.slice(0, 5)) console.error(`wiki-log-lint:   ${l.slice(0, 120)}`);
    return 2;
  }
  if (stats.distinctLinesBefore !== stats.distinctLinesAfter) {
    console.error(
      `wiki-log-lint: ABORT — distinct-line set size changed ` +
        `(${stats.distinctLinesBefore} → ${stats.distinctLinesAfter}); nothing written.`,
    );
    return 2;
  }
  console.log('wiki-log-lint: set equality HOLDS (no entry lost, each unique line present)');
  if (dry) {
    console.log('wiki-log-lint: --dry — not written');
    return 0;
  }
  writeFileSync(abs, rebuilt);
  console.log(`wiki-log-lint: rewrote ${abs}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
