# Running with nobody watching

An agent session running unattended — on a schedule, in a sandbox, with no human reading its output
as it works — cannot ask for help mid-task. If it takes an action that would normally pause for a
human's yes, there is no one there to click yes: the session simply sits, silent, until whatever
time limit eventually kills it. Worse, if it fails partway through and cannot signal that failure,
its state becomes indistinguishable from a session that never ran at all — which means whatever
mechanism is supposed to notice stuck or abandoned work sees nothing wrong, and the same unit of
work eventually gets picked up and redone by someone else while the first attempt's real,
possibly-finished work sits invisible and unmerged. This document is the set of mechanisms that make
unattended execution survivable: what such a session may decide on its own, how it proves it is
still alive when its normal channel is blocked, how two unattended firings avoid colliding on the
same unit of work, and how a session that hits a wall too big to solve exits cleanly instead of
freezing.

## The autonomy axis

Not every task is safe to run with nobody watching, and the judgment about which tasks are safe
cannot live inside the unattended session itself — by the time it discovers a task needs a human, it
has no human to ask. So the decision is made _in advance_, by whoever prepares the work item, and
recorded as an explicit flag on the item's own metadata: this unit of work either may run
unattended, or it may not, and if not, why not.

**The default should be permissive, with the burden of proof on excluding a task, not on including
it.** A conservative-by-default policy — "only run unattended what has been proven safe" — sounds
cautious but produces a worse failure in practice: a wrongly-excluded task just sits forever, exiled
to a human-attended lane nobody gets around to, invisibly. A wrongly-included task, by contrast,
fails fast and visibly the first time an unattended session actually hits the missing capability —
which is loud, immediate, and self-correcting. Given that asymmetry, the better policy inverts the
naive instinct: default new work to "runnable unattended," and require a real, specific,
evidence-backed reason to mark it otherwise.

The categories that genuinely warrant excluding a task from unattended execution are narrow, and
each one names a concrete missing capability rather than a vague discomfort:

| #   | Reason a task must park for a human                                                                                                                                                        | What it is NOT                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The work needs a real, rendered browser session beyond what the sandbox environment can provide — a live display, or a specific human's already-logged-in browser                          | "Needs a browser" alone — most browser automation runs fine unattended; only a genuinely irreproducible session doesn't             |
| 2   | The work must reach a specific host that the sandbox's network policy cannot reach even through its configured fallback routes                                                             | A plain, ordinary network fetch — those work unattended by default                                                                  |
| 3   | The work needs a credential that was deliberately withheld from the unattended environment (payment control, production-destructive access, anything the operator drew a hard line around) | A credential that is simply missing today but could reasonably be provisioned — provision it, don't exclude the task                |
| 4   | The work touches files outside the set of repositories the unattended session is permitted to check out                                                                                    | Files inside a repository that IS reachable, however deeply nested                                                                  |
| 5   | The work depends on machine-wide state that exists only on a specific human's own workstation (a local resource mutex, machine-local telemetry, another live session on that same machine) | A shared resource with its own cross-environment coordination mechanism — that mechanism covers it from any host, unattended or not |
| 6   | The work is a decision explicitly routed to a human, or requires that human's own account credentials to act as them                                                                       | A decision an unattended session could reasonably make itself and merely hasn't been told it may                                    |
| 7   | The work writes to a configuration path whose edit would trigger an unattended safety prompt with no approver present                                                                      | Ordinary application code, however sensitive its content                                                                            |
| 8   | The work performs a destructive or gate-bypassing action that an automated safety classifier will refuse without a direct human instruction naming that exact action                       | The classifier being over-cautious in general — that is the classifier working as intended, not a reason to route around it         |

Some observed anti-patterns are worth naming explicitly, because each one has been used, wrongly, to
exclude work that should have run unattended: "this needs reasoning" is not a reason — the whole
point of an unattended session with a capable model is that it _can_ reason; a task touching a
resource that already has its own cross-environment coordination mechanism does not need a _second_,
human-only lane on top of it; "this needs multi-session validation" almost always dissolves once you
check the task's actual acceptance criteria rather than assuming; and excluding a task merely
because it edits the _automation code itself_ is backwards — a reviewed, gated change carries the
same risk regardless of which environment produced it.

This axis is deliberately independent of how _hard_ a task is. A task can require deep reasoning and
still be perfectly safe to run unattended — reasoning is exactly what a capable unattended session
is for — while a trivial one-line task can still need a human's own logged-in account or a
credential nobody provisioned into the sandbox. Conflating "is this safe to run with nobody
watching" with "is this easy" produces exactly the kind of mis-stamped exclusion the anti-pattern
list above calls out.

