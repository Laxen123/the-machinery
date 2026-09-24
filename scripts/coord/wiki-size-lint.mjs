#!/usr/bin/env node
// scripts/coord/wiki-size-lint.mjs — wiki page-size budget lint (plan 1255).
//
// Injected wiki page heads are auto-pushed into context by the
// scripts/hooks/*-loader.mjs family. A folded tail stays pull-on-demand behind one
// pointer line. Past a few thousand pushed tokens, added text REDUCES recall of what
// stays (attention dilution), so each region is budgeted deterministically:
//
//   injected head — a wiki/entities/** page wired to a loader: warn >8 KB, NEAR-CAP
//                                                              warn ≥90% of 32 KB, FAIL >32 KB
//   folded tail  — warn >24 KB, no fail
//   total file   — warn >64 KB (the one-Read ceiling), no fail
//   pull page    — everything else (concepts, services, meta): warn >24 KB, no fail
//   exempt       — wiki/log.md (journal), wiki/hot.md (own ≤500-word rule), wiki/index.md
//
// The NEAR-CAP band (plan 2487) is a SEVERITY split inside the injected warn, not a new
// bucket: a page at 8.1 KB and one at 16.3 KB used to emit the same-shaped WARN line, so
// the approach to the hard cap was invisible until it BLOCKED. `price-inspector.md` sat at
// 16360/16384 bytes — 24 bytes of headroom — and refused every new burn-list entry mid-land
// (plan 2407), with no warning that had ever said anything different from the one it had
// been printing since it crossed 8 KB. A near-cap page still only warns (never blocks), but
// it says so in its own words, with the remaining headroom in bytes.
//
// Plan 2618 (operator-directed 2026-07-29) raised the injected cap 16 → 24 KB and gave the
// two structure rules that keep pages lean mechanical teeth, because the cap alone had
// turned into pure trim-friction (price-inspector.md: 273 commits/30d, ~111 of them
// trim-shuffle, while the rules it depends on decayed unenforced):
//
//   updated:-length FAIL — any non-exempt page whose frontmatter `updated:` VALUE exceeds
//     400 bytes (WIKI.md § Page budgets rule 3: date + last plan or two, never an accretion
//     chain; the trim is always lossless — history lives in wiki/log.md). Applies to BOTH
//     classes: pull-page updated: chains had reached 8.3 KB. Measured on the value's first
//     physical line (a YAML block-scalar continuation would evade this; no page uses one).
//   long-line WARN — an injected page body line over 700 bytes (rule: a burn-list entry is
//     ONE line + a pointer; a paragraph-sized entry is the growth mechanism that ate the old
//     cap). Warn-only: ~13 existing injected pages carry legit 700–1700 B lines, and the
//     value is the write-time surfacing in wiki-commit.mjs at the moment of authorship.
//
// The injected set is DERIVED, never a hand list (so it cannot drift as loaders are
// added — e.g. the plan-1254 generic subject/path loaders):
//   (a) every wiki/entities/clinics/*.md            (clinic-wiki-loader is file-derived)
//   (b) any wiki/entities/** page whose BASENAME appears in a scripts/hooks/**/*.mjs
//       source                                       (the CHAINS registry `file:` entries,
//                                                     price-pipeline-loader's fixed PAGE)
//   (c) any wiki/entities/** page whose frontmatter carries a non-empty `aliases:` or
//       `triggerPaths:` list                          (the plan-1254 loaders match on these;
//                                                     `aliases: []` is an explicit waiver)
//
// Exit non-zero on any FAIL; warns print but never block. Rules doc: WIKI.md
// § "vetapp instance" → "Page budgets + structure rules". Wired as a diff-scoped
// .husky/pre-push tier (fires only when the push touches wiki/**).
//
// ── The fold-structure rule (plan 4027) ──────────────────────────────────────
//
// The three budgets above bound how BIG a page is. This one bounds how much of it is
// CURRENT: a loader injects everything above `<!-- fold -->`, so whatever sits there is
// what a session is told is true today. The motivating observation (operator, 2026-09-14):
// the loaders injected six entity pages IN FULL and their dated history — an old captcha
// claim, a mid-migration empty-cell state, old stall reports — reached the conversation as
// if current.
//
//   above-fold body WARN — a wiki/entities/** page whose above-fold body exceeds
//     FOLD_ABOVE_MAX_LINES non-blank lines. Warn-only, never a fail bucket.
//
// Four decisions, each load-bearing:
//
// 1. SCOPED BY PATH (`wiki/entities/**` minus the `-appendix.md` family), not by
//    `cls === 'injected'`. Every loader's page
//    root is under entities/ (loader-common scans platforms/inspectors/services;
//    chain-wiki-loader chains; clinic-wiki-loader clinics; price-pipeline-loader pins
//    price-inspector.md) — nothing under wiki/concepts/** is injectable today. Scoping by
//    PATH rather than by the derived injected set is deliberate, and it still is even now
//    that the two agree on chains: a path rule cannot be broken by a registry move. The gap
//    it was working around is CLOSED (plan 4035) — `collectHookReferencedBasenames` now also
//    reads `scripts/wiki-chain-registry.mjs`, so the 24 registry-driven chain pages classify
//    `injected` and draw the 8 KB warn / 32 KB FAIL their heads are really injected under.
//    That widening was sequenced AFTER plan 4035's fold sweep on purpose: it applies the
//    FAIL cap, and five chain pages exceeded it beforehand (vetathome 70.0K, evidensia 51.0K,
//    anicura 49.3K, plutovets 44.0K, distriktsveterinarerna 35.1K), so closing it earlier
//    would have BLOCKED every wiki write. All 25 are under the cap as of that sweep.
//    The `-appendix.md` exclusion is the other half of the same scoping judgment — see
//    `isFoldable` for why a fold's destination must not be asked to fold itself.
//
// 2. ONE rule, not a separate "page has no marker" rule. A page with no marker has its
//    WHOLE body above the fold, so a long unfolded page trips this same bound and a short one
//    is already compliant. Measured on origin/master 178f2d8ae: 18 of the 55 in-scope entity
//    pages warn (68 under entities/, less the 13 appendices), and the unfolded ones under the
//    bound stay silent — warning those too would be noise on more than half the tree, and a
//    lint that cries wolf stops being read.
//
// 3. LINES, not bytes. Bytes already have three owners here (injected head cap, tail warn,
//    one-Read ceiling) and this rule is not a fourth: it is structural — "the current-state
//    section is short" — and a line count is what an author edits against. The two genuinely
//    diverge (awake.md: 22 non-blank lines, 15.9 KB), which is the long-line advisory's job,
//    not this one's.
//
// 4. N = 75, the MEDIAN above-fold non-blank body-line count of the seven entity pages that
//    already carry a marker (20, 29, 41, **75**, 142, 343, 348), measured on origin/master
//    178f2d8ae 2026-09-14. Derived from the pages that already do this rather than picked, so
//    the bound is what the vault's own folded pages already demonstrate is workable.
//
// Pure functions are exported for scripts/coord/wiki-size-lint.test.mjs; main() runs only
// when invoked directly.

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  parseFrontmatterKeys,
  listWikiMarkdownFiles,
} from './wiki-coverage-sweep.mjs';
import { splitFrontmatter, splitFold } from './wiki-fold.mjs';

