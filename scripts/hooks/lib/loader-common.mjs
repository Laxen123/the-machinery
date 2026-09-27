// scripts/hooks/lib/loader-common.mjs — shared helpers for the UserPromptSubmit wiki
// loaders: the generic subject loaders (subject-wiki-loader, path-wiki-loader) that ship in
// the kit, and a project's own per-record loaders. Extracted to one source of truth (plan-1074
// review NIT): these were byte-identical across the loaders. Pure / fail-open; no
// module-level state. The helpers only per-record loaders use (record-name matching, the
// sharded-seed row cache) live in the project-only sibling record-loader-common.mjs (plan 4172).

import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── stdin (plan 2615) ────────────────────────────────────────────────────────
// The nine hook entrypoints all open with `const raw = readStdin(); if (!raw.trim())
// return;`. That helper used to live HERE as `readFileSync(0, 'utf8')` inside a bare
// `catch { return '' }`, which made a READ FAILURE indistinguishable from NO INPUT — on
// Windows an intermittent EAGAIN on the payload pipe therefore masqueraded as an empty
// prompt/reply and killed the injection with no marker, no log line and exit 0.
//
// The fixed reader (bounded EAGAIN retry + a temp-file diagnostic + a discriminated
// `{ ok, raw, error, attempts }` result) now lives in scripts/coord/stdin-read.mjs, because
// `scripts/*.mjs` tools must not import outside `scripts/` — the isolated-plan-repo test
// scaffold copies the flat scripts tree and runs the copies. Re-exported here so all nine
// hooks keep importing it from loader-common unchanged. Full rationale: that module's header.
export {
  readStdin,
  readStdinResult,
  appendStdinDiagnostic,
  STDIN_DIAGNOSTIC_LOG,
} from '../../coord/stdin-read.mjs';
// A LOCAL binding too: runHookCli (plan 4238) reads the payload through the same reader.
import { readStdin } from '../../coord/stdin-read.mjs';

// Wiki fold parsing lives in scripts/ so both scripts and hooks can share one
// implementation without scripts reaching back into scripts/hooks/. Re-exported here so
// every loader keeps importing from loader-common.
import { splitFrontmatter, splitFold, foldPointerLine } from '../../coord/wiki-fold.mjs';
export { splitFrontmatter, splitFold, foldPointerLine };

// Render one or more loader page bodies through the shared fold contract. Every `rel`
// must be repo-relative so the emitted `Read <rel>` pointer is directly openable.
export function renderPageBlocks(shown) {
  return shown
    .map(({ rel, body, hasFrontmatter }) => {
      if (typeof hasFrontmatter !== 'boolean') {
        throw new TypeError(`renderPageBlocks entry ${rel} must declare hasFrontmatter`);
      }
      const { head, tailBytes } = splitFold(body, { hasFrontmatter });
      const pointer = tailBytes > 0 ? `\n${foldPointerLine(rel, tailBytes)}` : '';
      return `\n===== ${rel} =====\n${head.trimEnd()}${pointer}\n`;
    })
    .join('');
}

// Sibling-hook audit (plan 2615 task 4) — the two OTHER stdin readers in this tree do not
// use the shared reader and are deliberately left best-effort:
//   • scripts/hooks/block-archive-plan-edits.sh — shell; reads the payload with `cat` (a
//     proper read-to-EOF, not the failing shape) and only re-pipes that buffered string
//     through a `node -e` extractor. Documented fail-open in its own header.
//   • .claude/settings.json's PostToolUse lint one-liner — a `node -e` file_path extractor
//     whose worst case is a skipped ruff/eslint run on one edited file.
// Neither can silently drop an injection the way the loader family could. The THIRD one that
// DID matter, scripts/select-battery-tests.mjs, is migrated (/sonnet-review high finding).

// The session id off a hook payload, tolerating both the snake_case field the Claude
// Code hooks API sends (`session_id`) and a camelCase fallback. One helper so all five
// hooks read it identically — a field rename lands in one place, not five.
export function parseSessionId(payload) {
  return payload?.session_id ?? payload?.sessionId ?? '';
}

