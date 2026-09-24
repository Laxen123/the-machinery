#!/usr/bin/env node
// scripts/select-battery-tests.mjs — delta-scope the pre-push coord test battery (plan 1673).
//
// WHY: `scripts/hooks/pre-push.sh` (formerly `.husky/pre-push`) ran the FULL `node --test scripts/*.test.mjs` battery (99 files at
// c2ebcb874) for ANY `scripts/*.mjs` in the pushed delta. Each battery spawns ~one worker per
// test file plus real git fixture repos; with 5-7 parallel coord sessions each pushing coordWrite
// commits, 9-10 batteries ran CONCURRENTLY (measured 2026-07-10: 162 live git.exe, ~15 process
// creations/sec, kernel paged pool 6.1 GB in 5h → reboot). Plan 1289 delta-scoped the hook's
// *guards*; this closes the same gap for the battery. The companion axis is the machine-wide
// mutex in `scripts/battery-lock.mjs`.
//
// CONTRACT (the hook depends on both halves):
//   stdin  — the pushed changed-file list, one repo-relative path per line (the hook's `$CHANGED`,
//            computed ONCE by `scripts/compute-push-diff.mjs`; we never recompute a diff).
//   stdout — the `scripts/**/*.test.mjs` files to run, one per line, on exit 0.
//   exit 3 — "cannot scope this delta: RUN THE FULL BATTERY". Malformed input, no scripts/**/*.mjs
//            in the delta, a scripts/ path this selector cannot turn into a graph key (a nested
//            non-module, or a .mjs the key rules exclude), or an empty selection all route here.
//            Any non-zero exit means the same to the hook, so a crash is fail-SAFE (full
//            battery), never a test-skip.
//
// SELECTION = union of three rules (operator ruling 2026-07-10: no always-run core list — pairing
// + import closure suffices, and the full battery stays reachable via PREPUSH_FULL_BATTERY=1),
// every one of them keyed on the scripts/-relative KEY (`board.mjs` flat, `coord/landing-lock.mjs`
// nested) rather than a flat basename:
//   (a) changed `scripts/**/*.test.mjs` themselves;
//   (b) `<dir>/X.test.mjs` for each changed `<dir>/X.mjs` (name pairing) — this is what covers
//       the many tests that exercise a CLI by SPAWNING it rather than importing it;
//   (c) every `scripts/**/*.test.mjs` whose static reference closure reaches any changed
//       `scripts/**/*.mjs` (BFS, resolving only within `scripts/`).
//
// Since plan 4085 the closure also follows three shapes whose DIRECTORY it cannot compute but
// whose basename is literal — a real-tree source read off a repo-root binding
// (`join(REPO_ROOT, 'scripts', 'hooks', 'x.mjs')`), a TRANSFORMED self-dir binding
// (`import.meta.dirname.replace(…)`), and a join against any other identifier
// (`join(spineDir, 'done-worktree.mjs')`) — by resolving the basename against the real tree. See
// § the basename fallback for why an EDGE is the cheap direction here and an UNRESOLVABLE
// classification the expensive one.
//
// The closure has two edge kinds: `import`/`export … from`/dynamic `import()` specifiers resolving
// to a scripts/ sibling (at every BFS depth), plus a spawned-CLI reference on a code line of the
// ENTRY TEST FILE only — either the literal `scripts/<name>.mjs` or `join(HERE, '<name>.mjs')`
// against the module's own directory (see extractScriptRefs for why that asymmetry is
// load-bearing). Both are over-approximate by design: a regex can match a token inside a string
// that is not a real dependency, which only ever ADDS test files to the subset. Over-inclusion
// costs seconds; under-inclusion ships a regression. Never trade that direction.
//
// This module also owns the OTHER view of the same fact — `unresolvedScriptRefReason`, which says
// whether a source spells a sibling reference the extraction above CANNOT follow. The battery
// pass-cache keys on this closure, where a dropped edge is a false green rather than a slow run,
// so it consumes both halves (a permissive `referenceClosure(…, { allLiterals: true })` plus that
// classification as its widen trigger). Keeping the two views in one module is what keeps them
// from drifting — plan 2560 derailed on a second, private copy of the spawn-shape list.
//
// Measured on the 101-file suite: a leaf module (`next-plan-id.mjs`) selects 2, `landing-lock.mjs`
// 19, and the `coord-git.mjs` hub 58 — a hub SHOULD be wide, that is the closure working.
// Re-measured on the 313-file suite after plan 4085 completed the closure: `next-plan-id.mjs` 34,
// `hooks/chain-wiki-loader.mjs` 6, `coord/land/spine.mjs` 32, `coord/battery-pass-cache.mjs` 64,
// `coord/gate-pass-cache.mjs` 64, `board.mjs` 124, `coord/landing-lock.mjs` 145,
// `coord/coord-git.mjs` 211. The big movers are repairs, not width: `board.mjs` was selecting 12
// while ~115 of 313 tests reach the drain machinery that SPAWNS it (`coord/queue-drain.mjs`, four
// `_exec` sites), so the old 12 was an under-selection the graph could not see.
//
// Rounds 6-7 then admitted the INLINE computed-directory spellings: the canonical
// `dirname(fileURLToPath(import.meta.url))` as a SELF-DIR spelling (resolved exactly against
// fromDir) and any other `dirname(<expr>)` through E2's basename fallback. Re-measurement is how
// those were accepted rather than assumed (T2's rule): every key above moved by +1 or +2 against
// the pre-round-6 numbers and `hooks/chain-wiki-loader.mjs` not at all — nowhere near the ~2x blob
// guide, each added test tracing to a real construction site per E3's smell test — and the round-7
// split between the two spellings moved no width at all.
//
// THE UN-PLACEABLE RESIDUE (plan 4085 T2). Every shape this module follows ends at a statically
// spelled BASENAME, so what remains unplaceable is a reference whose basename is itself computed
// — and those are exactly what `unresolvedScriptRefReason` reports for the pass-cache. Two known
// residue shapes are NOT edges today and are left deliberately:
//   - a basename handed through a helper rather than written at the path site —
//     `scriptFile('main-checkout-clean-guard.mjs', join(REPO, 'scripts'))`
//     (main-checkout-clean-guard.test.mjs). Following it needs call-graph knowledge, not a regex.
//   - a fully computed basename (`join(dir, `${name}.mjs`)`), which no static rule can place.
//   - a PARTIALLY literal join against an unknown directory — `join(dir, 'coord', name)`. Neither
//     an edge nor a widen trigger, on master before plan 4085 and still. Making it a trigger was
//     measured at plan 4085 /gpt-review round 3 and REJECTED: the shape is the ordinary fixture
//     idiom, so it flags 189 of 701 modules (27%), and since the pass-cache widens on any flagged
//     member of a permissive closure that switches its narrowing off wholesale — the plan-2578
//     blob again, this time on the KEY rather than the selection.
// The fix for a residue shape that starts costing real misses is a new EDGE, not a wider
// always-run set: plan 4085 § E1 measured the "always run what the graph cannot place" union and
// found it transitively explosive (one flagged module took it from 54 to 229 of 311).
// One harmless artifact of the real-tree read rule: a key is emitted for a path a test merely
// SPELLS in an assertion string (`scripts/x.mjs` in battery-pass-cache.test.mjs), which is a dead
// node — nothing reads it and no delta can ever contain it. That is the same posture as the
// long-standing `scripts/<name>.mjs` literal rule, and for the same reason: matching is on the
// NAME, so a DELETED module still selects its dependents.
//
// A changed module that was DELETED still matches rules (b)/(c): rule matching is on the changed
// NAME, not on the file existing. Only the BFS *traversal* skips unreadable files.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStdinResult } from './stdin-read.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// Exit code meaning "I could not scope this delta — run the full battery." Distinct from 1 so a
// future caller can tell a deliberate fall-back from an unexpected crash (both fail safe).
export const EXIT_RUN_FULL = 3;

// `findRepoRoot` is now ONE implementation, `scripts/coord/scripts-anchor.mjs` — see that module for
// why the anchor is the `scripts/` directory NAME and not a repo-root marker or an existsSync
// probe. It used to be copied into each module because Rule 3 forbids a coord-core-destined
// module importing a NON-coord sibling; the shared version lives under `scripts/coord/`, so
// that objection is gone and the copies are retired (plan 3962 Phase 2).
// Kept as a named export because this module's test names it.
export const findRepoRoot = (startDir) => repoRootFrom(startDir);

// plan 3962 P1, job 2 evidence: this module IS reachable from a COPIED tree, so "only ever run
// from the real repo" was false as originally written. `scripts/test-helpers/isolated-plan-repo.mjs`
// copies the whole non-test scripts/ tool tree into a temp repo (its own header names
// select-battery-tests.mjs as a historically-REACHABLE case — plan 2615, which broke
// stamp-exec-model.test.mjs — and assert-scripts-self-contained.mjs's header repeats the same
// citation), and done-worktree.test.mjs dynamically imports the COPIED done-worktree.mjs (its
// own comment: "import by STRING LITERAL ... done-worktree.mjs carries the same CLI entry
// guard"), which imports battery-ledger.mjs, which imports EXTERNAL_TREE_PREFIXES from here — so
// this module's top-level code runs against a temp-repo COPY of itself, not only the real repo.
// An ABSENT coord.config.json there is SAFE, not a silent-narrowing hazard: loadCoordConfig()
// never throws on a missing file (normalizeConfig(null) just defaults
// externalTreePrefixes/dataDependencyMap to []/{}), and the walk-up above lands on the COPY's own
// repo root (the temp repo's `scripts/` parent) — exactly the directory a test can drop its own
// coord.config.json into for config-driven fixture behavior, which done-worktree.test.mjs's
// "archiveBatchMembers recognizes a CONFIGURED lanes.waitingOperator rename" test already does
// for a different key. A fixture that writes no coord.config.json gets the coord-kit-generic
// defaults, the same posture as a real config-less checkout — by design, not a hazard peculiar to
// this module.
//
// A MALFORMED coord.config.json is a DIFFERENT case the paragraph above does not cover:
// loadCoordConfig DOES throw on that (bad JSON, or a value a normalizer rejects) — by design, so
// every module-scope reader is individually responsible for fail-open (bug found + fixed in plan
// 3962 P1: this was the ONE module-scope reader among the four keys this plan's new
// coord.config.json keys introduced — jobOutputPrefixes and cloudRepos are read only inside
// function bodies in pre-yield-guard.mjs and queue-drain.mjs respectively, never at module scope
// — that skipped it, so a malformed on-disk coord.config.json crashed at STATIC IMPORT TIME,
// before any importer's own try/catch could run: deploy.mjs's `resolveDeployServicesDefault`
// already wraps ITS loadCoordConfig call, but deploy.mjs imports ../done-worktree-lib.mjs ->
// battery-ledger.mjs -> this module, so the throw here happened first, on the way in). Mirrors
// the fail-open contract `scripts/hooks/land-timeout-guard.mjs`'s resolveLandTimeoutSeconds and
// `build-index-lib.mjs`'s equivalent already use; `repoRoot`/`loadConfig` are parameters purely
// for testability, same reason as those two.
export function resolveBatterySelectionConfig(repoRoot, loadConfig = loadCoordConfig) {
  try {
    const cfg = loadConfig(repoRoot);
    return {
      externalTreePrefixes: cfg.externalTreePrefixes,
      dataDependencyMap: cfg.dataDependencyMap,
    };
  } catch {
    // fail open — a malformed coord.config.json must never crash every importer of this module
    return { externalTreePrefixes: [], dataDependencyMap: {} };
  }
}
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const CFG = resolveBatterySelectionConfig(REPO_ROOT);

