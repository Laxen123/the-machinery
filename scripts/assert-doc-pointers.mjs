#!/usr/bin/env node
// scripts/assert-doc-pointers.mjs — DEAD-POINTER lint over the LIVE docs corpus (plan 3204).
//
// The 2026-08-15 docs-staleness audit (`output/reports/2026-08-15-docs-staleness-gap-audit.md`)
// read 192 live doc files with 174 agents and found 156 stale claims. Its single largest
// mechanical class needed none of that machinery: 76 dead path references, found in seconds by
// a regex plus an existence check. That class re-accumulates by itself — a file moves, the
// doc that pointed at it does not — so the durable fix is a write-time warning, not another
// audit (report Part 3, item 6).
//
// WHAT IT CHECKS. Every repo-relative FILE reference in the live docs corpus must exist on
// disk. That is the whole check. It is deliberately the narrowest useful version:
//
//   ANCHOR — the token must start with one of REF_ANCHORS (`docs/`, `wiki/`, `scripts/`,
//     `backend/`, `frontend/`, `shared/`, `coord/`). Unanchored prose shorthand
//     (`clinics/<CC>/clinic-NNN.json`, `parked/`, `ready/`) is invisible to this lint, and
//     so are URLs, package specifiers (`@vetapp/shared`) and `./`-relative link targets.
//   EXTENSION — the token must end in one of REF_EXTENSIONS (`.md .mjs .py .ts .tsx .json
//     .sh`). Directory references are NOT checked: `docs/runbooks/` is a stable concept, a
//     named FILE is the thing that actually moves, and directory tokens are where the prose
//     shorthand lives. This is the second half of the zero-false-positive contract.
//   PLACE — the token must sit inside a backtick span, a markdown link target, or a COMMAND
//     fenced block (```bash and friends, plus the unlabelled fences that are shell in all but
//     the info string; see SCANNED_FENCE_LANGS). Bare prose is never scanned — a path written
//     in running text without backticks is prose about a path, not a pointer — and neither is
//     a data/source fence, where a path is a string value illustrating a format.
//
// The two rules together are why note (b) of the plan ("glob-like examples, template
// placeholders, code blocks demonstrating OLD paths as history") is mostly answered by
// construction: a template placeholder like `<slug>/index.md` is unanchored, `clinics/<CC>/`
// is unanchored and extension-less, and an old path shown AS history is either anchored and
// genuinely dead (a real finding — say so, or waive it in place) or unanchored and ignored.
//
// WHAT IT DOES NOT CHECK, on purpose:
//   • `docs/superpowers/plans/` references — plans MOVE between status folders by design, so
//     a plan path is stale the moment the plan is claimed. That is `lint-plan-index.mjs`'s
//     job, and the landed-plan-claim class is `assert-plan-pointers.mjs`'s.
//   • `./`- and `../`-relative markdown links. They are a real drift class, but resolving
//     them needs per-document base-path logic and would pull in anchors, query strings and
//     bare `#section` links — a different token contract with a different false-positive
//     profile. Anchored-only is what plan 3204 specced and what the audit measured.
//   • `[[wikilinks]]` — the wiki's own link graph, not a repo path.
//   • symbols after `::` (`shared/src/schemas.ts::CountrySchema` checks the FILE only).
//
// WARN-ONLY (plan 3204 execution note (a)). It prints and exits 0. Promotion to a blocking
// gate is a separate, later decision once the false-positive rate is known in practice;
// `--check` exits 1 and is the mode that promotion would turn on, available today for a
// deliberate "prove the corpus is clean" run.
//
// ── Waiving a reference in place ─────────────────────────────────────────────────
//   `docs/countries/gb.md` does not exist yet <!-- doc-pointer-ok: documenting a real gap -->
// exempts every reference on the lines the comment spans. For a whole historical passage:
//   <!-- doc-pointer-ok-section: the 2026-05 layout, kept as the record of what moved -->
// exempts everything from that comment down to the next markdown heading. The section form
// IS this lint's reading of the audit's "a reference inside a passage marked historical"
// convention: a prose sniffer for the word "historical" would both miss real historical
// passages and swallow live drift, so the marker is explicit and the exemption is bounded by
// the heading rather than guessed. Both markers are HTML comments, invisible when rendered,
// and they travel with the text they exempt — no sidecar list to drift out of sync.
//
// ── The grandfather file ─────────────────────────────────────────────────────────
// `scripts/doc-pointer-grandfather.txt` is a frozen snapshot of the dead references that
// already existed when this lint landed (same shape as `scripts/seed-io-seam-allowlist.txt`).
// Sibling plans own those cleanups; without the snapshot every one of them would WARN on
// every push that touched its file, which is exactly the bystander noise that gets a lint
// ignored. The list only SHRINKS: delete a row when the pointer is fixed. `--no-grandfather`
// shows the full picture (what the weekly full-corpus run wants).
//
// ── Modes ────────────────────────────────────────────────────────────────────────
//   node scripts/assert-doc-pointers.mjs                 # full corpus (the weekly run)
//   node scripts/assert-doc-pointers.mjs docs/a.md …     # just these files
//   … | node scripts/assert-doc-pointers.mjs --stdin     # newline-separated paths on stdin
//                                                        # (how pre-push scopes to the diff)
//   --check            exit 1 when there are findings
//   --no-grandfather   report grandfathered pointers too
//   --json             machine-readable findings on stdout
//
// Exit codes: 0 clean, or findings printed in the default WARN-only mode · 1 findings + --check
// · 2 a usage error (an unknown flag), which is a bug in the caller, not a doc finding.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The path-token machinery plan 2631 originally built and tested for PIPELINE.md's check (A),
// extracted into a coord-owned module by plan 3958 (S2 follow-up) so this lint's own closure
// does not pull in `./pipeline-doc.mjs` (vetapp-only) via `./lint-pipeline-doc.mjs`. Importing
// it rather than re-deriving it keeps ONE brace-expander, ONE glob matcher and ONE gitignore
// batcher in the tree — the `{a,b}` / `<PLACEHOLDER>` / trailing-`/` edge cases in there cost
// two review rounds to get right, and a second copy would drift from the first.
import {
  expandBraces,
  gitIgnoredSet,
  globMatches,
  splitSpanWords,
  trimToken,
} from './coord/doc-token-lib.mjs';
// Flags, scoping, grandfather reading, reporting, exit codes — everything both doc-freshness
// lints do identically, so neither can grow a flag the other lacks.
import { readGrandfatherFile, runLint } from './doc-lint-cli.mjs';

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * The LIVE docs corpus — plan 3204 § Scope 1. "Live" means a reader is expected to act on it
 * today: the archives, the per-session handoffs and the generated surfaces are excluded
 * because a dead pointer in them is a faithful record, not rot.
 *
 * Data, not code: extending coverage (a new top-level doc, a newly-archived tree) is one row.
 */