export const KB = 1024;
export const INJECTED_WARN = 8 * KB;
export const INJECTED_FAIL = 32 * KB; // operator 2026-08-03: raised from 24 KB (plan 2618: 16 → 24)
export const PULL_WARN = 24 * KB;
export const ONE_READ_CEILING = 64 * KB;
// plan 2618: hard cap on the `updated:` frontmatter VALUE (bytes), all non-exempt classes.
export const UPDATED_MAX = 400;
// plan 2618: advisory threshold for a single body line on an INJECTED page (bytes).
export const LONG_LINE_WARN = 700;
// plan 2487: the escalated warn band — an injected page at or above 90% of its hard cap.
// Floored to a whole byte so the threshold, the reported limit, and the headroom arithmetic
// are all integers (0.9 × 16384 = 14745.6).
export const INJECTED_NEAR_CAP = Math.floor(INJECTED_FAIL * 0.9);
// plan 4027: advisory bound on a wiki/entities/** page's ABOVE-FOLD body, in non-blank
// lines. See the fold-structure rule in the header for the derivation (median of the seven
// already-folded entity pages) and for why this is scoped by path and measured in lines.
export const FOLD_ABOVE_MAX_LINES = 75;
// plan 4027: the path prefix the fold-structure rule applies to — every loader's page root.
export const FOLDABLE_PREFIX = 'wiki/entities/';
// The warn `kind`s that ride BESIDE a size bucket rather than being one. A page can carry both
// (an over-cap head that also has a long line), so any caller that means "the size verdict" must
// filter these out — and filter on THIS set, not a hand-listed copy, so adding an advisory below
// cannot silently leak into a size assertion (gpt-review 47bf11). The size kinds (`tail`,
// `total`, and the bare bucket with no `kind`) are deliberately absent.
export const ADVISORY_KINDS = new Set(['longLine', 'foldHead', 'foldMarkers']);

// plan 4027: the documented pull-on-demand suffix (WIKI.md § "Page budgets" rules 5-6) —
// an appendix is a fold's DESTINATION, so the fold rule must not ask one to fold itself.
export const APPENDIX_SUFFIX = '-appendix.md';

// plan 4027: does the fold-structure rule apply to this page? Every wiki/entities/** page is
// a loader page root, EXCEPT the `<page>-appendix.md` family: WIKI.md rule 6 makes those the
// pull-on-demand depth holders (the fold tail's legacy equivalent) and rule 5 writes detail
// APPENDIX-SIDE from the first write-back, so they are big BY DESIGN and no loader injects
// one — all 14 in the vault classify `pull`, none is named in any scripts/hooks/** source
// (13 sit under entities/ and are in this rule's path scope; qualifier-axes-appendix.md is
// under concepts/ and was never in scope). Asking an appendix to fold would be asking the
// destination to become its own tail; it would also have been 11 of 29 warns, i.e. well over
// a third of this rule's output landing on pages that are doing the right thing.
export function isFoldable(rel) {
  return String(rel).startsWith(FOLDABLE_PREFIX) && !String(rel).endsWith(APPENDIX_SUFFIX);
}

// Repo-relative (forward-slash) paths exempt from any budget.
export const EXEMPT = new Set(['wiki/log.md', 'wiki/hot.md', 'wiki/index.md']);

// ── frontmatter ──────────────────────────────────────────────────────────────

// The raw frontmatter block text, or ''. Thin wrapper over the single-owner parser
// in wiki-coverage-sweep.mjs (its `raw` field) — no second frontmatter regex here.
export function frontmatterOf(text) {
  const fm = parseFrontmatter(String(text));
  return fm.found ? fm.raw : '';
}

