#!/usr/bin/env node
// scripts/hooks/subject-wiki-loader.mjs — UserPromptSubmit hook (plan 1254).
//
// The generic PLATFORM + INSPECTOR analogue of chain-wiki-loader.mjs. Those subjects
// (wiki/entities/platforms/*.md — a booking platform, a scheduling platform, a
// marketplace platform, … — and the non-price inspector pages wiki/entities/inspectors/
// {homepage,booking,record-profile}-inspector.md) previously had NO loader: they relied
// on the prose "pickup mapping" rule in CLAUDE.md, i.e. on the model remembering to read
// the page — the exact failure mode the loaders exist to remove. This closes that
// coverage gap.
//
// Matcher source is the page's own `aliases:` frontmatter (a curated phrase list), so
// registering a page = it lights up; no hook edit. Mirrors the file-derived spirit of
// a per-record loader. Keyed by PAGE SLUG in the SHARED `subjects` marker root, so it
// dedupes against path-wiki-loader (a file touch) and a project's own fixed-page
// loaders — an overlap can never double-inject.
//
// Design (mirrors the sibling loaders):
//   - Fires on EVERY prompt (UserPromptSubmit); a subject is as often named mid-thread.
//   - Injects each page AT MOST ONCE per session (shared marker keyed session_id + slug).
//   - A dedicated-subject page can be EXCLUDED here (DEDICATED): it keeps its own richer
//     loader, whose TRIGGER regex is far richer than a flat alias list.
//   - Fails OPEN + SILENT: bad/missing stdin, unparseable payload → empty stdout, exit 0.
//
// matchSubjects / buildSubjectIndex are exported for unit tests; selectFresh +
// toStopEntries are the Stop-driver contract (wiki-loaders-stop.mjs); main() runs only
// when invoked directly.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runHookCli,
  markerDirFor,
  alreadyInjected,
  markInjected,
  norm,
  phraseHit,
  parseInlineList,
  scanEntityPages,
  subjectPageDirs,
  CACHE_ROOTS,
  injectionEnvelope,
  parseSessionId,
  isRelayedAgentTurn,
  renderPageBlocks,
} from './lib/loader-common.mjs';
import { loadCoordConfig } from '../coord/coord-config.mjs';

// Compatibility re-export for stop-loader composition and its tests; implementation lives
// only in loader-common.
export { renderPageBlocks };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const CACHE_ROOT = CACHE_ROOTS.subjects;

// The dirs this loader owns — platforms + inspectors + services, shared with
// path-wiki-loader via the same `subjects` marker root (defined once in loader-common).
const SUBJECT_DIRS = subjectPageDirs(REPO_ROOT);

// Pages owned by a DEDICATED loader — skip them here so the richer loader stays canonical
// (a project's own dedicated-subject loader, e.g. one pinned to its own pipeline concept
// page). Belt-and-suspenders even so: all three subject loaders share ONE marker
// root keyed by slug, so an overlap can't double-inject.
const DEDICATED = new Set(['price-inspector']);

// Normalized alias must be ≥ this many chars to be eligible — a light guard against an
// accidental ultra-short alias. Curated single-word BRANDS are legitimate, so — unlike
// the seed-derived per-record loader — we do NOT require ≥2 words.
const MIN_ALIAS_LEN = 4;

// Bare generic tokens that must NEVER fire even if a page mis-declares one as an alias
// (matched against the WHOLE normalized alias, so a real multi-word phrase containing one is
// unaffected). Mirrors chain-wiki's GENERIC_DENY.
//
// plan 4172: the project's OWN deny words — its record noun, and a product name that is also
// a common word in the project's language — are coord.config.json's `wikiAliasDeny`, added to
// the generic set here. An unreadable config adds nothing (fail-open: a prompt hook never throws).
export function configuredAliasDeny(repoRoot) {
  try {
    return loadCoordConfig(repoRoot).wikiAliasDeny ?? [];
  } catch {
    return [];
  }
}
const GENERIC_DENY = new Set([
  'booking',
  'profile',
  'homepage',
  'price',
  'inspector',
  'platform',
  ...configuredAliasDeny(REPO_ROOT),
]);