// The CONTEXT id off a hook payload — the session id, plus the sub-agent discriminator
// when the event fired inside a dispatched agent. This is the correct dedup key for any
// hook that can fire inside a sub-agent (PostToolUse, Stop/SubagentStop); `parseSessionId`
// alone is the key for hooks that only ever fire on the main thread (UserPromptSubmit).
//
// WHY (plan 2883, measured 2026-08-05 by dumping real payloads from both sides of one
// `claude -p` run): a dispatched sub-agent's hook payload carries the PARENT's `session_id`
// AND the parent's `transcript_path` — neither discriminates. What it does carry, and a
// main-thread payload does not, is `agent_id` (+ `agent_type`). Measured key sets:
//   main thread: session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
//                hook_event_name, tool_name, tool_input, tool_response, tool_use_id,
//                duration_ms
//   sub-agent:   the same PLUS agent_id, agent_type
// So on a session-keyed marker the FIRST context to touch a subject eats the page for the
// whole session: the same probe read a pipeline source file on the main thread, then a
// dispatched worker read another file under the same triggerPath and received NOTHING.
// The inverse held too — a worker's read blinded the parent. Keying per context fixes both.
//
// Fails OPEN in the same direction as parseSessionId: an absent agent_id is a main-thread
// event, which keeps its byte-identical pre-2883 namespace.
// The SUB-AGENT id off a hook payload, or '' on the main thread. One reader for the
// one field that discriminates the two vantages, so a rename lands in one place —
// `parseContextId` below and the plan-3116 backgrounding guard both go through it.
//
// `agent_id` is the ONLY discriminator, and deliberately not `agent_type`: the shipped
// hook-input schema (Claude Code 2.1.228) says so in the field's own description —
// "Present only when the hook fires from within a subagent … Absent for the main thread,
// even in --agent sessions. Use this field (not agent_type) to distinguish subagent calls
// from main-thread calls." `agent_type` is ALSO set on the main thread of an --agent
// session, so keying on it fires on every top-level call in one.
export function parseAgentId(payload) {
  return payload?.agent_id ?? payload?.agentId ?? '';
}

export function parseContextId(payload) {
  const sessionId = parseSessionId(payload);
  const agentId = parseAgentId(payload);
  if (!sessionId || !agentId) return sessionId;
  const suffix = `-agent-${safeMarkerKey(agentId)}`;
  // IDEMPOTENT on purpose. The Codex PreToolUse adapter (`.codex/hooks/codex-context.mjs`
  // `pathOutput`) already folds the agent into `session_id` before it forwards the payload,
  // and it KEEPS `agent_id` — so a blind append gives that transport
  // `<s>-agent-<a>-agent-<a>`, a second namespace for one context, and the path loader
  // re-injects a page the Stop loader has already marked (gpt-review finding 781520).
  if (safeMarkerKey(sessionId).endsWith(suffix)) return sessionId;
  return `${sessionId}${suffix}`;
}

// Marker dir for this session under the given cache root. null if no usable session
// id (→ no dedup, inject every time, which is safer than never injecting).
// The on-disk directory NAME for a context id (filesystem-safe). Exported so the sweep
// below can recognise `<session>-agent-<agentId>` siblings without re-deriving the rule.
export function safeMarkerKey(id) {
  return id ? String(id).replace(/[^A-Za-z0-9_-]/g, '_') : '';
}

export function markerDirFor(cacheRoot, sessionId) {
  if (!sessionId) return null;
  return join(cacheRoot, safeMarkerKey(sessionId));
}

export function alreadyInjected(markerDir, key) {
  if (!markerDir) return false; // no session id → can't dedup → treat as fresh
  return existsSync(join(markerDir, key));
}

export function markInjected(markerDir, key) {
  if (!markerDir) return;
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, key), '1');
  } catch {
    /* best-effort; a failed marker just means it may inject again later */
  }
}

// ── Centralized per-loader marker cache roots (plan 1254) ────────────────────
// The ONE source of truth for every wiki-loader's tmpdir marker root. Previously
// each loader defined its own `join(tmpdir(), 'vetapp-…')` literal; centralizing them
// here lets the compaction-reset hook (wiki-markers-compact-reset.mjs) and the coverage
// lint enumerate EVERY root, so a new loader can't be forgotten by the reset.
//
//   chain / special / record — per-loader roots, keyed by the loader's own key
//     (chain.key / record id). Distinct page namespaces, no cross-loader overlap.
//   subjects — a SHARED root keyed by PAGE SLUG, used by the three subject loaders
//     (a dedicated-subject prompt loader, subject-wiki prompt, path-wiki PostToolUse).
//     Because they all key on the page slug in ONE root, an overlap (e.g. a pipeline term
//     in a prompt AND a later Edit under that pipeline's triggerPath both point at the same
//     inspector page) dedupes to a single injection instead of double-firing.
// plan 4172: the per-record roots were renamed off the project's record noun (a one-time
// re-injection per live session is the whole cost of moving a marker dir).
export const CACHE_ROOTS = {
  chain: join(tmpdir(), 'vetapp-chain-wiki'),
  special: join(tmpdir(), 'vetapp-special-record'),
  record: join(tmpdir(), 'vetapp-record-wiki'),
  subjects: join(tmpdir(), 'vetapp-wiki-subjects'),
};
export const ALL_CACHE_ROOTS = Object.values(CACHE_ROOTS);