// Markdown has no syntactic way to distinguish a leading thematic-break pair around
// `key: value` prose from YAML frontmatter: both are the same bytes. parseFrontmatter is
// still the single parser; this vault-schema check resolves only that unavoidable ambiguity.
// A candidate is frontmatter when the parser found metadata the wiki actually owns. Keep
// this list aligned with WIKI.md's page metadata contract rather than accepting any prose key.
const WIKI_METADATA_KEYS = new Set([
  'name',
  'aliases',
  'triggerPaths',
  'description',
  'type',
  'kind',
  'updated',
  'computed-from',
]);

// ONE regex decides WHERE the frontmatter fence is: splitFrontmatter's, the canonical
// one splitFold also scans from. parseFrontmatterKeys is then handed that span's TEXT, so
// it reads KEYS and never re-judges a fence — the two
// cannot disagree about a closing `---` that carries trailing characters, which is
// exactly how an earlier revision flipped this guard (plan 3531 review round 4).
// What is left here is the POLICY question the shared parser deliberately does not
// answer: a leading thematic-break pair wrapping `key: value` prose is the same bytes
// as frontmatter, so it counts only when it declares real vault metadata.
function frontmatterSpan(text) {
  const span = splitFrontmatter(text);
  if (span.end === 0) return { found: false, raw: '', end: 0, parsed: { found: false } };
  const parsed = parseFrontmatterKeys(span.frontmatter);
  const hasMetadata =
    parsed.found &&
    (parsed.sources?.length > 0 || Object.keys(parsed).some((key) => WIKI_METADATA_KEYS.has(key)));
  if (!hasMetadata) return { found: false, raw: '', end: 0, parsed: { found: false } };
  return { found: true, raw: span.frontmatter, end: span.end, parsed };
}

// Strip a YAML comment from a frontmatter value: a value that IS a comment
// (`# TBD`) or a trailing ` # waived` suffix. Keeps `aliases: [] # note` a waiver
// and `aliases: # fill in later` empty instead of a phantom scalar. (A literal `#`
// inside a quoted alias would be over-stripped — no such alias exists or is
// plausible in this vault.)
function stripYamlComment(v) {
  return v.replace(/(^|\s)#.*$/, '').trim();
}

// True when the frontmatter declares a NON-EMPTY list under `key:`. Tolerates both
// the inline form (`key: [a, b]` — including prettier's single-quoted rewrite) and
// the YAML block form (`key:` followed by `  - item` lines). `key: []` (an explicit
// waiver), a bare `key:`, and a comment-only `key: # …` are NOT non-empty.
//
// DELIBERATE SUPERSET of the production alias matcher (clinic-wiki-loader's
// parseAliases reads only the inline form): the lint classifies a block-form page
// as injected even though today's loader would not inject it. Conservative on
// purpose — over-classifying applies the TIGHTER budget, never lets an actually
// injected page escape. Revisit alignment when the plan-1254 generic loaders land
// their own aliases:/triggerPaths: parsers.
export function hasNonEmptyListKey(fm, key) {
  const lines = String(fm).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!m) continue;
    const rest = stripYamlComment(m[1].trim());
    if (rest) {
      // inline form: non-empty iff the bracket body has content
      const br = rest.match(/^\[(.*)\]$/);
      if (br) return br[1].trim().length > 0;
      return true; // a scalar value — treat as declared
    }
    // block form: at least one following `- item` line before the next top-level key, OR a
    // BRACKETED list written across the following indented lines (plan 4035). Prettier emits
    // TWO bracketed shapes depending on whether the list fits one line — `[` alone with an
    // item per line, and the whole list wrapped onto the single line after `key:` — and both
    // occur in the vault (14 entity pages between them: rcvs, booking-inspector,
    // companies-house, vetstoria on the first; firecrawl, cvr, brreg, allabolag on the
    // second). Handling only one shape left the other classified `pull` on the loose budget,
    // so the indented continuation lines are gathered and tested as one bracket body. An
    // EMPTY bracket pair is still empty — the key exists to mean a non-empty list.
    let buf = '';
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!buf && /^\s+-\s*\S/.test(l)) return true; // `- item` block form
      if (/^\S/.test(l)) break; // next top-level key
      buf += stripYamlComment(l.trim());
      if (buf.startsWith('[') && buf.includes(']')) break; // list closed
    }
    if (buf.startsWith('[')) {
      const close = buf.lastIndexOf(']');
      const inner = close === -1 ? buf.slice(1) : buf.slice(1, close);
      return inner.trim().length > 0;
    }
    return false;
  }
  return false;
}

// ── injected-set derivation ──────────────────────────────────────────────────

