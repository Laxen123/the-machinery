// scripts/coord/claude-env.mjs — moved from scripts/fb-responder/classify.mjs (plan 3959 T2).
//
// `process.env` minus the two account-override vars a call site must strip before spawning
// `claude -p`, so the child bills the session's own CLAUDE_CONFIG_DIR account rather than a
// foreign token some imported module's dotenv load dragged in (the plan-2141/2228 "429 that
// describes a foreign account" failure mode) — the JS twin of
// backend/scripts/lib/claude_hooks.py's clean_claude_env(). Generic (no vetapp vocabulary), and
// already imported by more than the Facebook classifier alone (gpt-review.mjs), which is why it
// moves to scripts/coord/ rather than staying a fb-responder-owned export.
//
// No fs, no git, no vetapp-specific knowledge — Rule 3 (docs/runbooks/scripts-module-layout.md)
// compliant: node: builtins only, no bare package specifiers, no import outside scripts/coord/.

// The two account-override vars a call site must strip before spawning `claude -p`
// (backend/scripts/lib/claude_hooks.py's _ACCOUNT_OVERRIDE_VARS) — either one, if dragged in
// ambient from some imported module's dotenv load, makes the child bill a DIFFERENT account than
// the session's own CLAUDE_CONFIG_DIR.
const ACCOUNT_OVERRIDE_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

/** `process.env` minus the account-override vars — the JS twin of clean_claude_env(). */
export function cleanClaudeEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of ACCOUNT_OVERRIDE_VARS) delete env[key];
  return env;
}
