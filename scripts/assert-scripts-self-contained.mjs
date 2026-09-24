#!/usr/bin/env node
// scripts/ self-containment guard (plan 2622).
//
// Blocks a push in which a non-test `scripts/**/*.mjs` module imports OUTSIDE
// `scripts/` — the rule `docs/runbooks/scripts-module-layout.md` § Rule 1 states and,
// until this guard, nothing enforced.
//
// WHY THE RULE EXISTS: `scripts/test-helpers/isolated-plan-repo.mjs` builds a fully
// self-contained temp repo by copying the non-test `scripts/` tool tree into it and
// running the COPIES (so a tool that resolves paths from its own dirname operates on the
// temp repo, not the real one). A relative specifier that escapes `scripts/` —
// `../shared/…`, `../backend/…` — resolves to nothing inside that temp repo, and the
// copied tool dies with ERR_MODULE_NOT_FOUND. Hook modules live at `scripts/hooks/**`
// (plan 3765 moved them out of `.claude/hooks/`), so importing a `scripts/` sibling from
// a hook is fine and well established — `scripts/hooks/chain-wiki-loader.mjs` importing
// `../wiki-chain-registry.mjs` (several hooks do this). The old asymmetric hazard, a hook
// tree living OUTSIDE `scripts/` that only scripts could not reach into, is gone now that
// hooks live inside `scripts/hooks/`: an import between a hook and a top-level script
// never escapes `scripts/` in either direction, so this gate does not distinguish them.
//
// WHY A GATE AND NOT JUST A DOC: detection was ACCIDENTAL. A violation only turns a suite
// red if some copied tool's import chain happens to reach the offending module.
// `scripts/coord/write-lint-common.mjs` carried exactly this bad import for a long time with
// nothing ever failing (no isolated-repo tool imports it) and was found only by the
// tree-wide scan plan 2615 ran after being burned by a REACHABLE case
// (`select-battery-tests.mjs`, which broke `stamp-exec-model.test.mjs` the moment the
// same import was added). The real failure mode is a latent break that lands green and
// detonates much later, pointing at a temp directory and an innocent test file.
//
// WHAT IT FLAGS (the two shapes plan 2622 pinned):
//   (i)  a relative specifier that resolves outside `scripts/`;
//   (ii) a relative specifier that resolves into `scripts/test-helpers/` from a module
//        outside that dir — test-helpers/ is deliberately never copied into the temp
//        repo, so importing it from a tool breaks identically.
// `node:` builtins and bare package specifiers are ignored (they resolve from
// node_modules / the runtime, not from the copied tree).
//
// WHAT IT SCANS: every `scripts/**/*.mjs` EXCEPT `*.test.mjs` and everything under
// `scripts/test-helpers/`. Both exclusions are the same fact: those files are never
// copied into the temp repo, so they are free to import anywhere (the test suites import
// `scripts/hooks/*` deliberately, to test the hooks — no longer a special case, since
// that import no longer escapes `scripts/` either). Nested non-test dirs
// (`scripts/lib/**`) ARE scanned, because plan 2622 also taught the scaffold to copy them
// — so the invariant and the scaffold agree.
//
// WHAT IT READS: the WORKING TREE, not a committed diff — unlike the assert-*-seam
// guards, whose grandfather allowlists make committed-state reads necessary. This guard
// has no allowlist (the tree is at zero violations as of plan 2615) and its whole-tree
// scan is a few hundred cheap file reads, so it always reports ground truth about the
// files on disk. A violation cannot hide behind a stale range, and there is nothing to
// grandfather.
//
// RANGES: the pre-push hook passes the pushed-delta range(s) via argv (run_range_guard).
// They are used ONLY to skip the scan when the push touches nothing under `scripts/` —
// never to bound WHICH files are scanned. Any git failure (unresolvable base, transient
// shared-.git churn) falls through to scanning: this gate has no false-positive risk to
// fail open for, and a scan is cheaper than the diff it replaces.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join, dirname, resolve, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from './coord/coord-git.mjs';
import { isUnder } from './coord/move-to-coord.mjs';
import { stripJsCommentsAndStrings } from './coord/write-lint-common.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

// THE single source of truth for what the isolated-plan-repo scaffold leaves out of its
// temp-repo copy — imported by scripts/test-helpers/isolated-plan-repo.mjs's
// copyScriptsTree so the guard's permitted set and the scaffold's copied set cannot drift
// (review finding: two hand-maintained copies of the same literal, kept in step by comment
// only, is exactly the latent-drift shape this plan exists to close). Root-level dirs
// under scripts/ that are never copied — and therefore never scanned, since a module that
// is never copied is free to import anywhere.
export const UNCOPIED_ROOT_DIRS = ['test-helpers'];

// A file the scaffold copies into the temp repo. Everything EXCEPT the test files
// themselves: a nested module's sibling ASSETS travel with it (scripts/lib/decision-dossier/
// template.html is read at runtime by inline.mjs via readFileSync(dirname(import.meta.url)),
// so an .mjs-only copy would break a copied tool the same way an escaping import does —
// review finding, and the reason this is a file-shape rule rather than an extension list).
export function isCopiedFile(name) {
  return !name.endsWith('.test.mjs');
}