// Build the match index: one entry per page (via the shared scanEntityPages) with its
// eligible normalized alias phrases and its body. opts.readDir/readFile injectable for
// tests. Returns [{ slug, rel, file, phrases:[norm], body }]. Fail-open (scanEntityPages
// swallows a missing dir / unreadable page). Pages owned by a DEDICATED loader, or with no
// usable alias, are dropped.
export function buildSubjectIndex(dirs = SUBJECT_DIRS, opts = {}) {
  const out = [];
  for (const page of scanEntityPages(dirs, opts)) {
    if (DEDICATED.has(page.slug)) continue;
    const phrases = [];
    const seen = new Set();
    for (const alias of parseInlineList(page.frontmatter, 'aliases')) {
      const p = norm(alias);
      if (p.length < MIN_ALIAS_LEN || GENERIC_DENY.has(p) || seen.has(p)) continue;
      seen.add(p);
      phrases.push(p);
    }
    if (phrases.length === 0) continue; // no usable alias → page can't match here
    out.push({ slug: page.slug, rel: page.rel, file: page.file, phrases, body: page.body });
  }
  return out;
}

// Collect the subject pages named in `text` (case-insensitively, whole-phrase with a left
// word boundary via phraseHit). De-duped by slug. PURE (no marker/body side effects beyond
// the buildSubjectIndex read) so it is reusable by tests. Returns [{ slug, rel, body }].
export function matchSubjects(text, index = buildSubjectIndex()) {
  const np = norm(text);
  if (!np) return [];
  const out = [];
  const seen = new Set();
  for (const entry of index) {
    if (seen.has(entry.slug)) continue;
    if (entry.phrases.some((p) => phraseHit(np, p))) {
      seen.add(entry.slug);
      out.push({ slug: entry.slug, rel: entry.rel, body: entry.body });
    }
  }
  return out;
}

// Select the fresh, MARKED subject pages for `text` this session: match → drop
// already-injected → mark (shared root keyed by slug). No cap (the subject set is small
// and bounded). Returns { shown, overflow } with shown = [{ slug, label, body, rel }].
// Used by both main() (prompt-side) and wiki-loaders-stop.mjs (assistant-side).
export function selectFresh(text, sessionId) {
  const markerDir = markerDirFor(CACHE_ROOT, sessionId);
  const shown = [];
  for (const { slug, rel, body } of matchSubjects(text)) {
    if (alreadyInjected(markerDir, slug)) continue;
    markInjected(markerDir, slug);
    shown.push({ slug, label: slug, body, rel });
  }
  return { shown, overflow: 0 };
}

// Map shown pages → uniform Stop entries { key, label, path } for the batched Stop
// injection. `path` makes the Stop driver emit a Read-pointer; deliberately NO `block`
// (the driver discards it for path-bearing entries — plan 1330 review).
export function toStopEntries(shown) {
  return (shown || []).map((s) => ({
    key: s.slug,
    label: s.label,
    path: s.rel,
  }));
}

// The hook's whole outcome as DATA (plan 4238): the injection envelope it would print,
// or undefined for silence. Marker/dedup side effects happen here exactly as before the fold.
// The in-process UserPromptSubmit dispatcher (prompt-wiki-dispatch.mjs) calls this; the
// CLI below is a thin wrapper that prints it.
export function evaluateHook(payload) {
  const prompt = String(payload?.prompt ?? '');
  if (!prompt || isRelayedAgentTurn(prompt)) return;

  const { shown } = selectFresh(prompt, parseSessionId(payload));
  if (shown.length === 0) return; // nothing fresh → empty stdout

  const labels = shown.map((s) => s.label).join(', ');
  const plural = shown.length > 1 ? 's' : '';
  const header =
    `[subject-wiki loader] The prompt names ${shown.length} subject${plural} ` +
    `we keep a wiki page for: ${labels}. Injected once per session; treat as canonical subject ` +
    `knowledge and reconcile against it (+ the code) before answering. Write back to the page ` +
    `(and wiki/log.md) if you learn something durable.\n`;
  const blocks = renderPageBlocks(shown.map((page) => ({ ...page, hasFrontmatter: false })));

  return injectionEnvelope(header + blocks, `📄 subject-wiki: loaded ${labels} (once per session)`);
}

// Run main() only when invoked directly, so importing for tests never reads stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a prompt hook must never break the turn
  }
  process.exit(0);
}