// Collect every `<name>.md` basename mentioned in any scripts/hooks/**/*.mjs source
// (registries + fixed page constants), PLUS the loader data tables that deliberately live
// outside that tree. Case-insensitive set of lowercased basenames.
//
// plan 4035: `scripts/wiki-chain-registry.mjs` is the chain loader's CHAINS table, parked
// outside `scripts/hooks/` by plan 2140 so that registering a chain never edits an
// executable hook file. Scanning only `scripts/hooks/**` therefore missed 20 of the 24
// registry-driven chain pages — they classified `pull` and drew the loose 24 KB warn
// instead of the 8 KB warn / 32 KB FAIL their heads are actually injected under. This was
// sequenced behind plan 4035's fold sweep on purpose: reclassifying applies the FAIL cap,
// and five chain pages exceeded it before the sweep, so closing the gap earlier would have
// blocked every wiki write. All 25 chain-page heads are under the cap as of that sweep.
//
// The extra source is a FILE LIST, not a second tree walk: a data table is a leaf, and a
// recursive scan of `scripts/**` would pull in every unrelated script that happens to quote
// a `.md` name (docs pointers, report writers) and silently over-inject.
//
// It is also read through its `file:` VALUES rather than by a bare `.md`-token scan, unlike
// the hooks tree. That asymmetry is deliberate (review finding 2d6119): the registry is
// roughly half prose comment, and those comments cite other `.md` paths — `docs/countries/gb.md`
// and `wiki/entities/services/rcvs.md` today — so a token scan would inject a page merely
// because a comment linked it. A hook source has no such commentary density and its page
// names appear in several shapes, so the loose scan stays right there.
const REGISTRY_FILE_VALUE_RX = /\bfile:\s*['"]([\w][\w.-]*\.md)['"]/g;

// The relative path of the chain registry as this module reads it. DUPLICATED from
// `wiki-commit.mjs`'s `CHAIN_REGISTRY_REL` on purpose (review finding bd21d6): that module
// IMPORTS this one, so reusing its constant would close an import cycle. The two are pinned
// equal by a test in `wiki-size-lint.test.mjs`.
export const CHAIN_REGISTRY_REL_FOR_LINT = 'scripts/wiki-chain-registry.mjs';

const LOADER_DATA_MODULES = [
  {
    parts: CHAIN_REGISTRY_REL_FOR_LINT.split('/'),
    rx: REGISTRY_FILE_VALUE_RX,
    stripComments: true,
  },
];

export function collectHookReferencedBasenames(repoRoot) {
  const out = new Set();

  // Only a MISSING optional source is swallowed (review finding 0824a2). An unreadable one
  // must surface: silently dropping it shrinks the injected set, and an over-cap page would
  // quietly stop failing — the exact direction of error this lint exists to prevent.
  const addFrom = (file, rx, { stripComments = false } = {}) => {
    let src = '';
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return; // fixture repos, sparse checkouts
      throw err;
    }
    // A data table is scanned by its `file:` VALUES, so a commented-out example entry
    // (`// { file: 'x.md' }`) would otherwise register a page it only illustrates.
    // Line comments only: the registry's prose block is `//`-per-line throughout.
    if (stripComments) src = src.replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of src.matchAll(rx)) out.add((m[1] ?? m[0]).toLowerCase());
  };

  const hooksDir = join(repoRoot, 'scripts', 'hooks');
  const stack = [hooksDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // hooks dir absent → empty set (fixture repos without hooks)
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith('.mjs')) {
        addFrom(p, /[\w][\w.-]*\.md\b/g);
      }
    }
  }

  for (const { parts, rx, stripComments } of LOADER_DATA_MODULES)
    addFrom(join(repoRoot, ...parts), rx, { stripComments });

  return out;
}

// ── walk + classify ──────────────────────────────────────────────────────────

// All wiki/**/*.md as repo-relative forward-slash paths, via the single-owner walk
// in wiki-coverage-sweep.mjs.
export function listWikiPages(repoRoot) {
  return listWikiMarkdownFiles(repoRoot)
    .map((abs) => {
      const rel = abs.slice(repoRoot.length).split(sep).join('/').replace(/^\/+/, '');
      return rel;
    })
    .sort();
}

// Classify one page: 'exempt' | 'injected' | 'pull'. `rel` is repo-relative
// forward-slash; `hookBasenames` from collectHookReferencedBasenames.
export function classifyPage(rel, { frontmatter, hookBasenames }) {
  if (EXEMPT.has(rel)) return 'exempt';
  if (!rel.startsWith('wiki/entities/')) return 'pull'; // every loader targets entities/**
  if (rel.startsWith('wiki/entities/clinics/')) return 'injected'; // file-derived loader
  const basename = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  if (hookBasenames.has(basename)) return 'injected'; // named in a loader registry
  if (hasNonEmptyListKey(frontmatter, 'aliases')) return 'injected';
  if (hasNonEmptyListKey(frontmatter, 'triggerPaths')) return 'injected';
  return 'pull';
}

// plan 2434: the LF-normalized byte length of a buffer — counted on the raw bytes (never
// via a UTF-8 decode/re-encode round-trip, which lossily replaces any invalid byte
// sequence with the 3-byte U+FFFD and would inflate rather than fix the measurement).
// Matches git's `eol=lf` normalization: a lone CR is left alone; a CRLF pair collapses
// to LF (one byte removed per pair).
export function lfNormalizedByteLength(buf) {
  let crlfCount = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) crlfCount++;
  }
  return buf.length - crlfCount;
}

// plan 2618: byte length of the frontmatter `updated:` VALUE (trimmed), or 0 when absent.
// Read via the single-owner parseFrontmatter — no second frontmatter regex here (the same
// rule frontmatterOf's comment states; sonnet-review caught the first cut re-rolling one).
// Measured on the value's one physical line (a YAML block-scalar continuation would evade
// this — none exists in the vault, keep it simple).
export function updatedValueLength(
  text,
  parsed = parseFrontmatter(String(text)),
  hasFrontmatter,
  encoding = 'utf8',
) {
  const found = hasFrontmatter ?? parsed.found;
  return found && typeof parsed.updated === 'string'
    ? Buffer.byteLength(parsed.updated, encoding)
    : 0;
}

