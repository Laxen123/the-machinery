#!/usr/bin/env node
// scripts/hooks/wiki-markers-compact-reset.mjs — SessionStart hook, matcher "compact"
// (plan 1254).
//
// Closes the COMPACTION gap in the once-per-session wiki injection. The loaders inject a
// subject page at most once per session and record a marker file so a later mention won't
// re-inject. But when a long session is COMPACTED, the summary can drop the injected page
// while the marker file persists — so a later mention re-injects NOTHING, and the session
// ends up with neither the page nor a chance to get it back. This hook fires on the
// compaction event and deletes THIS session's marker dir under every loader cache root, so
// the next mention (or file touch) of a subject re-injects its page — restoring knowledge
// the compaction may have summarized away.
//
// Cost bound: worst case one extra injection per subject per compaction — acceptable by
// design (the alternative is permanently losing the page for the rest of the session).
//
// Belt-and-suspenders: also guards on `payload.source === 'compact'` internally, so a
// misconfigured matcher can't make it clear markers on an ordinary startup/resume. Fails
// OPEN + SILENT: bad/missing stdin or unparseable payload → do nothing, exit 0.
//
// run() is exported for unit tests; main() runs only when invoked directly.

import { fileURLToPath } from 'node:url';
import { readStdin, parseSessionId, clearAllRegisteredMarkers } from './lib/loader-common.mjs';

// Clear this session's markers IFF the payload is a genuine compaction event with a usable
// session id. Returns the list of dirs removed (empty when it declines / no session id).
// Uses clearAllRegisteredMarkers (not the wiki-only clearSessionMarkers) so a compaction
// also sweeps every OPT_IN_ROOTS registrant — currently the bulk-fable tripwire's marker
// (plan 1754 marker-lifecycle fold-in) — restoring the same "re-inject after compaction"
// guarantee to those hooks that the wiki loaders already have.
export function run(payload) {
  if (!payload || payload.source !== 'compact') return [];
  const sessionId = parseSessionId(payload);
  if (!sessionId) return [];
  return clearAllRegisteredMarkers(sessionId);
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
  const cleared = run(payload);
  if (cleared.length === 0) return; // nothing reset → empty stdout

  // systemMessage only (no additionalContext): a SessionStart hook's stdout would be added
  // to context, so we keep the JSON to a user-facing note + suppressOutput and inject nothing.
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        '♻️ wiki loaders: cleared this session’s injection markers after compaction (subjects can re-inject)',
      suppressOutput: true,
    }),
  );
}

// Run main() only when invoked directly, so importing for tests never reads stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a SessionStart hook must never break the session
  }
  process.exit(0);
}