const SCRIPTS_DIR = 'scripts';
// Exported so every consumer resolves against ONE spelling of the scripts root rather than
// hard-coding a second literal of its own (/gpt-review round 3, finding cbed8d).
export const SCRIPTS_DIR_DEFAULT = SCRIPTS_DIR;
// A changed path this selector can turn into a graph KEY: a `.mjs` file under scripts/, at ANY
// depth. Capture group 1 is the scripts/-relative key — `board.mjs` flat,
// `coord/landing-lock.mjs` nested, `coord/land/spine.mjs` deeper — which is exactly the shape
// listTestFiles() returns, resolveRefKey() resolves specifiers into, and referenceClosure() keys
// its BFS nodes by. So a nested key drops straight into selectTests with no special-casing: rule
// (b) pairs `coord/x.mjs` with `coord/x.test.mjs`, and rule (c) matches the closure node of the
// same name.
//
// It was one level deep until plan 4076. That was written when scripts/ WAS flat and the nested
// bail below was nearly unreachable; plan 3962 then moved the core coordination libraries into
// scripts/coord/, after which 44% of the tree's non-test modules are nested and 22 of the last 65
// battery-triggering commits bailed to the whole battery for no reason but their depth (measured
// on this tree — plan 4076 T1).
//
// What makes the widening safe is the CLOSURE being complete enough to place the tests a scoped
// nested delta would otherwise strand — and plan 3959's nested-awareness (recursive
// listTestFiles, resolveRefKey on `../x.mjs` and `./sub/x.mjs`, the nested spawn literal) was NOT
// on its own enough. Plan 4076's first attempt widened this predicate on exactly that assumption
// and its review found four REAL under-selections in the tree: a nested module scoped, and the
// test covering it was not selected, because the covering test reached the module through a shape
// the closure could not follow. That is the one error direction this module may never make, so the
// widening was held and plan 4085 taught the closure the missing vocabulary (the basename fallback
// for an unresolvable directory, the computed self-dir spellings) FIRST. This predicate is
// deliberately the second half of that pair, not the first — if a future change narrows the
// closure's vocabulary, it re-opens the gap this bail used to cover wholesale.
const SCRIPT_PATH_RX = /^scripts\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs)$/;
// The scripts/-relative key for a changed path, or null when this selector cannot key it. The ONE
// definition the key half (changedScriptBasenames) and the bail half (hasNestedScriptChange) both
// consume, so "a nested path we bail on" is the exact complement of "a nested path we can key"
// rather than two regexes that can drift into a gap between them — the gap being precisely an
// under-selection, the one error direction this module may never make.
//
// The shape must also be a GRAPH key (plan 4085's isGraphKey, defined below and consumed here as
// the single definition rather than re-spelled): a `.mjs` under `__golden__` or `node_modules`
// matches the regex but is excluded from every edge the closure can produce AND skipped by
// listTestFiles(), so keying it would admit a changed path that contributes nothing — a
// non-bailing selection with an invisible member, which is the gap this predicate exists to make
// unrepresentable (/gpt-review round 1, finding 4d539c). Returning null routes it to the bail,
// the fail-safe direction. Called only from function bodies, never at module load, so the
// forward reference to isGraphKey is resolved by the time any caller runs.
export const scriptModuleKey = (p) => {
  const key = SCRIPT_PATH_RX.exec(p)?.[1] ?? null;
  return key !== null && isGraphKey(key) ? key : null;
};
// scripts/ is not flat: `scripts/coord/**`, `scripts/hooks/**`, `scripts/lib/decision-dossier/`.
// A nested path this selector cannot key is invisible to the reference closure, so a delta
// changing one alongside a keyable path would compute a non-empty subset that silently omits the
// tests depending on it. Bail to the full battery.
//
// Since plan 4076 the rule is "nested AND unkeyable", not "nested AND not a test". A nested `.mjs`
// at any depth is keyable (SCRIPT_PATH_RX above) and enters the graph; everything else nested
// still bails — `scripts/hooks/pre-push.sh` and the other shell guards (shell the .husky/pre-push
// dispatcher sources, which nothing imports, so they contribute no key), `scripts/coord/*.json`,
// `scripts/coord/land/__golden__/*.txt`, `scripts/market-plan-templates/*.md`. The pre-push gate
// logic is the load-bearing case: a MIXED delta (scripts/board.mjs + scripts/hooks/pre-push.sh)
// must still omit nothing, and it bails here because that path yields no key.
//
// A nested path whose segments fall outside SCRIPT_PATH_RX's character class also bails, which is
// the fail-safe direction: SAFE_PATH_RX admits `[`/`]` (Next.js dynamic routes), so
// `scripts/coord/[x].mjs` reaches this function, keys as null, and forces the full battery rather
// than contributing a key the closure would never match.
//
// Deliberately NOT an EXTERNAL_TREE_PREFIXES entry: that list is dual-purpose and also defines
// battery-pass-cache's content-addressed key set (keyedPaths imports it), and a `scripts/hooks`
// entry there would turn every repo without that directory UNCACHEABLE. Selection bail-out is this
// guard's job; keying is not.
// (Keying `scripts/hooks/pre-push.sh` IS needed — plan 2578 narrowed the `scripts` key to the
// selection's flat-file import closure, so it is no longer covered wholesale. Plan 2598 does that
// with a dedicated `gateLogic` key component instead, which also avoids collapsing the key's
// `ls-tree` pathspec. See battery-pass-cache.mjs § gateLogicKey.)
const NESTED_SCRIPTS_PATH_RX = /^scripts\/[^/]+\/.+$/;
// A `.mjs` anywhere under scripts/, at any depth — the shape that IS a module and therefore can
// own tests, independent of whether this selector manages to key it.
const SCRIPTS_MODULE_SHAPE_RX = /^scripts\/.*\.mjs$/;
// True when the delta contains a scripts/ path this selector cannot turn into a graph key, so the
// selection it would compute is missing a member and must be abandoned for the full battery.
//
// TWO shapes reach that state, and depth is not what unites them (/gpt-review round 2, finding
// 632962 — the bail was spelled over nested paths only because, when it was written, every
// unkeyable module happened to be nested):
//   - a NESTED non-module: `scripts/hooks/pre-push.sh`, `scripts/coord/*.json`, a `__golden__`
//     fixture. Nothing imports it, so it contributes no key and no test can be reached through it.
//   - an UNKEYABLE MODULE at any depth, flat included: `scripts/[x].mjs` is accepted by
//     parseChangedList (SAFE_PATH_RX admits `[`/`]` for Next.js routes) but falls outside
//     SCRIPT_PATH_RX's charset, and a `.mjs` under `__golden__`/`node_modules` is excluded by
//     isGraphKey. Left to drop out, such a path mixed with an ordinary module scoped to that
//     module ALONE and silently omitted its own tests — an under-selection, the one error
//     direction this module may never make.
// A flat NON-module (`scripts/notes.md`) is neither: nothing imports it, it owns no tests, and it
// has never forced the battery. Keeping it out is what stops this guard from degenerating into
// "any scripts/ touch runs everything".
//
// The name is kept because battery-pass-cache.mjs consumes this exact symbol for its canonical
// derivation and the two MUST bail identically (plan 4076 D1) — renaming is a separate change, not
// a hunk in the fix that widened it.
// The ONE spelling of "this selector cannot turn this path into a graph key". Exported because the
// CLI's fallback diagnostic names the offending paths and must never disagree with the predicate
// that actually bailed: a second copy would let a future case bail correctly while printing an
// empty `Unkeyable:` list (/gpt-review round 3, findings d71bf1 / 053eae / 58336f). That is the
// private-copy drift this module's header warns about three times over.
export const isUnkeyableScriptPath = (p) =>
  (NESTED_SCRIPTS_PATH_RX.test(p) || SCRIPTS_MODULE_SHAPE_RX.test(p)) &&
  scriptModuleKey(p) === null;
export const hasNestedScriptChange = (paths) => paths.some(isUnkeyableScriptPath);

// Real-tree paths OUTSIDE scripts/ that battery tests read directly (not via a fixture): the hooks
// they execute end-to-end, and the trees their assertions walk. A delta touching any of these
// cannot be scoped by the import graph — `pre-push-hook.test.mjs` runs the REAL `.husky/pre-push`
// under `sh -e`, yet nothing in scripts/ imports it — so we bail to the full battery.
//
// This list is not maintained by hand-vigilance: `select-battery-tests.test.mjs` scans every
// `scripts/*.test.mjs` for `join(REPO…, '<segment>', …)` and FAILS when a test starts reading a
// real-tree path no prefix here covers. Add the prefix (or make the test use a fixture) — never
// silence the guard.
// plan 3962 P1: the coord-kit-generic bail-out roots. `backend/` (vetapp's own price-pipeline
// stores + backend test fixtures no scripts/*.mjs file imports) moved to coord.config.json's
// `externalTreePrefixes` key — see EXTERNAL_TREE_PREFIXES below, which is this default PLUS the
// project's additions. Every other entry here is coord-kit convention (the plan/handoff/hook
// machinery every checkout using this spine shares), so it stays the module's own default.
export const DEFAULT_EXTERNAL_TREE_PREFIXES = [
  '.husky/',
  // Plan 3765 moved hook LOGIC to scripts/hooks/ (a nested scripts path, so
  // hasNestedScriptChange bails to the full battery on its own). What is left under .claude/
  // is settings.json + commands/ + workflows/, which build-codex-hooks.test.mjs and
  // apply-workflow-file.test.mjs read from the real tree — hence the whole-dir prefix that
  // replaced the old '.claude/hooks/' entry.
  '.claude/',
  '.codex/',
  '.gitattributes', // union-merge-logs.test.mjs asserts on the real file's merge=union lines
  'AGENTS.md',
  'CLAUDE.md',
  'wiki/',
  'node_modules/',
  'coord.config.json',
  'package.json',
  // assert-wiki-prettier-ignored.test.mjs reads the REAL .prettierignore to decide whether the
  // wiki vault is outside prettier's reach (plan 2389) — nothing in scripts/ imports it.
  '.prettierignore',
  // pre-push-battery-cap.test.mjs reads the REAL .github/workflows/ci.yml: the CI battery step is
  // the one `node --test scripts/*.test.mjs` caller that cannot inherit the hang backstop from the
  // shared BATTERIES entry (YAML, not JS), so its flags are pinned literally there. Editing that
  // workflow must therefore re-select that test, and nothing in scripts/ imports a .yml.
  '.github/',
];
export const EXTERNAL_TREE_PREFIXES = [
  ...DEFAULT_EXTERNAL_TREE_PREFIXES,
  ...CFG.externalTreePrefixes,
];

export const touchesExternalTree = (paths) =>
  paths.some((p) => EXTERNAL_TREE_PREFIXES.some((pre) => p === pre || p.startsWith(pre)));

// The two join-idiom shapes that mean "this test reads the REAL repo tree" — the SINGLE
// definition shared by the EXTERNAL_TREE_PREFIXES guard in select-battery-tests.test.mjs and by
// battery-pass-cache's per-selection prefix attribution (plan 2279). Capture group 1 is the
// first real-tree ARGUMENT, which is the first segment only when the test wrote the path
// segment-wise; a slash-joined literal captures the whole path (see realTreeFirstSegment).
// Shared so the guard and the attribution scan can never drift: a new
// idiom added here widens BOTH in lockstep (a guard-only widening would silently un-key a prefix
// a real test reads). Safe to share as /g regexes — every consumer uses matchAll, which never
// mutates lastIndex.
// `$` is legal in a JS identifier and means end-of-input in a pattern, so every name that reaches
// an alternation is escaped (/gpt-review round 3, finding 9fa123). Declared here because
// REAL_TREE_JOIN_IDIOMS below is built with it at module load; `selfDirAlternation` uses the same
// one further down.
const escapeForRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The repo-root binding names, spelled ONCE. Both consumers derive from this list: the idioms
// below, and the basename fallback's REPO_ROOT_ALT — which excludes these bindings because a join
// against one of them is already resolved exactly. Spelling the vocabulary twice meant a name
// added for one consumer silently widened neither the other's regex nor its exclusion
// (/gpt-review round 4, 2ecec3; round 3's 86dde8 closed the same drift one seam at a time).
export const REPO_ROOT_BINDING_NAMES = Object.freeze(['REPO', 'REPO_ROOT', 'ROOT', 'repoRoot']);
const REPO_ROOT_NAME_ALT = REPO_ROOT_BINDING_NAMES.map(escapeForRegExp).join('|');

// The same vocabulary as a ready-made regex alternation, for a consumer that needs the grammar
// but not the idioms themselves (plan 4071 review round 3): battery-pass-cache.mjs's nested-
// segment matcher generalizes the two shapes below to N>1 quoted arguments and would otherwise
// re-type the name list, so a future alias would have to be added in two places. `withHere`
// selects the second idiom's wider set, which also admits the self-dir binding.
export const repoRootAlt = (withHere = false) =>
  `(?:${[...REPO_ROOT_BINDING_NAMES, ...(withHere ? ['HERE'] : [])]
    .map(escapeForRegExp)
    .join('|')})`;

export const REAL_TREE_JOIN_IDIOMS = Object.freeze([
  new RegExp(`\\bjoin\\(\\s*(?:${REPO_ROOT_NAME_ALT})\\s*,\\s*'([^']+)'`, 'g'),
  new RegExp(
    `\\bjoin\\(\\s*(?:${REPO_ROOT_NAME_ALT}|HERE)\\s*,\\s*'\\.\\.'\\s*,\\s*'([^']+)'`,
    'g',
  ),
]);

// The first PATH SEGMENT of a REAL_TREE_JOIN_IDIOMS capture. A test may spell the same real-tree
// read either segment-wise — join(REPO, 'backend', 'scripts', '_seed_validation.py') — or
// slash-joined in one literal — join(REPO, 'backend/scripts/_seed_validation.py'). Both mean the
// same read, so EXTERNAL_TREE_PREFIXES coverage must judge them identically, by the first segment:
// every entry in that list is a PREFIX (touchesExternalTree matches with startsWith), so a covered
// path is exactly one whose first segment names an entry.
//
// Plan 3969 (found while landing that plan; the defect is plan 3954's): the guard compared the RAW
// capture against first-segment names, so the slash-joined form could match no entry at all.
// `spawn-failure-signatures.test.mjs`'s join(REPO_ROOT, 'backend/scripts/_seed_validation.py') was
// reported as uncovered even though `backend/` covers it — a FALSE POSITIVE that turned the
// scripts battery red on origin/master for every `scripts/**` push.
//
// A capture containing a `..` segment resolves OUT of its first segment, so its first segment says
// nothing about what is actually read: 'backend/../frontend/src/page.tsx' would read under
// `frontend/` while presenting as covered by `backend/`. Narrowing must never be the reason an
// uncovered read passes, so a traversal capture returns a sentinel that is in no allow-set and is
// therefore always an offender — the selector's fail-safe direction (over-include) is preserved.
// Review finding 9afa71 (plan 3969, gpt-review round 1) caught this in the first cut, which
// reduced the capture unconditionally.
export const realTreeFirstSegment = (captured) => {
  const path = String(captured);
  if (path.split('/').includes('..')) return `../ traversal: ${path}`;
  return path.split('/')[0];
};