// Every static/dynamic import specifier form in one pass:
//   import x from 'y' / import 'y' / export … from 'y' / import('y') / await import('y')
// The leading (^|[^\w$.]) keeps `foo.import(` and identifiers ending in `from` from
// matching, and the optional `(` covers the dynamic form.
//
// The second alternative — `` `([^`\n]+)` `` — is round-3 review T3: `import(\`./x.mjs\`)` is a
// perfectly ordinary dynamic import (a static `import … from` can never carry a template literal —
// that is a syntax error — but the dynamic form can, and does, in real code), and until now it was
// invisible to this rule entirely: the quote-only alternative simply never matched it. Group 1
// holds a quoted specifier, group 2 a backtick one — callers read `m[1] ?? m[2]`. An interpolated
// template (`` `./${name}.mjs` ``) matches too, capturing the `${…}` text verbatim (this pass keeps
// string CONTENTS — see the two-mask cross-check below), and callers must check for `${` and
// discard that case: the path is not statically knowable, so — per this round's decision — it is
// IGNORED rather than guessed at or reported, the same way a constructed specifier built by string
// concatenation already falls outside this regex's reach today. Ignoring, not flagging it
// "unanalyzable", was chosen because there is nowhere for a new violation kind to live cheaply: it
// would need its own row in both call sites below (Rule 1-3 and Rule 4) and in main()'s reporting
// for a case that resolves to nothing wrong 100% of the time it fires in this tree today (checked:
// zero interpolated dynamic imports exist under scripts/ or in the outside tree) — and the
// directive for this task is explicit that whichever choice is made must never produce a false
// violation, which "ignore" trivially satisfies and "report" would not without that extra plumbing.
const SPECIFIER_RX = /(?:^|[^\w$.])(?:from|import)\s*\(?\s*(?:['"]([^'"\n]+)['"]|`([^`\n]+)`)/g;

// A specifier resolves through the copied file tree only when it is relative or absolute;
// `node:fs` and bare package names ('vitest') resolve from the runtime / node_modules and
// are always fine.
function isPathSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

// True when `m` — a SPECIFIER_RX/REQUIRE_RX match — captured a BACKTICK literal (group 2) whose
// text INTERPOLATES (`` `./${name}.mjs` ``, captured verbatim including the `${…}` text) — the
// path is not statically knowable, so per this round's decision such a match is IGNORED rather
// than guessed at or reported (see the SPECIFIER_RX comment above for the full reasoning). A plain
// backtick specifier with no interpolation (`` `./x.mjs` ``) is NOT interpolated and is treated
// exactly like a quoted one.
//
// Round-4 review (five reviewers): this used to test `spec` (the resolved text from EITHER
// group), so a single/double-QUOTED specifier that merely happens to contain the two characters
// `${` in its filename was exempted too. Only a backtick literal can ever interpolate — a static
// `import … from '…'` can't carry a template literal at all (that's a syntax error), so an
// ordinary quoted path is always static text regardless of what characters it contains — and
// exempting it hid a real escaping/dead import behind a coincidental filename. Testing `m[2]`
// (only ever populated for the backtick alternative) instead of the resolved `spec` carries that
// distinction through rather than re-deriving it from the text.
function isInterpolated(m) {
  return m[2] !== undefined && m[2].includes('${');
}

// True when `abs` — a resolved specifier target — names something OUTSIDE `scriptsDir` (round-3
// review T2; round-4 review T5). Delegates to the segment-aware `isUnder` helper
// scripts/coord/move-to-coord.mjs already exports rather than keeping a second copy of the same
// '..' / '..'+sep / isAbsolute containment logic under a different name — this file sits at the
// flat scripts/ layer, so importing from scripts/coord/ is legal (Rule 3 only constrains a coord
// module reaching back OUT of scripts/coord/, not this direction) and creates no import cycle
// (move-to-coord.mjs imports only node: builtins and its own sibling module-graph.mjs). `isUnder`
// is the proper prefix test — never `rel.startsWith('..')` alone, which also fires on a real
// directory whose name merely BEGINS with two dots (`scripts/..cache/x.mjs`, resolves INSIDE
// scriptsDir, not an escape) — and it covers the Windows different-drive case, where `relative()`
// itself falls back to returning an absolute path, the same "the two roots share nothing" signal
// on any platform.
function escapesScriptsDir(abs, scriptsDir) {
  return !isUnder(abs, scriptsDir);
}

// Every non-test .mjs under scripts/, minus the uncopied root dirs (see header). The
// scanned set is the .mjs subset of what the scaffold copies — both sides derive their
// exclusions from UNCOPIED_ROOT_DIRS / isCopiedFile above, never from a second literal.
export function collectScannedFiles(root = SCRIPTS_DIR) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (dir === root && UNCOPIED_ROOT_DIRS.includes(entry.name)) continue;
        walk(p);
      } else if (entry.name.endsWith('.mjs') && isCopiedFile(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

// Rule 3 (plan 3959, docs/runbooks/scripts-module-layout.md § Rule 3): scripts/coord/ is the
// generic core the eventual public extraction takes as-is, so a non-test module there may import
// ONLY its own siblings (scripts/coord/**) and node: builtins. A bare package specifier is legal
// from a coord module ONLY when it is in this allow-list — START EMPTY (the tree carries none
// today); every future addition needs a one-line reason right here, same discipline as Rule 1's
// "nothing to grandfather" stance. The constant IS the audit trail — a runbook prose sentence
// could drift from what the gate actually admits, this cannot.
export const COORD_BARE_IMPORT_ALLOWLIST = Object.freeze({});

const COORD_DIR_NAME = 'coord';

// PURE core: classify one file's source. Returns [{ specifier, kind }] where kind is
// 'escapes-scripts', 'test-helpers', 'coord-boundary', or 'coord-bare-import' (Rule 3 fires only
// when `filePath` resolves under scripts/coord/). `filePath` is only used to resolve the
// specifier relative to the importing module's own directory (and, for Rule 3, to decide whether
// this file is itself a coord module).
export function findViolationsInSource(source, filePath, scriptsDir = SCRIPTS_DIR) {
  const found = [];
  const seen = new Set();
  // Is `filePath` itself inside scripts/coord/? Rule 3 applies only to those modules — everything
  // outside scripts/coord/ keeps today's Rule 1/2 behavior untouched.
  const isCoordModule =
    relative(scriptsDir, filePath).split(sep)[0].toLowerCase() === COORD_DIR_NAME;
  // Blank COMMENTS before matching, keeping string contents (review finding): this guard
  // has no allowlist, so a doc comment that quotes an illegal import with straight quotes
  // — `// never: import x from '../shared/foo.mjs'` — would otherwise BLOCK every
  // scripts-touching push with a bogus violation on a line holding no real import. The
  // shared tokenizer in write-lint-common.mjs owns the state machine; `blankStrings:false`
  // is the mode that keeps the specifiers themselves readable.
  const code = stripJsCommentsAndStrings(source, { blankStrings: false });
  // …but a specifier-SHAPED fragment inside a STRING is not an import either, and keeping string
  // contents (above) makes every one of them match. Live example that blocked plan 3962's Phase 2:
  // scripts/coord/coord-refs.mjs throws `cannot derive a plan id from "${idOrName}"` — the word
  // `from` followed by a quoted template placeholder, which SPECIFIER_RX reads as a bare import of
  // `${idOrName}` and Rule 3 then rejects as a non-allow-listed bare package. So match POSITIONS on
  // the string-BLANKED source (where that fragment is gone) and read the specifier TEXT from the
  // string-KEPT one (where the real specifiers are still readable). Both passes run over the same
  // tokenizer with length preserved, so the indices line up; this is the same two-view technique
  // scripts/coord/move-to-coord.mjs uses to splice specifiers safely.
  const codeOnly = stripJsCommentsAndStrings(source, { blankStrings: true });
  const realSpecifierIndices = new Set([...codeOnly.matchAll(SPECIFIER_RX)].map((m) => m.index));
  for (const m of code.matchAll(SPECIFIER_RX)) {
    if (!realSpecifierIndices.has(m.index)) continue;
    const spec = m[1] ?? m[2]; // group 1: quoted; group 2: backtick (see SPECIFIER_RX comment)
    if (isInterpolated(m)) continue; // path not statically knowable — ignored, not guessed at
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (!isPathSpecifier(spec)) {
      // A bare specifier ('vitest', 'node:fs') resolves from node_modules/the runtime, not the
      // copied tree, so Rule 1 has nothing to say about it. Rule 3 does, for a coord module only:
      // a REAL node: builtin is always fine; anything else must be on COORD_BARE_IMPORT_ALLOWLIST.
      //
      // Both halves of this predicate are deliberate (plan 3959 review, six finders on one line):
      //   • The node: test is a CONJUNCTION — `node:`-prefixed AND a real builtin. Neither half
      //     alone is the rule. The prefix alone admitted a typo'd builtin (`node:fs/promisesx`),
      //     which passes the boundary gate here and then dies at module load in the extracted
      //     coord checkout — the exact failure Rule 3 exists to catch BEFORE extraction.
      //     `isBuiltin` alone is wrong in the other direction (review round 2): `isBuiltin('fs')`
      //     is true, so it would start admitting the UN-prefixed spelling the rule has never
      //     allowed. Both halves, or the gate leaks one way or the other.
      //   • `Object.hasOwn(...)`, not `spec in ...` — `in` walks the prototype chain, so an EMPTY
      //     allow-list still "contained" every Object.prototype name and admitted a bare
      //     `import … from 'constructor'`. The allow-list is a data table, never a namespace to
      //     inherit from; own-key membership is the only membership that matches its contract.
      const isRealNodeBuiltin = spec.startsWith('node:') && isBuiltin(spec);
      if (
        isCoordModule &&
        !isRealNodeBuiltin &&
        !Object.hasOwn(COORD_BARE_IMPORT_ALLOWLIST, spec)
      ) {
        found.push({ specifier: spec, kind: 'coord-bare-import' });
      }
      continue;
    }
    const abs = resolve(dirname(filePath), spec);
    const rel = relative(scriptsDir, abs);
    if (escapesScriptsDir(abs, scriptsDir)) {
      // Outside scripts/ entirely — the `../shared/…` class (see escapesScriptsDir above for why
      // this is a proper containment test rather than a `rel.startsWith('..')` prefix guess).
      // `rel === ''` — a specifier resolving to the scripts dir itself — is deliberately
      // NOT a violation: it is inside the copied tree, so it cannot break the temp repo.
      // It is what a partially-captured concatenated specifier looks like
      // (`await import('./' + f)` in assert-coord-in-sync.mjs's generated snippet).
      found.push({ specifier: spec, kind: 'escapes-scripts' });
    } else if (rel.split(sep)[0].toLowerCase() === 'test-helpers') {
      // Compared case-INSENSITIVELY (review finding): on Windows `./Test-Helpers/x.mjs`
      // resolves to the same real directory, but the scaffold skips the dir by its
      // lowercase name, so an exact-case test would wave the mis-cased specifier through
      // and the copied tool would then die with ERR_MODULE_NOT_FOUND inside the temp repo —
      // the exact failure this rule exists to prevent, reachable purely by capitalisation.
      found.push({ specifier: spec, kind: 'test-helpers' });
    } else if (isCoordModule && rel.split(sep)[0].toLowerCase() !== COORD_DIR_NAME) {
      // Rule 3: a coord module reaching OUTSIDE scripts/coord/ but still inside scripts/ — e.g.
      // `../done-worktree-lib.mjs` or `../project/deploy.mjs`. Legal under Rule 1 (never escapes
      // scripts/), illegal under Rule 3 (re-creates the exact closure this split exists to cut).
      found.push({ specifier: spec, kind: 'coord-boundary' });
    }
  }
  // Rule 2 (plan 1555) — the CLI entry guard must compare URL to URL.
  // `import.meta.url === `file://${process.argv[1]}`` is a hand-built URL, and on Windows
  // argv[1] is a BACKSLASH path with a drive letter (`C:\…`) while import.meta.url is
  // `file:///C:/…`, so the two NEVER match: main() is not called, the tool prints nothing
  // and exits 0. That reads exactly like a clean pass, which is why it survived — four
  // modules carried it, and two of them are live pre-push GATES (the clinic-id collision
  // blocker and the PIPELINE.md lint) that had therefore never once fired on a Windows
  // session, while `clinic-id-mint reserve` — the fix the collision gate tells you to run
  // — was an unusable no-op. 84 other scripts already use `pathToFileURL(argv[1]).href`.
  // Scanned on `code` (comments stripped) so this file's own prose, and the fixed modules'
  // explanatory comments, cannot self-trigger. The detector itself is below — it matches the
  // comparison SHAPE rather than one spelling, because the first cut caught the template
  // literal and nothing else.
  // The LABEL must not spell the banned pattern out: `stripJsCommentsAndStrings` runs with
  // `blankStrings: false`, so a string literal here holding the shape makes this module
  // its own first violation. (It did, on the first run — the rule catching its own author
  // is the cheapest possible proof that it fires.)
  if (hasHandBuiltEntryUrl(code)) {
    found.push({ specifier: 'hand-built file:// CLI entry guard', kind: 'hand-built-entry-url' });
  }
  return found;
}

