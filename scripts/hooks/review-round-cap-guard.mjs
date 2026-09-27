#!/usr/bin/env node
// scripts/hooks/review-round-cap-guard.mjs — PreToolUse hook (plan 3527).
//
/*
 * NARROW BY DESIGN: this guard recognizes only one direct, single-segment Bash review command or
 * one direct Workflow review call. It is a guard, not a shell, and two review rounds proved that
 * interpreting wrappers, prompts, quotes, or compound control flow here creates bypasses faster
 * than it closes them. The gpt-review runner keeps its own enforcement for every runner launch.
 */
//
// DISPATCHED SUBAGENTS are detected by parseAgentId(payload), exactly like
// subagent-backgrounding-guard.mjs. They are silent here because their plain-CLI path belongs
// to the runner's own gate and they do not have the Workflow tool.
//
// FAIL-OPEN, unconditionally. Malformed input, an unparseable command, an unreadable repo, a
// failed git call, or any other internal throw emits nothing and exits success. A boundary hook
// must never block an unrelated Bash command because its own machinery broke.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRepoIsolatedEnv } from '../coord/child-env.mjs';
import { GIT_NONINTERACTIVE_ENV } from '../coord/coord-git.mjs';
import {
  REVIEW_LEVELS,
  capDenialMessage,
  effectiveLaunchFloor,
  fixBriefCandidates,
  fixBriefDenialMessage,
  fixBriefRequired,
  fixDeltaChangedLines,
  isPastCap,
  planSlugFromBranch,
  planIdFromSlug,
  readLaunchCount,
  recordLaunch,
  resolveReviewTargetBranch,
  validatePastCapReason,
} from '../coord/review-round-cap.mjs';
// plan 3967: the fastlane stamp reader — a plan's review-round cap is 1 (never the default 4)
// once its frontmatter carries `lane: fast`. Fails open to `null` (the default lane) on any
// lookup error by its own contract, so this import can never turn a read failure into a denial.
import { readLaneById } from '../coord/read-plan-stamps.mjs';
import { splitSegments, tokenize } from './land-timeout-guard.mjs';
import { denyEnvelope, parseAgentId, runHookCli } from './lib/loader-common.mjs';

// Re-exported: existing external callers (this hook's own test file) import REVIEW_LEVELS from
// here. plan 3618 moved the definition into scripts/coord/review-round-cap.mjs so the shared target
// resolver (which needs the same level union) and this hook read one copy.
export { REVIEW_LEVELS };

const REVIEW_LANES = new Set(['sonnet-review', 'code-review']);
const NON_LAUNCH_FLAGS = new Set(['--dry-run', '--help', '-h', '--version']);
const NODE_BASENAMES = new Set(['node', 'node.exe']);

