#!/usr/bin/env node
// scripts/exec-model-default.mjs — read or flip THE executor-lane default (plan 3656).
//
//   node scripts/exec-model-default.mjs                    # print the current lane + its ruling
//   node scripts/exec-model-default.mjs show               # same
//   node scripts/exec-model-default.mjs set sol --reason "I want Sol as the default again."
//
// `set` rewrites scripts/exec-model-default.json and stops. It deliberately does NOT
// commit, push, or touch git: this is a CONFIG file, so the flip is review-exempt and
// lands like any other config edit — the caller commits it. Keeping git out of here also
// keeps the tool runnable from a worktree, a coord checkout, or a cloud sandbox without
// caring which.
//
// The `--reason` is the OPERATOR'S VERBATIM WORDS, not a paraphrase. It is stored beside
// the value so the ruling and the thing it rules live in one file — the failure this
// repo keeps hitting is a decision recorded only in chat, then lost to compaction
// (98 Hobby CLAUDE.md § "Operator rulings land in committed text the SAME TURN").

import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteTextSync } from './coord/atomic-write.mjs';
import { parseFlags } from './coord/parse-flags.mjs';
import {
  assertExecModelDefaultShape,
  EXEC_MODEL_DEFAULT_PATH,
  KNOWN_EXEC_LANES,
  readExecModelDefault,
} from './coord/exec-model-default-lib.mjs';

// The printed commit hint's paths, both DERIVED from the one canonical constant so the
// toggle's location is never spelled out twice (gpt-review key 96092e).
//
// Two review rounds pulled this in opposite directions and the resolution is to satisfy
// both: a bare absolute path is machine-specific and breaks unquoted on a path with a
// space (keys 19b7f8 / b7f260), while a bare relative path silently resolves against
// whatever directory the operator happens to be in (keys 1866d0 / 8c7bd5 / 46d9a0 /
// 96b801). So the hint prints `git -C "<abs repo root>" add <repo-relative path>` — this
// repo's standard shape, quoted, and correct from any cwd.
const TOGGLE_REPO_ROOT = dirname(dirname(EXEC_MODEL_DEFAULT_PATH));
const TOGGLE_REL_PATH = `scripts/${basename(EXEC_MODEL_DEFAULT_PATH)}`;

const USAGE =
  'usage: exec-model-default.mjs [show]\n' +
  `       exec-model-default.mjs set <${KNOWN_EXEC_LANES.join('|')}> --reason "<operator verbatim>" [--repair]`;

/**
 * The file's rendered form. Written by hand rather than via a bare JSON.stringify so the
 * `$comment` lead line — which is what a human opening the file reads first — keeps a
 * stable position and wording across every flip, making the diff of a flip exactly the
 * three lines that changed.
 */
