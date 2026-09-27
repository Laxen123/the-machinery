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

These numbers are the same numbers the stamping rubric uses (§ The cloudExec stamping rubric, which
carries each reason's adjudication detail), and they are stable.

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

**How the flag is carried.** It is a dedicated frontmatter key, `cloudExec: true | false`, stamped at
review time by the heavy model that already read the whole item — the only reader positioned to
judge the item's actual work. Before the key existed, eligibility was re-derived inside each
unattended prompt from a keyword grep over the item body, and it misfired both ways: an item needing
tooling the sandbox lacks got picked and stalled, and an item that merely _mentioned_ an excluded
tool in passing prose got skipped. The unattended session selects work by calling the oracle, never
by grepping frontmatter itself (§ Why the eligibility oracle must be a program, below):
`node scripts/queue-drain.mjs --cloud` EXCLUDES every item not explicitly stamped `true` — a `false`
item and an unstamped one alike — and that safety gate fires first, ahead of every other gate. An
absent stamp therefore means "never picked unattended": the conservative direction, since a missed
stamp only defers an item to an attended lane. Local drains omit `--cloud` and see the whole pool.

## The cloudExec stamping rubric

This section is the single source every stamper adjudicates against — an unattended review sweep
and an attended review pass alike. Rubric changes are made here, never inline in a prompt, so a rule
change propagates without re-syncing every scheduled job's configuration.

**The tool.** `node scripts/stamp-cloud-exec.mjs <id> true|false [--env <rung>] [--reason "…"]`
writes the key atomically, the same way the other stamp tools do. A `false` stamp **requires**
`--reason`, recorded as a body banner (`> ☁️ **cloudExec: false** — #<n> <evidence>`) beside the
mutation and cost banners, so the WHY survives; stamping `true` strips a stale reason banner. The
tool refuses `in-progress/` and `archive/`, and is meant to run at verdict time whatever the item's
route, so a later objective promotion into `ready/` finds the stamp already present. The review
pass's stamp tool can fold the same stamp into its one verdict commit.

**The burden of proof is inverted: the default stamp is `true`.** Unattended-ineligibility must be
PROVEN, not presumed. A `false` stamp is valid only when it cites a numbered reason below AND the
reason text names the concrete missing capability with its evidence — a probe result, a registry
entry, a named withheld credential, a named machine-local dependency. When the stamper is unsure, the
safe stamp is `true` with the most capable plausible environment rung (§ The cloudEnv axis): a wrong
`true` fails fast and visibly in the drain, while a wrong `false` silently exiles the item to the
attended lane forever. Never valid as `false` on their own: "needs a browser" (apply the engine check
in #1 and route a rung instead), "not proven in the sandbox yet" (an unproven capability gets proven
once, not defaulted away), a bare "writes the shared dataset" banner, or a stamp with no written
reason at all.

**An inherited `false` reason is not an adjudication.** A reason sentence copied from a predecessor
item carries that item's evidence, not this one's — and if it was never true, the copy propagates a
wrong exclusion down a whole lineage unchallenged. Before honouring an existing `false`, grep its
reason text across the item tree; an exact hit elsewhere means re-adjudicate from the rubric, never
re-affirm. In the same spirit: a store of artifacts committed to the repository is not a machine-local
dependency (a drain clones it), and neither is work on an unlanded branch that has been pushed to the
remote (a drain fetches it — check the remote's branch list first).

**The ONLY valid `false` reasons — a concrete capability the sandbox lacks.** The numbers are
stable: shipped code, banners and command docs cite them as "rubric #N", so a reason is never
renumbered or reused for a different meaning.

1. **A real rendered browser needed for the work itself, beyond what the most capable environment
   provides.** A restricted environment's browser cannot reach arbitrary hosts, but a full-egress
   environment's can, so those blockers ROUTE a rung rather than excluding the item. Still `false`:
   a specific human's logged-in browser session, or anything needing a real display. **Engine-first
   check:** a browser-verification step is never `false` by itself. Acceptance that consumes DOM,
   HTML or URL assertions routes to the headless-engine rung even when the page under test is a
   sandbox-local server pulling live resources; only pixel or vision acceptance, a real display, or a
   human's logged-in browser forces the top rung or `false`. The classic mis-stamp is a step written
   around one browser tool when its actual method (a scripted stub plus URL assertions) was
   engine-agnostic.
2. **Target hosts that must be reached from a local vantage.** The project's host-reachability
   registry marks a host as reachable only from a local vantage when even a residential fetch fails
   and a real browser there is required. A host merely blocked by a restricted environment's proxy
   routes the full-egress rung, plain fetches are otherwise fine unattended, and a host blocked only
   from datacenter addresses but reachable through a configured scraping vantage is not a reason
   either.
3. **An external credential deliberately withheld from the unattended environment.** The withheld
   set is a short, deliberate list — email-sending, production deploy control, a production database
   credential, DNS and domain control, social posting — and it never grows without a fresh human
   go-ahead. A credential that is merely missing today but could reasonably be provisioned is not a
   reason: provision it into every unattended environment and restamp `true`. A nested model-CLI
   call from inside the sandbox is not a blocker on its own; it authenticates from the sandbox's own
   credentials.
4. **Files in a repository outside the clone that is not in the extra-repo registry.** An unattended
   sandbox holds one clone. A repository registered in `coord.config.json`'s `cloudRepos` (read by
   `scripts/coord/cloud-repos-lib.mjs`) is cloned beside it on demand, so an item whose only
   outside-the-clone surface is a registered repository is stamped `true --repos <key>`, never
   `false`. This retires the recurring class of policy and coordination text that lives one level up
   from the repository a drain checks out.
5. **Machine-wide state on a human's own workstation** — local resource mutexes, machine-wide
   telemetry, the human's running dev servers or parallel local sessions.
6. **Human-as-oracle.** A decision the item explicitly routes to a human, or an action needing that
   human's own credentials or logged-in accounts. **Front-load first:** if the human's input depends
   only on a cheap read-only computation, the review pass computes it and asks (or parks) with the
   result attached, and the routed mid-run decision disappears. `false` under #6 is for exchanges
   that genuinely depend on mid-implementation state.
7. **Work that writes under `.claude/**`** — settings, commands, workflows. The harness raises a
safety ask with no approver in an unattended run, and the session freezes until its window dies
(observed freezes ran for hours). Do not rely on remembering this one: the stamp tool REFUSES a
`true`stamp (exit 2) when the item body names a`.claude/`path, naming the matched line. It skips
the frontmatter, fenced code blocks, and any`## Do NOT touch`section, but inline backticked
paths are scanned — that is where a scope section declares its real file surface. The override is`--claude-dir-ok "<justification>"`, recorded as a banner in the same slot, for two cases only:
the item merely MENTIONS the path and no step writes there; or its only writes are workflow files
routed through `node scripts/apply-workflow-file.mjs`, a tool call that raises no safety ask.
   Settings and command files stay hard-forbidden regardless. The durable escape when the surface is
   doctrine prose inside a command body is relocation: move the mutable text into an in-repo file and
   leave the command a thin "read this file and follow it" stub, so later items never touch the
   gated path. Hook logic belongs in a non-gated scripts directory for the same reason.
8. **Work needing an action the unattended safety classifier denies** — the general class #7 is one
   instance of: writes to shared git hooks (`.husky/**`, which the stamp tool also refuses, with its
   own separate `--husky-ok "<justification>"` override so one flag never silently clears the
   other), remote-branch deletes, a `--no-verify` / guard-override prefix, or a one-off change to a
   live shared service (the hosting platform, DNS or CDN, the code host's settings) by any path other
   than an allow-listed committed tool — a raw API mutation, a REST call, a dashboard step (plan 4256
   parked on exactly this: a staging build-command update refused as "Modify Shared Resources").
   Where the repository ships a narrowly scoped tool for such a change and allow-lists exactly that
   tool in the committed `.claude/settings.json`, an item whose only live-infra step goes through it
   stays `true`; the project's own staging runbook names the instance (plan 4261). Do NOT weaken the
   classifier to route around this — it blocking these writes is correct, and the attended lane is
   the design. Three facts about the classifier worth budgeting for: delegated authority does not
   clear it (only a direct human instruction naming that exact action does — design around it, or
   surface a one-line ask); its verdict is not a stable function of the command text (identically
   shaped launches in one batch can split admitted and denied, so plan a fallback for a partial
   fan-out); and a dispatch prompt's own WORDING is judged — a prohibition list of destructive verbs
   reads as intent and gets a benign command denied, where a positive recipe is admitted.

**A `false` stamp cites its number(s) in the banner**, for example
`false — #3 <which credential>, #6 <which decision>`. Adjudication is a checklist pass against these reasons and nothing else: a rationale
that maps to no number is not a reason, and the item is `true`.

**Never valid `false` reasons**, each over-applied once and corrected:

- "Judgment work" or heavy-model reasoning — the heavy unattended lane exists for exactly that.
- Writes to the shared authoritative dataset — the scoped landing mutex covers an unattended land
  like any other.
- Plain HTTP fetches — unattended environments have egress.
- "Validation needs live multi-session machinery" — check the item's OWN acceptance criteria;
  criteria that name tests or fixtures are headless. Only a criterion that irreducibly needs live
  concurrent sessions counts, and then prefer splitting.
- Editing drain-adjacent repository code, the eligibility oracle included — a reviewed, gated land
  carries the same risk from any host. (Live scheduled-job configurations stay human-attended.)

**Split, don't sink.** An item that is mostly headless with an attended tail — a per-account apply,
one config line, a live validation step — has its body restructured, the tail carved out as an
explicit close-out follow-up, and is stamped `true`. Never stamp a whole item `false` for its tail.
**Split by reach, too:** for a per-record pass, the split axis is the cohort, measured up front — the
rows an unattended vantage can reach are the unattended part (stamped `true` with its rung), the rows
that need a local vantage are a COUNTED remainder. The unattended part executes and lands on its own;
its close-out mints the remainder as a new `false` (#2) item carrying the exact residue roster. When
the split cannot be measured in advance, the first unattended batch IS the measurement, and its
failure ledger is the remainder.

**Re-adjudication duty, every sweep.** For each `ready/` item already stamped `false`, compare its
cited reason against the current list; a reason no longer valid, or a body since restructured, is
re-adjudicated and restamped. Stale stamps die at the next sweep, not at the next human challenge. And
**a fix only clears the reason it targets** — provisioning a credential clears a #3 banner, but the
same item may also do work that trips #2; a restamp is a whole-item judgment, never a per-reason
patch.

**Probe the environment you think you are probing.** A dispatch that claims to run in a remote
sandbox can silently fall back to running on the local machine. Any probe whose conclusion depends on
WHERE it ran (tool availability, network posture, browser pairing) reports its hostname and kernel
string, and is void if they match the local workstation.

## The cloudEnv axis

`cloudExec` answers whether an item may run unattended at all (safety). A second, independent axis
answers **which kind of environment** it needs (routing). The key is `cloudEnv:`, one of
`trusted`, `full`, `webkit` or `browser` — a superset ladder where each rung can run everything below it. Absent means `trusted`, the
base pool. It exists because the two biggest "the sandbox cannot do this" classes — a headless-engine
test gate and live fetches of arbitrary hosts — turned out to be artifacts of the RESTRICTED
environment, and both work outright in a full-egress one. So those items ROUTE to a rung instead of
sinking to `false`.

| Rung      | What the environment provides                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trusted` | Restricted egress through a host allowlist; engines cannot be installed; plain repository work, tests and allowlisted fetches.                                                          |
| `full`    | Unrestricted egress: fetches to arbitrary hosts, and engine installs.                                                                                                                   |
| `webkit`  | A headless engine whose own TLS handshakes to live hosts are proven to work from the sandbox — for acceptance that consumes DOM, HTML, anchors or status codes from a live page.        |
| `browser` | The top rung: the specific browser engine the project's pixel-level acceptance is pinned to, reaching live hosts — for screenshots, crops, vision grading or structural-hash freshness. |

- **Stamp** with the same tool, `stamp-cloud-exec.mjs <id> true --env <rung>`, so both keys land in
  ONE atomic commit. `--env` is legal only beside `true` (a `false` item runs nowhere unattended, so
  routing it is meaningless — the tool refuses). A bare `cloudExec` restamp leaves an existing
  `cloudEnv` untouched: independent axes, so a safety flip never silently clears routing.
- **The oracle is a superset ladder.** Plain `queue-drain.mjs --cloud` (the restricted lane)
  excludes every item above `trusted`. `--cloud --env full` excludes NOTHING on this axis — a
  full-egress environment admits the whole unattended-eligible pool — so an intermediate rung that
  a full-egress lane already satisfies needs no lane value of its own. `--env` composes with the
  lane selection; attended local drains never read the axis. The intended end state is full-only
  draining; while two lanes overlap, the claim compare-and-swap makes the overlap safe (two drains
  cannot both win one claim) if wasteful.
- **Split on what the acceptance CONSUMES, never on "does it launch a browser".** DOM, HTML, anchors
  and status codes from a live page route the engine rung. Pixels, crops, vision grades and
  screenshot-freshness hashes route the top rung, because swapping engines changes font
  rasterization and layout, which silently invalidates a cached screenshot corpus and changes what a
  vision judge sees. A capture on one engine may feed text extraction while the pixel of record
  stays pinned to the other; never let an engine swap quietly become the screenshot of record.
- **Anti-downgrade guard.** Restamping a top-rung item to any lower rung REFUSES — a lower lane still
  cannot run pixel acceptance. Downgrades among the lower rungs are deliberately not guarded: the
  full lane admits all of them, so such a downgrade is lossy on meaning but strands nothing.
- **A rung is a per-environment MEASURED verdict, never an assumption.** "Full egress, therefore
  every browser reaches live hosts" has been false in practice: one engine's TLS handshake reset
  mid-tunnel from a full-egress sandbox while plain fetches and a different engine succeeded against
  the same hosts. A small egress probe per engine records which environment it measured and whether
  it passed; an environment the probe passes on is a candidate for the rung, one it fails on is not,
  and neither is assumed without measuring.

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

The details that make this safe rather than a loop:

- **Three outcomes, told apart by a marker line, not by prose.** A chunked round prints a
  machine-readable marker naming the outcome and the gate (for example
  `MARKER prepush-outcome=CHUNKED gate=<gate>`) followed by a plain instruction to re-push the SAME
  commit — no rebase, no hook bypass, no diagnosis, because a content-keyed ledger already recorded
  what that round proved. A genuinely failing check prints no marker at all; its absence is the
  third state.
- **Non-convergence is bounded in code.** Each chunked round is scored against the ledger: two
  consecutive rounds that bank ZERO new units of work on the same content print a different marker
  (`NON_CONVERGENT`) and an explicit STOP — do not push the same commit again, it will bank nothing.
  Isolate or fix the one unit that cannot finish inside a single window, or raise the window for one
  push if the work is healthy but too big, then push a DIFFERENT commit. The tally is keyed on a hash
  of the check's own input closure, never on the commit id: a commit that changes the check's inputs
  starts a fresh tally, while an unrelated commit keeps the old one — otherwise a stuck check could be
  laundered back to "chunked" by a commit that never touched the unit causing it.
- **The same loop runs at land time**, through the landing spine rather than the push hook: the land
  reports a chunked seam and the session re-invokes the same land. A chunk-resume is progress, never a
  proof — it does not count as the check having passed.
- **The deadline is anchored at process start, not at the first chunked step.** A land spends real
  time on earlier phases (preflight, a build, other gates) before its first chunkable check; a
  deadline stamped only when that check starts leaves those phases uncounted, and the window can then
  expire AFTER the tool's own hard cap has already killed the call, so the chunk report never speaks.
  The shared budget covers everything up to and including the chunked checks, deliberately leaving
  headroom under the hard cap for the bookkeeping that follows. Earlier phases derive their own
  timeouts from what is left of the same budget and report "chunked" instead of "failed" when they
  run out, and a phase that retires nothing twice on the same commit reports non-convergence naming
  the real cause — the phases before it are eating the window, or the check cannot fit inside one.
- **The binding instruction lives in the unattended prompt itself.** If the prompt's hard-limits
  paragraph says "hand the job back when it overruns one foreground call" and overrides any
  conflicting instruction elsewhere, then a chunking rule written only in a separate doc is, by
  construction, overridden. State the chunk-and-repeat rule inside the prompt, ahead of the hand-back
  rule, and narrow the hand-back to an overrun with NO chunk report.

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
