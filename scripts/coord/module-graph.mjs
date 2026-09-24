#!/usr/bin/env node
// scripts/coord/module-graph.mjs — the `coord-core` program's import-graph + command-census asset
// (plan 4061 T1; the ~40-line graph builder plan 3962 § E3 asked to be committed as a step asset).
//
// WHY THIS EXISTS. Steps 4a (this plan) and 4 of the `coord-core` program both rest on three
// measurements that must be reproducible at the EXECUTING sha, not quoted from a previous
// session's scratch:
//
//   1. the resolved local-import graph over `scripts/**/*.mjs` (793 edges / 348 files at
//      3962 § E3 — a number that drifts every time a module lands);
//   2. the transitive closure of a seed set under that graph, which is what Rule 3
//      (`assert-scripts-self-contained.mjs`) forces to move together;
//   3. the COMMAND CENSUS — the distinct `scripts/*.mjs` names that a hook, skill, workflow,
//      runbook, allow-list or routine prompt invokes BY PATH. Plan 3962's Rules quote 116;
//      § E4 re-measured 123 at its hand-back sha. Both numbers are right for their sha, which
//      is exactly why the invariant is `before == after at the executing sha` and never a
//      literal.
//
// WHY IT LIVES IN `scripts/coord/`. It is generic: it knows about ES-module import syntax and
// about the shape of a CLI main-guard, and nothing about vetapp. Every vetapp-specific input —
// which directories to treat as census surfaces, which seeds to close over — arrives as a
// PARAMETER from the caller, per plan 4061's operator decision 2 (cut every core→project edge by
// parameter passing, no function relocations). That keeps it Rule-3 clean: `node:` builtins only.
//
// WHAT COUNTS AS A COMMAND ENTRY POINT. Session 4138 established the two-axis test and plan 4061
// inherits it verbatim: a module is a command entry point when it carries a CLI main-guard AND
// some file outside the plans corpus really invokes it as `node scripts/<name>.mjs`. A mere
// mention in prose is not an invocation — that distinction is what clears `coord-git.mjs`,
// `coord-refs.mjs` and `excl-lock.mjs` to move freely despite matching a naive census grep.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(SCRIPTS_DIR, '..');

// plan 3962 T3: `census --surface .` (REPO_ROOT itself as the surface) used to crash with
// "Maximum call stack size exceeded". `.claude/worktrees/<slug>` holds full NESTED checkouts of
// this same repo — each one a complete copy of every tracked file, so walking into it multiplies
// an already large tree every time this runs from the MAIN checkout (any number of live plan
// worktrees, each contributing its own tens of thousands of files). Matched by name+parent, not
// `e.name === 'worktrees'` alone, which would also skip an unrelated top-level `worktrees/` dir.
function isNestedCheckoutDir(root, name) {
  return name === 'worktrees' && basename(root) === '.claude';
}

