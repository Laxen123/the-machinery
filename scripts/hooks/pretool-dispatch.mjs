#!/usr/bin/env node
// scripts/hooks/pretool-dispatch.mjs — PreToolUse dispatcher (plan 4238).
//
// WHY: every Bash tool call used to start EIGHT separate `node` hook processes (plus
// worktree-guard.sh), each reading the same stdin JSON. On Windows a Node start costs
// ~0.3-0.7 s of CPU at rest and far more on a loaded box, which is what made hooks time
// out. This module runs the same eight guards IN ONE PROCESS: stdin is read once, each
// guard's own `evaluateHook(payload)` runs in-process, and the outcomes are merged the
// way Claude Code merges separate hooks. worktree-guard.sh stays its own bash hook.
//
// WHAT MUST NOT CHANGE: what any guard allows, denies, warns or injects. So:
//   - Each guard keeps its OWN matcher (the per-entry `matcher` it had in
//     .claude/settings.json), carried below as data, and its own `if` condition where it
//     had one. A guard never runs for a tool it was not registered for.
//   - Guards run in their old registration order, so concatenated text reads in the same
//     order it used to.
//   - When exactly ONE guard speaks (the overwhelmingly common case), the dispatcher
//     prints that guard's envelope object UNCHANGED, byte for byte.
//   - A guard that throws is isolated: a one-line note goes to stderr (exit stays 0, so
//     it is non-blocking, the same as a crashed separate hook) and the others still run.
//   - Each guard's module is imported LAZILY, through its registry entry's `load` thunk, and
//     only when its matcher and condition fit the call. So a guard module that fails to load
//     (a syntax error, a missing import) is isolated exactly like a guard that throws; before
//     the fold such a module broke only its own hook process, never its siblings. A tool call
//     no guard is registered for (Read, Edit, …) imports none of them. The thunks keep
//     LITERAL specifiers outside any importOptional(…) call, so module-graph.mjs reads each
//     one as a REQUIRED edge and build-coord-kit.mjs still ships all eight with this file.
//
// Merge rule when several guards speak: scripts/hooks/lib/hook-dispatch.mjs (shared with
// prompt-wiki-dispatch.mjs).
//
// Fails OPEN: an empty/malformed payload, or any dispatcher-level error, prints nothing.

import { fileURLToPath } from 'node:url';
import { runHookCli } from './lib/loader-common.mjs';
import { runGuards } from './lib/hook-dispatch.mjs';

// Claude Code's `"if": "Bash(git *)"` condition, as this repo measured it (commit
// a7d2d01ef03, plan 3944 review): a PREFIX match on the command text, so it holds only when
// the command itself starts with `git `. Reproduced literally, not improved — widening it
// would change when coord-write-guard speaks, which is out of scope for plan 4238.
export function bashGitPrefix(payload) {
  const cmd = payload?.tool_input?.command;
  return typeof cmd === 'string' && /^git\s/.test(cmd);
}

// The registry, in the order the guards were registered in .claude/settings.json before the
// fold. `matcher` is each guard's ORIGINAL entry matcher; `if` its original condition; `load`
// imports the guard's module, whose `evaluateHook` is what runs. Keep every specifier a plain
// string literal: a computed one would hide the edge from the module graph.
export const PRETOOL_GUARDS = [
  {
    name: 'coord-write-guard-pretooluse',
    matcher: 'Bash',
    if: bashGitPrefix,
    load: () => import('./coord-write-guard-pretooluse.mjs'),
  },
  {
    name: 'hand-rolled-step-guard',
    matcher: 'Bash',
    load: () => import('./hand-rolled-step-guard.mjs'),
  },
  { name: 'bash-shape-guard', matcher: 'Bash', load: () => import('./bash-shape-guard.mjs') },
  { name: 'land-timeout-guard', matcher: 'Bash', load: () => import('./land-timeout-guard.mjs') },
  {
    name: 'main-checkout-rebase-guard',
    matcher: 'Bash',
    load: () => import('./main-checkout-rebase-guard.mjs'),
  },
  {
    name: 'review-round-cap-guard',
    matcher: 'Bash|Workflow',
    load: () => import('./review-round-cap-guard.mjs'),
  },
  {
    name: 'subagent-backgrounding-guard',
    matcher: 'Bash|PowerShell|Agent|Task|Monitor',
    load: () => import('./subagent-backgrounding-guard.mjs'),
  },
  {
    name: 'cloud-land-backgrounding-guard',
    matcher: 'Bash|PowerShell|TaskOutput|Monitor',
    load: () => import('./cloud-land-backgrounding-guard.mjs'),
  },
];

// The .claude/settings.json PreToolUse block that registers THIS dispatcher, or undefined.
// The guards' own tests use it with PRETOOL_GUARDS to assert a guard is still wired: the
// dispatcher is registered, and its matcher covers the guard's own matcher.
export function dispatcherBlock(settings) {
  return (settings?.hooks?.PreToolUse ?? []).find((block) =>
    (block.hooks ?? []).some((h) => String(h.command ?? '').includes('pretool-dispatch.mjs')),
  );
}

// A guard's EFFECTIVE registration: its registry entry, but only when the dispatcher is
// registered and the dispatcher's matcher covers every tool in the guard's own matcher.
export function effectiveGuardRegistration(settings, name, guards = PRETOOL_GUARDS) {
  const guard = guards.find((g) => g.name === name);
  const block = dispatcherBlock(settings);
  if (!guard || !block) return undefined;
  const covered = String(block.matcher ?? '').split('|');
  if (!guard.matcher.split('|').every((tool) => covered.includes(tool))) return undefined;
  return guard;
}

// `guards` is a seam for tests (a registry whose `load` fails, a spy); it defaults to the real one.
export function evaluateHook(payload, { guards = PRETOOL_GUARDS, ...opts } = {}) {
  return runGuards(payload, guards, opts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}
