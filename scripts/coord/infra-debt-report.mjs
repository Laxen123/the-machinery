#!/usr/bin/env node
// scripts/coord/infra-debt-report.mjs (plan 4199) — shape + size + duplicate report for the
// rolling debt ledgers (`docs/handoff/infra-debt.md`, and any sibling domain ledger such as a grammar-debt.md via
// `--ledger`, which shares its write contract).
//
// The ledger is the sub-floor valve of plan 2531's severity floor and it had no drain: between the
// 2026-08-22 sweep and plan 4199 it grew from 589 to 1,615 entries, with a third of them carrying
// an off-contract tag, 66 newest-first inversions and whole duplicate clusters of shipped work,
// because nothing checked shape at filing time and board-pass had no scripted sweep step. This is
// that step: board-pass Phase 1 runs `--check` and proposes a sweep when it says one is due.
//
// READ-ONLY. It never edits a ledger — the ledgers are hand-edited on MASTER only (vetapp
// CLAUDE.md § Coordination), and a sweep's per-line delete verdicts need evidence this tool does
// not have. It reports; a human (or a heavy session) decides.
//
// The TAG CONTRACT is read from the ledger's own header — every backticked `[tag]` token above
// `## Entries` — so the header stays the one place the allowed list lives. A ledger whose header
// names no tags (grammar-debt.md) gets every check except the tag ones.
//
// Usage:
//   node scripts/coord/infra-debt-report.mjs [--ledger <path>] [--json]
//   node scripts/coord/infra-debt-report.mjs --check [--ledger <path>] [--max-sweep-age-days N]
//   … --ref origin/master   reads the ledger committed at that ref instead of the working tree
//   A relative --ledger path resolves against the repo root (not the cwd), in both read modes.
//   … --no-sweep-date-ok    a header with no last-sweep date is not by itself a reason (grammar-debt.md)
// `--check` prints one verdict line (`INFRA-DEBT: OK …` / `INFRA-DEBT: SWEEP DUE …`) plus the
// reasons, and ALWAYS exits 0 — it is a warning for board-pass, never a gate.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_LEDGER = join(REPO_ROOT, 'docs', 'handoff', 'infra-debt.md');
export const DEFAULT_MAX_SWEEP_AGE_DAYS = 21;
// Near-duplicate CANDIDATES (a human confirms each): token-set Jaccard at or above this, over slugs of at least
// NEAR_DUP_MIN_TOKENS meaningful tokens (shorter slugs collide on vocabulary, not on subject).
export const NEAR_DUP_JACCARD = 0.55;
export const NEAR_DUP_MIN_TOKENS = 4;

const ENTRY_RX = /^- /;
const DATED_RX = /^- (?:~~)?(\d{4}-\d{2}-\d{2})\b/;
// grammar-debt.md's two older shapes: `- **DATE · title.**` and `- **slug** (DATE, …)`.
const BOLD_DATED_RX = /^- (?:~~)?\*\*(\d{4}-\d{2}-\d{2})\b(?:\s*·\s*([^*\n]+))?/;
const BOLD_SLUG_RX = /^- (?:~~)?\*\*([^*\n]+)\*\*\s*\((\d{4}-\d{2}-\d{2})\b/;
const TAG_RUN_RX = /^((?:\[[^\]\n]+\]\s*)*)/;
const SLUG_RX = /^(?:~~)?`([^`\n]+)`/;
// A STATUS marker leading the entry body (optionally bolded / check-marked / struck through), or a
// `RESOLVED-BY-<plan>` slug prefix. "NOT FIXED", "a FIXED path" and "the RESOLVED id" mid-sentence
// are deliberately NOT matched — only a marker the filer put in the status position.
const TERMINAL_BODY_RX = /^(?:✅\s*)?(?:~~)?(?:\*\*)?(?:RESOLVED|FIXED|SUPERSEDED|RETIRED)\b/;
const STOPWORDS = new Set(
  'a an and as at be by for from in is it its no not of on or the to when with'.split(' '),
);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-99-99 and 2026-02-31). */
export function isValidIsoDate(s) {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function daysBetween(fromIso, now) {
  return Math.floor((now.getTime() - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/** The header is everything above `## Entries` (or above the first entry when there is no such heading). */