// (a) THE SHAPE, not a spelling: `import.meta.url` compared against an expression that
// mentions `process.argv[1]`, in either operand order. The first cut of this rule matched one
// exact template-literal spelling, so `import.meta.url === 'file://' + process.argv[1]` — the
// same bug, one keystroke apart — walked straight through it (review finding, six votes).
// Bounded to 200 chars and stopping at `;` so the two halves must belong to ONE comparison
// rather than being two unrelated mentions somewhere in the same file.
const ENTRY_GUARD_COMPARISON_RX = new RegExp(
  [
    /import\.meta\.url\s*[=!]==?[^;]{0,200}?process\.argv\s*\[\s*1\s*\]/.source,
    /process\.argv\s*\[\s*1\s*\][^;]{0,200}?[=!]==?\s*import\.meta\.url/.source,
  ].join('|'),
  'g',
);

// A comparison is CORRECT as soon as one side is converted: `pathToFileURL(argv[1]).href`
// (URL vs URL) or `fileURLToPath(import.meta.url)` (path vs path). Either name inside the
// matched span clears it.
const URL_CONVERSION_RX = /pathToFileURL|fileURLToPath/;

// (b) The construction, for the case where the URL is built into a variable on one line and
// compared on the next — the `;` bound in (a) cannot see across that. Any `file://` glued to
// `process.argv[1]` within a few characters is the bug regardless of how it is spelled:
// `${…}` and `' + …` both land inside the window. Only counted in a file that also mentions
// `import.meta.url`, so a help string or fixture in a module that never compares the two
// cannot trip it (review finding: this scanner keeps string contents on purpose, so an
// unconditional text match makes any file quoting the shape its own violation).
const HAND_BUILT_URL_RX = /file:\/\/[^;\n]{0,12}?process\.argv\s*\[\s*1\s*\]/;