export const CORPUS = {
  /** A file is in scope if it lives under one of these… */
  includePrefixes: ['docs/', 'wiki/'],
  /** …or IS one of these. */
  includeExact: ['WIKI.md', 'CLAUDE.md'],
  /** …unless it lives under one of these. */
  excludePrefixes: [
    // Point-in-time records of a decision, a review or a batch — never a live instruction.
    'docs/superpowers/specs/',
    'docs/superpowers/audits/',
    'docs/superpowers/batches/',
    // Plans are a separate surface with their own lints, and their paths move by design.
    'docs/superpowers/plans/',
    'docs/handoff/archive/',
    'docs/handoff/sessions/',
    'docs/archive/',
    // Prompt bodies the audit harness interpolates, not documents a reader acts on. Their path
    // references are illustrative by construction ("if the reviewer cited
    // `frontend/src/components/Foo.tsx` but the file is at …"), so every one is a placeholder.
    'docs/superpowers/audit-harness/templates/',
  ],
  /** …or IS one of these. */
  excludeExact: [
    // Generated from git ls-files by scripts/build-index.mjs; its pointers are as fresh as
    // the last regeneration, and lint-plan-index.mjs already regenerate-and-diffs it.
    'docs/INDEX.md',
    // Explicitly a historical record, and excluded from the 2026-08-15 audit on operator
    // instruction for that reason.
    'docs/PRE-SEED-HISTORY.md',
    // Append-only ledgers of what happened, not instructions.
    'wiki/log.md',
    'wiki/plans-archive.md',
  ],
  /** Only markdown carries doc pointers. */
  suffix: '.md',
};