function basenameOf(token) {
  const normalized = String(token ?? '').replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

// Returns the lane plus its argv (excluding the command token), or null when the segment merely
// mentions a lane name rather than invoking one. There are deliberately no wrappers or Node
// option tables here: anything other than the direct shape fails open.
export function reviewInvocation(parsed) {
  const head = parsed.argv0Base;
  if (!head) return null;

  if (head === 'gpt-review.mjs') return { lane: 'gpt-review', args: parsed.args };
  if (REVIEW_LANES.has(head)) return { lane: head, args: parsed.args };
  if (NODE_BASENAMES.has(head) && basenameOf(parsed.args[0]) === 'gpt-review.mjs') {
    return { lane: 'gpt-review', args: parsed.args.slice(1) };
  }
  return null;
}

function workflowReviewInvocation(input) {
  const args = input.args === undefined ? '' : input.args;
  if (typeof args !== 'string') return null;
  if (typeof input.name === 'string' && REVIEW_LANES.has(input.name)) {
    return { lane: input.name, args };
  }
  if (typeof input.scriptPath !== 'string') return null;
  const scriptLane = basenameOf(input.scriptPath).replace(/\.js$/i, '');
  return REVIEW_LANES.has(scriptLane) ? { lane: scriptLane, args } : null;
}

// plan 3618 finding 5a186f: valuelessness is reported HERE, in the one match scan, rather than
// copied into a second scanning function that could silently disagree with this one about what
// counts as "exactly once" or "duplicated". A `--flag` with no following value, or followed by
// ANOTHER `--flag`, is `valueless: true` with `value: undefined` (so `flagValue` below still
// resolves it to `null`, same as the pre-existing "absent" contract every OTHER flagValue caller
// — `--repo` included — already relies on). The attached `name=value` form always carries a
// value. Two or more occurrences of `name` stay `null` (ambiguous, treated as absent) — unchanged.
function flagEntry(args, name) {
  const matches = args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => arg === name || arg.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const { arg, index } = matches[0];
  if (arg !== name) {
    return { value: arg.slice(name.length + 1), start: index, end: index + 1, valueless: false };
  }
  const next = args[index + 1];
  const valueless = next === undefined || next.startsWith('--');
  return valueless
    ? { value: undefined, start: index, end: index + 1, valueless: true }
    : { value: next, start: index, end: index + 2, valueless: false };
}

function flagValue(args, name) {
  return flagEntry(args, name)?.value ?? null;
}

export function hasPastCapEscape(args) {
  const reason = flagValue(args, '--past-cap');
  return reason !== null && validatePastCapReason(reason).accepted;
}

function repoCandidate(args, payload, { pathApi = nodePath } = {}) {
  const fromFlag = flagValue(args, '--repo');
  const cwd = typeof payload?.cwd === 'string' && payload.cwd.trim() ? payload.cwd : null;
  if (fromFlag && fromFlag.trim()) {
    if (pathApi.isAbsolute(fromFlag)) return pathApi.resolve(fromFlag);
    return cwd ? pathApi.resolve(cwd, fromFlag) : null;
  }
  return cwd ? pathApi.resolve(cwd) : null;
}

// `--no-optional-locks` (plan 3974 review finding f234fa) is a GLOBAL git option — harmless on
// every verb this wrapper is ever asked to run (it only skips optional sub-operations such as
// status's index refresh), so no caller needs to change: it always goes first, before `-C`.
export function runGit(repoRoot, args) {
  return execFileSync('git', ['--no-optional-locks', '-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitRepoIsolatedEnv(GIT_NONINTERACTIVE_ENV),
  }).trim();
}

async function readMarkerRoundFloor(repoRoot, branch) {
  const { warnBeforeReviewLaunch } = await import('../gpt-review.mjs');
  return warnBeforeReviewLaunch(repoRoot, {
    branchName: branch,
    warn: () => {},
    returnContext: true,
  }).markerRoundFloor;
}

// plan 4078 T1: the previous reviewed tip — the `@ <sha>` of the plan's Review marker — for the
// fix-brief gate below. A SEPARATE call from readMarkerRoundFloor above rather than a shared one:
// `readMarkerRoundFloorFn` is a pinned, test-stubbed contract (existing tests inject it as a bare
// number), so its return shape cannot grow a second field without breaking every one of them.
// Same fail-open contract as readMarkerRoundFloor's own call: an unresolvable marker degrades to
// null here, which fixDeltaChangedLines below treats as "undeterminable" and never denies on.
async function readMarkerSha(repoRoot, branch) {
  const { warnBeforeReviewLaunch } = await import('../gpt-review.mjs');
  return (
    warnBeforeReviewLaunch(repoRoot, {
      branchName: branch,
      warn: () => {},
      returnContext: true,
    }).markerSha ?? null
  );
}

// Returns null (ALLOW) or the shared cap-denial inputs (DENY). All dependencies that can touch
// git are injectable, and the whole verdict is fail-open so a throwing seam is indistinguishable
// from any real git/read failure: no verdict, no output.
export async function evaluate(
  payload,
  {
    runGitFn = runGit,
    readLaunchCountFn = readLaunchCount,
    recordLaunchFn = recordLaunch,
    readMarkerRoundFloorFn = readMarkerRoundFloor,
    resolveReviewTargetBranchFn = resolveReviewTargetBranch,
    // plan 3967: named `readLaneByIdFn`, never `readLaneFn` — this reads the PLAN's `lane: fast`
    // stamp by id, a completely different axis from the `lane` local variable a few lines below
    // (the review TOOL lane: 'gpt-review' / 'sonnet-review' / 'code-review'). Both are called
    // "lane" in prose because that is what their own frontmatter keys are named; see
    // read-plan-stamps.mjs's LANE_FAST comment for the same collision noted at its source.
    readLaneByIdFn = readLaneById,
    pathApi = nodePath,
    // plan 4078 T1: the fix-brief gate's own two injectable seams — a marker-sha reader (see
    // readMarkerSha's header above) and an existence check, mirroring existsFn's role everywhere
    // else in this repo's advisory readers.
    readMarkerShaFn = readMarkerSha,
    existsFn = existsSync,
  } = {},
) {
  try {
    const toolName = String(payload?.tool_name ?? '');
    if (toolName !== 'Bash' && toolName !== 'Workflow') return null;
    if (parseAgentId(payload)) return null;
    const input = payload?.tool_input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const workflow = toolName === 'Workflow';
    let lane;
    let args;
    if (workflow) {
      const invocation = workflowReviewInvocation(input);
      if (!invocation) return null;
      ({ lane, args } = invocation);
      args = tokenize(args);
    } else {
      if (typeof input.command !== 'string' || !input.command) return null;
      const segments = splitSegments(input.command);
      if (segments.length !== 1) return null;
      const tokens = tokenize(segments[0]);
      if (tokens.length === 0) return null;
      const invocation = reviewInvocation({
        argv0: tokens[0],
        argv0Base: basenameOf(tokens[0]),
        args: tokens.slice(1),
      });
      if (!invocation) return null;
      ({ lane, args } = invocation);
      if (args.some((arg) => NON_LAUNCH_FLAGS.has(arg))) return null;
    }

    // plan 3618 addendum item C: catch a valueless --past-cap BEFORE the extraction below reads
    // it as absent — mirrors gpt-review.mjs's ARG_SPEC `requireValues: true`, which refuses this
    // shape unconditionally in the Bash lane regardless of plan association, so the guard does
    // the same rather than only ever catching it after the CLI process already started.
    const pastCapFlag = flagEntry(args, '--past-cap');
    if (pastCapFlag?.valueless) {
      return { valuelessPastCap: true, ...(workflow ? { workflow: true } : {}) };
    }
    const rawPastCapReason = pastCapFlag?.value ?? null;
    if (pastCapFlag) args = [...args.slice(0, pastCapFlag.start), ...args.slice(pastCapFlag.end)];
    if (!workflow && lane === 'gpt-review' && rawPastCapReason !== null) return null;

    const pastCapValidation =
      rawPastCapReason === null ? null : validatePastCapReason(rawPastCapReason);
    const pastCapReason = pastCapValidation?.accepted ? pastCapValidation.reason : null;

    const requestedRepo = repoCandidate(workflow ? [] : args, payload, { pathApi });
    if (!requestedRepo) return null;
    // plan 3618 finding D1 (a REGRESSION this plan's own first pass introduced): the sibling-
    // worktree hunt is Workflow-scope-recovery ONLY (`allowSiblingHunt: workflow`) — the Bash
    // lane must NEVER auto-detect a sibling, because `gpt-review.mjs`'s own runner always
    // resolves the CURRENT checkout branch, and a Bash launch charged to a different, guessed
    // plan than the one the runner just reviewed is exactly the "guard and runner disagree" bug
    // class this whole plan exists to close. The Bash lane's own explicit-target resolution
    // (addendum item B — a `--range` value, charged to its END ref) is the ONLY token source it
    // gets; a bare `sonnet-review`/`code-review`/`gpt-review.mjs` Bash command carries none of
    // those flags and resolves to the current branch, same as before this plan.
    //
    // plan 3618 round 2 finding 153a5b: `--end-ref` is NEVER a target selector, in either lane —
    // the runner's own parseArgs only consults `--end-ref` to bound the DIFF (a deliberate
    // historical replay), never to choose which plan a launch is charged to; a standalone
    // `--end-ref x` falls back to the runner's DEFAULT range (`origin/master...HEAD`), which
    // charges the CURRENT branch. Reading it here as a target made the two lanes disagree the
    // other way — the guard charged `x`'s plan while the runner charged the current checkout's.
    const bashExplicitToken =
      !workflow && lane === 'gpt-review' ? flagValue(args, '--range') : null;
    const target = resolveReviewTargetBranchFn({
      tokens: workflow ? args : bashExplicitToken !== null ? [bashExplicitToken] : [],
      cwd: requestedRepo,
      runGitFn,
      allowSiblingHunt: workflow,
    });
    if (!target) return null;
    const { branch, repoRoot } = target;
    const slug = planSlugFromBranch(branch);
    const planId = planIdFromSlug(slug);
    if (!planId) return null;
    // plan 3967: the plan's OWN `lane: fast` stamp (never confused with the `lane` local above,
    // the review TOOL lane) — read from the MAIN checkout's plan file, because the plan file
    // lives on master, not on the reviewed worktree branch (repoRoot here is already resolved to
    // that MAIN checkout by resolveReviewTargetBranchFn). Fails open to `null` on any lookup
    // error (readLaneById's own contract) — a lookup failure must never DENY a review that the
    // default cap would have allowed.
    const planLane = readLaneByIdFn(repoRoot, planId);

    const markerRoundFloor = await readMarkerRoundFloorFn(repoRoot, branch);
    const priorLaunches = readLaunchCountFn(repoRoot, planId);

    // plan 4078 T1: shared by both lanes below, and evaluated ONLY when the cap itself has
    // already ALLOWED this launch (never before it — a brief denial must not mask an at-cap
    // denial, which would show the wrong fix menu). The guard fires before the runner's own
    // --out exists, so it checks only the slug-keyed default location; the runner's own cap
    // decision (reviewLaunchCapDecision, scripts/gpt-review.mjs) additionally checks whatever
    // --out that run actually resolves. Fail-open throughout: an unresolvable marker sha or a
    // git failure degrades to `changedLines: null`, which fixBriefRequired never denies on.
    const fixBriefDenial = async (launchOrdinal) => {
      if (launchOrdinal < 2) return null;
      const markerSha = await readMarkerShaFn(repoRoot, branch);
      const changedLines = fixDeltaChangedLines(repoRoot, markerSha, branch, { runGitFn });
      const candidates = fixBriefCandidates({ repoRoot, slug });
      if (
        !fixBriefRequired({ launchOrdinal, changedLines, briefExists: candidates.some(existsFn) })
      )
        return null;
      return { deniedReason: 'fix-brief-missing', slug, candidates };
    };

    if (lane === 'gpt-review') {
      const launchOrdinal = effectiveLaunchFloor(priorLaunches, markerRoundFloor) + 1;
      // `planLane` rides the verdict ONLY when it is the fastlane value — an unstamped plan's
      // verdict must stay the exact `{ planId, launchOrdinal }` shape byte-identical tests pin
      // (plan 3967's own acceptance: default-lane behaviour is unchanged, not "unchanged plus a
      // null key").
      if (isPastCap(launchOrdinal, planLane)) {
        return { planId, launchOrdinal, ...(planLane ? { planLane } : {}) };
      }
      const briefDenial = await fixBriefDenial(launchOrdinal);
      return briefDenial
        ? { planId, launchOrdinal, ...briefDenial, ...(planLane ? { planLane } : {}) }
        : null;
    }

    // Accepted cost: PreToolUse records before the command runs, so a CLI launch that then fails
    // to start still burns its round. This matches the runner's pre-spend asymmetry and errs
    // toward the cap rather than around it. `recordLaunchFn` itself now decides the second-
    // consecutive-`run:` denial ATOMICALLY inside its own CAS loop (plan 3618 finding D2) — a
    // plain integer means the launch was recorded; `{denied:true, ordinal, consecutiveEscapes}`
    // means it was NOT (no ledger write happened for that specific denial).
    // plan 3967 fix round 1 (findings 10/13/14): thread the fastlane stamp into the ledger
    // path itself — `recordLaunchFn`'s own internal past-cap/consecutive-escape check used to
    // stay lane-blind even though `isPastCap` below already knew about `planLane`, so a
    // fastlane plan's SECOND consecutive `run:` escape (which must be denied, same as the
    // default lane's rule) was silently recorded and allowed instead.
    const result = recordLaunchFn(repoRoot, planId, {
      branch,
      launchFloor: markerRoundFloor,
      pastCapReason,
      lane: planLane,
    });
    const consecutiveRunDenial = result && typeof result === 'object' ? result : null;
    const launchOrdinal = consecutiveRunDenial ? consecutiveRunDenial.ordinal : result;
    if (pastCapValidation && !pastCapValidation.accepted) {
      return {
        planId,
        launchOrdinal,
        ...(workflow ? { workflow: true } : {}),
        pastCapRefusal: pastCapValidation.message,
      };
    }
    if (consecutiveRunDenial) {
      return {
        planId,
        launchOrdinal,
        ...(workflow ? { workflow: true } : {}),
        ...(planLane ? { planLane } : {}),
        consecutiveEscapes: consecutiveRunDenial.consecutiveEscapes,
      };
    }
    // `planLane` again rides the verdict only when set (see the gpt-review branch above) — the
    // default-lane shape stays byte-identical to every pre-3967 caller.
    if (isPastCap(launchOrdinal, planLane) && pastCapReason === null) {
      return {
        planId,
        launchOrdinal,
        ...(workflow ? { workflow: true } : {}),
        ...(planLane ? { planLane } : {}),
      };
    }
    const briefDenial = await fixBriefDenial(launchOrdinal);
    return briefDenial
      ? {
          planId,
          launchOrdinal,
          ...briefDenial,
          ...(workflow ? { workflow: true } : {}),
          ...(planLane ? { planLane } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export function formatDeny(verdict) {
  const workflowUsage =
    'Workflow args: append --past-cap "run: <reason>", ' +
    '--past-cap "simplify: <reason>", or --past-cap "park: <reason>" to tool_input.args.';
  if (verdict.valuelessPastCap) {
    const message =
      'review-round cap: --past-cap requires a value — use ' +
      '--past-cap "<run|simplify|park>: <reason>".';
    return verdict.workflow ? `${message}\n${workflowUsage}` : message;
  }
  if (verdict.pastCapRefusal) {
    return `${verdict.pastCapRefusal}.${verdict.workflow ? `\n${workflowUsage}` : ''}`;
  }
  // plan 4078 T1: the fix-brief gate's own denial shape — a launch the cap itself would allow,
  // denied instead for lacking the previous round's fresh-context brief.
  if (verdict.deniedReason === 'fix-brief-missing') {
    const message = fixBriefDenialMessage({
      planId: verdict.planId,
      slug: verdict.slug,
      launchOrdinal: verdict.launchOrdinal,
      candidates: verdict.candidates,
    });
    return verdict.workflow ? `${message}\n${workflowUsage}` : message;
  }
  const message = capDenialMessage({
    planId: verdict.planId,
    launchOrdinal: verdict.launchOrdinal,
    pastCapFlagName: '--past-cap',
    consecutiveEscapes: verdict.consecutiveEscapes,
    // plan 3967: absent on every pre-fastlane verdict shape (see evaluate()'s own
    // `...(planLane ? { planLane } : {})` guards) — capDenialMessage's own `lane = null` default
    // then renders the exact byte-identical message it always has.
    lane: verdict.planLane,
  });
  return verdict.workflow ? `${message}\n${workflowUsage}` : message;
}

// The hook's whole outcome as DATA (plan 4238): the deny envelope it would print, or
// null for silence. The in-process PreToolUse dispatcher (pretool-dispatch.mjs) awaits
// this; main() below is a thin CLI wrapper that prints it.
export async function evaluateHook(payload, { env = process.env } = {}) {
  const runGitFn =
    String(env?.REVIEW_ROUND_CAP_GUARD_FORCE_GIT_ERROR ?? '') === '1'
      ? () => {
          throw new Error('review-round-cap-guard: forced git failure');
        }
      : runGit;
  const verdict = await evaluate(payload, { runGitFn });
  if (!verdict) return null;

  return denyEnvelope(formatDeny(verdict));
}

async function main(env = process.env) {
  return runHookCli((payload) => evaluateHook(payload, { env }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}

export { main };
