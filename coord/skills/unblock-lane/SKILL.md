---
name: unblock-lane
description: Use when the operator asks to walk the operator lane, triage waiting-operator, "/unblock-lane", or wants their waiting-operator plans interviewed and cleared instead of spontaneously remembering them. Operator-invoked, heavy-model only (Fable/Opus) — reading plan bodies and judging blocker-type is judgment work, same tier as board-pass. Scope defaults to `waiting-operator/` plus `loop: hitl`-stamped plans in active lanes; an argument may narrow to a plan id or theme. NEVER touches `waiting-blocked/`, `waiting-trip/`, or `waiting-date/` (board-pass's objective-promotion lanes).
---

# /unblock-lane — interactive waiting-operator triage + promote

Plans land in `waiting-operator/` with an `unblock:` marker and then wait for the operator to
spontaneously remember them (board-pass audit, 2026-07-04: 23 plans, oldest 5 weeks). `board-pass`
Phase 1 already produces a ranked **decision digest** for this lane but does not interview — the
operator still has to read it, decide, and hand-route each one. This skill closes that gap: it walks
`waiting-operator/` plan by plan, asks the operator exactly the question each one needs (and only that
one), folds the answer back into the plan, and promotes what clears.

**Critically, `waiting-operator/` is not one thing.** It hides three different blockers, and only one
of them is actually an interview. Getting this wrong in either direction is the failure mode: nagging
the operator for a decision they can't make (an ACTION-blocked plan needs them to go DO something, not
choose), or auto-promoting a plan that still needs an out-of-band act. **Triage every plan into exactly
one bucket before asking anything.**

## D1 — Who runs this, and on what model