/** A reference must start with one of these to be checked at all. */
export const REF_ANCHORS = ['docs', 'wiki', 'scripts', 'backend', 'frontend', 'shared', 'coord'];

/** …and end in one of these. Directory references are deliberately not checked. */
export const REF_EXTENSIONS = ['md', 'mjs', 'py', 'ts', 'tsx', 'json', 'sh'];

/**
 * References under these prefixes are skipped even when they are anchored + extensioned.
 *   • Plans move between status folders as a matter of routine, so their paths are expected to
 *     go stale and a lint firing on them would be pure noise.
 *   • `backend/data/` is the per-run pipeline ARTIFACT store (67k tracked files of per-plan
 *     cohort dumps, plus directories that only exist in a checkout where that pass has run).
 *     Docs cite paths there to describe an output SHAPE, so "does it exist right now" is the
 *     wrong question — the same reasoning that makes the gitignore skip correct.
 */
export const SKIP_REF_PREFIXES = ['docs/superpowers/plans/', 'backend/data/'];

/**
 * Template placeholders, replaced by `*` before the existence check. `<CC>` is the explicit
 * form; `clinic-NNN.json` and `lint-report-YYYY-MM-DD.md` are the two bare forms this repo's
 * docs use as a matter of house style (`CLAUDE.md` names the sharded seed exactly that way),
 * and without them 18 of the first full-corpus run's 77 hits were the SAME false positive.
 */
const PLACEHOLDER_RES = [
  /<[^<>/]*>/g, // <CC>, <slug>, <clinic_id>
  /\bYYYY-MM-DD\b/g, // dated artifact names
  /\bN{3,}\b/g, // clinic-NNN.json
];

export const GRANDFATHER_FILE = 'scripts/doc-pointer-grandfather.txt';

// Scanned over the WHOLE document, not per line: a marker carrying a long reason gets wrapped
// by an editor, and a per-line regex silently fails to exempt such a marker's reference —
// turning a correctly-documented gap into a permanent WARN (the same bug plan 2631's review
// found in lint-pipeline-doc). `[\s\S]` so the body may span newlines.
const LINE_WAIVER_RE = /<!--\s*doc-pointer-ok:([\s\S]*?)-->/g;
const SECTION_WAIVER_RE = /<!--\s*doc-pointer-ok-section:([\s\S]*?)-->/g;
const HEADING_RE = /^#{1,6}\s/;
// The underline half of a setext heading (`Today` on one line, `=====` on the next). A section
// waiver must end there too — otherwise a document that heads its sections this way keeps the
// waiver running past the passage it was written for, hiding live findings. `-` requires a
// non-blank line above, which is what separates a setext heading from a thematic break.
const SETEXT_UNDERLINE_RE = /^\s*(?:=+|-+)\s*$/;
// A fenced code block's delimiter, either style, with its fence run and the REST of the line.
// The RUN is captured, not just matched: a ``` line inside a ~~~ block is content, not a close,
// and treating it as one ends the block early and skips every reference below it. The rest of
// the line is captured WHOLE (`.*`, not an info-string character class) because a close must
// carry nothing after it at all — an anchored prefix match would read `~~~ some prose` as a
// bare close and end the block on a line that is really content.
const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;

/**
 * The fenced blocks whose bare words are scanned as path references: COMMAND blocks, plus the
 * unlabelled ones (86 of the corpus's fences carry no info string and are overwhelmingly
 * shell). A command that no longer runs is the most expensive kind of stale doc, and it is
 * written without backticks, so the backtick rule alone cannot see it.
 *
 * DATA and SOURCE blocks (`json`, `yaml`, `js`, `ts`, `jsonc`, `markdown`, …) are deliberately
 * not scanned: a path there is a string VALUE illustrating a format, not a pointer the reader
 * follows. WIKI.md § 14's Obsidian-canvas sample is the measured case — `wiki/domains/APIs.md`
 * inside a `json` block is a made-up example, and scanning it produced this lint's only two
 * false positives on the whole corpus.
 */
