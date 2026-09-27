#!/usr/bin/env node
// scripts/coord/wiki-coverage-sweep.mjs  (plan 1082)
//
// A DECOUPLED wiki coverage sweep — the third land-mechanism designed in plan 1074,
// deferred and then operator-greenlit (2026-06-26) with the "landing-watcher hook,
// every N lands" cadence. Unlike plan 1074's per-land gates (the STATUS_FLIP consistency
// gate + the WIKI_CHECKPOINT growth gate in done-worktree), this is PERIODIC maintenance
// that catches cross-land drift no single land's gate can see.
//
// What it flags (ranked, into a committed output/reports/ doc):
//   1. DRIFTED subjects — a wiki page whose SOURCE (the code/spec it documents, read from
//      the page's own `sources:` frontmatter) was committed AFTER the page's `updated:`
//      date. This is the "source moved, page didn't" drift the growth checkpoint can miss.
//   2. DEAD source refs — a `sources:` entry that no longer resolves to a repo path
//      (code moved/renamed → the page certainly needs a look).
//   3. ORPHANS — subject pages with no inbound [[wikilinks]] from a NON-meta page (index /
//      hot / overview etc. link everything, so they're excluded as link sources — a page
//      reachable ONLY through them is effectively orphaned).
//   4. SEED-behind — pages listing the high-churn seed whose `updated:` trails the seed's
//      last change by more than SEED_STALE_DAYS. Seed changes almost every land, so this is
//      a LOW-priority spot-check bucket (a 1-day seed lead is noise; a 30-day lead isn't),
//      kept separate from the high-signal definitional-drift ranking above.
//   5. NO-SOURCES (advisory, plan 1609) — non-meta subject pages carrying no `sources:` at all.
//      They are invisible to buckets 1/2/4 (which read `sources:`), so without this bucket the
//      `sources:` convention is silently unenforced. A `computed-from:` key is the declared
//      waiver: provenance that is a command, not a git-datable repo path.
//   6. STALE-STATUS / DEAD-CITED / HOT-CACHE-AGE (advisory, plan 4125) — the three mechanically
//      detectable classes from the 2026-09-22 wiki stale review: a landed plan's work still
//      written as pending, a backticked repo path in the page BODY that no longer resolves
//      (bucket 2's twin, for prose citations rather than `sources:`), and a `hot.md` older than
//      its own overwritten-each-pass promise. See § Stale-claim buckets below.
//
// The page->source mapping is NOT invented here: it already exists as each page's `sources:`
// frontmatter list (40 of 51 pages carry it — the other 11 are the 8 exempt spine/meta pages
// plus whatever bucket 5 is currently flagging), already citing code paths like
// `backend/src/adapters/some-platform.ts` and `backend/scripts/data-pipeline/ (code)`.
// Source "freshness" is the git LAST-COMMIT date of each path (NOT filesystem mtime, which a
// fresh worktree checkout resets) — deterministic and worktree-safe.
//
// Cadence: done-worktree's close-out calls `node scripts/coord/wiki-coverage-sweep.mjs --on-land`
// as a best-effort step (guarded by existsSync so it cleanly no-ops on a sibling like tandapp
// that adopts done-worktree.mjs byte-identical but has no wiki/ and hasn't adopted this
// script). --on-land fires the sweep only every LANDS_PER_SWEEP lands — measured by the
// durable, cross-machine count of archived plans (docs/superpowers/plans/archive/), with the
// "last swept at" index stored in the committed report's own `landing_index:` frontmatter
// (the report IS the cadence state — no extra counter file). Non-firing lands do nothing and
// commit nothing.
//
// Usage:
//   node scripts/coord/wiki-coverage-sweep.mjs                 # manual sweep; write report, print summary
//   node scripts/coord/wiki-coverage-sweep.mjs --commit        # ...and commit the report to master
//   node scripts/coord/wiki-coverage-sweep.mjs --json          # machine-readable result to stdout
//   node scripts/coord/wiki-coverage-sweep.mjs --root <dir>    # sweep a specific repo root (tests/dev)
//   node scripts/coord/wiki-coverage-sweep.mjs --on-land       # cadence hook (every Nth land); always exit 0
//
// Manual exit code: 0 = clean, 1 = findings (so it's usable as a check). --on-land: always 0.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveMain, coordWrite, withCoordCheckout, parseFlags } from './coord-git.mjs';
import { ALL_PLAN_FOLDERS, buildPlanFolderIndex } from './build-index-lib.mjs';
import { splitFrontmatter } from './wiki-fold.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

// ── Tunables ────────────────────────────────────────────────────────────────
export const LANDS_PER_SWEEP = 10; // fire the on-land sweep once every N completed lands
export const SEED_STALE_DAYS = 30; // a seed-listing page only flags if it trails seed by > this
export const REPORT_REL = 'output/reports/wiki-coverage-sweep.md';
const PLANS_REL = 'docs/superpowers/plans';

// Front-door / meta pages: they link broadly (index, hot) or are journals/pointers. They are
// NOT subjects (no code source to drift) and must NOT count as inbound-link sources, else they
// mask every orphan. Matched by `name` frontmatter OR bare filename (a page may lack frontmatter).
export const META_PAGES = new Set([
  'index',
  'hot',
  'overview',
  'log',
  'MEMORY',
  'QUICKSTART',
  'plans-active',
  'plans-archive',
]);

// ── Frontmatter parsing (minimal YAML: scalars + one level of block list) ─────
// The wiki frontmatter is a known, simple shape — `key: value` scalars and a `sources:`
// block list of `  - path` items. We parse exactly the fields we need rather than pull in a
// YAML dependency the workspace doesn't carry.
export function parseFrontmatter(text) {
  // ONE fence rule repo-wide (plan 3531): splitFrontmatter is the single owner, so this parser,
  // wiki-size-lint and the loaders can never disagree about where frontmatter ends. It is
  // stricter than the regex that used to live here - a closing `---` must stand alone
  // apart from horizontal whitespace - which is why an inner `--- text` line no longer
  // truncates the block.
  const { frontmatter, end } = splitFrontmatter(text);
  if (end === 0) return { found: false };
  return parseFrontmatterKeys(frontmatter);
}

