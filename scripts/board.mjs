// scripts/board.mjs
// Atomic owner of handoff-board.md mutations. One invocation = one
// read→mutate-one-row→stage-one-file→commit→push→retry cycle, run from the
// resolved main worktree ($MAIN) on master. Eliminates the held-edit window
// that caused the shared-index race class (see plan 205 / spec 2026-05-28).
//
// Usage:
//   node scripts/board.mjs claim <slug> --state ACTIVE --plan-claim "<cell text>" --touched "<date>" [--tip <sha>] [--resume "<text>"]
//   node scripts/board.mjs set-state <slug> <STATE|alias>
//   node scripts/board.mjs update <slug> [--tip <sha>] [--plan-claim "<text>"] [--touched "<date>"] [--resume "<text>"] [--state <STATE>]
//   node scripts/board.mjs remove <slug> [<slug>...]   # multi-slug: ONE commit, tolerant of any subset already absent (plan 1364 Ship 3)
//   node scripts/board.mjs get <slug>            # read-only, prints the row
//   node scripts/board.mjs list                  # read-only, prints all rows
//   node scripts/board.mjs landing-held [--except <slug>]   # exit 0 if a 🟢 LANDING row exists
//   node scripts/board.mjs landing-age <slug>    # read-only: minutes since the LANDING claim (exit 0); non-LANDING → exit 1
//   node scripts/board.mjs set-state <slug> LANDING [--landing-at <iso>]   # stamps the claim time (default: now)
//
// The CALLER composes rich cell prose (plan-claim / resume); board.mjs only places it.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseArgs,
  resolveMain,
  coordWrite,
  withCoordCheckout,
  readTrackedFileFresh,
} from './coord/coord-git.mjs';
import { loadCoordConfig } from './coord/coord-config.mjs';
import {
  setRowState,
  updateRow,
  upsertRow,
  removeRow,
  removeRows,
  splitBoard,
  findRowLineIndex,
  landingRows,
  stampLanding,
  landingInfo,
  LANDING_STATE,
  PAUSED_STATE,
  IN_PROGRESS_STATE,
  DONE_ON_BRANCH_STATE,
  SUPERSEDED_STATE,
} from './coord/board-lib.mjs';

export { parseArgs, withRetry } from './coord/coord-git.mjs';
import { planBasenameMap, validateRowInContent } from './coord/lint-board.mjs';

export const STATE_ALIASES = {
  ACTIVE: '🔄 ACTIVE',
  LANDING: LANDING_STATE,
  // plan 2394: from board-lib, not a literal — `claim-plan acquire --resume` now writes this
  // same demote state directly into its projection commit, so the two writers must agree
  // byte-for-byte on the rendered string.
  PAUSED: PAUSED_STATE,
  // plan 3814 review fix (F1): these three used to be inline literals — a hand-copied third
  // (fourth, fifth) definition of a rendered board-state string alongside board-lib.mjs's own
  // ACTIVE_STATE/PAUSED_STATE/LANDING_STATE, and the exact drift class those constants exist
  // to prevent. Pure de-duplication: byte-identical rendered strings, no behaviour change.
  'IN-PROGRESS': IN_PROGRESS_STATE,
  'DONE-ON-BRANCH': DONE_ON_BRANCH_STATE,
  SUPERSEDED: SUPERSEDED_STATE,
};

const MUTATING = new Set(['claim', 'set-state', 'update', 'remove']);
const READONLY = new Set(['get', 'list', 'landing-held', 'landing-age']);

// Command registry — the ONE place all 8 dispatched commands are named,
// DERIVED from MUTATING + READONLY (review 2026-07-19: a hand-maintained
// third list can drift from the two sets that actually gate dispatch below —
// deriving it structurally guarantees it can't). Both CLI error messages in
// main() derive from it (plan 2066: `board: no command` and `board: unknown
// command "<cmd>"` previously named ZERO of the 8 commands — same defect
// class plan 2061 fixed in landing-queue.mjs). Not a full registration-IS-
// dispatch registry like landing-queue.mjs's final shape — board.mjs's
// mutating commands share one buildContent/coordWrite path that a per-command
// `run` function would fragment for no benefit — so MUTATING/READONLY still
// own actual dispatch; the bottom `!MUTATING.has` check is kept as a
// COMMANDS-vs-dispatcher drift guard rather than removed.
const COMMANDS = new Set([...MUTATING, ...READONLY]);

