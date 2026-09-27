#!/usr/bin/env node
// scripts/hooks/cloud-land-backgrounding-guard.mjs — PreToolUse hook (plan 3248).
//
// WARNS (never denies) when a TOP-LEVEL CLOUD DRAIN session (1) backgrounds a landing
// operation, or (2) re-issues a blocking `TaskOutput` on a task whose FIRST blocking
// wait already timed out.
//
// § WHY. 2026-08-16: three cloud drain sessions across two accounts died on exactly
// this shape — hand `done-worktree` to a backgrounded local_bash task, then sit in a
// blocking `TaskOutput {block:true, timeout:600000}`. One of the three ran the full
// 600 s, got `<status>running</status>` back, and immediately re-issued a SECOND
// blocking `TaskOutput` on the SAME task_id — the environment died 2 seconds later.
// Two plan claims (`refs/claims/3181`, `refs/claims/3239`) stayed stranded 9+ hours
// because nothing detected the death or released the claim. Full incident + evidence:
// docs/superpowers/plans/in-progress/3248-FABLE-Infra-cloud-drain-backgrounded-land-death.md.
//
// § WHY THIS GUARD IS NOT plan-3116's subagent-backgrounding-guard.mjs. That guard
// keys on `agent_id` (see its own header) and is SILENT at top level — your project's `CLAUDE.md`
// POSITIVELY REQUIRES a top-level cloud drain to background a push when the gate cannot
// fit one 600 s call (the plan-2950 rule). Plan 3248 narrows that permission: a cloud
// drain may background *some* work, but never the LAND itself, and never a re-block on
// an already-timed-out task. This file is deliberately a SEPARATE hook rather than an
// extension of the 3116 guard — the two have opposite polarity on the exact same
// `run_in_background: true` payload shape (top-level + cloud must warn; a dispatched
// subagent already warns via 3116; a top-level LOCAL session must stay silent, because
// the shared-checkout push-backgrounding mandate is real and correct there). Folding
// both into one file would mean re-deriving that polarity table on every future edit.
//
// § THE TWO GATES, BOTH REQUIRED.
//   top-level = `agent_id` ABSENT from the payload (parseAgentId — the exact inverse of
//               plan 3116's isSubagentPayload; reused rather than re-derived).
//   cloud     = `CLAUDE_CODE_REMOTE === 'true'` in the hook process's environment. This
//               is the SAME marker your project's `CLAUDE.md` and its env loader already
//               treat as authoritative for "is this a cloud/remote checkout" (the loader's
//               line ~103: `process.env.CLAUDE_CODE_REMOTE === 'true'` is the one
//               documented exemption from its hobby-root-missing throw; CLAUDE.md's own
//               § Batch / long-running text: "the binary refuses `bypassPermissions`
//               whenever `CLAUDE_CODE_REMOTE` is set"). No other candidate marker exists
//               in this tree — `CLAUDE_CODE_ENTRYPOINT` (loader-common's
//               isHeadlessInvocation) distinguishes `claude -p` from interactive, not
//               local from cloud; a `claude -p` run on the operator's own machine also
//               reports `sdk-cli` there.
// A LOCAL top-level session (agent_id absent, CLAUDE_CODE_REMOTE unset) must stay
// SILENT — backgrounding a gate-running push there is MANDATORY, not a mistake, and a
// warning would be actively wrong (mirrors plan 3116's own top-level silence, one gate
// further out).
//
// § PATTERN 1 — backgrounded-land. A Bash/PowerShell call with `run_in_background:
// true` whose command text names a LANDING operation — see LAND_COMMAND_PATTERNS below
// for the exact, deliberately narrow token list.
//
// § PATTERN 1b — backgrounded-push. Plan 3248 (docs/superpowers/plans/…) RETIRES the
// plan-2950 background-plus-Monitor escape hatch outright, not merely the
// `scripts/**`/`backend/scripts/**` shape it was coined for — a cloud top-level session
// now pushes in the FOREGROUND, always. So a `git push` backgrounded
// (`run_in_background: true`) in a cloud top-level session trips this too, independent
// of pattern 1's landing-verb list. A LOCAL top-level session stays silent on the exact
// same call (see isApplicable) — the shared-checkout mandate there is the opposite and
// still real.
//
// § PATTERN 2 — reblocked-task. A blocking wait — `TaskOutput` with `block: true` for a
// given `task_id`, OR a `Monitor` call (which has no foreground/non-blocking mode at
// all, so every call counts — see WHY MONITOR HAS NO block FLAG below) — issued when
// this SAME CONTEXT already has a PRIOR blocking wait recorded for the identical wait
// key. The first blocking wait on a given key is recorded and stays silent (blocking
// once, waiting out a real timeout, is the sanctioned shape). A SECOND wait on the SAME
// key is classified against the PRIOR wait's own elapsed-vs-declared-timeout — see § THE
// HONEST LIMITATION below for exactly what that can and cannot prove. Deliberately keyed
// per wait-identity (task_id for TaskOutput, a fixed per-context key for Monitor), not
// merely "any second blocking call": polling a DIFFERENT task, or a non-blocking status
// check, must never trip this.
//
// § WHY MONITOR HAS NO block FLAG, AND HOW ITS RE-BLOCK KEY IS DERIVED. `Monitor`'s own
// schema carries no `task_id` and no boolean toggle between a blocking and non-blocking
// mode — plan 3116's sibling guard (subagent-backgrounding-guard.mjs, WAIT_TOOLS) already
// treats every single `Monitor` call as backgrounding on exactly that basis ("has no
// foreground mode... using it at all means the worker is parked"), and this guard reuses
// that same unconditional read: no `block` field to check, no `=== true` gate — the tool
// name alone is the trigger.
//
// H3 (plan 3248 re-check, confirmed finding): a single FIXED wait key for every `Monitor`
// call meant a session legitimately watching two DIFFERENT background jobs got a false
// re-block warning on the second call — exactly the failure mode this guard's own design
// is biased against (miss > false positive). The tool's real schema (checked against the
// live tool definition, not assumed) does offer something to tell two waits apart:
// `command` (the shell command being tailed/polled) or, for the `ws` source, `ws.url`.
// Two calls watching different jobs will almost always carry different command text or a
// different socket URL; a genuine re-block re-issues the identical wait (same
// command/url) after its own declared timeout elapsed. `extractMonitorWaitKey` below keys
// on a short hash of whichever is present, `command` first, `ws.url` second — the hash
// keeps the on-disk marker filename bounded regardless of how long a poll-loop command
// gets.
//
// What this STILL cannot do: correlate a `Monitor` wait with a PRIOR timed-out
// `TaskOutput` wait on a possibly-related job — no shared identifier exists across the two
// tools, and guessing "same job" risks exactly the false-positive this whole section
// exists to avoid, so that cross-tool case stays untracked (see the test naming this scope
// limit explicitly).
//
// The honest residual gap: a bare `Monitor` call with NEITHER `command` nor `ws.url` set
// (schema-legal but rare) has nothing distinguishing to key on — `description` is the only
// other identifying field, and it is free text a caller could coincidentally repeat across
// unrelated waits (or vary within the SAME wait), so it is deliberately NOT used as a key.
// That case falls back to the fixed MONITOR_WAIT_KEY constant, so two bare Monitor calls
// in the same context remain indistinguishable — accepted, per the guard's stated bias
// toward a miss over a false positive.
//
// § WARN, never DENY — the plan-2848/3116 precedent. Exit 0 always; the warning rides
// PreToolUse `hookSpecificOutput.additionalContext` via loader-common's shared
// `emitInjection` envelope. A deny here would get the hook muted within a day, and an
// unattended cloud drain has no one to click a permission prompt anyway.
//
// § DE-DUPE. Two independent on-disk marker uses, both via loader-common's
// alreadyInjected/markInjected primitives, both keyed under `parseContextId` (the
// session id, or session+agent_id when the rare case of a cloud TOP-LEVEL session that
// is ALSO somehow agent-scoped arises — parseContextId degrades to the plain session id
// whenever agent_id is absent, which it always is here by the top-level gate):
//   1. TASK_SEEN_ROOT — "has this context already issued a FIRST blocking TaskOutput for
//      this task_id" — the state pattern 2's detection itself depends on.
//   2. MARKER_ROOT — the plan-3116-style "have I already shown the FULL warning for this
//      PATTERN in this context" — first firing gets the full text + hand-back recipe,
//      every later firing of the SAME pattern gets a one-liner, so a drain that keeps
//      polling is not buried under repeated policy prose.
// These are different concerns on purpose: pattern 2 can be "seen this task before" on
// its 2nd call yet still be a "first FULL warning" (nothing has warned yet); its 3rd+
// call is both "seen before" AND "already warned" → one-liner.
//
// § MEASUREMENT. One line per firing appended to
// ~/.claude/session-state/cloud-land-backgrounding-guard-firings.log — the
// subagent-backgrounding-guard-firings.log precedent, so a future audit can grade
// whether the warning is heeded the same way plan 3121 grades the 3116 guard.
//
// Fails OPEN on any parse/IO error — a tool hook must never break the turn.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alreadyInjected,
  injectionEnvelope,
  markInjected,
  markerDirFor,
  parseAgentId,
  parseContextId,
  runHookCli,
  safeMarkerKey,
} from './lib/loader-common.mjs';

