---
name: grill-lane
description: Use when the operator asks to grill the lane, empty `waiting-grill/`, answer the parked design questions, "/grill-lane", or otherwise wants a batched sitting to resolve the plan questions that have been accumulating for them. Operator-invoked, heavy-model only (Fable/Opus) — running a grilling interview and judging whether the rulings close every fork is the same tier as board-pass. Scope is `waiting-grill/` ONLY; `/unblock-lane` owns `waiting-operator/`, board-pass owns the objective lanes.
---

# /grill-lane — batched grilling of the parked-questions lane

`waiting-grill/` (plan 2034) is where plans go when their correctness criteria live in the
operator's head. Spec-pass and board-pass are forbidden from asking inline — an autonomous
10-plan sweep must never block on question one — so they write the open questions into a
`## Grill questions` section and park the plan here. **This skill is the other half of that
contract: the deliberate sitting where the operator answers them all at once.**

Without this skill the lane is a graveyard. With it, the parking rule is honest: the questions
were never dropped, just batched.

## D1 — Who runs this, and on what model

Operator-invoked, never a periodic sweep. **Heavy-model only (Fable/Opus)** — same tier as
`board-pass` / `/unblock-lane`. Conducting a real interview (one question at a time, adapting to
the previous answer) and then judging whether the rulings actually close every fork are both
judgment calls a drain/executor model must not make.

Budget honestly up front: this is an interview, not approval triage. A five-plan lane is a
real sitting. If the operator has five minutes, say so and offer to grill the top one or two
rather than starting a walk that gets abandoned halfway.

## D2 — Scope: this lane and nothing else

**Only `waiting-grill/`.** An argument narrows it (`/grill-lane 1782`, `/grill-lane the DK plans`);
absent an argument, walk the whole lane.

- `waiting-operator/` → **`/unblock-lane`**. That lane is 5-minute approval triage (a go/no-go on
  an already-specified action). This one is an hour-long design interview. Do not merge them.
- `waiting-blocked/` · `waiting-trip/` · `waiting-date/` → board-pass's objective-promotion lanes.
  Nothing there needs an interview.

**The R1 boundary litmus**, if a plan looks like it could belong to either lane: route by _what the
operator's reply looks like_. A go/no-go or timing call on an already-specified action → operator
lane. Reply that is _content_ which must be written into the plan body before execution can be
fully specified → grill lane. A single design fork (the plan-767 tombstone-or-keep shape) is grill,
not operator, even though it is only one question.

## D0 — Open by re-checking tags, not by asking (plan 4069, operator ruling 2026-09-20)

Sessions decide tech-design and plan-scope forks themselves now — only a question naming one of the
fixed operator axes (`product`, `policy`, `money`, `access`, `data-ruling`) may still be sitting in
`## Grill questions` at all. **Before running the interview, re-read each plan's tagged questions and
re-route any that look wrong to a fresh reader:** a question whose `[axis: <tag>]` doesn't actually match
its content, or that is really a technical-design/scope call a session should have decided itself, gets
answered on the spot — write the chosen option into `## Session decisions` (never into `## Operator
rulings`, which is reserved for genuine operator answers) and skip it in the interview. Only the
genuinely axis-correct remainder gets asked. This is a quality check on the parking sessions' tagging,
not a re-litigation of their content — when in doubt whether a tag is wrong, ask rather than silently
resolve it. The section itself is a NUMBERED LIST ONLY (plan 4069 session decision S1): if a re-route
edit needs to touch an item's own line, keep it opening with `N. ` immediately followed by its
`[axis: <tag>]` marker, with any context indented underneath — never flatten it into a bullet or bare
prose while editing.

## D3 — The walk

Order by (age × relevance to currently-active work) — the same ranking board-pass Phase 1's
decision digest uses. Don't invent a second ordering.

