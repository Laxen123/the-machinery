#!/usr/bin/env node
// scripts/wiki-commit.mjs  (plan 1279)
// The ONE sanctioned way to commit wiki/** pages (+ WIKI.md) on the main checkout. The
// pre-commit guard (check-coordination-branch.mjs, plan-1279 'main' mode) blocks a raw
// `git add wiki/… && git commit` there, because hand commits on the SHARED main index
// are the sweep class: a pathspec-less `git commit` snapshots the whole index and eats
// a peer session's staged files (the plan-1256 incident). This helper is structurally
// sweep-proof and prettier-safe:
//
//   1. runs the pages through prettier FIRST, in-process via the prettier API (no pnpm/shell
//      hop, no cmd.exe arg-parsing on Windows). Since plan 2389 this step is a NO-OP for wiki
//      content: `wiki/` + `WIKI.md` ARE in .prettierignore now (they were not before — that
//      omission is what let prettier silently mangle pages, `O_EXCL` -> `O*EXCL`, since wiki
//      prose is full of snake_case identifiers markdown emphasis parsing eats), and
//      prettierWrite() consults .prettierignore via getFileInfo's `ignorePath` and skips
//      ignored files.
//      WHY THAT IS SAFE and not a hole: this step existed to satisfy the diff-scoped
//      `prettier --check` in scripts/hooks/pre-push.sh, and that gate reads THE SAME `.prettierignore`.
//      So ignoring the vault removes the CHECK and the pre-format together — the gate can no
//      longer fail on wiki content, so there is nothing left for the pre-format to pre-empt.
//      One file, both directions; they cannot drift apart into "unformatted content facing a
//      gate that still checks it".
//      The step is kept rather than deleted because that makes it VESTIGIAL for the WIKI_RX
//      file class (this helper's only class until plan 3411 added one named exception — see
//      below), not wrong — and deleting code on the sanctioned wiki write path is its own
//      change with its own blast radius (a follow-up plan owns it). It also still earns its
//      keep if the accepted set (WIKI_RX) ever widens to a path the ignore entry does not
//      cover; with the entry in place it costs one getFileInfo call per page.
//      Do NOT "fix" a mangled page by removing the ignore entry —
//      the wiki prettier-ignore test gates it.
//      PLAN 3411: scripts/wiki-chain-registry.mjs is the one accepted path this no-op claim
//      does NOT cover (it is not under .prettierignore) — see prettierWrite()'s own comment
//      for why that is deliberate.
//   2. captures the formatted page content from MAIN's disk and lands it via the DISPOSABLE
//      coord-checkout under the coord-write lock (withCoordCheckout + coordWrite, plan 1286):
//      pathspec commit with a Coord-Write trailer, scoped rollback, silent non-ff retry —
//      never a commit on (or a rebase of) the shared MAIN checkout. A peer's staged files
//      cannot be swept (different tree entirely), and MAIN's HEAD never moves during the op.
//   3. afterwards MAIN's now-redundant page dirt is cleared and MAIN is best-effort
//      fast-forwarded so the on-disk pages come back as their committed selves.
//      (--no-push keeps the old local pathspec-commit on MAIN, without pushing.)
//
// Path scope is check-coordination-branch.mjs's WIKI_RX — the guard's blocked set and this
// helper's accepted set are the same constant, so they cannot drift apart, PLUS exactly one
// named exception (plan 3411): scripts/wiki-chain-registry.mjs (CHAIN_REGISTRY_REL below), so a
// chain wiki page and its CHAINS registry row can land in the same atomic commit — see
// normalizeWikiPaths for the exception itself and its rationale.
//
// Scope: ALL wiki write-backs, from either checkout shape:
//   - main-checkout session (branch != worktree-*): the CLAUDE.md low-friction path,
//     unchanged since plan 1279 — operates on $MAIN regardless of cwd.
//   - worktree session (branch worktree-<slug>) — plan 1604: auto-detected from the
//     CALLING checkout's branch (no flag needed). A worktree branch must NEVER carry a
//     wiki/** commit (hot pages conflict on every parallel land — the plan-1536
//     landing-queue incident, done-worktree preflight + .husky/pre-push now BLOCK such a
//     branch outright). So this helper captures the page content from the CALLER's own
//     disk (not $MAIN's), lands it via the exact SAME withCoordCheckout + coordWrite
//     mechanism below (never a second master-push path — reusing record-wiki.mjs's
//     plan-1286 precedent, not inventing one), then discards the caller's local edit
//     (revertPathsToHead) so it never rides the worktree branch. The OLD guidance —
//     "edited them inside a plan worktree? They land via your branch merge — no helper
//     needed" — is exactly the root cause plan 1604 closed; do not resurrect it.
//
// NOT for coord docs (board / INDEX / plans / handoff) — those have their own tools
// (board.mjs, index.mjs, move-plan, edit-plan, coord-edit). Sibling: record-wiki.mjs
// records the WIKI_CHECKPOINT marker from inside a worktree — a different,
// near-opposite context (plan 1105); it is deliberately NOT folded into this helper.
//
// Usage (run from anywhere in the repo — main-checkout OR worktree, auto-detected):
//   node scripts/wiki-commit.mjs wiki/entities/chains/chain-a.md wiki/log.md -m "chore(wiki): …"
//   [--no-push] [--dry]
//   (--no-push is a MAIN-only local/offline escape hatch — refused from a worktree
//   session, which must always land straight to master, never commit on its own branch.)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import {
  resolveMain,
  pushMasterWithRebase,
  gitWithLockRetry,
  commitSubjectAtHead,
  isNothingToCommit,
  errText,
  GIT_MAXBUFFER,
  withCoordCheckout,
  coordWrite,
  revertPathsToHead,
  ffMasterFromOrigin,
  parseFlags,
} from './coord/coord-git.mjs';
import { normalizeRel } from './coord/main-checkout-allowlist.mjs';
import { frontmatterEnd } from './coord/build-index-lib.mjs';
import { WIKI_RX } from './coord/check-coordination-branch.mjs';
import {
  checkPages,
  collectHookReferencedBasenames,
  formatBudgetWarning,
  formatBudgetFailure,
} from './coord/wiki-size-lint.mjs';
import { JOURNAL_REL, checkJournalOrThrow, lineMultiset } from './coord/wiki-log-lint.mjs';
import { slugFromBranch } from './coord/redgreen-lib.mjs';
import { selectDataTriggeredTests, DATA_DEPENDENCY_MAP } from './coord/select-battery-tests.mjs';
import {
  resolveUpdatedOnlyConflicts,
  UPDATED_LINE_RE,
} from './coord/wiki-updated-merge-driver.mjs';
import { gitRepoIsolatedEnv } from './coord/child-env.mjs';

function git(dir, args, opts = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER,
    env: gitRepoIsolatedEnv(),
    ...opts,
  });
}

