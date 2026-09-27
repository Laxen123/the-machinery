#!/usr/bin/env node
// scripts/build-handoff.mjs
// Render the "Recent sessions" thin index in handoff.md from the per-session
// entry files in handoff/sessions/ (plan 249, Task 3).
//
// This is an ON-DEMAND materializer, NOT part of the per-session write path:
// the `handoff` skill still just creates handoff/sessions/<date>-session-N.md
// (contention-free, plan 205). Run this when you want handoff.md's top index
// refreshed to reflect the current set of session entries. The frozen pre-split
// history below the sentinels and the pointer header above them are untouched.
//
// Usage:
//   node scripts/build-handoff.mjs           # rewrite handoff.md's recent index
//   node scripts/build-handoff.mjs --check    # exit 1 if the index is stale
//   node scripts/build-handoff.mjs --print    # write regenerated handoff.md to stdout

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCoordConfig } from './coord/coord-config.mjs';
import {
  sortSessionsNewestFirst,
  entryHeading,
  entryStatus,
  renderRecentBlock,
  spliceRecentBlock,
} from './coord/build-handoff-lib.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = loadCoordConfig(REPO_ROOT);
const SESSIONS_DIR = join(REPO_ROOT, CFG.paths.sessionsDir);
const HANDOFF_PATH = join(REPO_ROOT, CFG.paths.rollingHandoffFile);
// The sessions dir RELATIVE to the rolling-handoff file's dir, for the index links
// (plan 857): legacy → 'handoff/sessions'; one-tree → 'sessions'.
const SESSIONS_LINK_PREFIX = relative(
  dirname(CFG.paths.rollingHandoffFile),
  CFG.paths.sessionsDir,
).replace(/\\/g, '/');

export function collectEntries() {
  const names = sortSessionsNewestFirst(readdirSync(SESSIONS_DIR));
  return names.map((name) => {
    const content = readFileSync(join(SESSIONS_DIR, name), 'utf8');
    return { name, heading: entryHeading(content), status: entryStatus(content) };
  });
}

function main() {
  const args = process.argv.slice(2);
  if (CFG.handoffLayout === 'single') {
    console.log('build-handoff: single-handoff layout — no per-session index to build, skipping.');
    return 0;
  }
  const entries = collectEntries();
  const block = renderRecentBlock(entries, SESSIONS_LINK_PREFIX);
  const current = readFileSync(HANDOFF_PATH, 'utf8');
  const next = spliceRecentBlock(current, block);

  if (args.includes('--print')) {
    process.stdout.write(next);
    return 0;
  }
  const rolling = CFG.paths.rollingHandoffFile;
  if (args.includes('--check')) {
    if (next !== current) {
      console.error(
        `build-handoff: ${rolling} recent index is STALE — run \`node scripts/build-handoff.mjs\`.`,
      );
      return 1;
    }
    console.log(`build-handoff: ${rolling} recent index up to date (${entries.length} sessions).`);
    return 0;
  }
  if (next !== current) {
    writeFileSync(HANDOFF_PATH, next);
    console.log(
      `build-handoff: refreshed ${rolling} recent index (${entries.length} sessions, newest first).`,
    );
  } else {
    console.log(
      `build-handoff: ${rolling} recent index already current (${entries.length} sessions).`,
    );
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
