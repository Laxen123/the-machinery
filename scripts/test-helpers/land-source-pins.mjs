// scripts/test-helpers/land-source-pins.mjs (plan 3961 sibling suite fix)
//
// As scripts/coord/land/** and scripts/project/** carve functions out of the land spine
// (scripts/done-worktree.mjs), tests that pin a property by scanning SOURCE TEXT for a named
// function's declaration, or by slicing a window between two source-text markers, must scan the
// WHOLE carved spine, not just the command file. The old pattern — `readFileSync(done-worktree.mjs)`
// + `src.indexOf('function X')` (or a second `indexOf` for a window's other end) — degrades
// SILENTLY the moment a carve moves X to another file: indexOf returns -1, and a downstream
// .slice(-1) can turn the whole assertion into a one-character string that still reports green.
// Worse, a WINDOW whose two ends resolve in two DIFFERENT files (or end up out of order) silently
// becomes a slice over unrelated code instead of failing at all.
//
// These helpers replace that pattern: allLandSource() reads the WHOLE land spine (the command
// file, plus every non-test module the carve has moved code into so far) so a pin still finds its
// target wherever it now lives; landFnStart()/landLiteralIndex() THROW, naming the target, when it
// is nowhere at all or (an ambiguous pin proving nothing) present more than once; and landWindow()
// THROWS, naming both ends, when a two-marker window would span two different files or come out of
// order.
//
// ONE definition, shared by scripts/done-worktree.test.mjs and scripts/done-worktree-land.test.mjs
// — two SEPARATE suites carrying source-text pins on the same carved spine — so a future carve
// only has to teach the scan here, not in both files.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(SCRIPTS_DIR, 'done-worktree.mjs');