export const FIRING_LOG = join(
  homedir(),
  '.claude',
  'session-state',
  'cloud-land-backgrounding-guard-firings.log',
);

// "Have I already shown the FULL warning for this pattern, in this context" — the
// plan-3116-style say-it-once cache. Env override is the e2e-test seam (mirrors
// SUBAGENT_BACKGROUNDING_GUARD_MARKERS).
export const MARKER_ROOT = join(tmpdir(), 'vetapp-cloud-land-bg-guard');

// "Has this context already issued a FIRST blocking wait (TaskOutput or Monitor) for
// this wait key" — a SEPARATE cache from MARKER_ROOT because the two questions have
// different lifetimes: a wait can be seen-before on its 2nd call while the
// reblocked-task PATTERN is still unwarned (nothing has fired yet), so collapsing them
// into one marker would either warn on the very first re-block with no way to test
// "silent on first, warn on second" in isolation, or silently merge two unrelated
// dedupe lifetimes.
//
// UNLIKE MARKER_ROOT (a bare touch file — existence is the whole signal), each entry
// here holds JSON `{ seenAtMs, timeoutMs }` — see § THE HONEST LIMITATION at
// classifyReblock below for why the CONTENT, not just the existence, is load-bearing.
export const TASK_SEEN_ROOT = join(tmpdir(), 'vetapp-cloud-land-bg-guard-tasks');