For each plan (after D0's re-check has cleared any mistagged questions):

1. **Read the body in full**, not just the `## Grill questions` section. The questions were written
   at park time with full context loaded; you need enough of that context back to conduct the
   interview and to recognise a question that has since dissolved (see D5).
2. **Run the interview with the `grilling` skill** — one question at a time, each carrying your
   recommended answer, every resolved answer folded into the plan body as you go. Not a single
   batched question set: the whole point of batching at the LANE level is that each individual
   plan can then get a real back-and-forth. `grilling` is a plain personal skill, not a
   Superpowers one — it does not ship in the coord-kit (`coord/skills/**` is the kit's only skill
   source; a skill the kit doesn't carry is out of scope for the builder to vendor). **When
   `grilling` is not installed, run the interview inline, the same shape:** open with a short
   plain-language brief (what the plan builds, why, what's already decided, what this grilling
   settles); then, one question at a time — where in the plan it lands, the question itself (never
   bundled), each option in plain words with an upside/downside line, your recommendation — and
   wait for the answer before asking the next one.
3. **Record the answers** as a `## Operator rulings` section in the plan body (via
   `scripts/edit-plan.mjs`), each ruling numbered and tied to the question it answers, in the
   operator's decision voice — `R1 — <the rule>`, not "we discussed X". A future executor reads the
   rulings, never the transcript. **Recording an answer means MOVING the item** — the question comes
   out of `## Grill questions` once it has a ruling (plan 4069 session decision S1: the "already
   answered" signal is a literal bracket token, `[RESOLVED]`/`[RULED]`/`[ANSWERED]` immediately after
   the item's axis tag, never inferred prose). If a question stays visible in `## Grill questions` for
   the historical record rather than being deleted, mark it with that literal token in that exact
   position — annotating it with prose like "→ RULED, see R1" instead does NOT satisfy the stale check
   and the item is read as still open on the next re-park.
4. **Write durable defaults back out.** When a ruling is a general policy rather than a fact about
   this one plan (the plan-1896 distance-basis rule is the archetype), fold it into the runbook /
   CLAUDE.md / wiki page that owns the subject **in the same session** — otherwise the next plan
   asks the same question. The plan body keeps the ruling; the runbook gets the rule.
5. **Re-stamp `loop:`** — flip `hitl` → `afk` when the rulings close every fork that needed the
   operator live. If some step still only resolves through a live exchange, leave `hitl` and say so.
6. **Route it out** (D4).

## D4 — Exit routing

`move-plan` enforces the exit guard: **`waiting-grill/` → `ready/` is refused without a non-empty
`## Operator rulings` section.** Every other exit is unguarded.

| After the interview                                                                                                       | Route                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rulings close every fork AND the plan is obviously drainable                                                              | Stamp spec in-session (`scripts/stamp-exec-model.mjs`) and `move-plan <id> ready`. **This is legitimate** (R4c): a grilling session is heavy-model by definition, the same tier the spec-pass exit test needs — it does not have to hand a freshly-grilled plan back to a separate spec-pass round-trip. |
| Rulings answered, but the framing still needs the full exit test (an epic, a decomposition, a non-obvious placement call) | `move-plan <id> pending-approval` for the normal spec-pass.                                                                                                                                                                                                                                              |
| Rulings answered, but execution now waits on something else                                                               | The applicable `waiting-*` lane — including `waiting-operator/` when what remains is a plain go-ahead.                                                                                                                                                                                                   |
| The operator wants it frozen                                                                                              | `move-plan <id> parked` (plan 1426).                                                                                                                                                                                                                                                                     |
| The operator wants it dropped                                                                                             | Draft a superseded/wontfix one-liner, **get the nod**, then archive. Beyond-goal drops also append to `docs/superpowers/plans/FOG.md` § "Out of scope".                                                                                                                                                  |

The lane admits both `stage: stub` and `stage: specced` plans (R4a) — a plan can be parked for
grilling before spec-pass or after, when execution surfaced new operator questions.

## D5 — The dissolution path (no interview needed)

A plan whose questions have gone moot — superseded by a later plan, answered elsewhere, the
surface deleted — does **not** need a grilling session. Any session that notices records a
one-line ruling and routes it out:

```
## Operator rulings

dissolved: superseded by plan 2100 — the taxonomy fork no longer exists.
```

That satisfies the exit guard naturally. The lane is a queue, not a graveyard: a plan should leave
it the moment its questions stop being real, whether or not the operator ever answered them.

## D6 — What this skill must never do

- **Never role-play the operator's side.** If they defer a question, it stays open and the plan
  stays parked. A recommended answer is a recommendation; only their reply becomes a ruling.
- **Never promote to `ready/` on rulings that leave a fork open.** The exit guard checks for a
  non-empty section, not for completeness — that judgment is yours, and it is the whole reason
  this skill is heavy-model.
- **Never widen into `waiting-operator/`** because the operator is here anyway. Different lane,
  different skill, different question shape.

## Common mistakes

| Mistake                                                     | Why it bites                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Batching every plan's questions into one giant question set | The batching is at the LANE level; each plan still deserves a real interview. A mega-set gets shallow answers on the questions that most needed depth. |
| Recording the transcript instead of the rulings             | The next executor reads `## Operator rulings` cold, weeks later. "We talked about it and agreed" is not a ruling.                                      |
| Leaving a durable default only in the plan body             | The next plan asks the same question. Policy answers belong in the runbook (D3 step 4), same session.                                                  |
| Promoting a grilled stub to `ready/` without stamping spec  | The ready-gate needs a spec stamp; R4c lets you stamp it here, but it must actually be stamped.                                                        |
| Starting a full-lane walk when the operator has two minutes | An abandoned half-walk leaves plans with partial rulings — worse than un-grilled. Offer the top one or two instead.                                    |