// Matched on a whitespace-COLLAPSED copy so a prettier-wrapped multi-line guard reads exactly
// like the one-liner form.
export function hasHandBuiltEntryUrl(code) {
  const collapsed = String(code).replace(/\s+/g, ' ');
  for (const m of collapsed.matchAll(ENTRY_GUARD_COMPARISON_RX)) {
    if (!URL_CONVERSION_RX.test(m[0])) return true;
  }
  return collapsed.includes('import.meta.url') && HAND_BUILT_URL_RX.test(collapsed);
}

// Scan the tree; returns [{ file (repo-relative, forward slashes), specifier, kind }].
export function scanTree(scriptsDir = SCRIPTS_DIR, repoRoot = REPO_ROOT) {
  const violations = [];
  for (const file of collectScannedFiles(scriptsDir)) {
    const source = readFileSync(file, 'utf8');
    for (const v of findViolationsInSource(source, file, scriptsDir)) {
      violations.push({ file: relative(repoRoot, file).split(sep).join('/'), ...v });
    }
  }
  return violations;
}

// Does any supplied push range touch `scripts/`? Unknown (no ranges, or git failed) → true,
// i.e. scan anyway. Exported for the unit test.
export function rangesTouchScripts(ranges, repoRoot = REPO_ROOT, { _git = git } = {}) {
  if (!ranges.length) return true;
  for (const range of ranges) {
    let names;
    try {
      names = _git(repoRoot, ['diff', '--name-only', range, '--', 'scripts/']);
    } catch {
      return true; // transient / unresolvable base — scan rather than skip
    }
    if (names.trim()) return true;
  }
  return false;
}