// Grace window subtracted from a prior wait's own declared timeout before comparing it
// to the elapsed wall-clock time to THIS call — hook dispatch, JSON marshalling, and the
// model's own turn-processing time between the prior call returning and this call firing
// all eat a few seconds that are not part of the prior wait's actual duration. Without
// this, a prior wait that returned at (very near) its own timeout could read as
// "elapsed < timeout" purely from that overhead and wrongly clear as a normal
// completion.
const RE_BLOCK_GRACE_MS = 5_000;

// The shell tools that take an explicit background flag — same pair plan 3116 watches
// (this harness is cross-platform: vetapp runs on Windows locally, Linux in the cloud).
const BACKGROUND_FLAG_TOOLS = new Set(['Bash', 'PowerShell']);

// § LAND_COMMAND_PATTERNS — deliberately narrow. `done-worktree` is the actual
// merge+gate+deploy+archive script and the exact call all three 2026-08-16 deaths
// backgrounded. `landing-queue.mjs enqueue` (joining the FIFO to land) and
// `landing-queue.mjs mark-in-land` (the done-worktree spine's own "I am now inside the
// merge window" stamp) are the two landing-queue.mjs subcommands that represent
// ACTIVELY LANDING rather than queue bookkeeping — a backgrounded call to either parks
// a top-level cloud session on the same re-block shape the incident measured.
// Deliberately EXCLUDED: `dequeue` / `status` / `heartbeat` / `mark-holding` /
// `requeue` / `reenter` / `demote` / `steal` / `reap` — pure queue housekeeping, and
// `dequeue` specifically is the SANCTIONED hand-back move this guard's own warning
// text recommends; flagging it would warn on the fix. A bare `git push origin <branch>`
// matches none of these — see PATTERN 1b / GIT_PUSH_PATTERN below, which now covers it
// on its own (plan 3248 retired the plan-2950 mandate this used to fall back on).
const LAND_COMMAND_PATTERNS = [
  /\bdone-worktree(?:\.mjs)?\b/,
  /\blanding-queue(?:\.mjs)?\s+enqueue\b/,
  /\blanding-queue(?:\.mjs)?\s+mark-in-land\b/,
];