/**
 * Walk a directory tree, returning absolute paths of every file matching `pred`.
 *
 * An unreadable ROOT throws; an unreadable SUBdirectory is skipped (gpt-review round 1). The
 * asymmetry is the point: swallowing a bad root turns "you pointed me at nothing" into
 * "0 modules, 0 edges", a measurement that looks like an answer and makes every closure come back
 * empty — while a transient lock on one directory under a live worktree must not fail a whole scan.
 *
 * NO DEPTH CAP (plan 3962 round-2 review, four reviewers on the same objection). A MAX_WALK_DEPTH
 * backstop lived here briefly, added on the theory that a directory CYCLE — a symlink loop chief
 * among them — could otherwise recurse this walker forever. A depth cap was the wrong fix even for
 * that: it would silently TRUNCATE a legitimately deep real tree (this repo's deepest directory
 * today is 21 levels, but that is not a bound anything enforces) and hand a caller like
 * `commandCensus` below a PARTIAL file list with no signal that anything was cut — exactly the
 * silent-partial shape that review round existed to close. The actual crash this asset hit in
 * production, `census --surface .` walking 130k+ files, had nothing to do with recursion depth
 * either: it was `push(...spread)`'s call-stack-sized argument limit, fixed separately where
 * `commandCensus` builds `files` below (`for (const f of walk(...)) files.push(f)`, never
 * `files.push(...walk(...))`).
 *
 * CYCLE-SAFE BY REAL-PATH IDENTITY, NOT BY DEPTH (round-3 review). Round 2's evidence that a
 * SYMLINK or a Windows directory-JUNCTION can never be the way in still holds:
 * `readdirSync(dir, { withFileTypes: true })` classifies each entry from its own dirent (an
 * lstat-shaped read of the entry itself, never a stat of what it points at), so `e.isDirectory()`
 * is false for either alike — verified empirically against this repo's own dev box:
 * `symlinkSync(target, link, 'junction')` followed by `readdirSync(parent,{withFileTypes:true})`
 * reports that entry as `isDirectory()=false, isSymbolicLink()=true`. The recursion guard below —
 * `if (e.isDirectory())` — never even considers descending into either one.
 *
 * A genuine directory MOUNT is a different animal, though: a Windows volume mounted into a folder,
 * or a Linux bind mount, presents as an ORDINARY directory (`isDirectory()=true`) and can still
 * cycle — and cloud drains run Linux, so this is reachable there even though the symlink/junction
 * route is closed. `realpathSync` was tried here first (round 3) and is WRONG for this exact case
 * (round 4 review, five reviewers): a bind mount is a second mount POINT for the same underlying
 * directory, and `realpathSync` resolves a path by walking its own components, which never crosses
 * back to the OTHER mount's spelling — so the same real place yields a DIFFERENT canonical string
 * at every level of a bind-mount loop, and the guard that string feeds never matches, never fires,
 * on precisely the case it exists to catch.
 *
 * The fix is IDENTITY BY (dev, ino) FROM A STAT, not by resolved path text: two directory entries
 * reached by any route — a real path, a bind mount, a bare mount point — share the same
 * (device, inode) pair when and only when they are the same underlying directory, which is exactly
 * the property a cycle guard needs and a path string cannot give it regardless of how it is
 * resolved. Tracked in a set for the DURATION of one `walk()` call; a directory whose identity was
 * already visited on this walk is skipped. That terminates any cycle — a mount loop revisits the
 * same (dev, ino) by construction — without capping anything and without ever reporting a partial
 * list silently: a directory is skipped only when it is PROVABLY the same underlying place as one
 * already walked, never because of how deep it sits.
 *
 * A FAILED identity read (the stat throws — a permissions error, a race with a deletion) is NOT
 * treated as "assume unique and walk it anyway": that fallback is what defeated the old
 * `realpathSync`-with-fallback shape in the first place (round-4 review) — continuing into a
 * directory this walk cannot identify is exactly the silent-cycle-survival behavior the guard
 * exists to prevent, so it is refused the same way an unreadable directory already is just below:
 * the ROOT throws (a walk that cannot even identify where it starts is not a partial answer, it is
 * no answer), a non-root directory is skipped (mirroring the existing `readdirSync` failure
 * handling immediately below, which already treats a sub-directory read failure as skip-not-abort).
 *
 * Injectable as `{ statSync }` (same DI pattern `assert-scripts-self-contained.mjs` already uses
 * for its own stat calls) so a test can prove termination with a fake filesystem shape instead of
 * building a real mount.
 */
export function walk(root, pred, out = [], { statSync: _statSync = statSync } = {}) {
  return walkFrom(root, pred, out, true, new Set(), _statSync);
}

function realIdentity(p, st) {
  // `bigint: true` is load-bearing, not a nicety: an NTFS file id is 64 bits and, on this
  // checkout, the ids of `scripts/coord`, `scripts/project` and `scripts/coord/land` all exceed
  // 2^53, so the plain-Number `ino` is ROUNDED (granularity 8 at that magnitude). Sibling
  // directories created together carry adjacent MFT indices, so two of them round to the SAME
  // number and the second one is skipped as an already-visited cycle — silently, one whole
  // directory of modules missing from the graph (plan 3958: a three-directory fixture lost its
  // `scripts/project` in one run out of four). The BigInt form is exact.
  const s = st(p, { bigint: true });
  // ino 0 means the filesystem reports no usable inode (some Windows volumes, some network
  // shares). Keying on `<dev>:0` would make EVERY directory the same identity, so the visited
  // set would match on the second directory walked and the census would return almost nothing —
  // silently, still exiting success. That is a far worse failure than the mount cycle this guard
  // exists for, and it is the exact silent-narrowing shape plan 3962 is about. Fall back to the
  // path there: cycle detection degrades to the weaker path identity on such a volume rather than
  // collapsing the walk. On doubt, walk MORE, never less.
  return s.ino ? `${s.dev}:${s.ino}` : `path:${p}`;
}

// `isRoot` is recursion state, kept private rather than exposed as a caller-visible option
// (gpt-review round 2) — a caller passing it could turn the root check off, which is the whole
// point of the distinction. `visited` and `st` are threaded through the same way, for the same
// reason: caller-visible knobs would let a consumer defeat the cycle guard by accident.
function walkFrom(root, pred, out, isRoot, visited, st) {
  let real;
  try {
    real = realIdentity(root, st);
  } catch (e) {
    // Cannot identify this directory at all — see the header comment above for why that is refused
    // rather than walked anyway. Same root/non-root asymmetry as the readdirSync failure just below.
    if (isRoot) throw new Error(`module-graph: cannot stat ${root} (${e.code ?? e.message})`);
    return out;
  }
  if (visited.has(real)) return out; // already walked this identity earlier on this pass — a mount
  // cycle revisits the same (dev, ino) by construction, so this is what actually stops it (see the
  // header comment above for why a depth cap is the wrong fix).
  visited.add(real);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (isRoot) throw new Error(`module-graph: cannot read ${root} (${e.code ?? e.message})`);
    return out;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (isNestedCheckoutDir(root, e.name)) continue;
      walkFrom(p, pred, out, false, visited, st);
    } else if (e.isFile() && pred(p)) {
      out.push(p);
    }
  }
  return out;
}

