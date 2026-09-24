---
name: cloud-routines
description: Use when the operator asks about his cloud routines (Claude Code scheduled triggers) across accounts — which are enabled, when they fired, OR to enable/disable/re-cadence them. Covers the multi-account status fan-out and the safe change procedure.
---

# cloud-routines — status + enablement/cadence changes across all accounts

Answers "which routines are activated?" / "did the drains fire?" with LIVE state, and applies
operator-directed enablement/cadence changes. Reference inventory (trigger ids, env ids,
provisioning caveats): `the project/docs/runbooks/cloud-drain-landing.md` § multi-account routine
inventory — keep that table in sync after ANY change (same session, `docs(runbooks)` commit).
Canonical prompt bodies live in `the project/docs/runbooks/cloud-routines/*.md` — prompt-content
changes are NOT this skill (see the runbook's v-generation procedure); this skill only flips
`enabled` and `cron_expression`.

## Account map — read it from the registry, not from here

`scripts/account-registry.mjs` is the ONE source of truth for account facts (plan 3416). Print the
current fleet — labels, emails, `CLAUDE_CONFIG_DIR`, launcher, CDP profile, dormancy with the
operator ruling that set it, and the full-egress env id:

```bash
node scripts/account-registry.mjs
```

The rendered table also lives in `the project/docs/runbooks/cloud-drain-landing.md` § The account fleet,
generated from that same registry.

**This section used to carry its own copy of the map, and the copy went stale** — its per-account
"stagger minute" column read `:15` for home and `:30` for acct-b while the live crons had been
`:20` and `:35` for weeks, and its single-minute-per-account shape silently dropped vet's second,
different lane minute. That is why the minutes are not restated here either: a cron is a LIVE fact.
Read the current ones with the status procedure below (`RemoteTrigger` action `list` per account) —
NOT with `sync-trigger-bodies.mjs --dry-run`, which reconciles trigger BODIES and reports envelope
drift without ever printing `enabled` or `cron_expression`.

Two axes this skill must keep straight, both answered by named registry predicates rather than by
re-reading prose: `isRoutineAccount` (does this account have coordination routines to act on?) and
`isSweptAccount` (does the stall sweep cover it?). They are deliberately different sets — `zed` is
dormant and unrouted yet still swept, because <account-c-alt> is signed in on its profile and can still
hold a stalled session.

## Status procedure

1. **Current account directly:** RemoteTrigger tool, action `list`. (Confirm which account that
   is from a known trigger id if unsure.)
2. **Other accounts — background `claude -p` workers, all in parallel** (Bash tool,
   `run_in_background: true`, cwd = the session scratchpad, NEVER a repo — repo hooks pollute
   worker stdout, which is why workers must WRITE A FILE instead of printing). `vet` is a normal
   fleet member again since its 2026-08-21 reactivation (account map above) — spawn its worker
   exactly like zed/acct-b/acct-c, no special-casing:

   ```bash
   cd <scratchpad> && CLAUDE_CONFIG_DIR="<home>\.claude-z" \
     claude -p 'Call the RemoteTrigger tool with action "list". The result is LARGE and spills to a file — Read it fully. Then use the Write tool to write the ABSOLUTE path <scratchpad>/routines-zed.json containing exactly: {"account":"zed","routines":[{"name":...,"id":...,"enabled":...,"cron_expression":...,"last_fired_at":...,"next_run_at":...} for every trigger]}. Only those fields — never the routines message/prompt bodies, tokens, or environment secrets.' \
     --model haiku --allowedTools "RemoteTrigger,Write,Read" \
     --add-dir "<home>\.claude-z\projects"
   ```

   **Worker model = Haiku, deliberately the floor** (2026-07-16). The worker's whole job is one
   fixed tool call (`RemoteTrigger` with a given action/body) + a Read of the spilled result + one
   `Write`. Haiku 4.5 handles that fine and is the cheapest tier; there is no accuracy reason to
   spend Sonnet here. Note this does NOT make the fan-out faster or its exit codes reliable — that
   cost is the ~1-3 min process spin-up + the judge-by-file-presence gotcha below, both structural
   (no public flip API — see the plan-1928 section), not model-driven.

   Gotchas: (1) `RemoteTrigger list` now returns a MULTI-KB payload (every trigger embeds its full
   drain prompt), so the CLI spills it to a temp file — the worker MUST have `Read` in
   `--allowedTools` or it stalls asking for read permission and writes nothing (observed 2026-07-16).
   (2) Pass an ABSOLUTE output path — a bare filename resolves against the worker's own cwd, not
   `<scratchpad>`, and lands in whatever repo the process started in. (3) The CLI sometimes
   false-times-out AFTER the file is written — judge by file presence, not exit code; missing file
   after ~3 min → rerun that one account once. (4) `Read` in `--allowedTools` is NOT enough: the
   spill file lands in `<CLAUDE_CONFIG_DIR>\projects\<session>\tool-results\`, OUTSIDE the worker's
   scratchpad sandbox, so the worker stalls on a directory-permission ask and writes nothing
   (observed on all 3 accounts 2026-07-18) — always pass
   `--add-dir "<CLAUDE_CONFIG_DIR>\projects"` as in the example. (5) `--add-dir` is VARIADIC: it
   swallows any positional prompt that follows it ("Input must be provided either through stdin or
   as a prompt argument") — keep it AFTER the quoted prompt, last on the command line.

3. **Render one table:** account · routine · enabled · cron (UTC) · fires-local (operator is
   UTC+2 in summer — ALWAYS convert) · last fired. Lead with the enabled set and the net rhythm
   in one sentence (e.g. "every hour one sonnet + one FABLE drain; sweep every other hour").
4. `last_fired_at` doubles as liveness: flag any enabled routine whose last_fired_at is older
   than 2× its cron interval — that's a silently-dead routine (check its claude.ai session list).

## Change procedure (enable / disable / re-cadence)

Operator-directed changes are pre-authorized — apply, verify, report; don't re-confirm unless the
instruction is ambiguous about WHICH routine/account.

1. Resolve trigger id from the runbook table (or a fresh `list`).
2. Translate the operator's LOCAL-time intent to a UTC cron, keeping two invariants:
   - **Account stagger:** keep each account on its stagger minute (table above) so two routines
     never hit the shared repo in the same minute.
   - **Alternation idiom:** every-other-hour pairs use `M 0-23/2 * * *` vs `M 1-23/2 * * *`
     (even/odd UTC hours) — that's how "one sonnet AND one fable per hour" is spelled.
3. Apply — partial update, never resend the whole body for an enablement/cadence flip:
   - current account: RemoteTrigger action `update`, body `{"enabled": ..., "cron_expression": "..."}`.
   - other account: same worker pattern with prompt 'Call RemoteTrigger action "update",
     trigger_id "<id>", body {...}; then action "get" on it and Write the result to <file>.'
4. **Verify via `get`** (never trust the update response alone, and never trust a worker's exit
   code): confirm `enabled` + `cron_expression` + server-parsed `next_run_at`, and echo
   next_run_at back to the operator in LOCAL time.
5. Same session: update the enabled-state paragraph in
   `the project/docs/runbooks/cloud-drain-landing.md` so the runbook never lies about live config.

## Why the `claude -p` workers are still here (plan 1928, 2026-07-16)

The worker pattern above is expensive and its exit codes are unreliable, so plan 1928 tried to
replace it with a direct-HTTP CLI. **It cannot be done — do not re-attempt it:**

- `/v1/code/triggers` (what RemoteTrigger calls) is an **internal** API backing Claude Code's own
  session, not on the public edge. A direct GET with a _valid_ OAuth bearer + `anthropic-beta:
oauth-2025-04-20` returns **404 `not_found`** — not 401, so auth is accepted and the route just
  is not there. Verified live against an account RemoteTrigger simultaneously lists at 200.
- The public namespace is `/v1/claude_code/routines/...` and exposes **only `fire`**. The docs are
  explicit: _"There is no public API for token management"_; _"API triggers are added to an
  existing routine from the web. The CLI cannot currently create or revoke tokens."_
- Do **not** reverse-engineer the internal base out of the CLI bundle — coord machinery on an
  unversioned internal API breaks silently on any Claude Code update.

So **list / enable / disable / cadence flips stay exactly as documented above** (RemoteTrigger for
the current account, a `claude -p` worker for the others). Only _firing_ got a no-LLM path — below.

## One-shot fire ("start a sonnet on zed now")

**Account default (operator 2026-07-19): when the operator asks to launch one-shots WITHOUT
naming an account ("trigger 2 sonnet sessions"), fire ALL of them from the CURRENT session's
account (e.g. acct-b in a acct-b session) — firing the same trigger N times is fine, the claim
machinery keeps concurrent sessions apart.** Never spread across accounts on your own; other
accounts' routines fire only when the operator names the account.

RemoteTrigger action `run` (POST /triggers/{id}/run) starts the routine IMMEDIATELY — the cron
schedule and even `enabled: false` are ignored, and the regular schedule is unaffected. This is
how ad-hoc drain firings and one-off probes work; operator-directed one-shots are pre-authorized.

**Preferred for a non-current account: `node the project/scripts/routine-ctl.mjs fire --routine
<account>/<kind>`** (e.g. `zed/sonnet-full`; `routine-ctl.mjs list` shows the inventory and which
routines are fireable). The live kinds are `spec-sweep` / `sonnet-full` / `fable-full` — the trusted
`sonnet-drain` / `fable-drain` pair was deleted on all four accounts 2026-07-19, so those aliases no
longer resolve. **There is still no `sol` routine KIND, and since plan 3461 you do not need one — fire an
ordinary drain instead.** Operator ruling 2026-08-26 ("Sol by default") made `execModel: sol`
drain-claimable and LANE-AGNOSTIC, permanently — that claim-eligibility is independent of whichever
lane `scripts/exec-model-default.json` currently names as the STAMPING default (`node
scripts/exec-model-default.mjs` to read it; the project `docs/runbooks/plans-workflow.md` § Sol executor
lane has the live value and history), so sol units keep existing and riding ordinary drains at
whatever rate new plans are being stamped `sol`. So either lane's
`sonnet-full` / `fable-full` can select and
execute a sol unit, and both drain prompt bodies carry a Sol lane section that substitutes
`codex exec` dispatches for Sonnet subagents. "Trigger N sol" therefore means N ordinary drain
fires, **on a FULL-EGRESS routine** — `solEnvExclusion()` in `scripts/queue-drain.mjs` clears sol
only there (`SOL_FULL_EGRESS_CLOUD_SUPPORTED`, plan 3380 fixed the hook-injection blocker) and
still refuses it on a trusted/limited-egress env, which cannot reach `api.openai.com` at all.
Verify the pool with the drain's OWN oracle invocation before firing, never by reading plan
frontmatter: `node scripts/queue-drain.mjs --cloud --env full --no-mutex --no-heal` and check the
eligible entries carry `"lane": "sol"`. **The one-shot `sol-single` trigger is NOT that vehicle:**
its body PINS one plan id and forbids substituting another, so it is only for a plan the oracle
will not hand out, and firing it N times puts N sessions on the SAME plan — acct-c's copy was still
pinned to the already-succeeded 3396 on 2026-08-26. Re-pinning it is a prompt-BODY change and out
of this skill's scope (§ Boundaries). It is a single authenticated POST to the documented `/fire` endpoint — no
`claude -p` worker, no LLM tokens, no unreliable worker exit code. **As of 2026-07-20 (plan 2121)
8 of 12 tokens are minted and live-verified: every `sonnet-full` + `fable-full` on all four
accounts is fireable; the 4 `spec-sweep` tokens are deliberately unminted** (sweeps are
cron-driven) — those skip with "no token", use the RemoteTrigger or worker paths for them.
It needs a **per-routine**
`sk-ant-oat01-…` API-trigger token (NOT the account's OAuth token), minted by hand in the web UI
(open the routine → add an API trigger) and stored in `the parent folder/.env` as
`ROUTINE_FIRE_TOKEN_<ACCOUNT>_<KIND>`. A routine whose token is not minted yet prints an actionable
skip; fall back to the worker pattern below for that one.

Otherwise:

1. Resolve the trigger id (runbook table / `list`).
2. Current account: RemoteTrigger action `run`, trigger_id `<id>`. Other account: the worker
   pattern with prompt 'Call RemoteTrigger action "run", trigger_id "<id>", then Write the
   response JSON to <file>.'
3. The response carries a `session_id` (`cse_…`) — report it plus where the run is visible
   (that account's claude.ai/code session list). A drain fired this way runs the full autonomous
   claim→work→review→land path; the claim machinery makes it safe beside scheduled firings.
4. Track completion from git, not the API: watch for the claim / branch / land commits — check a
   specific plan with `node scripts/claim-plan.mjs status <id>` (a raw `git ls-remote origin
'refs/claims/*'` is stale: claim refs live under `refs/heads/coord/claims/*` since plan 3756,
   and a ref existing no longer proves a claim is live, since release now tombstones rather than
   deletes) — since other accounts' session views aren't visible.
5. One-off custom jobs (not a standing drain) follow the same shape: create a DISABLED trigger
   with a far-future cron (e.g. `0 3 1 1 *`), `run` it, and delete or keep it as a template —
   precedent: the 2026-07-14 sandbox capability probe on home.

## Boundaries

- Prompt/body content, allowed_tools, model, and environment (secrets) changes are OUT of scope —
  those follow the v-generation sync in `cloud-drain-autonomy.md` / `cloud-drain-landing.md`.
- Never create or delete triggers here except on explicit operator instruction naming the routine.
- If the operator only asks what SHOULD be enabled (config intent, not liveness), answer from the
  runbook inventory and say when it was last verified — no fan-out needed.