// § PATTERN 1b's command test — see the header note. H1 (plan 3248 re-check, confirmed
// finding): the original `/\bgit\s+push\b/` required "push" to follow "git" IMMEDIATELY,
// which misses `git -C <dir> push` — the exact form your project's `CLAUDE.md` MANDATES on Windows,
// because a Bash command may never open with `cd`, so every git call in this repo passes
// `-C <abs path>`. As written the old pattern would have missed essentially every real
// backgrounded push this codebase actually issues.
//
// Q2 (plan 3248 review, CONFIRMED): the option-value half of this pattern used to be
// `\S+` only — a run of non-whitespace — so a QUOTED value containing a space (`git -C
// "C:/Program Files/repo" push`, the realistic Windows-path shape) broke the token walk:
// the quoted value's internal space ended `\S+` before the closing quote, the following
// `Files/repo"` token had no leading `-` to keep the option-loop going, and the whole
// match failed with "push" never reached — even though `git -C <dir> push` is the exact
// form your project's `CLAUDE.md` MANDATES on Windows (a Bash command may never open with `cd`).
// The value alternative now also accepts a double- or single-quoted run (greedy up to
// the first matching close-quote), independent of whether it contains whitespace.
//
// GIT_PUSH_PATTERN now MATCHES:
//   - `git push` — the bare form.
//   - `git.exe push` — the Windows executable suffix.
//   - `git -C <dir> push` — an UNQUOTED option value with no embedded space.
//   - `git -C "<dir with spaces>" push` / `git -C '<dir with spaces>' push` — a
//     double- or single-QUOTED option value, WITH embedded spaces (the Q2 fix).
//   - `git --work-tree=<dir> push`, `--work-tree="<dir with spaces>"` — an `=`-joined
//     value, quoted or not.
//   - `git -c foo=bar push`, `git --no-pager push` — a value-bearing or bare global
//     option.
//   - any STACK of the above between `git` and `push` (each option independently
//     quoted or not, valued or not).
// GIT_PUSH_PATTERN deliberately does NOT match (known, accepted gaps — this is a plain
// text matcher, not a shell parser):
//   - `git commit -m "push the fix later"` — "push" appears, but not as the subcommand
//     immediately after `git` + zero-or-more option tokens (a non-flag token like
//     `commit` between `git` and `push` breaks the match).
//   - `echo "please push soon"`, or any other command mentioning the bare word "push"
//     with no `git` invocation at all.
//   - `npm run push-thing` / `gitpush` — no `\bgit\b` token, or "push" is not its own
//     word.
//   - a quoted value containing an ESCAPED quote of its own kind (`"C:\some\"path"`) —
//     `[^"]*`/`[^']*` stop at the first literal quote character, with no shell-escaping
//     awareness.
//   - a FLAG token itself wrapped in quotes (e.g. `git "-C" "<dir>" push`) — only the
//     VALUE half of an option is allowed to be quoted, not the flag name.
//   - command substitution / variable expansion inside a value (`` `$(...)` ``, `$VAR`)
//     — matched as literal text, never evaluated.
// This is a plain substring test (`.test()`, not anchored), so a command that ALSO
// contains a real `git ... push` invocation later in the same string (e.g. chained with
// `&&`) still matches on that real invocation, by design.
const GIT_PUSH_PATTERN = /\bgit(?:\.exe)?\b(?:\s+-\S+(?:[ =](?:"[^"]*"|'[^']*'|\S+))?)*\s+push\b/;

function isPushCommand(command) {
  return GIT_PUSH_PATTERN.test(String(command ?? ''));
}

const PATTERNS = {
  'backgrounded-land': {
    what: 'This call runs a LANDING operation in the BACKGROUND (`run_in_background: true`).',
    fix: 'Run it in the FOREGROUND instead (≥600000ms timeout) — or hand the land back per the recipe below.',
  },
  'backgrounded-push': {
    what: 'This call runs `git push` in the BACKGROUND (`run_in_background: true`) — backgrounding a push is no longer permitted here.',
    fix: 'Run the push in the FOREGROUND instead (≥600000ms timeout) — or hand the land back per the recipe below.',
  },
  'reblocked-task': {
    what: 'This is a SECOND blocking wait (`TaskOutput` or `Monitor`) on a task whose PRIOR wait appears to have already timed out.',
    whatUncertain:
      'This is a SECOND blocking wait (`TaskOutput` or `Monitor`) on the same task. This guard cannot confirm the PRIOR wait actually timed out — treat this as a caution, not a confirmed violation.',
    fix: 'Do not re-block on this task — hand the land back per the recipe below instead.',
  },
};

export const PATTERN_KEYS = Object.keys(PATTERNS);

// H2 (plan 3248 re-check, confirmed finding): the OLD order below released the claim
// (step 5) and moved the plan to ready/ (step 6) BEFORE writing the hand-back note into
// the plan body — that opens a window where the plan is claimable with nothing recording
// that a built, pushed branch already exists, so the next drain to pick it up could redo
// the work from scratch or cut a second worktree over the same plan. The canonical order
// (the canonical hand-back order, "Once the push is confirmed on origin:") writes
// the note via `edit-plan.mjs` WHILE STILL CLAIMED, then releases, then moves to ready/.
const HAND_BACK_RECIPE = [
  '   A cloud drain never backgrounds the land, and never re-blocks on a task whose',
  '   blocking wait already timed out (plan 3248 — three cloud sessions died on this',
  '   exact shape 2026-08-16, two claims stranded 9+ hours). Hand the land back instead',
  '   (canonical order, note BEFORE release):',
  '     1. Commit and push the branch in the FOREGROUND (git push, >=600000ms timeout).',
  '     2. Record the review (node scripts/record-review.mjs <PASS|NITS|BUGS-FOUND> ...).',
  '     3. node scripts/landing-queue.mjs dequeue <slug> — never end a run holding the',
  '        queue head.',
  '     4. node scripts/edit-plan.mjs <id> --find <s> --replace <s> — write a note into',
  '        the plan body naming the branch as BUILT and PUSHED, WHILE STILL CLAIMED (do',
  '        this before step 5, not after — releasing/moving first makes the plan',
  '        claimable with no note yet describing the built branch).',
  '     5. node scripts/release-claim.mjs release <id>',
  '     6. node scripts/move-plan.mjs <id> ready — the plan becomes claimable only now,',
  '        once the note already describes the built branch.',
  '     7. Report and end the turn cleanly.',
].join('\n');

// ── the two gates ────────────────────────────────────────────────────────────

// top-level = the exact inverse of plan 3116's isSubagentPayload; reused via
// parseAgentId so a schema rename lands in one place for both guards.
export function isTopLevelPayload(payload) {
  return !parseAgentId(payload);
}

// cloud = CLAUDE_CODE_REMOTE === 'true', the marker your project's `CLAUDE.md` and
// env loader already treat as authoritative (see header). `env` is a
// parameter so tests never touch the real process environment.
export function isCloudSession(env = process.env) {
  return String(env?.CLAUDE_CODE_REMOTE ?? '').trim() === 'true';
}

export function isApplicable(payload, env = process.env) {
  return isTopLevelPayload(payload) && isCloudSession(env);
}

// ── pattern 1: backgrounded-land (pure — payload only, no disk) ─────────────

function isLandingCommand(command) {
  const cmd = String(command ?? '');
  return LAND_COMMAND_PATTERNS.some((rx) => rx.test(cmd));
}

// H4 (plan 3248 re-check): patterns 1 and 1b share every gate EXCEPT the command-text
// test — same tool-name check, same tool_input object check, same literal-`true`
// run_in_background check. Factored out so the two patterns cannot drift on that shared
// shape; only isLandingCommand vs isPushCommand stays a per-pattern decision. Returns the
// validated tool_input on a pass, null on any shape failure.
function extractBackgroundedInput(payload) {
  const toolName = String(payload?.tool_name ?? '');
  if (!BACKGROUND_FLAG_TOOLS.has(toolName)) return null;
  const input = payload?.tool_input;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (!isObj) return null;
  if (input.run_in_background !== true) return null;
  return input;
}

export function evaluateLandPattern(payload) {
  const input = extractBackgroundedInput(payload);
  if (!input) return null;
  if (!isLandingCommand(input.command)) return null;
  return 'backgrounded-land';
}

// § PATTERN 1b — see the header note. Same shape gate as pattern 1 (extractBackgroundedInput),
// a different command test (isPushCommand vs isLandingCommand), so it stays a sibling
// function rather than a branch inside evaluateLandPattern — the two command tests are
// independent lists and keeping them as separate pure functions means either can change
// without touching the other's tests.
export function evaluatePushPattern(payload) {
  const input = extractBackgroundedInput(payload);
  if (!input) return null;
  if (!isPushCommand(input.command)) return null;
  return 'backgrounded-push';
}

// Convenience wrapper mirroring plan 3116's `evaluate(payload)` shape: gates on
// applicability, then checks patterns 1 and 1b only (pattern 2 is inherently stateful —
// see classifyReblock below, which is the pattern-2 analogue exercised separately).
export function evaluate(payload, env = process.env) {
  if (!isApplicable(payload, env)) return null;
  return evaluateLandPattern(payload) || evaluatePushPattern(payload);
}

// ── pattern 2: reblocked-task (stateful — needs prior-call history) ─────────

// A blocking TaskOutput call names its task via `task_id` (the field observed in the
// live 2026-08-16 incident payloads); tolerate the camelCase fallback the way
// parseAgentId/parseSessionId do, for the same reason (a future transport normalizing
// snake_case must not silently blind this).
export function extractBlockingTaskId(payload) {
  if (String(payload?.tool_name ?? '') !== 'TaskOutput') return null;
  const input = payload?.tool_input;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (!isObj) return null;
  if (input.block !== true) return null;
  const taskId = input.task_id ?? input.taskId;
  return typeof taskId === 'string' && taskId ? taskId : null;
}

// The `timeout` a blocking TaskOutput call itself declared, if any — the value § THE
// HONEST LIMITATION compares elapsed wall-clock time against. Only meaningful once
// extractBlockingTaskId has already confirmed this IS a blocking TaskOutput call.
function extractBlockingTimeoutMs(payload) {
  const input = payload?.tool_input;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (!isObj) return null;
  const t = input.timeout ?? input.timeoutMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

export function isMonitorCall(payload) {
  return String(payload?.tool_name ?? '') === 'Monitor';
}

// Monitor's OWN declared timeout — `timeout_ms` (its real field name; `timeoutMs`
// tolerated for parity with every other camelCase fallback in this file), defaulting to
// the tool's documented 300000ms when omitted. `persistent: true` is a session-length
// watch with no timeout at all — returns null (unknown), same as a TaskOutput call that
// carried no readable timeout.
function extractMonitorTimeoutMs(payload) {
  const input = payload?.tool_input;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (!isObj) return 300_000;
  if (input.persistent === true) return null;
  const t = input.timeout_ms ?? input.timeoutMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : 300_000;
}

// The FALLBACK per-context wait-key for a `Monitor` call that carries neither `command`
// nor `ws.url` — see the header's § WHY MONITOR HAS NO block FLAG note. Real Monitor calls
// almost always carry one of those two fields; this constant only fires for the rare bare
// call, where nothing distinguishes one wait from another.
const MONITOR_WAIT_KEY = 'monitor';

// H3 (plan 3248 re-check, confirmed finding): derives the actual per-wait key from
// whatever the Monitor payload offers to tell two waits apart — `command` first (the
// shell command being tailed/polled), `ws.url` second (the `ws` source has no `command`).
// Hashed (not used raw) so an arbitrarily long poll-loop command never produces an
// oversized/illegal marker filename — safeMarkerKey only substitutes unsafe characters,
// it does not bound length. Falls back to the fixed MONITOR_WAIT_KEY when neither field is
// present (schema-legal but rare; see the header note on why `description` is not used).
function extractMonitorWaitKey(payload) {
  const input = payload?.tool_input;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  if (isObj) {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (command) return `cmd-${createHash('sha1').update(command).digest('hex').slice(0, 16)}`;
    const wsUrl = typeof input.ws?.url === 'string' ? input.ws.url.trim() : '';
    if (wsUrl) return `ws-${createHash('sha1').update(wsUrl).digest('hex').slice(0, 16)}`;
  }
  return MONITOR_WAIT_KEY;
}

// Read/write a wait-key marker's CONTENT (not just its existence — alreadyInjected /
// markInjected are bare touch-files and can't carry a timestamp+timeout). Fails open:
// a torn/missing marker reads as "no prior wait", the safer default (silent, not warn).
function readWaitMarker(dir, key) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, key), 'utf8'));
  } catch {
    return null;
  }
}
function writeWaitMarker(dir, key, data) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, key), JSON.stringify(data));
  } catch {
    /* best-effort; a failed write just means the NEXT call can't compare against this one */
  }
}