export function renderExecModelDefault({ defaultLane, since, ruling }) {
  const body = {
    $comment:
      'THE executor-lane default toggle (plan 3656). Flip it with `node ' +
      'scripts/exec-model-default.mjs set <lane> --reason "<operator verbatim>"`, then ' +
      'commit. This file is CONFIG, so a flip is review-exempt: no plan, no worktree, no ' +
      'code review. Nothing else in the repo may restate the value — prose surfaces point HERE.',
    defaultLane,
    since,
    ruling,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** `YYYY-MM-DD` in UTC — the date convention every plan/runbook stamp in this repo uses. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Write the toggle. Exported so the test suite can exercise the REAL write path against a
 * temp path (gpt-review key 5b8939: the first cut tested only the refusal branches and the
 * same-lane no-op, so `writeFileSync` itself was never covered).
 *
 * Atomic (gpt-review keys c25196 / 5b4cfc / 464f69 / 2d1ba9): the reader is deliberately
 * fail-closed on malformed JSON, and this file is read by every plan write across ~5-7
 * parallel sessions, so a torn in-place truncating write would hard-fail every one of them
 * until someone noticed. `atomicWriteTextSync` is the repo's existing write-temp-then-rename
 * helper, so a reader sees either the old file or the new one, never half of either.
 */
export function writeExecModelDefault(
  { defaultLane, since, ruling },
  path = EXEC_MODEL_DEFAULT_PATH,
) {
  // Validate with the READER's own predicate before persisting (gpt-review key 980b2c). An
  // exported writer that enforced nothing could put a toggle on disk that then throws in
  // every plan write across every session — a repo-wide outage from one bad call.
  assertExecModelDefaultShape({ defaultLane, since, ruling }, `the value being written to ${path}`);
  atomicWriteTextSync(path, renderExecModelDefault({ defaultLane, since, ruling }));
}

/**
 * `{ lane, error }` — the lane currently in force, or the read error that prevented it.
 *
 * `set` must still be able to REPAIR a broken toggle (gpt-review key e099fb): the reader's
 * own error message tells the operator to fix it with `set`, so `set` cannot itself depend
 * on a successful read. But it must not overwrite blind either (key 726972), so the error
 * is RETURNED rather than swallowed and `set` gates the repair behind `--repair`.
 */
function readCurrentLane(path) {
  try {
    return { lane: readExecModelDefault(path).defaultLane, error: null };
  } catch (err) {
    return { lane: null, error: err };
  }
}

/**
 * @param argv — CLI arguments.
 * @param opts.togglePath — the toggle this invocation reads and writes. Defaults to the
 *   committed one. It is a PARAMETER rather than a CLI flag so the test suite can exercise
 *   the whole `set` path — the repair gate and the real write included — against a temp
 *   file, without either corrupting the repo's own toggle or growing a test-only flag an
 *   operator could point at the wrong file.
 */
export function main(argv = process.argv.slice(2), { togglePath = EXEC_MODEL_DEFAULT_PATH } = {}) {
  // The shared parser, not a hand-rolled loop (gpt-review keys 1faa8c / d6d055 / 4b5b26).
  // `requireValues` refuses `--reason` with a missing or whitespace-only value, and the
  // parser refuses unknown flags and stray positionals outright — which is what closes
  // 4b5b26: an UNQUOTED ruling (`set sol --reason I want Sol back`) used to bind only its
  // first word and silently drop the rest, recording a truncated operator quote.
  let cmd;
  let positionals;
  let flags;
  try {
    ({ cmd, positionals, flags } = parseFlags(argv, {
      subcommand: true,
      requireValues: true,
      value: ['reason'],
      boolean: ['repair'],
      label: 'exec-model-default',
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 1;
  }

  const command = cmd ?? 'show';

  if (command === 'show') {
    // `show` takes nothing (gpt-review keys ad0ee3 / ac7843 / a4bcdc). Silently ignoring a
    // stray argument is how `exec-model-default show sol` reads as a successful FLIP to a
    // hurried operator — it prints the lane either way. Refuse instead.
    if (positionals.length || Object.keys(flags).length) {
      console.error(`exec-model-default: show takes no arguments\n${USAGE}`);
      return 1;
    }
    const { defaultLane, since, ruling } = readExecModelDefault(togglePath);
    console.log(`exec-model-default: ${defaultLane} (since ${since})`);
    console.log(`  operator ruling: ${ruling}`);
    console.log(`  toggle: ${togglePath}`);
    return 0;
  }

  if (command !== 'set') {
    console.error(`exec-model-default: unknown command ${JSON.stringify(command)}\n${USAGE}`);
    return 1;
  }

  const [lane, ...extra] = positionals;
  if (!KNOWN_EXEC_LANES.includes(lane)) {
    console.error(
      `exec-model-default: ${JSON.stringify(lane ?? '')} is not a lane — expected one of ` +
        `${KNOWN_EXEC_LANES.join(' | ')}.\n${USAGE}`,
    );
    return 1;
  }
  if (extra.length) {
    console.error(
      `exec-model-default: unexpected argument ${JSON.stringify(extra[0])} — quote the ruling ` +
        `as ONE argument: --reason "<operator verbatim>".\n${USAGE}`,
    );
    return 1;
  }

  const reason = flags.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    console.error(
      'exec-model-default: set needs --reason "<operator verbatim>" — the operator\'s own ' +
        'words, quoted, not a paraphrase. The ruling is stored beside the value so the ' +
        'decision cannot be lost to compaction.',
    );
    return 1;
  }
  // A value flag consumes the NEXT token unconditionally (parse-flags.mjs's pinned
  // contract), so `--reason --dry` binds the FLAG as the ruling. `requireValues` does not
  // catch it — the value is present and non-empty, just wrong — and it would be recorded
  // as the operator's verbatim words. Same refusal stamp-exec-model.mjs makes (plan 2734).
  if (/^\s*-/.test(reason)) {
    console.error(
      `exec-model-default: --reason got the flag "${reason}" as its value — it needs the ` +
        "operator's words. (A flag directly after --reason is consumed as its value, so the " +
        'flag you meant would be silently lost and the ruling silently wrong.)',
    );
    return 1;
  }

  // An unreadable toggle must be REPAIRABLE — the reader's own error tells the operator to
  // fix it with `set` — but a plain `set` must not silently overwrite whatever is there
  // (gpt-review key 726972: a warning alone still let every read failure through, and a
  // transient failure is indistinguishable from real corruption at this point). So a repair
  // is an explicit, separate intent, and without it `set` refuses and shows the read error.
  const { lane: previousLane, error: readError } = readCurrentLane(togglePath);
  if (readError && !flags.repair) {
    console.error(`exec-model-default: cannot read the current toggle — ${readError.message}`);
    console.error(
      'exec-model-default: refusing to overwrite it blind. If the file is genuinely corrupt, ' +
        're-run with --repair; the stored ruling will be REPLACED by your --reason. If this ' +
        'was a transient read failure, fix that instead — the ruling on disk is not recoverable ' +
        'from here once overwritten.',
    );
    return 1;
  }
  if (previousLane === lane) {
    console.log(`exec-model-default: already ${lane} — nothing to do.`);
    return 0;
  }

  const since = today();
  writeExecModelDefault({ defaultLane: lane, since, ruling: reason.trim() }, togglePath);

  console.log(`exec-model-default: ${previousLane ?? 'unknown (toggle was unreadable)'} → ${lane}`);
  console.log('  commit it — config-only, so review-exempt:');
  // Deliberately NOT `git push origin master` (gpt-review keys 44b028 / ab05f4 / 3089ae):
  // run from a worktree, that would commit onto the worktree branch and then push the
  // SEPARATE local master ref, publishing nothing and reporting success. The flip belongs
  // on master, so the hint names the destination without assuming the caller's checkout is
  // sitting on it.
  console.log(`    git -C "${TOGGLE_REPO_ROOT}" add ${TOGGLE_REL_PATH}`);
  console.log(
    `    git -C "${TOGGLE_REPO_ROOT}" commit -m "chore(config): default executor lane ${previousLane ?? 'unknown'} → ${lane}"`,
  );
  // The paths above name THIS checkout, which is the one that was just written — not
  // necessarily the main one (gpt-review key 800fea: the old wording said "run from the
  // main checkout" while printing the invoking worktree's root, which cannot both be true).
  console.log(
    `  Those paths are this checkout (${TOGGLE_REPO_ROOT}). The flip belongs on master: if ` +
      'that is the main checkout, push from there; if you ran this inside a worktree, the ' +
      'commit rides that branch to master through its normal land.',
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main());
  } catch (e) {
    console.error('exec-model-default:', e.message);
    process.exit(1);
  }
}