// The offenders a source file contributes to the EXTERNAL_TREE_PREFIXES guard: every real-tree
// read whose first segment is outside `allowedFirstSegments`. Pure and exported so the guard's
// own behaviour is unit-testable in BOTH directions against injected source, rather than only
// observable through a scan of the live scripts/ tree.
export function realTreeReadOffenders(src, allowedFirstSegments) {
  const offenders = [];
  for (const [i, idiom] of REAL_TREE_JOIN_IDIOMS.entries())
    for (const m of src.matchAll(idiom))
      if (!allowedFirstSegments.has(realTreeFirstSegment(m[1])))
        offenders.push(`${m[1]}${i === 1 ? " (via '..')" : ''}`);
  return offenders;
}
// A path that is plausibly a repo-relative file. Anything else means the caller handed us garbage
// (or a NUL-separated / shell-mangled list) and we must not pretend to have scoped it.
//
// Plan 2670 — `[` and `]` are legal here: every Next.js App Router dynamic segment carries them
// (`frontend/src/app/veterinar/[city]/klinik/[clinic]/page.tsx`), so rejecting them made the
// COMMONEST frontend diff shape unscopeable. The throw fails SAFE — the CLI turns it into
// EXIT_RUN_FULL — so the symptom was silent over-running, not a miss: a routine clinic-profile
// diff that maps to ZERO data-triggered tests instead ran every mapped test, and any pre-existing
// red among them blocked a push it had nothing to do with. These paths are only ever MATCHED
// against the dependency maps, never interpolated into a shell command, so widening the class
// costs no safety; the absolute-path and `..` traversal guards below are untouched.
const SAFE_PATH_RX = /^[A-Za-z0-9._\-/[\]]+$/;

// --- pure helpers -----------------------------------------------------------

// Parse stdin's path list. Returns { paths } or throws on anything malformed — the CLI turns a
// throw into EXIT_RUN_FULL, so a mangled list can never silently narrow the battery.
export function parseChangedList(stdin) {
  const paths = [];
  for (const raw of String(stdin).split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) continue;
    if (line.startsWith('/') || line.includes('..') || !SAFE_PATH_RX.test(line))
      throw new Error(`malformed path in changed-file list: ${JSON.stringify(line)}`);
    paths.push(line);
  }
  return paths;
}

// The changed `scripts/**/*.mjs` KEYS (e.g. `coord-git.mjs`, `board.test.mjs`,
// `coord/landing-lock.mjs`, `coord/select-battery-tests.test.mjs`) — flat and nested, module and
// test alike, in the one shape every other half of this module already speaks. A path this
// selector cannot key contributes nothing here; when it is NESTED, hasNestedScriptChange above has
// already forced the full battery, so "contributes nothing" is never how an unkeyable nested path
// is handled.
export function changedScriptBasenames(paths) {
  const out = new Set();
  for (const p of paths) {
    const key = scriptModuleKey(p);
    if (key !== null) out.add(key);
  }
  return out;
}

export const isTestFile = (basename) => basename.endsWith('.test.mjs');

// `scripts/foo.mjs` → `foo.test.mjs`. Undefined for a file that already IS a test.
export function pairedTestFor(basename) {
  if (isTestFile(basename)) return undefined;
  return basename.replace(/\.mjs$/, '.test.mjs');
}

// A line that is wholly a comment: `// …`, `/* …`, or a ` * …` block-comment continuation. Used to
// keep the spawned-CLI rule off PROSE — this codebase's module headers are dense cross-references
// ("see scripts/landing-lock.mjs"). We do NOT strip comments before matching import specifiers: a
// mis-stripped line could DROP a real `import`, and under-inclusion is the one error direction this
// file must never make.
export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

// A code line that invokes a child process. Used to admit spawned-CLI edges from LIBRARY modules
// without re-welding the dependency graph (see extractScriptRefs).
const SPAWN_CALL_RX = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork|run)\s*\(/;

// A binding whose value is the MODULE'S OWN directory — `const HERE = dirname(fileURLToPath(
// import.meta.url))`, or its modern one-liner `const HERE = import.meta.dirname`. In the flat
// `scripts/` layer that directory IS `scripts/`, so `join(HERE, 'board.mjs')` names a sibling
// module just as surely as the literal `'scripts/board.mjs'` does — and it is the DOMINANT
// cross-script CLI-spawn spelling in this repo (plan 2578 finding 2). Detected from the source
// instead of whitelisted by name: the tree spells this binding nine different ways today (HERE,
// SCRIPTS, SCRIPTS_DIR, SCRIPT_DIR, SELF_DIR, HERE_LIB, scriptsDir, here, SCRIPTS_DIR_FOR_TEST),
// and a tenth spelling must not need an edit here. A binding to anything ELSE (a fixture dir, a
// tmp dir, a repo root) is deliberately NOT collected — `join(tmpRepo, 'board.mjs')` names a
// fixture file, not a sibling module.
const SELF_DIR_BINDING_RX =
  /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname\b)/g;

export function selfDirNames(source) {
  const names = new Set();
  for (const m of String(source).matchAll(SELF_DIR_BINDING_RX)) names.add(m[1]);
  return names;
}

// A binding whose self-dir expression is immediately TRANSFORMED by a method call or property
// access — `const SCRIPTS_DIR = import.meta.dirname.replace(/[\\/]coord[\\/]land$/, '')`
// (coord/land/gates-runner.mjs:1984). SELF_DIR_BINDING_RX matches it: its `import\.meta\.dirname\b`
// alternative stops before the `.`, so the transform was silently IGNORED and the name resolved as
// the module's own bare directory. From `scripts/coord/land` that emitted
// `coord/land/battery-pass-cache.mjs` — a file that exists nowhere, while the real target is
// `coord/battery-pass-cache.mjs` reached through the plan-3962 compat shim. A WRONG edge, not a
// missing one, which is worse: it looks resolved to both halves of this module (plan 4085, row
// 2f9ccd; measured, not read).
// Both spellings of "a method call or property access follows": the dotted `.replace(…)` and the
// equivalent BRACKET access `import.meta.dirname['replace'](…)`, which a `.`-only tail missed and
// so classified PLAIN — re-emitting the very phantom edge this split exists to kill, under a
// different spelling (/gpt-review round 6, 3e0b53; reproduced: `plain=["S"]` with the sibling
// matcher emitting `coord/land/worker.mjs` and `selectTests` returning []).
//
// Erring toward TRANSFORMED is the safe direction: a binding wrongly called transformed loses
// `./<name>` resolution and routes to the basename fallback, which over-approximates (every home
// of that basename) — over-selection for the gate, key-coarsening for the pass-cache. The reverse
// mistake is the false green. So the `\s*` crossing a line break to reach an unrelated `[` (a
// `const HERE = import.meta.dirname` followed by a statement opening with an array literal) costs
// at most a wider selection, never a missed one.
// `?` covers the optional-chaining spellings `?.replace(…)` and `?.['replace'](…)`, which a
// `[.[]`-only tail read as PLAIN (round 9, 68a2c9) — the next spelling in exactly the sequence
// this module's infra-debt line predicts is unbounded. The class is "a member access of any
// kind follows", so it is written as the three characters one can start with rather than as a
// list of the call forms.
const TRANSFORMED_TAIL_RX = /^\s*[.[?]/;

// The subset of selfDirNames whose value really IS the module's own directory, so `./<name>`
// resolution against `fromDir` is sound. A TRANSFORMED binding is excluded here and routed to the
// basename fallback below instead — its directory is unknown, but its referenced basename is still
// a literal.
//
// A name bound BOTH ways in one file is treated as transformed (the transformed set is subtracted
// last): resolving it as the bare module dir would re-emit exactly the phantom this split exists
// to kill, and the fallback's over-approximation is the safe direction for both consumers.
//
// selfDirNames above is deliberately LEFT WHOLE. It feeds the CLASSIFIER's alternation, where a
// transformed binding must keep counting as a self-dir spelling or `` `${SCRIPTS_DIR}/${n}.mjs` ``
// would stop classifying `dynamic-self-dir` and the pass-cache KEY would silently narrow — a false
// green, the one failure mode that cache may never produce. Splitting at the RESOLVER, not at the
// name list, is what keeps the two views moving in one edit (plan 4085 E4 / T3).
export function plainSelfDirNames(source) {
  const src = String(source);
  const plain = new Set();
  const transformed = new Set();
  for (const m of src.matchAll(SELF_DIR_BINDING_RX)) {
    const rest = src.slice(m.index + m[0].length);
    (TRANSFORMED_TAIL_RX.test(rest) ? transformed : plain).add(m[1]);
  }
  for (const name of transformed) plain.delete(name);
  return plain;
}

// Every way THIS source can spell "my own directory", as one regex alternation: the bindings above
// plus the bare `import.meta.dirname` expression, which 13 files use INLINE with no binding at all
// — `` const GATE_CACHE_CLI = `${import.meta.dirname}/gate-pass-cache.mjs` `` (done-worktree.mjs).
// Missing that spelling was a measured FALSE GREEN (/sonnet-review high, plan 2578): the key for a
// selection reaching done-worktree.mjs narrowed to 81 files that did not include gate-pass-cache.mjs,
// so editing gate-pass-cache.mjs alone recomputed the same key and served a HIT. Never empty —
// `import.meta.dirname` is always a valid spelling — so callers never have a null case to handle.
// `$` is legal in a JS identifier and means end-of-input in a pattern, so an unescaped
// `const $dir = import.meta.dirname` produced an alternation that matched nothing — a silent
// under-selection, not a crash (/gpt-review round 3, finding 9fa123).
// (Defined near the top of the file: REAL_TREE_JOIN_IDIOMS is built with it at module load.)

// The unbound inline spelling of the same thing — `dirname(fileURLToPath(import.meta.url))` used
// directly as a join's first argument rather than through a binding. SELF_DIR_BINDING_RX already
// recognises it on the right-hand side of `const HERE = …` to learn the NAME; this is the case with
// no name to learn. Admitting it here (rather than as a second unknown-directory pattern) is what
// makes it resolve EXACTLY against `fromDir` instead of over-approximating by basename, and gives
// its computed-segment twin a widen through `dynamicJoin` for free — both halves in one edit, which
// is what T3 asks for (/gpt-review round 6 a84d04, round 7 d28e93 / b8c799 / 31261b).
//
// The real satisfiers are `landing-queue-watch.mjs:239-240`,
// `join(dirname(fileURLToPath(import.meta.url)), 'landing-queue.mjs')` and the `done-worktree.mjs`
// twin beside it — genuine spawns of both CLIs. (Round 8, 52a814: an earlier draft of this comment
// cited that file's `join(dirname(LQ_CLI), 'board.mjs')` at :1065 instead, which is the
// UNKNOWN-directory case below, not this one. Cite the line, not the file.)
const INLINE_SELF_DIR = `dirname\\(\\s*fileURLToPath\\(\\s*import\\.meta\\.url\\s*\\)\\s*\\)`;

function selfDirAlternation(names) {
  return [...[...names].map(escapeForRegExp), 'import\\.meta\\.dirname', INLINE_SELF_DIR].join('|');
}

// The FOUR shapes a self-dir sibling reference takes, built from one alternation so the extraction
// half and the classification half can never disagree about what a self-dir call looks like (the
// duplication that derailed plan 2560, in miniature). `sibling*` are RESOLVABLE — extractScriptRefs
// turns them into edges, capture group 1 is the basename. `dynamic*` are the same construct sites
// with a computed segment, which only the widen guard consumes.
//   siblingJoin   join(HERE, 'board.mjs')          dynamicJoin      join(HERE, name)
//   siblingTpl    `${import.meta.dirname}/x.mjs`   dynamicSelfDir   `${HERE}/${name}`
// `join(HERE, '..', 'x')` can never match siblingJoin — a matched segment must itself end in
// `.mjs`, which is exactly the REAL_TREE_JOIN_IDIOMS shapes' complement — nor dynamicJoin, whose
// lookahead requires a NON-quote segment.
//
// `names` is the name set the two RESOLVABLE patterns are built from, and the reason it is a
// parameter rather than derived here: the extractor passes `plainSelfDirNames` (a transformed
// binding must not resolve as the bare module dir), the classifier passes the whole
// `selfDirNames` (a transformed binding is still a self-dir spelling whose computed segments must
// keep triggering the pass-cache widen). Defaulting to the whole set keeps every existing caller —
// and `unresolvedScriptRefReason` below — on the classifier's reading.
//
// Since plan 4085 the sibling captures accept a multi-SEGMENT tail (`join(HERE, 'sub/worker.mjs')`,
// `join(HERE, '../x.mjs')`), which resolveRefKey already resolves against `fromDir`. The capture
// used to be a bare basename, so a self-dir join carrying any directory tail was no edge at all
// (row f64aea — latent, no instance in the tree when this landed). `join(HERE, '..', 'x')` still
// cannot match: its `'..'` is a separate argument, not a segment of the matched literal.
// A fully LITERAL argument run that ends the call: quoted segments only, the last ending in `.mjs`.
// Every argument-run rule in this module is built from this one string, and the closing `)` is
// what makes it a whole path rather than a prefix — `join(dir, 'coord', name)` and
// `join(HERE, 'a.mjs', name)` both used to match their literal head and resolve to a path the
// source never names (/gpt-review round 2, findings 3e4822 / db2dc0 / 095aa4). The optional
// trailing comma is the dangling one prettier emits when it wraps a long call.
const ARG_RUN = `(?:['"][^'"\\n]*['"]\\s*,\\s*)*['"][^'"\\n]*\\.mjs['"]`;
// What may sit between the final literal and the closing paren: whitespace, prettier's dangling
// comma, and a trailing line comment. Round 2 allowed only the first two, which silently dropped
// the edge from a wrapped call whose last argument carries a comment (/gpt-review round 3,
// findings 331abb / 853946) — an under-selection introduced by a fix.
//
// Each comment is ANCHORED to its end-of-line. Round 3 wrote the comment as one alternative of the
// repeated group — `(?:\s|,|//[^\n]*)*\)` — where `[^\n]*` is free to backtrack INSIDE the comment
// and let a `)` written in the comment TEXT close the call. `join(HERE, 'coord.mjs', // see f(x)`
// then matched its literal head even though a computed argument follows, inventing an edge to a
// path the source never names — the exact prefix-vs-whole-path confusion the closing paren exists
// to prevent (/gpt-review round 4, 1caa64). Requiring a TERMINATOR after the comment body removes
// the backtrack — the body class cannot cross one, so it can only ever end at end-of-line — and
// the trailing `(?:\s|,)*` keeps round 3's case plus a dangling comma written after the comment.
//
// The terminator is every ECMAScript LineTerminator, not LF alone: a `//` comment also ends at CR,
// U+2028 and U+2029, and anchoring to LF would drop the edge from a CR-terminated source — an
// UNDER-selection, the one direction this module may never take (/gpt-review round 5, 438e09 /
// 28b2d2). CRLF needs no special case either way: its CR is part of the comment body.
const LINE_TERMINATORS = `\\n\\r\\u2028\\u2029`;
// The BLOCK form, which round 5 left out: `join(HERE, 'worker.mjs' /* why */)` matched nothing,
// and `unresolvedScriptRefReason` returned null for it too, so the dropped edge was invisible to
// BOTH consumers — an unselected dependent test AND a stale pass-cache component, the false green
// this module may never produce (/gpt-review round 6, 75d0d0 / b5a839 / 683272 / a0ccfb).
//
// The body is `(?:[^*]|\*(?!/))*`, not `[\s\S]*?`: it can only ever END at its own `*/`, which is
// the same no-backtrack property the line comment gets from its terminator anchor. A lazy body
// would be free to give back characters and let a `)` written in the comment TEXT close the call —
// exactly the round-4 1caa64 defect, re-introduced through the other comment kind.
const BLOCK_COMMENT = `/\\*(?:[^*]|\\*(?!/))*\\*/`;
const LINE_COMMENT = `//[^${LINE_TERMINATORS}]*[${LINE_TERMINATORS}]`;
// Either comment kind, any number of them, in any order — a wrapped call can carry both.
const ARG_RUN_END = `(?:\\s|,)*(?:(?:${LINE_COMMENT}|${BLOCK_COMMENT})(?:\\s|,)*)*\\)`;

export function selfDirRefPatterns(source, names = selfDirNames(source)) {
  const e = selfDirAlternation(names);
  const tail = `(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+\\.mjs`;
  // siblingJoin captures the whole ARGUMENT RUN, so the segment-wise
  // `join(HERE, 'hooks', 'guard.mjs')` and the packed `join(HERE, 'hooks/guard.mjs')` are read
  // identically (pathSegments normalizes both). Callers run the capture through
  // selfDirJoinTail before resolving.
  return {
    siblingJoin: new RegExp(
      `\\b(?:join|resolve)\\(\\s*(?:${e})\\s*,\\s*(${ARG_RUN})${ARG_RUN_END}`,
      'g',
    ),
    siblingTpl: new RegExp(`\\$\\{\\s*(?:${e})\\s*\\}/(${tail})`, 'g'),
    // A computed segment ANYWHERE in the run, not only as the first one: the literal-prefix group
    // lets `join(HERE, 'coord', name)` match, which the old first-segment-only form classified as
    // resolvable while the extractor produced no edge for it — the two-views drift T3 exists to
    // prevent (/gpt-review round 2, finding 1e8d71). A fully literal run cannot match: every
    // literal is consumed by the prefix group and the lookahead then sees a quote.
    dynamicJoin: new RegExp(
      `\\b(?:join|resolve)\\(\\s*(?:${e})\\s*,\\s*(?:['"][^'"\\n]*['"]\\s*,\\s*)*(?!['"]|\\s|\\))`,
    ),
    dynamicSelfDir: new RegExp(`\\$\\{\\s*(?:${e})\\s*\\}`),
  };
}

// --- un-resolvable directories: the basename fallback (plan 4085) ----------------------------
//
// Directories this graph never keys, at ANY depth. `__golden__` holds committed expected-output
// fixtures that listTestFiles() already skips (so a `.mjs` there can have no name-pair, and keying
// it would invent a node nothing runs); `node_modules` is vendored. Every key the shapes below
// produce is routed through isGraphKey, so no new edge vocabulary can make either scopeable — this
// plan's half of its own acceptance (rows 4d539c and, defensively, the vendored case).
const GRAPH_EXCLUDED_DIRS = new Set(['node_modules', '__golden__']);
export const isGraphKey = (key) =>
  typeof key === 'string' &&
  key.length > 0 &&
  !key.split('/').some((seg) => GRAPH_EXCLUDED_DIRS.has(seg));

// basename -> every scripts/-relative key carrying it. Built by one walk of the real tree, and the
// substrate for the fallback below. Separate from listTestFiles because this indexes MODULES as
// well as tests, and from makeReadSource because it is a reverse lookup rather than a read.
export function buildBasenameIndex(scriptsDir) {
  const index = new Map();
  // A read error PROPAGATES, deliberately — the same posture listTestFiles has always had, and
  // the opposite of makeReadSource's (an unreadable MODULE is a leaf; an unreadable DIRECTORY is a
  // silently narrower index, and a narrower index under-selects). The CLI's top-level handler
  // turns the throw into EXIT_RUN_FULL: over-run, never skip (/gpt-review round 1, finding 8deec5).
  // No visited-set is needed against directory cycles: `withFileTypes` reports a symlink as
  // isSymbolicLink, never isDirectory, so this walk does not follow one.
  const walk = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (GRAPH_EXCLUDED_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.mjs')) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!index.has(entry.name)) index.set(entry.name, []);
        index.get(entry.name).push(key);
      }
    }
  };
  walk(scriptsDir, '');
  return index;
}