// § THE HONEST LIMITATION. A PreToolUse hook sees only the CALL, never the tool's
// RESULT — it fires BEFORE the tool executes, so it can never directly observe whether a
// prior blocking wait returned because it timed out (`<status>running</status>`, the
// exact 3239 death shape) or because the underlying task genuinely completed (a
// legitimate reason to never re-block on it again, and also no real reason TO re-block —
// so a second wait right after a genuine completion is unusual, but not dangerous, and
// must not warn as if it were).
//
// The best available PROXY, not a certainty: the wall-clock time between this hook
// seeing the PRIOR blocking wait and seeing THIS one is (very nearly) how long the prior
// wait's tool execution actually took, because the model cannot issue this call until
// the prior one returns. Compared against the PRIOR call's own declared timeout:
//   • elapsed reached (within RE_BLOCK_GRACE_MS of) that timeout → the prior wait almost
//     certainly ran to its full duration without the task finishing — classified
//     'timed-out', the confident case, warned with the assertive `what` text.
//   • elapsed is well under that timeout → the prior wait almost certainly returned
//     early on a genuine completion — returns null (no violation), SILENT.
//   • the prior call carried no readable timeout at all → elapsed time proves nothing
//     either way — classified 'uncertain', still warned (a caller re-blocking twice on
//     the same wait key is still worth a look) but with the hedged `whatUncertain` text
//     rather than an asserted violation.
// This is an approximation, stated plainly rather than silently assumed: it can be
// fooled by a task that happens to finish in exactly the window the grace constant
// covers, or by unusually slow hook/model dispatch inflating elapsed time on a fast
// completion. Given the guard's own operating asymmetry (miss > false positive), the
// grace window is sized to bias toward the SILENT branch when timing is ambiguous.
function classifyWait(payload, { markerRoot, now, waitKey, timeoutMs }) {
  const dir = markerDirFor(markerRoot, parseContextId(payload));
  const key = `task-${safeMarkerKey(waitKey)}`;
  const nowMs = now();
  const prior = readWaitMarker(dir, key);
  // Always refresh to THIS call's own timestamp/timeout, so a THIRD call is judged
  // against the SECOND call, not stale first-call state.
  writeWaitMarker(dir, key, { seenAtMs: nowMs, timeoutMs });
  if (!prior) return null; // first blocking wait on this key — the sanctioned shape

  const elapsedMs = nowMs - prior.seenAtMs;
  if (typeof prior.timeoutMs === 'number' && prior.timeoutMs > 0) {
    const threshold = Math.max(0, prior.timeoutMs - RE_BLOCK_GRACE_MS);
    return elapsedMs >= threshold ? 'timed-out' : null;
  }
  return 'uncertain';
}

