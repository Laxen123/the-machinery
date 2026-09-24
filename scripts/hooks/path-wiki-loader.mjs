#!/usr/bin/env node
// scripts/hooks/path-wiki-loader.mjs — PostToolUse hook (plan 1254).
//
// The FILE-TOUCH trigger the prompt/reply loaders can't provide. All the other wiki
// loaders match TEXT (the user's prompt or the assistant's reply). Work that arrives as
// "fix backend/src/adapters/provet-cloud.ts" — or via a plan doc that names files, not
// subjects — never names the subject anywhere, so no text loader fires. That is exactly
// when the model is most likely to confabulate. This hook fires on the tool event: when a
// Read/Edit/Write/MultiEdit touches a file under a subject page's declared `triggerPaths:`,
// it injects that page once per CONTEXT — the main thread and each dispatched sub-agent get
// it once each (plan 2883; see `parseContextId` in loader-common for the measured why).
//
// Mapping source is `triggerPaths:` frontmatter on the wiki pages (a repo-relative path
// prefix list), NOT a hand registry here — same philosophy as chain-wiki Pass 2: register
// the page, matching lights up; no hook edit. Keyed by PAGE SLUG in the SHARED `subjects`
// marker root, so a prior prompt-side injection (subject-wiki / price-pipeline) SUPPRESSES
// the path-side one — no double-inject.
//
// SCOPE — platforms + inspectors + services ONLY (the shared subjectPageDirs), NOT the whole
// wiki/entities tree. Chains/clinics have their OWN prompt loaders keyed under separate
// marker roots (CACHE_ROOTS.chain / .clinic); scanning a chain/clinic page here would mark
// it under the `subjects` root instead, so a prompt-side chain injection and a path-side
// touch would NOT dedupe → the page fires twice. Restricting to the pages that live in the
// shared root keeps the once-per-session invariant intact (plan 1254 review).
//
// Output contract (PostToolUse): a PostToolUse hook's PLAIN stdout is NOT added to the
// model context — only structured JSON `hookSpecificOutput.additionalContext` (with
// hookEventName "PostToolUse") is (confirmed against the Claude Code hooks docs). So we
// emit that JSON form; there is no plain-stdout fallback. Fails OPEN + SILENT: bad/missing
// stdin, unparseable payload, no file path, or no match → empty stdout, exit 0.
//
// buildTriggerIndex / matchPaths / pathTriggerHit are exported for unit tests; main() runs
// only when invoked directly.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readStdin,
  markerDirFor,
  alreadyInjected,
  markInjected,
  parseInlineList,
  scanEntityPages,
  subjectPageDirs,
  emitInjection,
  CACHE_ROOTS,
  parseContextId,
  renderPageBlocks,
} from './lib/loader-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
// platforms + inspectors + services only (see SCOPE note above) — the pages that share the
// `subjects` marker root with subject-wiki-loader + price-pipeline-loader.
const SUBJECT_DIRS = subjectPageDirs(REPO_ROOT);
const CACHE_ROOT = CACHE_ROOTS.subjects;

// Path separators that count as a boundary AFTER a triggerPath prefix, so a prefix like
// `backend/src/adapters/provet-cloud` matches `provet-cloud.ts` ('.'), `provet-cloud-
// legacy.ts` ('-'), and `provet-cloud/…` ('/') — but not an unrelated `provet-cloudify`.
const SEP = new Set(['/', '.', '-', '_']);

function normPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

// True if the repo-relative path `rel` is at-or-under the triggerPath prefix `T` — i.e.
// `rel` equals T, or begins with T followed by a path/name separator.
function relMatchesTrigger(rel, T) {
  if (!rel.startsWith(T)) return false;
  if (rel.length === T.length) return true;
  return SEP.has(rel[T.length]);
}

