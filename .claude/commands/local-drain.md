---
description: Run the autonomous LLM-orchestrator restricted to LOCALLY-EXECUTABLE plans — the two oracle lanes, both drain-claimable. Sonnet-lane plans are dispatched to Sonnet workers (worker tier follows the execModel stamp, plan 2567) exactly as /orchestrate; fable-lane plans (execModel: fable) are executed by THIS session inline under the thin-orchestrator doctrine, heavy-model sessions (Fable/Opus) only. A THIRD lane, execModel: sol (plan 3341, drain-claimable since plan 3461), is admitted under either oracle run and executed inline the same way as fable, with codex exec dispatches standing in for Sonnet subagents. Every plan stamped `cloudExec: true` is excluded in both dispatched lanes — left for the scheduled cloud drains. Identical loop, pacer, journal, and guardrails to /orchestrate. Runbook: docs/coord/local-drain-loop.md.
---

# /local-drain

**Read `docs/coord/local-drain-loop.md` now and follow it exactly.** That file is the complete
runbook — the two-lane local-only filter (`sol`, plan 3341's third lane, is drain-claimable
since plan 3461 and is admitted lane-agnostically under either oracle run), the inline
fable/sol-lane execution path, the batch-train path, and the boundary notes. It in turn sends you to
`docs/coord/orchestrator-loop.md` for everything it does not override. This command file is a
pointer stub and carries no doctrine of its own.

User invocation: `$ARGUMENTS` — pass it straight into the runbook's argument slot (a budget
override like `--dispatch-ceiling 70`, or a plan-id allowlist that INTERSECTS with the local-only
filter, never widens it).

> Why the split (plan 2694): an unattended cloud drain freezes on an unanswerable `safetyCheck`
> ask when it writes under `.claude/**`, and `scripts/stamp-cloud-exec.mjs` refuses a
> `cloudExec: true` stamp on any plan whose body names a `.claude/` path. Keeping the doctrine in
> `docs/coord/` means future orchestration plans stay cloud-drainable. Add doctrine THERE,
> never back into this stub.