// The pattern-2 entry point: classifies a blocking TaskOutput call (keyed on its real
// task_id) or a Monitor call (keyed on the fixed MONITOR_WAIT_KEY — see the header note),
// returning 'timed-out' | 'uncertain' | null. Anything else (a non-blocking TaskOutput
// call, any other tool) is null and touches no marker.
export function classifyReblock(
  payload,
  { markerRoot = TASK_SEEN_ROOT, now = () => Date.now() } = {},
) {
  const taskId = extractBlockingTaskId(payload);
  if (taskId) {
    return classifyWait(payload, {
      markerRoot,
      now,
      waitKey: taskId,
      timeoutMs: extractBlockingTimeoutMs(payload),
    });
  }
  if (isMonitorCall(payload)) {
    return classifyWait(payload, {
      markerRoot,
      now,
      waitKey: extractMonitorWaitKey(payload),
      timeoutMs: extractMonitorTimeoutMs(payload),
    });
  }
  return null;
}

// Boolean convenience wrapper — true for EITHER classification ('timed-out' or
// 'uncertain'), since both fire a warning; main()/fireWarning read classifyReblock
// directly when they need to pick the wording.
export function isReblockedTask(payload, opts) {
  return classifyReblock(payload, opts) !== null;
}

// ── warning text ──────────────────────────────────────────────────────────────