// The KEY reader, split out from the fence finder above (plan 3531). A caller that has
// ALREADY delimited the frontmatter - wiki-size-lint, which must use the same fence that
// wiki-fold's splitFold scans from - passes the block text straight in, so it cannot be
// re-clipped by a second fence regex. That re-clipping was a real defect: a frontmatter line
// beginning `---` followed by other text ended the block for this parser but not for the
// strict one, so every key after that line was invisible to whoever asked for keys.
export function parseFrontmatterKeys(body) {
  const lines = String(body).split(/\r?\n/);
  const out = { found: true, sources: [] };
  let inSources = false;
  for (const line of lines) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const item = /^\s+-\s+(.*\S)\s*$/.exec(line);
      if (item) {
        out.sources.push(item[1]);
        continue;
      }
      // Stay in the block across blank lines and any INDENTED non-list line (a YAML comment or a
      // wrapped continuation): only a new TOP-LEVEL key (a line starting at column 0) ends the
      // list — so an interleaved `  # note` can't silently truncate the remaining source paths.
      if (line.trim() === '' || /^\s/.test(line)) continue;
      inSources = false;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      const [, key, val] = kv;
      if (key === 'sources') continue; // handled above
      out[key] = val.trim();
    }
  }
  // `raw` = the un-parsed block text, for consumers that scan keys this parser doesn't
  // model (wiki-size-lint's aliases:/triggerPaths: probe) — keeps the frontmatter regex
  // single-owner. Set last so a literal `raw:` frontmatter key can't shadow it.
  out.raw = body;
  return out;
}

// A source that does not live inside THIS repo: an absolute path (a cross-repo pointer like the
// shared tandapp muntra adapter), a URL, or a `..`-escape. These are intentional external
// references — we can't git-date them here, and they are neither drift nor dead-ref. Skipped.
export function isExternalPath(p) {
  return (
    /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p) || /^[a-z]+:\/\//i.test(p) || p.includes('../')
  );
}

// Strip the optional ` (code)` annotation + surrounding whitespace from a source entry.
export function normalizeSource(raw) {
  return raw
    .replace(/\s*\(code\)\s*$/i, '')
    .trim()
    .replace(/\/+$/, ''); // drop a trailing slash so a dir path resolves cleanly
}

// Classify a source by what KIND of change it represents:
//   'data' — high-churn data (the seed JSON); drift is expected, handled in the low-priority bucket
//   'code' — the subject's behaviour (ts/py/mjs/js, or a dir under a code root, or a `(code)` tag)
//   'doc'  — a runbook/spec the page synthesises
//   'other'— anything else (ignored for drift, still existence-checked for dead refs)
export function classifySource(raw) {
  const hadCodeTag = /\(code\)\s*$/i.test(raw);
  const p = normalizeSource(raw);
  if (/\.json$/i.test(p)) return 'data';
  if (/\.(ts|tsx|js|mjs|cjs|py)$/i.test(p)) return 'code';
  if (/\.md$/i.test(p)) return 'doc';
  if (/^(backend\/(src|scripts)|frontend\/src|shared\/src)(\/|$)/.test(p)) return 'code';
  if (hadCodeTag) return 'code';
  return 'other';
}

// Extract [[wikilink]] targets from page body text, normalising `[[name|alias]]` → name and
// dropping any `#anchor`. Returns lower-cased-trimmed target names.
export function extractWikilinks(text) {
  const out = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

// A page is meta/front-door if its `type:` frontmatter says so (the durable signal every page
// already carries) OR its bare filename is in the hardcoded allowlist (belt-and-suspenders for a
// page whose frontmatter is missing/incomplete). Keying off `type:` means a NEW front-door page
// (e.g. a future glossary with `type: meta`) is recognised without hand-editing META_PAGES.
export const META_TYPES = new Set(['index', 'meta', 'overview']);
function isMetaPage(page) {
  return META_TYPES.has(page.type) || META_PAGES.has(page.name) || META_PAGES.has(page.base);
}

// ── Date helpers (YYYY-MM-DD compares lexically == chronologically) ───────────
// A valid wiki `updated:` is a bare ISO date. Anything else (a free-text "June 2026", a `2026-06`
// month, an empty value) can't be compared or differenced soundly, so analyze flags it as
// malformed rather than silently mis-handling it (a non-ISO string both breaks the lexical drift
// filter and yields NaN from Date.parse).
export function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}
function daysBetween(aYmd, bYmd) {
  const a = Date.parse(aYmd + 'T00:00:00Z');
  const b = Date.parse(bYmd + 'T00:00:00Z');
  return Math.round((a - b) / 86400000);
}
function ymd(iso) {
  return (iso || '').slice(0, 10);
}

