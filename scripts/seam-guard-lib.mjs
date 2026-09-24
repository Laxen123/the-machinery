// Shared range-guard scaffolding for the assert-*-seam pre-push lints (plan 1693).
//
// assert-seed-io-seam.mjs and assert-price-write-seam.mjs are independent gates
// (different scope, different violation pattern, different allowlist, different
// message text) that happened to be built by mirroring one file into the other
// (plan 1665 D7), so ~200 lines of diff-parsing scaffolding — inScope,
// loadAllowlist, findViolations' hunk-walking core, and main()'s range
// resolution / SKIP-on-unresolvable-base / allowlist-missing handling — were
// duplicated byte-for-byte. This module is the ONE home for that scaffolding;
// each guard calls makeSeamGuard() with its own scope/pattern/message config and
// stays a thin caller. A fix to the shared loop (e.g. a rename-detection edge
// case) now lands once instead of needing a hand-port to both guards.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { git, errText, resolveGuardRanges } from './coord/coord-git.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Shared unified-diff walker (plan 1708 F3): owns ALL header/hunk-state parsing
// for the four `--unified=0` diff-scoped pre-push gates that used to hand-copy
// the same inHunk/@@/`diff --git` state machine — this file's own
// findViolations below, assert-pipeline-field-specreview.mjs's detectFieldFlips,
// assert-price-gates-single-site.mjs's scanDiffs, and assert-color-tokens.mjs's
// findViolations (plan 1657 original). Before this extraction a parsing fix
// (the plan-1708 `+++`-vs-`++`-content collision) needed a hand-port to all
// four; now it lands once here. Each caller supplies only its own
// added/removed-line callbacks and does its own scope/pattern matching on the
// content it's handed — the walker owns diff STRUCTURE only, never a caller's
// scope rules.
//
// Positional hunk-state parsing: a unified diff's `--- `/`+++ ` file headers
// only ever appear in the pre-hunk preamble, so BOTH `--- ` and `+++ ` are
// recognised as file headers ONLY while `!inHunk`. Once an `@@` hunk header is
// seen, every `+`/`-`-prefixed line is real hunk content — including one whose
// own content starts with `++` (a prefix-increment, `++x` or spaced `++ x`) or
// `--` (a prefix-decrement, `--x` or spaced `-- x`), either of which would
// otherwise collide with the `+++ `/`--- ` header sentinels and get misread as
// one (plan 1708: silently dropped the line, and on the spaced form corrupted
// the tracked file path for the rest of the hunk).
//
// Whole-file DELETION (plan 1708 review round 2, finding A): a deletion diff's
// headers are `--- a/<path>` / `+++ /dev/null`, so the `+++ ` target (`current`)
// is null for the whole section — every one of its lines is a REMOVED line, so
// reporting `file = null` to onRemovedLine silently hid every removed line from
// scope/pattern-matching callers (e.g. detectFieldFlips's pipeline-owned-field
// flip detection never saw a field deleted via whole-file deletion, despite the
// gate's own docstring promising removed-only lines are conservatively treated
// as flips). Fixed by tracking the `--- a/<path>` OLD path too, and reporting
// removed lines under `current ?? oldPath` — the `+++ ` target when there is
// one (identical to before, for every ordinary modify/rename), falling back to
// the old path only when `+++ ` is `/dev/null`. Added-line semantics are
// unchanged: an added line in a normal or new-file section keeps the `+++ `
// target verbatim, and `/dev/null` can never own an added line (a pure
// deletion's hunks are removed-only by construction).
//
// Callbacks receive (content, file): `content` is the line with its leading
// `+`/`-` stripped (never the raw diff line, so a caller never has to re-slice
// it); `file` is scope-neutral (null when out of a hunk's preamble, or — for
// an added line only — when the `+++ ` target is `/dev/null`). Callers apply
// their own inScope()/isExempt()/allowlist filtering on `file`; the walker
// itself has no notion of scope.
export function walkUnifiedDiff(diffText, { onAddedLine, onRemovedLine } = {}) {
  let current = null; // `+++ ` target: null out of a hunk's preamble, or when it is /dev/null
  let oldPath = null; // `--- ` source: null out of a hunk's preamble, or when it is /dev/null
  let inHunk = false;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = null;
      oldPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^a\//, '');
      oldPath = p === '/dev/null' ? null : p;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      current = p === '/dev/null' ? null : p;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (line.startsWith('+')) {
      onAddedLine?.(line.slice(1), current);
    } else if (line.startsWith('-')) {
      // `current ?? oldPath`: the `+++ ` target when there is one (every ordinary
      // modify/rename), falling back to the `--- ` source only for a whole-file
      // deletion (`+++ /dev/null`), so removed lines are never hidden from callers.
      onRemovedLine?.(line.slice(1), current ?? oldPath);
    }
  }
}

