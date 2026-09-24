#!/usr/bin/env node
// scripts/hooks/subagent-backgrounding-guard.mjs — PreToolUse hook (plan 3116).
//
// WARNS (never denies) when a call made from INSIDE a dispatched subagent backgrounds
// work: a `run_in_background: true` shell call, a `Monitor` wait, or a nested Agent
// dispatch that is not explicitly foreground.
//
// § WHY A GUARD AND NOT MORE PROSE. Plan 3110 measured 2,484 dispatch-and-return
// subagent runs across the whole local transcript corpus (2026-06-01 → 2026-08-11):
//   • an agent that starts a background child of its own stalls mid-run 32.3% (21/65);
//     one that does not stalls 0.26% (2/768);
//   • a backgrounded `git push` specifically stalls 45.8% (11/24) vs 1.2% foreground
//     (1/83);
//   • and — the finding that made this file necessary — dispatch prompts that ALREADY
//     asked the worker to commit before reporting stalled at 22.6% (7/31) versus 1.7%
//     for prompts that did not ask. The instruction is being given and is not preventing
//     the outcome.
// Report: output/reports/2026-08-11-subagent-stall-rate-plan-3110.md. The mechanism is
// that the harness fires the completion notification when an agent stops with no live
// background children, so a worker parked on its own background job is reported
// `completed` while its last words say it is waiting.
//
// § WARN, never DENY — the plan-2848 precedent this file explicitly reuses. Exit 0
// always; the warning rides PreToolUse `hookSpecificOutput.additionalContext` via
// loader-common's shared `emitInjection` envelope. Legitimate one-offs exist, the value
// is naming the rule at the moment of the mistake, and a deny here would get the hook
// muted within a day. Plan 3116 § Do-not-touch forbids flipping this warn→deny.
//
// § THE SUBAGENT TEST IS `agent_id`, AND ONLY `agent_id`. Verified live on 2026-08-12
// (plan 3116's probe: a throwaway project + an injected dump-only hook + one headless
// `claude -p` turn that ran a Bash call at top level and then in a dispatched
// general-purpose subagent). Independently re-confirming plan 2883's 2026-08-05
// measurement, which is already load-bearing in `parseContextId`. What the two payloads
// showed, field by field:
//   • `session_id`      — IDENTICAL (the subagent carries the PARENT's session id)
//   • `transcript_path` — IDENTICAL, and it is the PARENT's transcript, not the agent's
//     own (`SubagentStop` is the only event carrying `agent_transcript_path`)
//   • `cwd` / `prompt_id` / `permission_mode` / `effort` — identical
//   • the hook process's ENVIRONMENT — byte-identical; there is no env-var route
//   • `agent_id` — ABSENT at top level, `"a6ad261439d9f4d3d"` in the subagent
// Both raw payloads are COMMITTED, verbatim, at
// `output/reports/2026-08-12-pretooluse-subagent-payload-probe-plan-3116.md` — the tests here
// hand-construct their payloads, so that file is what they can be checked against, and what a
// future harness change would be caught by (gpt-review finding 4eec89).
//
// So the guard reads `agent_id` and nothing else. Deliberately NOT `agent_type`: the
// shipped schema's own description warns that it is also set on the MAIN thread of any
// `--agent` session, so a guard keyed on it would fire on every top-level push in one —
// exactly the "fires on everything, muted within a day" failure plan 2848 warns about.
//
// § THREE PATTERNS, tight on purpose (prefer a miss to a false positive):
//   1. background-shell  — Bash/PowerShell with `run_in_background: true`
//   2. monitor-wait      — any `Monitor` call (the tool exists only to wait on
//                          background work)
//   3. nested-bg-agent   — an Agent/Task dispatch that is not explicitly foreground
//
// § WHY PATTERN 3 FIRES ON AN ABSENT FLAG. Agent dispatches are BACKGROUND BY DEFAULT in
// this harness ("Subagents run in the background by default"), so an omitted
// `run_in_background` IS a backgrounded dispatch. The apparent false-positive — a worker
// that meant to dispatch in the foreground and relied on the default — is not one: under
// the plan-3110 rule a subagent must background nothing, so "pass `run_in_background:
// false` explicitly" is the correct advice in that case too. Patterns 1 and 2 stay strict
// (`=== true`, exact tool name) because there is no such default to reason about.
//
// § SCOPE IS THE SUBAGENT ONLY. Every one of these calls is LEGITIMATE at top level —
// vetapp/CLAUDE.md positively REQUIRES a backgrounded gate-running push on the shared
// local checkout, and `TaskOutput`/`Monitor` are the sanctioned way a top-level session
// reaps its own background work. A top-level payload has no `agent_id`, so the guard is
// silent there by construction, which is the whole reason the probe had to come first.
//
// § NO PLATFORM BRANCH. The same hook runs on the operator's Windows checkout (where the
// 32% stall population lives) and on cloud Linux drains, so it reads only payload fields
// and never a path, a separator or a `process.platform`. The single filesystem touch is
// the firing log under `homedir()`, whose path the tests inject. That is the strongest
// form of the platform-parameter rule: nothing to parameterise.
//
// § MEASUREMENT. One line per firing (ISO timestamp + pattern key + agent type) is
// appended to ~/.claude/session-state/subagent-backgrounding-guard-firings.log — the
// hand-rolled-guard-firings.log / wedge-kills.log precedent. Plan 3116 acceptance 3 grades
// the fix by re-running scripts/measure-subagent-endings.mjs against the same corpus; this
// log is the cheap cross-check on whether the warning is being heeded rather than merely
// shown.
//
// Fails OPEN on any parse/IO error — a tool hook must never break the turn.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alreadyInjected,
  emitInjection,
  markInjected,
  markerDirFor,
  parseAgentId,
  parseContextId,
  readStdin,
} from './lib/loader-common.mjs';

