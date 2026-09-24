# the-machinery

A one-time, MIT-licensed snapshot of a generic multi-agent coordination layer: plan lanes,
ref-CAS claims, git worktrees, a FIFO landing queue, a deterministic land spine, guard hooks,
a dozen coordination skills, and the slash commands that drive them. Extracted from a project
that runs 5-7 parallel Claude Code sessions against one shared checkout.

## What it gives you

- Plan lanes under `docs/superpowers/plans/` (`pending-approval → ready → in-progress →
  archive`, plus `waiting-*` parking lanes) instead of an ad-hoc TODO list.
- `claim-plan` — a ref-CAS claim so two parallel sessions never grab the same plan.
- `cut-worktree` / `done-worktree` — an isolated git worktree per plan, merged back through a
  FIFO landing queue (`landing-queue.mjs`) so parallel lands don't race the shared checkout.
- Guard hooks (`scripts/hooks/*`) that keep a worktree branch from silently writing
  coordination state that belongs on `master`.
- Coordination skills under `coord/skills/` (`pickup-plan`, `done-worktree`, `board-pass`,
  `handoff`, …) and slash commands under `.claude/commands/`.
- An optional wiki layer (`WIKI.md`, `wiki/`) for durable subject knowledge the plan/runbook
  layers cannot hold.

## Prerequisites

You already run Claude Code, so this only lists what the kit needs on top of it.

**Required:**

- Node 22.6.0 or newer.
- git.
- pnpm, enabled via `corepack enable`.
- The Superpowers plugin for Claude Code — `pickup-plan` calls its `writing-plans`,
  `executing-plans`, and `subagent-driven-development` skills, and the plan lanes live under
  `docs/superpowers/`.

**Optional:**

- Codex CLI with a ChatGPT subscription — powers `/gpt-review`, the `sol` executor lane, and
  the `codex exec` steps in batch-train, spec-pass, pickup-plan, and cloud-routines. Without
  it, use `/sonnet-review` instead.
- Playwright — used by spec-pass checks and `/audit-with-verification`.
- Obsidian — for browsing the `wiki/` vault; the wiki works without it.

## Quick start

**New repo:** `node scripts/coord/coord-init.mjs --target <path>` — creates the plan lanes, a
default `coord.config.json`, the board/INDEX skeletons, and merges the generic hooks into
`.claude/settings.json` (never overwriting an existing entry).

**Existing repo:** the same command adopts into it — anything already present with different
content is left alone and reported `skipped-differs`.

Then: `node scripts/coord/smoke.mjs` proves the whole loop (mint → claim → cut → commit →
review → land) end to end in a throwaway temp repo.

## License

MIT — see `LICENSE`.

---

extracted from the project at 50cfebc2a9b3a02dffafd4e4fc8700992cb34146 on 2026-09-24; not synced afterwards