// ── Pure analysis core ────────────────────────────────────────────────────────
// pages: [{ name, base, type, file, updated, sources:[raw], computedFrom, links:[targetSlug] }]
// dateOf: (repoRelPath) => 'YYYY-MM-DD' | null   (null = path absent / no commit)
// Returns the categorised, ranked findings. Fully deterministic — no git, no clock here.
export function analyze(pages, dateOf) {
  const drifted = [];
  const deadRefs = [];
  const seedBehind = [];
  const malformed = [];
  const noSources = [];
  let subjects = 0;

  for (const page of pages) {
    if (isMetaPage(page)) continue;
    if (!page.sources || page.sources.length === 0) {
      // NO-SOURCES: invisible to every drift check below. `computed-from:` is the declared
      // waiver for pages whose provenance is a command, not a git-datable repo path.
      if (!page.computedFrom) noSources.push({ page: page.name, type: page.type || '(none)' });
      continue;
    }
    subjects++;
    const pageDate = ymd(page.updated);

    // A subject page with no valid ISO `updated:` can't be drift-reasoned (the lexical compare and
    // the day-diff both go wrong on a non-ISO value). Flag it as a hygiene finding and skip — never
    // silently suppress its drift or emit a NaN drift row.
    if (!isIsoDate(pageDate)) {
      malformed.push({ page: page.name, updated: page.updated || '(none)' });
      continue;
    }

    const defDates = []; // {path, date} for code+doc sources
    const dataDates = []; // {path, date} for seed/data sources
    const dead = [];
    for (const raw of page.sources) {
      const path = normalizeSource(raw);
      if (isExternalPath(path)) continue; // external cross-repo / URL pointer — not our subject to track
      const cls = classifySource(raw);
      const d = dateOf(path);
      if (d === null) {
        dead.push(path);
        continue;
      }
      if (cls === 'code' || cls === 'doc') defDates.push({ path, date: d });
      else if (cls === 'data') dataDates.push({ path, date: d });
    }

    if (dead.length) deadRefs.push({ page: page.name, missing: dead });

    const newerDef = defDates
      .filter((s) => s.date > pageDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    if (newerDef.length) {
      const newest = newerDef[0];
      drifted.push({
        page: page.name,
        updated: pageDate,
        newestSource: newest.path,
        sourceDate: newest.date,
        driftDays: daysBetween(newest.date, pageDate),
      });
    }
    if (dataDates.length) {
      const newestData = dataDates.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      const behind = daysBetween(newestData.date, pageDate);
      if (behind > SEED_STALE_DAYS) {
        seedBehind.push({
          page: page.name,
          updated: pageDate,
          seedDate: newestData.date,
          daysBehind: behind,
          seedPath: newestData.path,
        });
      }
    }
  }

  drifted.sort((a, b) => b.driftDays - a.driftDays);
  seedBehind.sort((a, b) => b.daysBehind - a.daysBehind);
  deadRefs.sort((a, b) => (a.page < b.page ? -1 : 1));
  malformed.sort((a, b) => (a.page < b.page ? -1 : 1));
  noSources.sort((a, b) => (a.page < b.page ? -1 : 1));

  // Orphans, two tiers — meta/front-door pages (index, hot, …) link broadly, so a page they
  // link is reachable but may have no real place in the knowledge graph:
  //   orphans       — ZERO inbound from any page (not even index): genuinely unreachable. A finding.
  //   catalogOnly   — inbound ONLY from meta pages: reachable just via the index catalog. Advisory
  //                   (normal for a standalone chain page no sibling subject references).
  // A [[wikilink]] references a page's FILENAME slug, but a page's `name:` may differ from its
  // filename — so resolve every target through an identity map keyed on BOTH, and count/look up
  // inbound by the page's stable `base` (filename), never the possibly-divergent `name`.
  const pageByIdentity = new Map();
  for (const page of pages) {
    pageByIdentity.set(page.base, page);
    if (page.name) pageByIdentity.set(page.name, page);
  }
  const inboundAny = new Map(); // keyed by page.base
  const inboundNonMeta = new Map();
  for (const page of pages) {
    const fromMeta = isMetaPage(page);
    for (const target of page.links || []) {
      const tgt = pageByIdentity.get(target);
      if (!tgt || tgt.base === page.base) continue; // unknown target or self-link
      inboundAny.set(tgt.base, (inboundAny.get(tgt.base) || 0) + 1);
      if (!fromMeta) inboundNonMeta.set(tgt.base, (inboundNonMeta.get(tgt.base) || 0) + 1);
    }
  }
  const orphans = [];
  const catalogOnly = [];
  for (const page of pages) {
    if (isMetaPage(page)) continue;
    const any = inboundAny.get(page.base) || 0;
    const nonMeta = inboundNonMeta.get(page.base) || 0;
    if (any === 0) orphans.push({ page: page.name });
    else if (nonMeta === 0) catalogOnly.push({ page: page.name });
  }
  orphans.sort((a, b) => (a.page < b.page ? -1 : 1));
  catalogOnly.sort((a, b) => (a.page < b.page ? -1 : 1));

  return {
    subjects,
    drifted,
    deadRefs,
    orphans,
    catalogOnly,
    seedBehind,
    malformed,
    noSources,
    // hasFindings drives the manual exit code — only the ACTIONABLE buckets count.
    // catalogOnly + seedBehind + noSources are advisory and stay out.
    hasFindings: drifted.length + deadRefs.length + orphans.length + malformed.length > 0,
  };
}

// ── Stale-claim buckets (plan 4125) ───────────────────────────────────────────
// The 2026-09-22 wiki stale review (output/reports/2026-09-22-wiki-stale-review.md) confirmed
// 229 stale claims across 64 pages and sorted them into eight classes. Two of those classes are
// mechanically detectable and one is a freshness promise the cache page makes about itself —
// these three functions are them. All ADVISORY: they never enter `hasFindings`, so they flag on
// the every-10th-land sweep without ever gating a land.
//
// Pure + dependency-injected exactly like analyze(pages, dateOf): the plan-status lookup, the
// filesystem probe and today's date all arrive as arguments, so the tests run with no git, no
// clock and no filesystem (the ambient-state rule, CLAUDE.md § Conventions).

// Only wording that unambiguously asserts a PLAN'S WORK IS NOT LANDED. Three phrases the plan
// body originally listed are deliberately absent — "still open", "in flight" and "follow-up plan"
// — because on the live corpus they almost never mean that. They describe an open DEFECT, a
// deliberate decision, or a plan that correctly owns some later work: "deliberately still open —
// census them separately", "PAUSED machinery pending the deletion follow-up plan", "landed
// 2026-09-13, while 3979 was in flight". Measured on the swept corpus (2026-09-22, plan 4125):
// of 24 surviving hits, 21 came from these three phrases and every one was a false positive,
// while all three genuine hits carried "unlanded" or "not landed". A bucket whose list is 87%
// noise is a bucket the next maintenance pass stops reading, which is the failure this plan
// exists to prevent — so precision wins over recall here.
export const PENDING_WORDING_RX =
  /\b(not yet landed|not landed|unlanded|still-unlanded|branch-state|pending-approval|awaiting (?:its|the) land)\b/i;
export const PLAN_ID_RX = /\bplan[- ](\d{3,4})\b/gi;
const HISTORY_RX =
  /\b(was|were|deleted|removed|retired|renamed|moved|archived|tombstoned|no longer|gone|superseded)\b/i;
const CITED_PATH_RX =
  /`((?:backend|frontend|shared|scripts|docs|coord|wiki|output|\.husky)\/[^`\s]+?)`/g;
// A path's own SPELLING must not make its line read as history: `backend/scripts/gone.py` carries
// a bare `gone`, and `.../archive-me.py` a bare `archive`. HISTORY_RX is a claim about the PROSE
// around the citation, so strip every backticked span before asking it.
const CODE_SPAN_RX = /`[^`]*`/g;

// `wiki/log.md` is the append-only JOURNAL: every line is a dated record of what was true the day
// it was written, and both WIKI.md rule 3 and plan 4125 forbid editing past entries. So a log line
// reading "on plan 3548's branch, not yet landed", or citing a path a later plan deleted, is
// CORRECT history, not a stale claim — and it is unfixable by construction. Left in, the journal
// contributed 63 of 101 stale-status and 7 of 22 dead-cited hits on the 2026-09-22 corpus, drowning
// the live pages these buckets exist to flag. The other meta pages (hot, index, overview) make
// PRESENT-TENSE claims and stay in scope: hot.md L15 is one of the review's own HIGH items.
const JOURNAL_BASES = new Set(['log']);
const isJournalPage = (page) => JOURNAL_BASES.has(page.base);

// Class 1 of the 2026-09-22 review: a sentence that presents a plan's work as unlanded while
// every plan it names is in archive/. planFolderOf(id) -> 'archive' | '<folder>' | null.
export function findStaleStatusClaims(pages, planFolderOf) {
  const out = [];
  for (const page of pages) {
    if (isJournalPage(page)) continue;
    const lines = String(page.text || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!PENDING_WORDING_RX.test(line)) return;
      const ids = [...line.matchAll(PLAN_ID_RX)].map((m) => m[1]);
      if (!ids.length) return;
      if (ids.every((id) => planFolderOf(id) === 'archive'))
        out.push({ page: page.name, line: i + 1, ids });
    });
  }
  return out;
}