function splitHeader(lines) {
  const entriesHeading = lines.findIndex((l) => /^##\s+Entries\s*$/.test(l));
  if (entriesHeading !== -1) return { headerEnd: entriesHeading, bodyStart: entriesHeading + 1 };
  const firstEntry = lines.findIndex((l) => ENTRY_RX.test(l));
  const end = firstEntry === -1 ? lines.length : firstEntry;
  return { headerEnd: end, bodyStart: end };
}

export function parseAllowedTags(headerText) {
  const tags = [...headerText.matchAll(/`\[([^\]`\n]+)\]`/g)].map((m) => m[1]);
  return tags.length > 0 ? [...new Set(tags)] : null;
}

export function parseLastSweep(headerText) {
  const m = /last sweep[^0-9\n]{0,20}(\d{4}-\d{2}-\d{2})/i.exec(headerText);
  return m && isValidIsoDate(m[1]) ? m[1] : null;
}

/** Strip a status prefix off a slug so a `RESOLVED-BY-4192: foo` entry clusters with `foo`. */
export function normalizeSlug(slug) {
  return slug
    .replace(/^RESOLVED(?:-BY-\d+)?\s*[:—-]\s*/i, '')
    .trim()
    .toLowerCase();
}

export function slugTokens(slug) {
  return [
    ...new Set(
      normalizeSlug(slug)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

/** Parse a ledger's text into its header facts and one record per top-level entry. */
export function parseLedger(text) {
  const lines = text.split(/\r?\n/);
  const { headerEnd, bodyStart } = splitHeader(lines);
  const headerText = lines.slice(0, headerEnd).join('\n');
  const entries = [];
  for (let i = bodyStart; i < lines.length; i++) {
    const raw = lines[i];
    if (!ENTRY_RX.test(raw)) continue; // blank lines and indented continuation lines
    const lineNo = i + 1;
    const dated = DATED_RX.exec(raw);
    if (!dated) {
      // grammar-debt.md's older shapes. A bold-date TITLE is prose, not a slug, so it never feeds
      // duplicate matching; a bold SLUG does. Both get the same status-marker test as the rest.
      const boldDated = BOLD_DATED_RX.exec(raw);
      const boldSlug = boldDated ? null : BOLD_SLUG_RX.exec(raw);
      const date = boldDated ? boldDated[1] : boldSlug ? boldSlug[2] : null;
      const slug = boldSlug ? boldSlug[1].trim() : null;
      const title = boldDated ? (boldDated[2]?.trim() ?? '') : '';
      const valid = date !== null && isValidIsoDate(date);
      // Status lives in the struck-through prefix, a RESOLVED-BY slug prefix, the title, or the
      // body after the `(DATE, …)` parenthetical — never a bare slug word (`fixed-fee-rounding`).
      const body = boldSlug
        ? raw.slice(boldSlug[0].length).replace(/^[^)]*\)\s*[:—-]*\s*/, '')
        : '';
      const terminal =
        valid &&
        (/^- ~~/.test(raw) ||
          /^RESOLVED-BY-\d+/i.test(slug ?? '') ||
          TERMINAL_BODY_RX.test(title) ||
          TERMINAL_BODY_RX.test(body));
      entries.push({ line: lineNo, date: valid ? date : null, tags: [], slug, terminal, raw });
      continue;
    }
    if (!isValidIsoDate(dated[1])) {
      entries.push({ line: lineNo, date: null, tags: [], slug: null, terminal: false, raw });
      continue;
    }
    let rest = raw.slice(dated[0].length).replace(/^~~/, '').trimStart();
    const tagRun = TAG_RUN_RX.exec(rest)[1];
    const tags = [...tagRun.matchAll(/\[([^\]\n]+)\]/g)].map((m) => m[1]);
    rest = rest.slice(tagRun.length);
    const slugMatch = SLUG_RX.exec(rest);
    const slug = slugMatch ? slugMatch[1] : null;
    const body = slugMatch ? rest.slice(slugMatch[0].length).replace(/^[\s~]*[—:-]+\s*/, '') : rest;
    const terminal =
      /^- (?:~~|✅)/.test(raw) ||
      /^RESOLVED-BY-\d+/i.test(slug ?? '') ||
      TERMINAL_BODY_RX.test(body);
    entries.push({ line: lineNo, date: dated[1], tags, slug, terminal, raw });
  }
  return {
    headerText,
    allowedTags: parseAllowedTags(headerText),
    lastSweep: parseLastSweep(headerText),
    physicalLines: lines.length,
    entries,
  };
}

function jaccard(a, b) {
  let inter = 0;
  const small = a.length <= b.length ? a : b;
  const big = new Set(small === a ? b : a);
  for (const t of small) if (big.has(t)) inter++;
  return inter / (a.length + b.length - inter);
}

/** Group entries whose slugs are identical after normalisation, or near-identical as token sets. */
export function findDuplicateClusters(entries) {
  const withSlug = entries.filter((e) => e.slug);
  const parent = withSlug.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  const norm = withSlug.map((e) => normalizeSlug(e.slug));
  const toks = withSlug.map((e) => slugTokens(e.slug));
  for (let i = 0; i < withSlug.length; i++) {
    for (let j = i + 1; j < withSlug.length; j++) {
      if (norm[i] === norm[j]) {
        union(i, j);
      } else if (
        toks[i].length >= NEAR_DUP_MIN_TOKENS &&
        toks[j].length >= NEAR_DUP_MIN_TOKENS &&
        jaccard(toks[i], toks[j]) >= NEAR_DUP_JACCARD
      ) {
        union(i, j);
      }
    }
  }
  const groups = new Map();
  withSlug.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      kind: new Set(g.map((i) => norm[i])).size === 1 ? 'exact' : 'near',
      entries: g.map((i) => ({
        line: withSlug[i].line,
        date: withSlug[i].date,
        slug: withSlug[i].slug,
      })),
    }));
}

/** The full report object. `now` is injected so the age figures are a property of the input. */
export function buildReport(
  text,
  {
    now = new Date(),
    maxSweepAgeDays = DEFAULT_MAX_SWEEP_AGE_DAYS,
    sweepDateOptional = false,
  } = {},
) {
  const parsed = parseLedger(text);
  const dated = parsed.entries.filter((e) => e.date);
  const malformed = parsed.entries
    .filter((e) => !e.date)
    .map((e) => ({ line: e.line, text: e.raw.slice(0, 120) }));
  const allowed = parsed.allowedTags ? new Set(parsed.allowedTags) : null;
  const offContractTags = [];
  const untagged = [];
  if (allowed) {
    for (const e of dated) {
      if (e.tags.length === 0) untagged.push({ line: e.line, date: e.date, slug: e.slug });
      for (const t of e.tags)
        if (!allowed.has(t)) offContractTags.push({ line: e.line, tag: t, slug: e.slug });
    }
  }
  const inversions = [];
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].date > dated[i - 1].date) {
      inversions.push({ line: dated[i].line, date: dated[i].date, after: dated[i - 1].date });
    }
  }
  const tagHistogram = {};
  for (const e of dated) for (const t of e.tags) tagHistogram[t] = (tagHistogram[t] ?? 0) + 1;
  const oldestDate = dated.reduce((min, e) => (min === null || e.date < min ? e.date : min), null);
  const duplicateClusters = findDuplicateClusters(dated);
  const terminalMarkers = dated
    .filter((e) => e.terminal)
    .map((e) => ({ line: e.line, date: e.date, slug: e.slug }));
  const lastSweepAgeDays = parsed.lastSweep ? daysBetween(parsed.lastSweep, now) : null;

  // A header with no last-sweep date is a reason — unless the caller says this ledger carries none
  // by design (grammar-debt.md, via `--no-sweep-date-ok`), where a reason no sweep can clear would
  // make SWEEP DUE permanent. A ledger with ZERO dated entries is exempt regardless of that flag
  // (plan 4218 gap 2): a fresh coord-init skeleton (and any ledger a sweep has just emptied) has
  // nothing to sweep, so demanding a last-sweep date on it would make a brand-new project report
  // SWEEP DUE before its first entry is ever filed — a false positive, not a real debt signal.
  const reasons = [];
  if (lastSweepAgeDays === null) {
    if (!sweepDateOptional && dated.length > 0) reasons.push('header records no last-sweep date');
  } else if (lastSweepAgeDays > maxSweepAgeDays)
    reasons.push(
      `last sweep ${parsed.lastSweep} is ${lastSweepAgeDays}d old (> ${maxSweepAgeDays}d)`,
    );
  if (offContractTags.length) reasons.push(`${offContractTags.length} off-contract tag(s)`);
  if (untagged.length)
    reasons.push(`${untagged.length} untagged entr${untagged.length === 1 ? 'y' : 'ies'}`);
  if (inversions.length) reasons.push(`${inversions.length} newest-first date inversion(s)`);
  if (malformed.length) reasons.push(`${malformed.length} undated top-level line(s)`);
  if (duplicateClusters.length)
    reasons.push(`${duplicateClusters.length} duplicate slug cluster(s)`);
  if (terminalMarkers.length)
    reasons.push(`${terminalMarkers.length} terminal-marker line(s) awaiting verify-delete`);

  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    physicalLines: parsed.physicalLines,
    entries: dated.length,
    oldestDate,
    oldestAgeDays: oldestDate ? daysBetween(oldestDate, now) : null,
    lastSweep: parsed.lastSweep,
    lastSweepAgeDays,
    allowedTags: parsed.allowedTags,
    tagHistogram,
    offContractTags,
    untagged,
    inversions,
    malformed,
    duplicateClusters,
    terminalMarkers,
    sweepDue: reasons.length > 0,
    reasons,
  };
}

export function formatCheck(report, ledgerName) {
  const head =
    `INFRA-DEBT: ${report.sweepDue ? 'SWEEP DUE' : 'OK'} (${ledgerName}: ${report.entries} entries, ` +
    `${(report.bytes / 1024).toFixed(0)} KiB, oldest ${report.oldestDate ?? 'n/a'}` +
    `${report.oldestAgeDays === null ? '' : ` (${report.oldestAgeDays}d)`}, ` +
    `last sweep ${report.lastSweep ?? 'never'})`;
  return [head, ...report.reasons.map((r) => `  - ${r}`)].join('\n');
}

export function formatText(report, ledgerName) {
  const out = [formatCheck(report, ledgerName), ''];
  if (report.allowedTags) {
    out.push(`tag contract: ${report.allowedTags.map((t) => `[${t}]`).join(' ')}`);
    const hist = Object.entries(report.tagHistogram).sort((a, b) => b[1] - a[1]);
    out.push(`tag histogram: ${hist.map(([t, n]) => `[${t}] ${n}`).join(', ')}`);
  } else {
    out.push('tag contract: none declared in the header (tag checks skipped)');
  }
  const section = (title, rows, fmt) => {
    if (!rows.length) return;
    out.push('', `${title} (${rows.length}):`);
    for (const r of rows) out.push(`  ${fmt(r)}`);
  };
  section(
    'off-contract tags',
    report.offContractTags,
    (r) => `:${r.line} [${r.tag}] ${r.slug ?? ''}`,
  );
  section('untagged entries', report.untagged, (r) => `:${r.line} ${r.date} ${r.slug ?? ''}`);
  section(
    'date inversions (newer below older)',
    report.inversions,
    (r) => `:${r.line} ${r.date} after ${r.after}`,
  );
  section('undated top-level lines', report.malformed, (r) => `:${r.line} ${r.text}`);
  section(
    'terminal-marker lines',
    report.terminalMarkers,
    (r) => `:${r.line} ${r.date} ${r.slug ?? ''}`,
  );
  section(
    'duplicate slug clusters',
    report.duplicateClusters,
    (c) => `${c.kind}: ${c.entries.map((e) => `:${e.line} ${e.slug}`).join(' | ')}`,
  );
  return out.join('\n');
}

export function parseArgs(argv) {
  const opts = {
    ledger: DEFAULT_LEDGER,
    ref: null,
    json: false,
    check: false,
    maxSweepAgeDays: DEFAULT_MAX_SWEEP_AGE_DAYS,
    sweepDateOptional: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--no-sweep-date-ok') opts.sweepDateOptional = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--ledger') opts.ledger = resolve(REPO_ROOT, argv[++i] ?? '');
    else if (a === '--ref') {
      opts.ref = argv[++i];
      if (!opts.ref) throw new Error('--ref needs a git ref (e.g. origin/master)');
    } else if (a === '--max-sweep-age-days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`--max-sweep-age-days needs a non-negative integer`);
      opts.maxSweepAgeDays = n;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE =
  'usage: node scripts/coord/infra-debt-report.mjs [--ledger <path>] [--ref <git-ref>] [--json | --check] [--max-sweep-age-days N] [--no-sweep-date-ok]\n';

/**
 * The ledger text: the working-tree file, or — with `--ref` — the committed blob at that ref, so a
 * board-pass run from any checkout reads `origin/master`'s ledger rather than a stale local copy.
 */
export function readLedger(ledgerPath, ref, { repoRoot = REPO_ROOT, git = execFileSync } = {}) {
  if (!ref) return existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : null;
  const rel = relative(repoRoot, ledgerPath).split(sep).join('/');
  try {
    return git('git', ['-C', repoRoot, 'show', `${ref}:${rel}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function main(
  argv,
  { write = (s) => process.stdout.write(s), now = new Date(), git = execFileSync } = {},
) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`infra-debt-report: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    write(USAGE);
    return 0;
  }
  const text = readLedger(opts.ledger, opts.ref, { git });
  if (text === null) {
    const where = opts.ref ? `${opts.ref}:${opts.ledger}` : opts.ledger;
    process.stderr.write(`infra-debt-report: no ledger at ${where}\n`);
    return 2;
  }
  const report = buildReport(text, {
    now,
    maxSweepAgeDays: opts.maxSweepAgeDays,
    sweepDateOptional: opts.sweepDateOptional,
  });
  const name = basename(opts.ledger);
  if (opts.json) write(JSON.stringify({ ledger: name, ...report }, null, 2) + '\n');
  else if (opts.check) write(formatCheck(report, name) + '\n');
  else write(formatText(report, name) + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