// Codex subagents do not receive Claude's UserPromptSubmit event for their task
// text. The Codex Agent PreToolUse adapter therefore appends the selected wiki
// context directly to the spawned task plus this compact marker. SubagentStop
// can recover the marker from the agent transcript and seed the normal loader
// caches before checking the final reply, so it only reopens for NEW subjects.
// The marker contains keys only, never page contents or operator data.
export const CODEX_WIKI_CONTEXT_MARKER_RX = /<!-- CODEX_WIKI_CONTEXT_MARKERS ([A-Za-z0-9_-]+) -->/g;

export function renderCodexWikiContextMarker(markers) {
  const clean = {};
  for (const key of Object.keys(CACHE_ROOTS)) {
    const values = Array.isArray(markers?.[key]) ? markers[key] : [];
    if (values.length) clean[key] = [...new Set(values.map(String))].sort();
  }
  if (Object.keys(clean).length === 0) return '';
  const encoded = Buffer.from(JSON.stringify(clean), 'utf8').toString('base64url');
  return `<!-- CODEX_WIKI_CONTEXT_MARKERS ${encoded} -->`;
}

export function parseCodexWikiContextMarkers(text) {
  const merged = Object.fromEntries(Object.keys(CACHE_ROOTS).map((key) => [key, new Set()]));
  for (const match of String(text || '').matchAll(CODEX_WIKI_CONTEXT_MARKER_RX)) {
    try {
      const parsed = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
      for (const key of Object.keys(CACHE_ROOTS)) {
        for (const value of Array.isArray(parsed?.[key]) ? parsed[key] : []) {
          if (/^[A-Za-z0-9_.-]+$/.test(String(value))) merged[key].add(String(value));
        }
      }
    } catch {
      // A torn/untrusted transcript marker is ignored; the stop loader may
      // redundantly reconcile a page, which is safer than suppressing one.
    }
  }
  return Object.fromEntries(
    Object.entries(merged)
      .map(([key, values]) => [key, [...values].sort()])
      .filter(([, values]) => values.length),
  );
}

export function seedCodexWikiContextMarkers(text, sessionId) {
  if (!sessionId) return {};
  const markers = parseCodexWikiContextMarkers(text);
  for (const [rootKey, values] of Object.entries(markers)) {
    const markerDir = markerDirFor(CACHE_ROOTS[rootKey], sessionId);
    for (const value of values) markInjected(markerDir, value);
  }
  return markers;
}

// ── Opt-in cache roots for the compaction reset (plan 1754 folded finding) ──────
// A hook OUTSIDE the wiki-loader family — its marker cache lives under its own
// tmpdir root, not one of CACHE_ROOTS above — can still want its per-session markers
// cleared after a compaction. It registers its root HERE, in a SEPARATE object, never
// merged into CACHE_ROOTS/ALL_CACHE_ROOTS: those are walked as the wiki-coverage
// lint's own inventory of wiki loaders, and mixing a non-wiki root in there was the
// REVERTED 1747 wrong-depth mistake (it made bulk-fable-zero-dispatch-tripwire-stop's
// marker look like a fifth wiki loader to that lint). `clearAllRegisteredMarkers` is
// the union-clearing entry point for a compact-reset hook that wants BOTH families
// swept; `clearSessionMarkers`'s own default stays wiki-only and UNCHANGED below, so
// every existing wiki-only caller (and its tests) keeps its exact current behavior.
export const OPT_IN_ROOTS = {
  // bulk-fable-zero-dispatch-tripwire-stop.mjs's own CACHE_ROOT — the single source of
  // truth the hook imports rather than re-declaring the literal.
  bulkFableTripwire: join(tmpdir(), 'vetapp-bulk-fable-tripwire'),
};
export const OPT_IN_CACHE_ROOTS = Object.values(OPT_IN_ROOTS);

