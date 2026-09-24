// scripts/coord/exec-model-default-lib.mjs — the ONE place the executor-lane default is
// resolved from (plan 3656).
//
// WHY THIS EXISTS. Before this plan the default lane was a string literal exported
// from scripts/coord/exec-model-stamp.mjs, pinned by a test that asserted the literal, and
// re-stated as prose in six live surfaces (docs/runbooks/plans-workflow.md x3,
// coord/skills/spec-pass/SKILL.md x2, vetapp CLAUDE.md, thin-orchestrator.md,
// coord/skills/cloud-routines/SKILL.md). Flipping it therefore meant a `scripts/**`
// diff — which triggers the mandatory code review — plus a six-file prose rewrite
// that had to keep four dated verbatim rulings straight. Two flips (plans 3461 and
// 3617) each cost a full plan + review + land cycle for what is, in substance, a
// one-word operator preference.
//
// Operator ruling 2026-09-03, verbatim: "I'd also like for the flip to be faster. It
// shouldn't be a plan and reviews, and it should just be a toggle somewhere."
//
// So the value is DATA now: `scripts/exec-model-default.json`. A flip is a
// config-only edit (review-exempt per vetapp CLAUDE.md § Plans, specs, landing), made
// with `node scripts/exec-model-default.mjs set <lane> --reason "<verbatim>"`.
//
// WHY THE JSON LIVES UNDER scripts/. Two constraints pin it here rather than at the
// repo root next to coord.config.json:
//   1. scripts-module-layout: a non-test .mjs under scripts/ must not import outside
//      scripts/. A path read is not an import, but the second constraint decides it.
//   2. The isolated-plan-repo test scaffold (scripts/test-helpers/isolated-plan-repo.mjs)
//      runs COPIES of the scripts tree and copies "everything except the test files
//      themselves — not just .mjs", so a sibling asset under scripts/ travels with its
//      module. A repo-root JSON would ENOENT inside every scaffolded temp repo, the
//      same way an escaping import ERR_MODULE_NOT_FOUNDs there.
//
// RESOLVED FROM THIS MODULE'S OWN DIRNAME, never process.cwd() — and therefore from the
// CHECKOUT the calling code lives in, which is the point rather than a bug (gpt-review
// key 8d132e read it as "a supposedly global toggle resolved from the worktree's copy").
// A stamp written by a worktree session belongs to the branch that session will land, so
// it must read that branch's toggle, exactly like every other line of code the session
// runs. A worktree cut before a flip sees the pre-flip lane until it rebases — the same
// staleness every other file in that worktree has, and the landing queue's rebase is what
// resolves it. A cwd-relative or repo-root-absolute read would instead give one checkout's
// answer to another checkout's code, which is the genuinely wrong behaviour.
//
// FAIL LOUD, NEVER DEFAULT. An unreadable, malformed, unknown-lane, or audit-incomplete
// toggle throws at read time. Silently falling back to a hardcoded lane would resurrect
// the very thing this module deletes: a second, invisible statement of the default that
// can disagree with the file the operator just edited.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptsFileFrom } from './scripts-anchor.mjs';

/**
 * The lanes a plan's `execModel` may name.
 *
 * Deliberately a LOCAL literal rather than an import of claim-plan-lib.mjs's
 * EXEC_LANE_TABLE (gpt-review keys 65ba76 / f300b0 / 815b17 read the duplication as
 * drift risk). Two reasons it stays local: claim-plan-lib.mjs pulls in coord-config,
 * build-index-lib, board-write-gate and more, and this module is imported at LOAD time
 * by exec-model-stamp.mjs — which every plan write goes through — so importing it here
 * would drag that whole graph into every stamp, with a real cycle risk as those modules
 * grow. The drift the reviewer worried about is closed WITHOUT the import:
 * exec-model-default-lib.test.mjs asserts these keys equal EXEC_LANE_TABLE's, so the two
 * can never disagree without a red test. That is the same shape plan-lane-segments.mjs
 * uses to stay a dependency-free leaf.
 */