// Write-time Plan/claim cell lint (plan 511). Only the commands that SET the
// cell are linted — `claim` (always; an empty cell is exactly the plan-479
// incident class) and `update` with an explicit --plan-claim. set-state /
// remove / update-without-the-flag don't touch the cell and must not be blocked
// by someone else's pre-existing poison (the push-time full-board lint owns
// that). BOARD_LINT_SKIP=1 is the emergency bypass (validateRows bug blocking
// all claims) — the push-time lint still gates.
export function shouldLintCell(cmd, flags, env) {
  if (env.BOARD_LINT_SKIP === '1') return false;
  return cmd === 'claim' || (cmd === 'update' && flags['plan-claim'] !== undefined);
}

// Throws when the just-built board text carries a lint-poisoned row for `slug`
// — BEFORE the caller writes/commits it, so the poison never reaches siblings.
export function assertCellLintClean(built, slug, byBasename) {
  const errors = validateRowInContent(built, slug, byBasename);
  if (errors.length === 0) return;
  const detail = errors.map((e) => `[${e.kind}] ${e.hint}`).join('\n  ');
  throw new Error(
    `refusing to write a lint-poisoned "Plan / claim" cell for ${slug} ` +
      `(it would block every sibling push at lint-board):\n  ${detail}\n` +
      `Cell contract: include \`<status-dir>/NNN-….md\` matching where the plan file actually lives — ` +
      `move it first via move-plan.mjs, or annotate "(moving to <dir>/)". ` +
      `Emergency bypass: BOARD_LINT_SKIP=1 (the push-time full-board lint still gates).`,
  );
}