// Delete THIS session's marker dir under every (given) cache root — the compaction
// reset. Only removes `<root>/<sanitized-session-id>`, so other sessions' markers are
// untouched. Fails open per-root (a failed rm just leaves that root's markers, which at
// worst suppresses one re-injection). Returns ONLY the dirs that ACTUALLY existed and
// were removed — an existence check gates the rm so a root this session never wrote
// to is not falsely reported as "cleared" (rmSync's `force:true` swallows a missing
// path, so without the guard every root would be pushed even when nothing was there;
// the honest return keeps the caller's "systemMessage fires only when something was
// actually reset" semantics truthful — plan 1754 marker-lifecycle fold-in).
export function clearSessionMarkers(sessionId, roots = ALL_CACHE_ROOTS) {
  if (!sessionId) return [];
  const cleared = [];
  // Per-context dirs (plan 2883) are siblings named `<session>-agent-<agentId>`, so a
  // session sweep must take them too: a sub-agent never outlives the compaction that
  // triggers this sweep, and leaving its dir behind means the marker root grows one
  // directory per dispatched worker forever.
  const agentPrefix = `${safeMarkerKey(sessionId)}-agent-`;
  for (const root of roots) {
    const dir = markerDirFor(root, sessionId);
    if (!dir) continue;
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        cleared.push(dir); // nothing here for this session → don't claim we cleared it
      }
    } catch {
      /* best-effort; leaving a root's markers only risks one missed re-injection */
    }
    if (!agentPrefix) continue;
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.startsWith(agentPrefix)) continue;
        const agentDir = join(root, entry);
        rmSync(agentDir, { recursive: true, force: true });
        cleared.push(agentDir);
      }
    } catch {
      /* root may not exist yet, or an entry may vanish under us — both are fine */
    }
  }
  return cleared;
}

// The union-clearing entry point a compact-reset hook calls when it wants BOTH the
// wiki-loader family AND every OPT_IN_ROOTS registrant swept for this session — see
// the OPT_IN_ROOTS block above. Called by wiki-markers-compact-reset.mjs (plan 1754
// marker-lifecycle fold-in) so a compaction now also clears the bulk-fable tripwire's
// opt-in marker, not just the wiki loaders'. Returns only the dirs that actually
// existed and were removed (see clearSessionMarkers).
export function clearAllRegisteredMarkers(sessionId) {
  return clearSessionMarkers(sessionId, [...ALL_CACHE_ROOTS, ...OPT_IN_CACHE_ROOTS]);
}

// Fold Nordic diacritics (å/ä/ö/é → a/a/o/e, ø → o, æ → ae, ß → ss), lowercase, and
// reduce every non-alphanumeric run to a single space. The ̀-ͯ class is the
// combining-diacritics range (identical to the loaders' original literal range).
export function norm(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/gi, 'o')
    .replace(/æ/gi, 'ae')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Whole-phrase hit with a LEFT word boundary; right side open so Swedish definite
// forms match ("skara djursjukhus" hits inside "skara djursjukhuset"). Both args are
// already norm()'d (charset [a-z0-9 ]).
export function phraseHit(haystack, phrase) {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(phrase, from);
    if (i < 0) return false;
    if (i === 0 || haystack[i - 1] === ' ') return true;
    from = i + 1;
  }
}

// Parse a `<key>: [ ... ]` frontmatter flow array into a list of strings. Tolerant:
// missing/malformed → []. Handles every shape the pages actually take:
//   - INLINE      `key: ["a", "b"]`
//   - prettier-WRAPPED across lines for a long array
//     (`key:\n  [\n    'a',\n    'b',\n  ]`) — long arrays get reflowed on commit
//   - JSON double-quotes (what a human writes) AND prettier's single-quotes (NOT valid
//     JSON), with the single-quoted `''`→`'` apostrophe escape
//   - a value that CONTAINS a `]` (e.g. a Next.js dynamic-route path `.../[city]/...`)
//
// It finds the array's CLOSING `]` by scanning char-by-char while tracking quote state, so
// a `]` inside a quoted scalar can't close the array early. (A plain non-greedy
// `\[[\s\S]*?\]` regex stops at the FIRST `]` → truncates a bracket-containing value to [];
// a greedy one over-captures a later `]` in a following field. Both are wrong — plan 1254
// review rounds 1+2.) `key` is a controlled literal ('aliases' / 'triggerPaths'), so it is
// not regex-escaped.
export function parseInlineList(frontmatter, key) {
  const text = String(frontmatter);
  const head = text.match(new RegExp(`^${key}:[ \\t]*`, 'm')); // key: at a line start
  if (!head) return [];
  let i = head.index + head[0].length;
  while (i < text.length && /\s/.test(text[i])) i++; // skip whitespace/newlines to '['
  if (text[i] !== '[') return [];
  i++; // past the opening '['
  const start = i;
  let quote = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i++; // YAML single-quote '' escape → a literal ', stay in-quote
          continue;
        }
        quote = null;
      }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === ']') {
      break; // the MATCHING close bracket (any ']' inside quotes was skipped above)
    }
  }
  // Extract the quoted scalars from the array body (double- OR single-quoted; '' → ').
  const inner = text.slice(start, i);
  const out = [];
  const re = /'((?:[^']|'')*)'|"([^"]*)"/g;
  let mm;
  while ((mm = re.exec(inner)) !== null) {
    if (mm[1] !== undefined)
      out.push(mm[1].replace(/''/g, "'")); // single-quoted: unescape ''
    else out.push(mm[2]); // double-quoted, verbatim
  }
  return out;
}

