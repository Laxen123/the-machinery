#!/usr/bin/env node
// scripts/battery-pass-cache.mjs — content-addressed pass-cache for the pre-push coord test
// battery (plan 1824; the machinery that closes plan 1807's levers 1+3 in one mechanism).
//
// WHY: during a landing ripple the SAME gated content is battery-tested repeatedly. The canonical
// case is a land: the worktree branch's last force-push gates a tree, then minutes later
// done-worktree's master merge-push re-gates a patch-identical tree (a clean merge of a rebased
// branch produces the branch tip's tree for every gated path), paying the full battery — and a
// machine-wide mutex wait (scripts/battery-lock.mjs) — a second time for content that already
// passed. This cache remembers "this exact gated-content state passed this exact selection" so the
// second run is a hit that skips BOTH the battery run and the mutex acquire.
//
// WHY CONTENT-ADDRESSED, NOT PATCH-ID (the plan-1807 lever-1 subsumption verdict, recorded in plan
// 1824): a patch-id skip needs a record of "the prior gated push" — a mutable marker a crashed
// session could leave stale, which the plan's fail-safe pin forbids. Content addressing needs no
// history at all: the key IS the content. Any difference anywhere in what the battery can read →
// a different key → a miss → the battery runs. The only stored state is "key K passed at time T",
// and the only way to mint K is to hash the live content being tested right now.
//
// WHAT THE KEY COVERS — everything the battery can read, not just the selected tests:
//   - the `scripts` tree oid (the suite itself + every module it imports/spawns, nested included);
//   - the gate-logic file `scripts/hooks/pre-push.sh` — its own component (plan 2598), because a
//     key narrowed to the selection's flat-file import closure reaches no nested path, and that
//     file cannot join the `ls-tree` pathspec set without collapsing it (see gateLogicKey);
//   - every EXTERNAL_TREE_PREFIXES entry from scripts/select-battery-tests.mjs (imported, so the
//     two stay in lockstep by construction — a new prefix added there is in this key on the next
//     run, never a second hand-maintained list): battery tests read REAL-tree paths (.husky hooks
//     run end-to-end, .gitattributes assertions, backend/wiki walks) that no import graph sees.
//     Since plan 2279, `wiki/` and `backend/` (the caller-injected scopedPrefixes, plan 4071 T2)
//     are keyed PER-SELECTION: they
//     drop out of the key when no selected test can read them (reachableScopedPrefixes), so
//     master-side churn there — the dominant measured hit-defeater — no longer re-keys
//     selections that never look at it;
//   - `pnpm-lock.yaml` as the tracked proxy for node_modules/ (the one prefix that cannot be
//     content-addressed — it is untracked; see DEFAULT_TTL_MIN for the residual-drift bound);
//   - the running node MAJOR version and the installed git version (the battery spins real
//     git repos/worktrees — upgrading either can change test outcomes);
//   - the selection CLAIM (sorted). Since plan 2279 this is the CANONICAL selection — what the
//     selector picks for merge-base(origin/master, HEAD)..HEAD, the tree's own content diff —
//     when one is derivable, because each push's RANGE-derived selection is an artifact of
//     remote-ref state: a branch's final push and its land's merge-push gate identical content
//     under different ranges, and keying the range selection made them miss each other (the
//     plan-1838 dominant leak, 56/75). The push's own selection remains the key's selection
//     (legacy mode) when no canonical claim exists. Soundness is held by two gates: `record`
//     refuses a claim the run didn't cover (sel-not-superset), and `check` refuses a hit whose
//     claim doesn't cover the current run (run-exceeds-canonical). A full-glob green run also
//     records a UNIVERSAL twin entry that any selection of identical content may hit.
// Oids come from HEAD via one combined `git ls-tree` spawn covering every UN-NESTED keyed path,
// plus one small per-path verification probe for anything that call didn't resolve (a nested
// pathspec forces git to recurse and can silently drop an ancestor's own entry from the output —
// see gatherRepoState's dedupe/verify step, plan 4071 review finding 9179f0/99567b), which is
// only sound when the WORKING TREE (what `node --test` actually reads) matches HEAD for every
// keyed path — so `check`/`record` first run `git status --porcelain` over those paths and refuse
// to cache on ANY dirt (tracked or untracked). Refusal degrades to "run the battery", never to a
// wrong key.
//
// FAIL-CLOSED CONTRACT (plan-1673 principle, unchanged): every uncertain path — dirty gated
// content, a git error, a corrupt entry, a TTL expiry, a key mismatch at record time — means "no
// cache", and the hook then runs the battery exactly as it does today. A failure is NEVER cached
// (`record` is only ever called by the hook after a green run, and `invalidate` drops the key on
// a red one so a flaky pass can't shadow a later real failure). Nothing in this file can cause a
// test not to run that today's hook would have run — it can only skip a run whose exact content
// already ran green.
//
// RENDEZVOUS: entries live in `<git common dir>/battery-pass-cache/` — the same shared-.git
// property battery-lock.mjs relies on (every worktree of the one clone sees the one cache; never
// git-tracked, never swept by `git clean -fdx`). One JSON file per key; `record` opportunistically
// prunes expired siblings — once the dir has actually accumulated (plan 2492's entry-count
// throttle) — so it stays a handful of files without a scheduled sweep.
//
// Usage (stdin for check/record is the hook's $BATTERY_FILES — the selected test list, or the
// literal 'scripts/*.test.mjs' glob on a full run; the scripts tree oid in the key disambiguates
// what the glob expands to):
//   printf '%s\n' "$BATTERY_FILES" | node scripts/battery-pass-cache.mjs check
//       stdout: the key that decided — the served entry's key on HIT (the universal twin's on a
//               fallback hit), the primary key on MISS; empty when uncacheable
//       exit:   0 HIT (a valid, unexpired pass exists) · 2 MISS · 3 UNCACHEABLE (dirty/error/disabled)
//   printf '%s\n' "$BATTERY_FILES" | node scripts/battery-pass-cache.mjs record --key <k> [--label <s>]
//       recomputes the key and records ONLY if it still equals <k> (the tree could have changed
//       under the battery — the 2026-06-04 plan-338 incident proved tests CAN mutate the repo);
//       always exits 0 (close-out must never block a push).
//   node scripts/battery-pass-cache.mjs invalidate --key <k>   # drop one entry; always exit 0
//   node scripts/battery-pass-cache.mjs status                 # list live entries (read-only)
//   node scripts/battery-pass-cache.mjs path                   # the resolved cache dir
//
// Kill-switches (both enforced in scripts/hooks/pre-push.sh, and `check` honors the first here too as
// defense in depth): PREPUSH_NO_BATTERY_CACHE=1 disables the cache entirely;
// PREPUSH_FULL_BATTERY=1 forces a full run that neither reads nor writes the cache.
// Runbook: docs/coord/land-spine.md § The once-per-land proof cache

import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
// plan 2615: the shared reader (bounded EAGAIN retry + a temp-file diagnostic). Was a local
// `readFileSync(0)` in a bare catch, which made a Windows read failure indistinguishable from
// empty input — the silent-skip class this plan exists to close. Fail-open shape unchanged.
import { readStdin } from './stdin-read.mjs';
import { pathToFileURL } from 'node:url';
import { parseLockArgs } from './landing-lock.mjs';
// The storage/TTL/telemetry KERNEL — the ONE implementation, shared with gate-pass-cache.mjs
// (plan 2492; the two carried near-identical copies of every helper). KEY DERIVATION stays here:
// this cache's key is inseparable from test-SELECTION semantics, which is why the two remain
// sibling modules rather than one.
import {
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  PRUNE_MIN_ENTRIES,
  entryPath,
  isLive,
  logTelemetry,
  makeGit,
  parseEntry,
  pruneExpired,
  readCacheEntry,
  removeCacheEntry,
  resolveCacheDir as resolveCacheDirIn,
  writeCacheEntry,
} from './pass-cache-kernel.mjs';

// Re-exported so this module stays the ONE import site for its own CLI and tests.
export {
  DEFAULT_TTL_MIN,
  EXIT_HIT,
  EXIT_MISS,
  EXIT_UNCACHEABLE,
  entryPath,
  isLive,
  logTelemetry,
  makeGit,
  parseEntry,
  pruneExpired,
  readCacheEntry,
  removeCacheEntry,
  writeCacheEntry,
};

// A SEPARATE dir from gate-pass-cache/ — different key format, different prune policy.
export const resolveCacheDir = (git) => resolveCacheDirIn(git, 'battery-pass-cache');
import {
  EXTERNAL_TREE_PREFIXES,
  REAL_TREE_JOIN_IDIOMS,
  repoRootAlt,
  DATA_DEPENDENCY_MAP,
  parseChangedList,
  touchesExternalTree,
  hasNestedScriptChange,
  changedScriptBasenames,
  selectTests,
  listTestFiles,
  makeReadSource,
  basenameIndexFor,
  SCRIPTS_DIR_DEFAULT,
  referenceClosure,
  unresolvedScriptRefReason,
} from './select-battery-tests.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { repoRootFrom } from './scripts-anchor.mjs';

// This CLI's flag surface (the plan-1777 cmd-shaped wrapper, same as battery-lock's own spec).
// `merge-base-out` (check) and `merge-base` (record) are plan 2559: pin the merge-base baseline
// at check time and thread it through to record — see deriveKey/resolveMergeBaseOid below.
export const CACHE_ARG_SPEC = Object.freeze({
  label: 'battery-pass-cache',
  value: Object.freeze(['key', 'label', 'ttl-min', 'merge-base', 'merge-base-out']),
  boolean: Object.freeze([]),
});

// (DEFAULT_TTL_MIN — its lockfile-proxy sizing rationale now lives beside the constant in
//  pass-cache-kernel.mjs — and the EXIT_* contract are re-exported above.)