let _landFiles;
function allLandFiles() {
  if (_landFiles !== undefined) return _landFiles;
  const nonTestMjsIn = (dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
      .sort()
      .map((f) => join(dir, f));
  const paths = [
    SHELL,
    ...nonTestMjsIn(join(SCRIPTS_DIR, 'coord', 'land')),
    ...nonTestMjsIn(join(SCRIPTS_DIR, 'project')),
  ];
  const files = [];
  const parts = [];
  let cursor = 0;
  for (const p of paths) {
    const text = readFileSync(p, 'utf8');
    files.push({ path: p, start: cursor, end: cursor + text.length });
    parts.push(text);
    cursor += text.length + 1; // +1 for the '\n' this join() inserts between files
  }
  _landFiles = { text: parts.join('\n'), files };
  return _landFiles;
}

export function allLandSource() {
  return allLandFiles().text;
}

// Which land-spine file an index (from allLandSource()) falls in. THROWS if the index lands in
// one of the '\n' join seams between files (never a real match, since every needle this file
// searches for is at least 2 characters) rather than silently attributing it to the wrong file.
// Exported (not just used internally by landWindow/landFnBodyToFileEnd) because a caller
// sometimes needs to assert WHICH file a moved declaration resolved into, not just that a window
// stays inside one file (scripts/done-worktree.test.mjs's plan-3598 ctx-publication guard does
// exactly this for phaseLaneMerge, which the plan-3961 carve moved to its own file).
export function landFileOf(index) {
  const hit = allLandFiles().files.find((f) => index >= f.start && index < f.end);
  if (!hit) {
    throw new Error(`landFileOf: index ${index} does not fall inside any land-spine file`);
  }
  return hit.path;
}

// Verify a two-marker window is meaningful before using it: both ends must resolve inside the
// SAME land-spine file, and `endIdx` must come strictly after `startIdx`. Once the searched
// source is a concatenation of many files, a window whose ends silently drifted into two
// different files (one marker moved, the other did not) — or came out of order — would slice
// over unrelated code, or an empty/negative range, while still reporting green. THROWS instead,
// naming both markers and (when they differ) both files.
export function landWindow(startIdx, startLabel, endIdx, endLabel) {
  const startFile = landFileOf(startIdx);
  const endFile = landFileOf(endIdx);
  if (startFile !== endFile) {
    throw new Error(
      `landWindow: "${startLabel}" resolved in ${startFile} but "${endLabel}" resolved in ` +
        `${endFile} — a window spanning two different land-spine files is meaningless`,
    );
  }
  if (!(endIdx > startIdx)) {
    throw new Error(
      `landWindow: "${endLabel}" (index ${endIdx}) does not come strictly after "${startLabel}" ` +
        `(index ${startIdx})`,
    );
  }
}

// A body sliced from `start` to the END OF ITS OWN FILE, instead of to the end of the whole
// concatenated source — so a site that has no second marker of its own (it re-scopes with a
// generic pattern afterwards, or doesn't re-scope at all) can never silently absorb a LATER
// file's content just because `start` now resolves earlier in the concatenation than it used to.
export function landFnBodyToFileEnd(src, start) {
  const file = allLandFiles().files.find((f) => f.path === landFileOf(start));
  return src.slice(start, file.end);
}

/**
 * Locate the ONE declaration of `nameFragment` (a function name, optionally carrying its opening
 * paren and part of its signature, exactly as it appears right after the `function` keyword) in
 * `src`. Matches both `function <nameFragment>` and `export function <nameFragment>` — a plain
 * substring search for "function <nameFragment>" finds the latter too, since "export function X"
 * contains "function X" as a substring — T3.1 already exported some carved functions, and later
 * carves will export more. A candidate only counts as a DECLARATION when its own line contains
 * nothing before it but indentation and an optional `export ` — this is what lets two carved
 * modules quote this exact scan idiom (`source.indexOf('function pushMaster(MAIN)')`) in a header
 * comment explaining why pushMaster stays put, without that quoted text reading as a second
 * declaration. THROWS, naming the fragment, when there is no match (the old plain indexOf
 * returned -1 and let the caller silently slice a near-empty string) or when there is more than
 * one match (an ambiguous pin proves nothing).
 */
export function landFnStart(src, nameFragment) {
  const needle = `function ${nameFragment}`;
  const at = [];
  for (let from = 0; ; ) {
    const i = src.indexOf(needle, from);
    if (i === -1) break;
    from = i + 1;
    const lineStart = src.lastIndexOf('\n', i - 1) + 1;
    if (/^[ \t]*(export )?$/.test(src.slice(lineStart, i))) at.push(i);
  }
  if (at.length === 0) {
    throw new Error(
      `landFnStart: no declaration of "${needle}" (or "export ${needle}") found anywhere across ` +
        'the land spine (scripts/done-worktree.mjs, scripts/coord/land/**, scripts/project/**) — ' +
        'has it moved under a different name, or been removed?',
    );
  }
  if (at.length > 1) {
    throw new Error(
      `landFnStart: "${needle}" matched ${at.length} times across the land spine — an ambiguous ` +
        'pin proves nothing',
    );
  }
  return at[0];
}

/**
 * Locate the ONE occurrence of an arbitrary literal `text` in `src` — the generalisation of
 * landFnStart() for a marker that is not a function declaration (a call site, a comment, any
 * other exact substring). No declaration-position filtering: an arbitrary marker can legitimately
 * sit mid-line. THROWS, naming the literal, on no match or more than one match, for the same
 * reason landFnStart() does: a silent -1 (or a silently-ambiguous first match) is exactly the
 * failure mode this whole file's source-text pins must never produce again.
 */
export function landLiteralIndex(src, text) {
  const at = [];
  for (let from = 0; ; ) {
    const i = src.indexOf(text, from);
    if (i === -1) break;
    at.push(i);
    from = i + 1;
  }
  if (at.length === 0) {
    throw new Error(
      `landLiteralIndex: "${text}" not found anywhere across the land spine (scripts/done-worktree.mjs, ` +
        'scripts/coord/land/**, scripts/project/**)',
    );
  }
  if (at.length > 1) {
    throw new Error(
      `landLiteralIndex: "${text}" matched ${at.length} times across the land spine — an ` +
        'ambiguous marker proves nothing',
    );
  }
  return at[0];
}