export const FIRING_LOG = join(
  homedir(),
  '.claude',
  'session-state',
  'subagent-backgrounding-guard-firings.log',
);

// § SAY IT ONCE PER WORKER, PER PATTERN. A hook is a one-shot process, so "have I already
// said this?" has to live on disk — the same marker primitives the wiki loaders use
// (`markerDirFor` / `alreadyInjected` / `markInjected`), keyed by `parseContextId` so the
// namespace is the AGENT, not the shared parent session. First firing gets the full
// warning; every later firing of the SAME pattern in the SAME worker gets one line.
//
// WHY it matters more here than for a loader: a worker that polls `Monitor` in a loop would
// otherwise take the whole warning on every poll, and a guard that floods the context it is
// trying to save is self-defeating — it buries the actionable line and can push out the tool
// result the worker was waiting for (gpt-review findings 9b29d8 + 6170ce, plan 3116).
// Deliberately NOT registered in loader-common's `CACHE_ROOTS`: that map is the wiki
// loaders' set, enumerated by the compaction-reset hook and a coverage lint, and this root
// is neither a wiki page namespace nor something a compaction should clear (the RULE does
// not stop applying because the context was compacted).
// Residue is one empty file per (worker, pattern) in tmpdir — bounded by the number of
// workers that actually violate the rule, which the whole point of this hook is to drive
// toward zero.
export const MARKER_ROOT = join(tmpdir(), 'vetapp-subagent-bg-guard');

// The shell tools that take an explicit background flag. Both are live in this harness
// (vetapp runs on Windows, where the PowerShell tool is the primary one).
const BACKGROUND_FLAG_TOOLS = new Set(['Bash', 'PowerShell']);

// The agent-dispatch tools. Two names for one thing: `Agent` is this harness's, `Task`
// is the name the same tool carries in other Claude Code surfaces, and a worker prompt
// that reaches for either is doing the same thing.
const AGENT_TOOLS = new Set(['Agent', 'Task']);

// Waiting on background work. `Monitor` has no foreground mode — using it at all inside a
// worker means the worker is parked. `TaskOutput` is deliberately ABSENT: it is the
// documented way to REAP a wedged background job, so warning on it would fire on the
// recovery and not on the mistake.
const WAIT_TOOLS = new Set(['Monitor']);

const PATTERNS = {
  'background-shell': {
    what: 'This shell call is backgrounded (`run_in_background: true`).',
    fix: 'Drop the flag and run it in the FOREGROUND with a ≥600000ms timeout.',
  },
  'monitor-wait': {
    what: 'This is a `Monitor` call, which exists only to wait on background work.',
    fix: 'Run the underlying command in the FOREGROUND with a ≥600000ms timeout instead.',
  },
  'nested-bg-agent': {
    what: 'This dispatches a nested Agent in the background (dispatches are background by default).',
    fix: 'Pass `run_in_background: false`, or do the work inline — a background fan-out is the orchestrator’s job, not a worker’s.',
  },
};

