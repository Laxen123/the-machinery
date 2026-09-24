# the-machinery

## What is this?

the-machinery is a coordination layer that lets many Claude Code sessions work on one repository
at the same time without stepping on each other. It turns the repository into a work queue.
Each piece of work is a plan file. A session claims a plan, works on it in its own git
worktree, gets the change reviewed, and lands it on the main branch in turn. Everything is
plain files and git: no server, no database.

This is a one-time, MIT-licensed snapshot of a system extracted from a real project. It is not
kept in sync with that project.

## Why use it?

- **Run autonomous loops at scale.** Manage 20+ Claude Code sessions working the same
  repository concurrently, each on its own plan.
- **Develop around the clock.** Local sessions and Anthropic cloud sessions draw from the same
  queue, so work keeps moving 24/7, including while you are away from your machine.
- **Context that finds the session.** In a large repository no session can read everything,
  and a session that guesses gets things wrong. A wiki holds the durable knowledge (how a
  subsystem works, why a decision was made), and hooks inject the right page on their own:
  when a prompt names a subject from a page's aliases, or when a session touches a file under a
  page's trigger paths. A page is injected once, not on every turn, and sessions write back what
  they learn, so knowledge builds up instead of being worked out again each time.
- **Teamwork across people and machines.** Claims, the landing queue and the plan board live
  in the shared git remote, not on one computer. Several people, each running their own agents
  on their own devices, see the same claims and the same queue, and every claim records which
  machine holds it. All it needs is a git host everyone can push to.
- **A real structure for plans.** Plans work like tickets with a life cycle: a fresh plan waits
  for approval, gets a spec review, moves to ready, is claimed and worked, and is archived when
  it lands. Plans blocked on another plan, a date, an outside event or a human decision each
  wait in their own lane, so the ready list only ever holds work that can start now.
- **No double work.** An atomic claim means two sessions can never pick up the same plan.
- **The main branch stays healthy.** Finished work lands one at a time through a queue, and each
  land runs the gates first, so parallel sessions never race each other into a broken merge.
- **A review workflow built in.** Before a change lands, a fan-out review runs: several finder
  agents each look at the diff from a different angle, a verifier checks every candidate
  finding, and a stronger model re-judges any finding a verifier rejects. The verdict is recorded
  against the exact commit, and each finding must be fixed, moved to its own plan, or consciously
  waved before the land goes through. A round cap stops fix-and-re-review loops that no longer
  converge.
- **Guardrails for agents.** Hooks stop common agent mistakes before they happen: writing in
  another session's worktree, putting coordination state on a feature branch, or looping on
  review rounds that no longer converge.
- **The right model for each job.** Plans carry a lane, so cheap models do bulk work and heavy
  models do planning and judgment.
- **You stay in charge.** Questions only a human can answer are parked in their own lanes and
  batched for you, instead of blocking a session or being guessed.
- **State you can read.** Where a plan sits is its status, so you and every agent can see what
  is happening without asking the session that last touched it.

## What it gives you

- Plan lanes under `docs/superpowers/plans/` (`pending-approval → ready → in-progress →
  archive`, plus `waiting-*` parking lanes) instead of an ad-hoc TODO list.
- `claim-plan` — a ref-CAS claim so two parallel sessions never grab the same plan.
- `cut-worktree` / `done-worktree` — an isolated git worktree per plan, merged back through a
  FIFO landing queue (`landing-queue.mjs`) so parallel lands don't race the shared checkout.
- Guard hooks (`scripts/hooks/*`) that keep a worktree branch from silently writing
  coordination state that belongs on `master`.
- Coordination skills under `coord/skills/` (`pickup-plan`, `done-worktree`, `board-pass`,
  `spec-pass`, …) and slash commands under `.claude/commands/`.
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

## Setup

Follow these steps once, in order, to start using the kit. It folds in what used to be a
separate "Quick start" — read it start to finish the first time.

