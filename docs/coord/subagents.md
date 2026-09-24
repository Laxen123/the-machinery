# Delegated work, kept honest

An orchestrating agent that reads and edits everything itself burns its most expensive resource —
the context window of its most capable (and most expensive) model — on work that needed no judgment
at all: scanning a hundred files for a pattern, rewriting the same mechanical edit across a corpus,
running a test suite and reading its output. That is the problem delegation solves. But delegation
creates three new failure modes of its own: a delegated worker can drift outside the task it was
given and edit things nobody asked it to touch; it can silently inherit an expensive model when
nobody pinned the cheap one; and it can start a job that outlives its own turn — a push, a long
build — and either vanish while "still working" or get reported complete while its last words say it
is waiting. This document is the discipline that gets the savings without those three costs.

## The thin-orchestrator doctrine

The rule of thumb: the expensive model spends its context on _judgment_ — how to frame a task, where
a change belongs, whether a result is correct, what a returned diff actually did — and delegates
everything else: bulk reads, corpus scans, and mechanical multi-file edits. The savings are real and
measured: one published benchmark of exactly this shape (a heavy orchestrating model handing bulk
work to a cheaper worker model) found the pairing scored 96% of the heavy model's solo performance
at 46% of the cost. The economics only hold if bulk content never enters the orchestrator's own
context — every rule below exists to protect that one invariant.

Four rules keep the split honest:

1. **Never bulk-read or bulk-edit yourself.** Delegate the reads, the searches, the edits. You
   consume conclusions and decide.
2. **Verify through gates, not eyes.** Tests, a build, a review fan-out — never trust a delegate's
   diff by reading it end to end. The moment you read every returned diff to trust it, you are
   paying for the delegate AND paying the full cost to verify it, and the whole arrangement stops
   paying for itself. If no gate covers a risk you care about, add the gate — it is cheaper than
   reading, and it is permanent.
3. **Write each decision into durable state as it is made**, not at the end of the session. A
   session can die mid-work; a decision that only lived in the conversation dies with it. The plan
   or task record is the artifact that survives; the orchestrator's own context is disposable.
4. **The downgrade tripwire:** if three consecutive delegations in a row needed no judgment call
   from you at all, the work was routed to the wrong lane. Hand it to whatever cheaper, more
   mechanical execution mode your system has, and stop paying heavy-model rates for work that never
   needed heavy-model judgment. (A lane explicitly reserved for purely mechanical execution is
   exempt from this tripwire by design — a long run of judgment-free steps is the _point_ there, not
   a symptom of mis-routing. See `plan-lanes.md`.)

The mirror image matters too: a task that is genuinely bulk-shaped (many independent files, a real
corpus, dozens of similar items) but never gets a single delegation dispatched is the opposite
failure — the orchestrator doing bulk work itself instead of handing it off, which defeats the whole
doctrine from the other direction. If your system can detect the shape of a task from its own
description, have it warn (not block) when a bulk-shaped task crosses a large number of direct file
operations with zero delegated dispatches.

## The scope block — every dispatch carries one

A delegated worker is only as safe as the boundary drawn around it. Every dispatch prompt carries an
explicit scope block, in the prompt text itself — never stated beside the prompt, where it will not
reach the worker. Four parts, always:

1. **Goal, in one sentence.** What this dispatch is for, stated plainly enough that a worker with
   zero other context can act on it.
2. **Files it MAY modify.** An explicit allowlist — a path, a glob, or "whatever the task's own
   declared surface names."
3. **Files it MUST NOT touch — with an explicit catch-all.** Every other surface a neighboring task
   owns, plus a closing "anything outside the allowlist" clause. Naming only the specific dangerous
   files leaves everything unnamed implicitly permitted, which is the opposite of the intent.
4. **Report, don't fix, anything out of scope.** A worker that notices a real problem outside its
   allowlist writes it down and returns it — it does not expand its own mandate to fix it. Scope
   creep under the banner of "I was already looking at that file" is exactly what this exists to
   prevent.

The orchestrator's obligation does not end at writing the block. When a worker returns, **diff the
actual change against the scope it was given**, and revert anything that falls outside it — a scope
block is a contract the orchestrator enforces on the result, not a suggestion the worker is trusted
to have honored. A worker that returns having touched a file it was told not to touch is a finding
about that dispatch, not a shrug.