export const PATTERN_KEYS = Object.keys(PATTERNS);

// Is this payload from inside a dispatched subagent? The one and only gate — see the
// § THE SUBAGENT TEST header note for the measured payload shapes behind it.
export function isSubagentPayload(payload) {
  return Boolean(parseAgentId(payload));
}

// The pattern this call trips, or null. Pure: takes the whole payload, reads nothing else.
export function evaluate(payload) {
  if (!isSubagentPayload(payload)) return null;

  const toolName = String(payload?.tool_name ?? '');
  const input = payload?.tool_input;
  // A missing/!object tool_input cannot carry a flag; read it as absent rather than
  // throwing (`null` is an object, so the typeof test alone is not enough).
  const background =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input.run_in_background
      : undefined;

  if (WAIT_TOOLS.has(toolName)) return 'monitor-wait';
  if (BACKGROUND_FLAG_TOOLS.has(toolName) && background === true) return 'background-shell';
  // Absent flag counts — dispatches default to background. Only an explicit `false` is
  // foreground, so only an explicit `false` is silent.
  if (AGENT_TOOLS.has(toolName) && background !== false) return 'nested-bg-agent';
  return null;
}

// The FIRST firing carries the reasoning; a REPEAT carries only what is actionable. The
// per-call lines (`what` / `fix`) survive both, because they are the part that differs
// between patterns and the part the worker has to act on — it is the static policy block
// that must not be re-paid on every call.
export function formatWarning(key, payload, { repeat = false } = {}) {
  const p = PATTERNS[key];
  if (!p) return '';
  if (repeat) {
    return `⚠️  subagent-backgrounding guard (again): ${p.what} ${p.fix}`;
  }
  const agentType = String(payload?.agent_type ?? '').trim();
  const who = agentType ? `a dispatched subagent (${agentType})` : 'a dispatched subagent';
  return [
    '⚠️  subagent-backgrounding guard',
    `   You are running inside ${who}, and this call backgrounds work.`,
    `   ${p.what}`,
    `   Do this instead: ${p.fix}`,
    '   A subagent backgrounds NOTHING: the harness reports an agent that parks on its own',
    '   background job as `completed` while its last words say it is waiting (measured: 32.3%',
    '   of such runs stall, against 0.26% otherwise). If the work cannot fit one foreground',
    '   call, commit, report, and hand the job to the orchestrator — it owns every job that',
    '   outlives a turn. See output/reports/2026-08-11-subagent-stall-rate-plan-3110.md.',
  ].join('\n');
}

// One line per firing: ISO timestamp + pattern key + agent type. Best-effort — a failed
// append must never affect the warning or the exit code. `logPath` is a test seam (and
// the SUBAGENT_BACKGROUNDING_GUARD_LOG env override its spawn-test equivalent) so a test
// run never pollutes the real machine log.
export function logFiring(
  key,
  agentType,
  { logPath = process.env.SUBAGENT_BACKGROUNDING_GUARD_LOG || FIRING_LOG, now = new Date() } = {},
) {
  if (!key) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${now.toISOString()} ${key} ${agentType || '-'}\n`);
  } catch {
    /* best-effort measurement; never breaks the turn */
  }
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

  const key = evaluate(payload);
  if (!key) return;

  // The firing LOG records every firing (it is the measurement surface for plan 3121); only
  // the injected TEXT shortens on a repeat. Conflating the two would make the log under-count
  // exactly the workers that ignore the warning most.
  logFiring(key, String(payload?.agent_type ?? ''));

  const markerDir = markerDirFor(
    process.env.SUBAGENT_BACKGROUNDING_GUARD_MARKERS || MARKER_ROOT,
    parseContextId(payload),
  );
  const repeat = alreadyInjected(markerDir, key);
  if (!repeat) markInjected(markerDir, key);

  emitInjection(
    formatWarning(key, payload, { repeat }),
    `⚠️  subagent-backgrounding guard: ${key}`,
    'PreToolUse',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