const isMjs = (p) => p.endsWith('.mjs');
const isTest = (p) => p.endsWith('.test.mjs');

/** Every non-test `scripts/**\/*.mjs` module, absolute paths, sorted. */
export function moduleFiles(scriptsDir = SCRIPTS_DIR) {
  return walk(scriptsDir, (p) => isMjs(p) && !isTest(p)).sort();
}

// Static-import, re-export and dynamic-import specifiers. Deliberately syntactic: the graph must
// be buildable without executing a single module (several of these acquire locks or push refs on
// import-time side effects, so an import-based walk is not an option).
// The side-effect import and the `… from '…'` import are SEPARATE patterns rather than one with an
// optional clause. Folding them together needs a lazy `[\s\S]*?` for the clause, and that crosses
// statement boundaries: `import './register.mjs';` followed anywhere later by a `… from '…'` gets
// swallowed into one bogus match and its specifier is LOST — a silently MISSING GRAPH EDGE, which
// shrinks the closure and drops a module out of step 4's move set.
//
// Tightening the clause to a negated class instead (`[^'";]*?`) fixes that but breaks a multi-line
// import whose clause carries a comment containing an apostrophe or a semicolon — measured here as
// 15 edges lost against the real tree, i.e. trading one silent-miss class for another. Split, both
// are exact: pattern 1 fires only when a quote immediately follows `import`, so it cannot be
// swallowed; pattern 2 requires a `from` and may over-span harmlessly, since whatever it captures
// is a real specifier of the same file and specifiers are de-duplicated per module.
/**
 * Blank out comments — and optionally string/template contents — so a regex probe cannot match
 * the thing it is looking for inside prose (gpt-review rounds 1 and 2).
 *
 * WHY THIS IS HAND-ROLLED RATHER THAN IMPORTED. `scripts/coord/write-lint-common.mjs` already exports
 * `stripJsCommentsAndStrings()`, and reusing it was the review's own suggestion — but Rule 3
 * (`assert-scripts-self-contained.mjs`) forbids a non-test module under `scripts/coord/` from
 * importing anything outside `scripts/coord/**`, and that rule is the whole point of the
 * `coord-core` program this asset serves. Importing it would make this module unmovable by the
 * very step it exists to enable. Same state machine, ~30 lines, node builtins only.
 *
 * TWO REGEX GENERATIONS WERE TRIED AND FAILED BEFORE THIS, both recorded because each looked
 * right: a comments-and-strings regex stripper ate the real `export function main()` out of
 * `select-battery-tests.mjs` and `wiki-commit.mjs` (it cannot know regex or template literals),
 * and column-0 anchoring then traded that for missing every INDENTED top-level export. A scanner
 * is the only thing that is exact in both directions.
 *
 * Newlines always pass through, so line numbers never shift.
 */
export function stripJs(src, { blankStrings = true } = {}) {
  const s = String(src);
  let out = '';
  // A STACK, not a scalar: a template literal's `${…}` is code that may itself contain another
  // template (`` `x ${ `y` } z` ``), and a single-slot state desynced on the inner backtick —
  // masking real code from there to end of file (gpt-review round 3).
  const stack = []; // entries: '"' | "'" | '`' | 'line' | 'block' | 'regex' | 'interp'
  const top = () => stack[stack.length - 1] ?? null;
  const keep = (ch) => (blankStrings ? (ch === '\n' ? '\n' : ' ') : ch);
  // Can a `/` here START a regex literal, or is it division? Decided by the previous meaningful
  // emitted character: after a value (identifier, number, `)`, `]`) it is division; after an
  // operator, `(`, `,`, `=`, `return` etc. it is a regex. Getting this backwards is fatal in both
  // directions — a missed regex corrupts the mask at its first unbalanced quote, and a division
  // read as a regex swallows the rest of the file.
  const regexCanStart = () => {
    const m = out.match(/([^\s])\s*$/);
    if (!m) return true;
    const c = m[1];
    if (/[)\]}]/.test(c)) return false;
    if (/[A-Za-z0-9_$]/.test(c))
      return /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/.test(
        out,
      );
    return true;
  };
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    const next = s[i + 1];
    const state = top();
    if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        stack.pop();
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        out += '  ';
        i += 1;
        stack.pop();
      } else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (state === 'regex') {
      // Blanked like a comment: a regex literal is never code we probe for, and its contents are
      // exactly what used to corrupt the scan.
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      if (ch === '/') stack.pop();
      continue;
    }
    if (state === '"' || state === "'" || state === '`') {
      if (ch === '\\') {
        out += keep(ch) + keep(next ?? '');
        i += 1;
        continue;
      }
      // `${` inside a template opens real code again.
      if (state === '`' && ch === '$' && next === '{') {
        out += blankStrings ? '  ' : '${';
        i += 1;
        stack.push('interp');
        continue;
      }
      out += keep(ch);
      if (ch === state) stack.pop();
      continue;
    }
    // state === null or 'interp' — both are CODE.
    if (state === 'interp' && ch === '}') {
      out += blankStrings ? ' ' : '}';
      stack.pop();
      continue;
    }
    if (ch === '/' && next === '/') {
      out += '  ';
      i += 1;
      stack.push('line');
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 1;
      stack.push('block');
      continue;
    }
    if (ch === '/' && regexCanStart()) {
      out += ' ';
      stack.push('regex');
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      stack.push(ch);
      out += keep(ch);
      continue;
    }
    out += ch;
  }
  return out;
}