// The index MUST describe the same tree the caller's readSource reads, so it is keyed by that
// tree and defaults to exactly makeReadSource's own default (`scripts`, CWD-relative) rather than
// to this module's checkout. Anchoring it on REPO_ROOT instead — the first cut — let the index and
// the read seam disagree whenever the two differ, and resolving a basename against the wrong tree
// either omits a real dependency or invents an unrelated one. For the pass-cache that is a
// NARROWER key, i.e. a false green, the one failure mode it may never produce (/gpt-review round 1,
// finding 4ce00f). extractScriptRefs therefore does NOT fall back to a default at all: with no
// index the shape is simply not an edge, which is the pre-plan-4085 behaviour and never a guess.
// Lazy so importing this module still costs no fs walk, memoized per tree so one selection run
// walks once.
const basenameIndexCache = new Map();
export function basenameIndexFor(scriptsDir = SCRIPTS_DIR) {
  // Keyed by the RESOLVED directory, not the raw string: `scripts` names a different tree from a
  // different cwd, and two spellings of one tree must share an index rather than walk it twice
  // (/gpt-review round 2, finding 000e5b).
  const key = resolve(scriptsDir);
  if (!basenameIndexCache.has(key)) basenameIndexCache.set(key, buildBasenameIndex(scriptsDir));
  return basenameIndexCache.get(key);
}

// The index PLUS keys that are not on disk — which for selectTests means the changed set, and
// closes the one hole an index-backed resolver has that the older literal rules do not. This
// module's stated contract is that "rule matching is on the changed NAME, not on the file
// existing", so a DELETED module must still select its dependents; but a deleted module is by
// definition absent from a walk of the tree, so the fallback alone would drop its edge and
// under-include — the one error direction this file may never make. Folding the changed keys in
// restores the contract exactly, at the cost of one Map copy per selection.
export function indexWithKeys(index, keys) {
  // Copy-on-write: a delta whose every key is already on disk (the overwhelmingly common case, a
  // pure modification) needs no clone at all (/gpt-review round 1, finding 796801).
  let merged = index;
  for (const key of keys) {
    if (!isGraphKey(key) || !key.endsWith('.mjs')) continue;
    const base = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
    const homes = merged.get(base);
    if (homes?.includes(key)) continue;
    if (merged === index) merged = new Map(index);
    merged.set(base, homes ? [...homes, key] : [key]);
  }
  return merged;
}

