#!/usr/bin/env node
// scripts/assert-lock-free-git-polls.mjs — lock-free git-poll gate (plan 3974 T1b).
//
// WHY: plan 3974's T0 traced a land's rebase dying on a stray
// `.git/worktrees/<slug>/index.lock` back to per-session read-only pollers/hooks
// (`scripts/redgreen.mjs`'s statusline lamp, `scripts/hooks/coord-write-guard-pretooluse.mjs`'s
// PreToolUse classifier) running `git status`/`git diff` in a worktree's cwd WITHOUT
// `--no-optional-locks` — on a 131k-file tree a plain `git status` can itself WRITE the index
// (refreshing stat cache / the untracked-cache extension), taking the same lock a concurrent
// rebase needs. T1 made every such poller lock-free (`--no-optional-locks` on the spawn argv,
// prepended inside each file's local wrapper so every caller inherits it with one edit); THIS
// gate keeps a new one from landing unflagged.
//
// SCOPE: non-test `scripts/hooks/**/*.mjs` and `scripts/redgreen*.mjs` — the two surfaces T0
// named as lock takers. NOT `scripts/hooks/pre-push.sh`'s own `git diff --name-only` calls (gate
// scoping inside a push is not polling — the plan says so explicitly) and NOT the seam-guard /
// spine / lock modules (`scripts/coord/worktree-lock.mjs`, `scripts/coord/land-lib.mjs`, `scripts/done-worktree.mjs`,
// …) — none of those live under this gate's scope, and none should: a lock module's whole JOB is
// to take a lock, deliberately, and a spine push runs `git diff` scoped to the push it is itself
// making, not on a poll cadence a rebase can collide with.
//
// WHY A NEW MODULE, NOT A CASE FOLDED INTO scripts/assert-posix-path-assertions.mjs (the repo's
// "fold into an existing name-paired test file" default): that gate's `SCOPE_PATHSPECS` covers
// `scripts/**/*.test.mjs` and `backend/scripts/**/*.py` ONLY — test-assertion source. This rule
// judges NON-test source (`scripts/redgreen.mjs`, `scripts/hooks/**`), a disjoint corpus with a
// disjoint violation shape (a missing spawn flag, not a platform-dependent assertion), so it is
// the name-pair of a genuinely new module rather than a case in an existing one.
//
// THE HELPER-INDIRECTION PROBLEM. Both fixed call sites route through a per-file wrapper
// (`redgreen.mjs`'s `gitOut`, `coord-write-guard-pretooluse.mjs`'s `git()`) that takes a caller-
// supplied argv array and forwards it straight into `execFileSync('git', args, …)` — the wrapper
// itself decides whether the flag is present, and a caller like `git(['status', '--porcelain'], cwd)`
// never spells `--no-optional-locks` at its own call site at all. A regex hunting for the LITERAL
// argv `['status', …]` missing the flag would therefore either (a) match every ordinary CALL SITE
// of an already-safe wrapper and false-positive forever, or (b) match nothing and never see the
// real spawn. This gate instead judges the SPAWN SITE (the one `execFileSync('git', …)` per
// wrapper), and treats a wrapper that unconditionally prepends the flag to whatever argv it is
// given (`['--no-optional-locks', ...args]`) as satisfying the rule for EVERY caller — the wrapper
// carries the flag once, so its callers never need to.
//
// TWO SHAPES A SPAWN SITE CAN TAKE, judged differently:
//
//   (a) DIRECT — the argv is a literal array AT THE SPAWN SITE containing a literal `'status'` or
//       `'diff'` element (`execFileSync('git', ['status', '--porcelain'])`, `bulk-fable-…`'s
//       `['rev-parse', …]` never matches this — no status/diff literal, so it is out of THIS rule's
//       scope regardless of the flag's presence, same as the file header's `pre-push.sh` carve-out
//       one level up). Judged UNCONDITIONALLY: `--no-optional-locks` (a GLOBAL git option) must
//       appear, as a literal, BEFORE the status/diff literal in the same array.
//
//   (b) PASSTHROUGH — the argv at the spawn site is either a bare identifier (`args`, wholly
//       opaque — the pre-fix shape of both wrappers) or a literal array containing a `...spread`
//       element (`['-C', repoRoot, ...args]`, `review-round-cap-guard.mjs`'s `runGit`) — in both
//       cases the actual subcommand is decided by the CALLER, not visible at the spawn site. A
//       passthrough spawn is judged UNSAFE the same way — flag literal missing, or present but not
//       ordered before the spread — but flagging every such wrapper unconditionally would false-
//       positive on `runGit`, which forwards to git for commands this gate has no reason to
//       believe are ever `status`/`diff` (nothing in its own file suggests otherwise). So a
//       passthrough spawn is only a violation when the SAME FILE also carries evidence that this
//       file spawns git status/diff at all — a literal `'status'` or `'diff'` string ANYWHERE in
//       the file (a direct spawn elsewhere, or a call site of the very wrapper passing one). Both
//       `redgreen.mjs` (the `gitOut(['status', '--porcelain'])` call in `gatherSignals`) and
//       `coord-write-guard-pretooluse.mjs` (the `git(['status', …])` / `git(['diff', …])` call
//       sites) carry that evidence; `review-round-cap-guard.mjs` does not, so its passthrough
//       `runGit` is correctly left unflagged. KNOWN BOUND, file-scoped (not call-graph-scoped) —
//       if a wrapper is only ever invoked with a literal status/diff argv from ANOTHER file, this
//       gate cannot see that. Measured against the current `scripts/hooks/**` corpus: zero such
//       cross-file cases exist (`grep -rn "'status'\|'diff'"` across every non-test hook file only
//       ever hits the two fixed files). A future one is either caught the same way as any other
//       gate residual — self-read + a waiver naming the reason — or promotes this gate's evidence
//       scan to repo-wide if the false-negative risk becomes real. THIS BOUND WAS HIT FOR REAL
//       (plan 3974 review finding f234fa): `review-round-cap.mjs`'s calls into `runGit` with
//       `['diff', '--quiet', 'HEAD']` live at `scripts/coord/review-round-cap.mjs` — outside this gate's
//       SCOPE_PATHSPECS entirely, not merely a different file within it — so no evidence-scan
//       promotion inside this gate's own scope would ever have seen that caller. Fixed at the
//       POLLER instead (`runGit` now prepends the flag unconditionally); the lint's blind spot to
//       an out-of-scope caller stands as a documented limit, not a bug to chase here.
//
// WAIVER: `// lock-free-poll-ok: <reason>` on the violating line, or anywhere in the contiguous
// comment block directly above it — mirroring assert-posix-path-assertions.mjs's
// `WAIVER_MARKER_RX` discipline exactly: a bare marker with no non-whitespace reason does NOT waive.
//
// HOW IT RUNS: diff-scoped like the rest of the `run_range_guard` family, via the shared
// seam-guard-lib.mjs helpers (`collectAddedByFile`, `fetchRangeDiff`, `readFileAtTip`, `rangeTip`) —
// only a violation whose text was ADDED by the pushed range blocks, so the pre-existing corpus
// (there is none today, but a future grandfathered exception would work the same way) never gates
// an unrelated push. `--all` sweeps the whole working-tree corpus (same acceptance-2 pattern as
// assert-posix-path-assertions.mjs and assert-color-tokens.mjs). Fail-open SKIP on an unresolvable
// base or a failed diff/blob read — the done-worktree land re-runs this gate.
//
// NOT COVERED: `exec`/`execSync` (a shell-string command, `exec('git status')`) — neither file in
// scope uses that shape; only `execFileSync`/`execFile`/`spawnSync`/`spawn` with an explicit `'git'`
// program argument are matched. A future shell-string spawn is a new shape this gate does not see;
// note it here rather than silently pretending coverage is total.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { errText, resolveGuardRanges } from './coord/coord-git.mjs';
import {
  fetchRangeDiff,
  readFileAtTip,
  rangeTip,
  collectAddedByFile as collectAddedByFileShared,
  // Reused rather than re-implemented (plan 3974 review finding 7b2bad): splits a call's top-level
  // arguments, quote- and nesting-aware — exactly what this file needs to pull the argv text out
  // of a `git` spawn's second argument. See the header comment on `balancedSpan` below for the one
  // thing it does NOT give us and why `balancedSpan` still exists alongside it. Lives in this
  // shared low-level module (not assert-posix-path-assertions.mjs, plan 3974 review round 2,
  // finding 214563) so this file never has to import a whole other gate for one helper.
  splitCallArgs,
} from './seam-guard-lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// `scripts/coord/redgreen*.mjs` is listed explicitly, not folded into a `scripts/**` glob:
// plan 3962 moved redgreen-lib.mjs into the coord core, and this rule judges POLLERS, which is a
// named short list — widening the pathspec to the whole tree would change what the gate means.
export const SCOPE_PATHSPECS = [
  ':(glob)scripts/hooks/**/*.mjs',
  ':(glob)scripts/redgreen*.mjs',
  ':(glob)scripts/coord/redgreen*.mjs',
];

