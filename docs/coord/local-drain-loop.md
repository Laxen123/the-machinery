# The local drain loop

> **This file IS the `/local-drain` procedure.** The slash command `.claude/commands/local-drain.md`
> is a pointer stub carrying no doctrine, for the same unattended-safety reason as its `/orchestrate`
> twin (see the note at the top of [`orchestrator-loop.md`](orchestrator-loop.md)): doctrine kept
> under `docs/` keeps future orchestration plans runnable unattended. Add doctrine here, never back
> into the stub.

This command IS `/orchestrate` with THREE modifications: (1) the Step-2 pick excludes plans the
unattended drains can take and merges BOTH oracle lanes (the default mechanical lane and the heavy
lane); (2) a heavy-lane or `sol`-lane pick is executed by THIS session inline, under the
thin-orchestrator doctrine, instead of being dispatched to a worker; (3) a runnable execution batch
is taken as one train. **Read [`orchestrator-loop.md`](orchestrator-loop.md) now and follow it
exactly** — the same operating contract, bootstrap, pace check, claim/verify/land steps, parking,
window stop, guardrails, and the same journal (`.scratch/orchestrator-state.json`: a `/local-drain`
run and an `/orchestrate` run are the same run, resumed). Everything below overrides ONLY Step 2
and, for heavy-lane, `sol`-lane and batch picks, Steps 3–4.

The concept behind the inline lane is [`subagents.md`](subagents.md) § The thin-orchestrator
doctrine; the lane stamps are [`plan-lanes.md`](plan-lanes.md) § Executor lanes and model
allocation; the eligibility stamp is [`cloud-drains.md`](cloud-drains.md) § The autonomy axis.

**Arguments** arrive through the command stub's `$ARGUMENTS` slot (this file is READ, not expanded —
take them from the stub's invocation) and pass straight through to `/orchestrate`'s argument slot: a
budget override such as `--dispatch-ceiling 70`, or a plan-id allowlist. An allowlist here
INTERSECTS with the local-only filter and the merged pool; it never widens either.

## Why this filter exists

Scheduled unattended drains can only take plans stamped `cloudExec: true`
([`cloud-drains.md`](cloud-drains.md) § The autonomy axis; the roster is the `/ready-plans`
command), in BOTH lanes — the unattended mechanical drain and the unattended heavy drain each
require the stamp. A live local session is the scarce resource: spend it on the plans ONLY it can
run, and leave every unattended-eligible plan to the scheduled drains. Before this command had a
heavy lane, a heavy-lane plan without the stamp had no drain at all — it waited for someone to pick
it up by hand.

## Modification 1 — Step 2 (pick) runs the merged two-lane oracle

At EVERY Step-2 iteration, instead of the bare `node scripts/queue-drain.mjs`, run:

```bash
git pull --ff-only
node scripts/coord/local-drain-filter.mjs
```

The filter runs BOTH oracles (`queue-drain.mjs` for the default lane and with `--lane fable`) and
partitions their `eligible[]` by the plan file's `cloudExec:` stamp. A plan is unattended-eligible
if and only if it is stamped `cloudExec: true` — the unattended oracles' primary gate. `false`,
unset, or no frontmatter at all means only a local session can run it. The filter applies to both
lanes.

**Never inline this read again.** An earlier version was an inline script whose stamp read sliced a
fixed number of leading BYTES from each plan file; since plan frontmatter leads with a
multi-sentence summary, `cloudExec:` routinely sat past that window and read as `unset` — about a
third of the offered plans were misread on one board, some of them unattended-reserved plans handed
to a local session. The filter reads through the same frontmatter reader the oracle uses.

The JSON on stdout carries these buckets, plus a `warnings[]` list (also echoed to stderr):

| Bucket                          | Meaning                                                                                                                  | Claim from it?                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `localOnly[]`                   | Locally-executable singles, each carrying the stamp actually read (`"false"`, `"unset"` or `"no-frontmatter"`)           | **Yes** — the only single-plan source |
| `localBatches[]`                | Execution batches every member of which is takeable right now                                                            | **Yes, first** — see below            |
| `droppedCloudEligible[]`        | Singles stamped `true` — they belong to the scheduled drains                                                             | Never; informational                  |
| `droppedCloudEligibleBatches[]` | Batches every member of which is stamped `true`                                                                          | Never; informational                  |
| `staleDropped[]`                | A mid-move race: the file vanished between the oracle's listing and the stamp read (another session claimed or re-filed) | Never; the next iteration re-reads    |
| `unreadable[]`                  | NOT a race: the file was there but could not be read (a wrong working directory, a permission problem)                   | Never; report it as a defect          |
| `skippedBatches[]`              | The oracle's own withheld trains, each with the member that withheld it                                                  | Never; report it                      |