export const SCANNED_FENCE_LANGS = new Set([
  '',
  'bash',
  'sh',
  'shell',
  'console',
  'zsh',
  'powershell',
  'ps1',
  'python',
  'py',
  'text',
]);
const BACKTICK_RE = /`([^`\n]+)`/g;
// A markdown inline link target: `](target)` or `](target "title")`. Reference-style
// definitions (`[id]: target`) are the same token in a different wrapper and are matched too.
const LINK_TARGET_RE = /\]\(\s*([^)\s]+)(?:\s+["'][^)]*)?\)|^\s*\[[^\]]+\]:\s*(\S+)/gm;

/** Is this repo-relative path one of the documents this lint reads? */
export function isCorpusFile(path, corpus = CORPUS) {
  if (!path.endsWith(corpus.suffix)) return false;
  if (corpus.excludeExact.includes(path)) return false;
  if (corpus.excludePrefixes.some((p) => path.startsWith(p))) return false;
  if (corpus.includeExact.includes(path)) return true;
  return corpus.includePrefixes.some((p) => path.startsWith(p));
}

/**
 * The corpus, from the git index. Tracked files only — an untracked scratch `.md` under
 * `docs/` is somebody's work in progress, not a doc anybody reads. `lsFiles` is injected so
 * the test battery can pin the selection logic without a git tree.
 */
export function listCorpus(root = REPO_ROOT, lsFiles = defaultLsFiles) {
  return lsFiles(root).filter((p) => isCorpusFile(p));
}

function defaultLsFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Is `token` a reference this lint checks? Anchored on a real top-level doc-bearing directory
 * AND naming a file by extension. Both halves are load-bearing: the anchor rejects URLs,
 * package specifiers and prose shorthand, the extension rejects directory tokens.
 */
export function isCheckableRef(token, { anchors = REF_ANCHORS, extensions = REF_EXTENSIONS } = {}) {
  if (!token.includes('/')) return false;
  if (token.includes('://') || token.startsWith('/') || token.startsWith('@')) return false;
  if (token.startsWith('.')) return false; // ./ and ../ relative forms — out of contract
  if (isNotAPath(token)) return false;
  const head = token.slice(0, token.indexOf('/'));
  if (!anchors.includes(head)) return false;
  const ext = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
  return token.includes('.') && extensions.includes(ext);
}

/**
 * Path-SHAPED text that is not a path reference at all — the four forms the full-corpus runs
 * turned up, each of which would otherwise be a permanent false positive:
 *   • interpolation — `docs/runbooks/cloud-routines/${f}.md` inside a JS snippet,
 *     `docs/sweep-$SCOPE-$DATE/…` inside a shell one-liner. The text on the page is not the
 *     path any reader will ever open.
 *   • elision — `backend/scripts/price-pipeline/...url_discovery.py`, prose shorthand for
 *     "somewhere under here".
 *   • a torn brace group — a `{a.ts, b.ts}` alternation written with a space after the comma
 *     tokenises into `{a.ts` and `b.ts}`, neither of which is a path. Balance is the test, so a
 *     well-formed `{a,b}` (which expandBraces handles) still checks normally.
 */
export function isNotAPath(token) {
  if (token.includes('$')) return true;
  if (token.includes('...') || token.includes('…')) return true;
  // A backslash is markdown escaping (`wiki/<domain>/\_index.md`) or a Windows path fragment;
  // neither is the POSIX repo-relative form every reference in this corpus is written in.
  if (token.includes('\\')) return true;
  const open = (token.match(/\{/g) ?? []).length;
  const close = (token.match(/\}/g) ?? []).length;
  return open !== close;
}

/**
 * Line numbers exempted by a waiver marker.
 *
 * A `doc-pointer-ok` marker exempts every line it spans (for the normal trailing-comment form,
 * exactly the line carrying the reference). A `doc-pointer-ok-section` marker exempts from its
 * own first line down to the line before the next markdown heading — the bounded, explicit
 * stand-in for "this passage is historical".
 */
export function waivedLines(text) {
  const lines = text.split('\n');
  const waived = new Set();
  // Markers are matched against a MASKED copy — code spans and fenced blocks blanked out,
  // offsets preserved — so a document that TEACHES the waiver syntax does not silently apply
  // it. `docs/runbooks/standing-operations.md` does exactly that, and before the mask its
  // example marker waived a real line of the runbook.
  const scan = maskCodeRegions(text);

  // ONE index builder per pass. The builder is stateful and monotonic (see below), and the two
  // passes each restart at the top of the document — sharing one would silently mis-number
  // every section marker that sits before the last inline marker.
  const inlineLineOf = buildLineIndex(scan);
  for (const m of scan.matchAll(LINE_WAIVER_RE)) {
    const start = inlineLineOf(m.index);
    const end = start + m[0].split('\n').length - 1;
    for (let ln = start; ln <= end; ln++) waived.add(ln);
  }

  const sectionLineOf = buildLineIndex(scan);
  for (const m of scan.matchAll(SECTION_WAIVER_RE)) {
    const start = sectionLineOf(m.index);
    for (let ln = start; ln <= lines.length; ln++) {
      // The heading that ends the passage is itself outside it — ATX (`## Today`) or setext
      // (`Today` over `=====`), where the heading starts on the line ABOVE the underline.
      if (ln > start && HEADING_RE.test(lines[ln - 1])) break;
      if (ln > start && lines[ln - 1].trim() && SETEXT_UNDERLINE_RE.test(lines[ln] ?? '')) break;
      waived.add(ln);
    }
  }

  return waived;
}

