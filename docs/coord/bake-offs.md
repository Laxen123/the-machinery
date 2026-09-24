# Bake-offs: comparisons you can still trust in six months

Every project eventually has to pick between two ways of doing something — two models, two tools,
two prompts, two algorithms — and the naive way to decide is to try both once, look at which one
seems better, and move on. That naive comparison is nearly worthless six months later: nobody wrote
down what exactly was compared, the "better" one was judged by eye against no fixed standard, and
the next person who asks "didn't we already decide this?" has no way to tell whether the old answer
still applies to today's version of either option. A bake-off is the discipline that makes a
comparison an asset instead of a fading impression — a controlled, single-variable trial over a
cohort fixed in advance, scored against a metric agreed before the numbers exist, with the verdict
written down somewhere a later reader can find and trust. Run well, it answers a question once and
the answer keeps paying off. Run casually, it produces a confident-sounding number that was never
actually evidence of anything.

## The method

A bake-off is built from a small number of disciplines, each one closing a specific way a comparison
can lie to you. None of them are exotic; all of them are easy to skip under time pressure, which is
exactly when skipping them costs the most.

1. **Fix the cohort before any arm runs, and never edit it afterward.** The cohort is the set of
   cases every arm is measured against. Choosing it in advance and freezing it is what makes the
   arms comparable to each other at all — if the cohort can still change after you have seen how an
   arm performs, there is nothing stopping it from quietly drifting toward whichever set of cases
   makes the preferred answer look best. A cohort edited after the fact does not need dishonest
   intent to invalidate the result; even a well-meant "let's drop that one weird case" made after
   seeing the numbers destroys the guarantee the freeze exists to provide.

2. **Vary exactly one thing per arm.** An arm is one configuration under test — one model, one
   prompt, one algorithm — and the entire value of running several arms side by side rests on every
   arm being identical except for the single variable actually being tested. Two arms that differ on
   the model _and_ the prompt _and_ the input format cannot tell you which of those three
   differences caused the outcome you measured; the result is a number with no diagnosis attached to
   it.

3. **Agree the gate metric, and its passing threshold, before the first scored call.** Deciding what
   "good enough" means after the numbers have already arrived is not measurement, it is post-hoc
   rationalization wearing a metric's clothes — the threshold quietly bends toward whatever result
   already happened. Writing the metric and its bar down before spending anything is what keeps the
   eventual verdict a genuine finding rather than a story fitted to a number.

4. **Score against ground truth that is independent of the arms being judged.** The judge cannot be
   the thing being judged, or a close relative of it. An arm scored against its own prior output, or
   against a reference built by a system closely related to one of the arms, will score suspiciously
   well against itself by construction — a win there is real evidence, but a loss is inseparable
   from the fact that the yardstick was never neutral to begin with. Without an independently
   sourced truth, a bake-off has a plausible cohort, plausible arms, and a plausible metric, and
   still cannot tell you who actually won.

5. **Never generalize from a single run.** A model, a person, or a stochastic process wobbles from
   attempt to attempt, and a single pass over the cohort cannot separate a real difference between
   arms from that within-arm noise. Report how many repetitions were run and how much the same arm
   disagreed with itself between them; a result reported as a single number with no replication
   behind it is a data point, not a verdict, and should be labeled as such rather than dressed up as
   one.

6. **Record the verdict on a durable registry page.** The comparison's whole value depends on a
   later reader — possibly the same person, months on — being able to find out what was actually
   compared without re-deriving it from a chat log or a half-remembered conversation. A registry
   entry names the cohort, the arms, the gate metric and its threshold, the verdict, and the date.
   Skipping this step means every hard-won comparison has to be re-fought from memory the next time
   the question comes up, which it will.

7. **A new verdict supersedes the old one in place, with a dated note — it never just accumulates.**
   Systems change, and a verdict measured against last quarter's version of an arm is not
   automatically still true of today's version. The registry entry is not append-only trivia; when a
   re-run produces a different answer, the old entry is updated to say so and point at the new one,
   so a reader in a hurry finds the current answer first rather than an unmarked pile of every
   verdict this question has ever had.