// Map of file → Set of trimmed line texts ADDED by a unified diff, filtered by the CALLER's scope
// predicates. The one diff-scoping primitive every diff-scoped gate shares (plan 3974, gpt-review
// 7b2bad): each gate owns its own `inScope`/`isExempt` (the posix gate walks test files, the
// lock-free-poll gate walks hook sources), so the predicates are parameters here rather than
// closed-over module state — importing one gate's closed-over copy into another would silently
// filter with the wrong corpus. Matching is on trimmed line TEXT, never line number, because an
// added line's post-image number can drift under a rename remap while its text is exactly what the
// diff reports.
export function collectAddedByFile(diffText, { inScope, isExempt = () => false } = {}) {
  if (typeof inScope !== 'function') throw new TypeError('collectAddedByFile: inScope is required');
  const byFile = new Map();
  walkUnifiedDiff(diffText, {
    onAddedLine: (content, file) => {
      if (!file || !inScope(file) || isExempt(file)) return;
      if (!byFile.has(file)) byFile.set(file, new Set());
      byFile.get(file).add(content.trim());
    },
  });
  return byFile;
}

// Canonical diff-fetch for the range-scoped gates (plan 1708 review round 3): the
// ONE place that owns the diff-invocation flags — `core.quotepath=false` (so
// non-ASCII paths aren't octal-escaped out of pathspec matching) and
// `--find-renames` (so a renamed-and-edited file resolves to its new path instead
// of a delete+add pair). All four walkUnifiedDiff callers fetch through this, so
// a flag fix lands once; each caller keeps its own try/catch (their fail-open
// SKIP semantics differ).
export function fetchRangeDiff(repoRoot, range, pathspecs) {
  return git(repoRoot, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--find-renames',
    '--unified=0',
    range,
    '--',
    ...pathspecs,
  ]);
}

// Split a call's top-level arguments, starting at the index of its opening paren. Quote- and
// nesting-aware. Returns null when the call does not close within `text` (the caller has already
// joined continuation lines, so null means genuinely unbalanced).
//
// Moved here from assert-posix-path-assertions.mjs (plan 3974 review round 2, finding 214563):
// assert-lock-free-git-polls.mjs needed this one helper and was importing the whole other gate
// module just to get it — a real cross-gate coupling now resolved by hosting it in the shared
// low-level module both gates already depend on. assert-posix-path-assertions.mjs re-exports it
// under the same name so its own existing import sites and its test file's import are unaffected.
export function splitCallArgs(text, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += text[i + 1] ?? '';
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (!(depth === 1 && i === open)) cur += c;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(cur);
        return args.map((s) => s.trim());
      }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  return null;
}

// Extract the RIGHT side of a `<start>..<tip>` push range — the ref whose committed
// state that range's diff represents. Every range compute-push-diff.mjs emits, and the
// default `origin/master..HEAD` fallback (resolveGuardRanges), is exactly this shape; a
// lone ref with no '..' (defensive — should not occur in practice) is treated as its own
// tip. Git ref names cannot themselves contain '..', so splitting on the LAST occurrence
// is unambiguous.
export function rangeTip(range) {
  const idx = String(range).lastIndexOf('..');
  return idx === -1 ? range : range.slice(idx + 2);
}

