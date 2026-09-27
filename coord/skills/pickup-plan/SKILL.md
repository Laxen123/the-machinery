---
name: pickup-plan
description: Use when continuing, executing, or starting work on a written plan from docs/superpowers/plans/ (or equivalent). Claims the plan via a handoff.md entry BEFORE work begins so parallel agents reading /state know it's taken, creates an isolated worktree, then on completion returns to the handoff to record what shipped. Triggers - "pick up plan X", "continue plan Y", "execute plan Z", "/pickup-plan", "let's work on the vetpris plan".
---

# pickup-plan — claim a plan, work in isolation, close the loop

The point of this skill is the **lock**, not the worktree. Multiple Claude sessions can run against the same repo concurrently. Without an explicit claim in `handoff.md` (and pushed to origin), two sessions can pick up the same plan and silently double-work. The handoff entry pushed BEFORE the worktree is created is the lock that `/state` surfaces.

## Lazy-loaded references

Read this when the procedure points to it:

- `batch-train/references/claim-land-spine.md` — the canonical claim(ref-CAS)+land(deterministic-spine)
  model this skill's step 0 and step 11 implement (plan 1373 D7; also cited by `batch-train`). Read it
  for the WHY behind the ref-CAS semantics and the `done-worktree` sequence; this file stays the
  the project-specific HOW (the literal commands below aren't restated there).

## Dispatching from an Opus orchestrator (preferred when running a plan on Opus)

Pickup is mechanical bookkeeping — no deep reasoning needed. When an Opus orchestrator is about to pick up a plan, dispatch steps 1–6 to a **Sonnet subagent at Medium effort** to keep the SKILL.md body, the plan file, and the procedural Bash output out of Opus's context. Saves ~$1 per pickup + a cleaner orchestrator context for the plan execution that follows.

**The split:**

- **Subagent (Sonnet, Medium effort) does steps 1–6**: identify plan → check claim (board state + liveness) → atomic handoff/INDEX/`git mv` commit + push → `git worktree add` → push empty branch. **Returns:** `{ slug, branch, worktree_path, plan_path, claim_sha }`.
- **Orchestrator (Opus) does the FIRST ACTION + step 7 onward**: the clipboard `/rename` copy (FIRST ACTION above) fires **before the dispatch** — the plan id is already known at that point, and the subagent CANNOT do it (only the orchestrator's title is the one the operator sees). When the subagent's JSON returns: verify the clipboard copy actually happened (step 7.5 checkpoint), then one `cd .claude/worktrees/<slug>` (the subagent's cwd doesn't propagate back), then step 8 (`pnpm install`), then plan execution proper.

**Dispatch shape** (per global CLAUDE.md: pass `model` explicitly):

```
Agent({
  subagent_type: "general-purpose",
  model: "sonnet",
  description: "Pickup-plan claim ritual",
  prompt: "Think at medium effort. Invoke the pickup-plan skill and execute steps 1–6 ONLY (identify → check claim → atomic claim commit + push → worktree create + empty-branch push). STOP after step 6 and return JSON: { slug, branch, worktree_path, plan_path, claim_sha }. Plan to pick up: <plan-name>. Host: <hostname>. Session N: <N>."
})
```

**When NOT to dispatch:** plans short enough that the ~30–60s subagent spin-up isn't earned back (~<15-turn executions), or when the orchestrator is already Sonnet/Haiku.

## When to use

- You've been asked to continue, execute, start, or "pick up" a written plan (a file in `docs/superpowers/plans/` or equivalent)
- The work spans more than one trivial commit (otherwise just do it on master)
- There is any chance another Claude session is active in the repo

**Do NOT use for:**

- One-shot fixes landing in a single commit
- Plans already marked in-progress in the current handoff (surface the conflict, don't double-pick)
- Plans without a written file — write the plan first via `superpowers:writing-plans`

## Project conventions vary

Plan naming, subfolder usage, and prefix tags differ between projects. This skill describes the project's conventions (`NNN-PX-Description.md`, `plans/in-progress/`, etc.). Adapt to the project's own scheme — keep the _flow_ (lock → atomic claim → worktree → push every commit → completion → done-worktree), substitute the surface details.

## Plan-state subfolder convention (when the project uses it)

| Folder                      | Meaning                                                                                                                                                                                                                        | Pickup-able?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans/pending-approval/`   | DEFAULT fresh-mint holding folder (plan 1371 — supersedes the retired `drafting/`) — every mint rests here, un-routed, until a board-pass/spec-pass stamps it `specced` and routes it out (`ready/` or the right `waiting-*/`) | Yes, as an operator-directed override — `acquire` finds it via `activePathFor` and promotes `pending-approval/` → `in-progress/`, same as `ready/`. The NORMAL exit is board-pass/spec-pass, not a direct pickup. **Gate 2 (plan 1427): `acquire` REFUSES a `stage: stub` plan with no `specReview`** — the operator-directed override is explicit: `--stub-ok "<operator authorization note>"`, recorded verbatim in the claim projection's `**Override:**` line. Only use it when the operator explicitly wants a not-yet-specced stub worked now; a session must NEVER `--stub-ok` its own fresh mint (that is exactly the plan-1412 incident the gate exists to stop). |
| `plans/` root (or `ready/`) | RELEASED for the orchestrator / any session to pick up                                                                                                                                                                         | Yes — claim freely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plans/in-progress/`        | A worktree branch is alive (active or paused)                                                                                                                                                                                  | No — already claimed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `plans/waiting-blocked/`    | Blocked on an upstream plan archiving                                                                                                                                                                                          | No — wait for `done-worktree` to promote it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plans/waiting-grill/`      | Parked for a BATCHED operator-grilling sitting (plan 2034) — the plan's correctness criteria live in the operator's head, so its open questions were written into a `## Grill questions` section instead of being asked inline | Only after the questions are answered. The normal exit is a `/grill-lane` session recording `## Operator rulings`; `move-plan <id> ready` is refused without them. Claiming it in place leaves the questions open — don't, unless the operator explicitly directs it                                                                                                                                                                                                                                                                                                                                                                                                       |
| `plans/waiting-date/`       | Calendar trip (e.g. quarterly re-probe)                                                                                                                                                                                        | Only if the date has arrived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plans/waiting-trip/`       | External trip-condition (queue accumulation, user report, etc.)                                                                                                                                                                | Only if the condition has fired                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `plans/parked/`             | Long-term freezer (plan 1426) — alive and resurrectable but deliberately excluded from every scan (INDEX, board-pass, drain, claim)                                                                                            | Never directly — `activePathFor` cannot resolve it. Un-park first (`move-plan <id> <lane>`), then claim normally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plans/archive/`            | Shipped or closed                                                                                                                                                                                                              | Never                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Detect by checking which subfolders exist. If none, treat as flat (root only) and skip the `in-progress/` `git mv` in step 5.

---

## Steps

### FIRST ACTION — copy `/rename <plan-id>` to the clipboard, before anything else

The moment this skill fires, copy the rename command to the OS clipboard and surface the paste nudge — BEFORE the claim ritual, before any git command, before reading the plan body. If the invocation named the plan (`pick up plan 517`, `/pickup-plan 517-DQ-…`), the id is known at launch — fire immediately. If no plan was named, fire as soon as step 1 identifies it (that's the only thing allowed to come first).

**The skill cannot fire `/rename` itself** — it's a built-in, and built-ins are not programmatically dispatchable (only custom slash commands are); `sessionTitle` is settable only by a `SessionStart` hook on `source: startup|resume`, never mid-session; and no hook can pre-fill the input box. Don't burn time on the SlashCommand tool, a `UserPromptSubmit`/`UserPromptExpansion` hook, `terminalSequence`, or the session-state file — none can retitle a _live_ session or draft the input (verified against the Claude Code docs). The lowest-friction path is the clipboard:

```bash
# Windows (operator's platform; Set-Clipboard adds no trailing newline):
powershell -NoProfile -Command "Set-Clipboard -Value '/rename <plan-id>'"
# macOS:  printf '%s' '/rename <plan-id>' | pbcopy
# Linux:  printf '%s' '/rename <plan-id>' | (wl-copy 2>/dev/null || xclip -selection clipboard)
```

```
📋 Copied  /rename <plan-id>  to your clipboard — paste (Ctrl+V) + Enter to rename this session.
```

`<plan-id>` = the id the operator picked up (e.g. `308`), or the slug for a fuller label. This must run from the **user-facing orchestrator session** — never a dispatched subagent (only the orchestrator's title is the one the operator sees). Skip ONLY if the operator already renamed the session, or if pickup is running headless (no clipboard / no operator to paste).

### 0. Acquire the atomic claim lock (ref-CAS) — PREFERRED when `scripts/claim-plan.mjs` exists (the project, plan 368)

The source of truth for "who holds this plan" is the git ref `refs/heads/coord/claims/<id>` (moved off the flat `refs/claims/<id>` by plan 3756 — a cloud sandbox's mandatory proxy hard-403s that legacy namespace; legacy refs are still read during the migration window). Acquire it FIRST — an atomic compare-and-swap on the plan identity, so two sessions claiming the same plan can't both win (unlike the board-row append, which has no such gate). Identify the plan (step 1) and derive its `<slug>` (step 3 — kebab of the basename) first, then:

> **Run `acquire` even when the plan already looks claimed by you.** The single most damaging skip (the 2026-06-22 953/924 same-tree collision) is to see a plan already in `in-progress/` with an ACTIVE board row and a session-entry stub, conclude "that is my own earlier claim, I'll just resume," and start working WITHOUT acquiring. A projected claim is exactly what a sibling's live lock looks like from outside; it is never proof the lock is yours. So always run `acquire` (or, for a paused-plan resume, `claim-plan.mjs status <id>`) and act on its result per the two bullets below, before you touch a worktree or any file.

```bash
node scripts/claim-plan.mjs acquire <plan-id|basename> --slug <slug> --seed-write yes|no
```

- `{"won":false,…}` → another session holds it. **STOP, unconditionally. Never reinterpret this as your own resume.** The JSON `holder` names the session/host/time; pick another plan and write nothing. Three traps that make a held plan feel like yours: (1) the CAS-minted session NUMBER is independent of your session TITLE, so "a session-N claim exists on plan X" means _a_ session holds it, not that _you_ do; (2) a fresh claim whose `host` matches your OWN machine is a LIVE sibling, not you (the 6h-stale gate detects crashes, not concurrency); (3) the projected board / INDEX / `in-progress/` state is what a sibling's claim looks like, never proof it is yours. To treat work as YOUR resume you must POSITIVELY own it: you ran `acquire` THIS session and got `{won:true}`, or `claim-plan.mjs status <id>` reports `youAreHolder: true` (plan 958). Belt-and-suspenders since plan 958: the `worktree-owner-guard` PreToolUse hook physically blocks a write into a worktree a different session owns, so even a mis-read here can't corrupt the holder's work.
- `{"won":true,…}` → you own the lock. The tool ALREADY minted your session number (CAS counter — no 329/330/331 scramble) and projected the claim onto master via the race-safe tools: board ACTIVE row, body Status flip + `git mv` to `in-progress/`, INDEX repath, and a session-entry stub. **Steps 2 and 5 are DONE — skip to step 6** (create the worktree). Flesh out the session-entry stub at completion (step 10).

`release-claim.mjs` frees the ref on land (wired into `done-worktree`) or abandon; `reconcile-board.mjs` reports ref↔board drift. Model: `docs/coord/claims.md`.

**No-script fallback** (sibling subprojects / no `scripts/claim-plan.mjs`): use the manual steps 2 + 5 below — the optimistic board-row claim with the GATE probe.

**⚠️ Resuming a `waiting-*/` or ⏸ PAUSED plan (operator override).** (Not to be confused with the `parked/` FOLDER — a `parked/` plan is un-parked via `move-plan` first, never claimed in place.) The full `acquire` above handles a waiting-lane resume **directly — no `--lock-only`, no manual projection.** It resolves the plan via `activePathFor`, which searches **every claimable folder** (`ready/`, `pending-approval/`, and all `waiting-{blocked,operator,grill,date,trip}/`) — there is no `ready/`-only restriction (the old `readyPathFor`-throws-on-waiting behavior is gone). On `{won:true}` it projects exactly as a fresh claim: git-mv to `in-progress/`, body Status → `🔄 IN PROGRESS` (auto-stamping an `**Override:**` note recording the `waiting-*/` gate it satisfied), board ACTIVE row, INDEX repath, and a session-entry stub. So run the **same `acquire`** as for a `ready/` plan; steps 2 + 5 are then DONE — skip to step 6.

The one thing `acquire` does NOT do is judge whether the gate may be bypassed — it claims unconditionally. So for a `waiting-operator/` (or any gated) plan, **confirm the operator green-light yourself BEFORE running `acquire`** — that human judgment is the whole reason the plan was parked. The auto-stamped `**Override:**` note is generic; if the specific reason matters for the audit trail, enrich it afterward with `scripts/edit-plan.mjs`.

**Invariant: a plan you are actively working MUST end in `in-progress/` with a `🔄 ACTIVE` board row.** A clean `acquire` (NOT `--lock-only`) guarantees this. The ONLY way to strand a plan in `waiting-*/` is to reach for `--lock-only` (tests/dogfood only) and then skip the projection it omits — so don't (the 2026-06-07 session-376 stranding). If you ever do `--lock-only`, you OWN the full projection: flip Status + `**Override:**` (step 5c) → `move-plan <id> in-progress` → `board.mjs update <slug> --state ACTIVE` → write the `docs/handoff/sessions/<date>-session-<N>.md` entry.

**`--lock-only` is a footgun.** It acquires the ref and projects nothing — no folder move, no board, no INDEX, no session entry. It exists for tests / the dogfood. **NEVER use it for a real pickup unless you immediately do the manual projection above; if you `--lock-only`, you OWN the projection.**

**⚠️ TAKING OVER a plan already in `in-progress/` (a dead holder) — use `--resume`, never `--lock-only` (plan 2353, 2026-07-25).** A plain `acquire` cannot resolve an `in-progress/` plan (that refusal is deliberate: a free claim ref on an in-progress plan means the holder died, and only an explicit takeover should proceed) — worse, it WINS the ref-CAS and then rolls it back, so the failure is not a clean up-front refusal. The takeover is two deliberate steps:

1. **Confirm the holder is actually dead, then free the ref yourself:** `node scripts/release-claim.mjs release <id> --force`. This is deliberately NOT part of `--resume` — the "is it really dead?" call is operator judgment (a cloud session's environment can be gone while its claim looks fresh; check `claim-plan.mjs status <id>` and, for a cloud holder, the session's own event log via `/cloud-stalls`).
2. `node scripts/claim-plan.mjs acquire <id> --slug <slug> --seed-write … --resume` — projects the takeover through the SAME atomic sanctioned path a fresh claim uses (board ACTIVE row, INDEX regen, a `**Takeover:**` line in the plan body, and the new session-entry stub), skipping only the `git mv`. Steps 2 + 5 are then DONE — skip to step 6.

`--resume` and `--lock-only` are mutually exclusive and `acquire` refuses both together. If your takeover slug differs from the dead holder's, `--resume` adds a row for the NEW slug and **demotes the superseded row to `⏸ PAUSED` inside the SAME projection commit** (plan 2394), stamping its Resume cell `superseded by <new-slug> (takeover <date>)` — nothing to do by hand. The row is never removed or renamed, so the old worktree still survives its own teardown. **Two classes are deliberately spared** and still print the `board.mjs set-state <slug> PAUSED` line for you: a row carrying a `` · batch=`…` `` marker (a LIVE batch member, plan 1364 — demoting it would detach it from a running train) and a `🟢 LANDING` row (that row IS the cross-session land mutex). If one of those is genuinely stale, confirm it is dead and demote it yourself.

Before plan 2353 this case had NO sanctioned route: `--lock-only` plus a hand-rolled projection, whose new session-entry file `coord-edit.mjs` refuses (untracked) and the pre-commit coord guard blocks — leaving `BOARD_GUARD_OVERRIDE=1`, itself classifier-denied without an explicit operator instruction. If you are on a checkout predating plan 2353, that old recipe is in the project `docs/coord/claims.md`.

### 1. Identify the plan

If the user named one, find the matching file across active subfolders (NOT archive). If a partial match ("vetpris"), pick the most recent; if multiple, ask. If no name was given, list active plans with their subfolder so the operator can see ready-to-start vs blocked/trip-gated/in-progress at a glance.

Folder semantics:

- `plans/` root / `ready/` / `pending-approval/` (the project's default fresh-mint holding folder since plan 1371, superseding the retired `drafting/`) → claim freely
- `plans/in-progress/` → step 2's gate
- `plans/waiting-*/` → don't claim without confirming the gate is met; surface to operator, let them override explicitly

Read the plan top-to-bottom before claiming. Note: what it ships, cost/wall-time, parallelisable sub-tracks, dependencies on other plans, **and any project-specific markers** (the project: `🟥 SEED-WRITE` — two SEED-WRITE plans can work in parallel but must serialize their merge).

**Subject knowledge (before the first edit, not just the plan):** if the project keeps subject pages (a wiki — the project: `wiki/index.md` catalog, `wiki/hot.md` recent context), map the plan's subject to its page and read that page IN FULL before your first edit. The plan carries the _what_; the subject page carries the _why_ and the burn-list of invariants that bite. A plan body's own `> Read first` line, if present, names the exact pages. Don't rely on hook auto-injection alone — it delivers a page, but reading it in full is on you.

### 1.5. Detect plan-subfolder convention ONCE per session

```bash
ls -d docs/superpowers/plans/in-progress docs/superpowers/plans/ready \
       docs/superpowers/plans/waiting-blocked docs/superpowers/plans/waiting-date \
       docs/superpowers/plans/waiting-trip 2>/dev/null
```

Remember the result for the rest of this session — DON'T re-run this `ls` sweep at every subsequent step. Audit of 20 sessions: this exact orientation-ls fired ~55× per session because the skill body re-prompts it at every gate. Run once, cache mentally, branch your flow on the result. If `in-progress/` exists → step 5d is in scope; if `ready/` exists → step 1 lists from there; if `waiting-*/` exist → step 2 surfaces them as not-pickup-able.

### 2. Check for existing claim — board state first, timestamps second

> **Superseded by Gate 0** when `scripts/claim-plan.mjs` exists (the ref-CAS acquire IS the atomic check). The body below is the no-script fallback.

Open `docs/handoff/board.md` (the dedicated active-worktree board; the project extracted it from `handoff.md` on 2026-05-27 to keep gate-check reads small). Fall back to `handoff.md` only if the project hasn't extracted the board yet — the `## Active worktrees` table at the top of `handoff.md` is the legacy single-file location. The board is the primary signal:

- **🔄 ACTIVE row exists** → another session is working on it. STOP. Surface conflict.
- **⏸ PAUSED row exists** → the operator paused it explicitly. NOT stale — has a stated `Resume condition`. Surface and ask whether to take over.
- **🟢 LANDING row exists** → mid-merge to master. Do NOT start a parallel merge.
- **No board row, but a per-session entry references the plan** → fall to the timestamp heuristic below.

Liveness fallback (when the board is missing or ambiguous) — per-session entries still live in `handoff.md`:

```bash
git log -1 --format=%cI <branch-name>      # last commit on the plan's worktree branch
git log -1 --format=%cI -- handoff.md      # last handoff edit
```

Take the more recent of the two. **<6h** → assume live, STOP and surface. **≥6h** → likely stale; surface to operator, take over only after explicit approval.

Same gate applies when reading `/state` output: a fresh IN PROGRESS entry (<6h) means hands off.

### 2.5. Rename if the slug misleads (optional)

If the filename no longer describes the work, rename NOW — before slug derivation in step 3. Branch + worktree dir are baked from the slug; renaming later means branch-rename + dir-move churn.

```bash
git mv docs/superpowers/plans/<old>.md docs/superpowers/plans/<new>.md
```

Keep the `NNN-PX-` prefix verbatim — only the descriptive part changes. Renaming NNN means a new plan, not a rename. In the same commit, update: plan body H1 (if it spells the title), `docs/INDEX.md` entry, in-body cross-refs, and `grep -r '<old-slug>' docs/superpowers/plans/` hits in sibling plans.

When NOT to rename: cosmetic preference, existing handoff/Issue/chat references point at the old name, or the scope is actually _different_ (that's "wrong plan" — STOP and surface).

### 3. Pick the slug and branch name

**Vetapp convention:** `NNN-PX-Plan Description.md` where `NNN` is the monotonic plan ID and `PX` is the stage tag (`P07`, `P06b`, `ARCH`, `Other`). Slug = kebab-cased filename minus `.md`, **preserving the `NNN-PX-` prefix verbatim** (so `ARCH`, `P07`, `P06b` stay readable):

- `007-P07-Scrape Concurrency Sweep.md` → `007-P07-scrape-concurrency-sweep`
- Branch: `worktree-<slug>` · Worktree dir: `.claude/worktrees/<slug>`

Legacy date-prefixed plans keep the date as prefix (`2026-05-17-vetpris-targeted-retry`). Existing pre-convention worktrees stay as-is — don't rename live worktrees just for compliance.

Check `.claude/worktrees/` for prior directories of that name; if one exists from an abandoned run, surface and ask.

### 4. Capture the host

Multi-PC operators need this so `/state` from another machine can distinguish "live elsewhere" from "abandoned":

```bash
hostname     # cross-platform; on Windows PowerShell, $env:COMPUTERNAME also works
```

### 5. Claim atomically — handoff entry + board row + plan body flip + git mv + index pointer

> **Superseded by Gate 0** when `scripts/claim-plan.mjs` exists — `acquire` does this projection behind the ref lock. The body below is the no-script fallback.

All five must land in ONE commit. The folder location, the plan-body status line, the board row, the per-session entry, and the INDEX pointer are all read by different readers (folder = `/state`, body = direct opens, board = first-glance, INDEX = navigation) — drift between them is exactly what this skill exists to prevent.

**5.0. GATE probe — BEFORE any 5a-5e edits.** Run against the _clean_ working tree to detect a parallel session mid-flight on the shared paths. After your own edits, the regex can't distinguish your unstaged hunks from theirs, so the probe MUST run at the gate.

```bash
# At probe time (before any 5a-5e edits) we have made NO changes — any modification on a
# shared path is from another session, staged OR unstaged. Only `??` (untracked new file at
# that name, harmless) is acceptable. The old `[AM]M?` filter incorrectly passed staged
# modifications (`M `) through as "our own staged"; fixed to `^\?\?`.
# `docs/superpowers/plans` deliberately excluded — our own `git mv` of the plan file (step 5d) shows up there.
DIRTY=$(git status --porcelain -- handoff.md docs/handoff/board.md docs/INDEX.md 2>/dev/null | grep -vE '^\?\?' | head -5)
if [ -n "$DIRTY" ]; then
  echo "pickup-plan: GATE probe found unstaged changes on shared paths owned by another session:"
  echo "$DIRTY"
  echo "Another session (probably /done-worktree) is mid-flight. STOP — surface to operator before continuing."
  exit 1
fi
```

If the probe trips, **do not edit** — surface the dirty paths to the operator, identify which sibling session owns them, and wait for that session to commit its work before retrying. Re-running step 5.0 after the foreign work clears is the resume.

**5a. Write the session entry.** On the project `claim-plan.mjs acquire` already wrote this stub for you (Gate 0) — the template below is the no-script fallback, and it is verbatim the shape `sessionEntryStub()` emits, so a hand-written entry is indistinguishable from a generated one:

```markdown
# YYYY-MM-DD (session <N> — pick up plan <id>: <slug>)

**Status:** 🔄 IN PROGRESS — claimed via ref-CAS (`refs/claims/<id>`), worktree being created.
**Plan:** `docs/superpowers/plans/in-progress/<plan-file>.md`
**Host:** `<hostname>`
**Executor:** `<dispatch-mode>` · model `<model-id>`
**Branch:** `worktree-<slug>` · worktree `.claude/worktrees/<slug>`
**Seed-write:** 🟩 NO
```

**Two things here are machine-read; the rest is prose for humans.** The FILENAME must match `YYYY-MM-DD-session-<N>[a-z]*.md` or the entry is invisible to `/state` (`parseSessionFilename`), and the first `**Status:**` line's value becomes the generated index line's tail (`entryStatus`) — so keep it on ONE line and lead with the state emoji. Everything else you may extend freely: extra fields, sections, and the completion bullets from step 10 all ride along untouched.

- **If `docs/handoff/sessions/` exists (the project post-plan-205):** write the entry to a NEW file `docs/handoff/sessions/YYYY-MM-DD-session-<N>.md` (one file per session — no append-contention). This is a coordination path → it lives on master via `$MAIN` (see step 5f / the guard).
- **Else (legacy / sibling subprojects):** prepend the entry to `handoff.md` above the current top entry, as before.

Session N: read the most recent prior session number and increment. Same-day parallel sessions disambiguate with letter suffixes (`19b`, `19c`).

**5b. Add the new board row.** If `scripts/board.mjs` exists (the project post-plan-205), use it — it owns the atomic read→commit→push of `docs/handoff/board.md`, so you do NOT hand-edit or hand-stage the board:

```bash
node scripts/board.mjs claim <slug> --state ACTIVE \
  --plan-claim "\`<plan-file>.md\` · session N · host=\`<hostname>\`" --touched "YYYY-MM-DD HH:MM"
```

(`--tip` is filled later via `node scripts/board.mjs update <slug> --tip "\`<sha>\`"`once the worktree branch exists in step 6.) Because`board.mjs`already committed + pushed the board row on its own, **step 5f must NOT re-stage`docs/handoff/board.md`\*\* — see the caveat there.

If `scripts/board.mjs` is absent (legacy / sibling subprojects), fall back to manually inserting this row above the `<!-- BOARD-END -->` sentinel in `docs/handoff/board.md` (or the root `handoff-board.md` on legacy projects without the `docs/handoff/` tree), AFTER any existing data rows, then staging it in step 5f:

```markdown
| <slug> | `<tip>` | 🔄 ACTIVE | `<plan-file>.md` · session N claim `<sha>` · host=`<hostname>` | YYYY-MM-DD HH:MM | — |
```

If `handoff-board.md` itself doesn't exist (pre-extraction projects), fall back to single-write in `handoff.md` — create the board there if absent (heading + headers + this row at the very top of `handoff.md`). When reading the board from a different machine: a row whose `host=…` doesn't match the current PC is NOT a phantom — it's live elsewhere. `git fetch origin` before re-claiming.

**5c. Flip the plan body's `Status:` line:**

```markdown
**Status:** 🔄 IN PROGRESS — picked up YYYY-MM-DD by `<host>` in `worktree-<slug>`.
**Previous status:** <original Status: value, verbatim, for audit trail>
```

If the plan came from `waiting-*/` via operator override, add:

```markdown
**Override:** operator green-light YYYY-MM-DD — trip-condition '<X>' bypassed.
```

Without this, the gate disappears silently and future audits can't reconstruct why the plan ran before its trip fired.

**5d. `git mv` into `in-progress/`** (skip if project doesn't use the subfolder convention):

```bash
git mv docs/superpowers/plans/<plan-file>.md docs/superpowers/plans/in-progress/<plan-file>.md
# Or from a waiting-*/ subfolder if it's an operator override
```

**5e. Update the INDEX active bullet.** If `scripts/index.mjs` exists (the project post-plan-206), it owns the atomic INDEX edit — the bullet was added when the plan was filed (in `ready/`), so claiming just repaths it:

```bash
node scripts/index.mjs move <plan-basename>.md in-progress/<plan-basename>.md
```

(For a brand-new plan with no existing bullet, use `node scripts/index.mjs add "- 🟥/🟩 …blurb… → \`in-progress/<plan-file>.md\`"`.) Because `index.mjs`commits + pushes`docs/INDEX.md`itself, **step 5f must NOT stage`docs/INDEX.md`**. Fallback (no index.mjs): hand-edit the bullet's path token in `docs/INDEX.md` and stage it in 5f.

**5f. Lint-check BEFORE staging, then commit + push to master — BEFORE creating the worktree:**

```bash
# (1) Catch INDEX.md drift NOW, not at the pre-push hook
node scripts/lint-plan-index.mjs --check   # if absent, skip — projects without it just rely on the hook
# (2) Stage by EXPLICIT path — NEVER `git add <dir>`. Step 5d's `git mv` already staged the
# plan-file rename; a broad `git add docs/superpowers/plans` would ADDITIONALLY consume a parallel
# session's uncommitted plan rename living in the same dir (the 2026-05-28 race: a sibling's
# `done-worktree` ate this claim's ready→in-progress mv). Explicit paths can't reach a foreign file.
# If you used `board.mjs` in 5b, the board row is ALREADY committed + pushed —
# do NOT re-stage `docs/handoff/board.md` here. Stage the session entry
# (+ the plan rename, already staged by 5d's git mv):
#   - post-plan-205 (5a wrote docs/handoff/sessions/<file>): stage that NEW file, by name.
#   - legacy (5a prepended to handoff.md): stage handoff.md.
# If you used `index.mjs` in 5e, the INDEX bullet is ALREADY committed — do NOT re-stage `docs/INDEX.md`.
# Fallback (no index.mjs): add `git add docs/INDEX.md` before the commit.
git add docs/handoff/sessions/YYYY-MM-DD-session-<N>.md   # post-plan-205; OR `handoff.md` (legacy)
# [ -f docs/handoff/board.md ] && git add docs/handoff/board.md   # ← manual-fallback ONLY (board.mjs absent; legacy: handoff-board.md)
git commit -m "handoff: claim <plan-slug> (session N) — picking up <plan title>"
# (3) Push — if rejected non-fast-forward, `git pull --ff-only`, re-run lint, retry. Never `--amend` or `--force`.
git push origin master
```

**The push is the lock.** Until this is on origin, the claim is invisible. Do this BEFORE `git worktree add` — if worktree creation fails, the claim reverts cleanly in one commit. **Running the lint up-front is the cheapest way to dodge the most common parallel-session collision: a sibling session pushed an INDEX.md edit between your Read and your push. Cross-_file_ entanglement (a broad `git add <dir>` eating a sibling's plan rename) is now prevented outright by staging explicit paths, never directories. The GATE probe at step 5.0 still catches the residual same-_file_ race: another session has staged OR unstaged modifications on a shared file (handoff.md / board / INDEX) mid-flight — `git add <file>` stages the whole working-tree copy, foreign hunks included, so the probe must bail before you stage. The probe blocks all status codes except `??` (`grep -vE '^\?\?'`); an earlier `[AM]M?` filter incorrectly allowed staged mods through.**

### 6. Create the worktree + push the empty branch

**Cut off the FRESH origin tip, never local `master`.** In a shared `.git` worked by many sessions, local `master`/`origin/master` lags the remote by minutes under load; a worktree cut from a stale ref builds on an outdated baseline and silently misses already-landed sibling plans (the 2026-06-20 session-793 stale-cut). So **always `git fetch origin master` immediately before the cut, and cut from `origin/master`.**

If `scripts/cut-worktree.mjs` exists (the project, plan 871), it owns this — one call fetches, cuts from `origin/master`, and publishes the empty branch:

```bash
node scripts/cut-worktree.mjs <slug>          # fetch origin master → worktree add origin/master → push -u
```

Since plan 3956 the cut is **SPARSE by default**: the worktree leaves the six heavy stores under `backend/data/data-pipeline` (`render-store`, `render-archive`, `render-fingerprints`, `batches`, `prompt-bench`, `llm-runs` — 87,000 of the repo's 131,000 tracked files, 3.7 GB) off disk unless the plan's class keeps it dense — a 🟥 / MAYBE / missing SEED-WRITE banner, a `Pipe`/`DQ` category, a body naming one of those stores / `data-pipeline` / `weekly-price-sweep`, an unresolvable plan file (batch slug), or an explicit `--dense`. The cut prints which rule decided it (`worktree add` ~45 s instead of ~7 min; `status` ~0.4 s instead of ~6 s). A sparse worktree that turns out to need a store **widens in place, never re-cuts**: `node scripts/cut-worktree.mjs <slug> --widen` — the pytest and price-trust gates do this by themselves. Detail: the project `docs/coord/worktrees.md` § Sparse checkouts as the default.

Fallback (no `cut-worktree.mjs` — sibling subprojects):

```bash
git fetch origin master                       # MANDATORY: refresh the remote-tracking ref first
git worktree add -b worktree-<slug> .claude/worktrees/<slug> origin/master
git push -u origin worktree-<slug>
```

Confirm with `git worktree list`. Pushing the empty branch is the second half of cross-PC visibility — the claim row says "this PC is on it"; the branch on origin proves the worktree was actually created. Skip the empty-push only if branch protection rejects pushes from a non-current branch.

### 7. cd into the worktree

```bash
cd .claude/worktrees/<slug>
```

Bash cwd persists across calls — one `cd` holds for the rest of the session. Commits will land on the worktree branch regardless of what the status line shows.

### 7.5. Checkpoint — was the FIRST-ACTION clipboard copy fired?

The clipboard `/rename <plan-id>` copy belongs at the very top of this skill (the FIRST ACTION block, before step 0). If it somehow hasn't fired yet — e.g. the plan id only became unambiguous late, or this is a resumed session — do it NOW, before `pnpm install`. The session renaming exists so `/state`, the session picker, and the CC Watcher widget show the plan instead of the launch folder. Never skip it just because you're moving on to the work.

### 8. Install Node workspace deps if applicable

If `pnpm-workspace.yaml` exists (or `package.json` has `workspaces`/`pnpm` keys):

```bash
pnpm install     # ~30s warm, ~3min cold
```

**HARD STOP — never pass `--ignore-scripts`.** Skipping `prepare` silently disables husky → the pre-push lint stops firing → INDEX.md drift and other class-of-bug gets through. If you reach for the flag because of an EPERM/lock error, FIX THE LOCK (kill the holder via `zombies` skill, retry); don't shortcut. Audit of 20 recent sessions: `--ignore-scripts` appeared in 17 of them; every appearance traces to husky breakage downstream.

Skip the whole `pnpm install` only when the plan is provably pure-Python / pure-docs (no `pnpm-workspace.yaml` in the worktree root). When in doubt, install. (npm: `npm install`; yarn: `yarn install`.)

> 📦 Ran `pnpm install` in the worktree — wires husky hooks and node_modules. Took ~Ns.

### 8.5. Read the plan's subject wiki — if the project keeps a subject vault

If the project keeps a synthesis wiki (the project: `wiki/`, an Obsidian vault of subject pages), read the plan's SUBJECT page(s) IN FULL before the first edit. Derive the subject from the plan's category / slug / touched files and open the matching page — e.g. a data-pipeline plan reads `wiki/entities/inspectors/price-inspector.md`; a chain plan reads its chain page. That synthesis is what the seed / runbooks / code can't hold, and reading it here (not `hot.md` / `index` alone) is the difference between working from current truth and re-deriving it. Skip only if the project keeps no such vault.

### 8.6. `execModel: fable` plans — the acquire output's doctrine block is BINDING

When the claimed plan's frontmatter says `execModel: fable`, `claim-plan.mjs acquire` prints a
thin-orchestrator doctrine block after its WON line (plan 1627) — the inline-vs-orchestrate mode
test, rules 1–4, and the explicit-`model`-pin rule. That block is not decoration: it governs the
execution that follows. In particular, corpus/bulk-shaped plans delegate their bulk reads/edits to
pinned Sonnet workers (read-only research/bulk-read dispatches are pre-authorized — no operator
pause); only small judgment-dense plans run inline. Full doctrine:
`batch-train/references/thin-orchestrator.md` (master:
`<home>\Desktop\Claude\Hobby\the project\coord\skills\batch-train\references\thin-orchestrator.md`).

### 8.7. `execModel: sol` plans — Sol writes, an Opus session orchestrates

When the claimed plan's frontmatter says `execModel: sol` (plan 3341, operator ruling 2026-08-20),
the SAME thin-orchestrator doctrine that governs `execModel: fable` above binds, with one
substitution: the cheap workers that touch files are `codex exec` dispatches, not Sonnet subagents.
The mode test, never-bulk-read/edit-yourself, verify-through-gates, and writing each decision into
the plan body as it happens all apply unchanged. Review is still `/gpt-review`, same as any other
lane. If the SAME gate/review finding (same file, location, defect class) comes back unfixed after
two consecutive Sol rework rounds, finish that finding on the normal Claude lane and record the
switch in the plan body naming the finding; a round that shrinks or changes the finding set keeps
Sol, no round limit (operator ruling 2026-08-29, replacing the fixed 2-round cap; rule text:
`docs/coord/plan-lanes.md` § Executor lanes and model allocation) — the lane never blocks real work. A plan
reaches this step either because the executor-lane toggle (`scripts/exec-model-default.json`, read
with `node scripts/exec-model-default.mjs`) named `sol` at spec-pass time, or because someone
stamped `sol` on it deliberately while the toggle named a Claude lane instead — either way the
recipe below is identical. The lane's mechanics are untouched by which way the toggle currently
points: an already-stamped `sol` plan is still drain-claimable and a drain that claimed it via
`queue-drain.mjs` follows this same recipe, not only an interactive `pickup-plan` session. Full doctrine:
`batch-train/references/thin-orchestrator.md`; lane facts: the project `docs/coord/plan-lanes.md`
§ Executor lanes and model allocation.

### 9. Do the work — and push after every commit

You're cd'd in. Use cwd-relative paths for everything.

Execute the plan per its own steps. If it was written for subagent execution, follow `superpowers:executing-plans` or `superpowers:subagent-driven-development`.

**Push after every commit on the worktree branch.** Parallel sessions may run `/done-worktree` at any time; unpushed work is lost in the takeover.

```bash
git push origin worktree-<slug>
```

Only merge to master per the parent CLAUDE.md branch-hygiene rules — typically after explicit operator approval.

**If you must stop mid-run on an open question (the tier-3 mid-run park, plan 4069, operator ruling
2026-09-20).** Ask first whether the question is a technical-design or plan-scope call (split / fold /
which lane / which model / file a follow-up or not) — the operator does not want those brought to them.
Pick your recommended option, write it into the plan body as a `## Session decisions` entry (the option
chosen, one line why), and keep going — never park it. Only a question naming one of `product` (what
users see), `policy` (a rule/default, a taxonomy boundary, legal/privacy posture), `money` (cash above
the drain's spend ceiling), `access` (credentials/accounts/dashboards/a physical operator action), or
`data-ruling` (a seed-row edit under the hand-edit ban, a dossier sign-off) genuinely needs to stop. For
that case, self-move the plan out of `in-progress/` VISIBLY in the same run — `node scripts/move-plan.mjs
<id> waiting-grill`, with the question in a `## Grill questions` section written as a NUMBERED LIST ONLY
(plan 4069 session decision S1) — the item opens with `N. ` immediately followed by its own
`[axis: <tag>]` marker, with any context indented underneath it, never as a bullet, bold line, or bare
prose (the entry guard requires the section, its numbered-list shape, AND the tag) — then release the claim
(`node scripts/release-claim.mjs release <id>`). Full mechanics, the `waiting-operator/` fallback, and
why the claim is released rather than held: `docs/coord/plan-lanes.md` § Park visibility.

### 10. Write the COMPLETION update on master

The handoff entry lives on master, NOT the worktree branch. Editing the worktree's copy writes to the wrong branch and hides updates from `/state` readers until merge.

**Primary pattern — commit from the worktree using `git -C`** (avoids fragile `cd` math). Edit the SAME entry from step 5a in place:

- **post-plan-205:** edit `"$MAIN/docs/handoff/sessions/YYYY-MM-DD-session-<N>.md"` (this session's own file).
- **legacy:** edit `"$MAIN/handoff.md"` (the block from step 5a).

```bash
MAIN=$(git worktree list --porcelain | awk '/^worktree/ {print $2; exit}')
# edit the session entry — flip Status, add Finished/What shipped/Carry-forward/Files touched
git -C "$MAIN" add docs/handoff/sessions/YYYY-MM-DD-session-<N>.md   # post-plan-205; OR `handoff.md` (legacy)
git -C "$MAIN" commit -m "handoff: complete <plan-slug> (session N) — <one-line summary>"
git -C "$MAIN" push origin master
```

Update the same handoff entry from step 5a — don't write a new one. Set:

- **Status:** ✅ COMPLETED (or ⏸ PAUSED with a Resume condition)
- **Finished:** YYYY-MM-DD HH:MM
- **What shipped:** concrete bullets — commits, seed deltas, services deployed, metric changes
- **What's left:** if partial, what's NOT done and why
- **Carry-forward:** numbered list of follow-ups
- **Files touched:** code block of changed paths

Then update the `## Active worktrees` row: `🔄 ACTIVE → ⏸ PAUSED` if pausing (refresh tip + last-touched + resume-condition). If completing, STOP here and invoke `done-worktree` — it merges, archives, extracts carry-forwards, tears down, and removes the row atomically.

### 11. Cleanup → `done-worktree`

Do NOT clean up manually from inside `pickup-plan`. The merge + archive + carry-forward extraction + teardown + board-row removal belong to `done-worktree`. Invoke it explicitly when the plan is finished. If just pausing, the worktree stays alive with `⏸ PAUSED` state.

---

## Critical mistakes

| Mistake                                                                 | Why it bites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create worktree first, write handoff second                             | Lock isn't visible until pushed. Window for parallel pickup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Write handoff but don't push                                            | Local-only claim. Push IS the lock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm install --ignore-scripts`                                         | HARD STOP — breaks husky → pre-push lint silently disabled → INDEX drift gets through. 17 of 20 audited sessions did this; every appearance caused downstream lint failures. See step 8.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Skip lint-plan-index check before staging in step 5f                    | Drift caught at `git push` instead → re-orient + amend + re-push loop. Run `node scripts/lint-plan-index.mjs --check` BEFORE staging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Re-run the plan-subfolder `ls` sweep at every step                      | Audit found ~55× per session. Step 1.5 says run ONCE, cache the result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Forget to push after every commit on the worktree branch                | Parallel `/done-worktree` takes over with stale tip → unpushed work lost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Re-claim a row whose `host=…` ≠ this PC                                 | Not a phantom — it's live elsewhere. Fetch origin, surface, ask.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stage cross-session paths without a pre-stage probe                     | Race: a parallel session mid-`/done-worktree` has staged OR unstaged modifications on the same shared paths (`handoff.md` / `docs/handoff/board.md` / `docs/INDEX.md`); broad `git add` in step 5f consumes them under THIS session's commit message. Attribution silently breaks. The probe (`git status --porcelain` on target paths → bail on anything except `??` via `grep -vE '^\?\?'`) catches it BEFORE `git add`. Recurring race shape (4+ incidents, see plan 173).                                                                                                                            |
| Use `--lock-only` for a real pickup (then skip the projection it omits) | The full `acquire` resolves + projects a `waiting-*/` or `pending-approval/` plan DIRECTLY (via `activePathFor`), and `--resume` does the same for an `in-progress/` takeover (plan 2353) — `--lock-only` is tests/dogfood ONLY. Using it for a real pickup and forgetting the manual projection strands the plan in `waiting-*/` while you work it — invisible as ACTIVE to parallel sessions (2026-06-07 session-376). Just run the normal `acquire`. Invariant: a worked plan MUST end in `in-progress/` + `🔄 ACTIVE`. See the "Resuming a `waiting-*/` plan" and "TAKING OVER" blocks after step 0. |

This table is the catalog — every row above is an incident that actually happened, with its date or plan id. Add to it in place when a new one bites; do not spin the overflow into a sibling file.

## Red flags — STOP and check

- "I'll write the handoff after I finish" → No. Claim is the LOCK. Write first.
- "It's just a small plan, I don't need a worktree" → Then you don't need this skill — do it on master.
- "I'll merge to master without telling the operator" → Worktree branches stage by default per parent CLAUDE.md. Merge needs approval.
- "The plan looks claimed but the session probably crashed" → Surface it. Don't silently take over. Step 2's gate exists for this.
- "There's an uncommitted/foreign plan doc in `plans/` I didn't write — I should reconcile or redo something" → No (plan 249). An uncommitted or foreign doc in `plans/` is **never** a redo-or-reconcile signal. Derive what's claimed/done from committed `docs/handoff/board.md` + the generated `docs/INDEX.md` + your own claim. `docs/INDEX.md`'s active region is generated by `scripts/build-index.mjs` from `git ls-files`, and the pre-push lint is regenerate-and-diff, so an untracked foreign plan doc is invisible — it can't gate your push or your reasoning. Ignore working-tree dirt you didn't create.

## Example CLAIM entry

Inline at step 5a (the claim stub, verbatim from `sessionEntryStub()`), with the completion-update fields at step 10.
