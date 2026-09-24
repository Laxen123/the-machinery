#!/usr/bin/env node
// scripts/lint-index-brevity.mjs  (plan 639)
// Prohibit detailed narratives in docs/INDEX.md's plan-ARCHIVE region.
//
// The archive region (everything after the INDEX:PLANS-END sentinel, within the
// "## Plans" section) is PERMANENT — its bullets never get rebuilt, so a verbose
// "what happened" essay written at archive time lives forever (entries had grown
// to 4407 chars; plan 639 condensed them to one-liners). This guard rejects any
// archive bullet over CAP chars so the region stays one-line-per-plan.
//
// The umbrella archive discipline: the bullet is prefix-only (plan 3971) —
// (file — archived <date> (session N), merged <sha>.) plus a trailing
// "— batch <slug> (N members)." tag when the land was a batch; the plan's
// summary lives in the archived plan FILE, not the INDEX bullet.
// `node scripts/index.mjs condense-archive` rewrites any spine-shaped row that
// still carries a summary to this shape.
//
// plan 3971 review r2 (the governing principle, superseding review r1's split): a PRE-PUSH
// GATE judges what THIS PUSH ADDS, never the whole file's standing state — that is
// `node scripts/index.mjs condense-archive`'s job, run once against master. So BOTH offender
// reasons ('overlong' and 'narrative', see findOverlongArchiveBullets below) are base-scoped
// THE SAME WAY: a row already present in the base's archive region (line-for-line,
// \r-stripped so CRLF on either side can't defeat the match) is this push's problem to fix
// only if the push is what introduced it — a pre-existing row, of either reason, is
// condense-archive's problem, not this push's. Review r1 originally left 'overlong'
// un-scoped ("a huge bullet is a hazard regardless of which side it's on"), but review r2
// found a REAL row (`157-Other-test-suite-rot-from-parallel-sessions.md`, 2496 chars) that
// had been silently exempted by review r1's own EXEMPT_RX bug (fixed below) — un-scoping
// 'overlong' meant fixing that bug made every push fail on a row this push never touched.
// condense-archive repairs it exactly like any other spine-shaped row (it's narrative too,
// underneath the length problem), so there is nothing this check needs to catch pre-emptively
// that condense-archive won't already fix. This is what lets BOTH checks land — and STAY
// landed — before the one-time condense (T4) that clears the pre-existing backlog, without
// blocking any push on rows it didn't introduce. A brand-new narrative row (of any length)
// can never sneak past this gate either way, because the writer (archiveNotePrefix) and
// archiveBullet both refuse to emit one in the first place — only condense-archive re-derives
// an already-narrative row into something narrower, so this check has nothing new to enforce
// beyond "the push didn't just add one."
//
// plan 3971 review r2 (findings eb1f57, 039000, 73d472, 32132f): the base defaults to the
// MERGE BASE of HEAD and origin/master, not origin/master itself — see main()'s comment for
// why. The base multiset is built from the base's own ARCHIVE REGION only (never its
// generated region, never anything past its own next "## "), and is a Map<line, count>: each
// base OCCURRENCE exempts at most one HEAD occurrence, so a genuinely new DUPLICATE of an
// already-existing offending row still gets flagged.
//
// The belt (`clampOverlongArchiveBullets` in index-lib.mjs) stays UN-scoped, whole-file,
// overlong-only — its contract is fixing at LAND time (a done-worktree close-out), not
// blocking a push; a land is exactly where the whole-file state legitimately gets repaired.
//
// NOT enforced on the generated region (between the INDEX:PLANS sentinels): those
// bullets come from each plan's `summary:` frontmatter and are transient — they
// get condensed when the plan is archived (at which point THIS guard applies).
//
// A handful of legacy entries have no archived plan file — those are the sole record, so
// they are grandfathered (EXEMPT_RX) until migrated to real archive files.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INDEX_PLANS_END, nextHeadingBoundary } from './build-index-lib.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';
// plan 3971 review r2 (finding 20a2a6): both EXEMPT_RX and condenseArchiveRow now live in a
// LEAF module (no imports of its own), so this file no longer imports from index-lib.mjs —
// the review r1 cycle (this file <-> index-lib.mjs, each importing the other) is gone.
// EXEMPT_RX is re-exported below for any existing importer of it from this file.
import { EXEMPT_RX, condenseArchiveRow } from './index-archive-row.mjs';
import { parseFlags } from './parse-flags.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

export { EXEMPT_RX };
export const CAP = 600;