Pick from `localOnly[]` only, value-ranked exactly as `/orchestrate` Step 2 says (unblockers first,
then cheap high-confidence wins, then window fit) across BOTH lanes — no forced lane preference. The
stamp each entry carries is what the end-of-run "unstamped" list is built from. A non-empty
`unreadable[]`, or any `warnings[]` line, is a defect to report in the run summary — never shrugged
off as queue churn. Re-run the filter on every iteration: the queue shifts as sessions land, stamp
and file.

**Run it from the MAIN checkout** (where the orchestrator operates): the oracle lists the main
checkout's `ready/` lane but emits repository-RELATIVE paths, so a foreign working directory
mis-resolves the stamp reads into `staleDropped[]`. **Fast-forward first — a bare `git fetch` is
NOT enough:** the oracle and the stamp reads consume the WORKING TREE, so a stale local trunk lists
plans other sessions already claimed or re-filed, and hides the lane moves the remote already
carries.

**Heavy-model gate on the heavy lane.** Pick a `lane: "fable"` entry ONLY if the running session's
own model is heavy-tier. A cheap-tier session skips every heavy-lane entry, drains the mechanical
lane as normal, and notes ONCE in the end-of-run summary: "heavy lane skipped — session model below
the heavy gate; N plans waiting". Never dispatch a heavy-lane plan to a worker as a workaround:
`execModel: fable` means the heavy model's OWN context makes the judgment calls, not a briefed
worker's.

**`localBatches[]` — if a train is runnable you MUST take it.** The filter also partitions the
oracles' runnable batches, in both lanes, so every host × lane combination has an automated batch
path. Each entry is a proposed execution batch every member of which is takeable right now (it
carries its slug, lane, members, their slugs and paths, the mutation-banner bit, each member's
`cloudExec` stamp, `rankedBy`, priority and cost). This bucket exists because a batch-held plan is
deliberately ABSENT from `eligible[]` — the solo-claim hold that stops the fastest claimer from
dissolving a train — so without it, a grouped pair would be invisible here and executable by
nothing.

**A train is never passed over.** When `localBatches[]` is non-empty, take its FIRST entry before
picking any single plan. The array is already ordered by each train's BEST member under the exact
ranking single plans use (`rankedBy` names that member), so the first entry outranks `localOnly[0]`
by construction: a batch rides the priority of its best member, and "the next plan I would have
picked is batch-held" means the train IS the next unit of work. Do not re-rank batches yourself, and
never claim a train partially.

A batch whose members DISAGREE about `cloudExec` is offered here anyway, with a
`MIXED cloudExec BATCH` warning. It can never be runnable in the unattended lane (an unstamped member
is excluded before the batch gate), so withholding it locally too would leave it unexecutable
everywhere. Report the warning and take the train.

**`execModel: sol` plans appear here too**, folded into whichever lane's bucket they were picked up
under — the oracle admits them lane-agnostically under both runs, and there is no separate
`sol` value for `--lane`. Execute a claimed `sol` pick per Modification 2, exactly like a heavy-lane
pick, with one substitution: the cheap workers are `codex exec` dispatches. (The one environment
that refuses `sol` — an unattended sandbox with no route to the codex API endpoint — is irrelevant
here, since this is the LOCAL drain.)

**An empty `localOnly[]` with a non-empty `droppedCloudEligible[]` is SUCCESS, not a reason to
widen.** Report "local-only queue empty; N unattended-eligible plans left for the scheduled drains"
and proceed to `/orchestrate` Step 7. Never fall back to draining unattended-eligible plans under this
command. The same holds for `droppedCloudEligibleBatches[]`.

## Modification 2 — a heavy-lane or sol-lane pick executes INLINE (thin-orchestrator)