// ── Rule 4 (plan 3962 Phase 2 fallout): a file OUTSIDE scripts/ must import an EXISTING
// scripts/ path ─────────────────────────────────────────────────────────────────────────────
// Rule 1 above is one-way — it only catches a `scripts/**/*.mjs` module reaching OUTSIDE
// scripts/, and is blind to the opposite break. Plan 3962 Phase 2 moved 93 generic modules
// from the flat `scripts/` layer into `scripts/coord/` (test-queue.mjs, kill-tree.mjs among
// them) and left no path-compat shim for either — shims exist only for modules invoked by
// PATH as a command, not for import specifiers. Three consumers OUTSIDE scripts/
// (backend/vitest.config.ts, frontend/scripts/verify-mobile.mjs,
// frontend/scripts/assert-market-copy.mjs) still imported the pre-move flat path and nothing
// caught it: each loaded fine at author time (the move never ran them) and would only have
// died with MODULE_NOT_FOUND the next time something actually invoked them. This rule closes
// the gap the other direction: a relative import from OUTSIDE scripts/ that resolves INTO
// scripts/ must point at a file that exists on disk.
//
// Scoped to genuine code (`.ts`/`.tsx`/`.mjs`/`.js`/`.cjs`); Python and prose comments are out
// of scope for this rule (the three stale Python-comment mentions plan 3962 also left behind
// are prose, not executable, and are fixed by hand once rather than lint-enforced).
const OUTSIDE_SCAN_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '.cjs'];

// Rule 4 also honors CommonJS `require('spec')` — unlike scripts/ itself (ESM-only), the
// outside consumer tree includes plain CommonJS/TS. Kept as its OWN regex rather than folded
// into SPECIFIER_RX above, so Rules 1-3's scan of scripts/ (which never uses `require`) is
// byte-for-byte unchanged. Same backtick alternative as SPECIFIER_RX and for the same reason
// (round-3 review T3): `require(\`./x.mjs\`)` is legal CommonJS. Group 1 quoted, group 2 backtick.
const REQUIRE_RX = /(?:^|[^\w$.])require\s*\(\s*(?:['"]([^'"\n]+)['"]|`([^`\n]+)`)/g;

// Every SPECIFIER_RX or REQUIRE_RX match in `text`, as one combined list — the shared helper
// both passes of findDeadScriptsImports (comment-blanked, then string-blanked) run, so their
// match INDICES line up for the same position cross-check Rule 1 uses (see its own comment).
function outsideSpecifierMatches(text) {
  return [...text.matchAll(SPECIFIER_RX), ...text.matchAll(REQUIRE_RX)];
}

// Thrown when part or all of the outside-to-scripts import check (Rule 4) could not be completed —
// distinct from "ran the check and it's clean", so a caller can tell "I could not check" from "I
// checked and found nothing" (round-2 review T1: the two must never collapse into the same
// message). Two independent causes throw it: `collectOutsideTrackedFiles` below, when the `git
// ls-files` call itself fails, and `findDeadScriptsImports`, when statting an IMPORT TARGET fails
// for any reason other than ENOENT (round-3 review T4 — a permissions error or transient IO
// failure while checking whether a target exists is not the same fact as the target being absent,
// and must not be reported as a DEAD IMPORT violation). Both causes are handled identically by
// `scanOutsideTree`: the whole outside-scan degrades to `{ violations: [], skipped: true, reason }`
// rather than mixing a partial violation list with an incomplete scan.
export class OutsideTreeUnavailableError extends Error {}

