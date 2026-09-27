---
name: board-pass
description: Use when the operator asks for a board pass, a plan-board review/sweep, "/board-pass", or a periodic look at all open plans. Heavy-model only (Fable/Opus) — TWO-PHASE: Phase 1 sweeps pending-approval/ + the whole board, chains spec-pass (batch mode) + a batch/fold sweep + a waiting-lane audit into ONE ranked report; Phase 2, on the operator's per-item "go" between phases, executes the approved folds/promotions/stamps/routes IN-SKILL, reusing Phase 1's analysis. Stamps and objectively-met promotions are pre-authorized in Phase 1; everything else is a Phase-1 proposal that only runs once approved. Never executes plan WORK — only board curation.
---

# board-pass — the periodic heavy-model pass over the whole plan board

One command, two phases, one report, one execute pass. Phase 1 is the unchanged sweep-and-propose
product; Phase 2 is new (plan 1373 D1) — it collapses the old "board-pass proposes, then a SEPARATE
`consolidate`/`spec-pass` invocation re-derives the same analysis to actually do it" friction into one
skill, gated by the same operator turn that already existed between them. **REQUIRED SUB-SKILLS:**
spec-pass, consolidate (via `consolidate/references/fold-procedure.md`), batch-train's
`references/share-a-land.md`.

Why the waiting-lane sweep exists: the waiting lanes have no return path — plans enter
`waiting-operator`/`waiting-trip` with a marker and then wait for someone to spontaneously remember them
(2026-07-04 audit: 22 in waiting-operator, oldest 5 weeks; 19 waiting-trip conditions nobody evaluates).
This pass IS the return path. Why the `pending-approval/` sweep exists: since plan 1371, every fresh
mint rests there un-routed by design — board-pass is its ONLY normal exit (see Phase 1 step 2).

---

## FIRST ACTION — copy `/rename boardpass` to the clipboard, before anything else

The moment this skill fires, copy the rename command to the OS clipboard and surface the paste nudge —
BEFORE `git fetch`, the spec-sweep lock probe, or any inventory. This gives the session a meaningful
title so `/state`, the session picker, and the CC Watcher widget show `boardpass` instead of the
launch folder.

**The skill cannot fire `/rename` itself** — it's a built-in, and built-ins are not programmatically
dispatchable (only custom slash commands are); `sessionTitle` is settable only by a `SessionStart`
hook on `source: startup|resume`, never mid-session; and no hook can pre-fill the input box. The
lowest-friction path is the clipboard:

```bash
# Windows (operator's platform; Set-Clipboard adds no trailing newline):
powershell -NoProfile -Command "Set-Clipboard -Value '/rename boardpass'"
# macOS:  printf '%s' '/rename boardpass' | pbcopy
# Linux:  printf '%s' '/rename boardpass' | (wl-copy 2>/dev/null || xclip -selection clipboard)
```

```
📋 Copied  /rename boardpass  to your clipboard — paste (Ctrl+V) + Enter to rename this session.
```