export function inScope(path) {
  if (path.startsWith('scripts/hooks/') && path.endsWith('.mjs')) return true;
  if (/^scripts\/(?:coord\/)?redgreen[^/]*\.mjs$/.test(path)) return true;
  return false;
}

// This gate's own test file's fixtures ARE violating source text by construction; every other
// `.test.mjs` is exempt too (a hook/poller's OWN test file legitimately builds fixture strings that
// happen to contain `'git'`/`'status'` text, none of it a real spawn this rule should judge).
export const SELF_TEST_PATH = 'scripts/assert-lock-free-git-polls.test.mjs';
export function isExempt(path) {
  return path.endsWith('.test.mjs');
}

// `// lock-free-poll-ok: <reason>` — a marker with a NON-EMPTY reason. Mirrors
// assert-posix-path-assertions.mjs's WAIVER_MARKER_RX discipline (a bare marker does not waive).
const WAIVER_RX = /\/\/\s*lock-free-poll-ok:\s*\S/;

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || /^\*(?:\s|\/|$)/.test(t);
}

function waivedFromAbove(lines, i) {
  if (WAIVER_RX.test(lines[i])) return true;
  for (let j = i - 1; j >= 0 && isCommentLine(lines[j]); j--) {
    if (WAIVER_RX.test(lines[j])) return true;
  }
  return false;
}