// The history skip is scoped to the CLAUSE that carries the citation, not to the whole line
// (round-1 review finding, plan 4125). Line-wide, any past-tense word anywhere in a sentence
// suppressed every citation on it — "This adapter WAS the default before the newer one; see
// `backend/scripts/legacy.py` for the old logic" hid a genuinely dead `legacy.py`, because "was"
// described the adapter, not the path. Splitting on clause boundaries keeps the intended case
// ("the old `x.py` was deleted by plan N" is history) while narrowing the blast radius.
const CLAUSE_SPLIT_RX = /(?<=[.;:!?])\s+|\s+[—–]\s+/;
function clauseAround(line, index) {
  let at = 0;
  for (const clause of String(line).split(CLAUSE_SPLIT_RX)) {
    const start = String(line).indexOf(clause, at);
    const end = start + clause.length;
    if (index >= start && index < end) return clause;
    at = end;
  }
  return line;
}

// Class 8: a backticked repo path the reader would follow that no longer exists in the repo.
// existsRel(relPath) -> boolean. Line refs (:NN), § anchors and trailing punctuation are stripped;
// a clause that says the thing was removed is history, not a dead pointer.
export function findDeadCitedPaths(pages, existsRel) {
  const out = [];
  for (const page of pages) {
    if (isJournalPage(page)) continue;
    const lines = String(page.text || '').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.matchAll(CITED_PATH_RX)) {
        const clause = clauseAround(line, m.index ?? 0);
        if (HISTORY_RX.test(clause.replace(CODE_SPAN_RX, ' '))) continue;
        const p = m[1].replace(/[:#§][^`]*$/, '').replace(/[),.;]+$/, '');
        if (/[<>{}$*]/.test(p)) continue;
        if (!existsRel(p)) out.push({ page: page.name, line: i + 1, path: p });
      }
    });
  }
  return out;
}

// The ONE owner of the console summary. The manual run and the --on-land cadence run each used to
// build this line by hand, so the plan-4125 buckets reached the report but not the on-land summary
// — which is the path that actually runs unattended, every tenth land. Both call this now.
// Tolerant of a result from an older sweep() that carries none of the new keys.
// It must name EVERY bucket, because the report frontmatter's `summary:` is also the INDEX blurb:
// a bucket missing from here is a bucket nobody reads. (The first cut of this function listed only
// the actionable ones and silently dropped `catalog-only` / `no-sources` from the frontmatter.)
export function summaryLine(result) {
  const n = (k) => (result[k] || []).length;
  const hot = result.hotStale ? `${result.hotStale.days}d stale` : 'fresh';
  return (
    `${n('drifted')} drifted, ${n('deadRefs')} dead-refs, ${n('orphans')} orphans, ` +
    `${n('malformed')} malformed, ${n('catalogOnly')} catalog-only, ` +
    `${n('seedBehind')} seed-behind, ${n('noSources')} no-sources, ` +
    `${n('staleStatus')} stale-status, ${n('deadCited')} dead-cited, hot ${hot}`
  );
}

// hot.md is a cache that promises to be overwritten each maintenance pass (WIKI.md § Hot cache).
export const HOT_STALE_DAYS = 14;
export function hotCacheAge(pages, today) {
  const hot = pages.find((p) => p.base === 'hot');
  if (!hot || !hot.updated) return null;
  const d = String(hot.updated).match(/^\d{4}-\d{2}-\d{2}/);
  if (!d) return null;
  const days = Math.floor((Date.parse(today) - Date.parse(d[0])) / 86_400_000);
  return days > HOT_STALE_DAYS ? { updated: d[0], days } : null;
}