// PURE apart from the `statSync` existence-AND-file-type check on each import TARGET (injectable
// as `_statSync`, same DI pattern the git-facing functions in this file already use, so a non-ENOENT
// stat failure can be pinned in a test without depending on an ambient, platform-specific way to
// provoke one) — everything else is string work, mirroring findViolationsInSource's comment/string
// handling exactly: a specifier-shaped fragment inside a comment, or inside a string/template
// literal (an error-message shape like `scripts/coord/coord-refs.mjs`'s own `cannot derive a plan
// id from "${idOrName}"`), must never fire. Returns [{ specifier, line, kind: 'dead-scripts-import',
// suggestedFix }] — `line` is 1-based against the ORIGINAL source, and `suggestedFix` is the
// scripts/coord/ path when a same-basename file lives there (the common case: a Phase-2 move), else
// null. Throws `OutsideTreeUnavailableError` when an import target cannot be statted for a reason
// other than ENOENT — see that class's own comment.
export function findDeadScriptsImports(
  source,
  filePath,
  { scriptsDir = SCRIPTS_DIR, _statSync = statSync } = {},
) {
  const found = [];
  const seen = new Set();
  const code = stripJsCommentsAndStrings(source, { blankStrings: false });
  const codeOnly = stripJsCommentsAndStrings(source, { blankStrings: true });
  const realSpecifierIndices = new Set(outsideSpecifierMatches(codeOnly).map((m) => m.index));
  for (const m of outsideSpecifierMatches(code)) {
    if (!realSpecifierIndices.has(m.index)) continue;
    const spec = m[1] ?? m[2]; // group 1: quoted; group 2: backtick (see SPECIFIER_RX comment)
    if (isInterpolated(m)) continue; // path not statically knowable — ignored, not guessed at
    if (!isPathSpecifier(spec) || seen.has(spec)) continue;
    seen.add(spec);
    const abs = resolve(dirname(filePath), spec);
    if (escapesScriptsDir(abs, scriptsDir)) continue; // doesn't resolve into scripts/ — not this rule's business
    // `existsSync(abs)` alone is satisfied by a DIRECTORY (round-2 review T2 finding): `import
    // './coord'` where `scripts/coord/` is a directory used to pass this gate and still fail at
    // runtime, because Node's module loader never resolves a bare directory specifier — the exact
    // failure this rule exists to catch, just one level removed from the moved-file case.
    //
    // DECIDED: no extensionless carve-out. An extensionless specifier gets the identical isFile()
    // check below, not a pass. `scripts/index.mjs` exists (the docs/INDEX.md mutation tool), but it
    // sits at the scripts/ ROOT, not inside any SUBdirectory — so it can never satisfy a directory
    // specifier's index-resolution, which needs an `index.*` INSIDE the directory being imported
    // (e.g. `scripts/coord/index.js` for `./coord`). No subdirectory under `scripts/**` carries one,
    // and no `package.json` "main" exists anywhere in the tree either, so there is no real
    // resolution algorithm — Node ESM (no extension/index inference at all), Node CJS `require`
    // (tries `index.js`/`.json`/`.node`, never `.mjs`), or a bundler's default extension list —
    // under which an extensionless specifier could land on a scripts/ file that this exact-path
    // check would miss. Concretely: `./coord` (the directory case above) resolves under NONE of
    // them, and a bare `../../scripts/kill-tree` (missing `.mjs`) was already flagged dead before
    // this change too, since `existsSync` was already false for that non-extended path — this fix
    // only changes the DIRECTORY sub-case, which is exactly T2's target. (Confirmed no extensionless
    // scripts/-pointing specifier exists in the outside tree today, so this is a forward-safety
    // decision, not a live behavior change beyond T2.)
    let isFile;
    try {
      isFile = _statSync(abs).isFile();
    } catch (e) {
      if (e.code === 'ENOENT') {
        isFile = false; // genuinely nothing there — this IS the dead-import case
      } else {
        // Round-3 review T4: a permissions error or any other transient IO failure is NOT "the
        // target is absent" — folding it into that case reports a DEAD IMPORT VIOLATION for a
        // target that may exist just fine, blocking a push over a scan that could not complete
        // rather than a real defect. Surface it as a SCAN failure instead (see
        // OutsideTreeUnavailableError's own comment for the full contract).
        throw new OutsideTreeUnavailableError(
          `cannot stat ${abs} (${e.code ?? e.message}) while checking an import in ${filePath}`,
        );
      }
    }
    if (isFile) continue; // resolves, and the target is really a FILE
    const line = code.slice(0, m.index).split('\n').length;
    const coordCandidate = join(scriptsDir, 'coord', basename(abs));
    found.push({
      specifier: spec,
      line,
      kind: 'dead-scripts-import',
      suggestedFix: existsSync(coordCandidate) ? `scripts/coord/${basename(abs)}` : null,
    });
  }
  return found;
}