// Bump when the key derivation changes shape: an old-format entry must never satisfy a
// new-format lookup (the version is hashed INTO the key, so a bump orphans old entries — they
// age out via prune rather than ever matching). v2: added gitVersion (xhigh review, plan 1824).
// v3: canonical-selection keying + per-selection wiki/backend prefix scoping (plan 2279).
// v4 (plan 2560): `scripts/` is keyed on the selected tests' import CLOSURE (individual file
// oids) instead of the whole tree's aggregate oid whenever the closure resolves cleanly, and
// `.husky/` is keyed on just the pass-cache's own block inside `pre-push` instead of the whole
// hook file whenever that block extracts cleanly — both widen to the pre-2560 whole-tree/file
// keying on any uncertainty (universal selection, a non-flat path, an unresolvable dynamic
// import, a missing marker, a git error). See `closurePathsForSelection` below.
// v5 (plan 2598): the block-scoping half of v4 is RETIRED, not moved. The gate logic plan 2576
// took out of `.husky/pre-push` now lives in `scripts/hooks/pre-push.sh` and is keyed WHOLE, as
// its own component, because the battery's verdict-deciding helpers sit outside any marker pair
// (see gateLogicKey). `.husky/` goes back to permanent wholesale keying (a 26-line dispatcher
// shim + two near-static hooks). See `gateLogic` in computeKey's components.
export const KEY_FORMAT_VERSION = 5;

// The one selection value that means "the full battery" — the literal glob the hook pipes on a
// full run (normalizeSelection keeps it as this single line; the scripts tree oid in the key
// disambiguates what it expands to). Semantically a UNIVERSAL claim: a green full run proves
// every test file, so it is a superset of any selection.
export const UNIVERSAL_SELECTION = Object.freeze(['scripts/*.test.mjs']);

export const isUniversalSelection = (sel) => sel.length === 1 && sel[0] === UNIVERSAL_SELECTION[0];

// The external prefixes keyed PER-SELECTION instead of always (plan 2279 leak 2): wiki/ and
// backend/ move on master constantly (soak-measured: 12 + 4 defeated merge-push hits in 8 days),
// while only 3 / 4 battery tests actually read them from the real tree. Every OTHER prefix stays
// globally keyed — their churn is a rounding error and a smaller scoping surface is a smaller
// soundness surface. Scoping a prefix OUT of the key is only sound when NO selected test can
// read it; see reachableScopedPrefixes for how that is established.
//
// PLAN 4071 T2 — CALLER-INJECTED, NOT SELF-RESOLVED. `wiki/` is a coord-kit concept (shipped on
// by default, generic to any project this seam serves) and stays a CORE prefix; `backend/` was
// vetapp's own addition, hardcoded here. Per this repo's caller-injects rule (plan 4071 Rule 1),
// every pure helper below takes the MERGED prefix list as a parameter (`scopedPrefixesFor` turns
// coord.config.json's `batteryScopedPrefixes` row into that list); only `main()` — a CLI entry
// point whose sole caller is the shell — resolves the config, once, and passes the merged list
// down.
export const CORE_SCOPED_PREFIXES = Object.freeze(['wiki/']);

// The core prefix plus a project's own additions (coord.config.json's `batteryScopedPrefixes`
// row), deduplicated, core first — the "function OF the value" plan 4071's Rule 1 requires.
export function scopedPrefixesFor(configPrefixes = []) {
  const out = [...CORE_SCOPED_PREFIXES];
  for (const p of configPrefixes) if (!out.includes(p)) out.push(p);
  return out;
}

// The tracked paths whose content the key must cover, derived from the selector's own
// external-tree list so the two can never drift apart (see WHAT THE KEY COVERS above).
// node_modules/ is untracked (represented by the lockfile instead); trailing slashes are
// stripped to the path form `git ls-tree` and `git status` pathspecs expect.
// `scopedOut` (plan 2279; plan 2560 also routed `.husky/` through it, which plan 2598 reverted
// when the gate logic moved out of `.husky` — see gateLogicKey) lists EXTERNAL_TREE_PREFIXES
// entries proven unreachable by the selected tests — they are dropped from the wholesale key so
// master-side churn there cannot defeat a hit. `scriptsPaths` (plan 2560) is the whole-tree `['scripts']` default, or — when
// `closurePathsForSelection` resolves cleanly for the current key-selection — the sorted set of
// individual `scripts/<name>` paths that selection's import closure can actually reach.
export function keyedPaths(
  prefixes = EXTERNAL_TREE_PREFIXES,
  scopedOut = [],
  scriptsPaths = ['scripts'],
) {
  const out = new Set([...scriptsPaths, 'pnpm-lock.yaml']);
  for (const p of prefixes) {
    if (p === 'node_modules/') continue;
    if (scopedOut.includes(p)) continue;
    out.add(p.replace(/\/$/, ''));
  }
  return [...out].sort();
}

// Escape a literal string for embedding in a regex — plan 4071 review finding f5ea01. `seg` is a
// configured prefix segment (project-supplied, via coord.config.json's `batteryScopedPrefixes`),
// not a hardcoded constant, so it can contain regex metacharacters (e.g. a prefix named
// `backend[legacy]/` would otherwise be parsed as a character class below, silently dropping the
// prefix from attribution and from the key). Every prefix in this repo today is plain path
// characters, so this changes no existing behavior.
function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does this TEST-FILE source read the real tree under `<seg>/`? `<seg>` may itself be a
// multi-segment path (a nested configured prefix like `backend/scripts`) — every shape below
// matches at ANY depth, not just a top-level segment (plan 4071 review finding 66d3c7). Three
// shapes, ALL deliberately over-approximate (a false positive keeps the prefix keyed — today's
// behavior; a false negative would be unsound, so when in doubt this must answer true):
//   1+2. For a SINGLE-segment `seg`, REAL_TREE_JOIN_IDIOMS — the SAME regex objects
//        select-battery-tests.test.mjs's EXTERNAL_TREE_PREFIXES guard scans (join(<root-const>,
//        '<segment>', …) and join(<root-or-HERE>, '..', '<segment>', …), imported so the two
//        scans can never drift). That guard is the system's enforced definition of "a battery
//        test reads the real tree", so attribution built on the same scan inherits exactly its
//        soundness envelope. For a NESTED `seg` (more than one path segment), the shared idioms
//        cannot be reused as-is — each only captures the FIRST quoted join() argument, so
//        `join(REPO, 'backend', 'scripts', …)` captures just `backend` and can never equal a
//        two-segment `seg`. Generalize the same two root shapes to N consecutive quoted
//        arguments instead, escaped per-segment.
//   3.   any quoted path literal starting `<seg>/` — extra margin for reads the join idioms
//        miss (cwd-relative literals, glob strings, DATA_DEPENDENCY_MAP-style paths), and the
//        one shape that also covers a slash-joined literal at any depth
//        (`join(REPO, 'backend/scripts/foo.py')`).
// Library modules are NOT scanned: tests drive CLIs against fixture repos, so a library's own
// path literals resolve inside fixtures, and scanning closures makes attribution useless
// (measured: 89/146 tests' closures mention 'wiki' in prose/error strings).
// One quoted-string-literal alternative for a path segment — single, double, OR backtick quotes
// (plan 4071 review finding e5de0f/733b4e). The single-segment path below uses the shared
// REAL_TREE_JOIN_IDIOMS, which now admits the same three static quote styles (plan 4228).
// This helper remains for N > 1, where the shared idioms capture only the first argument.
function quotedSegmentAlt(seg) {
  const esc = escapeRegExpLiteral(seg);
  return `(?:'${esc}'|"${esc}"|\`${esc}\`)`;
}

// The two REAL_TREE_JOIN_IDIOMS root shapes, generalized to N consecutive quoted path arguments
// (plan 4071 review finding 733b4e) instead of a hand-duplicated, single-quote-only copy. The
// root-alias alternation itself is NOT re-typed here: `repoRootAlt`, imported from
// select-battery-tests.mjs, is the one place that grammar is defined, so REAL_TREE_JOIN_IDIOMS
// (N=1) and this nested matcher (N>1) are both built from it and a future root alias only ever
// needs to change there (plan 4071 review round 3). The `..` traversal token goes through
// `quotedSegmentAlt` too, same as every path segment, so it is matched in any quote style
// (plan 4071 review round 3, findings 555ec4/8718c1).
function joinIdiomsForSegments(parts) {
  const partsRx = parts.map(quotedSegmentAlt).join('\\s*,\\s*');
  const traversalRx = quotedSegmentAlt('..');
  return [
    new RegExp(`\\bjoin\\(\\s*${repoRootAlt()}\\s*,\\s*${partsRx}`),
    new RegExp(`\\bjoin\\(\\s*${repoRootAlt(true)}\\s*,\\s*${traversalRx}\\s*,\\s*${partsRx}`),
  ];
}

export function testReadsRealTreeSegment(src, seg) {
  const parts = seg.split('/');
  if (parts.length === 1) {
    for (const idiom of REAL_TREE_JOIN_IDIOMS)
      for (const m of src.matchAll(idiom)) if (m[1] === seg) return true;
  } else if (joinIdiomsForSegments(parts).some((rx) => rx.test(src))) {
    return true;
  }
  return new RegExp(`['"\`]${escapeRegExpLiteral(seg)}/`).test(src);
}

// The FLAT scripts/<name>.test.mjs shape — the ONE shape the selector, reachableScopedPrefixes,
// and closurePathsForSelection below all require of a key-selection entry before they will try to
// attribute anything to it. A single named regex (plan 2560) so a future edit to the shape cannot
// drift between the two closure-walking consumers.
export const FLAT_TEST_PATH_RX = /^scripts\/([A-Za-z0-9._-]+\.test\.mjs)$/;