// ── Report rendering ──────────────────────────────────────────────────────────
export function renderReport(result, { generated, landingIndex, trigger }) {
  const L = [];
  L.push('---');
  L.push('name: wiki-coverage-sweep');
  L.push('type: report');
  L.push(`generated: ${generated}`);
  if (landingIndex != null) L.push(`landing_index: ${landingIndex}`);
  L.push(`trigger: ${trigger}`);
  L.push(
    // ONE owner for the bucket-count string — see summaryLine. A third hand-built copy here is
    // exactly how the --on-land summary drifted from the report in the first place.
    `summary: ${summaryLine(result)}`,
  );
  L.push('---');
  L.push('');
  L.push(`# Wiki coverage sweep — ${generated}`);
  L.push('');
  L.push(
    `Trigger: **${trigger}**${landingIndex != null ? ` (archive index ${landingIndex})` : ''} · ${result.subjects} subject pages scanned.`,
  );
  L.push('');
  L.push(
    'Generated by `scripts/coord/wiki-coverage-sweep.mjs` (plan 1082). The sweep FLAGS; a human/Claude writes back to the wiki page + `wiki/log.md` per the write-back rule. Source dates are git last-commit dates.',
  );
  L.push('');

  L.push(`## 1. Drifted subjects — ${result.drifted.length}`);
  L.push('');
  L.push(
    'A definitional source (code/spec the page documents) was committed AFTER the page `updated:` date. Ranked by drift.',
  );
  L.push('');
  if (result.drifted.length) {
    L.push('| Page | updated | newest source | source date | drift (d) |');
    L.push('|---|---|---|---|---:|');
    for (const d of result.drifted) {
      L.push(
        `| [[${d.page}]] | ${d.updated} | \`${d.newestSource}\` | ${d.sourceDate} | ${d.driftDays} |`,
      );
    }
  } else {
    L.push('_None — every subject page is at least as fresh as its definitional sources._');
  }
  L.push('');

  L.push(`## 2. Dead source references — ${result.deadRefs.length}`);
  L.push('');
  L.push(
    'A `sources:` entry no longer resolves to a repo path (code moved/renamed/deleted). The page references something gone.',
  );
  L.push('');
  if (result.deadRefs.length) {
    L.push('| Page | missing source(s) |');
    L.push('|---|---|');
    for (const r of result.deadRefs) {
      L.push(`| [[${r.page}]] | ${r.missing.map((p) => `\`${p}\``).join(', ')} |`);
    }
  } else {
    L.push('_None — every `sources:` path resolves._');
  }
  L.push('');

  L.push(`## 3. Orphans — ${result.orphans.length}`);
  L.push('');
  L.push(
    'Subject pages with NO inbound `[[wikilink]]` from any page — not even the index. Genuinely unreachable in the knowledge graph; link them in or confirm the subject is dead.',
  );
  L.push('');
  if (result.orphans.length) {
    L.push('| Page |');
    L.push('|---|');
    for (const o of result.orphans) L.push(`| [[${o.page}]] |`);
  } else {
    L.push('_None — every subject page has at least one inbound link._');
  }
  L.push('');

  L.push(`## 3b. Catalog-only (advisory) — ${result.catalogOnly.length}`);
  L.push('');
  L.push(
    'Reachable ONLY via a meta/front-door page (index/hot) — no sibling subject references them. Normal for a standalone chain page; worth a cross-reference if the subject is load-bearing.',
  );
  L.push('');
  if (result.catalogOnly.length) {
    L.push('| Page |');
    L.push('|---|');
    for (const o of result.catalogOnly) L.push(`| [[${o.page}]] |`);
  } else {
    L.push('_None._');
  }
  L.push('');

  L.push(`## 3c. Malformed frontmatter — ${result.malformed.length}`);
  L.push('');
  L.push(
    'Subject pages whose `updated:` is missing or not a bare `YYYY-MM-DD` date — they cannot be drift-checked until fixed. A data-quality gap the sweep cannot reason past.',
  );
  L.push('');
  if (result.malformed.length) {
    L.push('| Page | updated |');
    L.push('|---|---|');
    for (const m of result.malformed) L.push(`| [[${m.page}]] | \`${m.updated}\` |`);
  } else {
    L.push('_None — every subject page has a valid ISO `updated:` date._');
  }
  L.push('');

  L.push(
    `## 3d. NO-SOURCES — invisible to drift detection (advisory) — ${result.noSources.length}`,
  );
  L.push('');
  L.push(
    'A non-meta subject page with no `sources:` frontmatter (and no `computed-from:` waiver) is skipped by every drift check above — it can go stale forever without being flagged. Backfill `sources:` (or declare `computed-from:` for command-derived provenance).',
  );
  L.push('');
  if (result.noSources.length) {
    for (const f of result.noSources) L.push(`- **${f.page}** (type: ${f.type})`);
  } else {
    L.push('_None — every subject page declares provenance._');
  }
  L.push('');

  L.push(`## 4. Seed-behind (spot-check) — ${result.seedBehind.length}`);
  L.push('');
  L.push(
    `Low priority: these pages list the seed (high-churn) and trail its last change by > ${SEED_STALE_DAYS} days. The seed changes almost every land, so a small lead is noise; a large one means seed-derived facts (counts, footprints) may be stale.`,
  );
  L.push('');
  if (result.seedBehind.length) {
    L.push('| Page | updated | seed last change | days behind |');
    L.push('|---|---|---|---:|');
    for (const s of result.seedBehind) {
      L.push(`| [[${s.page}]] | ${s.updated} | ${s.seedDate} | ${s.daysBehind} |`);
    }
  } else {
    L.push('_None — every seed-listing page is within the threshold._');
  }
  L.push('');

  // Sections 5-7 (plan 4125): the three stale-claim buckets. Advisory like 3b/3c/3d — they never
  // enter hasFindings. A result from an older sweep() has none of these keys, so each defaults.
  const staleStatus = result.staleStatus || [];
  const deadCited = result.deadCited || [];

  L.push(`## 5. Stale status claims (advisory) — ${staleStatus.length}`);
  L.push('');
  L.push(
    'A line describing a plan\'s work as NOT LANDED ("not yet landed", "unlanded", "branch-state", "pending-approval") while EVERY plan id it names sits in `archive/`. The wiki is auto-injected, so a landed fix still written as pending is re-learned by every session that names the subject (plan 4125; class 1 of the 2026-09-22 review, its largest at 76 items). Deliberately NOT flagged: "still open", "in flight" and "follow-up plan" — measured as 87% false positives on this corpus, where they describe an open DEFECT rather than an unlanded plan.',
  );
  L.push('');
  if (staleStatus.length) {
    L.push('| Page | line | plan(s) |');
    L.push('|---|---:|---|');
    for (const s of staleStatus) L.push(`| [[${s.page}]] | ${s.line} | ${s.ids.join(', ')} |`);
  } else {
    L.push("_None — no page describes an archived plan's work as still pending._");
  }
  L.push('');

  L.push(`## 6. Dead cited paths (advisory) — ${deadCited.length}`);
  L.push('');
  L.push(
    'A backticked repo path in the page body that no longer resolves on disk. Unlike section 2 these are cited in PROSE, not in `sources:` — the pointer a reader would actually follow. A line whose prose says the thing was removed/renamed is history and is skipped.',
  );
  L.push('');
  if (deadCited.length) {
    L.push('| Page | line | missing path |');
    L.push('|---|---:|---|');
    for (const d of deadCited) L.push(`| [[${d.page}]] | ${d.line} | \`${d.path}\` |`);
  } else {
    L.push('_None — every repo path cited in a page body resolves._');
  }
  L.push('');

  L.push(
    `## 7. Hot-cache age (advisory) — ${result.hotStale ? `${result.hotStale.days} d` : 'fresh'}`,
  );
  L.push('');
  L.push(
    `\`hot.md\` is a ~500-word recent-context cache that promises to be overwritten each maintenance pass (WIKI.md § Hot cache). Past ${HOT_STALE_DAYS} days it is teaching an old snapshot to every session that opens the wiki.`,
  );
  L.push('');
  if (result.hotStale) {
    L.push(
      `⚠️ \`hot.md\` \`updated: ${result.hotStale.updated}\` — **${result.hotStale.days} days** old (threshold ${HOT_STALE_DAYS}). Rewrite it whole.`,
    );
  } else {
    L.push('_Fresh — `hot.md` is within the threshold._');
  }
  L.push('');

  if (!result.hasFindings) {
    L.push('---');
    L.push('');
    L.push(
      '✅ **Clean sweep** — no drift, dead refs, orphans, or malformed frontmatter. (Catalog-only, seed-behind, no-sources and the three stale-claim buckets are advisory only.)',
    );
    L.push('');
  }
  return L.join('\n');
}

// ── Git / filesystem IO shell ─────────────────────────────────────────────────
function gitToplevel(cwd) {
  try {
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this cwd-scoped,
    // local read at a different repo (see scripts/coord/child-env.mjs gitRepoIsolatedEnv()).
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      env: gitRepoIsolatedEnv(),
    }).trim();
  } catch {
    return cwd;
  }
}