// plan 2618: body lines (everything after the frontmatter block) longer than
// LONG_LINE_WARN bytes. Returns { count, first: { line, bytes } | null } — enough for a
// warn that names the first offender without hauling page text around. Frontmatter is
// removed by the caller-supplied offset decided once alongside classification. Nothing
// here re-parses or re-guesses the frontmatter fact. Line numbers are body-relative
// (1 = first line after the closing fence).
export function longBodyLines(text, { bodyStart = 0, encoding = 'utf8' } = {}) {
  const body = String(text).slice(bodyStart);
  let count = 0;
  let first = null;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const bytes = Buffer.byteLength(lines[i], encoding);
    if (bytes > LONG_LINE_WARN) {
      count++;
      if (!first) first = { line: i + 1, bytes };
    }
  }
  return { count, first };
}

// plan 4027: the fold-structure measurement for ONE page — how much of it a loader would
// push into context as current truth, and whether it declares a current/history split at all.
//
// `bodyStart` is the caller's already-decided frontmatter offset (the same value the other
// rules are handed), so nothing here re-parses or re-guesses a fence. Measured on the DECODED
// text and in non-blank LINES, not bytes: this is the structural rule, and the byte budgets
// above stay the single owner of size (header decision 3).
//
// Blank lines are excluded so a page is judged on the claims it makes, not on how airily it
// is typeset — two authors writing the same content with different paragraph spacing must not
// land on opposite sides of the bound.
//
// `marked` reports whether the page declares the split at all; `extraMarkers` counts further
// standalone markers after the first. splitFold takes the FIRST marker and leaves the rest as
// inert text in the tail, so a second one is harmless — it is reported (WIKI.md asks for
// exactly one) but never on its own a warn. Counting by re-splitting the TAIL reuses the one
// owner of the fence-aware scan rather than re-rolling it here; the tail re-scan starts with a
// fresh fence context, which can only UNDER-count a marker inside a fence that opened above
// the fold — conservative in the direction that never invents a complaint.
//
// "A marker was found" is `head.length < input.length`, NOT a non-empty tail: splitFold
// returns an empty tail BOTH when there is no marker and when the marker is the last line of
// the file, and only the length comparison tells those apart (the marker line itself is
// dropped from both halves, so a hit always shortens the head).
// Line breaks are CRLF and LF only — deliberately NOT a lone CR, matching `longBodyLines` and
// `splitFrontmatter`, the two parsers this count has to agree with. Round 1 of review made this
// one function lone-CR-aware (gpt-review 8d67e3) and round 2 showed that a HALF-migration is the
// worse state: `splitFrontmatter` still would not find lone-CR frontmatter, so `bodyStart` stays
// 0 and the newly CR-aware counter then counted the metadata lines as body and could warn a
// compliant page (978632, df96c5, 3bbfac, 0d49c1, 6907bb), while `longBodyLines` kept reading a
// whole CR-only page as one oversized line (c0c4ba, 91466c). `.gitattributes` pins `eol=lf` and
// no tracked page uses lone CR, so the uniform LF/CRLF stance is both correct in practice and
// the only self-consistent one available here — `wiki-fold.mjs` semantics are out of scope for
// plan 4027, and generalising the line parser across the module is carried as one infra-debt
// line instead. Do not make this function CR-aware on its own again.
export function aboveFoldBody(text, { bodyStart = 0 } = {}) {
  const src = String(text);
  const { head, tail } = splitFold(src, { scanFrom: bodyStart });
  const lines = head
    .slice(bodyStart)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0).length;
  let extraMarkers = 0;
  for (let rest = tail; rest; ) {
    const next = splitFold(rest);
    if (next.head.length === rest.length) break; // no further marker in the remaining tail
    extraMarkers++;
    rest = next.tail;
  }
  return { lines, marked: head.length < src.length, extraMarkers };
}