// Which of the given scopedPrefixes the key-selection's tests can read from the REAL tree — the
// prefixes that must stay IN the key. Sound direction on every uncertain path is "all of them"
// (= today's unscoped key): a universal selection can run any test; an unreadable / non-test
// selection entry means we cannot prove unreachability. A test named in DATA_DEPENDENCY_MAP
// additionally pins every scoped prefix its data globs live under, even if its own source scan
// misses the read (the loaders read that data indirectly).
export function reachableScopedPrefixes(
  selection,
  {
    readSource = makeReadSource(),
    dataMap = DATA_DEPENDENCY_MAP,
    scopedPrefixes = CORE_SCOPED_PREFIXES,
  } = {},
) {
  if (isUniversalSelection(selection)) return [...scopedPrefixes];
  const segs = scopedPrefixes.map((p) => p.replace(/\/$/, ''));
  const found = new Set();
  for (const path of selection) {
    const m = FLAT_TEST_PATH_RX.exec(path);
    if (!m) return [...scopedPrefixes]; // not a flat test path — cannot attribute, key everything
    const src = readSource(m[1]);
    if (src == null) return [...scopedPrefixes]; // unreadable test — key everything
    for (const seg of segs) {
      if (!found.has(seg) && testReadsRealTreeSegment(src, seg)) found.add(seg);
    }
    // Match at any depth (plan 4071 review finding 66d3c7's same nested-prefix gap): a glob
    // under a nested prefix like `backend/scripts/**` must pin `backend/scripts`, not just its
    // first path segment `backend` — a first-segment-only comparison can only ever match a
    // single-segment scoped prefix.
    const globs = dataMap[m[1]];
    if (globs)
      for (const g of globs)
        for (const seg of segs)
          if (!found.has(seg) && (g === seg || g.startsWith(`${seg}/`))) found.add(seg);
    if (found.size === segs.length) break;
  }
  return scopedPrefixes.filter((p) => found.has(p.replace(/\/$/, '')));
}

// --- scripts/ import-closure scoping (plan 2560) ------------------------------
//
// Everything above this point keys `scripts/` WHOLESALE (the whole tree's aggregate oid) — sound,
// but every coord/infra land moves SOME file under `scripts/`, and the landing queue is
// coord-heavy, so the population whose batteries this cache would help most defeats each other's
// hits (122 of 164 measured oid-moved misses, `.husky` + `scripts` combined — plan 2327 re-measure,
// docs/coord/land-spine.md § The once-per-land proof cache). This closure lets the key drop to the
// INDIVIDUAL `scripts/<name>` files the selected tests can actually reach, so an unrelated
// `scripts/` edit elsewhere in the tree no longer moves the key.
//
// The narrow/widen guard is NOT a second text scan owned here (plan 2578): both halves come from
// scripts/select-battery-tests.mjs — `referenceClosure` for the edges and
// `unresolvedScriptRefReason` for the classification — so the extractor and the guard can never
// drift on what a resolvable sibling-script reference is. Plan 2560's own `hasUnresolvableSpecifier`
// was that second list, and it drifted in BOTH directions within one commit: it matched
// `FLAT_TEST_PATH_RX.exec(path)` (plain `RegExp.prototype.exec`) as a child-process call, so every
// selection reaching a file with `.exec(` in it no-op'd back to whole-tree keying, while missing
// the `const CLI = join(HERE, 'sibling.mjs')` spawn idiom that is this repo's dominant one.
//
// THE CLOSURE IS WALKED PERMISSIVELY HERE (`allLiterals`), unlike the selector's. The selector's
// spawn gate deliberately DROPS a `scripts/<name>.mjs` / `join(HERE, 'x.mjs')` reference that sits on a
// line with no child-process call, because library modules name siblings in error strings and
// counting those welds the graph into one blob. Dropping an edge is free for selection and
// UNSOUND for the key: `const CLI = join(HERE, 'build-index.mjs')` (done-worktree.mjs) has no
// spawn call on its line, so the gated walk would leave build-index.mjs out of the key and serve a
// HIT after it changed. Measured cost of the permissive walk (plan 2578, 354-file tree): a
// board.mjs delta keys 118 files instead of the gated walk's 104, a next-plan-id.mjs delta 88
// instead of 58 — both still a fraction of the whole tree, which is the fallback either way.

// Derive the set of `scripts/<name>` paths the given key-selection's reference closure can reach.
// Returns `{ ok: true, paths }` (sorted, safe to key individually instead of the whole tree) or
// `{ ok: false, reason }` — every failure/uncertainty route means "key the whole scripts/ tree",
// never a partial or best-effort closure:
//   - the universal selection proves every test — scoping it would be both meaningless (it IS
//     the "ran everything" claim) and unsound (it must stay comparable to the pre-2560 key);
//   - a selection entry that is not FLAT_TEST_PATH_RX-shaped cannot be resolved by this walk (the
//     same shape reachableScopedPrefixes already requires);
//   - an unreadable entry test, or a referenceClosure crash, is a resolution ERROR — the plan's
//     pin: an error may only widen, never narrow;
//   - unresolvedScriptRefReason on ANY closure member (entry or transitive) forces the whole tree,
//     because that file may reach a sibling the static walk never discovered.
// `refsCache` is a single shared Map across every entry in `selection` (mirroring selectTests'
// own cache) — a hub module reached from several selected tests is parsed once, not once per test.
// It must never be shared with a selector-side cache: the two walks scan in different modes.
// `basenameIndex` (plan 4085) is the tree the closure resolves a computed-directory reference's
// BASENAME against — `join(spineDir, 'done-worktree.mjs')`. It defaults to the SAME tree
// makeReadSource defaults to, so index and read seam always describe one checkout; a caller
// reading another tree passes both. Supplying it MATTERS here rather than being an optimization:
// without an index the fallback does not fire, and a dropped edge means this key omits a file the
// battery genuinely reads — editing that file then recomputes the same key and serves a HIT for
// changed content, the false green this cache may never produce.
export function closurePathsForSelection(keySelection, opts = {}) {
  // The universal-selection fast path returns before any tree is walked (/gpt-review round 2,
  // findings 9e9e32 / d15bdd) — an un-narrowable key needs no closure and so no index.
  if (isUniversalSelection(keySelection)) return { ok: false, reason: 'universal-selection' };
  const { scriptsDir = SCRIPTS_DIR_DEFAULT, refsCache = new Map() } = opts;
  const readSource = opts.readSource ?? makeReadSource(scriptsDir);
  // Paired BY CONSTRUCTION: an index is only derived when this call also owns the reader (or the
  // caller named the tree). A caller that injects a reader for some OTHER tree without naming it
  // gets NO index rather than one describing this process's cwd — resolving a basename against the
  // wrong tree would drop a real dependency from the key, i.e. serve a HIT for changed content
  // (/gpt-review round 2, findings c588f7 / b14647 / ab0a70 / 2b4440).
  const basenameIndex =
    opts.basenameIndex ??
    (opts.readSource && opts.scriptsDir === undefined ? undefined : basenameIndexFor(scriptsDir));
  // UNPAIRED: a reader was injected but no tree was named, so there is nothing to resolve a
  // computed-directory reference against and the closure would silently omit one — a key missing a
  // file the battery reads, i.e. a HIT for changed content. Refuse to narrow rather than narrow
  // unsoundly; the caller falls back to whole-tree `scripts` keying, which is un-narrowed but
  // never wrong. A caller whose reader serves a SYNTHETIC tree says so with an explicit empty
  // index — truthful there, since such a tree has no modules to resolve against.
  if (!basenameIndex) return { ok: false, reason: 'read-source-without-tree' };
  const basenames = [];
  for (const p of keySelection) {
    const m = FLAT_TEST_PATH_RX.exec(p);
    if (!m) return { ok: false, reason: 'non-flat-test-path' };
    basenames.push(m[1]);
  }
  const files = new Set();
  for (const b of basenames) {
    const src = readSource(b);
    if (src == null) return { ok: false, reason: 'unreadable-test' };
    let closure;
    try {
      closure = referenceClosure(b, readSource, refsCache, {
        allLiterals: true,
        basenameIndex,
      });
    } catch (e) {
      return { ok: false, reason: `closure-error:${e.message}` };
    }
    for (const name of closure) files.add(name);
  }
  // Classify EVERY closure member (not just the selected entries) — referenceClosure's own BFS
  // does not check for unresolvable references, and a hub module reached only transitively is
  // exactly the file whose own dynamic edge would otherwise go unnoticed.
  for (const name of files) {
    const src = readSource(name);
    if (src == null) continue;
    let reason;
    try {
      reason = unresolvedScriptRefReason(src);
    } catch (e) {
      // The classifier is documented never to throw; if a future edit makes it, that is doubt —
      // and doubt widens. Never let an exception here read as "nothing unresolvable".
      return { ok: false, reason: `classify-error:${e.message}` };
    }
    if (reason) return { ok: false, reason: `${reason}:${name}` };
  }
  return { ok: true, paths: [...files].map((n) => `scripts/${n}`).sort() };
}

// --- gate-logic file keying + battery-block scoping (plan 2560, retargeted by plan 2598) ------
//
// THE FILE THAT DECIDES WHICH GATES RUN NEEDS ITS OWN KEY COMPONENT. Plan 2576 moved the pre-push
// gate logic out of `.husky/pre-push` (now a 26-line dispatcher shim) into
// `scripts/hooks/pre-push.sh`; plan 2578 then narrowed the `scripts/` key to the individual FLAT
// `scripts/<name>.mjs` files a selection's import closure reaches. Those two compose badly: the
// closure never reaches a nested path, so after 2576+2578 a narrowed key covered the gate logic
// through NOTHING — editing `scripts/hooks/pre-push.sh` alone left the key unchanged and `check`
// could serve a HIT for a push whose gate logic had moved since the recorded pass.
//
// WHY A DEDICATED PROBE AND NOT AN ENTRY IN `keyedPaths` (measured, plan 2598): `gatherRepoState`
// resolves the keyed set with ONE `git ls-tree HEAD -- <paths>`, and that call is non-recursive
// only as long as every pathspec is top-level. Adding `scripts/hooks/pre-push.sh` to the same
// pathspec list makes git recurse to satisfy it, and the aggregate `scripts` TREE entry then
// disappears from the output (verified: 368 blob rows, no `scripts` row) — which trips
// gatherRepoState's own `no-scripts-tree` refusal and makes the cache permanently uncacheable.
// Fail-safe, but a total loss of the mechanism behind a reason string that would be a lie. So the
// gate-logic file is resolved by its own `git show` probe and carried as its own component,
// symmetric with (and now the sole remaining use of) the block-scoping mechanism below.
//
// WHY SCOPE TO THE BLOCK AT ALL (the 2560 rationale, which transfers verbatim to the new home):
// the only thing in the hook THIS cache's own claim depends on is the "1.7 Battery pass-cache"
// section — every other line (the tsc/vitest/pytest/mobile gates, the selector wiring, the mutex)
// is irrelevant to whether a recorded battery pass is still trustworthy, and the inputs that ARE
// load-bearing (which tests were selected, the tree they read, node/git versions) are already key
// components in their own right. 2560 measured ~94% of `.husky` churn as `pre-push` edits; that
// churn moved to `scripts/hooks/pre-push.sh` with the logic, so scoping to the block is what keeps
// non-battery gate churn from busting every narrowed key.
//
// `.husky/` itself goes back to permanent WHOLESALE keying (it stays in EXTERNAL_TREE_PREFIXES and
// is never scoped out): post-2576 it is a 26-line shim plus two near-static hooks — cheap to key
// whole, and nothing else covers it now that the block lives elsewhere.
export const GATE_LOGIC_PATH = 'scripts/hooks/pre-push.sh';