A `lane: "sonnet"` pick follows `/orchestrate` Steps 3–4 unchanged — claim, cut, dispatch a
cheap-tier worker, verify the diff, fix-now-triage its findings, land — which means it INHERITS that
step's budget + yield block and its triage-then-fresh-worker-per-cluster `fix` path. This file copies
neither, so edit them in [`orchestrator-loop.md`](orchestrator-loop.md) only. A `lane: "fable"` pick,
and a `sol` pick claimed under either oracle run, replaces the worker dispatch with inline execution,
per `coord/skills/pickup-plan/SKILL.md` § 8.7 (the shared thin-orchestrator recipe for both lanes):

1. **Claim and cut with the same deterministic tools** — never by hand:

   ```bash
   node scripts/claim-plan.mjs acquire <id> --slug <slug> --dispatch-mode local-drain-inline --model-id <this session's own model id>
   node scripts/cut-worktree.mjs <slug>
   ```

   As in `/orchestrate` Step 3, also pass the item's mutation-banner value through the claim tool's
   own flag for it.

2. **Execute the plan YOURSELF in that worktree under the thin-orchestrator doctrine**
   (`coord/skills/batch-train/references/thin-orchestrator.md`; concept:
   [`subagents.md`](subagents.md)). Spend your own context on judgment — framing, placement,
   correctness calls, verifying subagent output — and dispatch cheap-tier subagents (model pinned
   explicitly, each carrying a `## SCOPE — DO NOT EXCEED` block) for bulk work: wide reads, corpus
   scans, mechanical multi-file edits. A HARD delegable chunk whose decisions are already made (a
   gnarly refactor or extraction) may instead go to a heavier tier at high effort. Small plans (up
   to about a day of work) may run fully inline with no dispatches. **When this plan's own gates go
   red, the burndown is a fan-out, not a grind:** triage the failures into root-cause clusters,
   dispatch one scoped worker per cluster over DISJOINT write-sets, each carrying the self-yield
   block, and run exactly ONE queued full-suite verification at the end (thin-orchestrator
   § Bug-fix burndown and § Self-yield contract). Document every judgment call and its rationale in
   commit messages and in the journal entry, as you make it. If the plan's subject has a page in the
   wiki, read it IN FULL before the first edit, and never commit wiki changes on the worktree
   branch.

   **For a `sol` pick, the delegated workers are `codex exec` dispatches instead of cheap-tier
   subagents** (pickup-plan § 8.7); everything else in this step is unchanged. If the SAME gate or
   review finding comes back unfixed after two consecutive rework rounds on that lane, finish that
   one finding on the ordinary lane and record the switch in the plan body, naming the finding. A
   round that shrinks or changes the finding set keeps the plan on its lane, with no round limit —
   the lane never blocks real work.

3. **Standard land gates and review**, exactly as any worktree session: the type-check, test and
   build gates the touched surface calls for. For an application- or tooling-source diff, run the
   session's default review lane — **`/gpt-review` on a local session** (the Workflow-driven
   `/sonnet-review high` is the fallback when the codex transport fails) — fix significant findings,
   and record with `node scripts/record-review.mjs …` carrying findings and dispositions.
   Dispositions follow the fix-now test ([`review.md`](review.md) § Disposition policy): `--fixed`
   is the default; a deferral names the clause that failed and routes per the severity floor. Fix
   rounds follow [`review.md`](review.md) § Stopping rule — generate the must-fix-only brief with
   `node scripts/review-fix-brief.mjs <slug> --round <n>` and dispatch it to a fresh worker; never
   fix inline.

4. **Land deterministically:** `node scripts/done-worktree.mjs <slug>` — NEVER the deploy flag, and
   never a detached `--wait`. Record the land in the journal (`plans_landed` and `pending_deploy`)
   with a `lane: "fable"` (or `lane: "sol"`) note on the entry.

5. **Concurrency.** While a heavy-lane plan is mid-execution inline, do NOT start new mechanical-lane
   dispatches. Workers dispatched earlier may keep running; fold their completions when the brain is
   next free (after the heavy-lane plan lands or parks).