**When only part of a task is unattended-safe, split it rather than sinking the whole thing.**
Measure (or, if measuring in advance is impractical, let the first unattended attempt itself be the
measurement) which portion of the work a sandboxed session can reach and which portion genuinely
needs a human vantage point. The reachable portion executes and completes on its own; the
unreachable remainder becomes its own new, explicitly-parked work item carrying the exact residue.
Never hold the reachable majority hostage to the unreachable minority, and never silently fold the
minority into the majority and hope nobody notices the gap.

## The prompt-template shape

An unattended session's operating instructions follow one fixed skeleton, regardless of what
specific work it ends up doing:

1. **Credential setup.** Whatever the environment needs authenticated before anything else runs.
2. **Checkout preflight.** Confirm the working copy is in a sane, up-to-date state before touching
   it — a stale local copy racing against work that has already landed elsewhere is a common,
   avoidable source of wasted cycles.
3. **A usage or budget gate.** Check remaining allowance before committing to a run; an unattended
   session that starts expensive work and then gets cut off mid-task by a hard resource ceiling is
   worse than one that never started.
4. **A drift report.** Say plainly what state the environment is in relative to expectations, so a
   human skimming logs later can spot an environment that has quietly diverged.
5. **A call to the eligibility oracle** — see below — to select the one unit of work to run this
   firing.
6. **Execute exactly one unit of work.** Unattended sessions are deliberately single-threaded at
   this level: one unit claimed, worked, and finished (or handed off) before the session's job is
   done. Running several units concurrently in one unattended firing multiplies every failure mode
   below.
7. **Review** the resulting change per whatever calibrated review process the system uses (see
   `review.md`).
8. **Land** the change through the normal, deterministic merge path — never a hand-rolled shortcut,
   because nobody is watching to catch a shortcut going wrong.
9. **An escape hatch**, always available, that produces a durable, visible hand-off instead of
   silence — detailed below.

### Why the eligibility oracle must be a program, not a prose instruction

The temptation is to describe eligibility in the prompt itself — "run this unless the item mentions
X or Y" — re-derived by the model on every firing. That fails in both directions: a task needing a
capability the sandbox genuinely lacks gets picked anyway and the firing stalls, wasting the whole
run; and a task that merely _mentions_ an excluded keyword in passing prose gets wrongly skipped,
starving a lane that should have had work to do. A hand-rolled, prose-based eligibility check is
fragile exactly where it matters most — at the boundary between "safe" and "not safe" — and a
fragile check at that boundary is worse than no check, because it looks authoritative.

The fix is to make eligibility a small, deterministic **oracle program** — a single piece of code
that reads each candidate work item's structured metadata (the autonomy flag above, any cross-item
blocking, any resource mutex state) and returns the one item to run next, or a specific
machine-readable reason why nothing is eligible right now. The unattended session calls the oracle
and does exactly what it returns — it never re-derives eligibility itself from reading item bodies.
This also makes the policy auditable and centrally correctable: a bad eligibility call is a bug in
one program, fixable in one place, rather than a drifting inconsistency across every prompt that
re-implements the same judgment slightly differently.

## The heartbeat channel

An unattended session's only reliable signal of its own state, to everything outside it, is a
**successful push** to the shared repository. Every other observability surface — claim records,
progress markers, queue state — ultimately derives from pushed commits. That creates a structural
blind spot: if a push is _rejected_ by a pre-merge check partway through a run, the session is, from
the outside, byte-for-byte indistinguishable from a session that never started. Every detector that
watches for stuck or abandoned work is blind to it by construction, and the standard remedy for
apparent abandonment — declaring the claim dead and letting someone else redo the work — actively
fires on a session that is not dead at all, just quietly stuck behind a failing check.

The fix is a small, dedicated **status channel**: when a normal push is rejected, the session
publishes a tiny, separate status record — a heartbeat, a count of how much finished work is being
held, and the name of whatever check is currently failing — through a path that is deliberately
exempt from the very check blocking the main push (exempted by the _content_ of that specific push
being pure status data, never by a flag anyone could set on an ordinary push to dodge review). A
fresh heartbeat tells every downstream detector "this session is alive and blocked on a known, named
thing," which suspends any dead-work reclamation clock and gives a human a precise, actionable state
to look at rather than a mystery. Publishing this costs the session almost nothing — it is a small,
separate write, not a retry of the expensive blocked operation.

## Dead-session detection and the marker convention