// plan 3963 split the gate logic in two, and the component had to follow it. `pre-push.sh` is now
// a ~27-line dispatcher: it sources `pre-push-core.sh` (the generic gates — including
// `run_battery_with_retry` and the selection assembly, the two the comment above names as the
// verdict-deciding code the retired block scoping could not see) and, when the file exists,
// `pre-push-project.sh` (this repo's vetapp gates). Keying the dispatcher ALONE would reinstate
// the plan-2598 failure verbatim at a new seam: a fix to a misclassification bug in
// `run_battery_with_retry` would no longer move the key, so entries RECORDED by the buggy version
// stay servable after the bug is fixed. The soundness argument is unchanged — "every line that can
// affect the battery's verdict is covered" — it now just takes three blob oids instead of one.
// A path that is not in HEAD contributes `absent`, the same convention the single-path probe used,
// which is what keeps a core-only checkout (no `pre-push-project.sh`) keyable rather than
// permanently uncacheable — and keeps it DISTINCT from a tree that does carry one.
export const GATE_LOGIC_PATHS = [
  GATE_LOGIC_PATH,
  'scripts/hooks/pre-push-core.sh',
  'scripts/hooks/pre-push-project.sh',
];

// THE BLOCK SCOPING IS RETIRED (plan 2598, on its own `/sonnet-review high`). Plan 2560 keyed only
// the `1.7 Battery pass-cache` block inside the hook rather than the whole file, on the argument
// that nothing else in it can affect whether a recorded battery pass is still trustworthy. That
// argument is FALSE, and the review found the counter-example in the live file: the battery is
// executed through `run_battery_with_retry()`, defined around line 767 — hundreds of lines ABOVE
// the block's start marker — and that function is what classifies an attempt as pass / fail /
// timeout. So does the selection assembly (`BATTERY_DELTA`, the `scripts/*.mjs` entry gate) that
// decides which tests the block even receives. A fix to a misclassification bug in that helper
// would not move a block-scoped key, so entries RECORDED by the buggy version stay servable after
// the bug is fixed: a false green surviving its own remediation, which is precisely the failure
// mode this cache is built to make impossible.
//
// The block mechanism cannot be repaired by moving markers, because the property it needs — "every
// line that can affect the battery's verdict is textually between two markers" — is not a property
// a shell file maintains for you, and plan 2579 is actively extracting MORE shared helpers out of
// the gates into file-level functions. Keying the WHOLE gate-logic file is the only formulation
// whose soundness does not depend on where a future refactor happens to put a helper. Plan 2598's
// acceptance names this arm explicitly as the sanctioned fallback ("delete remains the sanctioned
// fallback if the retarget does not compose cleanly"), and the one forbidden outcome —
// dead-but-present code — is avoided by removing the mechanism rather than leaving it inert.
//
// The cost is the hit-rate 2560 was buying: an edit anywhere in the hook now busts a narrowed key.
// 2560 measured ~94% of that file's churn as edits that "correctly still miss either way", so the
// forgone recovery is the ~6% tail — a price worth paying for a key whose coverage argument is
// "the whole file" instead of a textual-contiguity assumption nobody can enforce.
//
// WHY A DEDICATED PROBE AND NOT AN ENTRY IN `keyedPaths` (measured, plan 2598): `gatherRepoState`
// resolves the keyed set with ONE `git ls-tree HEAD -- <paths>`, and that call stays non-recursive
// only while every pathspec is top-level. Adding `scripts/hooks/pre-push.sh` to the same pathspec
// list makes git recurse to satisfy it, and the aggregate `scripts` TREE entry then disappears
// from the output (verified: 368 blob rows, no `scripts` row) — which trips gatherRepoState's own
// `no-scripts-tree` refusal and makes the cache permanently uncacheable. Fail-safe, but a total
// loss of the mechanism behind a reason string that would be a lie.
//
// `.husky/` goes back to permanent WHOLESALE keying (it stays in EXTERNAL_TREE_PREFIXES and is
// never scoped out): post-2576 it is a 26-line shim plus two near-static hooks — cheap to key
// whole, and nothing else covers it now that the gate logic lives elsewhere.

// Resolve the gate-logic file's content identity at HEAD through the injected git seam (never a
// raw fs path — the same cwd-independence every other probe in this file has). THREE outcomes:
//   { ok: true,  hash: <blob oid> } — the file is in HEAD. The blob oid IS git's own content hash
//                                     of the whole file, so there is nothing to compute: no second
//                                     `git show` spawn, no hand-rolled sha256, and the value is
//                                     exactly what every other keyed path contributes.
//   { ok: true,  hash: 'absent' }   — the file is genuinely not in HEAD (a fixture repo, or a
//                                     sibling that never adopted plan 2576's move). Nothing to
//                                     cover, and absence is content — the same convention
//                                     computeKey's `oids` already uses for a missing path. Such
//                                     repos stay NARROWABLE, so this plan does not silently revoke
//                                     plan 2578's closure scoping wherever the file does not exist
//                                     (the "uncacheable in every repo without the directory"
//                                     objection select-battery-tests.mjs raises against putting
//                                     `scripts/hooks` in EXTERNAL_TREE_PREFIXES does not apply).
//   { ok: false }                   — git itself failed. Genuine doubt: the caller must refuse to
//                                     NARROW the scripts key, so the whole-tree `scripts` oid
//                                     covers this file the pre-2578 way.
// Absence is read off `parseLsTree` — the module's ONE definition of a well-formed ls-tree line —
// rather than a bare emptiness test on raw stdout, so any output this module cannot parse falls to
// `absent`-by-way-of-no-match only when git also produced no matching entry for the path.
//
// Deliberately INDEPENDENT of `gatherRepoState`'s recursive `ls-tree -r -- scripts` walk, which
// does also carry this path: that walk is skipped when `perFileScriptOids` is false, and plan 2578
// pins `universalKeyFor` to be IDENTICAL with and without it (that is what lets `invalidate` mint
// the same universal key `check`/`record` did). Sourcing this component from the walk therefore
// makes the two arms disagree and breaks `invalidate`. One extra short git call is the price of
// that invariant, and dropping the `git show` above already more than pays for it.
export function gateLogicKey(git) {
  let entry;
  try {
    entry = git(['ls-tree', 'HEAD', '--', ...GATE_LOGIC_PATHS]);
  } catch {
    return { ok: false };
  }
  // One `path:oid` field per gate-logic file, in the module's own fixed order — so the hash is a
  // function of content ALONE (never of git's output ordering), and a file moving from present to
  // absent moves the key just as a content edit does.
  const oids = parseLsTree(entry);
  return {
    ok: true,
    hash: GATE_LOGIC_PATHS.map((path) => `${path}:${oids.get(path) ?? 'absent'}`).join(' '),
  };
}

// selection-cover helpers (plan 2279). `claim` ⊆ `run` with universal semantics: a universal run
// proves everything; a universal claim is proven only by a universal run; otherwise plain set
// inclusion. Used in BOTH soundness gates — record's superset pin (the run must prove at least
// the canonical claim) and check's subset gate (a hit may only skip tests the key's claim
// covers).
export function selectionCovers(run, claim) {
  if (isUniversalSelection(run)) return true;
  if (isUniversalSelection(claim)) return false;
  const ran = new Set(run);
  return claim.every((p) => ran.has(p));
}

// --- pure helpers -----------------------------------------------------------

// Normalize the stdin selection: trimmed, de-duplicated, SORTED — node --test outcome is
// order-independent, so two pushes selecting the same set in different orders share a key.
export function normalizeSelection(stdin) {
  const set = new Set();
  for (const raw of String(stdin).split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line) set.add(line);
  }
  return [...set].sort();
}