// A `git` spawn: execFileSync/execFile/spawnSync/spawn with an explicit `'git'`/`"git"` program
// argument (see the header's "NOT COVERED" note for what this deliberately does not match).
const GIT_CALL_RX = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*(['"])git\1\s*,/g;

// The balanced span `[start, end]` (both inclusive, indices into `text`) of the bracketed region
// opening at `openIdx` — quote-aware (a `[`/`]`/`(`/`)` inside a string never desyncs the depth
// count). Returns null if the text ends before the region closes (defensive; not expected on a
// well-formed file).
//
// STILL HAND-ROLLED, NOT `splitCallArgs` (plan 3974 review finding 7b2bad considered folding this
// into the import above too): `splitCallArgs` returns only the trimmed TEXT of each top-level
// argument — it discards where each one starts and ends in `text`. This function is used below to
// find the SPAWN CALL's closing paren, whose index this gate needs to compute `endLine` correctly
// for a call written across several lines, e.g.
//   execFileSync('git',
//     ['status', '--porcelain'],
//     { encoding: 'utf8', cwd },
//   );
// `splitCallArgs` would split that into three trimmed strings just fine, but nothing in its return
// value says where the final `)` sits — the one thing `endLine` reporting needs. `splitCallArgs`
// IS used below (via the import) for the argv text itself, which needs no position, only content.
function balancedSpan(text, openIdx) {
  const openChar = text[openIdx];
  const closeChar = { '[': ']', '(': ')', '{': '}' }[openChar];
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return [openIdx, i];
    }
  }
  return null;
}