Two unattended firings can pick the same unit of work if nothing stops them — one wastes its whole
run duplicating the other's effort, and worse, they can produce conflicting results that neither
side notices. The standard fix is a lightweight **marker**: the moment a session decides which unit
of work it is taking, before it has done any of the work, it stakes a small, visible marker naming
that unit and that session. A second firing checking the same unit sees the marker and skips it.

Two details make this reliable rather than a race condition of its own:

- **Stake the marker at selection time, not completion time.** Staking only after the work is done
  protects nothing — the whole race happens in the window between two sessions both deciding to take
  the same unit and either of them finishing. The marker has to exist from the moment of intent, not
  the moment of completion.
- **A staking collision is not an error — it is information.** When a session tries to stake a
  marker and finds one already there, that specific, distinguishable outcome means "another firing
  already owns this unit; skip it cleanly," which is entirely different from a genuine failure to
  write. Conflating the two — treating a collision as a crash, or treating a crash as "someone else
  has it" — either silently skips real work that needed doing, or duplicates work a collision should
  have prevented.

Liveness of a marker is typically judged by the timestamp of its last real update, not by a
separate, always-on heartbeat write — a session that is genuinely still thinking, rather than idle,
can therefore look momentarily stale without actually being dead. That is an accepted, bounded cost:
a marker looking prematurely adoptable is not itself catastrophic, because adopting someone else's
apparently-stale work is a deliberate, visible human or oracle act, not an automatic one.

## The escape hatch — a clean exit is a success, not a failure

An unattended session that hits something it genuinely cannot resolve — a check it cannot get past,
a decision it cannot safely make alone — does not sit and hope, and does not silently give up
leaving no trace. It runs a fixed exit sequence:

1. **Commit and push everything, even if it is broken or incomplete.** Partial, honestly-labeled
   work that a human or a later session can pick up is worth far more than work that vanishes
   because it was never saved. A push carrying broken or incomplete work can itself be refused by a
   blocking check — that is exactly the case the heartbeat channel above exists for: publish the
   status record naming the failing check, so the session reads as visibly blocked rather than
   silently indistinguishable from one that never started. A work-in-progress commit is often best
   aimed at a side branch that carries no check obligation of its own, rather than forced at the
   branch the checks actually gate. That side branch is for PRESERVATION, not for landing: nothing
   merges from it, and whatever eventually does land still passes every check the gated branch owes,
   in full. Routing around a blocking check to get work merged is never what this step authorises —
   the point is only that unfinished work should survive the session that produced it. Whichever
   route the work ends up on, the hand-off note below must name exactly where it actually is —
   nothing needed for recovery may ever exist only in the sandbox.
2. **Write a durable hand-off note into the work item itself**, naming exactly what state things are
   in and what remains — and do this _before_ releasing any lock or moving the item's status, never
   after. Releasing first opens a window where the item looks freely available with no note yet
   describing that a branch already exists, and the very next session to pick it up either redoes
   the work from scratch or starts a second, conflicting attempt over the same ground.
3. **Park the item visibly in the correct waiting lane** — not buried in a generic "blocked" bucket
   a human never checks, but the lane that specifically matches what it is waiting on.
4. **Release the claim** on the work item, so it becomes available again.
5. **Release any queue slot** the session was holding, so it stops occupying a position it is no
   longer actively using.

**A partial run that hands off this cleanly is a success**, not a failure to be embarrassed about.
The alternative — grinding indefinitely against something genuinely unresolvable, or vanishing
without a trace — is strictly worse in every case: it either wastes the whole session's remaining
budget on a wall it cannot climb, or it destroys the visibility this entire document exists to
preserve.

## Chunking a job that is too big for one foreground window

An unattended session's foreground calls are capped at some fixed wall-clock limit, and the heaviest
verification or build steps can genuinely run longer than that cap even when everything is healthy —
the job is not stuck, it is just long. Treating an overrun as a failure and forcing a full hand-off
every time would waste the escape hatch on a routine, expected case. The better answer is for the
check itself to **chunk under a shared deadline**: run for as much of the window as it safely can,
record exactly how much of the work is provably done, and — instead of failing outright — report
plainly that it needs another pass, naming what already succeeded. The unattended session's response
to that report is mechanical: push the same, unchanged commit again, which resumes exactly where the
previous pass stopped rather than restarting from zero. A handful of such rounds converging cleanly
is normal; only a check that is not actually making progress across rounds is a real problem, worth
escalating through the normal escape hatch instead of repeating forever.

## The hard limit: never end a turn with live background work