// D1 (plan 1362): wiki-commit runs the SAME size-budget check the pre-push
// wiki-size-lint tier runs — scoped to just the pages this commit touches — so an
// over-cap injected page is refused HERE, at write time, instead of landing with
// HUSKY=0 and taxing the next unrelated session's push (the observed 2026-07-03
// price-inspector case). A WARN (pull-page budget) prints but never blocks —
// severity parity with the pre-push tier. No bypass flag: the lint's remedy
// (relocate detail to a non-injected page) is always available.
// `hookBasenames`: an optional precomputed collectHookReferencedBasenames set, threaded through
// to checkPages. plan 1398 item 3 memoized this ONCE before coordWrite's retry loop (to avoid
// re-walking `scripts/hooks/**` while holding the coord lock), but plan 1475 item 1 REVERTED
// that: coordWrite ff-merges origin/master before each retry, so `scripts/hooks/**` can
// legitimately change mid-window (a sibling newly wiring a page into a loader), and the snapshot
// classified against a STALE (looser `pull`) budget — the write-time-catch gap plan 1362 D1
// closed. The default land path in main() now recomputes the set fresh INSIDE mutate() (per
// retry), so BOTH inputs — the content size and this hook-basename budget — reflect the
// post-merge state. Omitted (the --no-push local path, which never retries) → computed fresh
// inside checkPages, as before. Exported for the plan-1475 per-retry re-classification test.
export function checkSizeOrThrow(dir, relPaths, { hookBasenames } = {}) {
  const { fails, warns } = checkPages(dir, relPaths, { hookBasenames });
  for (const w of warns) {
    // plan 2487: the message body is rendered by wiki-size-lint's single-owner
    // formatBudgetWarning, so an injected page ≥90% of its cap reads NEAR-CAP here and in
    // the pre-push tier identically — severity parity, same as the fail path.
    const { severity, message } = formatBudgetWarning(w);
    console.error(`wiki-commit: ${severity} ${message}`);
  }
  if (fails.length) {
    // plan 2618: message body rendered by wiki-size-lint's single-owner formatBudgetFailure
    // (covers both the size cap and the updated:-length cap) — same parity reasoning as the
    // formatBudgetWarning wiring above.
    throw new Error(
      'wiki-commit: refusing to commit — ' +
        fails.map((f) => formatBudgetFailure(f)).join(' | ') +
        ' No bypass flag — relocating/trimming the text is always available.',
    );
  }
}

// plan 3411: what a CHAIN_REGISTRY_REL edit owes the gate is EXACTLY what a chain wiki PAGE
// owes it — they are the two halves of one bijection — so the forced selection is DERIVED from
// DATA_DEPENDENCY_MAP by asking it what a chain page selects, never by naming the coverage test
// a second time. Naming it twice was the first cut and review refuted it three ways: a rename
// or split of that test would update the canonical map and leave the literal here stale, whereon
// `existsSync` silently filters it out and the registry-only commit selects NOTHING again — the
// exact gap this force-select exists to close, reopened invisibly. This proxy path is never read
// from disk; it only has to MATCH the map's `wiki/entities/**` glob. If the map ever grows a
// second test over that glob, a registry commit correctly runs that one too.
// (CHAIN_REGISTRY_REL itself is declared beside normalizeWikiPaths, the exception it belongs to;
// the forward reference resolves at call time — this function only ever runs from
// main()/commitWikiPages, never at module eval.)
const CHAIN_PAGE_PROXY_REL = 'wiki/entities/chains/__registry_coverage_proxy__.md';

// plan 2070 Group B: the wiki-loader-coverage gate. This helper is the ONE path wiki pages
// reach master through that NEVER runs `scripts/hooks/pre-push.sh`'s battery (or its own data-triggered
// block, same plan) — a page-add carrying an unmapped seed chainId or an illegal
// `triggerPaths:` would otherwise land straight to master undetected until an unrelated
// scripts/-touching push happened to eat the failure (the 2026-07-17→19 GB-chains incident).
// Consults the SAME DATA_DEPENDENCY_MAP the pre-push data-triggered block reads (never a
// second, parallel hardcode of the input set) against the pages THIS commit actually touches,
// so a wiki/log.md-only commit (not in the map) is a no-op — no test spawn, no cost. Runs
// against `dir` (the coord-checkout, post-merge, post-write — the exact same placement as
// checkSizeOrThrow's E1 call below: fresh per coordWrite retry, against the on-disk content
// that will actually be committed). A mapped test file that does not exist at `dir` (a
// throwaway fixture repo carrying only a couple of wiki pages, e.g. this file's own test
// suite) is skipped, not failed — this gate can only enforce a check it can actually run; in
// every real checkout (`dir` shares this repo's object store) the file always exists.
//
// plan 3411 (review finding, all 8 candidates): the CHAIN_REGISTRY_REL exception opened a NEW
// door into this gate's blind spot, and it is the very failure the exception exists to close.
// `selectDataTriggeredTests` reads DATA_DEPENDENCY_MAP, which maps the coverage test to
// `wiki/entities/**` (and the loader hooks) — NOT to scripts/wiki-chain-registry.mjs, whose
// coverage at push time comes from the scripts battery instead. But the coord-checkout push
// below runs NO git hooks, so a wiki-commit carrying ONLY the registry (a row edit with no page
// beside it — an rx tune, a chainIds addition, or a registration whose page is already landed)
// selected NOTHING and pushed a possibly-DANGLING entry straight to master, red-ing the next
// unrelated session's scripts/-touching push. The registry is therefore force-selected here: if
// it rides the commit, the bijection is checked, page or no page. Belt-and-braces on the
// page+registry commit (the pages already select it), load-bearing on the registry-only one.
export function checkWikiLoaderCoverageOrThrow(
  dir,
  relPaths,
  // `dataDependencyMap` (plan 3958): DATA_DEPENDENCY_MAP itself is read from coord.config.json's
  // `dataDependencyMap` row (self-resolved at module load) — vetapp's row is what maps
  // 'wiki/entities/**' to wiki-loader-coverage.test.mjs; the public coord-kit's own neutral
  // config carries no such row, degrading to the generic default alone. A test that needs to
  // pin this gate's bijection behaviour injects a synthetic map here instead of depending on
  // the calling checkout's live config.
  { _execFileSync = execFileSync, dataDependencyMap = DATA_DEPENDENCY_MAP } = {},
) {
  const mapped = selectDataTriggeredTests(relPaths, dataDependencyMap);
  const forced = relPaths.includes(CHAIN_REGISTRY_REL)
    ? selectDataTriggeredTests([CHAIN_PAGE_PROXY_REL], dataDependencyMap)
    : [];
  const selected = [...new Set([...mapped, ...forced])]
    .sort()
    .filter((rel) => existsSync(join(dir, rel)));
  if (!selected.length) return;
  // NODE_TEST_CONTEXT=child-v8, if inherited from an outer node:test process (this function's
  // own test suite runs under one), makes this NESTED `node --test` mistake itself for that
  // outer runner's IPC child and silently report success without running anything — the exact
  // hazard scripts/hooks/pre-push.sh's own nested node:test invocation defensively unsets (see its
  // CRITICAL clean-git-env comment). Delete rather than set-to-undefined: child_process
  // stringifies an explicit `undefined` value into the literal text "undefined".
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    // 120s cap, same bound as the pre-push data-triggered block's `run_bounded 120` (this
    // runs synchronously inside coordWrite's mutate() while holding the cross-session coord
    // lock — an unbounded hang here (e.g. this test's own `git ls-files` stalling on a
    // concurrent index/ref lock) would wedge every other parallel session's coord writes).
    _execFileSync('node', ['--test', ...selected], {
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    });
  } catch (e) {
    throw new Error(
      `wiki-commit: refusing to commit — ${selected.join(', ')} FAILED against this commit's ` +
        'post-merge content (an unmapped seed chainId, an illegal wiki triggerPaths:, or a ' +
        'broken loader-registry bijection, OR the run hit the 120s cap). Fix the page(s) or ' +
        `the registry, confirm green with \`node --test ${selected.join(' ')}\`, then retry. ` +
        `(plan 2070 — this data class never reaches .husky/pre-push's own battery.)\n${errText(e)}`,
    );
  }
}