// The statement anchor is `(?:^|\n|;)\s*`, not `(?:^|\n)\s*`: a second import following a
// semicolon on the SAME line is still a statement, and anchoring only at a line start silently
// dropped its edge. Prettier never emits that shape here, but a measurement tool must not depend
// on the tree happening to be prettier-clean. These run over `stripJs(src, {blankStrings:false})`
// — comments gone, string CONTENTS kept, because the specifier itself is a string.
const SPEC_RX = [
  /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g,
  /(?:^|[\n;])\s*import\s[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g,
  /(?:^|[\n;])\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// ── WHY THE DETECTORS BELOW ARE DELIBERATELY ONE-SIDED ────────────────────────────────────────
//
// `stripJs` is a scanner, not an ECMAScript parser, and four rounds of review established that
// there is no fixed point short of one: every increment of precision (regex literals, then
// character classes inside them, then brace depth inside `${…}`, then postfix operators, then
// ASI-aware regex-vs-division) surfaces the next. Chasing that is the wrong shape for an asset
// whose job is to tell a human WHICH MODULES TO LOOK AT.
//
// So precision is not what makes this correct — DIRECTION is. Each detector below has one
// dangerous direction and one harmless one, and each is made one-sided so that whatever the
// scanner gets wrong lands on the harmless side:
//
//   guardKind      OVER-inclusive: fires if EITHER the raw source or the masked one shows a guard.
//                  A MISSED guard leaves a live command unsplit and breaks its invoked path at
//                  step 4 with nothing red; a false one only adds a row a human reads in T1's table.
//   exportsEntry   UNDER-inclusive: both masks must agree the entry is exported. A false POSITIVE
//                  means "already exported" and silently skips a module that still needs the
//                  transform; a false negative only re-exports something already exported, a no-op.
//   commandCensus  OVER-inclusive by shape (literal + constructed), and whatever it over-counts
//                  surfaces in `unresolved`, which callers already check.
//   specifiersOf   stays PRECISE (two-mask, keyword-validated) rather than one-sided: a graph is
//                  the one consumer where a spurious edge is not free — it would permanently
//                  inflate the closure every later run reports. Its residual risk is a scanner
//                  desync, which regex- and template-lexing has now made rare.

/**
 * Raw specifiers a module names, in source order (duplicates kept out).
 *
 * Two masks, because an import statement straddles the code/string boundary: the KEYWORD must be
 * real code, while the SPECIFIER is by definition a string literal. `stripJs` preserves length
 * exactly (every branch emits one output char per input char), so offsets align between the two
 * masks and a match found in one is validated against the other. Without that check, an
 * `import x from './y.mjs'` written inside a comment or a template registers as an edge.
 */
export function specifiersOf(file, src = readFileSync(file, 'utf8')) {
  return scanSpecifiers(src).specs;
}

/**
 * Specifiers this module names ONLY inside an `importOptional(…)` call (plan 4096 T1's seam,
 * `scripts/coord/optional-import.mjs`): the `new URL('<lit>', import.meta.url)` first argument
 * and/or the `() => import('<lit>')` loader. Such an edge is OPTIONAL — the importer boots when
 * the target is absent — so a caller asking "what must ship with this module?" may skip it
 * (`closure(…, graph, { skipOptional: true })`).
 *
 * Conservative in the one direction that matters: a specifier that ALSO appears as an ordinary
 * import anywhere else in the file is NOT optional (it is required regardless of the seam), and
 * a call written inside a comment or string does not count (same two-mask validation as
 * `specifiersOf`). A loader that is not written inline — `importOptional(url, loadFn)` — leaves its
 * `import()` outside the call, so that edge stays required. Returned in source order.
 */
export function optionalSpecifiersOf(file, src = readFileSync(file, 'utf8')) {
  return scanSpecifiers(src).optional;
}

// A CALL of the seam, not its declaration (`function importOptional(` in optional-import.mjs).
const OPTIONAL_CALL_RX = /(?<!\bfunction\s{1,20})\bimportOptional\s*\(/g;
// The two argument shapes the seam's call site uses (optional-import.mjs § THE CALL SHAPE).
const OPTIONAL_ARG_RX = [
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** [start, end) offsets of every `importOptional(…)` call's argument list, on the code-only mask. */
function optionalCallSpans(codeOnly) {
  const spans = [];
  OPTIONAL_CALL_RX.lastIndex = 0;
  let m;
  while ((m = OPTIONAL_CALL_RX.exec(codeOnly)) !== null) {
    const open = m.index + m[0].length - 1;
    // Strings, comments and regex literals are blanked on this mask, so a paren inside one
    // cannot unbalance the count. An unclosed call (a scanner desync) yields no span: required.
    let depth = 0;
    for (let i = open; i < codeOnly.length; i += 1) {
      const ch = codeOnly[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          spans.push([open, i + 1]);
          break;
        }
      }
    }
  }
  return spans;
}

// One pass over the two masks for both `specifiersOf` (unchanged behaviour: same patterns, same
// order, same de-duplication) and `optionalSpecifiersOf`.
function scanSpecifiers(src) {
  const withStrings = stripJs(src, { blankStrings: false }); // comments gone, strings kept
  const codeOnly = stripJs(src, { blankStrings: true }); // comments AND strings gone
  const spans = /\bimportOptional\b/.test(codeOnly) ? optionalCallSpans(codeOnly) : [];
  const inSpan = (pos) => spans.some(([a, b]) => pos >= a && pos < b);
  const found = new Set();
  const required = new Set();
  for (const rx of SPEC_RX) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(withStrings)) !== null) {
      const span = codeOnly.slice(m.index, m.index + m[0].length);
      // The keyword survived the code-only mask ⇒ this really is a statement, not prose.
      if (/\b(?:import|export)\b/.test(span)) {
        found.add(m[1]);
        // Position of the captured specifier itself (the match may start at a preceding `\n`/`;`).
        if (!inSpan(m.index + m[0].lastIndexOf(m[1]))) required.add(m[1]);
      }
    }
  }
  const optional = new Set();
  for (const [a, b] of spans) {
    const argsText = withStrings.slice(a, b);
    const argsCode = codeOnly.slice(a, b);
    for (const rx of OPTIONAL_ARG_RX) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(argsText)) !== null) {
        if (!/\b(?:new|import)\b/.test(argsCode.slice(m.index, m.index + m[0].length))) continue;
        if (!required.has(m[1])) optional.add(m[1]);
      }
    }
  }
  return { specs: [...found], optional: [...optional] };
}