// The marker key / slug for a wiki page file — its basename without `.md`, lowercased.
// Shared by the subject loaders so path-side and prompt-side compute the SAME key for a
// page (the guarantee that lets them dedupe against each other in the shared root).
export function pageSlug(file) {
  return String(file).split(/[\\/]/).pop().replace(/\.md$/i, '').toLowerCase();
}

// The wiki-entity dirs the SUBJECT loaders own — platforms + inspectors + services, the
// pages that share the `subjects` marker root (CACHE_ROOTS.subjects, keyed by page slug).
// Both subject-wiki-loader (aliases → prompt) and path-wiki-loader (triggerPaths → file
// touch) scan EXACTLY these, so a page injected by one dedupes against the other.
// Chains/records are DELIBERATELY excluded: they have their own loaders keyed under
// separate roots (CACHE_ROOTS.chain / .record), so scanning them here would inject the same
// page under two different (root,key) spaces and double-fire (plan 1254 review). `repoRoot`
// is the caller's repo root (loader-common can't compute it — it lives one dir deeper than
// the hooks).
//
// This list is the SINGLE source of the loader scope: wiki-loader-coverage.test.mjs derives
// both its aliases-coverage set and its triggerPaths scope check from these `rel` values, so
// the scanner and the lint can never silently disagree (plan 2718 — services/ had been
// scanned by NOTHING, so its pages auto-injected nowhere).
export function subjectPageDirs(repoRoot) {
  return [
    { dir: join(repoRoot, 'wiki', 'entities', 'platforms'), rel: 'wiki/entities/platforms' },
    { dir: join(repoRoot, 'wiki', 'entities', 'inspectors'), rel: 'wiki/entities/inspectors' },
    { dir: join(repoRoot, 'wiki', 'entities', 'services'), rel: 'wiki/entities/services' },
  ];
}