A worked example of the shape, adapted from a real deterministic-execution lane's dispatch prompt:

```
## SCOPE — DO NOT EXCEED
Goal: <one sentence — what this dispatch accomplishes>.
Files you MAY modify: <the declared file surface for this unit of work>.
Files you MUST NOT touch: anything outside the allowlist; shared coordination
state; anything another concurrent dispatch owns.
Out-of-scope issues: report them, do NOT fix them.

Execute the task. Push after every commit. If your diff changes what a
shared function returns or filters, run the test-selection tool before
trusting your own green run — narrowing by your own judgment is exactly
the gap that tool exists to close.

Final message MUST be ONE structured object: {status, shipped_ref, findings,
carry_forward, notes}. status ∈ {completed, blocked, needs_decision, yielded}.
```

## Model pinning — never let a dispatch inherit the session model

Dispatch tools default to inheriting the calling session's own model unless a call explicitly
overrides it. In a heavy orchestrating session, an unpinned dispatch is therefore silently a
heavy-model worker running at heavy-model rates — the exact cost the whole doctrine exists to avoid,
incurred by omission rather than by decision. **Pin the model explicitly on every single dispatch
call.** This is a one-line discipline with an easy, invisible failure mode if skipped: nothing
errors, nothing warns, the bill is just wrong.

## Foreground-only for a delegated worker's pushes and long jobs

A delegated worker must run its own pushes and any long-running job in the **foreground**, never
backgrounded, and must never leave a background task running when it ends its turn. The reason is a
mechanism, not a style preference: the harness fires a task's "completed" notification when the
worker stops with no live background children — so a worker that backgrounds its own push and then
ends its turn is reported _complete_ while its last words in the transcript say it is still waiting
on that push. Nothing is watching the background job after that point; nothing will ever notice if
it fails.

This was measured, not assumed: across roughly 2,500 delegated runs in one deployment of this
pattern, a worker that backgrounded anything at all stalled mid-run about 32% of the time, versus
roughly a quarter of one percent when it backgrounded nothing — and a backgrounded push specifically
stalled **46% of the time**, versus about 1% when the same push ran in the foreground. That is not a
marginal difference; backgrounding a push in a delegated worker is close to a coin flip on losing
the work silently.

The rule that follows: **any job that genuinely cannot finish inside one foreground call belongs to
whoever owns the next turn** — never to a background task nobody is watching. A delegated worker
facing that situation commits what it has, reports the state plainly, and hands the remaining work
back to its orchestrator rather than backgrounding it. The orchestrator — which does own a "next
turn" in a way a one-shot worker does not — is the only layer allowed to hold a job open across
time. If the underlying harness itself backgrounds a timed-out foreground command against the
worker's wishes, the worker does not sit and wait for that background task's own completion
notification either — it reports the handed-off task's identity and the remaining work, and ends its
turn. Waiting on it would be exactly the same stall, just delegated one level further down.

## Self-yield budgets — a worker bounds itself