// plan 1398 (item 2): read + classify + budget-bucket ONE page — the shared core both
// lintWikiSizes (the full tree walk) and checkPages (a writer's subset check, plan 1362 D1)
// call, so a future budget-rule change can never apply to one and not the other (the exact
// drift the plan-1362 D1 gap risked: a page passing wiki-commit's write-time check but
// failing the pre-push tier, or vice-versa). Returns `null` when the page is unreadable (a
// race with a concurrent move/delete — the caller skips it, the next push/write re-checks);
// otherwise `{ page, bucket, extras }` where `page` is `{ rel, size, cls }` (plus `limit`
// when bucketed) and `bucket` is `'fail' | 'warn' | null` (null = in-budget or exempt —
// still returned so a caller that counts every page, like lintWikiSizes, can). `extras`
// (plan 2618) is a list of ADDITIONAL warn records independent of the size bucket (the
// long-line advisory) — both callers append them to their warns, so the two surfaces can
// never disagree on them either.
export function classifyAndBucketPage(repoRoot, rel, hookBasenames) {
  const abs = join(repoRoot, ...rel.split('/'));
  let buf;
  try {
    buf = readFileSync(abs); // one read: byte size + text from the same buffer
  } catch (err) {
    // A page that VANISHED between the tree walk and this read is a race: the next push or
    // write re-checks it. Anything else - a real permission problem, too many open files -
    // must be LOUD, because swallowing it drops a page from a gate meant to be exhaustive
    // with no verdict anywhere.
    // Do NOT classify by errno. This repo runs on Windows, where a concurrent delete or
    // rename can surface as EPERM/EACCES/EBUSY rather than ENOENT, and an errno allowlist is
    // then a guess that silently rots. Do NOT use existsSync either: it answers false for
    // "inaccessible" as well as "absent", collapsing the exact two cases being told apart.
    // A THROWING stat separates them - only its own ENOENT proves absence, and every other
    // outcome (it stats fine, or fails for another reason) re-throws the ORIGINAL read error.
    // Fail-closed by construction, so it holds whatever errno the platform picks.
    // lstat, NOT stat: stat follows the link, so a DANGLING symlink would fail ENOENT for the
    // target and read as a vanished page, silently dropping a broken page the gate should
    // report. lstat answers about the entry itself, which is the thing that did or did not
    // vanish.
    try {
      lstatSync(abs);
    } catch (probe) {
      if (probe?.code === 'ENOENT' || probe?.code === 'ENOTDIR') return null;
    }
    throw err;
  }
  const text = buf.toString('utf8');
  const frontmatter = frontmatterSpan(text);
  // Size the LF-normalized BYTES, not the raw on-disk bytes: `.gitattributes` pins
  // `eol=lf`, so git stores/injects LF regardless of what a writer left on disk — a
  // CRLF working copy must not measure ~1 byte/line over the artifact the cap
  // actually bounds. Count on the raw buffer (not the decoded `text`): a
  // decode-then-re-encode round-trip replaces any invalid UTF-8 byte with the
  // 3-byte U+FFFD replacement character, which would inflate size instead of
  // just stripping CRLF.
  const size = lfNormalizedByteLength(buf);
  const cls = classifyPage(rel, {
    frontmatter: frontmatter.raw,
    hookBasenames,
  });
  const totalPage = { rel, size, cls };
  if (cls === 'exempt') return { page: totalPage, bucket: null, extras: [] };

  // ONE byte-exact view of the page, used for every BYTE MEASUREMENT below (plan 2434's
  // invariant, restored across all three measured rules). The decoded `text` stays the
  // view for CONTENT and POLICY reads (key names, classification); it must never be the
  // view for a byte count, because `Buffer.from(decoded, 'utf8')` turns each invalid byte
  // into a 3-byte U+FFFD and inflates the measurement - a page under a cap then FAILS, and
  // a false FAIL blocks a wiki write, the exact failure class 2434 exists to stop.
  // latin1 is a byte-for-byte view (1 char == 1 byte), and every construct the splitters
  // inspect - code fences, the frontmatter fence, the `<!-- fold -->` marker, line breaks -
  // is pure ASCII, which a UTF-8 multi-byte sequence never contains. So the raw scan lands
  // on the same lines as the decoded one while the offsets stay byte-exact.
  const rawText = buf.toString('latin1');
  const rawFrontmatterEnd = frontmatter.found ? splitFrontmatter(rawText).end : 0;

  let page = totalPage;
  const sizeExtras = [];
  let injectedHead = text;
  let rawInjectedHead = rawText;
  if (cls === 'injected') {
    const { head } = splitFold(text, { scanFrom: frontmatter.end });
    injectedHead = head;
    const rawFold = splitFold(rawText, { scanFrom: rawFrontmatterEnd });
    rawInjectedHead = rawFold.head;
    const headBytes = lfNormalizedByteLength(Buffer.from(rawFold.head, 'latin1'));
    const tailBytes = lfNormalizedByteLength(Buffer.from(rawFold.tail, 'latin1'));
    page = { rel, size: headBytes, totalSize: size, tailBytes, cls };
    if (tailBytes > PULL_WARN) {
      sizeExtras.push({ ...page, kind: 'tail', size: tailBytes, limit: PULL_WARN });
    }
  }
  if (size > ONE_READ_CEILING) {
    sizeExtras.push({ ...page, kind: 'total', size, limit: ONE_READ_CEILING });
  }

  // plan 4027: the fold-structure advisory. Pushed into `sizeExtras` BEFORE either return
  // path reads it, so it reaches the pre-push tier and wiki-commit's write-time check
  // identically — the same single-owner reasoning the size rules already follow. Scoped by
  // PATH, not by `cls`, for the reason given in the header's decision 1.
  if (isFoldable(rel)) {
    const fold = aboveFoldBody(text, { bodyStart: frontmatter.end });
    if (fold.lines > FOLD_ABOVE_MAX_LINES) {
      sizeExtras.push({
        ...page,
        kind: 'foldHead',
        aboveFoldLines: fold.lines,
        limit: FOLD_ABOVE_MAX_LINES,
        marked: fold.marked,
      });
    }
    // A stray second marker is its OWN advisory, not a rider on the over-bound one: WIKI.md asks
    // for exactly one marker, and a page that already folds is usually WITHIN the bound — which
    // is precisely where a rider could never fire (gpt-review bb7fa2/4522f6).
    if (fold.extraMarkers > 0) {
      sizeExtras.push({ ...page, kind: 'foldMarkers', extraMarkers: fold.extraMarkers });
    }
  }

  // plan 2618: the updated:-length hard rule (both classes) outranks every warn but yields
  // to a size FAIL (the bigger problem prints; fixing either forces a re-check that
  // surfaces the other).
  // DELIBERATELY measured on the DECODED value, unlike the head/tail and long-line rules
  // above. Parsing the latin1 view here would change the RULE, not just the view:
  // parseFrontmatterKeys trims its value, and a raw 0xA0 byte decodes under latin1 to
  // U+00A0, which JS .trim() strips - so a raw-parsed value UNDER-counts (a false PASS),
  // and it would disagree with the `updated:` merge driver, which is UTF-8. The round-trip
  // inflation plan 2434 warns about is ACCEPTED here: it needs invalid UTF-8 inside an
  // `updated:` value specifically, which no page carries, and unlike the head/tail cap
  // is not the rule the fold model moved. Byte-exactness wins where the HARD size cap
  // reads; here matching the merge driver and the trim semantics wins.
  const updatedBytes = updatedValueLength(text, frontmatter.parsed, frontmatter.found);
  const updatedFail =
    updatedBytes > UPDATED_MAX
      ? { page: { ...page, kind: 'updated', updatedBytes, limit: UPDATED_MAX }, bucket: 'fail' }
      : null;

  if (cls === 'injected') {
    // plan 2618: the long-line advisory rides beside the size bucket (injected pages only).
    const extras = [...sizeExtras];
    // Byte-measured too, so it scans the RAW head view (same reason as above).
    const { count, first } = longBodyLines(rawInjectedHead, {
      bodyStart: Math.min(rawFrontmatterEnd, rawInjectedHead.length),
      encoding: 'latin1',
    });
    if (count > 0) {
      extras.push({ ...page, kind: 'longLine', longLines: count, firstLongLine: first });
    }
    if (page.size > INJECTED_FAIL)
      return { page: { ...page, limit: INJECTED_FAIL }, bucket: 'fail', extras };
    if (updatedFail) return { ...updatedFail, extras };
    // plan 2487: ≥90% of the hard cap is still a WARN (never blocks — the bucket is
    // unchanged, so exit codes and every caller's fails/warns split behave as before), but
    // it carries `nearCap` + `cap` so formatBudgetWarning can say "you are about to be
    // REFUSED" instead of repeating the soft 8 KB budget line.
    if (page.size >= INJECTED_NEAR_CAP) {
      return {
        page: { ...page, limit: INJECTED_NEAR_CAP, cap: INJECTED_FAIL, nearCap: true },
        bucket: 'warn',
        extras,
      };
    }
    if (page.size > INJECTED_WARN)
      return { page: { ...page, limit: INJECTED_WARN }, bucket: 'warn', extras };
    return { page, bucket: null, extras };
  }
  if (updatedFail) return { ...updatedFail, extras: sizeExtras };
  if (size > PULL_WARN)
    return { page: { ...page, limit: PULL_WARN }, bucket: 'warn', extras: sizeExtras };
  return { page, bucket: null, extras: sizeExtras };
}