// A module path built from a directory this module CANNOT resolve, but whose basename is a plain
// literal: `join(spineDir, 'done-worktree.mjs')` where spineDir is a function PARAMETER
// (coord/land/parity.test.mjs, row ad3a41), or `` `${SCRIPTS_DIR}/battery-pass-cache.mjs` `` where
// SCRIPTS_DIR is a TRANSFORMED self-dir binding (row 2f9ccd). Capture 1 is the identifier, capture
// 2 the basename; a plain self-dir name is filtered out in JS because it already resolved above.
//
// WHY A BASENAME, AND WHY THIS IS NOT THE PLAN-2578 BLOB. The directory is unknown, so the sound
// over-approximation is "every home this basename has" — and in this tree the maximum is TWO (a
// plan-3962 path-compat shim plus its real coord/ module), which is also what makes a shim-mediated
// reach land on the REAL module instead of stopping at the shim. The blob rule still binds: an
// edge must trace to a real path CONSTRUCTION site, never to a sibling merely NAMED in prose, which
// is why this matches `join`/`resolve`/`${…}/` with a literal `.mjs` and nothing looser. A basename
// with no home under scripts/ yields no edge at all, so a fixture directory holding no modules
// contributes nothing.
//
// MEASURED (plan 4085 E2/E3, on the 311-test tree): hub widths move +1 (`coord/coord-git.mjs`
// 208->209) to +5 (`coord/landing-lock.mjs` 135->140). The one large move is the LEAF
// `next-plan-id.mjs`, 6->22, and all 16 added tests trace to a single real construction site —
// `drain-run.mjs`'s `join(scriptsDir, 'next-plan-id.mjs')`, a genuine spawn of that CLI. So the
// pre-shape 6 was an UNDER-selection this shape repairs, not width this shape invents.
//
// Considered and REJECTED as the backstop for these rows: the "always run what the graph cannot
// place" union (this plan's own § The fork). Its membership rule is transitive through the
// PERMISSIVE closure, so teaching the classifier the row-2 shape — which flags exactly ONE module,
// coord/land/gates-runner.mjs — took the always-run set from 54 to 229 of 311 (17.4% -> 73.6%), and
// the row-3 shape to 240 (77.2%). A directed edge is the cheap direction here and an UNRESOLVABLE
// classification the expensive one, which inverts the usual demotion ladder: see plan 4085 § E1.
// Capture 2 is the whole ARGUMENT RUN, so a segment-wise `join(spineDir, 'coord', 'x.mjs')` is
// read identically to the packed `join(spineDir, 'coord/x.mjs')` — the plan-3969 lesson, which the
// first cut applied to the repo-root rule only (/gpt-review round 1, findings 0719d8 / abe465).
const UNKNOWN_DIR_JOIN_RX = new RegExp(
  `\\b(?:join|resolve)\\(\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*(${ARG_RUN})${ARG_RUN_END}`,
  'g',
);
// The same unknown directory spelled INLINE rather than bound to a name:
// `join(dirname(fileURLToPath(import.meta.url)), 'board.mjs')` (landing-queue-watch.mjs, a genuine
// spawn of the board CLI) and `join(dirname(SCRIPT), 'record-marker-cli.mjs')`
// (record-review.test.mjs). Neither is a self-dir spelling the alternation knows, so the identifier
// form above produced no edge and `dynamicJoin` did not widen either — no edge AND no widen, the
// shape invisible to both consumers (/gpt-review round 6, a84d04; four uncovered construction sites
// measured on this tree, each reaching a tracked module that is not the reader's name-pair).
//
// An unknown directory is unknown however it is written, and the basename stays fully static, so
// this takes exactly the E2 fallback — it is that decision's own shape, not a new one. There is no
// identifier to exclude, so the plainNames / REPO_ROOT_BINDINGS checks simply do not apply (the
// caller passes null); a literal first argument cannot reach here because the pattern requires a
// `dirname(`/`resolve(` call, and REAL_TREE_JOIN_IDIOMS already resolves the repo-root forms.
//
// The inner argument allows ONE level of nesting, which covers `fileURLToPath(import.meta.url)`.
// Its alternation branches are disjoint on their first character (`[^()]` vs `\(`), so the nested
// quantifier cannot backtrack exponentially — the property that makes this safe to run over every
// source in the tree.
// The lookahead excludes the canonical INLINE_SELF_DIR spelling, which `siblingJoin` now resolves
// EXACTLY against fromDir. Without it both rules fire on the same construction and the fallback
// adds every other home of that basename on top of the precise edge — harmless in direction
// (over-selection) but a redundancy with no exclusion analogous to the `plainNames.has(ident)` one
// that already keeps resolved same-directory siblings out of this rule (/gpt-review round 8,
// da9516 / 5283da / 1a71fe / 3f1134). This is that missing analogue: a directory this module CAN
// resolve never reaches the unknown-directory fallback, whether it is spelled as a name or inline.
const CALL_DIR_ARG = `(?:[^()]|\\([^()]*\\))*`;
const UNKNOWN_DIR_CALL_JOIN_RX = new RegExp(
  `\\b(?:join|resolve)\\(\\s*(?!${INLINE_SELF_DIR}\\s*,)(?:dirname|resolve)\\(${CALL_DIR_ARG}\\)\\s*,\\s*(${ARG_RUN})${ARG_RUN_END}`,
  'g',
);
// T3's counterpart to the edge above is NOT a second unknown-directory pattern. Round 7 (d28e93)
// asked for one and a literal reading of it over-fires badly: `(?:dirname|resolve)\(…\)` matches
// EVERY dirname-based path construction in the tree, module or not, so
// `join(dirname(lockPath), COORD_OP_JOURNAL_BASENAME)` in coord-git.mjs — a JSON journal path with
// no module in it — classified as an unresolvable MODULE reference and made that hub's key
// un-narrowable, failing the plan-2578 "narrows on real sources" pin. Classification is the
// EXPENSIVE direction here (this plan's own E1), so a widen trigger must be at least as specific
// as the edge it mirrors, and the edge's specificity comes from ARG_RUN requiring a literal `.mjs`
// — which a computed segment can never supply.
//
// The shape that DOES need both halves is the one whose directory is the module's own: the
// canonical inline `dirname(fileURLToPath(import.meta.url))`, used unbound. Teaching the SELF-DIR
// alternation that spelling (see selfDirAlternation) gives both halves at once and better than a
// fallback could — `siblingJoin` resolves it exactly against `fromDir` instead of over-
// approximating by basename, and `dynamicJoin` then widens for its computed-segment twin with no
// new pattern at all. That also answers round 7's b8c799 / 31261b, which objected to the inline
// self-dir spelling being treated as an UNKNOWN directory when it is precisely knowable.
//
// What stays residue, deliberately and as the header already records for its identifier twin: an
// unknown directory with a COMPUTED segment (`join(dirname(SCRIPT), name)`) — neither an edge nor
// a widen trigger, on master before plan 4085 and still. Nothing static can place it, and widening
// for it is what the coord-git.mjs regression above measures the cost of.
// A join against one of these is ALREADY resolved, exactly, by REAL_TREE_SCRIPTS_JOIN_RX below —
// it is the repo root, not an unknown directory. Excluding them from the basename fallback is the
// more correct reading as well as the quieter one: `join(REPO_ROOT, 'backend', 'x.mjs')` names a
// file outside scripts/ entirely, and resolving its basename against the scripts tree would invent
// an edge to an unrelated same-named module.
// Both derived from REPO_ROOT_BINDING_NAMES — the one spelling of this vocabulary, shared with
// REAL_TREE_JOIN_IDIOMS so a name added for either consumer widens both in the same edit
// (/gpt-review round 3 86dde8, round 4 2ecec3).
const REPO_ROOT_BINDINGS = new Set(REPO_ROOT_BINDING_NAMES);
const REPO_ROOT_ALT = REPO_ROOT_NAME_ALT;

const UNKNOWN_DIR_TPL_RX =
  /\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs)/g;

// The final path segment of an argument run — the basename the fallback looks up. Shares
// pathSegments with parseScriptsRootSegments so the two rules can never disagree about how a run
// is spelled (/gpt-review round 1, finding 39934b).
const runBasename = (argRun) => {
  const segments = pathSegments(argRun);
  return segments.length ? segments[segments.length - 1] : null;
};

// A path the source WRITES is a fixture it CREATES, never a dependency on a real module of that
// name — `writeFileSync(join(tmp, 'board.mjs'), 'B')` (coord-share-lib.test.mjs:87) builds a fake
// tree to exercise a sync checker and has nothing to do with the real board CLI. Without this,
// the basename fallback welded ten test files onto whatever hub happened to share their fixture's
// name (`coord-git.mjs`, `landing-queue.mjs`, `board.mjs`), which is the plan-2578 blob in
// miniature: 48 such sites in this tree, every one of them obviously synthetic (`a.mjs`, `b.mjs`,
// `stay.mjs`, `secret.mjs`).
//
// Narrowing is normally the dangerous direction here, so note what this does NOT touch: it blanks
// the WRITE call sites out of the text handed to the two fallback patterns ONLY. Every older rule
// — module specifiers, the `scripts/<name>.mjs` literal, the self-dir sibling shapes — scans the
// unmodified source, and the classifier is untouched. A spawn gate would have been the obvious
// alternative and is wrong for the same reason plan 2578 dropped it for self-dir refs: a CLI path
// is routinely declared on its own line and spawned later.
// Only calls whose path argument is PURELY a destination belong here. `cpSync`, `copyFileSync`,
// `renameSync` and `symlinkSync` were in this list in the first cut and are deliberately NOT:
// their first argument is the SOURCE being read, so masking them dropped a real dependency
// (/gpt-review round 1, finding af46f8).
const FS_WRITE_JOIN_RX = new RegExp(
  `\\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync|mkdir|rmSync|unlinkSync)\\(\\s*(?:join|resolve)\\(\\s*[A-Za-z_$][A-Za-z0-9_$]*\\s*,\\s*${ARG_RUN}${ARG_RUN_END}`,
  'g',
);

// A REAL-TREE read of a scripts/ module, spelled off a repo-root binding — segment-wise
// `join(REPO_ROOT, 'scripts', 'hooks', 'chain-wiki-loader.mjs')` (wiki-chain-registry.test.mjs:44,
// row 3a0ae6) or slash-joined `join(REPO, 'scripts/hooks/x.mjs')`. Several tests reach a module
// ONLY this way: they read it as SOURCE TEXT and assert on it, so there is no import, no spawn
// literal and no name-pair. REAL_TREE_JOIN_IDIOMS could not serve — it captures the FIRST argument
// only, which for the segment-wise spelling is the bare string `scripts`, and its job is the
// EXTERNAL_TREE_PREFIXES coverage guard rather than edge extraction. Capture 1 is the whole
// argument run; parseScriptsRootSegments below turns it into a key.
const REAL_TREE_SCRIPTS_JOIN_RX = new RegExp(
  `\\b(?:join|resolve)\\(\\s*(?:${REPO_ROOT_ALT})\\s*,\\s*(${ARG_RUN})${ARG_RUN_END}`,
  'g',
);

// The scripts/-relative key for such an argument run, or null when it does not name one. Segments
// are re-joined and re-split so the segment-wise and slash-joined spellings are judged identically
// (the plan-3969 lesson from realTreeFirstSegment, applied to extraction rather than coverage): a
// run must start at `scripts` and carry no `..`, since a traversal leaves the tree this graph
// models.
// The quoted segments of an argument run, flattened: `'scripts', 'hooks/x.mjs'` and
// `'scripts', 'hooks', 'x.mjs'` both yield ['scripts','hooks','x.mjs']. The ONE spelling-normalizer
// every argument-run rule below shares.
export function pathSegments(argRun) {
  return [...String(argRun).matchAll(/['"]([^'"\n]*)['"]/g)]
    .flatMap((m) => m[1].split('/'))
    .filter((s) => s !== '' && s !== '.');
}

export function parseScriptsRootSegments(argRun) {
  const segments = pathSegments(argRun);
  if (segments.includes('..')) return null;
  if (segments[0] !== SCRIPTS_DIR || segments.length < 2) return null;
  return segments.slice(1).join('/');
}

// Every `scripts/*.mjs` basename this source references, as a Set.
//
// Three edge kinds, and the asymmetry between them is load-bearing:
//
//   1. Module specifiers — `import`/`export … from`/dynamic `import()`, plus the
//      `new URL('./x.mjs', import.meta.url)` idiom this suite uses to read a sibling's SOURCE and
//      assert on it (done-worktree-land.test.mjs is the only test pinning several move-plan.mjs
//      invariants, and reaches move-plan.mjs ONLY that way — never via a real import).
//
//   2. Spawned-CLI edges on the ENTRY test file (`entryLiterals`) — any code line naming a
//      `scripts/<name>.mjs`, or joining a sibling basename onto the module's own directory
//      (`const CLI = join(HERE, 'board.mjs')` — see siblingJoinRx). Tests hold CLI paths in
//      constants far from the spawn call, so we cannot require a spawn call on the same line here.
//
//   3. Spawned-CLI edges anywhere else (`spawnLiterals`) — the same two spellings on a line that
//      also CALLS a child process (`run('node', ['scripts/build-index.mjs'])`, done-worktree.mjs).
//      Requiring the spawn call is what keeps this from re-welding the graph: library modules name
//      sibling scripts constantly inside error-message STRINGS — coord-git.mjs's detached-MAIN error
//      says "run `node scripts/heal-main.mjs`". Counting those as edges made coord-git → heal-main →
//      pre-yield-guard → … → landing-lock one strongly connected blob, and a leaf-module delta
//      selected 64 of 99 files — no better than the full battery.
//
// All three over-approximate on purpose: a regex can match a token inside a string that is not a
// real dependency, which only ever ADDS test files. Over-inclusion costs seconds; under-inclusion
// ships a regression. That direction is right for SELECTION and wrong for the pass-cache KEY —
// see unresolvedScriptRefReason below for the classification the other consumer applies.
// plan 3959 review (8bd25c): resolve a relative specifier against the importing module's OWN
// scripts/-relative directory, yielding the same forward-slash key shape listTestFiles() returns
// (`coord/x.test.mjs` nested, `board.test.mjs` flat). Returns null when the specifier walks out of
// scripts/ entirely — that is not an edge this graph models.
//
// Before this, addSpecifier understood ONLY `./sibling.mjs` and dropped everything else, which was
// correct while scripts/ was flat and silently wrong the moment this plan created nested modules:
// a nested test's `../done-worktree-lib.mjs` edge vanished, so changing the lib skipped the very
// coord tests that cover it. Over-inclusion costs seconds, under-inclusion ships a regression.
export function resolveRefKey(fromDir, spec) {
  const segs = fromDir ? fromDir.split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length === 0) return null; // escapes scripts/ — not our graph
      segs.pop();
      continue;
    }
    segs.push(part);
  }
  return segs.length ? segs.join('/') : null;
}

