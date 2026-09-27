#!/usr/bin/env node
// scripts/ensure-wiki-merge-driver.mjs (plan 1528 A2)
// Idempotently register the wiki `updated:`-line merge driver for THIS repo. Merge
// drivers aren't versionable (git ignores a committed .gitattributes driver without a
// matching config entry, and config never travels with a clone), so registration rides
// the existing setup path: package.json `prepare` (husky) runs this on every
// `pnpm install`, in any checkout.
//
// BOTH halves are written to the SHARED .git side, deliberately paired:
//   - merge.wiki-updated.driver           → .git/config (shared by ALL worktrees of this
//     repo — the main checkout, plan worktrees, the coord checkout, and the ephemeral
//     land/finish worktrees all merge with it once ONE checkout ran pnpm install)
//   - `wiki/**/*.md merge=wiki-updated`   → .git/info/attributes (UNVERSIONED — putting
//     it in a committed .gitattributes instead would name a driver that fresh clones
//     haven't configured; keeping attribute+config together means an unregistered clone
//     has NEITHER and cleanly falls back to the default text merge)
//
// Never fails the install: any error (not a git repo, git absent, read-only .git) prints
// a note and exits 0 — merges then simply behave as before plan 1528.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';

const DRIVER_CMD = 'node scripts/coord/wiki-updated-merge-driver.mjs %O %A %B';
const ATTR_LINE = 'wiki/**/*.md merge=wiki-updated';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

try {
  // The COMMON dir (not --git-dir): a worktree's git-dir is .git/worktrees/<name>, but
  // config + info/attributes live in the shared common dir.
  let commonDir = git(['rev-parse', '--git-common-dir']);
  if (!isAbsolute(commonDir)) commonDir = resolve(process.cwd(), commonDir);

  let current = null;
  try {
    current = git(['config', 'merge.wiki-updated.driver']);
  } catch {
    /* unset */
  }
  if (current !== DRIVER_CMD) {
    git(['config', 'merge.wiki-updated.driver', DRIVER_CMD]);
  }

  const infoDir = join(commonDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const attrPath = join(infoDir, 'attributes');
  const existing = existsSync(attrPath) ? readFileSync(attrPath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes(ATTR_LINE)) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(attrPath, `${existing}${sep}${ATTR_LINE}\n`);
  }
  console.log(
    'ensure-wiki-merge-driver: wiki updated:-line merge driver registered (shared .git config + info/attributes, plan 1528)',
  );
} catch (e) {
  console.error(
    `ensure-wiki-merge-driver: skipped (${e.message?.split('\n')[0] ?? e}) — merges keep default behavior`,
  );
}
process.exit(0);