// List every git-TRACKED file outside scripts/ with a scannable extension, as absolute paths.
// Tracked (not "on disk") so a build artifact or a gitignored scratch file can never feed this
// rule. `_git` is a test seam, same pattern as rangesTouchScripts above. Rule 4 has no fallback TO
// scan with — unlike rangesTouchScripts above, whose git call only decides whether to skip an
// optimization and can fail open by scanning MORE, this git call produces the very file list Rule 4
// scans, so there is nothing left to fall through to; a failure here throws
// OutsideTreeUnavailableError (see that class's own comment).
export function collectOutsideTrackedFiles(repoRoot = REPO_ROOT, { _git = git } = {}) {
  let raw;
  try {
    raw = _git(repoRoot, ['ls-files', '--', ...OUTSIDE_SCAN_EXTENSIONS.map((e) => `*${e}`)]);
  } catch (e) {
    // Round-2 review T1: this call used to be unguarded, so a git failure (a transient shared-.git
    // hiccup, same class rangesTouchScripts already tolerates above) threw all the way out of
    // main() uncaught — a stack trace and a non-zero exit, i.e. THIS gate blocking every push on
    // the machine over a git problem that has nothing to do with the code being pushed. Converted
    // to a typed error so scanOutsideTree/main can fail OPEN the same way Rules 1-3 do, while still
    // surfacing that the check was SKIPPED rather than quietly reporting "clean".
    throw new OutsideTreeUnavailableError(e?.message ?? String(e));
  }
  const out = [];
  for (const rel of raw
    .split('\n')
    // Strip only the line terminator, not surrounding whitespace (round-4 review T3): `git
    // ls-files` output is LF-joined, so `\n` is already gone from `split`; the one remaining
    // terminator artifact is a trailing `\r` on a CRLF checkout. `.trim()` went further and ate
    // real leading/trailing spaces IN THE FILENAME too — a tracked path like `" x.mjs"` or
    // `"x .mjs"` is legal git content, and trimming silently mangles it into a path that resolves
    // to nothing on disk, so this rule would never scan the file it was supposed to.
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)) {
    // Case-SENSITIVE (round-4 review T4): on a case-sensitive filesystem (Linux, every cloud
    // drain) a tracked `Scripts/foo.mjs` is a DIFFERENT directory from `scripts/`, not the same
    // one spelled differently. Folding case here made the filter either skip a real `scripts/`
    // path spelled with different case (if git ever reported one) or, more subtly, treat an
    // actually-different `Scripts/` tree as this rule's own territory and silently exclude it
    // from the outside scan it should have covered.
    if (rel.split('/')[0] === 'scripts') continue; // scripts/ itself is Rules 1-3's territory
    out.push(join(repoRoot, rel));
  }
  return out;
}

// Scan every tracked outside file for a dead scripts/ import. Returns
// `{ violations, skipped, reason }` — `violations` is
// [{ file (repo-relative, forward slashes), specifier, line, kind, suggestedFix }]; `skipped` is
// true when EITHER `git ls-files` itself failed OR statting some import target failed for a reason
// other than ENOENT (both raise OutsideTreeUnavailableError — see that class's own comment), in
// which case `violations` is always `[]` and `reason` carries the failure text: a scan that could
// not finish must never report a mix of "these violations are real" and "the rest is unverified" —
// there is one shape for "I could not check", not one per cause. Whole-tree, like scanTree() above
// — not diff-scoped — because the failure this rule exists to catch is on the CONSUMER side, which
// the pushed range may not even touch (see main()'s own comment on why this is never skipped the
// way Rules 1-3 are).
export function scanOutsideTree(
  repoRoot = REPO_ROOT,
  scriptsDir = SCRIPTS_DIR,
  { _git = git, _statSync = statSync, _readFile = readFileSync } = {},
) {
  let files;
  try {
    files = collectOutsideTrackedFiles(repoRoot, { _git });
  } catch (e) {
    if (!(e instanceof OutsideTreeUnavailableError)) throw e;
    return { violations: [], skipped: true, reason: e.message };
  }
  const violations = [];
  try {
    for (const file of files) {
      let source;
      try {
        source = _readFile(file, 'utf8');
      } catch (e) {
        // ENOENT is ORDINARY here and means exactly "nothing to scan": plan 3956 cuts plan
        // worktrees SPARSE, so a tracked file under one of the six heavy price-pipeline stores
        // genuinely is not on disk. Every OTHER read failure — a permissions error, a transient
        // IO fault — means this file was never examined, and reporting that as "absent" would
        // let the scan claim a clean outside tree it never actually read. That is the
        // silent-narrowing shape this whole rule exists to catch, so it takes the same exit as a
        // git failure and a non-ENOENT stat failure: the WHOLE outside-scan degrades to skipped,
        // with the reason printed on its own line.
        if (e?.code === 'ENOENT') continue;
        throw new OutsideTreeUnavailableError(`${file}: ${e?.message ?? String(e)}`);
      }
      for (const v of findDeadScriptsImports(source, file, { scriptsDir, _statSync })) {
        violations.push({ file: relative(repoRoot, file).split(sep).join('/'), ...v });
      }
    }
  } catch (e) {
    if (!(e instanceof OutsideTreeUnavailableError)) throw e;
    // Round-3 review T4: same fail-open shape as the git-failure case above — a stat failure while
    // checking one import target must not surface as a mix of "these violations are real" (found
    // before the failing file) and "the rest was never checked". Degrading the WHOLE outside-scan
    // to skipped:true discards nothing false: any violation found so far was found by a scan that,
    // as a whole, did not complete.
    return { violations: [], skipped: true, reason: e.message };
  }
  return { violations, skipped: false, reason: null };
}