export function extractScriptRefs(
  source,
  { entryLiterals = false, fromDir = '', basenameIndex } = {},
) {
  const refs = new Set();
  // The ONE place a key enters this set, so isGraphKey cannot be forgotten by a future shape.
  const addKey = (key) => {
    if (isGraphKey(key)) refs.add(key);
  };

  const addSpecifier = (spec) => {
    // Relative specifiers only — a bare/package specifier is not a scripts/ edge. `./x.mjs` from a
    // flat module still resolves to `x.mjs`, exactly as before; `../x.mjs` and `./sub/x.mjs` now
    // resolve instead of being dropped.
    if (!spec.startsWith('./') && !spec.startsWith('../')) return;
    if (!spec.endsWith('.mjs')) return;
    addKey(resolveRefKey(fromDir, spec));
  };

  // `import … from 'x'` and `export … from 'x'` (the `from` keyword is the discriminator).
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) addSpecifier(m[1]);
  // Side-effect `import 'x'`.
  for (const m of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) addSpecifier(m[1]);
  // Dynamic `import('x')`.
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) addSpecifier(m[1]);
  // `new URL('./x.mjs', import.meta.url)` — a source-text read is a dependency the import graph
  // cannot see, and several tests assert cross-script invariants exclusively this way.
  for (const m of source.matchAll(/\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]/g)) addSpecifier(m[1]);

  const lines = source.split('\n').filter((l) => !isCommentLine(l));
  for (const line of lines) {
    if (!entryLiterals && !SPAWN_CALL_RX.test(line)) continue;
    // plan 3959 review round 2 (6e09d3): match a NESTED spawn literal too
    // (`scripts/coord/outer.mjs`), whose key is the whole `coord/outer.mjs` remainder. This path is
    // repo-root-relative, so unlike addSpecifier it never resolves against fromDir. Flat literals
    // are the same single-segment case and are unchanged.
    for (const m of line.matchAll(/scripts\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs)/g))
      addKey(m[1]);
  }

  // Self-dir sibling references are matched over the WHOLE source and at EVERY depth — neither
  // spawn-gated nor line-bounded, unlike the bare `scripts/<name>.mjs` literal above. The spawn
  // gate exists because library modules name siblings inside PROSE error strings; prose never
  // spells `join(HERE, 'x.mjs')` or `` `${import.meta.dirname}/x.mjs` ``, which are path
  // CONSTRUCTIONS. Both restrictions therefore buy nothing here and cost real edges
  // (/sonnet-review high, plan 2578): done-worktree.mjs declares
  // `` const GATE_CACHE_CLI = `${import.meta.dirname}/gate-pass-cache.mjs` `` on its own line and
  // spawns it three lines later, so the same-line gate dropped that edge — a gate-pass-cache.mjs
  // change ran neither done-worktree.test.mjs nor done-worktree-land.test.mjs. Whole-source
  // matching also catches the multi-line `join(\n  HERE,\n  'x.mjs',\n)` prettier produces.
  // Same plan-3959 resolution as addSpecifier: these two spellings name a SELF-DIR sibling, so from
  // a nested module they mean `coord/x.mjs`, not a flat `x.mjs` that exists nowhere. (The bare
  // `scripts/<name>.mjs` literal above is repo-root-relative, always flat, and stays as matched.)
  const code = lines.join('\n');
  // plan 4085: the RESOLVER sees only untransformed bindings. A transformed one names a directory
  // we cannot compute, so resolving it against `fromDir` invented a phantom key; it falls through
  // to the basename fallback below instead. selfDirNames stays whole for the classifier (see
  // plainSelfDirNames).
  const plainNames = plainSelfDirNames(code);
  const { siblingJoin, siblingTpl } = selfDirRefPatterns(code, plainNames);
  const addSelfDir = (name) => addKey(resolveRefKey(fromDir, `./${name}`));
  // siblingJoin's capture is an argument RUN (`'hooks', 'guard.mjs'`); siblingTpl's is already a
  // single path literal. pathSegments normalizes the run, `..` included, which resolveRefKey then
  // resolves against fromDir exactly as it does a relative specifier.
  for (const m of code.matchAll(siblingJoin)) addSelfDir(pathSegments(m[1]).join('/'));
  for (const m of code.matchAll(siblingTpl)) addSelfDir(m[1]);

  // plan 4085 row 3a0ae6: a real-tree source READ of a scripts/ module off a repo-root binding.
  // Repo-root-relative like the bare `scripts/<name>.mjs` literal above, so it never resolves
  // against fromDir.
  for (const m of code.matchAll(REAL_TREE_SCRIPTS_JOIN_RX)) addKey(parseScriptsRootSegments(m[1]));

  // plan 4085 rows 2f9ccd / ad3a41: a module path built from a directory we cannot resolve. The
  // basename is literal, so every home it has in the real tree becomes an edge.
  // No index means the caller named no tree, so there is nothing to resolve a basename against and
  // this shape contributes no edge — never the ambient checkout as a guess (finding 4ce00f).
  if (basenameIndex) {
    const addByBasename = (ident, base) => {
      if (!base) return;
      if (plainNames.has(ident)) return; // already resolved as a same-directory sibling above
      if (REPO_ROOT_BINDINGS.has(ident)) return; // already resolved exactly by the repo-root rule
      for (const key of basenameIndex.get(base) ?? []) addKey(key);
    };
    const constructed = code.replace(FS_WRITE_JOIN_RX, '');
    for (const m of constructed.matchAll(UNKNOWN_DIR_JOIN_RX))
      addByBasename(m[1], runBasename(m[2]));
    // Same shape, inline directory expression — no identifier to exclude (round 6, a84d04).
    for (const m of constructed.matchAll(UNKNOWN_DIR_CALL_JOIN_RX))
      addByBasename(null, runBasename(m[1]));
    for (const m of constructed.matchAll(UNKNOWN_DIR_TPL_RX))
      addByBasename(m[1], m[2].slice(m[2].lastIndexOf('/') + 1));
  }

  return refs;
}