// Lint the whole tree. Returns { pages, warns, failures } where each entry is
// { rel, size, cls, limit }.
export function lintWikiSizes(repoRoot) {
  const hookBasenames = collectHookReferencedBasenames(repoRoot);
  const pages = [];
  const warns = [];
  const failures = [];
  for (const rel of listWikiPages(repoRoot)) {
    const result = classifyAndBucketPage(repoRoot, rel, hookBasenames);
    if (!result) continue; // unreadable → skip (racing a concurrent move); the next push re-checks
    pages.push(result.page);
    if (result.bucket === 'fail') failures.push(result.page);
    else if (result.bucket === 'warn') warns.push(result.page);
    warns.push(...(result.extras ?? [])); // plan 2618: long-line advisories
  }
  return { pages, warns, failures };
}

// Lint exactly the given pages (repo-relative forward-slash wiki paths already ON
// DISK under `repoRoot`) against the SAME budgets + classification lintWikiSizes
// uses for the full tree walk (plan 1362, D1) — for a writer (wiki-commit.mjs) that
// only wants to check the pages IT is about to commit, not re-walk the whole vault.
// `repoRoot` is required (not just the bare paths) because classification depends
// on collectHookReferencedBasenames, which reads `scripts/hooks/**` under it. A
// path that no longer exists on disk (e.g. committing a deletion) is silently
// skipped — nothing to budget-check. Returns { fails, warns }, each entry shaped
// like lintWikiSizes' page records (`{ rel, size, cls, limit }`).
// `hookBasenames` (plan 1398 item 3) lets a caller that already computed the hook-referenced
// basename set — a static-per-hooks-dir value — pass it in, so a caller re-checking the SAME
// pages across multiple attempts (wiki-commit.mjs's coordWrite retry loop) does one
// `scripts/hooks/**` walk+regex for the whole op instead of one per retry. Omitted → computed
// fresh, exactly as before this option existed.
export function checkPages(repoRoot, paths, { hookBasenames } = {}) {
  const basenames = hookBasenames ?? collectHookReferencedBasenames(repoRoot);
  const fails = [];
  const warns = [];
  for (const rel of paths) {
    const result = classifyAndBucketPage(repoRoot, rel, basenames);
    if (!result) continue; // deleted / absent — nothing to check
    if (result.bucket === 'fail') fails.push(result.page);
    else if (result.bucket === 'warn') warns.push(result.page);
    warns.push(...(result.extras ?? [])); // plan 2618: long-line advisories
  }
  return { fails, warns };
}

export const fmtKB = (n) => (n / KB).toFixed(1) + ' KB';

