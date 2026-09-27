#!/usr/bin/env node
// scripts/hooks/bash-shape-guard.mjs — PreToolUse hook (plan 3099 sitting,
// operator-directed 2026-08-14: "How do we fix that in the future? Like, not
// just for this sub-edit").
//
// Claude Code 2.1.232's static analyzer makes two Bash command shapes stop for
// MANUAL operator approval every single time, regardless of permissions.allow
// (details: the operator's personal, machine-global CLAUDE.md § "Bash on
// Windows — never open a command with `cd`" and § "Bash commands over
// 10,000 characters"):
//   1. a command whose effective first token is `cd` (the final working
//      directory of a cd-compound cannot be statically resolved, so the call
//      is never handed to the auto-approval classifier), and
//   2. a command over 10,000 characters (hard cap, classifierApprovable:false;
//      inline heredocs carrying file content are how commands get there).
//
// Instruction files ask every session and subagent to avoid these shapes, but
// prompts still leaked through whenever an agent forgot — each one parking the
// whole session on a Yes/No dialog the operator has to click. This hook makes
// the rule DETERMINISTIC: the doomed call is denied before the permission
// system sees it, with a rewrite recipe the model applies on its next attempt.
// Same fail-open contract as the sibling hooks: malformed input or an internal
// error must never break the turn.

import { fileURLToPath } from 'node:url';
import { denyEnvelope, runHookCli } from './lib/loader-common.mjs';

// Effective-first-token `cd`: start of command or right after a separator
// (; & | && || newline, or an opening subshell paren), with optional
// env-assignment prefixes — mirrors worktree-guard.sh's boundary anchoring so
// prose mentioning "cd" inside a quoted string does not arm the guard for the
// COMMAND-INITIAL case we care about. Only the command-opening `cd` is fatal
// to the classifier, so only that is blocked; a mid-pipeline `cd` inside a
// subshell suffix rides the same refusal in practice, so separators arm it too.
const CD_RX = /(?:^|[;&|(]|\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*cd\s/;

const LENGTH_CAP = 9500; // margin under the classifier's hard 10,000

function evaluate(cmd) {
  if (cmd.length > LENGTH_CAP) {
    return (
      `bash-shape-guard: this command is ${cmd.length} characters — anything over ` +
      `10,000 stops for MANUAL operator approval (the 2.1.232 length cap downgrades ` +
      `even an explicit allow), and ${LENGTH_CAP}+ is too close to the cap. Never ` +
      `inline documents or file content in a heredoc: write the content with the ` +
      `Write tool, then run a SHORT command pointing at the absolute path ` +
      `(e.g. python -X utf8 "C:/abs/path/script.py", or pass --body "C:/abs/path/file.md").`
    );
  }
  if (CD_RX.test(cmd)) {
    return (
      `bash-shape-guard: this command opens with \`cd\` (or chains one after a ` +
      `separator). On Windows/Git Bash under Claude Code 2.1.232 such a command is ` +
      `NEVER auto-approved — it always stops the operator for a manual click. ` +
      `Rewrite without cd: the Bash tool's working directory already persists, and ` +
      `every tool takes an absolute path — use git -C "C:/abs/repo" …, ` +
      `python -X utf8 "C:/abs/script.py", node "C:/abs/script.mjs", ` +
      `pnpm --dir "C:/abs/pkg" …, and literal absolute paths in redirects.`
    );
  }
  return null;
}

// The hook's whole outcome as DATA (plan 4238): the deny envelope it would print, or
// null for silence. The in-process PreToolUse dispatcher (pretool-dispatch.mjs) calls
// this; the CLI below is a thin wrapper that prints it.
function evaluateHook(payload) {
  const cmd = String(payload?.tool_input?.command ?? '');
  if (!cmd) return null;

  const reason = evaluate(cmd);
  if (!reason) return null;

  return denyEnvelope(reason);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runHookCli(evaluateHook);
  } catch {
    // fail open — a tool hook must never break the turn
  }
  process.exit(0);
}

export { evaluate, evaluateHook, CD_RX, LENGTH_CAP };