// git last-commit ISO date for a repo-relative path; null if git knows no commit for it
// (absent / never committed). One `git log` per source path — fine for ~35 pages × a few sources.
export function makeGitDateOf(repoRoot) {
  const cache = new Map();
  return (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    let date = null;
    if (isExternalPath(relPath)) {
      cache.set(relPath, null); // never hand git an out-of-repo pathspec (it errors hard)
      return null;
    }
    try {
      const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'], // swallow git stderr (a bad pathspec must not leak)
        // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this local,
        // network-free read at a different repo (gitRepoIsolatedEnv()).
        env: gitRepoIsolatedEnv(),
      }).trim();
      date = out ? out.slice(0, 10) : null;
    } catch {
      date = null;
    }
    cache.set(relPath, date);
    return date;
  };
}

// Walk wiki/ and return every *.md as an ABSOLUTE path. The single owner of the
// wiki-tree traversal — loadPages() below and scripts/coord/wiki-size-lint.mjs both build
// on it, so a walk fix (symlink safety, a new skip rule) lands once.
export function listWikiMarkdownFiles(repoRoot) {
  const wikiDir = join(repoRoot, 'wiki');
  if (!existsSync(wikiDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) files.push(full);
    }
  };
  walk(wikiDir);
  return files;
}

// Walk wiki/ and build the page list (name/base/type/updated/sources/links) for analyze().
export function loadPages(repoRoot) {
  const files = listWikiMarkdownFiles(repoRoot);
  const pages = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const fm = parseFrontmatter(text);
    const base = file.split(sep).pop().replace(/\.md$/, '');
    pages.push({
      name: fm.name || base,
      base,
      type: fm.type || null,
      file: relative(repoRoot, file).split(sep).join('/'),
      updated: fm.updated || null,
      sources: fm.sources || [],
      // `computed-from:` is the NO-SOURCES waiver — provenance that is a command, not a
      // git-datable repo path (parseFrontmatter yields the key with an empty '' value).
      computedFrom: fm['computed-from'] !== undefined,
      links: extractWikilinks(text),
      // The RAW page body, for the line-level stale-claim buckets (plan 4125). Everything above
      // is a digest of the frontmatter; those three read the prose itself.
      text,
    });
  }
  return pages;
}

// ONE git shell-out shape for this module's plan-status / tracked-path reads (round-2 review
// finding: three call sites had each re-typed the same execFileSync options). stderr is swallowed
// because every caller has a defined answer for "git could not tell me".
function git(repoRoot, args, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore'],
    // plan 4096: this shell also runs `fetch --quiet origin` (a real network call, see
    // makePlanFolderOf below), so gitRepoIsolatedEnv() -- repo-selector strip only -- not
    // gitIsolatedEnv()'s blanket GIT_* strip, which would take transport/credential vars a
    // fetch needs down with it. An ambient GIT_DIR/GIT_WORK_TREE could otherwise override the
    // explicit `cwd: repoRoot` above and redirect every one of this module's reads.
    env: gitRepoIsolatedEnv(),
  });
}

// plan-id → status folder. `buildPlanFolderIndex` (scripts/coord/build-index-lib.mjs) is the ONE parser
// for a plan path's status, and its regex admits the optional one-level CATEGORY folder that a
// hand-rolled one-level readdir misses
// — a round-1 review finding: a plan filed at `<status>/<category>/<id>-*.md` resolved to null, so
// every page naming it was silently never checked. Returns a lookup taking a STRING id.
export function planFolderIndexFromListing(listing) {
  const index = buildPlanFolderIndex(listing);
  return (id) => index.get(String(id)) ?? null;
}

// Whether a plan has LANDED is a property of origin/master, not of this checkout, and a worktree's
// local folders lag it — so read the tree. Falls back to a local walk (fed through the SAME parser)
// when git or origin/master is unavailable, so the sweep still works offline.
// `fetch` is OPT-IN and only the CLI entry points pass it. FETCH BEFORE JUDGING (CLAUDE.md
// § Coordination, and the same reason reconcile-worktree-branches.mjs fetches before its own
// listPlanPathsAtOriginMaster): with 5-7 parallel sessions on a shared .git a local origin/master
// is easily behind, and a stale read makes a just-landed plan still look in-progress — silently
// UNDER-flagging. But it must NOT be the library default: this module is imported by
// wiki-size-lint, land-closeout and done-worktree, and a network call on a plain function call
// makes every one of their tests depend on the network. The impure shell fetches; the library reads.
export function makePlanFolderOf(repoRoot, { fetch = false } = {}) {
  try {
    if (fetch) {
      try {
        git(repoRoot, ['fetch', '--quiet', 'origin']);
      } catch {
        /* offline, or no remote — read whatever origin/master we already have */
      }
    }
    const listing = git(repoRoot, [
      'ls-tree',
      '-r',
      '--name-only',
      'origin/master',
      '--',
      PLANS_REL,
    ]);
    if (String(listing || '').trim()) return planFolderIndexFromListing(listing);
  } catch {
    /* no git, no origin/master, or a detached sandbox — fall through to the local walk */
  }
  const rels = [];
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(abs, ent.name), `${rel}/${ent.name}`);
      else if (ent.isFile() && ent.name.endsWith('.md')) rels.push(`${rel}/${ent.name}`);
    }
  };
  for (const folder of ALL_PLAN_FOLDERS) {
    walk(join(repoRoot, 'docs', 'superpowers', 'plans', folder), `${PLANS_REL}/${folder}`);
  }
  return planFolderIndexFromListing(rels.join('\n'));
}