/**
 * Resolve one specifier to an absolute path inside `scriptsDir`, or null when it is a `node:`
 * builtin, a bare package specifier, or resolves outside the tree (Rule 1's own violation shape —
 * reported by `assert-scripts-self-contained.mjs`, not by this asset).
 */
export function resolveLocal(fromFile, spec, scriptsDir = SCRIPTS_DIR) {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(dirname(fromFile), spec);
  const rel = relative(scriptsDir, abs);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel === '') return null;
  try {
    if (statSync(abs).isFile()) return abs;
  } catch {
    /* a specifier that names nothing on disk is a broken import, not an edge */
  }
  return null;
}

/**
 * The resolved local-import graph. `{ nodes: Map<abs, {imports:Set<abs>}>, edges: number }`.
 * `.test.mjs` files are excluded from the graph entirely — Rule 3 governs shipped modules, and a
 * test importing across the boundary is explicitly allowed by the guard.
 */
//
// Each node also carries `optional: Set<abs>` — the subset of `imports` reached ONLY through an
// `importOptional(…)` call (see `optionalSpecifiersOf`). `imports` and `edges` are unchanged by it:
// every existing consumer (the pass-cache among them) still sees an optional edge as an edge.
// A target counts as optional only when EVERY specifier resolving to it is optional, so two
// spellings of one module — one optional, one plain — leave it required.
export function buildGraph(scriptsDir = SCRIPTS_DIR) {
  const files = moduleFiles(scriptsDir);
  const nodes = new Map(files.map((f) => [f, { imports: new Set(), optional: new Set() }]));
  let edges = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const { specs, optional } = scanSpecifiers(src);
    const optionalSpecs = new Set(optional);
    const requiredTargets = new Set();
    const optionalTargets = new Set();
    for (const spec of specs) {
      const target = resolveLocal(f, spec, scriptsDir);
      if (!target || isTest(target) || !nodes.has(target)) continue;
      if (!nodes.get(f).imports.has(target)) edges += 1;
      nodes.get(f).imports.add(target);
      (optionalSpecs.has(spec) ? optionalTargets : requiredTargets).add(target);
    }
    for (const t of optionalTargets) if (!requiredTargets.has(t)) nodes.get(f).optional.add(t);
  }
  return { nodes, edges };
}

/** Reverse index: abs path -> Set of modules importing it (the fan-in the move tables quote). */
export function fanIn(graph) {
  const back = new Map([...graph.nodes.keys()].map((f) => [f, new Set()]));
  for (const [f, { imports }] of graph.nodes) for (const t of imports) back.get(t)?.add(f);
  return back;
}