// Parse `git ls-tree` porcelain output into { path → oid }.
export function parseLsTree(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    // <mode> SP <type> SP <oid> TAB <path>
    const m = /^\d+ (?:blob|tree|commit) ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// The cache key: sha256 over the canonical JSON of every covered component. A path absent from
// HEAD hashes as the literal 'absent' — absence is content too (a deleted .gitattributes must
// not collide with the pre-deletion key). `paths` (plan 2279) is the — possibly scoped — keyed
// path set this key covers; two keys with the same selection but different keyed-path sets can
// never collide because the oids object's own keys differ.
// `gateLogicHash` (plan 2560, retargeted by 2598): the gate-logic file's content — its battery
// block alone when the markers resolve, the whole file otherwise — hashed independently of the
// `oids` mechanism above, because that file cannot join the `ls-tree` pathspec set without
// collapsing it (see gateLogicKey). `null` means either "not attempted" (a caller that never
// resolved it) or "the file could not be read", which is indistinguishable here on purpose:
// `keyForSelection` is the ONLY caller, and it always keys `scripts` WHOLESALE whenever it passes
// null, so the two null causes are never asked to mean different things to the same key.
export function computeKey({
  oids,
  selection,
  nodeMajor,
  gitVersion,
  paths = keyedPaths(),
  gateLogicHash = null,
}) {
  const components = {
    v: KEY_FORMAT_VERSION,
    nodeMajor,
    // The battery spins REAL git repos/worktrees (worktree-guard, coord-git suites), so the
    // installed git binary is content the battery can read too — a git upgrade within the TTL
    // must miss, for the same reason a node major bump must (xhigh review finding, plan 1824).
    gitVersion,
    oids: Object.fromEntries(paths.map((p) => [p, oids.get(p) ?? 'absent'])),
    selection,
    gateLogic: gateLogicHash,
  };
  const key = createHash('sha256').update(JSON.stringify(components)).digest('hex').slice(0, 32);
  return { key, components };
}

// The canonical selection (plan 2279 leak 1): what the battery selector would pick for this
// tree's OWN content diff vs origin/master — merge-base(origin/master, HEAD)..HEAD — instead of
// the push's range. A branch's final force-push and its land's master merge-push carry the same
// content diff, so they derive the SAME canonical selection where their push ranges differ
// (each push's range is an artifact of remote-ref state, not of content). Return values:
//   null  — underivable (no origin/master, git failure): fall back to legacy exact-selection
//           keying, i.e. exactly the pre-2279 behavior;
//   []    — the canonical diff touches no scripts/*.mjs: there is no canonical claim to make
//           (the battery only ran because the push RANGE touched scripts) — legacy keying;
//   UNIVERSAL_SELECTION — the canonical diff cannot be scoped (external-tree touch, an unkeyable
//           nested path — shell/JSON/golden, since plan 4076 widened the entry predicate to nested
//           .mjs MODULES — malformed path, empty selection), mirroring the selector CLI's own
//           full-battery fallbacks so both pushes of identical content bail identically. That
//           mirroring is load-bearing, not cosmetic: the key's `selection` component records WHICH
//           selection the recorded pass proves, so a selector that scoped a nested-module delta
//           while this derivation still bailed UNIVERSAL would record "the whole battery passed"
//           for a run that was only a subset — a false green. The two must widen together, which
//           is why plan 4076 widened the shared `hasNestedScriptChange` rather than adding a
//           selector-only predicate beside it;
//   otherwise the sorted scripts/<name>.test.mjs selection.
// `mergeBase` (plan 2559): an already-resolved oid to use as the baseline INSTEAD of asking
// `git merge-base origin/master HEAD` again — this is what lets `record` key off the SAME
// baseline `check` minted for this exact battery run, immune to a sibling session's `git fetch`
// moving `origin/master` in between (the RECORD-REFUSED reason=key-drift leak, measured 8/218
// records over 3.1 days — docs/coord/land-spine.md § The once-per-land proof cache; plan 2327 measurement). Absent (the
// default) means "resolve it fresh", i.e. exactly today's behavior — this parameter can only PIN
// a value, never suppress or alter the resolution any existing caller relies on.
export function deriveCanonicalSelection(opts = {}) {
  const {
    git,
    scriptsDir = SCRIPTS_DIR_DEFAULT,
    listTests = () => listTestFiles(scriptsDir),
    readSource = makeReadSource(scriptsDir),
    mergeBase,
  } = opts;
  // The pairing discipline's THIRD seam. Enumerating tests is a property of a TREE, exactly as
  // resolving a basename is: a caller that injects a reader for some other tree without naming it
  // AND without supplying that tree's test list has left nothing to enumerate but this process's
  // cwd, and name-pairing alone would then mint a canonical claim over tests the injected tree may
  // not even have (/gpt-review round 5, 6d123d). Refuse to narrow — `null` is legacy keying, which
  // is un-narrowed but never wrong — rather than narrow unsoundly. Naming EITHER the tree or the
  // list is enough, and every production caller names neither (so it reads the ambient tree,
  // paired, exactly as before).
  if (opts.readSource && opts.scriptsDir === undefined && opts.listTests === undefined) return null;
  let diffOut;
  try {
    const base = mergeBase || git(['merge-base', 'origin/master', 'HEAD']).trim();
    if (!base) return null;
    diffOut = git(['diff', '--name-only', base, 'HEAD']);
  } catch {
    return null;
  }
  let paths;
  try {
    paths = parseChangedList(diffOut);
  } catch {
    return [...UNIVERSAL_SELECTION]; // malformed path → selector-CLI parity: the full battery
  }
  if (touchesExternalTree(paths) || hasNestedScriptChange(paths)) return [...UNIVERSAL_SELECTION];
  const changed = changedScriptBasenames(paths);
  if (changed.size === 0) return [];
  let sel;
  try {
    // Paired like every other seam: the canonical CLAIM must be what the selector CLI would
    // actually run, and an unpaired call drops the basename-fallback edges the CLI has — so the
    // claim would be narrower than the run it stands for (/gpt-review round 3, 4b7805 / 4dd15d).
    //
    // The pairing is by CONSTRUCTION, exactly as at closurePathsForSelection (/gpt-review round 4,
    // 015346 / 39d887 / 07bc89): a caller that injects a reader for some other tree WITHOUT naming
    // it gets no index at all, rather than one describing this process's cwd — resolving a
    // basename against the wrong checkout invents edges the injected tree never had. Derived HERE
    // rather than as a default parameter so an unwalkable named tree lands in this function's own
    // fail-safe (`null`, i.e. legacy keying) instead of throwing out of it (81b8c8 / 512d18 /
    // 62d562).
    const basenameIndex =
      opts.basenameIndex ??
      (opts.readSource && opts.scriptsDir === undefined ? undefined : basenameIndexFor(scriptsDir));
    sel = selectTests({ changed, allTests: listTests(), readSource, basenameIndex });
  } catch {
    return null; // fs trouble listing/reading tests — legacy keying, never a guess
  }
  return sel.length === 0 ? [...UNIVERSAL_SELECTION] : sel;
}

// (parseEntry / isLive / makeGit / resolveCacheDir now live in pass-cache-kernel.mjs — identical
//  discipline in both caches, and drifting copies were the debt plan 2492 closed.)

// A minimal sanity check on an operator/hook-pinned merge-base oid (plan 2559): a git object id
// is hex, 4-40 chars (short hashes are valid git refs too). Anything else cannot even be a real
// oid, so it is treated exactly like "not provided" — re-resolve fresh — rather than handing a
// clearly-bogus value to `git diff` and relying on the raw git error for the same fail-safe
// destination. Named explicitly because the plan calls out "unparseable" as its own case.
export function looksLikeOid(s) {
  return typeof s === 'string' && /^[0-9a-f]{4,40}$/i.test(s);
}

// Resolve merge-base(origin/master, HEAD) as its own single-purpose probe (plan 2559) — used by
// `deriveKey` to learn (and let `check` report back) the baseline it derived the canonical
// selection from, so a later `record` call can be handed that EXACT oid instead of re-asking
// origin/master (which a sibling session's `git fetch` may have moved in between). Returns the
// trimmed oid, or '' on any git trouble/empty result — never throws.
export function resolveMergeBaseOid(git) {
  try {
    return git(['merge-base', 'origin/master', 'HEAD']).trim();
  } catch {
    return '';
  }
}

// --- git seam ----------------------------------------------------------------

// The shared repo-state probe both key arms need: clean-tree check, HEAD oids, tool versions.
// The status check and the ls-tree deliberately run over the FULL unscoped path set even when
// scoping will drop a prefix from the key — a strictly-stricter dirt refusal is the simple,
// deterministic choice (the leak plan 2279 closes is master-side CONTENT movement, not dirt),
// and the oid superset lets the canonical and universal key arms share ONE git probe.
// `perFileScriptOids` (plan 2578 review finding): the recursive `ls-tree -r` below enumerates every
// blob under scripts/ (~350 entries) and is ONLY consumable by a closure-scoped key. A caller that
// can only ever build the UNIVERSAL key — `invalidate`, which needs `universalKeyFor(state)` and
// nothing else — passes false and skips the spawn entirely, on the pre-push hot path where a red
// battery already costs enough. Default true: every existing caller keeps today's behavior.
// `scopedPrefixes` (plan 4071 review finding 859192): a project's CONFIGURED scoped prefix (e.g.
// `backend/`) is not necessarily also an EXTERNAL_TREE_PREFIXES entry — that membership happens
// to hold for vetapp's own `backend/` row today (both lists carry it), which is exactly what let
// this gap ship unnoticed. Without threading it here, a configured prefix that names a tree
// EXTERNAL_TREE_PREFIXES does not cover would have neither dirty-status coverage nor a HEAD oid
// in `state.oids` — edits under it could not move the key, so a stale green could be served
// forever. Merged into the SAME unscoped path set `keyedPaths` already gathers (a `Set` under the
// hood, so a prefix already present via EXTERNAL_TREE_PREFIXES is not asked for twice) — never
// constrained to require prior EXTERNAL_TREE_PREFIXES membership, because the point of a
// project-supplied scoped prefix is to name a tree of the project's own choosing.
export function gatherRepoState(
  git,
  { perFileScriptOids = true, scopedPrefixes = CORE_SCOPED_PREFIXES } = {},
) {
  const paths = keyedPaths([...EXTERNAL_TREE_PREFIXES, ...scopedPrefixes]);
  let status;
  try {
    status = git(['status', '--porcelain', '--untracked-files=normal', '--', ...paths]);
  } catch (e) {
    return { ok: false, reason: `git-status-failed: ${e.message}` };
  }
  if (status.trim() !== '') {
    // ANY dirt (tracked modification, untracked file) in a keyed path means the working tree —
    // what the battery actually reads — is not the HEAD content we would key on. Refuse.
    return { ok: false, reason: 'dirty-gated-paths' };
  }
  // plan 4071 review finding 9179f0/99567b: an ANCESTOR and a nested DESCENDANT pathspec (e.g. a
  // configured `backend/` alongside `backend/scripts/`) cannot be resolved in the SAME `git
  // ls-tree` call — the descendant forces git to recurse to satisfy it, and the ancestor's own
  // top-level tree entry silently drops out of the output (verified against this repo: `git
  // ls-tree HEAD -- backend backend/scripts` lists every child of `backend` EXCEPT `backend`
  // itself). The old code read that gap via `oids.get(p) ?? 'absent'` with no way to tell "genuinely
  // absent from HEAD" apart from "masked by a sibling pathspec" — so the ancestor keyed as
  // 'absent' permanently, and a content change under it that the descendant doesn't also cover
  // could never move the key. Fixed two ways: (1) the pathspec actually SENT to this combined call
  // drops any path whose ancestor is ALSO being queried (longest-first, so a chain of nested
  // ancestors collapses to just the top), which keeps the common (non-nested) case at one spawn
  // and already avoids the masking for it; (2) every path this repo was asked to key on is then
  // checked against the result, and anything not found there — a path dropped by (1), or one this
  // combined call simply never returned — gets its OWN single-pathspec `ls-tree` probe, which
  // cannot be masked by any sibling. "Not in the map" can therefore never again mean anything but
  // "this exact path, queried alone, is confirmed absent from HEAD".
  const queryPaths = [];
  for (const p of [...paths].sort((a, b) => a.length - b.length)) {
    if (queryPaths.some((q) => p.startsWith(`${q}/`))) continue;
    queryPaths.push(p);
  }
  let lsTree;
  try {
    lsTree = git(['ls-tree', 'HEAD', '--', ...queryPaths]);
  } catch (e) {
    return { ok: false, reason: `git-ls-tree-failed: ${e.message}` };
  }
  const oids = parseLsTree(lsTree);
  for (const p of paths) {
    if (oids.has(p)) continue;
    let solo;
    try {
      solo = git(['ls-tree', 'HEAD', '--', p]);
    } catch (e) {
      return { ok: false, reason: `git-ls-tree-failed: ${e.message}` };
    }
    oids.set(p, parseLsTree(solo).get(p) ?? 'absent');
  }
  if (oids.get('scripts') === 'absent') {
    // No scripts tree = not the repo shape this cache understands. Refuse rather than key on it.
    return { ok: false, reason: 'no-scripts-tree' };
  }
  // plan 2560: individual scripts/<name> blob oids, so a per-selection closure can key ONE file
  // instead of the whole tree. Best-effort and SEPARATE from the refusal above — a failure here
  // only means closure-scoped keying is unavailable this run (keyForSelection then falls back to
  // the whole-tree 'scripts' oid already gathered above, exactly the pre-2560 key); it must never
  // silently key a path 'absent' that this run simply failed to probe (a false key, not a false
  // green, but the file it should have named would then be invisible to `oid-moved` attribution).
  let scriptOidsOk = false;
  try {
    if (perFileScriptOids) {
      for (const [p, oid] of parseLsTree(git(['ls-tree', '-r', 'HEAD', '--', 'scripts']))) {
        oids.set(p, oid);
      }
      scriptOidsOk = true;
    }
  } catch {
    /* closure-scoped keying unavailable this run — the whole-tree fallback still covers it */
  }
  // plan 2560, retargeted by 2598: the gate-logic file `scripts/hooks/pre-push.sh` — its battery
  // block when the markers resolve, the whole file otherwise. Deliberately NOT part of the
  // `paths` pathspec above (that would collapse the `scripts` tree entry — see gateLogicKey).
  // Never throws; `{ ok: false }` is the do-not-narrow signal keyForSelection reads. Deliberately
  // INDEPENDENT of `perFileScriptOids`/`scriptOidsOk` — plan 2578 pins `universalKeyFor` to be
  // identical with and without the per-file probe, so a component that only resolved on one arm
  // would break `invalidate`'s ability to mint the same universal key `check`/`record` did.
  const gateLogic = gateLogicKey(git);
  let gitVersion;
  try {
    gitVersion = git(['version']).trim();
  } catch (e) {
    return { ok: false, reason: `git-version-failed: ${e.message}` };
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  return { ok: true, oids, gitVersion, nodeMajor, scriptOidsOk, gateLogic };
}

// One key for one key-selection over an already-gathered state. Attribution trouble keys every
// scoped prefix — the pre-2279 unscoped key, never a narrower one. `scriptOidsOk`/`gateLogic`
// (plan 2560, retargeted by 2598; both optional so a caller building a bare `state` by hand — as
// several unit tests do — gets the pre-2560 whole-tree behavior by default) drive the two
// independent scoping axes above. The fourth argument carries BOTH axes, which arrived from
// two plans at once: `scriptsDir` (plan 4085) names the tree, and `scopedPrefixes` (plan 4071
// T2) is the merged core+project list a caller resolved from coord.config.json — a caller with
// no config gets the core list. They are independent, so neither defaults the other.
export function keyForSelection(state, keySelection, readSource, treeOpts = {}) {
  const { scopedPrefixes = CORE_SCOPED_PREFIXES } = treeOpts;
  // ONE tree for BOTH halves. The closure half below threads `treeOpts`; passing only the reader
  // here let its own default read the AMBIENT scripts/ tree, so a caller who NAMED a tree without
  // injecting a reader got its scoped prefixes attributed from this process's checkout and its
  // scripts/ closure from the named one. A prefix the named tree reads but the ambient copy does
  // not was then scoped OUT, and an edit under it recomputed the same key — a stale HIT for
  // changed content (/gpt-review round 6, 1f80a6). Derived exactly as `deriveKey` and
  // `closurePathsForSelection` do it: an injected reader wins, else read the named tree.
  const reachReadSource = readSource ?? makeReadSource(treeOpts.scriptsDir ?? SCRIPTS_DIR_DEFAULT);
  let reach;
  try {
    reach = reachableScopedPrefixes(keySelection, {
      readSource: reachReadSource,
      scopedPrefixes,
    });
  } catch {
    reach = [...scopedPrefixes];
  }
  // plan 2598: `.husky/` is NEVER scoped out any more. Until 2576 it held the gate logic and a
  // resolvable block hash could stand in for it; post-2576 it is a dispatcher shim plus two
  // near-static hooks that nothing else in this key covers, so it stays wholesale.
  const scopedOut = scopedPrefixes.filter((p) => !reach.includes(p));

  // plan 2560: scripts/ closure scoping. Only attempted when the individual-file oid probe
  // succeeded (scriptOidsOk) — otherwise there is nothing sound to key those paths on, and the
  // whole-tree 'scripts' oid gathered above is used instead, exactly as before this plan.
  //
  // plan 2598: AND only when the gate-logic file resolved. The closure walk reaches flat
  // `scripts/*.mjs` files only, so a narrowed `scripts` key covers `scripts/hooks/pre-push.sh`
  // through the `gateLogic` component alone; if that component is unavailable, narrowing would
  // leave the file covered by nothing at all. Falling back to the whole-tree `scripts` oid keys
  // it (or its absence) the pre-2578 way — un-narrowable, never uncacheable.
  //
  // ONE resolution of the gate-logic component, read by both the narrowing gate and the key
  // itself: they are two consequences of the same fact, and letting them re-derive it separately
  // is how a later edit silently narrows the key while dropping the component that justifies it.
  const gateLogicHash = state.gateLogic?.ok ? state.gateLogic.hash : null;

  let scriptsPaths = ['scripts'];
  if (state.scriptOidsOk && gateLogicHash !== null) {
    let closure;
    try {
      // Thread the TREE, not just the reader: closurePathsForSelection derives the basename index
      // from it, and a reader handed over without its tree deliberately yields no index at all.
      closure = closurePathsForSelection(keySelection, { readSource, ...treeOpts });
    } catch {
      closure = { ok: false, reason: 'closure-threw' };
    }
    // A narrowed key is sound only if EVERY path it narrows to can actually be KEYED. computeKey
    // maps a path with no oid to the constant 'absent' (see its own line), so a closure member git
    // does not report contributes a component that can never change: editing that file recomputes
    // the same key and serves a HIT for changed content. Two shapes reach here —
    //   · a git-IGNORED module admitted by the basename index's filesystem walk, which has no git
    //     knowledge at all; oids come from `git ls-tree -r HEAD` and the dirt probe runs
    //     `--untracked-files=normal`, which does not report ignored files (round 6, 8fe740);
    //   · a DELETED module, which selectTests deliberately folds back in via indexWithKeys so it
    //     still selects its dependents, while this cache half never did — the two-views drift
    //     this plan's own T3 forbids (round 6, 1585a0).
    // Both are closed by requiring keyability rather than by teaching the index about git, which
    // would put a second, drifting copy of git's tracking rules in the selector. Falling back to
    // the whole-tree `scripts` oid is this module's standing safe direction: un-narrowed, never
    // uncacheable, never a false green. The normal path is unaffected — every tracked closure
    // member has an oid — so this costs no hit rate where narrowing was already sound.
    if (closure.ok && closure.paths.every((p) => state.oids.has(p))) scriptsPaths = closure.paths;
  }

  // plan 4071 review finding 859192: the prefix LIST offered to keyedPaths must include
  // scopedPrefixes itself, not just EXTERNAL_TREE_PREFIXES — otherwise a configured prefix that
  // is not ALSO an EXTERNAL_TREE_PREFIXES entry could never appear in `paths` at all, no matter
  // how `scopedOut` is computed, and its HEAD oid (now gathered into `state.oids` by
  // gatherRepoState) would simply never be READ into the key. Deduplicated via the Set inside
  // keyedPaths, so a scopedPrefix that already IS an EXTERNAL_TREE_PREFIXES entry (every one
  // vetapp configures today) changes nothing about the resulting path set.
  const paths = keyedPaths([...EXTERNAL_TREE_PREFIXES, ...scopedPrefixes], scopedOut, scriptsPaths);
  return computeKey({
    oids: state.oids,
    selection: keySelection,
    nodeMajor: state.nodeMajor,
    gitVersion: state.gitVersion,
    paths,
    // Included whenever it resolved, narrowed or not. On a whole-tree `scripts` key it is
    // redundant (the tree oid already covers the file) but never wrong; on a narrowed key it is
    // the ONLY thing covering the gate logic.
    gateLogicHash,
  });
}

// Compute the PRIMARY key for the CURRENT repo state, or refuse. Returns
//   { ok: true, key, components, state, keySelection, mode, mergeBase }
//   | { ok: false, reason }
// The key's selection component is the CANONICAL selection when one is derivable and non-empty
// (mode 'canonical' / 'canonical-universal' — a branch push and its land's merge-push then mint
// the same key for identical content, plan 2279 leak 1); otherwise the push's own selection
// (mode 'legacy' — exactly the pre-2279 key, still used by repos without origin/master and by
// pushes whose canonical diff carries no scripts). Refusal reasons are strings for the telemetry
// line; every refusal means UNCACHEABLE. `canonical` may be injected for tests (undefined =
// derive here; null/array = use as-is).
// `mergeBase` (plan 2559): an already-resolved oid to PIN as the canonical-selection baseline —
// threaded in by `record` from the oid `check` resolved for this exact battery run, so the two
// key off the SAME baseline even if a sibling's `git fetch` moved `origin/master` while the
// battery ran (today's RECORD-REFUSED reason=key-drift). Ignored (falls back to a fresh resolve)
// when absent or when it fails `looksLikeOid` — the fail-closed direction the plan requires: a
// missing/unparseable pin can only WIDEN the drift exposure back to today's baseline, never mint
// an unverified key. Resolved ONCE here (whether pinned or fresh) and handed to
// `deriveCanonicalSelection` so it never re-asks git for the same answer.
export function deriveKey({
  git,
  selection,
  canonical,
  mergeBase,
  scriptsDir,
  readSource,
  scopedPrefixes = CORE_SCOPED_PREFIXES,
}) {
  // Do NOT default scriptsDir here. Defaulting it would hand keyForSelection a tree the caller
  // never named, which is exactly how an injected reader gets silently "paired" with the ambient
  // scripts index — the disguise finding 2f8730 / 5847ba / cb102d names. An unnamed tree stays
  // unnamed all the way down, where closurePathsForSelection declines to narrow; when this
  // function OWNS the reader, it owns the tree too and the two are paired by construction.
  const tree = scriptsDir ?? (readSource ? undefined : SCRIPTS_DIR_DEFAULT);
  // When this function owns the reader it owns the tree too, so the reader must read the tree the
  // caller NAMED — `SCRIPTS_DIR_DEFAULT` here made `deriveKey({ scriptsDir })` read the ambient
  // checkout while every seam below was handed `tree`, which un-narrows the key to the whole
  // `scripts` oid (/gpt-review round 4, 656499 / e5df98 / d19669 / 681e32 / 6949cd / 7c8dfe).
  readSource = readSource ?? makeReadSource(scriptsDir ?? SCRIPTS_DIR_DEFAULT);
  if (selection.length === 0) return { ok: false, reason: 'empty-selection' };
  // scopedPrefixes threaded through (plan 4071 review finding 859192) so the gathered state
  // covers every path the selection can be keyed on below, not just EXTERNAL_TREE_PREFIXES.
  const state = gatherRepoState(git, { scopedPrefixes });
  if (!state.ok) return state;
  const pinnedBase = looksLikeOid(mergeBase) ? mergeBase : undefined;
  const usedBase = pinnedBase ?? resolveMergeBaseOid(git);
  // ONE readSource for both consumers: the canonical derivation's selector reads and the
  // prefix-attribution scan share its per-file cache (and a test-injected fake reaches both).
  const canon =
    canonical !== undefined
      ? canonical
      : // Thread the TREE alongside the reader, for the same reason keyForSelection does: the
        // canonical derivation resolves basenames too, and a reader handed over without its tree
        // must get no index rather than the ambient one (/gpt-review round 4, 01cfad / 5e0e5d /
        // 646eaf / 4cf5de). `tree` is deliberately `undefined` for an unnamed injected reader —
        // that is the signal, not an omission.
        deriveCanonicalSelection({
          git,
          readSource,
          scriptsDir: tree,
          mergeBase: usedBase || undefined,
        });
  const canonicalMode = Array.isArray(canon) && canon.length > 0;
  const keySelection = canonicalMode ? canon : selection;
  const mode = canonicalMode
    ? isUniversalSelection(canon)
      ? 'canonical-universal'
      : 'canonical'
    : 'legacy';
  const { key, components } = keyForSelection(state, keySelection, readSource, {
    scriptsDir: tree,
    scopedPrefixes,
  });
  // mergeBase: null (not '') when underivable — a clean "no baseline" value distinct from an
  // empty-string flag, and what `check` writes to --merge-base-out as the empty file the hook's
  // fallback reads as "not provided".
  return { ok: true, key, components, state, keySelection, mode, mergeBase: usedBase || null };
}

// The universal-twin key for an already-gathered state — ONE definition for check's fallback
// arm, record's twin write, and invalidate's twin drop, so the three can never drift on what
// "the universal key" means. (No readSource: a universal selection attributes every scoped
// prefix without reading a single test source.)
export function universalKeyFor(state, scopedPrefixes = CORE_SCOPED_PREFIXES) {
  return keyForSelection(state, [...UNIVERSAL_SELECTION], undefined, { scopedPrefixes });
}

// --- fs ops -------------------------------------------------------------------
// (entryPath / readCacheEntry / writeCacheEntry / removeCacheEntry / pruneExpired / logTelemetry
//  now live in pass-cache-kernel.mjs — see the import block at the top.)

// Attribute a MISS (plan 2279 leak 3): why did no live entry satisfy this key? Compares the
// stored `components` of live same-format siblings against ours — pure telemetry, best-effort,
// never load-bearing. Priority: an on-disk-but-expired exact entry > content movement
// (`oid-moved:<path>`, naming the first differing SHARED keyed path — the leak-2 signature) >
// `sel-mismatch` (identical content keyed under a different selection — the leak-1 signature) >
// `no-entry`. Bounded: the sibling scan reads every live entry, so a runaway dir (prune only
// runs on `record`) degrades to `no-entry` instead of stalling every check.
const MAX_ATTRIBUTION_SCAN = 200;
export function attributeMiss(cacheDir, derived, nowMs, ttlMin = DEFAULT_TTL_MIN) {
  try {
    const exact = parseEntry(readFileSync(entryPath(cacheDir, derived.key), 'utf8'));
    if (exact && !isLive(exact, nowMs, ttlMin)) return 'expired';
  } catch {
    /* absent — fall through to the sibling scan */
  }
  let names = [];
  try {
    names = readdirSync(cacheDir).filter((n) => n.endsWith('.json'));
  } catch {
    return 'no-entry';
  }
  if (names.length > MAX_ATTRIBUTION_SCAN) return 'no-entry';
  const mine = derived.components;
  let oidMoved = null;
  let selMismatch = false;
  for (const name of names) {
    const e = readCacheEntry(cacheDir, name.replace(/\.json$/, ''));
    if (!isLive(e, nowMs, ttlMin) || !e.components) continue;
    const c = e.components;
    // Only same-format, same-toolchain siblings attribute cleanly — anything else would blame
    // "oid moved" for what is really a version/env difference.
    if (c.v !== mine.v || c.nodeMajor !== mine.nodeMajor || c.gitVersion !== mine.gitVersion)
      continue;
    const sameSel = JSON.stringify(c.selection) === JSON.stringify(mine.selection);
    // Only paths BOTH key sets cover can evidence content movement — per-selection scoping means
    // two same-selection entries may key different path SETS, and an absent-vs-present pair is
    // key-set drift, not an oid move (sorted, it would mask a real shared-path change behind an
    // alphabetically-earlier scope difference — xhigh review finding, plan 2279).
    const shared = Object.keys(mine.oids)
      .filter((p) => (c.oids ?? {})[p] !== undefined)
      .sort();
    const movedPath = shared.find((p) => c.oids[p] !== mine.oids[p]);
    if (sameSel && movedPath && !oidMoved) oidMoved = movedPath;
    if (!sameSel && !movedPath) selMismatch = true;
  }
  if (oidMoved) return `oid-moved:${oidMoved}`;
  if (selMismatch) return 'sel-mismatch';
  return 'no-entry';
}

// record/invalidate share ONE --key presence/shape guard so the two close-out commands can
// never drift on what counts as a usable key (xhigh review finding, plan 1824).
function usableKeyFlag(key, cmdName) {
  if (typeof key === 'string' && key && !key.startsWith('--')) return true;
  console.error(`battery-pass-cache: ${cmdName} needs --key <key> — nothing done`);
  return false;
}

// `check --merge-base-out <file>` (plan 2559): OPTIONAL, unlike gate-pass-cache's mandatory
// `--out` — most callers (every existing test, any direct CLI use) never pass it, and check must
// keep working exactly as before when they don't. Writes the oid `deriveKey` used (or '' when
// underivable/refused) so the hook can thread it into the later `record --merge-base` call.
// Best-effort: a write failure (bad path, readonly fs) must never fail `check` itself — the hook
// would simply read an absent/empty file later and fall back to record's own fresh resolve.
function writeMergeBaseOut(flags, mergeBase) {
  const out = flags['merge-base-out'];
  if (typeof out !== 'string' || !out || out.startsWith('--')) return;
  try {
    writeFileSync(out, mergeBase ?? '');
  } catch {
    /* best-effort — see comment above */
  }
}

// --- CLI ----------------------------------------------------------------------

export function main() {
  const { cmd, flags } = parseLockArgs(process.argv.slice(2), CACHE_ARG_SPEC);
  if (!cmd) {
    console.error('battery-pass-cache: no command (check|record|invalidate|status|path)');
    return EXIT_UNCACHEABLE;
  }
  const git = makeGit();
  const cacheDir = resolveCacheDir(git);
  // Resolve the project's scoped prefixes ONCE, here — this is the CLI entry point plan 4071's
  // Rule 1 carves out ("the chain genuinely terminates at a CLI entry point whose only caller is
  // the shell, that entry point resolves the config once and passes it down"). The root is
  // anchored on this module's OWN `scripts/` ancestor (scripts-anchor.mjs), never a fixed `..`
  // count, so the resolution survives this module moving one directory deeper.
  const scopedPrefixes = scopedPrefixesFor(
    loadCoordConfig(repoRootFrom(import.meta.dirname)).batteryScopedPrefixes,
  );
  if (cmd === 'path') {
    console.log(cacheDir);
    return 0;
  }
  const ttlMin = (() => {
    const raw = flags['ttl-min'];
    const n = Number(raw ?? DEFAULT_TTL_MIN);
    if (!Number.isFinite(n) || n < 0)
      throw new Error(`--ttl-min must be a non-negative number, got ${JSON.stringify(raw)}`);
    return n;
  })();

  if (cmd === 'status') {
    let names = [];
    try {
      names = readdirSync(cacheDir).filter((n) => n.endsWith('.json'));
    } catch {
      /* no dir yet */
    }
    const nowMs = Date.now();
    let shown = 0;
    for (const name of names) {
      // readCacheEntry (the check path's own read) already treats an unreadable/corrupt entry as
      // absent — reuse it so a race with a sibling's record/prune skips the vanished entry and
      // lists the rest, with ONE hardening site instead of two (delta-review finding, plan 1824).
      const entry = readCacheEntry(cacheDir, name.replace(/\.json$/, ''));
      if (isLive(entry, nowMs, ttlMin)) {
        console.log(
          `${name.replace(/\.json$/, '')} pass @ ${entry.iso} (${entry.label ?? '?'}, host ${entry.host ?? '?'})`,
        );
        shown += 1;
      }
    }
    if (shown === 0) console.log('empty');
    return 0;
  }

  if (cmd === 'check') {
    if (process.env.PREPUSH_NO_BATTERY_CACHE === '1') {
      // Defense in depth — the hook also guards this, but a future caller must not be able to
      // bypass the kill-switch by invoking the script directly.
      writeMergeBaseOut(flags, '');
      logTelemetry(cacheDir, 'UNCACHEABLE reason=disabled-by-env');
      return EXIT_UNCACHEABLE;
    }
    const selection = normalizeSelection(readStdin());
    const derived = deriveKey({ git, selection, scopedPrefixes });
    // plan 2559: write the merge-base oid `deriveKey` used (empty when underivable/refused) — on
    // EVERY exit path, one call site, so `record`'s later fallback logic is symmetric regardless
    // of whether this check HIT, MISSed, or was refused outright.
    writeMergeBaseOut(flags, derived.mergeBase);
    if (!derived.ok) {
      console.error(`battery-pass-cache: uncacheable — ${derived.reason}`);
      logTelemetry(cacheDir, `UNCACHEABLE reason=${derived.reason.split(':')[0]}`);
      return EXIT_UNCACHEABLE;
    }
    // stdout is the key and ONLY the key — the hook captures it. Printed per-outcome so it
    // always names the entry that decided: the primary key on a primary HIT and on a MISS (the
    // key a green run will `record --key` under), the TWIN key on a universal-fallback HIT
    // (xhigh review finding, plan 2279 — the primary key would name a different, non-matching
    // entry there).
    const nowMs = Date.now();
    // Subset gate (plan 2279): a primary-key hit skips every test in `selection`, so it is only
    // sound when the key's claim covers them all. Under the hook's union input this holds by
    // construction on land merge-pushes (range == canonical there); it FAILS when the push range
    // selects tests outside the canonical claim (e.g. a force-push range sweeping master-side
    // scripts churn) — those must miss the canonical arm and fall through to the universal one.
    const claimCovers = selectionCovers(derived.keySelection, selection);
    if (claimCovers) {
      const entry = readCacheEntry(cacheDir, derived.key);
      if (isLive(entry, nowMs, ttlMin)) {
        console.log(derived.key);
        console.error(
          `battery-pass-cache: HIT — identical gated content + selection passed @ ${entry.iso} (${entry.label ?? '?'})`,
        );
        logTelemetry(
          cacheDir,
          `HIT key=${derived.key} sel=${selection.length} mode=${derived.mode}`,
        );
        return EXIT_HIT;
      }
    }
    // Universal fallback (plan 2279): a green FULL-glob run records a twin entry under the
    // universal key (all prefixes keyed, claim = everything) — sound to satisfy ANY selection of
    // the same content. This also preserves the pre-2279 repeated-full-run hit.
    if (!isUniversalSelection(derived.keySelection)) {
      const uni = universalKeyFor(derived.state, scopedPrefixes);
      const uniEntry = readCacheEntry(cacheDir, uni.key);
      if (isLive(uniEntry, nowMs, ttlMin)) {
        console.log(uni.key);
        console.error(
          `battery-pass-cache: HIT — a full battery of identical gated content passed @ ${uniEntry.iso} (${uniEntry.label ?? '?'}, universal)`,
        );
        logTelemetry(cacheDir, `HIT key=${uni.key} sel=${selection.length} mode=universal`);
        return EXIT_HIT;
      }
    }
    console.log(derived.key);
    const reason = claimCovers
      ? attributeMiss(cacheDir, derived, nowMs, ttlMin)
      : 'run-exceeds-canonical';
    logTelemetry(
      cacheDir,
      `MISS key=${derived.key} sel=${selection.length} mode=${derived.mode} reason=${reason}`,
    );
    return EXIT_MISS;
  }

  if (cmd === 'record') {
    // Close-out path: like battery-lock release, this must never block a push — every refusal is
    // a logged no-op, exit 0.
    const key = flags.key;
    if (!usableKeyFlag(key, 'record')) return 0;
    if (flags['ttl-min'] != null)
      console.error(
        'battery-pass-cache: note — record ignores --ttl-min (its prune always sweeps under the default policy so it can never evict another session’s live entry)',
      );
    const selection = normalizeSelection(readStdin());
    // plan 2559: --merge-base pins the SAME baseline check resolved, so a sibling's `git fetch`
    // moving origin/master while the battery ran cannot re-derive a different canonical selection
    // (and hence a different key) out from under this record. Absent/unparseable falls back to
    // deriveKey's own fresh resolve — exactly today's (possible-key-drift) behavior; the pin can
    // only remove that exposure, never introduce an unverified key (deriveKey's own `derived.key
    // !== key` check below still catches a stale/tampered pin, same as any other content drift).
    const derived = deriveKey({ git, selection, mergeBase: flags['merge-base'], scopedPrefixes });
    if (!derived.ok) {
      console.error(`battery-pass-cache: not recording — ${derived.reason}`);
      logTelemetry(cacheDir, `RECORD-REFUSED reason=${derived.reason.split(':')[0]}`);
      return 0;
    }
    if (derived.key !== key) {
      // The gated content changed between the hook's `check` and this record — the battery tested
      // a state we can no longer name. Recording under EITHER key would be unsound.
      console.error(
        'battery-pass-cache: not recording — gated content changed while the battery ran (key mismatch)',
      );
      logTelemetry(cacheDir, `RECORD-REFUSED reason=key-drift`);
      return 0;
    }
    // plan 2279 SOUNDNESS PIN: a pass may only be recorded under a canonical claim the run
    // actually proves — the RAN selection must cover the key's selection. Under the hook's
    // union input this holds by construction (selector monotonicity); this is the
    // belt-and-suspenders enforcement for any other caller.
    if (!selectionCovers(selection, derived.keySelection)) {
      console.error(
        'battery-pass-cache: not recording — the run selection does not cover the canonical claim (never record a broader claim than the run proves)',
      );
      logTelemetry(cacheDir, `RECORD-REFUSED reason=sel-not-superset`);
      return 0;
    }
    const base = {
      iso: new Date().toISOString(),
      host: hostname(),
      pid: process.pid,
      label: flags.label ?? 'battery',
      selectionRan: selection,
    };
    writeCacheEntry(cacheDir, key, {
      ...base,
      selection: derived.keySelection,
      mode: derived.mode,
      components: derived.components,
    });
    // Universal twin (plan 2279): a green FULL-glob run proves every test file, so it also earns
    // the universal-key entry check's fallback arm reads — without this, a full run forced by
    // range-side churn (external-tree bail) records only its canonical claim and a repeat
    // full-glob push of identical content would re-run.
    if (isUniversalSelection(selection) && !isUniversalSelection(derived.keySelection)) {
      const uni = universalKeyFor(derived.state, scopedPrefixes);
      writeCacheEntry(cacheDir, uni.key, {
        ...base,
        selection: [...UNIVERSAL_SELECTION],
        mode: 'universal-twin',
        components: uni.components,
      });
      logTelemetry(cacheDir, `RECORD key=${uni.key} sel=universal-twin`);
    }
    // Prune under the DEFAULT policy, never this invocation's --ttl-min: the override scopes
    // this command's own judgment, and must not evict OTHER sessions' entries that are still
    // live under the documented TTL (xhigh review finding, plan 1824). Throttled by entry count
    // (plan 2492) so the common close-out does not parse every sibling on every record.
    pruneExpired(cacheDir, Date.now(), DEFAULT_TTL_MIN, { minEntries: PRUNE_MIN_ENTRIES });
    logTelemetry(cacheDir, `RECORD key=${key} sel=${selection.length} mode=${derived.mode}`);
    console.error(`battery-pass-cache: recorded pass ${key}`);
    return 0;
  }

  if (cmd === 'invalidate') {
    const key = flags.key;
    if (!usableKeyFlag(key, 'invalidate')) return 0;
    let removed = false;
    try {
      removed = removeCacheEntry(cacheDir, key);
    } catch {
      removed = false; // malformed key ⇒ nothing to remove; close-out never blocks
    }
    logTelemetry(cacheDir, `INVALIDATE key=${key} removed=${removed}`);
    console.error(`battery-pass-cache: ${removed ? 'invalidated' : 'no entry for'} ${key}`);
    // plan 2279: a red run must also drop the universal twin for the CURRENT content — check's
    // fallback arm would otherwise re-HIT an unchanged re-push of content whose battery just
    // failed. Best-effort close-out: a dirty tree / git error simply skips it (the tree then no
    // longer names the failed content anyway, so no key derived from it could resurrect a skip).
    try {
      // Only the UNIVERSAL key is built here, so the per-file scripts oids can never be consulted
      // — skip that recursive ls-tree (plan 2578 review finding). scopedPrefixes threaded through
      // (plan 4071 review finding 859192) so this state's oids match what record's universal-twin
      // write used — otherwise a configured prefix outside EXTERNAL_TREE_PREFIXES could make this
      // arm mint a DIFFERENT "universal" key than record did, and the twin it means to drop would
      // never be found.
      const state = gatherRepoState(git, { perFileScriptOids: false, scopedPrefixes });
      if (state.ok) {
        const uni = universalKeyFor(state, scopedPrefixes);
        if (uni.key !== key && removeCacheEntry(cacheDir, uni.key)) {
          logTelemetry(cacheDir, `INVALIDATE key=${uni.key} removed=true (universal twin)`);
          console.error(`battery-pass-cache: invalidated universal twin ${uni.key}`);
        }
      }
    } catch {
      /* close-out never blocks */
    }
    return 0;
  }

  console.error(`battery-pass-cache: unknown command "${cmd}"`);
  return EXIT_UNCACHEABLE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (e) {
    // Any unexpected crash is fail-SAFE: `check` callers read non-zero as "no cache, run the
    // battery"; `record`/`invalidate` callers `|| true` the call anyway.
    console.error('battery-pass-cache:', e.message);
    process.exit(EXIT_UNCACHEABLE);
  }
}