async function main() {
  const { cmd, positionals, flags } = parseArgs(process.argv.slice(2));
  const validCmds = [...COMMANDS].join('|');
  if (!cmd) {
    console.error(`board: no command (${validCmds})`);
    return 2;
  }
  if (!COMMANDS.has(cmd)) {
    console.error(`board: unknown command "${cmd}" (valid: ${validCmds})`);
    return 2;
  }

  const mainDir = resolveMain();
  const { paths } = loadCoordConfig(mainDir);
  const boardPath = join(mainDir, paths.boardFile);
  if (!existsSync(boardPath))
    throw new Error(`board: ${paths.boardFile} not found at main worktree`);

  const slug = positionals[0];
  // plan 1364 Ship 3: `remove` alone accepts N slugs (a batch close-out's one-commit
  // multi-row removal). Every other mutating command stays single-slug (`positionals[0]`
  // is still `slug`, unchanged) — this array is only consulted by the `remove` branches below.
  const removeSlugs = cmd === 'remove' ? positionals.filter(Boolean) : null;

  // Read-only commands first (no commit).
  if (READONLY.has(cmd)) {
    // plan 989: MAIN's working-tree board.md is NO LONGER freshened by coord writes (they land in the
    // disposable coord-checkout now), so it drifts behind origin. The LANDING-mutex probes
    // (landing-held / landing-age) MUST read the AUTHORITATIVE origin/master copy — a stale MAIN read
    // could miss a sibling's 🟢 LANDING row and let a 🟥 seed land concurrently (the very seed-clobber
    // the mutex exists to prevent). list/get are display-only → the local copy is fine (no fetch).
    const mutexRead = cmd === 'landing-held' || cmd === 'landing-age';
    // plan 989: the mutex probes read the AUTHORITATIVE origin/master board (fetch + git show,
    // local fallback — coord-git's readTrackedFileFresh, extracted from here by plan 1312/F-003)
    // because MAIN's board.md is no longer kept fresh by coord writes.
    const content = mutexRead
      ? readTrackedFileFresh(mainDir, paths.boardFile, boardPath)
      : readFileSync(boardPath, 'utf8');
    const { body } = splitBoard(content);
    if (cmd === 'landing-age') {
      // Minutes since this row claimed LANDING (stamped via set-state … --landing-at).
      // Non-LANDING (or absent) row → exit 1. LANDING row with no stamp → "unknown"
      // exit 0; consumers treat an unknown age as STALE (can't prove healthy).
      const info = landingInfo(content, slug, Date.now());
      if (!info.landing) return 1;
      console.log(info.ageMin == null ? 'unknown' : String(info.ageMin));
      return 0;
    }
    if (cmd === 'landing-held') {
      // Column-aware (board-lib.landingRows): a substring scan would false-match
      // "🟢 LANDING" inside another row's resume prose and deadlock the mutex.
      const held = landingRows(body, flags.except);
      held.forEach((l) => console.log(l.trim()));
      return held.length > 0 ? 0 : 1; // exit 0 if a LANDING row is held
    }
    if (cmd === 'get') {
      const lines = body.split('\n');
      const idx = findRowLineIndex(lines, slug);
      if (idx === -1) {
        console.error(`board: no row for "${slug}"`);
        return 1;
      }
      console.log(lines[idx].trim());
      return 0;
    }
    console.log(body.trim()); // list
    return 0;
  }

  // Unreachable in normal operation — cmd is already validated against
  // COMMANDS above. Kept as a drift guard: if COMMANDS and MUTATING (or the
  // read-only dispatch above) ever diverge, this still fails closed instead
  // of falling through into mutating-only code with an unhandled cmd.
  if (!MUTATING.has(cmd)) {
    console.error(`board: unknown command "${cmd}" (valid: ${validCmds})`);
    return 2;
  }
  if (!slug) {
    console.error(`board: "${cmd}" needs a <slug>`);
    return 2;
  }

  const resolveState = (s) => (s ? STATE_ALIASES[s] || s : undefined);

  // Defaults computed ONCE (not per-mutate) so a fresh-base coordWrite retry
  // re-applies the SAME row content rather than re-stamping a drifting date/time.
  const touchedDefault = flags.touched || new Date().toISOString().slice(0, 10);
  const landingAtDefault = flags['landing-at'] || new Date().toISOString();

  // Pure transform: given the freshest board text, return the mutated text. Runs
  // inside coordWrite's mutate AFTER the fresh-base merge, so it always rebuilds
  // its one row against the current board (idempotent on retry).
  const buildContent = (content) => {
    if (cmd === 'set-state') {
      const target = resolveState(positionals[1]);
      // F-018 (plan 1313 coord audit): a `set-state` DEMOTE/teardown transition tolerates an
      // already-absent row — a sibling's concurrent close-out removing it first is a benign race
      // (drain-run/done-worktree already swallow this exact "row not found" throw at 4 call sites;
      // a bare manual CLI invocation, a documented op step, used to hard-fail exit 2 instead). A
      // tolerant no-op leaves `content` unchanged, which coordWrite's own "nothing staged"
      // short-circuit reports as a clean `{noop:true}` — never a phantom commit.
      //
      // A transition INTO LANDING is the OPPOSITE semantic: it CLAIMS the scoped cross-session
      // land signal. done-worktree stamps it via coordStep right before merging and, in the
      // default (non-`--wait`) mode, that step's throw is DESIGNED to propagate and abort the land
      // (plan 810 sets landingClaimed BEFORE this step so the finally still frees the seed mutex on
      // such a throw). Silently tolerating an absent row here would drop the 🟢 LANDING marker a
      // sibling's overlapping-shard preflight (landingRows) checks, letting a conflicting 🟥 land
      // start unseen (review 2026-07-04). So the LANDING stamp stays STRICT — throws if the row is
      // gone. The stamp also records the claim time (default now) for the next waiter's staleness
      // math (landing-age); --landing-at overrides.
      if (target === LANDING_STATE) return stampLanding(content, slug, landingAtDefault);
      return setRowState(content, slug, target, { tolerateAbsent: true });
    }
    if (cmd === 'remove') {
      // plan 1364 Ship 3: N slugs → removeRows (tolerant multi-remove, ONE commit).
      // Exactly 1 slug now ALSO tolerates absence (F-018 — mirrors dequeueEntry's idempotent
      // no-op contract; the multi-slug path below already never throws).
      if (removeSlugs.length > 1) return removeRows(content, removeSlugs).content;
      return removeRow(content, slug, { tolerateAbsent: true });
    }
    if (cmd === 'update') {
      return updateRow(content, slug, {
        tip: flags.tip,
        planClaim: flags['plan-claim'],
        touched: flags.touched,
        resume: flags.resume,
        state: resolveState(flags.state),
      });
    }
    // claim
    const state = resolveState(flags.state) || '🔄 ACTIVE';
    const built = upsertRow(content, {
      slug,
      tip: flags.tip || '`PENDING`',
      state,
      planClaim: flags['plan-claim'] || '',
      touched: touchedDefault,
      resume: flags.resume || '—',
    });
    // Claiming straight into LANDING (rare) still stamps the claim time.
    if (state === LANDING_STATE) return stampLanding(built, slug, landingAtDefault);
    return built;
  };

  const msg = {
    claim: `chore(handoff): claim ${slug} on board`,
    'set-state': `chore(handoff): set ${slug} → ${resolveState(positionals[1])}`,
    update: `chore(handoff): update ${slug} board row`,
    remove:
      removeSlugs && removeSlugs.length > 1
        ? `chore(handoff): remove batch rows (${removeSlugs.join(', ')}) from board`
        : `chore(handoff): remove ${slug} from board`,
  }[cmd];

  // Write-time cell lint (plan 511): runs INSIDE mutate, between build and
  // write, so every coordWrite fresh-base retry re-validates against the
  // freshened plan tree (a sibling may have moved/archived the plan mid-retry)
  // and a poisoned cell throws BEFORE anything is written or committed.
  const lintCell = shouldLintCell(cmd, flags, process.env);
  // Warn only when the bypass actually suppresses a lint that would have run
  // (shouldLintCell minus the env): a skip-flagged `update --tip` would
  // otherwise warn about a lint that never applies to it.
  if (!lintCell && shouldLintCell(cmd, flags, {})) {
    console.error(
      `board: WARNING — BOARD_LINT_SKIP=1, skipping the write-time Plan/claim cell lint for ${slug}. ` +
        `The push-time full-board lint still gates.`,
    );
  }

  // ONE sanctioned write path: coordWrite freshens onto origin, re-runs mutate,
  // commits handoff-board.md by pathspec with a `Coord-Write: board` trailer,
  // and silently rebase-retries (jittered) on non-ff. (plan 421)
  // plan 989: run the board write against the DISPOSABLE coord-checkout (under the coord-write
  // lock), never the shared MAIN tree — so a sibling's transient dirt / our own uncommitted code
  // can't block it, and a partial failure strands zero residue. All paths recompute from `cdir`.
  // plan 1508 (belt-and-suspenders audit): coordWrite's push try/catch ONLY tolerates a
  // non-fast-forward rejection (silently undoes + retries) — every other push failure (auth,
  // network, hook, an unreachable remote) is rethrown as-is, all the way out of withCoordCheckout
  // / withCoordLock (neither catches — see their own comments) to this function's caller in
  // main(), whose top-level `.then(success, failure)` logs the message and `process.exit(2)`.
  // A CALLER that shells out to this CLI (done-worktree's `node()` → execFileSync) therefore
  // already sees that exit code as a thrown error — the log line below is reached ONLY on an
  // already-confirmed-pushed (or genuinely no-op) result, never a swallowed failure.
  // plan 2393 lever 1: pass the lock handle through so coordWrite hands the coord lock back after
  // its commit and spends the push + verify round-trips unserialized. Safe here because coordWrite
  // is this callback's LAST mutation of the coord-checkout — only console output follows.
  const result = withCoordCheckout(
    mainDir,
    (cdir, lockCtx) => {
      const cBoardPath = join(cdir, paths.boardFile);
      return coordWrite(cdir, {
        lockCtx,
        relPaths: [paths.boardFile],
        mutate: () => {
          const built = buildContent(readFileSync(cBoardPath, 'utf8'));
          if (lintCell) {
            const byBasename = planBasenameMap(join(cdir, 'docs', 'superpowers', 'plans'));
            assertCellLintClean(built, slug, byBasename);
          }
          writeFileSync(cBoardPath, built);
        },
        message: msg,
        tool: 'board',
      });
    },
    // plan 2519: label withCoordLock's OWN journal entries as `board` too — coordWrite's
    // `tool: 'board'` above only tags coordWrite's internal bookkeeping; the outer
    // withCoordCheckout → withCoordLock journal (start/release/done) reads `lockOpts.tool`
    // independently and defaulted to the generic `coord` label without this.
    { tool: 'board' },
  );
  const cmdLabel = removeSlugs && removeSlugs.length > 1 ? removeSlugs.join(', ') : slug;
  // F-018: a tolerant remove/set-state on an already-absent row produces IDENTICAL content, so
  // coordWrite's own no-op short-circuit fires (`{noop:true}`) — report that accurately instead
  // of the misleading "committed + pushed" (nothing was committed).
  if (result?.noop) {
    console.log(`board: ${cmd} ${cmdLabel} — already absent, no-op (idempotent)`);
  } else {
    console.log(`board: ${cmd} ${cmdLabel} — committed + pushed`);
  }
  return 0;
}

// Only run main() when invoked as a CLI (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('board:', e.message);
      process.exit(2);
    },
  );
}
