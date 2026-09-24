#!/usr/bin/env bash
# PreToolUse Edit|Write|MultiEdit hook — Tier 1 of plan 977. Keeps the shared MAIN
# checkout clean: DENIES an edit to a non-allowlisted, non-gitignored path on the
# main checkout (forcing it into a worktree), so loose dirt can't wedge coord/land
# ops (the plan-956 / plan-961 incidents). Worktree edits, allowlisted bookkeeping
# (plans/specs/handoff/INDEX/wiki + .claude config), and gitignored scratch are
# allowed; a deliberate one-shot fix on master is allowed via CLEAN_MAIN_AUTHORIZED=1.
#
# All logic + the single shared allowlist live in the node module (guaranteed
# present; no `jq`). The module reads the PreToolUse payload from stdin, prints the
# deny JSON to stdout on a block, and is empty + exit 0 on allow. `$(dirname "$0")`
# locates the repo so this works regardless of the hook's working directory.
exec node "$(dirname "$0")/../main-checkout-clean-guard.mjs"