/**
 * Transitive import closure of `seeds` (absolute paths), seeds included.
 *
 * `{ skipOptional: true }` (plan 4096) follows only REQUIRED edges — an `importOptional(…)` edge
 * (a node's `optional` set) is not walked, which answers "what must ship for this to boot?". The
 * default follows every edge, byte-identical to the behaviour before the option existed. An
 * option on `closure` rather than a second function: the walk is the same, only the edge filter
 * differs, and a hand-built graph without `optional` sets degrades to the full closure.
 */
export function closure(seeds, graph, { skipOptional = false } = {}) {
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length) {
    const f = stack.pop();
    if (!f || seen.has(f)) continue;
    seen.add(f);
    const node = graph.nodes.get(f);
    const skip = skipOptional ? node?.optional : null;
    for (const t of node?.imports ?? []) if (!seen.has(t) && !skip?.has(t)) stack.push(t);
  }
  return seen;
}

// A CLI main-guard, detected STRUCTURALLY rather than by shape. Four spellings are live here:
//   `import.meta.url === pathToFileURL(process.argv[1]).href`   (the common one)
//   `fileURLToPath(import.meta.url) === process.argv[1]`        (wiki-size-lint, wiki-log-lint)
//   `process.argv[1] && import.meta.url === …`                  (the guarded prefix)
//   `process.argv[1].endsWith('<name>.mjs')`                    (gate-pass-cache — NO import.meta)
// Two successive shape-matching regexes here each missed one of them, which is precisely the
// failure this asset must not have: a false positive only adds a module to the split list for a
// human to judge, while a false NEGATIVE leaves a live command unsplit and breaks its invoked
// path at step 4. Hence both a co-occurrence test and an explicit `endsWith` arm.
//
// The `endsWith` spelling is also a STEP-4 HAZARD in its own right, flagged as `guardKind` below:
// it matches on BASENAME, so once the library half moves to `scripts/coord/<name>.mjs` and a shim
// keeps `scripts/<name>.mjs`, `argv[1]` still ends with `<name>.mjs` and the moved module's guard
// fires TOO — running the CLI twice. `import.meta.url`-based guards go correctly inert instead.
// Plan 4061's transform normalises these to the identity form for exactly this reason.
const GUARD_WINDOW = 240;
const ENDSWITH_RX =
  /process\.argv\[1\]\s*(?:\?\.)?[\s\S]{0,40}?\.endsWith\s*\(\s*['"][^'"]+\.mjs['"]/;

export function guardKind(file, src = readFileSync(file, 'utf8')) {
  // OVER-inclusive on purpose (see the direction note above): a guard is looked for in the masked
  // source AND in the raw source, so no scanner mistake can hide one. The cost of a false positive
  // is a module a human reads in T1's table; the cost of a false negative is a live command left
  // unsplit whose path breaks at step 4 with nothing red to say so.
  for (const text of [stripJs(src, { blankStrings: false }), src]) {
    let i = text.indexOf('import.meta.url');
    while (i !== -1) {
      const from = Math.max(0, i - GUARD_WINDOW);
      if (text.slice(from, i + GUARD_WINDOW).includes('process.argv[1]')) return 'import-meta';
      i = text.indexOf('import.meta.url', i + 1);
    }
  }
  return ENDSWITH_RX.test(src) ? 'endsWith' : null;
}

export function hasCliGuard(file, src = readFileSync(file, 'utf8')) {
  return guardKind(file, src) !== null;
}

/**
 * Does the module already export an entry point this plan's transform would add?
 *
 * Runs over the CODE-ONLY mask, so neither a `// TODO: export function main()` comment nor the
 * same words inside a template literal count, and no positional anchor is needed — which matters
 * because two earlier attempts here each failed in one direction. A crude regex stripper ate the
 * real export out of `select-battery-tests.mjs` and `wiki-commit.mjs`; column-0 anchoring then
 * missed every INDENTED top-level export. Both directions are wrong in a load-bearing way: a false
 * POSITIVE silently skips a module that still needs the transform, and a false NEGATIVE re-exports
 * one that does not.
 */
export function exportsEntry(file, src = readFileSync(file, 'utf8')) {
  const shows = (t) =>
    /\bexport\s+(?:async\s+)?function\s+main\b/.test(t) || /\bexport\s*\{[^}]*\bmain\b/.test(t);
  // Two independent routes, because neither alone survives a real tree:
  //
  //   COLUMN 0 in the RAW source — robust to any scanner mistake. Requiring the MASK to confirm
  //   was tried and measured: `stripJs` desyncs somewhere in the 700-line prose of
  //   push-queue-status.mjs and blanked its real `export function main()`, so the conservative
  //   form reported a module that HAD been transformed as still needing it.
  //
  //   INDENTED, but only when the mask confirms it — an indented top-level export is legal and
  //   must not be missed, but indentation is also what comment and template text looks like, so
  //   that route pays for the lexer's opinion.
  //
  // Residual bound, stated rather than chased: text at COLUMN 0 inside a template literal that
  // reads exactly `export function main(` is a false positive. No such shape exists in this tree
  // (a template's content is indented with its statement), and the alternative — trusting the
  // mask alone — mis-reports real files, which is the strictly worse trade.
  if (/^export\s+(?:async\s+)?function\s+main\b/m.test(src)) return true;
  if (/^export\s*\{[^}]*\bmain\b/m.test(src)) return true;
  return shows(stripJs(src));
}

/**
 * Names invoked as a command somewhere in `surfaces` (absolute file or directory paths).
 * Returns `Map<name, string[]>` — module basename (without `.mjs`) -> the surface files naming it.
 * `excludeDirs` keeps the plans/handoff corpora out: those describe work, they do not wire it.
 */
export function commandCensus(surfaces, { excludeDirs = [], repoRoot = REPO_ROOT } = {}) {
  const excl = excludeDirs.map((d) => resolve(repoRoot, d));
  // Test material is never wiring (gpt-review rounds 1 and 2): a command string in a fixture made
  // a module look invoked on the strength of its own test. Excluded by FILENAME (`*.test.mjs`) and
  // by DIRECTORY (`fixtures/`, `__tests__/`) — a golden file under `fixtures/` is not a `.test.mjs`
  // and the filename rule alone missed it.
  const testDirRx = new RegExp(`(?:^|\\${sep})(?:fixtures|__tests__)(?:\\${sep}|$)`);
  const inExcluded = (p) =>
    isTest(p) || testDirRx.test(p) || excl.some((d) => p === d || p.startsWith(d + sep));
  const files = [];
  for (const s of surfaces) {
    const abs = resolve(repoRoot, s);
    let st;
    try {
      st = statSync(abs);
    } catch (e) {
      // A MISSING surface is skipped on purpose — `.claude/settings.local.json` is genuinely
      // optional — but any OTHER stat failure (a permission error, a path under a file) is a real
      // problem and must not degrade into a silently smaller census (gpt-review round 2).
      if (e.code === 'ENOENT') continue;
      throw new Error(`module-graph: cannot read ${abs} (${e.code ?? e.message})`);
    }
    // plan 3962 T3: NOT `files.push(...walk(...))` — a `census --surface .` surface walks the
    // whole REPO_ROOT (133k+ files measured in this checkout alone, node_modules/.git excluded),
    // and spreading an array that large into push()'s argument list overflows V8's call-stack-sized
    // argument limit — the actual "Maximum call stack size exceeded" this walk was crashing with,
    // not a recursion-depth problem (this repo's deepest real directory measures 21 levels; see
    // MAX_WALK_DEPTH above for that backstop, which is a separate, unrelated hardening).
    if (st.isDirectory()) {
      for (const f of walk(abs, (p) => !inExcluded(p))) files.push(f);
    } else if (!inExcluded(abs)) files.push(abs);
  }
  // TWO invocation shapes, because a command is invoked by PATH in two different ways here.
  //
  // 1. LITERAL — `node|npx|pnpm|bash|sh … scripts/<name>.mjs`, the shape a hook, skill, runbook or
  //    allow-list uses. The `(?<![\w.-])(?<!\/)` guard anchors `scripts/` to a path ROOT: without
  //    it `frontend/scripts/verify-mobile-gate.mjs` and `backend/scripts/*.mjs` match as top-level
  //    commands and land in the census as names resolving to nothing (measured: 4 such here).
  //
  // 2. CONSTRUCTED — a sibling module spawned through a path BUILT at runtime, e.g.
  //    `const S = join(HERE, 'landing-queue.mjs'); execFileSync(process.execPath, [S, …])`, which
  //    is live in scripts/landing-queue-board.mjs. A literal-only regex cannot see it, so the
  //    spawned module reads as "not a command" and is left unsplit — and worse, the `join(HERE, …)`
  //    itself breaks the moment coord-core step 4 moves the SPAWNING module to another directory.
  //    Under-counting is the dangerous direction for this census, so this arm is deliberately
  //    loose: it matches any `'<name>.mjs'` string literal that a path-join names, and the caller's
  //    own `unresolved` check catches a name that turns out not to be a top-level command.
  // `scripts[\\/]` — both separators, because a runbook or an allow-list on Windows spells the
  // path with a backslash and a forward-slash-only pattern silently misses it.
  const LITERAL_RX =
    /(?:node|npx|pnpm|bash|sh)[^\n]{0,200}?(?<![\w.-])(?<![\\/])scripts[\\/]([A-Za-z0-9._-]+)\.mjs\b/g;
  // The constructed arm allows NESTED calls before the literal (`join(dirname(fileURLToPath(…)),
  // 'x.mjs')` is the live shape) by scanning to the statement end rather than the first `)`.
  const CONSTRUCTED_RX = /\b(?:join|resolve)\s*\([^;\n]{0,200}?['"]([A-Za-z0-9._-]+)\.mjs['"]/g;
  // …but only in a file that actually spawns something. Every `join(…, 'x.mjs')` is a PATH; only
  // some are a COMMAND, and counting the rest floods the census with names that resolve to nothing
  // (gpt-review round 2). A file-level gate is the cheap, exact-enough discriminator.
  // Child-process call shapes, including the promisified/aliased spellings
  // (`promisify(execFile)`, `execFileAsync(…)`). Bare `exec` and bare `promisify` are NOT in the
  // list: `RegExp.prototype.exec` is everywhere in this tree and `promisify` wraps plenty of
  // non-spawn functions, so either one would switch the constructed-path scan on for files that
  // spawn nothing (gpt-review round 4).
  const SPAWNS_RX =
    /\b(?:execFileSync|execFileAsync|execFile|spawnSync|spawn|execSync|fork)\s*\(|\bpromisify\s*\(\s*(?:execFile|exec|spawn|fork)\b/;
  const out = new Map();
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch (e) {
      // A file inside a surface that cannot be read is a real gap in the census, not a file with
      // no invocations in it (gpt-review round 2).
      throw new Error(`module-graph: cannot read ${f} (${e.code ?? e.message})`);
    }
    // Comments stripped, string CONTENTS kept: an invoked path IS a string here.
    const code = isMjs(f) ? stripJs(src, { blankStrings: false }) : src;
    const shapes = SPAWNS_RX.test(code) ? [LITERAL_RX, CONSTRUCTED_RX] : [LITERAL_RX];
    for (const rx of shapes) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(code)) !== null) {
        const name = m[1];
        if (!out.has(name)) out.set(name, []);
        const list = out.get(name);
        const relf = relative(repoRoot, f).split(sep).join('/');
        if (!list.includes(relf)) list.push(relf);
      }
    }
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p).split(sep).join('/');

export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const flagIdx = (n) => argv.indexOf(n);
  const flagVals = (n) => {
    const i = flagIdx(n);
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j]);
    return out;
  };

  if (cmd === 'graph') {
    const g = buildGraph();
    process.stdout.write(`${JSON.stringify({ files: g.nodes.size, edges: g.edges }, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'closure') {
    const g = buildGraph();
    const seeds = flagVals('--seed').map((s) => resolve(REPO_ROOT, s));
    // `--required` walks required edges only (an `importOptional(…)` edge is not followed).
    const c = closure(seeds, g, { skipOptional: argv.includes('--required') });
    process.stdout.write(`${JSON.stringify([...c].map(rel).sort(), null, 2)}\n`);
    return 0;
  }

  if (cmd === 'entry-points') {
    // Every module in the tree (or in a closure, with --seed) that carries a CLI guard, annotated
    // with whether a census surface really invokes it and whether it already exports its entry.
    const g = buildGraph();
    const seeds = flagVals('--seed').map((s) => resolve(REPO_ROOT, s));
    const scope = seeds.length ? closure(seeds, g) : new Set(g.nodes.keys());
    const census = commandCensus(flagVals('--surface'), { excludeDirs: flagVals('--exclude') });
    const back = fanIn(g);
    const rows = [];
    for (const f of [...scope].sort()) {
      const src = readFileSync(f, 'utf8');
      const kind = guardKind(f, src);
      if (!kind) continue;
      const name = f.slice(f.lastIndexOf(sep) + 1, -4);
      const invokedBy = census.get(name) ?? [];
      rows.push({
        module: rel(f),
        name,
        guardKind: kind,
        invoked: invokedBy.length > 0,
        invokedBy,
        exportsEntry: exportsEntry(f, src),
        fanIn: back.get(f)?.size ?? 0,
      });
    }
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'census') {
    const census = commandCensus(flagVals('--surface'), { excludeDirs: flagVals('--exclude') });
    const names = [...census.keys()].sort();
    const unresolved = names.filter((n) => {
      try {
        return !statSync(join(SCRIPTS_DIR, `${n}.mjs`)).isFile();
      } catch {
        return true;
      }
    });
    process.stdout.write(
      `${JSON.stringify(
        { distinct: names.length, unresolved, names, bySurface: Object.fromEntries(census) },
        null,
        2,
      )}\n`,
    );
    return unresolved.length ? 1 : 0;
  }

  console.error(
    'module-graph: unknown command (use: graph | closure --seed <path…> [--required] | ' +
      'entry-points [--seed <path…>] --surface <path…> [--exclude <dir…>] | ' +
      'census --surface <path…> [--exclude <dir…>])',
  );
  return 2;
}

// `process.exitCode`, never `process.exit()` (gpt-review round 1). Every subcommand here writes a
// JSON document to stdout and this tool is always read through `$(…)` or a pipe, where a POSIX
// stdout write is asynchronous — `process.exit()` would truncate the very measurement the caller
// asked for. Same defect class this plan fixed in account-registry.mjs and pytest-workers.mjs, so
// shipping it in the plan's own asset would have been quite the irony.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error('module-graph:', e.message);
    process.exitCode = 2;
  }
}