// Scan the given wiki-entity dirs (each { dir, rel }) for *.md pages; return one record per
// page: { slug, file, rel, frontmatter, body }. readDir/readFile are injectable for tests.
// Fail-open: a missing dir contributes nothing; an unreadable page is skipped. The shared
// dir-scan + frontmatter-split boilerplate for subject-wiki-loader (reads `aliases:`) and
// path-wiki-loader (reads `triggerPaths:`), so a change to how pages are enumerated/parsed
// lands in ONE place (plan 1254 review). Bounded set (a few dozen platform + inspector +
// service pages, well under 100 KB total), so no disk cache — the cost is a handful of small
// reads, dwarfed by node startup. If subjectPageDirs ever grows a dir with hundreds of pages,
// revisit that: this runs on EVERY prompt (subject-wiki-loader) and every file touch
// (path-wiki-loader).
export function scanEntityPages(
  dirs,
  { readDir = readdirSync, readFile = (p) => readFileSync(p, 'utf8') } = {},
) {
  const out = [];
  for (const { dir, rel } of dirs) {
    let files;
    try {
      files = readDir(dir).filter((f) => /\.md$/i.test(String(f)));
    } catch {
      continue; // dir missing → skip (fail-open)
    }
    for (const file of files) {
      let text = '';
      try {
        text = readFile(join(dir, file));
      } catch {
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(text);
      out.push({
        slug: pageSlug(file),
        file,
        rel: `${rel}/${file}`,
        frontmatter,
        body: String(body).trimEnd(),
      });
    }
  }
  return out;
}

// ── Shared injection envelope ────────────────────────────────────────────────
// Write a hook output envelope to stdout — additionalContext is injected into the model
// context, systemMessage is the one-line note shown to the user, suppressOutput keeps the
// raw JSON out of the transcript. `hookEventName` defaults to 'UserPromptSubmit' (the four
// prompt loaders) but is a parameter so the PostToolUse path-wiki-loader can reuse this
// SAME envelope with 'PostToolUse' instead of hand-rolling its own copy — a future change
// to the envelope contract then lands in one place (plan 1254 review). (Covered by each
// loader's e2e spawn test, which JSON.parses this output.)
export function emitInjection(
  additionalContext,
  systemMessage,
  hookEventName = 'UserPromptSubmit',
) {
  process.stdout.write(
    JSON.stringify(injectionEnvelope(additionalContext, systemMessage, hookEventName)),
  );
}

// The envelope emitInjection writes, as DATA (plan 4238): a hook's `evaluateHook()`
// returns this object so an in-process dispatcher (pretool-dispatch.mjs /
// prompt-wiki-dispatch.mjs) can merge it with its siblings instead of each hook
// writing its own stdout. emitInjection above stays the CLI path and serialises
// exactly this object, so the two paths cannot drift.
export function injectionEnvelope(
  additionalContext,
  systemMessage,
  hookEventName = 'UserPromptSubmit',
) {
  return {
    hookSpecificOutput: { hookEventName, additionalContext },
    systemMessage,
    suppressOutput: true,
  };
}

// The PreToolUse deny envelope the guard hooks write, as data (plan 4238). Key
// order matches every guard's hand-written literal, so JSON.stringify of this
// object is byte-identical to what the guards printed before the fold.
export function denyEnvelope(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

// The shared CLI shell of a folded hook (plan 4238): read stdin once, fail OPEN
// on an empty or malformed payload, run the hook's own `evaluateHook(payload)`,
// and print whatever envelope it returns. Kept here so the eight guards and five
// loaders cannot drift apart in how they treat a bad payload.
export async function runHookCli(evaluateHook) {
  const raw = readStdin();
  if (!raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed → fail open
  }
  const out = await evaluateHook(payload);
  if (out) process.stdout.write(JSON.stringify(out));
}

// ── Shared JSONL streaming parser (plan 1754 F5) ─────────────────────────────
// Parse newline-delimited JSON, yielding one parsed entry per line — tolerant of both
// \n and \r\n line endings (matching every transcript this repo's tooling reads).
// Blank lines are skipped; a line that fails JSON.parse (a torn/partial line — the
// FIRST line of a tail-window read, or the LAST line of a read that lands mid-write)
// is silently skipped, never thrown. Mirrors `String(raw).split(/\r?\n/)` exactly,
// INCLUDING its final segment even when the file has no trailing newline yet (an
// end-of-file read whose last entry is complete JSON simply hasn't been
// newline-terminated) — a caller that must never re-count that same trailing segment
// across repeated calls (the bulk-fable tripwire's per-Stop incremental counter, F7)
// is responsible for bounding the input to a newline-terminated prefix BEFORE calling
// this, not this generator's job.
//
// A generator, not an array-builder: a caller streams over entries (tallying a count,
// scanning backward for the last human turn, …) without this shared primitive itself
// holding the whole parsed transcript in memory as an intermediate array —
// countMainThreadToolUse and lastAssistantText each used to duplicate this exact loop
// inline (plan 1754 F5). The REVERTED 1747 dedupe attempt instead materialized the
// whole transcript through a shared function that returned an array, regressing
// memory on a large transcript; this generator form is the redo.
export function* parseJsonlEntries(raw) {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue; // torn/partial jsonl line — skip
    }
  }
}

// ── Stop-hook helpers (plan 1153) ────────────────────────────────────────────
// The four loaders above are UserPromptSubmit hooks — they only see the USER's
// prompt. wiki-loaders-stop.mjs is their assistant-side twin: a Stop hook that
// fires the SAME match → fresh → inject path against the assistant's own message,
// so a subject Claude introduces (that the user never named) still loads its page.
// These two helpers are the Stop-side analogues of readStdin/emitInjection.

// ── Shared low-level byte-range reader (plan 1754 review [6]) ────────────────
// Read the raw bytes `[start, end)` of a file via an fd + readSync loop — the ONE
// byte-range IO primitive shared by readFileTail (below, a tail window from EOF) and
// bulk-fable-zero-dispatch-tripwire-stop.mjs's resume-from-offset read, which were two
// near-identical open/loop/close copies before this. Deliberately a THIN IO seam:
// returns a raw Buffer and does no decoding or line/parse work — that stays in the
// callers (the reverted 1747 over-abstraction pulled parsing into the shared layer;
// this does not).
//
//   start — byte offset from the file start; NEGATIVE start means "the last |start|
//           bytes" (a tail window, clamped to the file size — how readFileTail uses it).
//   end   — exclusive byte end, defaulting to (and clamped at) EOF. A caller that
//           ALREADY knows the file size passes it here and the primitive then performs
//           NO stat of its own (review [4]: the tripwire's cached tally stats the
//           transcript one line before reading — two stat() syscalls per Stop where one
//           suffices). Only a negative start or an unbounded end needs the size; a
//           non-negative start with a finite end reads directly, and a short read at
//           EOF truncates naturally (readSync returns 0 past EOF). A finite `end` is
//           trusted as the allocation bound — pass a real known size, not a guess.
//
// Returns an empty Buffer for an empty range (e.g. start already at/past EOF — nothing
// to read is not an error), or null on ANY IO error. Callers own their fail-open
// translation of null ('' for readFileTail, bail-out for the tripwire's cached tally).
// `statSize` is an injectable test seam pinning the stat-elision behavior.
export function readFileByteRange(
  path,
  start,
  end = Infinity,
  { statSize = (p) => statSync(p).size } = {},
) {
  let fd;
  try {
    let from = start;
    let to = end;
    if (start < 0 || !Number.isFinite(end)) {
      // Only these shapes need the file size (tail window / read-to-EOF).
      const size = statSize(path);
      from = start < 0 ? Math.max(0, size + start) : Math.min(start, size);
      to = Math.min(end, size);
    }
    const len = to - from;
    if (len <= 0) return Buffer.alloc(0);
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close */
      }
    }
  }
}