// plan 1622 (batched by plan 1641): stale-base guard. Read EVERY page's blob at `ref` in
// `dir` via a single `git cat-file --batch` subprocess instead of one `git show` process per
// page — a multi-page wiki-commit invocation under coordWrite contention (retries up to 8x,
// exactly when a parallel session just landed a conflicting commit) would otherwise spawn
// relPaths.length extra git.exe processes per retry (/sonnet-review xhigh finding,
// batch-2026-07-08-coord-spine3). `git cat-file --batch` accepts one `<rev>:<path>` object
// spec per stdin line and echoes back, for each, either a `<sha> <type> <size>` header
// followed by exactly `<size>` content bytes (plus git's own framing LF), or the literal
// input token suffixed ` missing` when that path does not resolve at that ref — so absent-path
// detection is a string match on the batch's own output, not a caught exception. Returns a raw
// Buffer per page (never a decoded string), matching gitShowBlobOrNull's byte-exact semantics,
// keyed by relPath in `new Map`. `_execFileSync` is an injectable seam (mirrors
// commitWikiPages's `_git`/`_gitRetry` seams) so a test can assert the call count without a
// second git binary.
export function gitShowBlobsOrNull(dir, ref, relPaths, { _execFileSync = execFileSync } = {}) {
  const result = new Map();
  if (!relPaths.length) return result;
  // plan 1642 review fix [C]: verify the REF ITSELF resolves before trusting `cat-file
  // --batch`'s per-page "missing" output. `cat-file --batch` prints the IDENTICAL
  // "<spec> missing" line for BOTH a path genuinely absent at a valid ref AND a wholly
  // unresolvable ref (a corrupt/GC'd object, a bad ref name) — so without this check, every
  // page of an unresolvable ref would be silently reported "absent" instead of surfacing the
  // real error. The pre-plan-1641 gitShowBlobOrNull distinguished the two; this restores that
  // distinction while keeping plan 1641's "one subprocess per REF" cost characteristic — this
  // adds exactly one extra subprocess per gitShowBlobsOrNull call (not per page). Not currently
  // reachable by today's two call sites (both pre-validate their ref: `mergeBase` comes from a
  // successful `git merge-base`, and `HEAD` always resolves in a git worktree) but a real
  // contract violation for a future less-validated caller.
  try {
    _execFileSync('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    });
  } catch (e) {
    throw new Error(
      `wiki-commit: ref "${ref}" does not resolve to a commit in ${dir} — cannot read any ` +
        `page's blob at it (a "<path> missing" result from git cat-file --batch would otherwise ` +
        `be misread as every page being absent, rather than surfacing the real ref-resolution ` +
        `error). ${errText(e)}`,
    );
  }
  const specs = relPaths.map((rel) => `${ref}:${rel}`);
  const out = _execFileSync('git', ['-C', dir, 'cat-file', '--batch'], {
    input: specs.map((s) => s + '\n').join(''),
    maxBuffer: GIT_MAXBUFFER,
    env: gitRepoIsolatedEnv(),
  });
  let offset = 0;
  for (let i = 0; i < relPaths.length; i++) {
    const nl = out.indexOf(0x0a, offset);
    if (nl === -1) {
      throw new Error(
        `wiki-commit: git cat-file --batch produced fewer lines than requested (missing entry for ${specs[i]})`,
      );
    }
    const header = out.slice(offset, nl).toString('utf8');
    offset = nl + 1;
    if (header === `${specs[i]} missing`) {
      result.set(relPaths[i], null);
      continue;
    }
    const m = /^[0-9a-f]+ \S+ (\d+)$/.exec(header);
    if (!m) throw new Error(`wiki-commit: unexpected git cat-file --batch header: "${header}"`);
    const size = Number(m[1]);
    result.set(relPaths[i], out.slice(offset, offset + size));
    offset += size + 1; // + the framing LF git cat-file appends after each object's content
  }
  return result;
}

// Single-page convenience wrapper over gitShowBlobsOrNull (kept for callers/tests that only
// need one path at a time — same null-on-absent-path semantics, one subprocess either way).
export function gitShowBlobOrNull(dir, ref, relPath) {
  return gitShowBlobsOrNull(dir, ref, [relPath]).get(relPath);
}

// plan 3415 Item C review round 3 (finding 13nxuip): the warning printed when the pre-guard
// `git fetch origin master` fails — extracted to a pure, exported function (rather than an
// inline console.error) so it is unit-testable without having to break a real shared-`.git`
// origin remote (which cascades into the coord-checkout's own required fetch, since a linked
// worktree shares its repo's remote config with every other worktree of that same repo).
export function describeStaleFetchFailure(sourceDir, error) {
  return (
    `wiki-commit: could not fetch origin/master in ${sourceDir} before resolving the ` +
    `stale-base guard's merge-base (${errText(error)}) — proceeding against this checkout's ` +
    'LOCAL origin/master ref, which may itself be stale. A conflict a fresher ref would have ' +
    'caught could go undetected until a later push.'
  );
}

// plan 1622: attempt `git merge-file` (git's own three-way text merge) to incorporate master's
// changes (base→other) into the caller's edit (current). Returns the merged Buffer on a clean
// merge (git exits 0), or null when git reports an actual content conflict (exit nonzero AND
// conflict markers in stdout) — the caller maps null to a REFUSAL, never a silent pick of either
// side. Any OTHER nonzero exit (no conflict markers — e.g. a `git-merge-file` environment
// failure) is a real error and is rethrown, not swallowed as a conflict. Three throwaway temp
// files because `git merge-file` operates on paths, not stdin.
//
// plan 1697 (decision a): `union: true` passes `git merge-file --union`, which resolves every
// otherwise-conflicting hunk by keeping BOTH sides' lines (no markers, never a nonzero exit).
// wiki/log.md is append-only by convention (a newest-first journal), so a "conflict" there is
// always two sessions each prepending a fresh line — union keeps both, killing the EOF-conflict
// class AND the clean-deletion-on-refuse class for the journal (two live incidents, sessions
// 1548/1549). Union never returns null (it cannot conflict).
//
// plan 3415 Item C fix 3: a genuine `<<<<<<<` conflict gets ONE more chance before it is
// reported to the caller as unresolvable — resolveUpdatedOnlyConflicts (the SAME registered
// plan-1528 driver `git merge`/`rebase` use, generalised to the annotated
// `updated: YYYY-MM-DD (plan NNNN: ...)` form) auto-resolves a conflict that is ENTIRELY
// `updated:`-line hunks and leaves everything else untouched — a mixed conflict (any other hunk
// present) returns null from that call and falls through to the ordinary refusal below,
// unresolved, exactly as before. Previously this hand-rolled merge path had no such recovery at
// all: ANY conflict marker, including a lone updated:-line collision, was reported as a genuine
// conflict — the checkContainment exemption a few lines below exists BECAUSE this call can now
// legitimately replace the caller's own updated: line with a different, later one.
function tryThreeWayMerge(baseBuf, currentBuf, otherBuf, { union = false, pagePath } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-commit-merge-'));
  try {
    const baseFile = join(dir, 'base');
    const curFile = join(dir, 'current');
    const otherFile = join(dir, 'other');
    writeFileSync(curFile, currentBuf);
    writeFileSync(baseFile, baseBuf);
    writeFileSync(otherFile, otherBuf);
    const args = ['merge-file', ...(union ? ['--union'] : []), '-p', curFile, baseFile, otherFile];
    try {
      return execFileSync('git', args, { maxBuffer: GIT_MAXBUFFER });
    } catch (e) {
      if (e.stdout && Buffer.from(e.stdout).includes('<<<<<<<')) {
        const resolved = resolveUpdatedOnlyConflicts(Buffer.from(e.stdout).toString('utf8'), {
          pagePath,
        });
        return resolved == null ? null : Buffer.from(resolved);
      }
      throw e; // some other merge-file failure — surface it, never mistake it for a conflict
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// plan 1697 (decision b): the post-merge CONTAINMENT guard. `resolveStalePageContent` has decided
// it would WRITE `content` (either the caller's copy verbatim on the fast-forward path, or the
// 3-way merge output); before trusting that, verify the write is not a silent content loss. Two
// live incidents (sessions 1548/1549) landed commits whose net effect was the DELETION of a
// sibling's just-landed line while the tool reported success — the caller's stale-base snapshot
// was written over master, reverting content the caller had simply never seen.
//
// Comparison is by NON-BLANK line multiset, CRLF-normalized (a Windows caller copy is CRLF on
// disk; git blobs are LF) — blank/whitespace-only lines are ignored so pure reflow never trips
// the guard. Two independent refuse conditions (the plan's decision (b)):
//   (A) every line the caller's copy ADDS vs its base must survive in the result. A clean merge
//       that drops the caller's own contribution is a bug, not a commit.
//   (B) a NET REVERSION: the result deletes lines present on current master (M \ R non-empty)
//       while adding nothing of its own to master (R \ M empty). This is the stale-snapshot
//       signature — a write whose only effect is removing landed content. It deliberately does
//       NOT fire when the caller also adds something to master (R \ M non-empty): that shape is
//       a concurrent edit, provably indistinguishable from a legitimate one (the plan-1622
//       disjoint-lines-both-survive contract requires it to commit), so the guard leaves it to
//       the stale-base 3-way merge and, on refuse, defect-2's edit preservation.
// Returns a `{ action:'conflict', reason, detail }` refusal, or null when the write is safe.
//
// plan 2764: the CRLF-normalize / trim / skip-blank / count-into-Map rule is `lineMultiset`,
// imported from wiki-log-lint.mjs — it used to be reimplemented here byte-for-byte, and two
// copies of the rule meant the containment guard and the journal duplication guard could
// silently come to disagree about what counts as "the same line" for the same file on the
// same coordWrite retry. It accepts a Buffer directly (String(buf) on a Buffer is its utf8
// decoding), so the old Buffer.isBuffer branch is unnecessary rather than dropped.

// Multiset A minus B: lines whose count in A exceeds their count in B, as a line→residual Map.
function multisetDiff(a, b) {
  const out = new Map();
  for (const [line, c] of a) {
    const rem = c - (b.get(line) ?? 0);
    if (rem > 0) out.set(line, rem);
  }
  return out;
}

// plan 3415 Item C fix 1: `updated:` is POLICY-resolved metadata, not caller-owned prose — the
// registered driver (resolveUpdatedOnlyConflicts, wired into tryThreeWayMerge above) is
// ENTITLED to replace the caller's own `updated:` line with a different, later one (master's, on
// the reported ledger symptom: master's date newer than the caller's). Guard (A) below cannot
// tell that apart from a genuinely dropped contribution — both look like "a line the caller's
// copy had is missing from the merged result" — so the ONE frontmatter `updated:` line (bare or
// the annotated `updated: YYYY-MM-DD (plan NNNN: ...)` superset) is stripped from every multiset
// BEFORE the containment diff runs, and the line's own — stricter — rule is checked separately by
// checkUpdatedLineMonotonic: the survivor's date must never be OLDER than either side's, so a
// resolver bug (or some future hand-rolled merge picking the wrong side) that regresses the date
// is still caught. This narrows the exemption to exactly the one line class the plan calls out;
// every other line stays fully covered by guards (A) and (B), unchanged.
//
// plan 3415 Item C review (cluster 9): the exemption is scoped by POSITION, not by shape alone —
// only the `updated:` key inside the `---`-delimited frontmatter block at the very top of the
// page is exempt. A body line that merely LOOKS like `updated: YYYY-MM-DD (...)` (a quoted
// example, a changelog bullet) is never exempted: stripping it by shape alone (the pre-fix
// behavior) let a stale merge silently drop that body line — the line vanished from the
// caller's own multiset before guard (A)'s diff ever ran, so the drop was invisible to it.
//
// plan 3415 Item C review (cluster 10): UPDATED_LINE_RE is imported from
// wiki-updated-merge-driver.mjs (the SAME grammar `git merge`/`rebase` use via the registered
// driver) rather than a second, independently-maintained copy — the prior local
// `UPDATED_LINE_RX` could drift from the driver's regex if the accepted annotation syntax ever
// changed in only one place.
//
// plan 3415 Item C review round 3 (finding vqbtpw): scoped to the FRONTMATTER `updated:` line
// only — the prior version scanned the whole buffer, so a body line merely shaped like
// `updated: YYYY-MM-DD (...)` (a quoted example, a changelog bullet) could be mistaken for the
// page's own metadata date. Delegates to frontmatterUpdatedLine so the two functions can never
// disagree about which line counts as "the" updated: line for a given buffer.
function extractUpdatedDate(buf) {
  const line = frontmatterUpdatedLine(buf);
  if (line == null) return null;
  const m = line.match(UPDATED_LINE_RE);
  return m ? m[1] : null;
}

// The frontmatter `updated:` line in `buf`, or null when there is no `---`-delimited
// frontmatter block, or none of its lines match. Normalizes the same way lineMultiset does
// (CRLF-tolerant, trailing-whitespace-trimmed) so the returned string is the exact key that
// would appear in that buffer's own line multiset.
//
// plan 3415 Item C review round 3 (finding 149sbjt): the fence itself is located via
// build-index-lib.mjs's frontmatterEnd — the SAME fence rule (exactly `---`, trailing
// whitespace tolerated, leading whitespace not) every other frontmatter reader/writer in
// scripts/ shares — rather than a second, independently-maintained fence scan that could drift
// from it (e.g. on an indented YAML block-scalar value that happens to contain a dash rule).
function frontmatterUpdatedLine(buf) {
  const lines = String(buf ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''));
  const close = frontmatterEnd(lines);
  if (close === -1) return null;
  for (let i = 1; i < close; i++) {
    if (UPDATED_LINE_RE.test(lines[i])) return lines[i];
  }
  return null;
}

// Removes ONLY `buf`'s own frontmatter `updated:` line from `multiset` (by exact string match
// on that one line) — never any other line, even one with the identical shape.
//
// plan 3415 Item C review round 3 (finding 1ju4sdn): `Map.delete` removes the key ENTIRELY,
// not one occurrence — so when a page's BODY happens to carry a line byte-identical to its own
// frontmatter `updated:` line, deleting by value wiped out the body occurrence's count too,
// silently exempting it from guard (A)'s containment diff instead of only the one frontmatter
// line the exemption is scoped to. Decrementing the multiset's count by exactly one removes
// only the frontmatter occurrence and leaves any other identical line's count intact.
function stripFrontmatterUpdatedLine(multiset, buf) {
  const line = frontmatterUpdatedLine(buf);
  if (line == null) return;
  const count = multiset.get(line);
  if (count == null) return;
  if (count <= 1) multiset.delete(line);
  else multiset.set(line, count - 1);
}

// The `updated:` line's own guard, run once the ordinary containment diff (below) has already
// passed: the date that actually survives in `content` must be >= both the caller's date and
// master's date. Returns a refusal, or null when there is nothing to check (neither side carries
// an `updated:` line at all) or the survivor clears both.
function checkUpdatedLineMonotonic({ effectiveMaster, callerContent, content }) {
  const callerDate = extractUpdatedDate(callerContent);
  const masterDate = extractUpdatedDate(effectiveMaster);
  if (callerDate == null && masterDate == null) return null;
  const resultDate = extractUpdatedDate(content);
  if (resultDate == null) {
    return {
      action: 'conflict',
      reason: 'containment-updated-missing',
      detail: [`caller=${callerDate ?? '(none)'}`, `master=${masterDate ?? '(none)'}`],
    };
  }
  if ((callerDate && resultDate < callerDate) || (masterDate && resultDate < masterDate)) {
    return {
      action: 'conflict',
      reason: 'containment-updated-regressed',
      detail: [
        `caller=${callerDate ?? '(none)'}`,
        `master=${masterDate ?? '(none)'}`,
        `result=${resultDate}`,
      ],
    };
  }
  return null;
}

export function checkContainment({ effectiveBase, effectiveMaster, callerContent, content }) {
  const B = lineMultiset(effectiveBase);
  const M = lineMultiset(effectiveMaster);
  const C = lineMultiset(callerContent);
  const R = lineMultiset(content);
  stripFrontmatterUpdatedLine(B, effectiveBase);
  stripFrontmatterUpdatedLine(M, effectiveMaster);
  stripFrontmatterUpdatedLine(C, callerContent);
  stripFrontmatterUpdatedLine(R, content);

  // (A) the caller's own additions vs base must survive.
  const droppedCallerAdds = multisetDiff(multisetDiff(C, B), R);
  if (droppedCallerAdds.size) {
    return {
      action: 'conflict',
      reason: 'containment-caller-adds',
      detail: [...droppedCallerAdds.keys()].slice(0, 3),
    };
  }

  // (B) net reversion: master content lost, nothing added to master.
  const lostFromMaster = multisetDiff(M, R);
  const addedToMaster = multisetDiff(R, M);
  if (lostFromMaster.size && addedToMaster.size === 0) {
    return {
      action: 'conflict',
      reason: 'containment-reversion',
      detail: [...lostFromMaster.keys()].slice(0, 3),
    };
  }

  return checkUpdatedLineMonotonic({ effectiveMaster, callerContent, content });
}

// plan 1622: the decision table (pure, unit-testable without git). All three inputs are
// Buffer|null (null = the page is absent at that point — deleted, or never existed).
//   - masterBlob === baseBlob  → 'write' the caller's copy verbatim (fast-forward content,
//     master hasn't moved since the caller's base — today's pre-guard behavior).
//   - masterBlob === callerContent → 'skip', nothing to commit (master already has this content,
//     e.g. a sibling landed the identical edit, or a retry re-runs against its own prior write).
//   - otherwise → three-way merge (base, callerContent, masterBlob); clean → 'write' the merged
//     content; conflicting → 'conflict' (the caller must REFUSE — never silently prefer either
//     side, that IS the clobber this guard exists to prevent).
// A caller-side deletion (callerContent === null) is handled narrowly: apply it only when
// master is unchanged since base (nothing of master's would be lost); otherwise refuse rather
// than attempt a textual 3-way "merge" of a deletion, which `git merge-file` cannot express.
//
// plan 1697: `unionMerge` (true for wiki/log.md) swaps the 3-way merge for a `--union` merge —
// both sides' appended lines survive, never a conflict (decision a). Regardless of merge mode,
// every 'write' outcome runs the containment guard (checkContainment) before it is trusted, so a
// stale-base snapshot can never be written over master as a silent content deletion (decision b).
export function resolveStalePageContent(
  { baseBlob, masterBlob, callerContent },
  { unionMerge = false, pagePath } = {},
) {
  const bufEq = (a, b) => {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    return Buffer.compare(a, b) === 0;
  };

  if (callerContent === null) {
    if (masterBlob === null) return { action: 'skip' }; // already absent everywhere
    if (bufEq(masterBlob, baseBlob)) return { action: 'delete' }; // safe — nothing else changed
    return { action: 'conflict' }; // master moved since base — deleting would drop that content
  }

  // A brand-new page (absent at both the caller's base AND current master) falls through to
  // the general case below: effectiveBase/effectiveMaster both become an empty buffer, so
  // bufEq(effectiveMaster, effectiveBase) is trivially true and 'write' fires — no special
  // case needed (review fix: the prior explicit early-return duplicated this exact outcome).
  const effectiveBase = baseBlob ?? Buffer.alloc(0);
  const effectiveMaster = masterBlob ?? Buffer.alloc(0);

  // Fast-forward: master has NOT moved since the caller's base - no parallel session landed on
  // this page, so there is no sibling content to protect. Trust the caller's copy verbatim,
  // INCLUDING a deliberate in-place deletion ("correcting stale claims in place" is a core wiki
  // convention, the WIKI write-back rule). The containment guard is deliberately NOT run on this
  // branch: with master === base it cannot distinguish a legitimate solo deletion from a
  // stale-snapshot reversion (both are "master==base, caller drops a line, adds nothing"), and
  // refusing the former is a false-positive that breaks routine maintenance (review finding,
  // plan 1697). The guard runs ONLY on the true 3-way-merge branch below, where master HAS
  // diverged from base and there is genuinely concurrent content at stake.
  if (bufEq(effectiveMaster, effectiveBase)) return { action: 'write', content: callerContent };
  if (bufEq(effectiveMaster, callerContent)) return { action: 'skip' }; // master already has it

  const merged = tryThreeWayMerge(effectiveBase, callerContent, effectiveMaster, {
    union: unionMerge,
    pagePath,
  });
  if (merged === null) return { action: 'conflict' }; // real conflict (never for union)

  // plan 1697 (decision b): master diverged, so the merged result is trusted only once it clears
  // the containment guard - it must not drop the caller's own additions (A), nor reduce to a NET
  // deletion of master content (B): a stale-base caller deleting a line WHILE a sibling advanced
  // master is exactly the silent-reversion signature the two live incidents hit.
  const violation = checkContainment({
    effectiveBase,
    effectiveMaster,
    callerContent,
    content: merged,
  });
  if (violation) return violation;
  return { action: 'write', content: merged };
}

// plan 1604: is `branch` a worktree session's branch (worktree-<slug>)? Pure + exported
// so the auto-detect logic is unit-testable without spinning up a real worktree.
// plan 1616: delegates to the canonical slugFromBranch (redgreen-lib.mjs) instead of its own
// inline `/^worktree-/` copy — the same detector done-worktree.mjs and record-review.mjs /
// record-wiki.mjs now all share, PLUS an explicit bare-`worktree-` fallback (review fix,
// batch-2026-07-08-coord-spine3): slugFromBranch's `(.+)` capture requires a non-empty slug,
// so a literal branch named `worktree-` (nothing after the dash) resolves to null and would
// silently fall through to the MAIN-checkout branch below — routing a wiki commit straight
// onto that branch instead of through the disposable coord-checkout (the exact plan-1536
// hazard this whole routing exists to prevent). `assertSlugCharset`'s `SLUG_CHARSET_RX`
// (scripts/coord/claim-plan-lib.mjs) already rejects an empty slug at branch-creation time, but
// THIS function is the one guarding a security-relevant routing decision — it must not rely
// on an invariant enforced only in a different file to stay safe.
export function isWorktreeSessionBranch(branch) {
  return slugFromBranch(branch) !== null || /^worktree-$/.test((branch || '').trim());
}

// Arg surface (via the shared coord-git parseFlags, plan 1769): positionals are wiki pages;
// -m/--message consumes the next token unconditionally; --no-push/--dry are booleans; an
// unknown flag is a loud error (catches typos instead of silently treating them as a page path).
export function parseWikiCommitArgs(argv) {
  const { positionals, flags } = parseFlags(argv, {
    label: 'wiki-commit',
    value: ['message'],
    boolean: ['no-push', 'dry'],
    alias: { m: 'message' },
  });
  return {
    paths: positionals,
    flags: {
      noPush: flags['no-push'] === true,
      dry: flags.dry === true,
      message: flags.message ?? null,
    },
  };
}

// plan 3411: the ONE named exception to WIKI_RX. Registering a new chain wiki page requires a
// matching row in scripts/wiki-chain-registry.mjs's CHAINS array (the wiki-loader-coverage
// bijection between wiki/entities/chains/*.md and CHAINS) — but that registry file lives under
// scripts/, not wiki/, so without this exception the page and its registry row could never land
// in the same commit: page-first fails wiki-commit's own gate (checkWikiLoaderCoverageOrThrow
// sees an orphan page), registry-first lands a dangling entry that reds an unrelated session's
// next scripts/-touching push. Exactly this one file, named and commented, never a general
// widening — WIKI_RX itself (imported above from check-coordination-branch.mjs) is untouched
// and stays the pre-commit guard's own blocked-set definition.
export const CHAIN_REGISTRY_REL = 'scripts/wiki-chain-registry.mjs';

// plan 3411: drop CHAIN_REGISTRY_REL from a relPaths list before it reaches a WIKI-PAGE budget
// or lint check (checkSizeOrThrow) — those enforce per-page size caps that have no meaning
// applied to a script module, not a wiki page. Used at every checkSizeOrThrow call site; never
// applied to checkWikiLoaderCoverageOrThrow, which is meant to see the whole commit (the pages
// in it are what select the coverage test — the registry path itself matches no
// DATA_DEPENDENCY_MAP glob, so including it there is a harmless no-op, not a hazard).
export function wikiPagesOnly(relPaths) {
  return relPaths.filter((p) => p !== CHAIN_REGISTRY_REL);
}

// Normalize (via the shared normalizeRel — never a second copy of that logic) and
// enforce the guard's own WIKI_RX scope. Anything outside it is refused loudly — coord
// docs have their own tools, and silently widening the pathspec would re-open the sweep
// class this helper exists to close.
export function normalizeWikiPaths(paths) {
  if (!paths.length)
    throw new Error('wiki-commit: no pages given (pass one or more wiki/** paths)');
  return paths.map((raw) => {
    const p = normalizeRel(raw);
    if (p.split('/').includes('..'))
      throw new Error(`wiki-commit: refusing path with "..": ${raw}`);
    // plan 3411: the one named exception — see CHAIN_REGISTRY_REL above. Checked BEFORE the
    // WIKI_RX test below so the exact-match short-circuits it; every other non-wiki path still
    // falls through to the unchanged refusal (the CLI exit-code classifier at the bottom of this
    // file regex-matches that refusal's wording verbatim).
    if (p === CHAIN_REGISTRY_REL) return p;
    if (!WIKI_RX.test(p) || p === 'wiki/')
      throw new Error(
        `wiki-commit: "${raw}" is not under wiki/ (or WIKI.md) — this helper commits ONLY wiki pages ` +
          '(coord docs go via board.mjs / index.mjs / move-plan / edit-plan / coord-edit).',
      );
    return p;
  });
}

// Prettier-format the pages that exist on disk, IN-PROCESS via the prettier API (a
// deleted page has nothing to format; a .prettierignore'd or unparseable file is
// skipped, mirroring `--ignore-unknown`). Returns the paths that exist.
//
// SINCE PLAN 2389 THIS IS A NO-OP FOR EVERY WIKI_RX PATH — i.e. every accepted path EXCEPT the
// one plan-3411 exception below. `ignorePath` below opts into `.prettierignore` (the JS API does
// NOT consult it by default — this call site is what makes it apply), and `.prettierignore`
// covers `/wiki/` + `/WIKI.md`, which is exactly WIKI_RX. So `info.ignored` is true for every
// wiki page and the format branch never runs for them. Deliberately left in place: see the file
// header (item 1) for why removing it is a separate change, and note that the pre-push
// `prettier --check` reads the same ignore file, so nothing starts failing because this stopped
// formatting wiki content.
// If you are here because a wiki page came back reformatted anyway, the ignore entry regressed
// — check the wiki prettier-ignore test before touching this function.
//
// PLAN 3411 EXCEPTION: scripts/wiki-chain-registry.mjs (CHAIN_REGISTRY_REL, the one non-wiki
// path normalizeWikiPaths accepts) is an ordinary scripts/**/*.mjs file — `.prettierignore` has
// no scripts/ entry, so it is NOT ignored here and DOES flow through prettier.format() like real
// source. That is deliberate, not a gap left by the no-op claim above: the pre-push
// `prettier --check` gate expects scripts/*.mjs formatted, so formatting the registry here
// (rather than excluding it from this call) is the safer behavior — a registry edit landing
// unformatted would otherwise red the next unrelated session's scripts/-touching push instead of
// being fixed as part of this commit.
export async function prettierWrite(mainDir, relPaths, { _prettier = null } = {}) {
  const existing = relPaths.filter((p) => existsSync(join(mainDir, p)));
  if (!existing.length) return existing;
  const prettier = _prettier ?? (await import('prettier')).default;
  const ignorePath = join(mainDir, '.prettierignore');
  for (const rel of existing) {
    const abs = join(mainDir, rel);
    const info = await prettier.getFileInfo(abs, {
      ignorePath: existsSync(ignorePath) ? ignorePath : undefined,
      resolveConfig: true,
    });
    if (info.ignored || !info.inferredParser) continue;
    const src = readFileSync(abs, 'utf8');
    const cfg = (await prettier.resolveConfig(abs)) ?? {};
    const out = await prettier.format(src, { ...cfg, filepath: abs });
    if (out !== src) writeFileSync(abs, out);
  }
  return existing;
}

// Stage + pathspec-commit the pages on MAIN, then push (unless noPush). Since plan 1286
// this is ONLY the --no-push (local, offline/test) engine — the default path lands via
// withCoordCheckout + coordWrite in main(). Mirrors record-wiki.commitWikiMarker: HUSKY=0,
// lock-retry add/commit, tolerate the half-land "nothing to commit" ONLY when HEAD's
// subject confirms our commit, injectable seams. Returns { noop:true } when none of the
// pages differ from HEAD.
export function commitWikiPages(
  mainDir,
  relPaths,
  {
    message,
    noPush = false,
    _git = git,
    _gitRetry = gitWithLockRetry,
    _push = pushMasterWithRebase,
    retryOpts = {},
  } = {},
) {
  const env = { ...gitRepoIsolatedEnv(), HUSKY: '0' };
  const dirty = _git(mainDir, ['status', '--porcelain', '--', ...relPaths], { env }).trim();
  if (!dirty) return { noop: true };
  checkSizeOrThrow(mainDir, wikiPagesOnly(relPaths)); // D1 — pre-commit, on the on-disk content
  // plan 3411 (review finding): the loader-coverage gate ran ONLY on the default coord-checkout
  // path, so this --no-push engine could commit a page/registry pair (or, since the exception, a
  // registry row alone) with the bijection broken — a local commit, but one a later plain
  // `git push` of MAIN's master carries to origin with no hook in between (HUSKY=0 here). Same
  // placement reasoning as checkSizeOrThrow above: pre-commit, against the on-disk content. In a
  // fixture repo the mapped test file does not exist and the gate self-skips, so the offline
  // escape hatch stays offline.
  checkWikiLoaderCoverageOrThrow(mainDir, relPaths);
  _gitRetry(mainDir, ['add', '--', ...relPaths], { env, ...retryOpts });
  try {
    _gitRetry(mainDir, ['commit', '-m', message, '--', ...relPaths], { env, ...retryOpts });
  } catch (e) {
    if (!(isNothingToCommit(errText(e)) && commitSubjectAtHead(mainDir, message))) throw e;
  }
  if (!noPush) _push(mainDir);
  return { noop: false, pushed: !noPush };
}

export async function main() {
  const { paths: rawPaths, flags } = parseWikiCommitArgs(process.argv.slice(2));
  if (!flags.message || !flags.message.trim()) {
    console.error(
      'wiki-commit: a commit message is required: node scripts/wiki-commit.mjs <pages…> -m "chore(wiki): …"',
    );
    return 2;
  }
  const relPaths = normalizeWikiPaths(rawPaths); // throws (→ exit 2 below) on a non-wiki path

  const MAIN = resolveMain();

  // plan 1604: auto-detect a worktree session from the CALLING checkout's branch (no
  // flag to remember — mirrors record-wiki.mjs's own `/^worktree-/` check). When the
  // caller is on a worktree-<slug> branch, the page content lives on THAT checkout's
  // disk, not MAIN's — sourceDir switches to the caller's own toplevel so every read
  // below (missing-check, dry status, prettier, capture, and the final revert) operates
  // on the checkout that actually holds the edit. A main-checkout session is unaffected:
  // sourceDir === MAIN, byte-identical to pre-1604 behavior.
  const cwd = process.cwd();
  const callerBranch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  // `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD" for a detached
  // checkout (e.g. mid-rebase, or a worktree's post-merge "finish" state) — refuse loudly
  // rather than let isWorktreeSessionBranch('HEAD') silently classify it as a main-checkout
  // session and read/capture from MAIN's disk instead of the checkout that actually holds
  // the edit (/sonnet-review xhigh on this same batch, 2026-07-08).
  if (callerBranch === 'HEAD') {
    console.error(
      'wiki-commit: cwd has a DETACHED HEAD — cannot auto-detect worktree-session routing ' +
        '(plan 1604 routes by branch name; a detached checkout has none). Check out a branch ' +
        '(the worktree branch, or master on MAIN) before writing back wiki pages.',
    );
    return 2;
  }
  const fromWorktree = isWorktreeSessionBranch(callerBranch);
  const sourceDir = fromWorktree ? git(cwd, ['rev-parse', '--show-toplevel']).trim() : MAIN;

  if (fromWorktree && flags.noPush) {
    console.error(
      'wiki-commit: --no-push is a MAIN-only local/offline escape hatch — refusing it from a ' +
        `worktree session (branch "${callerBranch}"), which must always land straight to master, ` +
        'never commit on its own branch (plan 1604). Drop --no-push.',
    );
    return 2;
  }

  // A path that neither exists on disk nor is tracked is a typo, not a no-op — error
  // loudly instead of masking a lost write-back behind "nothing to commit" (a tracked
  // page deleted from the working tree stays legal: the commit records the deletion).
  const missing = relPaths.filter(
    (p) => !existsSync(join(sourceDir, p)) && !git(sourceDir, ['ls-files', '--', p]).trim(),
  );
  if (missing.length) {
    console.error(
      `wiki-commit: no such page (not on disk, not tracked) — check for a typo:\n  ${missing.join('\n  ')}`,
    );
    return 2;
  }

  if (flags.dry) {
    const dirty = git(sourceDir, ['status', '--porcelain', '--', ...relPaths]).trim();
    console.log(
      `[dry] wiki-commit: ${dirty ? `would prettier --write, then pathspec-commit + ${flags.noPush ? 'skip push' : 'push'}` : 'pages match HEAD — would be a no-op'} (source: ${sourceDir}):\n` +
        relPaths.map((p) => `  ${p}`).join('\n') +
        `\n  message: ${flags.message}`,
    );
    return 0;
  }

  await prettierWrite(sourceDir, relPaths);

  let res;
  if (flags.noPush) {
    // Local-only escape hatch (offline / tests): pathspec-commit on MAIN as before plan 1286,
    // no push. The DEFAULT path below never commits on MAIN. (fromWorktree already refused
    // this combination above — sourceDir === MAIN whenever we reach here.)
    res = commitWikiPages(MAIN, relPaths, { message: flags.message, noPush: true });
  } else {
    // plan 1286 (extended by plan 1604 to a worktree sourceDir): land via the DISPOSABLE
    // coord-checkout under the coord-write lock — the prettier-formatted page content is
    // captured from sourceDir's disk, replayed into the checkout, and committed+pushed
    // there (coordWrite: pathspec commit, scoped rollback, non-ff retry). No MAIN commit,
    // and above all no pushMasterWithRebase REBASE of the shared MAIN (the transient-
    // detached-HEAD class every sibling saw in the incident). A tracked page deleted from
    // sourceDir's tree is replayed as a deletion.
    const captured = relPaths.map((rel) => {
      const abs = join(sourceDir, rel);
      return existsSync(abs)
        ? { rel, exists: true, content: readFileSync(abs) }
        : { rel, exists: false };
    });
    const capturedByRel = new Map(captured.map((c) => [c.rel, c]));

    // plan 1622: stale-base guard. Without this, the mutate() below would blast `captured`'s
    // whole-file content over master regardless of what a PARALLEL session landed on this same
    // page since sourceDir's checkout branched off origin/master — silently REVERTING it (proven:
    // cad20b0c19f92e7a39d6572b6999a699cc6975de clobbering the plan-1614 urn bullet the same day
    // it landed). `mergeBase` and each page's blob AT that base are resolved ONCE here, from
    // sourceDir — sourceDir's own HEAD
    // cannot move during this command, and (being a linked worktree of the same repo, or MAIN
    // itself) it shares the object store with the coord-checkout below, so a sha resolved here
    // stays readable from cdir. `masterBlob`, by contrast, is read fresh INSIDE mutate() on every
    // coordWrite retry (below) — coordWrite ff-merges origin/master onto cdir before each attempt,
    // and reading master's content here, before the land even starts, would recreate the exact
    // staleness bug this guard exists to close.
    let mergeBase;
    try {
      // plan 3415 Item C review (cluster 11): refresh sourceDir's OWN view of origin/master
      // before resolving the merge-base against it. Without this, a session whose checkout has
      // not fetched recently reads a STALE local `origin/master` ref here — if the caller's
      // branch was actually rebased onto a NEWER master (this checkout's ref just hasn't caught
      // up), mergeBase/baseBlobs are then read at an OLDER ancestor than the true one, and an
      // unrelated, genuinely disjoint edit can spuriously 3-way-conflict against master's later
      // history, falsely refusing a commit that should have landed clean. Best-effort, exactly
      // like reattachMainToMaster's own fetch: an offline session judges the merge-base against
      // whatever refs it already has rather than failing outright.
      try {
        git(sourceDir, ['fetch', '--quiet', 'origin', 'master']);
      } catch (e) {
        // plan 3415 Item C review round 3 (finding 13nxuip): offline is a legitimate, non-fatal
        // case — the guard must still run on whatever refs sourceDir already has, rather than
        // block a genuinely disconnected session. But swallowing the failure SILENTLY made the
        // guard's own verdict dishonest about what it actually checked: a session whose local
        // origin/master ref has simply gone stale (not offline — a transient network blip, or
        // just "hasn't fetched in a while") got no signal that the merge-base it is about to
        // trust may itself be stale, undermining the exact staleness this guard exists to catch.
        console.error(describeStaleFetchFailure(sourceDir, e));
      }
      mergeBase = git(sourceDir, ['merge-base', 'HEAD', 'origin/master']).trim();
    } catch (e) {
      throw new Error(
        `wiki-commit: could not resolve a merge-base between HEAD and origin/master in ` +
          `${sourceDir} (needed for the stale-base guard) — ${errText(e)}`,
      );
    }
    const baseBlobs = gitShowBlobsOrNull(sourceDir, mergeBase, relPaths);

    const env = { ...gitRepoIsolatedEnv(), HUSKY: '0' };
    // plan 1697 (decision c): the revert runs ONLY on the SUCCESS path — NOT in a finally.
    // Every refuse (the plan-1622 stale-base conflict, the D1 page-budget caps, and the new
    // plan-1697 containment guard) throws out of withCoordCheckout; the pre-1697 unconditional
    // `finally { revertPathsToHead }` then reset sourceDir's named pages to HEAD, DESTROYING the
    // very edits the refusal was protecting — the caller had to re-apply from scratch each round
    // (the observed 3-round re-application tax, sessions 1548/1549). Now a throw skips straight to
    // main()'s catch, leaving the caller's working copies untouched (prettierWrite already
    // reformatted them, so what survives is exactly the caller's edit, ready for a re-read +
    // re-apply). On SUCCESS the redundant on-disk dirt is cleared below, as before — in a worktree
    // session that is the worktree's own checkout (so the landed content can never ride the
    // worktree branch, the plan-1604 invariant), in a main-checkout session it is MAIN.
    res = withCoordCheckout(
      MAIN,
      (cdir) => {
        return coordWrite(cdir, {
          relPaths,
          mutate: () => {
            // plan 1622: resolve EACH page's write action against cdir's just-freshened HEAD —
            // coordWrite's fetch + `merge --ff-only origin/master` ran immediately before this
            // mutate() call on this retry, so `HEAD:<rel>` in cdir right now IS the fresh master
            // tip (never a stale local ref re-creating the bug the guard fixes). plan 1641: ONE
            // batched subprocess reads every page's master blob for this retry, instead of one
            // `git show` per page re-spawned on each of coordWrite's up-to-8 retries.
            const masterBlobs = gitShowBlobsOrNull(cdir, 'HEAD', relPaths);
            // plan 2764: the journal's before/after for THIS retry, captured only if the
            // journal is among the pages actually written — the input to the duplication
            // guard below.
            let journalPrev = null;
            let journalNext = null;
            for (const rel of relPaths) {
              const c = capturedByRel.get(rel);
              const callerContent = c.exists ? c.content : null;
              const baseBlob = baseBlobs.get(rel);
              const masterBlob = masterBlobs.get(rel);
              const decision = resolveStalePageContent(
                { baseBlob, masterBlob, callerContent },
                { unionMerge: rel === JOURNAL_REL, pagePath: rel }, // plan 1697 (a): the journal union-merges
              );
              const abs = join(cdir, rel);
              if (decision.action === 'conflict') {
                // plan 1697 (b): the containment guard has its own, more specific refusals
                // (a stale-snapshot reversion / a dropped caller addition); the bare
                // 'conflict' with no reason is the plan-1622 3-way conflict.
                const detail = (decision.detail ?? []).filter(Boolean).join(' | ');
                if (decision.reason === 'containment-reversion') {
                  throw new Error(
                    `wiki-commit: refusing to commit ${rel} — the write would DELETE lines that ` +
                      `exist on current origin/master while adding nothing of its own, i.e. its ` +
                      `net effect is only removing landed content. Your working copy looks stale ` +
                      `(it predates content that has since landed). Re-read ${rel} from current ` +
                      `origin/master, re-apply your edit, and retry — your copy is left intact.` +
                      (detail ? ` Would drop: ${detail}.` : '') +
                      ` (plan 1697 containment guard — never silently reverting landed wiki content.)`,
                  );
                }
                if (decision.reason === 'containment-caller-adds') {
                  throw new Error(
                    `wiki-commit: refusing to commit ${rel} — the 3-way merge dropped your own ` +
                      `added line(s) (${detail || 'unknown'}); a clean merge must never lose the ` +
                      `caller's contribution. Re-read ${rel} from current origin/master, re-apply ` +
                      `your edit, and retry — your copy is left intact. (plan 1697 containment guard.)`,
                  );
                }
                // plan 3415 Item C fix 1: the updated:-line's own guard — reached only when a
                // resolveUpdatedOnlyConflicts substitution (tryThreeWayMerge, above) produced a
                // survivor date that is somehow OLDER than either side's, or dropped the line
                // outright. This should never fire from the resolver's own normal output (it
                // always picks the later date, or merges both on a tie) — seeing it means the
                // resolver itself regressed, not a routine collision.
                if (
                  decision.reason === 'containment-updated-regressed' ||
                  decision.reason === 'containment-updated-missing'
                ) {
                  throw new Error(
                    `wiki-commit: refusing to commit ${rel} — the updated: line the merge would ` +
                      `write is ${decision.reason === 'containment-updated-missing' ? 'MISSING' : 'OLDER than one of the two sides'} ` +
                      `(${detail || 'unknown'}); the updated:-line resolver must never regress the ` +
                      `date. Re-read ${rel} from current origin/master, re-apply your edit, and ` +
                      `retry — your copy is left intact. (plan 3415 Item C containment guard.)`,
                  );
                }
                throw new Error(
                  `wiki-commit: refusing to commit ${rel} — master's copy changed since your ` +
                    `checkout's base and the edits conflict (a clean 3-way merge was not ` +
                    `possible). Re-read ${rel} from current origin/master, re-apply your edit, ` +
                    `and retry (plan 1622 stale-base guard — never silently overwriting a ` +
                    `parallel session's landed wiki content).`,
                );
              }
              if (decision.action === 'skip') continue; // already matches master
              if (decision.action === 'delete') {
                rmSync(abs, { force: true });
                continue;
              }
              mkdirSync(dirname(abs), { recursive: true });
              writeFileSync(abs, decision.content);
              if (rel === JOURNAL_REL) {
                journalPrev = masterBlob;
                journalNext = decision.content;
              }
            }
            // plan 2764: the append-only journal must never gain structural duplication.
            // This seat is load-bearing rather than belt-and-braces: the coord-checkout push
            // below runs NO git hooks (branch-hygiene § "The coord-checkout push runs NO git
            // hooks"), so the pre-push copy of this lint provably cannot see a wiki-commit
            // write — and all eight copies of wiki/log.md's history arrived through exactly
            // this path. Placed with the same reasoning as checkSizeOrThrow's E1 call: after
            // coordWrite's fresh-base merge, against the content that will actually be
            // committed, re-evaluated on every retry. Delta-scoped (a write may not ADD
            // duplication) so it needs no ordering against the one-shot cleanup.
            checkJournalOrThrow(journalPrev, journalNext);
            // plan 1475 (item 1): recompute the hook-referenced basename set INSIDE mutate()
            // — i.e. once per coordWrite retry — NOT once before the loop (plan 1398 item 3's
            // memo, reverted here). coordWrite ff-merges origin/master before each of its
            // up-to-8 retries, so a sibling can newly wire a wiki page into a `scripts/hooks/**`
            // loader mid-window; the outside-the-loop snapshot then classified that page against
            // the STALE (looser `pull`) budget, reopening the exact write-time-catch gap plan
            // 1362 D1 closed. wiki-commit is not a hot coord path, so re-walking the hooks dir
            // per retry is an acceptable trade for a fresh classification input.
            const hookBasenames = collectHookReferencedBasenames(cdir);
            // E1 (plan 1362): check AFTER the fresh-base merge (coordWrite's freshen
            // already ran before mutate()), against the on-disk POST-MERGE content —
            // exactly the 2026-07-03 price-inspector case, where a page only exceeded
            // the cap once a peer's growth merged in. Re-runs on every retry — correct,
            // not wasteful (E1). BOTH inputs are now fresh per retry: the content size and
            // (plan 1475) the hook-basename budget.
            checkSizeOrThrow(cdir, wikiPagesOnly(relPaths), { hookBasenames });
            // plan 2070 Group B: same placement logic — post-merge, on cdir, every retry — for
            // the wiki-loader-coverage gate (a no-op unless relPaths touches the map's globs).
            checkWikiLoaderCoverageOrThrow(cdir, relPaths);
          },
          message: flags.message,
          tool: 'wiki-commit',
        });
      },
      { tool: 'wiki-commit' },
    );
    // plan 1604 + 1697: reached ONLY when the land above SUCCEEDED (any refuse threw past this
    // point). Revert sourceDir, not unconditionally MAIN — in worktree-session mode this is the
    // WORKTREE checkout, discarding the now-landed local edit so it can never ride a commit on the
    // worktree branch. A refuse deliberately skips this, preserving the caller's uncommitted edit.
    revertPathsToHead(sourceDir, relPaths, env);
    // Landed (or already on origin): after reverting sourceDir's redundant dirt above, best-effort
    // ff MAIN so its on-disk pages (main-checkout case) or just its local master ref (worktree-
    // session case, where MAIN's disk was never touched) come right back current. When a sibling's
    // dirt blocks the ff, origin holds the truth and MAIN just lags.
    try {
      ffMasterFromOrigin(MAIN, { env });
    } catch {
      /* dirty/diverged MAIN — MAIN catches up on a later ff */
    }
  }
  if (res.noop) {
    // plan 1604: the OLD message here ("edited them inside a plan worktree? They land via your
    // branch merge — no helper needed") was the root-cause guidance the plan-1536 landing-queue
    // incident traced to — do not resurrect it. A worktree session always routes through this
    // helper now; there is no branch-merge path for wiki/** left to point to.
    console.log(
      'wiki-commit: nothing to commit — the named pages already match master (after formatting)' +
        `${fromWorktree ? ` (source: ${sourceDir})` : ''}.`,
    );
    return 0;
  }
  console.log(
    `wiki-commit: committed ${relPaths.length} page(s)${flags.noPush ? ' (push skipped)' : ' + pushed'}.`,
  );
  if (!relPaths.includes('wiki/log.md')) {
    console.error(
      'wiki-commit: reminder — the write-back rule also appends one line to wiki/log.md ' +
        '(newest first) and bumps the page `updated:` date. Commit it the same way if you have not.',
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main());
  } catch (e) {
    const usage = /^wiki-commit: (unknown flag|no pages|refusing path|"[^"]+" is not under wiki\/)/;
    console.error(e.message);
    process.exit(usage.test(e.message) ? 2 : 1);
  }
}
