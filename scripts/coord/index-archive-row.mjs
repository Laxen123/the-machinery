// scripts/coord/index-archive-row.mjs
// plan 3971 review r2 (finding 20a2a6): the ONE leaf module — NO imports of its own — that
// owns the archive-row matcher (CONDENSE_ROW_RX / CONDENSE_BATCH_TAG_RX / EXEMPT_RX) and
// condenseArchiveRow(line), the single CR-aware match+rewrite primitive every consumer
// routes through: the condense-archive writer + archiveBullet's post-insert condense
// (index-lib.mjs), and the archive-row lint's narrative check (lint-index-brevity.mjs).
//
// Extracted here (out of index-lib.mjs, where review r1 first put it) because index-lib.mjs
// and lint-index-brevity.mjs already import from each other in ONE direction (index-lib.mjs
// imports CAP/findOverlongArchiveBullets from lint-index-brevity.mjs — pre-existing and
// acyclic, since neither module reads the other's binding at module-evaluation time). Adding
// a SECOND, opposite-direction import (lint-index-brevity.mjs importing condenseArchiveRow
// from index-lib.mjs, as review r1 did) makes that a genuine bidirectional cycle — it worked
// in practice (verified, both directions only read their import inside function bodies), but
// a leaf module with no imports at all can never be part of any cycle, by construction. Both
// files now import FROM here; lint-index-brevity.mjs no longer imports from index-lib.mjs.
//
// The umbrella archive discipline: a fresh archive row is prefix-only (plan 3971) — `file —
// archived <date> (session N), merged <sha>.` plus a trailing `— batch <slug> (N members).`
// tag when the land was a batch; the plan's summary lives in the archived plan FILE, not the
// INDEX bullet. `node scripts/index.mjs condense-archive` rewrites any spine-shaped row that
// still carries a summary to this shape.
//
// A handful of legacy entries have no archived plan file — those are the sole record, so
// they are grandfathered (EXEMPT_RX) until migrated to real archive files.

const CONDENSE_ROW_RX =
  /^(- `[^`]+` — archived \d{4}-\d{2}-\d{2} \(session [^)]*\), merged `[0-9a-f]+`\.)(.*)$/u;
const CONDENSE_BATCH_TAG_RX = /— batch \S+ \(\d+ members?\)\.$/u;

// plan 3971 review r2 (findings bc887f, 9d158f, 576e98): tightened from the old unanchored
// alternation (`no archive plan file|retained inline|body retained|no plan file`), whose last
// alternative false-matched ordinary prose containing the substring "no plan filed" (a real
// spine row that must condense, NOT a grandfathered one — verified against the real
// docs/INDEX.md: the row for `157-Other-test-suite-rot-from-parallel-sessions.md` says
// "...trip-condition unmet, no plan filed; future session..." and is a normal archived/merged
// spine row). The real grandfathered rows all carry this EXACT literal marker — verified
// against the real file: exactly 4 lines match, and the "no plan filed" row no longer does.
// plan 3971 review r3 (finding 2197fc): further ANCHORED to the row shape — the marker
// directly follows the backticked filename token in all 4 real rows, so an unanchored
// bare-substring match could exempt a genuinely spine-shaped row whose SUMMARY happened to
// mention this text mid-line. Re-verified against the real file: still exactly 4 matches.
// The em dash is written as — (not pasted as a literal character) so a mangled
// Windows console can't silently re-narrow or widen the marker.
export const EXEMPT_RX = /^- `[^`]+` _\(no archive plan file \u2014 body retained inline\)_/u;

// plan 3971 review r2 (finding a17b71): the EXEMPT check lives HERE, inside the one shared
// primitive — not re-implemented in every caller — so condenseArchiveRows, archiveBullet, and
// the lint's narrative check all honor the grandfather rule from exactly one place and can
// never drift on it.
//
// Splits off a trailing CR (the regex's `.`/`$` don't span `\r`) before matching, then
// splices it back onto whatever is emitted — never touches `\r`. Returns `{ line, changed }`:
// `line` is `raw` unchanged when nothing matched, the row is grandfathered, or nothing needed
// dropping.
export function condenseArchiveRow(raw) {
  if (EXEMPT_RX.test(raw)) return { line: raw, changed: false };
  const hasCr = raw.endsWith('\r');
  const line = hasCr ? raw.slice(0, -1) : raw;
  const m = line.match(CONDENSE_ROW_RX);
  if (!m) return { line: raw, changed: false };
  const [, prefix, rest] = m;
  const tagMatch = rest.trim().match(CONDENSE_BATCH_TAG_RX);
  const nextBody = tagMatch ? `${prefix} ${tagMatch[0]}` : prefix;
  const next = hasCr ? `${nextBody}\r` : nextBody;
  return { line: next, changed: next !== raw };
}