// Read a guard's allowlist as COMMITTED at a SPECIFIC range's tip (plan 1737). The bug
// this fixes: the pre-fix main() read the allowlist ONCE from the on-disk working tree
// and reused that single Set across every range of a multi-ref push — but only ONE
// branch can be checked out on disk at a time, so a range whose tip carries DIFFERENT
// committed allowlist content than whatever happens to be checked out was judged against
// the WRONG ref's allowlist (an offender could slip through, or a legitimately
// allowlisted file could be wrongly blocked). `git show <tip>:<repoRelPath>` reads the
// allowlist exactly as committed on that tip — the same "committed ref, never the
// working tree" principle fetchRangeDiff already applies to the diff itself.
//
// Falls back to the on-disk working-tree copy (`fallbackPath`) ONLY when the ref-read
// fails with a PATH-ABSENT error (the allowlist file genuinely did not yet exist on that
// ref) — this fallback is never itself a block; a caller whose fallback ALSO fails treats
// that as the pre-existing allowlist-unreadable degrade (fail-open), byte-compatible with
// the pre-fix behaviour. `_git` is a test seam (the real coord-git `git` by default).
//
// F0 (plan 1752): the pre-fix version fell back to the working tree on ANY git-show
// failure, including a TRANSIENT one (index.lock contention / an object-read hiccup on
// the shared object store — this repo's known Git-for-Windows fork()-crash class) that
// says nothing about whether the path exists. On a multi-ref push with divergent
// committed allowlist content, that transient case silently substituted whatever branch
// happened to be checked out on disk — reintroducing, intermittently, the exact
// cross-ref leak plan 1737 closed for the common case. PATH_ABSENT_RX matches git's two
// stable `git show <ref>:<path>` wordings for "no such path in that ref's tree" — the
// mechanic plan 1756's review finding contributed (see this plan's Provenance note) —
// distinguishing that from everything else. Any OTHER failure now THROWS (never touches
// the working tree) so the caller's existing fail-open-SKIP catch applies instead
// (main(), mirroring the fetchRangeDiff degrade at ~line 270): the whole range is
// skipped, not silently judged against the wrong ref.
//
// F1 (plan 1752): `isManualFallback` (threaded by main() from `argv.length === 0`, i.e.
// resolveGuardRanges' own no-argv → origin/master..HEAD fallback) reads the on-disk
// allowlist DIRECTLY, skipping the committed-ref read entirely. A no-argv manual
// invocation judges the dev's INTENDED next push, and the dev's working tree IS that
// intent (an uncommitted grandfather-list edit must be seen, not produce a stale BLOCK —
// the pre-1737 local-dev workflow, restored for exactly this one caller shape). A real
// argv-supplied push range never sets this — it keeps the per-committed-ref read below
// (the 1737 fix itself).
// Exported (plan 1752 fix-pass): assert-price-gates-single-site.mjs's committed-tip .py
// reads classify their git-show failures with the SAME two wordings — one definition.
export const PATH_ABSENT_RX = /does not exist in|exists on disk, but not in/i;

// THE shared `git show <tip>:<path>` read + F0 failure classification (plan 1752
// adjudicated fix-pass, finding [2]) — the one place that owns the mechanic both
// readAllowlistForRange below and assert-price-gates-single-site's readPyFileAtTip
// consume, so a classification fix lands once. Returns a classified outcome, never
// throws:
//   { ok: true,  content }              — the blob as committed at that tip
//   { ok: false, absent: true,  error } — path genuinely not in that ref's tree
//                                         (PATH_ABSENT_RX matched git's stderr)
//   { ok: false, absent: false, error } — anything else: the transient class
//                                         (index.lock contention / object-read
//                                         hiccup on the shared object store)
// Each CALLER owns its own degrade policy on the non-ok outcomes (fallback file,
// tagged throw, warn-and-skip) — this helper only reads and classifies.
export function readFileAtTip(repoRoot, tip, repoRelPath, { _git = git } = {}) {
  try {
    return { ok: true, content: _git(repoRoot, ['show', `${tip}:${repoRelPath}`]) };
  } catch (e) {
    return { ok: false, absent: PATH_ABSENT_RX.test(errText(e)), error: e };
  }
}

export function readAllowlistForRange(
  repoRoot,
  range,
  repoRelPath,
  fallbackPath,
  { _git = git, isManualFallback = false } = {},
) {
  if (isManualFallback) {
    return readFileSync(fallbackPath, 'utf8');
  }
  const res = readFileAtTip(repoRoot, rangeTip(range), repoRelPath, { _git });
  if (res.ok) return res.content;
  if (res.absent) {
    return readFileSync(fallbackPath, 'utf8');
  }
  const err = new Error(
    `readAllowlistForRange: transient git-show failure for ${range}:${repoRelPath} ` +
      `(failing open by skipping this range, NOT substituting the working tree): ${errText(res.error)}`,
  );
  err.cause = res.error;
  err.transientGitShow = true;
  throw err;
}

// Parse an allowlist file's text into a Set of repo-relative paths (# comments and
// blank lines ignored). Shared by every makeSeamGuard() instance AND by a guard
// that manages its own two-pass check outside the makeSeamGuard scaffold (e.g.
// assert-pricelist-url-denylist-consult.mjs's file-content import check needs a
// second pass makeSeamGuard's single diff-only loop doesn't model) — one format
// tweak lands once instead of needing a hand-port to every guard.
export function loadAllowlist(text) {
  const set = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    set.add(line);
  }
  return set;
}