/**
 * The ONE fenced-block scanner. Returns, per line, `{ fence, inFence, lang }` — whether the
 * line IS a delimiter, whether it sits inside a block, and the open block's info string.
 *
 * Both callers (the waiver mask and the reference extractor) read it, so they can never
 * disagree about where a block starts and ends — a split that had them tracking fence state
 * separately would eventually let a waiver mask and a scan window drift apart on the same
 * document.
 *
 * Two CommonMark rules that a boolean toggle gets wrong, both measured as review findings:
 *   • the delimiter RUN matters — a ``` line inside a ~~~ block is content, and closing on it
 *     ends the block early and skips every reference below it;
 *   • a CLOSING delimiter carries NO info string — `~~~python` inside a `~~~bash` block opens
 *     nothing and closes nothing, it is just text.
 */
export function scanFences(lines) {
  let openRun = null;
  return lines.map((line) => {
    const m = line.match(FENCE_RE);
    if (!m) return { fence: false, inFence: openRun !== null, lang: null };
    const [, run, rest] = m;
    const info = rest.trim().toLowerCase();
    if (openRun === null) {
      openRun = run;
      // Only the FIRST word of the info string names the language (```bash --no-run).
      return { fence: true, inFence: false, lang: info.split(/\s+/)[0], opening: true };
    }
    // A close matches the opener's character, is at least as long, and carries nothing after it.
    if (run[0] === openRun[0] && run.length >= openRun.length && !info) {
      openRun = null;
      return { fence: true, inFence: false, lang: null, opening: false };
    }
    return { fence: false, inFence: true, lang: null }; // a delimiter-shaped CONTENT line
  });
}

/**
 * A copy of `text` with every fenced block (delimiters included) and every inline code span
 * replaced by spaces — same length, same newlines, so every offset still names the same line.
 * Used only to find waiver markers: a marker shown as an example must not act as one, and that
 * includes one written on the fence line itself.
 */
export function maskCodeRegions(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const lines = text.split('\n');
  const states = scanFences(lines);
  return lines
    .map((line, i) =>
      states[i].fence || states[i].inFence ? blank(line) : line.replace(BACKTICK_RE, blank),
    )
    .join('\n');
}

