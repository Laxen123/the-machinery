// scripts/index.mjs
// Atomic owner of docs/INDEX.md's Plans active-section mutations. One
// invocation = one read→mutate→commit(pathspec docs/INDEX.md, HUSKY=0)→push→
// retry cycle from $MAIN on master. Mirrors board.mjs (plan-205). Removes the
// last hand-edited shared coordination file (plan-206).
//
// Usage (caller composes the rich blurb/note; index.mjs only places it):
//   node scripts/index.mjs add  "<full bullet line incl. - 🟥/🟩 … and the `path` token>"
//   node scripts/index.mjs move <plan-basename> <new-subfolder-relpath>   # repath the active bullet
//   node scripts/index.mjs archive <plan-basename> --note "archived YYYY-MM-DD (session N), merged `sha`."
//   node scripts/index.mjs remove <plan-basename>
//   node scripts/index.mjs get  <plan-basename>     # read-only, prints the active bullet
//   node scripts/index.mjs list                     # read-only, prints all active bullets
//   node scripts/index.mjs condense-archive          # rewrite existing spine-shaped archive
//                                                     # rows to the prefix-only shape (plan 3971);
//                                                     # idempotent, no positional argument

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveMain, coordWrite, withCoordCheckout, git } from './coord/coord-git.mjs';
import {
  addBullet,
  removeBullet,
  repathBullet,
  archiveBullet,
  assertGeneratedRegionCanonical,
  findBulletIndexBySlug,
  ACTIVE_END_RX,
  condenseArchiveRows,
} from './coord/index-lib.mjs';
import { PLAN_TAG_SOURCE } from './coord/build-index-lib.mjs';

const MUTATING = new Set(['add', 'move', 'archive', 'remove', 'condense-archive']);

export function buildMessage(cmd, key) {
  return {
    add: `docs(plans): index add ${key}`,
    move: `docs(plans): index move/repath ${key}`,
    archive: `docs(plans): index archive ${key}`,
    remove: `docs(plans): index remove ${key}`,
    'condense-archive': `docs(plans): index condense-archive`,
  }[cmd];
}

async function main() {
  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  if (!cmd) {
    console.error('index: no command');
    return 2;
  }
  const mainDir = resolveMain();
  const indexPath = join(mainDir, 'docs', 'INDEX.md');
  if (!existsSync(indexPath)) throw new Error('index: docs/INDEX.md not found at main worktree');

  // Read-only commands
  if (cmd === 'list' || cmd === 'get') {
    const lines = readFileSync(indexPath, 'utf8').split('\n');
    const end = lines.findIndex((l) => ACTIVE_END_RX.test(l));
    const active = lines
      .slice(0, end === -1 ? lines.length : end)
      .filter((l) => /^- (⚡?(?:🟥|🟩)) /.test(l)); // ⚡ = plan-2328 priority prefix
    if (cmd === 'list') {
      active.forEach((l) => console.log(l));
      return 0;
    }
    const idx = findBulletIndexBySlug(lines, positionals[0]);
    if (idx === -1) {
      console.error(`index: no active bullet for "${positionals[0]}"`);
      return 1;
    }
    console.log(lines[idx]);
    return 0;
  }

  if (!MUTATING.has(cmd)) {
    console.error(`index: unknown command "${cmd}"`);
    return 2;
  }

  // key for the commit message + the producer's mutation argument.
  // condense-archive takes no positional — it acts on the whole archive region, so its
  // "key" is the literal 'archive-region' (always truthy, skipping the check below).
  const key =
    cmd === 'condense-archive'
      ? 'archive-region'
      : cmd === 'add'
        ? slugFromBullet(positionals[0])
        : positionals[0];
  if (!key) {
    console.error(`index: "${cmd}" needs ${cmd === 'add' ? 'a bullet line' : 'a plan basename'}`);
    return 2;
  }

  // plan 3971 review r1 (C): the count is captured from INSIDE the coordWrite mutate closure
  // below — the authoritative transform, run against the freshly fetched/merged checkout
  // content — never from a pre-read taken before coordWrite freshens `cdir` (a pre-read could
  // disagree with what actually gets committed under a concurrent writer).
  let condenseCount = 0;

  // Pure transform: freshest INDEX text → mutated text. Runs inside coordWrite's
  // mutate AFTER the fresh-base merge, so the bullet edit always applies against
  // the current INDEX (idempotent on a non-ff retry). `cdir` is only used by
  // condense-archive, to resolve the archivedFiles set from the SAME freshened checkout.
  const buildContent = (content, cdir) => {
    if (cmd === 'add') return addBullet(content, positionals[0]);
    if (cmd === 'remove') return removeBullet(content, key);
    if (cmd === 'move') return repathBullet(content, key, positionals[1]);
    if (cmd === 'archive') return archiveBullet(content, key, flags.note || '');
    if (cmd === 'condense-archive') {
      // plan 3971 review r1 (B): never condense a spine-shaped row whose archived plan file
      // isn't actually tracked — that row is its only surviving record. Direct children of
      // docs/superpowers/plans/archive/ only (a nested batch-archive path is not a plan file).
      const archivePrefix = 'docs/superpowers/plans/archive/';
      const archivedFiles = new Set(
        git(cdir, ['ls-files', archivePrefix])
          .split('\n')
          .map((p) => p.trim())
          .filter(Boolean)
          .filter((p) => !p.slice(archivePrefix.length).includes('/'))
          .map((p) => p.slice(archivePrefix.length)),
      );
      const { content: next, rewritten } = condenseArchiveRows(content, { archivedFiles });
      condenseCount = rewritten;
      return next;
    }
  };

  // ONE sanctioned write path: coordWrite freshens, re-runs mutate, commits
  // docs/INDEX.md by pathspec with a `Coord-Write: index` trailer, and silently
  // (jittered) rebase-retries on non-ff. (plan 421)
  // plan 989: build the INDEX write in the DISPOSABLE coord-checkout (under the coord-write lock),
  // never the shared MAIN tree. Recompute the INDEX path from `cdir`.
  withCoordCheckout(mainDir, (cdir) => {
    const cIndexPath = join(cdir, 'docs', 'INDEX.md');
    coordWrite(cdir, {
      relPaths: ['docs/INDEX.md'],
      mutate: () => {
        const next = buildContent(readFileSync(cIndexPath, 'utf8'), cdir);
        // Refuse to commit a non-canonical INDEX generated region (plan 475).
        assertGeneratedRegionCanonical(next);
        writeFileSync(cIndexPath, next);
      },
      message: buildMessage(cmd, key),
      tool: 'index',
    });
  });
  if (cmd === 'condense-archive') {
    console.log(`index: condense-archive — rewrote ${condenseCount} row(s), committed + pushed`);
  } else {
    console.log(`index: ${cmd} ${key} — committed + pushed`);
  }
  return 0;
}

// Tag shape derived from build-index-lib's PLAN_TAG_SOURCE (plan 1945) — was a
// hand-typed copy of the same literal (also duplicated in index-lib.mjs's slugOf)
// until this fold.
const SLUG_BULLET_TOKEN_RX = new RegExp('`([^`]*' + PLAN_TAG_SOURCE + '[^`]*\\.md)`', 'g');

function slugFromBullet(bullet) {
  if (!bullet) return null;
  const m = [...bullet.matchAll(SLUG_BULLET_TOKEN_RX)].pop();
  return m ? m[1].split('/').pop() : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('index:', e.message);
      process.exit(2);
    },
  );
}