// Build a range-diff seam guard from a guard's own scope/pattern/message config.
//
//   allowlistRelPath — filename under scripts/ (joined onto REPO_ROOT/scripts)
//   scopeRules       — [{ prefix, exts }] the single source of truth for scope;
//                       both inScope() and SCOPE_PATHSPECS derive from it so
//                       they cannot drift.
//   violationRegex   — RegExp tested against each added (`+`) line.
//   isExempt         — optional (path) => boolean for a structurally-exempt
//                       surface (e.g. the seam's own sanctioned owners) that
//                       never needs an allowlist entry. Defaults to none exempt.
//   skipMessage      — exact text logged (plus an `[…]` detail suffix) when the
//                       range can't be resolved or a diff/allowlist read fails.
//   cleanMessage      — (allowlistSize) => exact text logged on a clean run.
//   blockHeader       — exact text logged before the offender list on a BLOCKED run.
//   blockBody         — array of lines (joined with '\n') logged after the list.
//   postFilterCandidates — optional (candidates, { range, isManualFallback, repoRoot })
//                       => filtered candidates, for a guard whose violation condition
//                       needs a SECOND pass beyond the diff (a candidate's full
//                       committed content, not just its added lines — e.g. a file-level
//                       import check). Invoked once per range, AFTER the pure
//                       diff-only findViolations core, BEFORE the clean/block decision —
//                       so SKIP classification (transient diff-fetch / allowlist-read
//                       failures) stays entirely in the shared loop and the hook only
//                       ever sees real candidates. Omitted (the default) = pass-through
//                       identity, so the two existing makeSeamGuard() callers
//                       (assert-seed-io-seam.mjs, assert-price-write-seam.mjs) stay
//                       BYTE-IDENTICAL. A hook throw is NOT an unhandled crash — main()
//                       classifies it like the existing transient-read SKIP path
//                       (fail-open with the loud SKIP banner), so a hook implementation
//                       should throw (never itself call process.exit) to signal a
//                       transient failure. Plan 2475.
export function makeSeamGuard({
  allowlistRelPath,
  scopeRules,
  violationRegex,
  isExempt = () => false,
  skipMessage,
  cleanMessage,
  blockHeader,
  blockBody,
  postFilterCandidates,
}) {
  const ALLOWLIST_PATH = join(REPO_ROOT, 'scripts', allowlistRelPath);
  // Repo-relative (forward-slash, git-pathspec-style) counterpart of ALLOWLIST_PATH, for
  // `git show <tip>:<repoRelPath>` — plan 1737's per-range committed-ref read.
  const ALLOWLIST_REPO_REL = `scripts/${allowlistRelPath}`;

  // Pathspec globs bounding the diff to the in-scope surfaces, so parsing stays
  // cheap and out-of-scope blobs can't appear. Derived from scopeRules so it
  // cannot drift from inScope() below.
  const SCOPE_PATHSPECS = scopeRules.flatMap(({ prefix, exts }) =>
    exts.map((ext) => `:(glob)${prefix}**/*${ext}`),
  );

  // A path is in scope iff some rule's prefix + extension matches it.
  function inScope(path) {
    return scopeRules.some(
      ({ prefix, exts }) => path.startsWith(prefix) && exts.some((ext) => path.endsWith(ext)),
    );
  }

  // PURE core: given the unified-diff text of the push range and the allowlist
  // Set, return the in-scope, non-exempt, non-grandfathered files that ADD a
  // line matching violationRegex. Only added lines (`+`, not `+++`) inside an
  // in-scope file's hunk count, so a pure rename (no hunk) and a modification
  // that doesn't touch a violating line both pass.
  //
  // Diff structure (header/hunk-state parsing, the `+++`-vs-`++`-content
  // collision fix) is owned by the shared walkUnifiedDiff — this function only
  // supplies its own scope/allowlist/pattern matching on each added line.
  function findViolations(diffText, allowlist) {
    const offenders = new Set();
    walkUnifiedDiff(diffText, {
      onAddedLine: (content, file) => {
        if (
          file &&
          inScope(file) &&
          !isExempt(file) &&
          !allowlist.has(file) &&
          violationRegex.test(content)
        ) {
          offenders.add(file);
        }
      },
    });
    return [...offenders];
  }

  // Applies the optional postFilterCandidates hook to a range's pure-core candidates —
  // exported (below) so the hook-omitted/hook-throw contract is directly unit-testable
  // without driving main()'s process.exit loop. Hook omitted → identity (pass-through).
  function applyPostFilter(candidates, ctx) {
    if (!postFilterCandidates) return candidates;
    return postFilterCandidates(candidates, ctx);
  }

  // ── main (skipped when imported as a module for the unit test) ──────────────
  function main() {
    // Ranges come as argv[2..] (plan 1289): the pre-push hook passes the per-ref
    // pushed-delta ranges compute-push-diff.mjs resolves (one per pushed ref, so
    // a rare multi-ref push carries several); CI passes its single <BASE>..HEAD.
    // With no args, resolveGuardRanges falls back to origin/master..HEAD (manual
    // invocation) — or null when origin/master is unresolvable.
    const argv = process.argv.slice(2);
    // F1 (plan 1752): threaded (not inferred from the range string, per E2) into
    // readAllowlistForRange below — a no-argv manual invocation reads the
    // WORKING-TREE allowlist; an argv-supplied push range keeps the committed-ref read.
    const isManualFallback = argv.length === 0;
    const ranges = resolveGuardRanges(REPO_ROOT, argv);
    if (ranges === null) {
      console.log(skipMessage);
      process.exit(0);
    }
    // plan 1737: each range is judged against ITS OWN committed allowlist — read at
    // that range's tip, never a single working-tree snapshot shared across every
    // range (the base-mismatch bug this fixes: a multi-ref push where two refs carry
    // divergent committed allowlist content, but only one branch can be checked out
    // on disk at a time). Any single diff failure still fail-opens the WHOLE gate
    // (exit 0), exactly as the old single-range path did — the done-worktree land +
    // CI backstop a skipped push. `rangeAllowlistSizes` keeps each range's OWN
    // allowlist.size (plan 1737 review finding F2: a prior cross-range union here
    // reported an inflated count that corresponded to no single ref's real
    // allowlist) — it plays no part in violation judging, which stays strictly
    // per-range and accumulates straight into the `violations` Set below (finding
    // F10: no intermediate array-of-arrays to flatten). plan 1752 F0: a TRANSIENT
    // git-show failure now THROWS out of readAllowlistForRange instead of silently
    // falling back to the working tree, so it lands in the same catch below as the
    // pre-existing allowlist-unreadable degrade — fail-open (SKIP, exit 0), never a
    // block, never a wrong-ref substitution.
    const rangeAllowlistSizes = [];
    const violations = new Set();
    for (const range of ranges) {
      let diffText;
      try {
        diffText = fetchRangeDiff(REPO_ROOT, range, SCOPE_PATHSPECS);
      } catch (e) {
        console.log(`${skipMessage} [${errText(e)}]`);
        process.exit(0);
      }

      let allowlistText;
      try {
        allowlistText = readAllowlistForRange(
          REPO_ROOT,
          range,
          ALLOWLIST_REPO_REL,
          ALLOWLIST_PATH,
          { isManualFallback },
        );
      } catch (e) {
        // A missing/unreadable allowlist — on both this range's committed tip AND the
        // working-tree fallback — is a repo-integrity problem, not a signal to block:
        // an empty allowlist would false-positive every grandfathered entry. Degrade
        // like the other infra failures (the land re-run + CI backstop). plan 1752 F0:
        // this also now catches a TRANSIENT git-show failure readAllowlistForRange
        // deliberately re-throws instead of silently substituting the working tree —
        // same fail-open-SKIP outcome, just for a different (correct) reason.
        console.log(`${skipMessage} [allowlist unreadable: ${errText(e)}]`);
        process.exit(0);
      }
      const allowlist = loadAllowlist(allowlistText);
      rangeAllowlistSizes.push(allowlist.size);
      const candidates = findViolations(diffText, allowlist);
      let filtered;
      try {
        filtered = applyPostFilter(candidates, {
          range,
          isManualFallback,
          repoRoot: REPO_ROOT,
        });
      } catch (e) {
        // A hook throw (e.g. a transient file-content read failure) fails open exactly
        // like the diff-fetch / allowlist-read failures above — SKIP, never a block, never
        // an unhandled crash.
        console.log(`${skipMessage} [${errText(e)}]`);
        process.exit(0);
      }
      for (const v of filtered) violations.add(v);
    }

    if (violations.size === 0) {
      // One cleanMessage line per range, each printed with THAT range's own honest
      // allowlist size (never a cross-range union) — the common single-ref push logs
      // exactly once.
      for (const size of rangeAllowlistSizes) console.log(cleanMessage(size));
      process.exit(0);
    }

    console.error(blockHeader);
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(blockBody.join('\n'));
    process.exit(1);
  }

  return {
    SCOPE_PATHSPECS,
    inScope,
    loadAllowlist,
    findViolations,
    applyPostFilter,
    main,
    ALLOWLIST_PATH,
  };
}