/**
 * `offset -> 1-based line`, in ONE pass over the text no matter how many markers there are.
 * (Slicing the prefix per match would scale with document length x marker count on a path
 * that runs on every push.) Callers must query offsets in ascending order, which `matchAll`
 * guarantees.
 */
function buildLineIndex(text) {
  let scanned = 0;
  let line = 1;
  return (offset) => {
    for (let i = scanned; i < offset; i++) if (text[i] === '\n') line++;
    scanned = offset;
    return line;
  };
}

/**
 * Every checkable reference in `text`, with its line number. Waived lines are dropped here
 * rather than at reporting time so a waiver costs nothing downstream (no existence check, no
 * grandfather lookup).
 */
export function extractRefs(text, opts = {}) {
  const waived = waivedLines(text);
  const refs = [];
  const seen = new Set(); // one finding per (line, path), not per repetition on that line
  const lines = text.split('\n');
  const states = scanFences(lines);
  // Whether the block we are inside is a COMMAND block worth reading bare words from. Set by
  // the opening delimiter, which is the only line carrying the info string.
  let scanFence = false;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const state = states[idx];
    if (state.fence) {
      scanFence = state.opening ? SCANNED_FENCE_LANGS.has(state.lang) : false;
      return;
    }
    if (waived.has(lineNo)) return;

    const tokens = [];
    if (scanFence && state.inFence) {
      // Inside a fenced block the whole line IS code, so every whitespace-separated word is a
      // candidate — a runbook command writes its paths bare, with no backticks to key on, and
      // a command that no longer runs is the single most expensive kind of stale doc. Measured
      // over the corpus: 184 candidates, 178 of them live, which is the precision the anchor +
      // extension contract buys. Backticks are stripped rather than used as a delimiter,
      // because a fenced line may carry them incidentally.
      for (const word of splitSpanWords(line.replace(/`/g, ''))) tokens.push(word);
    } else {
      for (const span of line.matchAll(BACKTICK_RE)) {
        for (const word of splitSpanWords(span[1])) tokens.push(word);
      }
      for (const link of line.matchAll(LINK_TARGET_RE)) {
        // The link target may itself be backticked (`[`docs/x.md`](docs/x.md)`) — harmless,
        // the (line, path) dedupe below collapses it.
        tokens.push((link[1] ?? link[2] ?? '').replace(/^`|`$/g, ''));
      }
    }

    for (const raw of tokens) {
      const token = normalizeToken(raw);
      const path = token.split('::')[0];
      if (!isCheckableRef(path, opts)) continue;
      if (SKIP_REF_PREFIXES.some((p) => path.startsWith(p))) continue;
      const key = `${lineNo}\u0000${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ line: lineNo, token, path });
    }
  });

  return refs;
}

/**
 * Strip everything that decorates a path but is not part of it, BEFORE the checkability test —
 * each of these would otherwise sit exactly where the extension has to be read from, so a
 * decorated reference reads as "not a file" and is silently skipped rather than checked:
 *   `<docs/a.md>`   markdown's angle-bracket link destination
 *   `#anchor`       a link into a section, `?query` a link parameter
 *   `:42` / `:42:7` this repo's `file_path:line_number` citation convention
 * `::symbol` is NOT stripped here — the caller keeps the full token for its finding text and
 * splits the path off separately.
 */
export function normalizeToken(raw) {
  const bare = trimToken(raw).replace(/^<+/, '').replace(/>+$/, '');
  return bare
    .split('#')[0]
    .split('?')[0]
    .replace(/:\d+(?::\d+)?$/, '');
}

/** Placeholder segments are wildcards, not literal text. */
export function placeholdersToGlobs(token) {
  return PLACEHOLDER_RES.reduce((t, re) => t.replace(re, '*'), token);
}

/** Read the frozen snapshot of already-dead pointers: one `<doc> <ref>` pair per line. */
export function readGrandfather(root = REPO_ROOT, file = GRANDFATHER_FILE) {
  return readGrandfatherFile(root, file);
}

/**
 * Lint one document. Pure — `resolvePath` decides existence, so the battery drives the whole
 * contract without a repo on disk.
 */