// Returns { lines: content.split('\n'), regionStart, regionEnd } — regionStart is the index
// (into `lines`) of the first archive-region line (right after the INDEX_PLANS_END sentinel),
// regionEnd is the index one past the last archive-region line. regionStart === -1 when the
// sentinel is absent (nothing to scan). Factored out (plan 3971 review r2) so
// findOverlongArchiveBullets scans HEAD's content and the review-r2 base-scoping scans
// `baseContent` through the exact same bounds logic — they can never disagree on where the
// archive region starts or ends.
//
// plan 3971 review r3 (finding a9b8fc): the end bound delegates to build-index-lib's shared,
// fence-aware nextHeadingBoundary(text, fromIndex, 2) — the SAME primitive
// lint-plan-index.mjs's boundArchiveRegion uses to bound this identical region — instead of a
// hand-rolled `startsWith('## ')` line scan, so a `## `-shaped line INSIDE a fenced code
// block (```...```) no longer wrongly ends the region. nextHeadingBoundary works in CHARACTER
// offsets into the full `content` (its fence-tracking must start from the document's true
// beginning, never a pre-sliced tail — see its own contract), so the result is converted back
// to a LINE index via `lineStarts` (every line's own starting character offset) rather than
// by re-splitting a substring, which would be off-by-one whenever `content` lacks (or has) a
// trailing newline. Exported so index-lib.mjs's condenseArchiveRows routes through the SAME
// bounds logic (also finding a9b8fc) — the writer and the lint can never disagree on where
// the region ends.
export function archiveRegionBounds(content) {
  const lines = content.split('\n');
  const endIdx = lines.findIndex((l) => l.includes(INDEX_PLANS_END));
  if (endIdx === -1) return { lines, regionStart: -1, regionEnd: -1 };
  const regionStart = endIdx + 1;
  const lineStarts = [];
  let offset = 0;
  for (const l of lines) {
    lineStarts.push(offset);
    offset += l.length + 1; // +1 for the '\n' this line consumed (or would have, at the end)
  }
  const startCharIdx = lineStarts[regionStart] ?? content.length;
  const endCharIdx = nextHeadingBoundary(content, startCharIdx, 2); // level 2 = "## " or shallower
  let regionEnd = lines.length;
  for (let i = regionStart; i < lines.length; i++) {
    if (lineStarts[i] >= endCharIdx) {
      regionEnd = i;
      break;
    }
  }
  return { lines, regionStart, regionEnd };
}