export const KNOWN_EXEC_LANES = ['sonnet', 'fable', 'sol'];

export const EXEC_MODEL_DEFAULT_PATH = scriptsFileFrom(
  'exec-model-default.json',
  dirname(fileURLToPath(import.meta.url)),
);

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in `YYYY-MM-DD`, not merely a string of that SHAPE (gpt-review keys
 * 62f66b / f5317f / 410589: the first cut's bare regex accepted `2026-99-99` and `2026-02-31`).
 * Round-tripping through Date is what separates the two — `Date.parse` normalises an
 * out-of-range day into the following month, so a value that does not render back to itself
 * was never the date it claimed to be.
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RX.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Throw unless `{ defaultLane, since, ruling }` is a toggle the reader would accept. Shared by
 * the reader and by the WRITER (gpt-review key 980b2c: the exported writer enforced none of
 * the reader's invariants, so a caller could persist a toggle that then hard-failed every
 * plan write in the repo). `where` names the file or call site in the message.
 */
export function assertExecModelDefaultShape({ defaultLane, since, ruling }, where) {
  if (!KNOWN_EXEC_LANES.includes(defaultLane)) {
    throw new Error(
      `exec-model-default: ${where} names defaultLane ${JSON.stringify(defaultLane)}, ` +
        `which is not one of ${KNOWN_EXEC_LANES.join(' | ')}.`,
    );
  }
  if (!isCalendarDate(since)) {
    throw new Error(
      `exec-model-default: ${where} has since ${JSON.stringify(since)} — it must be a real ` +
        'YYYY-MM-DD calendar date recording when this lane took effect.',
    );
  }
  if (typeof ruling !== 'string' || ruling.trim() === '') {
    throw new Error(
      `exec-model-default: ${where} has no ruling — it must carry the operator's verbatim ` +
        'words, so the decision lives with the value instead of only in chat.',
    );
  }
}

/**
 * Read the toggle. Returns `{ defaultLane, since, ruling }`.
 *
 * Every failure mode throws with the file path and the fix in the message, because the
 * callers (an auto-stamp on a plan write; the spec-pass CLI) have no sane fallback: a
 * wrong lane on a stamped plan is silent misrouting that only surfaces when a drain
 * picks the plan up, which is far from the write that caused it.
 *
 * `since` and `ruling` are validated as strictly as `defaultLane` (gpt-review keys
 * 5f4480 / a835ed / 63a8c2: the first cut coerced a missing one to `''`, so production
 * accepted an audit-incomplete toggle that the test suite rejected — two different
 * contracts for one file). They are the whole reason the ruling cannot be lost to
 * compaction, so a toggle that has lost them is broken, not merely untidy.
 *
 * @param {string} [path] — the toggle to read. Defaults to the committed one; tests pass
 *   a temp copy so they can exercise the real read/write round trip without mutating the
 *   repo's own toggle.
 */
export function readExecModelDefault(path = EXEC_MODEL_DEFAULT_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `exec-model-default: cannot read ${path} (${err.code ?? err.message}). ` +
        'This file is the ONE executor-lane default; restore it from git rather than ' +
        'reintroducing a hardcoded lane.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `exec-model-default: ${path} is not valid JSON (${err.message}). Repair it with ` +
        '`node scripts/exec-model-default.mjs set <lane> --reason "<operator verbatim>" ' +
        '--repair`, which rewrites the whole file and always emits valid JSON. The ' +
        '--repair flag is required precisely because that rewrite REPLACES the stored ' +
        'ruling, which is not recoverable afterwards.',
    );
  }

  const { defaultLane, since, ruling } = parsed ?? {};
  assertExecModelDefaultShape({ defaultLane, since, ruling }, path);
  return { defaultLane, since, ruling };
}

/** Convenience for the common case — just the lane. */
export function execModelDefaultLane(path = EXEC_MODEL_DEFAULT_PATH) {
  return readExecModelDefault(path).defaultLane;
}