A silent-hang detector (output staleness on the tool's own monitoring layer) catches a worker that
has stopped entirely. It does nothing for a worker that is still actively working — just slower and
worse, deep in an overloaded context window, than it was when it started. So the bound has to live
_inside_ the dispatch, self-enforced:

Every long-running or fix-loop dispatch carries a stated budget — commonly something like "20
minutes wall-clock or 5 distinct fixes, whichever comes first" — written into the prompt text
itself. On breach, the worker does not grind on. It:

1. Commits whatever is complete and internally green, and confirms the push actually reached the
   remote.
2. Leaves the working tree clean — reverts anything half-finished it did not commit, rather than
   leaving dirt for the next worker to inherit.
3. Returns a **compact handoff**: what it fixed, what remains, anything it learned that the next
   worker should not have to re-derive, and which files it touched or reverted.
4. Stops.

**Returning under budget with work remaining is a success, not a failure.** The orchestrator
verifies the push landed, confirms the tree is clean, and dispatches a _fresh_ worker on the same
unit carrying that handoff — new context, work already saved. Grinding past the budget instead of
yielding is the actual failure mode this guards against: a worker's usefulness per unit of context
degrades as that context fills, and pretending otherwise is how one unit eats an entire session's
budget alone.

**The yield chain itself is capped.** Without a cap, "a yield is not a failed attempt" would make a
unit of work infinitely re-dispatchable, and one stubborn unit could consume an unbounded share of
the whole run. A small fixed number of consecutive yields on the same unit (three is a reasonable,
commonly used default) is the ceiling; past it, the unit is bigger than the yield model can absorb,
or its budget was sized wrong for it — either way that is a decision for a human or a heavier
judgment pass, not more dispatching. Park it with the accumulated handoffs as the open question.

## The mis-routing signal

The downgrade tripwire above (three judgment-free delegations in a row) is really one instance of a
broader signal: **repeated delegations that need no judgment mean the work item itself was filed to
the wrong execution lane.** If an entire unit of work turns out to be mechanical from start to
finish, it should never have needed a heavy orchestrating session driving it one dispatch at a time
— it belongs on whatever lane in your system exists for exactly that shape (batched, deterministic,
cheap-tier execution). Catching this early is cheaper than running the whole unit through the
expensive lane and noticing only in hindsight.

## The bug-fix burndown pattern

A list of failing tests or review findings handed to one worker, one at a time, is a serial
bottleneck by construction: fix, re-run, read the output, next failure — with every test dump and
every file read staying resident in that one worker's context. It degrades worse than linearly,
because the last failures on the list cost far more than the first ones did, at an already-swollen
context size. The fix is not "more workers" applied naively — fanning out one worker per raw failure
is its own trap, because a batch of failures is very often ONE root cause wearing many faces, and
un-triaged fan-out just means N−1 workers independently re-discovering and re-fixing the same bug,
frequently colliding on the same file.

The pattern that actually works:

1. **Triage first, always.** Group the failures or findings by root cause and by which files they
   touch, before dispatching any fix work at all. This triage pass can itself be a cheap delegated
   scan, or a quick inline read if the list is short. The triage output — one cluster per root
   cause, plus the files it touches — is the real unit of work, not the individual failure.
2. **Fan out per cluster, not per failure**, once triage shows two or more genuinely independent
   clusters. One scoped fix worker per cluster: fresh context, model pinned explicitly, a scope
   block whose allowlist is that cluster's files and whose must-not-touch list names every _other_
   cluster's files.
3. **Disjoint write-sets are a hard precondition for running clusters in parallel.** Two workers
   editing the same file concurrently is the failure this whole arrangement exists to avoid;
   clusters whose files genuinely do not overlap can run in parallel (each staging its own changes
   by explicit path, never a blanket add, and retrying briefly on an index lock), and clusters that
   do overlap run serially in one worker instead.
4. **Verify with targeted runs per cluster; run exactly ONE full verification at the end**, after
   every cluster has merged. Running the full suite per worker thrashes whatever shared test
   infrastructure exists and turns a fan-out win back into a net loss.

## Worker sizing — split a big wave by disjoint file cluster

A large batch of independent work handed to one worker serializes what should have been parallel,
and carries the worst-case loss on top: the worker dies at its own context limit with the whole diff
sitting uncommitted, and everything it did is lost in one shot. When a wave crosses roughly eight
items, or three natural clusters, split it by **disjoint file cluster** rather than dispatching it
whole. Parallel workers sharing one working tree are safe exactly when their file allowlists
genuinely do not overlap — each stages its own changes by explicit path, never a blanket add, and
retries briefly on an index-lock collision rather than colliding silently.

Two supporting habits make this safe in practice. First, **checkpoint commits are mandatory on any
dispatch expected to run long** — commit completed, internally-green work before continuing, rather
than saving everything for one commit at the very end; a single end-of-task mega-commit is the
anti-pattern this exists to prevent. Second, **expect the silent-stall shape**: a worker that goes
quiet with no report has usually _finished_ and failed to send the report — most often because it
exhausted its context right at the finish line. Before re-dispatching a worker that appears stalled,
check the working tree for its commit or diff first; re-running work that already happened wastes
exactly the budget this whole pattern exists to save.

A single worker remains the right call when the items share a genuinely sequential dependency on the
same files — sequence the phases instead of trying to force a parallel split onto a chain that
cannot actually run in parallel.

A worked dispatch for one cluster inside a burndown, showing the shape once concretely. It reuses
the same four-part scope block above rather than restating it; what is shown here is the
one-sentence Goal (which is never boilerplate — it is different for every dispatch, and a block
without it is not a usable dispatch), the cluster-scoped allowlist, the exact failing commands, and
two clauses the general template does not carry: budget-and-yield, and
verify-with-targeted-commands-only. The report-don't-fix clause from the general block still applies
and is not repeated.

```
Goal: fix the timeout-handling cluster (3 failing tests, one root cause: a
retry loop that never re-reads its own deadline).
Files you MAY modify: <this cluster's files>.
Files you MUST NOT touch: <every other cluster's files>; shared config.
Exact failing commands: <the specific targeted test invocations>.

Budget + yield: 20 minutes or 5 fixes, whichever comes first. On breach,
commit + push what is green, leave the tree clean, return a compact
handoff, stop — that is a success, not a failure.

Verify with the targeted commands above only; do not run the full suite —
the orchestrator runs exactly one full verification after every cluster
merges.
```

## Red flags — you are about to break the doctrine

| Thought                                                        | Reality                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| "Faster to just read or edit it myself"                        | Each such read is bulk content, resident at heavy-model rates for the rest of the session. Delegate it.                              |
| "I need to see the diff myself to trust it"                    | That is what gates are for. Reading every diff to verify it pays the delegation cost twice.                                          |
| "12 things are red — dispatch 12 fix workers"                  | Triage first. N failures are frequently one root cause; un-triaged fan-out wastes N−1 workers on the same fix.                       |
| "It's still making progress, let it keep going"                | Progress at a swollen context is not the same progress it was at a fresh one. The budget is the point — yield and re-dispatch fresh. |
| "I'll record the decision at the end of the session"           | Sessions die mid-work. A decision is recorded the moment it is made, not planned for later.                                          |
| "The scope block is basically boilerplate, I'll keep it loose" | A loose allowlist and an incomplete must-not-touch list is what scope drift looks like in hindsight.                                 |

## Common mistakes

| Mistake                                             | Why it bites                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Letting a dispatch inherit the orchestrator's model | An unpinned dispatch silently runs at the expensive tier — no error, no warning, just a wrong bill.                                                                   |
| "It's faster if I just read/edit it myself"         | Every such read is bulk content resident in the expensive model's context for the rest of the session — exactly what delegation exists to avoid.                      |
| "I need to see the diff to trust it"                | That is what gates are for. Reading every diff to verify it defeats the economics twice over.                                                                         |
| Fanning out one worker per raw failure              | N failures are frequently one root cause; un-triaged fan-out wastes N−1 workers re-discovering and re-fixing the same bug.                                            |
| Writing the scope block loosely, "to save time"     | A vague allowlist and an incomplete must-not-touch list is what scope drift looks like in hindsight — the block IS the judgment work, not overhead competing with it. |
| Backgrounding a delegated worker's own push         | Reported complete while the push is still pending — nothing is watching it after that point.                                                                          |
| A single end-of-task mega-commit on a long dispatch | The worst-case loss: dying at the context limit with the whole diff uncommitted and nothing to recover.                                                               |
| Treating a yield as a failed attempt                | It isn't — a yield under budget with a clean handoff is success. Only a genuinely red result after a real fix attempt counts against a bounded-retry limit.           |

## Costs and limits

Delegation is not free. Every dispatch pays spin-up latency and prompt overhead that a worker doing
genuinely tiny work will not amortize — for a small, judgment-dense task, executing it inline in the
orchestrating session is the right call, and dispatching a worker for it is pure overhead. Writing a
good scope block also takes real orchestrator effort; treat that effort as the judgment work itself,
not as overhead competing with it — a vague or missing scope block is exactly what produces the
drift this whole document exists to prevent. And none of this replaces actually verifying returned
work: a gate you never built, or a diff you never checked against scope, means a delegate's mistake
ships exactly as easily as a diligent human's would have. The discipline buys cost and context
savings on genuinely bulk-shaped work; it does not buy correctness for free, and it does not remove
the need for judgment — it relocates the judgment to where it is cheapest to apply.

## See also

`plan-lanes.md` for how a unit of work is routed to a judgment-heavy lane versus a purely mechanical
one in the first place; `review.md` for what happens to a delegate's returned diff before it merges;
`cloud-drains.md` for the same foreground-only and hand-off discipline applied to a session with no
human watching at all; `landing-queue.md` and `land-spine.md` for what "the orchestrator owns
pushes" means once a diff is ready to merge.