// Find archive-region bullets that violate the archive-row contract, skipping grandfathered
// sole-record entries. Region = after the INDEX:PLANS-END sentinel up to the next top-level
// "## " header. Two independent reasons an offender can carry:
//   - 'overlong': the row exceeds `cap` chars (plan 639's original check).
//   - 'narrative': the row is spine-shaped but still carries text beyond the prefix (or the
//     batch tag) — i.e. condenseArchiveRow would still change it (plan 3971 review r1).
// plan 3971 review r2: BOTH reasons are base-scoped IDENTICALLY — a pre-push gate judges what
// this push ADDS, not the whole file's standing state (that's condense-archive's job). When
// `baseContent` is supplied, an offending row (either reason) already present in ITS archive
// region (line-for-line, \r-stripped so CRLF on either side can't defeat the match) is
// exempt — up to as many times as it occurs there (a Map<line, count> multiset), because
// it's pre-existing, not something this push introduced. A genuinely new duplicate, beyond
// how many copies the base already had, is still flagged, whichever reason it carries.
export function findOverlongArchiveBullets(indexContent, { cap = CAP, baseContent } = {}) {
  const { lines, regionStart, regionEnd } = archiveRegionBounds(indexContent);
  if (regionStart === -1) return [];
  const stripCr = (s) => (s.endsWith('\r') ? s.slice(0, -1) : s);
  const baseCounts = (() => {
    if (baseContent === undefined) return null;
    const base = archiveRegionBounds(baseContent);
    const counts = new Map();
    if (base.regionStart === -1) return counts;
    for (let i = base.regionStart; i < base.regionEnd; i++) {
      const key = stripCr(base.lines[i]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  })();
  const offenders = [];
  for (let i = regionStart; i < regionEnd; i++) {
    const raw = lines[i];
    if (!raw.startsWith('- ')) continue;
    if (EXEMPT_RX.test(raw)) continue;
    // plan 3971 review r4 (c2474c/8db714/b537cc/b8c0d0): measure the VISIBLE row — a CRLF
    // terminator is not content, and counting it made a 600-char row read as 601 that the
    // belt then could not fix (it strips the CR before clamping, so it saw a fitting note).
    const l = stripCr(raw);
    let reason = null;
    if (l.length > cap) reason = 'overlong';
    else if (condenseArchiveRow(l).changed) reason = 'narrative';
    if (!reason) continue;
    if (baseCounts) {
      const remaining = baseCounts.get(l) ?? 0;
      if (remaining > 0) {
        baseCounts.set(l, remaining - 1); // consume ONE base occurrence
        continue;
      }
    }
    offenders.push({ line: i + 1, len: l.length, preview: l.slice(0, 90), reason });
  }
  return offenders;
}

// plan 3971 review r2 (finding 5dc5e4): the shared value-aware flag parser, not a hand-rolled
// loop — an unknown flag now throws loudly instead of being silently ignored.
// plan 3971 review r3 (findings 545c77, 7ca206): `requireValues: true` makes a value-less
// `--base` (off the end of argv, or an explicitly empty/whitespace value) THROW instead of
// silently falling back to the merge-base default — a caller who typed --base clearly meant
// to name one, and silently ignoring a malformed one would resolve against the WRONG base
// with no signal at all. Exported (out of main()) so this contract is unit-testable without
// spawning a subprocess.
export function resolveBaseFlags(argv) {
  const { flags } = parseFlags(argv, {
    label: 'lint-index-brevity',
    value: ['base'],
    boolean: ['no-base'],
    positionals: false,
    requireValues: true,
  });
  return { explicitBase: flags.base, noBase: flags['no-base'] === true };
}

export function main() {
  const REPO_ROOT = repoRootFrom(dirname(fileURLToPath(import.meta.url)));
  const INDEX_PATH = join(REPO_ROOT, 'docs', 'INDEX.md');
  let content;
  try {
    content = readFileSync(INDEX_PATH, 'utf8');
  } catch {
    return 0; // no INDEX (sibling subproject) → nothing to check
  }

  const { explicitBase, noBase } = resolveBaseFlags(process.argv.slice(2));

  // plan 3971 review r2 (findings eb1f57, 039000, 73d472, 32132f): the base defaults to the
  // MERGE BASE of HEAD and origin/master, NOT origin/master itself. A worktree branch never
  // edits docs/INDEX.md, so its checkout always carries the CUT-TIME copy. Comparing that
  // against origin/master directly would work fine right up until the one-time condense
  // lands there — at that instant origin/master's copy stops narrating thousands of
  // pre-existing rows as narrative, so a stale worktree comparing against origin/master
  // would see all of them as "new" and fail every live worktree's push the moment the
  // condense lands. The merge base is exactly "what this branch inherited" and never moves
  // out from under a live worktree just because master advances. `--base <ref>` still
  // overrides (skips the merge-base call entirely); `--no-base` forces the old whole-file
  // behavior. Any git failure (detached HEAD with no origin/master, a shallow clone, a
  // network-less sandbox, …) degrades to whole-file — fail TOWARD more checking, never less.
  let baseContent;
  const baseLabel = explicitBase ?? 'the merge-base of HEAD and origin/master';
  if (!noBase) {
    try {
      const resolvedBase =
        explicitBase ??
        execFileSync('git', ['merge-base', 'HEAD', 'origin/master'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          windowsHide: true,
          env: gitRepoIsolatedEnv(),
        }).trim();
      baseContent = execFileSync('git', ['show', `${resolvedBase}:docs/INDEX.md`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: gitRepoIsolatedEnv(),
      });
    } catch {
      console.error(
        `lint-index-brevity: could not read docs/INDEX.md from ${baseLabel} — checked whole-file (no base-scoping).`,
      );
    }
  }

  const wholeFileOffenders = findOverlongArchiveBullets(content);
  const offenders =
    baseContent !== undefined
      ? findOverlongArchiveBullets(content, { baseContent })
      : wholeFileOffenders;
  // plan 3971 review r2: offenders is always a subset of wholeFileOffenders (base-scoping
  // only EXEMPTS candidates the whole-file pass already found, never adds new ones), so the
  // skipped set is the whole-file offenders whose line number doesn't survive into offenders.
  // Broken out by reason for the stderr note below — both 'overlong' and 'narrative' can now
  // be pre-existing-and-skipped, not just 'narrative'.
  const offenderLines = new Set(offenders.map((o) => o.line));
  const skippedOffenders = wholeFileOffenders.filter((o) => !offenderLines.has(o.line));
  const skippedOverlong = skippedOffenders.filter((o) => o.reason === 'overlong').length;
  const skippedNarrative = skippedOffenders.filter((o) => o.reason === 'narrative').length;

  if (offenders.length) {
    console.error(
      `lint-index-brevity: ${offenders.length} INDEX.md archive bullet(s) violate the archive ` +
        `format — the plan-archive region must stay one-line-per-plan, prefix-only (no narratives).`,
    );
    for (const o of offenders)
      console.error(`  L${o.line} (${o.reason}, ${o.len} chars): ${o.preview}…`);
    console.error(
      `Fix (overlong): condense to "file — archived <date> (session N), merged <sha>." (prefix-only, no summary). ` +
        `Fix (narrative): run \`node scripts/index.mjs condense-archive\` to rewrite every spine-shaped row automatically.`,
    );
    return 1;
  }
  if (skippedOffenders.length > 0) {
    console.error(
      `lint-index-brevity: ${skippedOffenders.length} pre-existing archive row(s) at ${baseLabel} ` +
        `left unchecked (${skippedOverlong} overlong, ${skippedNarrative} narrative) — repair ` +
        `with node scripts/index.mjs condense-archive`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