export function lintDocument(doc, { resolvePath, grandfather = new Set(), refs, text }) {
  const findings = [];
  let grandfathered = 0;
  for (const ref of refs ?? extractRefs(text)) {
    if (resolvePath(ref.path) !== 'missing') continue;
    if (grandfather.has(`${doc} ${ref.path}`)) {
      grandfathered += 1;
      continue;
    }
    findings.push({
      doc,
      line: ref.line,
      kind: 'dead-pointer',
      path: ref.path,
      message: `referenced path does not exist: ${ref.path}`,
    });
  }
  return { findings, grandfathered };
}

/**
 * Resolve references against the real tree. Built once per RUN over the whole reference set so
 * `git check-ignore` is one subprocess, not one per document, and each distinct path is
 * stat-ed once no matter how many docs cite it (`docs/PIPELINE.md` is cited ~200 times).
 */
export function makeResolver(paths, root = REPO_ROOT) {
  const { ignored, gitAvailable } = gitIgnoredSet([...new Set(paths)], root);
  const memo = new Map();
  const resolvePath = (p) => {
    let verdict = memo.get(p);
    if (verdict !== undefined) return verdict;
    if (ignored.has(p) || ignored.has(p.replace(/\/$/, ''))) verdict = 'ignored';
    else {
      const candidates = expandBraces(p).map(placeholdersToGlobs);
      verdict = candidates.some((c) => globMatches(c, root)) ? 'ok' : 'missing';
    }
    memo.set(p, verdict);
    return verdict;
  };
  return { resolvePath, gitAvailable };
}

/**
 * CLI entry. `opts.root` / `opts.files` / `opts.readDoc` / `opts.makeResolver` are the battery
 * seams, so the exit-code contract is pinned by a test rather than only by a human running the
 * command — the same silent-drift class this script exists to catch. Everything about the
 * command SHAPE (flags, scoping, grandfather reading, reporting) lives in doc-lint-cli.mjs,
 * shared byte-for-byte with the plan-pointer lint so the two can never drift apart.
 */
export function main(argv = process.argv.slice(2), opts = {}) {
  return runLint(
    {
      name: 'assert-doc-pointers',
      repoRoot: REPO_ROOT,
      grandfatherFile: GRANDFATHER_FILE,
      isCorpusFile,
      listCorpus,
      noun: { many: 'dead pointer(s)' },
      // Pass 1 parses every document; pass 2 resolves the whole reference set at once, so
      // `git check-ignore` is ONE subprocess and each distinct path is stat-ed once however
      // many documents cite it (`docs/PIPELINE.md` is cited ~200 times).
      parse: (doc, text) => ({ doc, refs: extractRefs(text) }),
      prepare: (items, root, o) => {
        const build = o.makeResolver ?? makeResolver;
        const { resolvePath, gitAvailable } = build(
          items.flatMap((i) => i.refs.map((r) => r.path)),
          root,
        );
        return {
          resolvePath,
          notes: gitAvailable
            ? []
            : [
                '`git check-ignore` unavailable, so gitignored paths were NOT skipped; ' +
                  'findings under deliberately-untracked trees may be spurious.',
              ],
        };
      },
      lintItem: ({ doc, refs }, { grandfather, ctx }) =>
        lintDocument(doc, { resolvePath: ctx.resolvePath, grandfather, refs }),
      advice:
        'Fix the pointer, or — if the doc is RIGHT that the path is absent (a documented gap, ' +
        'a historical passage) — mark it in place with `<!-- doc-pointer-ok: <reason> -->` on ' +
        'the line, or `<!-- doc-pointer-ok-section: <reason> -->` for the whole passage down ' +
        'to the next heading. See the header of scripts/assert-doc-pointers.mjs.',
    },
    argv,
    opts,
  );
}

// CLI entry. `pathToFileURL(process.argv[1]).href`, never a hand-built `file://${argv[1]}` —
// on Windows argv[1] is a backslash path with a drive letter while import.meta.url is
// `file:///C:/…`, so the hand-built form never matches, main() is never called, and the script
// prints nothing and exits 0, which reads exactly like a clean pass (plan 1555).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