// --- unresolved-reference classification (plan 2578) -------------------------
//
// The SECOND half of the canonical edge machinery, and the reason it lives here rather than in a
// second text scan owned by the pass-cache: extractScriptRefs above and this function are two
// views of ONE fact — which sibling-script references this source spells in a shape the static
// walk can follow. Keeping them in the same module is what makes "the guard widened, so the
// extractor must have missed an edge" a checkable statement instead of two drifting regex lists
// (the plan-2560 derailment: its guard omitted the `run(` wrapper SPAWN_CALL_RX has carried since
// plan 1673, and matched `FLAT_TEST_PATH_RX.exec(path)` — plain `RegExp.prototype.exec` — as a
// child-process call, so every selection whose closure reached a file containing `.exec(` fell
// back to whole-tree keying and the feature no-op'd where it was measured).
//
// THE TWO CONSUMERS WANT OPPOSITE SAFE DIRECTIONS, so this reports a CLASSIFICATION and never a
// verdict. Selection (extractScriptRefs, above) may over-include freely — a spurious edge costs
// seconds. The battery pass-cache KEY may not under-include at all — a missed edge means the key
// omits a file the battery genuinely reads, so editing that file re-computes the same key and
// serves a HIT for changed content: a FALSE GREEN, the one failure mode that cache may never
// produce. This function is that consumer's widen trigger.
//
// WHAT COUNTS AS UNRESOLVABLE is derived from extractScriptRefs, not guessed at: every spelling it
// CAN follow (`'./x.mjs'`, `'scripts/x.mjs'`, `new URL('./x.mjs', …)`, `join(HERE, 'x.mjs')`) ends
// in a plain quoted literal. So the unresolvable shapes are exactly the same construct sites with
// a NON-literal argument, plus a sibling path assembled at runtime. Note what is NOT here: the
// SPAWN CALL itself. A spawn's command argument is `'node'` or `process.execPath` (34 files) —
// its literality says nothing about which SCRIPT it runs, and gating on it is what made plan
// 2560's guard fire on every file in the tree. What matters is whether the script PATH is
// statically spelled, wherever it is built.
//
// EVERY rule below is tuned against the real 354-file tree, and the tuning axis is always the same:
// this codebase's error strings, usage banners and module headers are dense PROSE about sibling
// scripts ("Run: node scripts/generate-bcv-bundle-services.mjs", "…, scripts/**), run /sonnet-review
// …"). A rule that fires on prose fires on ~a fifth of the tree and no-ops the narrowing — the exact
// shape of plan 2560's finding 1. So each rule matches the CONSTRUCTION of a path whose BASENAME is
// computed, never the mere co-occurrence of `scripts/` or `.mjs` with a dynamic token.
//
// `import(x)` / `require(x)` — first argument not a `'`/`"` literal (a BACKTICK argument counts as
// unresolvable: extractScriptRefs' dynamic-import regex resolves only the two plain quote forms,
// so `` import(`./${x}.mjs`) `` is exactly the edge it cannot see). No whitespace is tolerated
// before the paren — prettier runs over every scripts/ file on commit, so a real call is always
// `import(`, while `… a broken import (standing backlog)` in an error string is prose. An empty
// `import()` is prose too (the module headers here write it that way), so `)` is excluded.
const DYNAMIC_SPECIFIER_RX = /\b(?:import|require)\(\s*(?!['"]|\)|\s)/;
// `new URL(<computed>, import.meta.url)` — the module-relative source-read idiom extractScriptRefs
// resolves only in its literal spelling. Two discriminators earn their keep: the
// `, import.meta.url` tail (without it this fires on every ordinary URL parse — `new URL(req.url,
// …)`, gsc-auth.mjs), and excluding a leading `.` (no real first-argument EXPRESSION starts with a
// dot, but a prose spelling of the idiom inside a test title does — `'… a `new URL(./x.mjs,
// import.meta.url)` source read …'`).
const DYNAMIC_URL_RX = /\bnew\s+URL\(\s*(?!['"]|\s|\.)[^;\n]*?,\s*import\.meta\.url/;
// A quoted path fragment ENDING at a separator and concatenated onward — `'./' + f`
// (assert-coord-in-sync.mjs's real sibling-import loop), `'scripts/' + name`, `dir + '.mjs'`. The
// literal must be a bare separator prefix or end at `scripts/`: prose paths end at a directory
// name too (`'…/plans/in-progress/' + slug`, drain-run.mjs) and those are not module paths.
const CONCAT_PATH_RX = /['"](?:\.{0,2}\/|[^'"\n]*scripts\/)['"]\s*\+|\+\s*['"]\.mjs['"]/;
// An interpolation INSIDE a .mjs path — `` `scripts/${name}.mjs` ``, `` `${dir}/${n}.mjs` ``.
// Prose that interpolates NEAR a path (`Run: node scripts/x.mjs ${flag}`) does not match: the
// `${…}` must be part of the path itself. `/` is in the trailing class so a separator between the
// interpolation and the basename does not hide the shape (/sonnet-review high, plan 2578).
const TEMPLATE_PATH_RX = /\$\{[^{}]*\}[A-Za-z0-9._\-/]*\.mjs/;

// Drop whole-line comments (this codebase's headers are dense cross-reference PROSE — they name
// sibling scripts, quote `import()` in backticks, and would trip every rule below). Trailing
// comments on code lines are kept: stripping them needs a tokenizer, and keeping them can only
// over-widen.
const codeLines = (source) =>
  String(source)
    .split('\n')
    .filter((l) => !isCommentLine(l));

// Returns a short reason string when this source builds a sibling-script reference
// `extractScriptRefs` cannot resolve, or `null` when every reference it spells is statically
// followable. Never throws — a caller reading `null` narrows, so any internal doubt must surface
// as a reason, not an exception.
//
// This is a TEXT scan, so a source that merely SPELLS a dynamic shape inside a fixture string
// classifies as unresolvable. That is the safe direction (a wider key, never a narrower one) and
// it is deliberately not worked around: `select-battery-tests.test.mjs` must spell every shape to
// test them, and duly classifies non-null. Files on the pass-cache's own hot path assemble their
// fixtures at the construct site instead so they stay classifiable — pinned by the
// "the pass-cache selection classifies as resolvable" case in that test file.
// The method is subtraction, not enumeration: BLANK OUT every spelling `extractScriptRefs` above
// resolved, then ask whether anything path-shaped is left. That inversion is what keeps the two
// halves honest — a shape the extractor learns to follow stops being a widen trigger in the same
// edit, and a shape it cannot follow survives into the residue by construction rather than by
// someone remembering to add a rule (the plan-2560 failure was exactly that memory step).
export function unresolvedScriptRefReason(source) {
  const lines = codeLines(source);
  const { siblingJoin, siblingTpl, dynamicJoin, dynamicSelfDir } = selfDirRefPatterns(
    lines.join('\n'),
  );
  // The three RESOLVED spellings, blanked out: a self-dir join, a self-dir template, and a plain
  // `scripts/<name>.mjs` literal. The last one matters even inside a template — done-worktree.mjs
  // writes `` `${MAIN}/scripts/build-index.mjs` ``, where the interpolation is the repo root and
  // the basename is fully literal, so extractScriptRefs already has that edge.
  const strip = (s) =>
    s
      .replace(siblingJoin, '')
      .replace(siblingTpl, '')
      .replace(/scripts\/[A-Za-z0-9._-]+\.mjs/g, '');
  const residual = strip(lines.join('\n'));
  for (const raw of lines) {
    const line = strip(raw);
    if (DYNAMIC_SPECIFIER_RX.test(line)) return 'dynamic-import';
    if (DYNAMIC_URL_RX.test(line)) return 'dynamic-url';
    if (CONCAT_PATH_RX.test(line)) return 'concat-path';
  }
  // A self-dir join whose SEGMENT is not a quoted literal — `join(HERE, name)`,
  // `` resolve(HERE, `${n}.mjs`) ``. `join(HERE, '..', …)` is a LITERAL segment and never matches:
  // that is the repo-root idiom (REAL_TREE_JOIN_IDIOMS), not a computed sibling. Tested against
  // the WHOLE residue, not per line — prettier wraps a long call across lines, and a per-line test
  // read `join(\n  HERE,\n  name\n)` as resolvable while the extractor produced no edge for it
  // (/sonnet-review high, plan 2578: a false green in the very function written to close them).
  if (dynamicJoin.test(residual)) return 'dynamic-join-segment';
  // A self-dir interpolation that SURVIVED the strip is one the extractor could not follow to a
  // literal basename — `` `${HERE}/${name}` ``, `` `${import.meta.dirname}/${n}.mjs` ``, or a bare
  // `` `${HERE}` `` handed onward. Whole-source, because a template may span lines.
  if (dynamicSelfDir.test(residual)) return 'dynamic-self-dir';
  if (TEMPLATE_PATH_RX.test(residual)) return 'template-path';
  return null;
}

// Every `scripts/*.mjs` basename reachable from `entry` (inclusive), BFS over extractScriptRefs.
// `readSource` returns the file's text, or null when it does not exist / cannot be read (a deleted
// or generated module is simply a leaf). The entry file gets the permissive `entryLiterals` scan;
// every deeper node requires a spawn call on the line — see extractScriptRefs.
//
// `refsCache` memoizes the non-entry (spawn-gated) ref set per basename. Without it, a hub like
// coord-git.mjs is re-read and re-regexed once per test file whose closure reaches it — ~99× per
// run. The entry scan is deliberately NOT cached: it uses different options, and each entry is
// visited exactly once anyway.
//
// `allLiterals` (plan 2578) gives EVERY node the permissive entry scan, dropping the spawn gate at
// depth. That is the wrong bias for SELECTION — it is the over-admission whose blob the header
// above records — and the only sound one for the battery pass-cache KEY, where a dropped edge is a
// false green rather than a slow run: a library that holds a CLI path in a constant
// (`const CLI = join(HERE, 'build-index.mjs')`, done-worktree.mjs) has no spawn call on that line,
// so the gated scan drops a REAL dependency. Callers must pass their own `refsCache` per mode —
// the two scans produce different ref sets for the same basename, so sharing one cache across
// modes would serve a gated answer to a permissive walk.
export function referenceClosure(
  entry,
  readSource,
  refsCache = new Map(),
  { allLiterals = false, basenameIndex } = {},
) {
  const seen = new Set([entry]);
  const queue = [entry];
  let isEntry = true;
  while (queue.length) {
    const cur = queue.shift();
    const entryScan = isEntry || allLiterals;
    isEntry = false;

    let refs;
    // The permissive scan is cacheable in `allLiterals` mode (every node uses the same options
    // there); in the default mixed mode the ENTRY scan is not, since it differs from the gated
    // scan the cache holds — and each entry is visited exactly once anyway.
    const cacheable = !entryScan || allLiterals;
    if (cacheable && refsCache.has(cur)) {
      refs = refsCache.get(cur);
    } else {
      const src = readSource(cur);
      // plan 3959: a node's key carries its directory (`coord/x.test.mjs`), and that directory is
      // what its own relative specifiers resolve against. Flat nodes pass '' and behave exactly as
      // before. Cache stays sound: fromDir is derived from `cur`, which IS the cache key.
      const curDir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
      refs =
        src == null
          ? new Set()
          : extractScriptRefs(src, { entryLiterals: entryScan, fromDir: curDir, basenameIndex });
      if (cacheable) refsCache.set(cur, refs);
    }

    for (const ref of refs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      queue.push(ref);
    }
  }
  return seen;
}

// The core selection. `allTests` is every `scripts/*.test.mjs` basename in the tree.
// Returns a sorted array of `scripts/<name>` paths. Empty means "cannot scope" — the CLI turns
// that into EXIT_RUN_FULL rather than running nothing.
export function selectTests({ changed, allTests, readSource, basenameIndex }) {
  const testSet = new Set(allTests);
  const selected = new Set();
  // A DELETED module is absent from the real-tree index, so fold the changed keys in — see
  // indexWithKeys for why the "matching is on the NAME, not on the file existing" contract would
  // otherwise break for exactly the deletions it was written for. The default tree is
  // makeReadSource's own, so an unqualified selectTests keeps index and read seam in agreement; a
  // caller reading some OTHER tree passes that tree's index alongside its readSource.
  // NO default. An index that does not describe the tree `readSource` reads resolves basenames
  // against the wrong checkout, which for the pass-cache is a narrower key and so a false green;
  // pairing them is therefore the CALLER's job, structurally (/gpt-review round 2, finding
  // cluster c588f7/b14647/ab0a70/2b4440). Naming no tree means the fallback contributes nothing —
  // exactly the pre-plan-4085 behaviour. The CLI's main() names it.
  const index = basenameIndex ? indexWithKeys(basenameIndex, changed) : undefined;

  for (const basename of changed) {
    // (a) a changed test file runs itself.
    if (isTestFile(basename)) {
      if (testSet.has(basename)) selected.add(basename);
      continue;
    }
    // (b) name pairing — covers CLIs exercised by spawn rather than import.
    const paired = pairedTestFor(basename);
    if (testSet.has(paired)) selected.add(paired);
  }

  // (c) import/reference closure: any test transitively touching a changed module. One shared
  // cache across all entries — hub modules are parsed once, not once per test.
  const refsCache = new Map();
  for (const t of allTests) {
    if (selected.has(t)) continue;
    const closure = referenceClosure(t, readSource, refsCache, { basenameIndex: index });
    for (const basename of changed) {
      if (closure.has(basename)) {
        selected.add(t);
        break;
      }
    }
  }

  return toScriptPaths(selected);
}

// --- data-dependency map (plan 2070) -----------------------------------------
// The closure above models CODE imports only. Some battery tests' TRUE inputs are DATA the
// import graph cannot see at all — no scripts/*.mjs file imports wiki/entities/**, and a diff
// touching only that data never even reaches this selector (the hook only invokes it on a
// scripts/*.mjs diff). That gap sat wiki-loader-coverage.test.mjs red on master for ~2 days
// (2026-07-17→19): the plan-1554 GB land added unmapped seed chainIds and illegal wiki
// triggerPaths:, and nothing re-ran the test until an unrelated scripts/-touching push
// happened to eat the failure. This map is a literal, human-declared "this test reads that
// data" fact — never inferred — consulted by TWO independent callers, so it is authored once:
// `scripts/hooks/pre-push.sh`'s data-triggered block (a diff with NO scripts/*.mjs change) and
// wiki-commit.mjs's coord-checkout mutate() (wiki pages reach master through a path that never
// runs the pre-push battery at all).
//
// Glob vocabulary: an exact repo-relative path, or a `<dir>/**` recursive-directory prefix —
// the whole vocabulary this repo's data-dependent tests need today (see matchesDataGlob).
//
// Considered-and-excluded (audited at plan-2070 spec time): the backend/frontend seed-sanity
// suites and the seed schema boot-validation gate are ALSO data-driven (keyed on
// backend/src/data/seed/**), but each already has its OWN dedicated `scripts/hooks/pre-push.sh` tier
// gated directly on that diff (`seed_data_changed`), independent of the scripts/** gate this
// map extends — no entry needed here.
// plan 3962 P1: 'wiki-loader-coverage.test.mjs' (the one row naming a seed-shard
// glob) moved to coord.config.json's `dataDependencyMap` key — a JSON file, so the SEED_SHARD_GLOB
// split-literal trick this row used to need (assert-seed-io-seam.mjs's guard scans committed
// `.{py,mjs,ts,tsx}` sources only, per its own SCOPE comment, never JSON) is no longer needed at
// all. Every row below is coord-kit convention (Codex registration/lifecycle files, the
// prettier/wiki-posture gate), so it stays this module's own default; DATA_DEPENDENCY_MAP below
// merges it with the project's rows.
export const DEFAULT_DATA_DEPENDENCY_MAP = {
  // plan 2661. Codex's generated registration and lifecycle adapter read these
  // real-tree configuration/hook files directly. Keep the name-paired generator
  // suite selected when a future Claude registration or Codex adapter changes,
  // even if no scripts/*.mjs file is in that push.
  'build-codex-skills.test.mjs': [
    'scripts/codex-skills.json',
    '.agents/skills/**',
    'coord/skills/**',
    '.claude/commands/**',
  ],
  'build-codex-hooks.test.mjs': [
    'AGENTS.md',
    '.claude/settings.json',
    '.codex/config.toml',
    '.codex/hooks.json',
    '.codex/hooks/codex-context.mjs',
  ],
  // plan 2389. True inputs: the two CONFIG files that together decide whether prettier
  // touches the wiki vault — `.prettierignore` (does it cover wiki/) and `package.json`
  // (lint-staged's `{"*": …}` glob, the thing that runs prettier over every staged file) —
  // plus `WIKI.md`, the one piece of in-scope wiki content that lives OUTSIDE wiki/ and so
  // needs its own ignore entry. None of the three is a scripts/*.mjs file, so a diff that
  // drops the ignore entry would never reach the closure-based gate: exactly the
  // "test never re-runs on this data class" hole this map exists to close.
  // `wiki/**` is in the set too. The narrower config-only reading — "the vault's posture is a
  // property of the ignore entry, and a directory entry already covers pages that do not exist
  // yet" — is true for the POSTURE assertion but NOT for the would-rewrite scan, which walks
  // `git ls-files -- wiki WIKI.md` and therefore takes every tracked page as a real input. Under
  // this map's own stated rule (over-inclusion costs seconds, under-inclusion ships a
  // regression) the page tree belongs here. It also buys something concrete: wiki-commit.mjs
  // consults this map on its coord-checkout write-back, so a page landing on master now gets
  // the posture check at exactly the moment it lands.
  'assert-wiki-prettier-ignored.test.mjs': [
    '.prettierignore',
    'package.json',
    'WIKI.md',
    // `wiki/**`, never a bare `wiki/` — matchesDataGlob understands only an exact path or a
    // `<dir>/**` suffix, and assertValidDataDependencyMap THROWS on a bare-prefix entry
    // precisely so a silently-dead glob cannot reach here (plan 2176 finding 3).
    'wiki/**',
  ],
};

// The effective map: the generic default rows above, plus this project's own
// (coord.config.json's `dataDependencyMap` — vetapp's row reproduces the former
// 'wiki-loader-coverage.test.mjs' entry exactly). A project row can also EXTEND an
// existing default row's key (last-write-wins on that key, same as any object spread);
// today's config only adds a new key, never overrides one.
export const DATA_DEPENDENCY_MAP = {
  ...DEFAULT_DATA_DEPENDENCY_MAP,
  ...CFG.dataDependencyMap,
};

// A changed path against one glob entry: an exact match, or (for a `<dir>/**` entry) the path
// equals the bare directory or sits under it.
export function matchesDataGlob(path, glob) {
  if (glob.endsWith('/**')) {
    const dir = glob.slice(0, -3); // 'wiki/entities/**' -> 'wiki/entities'
    return path === dir || path.startsWith(`${dir}/`);
  }
  return path === glob;
}

// A DATA_DEPENDENCY_MAP glob ending in a bare `/` (the EXTERNAL_TREE_PREFIXES prefix-string
// style above, e.g. 'wiki/entities/') is silently DEAD here: matchesDataGlob only recognizes an
// exact path or a `<dir>/**` recursive suffix, and no path a real diff produces ever equals a
// directory string with a trailing slash. A future map entry authored in the OTHER list's style
// would therefore match nothing, ever — reproducing the exact "test never re-runs on this data
// class" failure mode plan 2070 exists to close (finding 3, plan 2176). Reject it LOUDLY rather
// than widening matchesDataGlob to silently accept both styles — one canonical style plus a loud
// reject beats a second silently-accepted syntax.
//
// WHERE this is called matters as much as what it checks (/sonnet-review xhigh finding on plan
// 2176's own first cut, which called it at MODULE TOP-LEVEL). A module-evaluation throw happens
// before mainDataTriggered's try/catch — before even the entrypoint's top-level handler — so node
// dies with an uncaught stack and exit 1, and `scripts/hooks/pre-push.sh`'s `&&` chain reads that
// identically to "nothing matched" and SKIPS the data-dependency gate. A validator meant to stop
// a silently-dead map entry would itself have caused a silently-skipped gate: the exact
// incident class plan 2070 exists to close, reintroduced by its own guard. So the call lives
// INSIDE mainDataTriggered's fail-safe boundary (loud stderr + fall back to every mapped test),
// and the LOUD blocking half is owned by select-battery-tests.test.mjs asserting the real map
// is valid — a red battery test, which is a push blocker that cannot be mistaken for "no match".
export function assertValidDataDependencyMap(map) {
  for (const [test, globs] of Object.entries(map)) {
    for (const glob of globs) {
      if (glob.endsWith('/')) {
        throw new Error(
          `select-battery-tests: DATA_DEPENDENCY_MAP['${test}'] has a bare-prefix glob ` +
            `${JSON.stringify(glob)} — matchesDataGlob only recognizes an exact path or a ` +
            `'<dir>/**' recursive suffix, so this entry would silently match nothing. Use ` +
            `${JSON.stringify(`${glob.slice(0, -1)}/**`)} instead.`,
        );
      }
    }
  }
}

// Sorted, `scripts/`-prefixed paths for a set of bare test basenames — the one place this
// mapping convention lives (selectTests, selectDataTriggeredTests, and mainDataTriggered's
// fail-safe fallback all shared a hand-copy of this before /sonnet-review high flagged it).
function toScriptPaths(names) {
  return [...names].sort().map((b) => `${SCRIPTS_DIR}/${b}`);
}

// Which DATA_DEPENDENCY_MAP test basenames does this changed-path list select — independent of
// changedScriptBasenames/selectTests above (this consults ANY changed path: wiki/, backend/,
// .codex/, not just scripts/*.mjs). Returns `scripts/<name>` paths, sorted, deduped —
// same output shape as selectTests. Empty means "none of the mapped data was touched".
export function selectDataTriggeredTests(paths, map = DATA_DEPENDENCY_MAP) {
  const selected = new Set();
  for (const [test, globs] of Object.entries(map)) {
    if (paths.some((p) => globs.some((g) => matchesDataGlob(p, g)))) selected.add(test);
  }
  return toScriptPaths(selected);
}

// --- cross-gate battery dedup (plan 2176 finding 1 / plan 2197) -------------
// The scripts/*.mjs gate and this data-triggered gate select INDEPENDENTLY off the same repo
// and their sets legitimately overlap (wiki-loader-coverage.test.mjs is both a scripts/ battery
// member and a DATA_DEPENDENCY_MAP entry). `scripts/hooks/pre-push.sh` hands us the `scripts/<name>` paths
// its OWN battery gate genuinely ran `node --test` on AND passed in this same push (never a
// merely-selected or cache-hit file — see readExcludeRanFile), and this pure function drops them
// from the data-triggered `selected` set so a push touching both never runs the same file twice.

// Pure set-difference: every entry of `selected` not present in `ranFiles`. Both are
// `scripts/<name>` path lists (the same shape `selectDataTriggeredTests`/`toScriptPaths`
// produce), so this never needs to know about bare basenames.
export function subtractRanFiles(selected, ranFiles) {
  const ran = new Set(ranFiles);
  return selected.filter((p) => !ran.has(p));
}

// Reads the hook's `--exclude-ran <path>` file: one `scripts/<name>` path per line, exactly what
// the scripts battery ran+passed in this push. Fail-safe direction is load-bearing here — a
// missing path, an unreadable file, an unparseable entry, or no path at all must all return []
// (subtractRanFiles then removes nothing), NEVER throw or narrow the data-triggered selection on
// an error path. Reuses parseChangedList (same CRLF-trim-blank-drop parse as the changed-file
// list, plus its path-shape validation) rather than a third hand-rolled copy of the identical
// one-path-per-line format (/sonnet-review high finding — the other copy lives in
// scripts/battery-pass-cache.mjs's normalizeSelection); readFileSync's ENOENT on a missing path
// is caught by the same try, so no separate existsSync pre-check is needed.
export function readExcludeRanFile(path) {
  if (!path) return [];
  try {
    return parseChangedList(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

// --- fs seam ----------------------------------------------------------------

// plan 3959 T1: recursive discovery — walks scripts/** (skipping node_modules/, test-helpers/, and
// any __golden__/, at any depth) so a test co-located with a nested module (scripts/coord/x.test.mjs)
// is discoverable at all. Returns forward-slash relative names, `coord/x.test.mjs` for a nested
// file and `board.test.mjs` for a flat one — the SAME shape toScriptPaths' `${SCRIPTS_DIR}/${b}`
// string-concat already expects for either case, and (since plan 4076) the SAME shape
// changedScriptBasenames above produces for every changed .mjs at any depth, so a nested entry's
// name never needs special-casing once it is in this list.
const SKIPPED_TEST_DIRS = new Set(['node_modules', 'test-helpers', '__golden__']);
export function listTestFiles(scriptsDir = SCRIPTS_DIR) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIPPED_TEST_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (isTestFile(entry.name)) {
        out.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    }
  };
  walk(scriptsDir, '');
  return out.sort();
}

export function makeReadSource(scriptsDir = SCRIPTS_DIR) {
  const cache = new Map();
  return (basename) => {
    if (cache.has(basename)) return cache.get(basename);
    const p = join(scriptsDir, basename);
    let src = null;
    try {
      if (existsSync(p)) src = readFileSync(p, 'utf8');
    } catch {
      src = null; // unreadable → leaf, same as absent
    }
    cache.set(basename, src);
    return src;
  };
}

// This CLI's stdin is the changed-path list `scripts/hooks/pre-push.sh` pipes in. It used to be
// its own `readFileSync(0,'utf8')` inside a bare `catch { return '' }` — the exact shape plan
// 2615 fixed in the wiki-loader hooks — and it bit HARDER here than it did there:
// an empty read parses to [] WITHOUT throwing, so both entrypoints below sailed straight PAST
// their fail-safe catch and computed a selection from "nothing changed". main() would report
// "no scripts/*.mjs in the delta" and mainDataTriggered() would exit 1 ("nothing matched") —
// silently SKIPPING the gate instead of over-running it, which is the precise inversion of the
// direction both fallbacks were written to fail in.
//
// So: retry a transient EAGAIN via the shared reader, and on a genuine failure THROW. Each
// caller's existing catch then does the right thing (full battery / every mapped test) off a
// KNOWN read failure rather than a fabricated empty list.
//
// NAMED `readChangedListOrThrow`, deliberately not `readStdin` (/sonnet-review high finding):
// stdin-read.mjs already exports a `readStdin` with the OPPOSITE failure contract (fail-open,
// returns ''), used by the nine hooks and write-lint-common.mjs. Two same-named functions in
// scripts/ disagreeing about whether a failed read throws is a trap for the next author who
// greps for one and imports the other. The name now states which contract you get.
//
// Exported (with the reader as a seam) purely so the throw-on-failure contract above is
// unit-testable — a genuine EAGAIN cannot be provoked from outside the process, and the
// silent-skip it used to cause is exactly the failure nobody would notice without a test.
export function readChangedListOrThrow(readResult = readStdinResult) {
  const res = readResult();
  if (!res.ok) {
    throw new Error(
      `could not read the changed-path list from stdin (${res.error?.code ?? 'unknown error'} ` +
        `after ${res.attempts} retries)`,
    );
  }
  return res.raw;
}

// --- CLI --------------------------------------------------------------------

export function main() {
  let paths;
  try {
    paths = parseChangedList(readChangedListOrThrow());
  } catch (e) {
    console.error(`select-battery-tests: ${e.message} — falling back to the full battery`);
    return EXIT_RUN_FULL;
  }
  if (touchesExternalTree(paths)) {
    console.error(
      'select-battery-tests: delta touches a real-tree path battery tests read directly ' +
        '(hook, backend, wiki, package manifest) — falling back to the full battery',
    );
    return EXIT_RUN_FULL;
  }
  if (hasNestedScriptChange(paths)) {
    // Name the path that actually triggered it, and describe the real reason rather than assuming
    // the commonest one. The old wording said "a NESTED path that is not a .mjs module", which
    // lies for the two unkeyable-MODULE cases (a `.mjs` under `__golden__`/`node_modules`, and a
    // flat bracketed `scripts/[x].mjs`) and sent triage looking for a shell file that is not in
    // the delta (/gpt-review round 2, finding 39a701).
    const offenders = paths.filter(isUnkeyableScriptPath);
    console.error(
      'select-battery-tests: delta changes a scripts/ path this selector cannot turn into a ' +
        'graph key — either a nested non-module (shell, JSON, a golden fixture), or a .mjs the ' +
        'key rules exclude (under __golden__/node_modules, or outside the key charset). Nothing ' +
        'can reach it through the closure, so the selection would silently omit it: falling back ' +
        `to the full battery. Unkeyable: ${offenders.join(', ')}`,
    );
    return EXIT_RUN_FULL;
  }

  const changed = changedScriptBasenames(paths);
  if (changed.size === 0) {
    console.error(
      'select-battery-tests: no scripts/**/*.mjs in the delta — falling back to the full battery',
    );
    return EXIT_RUN_FULL;
  }

  // One tree, named once and handed to all three seams — the reader, the test list and the
  // basename index — so they cannot describe different checkouts (finding cluster c588f7).
  const selected = selectTests({
    changed,
    allTests: listTestFiles(SCRIPTS_DIR),
    readSource: makeReadSource(SCRIPTS_DIR),
    basenameIndex: basenameIndexFor(SCRIPTS_DIR),
  });
  if (selected.length === 0) {
    console.error('select-battery-tests: empty selection — falling back to the full battery');
    return EXIT_RUN_FULL;
  }
  console.log(selected.join('\n'));
  return 0;
}

// `--exclude-ran <path>` (plan 2197): the optional second flag on the `--data-triggered` CLI,
// naming the file of `scripts/<name>` paths the hook's OWN battery gate ran+passed this push (see
// readExcludeRanFile). Absent when not given — `--data-triggered` with no `--exclude-ran` is a
// complete, valid invocation (a data-only diff never has a scripts/ gate to dedup against).
function parseExcludeRanPath(argv) {
  const i = argv.indexOf('--exclude-ran');
  return i === -1 ? null : (argv[i + 1] ?? null);
}

// `--data-triggered` mode (plan 2070 Group B): a SECOND, independent CLI contract over the
// SAME stdin changed-path list — consults DATA_DEPENDENCY_MAP against the WHOLE list (not just
// scripts/*.mjs), so it is meaningful even when the delta carries no scripts/*.mjs at all (the
// exact shape main() above can never see, since the hook only invokes it on a scripts/*.mjs
// diff). Exit 0 + the matched `scripts/<name>` paths on stdout when at least one test is
// triggered; exit 1 (never EXIT_RUN_FULL — this contract has no "run everything" fallback,
// only "run the mapped test or don't") when nothing matches. ANY exception below (a malformed
// stdin list OR a future selectDataTriggeredTests/DATA_DEPENDENCY_MAP throw) fails SAFE in the
// opposite direction from "skip": print every mapped test rather than silently running none —
// the whole body is wrapped in ONE try/catch so a crash past the parse step can't slip through
// to the top-level handler's EXIT_RUN_FULL(3), which this CLI's caller (scripts/hooks/pre-push.sh's `&&`
// chain) reads identically to "nothing matched" and silently skips the gate (/sonnet-review
// high finding — the exact silent-skip incident class plan 2070 exists to close).
export function mainDataTriggered() {
  let selected;
  try {
    // plan 2176: validate the map HERE, inside the fail-safe boundary — never at module load
    // (see assertValidDataDependencyMap's docblock for why a top-level throw silently disables
    // this very gate). An invalid entry lands in the catch below: loud stderr naming the bad
    // glob, plus the every-mapped-test fallback, so the failure direction stays "over-run".
    assertValidDataDependencyMap(DATA_DEPENDENCY_MAP);
    selected = selectDataTriggeredTests(parseChangedList(readChangedListOrThrow()));
  } catch (e) {
    console.error(
      `select-battery-tests --data-triggered: ${e.message} — cannot scope this delta, ` +
        'falling back to every mapped test',
    );
    selected = toScriptPaths(Object.keys(DATA_DEPENDENCY_MAP));
  }
  // plan 2197 (moved from .husky/pre-push's own grep -vxF set-difference, plan 2176 finding 1):
  // drop whatever the scripts battery already ran+passed in THIS push. readExcludeRanFile fails
  // safe to [] (missing path, unreadable file, no --exclude-ran at all) and never throws, so this
  // can only ever narrow a selection that a green run in the SAME push already proved — never an
  // unproven one. Its own try/catch (/sonnet-review high finding): a future edit here that DOES
  // throw must fall back to the wider `selected` as computed above, not propagate past this
  // function to the CLI's outer handler — which would exit EXIT_RUN_FULL(3), read by
  // `scripts/hooks/pre-push.sh`'s `&&` chain as "nothing matched" and silently skip the whole gate, the
  // exact incident class plan 2070 exists to close (mirrors the parse-step boundary above; a
  // dedup failure narrows to "skip the optimization", never to "skip the gate").
  try {
    const ranFiles = readExcludeRanFile(parseExcludeRanPath(process.argv.slice(3)));
    if (ranFiles.length > 0) {
      const remaining = subtractRanFiles(selected, ranFiles);
      if (remaining.length !== selected.length) {
        console.error(
          'select-battery-tests --data-triggered: data-dependency selection — dropping test ' +
            `file(s) the scripts battery already ran green in this push (plan 2176 dedup); ` +
            `remaining: ${remaining.join(' ')}`,
        );
      }
      selected = remaining;
    }
  } catch (e) {
    console.error(
      `select-battery-tests --data-triggered: --exclude-ran dedup failed (${e.message}) — ` +
        'skipping the dedup, keeping the full selection (never narrows on an error path)',
    );
  }
  if (selected.length === 0) return 1;
  console.log(selected.join('\n'));
  return 0;
}

// THE CLI ENTRY POINT, and the reason it is an export rather than logic inside the guard below:
// this module has TWO modes, and a path-compat shim (plan 3962 Phase 2 left one at
// scripts/select-battery-tests.mjs) can only reproduce what it can IMPORT. A shim calling `main`
// alone silently routed `--data-triggered` into the DELTA selector, which answered "this delta
// touches backend/, run the full battery" and the pre-push data-dependency gate never fired at
// all. Guard and shim now call the same function, so the two invocation paths cannot diverge.
export function cliMain(argv = process.argv.slice(2)) {
  return argv[0] === '--data-triggered' ? mainDataTriggered() : main();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(cliMain());
  } catch (e) {
    // Any unexpected crash is fail-SAFE: the hook reads non-zero as "run the full battery".
    console.error('select-battery-tests:', e.message);
    process.exit(EXIT_RUN_FULL);
  }
}