// The first index of `word` as a whole quoted string literal (`'word'` or `"word"`) in `text`, or
// -1. Used against a bracketed argv-array's raw text, never the whole file.
function indexOfQuotedLiteral(text, word) {
  const m = new RegExp(`(['"])${word}\\1`).exec(text);
  return m ? m.index : -1;
}

// Every `git` spawn call in `text`: `{ start, end, argKind, argText }` — `start`/`end` bound the
// WHOLE call (from the callee name through its closing paren, for line-span reporting); `argKind`
// is 'literal' when the argv at the spawn site is an array literal (`argText` is its bracketed
// text, brackets included) or 'dynamic' when it is anything else (a bare identifier, a member
// expression, …) — the passthrough shape with nothing to inspect at all.
export function findGitSpawnCalls(text) {
  const calls = [];
  GIT_CALL_RX.lastIndex = 0;
  let m;
  while ((m = GIT_CALL_RX.exec(text))) {
    const parenIdx = m.index + m[0].indexOf('(');
    const callSpan = balancedSpan(text, parenIdx);
    if (!callSpan) continue; // malformed / truncated — skip defensively, never crash the gate
    // `args[0]` is the `'git'` literal itself; `args[1]` is the argv — a literal array (kept
    // verbatim, brackets included) or anything else (dynamic passthrough, nothing to inspect).
    const args = splitCallArgs(text, parenIdx);
    const secondArg = args?.[1] ?? '';
    const argKind = secondArg.startsWith('[') ? 'literal' : 'dynamic';
    const argText = argKind === 'literal' ? secondArg : '';
    calls.push({ start: m.index, end: callSpan[1], argKind, argText });
  }
  return calls;
}