// Read the last `maxBytes` of a file (the transcript JSONL grows unbounded across a
// session, so reading it whole every turn is O(session length); the current turn lives
// in the tail). The first line of the window is then likely partial, which the
// JSON.parse torn-line tolerance in lastAssistantText drops. Returns '' on any error
// (fail-open — this wrapper owns the null→'' translation so lastAssistantText's
// observable behavior is unchanged). Not exported — an internal of lastAssistantText.
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
function readFileTail(path, maxBytes) {
  const buf = readFileByteRange(path, -maxBytes);
  return buf === null ? '' : buf.toString('utf8');
}

// Return the assistant's prose for the CURRENT turn from a Claude Code transcript
// (.jsonl): the {type:"text"} blocks from `type:"assistant"` entries AFTER the last
// genuine human turn. A human turn boundary = a `type:"user"` entry that carries text
// (an array with a {type:"text"} block, or a bare string content) — tool_result user
// entries have no text block, so they do NOT end the scan (the turn spans them). We
// walk newest→oldest and stop at the first human turn, so multi-step turns (text →
// tool_use → tool_result → more text) are captured whole.
//
// Ordering: each assistant entry's own text blocks are joined FORWARD (so a multi-block
// entry reads in the order Claude wrote it); only the ENTRY sequence is reversed back to
// chronological. (A flat reverse of all blocks would invert within-entry order.)
//
// By default reads only the tail of the file (the turn lives there); pass an explicit
// `readFile` (tests) to parse a whole in-memory transcript. Fail-open '' on any error —
// a Stop hook must never throw.
export function lastAssistantText(
  transcriptPath,
  { readFile = null, maxBytes = TRANSCRIPT_TAIL_BYTES } = {},
) {
  if (!transcriptPath) return '';
  let raw = '';
  if (readFile) {
    try {
      raw = readFile(transcriptPath);
    } catch {
      return '';
    }
  } else {
    raw = readFileTail(transcriptPath, maxBytes);
  }
  if (!raw) return '';
  // parseJsonlEntries (plan 1754 F5) — skips blank/torn lines identically to the loop
  // this replaced; the first line of a tail read is expected to torn-skip this way.
  const entries = [...parseJsonlEntries(raw)];
  const turns = []; // one forward-joined string per assistant entry, newest entry first
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const msg = e && e.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (e && e.type === 'assistant') {
      if (content) {
        const parts = [];
        for (const block of content) {
          if (block && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
        }
        if (parts.length) turns.push(parts.join('\n')); // forward within the entry
      }
      continue;
    }
    if (e && e.type === 'user') {
      const isHuman = content
        ? content.some((b) => b && b.type === 'text')
        : typeof (msg && msg.content) === 'string';
      if (isHuman) break; // reached the human prompt that opened this turn
      // else: a tool_result user entry — part of this turn, keep scanning past it
    }
  }
  return turns.reverse().join('\n'); // reverse ENTRY order only → chronological
}

