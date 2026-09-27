---
description: Run the autonomous LLM-orchestrator — an Opus brain that drains the ready/-plan queue within the 5-hour usage window, dispatching supervised workers whose tier follows each plan's execModel stamp (Sonnet for sonnet-lane singles, plan 2567), verifying their diffs, fix-now-triaging findings (plan 2531), landing via the deterministic spine (NEVER deploying), and parking un-decidable forks. A THIRD lane, execModel: sol (plan 3341, drain-claimable since plan 3461), is claimed lane-agnostically under either oracle run and executed inline by THIS session under the thin-orchestrator doctrine, with codex exec dispatches standing in for Sonnet subagents. Window-paced, never-blocks. Budget from scripts/orchestrator-budget.mjs; journal at .scratch/orchestrator-state.json. Runbook: docs/coord/orchestrator-loop.md.
---

# /orchestrate

**Read `docs/coord/orchestrator-loop.md` now and follow it exactly.** That file is the
complete runbook — operating contract, bootstrap, the loop, parking, window-stop, guardrails,
validation modes. This command file is a pointer stub and carries no doctrine of its own.

User invocation: `$ARGUMENTS` — pass it straight into the runbook's argument slot (a budget
override like `--dispatch-ceiling 70`, or a space-separated plan-id allowlist).

> Why the split (plan 2694): an unattended cloud drain freezes on an unanswerable `safetyCheck`
> ask when it writes under `.claude/**`, and `scripts/stamp-cloud-exec.mjs` refuses a
> `cloudExec: true` stamp on any plan whose body names a `.claude/` path. Keeping the doctrine in
> `docs/coord/` means future orchestration plans stay cloud-drainable. Add doctrine THERE,
> never back into this stub.