Operator-invoked (not a periodic sweep board-pass owns automatically — the operator runs this when
they're ready to spend a few minutes clearing the lane). **Heavy-model only (Fable/Opus)**, same tier as
`board-pass` — reading a plan's full body and judging which of the three buckets it falls into, and
drafting the smallest honest option set for a DECISION plan, are both judgment calls a drain/executor
model should not be trusted with.

## D2 — The three-bucket triage (do this for every plan before any question)

| Bucket               | What it means                                                                                                                                                          | What this skill does                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DECISION-blocked** | The `unblock:` marker names a choice only the operator can make (e.g. "tag vs qualifier axis", "which mitigation: log / surface / accept", "go/no-go on an expansion") | **The only interview bucket** — ask, per D3                                                                                                                                                               |
| **ACTION-blocked**   | The operator must DO an out-of-band thing, not decide one (post a comment, get a sign-off, run a deploy, confirm each outreach recipient)                              | Report it as still-parked with the action named. **Never auto-promote, never interview** — asking "what should we do?" when the answer is already written and just needs doing wastes the operator's turn |
| **SPEC-blocked**     | `stage: stub` waiting on a spec-pass, not on the operator at all                                                                                                       | Hand to `spec-pass` (standalone invocation or flag it for the next `board-pass` spec sweep). **Do not interview the operator** — no answer they give moves a stub forward; it needs the exit-test review  |

Read the plan body far enough to tell which bucket it's actually in — the `unblock:` marker text alone
can look like a question ("which approach?") when the real blocker is that a stub was never spec-passed,
or look actionable when it's really an open fork only the operator can resolve. When genuinely unsure,
treat it as DECISION and ask — a wasted question costs less than a silently-stuck plan.

**A ZEROTH check, before any bucket (plan 4069, operator ruling 2026-09-20): is this row a session
decision, a session-owned close, or a genuine ask?** Sessions decide tech-design/plan-scope forks
themselves now — a `--blocked-by` naming a design/scope call with no `[axis: product|policy|money|
access|data-ruling|hold]` marker is answered on the spot (write the chosen option to `## Session
decisions`, `move-plan <id> ready` or the applicable lane) and never enters the DECISION bucket at all.
Separately, a plan whose premise is refuted, that is superseded, or whose work already shipped elsewhere
is a **session-owned close** — hand-archive it with a one-line reason (§ D4's "Drop it" confirm-round is
for an operator CHOOSING to drop something mid-interview; this is the session recognising the plan is
already dead before asking anything) and report it as DONE, not a proposal awaiting a nod. Only a row
that survives both checks — a real, axis-tagged, still-alive question — reaches D2's three-bucket triage.

## D3 — Interview protocol (DECISION bucket only)

One `AskUserQuestion` per plan:

- **Header** = the plan id.
- **Body** = the `unblock:` decision restated in plain language, plus the smallest set of concrete
  options pulled straight from the plan body (the operator can always pick "Other" — never force a
  false choice when the plan itself left it open-ended).

**Ranking** — walk the plans in the same order `board-pass` Phase 1's decision digest already uses:
**(age × relevance to currently-active work)**. Don't re-derive a different ordering; if a fresh
`board-pass` digest exists this session, use its ranking directly instead of recomputing it (see D6).

## D4 — On an answer, route it

- **A real decision** → fold it into the plan body via `edit-plan.mjs`: add a
  `**Decision (operator YYYY-MM-DD):** …` line, and resolve whatever open fork the body named (don't
  just append the line and leave the ambiguous section untouched — close the loop in the prose too).
  Then `move-plan <id> ready` — **unless** D5 applies (see below).
- **"Not now" / still deciding** → leave it parked in `waiting-operator/`. Optionally refresh the
  `unblock:` marker with the narrowed question, if the conversation sharpened it.
- **"Park it long-term"** → when the answer says this is a deliberate long-term hold rather than a
  near-term decision ("someday", "not this quarter", "stop asking me about this"), `move-plan <id>
parked` (plan 1426) instead of leaving it nagging in `waiting-operator/`. `parked/` is excluded from
  every scan (board-pass, this lane walk, INDEX, drain, claim) and the move is plain and reversible —
  the plan body stays intact and un-parks cleanly via `move-plan <id> <lane>`. This interview is the
  natural producer of `parked/` entries.
- **"Drop it"** → propose a close (archive with a superseded/wontfix one-liner) — but closing is itself
  **operator-confirmed, never unilateral**. Draft the one-liner, ask for the nod, then archive. When the
  drop verdict is **beyond-goal** (out of scope, not merely superseded/stale), also append gist + why +
  archive link to `docs/superpowers/plans/FOG.md` § "Out of scope" (plan 1668, via `coord-edit.mjs`) —
  the ledger is what stops the idea being re-proposed by later sweeps.

## D5 — The stub guard: a resolved decision does not skip spec-pass

If a DECISION-bucket plan is _also_ `stage: stub`, resolving the decision does not make it
execution-ready. Record the decision first (per D4), then **hand it to spec-pass** with the decision now
in the body — do not push a stub straight into `ready/` just because the operator answered the open
question. `ready/`'s gate (parseable 💰 banner, specced) still applies to every promotion this skill
makes.

## D6 — Reuse board-pass's classifier and ranking; don't re-roll it

The blocker-classification (which bucket a plan is in) and the digest-ranking (age × relevance) logic
are **shared with `board-pass` Phase 1** — see `coord/skills/board-pass/SKILL.md` § Phase 1 step 4
("Waiting-lane audit — the return path"), specifically its `waiting-operator/` sub-step, which already
builds "the decision digest: one line per plan — name, age, the smallest decision needed, and what
deferring costs. Rank by (age × relevance to currently-active work)." **That is the same digest this
skill interviews from.** If a `board-pass` ran this session, consume its digest directly instead of
re-sweeping the lane yourself. If none ran, apply the same two heuristics described there (age,
relevance-to-active-work) rather than inventing a different ranking or triage split — the plan-1373 D7
drift-prevention goal this skill was asked to honor is exactly "one definition, two callers."

## D7 — Scope

Default scope is `waiting-operator/` **plus any plan stamped `loop: hitl`** (plan 1668) sitting in the
claimable active lanes (`ready/`, `pending-approval/`) — a hitl plan's execution needs the operator live
regardless of which folder it rests in, and this walk is the natural place to schedule that exchange
(triage a hitl plan with the same D2 buckets; often it is DECISION-shaped even without an `unblock:`
marker). An argument may widen the target to a specific plan id
(`/unblock-lane 1356`) or narrow it to a theme (`/unblock-lane the DK-expansion plans`) — same
targeted-vs-sweep pattern other coord skills use. **Never touch:**

- `waiting-blocked/` — upstream-plan gated, promoted by `board-pass` when the blocker objectively lands.
- `waiting-trip/` — condition-gated, evaluated by `board-pass` against the repo.
- `waiting-date/` — calendar-gated, promoted by `board-pass` when the date passes.
- `waiting-grill/` — **`/grill-lane` owns it** (plan 2034). Those plans need an hour-long design
  interview producing `## Operator rulings` content; this skill stays 5-minute approval triage and
  must never become a design session. The R1 litmus when a plan could look like either: a go/no-go
  or timing call on an already-specified action is THIS lane; a reply that is _content_ which must
  be written into the body before execution can be specified is the grill lane. If a row genuinely
  belongs there instead, re-route it with `move-plan <id> waiting-grill`, writing the fork into
  `## Grill questions` as a NUMBERED LIST ONLY (plan 4069 session decision S1) — the item opens with
  `N. ` immediately followed by its own `[axis: <tag>]` marker, context indented underneath — never a
  bullet or a bare `--blocked-by` sentence copied over as-is.

The first three are **board-pass's objective-promotion lanes** — nothing in them needs an operator
interview — and the fourth is `/grill-lane`'s, so this skill has no business in any of them even
when invoked broadly.

## When to use / not use

- Use: the operator wants to clear some or all of `waiting-operator/` in one sitting, or asks "what's
  blocked on me right now" and is willing to answer questions about it.
- Do NOT use for a periodic full-board sweep with no interview intent — that's `board-pass` Phase 1
  (produces the digest; this skill is the interactive follow-through on it).
- Do NOT use to promote an ACTION-blocked or SPEC-blocked plan — route those per D2, don't force them
  through the interview path because "the operator is here anyway."

## Common mistakes

| Mistake                                                                | Why it bites                                                                                                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asking a question for an ACTION-blocked plan                           | The plan doesn't need a decision, it needs the operator to go do the named thing — a question just adds a turn with no useful answer.               |
| Interviewing a SPEC-blocked stub                                       | No operator answer turns a stub into a specced plan; that needs the spec-pass exit test.                                                            |
| Promoting a resolved-decision stub straight to `ready/`                | Skips the ready-gate (D5) — hand it to spec-pass with the decision recorded first.                                                                  |
| Re-deriving a new triage heuristic or ranking order                    | Duplicates board-pass Phase 1's classifier/digest logic (D6) — the exact drift plan 1373 D7 was meant to close.                                     |
| Closing a plan on "drop it" without a confirm round                    | Closing is archival and irreversible-ish; always show the one-liner and get the nod first.                                                          |
| Widening scope into `waiting-blocked/`/`waiting-trip/`/`waiting-date/` | Those lanes are objectively-gated, not operator-interview material — D7 scope is a hard boundary, not a default the operator can loosely wave past. |