This must run from the **user-facing session** — never a dispatched subagent (only the top-level
session's title is the one the operator sees). Skip ONLY if the operator already renamed the session,
or if the pass is running headless (no clipboard / no operator to paste).

---

## Phase 1 — Sweep + Propose

The product is unchanged from the single-phase skill: a ranked decision report. Pre-authorized stamps
and objectively-met promotions execute inline during the sweep (no gate needed — they're facts, not
judgment calls); everything else is a **proposal** that Phase 2 will not touch until the operator says go.

### 1. Inventory

**Pre-authorized reconcile (plan 3659) — run this first:** `node scripts/reconcile-drain-markers.mjs`.
Report every plan it projected in the Phase 1 report. This is an idempotent, safely re-runnable
reality correction before inventory reads `ready/`, not a curation proposal awaiting the operator's
Phase-2 "go".

Then `git fetch origin` (judge against `origin/master`, never a drifting local ref). List every active
folder — `pending-approval/`, `ready/`, `in-progress/`, all `waiting-*/` — with counts. Note
`in-progress/` staleness (a >6h-quiet claim is a liveness question, not yours to break — surface it).

### 2. Spec sweep

**Spec-sweep lock probe (plan 2144) — before touching `pending-approval/`.** The scheduled cloud
spec-sweep routine sweeps the same folder on its own cycle; probe its lock before starting so the two
never double-work the same stubs (the 2026-07-20 collision: a 5-verifier ~370k-token fan-out that
ended up pure confirmation of what the routine had already stamped minutes earlier). Run
`node scripts/spec-sweep-lock.mjs acquire` from the the project checkout:

- Exit 0 — you hold the lock. Proceed with the `pending-approval/` sweep below; release it
  (`node scripts/spec-sweep-lock.mjs release --sha <the acquire sha>`) immediately after routing
  those stubs, BEFORE continuing to the rest-of-board sweep — hold it only for the duration of the
  `pending-approval/` pass, never the whole board-pass (a routine firing mid-board-pass then skips
  cleanly via its own exit-3 path).
- Exit 3 — the routine is sweeping this cycle right now (holder + start time printed). Re-list
  `pending-approval/` before reading further — the folder emptying under you is the signal, not an
  error — and sweep only whatever is still `stage: stub`.
- Exit 4 — locking unavailable (coord-ref push denied). Fall back to a commit-signature scan:
  `git fetch origin`, then scan the last ~30 min of `origin/master` commit subjects for
  `spec-sweep —` / `board-pass reconcile —`; a hit means treat it like exit 3 (re-list, sweep only
  what's still unstamped). No hit → proceed unlocked as usual.

**Sweep `pending-approval/` FIRST.** It is the default fresh-mint holding folder (plan 1371) — every
`stage: stub` plan there is un-routed until this pass stamps it `specced` and routes it
(`move-plan <id> ready` or the matching `waiting-*`). This is `pending-approval/`'s ONLY normal exit;
treat clearing it as this step's first action, ahead of any other stub sitting in `ready/`/`waiting-*/`.

Then continue the sweep over the rest of the board: invoke **spec-pass** in batch mode over every
remaining `stage: stub` in any claimable folder, PLUS every `specced` plan whose `specReview` sha is
stale — **date-based**: >14 days since the `specReview` sha's commit date. Raw commit-distance to
`origin/master` is dead-on-arrival under coord-commit churn (~2,000 commits/2 days observed would flag a
same-afternoon spec sha as 300+ behind, re-speccing the whole board every pass) — if a commit-distance
signal is still wanted alongside the date window, count ONLY commits touching that plan's own
file-surface (`git rev-list --count <specReview-sha>..origin/master -- <surface>`), never raw master
distance. Apply the exit test (could Sonnet execute this
without a judgment call on a correctness-critical surface?): write `## Execution notes for the drain` or
stamp `execModel: fable`. Stamps are the spec-pass product — pre-authorized, no per-plan ask, and they
execute immediately in Phase 1 (a stamp is a verdict, not a mutation the operator needs to bless).

**Sweep mechanics — verifier fan-out at ≥4 stubs (fourteenth-pass evidence, 2026-07-15).** At ≥4
stubs, fan out ONE read-only Sonnet verifier per stub via the Workflow tool — schema-forced returns,
a `## SCOPE — DO NOT EXCEED` block, an explicit `model: 'sonnet'` pin — running spec-pass step 1's
claim verification (file:line premises, subsumption, overlap) in parallel while the heavy model reads
every stub body itself and makes every verdict itself. Below ~4 stubs, verify inline with targeted
greps — a fan-out costs more than it returns (the fourteenth pass did exactly this for its 3 mid-pass
mints). Depth: a SINGLE verifier per stub, never adversarial multi-vote panels — premise checks
confirm cited claims, they don't generate refutable findings (evidence: 8 verifiers / ~790k Sonnet
tokens / ~10 min produced four routing-changing finds — a refuted hypothesis, a worktree-only test
baseline, a vocabulary drift, a mislocated evidence file). This is the thin-orchestrator doctrine
applied to the sweep; it is the DEFAULT mechanism, not gated on an ultracode session.

**Operator in-session → ask mid-sweep, never defer the question.** Sweep momentum is not a reason to
skip spec-pass step 3b: when a plan's front-loadable call needs OPERATOR judgment and the operator is
present, pause the sweep and ask (one grouped question set per plan, recommended answers attached)
before stamping or routing — do not silently park it to `waiting-operator/` and do not fold the question
into the end report. The report's decision digest covers the operator-ABSENT case; it is not a
substitute for asking someone who is sitting right there. When a stub trips spec-pass's
**grill-escalation triggers** (step 3b: a refuted operator-observation premise, user-facing claim
semantics with an unverifiable default, or an explicit "grill me") run the full /grilling interview
mid-pass — one question at a time, answers folded into the plan body — instead of the one-shot
grouped set (added 2026-07-16, seventeenth pass: plan 1905's frame reversed at question 3).

### 2b. Fog sweep (plan 1668)

Open `docs/superpowers/plans/FOG.md`. For each patch under `## Not yet specified`, apply the wayfinder
discriminator: **stub when the question can be stated precisely now (even if blocked); fog when it
can't.** A graduated patch → mint the stub(s) it implies (`next-plan-id.mjs claim`, normal mint-time
authorship duty) and delete the patch from the section in the same pass — one patch may yield several
plans or none; **never pre-slice fog into stub-sized pieces to force a graduation.** Still-fog → leave
it (sharpen the wording if the sweep learned something). Minting from graduated fog is pre-authorized
like stamps (plan authoring is never gated); the fresh stubs then ride this same pass's spec sweep.
The reverse edge exists too: spec-pass may DEMOTE a stub to fog (its § Escalation) — this sweep is
where those patches get re-tested. FOG.md edits go through `coord-edit.mjs`, master-side.
**Naming (plan 2329):** `--category` must come from the allowlist and any country-scoped plan carries its
country token (`se`/`no`/`dk`/`uk` — prose says `uk`, never `gb`); the mint gate hard-fails an unknown
category. Table + rules: `docs/coord/plan-lanes.md` § Plan naming.

### 3. Batch sweep

**FIRST ACTION of this step: Read `batch-train/references/share-a-land.md` IN FULL — with the Read
tool, this pass, not from memory of a prior pass or the one-line summaries other docs carry.** The
§ "small-🟩-sonnet class" section is the part passes skip, and skipping it inverts the default the
wrong way (the 43rd pass, 2026-07-27, proposed 2 batches from a secondhand reading; the corrected
re-sweep against the actual file produced 4 covering 14 of 17 non-fable ready plans).

**The sweep input is the ENTIRE post-spec `ready/` pool — pre-existing singles included, never just
the stubs this pass routed.** Invoke **consolidate** in sweep mode over that pool. For each candidate
cluster, apply **the share-a-land criterion** from the file just read; don't restate it here. Three
outcomes: leave separate (default OUTSIDE the small-🟩-sonnet class; INSIDE it the default inverts —
batch, and solo needs a written reason), propose an
**execution batch** (plan files stay separate; only the worktree/review/land are shared — plan 1364),
or propose a **fold** (true duplicates / a work unit that shouldn't be split). Reserve folds for the
cases the coherence test actually calls for. Coord-machinery plans should essentially always ride one
batch. Proposing nothing is a valid result only outside the small-🟩-sonnet class.

**Exit condition (checkable, and the report must state the count):** the sweep is not done until
every 🟩 `execModel: sonnet` non-hitl plan in `ready/` is either (a) a member of a
`proposed`/`claimed` batch folder, or (b) listed with a written reason in the batches README
§ "Not batched (ready/ singles), with reasons" — from THIS pass or still-accurate from a prior one.
Count the leftovers before writing the report; a nonzero uncovered count in the report is a sweep
bug, not a style choice.

**Persist the rosters — they are NOT report-only.** Since plan 1467 each batch is a FOLDER
`docs/superpowers/batches/<slug>/batch.md` (the project; frontmatter `slug` / `lane` / `members` / `gate` /
`status: proposed|claimed|landed`; body = theme + banner reasons), edited via `coord-edit.mjs`, which
`batch-train` step 1 consumes:
RECONCILE the folders against the fresh sweep — add a `proposed` folder per new batch, update the
frontmatter of a batch whose members changed folder/eligibility since the last pass, **keep `gate`
fields OBJECTIVE-only** ("plan X lands", a date) or `null` — never a subjective/approval marker in
the gate field: an autonomous drain reads `gate: null` as runnable and anything else as not, so a
stale marker leaves a runnable batch drain-invisible (the 2026-07-13 pipeline-internals overnight
miss) — and let a claimed/landed batch keep its folder (its `status` reflects that; claim-plan
stamps `claimed`, done-worktree moves it to `archive/<slug>/`). Keep the `README.md` "Not batched,
with reasons" section honest. **Batch composition is AUTO-APPROVED at proposal (standing operator
directive 2026-07-14** — every per-batch "go" before it had been a rubber-stamp turn): persist each
new folder already runnable — `gate` objective-only or `null`, body line "AUTO-APPROVED per standing
operator directive 2026-07-14 — runnable at claim; operator veto via the report". The report still
lists every new batch (members, per-member execModel, banner reasons) so the operator can VETO or
amend in their reply — dissolve/amend the folder on a veto, exactly like any other Phase-2 item.
board-pass still never runs the train (a batch executes via a separate `batch-train` invocation or
the drain); maintaining the batch folders is part of the sweep, pre-authorized like stamps.
Criterion for a batch OUTSIDE the small-🟩-sonnet class (operator 2026-07-04): plans that FIT
TOGETHER (same subsystem, a reviewer's one pass), never "shares a queue slot". For the
small-🟩-sonnet class that precedent is OVERTURNED and the default inverts — see
`batch-train/references/share-a-land.md` § The small-🟩-sonnet class (plan 2459 ruling, landed via
plan 2516); don't restate the class rule here.

**`program:` tag (plan 1840).** Independent of batch/fold eligibility, some plans carry only a
`program: <slug>` frontmatter tag marking them as steps in the same multi-plan mission (e.g. a
discovery chain that had to fold or split across plans) — group these together in the Phase-1 report
as one thread rather than N cold standalones, even when they don't qualify for an execution batch or
fold. The tag is free-form, authoring-time text with no registry or lint of its own — this grouping is
board-pass's own presentation of it, not a separate check.

**Emit the `## Dependencies` block (plan 1373 D4).** Reconcile this block into the ONE global
`docs/superpowers/batches/dependencies.md` every pass (moved out of `proposed.md` by plan 1467) — it is
what `scripts/batches-view.mjs` (the `/batches` view skill's render helper) parses, so its shape is a
contract, not a suggestion:

````
## Dependencies

```dependencies
<left> <relation> <right> [: <free-text reason>]
```
````

- One edge per line, inside a **single** fenced block whose info-string is exactly `dependencies`,
  directly under a `## Dependencies` heading (matched loosely — trailing prose on the heading line is
  fine).
- `<left>` / `<right>` are each either a batch slug (`batch-2026-07-05-seed-heavy`) or a bare plan id
  (`1371`) — whichever the edge concerns. Batch-vs-batch, batch-vs-non-batched-plan, and plan-vs-plan
  edges are all the same shape.
- `<relation>` is one of `blocked-by` | `overlaps` | `order-after`. These are recorded exactly as
  computed — directional relations (`blocked-by`, `order-after`) are NOT auto-reversed by the parser;
  write both directions explicitly if both are meaningful.
- An optional ` : <reason>` suffix is free text, rendered verbatim (e.g. the specific shard/file that
  collided).
- Blank lines and `#`-prefixed comment lines inside the fence are ignored. A line that doesn't match the
  2-or-3-part shape is SKIPPED, never fatal.

Emit the edges you already compute during this sweep: explicit `Blocked-by` relations, 🟥 record-shard
collisions (e.g. two batches both touching record-034), file-surface overlaps (including a batch
overlapping a NON-batched single plan — e.g. `1371 overlaps 1362`), and land-ordering constraints within
or across batches. Reconcile the whole block every pass — add, re-shuffle, or drop edges as the board
changes; don't just append.

**Annotate per-member execModel in the report** (🟢 sonnet / 🟣 fable next to each id) in the same style
`/batches` renders it live from frontmatter — this keeps your own report and the durable view consistent
even though `/batches` recomputes it independently from each plan's current frontmatter (never from a
value cached in the roster doc, which would drift). `sol` (🔶) never appears here — it never batches
(plan 3341: batch eligibility requires `execModel: sonnet`, which already excludes it), so a batch
member's icon is always one of these two.

### 4. Waiting-lane audit — the return path

- `waiting-blocked/`: for each `Blocked-by`, check whether the blocker has archived on `origin/master`.
  Landed → **promote** (`move-plan <id> ready`, objectively met = pre-authorized) and report it.
- **`ready/` Blocked-by staleness (same rule, different folder) — BODY HYGIENE, not a stopgap:** a
  `ready/` plan can carry a `Blocked-by` line in its BODY; check each against the archive and, where
  the blocker landed, erase the stale line (objectively met, pre-authorized). Since plan 1819 landed
  (2026-07-14) the oracle resolves each named id against `archive/` itself, so a satisfied blocker no
  longer hides the plan from the drain — it is included with a `staleBlockedBy` warning in the oracle
  JSON. What the oracle does NOT do is edit the body, so the stale line survives every run until this
  sweep removes it; a shipped-vs-merely-archived blocker is a further distinction the oracle draws
  (plan 2496) and a `blocked-archived-not-shipped` reason still excludes. The original incident —
  plans 1790/1794/1787/1815 sitting drain-invisible on satisfied blockers until the operator asked —
  is the class 1819 closed, and the reason this line is worth keeping honest.
- `waiting-date/`: date reached → promote, same rule.
- `waiting-trip/`: run `node scripts/trip-status.mjs` (plan 2679) — read-only, no network, no
  mutations. Every 🔔 TRIPPED row is a promotion candidate (**promote**, same as a landed
  `waiting-blocked` blocker). A `manual` row stays parked (its trip is human-observed, not
  machine-checkable) and a `⚠ probe-error` row is reported, not promoted. A `∅ no-marker` row is
  missing its `tripCheck:` stamp (`docs/coord/plan-lanes.md` § waiting-trip) — add one in the
  same pass rather than leaving it un-evaluated. A `↷ moved (re-read)` row is NOT a finding at all: a
  parallel session re-filed that plan out of the lane mid-run — do NOT stamp it and do NOT chase it
  to its new folder; re-run the script if you need a settled table.
- **cloudExec backstop on every promotion to `ready/`** (plan 1796): if the promoted plan carries no
  `cloudExec` stamp (a pre-1796 spec — spec-pass now stamps it at verdict time), stamp it as part of
  the promotion via spec-pass step 4's rubric (`node scripts/stamp-cloud-exec.mjs <id> true|false
--reason "…"`), reading enough of the plan to judge cloud-safety. Pre-authorized like every stamp.
  Unstamped-on-`ready/` is safe (never cloud-picked) but wastes the cloud lane.
  **Adjudicate per the operator-ratified rubric at the project `docs/coord/cloud-drains.md`
  § The cloudExec stamping rubric** — concrete false-list only; judgment-work / seed writes / plain HTTP
  fetches are NEVER false reasons; a mostly-headless plan with a local tail gets the tail carved out
  as a close-out follow-up and stamped true (split-don't-sink); re-adjudicate existing `false`
  stamps whose banner reason the rubric no longer supports.
- **Session-owned closes (plan 4069, operator ruling 2026-09-20) apply across every lane a plan
  might rest in, not just `waiting-operator/`.** A plan whose premise is refuted, that is superseded,
  or whose work already shipped elsewhere is hand-archived by THIS pass, in Phase 1, with a one-line
  reason — never proposed and never parked to ask ("close this superseded plan?" was itself 11% of the
  audited `waiting-operator/` corpus and is exactly the shape this closes). Archive is reversible, which
  is why it does not need the operator's turn first. § 5's report lists these as DONE closes, alongside
  the digest, never as an open proposal.
- `waiting-operator/`: **NO moves, ever, in Phase 1** — this lane is the operator's. Build the
  **decision digest** instead: one line per plan — name, age, the smallest decision needed, and what
  deferring costs. Rank by (age × relevance to currently-active work). **First re-triage every row
  against the axis list (plan 4069, operator ruling 2026-09-20):** a row whose `--blocked-by` is a
  technical-design or plan-scope call with no `[axis: product|policy|money|access|data-ruling|hold]`
  marker is a session decision, not a digest line — a Phase-2 item drafts the `## Session decisions`
  entry and routes the plan itself (§ 5), it is never presented to the operator. Only axis-carrying rows
  make the digest. Plans that look superseded or stale get flagged as **close candidates** with a
  one-line "not doing this because…" draft — propose, never close unilaterally, UNLESS the premise is
  refuted or the work already shipped elsewhere, in which case the session-owned close above applies and
  the row is reported as a DONE close, not a proposal. (Phase 2 CAN execute an approved `waiting-operator`
  route or close, once the operator has picked one from this digest — see Phase 2.)
- `waiting-grill/` (plan 2034): **NO moves and NO interview in Phase 1** — the lane belongs to
  `/grill-lane`, and asking a grill question here is exactly the inline-blocking this whole taxonomy
  exists to prevent. Same re-triage as `waiting-operator/` above: a plan whose `## Grill questions`
  entries are all tech-design/scope forks with no genuine operator axis is a session-decidable plan, not
  a grill-lane wait — resolve it into `## Session decisions` and route out in Phase 2 rather than
  leaving it for a sitting that has nothing real to ask. Since plan 4069 session decision S1, `##
Grill questions` is a NUMBERED LIST ONLY — an item that survives re-triage still needs its own `N. `
  opener carrying an `[axis: <tag>]` marker, with any context indented underneath it, never rewritten as
  loose prose while re-triaging. Always report **lane size + oldest-plan age** alongside the other
  lanes. At **≥3 plans or oldest ≥7 days**, add one line to the report proposing a sitting: "grill lane
  at N plans / oldest X days — worth a /grill-lane session?" A nudge in a report the operator already
  reads; never a gate, never a hook. A plan whose questions have obviously dissolved (superseded,
  answered elsewhere) is a normal Phase-2 route-out proposal — mark the item itself with the literal
  `[RESOLVED]`/`[RULED]`/`[ANSWERED]` token immediately after its axis tag (the move-plan.mjs entry
  guard reads only that literal position, never prose) or move it to `## Operator rulings` / `##
Session decisions`, satisfying the exit guard without any grilling session.
- `parked/`: **SKIP entirely — not swept, not audited, not digested** (plan 1426). It is the operator's
  long-term freezer: a parked plan is alive and resurrectable but deliberately invisible to every scan
  (INDEX, drain, claim, this sweep) until the operator un-parks it (`move-plan <id> <lane>`). It is
  neither an active lane nor a waiting lane — no return-path check applies. When a Phase-2 route or an
  operator answer amounts to "long-term hold, stop surfacing this", `move-plan <id> parked` is the
  destination (contrast `waiting-operator/`, the short-term actively-surfaced lane).

### 4b. Debt-ledger report (plan 4199)

After `git fetch origin`, run `node scripts/coord/infra-debt-report.mjs --check --ref origin/master`
and the same command with `--ledger <path> --no-sweep-date-ok` for any other debt ledger the project keeps beside it
— read-only, always exit 0, and `--ref` reads the committed ledger rather than whatever copy this
checkout holds. Each prints one `INFRA-DEBT: OK|SWEEP DUE (…)` line (entry count, size, oldest entry
and its age, last-sweep date) and, when a sweep is due, the reasons: last sweep older than 21 days,
off-contract or missing tags, newest-first inversions, undated lines, duplicate-slug clusters,
terminal-marker lines still standing. Copy both lines into § 5's report. On `SWEEP DUE`, PROPOSE a
sweep (a Phase-2 item, never executed in Phase 1): the full report (drop `--check`) names the lines,
and the sweep procedure — report-only verifiers, verify-then-delete on an affirmative shipped verdict
only, slugs an open plan owns left alone, small master-only commits — is the one plan 4199 ran (its
plan body records the checklist). Never edit either ledger from this pass: they are hand-edited on
MASTER only, and a delete needs per-line evidence this report does not carry.

### 5. The report (operator-comms style — plain-English status first, decisions before recaps)

- Lead: folder counts (now including `pending-approval/`), board-size trend vs the last pass if known,
  and the **top 3 decisions** worth the operator's next five minutes.
- Sections: newly specced (with execModel split) · fog sweep (patches graduated → minted stub ids,
  patches left in fog) · proposed batches (members + per-member execModel +
  saved land cycles) · proposed folds (members + reconciled banners, drafted per
  `consolidate/references/fold-procedure.md` step 2 so Phase 2 can mint directly) · fable-class residue
  · promotions made (blocker-landed / date / trip / pending-approval routes) · decision digest
  (`waiting-operator`, ranked) · grill-lane size + oldest age (with the ≥3-or-≥7-days nudge when it
  trips) · the two debt-ledger lines from § 4b (plus the sweep proposal when either says
  `SWEEP DUE`) · session decisions recorded this pass (plan/id + the fork resolved — DONE, not a proposal) ·
  session-owned closes (plan 4069, § 4 Waiting-lane audit above — refuted-premise/superseded/
  already-shipped archives, also listed as DONE, never as a proposal awaiting a go) · close candidates
  (the remaining, genuinely ambiguous ones, which still need the operator's nod).
- One health number: the **meta-plan share** of the active board (coordination-machinery plans ÷ total).
  Rising or stuck above ~20% → say so and recommend the next coord plan REMOVE machinery rather than add
  it (operator doctrine 2026-07-04).
- A second health number (plan 2943, the evidence-floor standing loop metric — `docs/coord/plan-lanes.md`
  § The evidence floor): the **sitting's evidence mix** — of the stubs this pass stamped `specced`, how many
  carry `evidence: latent` vs `observed-*`/`operator`. Report the latent count and the observed:latent
  ratio; a rising latent share is the review-machine-as-plan-factory pattern the floor exists to catch,
  and a `latent` product-family (`Pipe`/`DQ`/`App`/`UI`) stub this pass routes to `ready/` is refused
  there (`move-plan`'s evidence-floor gate) — fold it to a line or upgrade the class instead.
- Every proposal (fold / close / `waiting-operator` route) is written with enough detail that Phase 2 can
  execute it directly off this report — an approved fold's draft body, an approved close's one-liner, an
  approved route's target folder — without re-deriving anything.

---

## Phase 2 — Execute (fires on the operator's per-item "go")

**The operator's turn between the phases IS the gate** — the same gate that used to sit between
board-pass and a manually-invoked `consolidate`/`spec-pass`, now inside one skill. The operator responds
to the Phase 1 report per item ("fold the seed-dental pair", "promote 1319", "close 1245", "route 1356
to waiting-trip") — Phase 2 carries out exactly those approved items, reusing the Phase-1 analysis:

- **Approved folds** — execute via the shared procedure at
  `consolidate/references/fold-procedure.md`, starting from its Step 3 (Mint), using the body Phase 1
  already drafted while proposing it. **No separate `consolidate` invocation needed** for a fold
  proposed in this same board-pass.
- **Approved promotions** — `move-plan <id> <target>` (already-identified target from Phase 1's
  waiting-lane audit or a `pending-approval/` route), or — since plan 3973 (T2) — the ONE-command
  combined form when the promotion still needs its cloudExec stamp too:
  `node scripts/stamp-exec-model.mjs <id> <lane> --spec-review <sha> --provenance "<model>/<effort>"
--cloud-exec <true|false> [--env <cloudEnv>] --move ready|<waiting-state> [--blocked-by "…"]` folds
  the exec-model stamp, the cloudExec backstop, and the move into ONE master commit. Same cloudExec
  backstop as Phase 1's waiting-lane audit either way: a promotion landing in `ready/` without a
  `cloudExec` stamp gets one now (spec-pass step 4 rubric) — via the combined form above, or the
  standalone `stamp-cloud-exec.mjs <id> true|false [--env …] --reason "…"` when the promotion needs no
  fresh exec-model/spec-review stamp.
- **Approved `waiting-operator` routes / closes** — apply the operator's pick from the decision digest:
  `move-plan` to the chosen lane (or the combined form's `--move waiting-operator --unblock
<manual|decision>` when a stamp is landing in the same breath), or archive with the drafted "not doing
  this because…" note. **When the close verdict is beyond-goal** (killed as out of scope, not merely
  superseded/stale), ALSO append one line — gist + why + link to the archived plan — to
  `docs/superpowers/plans/FOG.md` § "Out of scope" (plan 1668, via `coord-edit.mjs`). That ledger, not
  the archive body alone, is what stops the idea being re-proposed next sweep; its entries never
  graduate back (return only as a fresh mint if the goal itself is redrawn).
- **Remaining stamps** — call spec-pass's stamp authority (frontmatter `stage`/`execModel`/`specReview`,
  and — since plan 3973 (T2) — `cloudExec`/`cloudEnv` and a lane move in the SAME commit via
  `stamp-exec-model.mjs`'s combined form above) for anything the operator wants re-verdicted on the spot.

**What Phase 2 never does:** run a `batch-train` (a batch folder is auto-approved at proposal — already
runnable for the operator or the drain to claim separately; board-pass curates the batch, it does not
execute the train);
touch plan WORK (writing the plan's own implementation is never in scope, only its metadata/lifecycle);
or act on anything the operator didn't approve for this round (an un-answered proposal simply carries to
the next pass's report).

---

## Rules

- Heavy model only (Fable/Opus) — never run on the drain/executor model; never from a worktree
  (plan-body edits and moves are master-side coord ops via the coord tools, in both phases).
- Phase 1 pre-authorized without asking: spec-pass stamps, promotions whose gate is **objectively met**
  (blocker archived, date passed, condition demonstrably fired), fog-sweep graduations (minting stubs
  from graduated fog patches + clearing them, step 2b), reconciling the batch folders +
  `dependencies.md`, and **batch composition** (auto-approved at proposal, standing operator directive
  2026-07-14; the operator vetoes via the report). Everything else — folds, closes, `waiting-operator`
  moves — is a Phase-1 proposal; Phase 2 acts on it only once the operator has said go, per item.
- Don't manufacture work: no fold for tidiness, no promotion on a "probably fired" condition, no
  re-speccing a fresh `specReview`.
- Cadence: weekly, or whenever unspecced stubs (including `pending-approval/`) reach ~8, or before
  forming a coord-sprint batch.