// Does the touched file path hit any of `triggerPaths` (repo-relative prefixes)? Robust
// across: an absolute path under THIS checkout (strip repoRoot), a RELATIVE path (used as
// is), and an absolute path under a DIFFERENT checkout than the hook — worktree vs main —
// (boundary-substring `/T` anywhere in the absolute path). All comparison is lowercase /
// forward-slash (Windows-safe).
export function pathTriggerHit(filePathRaw, triggerPaths, repoRoot = REPO_ROOT) {
  const P = normPath(filePathRaw);
  if (!P) return false;
  const rr = normPath(repoRoot).replace(/\/+$/, '');
  const candidates = [P.replace(/^\/+/, '')]; // raw (covers a relative file_path)
  if (rr && P.startsWith(rr + '/')) candidates.push(P.slice(rr.length + 1)); // under this checkout

  for (const t of triggerPaths || []) {
    const T = normPath(t).replace(/^\/+/, '').replace(/\/+$/, '');
    if (!T) continue;
    // 1) repo-relative prefix match (relative path, or abs stripped of this checkout root)
    for (const rel of candidates) if (relMatchesTrigger(rel, T)) return true;
    // 2) boundary-substring `/T` anywhere in the absolute path (file under another checkout)
    const needle = '/' + T;
    let idx = P.indexOf(needle);
    while (idx !== -1) {
      const after = idx + needle.length;
      if (after === P.length || SEP.has(P[after])) return true;
      idx = P.indexOf(needle, idx + 1);
    }
  }
  return false;
}

// Build the trigger index from the loader-scanned subject pages (via the shared
// scanEntityPages): one entry per page carrying a non-empty `triggerPaths:` list. Returns
// [{ slug, rel, triggerPaths:[str], body }]. opts.readDir/readFile injectable for tests.
// Fail-open (scanEntityPages swallows a missing dir / unreadable page).
export function buildTriggerIndex(dirs = SUBJECT_DIRS, opts = {}) {
  const out = [];
  for (const page of scanEntityPages(dirs, opts)) {
    const triggerPaths = parseInlineList(page.frontmatter, 'triggerPaths').filter(
      (s) => s && s.trim(),
    );
    if (triggerPaths.length === 0) continue;
    out.push({ slug: page.slug, rel: page.rel, triggerPaths, body: page.body });
  }
  return out;
}

// The pages whose triggerPaths the touched file hits. De-duped by slug. PURE. Returns
// [{ slug, rel, body }].
export function matchPaths(filePath, index = buildTriggerIndex()) {
  const out = [];
  const seen = new Set();
  for (const entry of index) {
    if (seen.has(entry.slug)) continue;
    if (pathTriggerHit(filePath, entry.triggerPaths)) {
      seen.add(entry.slug);
      out.push({ slug: entry.slug, rel: entry.rel, body: entry.body });
    }
  }
  return out;
}

// Select the fresh, MARKED pages for a touched file in this CONTEXT (shared root keyed by
// slug — dedupes against the prompt-side subject/price loaders). Returns
// { shown: [{ slug, rel, body }] }.
//
// `contextId` is `parseContextId(payload)`, NOT the bare session id: this hook is the one
// wiki loader that fires inside a dispatched sub-agent, and a sub-agent inherits the
// parent's session_id, so a session-keyed marker made the first context to touch a subject
// eat the page for every other context in the session (plan 2883 — measured both
// directions). Per-context markers mean a worker and its orchestrator each see the page
// once; the prompt-side loaders stay session-keyed because they never fire in a sub-agent.
export function selectFresh(filePath, contextId) {
  const markerDir = markerDirFor(CACHE_ROOT, contextId);
  const shown = [];
  for (const m of matchPaths(filePath)) {
    if (alreadyInjected(markerDir, m.slug)) continue;
    markInjected(markerDir, m.slug);
    shown.push(m);
  }
  return { shown };
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed → fail open
  }
  const filePath = String(payload?.tool_input?.file_path ?? '');
  if (!filePath) return;

  const { shown } = selectFresh(filePath, parseContextId(payload));
  if (shown.length === 0) return; // nothing fresh → empty stdout

  const labels = shown.map((s) => s.slug).join(', ');
  const header =
    `[path-wiki loader] You just touched a file under a wiki subject we keep a page for: ${labels}. ` +
    `Injected once per context (triggered by the file path, not a mention). Treat as canonical subject ` +
    `knowledge and reconcile against it (+ the code) before answering. Write back to the page (and ` +
    `wiki/log.md) if you learn something durable.\n`;
  const blocks = renderPageBlocks(shown.map((page) => ({ ...page, hasFrontmatter: false })));

  // Same shared envelope as the prompt loaders, but tagged PostToolUse (the event this hook
  // fires on) so a future envelope-contract change lands in one place (loader-common).
  emitInjection(
    header + blocks,
    `📁 path-wiki: loaded ${labels} (once per context)`,
    'PostToolUse',
  );
}

// Run main() only when invoked directly, so importing for tests never reads stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