// A quoted `status`/`diff` literal sitting in ARGUMENT POSITION — immediately preceded (modulo
// whitespace) by `[`, `(`, or `,`, the only shapes a git arg list actually takes (an array-literal
// element, or a bare call argument). Plan 3974 review finding b78d7c: the prior version matched
// the literal ANYWHERE in the file, so an unrelated `const label = 'status';` false-flagged a
// perfectly safe dynamic wrapper elsewhere in the same file. Requiring argument position rules
// that out while still catching every real spawn-argv shape.
const EVIDENCE_ARG_RX = /[[(,]\s*(['"])(?:status|diff)\1/;

// Does this file spawn git status/diff SOMEWHERE — a `'status'`/`'diff'` literal in argument
// position anywhere in its text? See the header's shape-(b) PASSTHROUGH note for what this gates
// and its known bound (file-scoped, not call-graph-scoped). Run against the WHOLE file text, so
// `\s*` in EVIDENCE_ARG_RX already spans a newline between the opening `[`/`(`/`,` and the
// literal (prettier's one-element-per-line array formatting) — no separate multi-line handling
// needed here.
export function hasStatusOrDiffEvidence(text) {
  return EVIDENCE_ARG_RX.test(text);
}

// A quoted `status`/`diff` literal at the START of a line (optionally trailed by a comma) —
// `EVIDENCE_ARG_RX` above needs the `[`/`(`/`,` that opens argument position to be visible in the
// SAME text it is tested against; that holds for a whole-file scan (`\s*` spans the newline fine)
// but not for a single ADDED LINE checked in isolation, e.g. prettier's one-element-per-line array
// formatting splits `gitOut(['status', …])` across lines so the added line is just `'status',`
// with the opening `[` sitting on a PREVIOUS, unrelated line. Plan 3974 review round 2 findings
// 634891/d197d5: `violationsIntroduced` below tests each added line individually and missed this
// shape entirely. A line that itself STARTS with the literal (module-level array-element
// position) is evidence regardless of what precedes it off-line.
const EVIDENCE_LINE_START_RX = /^(['"])(?:status|diff)\1\s*(?:,|$)/;

// PURE core: every violation `text` contains, `{ line, endLine, kind, text, texts, detail }`
// (1-based line numbers; `texts` is every trimmed, non-blank line of the call — the diff filter
// matches on `texts` so a diff touching any line of a multi-line spawn call still counts as
// introducing it, mirroring assert-posix-path-assertions.mjs's own multi-line assertion handling).
export function findViolations(text) {
  const violations = [];
  const lines = text.split('\n');
  const lineStarts = [0];
  for (const line of lines) lineStarts.push(lineStarts.at(-1) + line.length + 1);
  const lineNumberFor = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo; // 0-based line index
  };
  const evidence = hasStatusOrDiffEvidence(text);

  for (const call of findGitSpawnCalls(text)) {
    const startLine = lineNumberFor(call.start);
    const endLine = lineNumberFor(call.end);
    if (waivedFromAbove(lines, startLine)) continue;

    let detail = null;
    if (call.argKind === 'literal') {
      const flagIdx = indexOfQuotedLiteral(call.argText, '--no-optional-locks');
      const statusIdx = indexOfQuotedLiteral(call.argText, 'status');
      const diffIdx = indexOfQuotedLiteral(call.argText, 'diff');
      const spreadIdx = call.argText.indexOf('...');
      const subIdxCandidates = [statusIdx, diffIdx].filter((x) => x !== -1);
      if (subIdxCandidates.length > 0) {
        // Shape (a) DIRECT — unconditional, regardless of file-wide evidence.
        const subIdx = Math.min(...subIdxCandidates);
        if (flagIdx === -1) {
          detail = 'git status/diff spawn is missing --no-optional-locks';
        } else if (flagIdx > subIdx) {
          detail =
            '--no-optional-locks must appear BEFORE the subcommand (it is a global git option — ' +
            "`git status --no-optional-locks` errors with 'unknown option')";
        }
      } else if (spreadIdx !== -1 && evidence) {
        // Shape (b) PASSTHROUGH via an array literal (`['-C', repoRoot, ...args]`) — only a
        // violation when this file has evidence it spawns status/diff at all.
        if (flagIdx === -1 || flagIdx > spreadIdx) {
          detail =
            'git spawn forwards a caller-supplied argv (…' +
            'spread) without --no-optional-locks preceding it, in a file that also spawns git ' +
            'status/diff — wrap it so the flag always comes first, as redgreen.mjs / ' +
            'coord-write-guard-pretooluse.mjs now do';
        }
      }
      // Neither a status/diff literal nor a spread (e.g. a fixed `['rev-parse', …]` /
      // `['merge-base', …]` call): out of this rule's scope, flag or no flag.
    } else if (evidence) {
      // Shape (b) PASSTHROUGH, fully dynamic (a bare identifier — nothing to inspect at the spawn
      // site at all) — same evidence gate as the array-literal passthrough case above.
      detail =
        'git spawn passes a dynamic argv straight through with no --no-optional-locks, in a file ' +
        'that also spawns git status/diff — wrap it in an array literal that always prepends the ' +
        'flag, as redgreen.mjs / coord-write-guard-pretooluse.mjs now do';
    }

    if (detail) {
      violations.push({
        line: startLine + 1,
        endLine: endLine + 1,
        kind: call.argKind === 'literal' ? 'missing-flag-direct' : 'missing-flag-passthrough',
        text: lines[startLine].trim(),
        texts: lines
          .slice(startLine, endLine + 1)
          .map((l) => l.trim())
          .filter(Boolean),
        detail,
      });
    }
  }
  return violations;
}

// ── diff scoping ──────────────────────────────────────────────────────────────

// The shared seam-guard-lib walk, bound to THIS gate's scope predicates (hook sources, not the
// posix gate's test files — which is why the primitive takes them as parameters).
export function collectAddedByFile(diffText) {
  return collectAddedByFileShared(diffText, { inScope, isExempt });
}

// Keep only the violations the range INTRODUCED — matching on line TEXT (not number), same
// rationale as assert-posix-path-assertions.mjs's violationsIntroduced: a rename/remap can move a
// line's number without changing its text, and the residual (a re-added identical violating line
// elsewhere) is a safe-direction false positive.
//
// A PASSTHROUGH violation gets a second way in (plan 3974 review finding 12eeb0): matching only on
// the SPAWN's own lines misses a diff that adds a brand-new CALLER to an existing, unchanged
// dynamic wrapper (`gitOut(['status', …])` added to a file whose flagless `gitOut` wrapper was
// never touched) — the wrapper's spawn line is real source but not part of THIS diff, so the
// spawn-line match alone would let it through even though the diff is exactly what turned a latent
// wrapper into a live lock-taker. Any added line carrying status/diff argument-position evidence
// (the same rule `hasStatusOrDiffEvidence` uses) also counts as introducing every passthrough
// violation in the file — including a line that only satisfies EVIDENCE_LINE_START_RX (a
// multi-line array literal whose opening `[`/`,` sits on a different, unadded line; see that
// regex's own comment).
export function violationsIntroduced(fileText, addedTexts) {
  const addedCarriesEvidence = [...addedTexts].some(
    (t) => EVIDENCE_ARG_RX.test(t) || EVIDENCE_LINE_START_RX.test(t),
  );
  return findViolations(fileText).filter(
    (v) =>
      v.texts.some((t) => addedTexts.has(t)) ||
      (v.kind === 'missing-flag-passthrough' && addedCarriesEvidence),
  );
}

// ── reporting ─────────────────────────────────────────────────────────────────

const FIX_ADVICE = [
  '',
  'A read-only poller/hook taking a git lock can collide with a concurrent land rebase in the same',
  'worktree (plan 3974: the index.lock contention that made a rescheduled rebase pick report',
  'LAND_BLOCKED). Fix by prepending `--no-optional-locks` (a GLOBAL git option — it must come',
  'BEFORE the subcommand) to the spawn argv:',
  '',
  "  execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], …)   // direct call",
  "  execFileSync('git', ['--no-optional-locks', ...args], …)                   // passthrough wrapper",
  '',
  'Genuinely-deliberate case (a write path that legitimately needs the lock): waive it in place',
  'with `// lock-free-poll-ok: <reason>` on the line or the line above.',
  '',
  "Rule + the helper-indirection design: see this file's own header. Plan 3974.",
  '',
];

function report(byFile) {
  console.error(
    '\nassert-lock-free-git-polls: BLOCKED — new lock-taking git status/diff spawn(s):\n',
  );
  for (const [file, vs] of byFile) {
    console.error(`  ✗ ${file}`);
    for (const v of vs) {
      console.error(`      line ${v.line} [${v.kind}] ${v.detail}`);
      console.error(`        ${v.text}`);
    }
  }
  console.error(FIX_ADVICE.join('\n'));
}

// ── --all corpus sweep ────────────────────────────────────────────────────────

const CORPUS_SKIP_DIRS = new Set(['node_modules', '__pycache__']);

function walkFilesUnder(rel) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (CORPUS_SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkFilesUnder(`${rel}/${entry.name}`));
      continue;
    }
    const child = `${rel}/${entry.name}`;
    if (inScope(child) && !isExempt(child)) out.push(child);
  }
  return out;
}

// Non-recursive: the in-scope redgreen*.mjs siblings sitting directly inside `rel` (never nested
// further — inScope's own regex is `[^/]*`, one path segment).
function redgreenSiblingsIn(rel) {
  return readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${rel}/${e.name}`)
    .filter((f) => inScope(f) && !isExempt(f));
}

// Every in-scope file: scripts/hooks/** recursively, plus the top-level scripts/redgreen*.mjs AND
// scripts/coord/redgreen*.mjs siblings (readdirSync on each dir, non-recursive — redgreen.mjs sits
// directly in scripts/, redgreen-lib.mjs directly in scripts/coord/ since plan 3962 moved it there,
// neither ever nested deeper). `inScope()` already accepts both locations (finding: the walker used
// to only ever read `scripts/` itself, so the plan-3962 move left `inScope()` and the corpus this
// sweep actually reads disagreeing about scripts/coord/redgreen-lib.mjs — in scope by the
// predicate, invisible to `--all`) — this must keep matching whatever `inScope()` accepts, never
// drift from it again. Exported so a test can pin that invariant directly against the real tree
// (see this module's own test file) rather than only through the CLI's stdout.
export function listCorpusFiles() {
  const hooks = walkFilesUnder('scripts/hooks');
  const redgreenSiblings = [
    ...redgreenSiblingsIn('scripts'),
    ...redgreenSiblingsIn('scripts/coord'),
  ];
  return [...new Set([...hooks, ...redgreenSiblings])].sort();
}

function runCorpusSweep() {
  const sorted = listCorpusFiles();
  const byFile = new Map();
  let total = 0;
  for (const file of sorted) {
    const vs = findViolations(readFileSync(join(REPO_ROOT, file), 'utf8'));
    if (vs.length) {
      byFile.set(file, vs);
      total += vs.length;
    }
  }
  if (total === 0) {
    console.log(`assert-lock-free-git-polls: corpus clean (${sorted.length} files scanned).`);
    process.exit(0);
  }
  console.error(`\nassert-lock-free-git-polls: corpus sweep — ${total} instance(s):\n`);
  for (const [file, vs] of byFile) {
    console.error(`  ✗ ${file}`);
    for (const v of vs) console.error(`      line ${v.line} [${v.kind}] ${v.text}`);
  }
  process.exit(1);
}

// ── main (skipped when imported as a module for the unit test) ────────────────

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--all') return runCorpusSweep();

  const ranges = resolveGuardRanges(REPO_ROOT, argv);
  const SKIP =
    'assert-lock-free-git-polls: SKIPPED (origin/master unresolvable or a diff/blob read failed — ' +
    'the done-worktree land re-runs this gate, so a skipped worktree push is re-checked).';
  if (ranges === null) {
    console.log(SKIP);
    process.exit(0);
  }

  const byFile = new Map();
  for (const range of ranges) {
    let diffText;
    try {
      diffText = fetchRangeDiff(REPO_ROOT, range, SCOPE_PATHSPECS);
    } catch (e) {
      console.log(`${SKIP} [${errText(e)}]`);
      process.exit(0);
    }
    const tip = rangeTip(range);
    for (const [file, addedTexts] of collectAddedByFile(diffText)) {
      const res = readFileAtTip(REPO_ROOT, tip, file);
      if (!res.ok) {
        if (res.absent) continue; // deleted by this range — no post-image, no violations
        console.log(`${SKIP} [${file}: ${errText(res.error)}]`);
        process.exit(0);
      }
      const existing = byFile.get(file) ?? [];
      const seenKeys = new Set(existing.map((v) => `${v.line}:${v.kind}`));
      const fresh = violationsIntroduced(res.content, addedTexts).filter(
        (v) => !seenKeys.has(`${v.line}:${v.kind}`),
      );
      if (fresh.length) byFile.set(file, [...existing, ...fresh]);
    }
  }

  if (byFile.size === 0) {
    console.log(
      'assert-lock-free-git-polls: clean (no new lock-taking git status/diff spawn in ' +
        'scripts/hooks/**/*.mjs or scripts/redgreen*.mjs).',
    );
    process.exit(0);
  }
  report(byFile);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