6. **Window accounting.** An inline heavy-lane plan burns THIS session's context and usage, not a
   worker's. Run the Step-1 pace check before every pick, and do not start a heavy-lane plan the
   remaining window cannot finish. If the window closes mid-plan anyway, push the branch as work in
   progress and park with a handoff note in the plan body (per `/orchestrate` Steps 5–6) — never
   leave it dangling. **This session-level work-in-progress push is NOT the worker self-yield
   contract:** this one is you saving your own run against the five-hour window; that one is a
   dispatched worker bounding its own context inside your run. Both can fire in the same iteration,
   and neither implies the other.

## Modification 3 — a `localBatches[]` pick executes as ONE train

A batch is one worktree, one review, one land, with the member plan files staying separate. Claim it
as a UNIT — never member by member, which is exactly the dissolution the solo-claim hold exists to
prevent:

```bash
node scripts/claim-plan.mjs batch <id1> <id2> ... --slug <batch-slug> --dispatch-mode local-drain-inline --model-id <this session's own model id>
```

The batch claim is all-or-release across every member's claim reference (one per member; see
[`claims.md`](claims.md) § All-or-nothing for a multi-item claim). It stamps the batch folder's
`batch.md` as `status: claimed` and writes its `manifest.json`. NEVER pass `--force` or `--stub-ok`.
If the batch claim loses a race, fall back to a single-plan pick from `localOnly[]`. Then cut ONE
worktree with `node scripts/cut-worktree.mjs <batch-slug>` and run the members back to back in it.

**Which conductor drives the train depends on the lane, and the two are not interchangeable:**

- **`lane: "sonnet"`** — the mechanical train. Invoke the `batch-train` skill YOURSELF as part of this
  drain iteration (this is the automated path; nobody needs to hand-invoke `/batch-train`): a fresh
  cheap-tier subagent per car, each with a `## SCOPE — DO NOT EXCEED` block naming every OTHER
  member's files as forbidden. A car still red after ONE fix attempt derails.
- **`lane: "fable"`** — the heavy conductor, behind the same heavy-model gate as a single heavy-lane
  pick. `batch-train` does NOT apply. Run each car yourself under the thin-orchestrator doctrine
  (inline when judgment-dense, pinned cheap-tier workers when bulky), writing each judgment call into
  that member's OWN plan body with `node scripts/edit-plan.mjs` as you make it. The derail rule
  relaxes to a bounded second fix attempt — you are the tier the mechanical train's one-attempt cap
  exists to defer to — but a car still red after two attempts derails like any other.

Either way: order the members by risk (shakiest last, unless another member depends on it), prefix
every commit subject with `<id>: `, keep each member's commits contiguous, push after every commit,
and run the gates each car's diff touches between cars. Derail a member with
`node scripts/move-plan.mjs <id> <matching waiting-* lane>` followed by
`node scripts/claim-plan.mjs derail <id>` (the single atomic reconcile), then CONTINUE with the
remaining members. Close ONCE: one review over the surviving combined diff, one `record-review.mjs`,
one `node scripts/done-worktree.mjs <batch-slug>` — never per-member lands. Journal the land with a
`unit: "batch"` note and one line per member (landed or derailed).

Parking is unchanged: a fork only the operator can resolve is parked
(`node scripts/move-plan.mjs <id> waiting-operator --blocked-by "…"`, or `waiting-grill` with a
`## Grill questions` section — see [`plan-lanes.md`](plan-lanes.md)), and the loop continues. The
heavy model does not upgrade "I could guess" into authority it does not have.

## Boundary notes

- An **unset** `cloudExec` counts as locally executable (the unattended oracles exclude unstamped
  plans too), but list every unset plan you land under "unstamped" in the end-of-run summary — a
  review-pass stamp might have made it unattended-eligible, and that stamping debt should stay
  visible to the operator. A `"no-frontmatter"` entry counts as unstamped too, and additionally says
  the plan FILE is malformed (no leading `---` block): report it as such, not as ordinary stamping
  debt. The stamping rubric itself: [`cloud-drains.md`](cloud-drains.md) § The cloudExec stamping
  rubric.
- The eligibility authority stays `scripts/queue-drain.mjs` (default lane plus `--lane fable`) plus
  the plan file's `cloudExec:` stamp. If a verdict looks wrong, that is a stamping question for a
  review pass — never restamp or hand-edit frontmatter from this drain.
- `/orchestrate` itself stays single-lane (the mechanical lane plus lane-agnostic `sol` picks); the
  inline heavy lane is a `/local-drain` override.