**1. Check prerequisites.** See [Prerequisites](#prerequisites) above — Node, git, pnpm, and
the Superpowers plugin are required; Codex CLI, Playwright, and Obsidian are optional.

**2. Get the kit.** Clone this repository:

```
git clone <this-repo-url> coord-kit
```

**3. Adopt it into your project.** From inside the cloned kit, point `coord-init.mjs` at your
project — a brand-new repo or an existing one both work the same way:

```
node scripts/coord/coord-init.mjs --target /path/to/your-project
```

Add `--dry-run` first to preview what it would write with nothing touched, and `--json` for a
machine-readable summary. It creates the plan lanes, `docs/handoff/board.md`, `docs/INDEX.md`,
a default `coord.config.json`, and merges the hooks into your project's `.claude/settings.json`
— an existing entry is never overwritten, only added to. Pass `--no-wiki` to skip the wiki
layer. It is idempotent: run it again any time, and a second run reports zero created, zero
merged.

**4. Install dependencies and hooks.** In your project:

```
pnpm install
```

This also runs the `prepare` script, which runs `husky` — it points git at `.husky/`, so the
shipped pre-commit / pre-push / post-checkout / pre-rebase gates now run automatically.

**5. Make the skills and commands visible to Claude Code.** `coord-init.mjs` copies the skill
files to `coord/skills/**` in your project — the same folder they live in here — not to
`.claude/skills/`, which is the path Claude Code reads a project's own skills from. Copy them
there yourself:

```
mkdir -p .claude/skills
cp -r coord/skills/*/ .claude/skills/
```

The slash commands are already in the right place — `coord-init.mjs` copies
`.claude/commands/*.md` directly, so `/gpt-review`, `/landing-queue`, and the rest work as
soon as you adopt.

**6. Set the config keys a new project wants first.** Everything lives in `coord.config.json`
at your project root; a freshly adopted one sets only the handoff layout, the spend ceiling,
and an empty plugin table — every key below takes its own code default until you add it.
Worth deciding before your first plan:

- `mutationBanner` — the `{ "label", "flag" }` pair every plan body carries for a change
  that mutates your data store. Defaults to `DATA-WRITE` / `--data-write`.
- `lanes` — the plan-status folder names, if you want something other than the shipped
  `ready`, `in-progress`, `waiting-blocked`, and the rest of the default set.
- `gitPatEnvVar` — the name of the environment variable holding a git push token, read by a
  cloud drain that pushes on your behalf. Defaults to `GIT_PUSH_TOKEN`.
- `codexAuthEnvVar` — the name of the environment variable holding a Codex/ChatGPT login
  blob, used by the `sol` executor lane and `/gpt-review`'s cloud self-bootstrap. Defaults
  to `CODEX_LOGIN_B64`.
- `cloudRepos` — extra repositories a cloud drain may clone alongside this one. Empty by
  default.

None of these block a first local plan — they matter once you run a cloud drain, or want a
different plan-body banner or lane names.

**7. Verify it works.** From the kit checkout:

```
node scripts/coord/smoke.mjs
```

This builds its own disposable demo repo, adopts the kit into it exactly as step 3 does, and
drives all seven coordination steps — mint, claim, cut, commit, review, land, assert — end to
end. Exit 0 means the whole loop works.

**8. Run your first plan.** In your adopted project, the mint → pickup → work → review →
land loop is five commands. Run them from your project root: every coordination command acts
on the git repository of the folder you run it in, and several of them push to its remote.

```
node scripts/next-plan-id.mjs claim --category Other --slug my-first-plan --body <file>
/pickup-plan <id>
# ... do the work in the worktree it creates ...
/gpt-review              # or /sonnet-review — then node scripts/record-review.mjs PASS
node scripts/done-worktree.mjs <slug>
```

**9. Do you want to run plans in the cloud?** Everything above works entirely on your own
machine. If that is all you need, skip this step.

If you want Claude Code cloud sessions (claude.ai/code) to pick up and land plans for you,
connect this repository first:

1. From [claude.ai/code](https://claude.ai/code), install and authorize the Claude GitHub
   app for this repository — this is what lets a cloud session clone it and push branches
   back. If you are unsure which control does this, look for the step that connects a
   specific GitHub repository to Claude Code, not a whole account.
2. Create a cloud environment for this repository from the same site.
3. In that environment's variables, set what the kit's cloud path actually reads:
   - The variable named by `gitPatEnvVar` in `coord.config.json` (`GIT_PUSH_TOKEN` by
     default) — a GitHub token with push access to this repo. Anthropic's cloud git proxy
     blocks the coordination refs a cloud session needs to push (a plan claim, its
     release); `scripts/coord/ensure-coord-reroute.mjs` reads this token at push time to
     reroute around that block. Without it, a cloud session can still push an ordinary
     branch but can never claim or land a plan.
   - Optionally, the variable named by `codexAuthEnvVar` (`CODEX_LOGIN_B64` by default) —
     a base64-encoded Codex/ChatGPT login, only if you want `/gpt-review`'s codex lane to
     work in the cloud too. Without it, a cloud review falls back to `/sonnet-review`
     instead.

If a plan's work genuinely spans more than this one repository, register the extra repo as
a row in `coord.config.json`'s `cloudRepos` array first — `scripts/coord/cloud-repos-lib.mjs`
and `queue-drain.mjs` are what read it — and stamp that plan with its own `cloudRepos:` key
so a cloud session knows to clone it too.

## License

MIT — see `LICENSE`.

---

extracted from the project at aaa08a3dfaff8737487af558a37057c832cd31e0 on 2026-09-24; not synced afterwards