export function formatWarning(key, payload, { repeat = false, uncertain = false } = {}) {
  const p = PATTERNS[key];
  if (!p) return '';
  const what = uncertain && p.whatUncertain ? p.whatUncertain : p.what;
  if (repeat) {
    return `⚠️  cloud-land-backgrounding guard (again): ${what} ${p.fix}`;
  }
  return ['⚠️  cloud-land-backgrounding guard', `   ${what}`, `   ${p.fix}`, HAND_BACK_RECIPE].join(
    '\n',
  );
}

// ── firing log (measurement surface) ─────────────────────────────────────────

export function logFiring(
  key,
  agentType,
  { logPath = process.env.CLOUD_LAND_BACKGROUNDING_GUARD_LOG || FIRING_LOG, now = new Date() } = {},
) {
  if (!key) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${now.toISOString()} ${key} ${agentType || '-'}\n`);
  } catch {
    /* best-effort measurement; never breaks the turn */
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

function fireWarning(key, payload, { uncertain = false } = {}) {
  const contextId = parseContextId(payload);

  // The firing LOG records every firing; only the injected TEXT shortens on a repeat —
  // conflating the two would under-count exactly the sessions that ignore the warning
  // most (mirrors plan 3116's own rationale).
  logFiring(key, String(payload?.agent_type ?? ''));

  const markerDir = markerDirFor(
    process.env.CLOUD_LAND_BACKGROUNDING_GUARD_MARKERS || MARKER_ROOT,
    contextId,
  );
  const repeat = alreadyInjected(markerDir, key);
  if (!repeat) markInjected(markerDir, key);

  return injectionEnvelope(
    formatWarning(key, payload, { repeat, uncertain }),
    `⚠️  cloud-land-backgrounding guard: ${key}`,
    'PreToolUse',
  );
}

// The hook's whole outcome as DATA (plan 4238): the warn envelope it would print, or
// null for silence. The firing log and the repeat / task-seen markers are side effects it
// still performs itself, exactly as before the fold. The in-process PreToolUse dispatcher
// (pretool-dispatch.mjs) calls this; the CLI below is a thin wrapper that prints it.
export function evaluateHook(payload) {
  if (!isApplicable(payload)) return null; // not top-level+cloud → silent by design

  const landKey = evaluateLandPattern(payload) || evaluatePushPattern(payload);
  if (landKey) return fireWarning(landKey, payload);

  const taskMarkerRoot = process.env.CLOUD_LAND_BACKGROUNDING_GUARD_TASK_MARKERS || TASK_SEEN_ROOT;
  const reblock = classifyReblock(payload, { markerRoot: taskMarkerRoot });
  if (reblock) {
    return fireWarning('reblocked-task', payload, { uncertain: reblock === 'uncertain' });
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
