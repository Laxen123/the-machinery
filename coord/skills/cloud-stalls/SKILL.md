---
name: cloud-stalls
description: Use when the operator asks whether any Claude sessions have stalled, died mid-run, or gone silent — cloud drains, routine-fired sessions, or worktree sessions — across ALL accounts, not just the current one. Triggers - "/cloud-stalls", "did anything stall?", "are the drains alive?", "check for dead sessions", "did a cloud session die on an API error?".
---

# cloud-stalls — stalled-session detector across all accounts

The SWEEP is read-only; RECOVERY is propose-then-execute (operator 2026-07-19): the run ends with
a Proposed-actions block and a sign-off ask, and THIS session executes whatever the operator
approves — nothing before, nothing beyond (§ Recovery). **Scope: CLOUD sessions on ACTIVE accounts
only** (plan 4144). Dormant accounts are read only as a fallback, for a cloud claim no session on an
active account matched. Local-hostname claims (the operator's own terminals) are cross-reference
context, never verdict rows (operator 2026-07-18).

**Target: about five minutes, one command** (plan 4144 — a 2026-09-22 run took ~30 min through
44 serial `claim-plan status` spawns, four `wake-stalls` re-runs, and a second tool to name
plan ↔ account). `node scripts/wake-stalls.mjs` reads every cloud claim itself, joins each to its
session through the CDP account tabs (the verdict source — git signals alone never decide a
verdict; the 2026-07-18 misfire called a live blocked-on-permission revive a death), and prints the
verdict table. Do not re-derive what it already prints.

## FIRST ACTION — copy `/rename cloudstalls` to the clipboard, before anything else

The moment this skill fires, copy the rename command to the OS clipboard and surface the paste nudge —
BEFORE `git fetch`, the claims sweep, or the CDP read. This gives the session a meaningful title so
`/state`, the session picker, and the CC Watcher widget show `cloudstalls` instead of the launch
folder.

**The skill cannot fire `/rename` itself** — it's a built-in, and built-ins are not programmatically
dispatchable (only custom slash commands are); `sessionTitle` is settable only by a `SessionStart`
hook on `source: startup|resume`, never mid-session; and no hook can pre-fill the input box. The
lowest-friction path is the clipboard:

```bash
# Windows (operator's platform; Set-Clipboard adds no trailing newline):
powershell -NoProfile -Command "Set-Clipboard -Value '/rename cloudstalls'"
# macOS:  printf '%s' '/rename cloudstalls' | pbcopy
# Linux:  printf '%s' '/rename cloudstalls' | (wl-copy 2>/dev/null || xclip -selection clipboard)
```

```
📋 Copied  /rename cloudstalls  to your clipboard — paste (Ctrl+V) + Enter to rename this session.
```

This must run from the **user-facing session** — never a dispatched subagent (only the top-level
session's title is the one the operator sees). Skip ONLY if the operator already renamed the session,
or if the sweep is running headless (no clipboard / no operator to paste).

## Procedure

Run from the the project main checkout.

1. `git fetch origin` — judge origin, not stale local refs (an `incorrect old value provided`
   fetch error is a local ref-update race: retry once).
2. `node scripts/wake-stalls.mjs` (CDP Chrome up: `node scripts/cdp-chrome.mjs`; the script opens
   any missing active-account tab and waits for it to sign in before sweeping). ONE invocation.
   It prints one row per cloud claim AND per claimless working/blocked session: plan id (or
   session title) · account email · verdict (ACTIVE, CAPPED (resumable now | in Nh),
   BLOCKED-ON-ASK, GOAL-DROPPED, MID-TOOL-HANG, DONE-AWAITING-DECISION, DIED-MID-RUN — an error
   exit with no usage cap in the tail — CAP-CHECK-INCONCLUSIVE / CAP-OR-TRANSIENT — a died-mid-run
   whose cap check could not decide — GATE-BLOCKED — a claimless drain whose FRESH status heartbeat
   names its push gate — or `unresolved`: any coverage gap, never read as healthy);
   `--verbose` adds the old per-account prose report. Measured 2026-09-23: 257 s
   for a four-claim board. A claim it cannot match on the active accounts is
   looked up on the dormant accounts for that claim only; still unmatched = `unresolved` with `—`
   as the account, say so rather than guessing the account. A `BOOT-DEAD LANE` section means an
   account's recent routine firings all died at boot — a trigger-body repair (the project
   `docs/runbooks/cloud-drain-landing.md` § Post-update trigger-body verification), not a wake.
   The table cannot see a routine that fired and died before claiming (FIRED-NO-TRACE): only when
   that is suspected (a routine should have fired recently but no claim or session shows it) run
   the **cloud-routines** status fan-out from § Deeper look; it is not part of the default run.
3. **Print the table — UNCONDITIONAL, no quiet mode, no all-ACTIVE shortcut.** Operator ruling
   2026-08-04: the operator wants to see every active cloud session, the account running it, and
   the verdict, even when all are healthy. Three leading columns, in this order: what is running,
   the ACCOUNT (signed-in email — never the claim `host`, which names a container), the verdict.
   Lead with one plain-English line: how many alive, how many blocked/stalled, smallest decision.
   Local-hostname claims get at most one summary line, never rows.
4. **Propose → sign off → run** the matching command (§ Recovery): `--send` for GOAL-DROPPED,
   `--resume-capped` for CAPPED sessions whose cap has reset, `reap-dead-claims.mjs` for a claim
   confirmed dead.

### Deeper look (optional — only when the table leaves a row unexplained)

- **Claim detail:** `node scripts/claim-plan.mjs status <id>` for ONE plan (`holder.host`,
  `holder.iso`, `ageSec`). A claim ref existing no longer proves it is held — release appends a
  tombstone. Host taxonomy: the local hostname = local session; `cloud-*` / bare `vm` = remote.
- **Branch activity:** `git for-each-ref --sort=-committerdate --format='%(refname:short) | %(committerdate:relative)' 'refs/remotes/origin/worktree-<id>-*'`.
  No branch is not automatically death: check the plan file's history
  (`git log --format='%h | %ci | %s' -6 origin/master -- 'docs/superpowers/plans/**/<id>-*.md'`);
  a `cloud drain handoff …` commit + a self-move to `waiting-*/` is a BLOCKED-HANDOFF.
- **Landing queue:** `node scripts/landing-queue.mjs status`. A slug that LEFT the queue landed
  (alive). A stale HEAD heartbeat counts as a stall only with a waiter behind it and a heartbeat
  > 45 min (the steal threshold); a lone head's heartbeat is frozen at enqueue by design; non-head
  > entries are ENQUEUED-WAITING.
- **Routine firings per account:** the **cloud-routines** skill's status fan-out (`last_fired_at`).
  A fresh `last_fired_at` does not prove a lane healthy (boot-death, plan 2156).
- **Raw session read:** procedure, death signatures, cap check: the project
  `docs/runbooks/cross-account-claude-ui.md`. Exact plan ↔ session join: claim
  `holder.sessionUuid` equals event `payload.session_id`.
- **Roster rule** (what `wake-stalls` implements): a row belongs whenever it holds a claim, OR its
  `status_bucket` is `working`/`blocked`, OR its `worker_status` is `requires_action`, OR its
  worker is `running` on an unfinished session. Finished firings (`review_ready` / `completed`, no
  claim) stay out even when the worker still says `running` — that flag outlives the turn by days
  (measured 2026-09-23, plan 4144).

## Verdicts

| Verdict                | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACTIVE                 | branch tip fresh, OR left the queue since last snapshot (= landed), OR queue head with a waiter behind AND heartbeat ≤45 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | leave it alone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ENQUEUED-WAITING       | in the landing queue but not head; also a LONE head (no waiter behind) whose heartbeat is frozen at enqueue-time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | done/landing, nothing to refresh the heartbeat — idle branch/stale heartbeat is normal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| WEDGED-HEAD            | queue head, heartbeat >45 min old, AND ≥1 waiter blocked behind it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | stalled land blocking the FIFO — steal-eligible; operator confirms then the waiter steals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SUSPECT-STALLED        | claim held, branch idle >45 min, NOT in the landing queue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PROVISIONAL (git-only) — never reportable as-is; the session event read MUST resolve it into BLOCKED-ON-ASK / DONE-AWAITING-DECISION / capped / GOAL-DROPPED / confirmed-dead                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| GOAL-DROPPED           | event tail ends in `active_goal: {value: null}` with NO `assistant` / `user` / `result` / `tool_progress` event newer than it, while holding a live claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | a platform environment restart killed the autonomous goal, so nothing re-prompts it — the 2026-07-17 wave. NOT dead: the environment and transcript survive; one composer message resumes it. `node scripts/wake-stalls.mjs` detects exactly this and drafts the message                                                                                                                                                                                                                                                                                                                                                                                    |
| BLOCKED-HANDOFF        | claim held, no branch (or a wip branch), BUT the plan file has a `cloud drain handoff` commit + a self-move to `waiting-*/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | NOT a stall — clean escape-hatch exit on a capability blocker; leftover claim is stale residue, safe to release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CLAIMED-NEVER-PUSHED   | claim held, no `worktree-<id>-*` branch on origin, claim age >20 min, AND no `cloud drain handoff` commit on the plan file (rule out BLOCKED-HANDOFF first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | died between claim and first push                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| FIRED-NO-TRACE         | routine `last_fired_at` recent (<2 h) but no new claim/branch/land attributable to it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | session died before claiming                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| STALE-CLAIM            | claim whose plan folder is no longer active (`archive/`, `parked/`, `waiting-*`), OR whose branch is merged, OR claim age >24 h                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | leftover lock, not a live session — propose the release in § Recovery, never clean mid-sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| BLOCKED-ON-ASK         | `status_bucket: blocked` + `worker_status: requires_action`; event tail ends in a `control_request` safetyCheck (then a `control_cancel_request` ~5 min later)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | LIVE session paused on an unattended permission ask (typically a coord-worktree write) — approving in that account's UI resumes it; NOT dead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| DONE-AWAITING-DECISION | `review_ready` + clean final `result` (`is_error: false`, Stop hooks green), often a handoff commit asking for a decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | finished its turn cleanly; not a stall — answer its question or resume, then release-or-reuse the claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| MID-TOOL-HANG          | MACHINE-DECIDED since plan 3248 (was hand-read): `node scripts/wake-stalls.mjs --mid-tool-hang-idle-min N` (default 45) reports it via `midToolHangSignature` — newest event is a `tool_progress` heartbeat/progress frame, or an assistant `tool_use` for a tool on the explicit `BLOCKING_WAIT_TOOLS` allowlist in `scripts/wake-stalls-lib.mjs` — `TaskOutput` only when it carries `input.block === true` (its documented dual-mode contract), and `Monitor` unconditionally (it has no foreground mode at all, the same reason `scripts/hooks/subagent-backgrounding-guard.mjs` treats every Monitor call as backgrounding). An ordinary non-blocking tool call never matches, and neither does an unknown tool that merely happens to carry a truthy `block` input — the test is name-keyed, not flag-shaped (tightened plan-3248 review C1, then narrowed again in the review of that fix). Caveat worth knowing: the 1,268-session corpus that validates this signature contained ZERO sessions whose newest event was a `Monitor` call, so the Monitor entry rests on that architectural argument, not on corpus evidence. Idle ≥N minutes, with no `active_goal:null`/`rate_limit_event`/`control_request` above it — for a session that HOLDS A LIVE CLAIM | a 4th death signature (first seen 2026-07-22, a ~3-min cluster killing 3 accounts' environments simultaneously at 17:27–17:30Z; reconfirmed 2026-08-16 as a backgrounded `done-worktree` land wedged inside a blocking `TaskOutput`, plan 3248). NOT goal-drop (there was a real in-flight call, not a null goal) and not resumable by a composer message at all while the tool call is wedged — a message typed into it will not land. The claim-holding case's scripted recovery is `reap-dead-claims.mjs` (§ Recovery); the reset-message rule below is for the RARER case where a human decides to nudge the session anyway before it is confirmed dead |

Threshold judgment: 45 min mirrors the queue's steal threshold. A long test battery or heavy
extraction pass can idle a branch that long while alive — that's why a git-only signature is
never a final verdict. The event-log tail decides: environment restart +
`active_goal: null` = confirmed stall; `rate_limit_event` 429 = capped; `control_request`
safetyCheck = BLOCKED-ON-ASK; clean `result` = DONE-AWAITING-DECISION. Procedure: the project
`docs/runbooks/cross-account-claude-ui.md` § "Reading the session + event API" + "Death
signatures" + "Check usage BEFORE diagnosing a stall as a crash".

## Account attribution

The claim `host` (e.g. `cloud-fable-drain`) names the runtime, NOT the account. EXACT method
(preferred): in the CDP Chrome, a session's worker events carry `payload.session_id` equal to the
claim's `holder.sessionUuid` from `claim-plan.mjs status` — sweep each account's
`/v1/code/sessions` and match (runbook above). Fallback heuristic: match the claim's `holder.iso`
against each account's routine `last_fired_at` (accounts fire on staggered minutes — see the
cloud-routines account map). An unmatched cloud claim = ad-hoc cloud session; say so rather than
guessing the account.

## Recovery: propose → sign off → execute

The verdict table is not the end of the run. The report ENDS with a **Proposed actions** block,
then the sign-off ask, then execution of exactly the approved items.

1. **Propose.** One numbered proposal per finding that needs recovery; findings needing nothing
   get none. Each proposal is three parts: the finding (plan id / session + verdict), the EXACT
   action this session will run, and a one-line consequence/risk. When the action is answering a
   session's question or re-prompting it, the proposal includes the DRAFT MESSAGE verbatim — the
   operator approves the words, not just the idea. Actions this session can execute on approval:
   - Release a stale/residual claim: `node scripts/release-claim.mjs <planId>` (the project checkout).
   - Release + re-route a claim CONFIRMED dead (plan 3248) — the MID-TOOL-HANG-holds-a-claim case,
     and any claim whose holder's tail resolves to `sessionOutcome` `killed`/`error_during_execution`:
     `node scripts/reap-dead-claims.mjs --plan <planId>` (the project checkout, CDP Chrome up). ALWAYS run
     it bare first — dry-run by default, prints its verdict (`REAP` / `skip` / `REFUSED` /
     `TRUNCATED`) and why, and refuses outright on a 🟢 LANDING plan row or a landing-queue-head
     claim regardless of the tail. Put THAT verdict line in the proposal; only `--apply` (a second,
     separate approved action) actually releases the claim (`release-claim.mjs --force`) and routes
     the plan back to `ready/` (`move-plan.mjs <planId> ready`) so a drain can pick it up again — a
     release alone leaves the plan stranded, unclaimed, in `in-progress/`, where no drain reads it
     (the exact 2026-08-17 gap this tool closes). Prefer this over a hand-typed `release-claim.mjs
--force` for any claim this sweep is proposing to release: it fails closed (skips rather than
     guesses) and does the re-route in the same motion.
   - Dequeue a dead queue slot: `node scripts/landing-queue.mjs dequeue <slug>`.
   - Wake a GOAL-DROPPED session: `node scripts/wake-stalls.mjs --send` (the project checkout, CDP
     Chrome up) — it re-derives the claim↔session join, prints the wake message, and asks per
     session before sending.
   - Resume a CAPPED session whose usage cap has reset (plan 4144):
     `node scripts/wake-stalls.mjs --resume-capped` — sends the fixed message "Your usage cap has
     reset. Continue the plan from where you stopped." to every capped-and-cleared claim-holding
     session, asking per session like `--send`; `--yes` skips the per-session ask for a run the
     operator already signed off. Reports `sent-confirmed-by-event-log` per session.
   - Rename claimed sessions for legibility: `node scripts/cloud-session-hygiene.mjs` (the project
     checkout, CDP Chrome up) — idempotent PUT of `<planId> <short-slug> (<lane>)` onto every live
     claim's session; safe standalone or reusing the sweep's open tabs. Also prints the operator
     link-list (plan id · title · status · direct URL) — the only "what's running where" view, since
     the sidebar and its Search both exclude trigger-fired sessions.
   - Delete stale cloud sessions: `node scripts/cloud-session-hygiene.mjs --cleanup` is still the
     ADVISORY report (a kill-list, nothing deleted), but the DELETE path is real since plan 2173 —
     `--cleanup --confirm-delete`. It is fail-closed by construction: both plan-state inputs (the
     `archive/` listing and the session ids referenced by ACTIVE plan bodies) are read from
     `origin/master` via git refs, never the shared checkout's working tree, and ANY origin resolve
     failure aborts before a kill-list exists; a plan held by ANY claim ref — including one that
     failed to resolve — is excluded; a session never Ship-1-renamed is excluded (that is also the
     "never touch an operator-created session" guard). Sign-off binds to the exact list: the run
     prints the candidates plus an approval hash, a TTY answers y/N, and a non-TTY re-runs
     `--approve <hash>` — which recomputes FRESH and refuses on any drift. There is no blind
     `--yes`, no checkpoint file (resume is recompute-from-truth), and a single-holder lock refuses
     — never queues — a concurrent delete run. DELETE is irreversible and is the only cleanup verb
     (the API exposes no archive concept). Propose it like any other mutation: run bare `--cleanup`
     first, put THAT list in the proposal, and let the operator sign off on the names.
   - Answer / resume / nudge a cloud session: type the approved message into that account's
     session composer via the CDP Chrome profile tabs the sweep opened. Same path for
     approving a still-pending permission ask (note: a `control_cancel_request` in the tail means
     the ask already expired — the recovery is a resume message telling it to retry, not a click).
     **For MID-TOOL-HANG specifically: word the message as a RESET of the interrupted step, not a
     "check if it finished, continue" resume.** A session that died mid-tool-call cannot reliably
     self-diagnose whether that call's effects landed (operator finding, 2026-07-22, plan 2215): a
     message that hedges ("check whether X completed, re-run if not") just makes it re-enter the
     interrupted step cold — e.g. re-launching a Workflow tool mid-stream, which reads as skipping
     straight to a fresh permission prompt with no visible diagnosis step in between. Say
     explicitly: "treat your last in-flight <tool/workflow> call as dead and its effects as not
     landed — start that step over from the top," and warn the operator up front that a workflow
     restart will likely re-trigger its one-time permission gate (the gate doesn't survive an
     environment restart) needing a manual click in that account's UI.
   - Re-fire a drain: `node scripts/routine-ctl.mjs fire --routine <account>/<kind>` (the
     cloud-routines one-shot path; falls back to that skill's worker pattern if no token).
     Teleports (`claude --teleport`) need the operator's own terminal — list them in a separate
     operator-run line with the full command; they are not sign-off-executable.
2. **Sign off.** Collect approval in-run: AskUserQuestion (multiSelect, one option per proposal)
   when they fit in one question, otherwise a numbered list the operator answers by number.
   Approval is per-item. Silence, a partial answer, or the run ending = not approved; an
   unapproved proposal dies with the run and is never carried into a later turn as pre-approved.
3. **Execute + verify.** Run ONLY the approved items, as proposed. Then re-read the mutated state
   (claim ref gone via `git ls-remote`, queue slot gone, the session's event tail shows the sent
   message / a new turn) and report per-item PASS/FAIL. A permission denial or classifier block
   on an approved item is a FAIL with the denial text quoted — never substitute a different
   mutation the operator didn't approve. An "expired" environment on a send is a FAIL whose
   follow-up is the operator-run teleport line, proposed, not executed.

## Boundaries

- The sweep never mutates: no releases, dequeues, branch deletes, session deletes, or firings while gathering
  verdicts — mutation happens only in § Recovery step 3, only for items approved at THIS run's
  sign-off. (Standing drain enablement/cadence changes remain the cloud-routines skill.)
- A quiet worktree with an ACTIVE claim is a LIVE sibling session — never write into it.
- If the operator asks about ROUTINE health only (did crons fire), that's cloud-routines, not this.