const FIX_LINES = [
  '',
  'A non-test `scripts/**/*.mjs` module must not import outside `scripts/`.',
  'scripts/test-helpers/isolated-plan-repo.mjs copies the non-test scripts tree into a temp',
  'repo and runs the COPIES, so an escaping specifier resolves to nothing there and the',
  'copied tool dies with ERR_MODULE_NOT_FOUND — possibly not in YOUR suite, but later, in an',
  'unrelated one, once some import edge reaches the offending module.',
  '',
  'Fix: move the shared piece INTO `scripts/` and have the other side import it.',
  'Hook modules live inside scripts/hooks/ now, so this rule is the same for them:',
  'nothing under scripts/ may import shared/ or backend/.',
  '`scripts/hooks/lib/loader-common.mjs` re-exporting `scripts/coord/stdin-read.mjs` is the pattern.',
  'A `./test-helpers/…` import breaks the same way — that dir is never copied either.',
  '',
  'Rule 3: a non-test module under scripts/coord/ may import only scripts/coord/** and node:',
  'builtins (a bare package specifier needs a one-line-justified entry in',
  'COORD_BARE_IMPORT_ALLOWLIST). scripts/coord/ is the generic core the public extraction takes',
  'as-is, so it may never reach back into scripts/project/ or plain scripts/ — move the shared',
  'piece into scripts/coord/ too, or take it as a parameter from the caller instead.',
  '',
  'Rule 4 (plan 3962): a file OUTSIDE scripts/ that imports a scripts/ path must import one that',
  'actually EXISTS. Rule 1 is one-way and cannot see this direction — a scripts/ module MOVE (like',
  'plan 3962 Phase 2 moving 93 modules into scripts/coord/, with no import-path shim: shims exist',
  'only for modules invoked by PATH as a command) can silently break an outside consumer, and',
  'nothing catches it until that consumer actually runs and dies MODULE_NOT_FOUND. Fix: repoint the',
  "dead specifier at the module's new home — the violation names the scripts/coord/ alternative",
  'when a same-basename file lives there.',
  '',
  'Full rule, evidence, and the hand-scan one-liner: docs/runbooks/scripts-module-layout.md',
  '',
];

function main() {
  const ranges = process.argv.slice(2);
  const scanScripts = rangesTouchScripts(ranges);
  const violations = scanScripts ? scanTree() : [];
  // Rule 4 is NEVER range-skipped, unlike Rules 1-3 above: the break it exists to catch (plan
  // 3962) is on the CONSUMER side, outside scripts/ entirely, so a push the ranges test says
  // "doesn't touch scripts/" is exactly the shape where an outside file's own edit introduces (or
  // simply still carries) a dead scripts/ specifier. This is a cheap read-and-regex over the
  // tracked outside tree (~1,400 files), not a diff walk, so there is no scan-cost reason to gate
  // it the same way Rules 1-3 are gated.
  const outsideResult = scanOutsideTree();
  const outsideViolations = outsideResult.violations;
  const allViolations = [...violations, ...outsideViolations];
  if (allViolations.length === 0) {
    // Round-2 review T1 (broadened round-3, T4): `outsideResult.skipped` means the check could not
    // complete — a `git ls-files` failure OR a non-ENOENT stat failure on an import target — and
    // never ran to a clean conclusion. That is NOT the same fact as "ran it and found nothing", so
    // the two must read differently here. A skip still exits 0 (an unreachable git or a transient
    // stat failure must not block every push on the machine, same fail-open stance
    // rangesTouchScripts already takes above), but the skip is named explicitly so a reader — or a
    // future change to this function — cannot mistake it for a clean scan.
    const scriptsClause = scanScripts
      ? 'no escaping imports, no hand-built CLI entry guards'
      : 'scripts/ scan skipped (push touches no scripts/ file)';
    const outsideClause = outsideResult.skipped
      ? `outside-to-scripts import check SKIPPED (${outsideResult.reason}), not verified this run`
      : 'no dead outside-to-scripts imports';
    console.log(`assert-scripts-self-contained: ${scriptsClause}; ${outsideClause}.`);
    process.exit(0);
  }
  console.error('\nassert-scripts-self-contained: BLOCKED — scripts-module-layout violation(s):\n');
  for (const v of allViolations) {
    const why =
      v.kind === 'test-helpers'
        ? 'test-helpers/ is never copied'
        : v.kind === 'hand-built-entry-url'
          ? 'CLI entry guard never matches on Windows — use pathToFileURL(process.argv[1]).href'
          : v.kind === 'coord-boundary'
            ? 'Rule 3: scripts/coord/ may only import scripts/coord/** and node: builtins'
            : v.kind === 'coord-bare-import'
              ? 'Rule 3: bare specifier not in COORD_BARE_IMPORT_ALLOWLIST (assert-scripts-self-contained.mjs)'
              : v.kind === 'dead-scripts-import'
                ? 'Rule 4: imports a scripts/ path that does not exist on disk'
                : 'escapes scripts/';
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    const hint =
      v.kind === 'dead-scripts-import' && v.suggestedFix
        ? ` — did it move to ${v.suggestedFix}?`
        : '';
    console.error(`  ✗ ${loc} → ${v.specifier}${hint}   (${why})`);
  }
  console.error(FIX_LINES.join('\n'));
  process.exit(1);
}

// Run only as a CLI entrypoint, not when imported by the unit test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