// ── Relayed-agent turn guard (plan 1299) ─────────────────────────────────────
// A subagent report / teammate message is delivered to the main session through the
// SAME UserPromptSubmit channel as an operator-typed prompt: the harness wraps the
// WHOLE turn in a `<teammate-message>`/`<agent-message>` tag (the report's text does not
// arrive alongside separate operator prose — it IS the turn). Without this guard, a
// report's incidental mention of a chain/platform/record (e.g. a read-only review
// agent's report naming three platforms in passing) injects that subject's
// full canonical page though the session never asked for it (measured 2026-07-02: ~30 KB
// from three review-agent reports in one session).
//
// Anchored at the START of the (trimmed) text, NOT a substring-anywhere check (plan 1299
// review [1]): an operator prompt that merely DISCUSSES this guard — e.g. "why does
// <agent-message> get relayed weirdly" — legitimately contains the tag text as prose
// without being a relay, and a substring-anywhere match silently starved that prompt's
// own subject injection. Anchoring to the turn's start still catches every real relay
// (which wraps the whole turn from byte 0) while leaving ordinary prose that merely
// mentions the tag alone.
export function isRelayedAgentTurn(text) {
  return /^\s*<(?:teammate-message|agent-message)\b/i.test(String(text ?? ''));
}

// --- Headless guard for turn-REOPENING Stop hooks (plan 2785) ----------------
//
// A Stop hook's only context channel is `decision:"block"`, which REOPENS the turn
// and makes the model produce one MORE message. That is coherent only for an
// interactive session, where the reopened turn is just extra conversation.
//
// In a headless `claude -p` run the final assistant message IS the envelope's
// `result` — the whole point of the call. A reopen therefore REPLACES the caller's
// structured payload with whatever the reopened turn says (for the wiki stop-loader,
// its one-line "📎 reconciled — no corrections" epilogue), while the envelope still
// reports `subtype:"success"`, `is_error:false`. The caller is billed for a full run
// and gets nothing back. Measured 2026-08-03 from `scripts/gpt-review.mjs`'s Sonnet
// arm: 34 turns, $1.78, `result` = the epilogue alone. Re-measured 2026-08-04 as a
// controlled repro (plan 2785): 1 turn / $0.049 with the guard's condition absent vs
// 3 turns / $0.080 and a destroyed payload with it present.
//
// The discriminator is `CLAUDE_CODE_ENTRYPOINT`, verified empirically on this machine
// 2026-08-04 by dumping a Stop hook's env from both sides: an interactive session's
// hook sees `cli`; a `claude -p` child's hook sees `sdk-cli` — the child OVERWRITES the
// inherited parent value, so it is a property of the invocation, not of the ancestry.
// The Stop payload itself carries no such field (its keys are session_id,
// transcript_path, cwd, prompt_id, permission_mode, hook_event_name, stop_hook_active,
// last_assistant_message, background_tasks, session_crons).
//
// UNKNOWN values are treated as INTERACTIVE (not headless) on purpose: this guard only
// ever REMOVES an injection, so an unrecognised entrypoint must keep today's behaviour
// rather than silently switch the loaders off for a whole class of session.
//
// This is only for hooks that BLOCK. A Stop hook that emits nothing but a
// `systemMessage` (park-master-dirt-on-stop.sh, the FEATURES.md reminder,
// bulk-fable-zero-dispatch-tripwire-stop.mjs) cannot clobber a result and does not use
// this guard.
//
// Note the prompt-side (UserPromptSubmit) loaders are deliberately NOT gated: they
// inject via `additionalContext`, which prepends to the model's input and can never
// overwrite an answer.
// Matched as a PREFIX, not an exact set (review finding, 2026-08-04): the observed
// value is `sdk-cli`, and the sibling SDKs report `sdk-py`/`sdk-ts`, so the family is
// what identifies a print-mode invocation. A future `sdk-batch` would otherwise fall
// into the unknown-means-interactive branch and reopen the hole. The prefix stays
// narrow on purpose — it must never swallow `cli`.
const HEADLESS_ENTRYPOINT_RX = /^sdk(-|$)/;

export function isHeadlessInvocation(env = process.env) {
  return HEADLESS_ENTRYPOINT_RX.test(String(env?.CLAUDE_CODE_ENTRYPOINT ?? '').trim());
}

// Stop-hook output envelope: `decision:"block"` reopens the turn and feeds `reason`
// back to the model as context; `systemMessage` is the one-line user-facing note.
// (No suppressOutput — unlike UserPromptSubmit, a Stop hook's stdout is the decision
// payload, not transcript-echoed text.)
//
// The headless invariant is enforced HERE, not only in each caller (review finding,
// 2026-08-04): the emitter is the one place every reopen must pass through, so a future
// hook — or an alias, or a wrapper a source-scanning guard cannot see — is safe by
// construction rather than by remembering to check. Callers may still check first (the
// wiki stop-loader does) to skip the work entirely; this is the backstop, not a
// substitute for that.
export function emitStopBlock(reason, systemMessage) {
  if (isHeadlessInvocation()) return;
  process.stdout.write(JSON.stringify({ decision: 'block', reason, systemMessage }));
}