// plan 2487: the ONE renderer for a warn-bucket page, shared by this lint's main() and
// wiki-commit.mjs's write-time check — so the two surfaces can never describe the same page
// differently (the same single-owner reasoning that put classifyAndBucketPage in one place).
// Returns { severity, message }; the caller prefixes its own tool name.
export function formatBudgetWarning(w) {
  if (w.nearCap) {
    return {
      severity: 'NEAR-CAP',
      message:
        `${w.rel} — ${fmtKB(w.size)} head is ≥90% of the ${fmtKB(w.cap)} injected-page cap ` +
        `(${w.cap - w.size} bytes of headroom left). Relocate detail to the non-injected ` +
        `tail below \`<!-- fold -->\` NOW (WIKI.md § "Page budgets") — at the cap ` +
        `the next edit is REFUSED outright, with no bypass flag.`,
    };
  }
  // plan 2618: the long-line advisory — a paragraph-sized entry on an injected page.
  if (w.kind === 'longLine') {
    return {
      severity: 'LONG-LINE',
      message:
        `${w.rel} — ${w.longLines} body line(s) over ${LONG_LINE_WARN} bytes (first: line ` +
        `${w.firstLongLine.line}, ${w.firstLongLine.bytes} B). An injected-page entry is ONE ` +
        `line + a pointer; move the detail to the pointer target (WIKI.md § "Page budgets").`,
    };
  }
  // plan 4027: the fold-structure advisory. The two shapes get different remedies — a page
  // with no marker needs the split drawn at all, a page that has one has let its current-state
  // section grow past the bound — so the message names which one the author is looking at.
  if (w.kind === 'foldHead') {
    return {
      severity: 'FOLD',
      message: w.marked
        ? `${w.rel} — ${w.aboveFoldLines} non-blank lines above \`<!-- fold -->\` ` +
          `(bound ${w.limit}). Everything above the marker is injected as CURRENT truth: move ` +
          `dated history below it, compressed to one line with its date and the plan that ` +
          `superseded it (WIKI.md § "Page budgets", CLAUDE.md § Subject knowledge).`
        : `${w.rel} — ${w.aboveFoldLines} non-blank body lines and no \`<!-- fold -->\` marker, ` +
          `so the WHOLE page is injected as current truth (bound ${w.limit} lines above the ` +
          `fold). Split it: current state above a standalone \`<!-- fold -->\` line, dated ` +
          `history below (WIKI.md § "Page budgets", CLAUDE.md § Subject knowledge).`,
    };
  }
  if (w.kind === 'foldMarkers') {
    return {
      severity: 'FOLD',
      message:
        `${w.rel} — ${w.extraMarkers} further \`<!-- fold -->\` marker(s) after the first. ` +
        `Only the first one splits the page; the rest sit in the tail as inert text. Keep ` +
        `exactly one (WIKI.md § "Page budgets").`,
    };
  }
  if (w.kind === 'tail') {
    return {
      severity: 'WARN',
      message: `${w.rel} — ${fmtKB(w.size)} tail (pull budget warns above ${fmtKB(w.limit)})`,
    };
  }
  if (w.kind === 'total') {
    return {
      severity: 'WARN',
      message:
        `${w.rel} — ${fmtKB(w.size)} total exceeds the ${fmtKB(w.limit)} one-Read ` +
        `ceiling (25,000 tokens).`,
    };
  }
  return {
    severity: 'WARN',
    message: `${w.rel} — ${fmtKB(w.size)} (${w.cls === 'injected' ? 'injected head' : w.cls} budget warns above ${fmtKB(w.limit)})`,
  };
}

// plan 2618: the ONE renderer for a fail-bucket page, shared by this lint's main() and
// wiki-commit.mjs's write-time refusal — same single-owner reasoning as formatBudgetWarning
// (plan 2487): the two surfaces must never describe the same refusal differently.
export function formatBudgetFailure(f) {
  if (f.kind === 'updated') {
    return (
      `${f.rel} — the frontmatter \`updated:\` value is ${f.updatedBytes} bytes ` +
      `(cap ${UPDATED_MAX}). \`updated:\` carries the date plus the last plan or two, never ` +
      `an accretion chain (WIKI.md § "Page budgets" rule 3) — keep the latest entry, point ` +
      `at wiki/log.md for history, and fold any fact not already in the body/log before ` +
      `trimming.`
    );
  }
  return (
    `${f.rel} — ${fmtKB(f.size)} head exceeds the ${fmtKB(f.limit)} injected-page cap. ` +
    `Move deep detail below a standalone \`<!-- fold -->\` marker so only the page head is ` +
    `pushed into context (WIKI.md § "Page budgets").`
  );
}

export function main() {
  const repoRoot = process.cwd();
  const { pages, warns, failures } = lintWikiSizes(repoRoot);
  for (const w of warns) {
    const { severity, message } = formatBudgetWarning(w);
    console.log(`wiki-size-lint: ${severity}  ${message}`);
  }
  for (const f of failures) {
    console.error(`wiki-size-lint: FAIL  ${formatBudgetFailure(f)}`);
  }
  const counts = pages.reduce((a, p) => ((a[p.cls] = (a[p.cls] || 0) + 1), a), {});
  const nearCap = warns.filter((w) => w.nearCap).length;
  // plan 2618: one page can carry several warn entries (size band + long-line advisory), so
  // the summary names the distinct-page count too — a warn total alone reads as "N pages".
  const warnPages = new Set(warns.map((w) => w.rel)).size;
  console.log(
    `wiki-size-lint: ${pages.length} pages (${counts.injected || 0} injected, ${counts.pull || 0} pull, ` +
      `${counts.exempt || 0} exempt) — ${failures.length} fail, ${warns.length} warn` +
      (warnPages !== warns.length ? ` on ${warnPages} page(s)` : '') +
      (nearCap ? ` (${nearCap} NEAR-CAP)` : ''),
  );
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