// "Does this cited path exist in the REPO?" — deliberately not `existsSync` alone (round-1 review
// finding). A plan worktree is cut SPARSE by default, so a tracked path under one of the six heavy
// data-pipeline stores is simply not on disk, and a bare existsSync reported every wiki citation
// of one as a dead pointer purely because of where the sweep was run from.
//
// The gitignore arm is deliberate, and a round-2 review finding argued against it: `git
// check-ignore` matches the ignore PATTERN rather than existence, so a TYPO under a
// blanket-ignored directory is reported as present and can never be flagged. That is true, and it
// is not fixable from the repo side — an ignored path is not in the repo by construction, so
// nothing here can tell a correct local-only path from a mistyped one; the information simply is
// not present. A parent-directory probe was tried and measured WORSE: it flagged
// `backend/data/stage4-claim-verifier-local/` itself (whose own citing sentence explains that it
// is gitignored and never reaches origin) while still excusing a typo inside it, i.e. it produced
// the false positive this arm exists to prevent AND kept the false negative. So the rule stays
// "ignored counts as present", and the residual blind spot is recorded rather than papered over.
//
// Pure, so the table is testable without git or a filesystem.
export function repoPathVerdict({ tracked, onDisk, ignored }) {
  return Boolean(tracked || onDisk || ignored);
}

// Every ANCESTOR directory of every tracked file, so a directory citation is one Set lookup
// rather than a scan of the whole ~131k-entry tracked list per citation (round-2 review finding).
export function trackedPrefixSet(trackedPaths) {
  const dirs = new Set();
  for (const f of trackedPaths) {
    let i = f.indexOf('/');
    while (i !== -1) {
      dirs.add(f.slice(0, i));
      i = f.indexOf('/', i + 1);
    }
  }
  return dirs;
}

export function makeRepoPathExists(repoRoot) {
  let files = null;
  let dirs = null;
  const ignoreCache = new Map();
  const load = () => {
    if (files) return;
    files = new Set();
    try {
      const out = git(repoRoot, ['ls-files', '-z'], 256 * 1024 * 1024);
      for (const f of out.split('\0')) if (f) files.add(f);
    } catch {
      /* no git — the filesystem arm below still answers */
    }
    dirs = trackedPrefixSet(files);
  };
  const isIgnored = (p) => {
    if (ignoreCache.has(p)) return ignoreCache.get(p);
    let ignored = false;
    try {
      // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this local,
      // network-free ignore check at a different repo (gitRepoIsolatedEnv()).
      execFileSync('git', ['check-ignore', '-q', '--', p], {
        cwd: repoRoot,
        stdio: 'ignore',
        env: gitRepoIsolatedEnv(),
      });
      ignored = true; // exit 0 = the path IS ignored
    } catch {
      ignored = false;
    }
    ignoreCache.set(p, ignored);
    return ignored;
  };
  return (p) => {
    load();
    const clean = p.replace(/\/+$/, '');
    if (files.has(clean) || dirs.has(clean)) return true;
    if (existsSync(join(repoRoot, clean))) return true;
    // Ask check-ignore about the string AS CITED first. A `foo/bar/` ignore rule only matches a
    // DIRECTORY, and for a path that is not materialised here git cannot infer directory-ness —
    // so the trailing slash is the only thing that tells it. Stripping it first (an earlier cut of
    // this round) made the founding case, `backend/data/stage4-claim-verifier-local/`, stop
    // matching its own blanket rule and start flagging.
    return repoPathVerdict({
      tracked: false,
      onDisk: false,
      ignored: isIgnored(p) || (clean !== p && isIgnored(clean)),
    });
  };
}

export function sweep(
  repoRoot,
  { dateOf, planFolderOf, existsRel, today: todayIso, fetchOrigin = false } = {},
) {
  const pages = loadPages(repoRoot);
  const df = dateOf || makeGitDateOf(repoRoot);
  const result = analyze(pages, df);
  // The three plan-4125 buckets need dependencies analyze() has no business carrying (plan
  // status, the filesystem, the clock), so they are resolved HERE — sweep is already the impure
  // shell that builds makeGitDateOf — and merged onto the result. Advisory: hasFindings is left
  // exactly as analyze computed it, so the --on-land cadence exit stays 0.
  const folderOf = planFolderOf || makePlanFolderOf(repoRoot, { fetch: fetchOrigin });
  const exists = existsRel || makeRepoPathExists(repoRoot);
  result.staleStatus = findStaleStatusClaims(pages, folderOf);
  result.deadCited = findDeadCitedPaths(pages, exists);
  result.hotStale = hotCacheAge(pages, todayIso || today());
  return { result, pages };
}