These seven are the load-bearing rules; nearly every failure mode below is one of them skipped.

## Failure modes this method exists to prevent

Naming the failure modes plainly is worth doing, because each one is individually easy to
rationalize in the moment:

- **A cohort edited to fit the result.** Dropping or adding cases after seeing how an arm performs,
  even with a defensible-sounding reason, breaks the comparability the freeze exists to guarantee.
- **A metric chosen after the numbers.** Deciding what counts as a win once you already know which
  arm you'd prefer to win turns measurement into justification.
- **A single run generalized into a verdict.** Reporting one pass's result as if it settled the
  question, with no replication to show whether the gap exceeds ordinary noise.
- **A verdict left standing after the thing it judged changed.** Treating an old comparison as still
  current simply because nobody re-ran it, when the arm it favored has since been modified, retired,
  or replaced.

## What "independent ground truth" costs when you skip it

The absence of an independent judge is the failure mode most tempting to accept, because building
one is often the most expensive part of the whole exercise — it can mean hand-labeling cases, or
paying for a second, unrelated system to adjudicate disputes. Skipping it does not make the
comparison free; it makes the comparison's failure invisible. A bake-off with every other discipline
in place but no independent ground truth can still report a confident-sounding win or loss, and that
confidence is not earned — it is borrowed against a judge that was never neutral. Treat the absence
of independent ground truth as a labeled limitation on the verdict, not as a detail to omit from the
writeup.

## Replication: what one run can and cannot tell you

A single comparison run can tell you that two arms produced different output on this pass, over this
cohort, at this moment. It cannot tell you whether that difference would survive a second pass,
because every real system — a model sampling with any randomness, a human doing subjective judgment,
a service with variable latency or load — wobbles run to run. The fix is not exotic: run more than
once, and report the within-arm spread alongside the between-arm gap. A between-arm difference that
is smaller than the within-arm wobble is not yet a finding; it is noise that happens to have a
direction this time. A difference clearly larger than that wobble, observed across several
repetitions, is what a real verdict is made of.

## The registry page as the durable artifact

The output of a bake-off is not the winning arm — that fact alone, disconnected from how it was
established, decays into folklore the moment the people who ran the comparison move on to other
work. The durable output is a registry entry that names, in one place, what was compared (the arms),
against what (the cohort), on what basis (the gate metric and threshold), with what result (the
verdict, including any caveats about ground truth or replication), and when. A registry that is kept
this way turns "didn't we already test this?" from a question that reopens a debate into a question
a link answers in ten seconds.

## Supersession, not accumulation

Nothing about a fixed cohort, a frozen threshold, or an independent judge stays true forever. Models
get updated, prompts get rewritten, the very system being tested for comparison purposes is retired
and replaced by something else entirely. A bake-off registry that never revisits its own entries
silently turns into a museum of comparisons made against systems that no longer exist. Supersession
is the fix: a re-run's new verdict replaces the old entry's standing answer in place, with a short
dated note explaining what changed and why the old verdict no longer applies — never a second,
separate entry left to coexist ambiguously with the first. A reader should never have to guess, from
two undated entries disagreeing with each other, which one is current.

## What this costs, and its limits

A bake-off run to this standard is slower and more expensive than an informal comparison — freezing
a cohort, building or sourcing independent ground truth, and running enough repetitions to separate
signal from wobble all take real time and, often, real money. It is not the right tool for a
decision that will be revisited in a week regardless of the answer, or for a difference so large
that no amount of noise could plausibly explain it. It earns its cost specifically for decisions
that are expensive to reverse, contentious enough that "I just tried it and X felt better" will not
be accepted as an answer, or likely to be asked again by someone with no memory of the first answer.
Used there, the discipline pays for itself the first time it prevents a comparison from being
re-litigated from scratch.

See also: `plan-lanes.md`, `land-spine.md`, `review.md`, `wiki.md` (a bake-off's registry entry is
exactly the kind of durable rationale the subject-knowledge vault is built to hold),
`rule-tiers.md`.