This is the unattended-session-specific sharpening of the general foreground-only rule (see
`subagents.md`): a session with no human watching **must never end its turn while a background job
is still running.** In an attended session, a human might eventually notice a stalled background
task and nudge things along. In an unattended one, nothing will ever wake it — there is no one to
notice, and no mechanism that polls a background job a dead session left behind. Every long
operation — a push, a build, a heavy verification pass — runs in the foreground, to completion or to
a clean hand-off, before the turn ends. If it genuinely cannot finish inside one foreground call,
the escape hatch above is the answer, not backgrounding it and hoping.

## A worked shape of the marker race

Concretely: two unattended firings both wake at roughly the same time and both call the eligibility
oracle, which — because neither has staked anything yet — hands both of them the same unit of work.
Without a marker, both proceed: both check out the same starting point, both do the work, and
whichever pushes second either produces a conflict or silently overwrites the first's result, with
neither session aware a collision happened at all. With the marker convention, the first session to
attempt the stake succeeds and proceeds normally; the second session's stake attempt fails with a
specific, recognizable "already taken" outcome, and that second session simply stops and looks for
other eligible work instead — no conflict, no silent overwrite, no wasted duplicate run. The entire
mechanism reduces to one property: staking has to happen before any real work starts, and a failed
stake has to be trivially distinguishable from every other kind of failure.

## Red flags — you are about to break the design

| Thought                                                                             | Reality                                                                                                                                             |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This clearly needs a human, better safe than sorry"                                | Check it against the numbered reasons above first — a vague discomfort is not one of them, and the default is permissive for a structural reason.   |
| "The push failed, I'll just quietly retry a few times"                              | A rejected push is a signal, not noise — publish the heartbeat before retrying, or the session looks exactly like one that never started.           |
| "I'll finish the work, then write the hand-off note"                                | Write the note before releasing anything. A finished-but-unreleased state with no note is worse than an honestly incomplete one with a note.        |
| "This background job will probably finish before I need to check on it"             | An unattended session has no later turn to check on anything. If it is not done in the foreground, it is not done.                                  |
| "I already have the marker, no need to check for a heartbeat from a sibling firing" | A live sibling can be mid-gate, blocked, and still alive — a stale-looking marker with no fresh heartbeat is the only safe read of "actually dead." |

## Common mistakes

| Mistake                                                                                    | Why it bites                                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Defaulting new work to "may not run unattended" until proven safe                          | The wrong-exclusion failure is silent and permanent — an exiled task just sits, invisibly, in a lane nobody attends to.                  |
| Re-deriving eligibility from a prose description of the work item, per firing              | A hand-rolled check mis-fires both ways: it picks work it cannot actually do, and it skips work over an incidental word match.           |
| Staking a marker only once the work is finished                                            | Protects nothing — the collision window is between two sessions both _deciding_ to take a unit, not between two sessions finishing it.   |
| Treating a staking collision as an error to retry                                          | It is information ("someone already has this"), not a fault — retrying past it duplicates work the marker exists to prevent.             |
| Going quiet instead of publishing a heartbeat when a push is rejected                      | A blocked, still-working session becomes indistinguishable from one that never started, and its claim gets reclaimed out from under it.  |
| Releasing a claim or moving a work item's status before writing the hand-off note          | Opens a window where the item looks freely available with no note yet describing that real work already exists on a branch.              |
| Backgrounding a job the session cannot finish in one foreground call                       | Nothing is watching a background job in an unattended session — it will never be noticed if it fails, because no one is there to notice. |
| Treating a routine multi-round chunked verification as a failure requiring a full hand-off | Wastes the escape hatch on an expected case — chunking exists precisely so a long, healthy job does not need one.                        |

## Costs and limits

This whole apparatus exists to buy unattended throughput — work that gets done on a schedule, with
no human cost per unit of work started. It does not buy correctness for free: review still has to
happen, and an unattended session's own self-review is never a substitute for the same gate an
attended session would run. It costs real design effort up front — the eligibility oracle, the
heartbeat channel, and the marker convention all have to exist before the first unattended session
can run safely, and skipping any one of them re-opens exactly the blind spot it exists to close. And
the permissive default on the autonomy axis is a deliberate bet: it accepts that some unattended
runs will fail fast and visibly on a missing capability, in exchange for never silently starving a
task that should have run. That bet only pays off if "fails fast and visibly" is actually true in
your system — if a failed unattended run can _also_ go unnoticed, the permissive default stops being
safe.

## See also

`subagents.md` for the same foreground-only and hand-off discipline in the context of a single
delegated worker rather than a whole unattended session; `review.md` for what an unattended
session's own review step must and must not skip; `landing-queue.md` and `land-spine.md` for the
deterministic merge path an unattended session lands through; `claims.md` for the general
claim/release mechanics the marker convention here specializes.