// ── Cadence: how many lands have completed (durable, cross-machine) ───────────
// Count archived PLAN files as the land proxy. We match only plan-id-shaped basenames (a `NNN-PX-…`
// id prefix, or a legacy `YYYY-MM-DD-…` plan) so a stray README/INDEX.md in the archive tree can't
// inflate the count. This stays APPROXIMATE — a consolidate/supersede archives a plan without a
// land — which is fine: the cadence is "roughly every N lands", not an exact trip.
export function countArchivedPlans(repoRoot) {
  try {
    // plan 4096: an ambient GIT_DIR/GIT_WORK_TREE could otherwise redirect this local,
    // network-free read at a different repo (gitRepoIsolatedEnv()).
    const out = execFileSync('git', ['ls-files', 'docs/superpowers/plans/archive/'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: gitRepoIsolatedEnv(),
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.split('/').pop() || '')
      .filter((b) => /^(\d{3,}-|\d{4}-\d{2}-\d{2}-).*\.md$/.test(b)).length;
  } catch {
    return null;
  }
}

function readLastLandingIndex(repoRoot) {
  const abs = join(repoRoot, REPORT_REL);
  if (!existsSync(abs)) return null;
  const fm = parseFrontmatter(readFileSync(abs, 'utf8'));
  const n = Number.parseInt(fm.landing_index, 10);
  return Number.isFinite(n) ? n : null;
}

// The cadence gate, pure + testable. Fire iff we've never swept before (lastIndex == null →
// bootstrap on the first land that has the script) OR at least `n` lands have completed since
// the last sweep. archiveCount == null means "couldn't count" → don't fire (skip this land).
export function sweepIsDue(archiveCount, lastIndex, n = LANDS_PER_SWEEP) {
  if (archiveCount == null) return false;
  if (lastIndex == null) return true;
  return archiveCount - lastIndex >= n;
}

// today's date as YYYY-MM-DD (UTC) — a real CLI, so the clock is fine here.
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── CLI ────────────────────────────────────────────────────────────────────────
// Spec'd wrapper over the shared coord-git parseFlags (plan 1777). No positionals: a bare
// token keeps the pre-1777 `unknown flag` error text (the message override) rather than
// parseFlags' default `unexpected argument`.
function parseArgs(argv) {
  const { flags } = parseFlags(argv, {
    label: 'wiki-coverage-sweep',
    value: ['root'],
    boolean: ['json', 'commit', 'on-land'],
    positionals: false,
    messages: { positional: (a) => `unknown flag ${a}` },
  });
  return {
    json: flags.json === true,
    commit: flags.commit === true,
    onLand: flags['on-land'] === true,
    root: flags.root ?? null,
  };
}

function runOnLand(flags) {
  // Cadence hook. Exit 0 on a clean no-op / not-due-skip / successful sweep. Exit 1 on a GENUINE
  // failure (couldn't count the archive, or the sweep/commit threw) so done-worktree's wrapper
  // records it as a (non-fatal) teardown error — the land has already shipped, so this never crashes
  // it, but a chronically-failing sweep MUST leave a signal rather than going invisibly dormant.
  let repoRoot;
  try {
    repoRoot = flags.root || resolveMain(); // done-worktree threads its known-good MAIN as --root
    if (!existsSync(join(repoRoot, 'wiki'))) {
      console.log(
        'wiki-coverage-sweep: no wiki/ at main — skipping (expected on a non-wiki sibling).',
      );
      return 0;
    }
    const archiveCount = countArchivedPlans(repoRoot);
    if (archiveCount == null) {
      console.log('wiki-coverage-sweep: could not count archived plans — failing visibly.');
      return 1;
    }
    const last = readLastLandingIndex(repoRoot);
    if (!sweepIsDue(archiveCount, last)) {
      console.log(
        `wiki-coverage-sweep: ${archiveCount - last}/${LANDS_PER_SWEEP} lands since last sweep — not due, skipping.`,
      );
      return 0;
    }
    const { result } = sweep(repoRoot, { fetchOrigin: true });
    const content = renderReport(result, {
      generated: today(),
      landingIndex: archiveCount,
      trigger: 'on-land',
    });
    // plan 1286: commit the report via the DISPOSABLE coord-checkout under the coord-write
    // lock, never the shared MAIN tree (this was one of the residual direct-MAIN writers).
    // Inside done-worktree's close-out a set COORD_MAIN_DIR short-circuits withCoordCheckout
    // to a direct fn(repoRoot) run — already isolated + serialized by the spine.
    withCoordCheckout(
      repoRoot,
      (cdir) =>
        coordWrite(cdir, {
          relPaths: [REPORT_REL],
          mutate: () => writeFileSync(join(cdir, REPORT_REL), content),
          message: `chore(wiki): coverage sweep (land #${archiveCount}) — ${result.drifted.length} drifted, ${result.orphans.length} orphans`,
          tool: 'wiki-coverage-sweep',
        }),
      { tool: 'wiki-coverage-sweep' },
    );
    console.log(
      `wiki-coverage-sweep: swept at archive index ${archiveCount} — ${summaryLine(result)}. Report: ${REPORT_REL}`,
    );
    return 0;
  } catch (e) {
    // Surfaced (exit 1) so done-worktree logs a teardown error, but printed plainly so a slow/dirty
    // MAIN reads as a benign skipped maintenance step, not a land failure.
    console.log(`wiki-coverage-sweep: on-land sweep failed: ${e.message || e}`);
    return 1;
  }
}

export function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (flags.onLand) return runOnLand(flags);

  const repoRoot = flags.root || gitToplevel(process.cwd());
  const { result } = sweep(repoRoot, { fetchOrigin: true });
  // Stamp the CURRENT archive index even on a manual run: the report is the cadence's only state
  // store, so a manual `--commit` must carry `landing_index` (a manual sweep legitimately resets the
  // every-N-lands clock — we just did the coverage check) rather than nulling it and forcing an
  // off-cadence bootstrap on the next land. Best-effort: omit it if the archive can't be counted.
  const content = renderReport(result, {
    generated: today(),
    landingIndex: countArchivedPlans(repoRoot),
    trigger: 'manual',
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.hasFindings ? 1 : 0;
  }

  const abs = join(repoRoot, REPORT_REL);
  if (flags.commit) {
    // plan 1286: same coord-checkout routing as the on-land path (see runOnLand).
    withCoordCheckout(
      repoRoot,
      (cdir) =>
        coordWrite(cdir, {
          relPaths: [REPORT_REL],
          mutate: () => writeFileSync(join(cdir, REPORT_REL), content),
          message: `chore(wiki): manual coverage sweep — ${result.drifted.length} drifted, ${result.orphans.length} orphans`,
          tool: 'wiki-coverage-sweep',
        }),
      { tool: 'wiki-coverage-sweep' },
    );
    // Keep the local convenience copy current too (the report is also a read artifact).
    writeFileSync(abs, content);
  } else {
    writeFileSync(abs, content);
  }
  console.log(`wiki-coverage-sweep: ${result.subjects} subjects — ${summaryLine(result)}`);
  console.log(`Report ${flags.commit ? 'written + committed' : 'written'}: ${REPORT_REL}`);
  if (!flags.commit)
    console.log(
      '(run with --commit to land it, or commit it yourself per the output-layout contract.)',
    );
  return result.hasFindings ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
