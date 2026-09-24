# Review as a costed step, not a ritual

Treating every change identically — either a light rubber-stamp for everything, or a full expensive
audit for everything — fails in both directions. Uniform light review lets a genuine correctness bug
through on exactly the diff that needed real scrutiny, because nothing distinguished it from a
trivial rename. Uniform heavy review burns an expensive, many-agent audit on a one-line comment fix,
and the wasted cost compounds: teams that feel review is too slow or too expensive start skipping it
selectively and informally, which is worse than never having calibrated it in the first place
because now the skipping is invisible. The failure this document prevents is not "review didn't
happen" — it is "review happened, but nobody can tell how much scrutiny it actually applied, so a
rubber-stamp and a real audit are recorded identically, and a bug that should have been caught ships
with an apparently clean review sitting right next to it."

## The calibration ladder

Route each change to review effort proportional to its actual risk, not its author's mood or the
reviewer's default settings:

- **No new logic → a self-read**, not a fan-out. A pure rename, a comment or whitespace change, a
  verbatim-moved block, or the tenth identical copy of a pattern already reviewed this same change —
  none of these need a multi-agent audit. Read it yourself, record that you did, move on. "New
  logic" is any added or changed conditional, loop, data transformation, external-input parse,
  ordering assumption, or error path; when genuinely in doubt, treat it as new logic.
- **New logic → the system's default review lane.** Whatever your standard fan-out mechanism is for
  a change that actually does something new.
- **A large diff or a correctness-critical surface → the widest available lane.** Size (many files,
  hundreds of changed lines) or stakes (a shared coordination primitive, a data-mutation path,
  anything where one bug silently corrupts many records) both independently justify the heaviest
  review tier your system has.

**Re-review, after a fix round, scopes to the delta — never a full re-fan-out of the whole diff.**
Re-running every finder against the entire change on every fix round is the single most common way
calibration gets wasted in practice: one measured audit of a real review pipeline found roughly a
third of all fan-out runs were repeat runs re-confirming a tiny follow-up rather than a genuine
first pass. Scope the re-review to exactly what changed since the last one.

## The fan-out shape

A full review fan-out, when one is warranted, follows a consistent shape regardless of which
specific model or tool implements it:

1. **Scope** the diff — resolve exactly which files and lines changed, explicitly, rather than
   trusting whatever the working directory happens to be sitting in (see the pitfall below).
2. **Parallel finders**, each looking through a different correctness _angle_ (logic errors,
   error-handling gaps, data races, security, the project's own known trouble spots), run
   concurrently over the scoped diff and surface candidate findings.
3. **One verifier per distinct finding location.** Rather than trusting a finder's raw output, an
   independent pass re-examines each specific `(file, line)` location a finder flagged and either
   confirms or refutes it.
4. **A sweep** for anything the per-location verification style would miss — gaps between findings,
   or issues that only show up when looking at the diff as a whole rather than location by location.
5. **Synthesis** — one coherent report out of everything the previous stages produced, findings
   ranked by severity.

**Escalate-on-refute is where the real cost saving comes from.** A cheap, fast model tier does the
bulk of the work — every finder, and the first round of per-location verification — and only when
that first verifier _refutes_ a candidate finding (says "this isn't actually a bug") does a second,
more expensive and more careful model re-judge that one specific location before the finding is
dropped for good. This means the expensive tier is spent exclusively on the highest-risk decision in
the whole pipeline — throwing away a candidate finding — and never on the bulk work of generating or
confirming findings in the first place. Measured against a full expensive-tier-only fan-out, this
pattern has delivered full-tier-comparable outcomes at a small fraction of the cost, because the
expensive model's attention goes only to the specific junction where getting it wrong (silently
dropping a real bug) is worst.

**Before launching any fan-out, prove the scope in one cheap command first.** The single most common
way to get a confident, meaningless clean result is launching the review from the wrong location
entirely — a shared root checkout sitting on the trunk branch, rather than the actual branch
carrying the change — so the "diff" it reviews is empty or belongs to someone else's already-merged
work. Print the branch name and the changed-file count before trusting anything past that point; a
zero file count is the whole failure stated in advance.

## Provenance as recorded data

Recording only a bare verdict — "passed" — answers nothing useful later: passed _how_? At what point
in the change's history? By a real multi-agent fan-out, or by one person skimming the diff once?
Record, alongside the verdict, the specific commit it was taken against, which review lane actually
ran, and the fan-out counts (how many finders, how many verifiers, how many escalations to the
expensive tier). With that recorded, "was this properly reviewed" becomes a query against stored
data rather than a question that only the original session — or nobody — can answer.

**A recorded review with no declared provenance is not silently trusted as a full review** — it is
stamped, visibly, as provenance-undeclared. This does not block anything by itself, but it stops an
under-scrutinized pass from being indistinguishable from a real one later. A known, named downgrade
(for instance, a single reviewer pass run by an execution context that structurally cannot run the
full multi-agent fan-out) is honestly recorded as exactly that: weaker, and labeled so.

**The merge gate itself should be command-agnostic.** It should key only on the presence of a
recorded, valid verdict-plus-commit marker — never on which specific tool or lane produced it. This
matters because it lets a system swap or add review lanes freely (a different provider, a cheaper
fallback when the primary transport is unavailable) without ever having to touch the gate that
enforces review happened. The gate's only job is confirming a review was recorded against the exact
commit being merged; deciding whether that review was rigorous enough is what the calibration ladder
and the provenance record above are for.

## Findings as data

Every finding a review surfaces gets an explicit **disposition** — never left implicitly "noted" and
forgotten:

- **Fixed** — addressed in this same change.
- **Deferred with a named target** — real, but out of scope for this change; captured somewhere a
  human or a future session will actually see it again, not left to memory.
- **Declined, with a reason** — a conscious call that this finding does not need addressing, stated
  plainly enough that a later reader can judge whether that call still holds.

**The merge is blocked until every single finding carries one of these three.** An undispositioned
finding sitting silently in a review's output is worse than no review at all, because it creates the
appearance of having been handled.

## Fix-now-first, and why "pre-existing" is not an excuse either way

When a finding is genuinely cheap to fix right now — the context is already loaded, fixing it does
not pull in a whole new review cycle, and it does not change the risk profile of the change already
in flight — fix it in the current change rather than deferring it. **Whether the bug is pre-existing
or newly introduced is explicitly irrelevant to this decision, in both directions**: "it was already
broken before my change" does not excuse fixing it when the fix is cheap right now, and it also does
not _obligate_ fixing every pre-existing issue a review happens to notice while looking at unrelated
code. The only question is total cost. The session that already has the context loaded is,
structurally, the cheapest possible session that will ever fix this particular finding — every
session after this one pays to re-acquire the same context from scratch, on top of the actual fix.

A closely related trap: once a change is a few fix-review rounds deep, a reviewer will start
surfacing findings about code the _current_ change never touched at all — pre-existing behavior of a
neighboring surface that merely happens to be visible in the same diff. The tell is cheap to check:
would this finding still be true with the current change's diff removed entirely? If yes, it belongs
to a different, separate piece of work — record it there, not as an obligation on the change in
front of you. Expanding a change's scope to fix every adjacent thing a reviewer happens to notice is
how a small, well-bounded change grows into an unreviewable one.

## Severity and evidence floors

Not every surfaced concern deserves the same weight, and the deciding axis is **how the problem was
found**, not how bad it sounds in the abstract:

- **Observed in the wild** — a real run produced a real wrong output, a live surface showed the bug,
  or a human directly reported it — earns its own tracked, followed-up item. This is real, confirmed
  evidence that something is actually broken for someone.
- **Noticed only while reading code** — a reviewer spotted something that _could_ go wrong, with no
  confirmation that it ever has — is real information, but proportioned lower: a single line in a
  running debt ledger rather than a whole new tracked item demanding its own future cycle. Promotion
  from ledger line to full tracked item happens only when it is later actually observed to matter.

This floor exists because a review process is, by its nature, extremely good at surfacing latent
"could go wrong" concerns, and treating every one of them as equally urgent as a confirmed live bug
floods whatever tracking system exists with items nobody can meaningfully prioritize against each
other.

## Failing-test-first for every accepted fix

Before writing the fix for any finding you accept, **write the test that reproduces it, confirm the
test actually fails against the unfixed code, then fix until it passes.** That red-to-green run is
the fix's real verifier of record — a subsequent re-review is a second, complementary check, never a
substitute for having actually run the failure and watched it go away. This matters because,
empirically, review rounds past the first are dominated by _regressions the previous fix round
itself introduced_ — a reviewer re-reading the code and pronouncing it correct has been observed to
pass an objectively still-broken fix clean, repeatedly, because a prediction about code and a
measurement of code are different things, and only the second one is reliable once a fix has already
gone through one wrong round.

On a surface with no natural test seam — pure visual rendering, live external-page behavior,
anything that cannot be asserted by a unit test — the substitute is a real run against the actual
surface: exercise the changed behavior once, for real, and name exactly what was run and what it
showed. A reviewer re-reading the change still does not count as verification in this case; the run
is what counts.

## A bounded fix-then-re-review loop

Review-then-fix-then-re-review is a valuable loop, but it does not converge to zero findings on its
own, and left unbounded it degrades: rounds beyond the first one or two are increasingly dominated
by regressions the previous round's own fix introduced, not by the original surface's genuine
problems. Set an explicit, small cap on the number of fix-and-re-review iterations one change may
run through. When the cap is hit, the exit is a deliberate choice among three, not an automatic
extension of the loop:

1. **Run it for real** — verify the disputed point with an actual measurement (a real execution, a
   staged failure test) rather than a further round of reading.
2. **Simplify or delete the fragile thing being argued about**, rather than patching it again. If
   every round is finding a new bug in the same small mechanism, the mechanism itself is very often
   the finding.
3. **Park it**, stating plainly what the reviewers claim, what you believe, and what would settle
   the disagreement — handed to a human rather than resolved by yet another automated round.

A softer companion rule: a finding that was already consciously declined once, and gets re-raised in
a later round with no new supporting evidence, is itself a sign the loop has converged — not a
reason to keep arguing it. And a single "run it for real" exit used twice in a row on the same
disputed point is itself a signal the loop is not actually converging; treat a second consecutive
instance of that exit as a forced move to one of the other two.

## Hard failure: zero changed files is never a pass

A review that resolves its target diff to **zero changed files** is a hard error, not a clean pass —
even though "nothing to review" superficially resembles a clean result. In practice this is almost
always the wrong-checkout pitfall named above: the review was launched from a shared root checkout
on the trunk branch, rather than from the branch actually carrying the change, so the tool dutifully
reported a truthful "no differences" against the wrong baseline. Treating this as a pass would let
an entirely unreviewed change sail through with an apparently valid review record attached to it.
The one legitimate exception is a genuinely empty diff after deliberately excluding non-reviewable
artifacts (generated files, vendored data) — that stays a real pass, because in that case there is
truly nothing left that needed a human or model's attention.

## A worked shape of escalate-on-refute

Concretely: a finder on the cheap tier flags a candidate bug at a specific location. A cheap-tier
verifier looks at just that location and either confirms it (it goes straight into the report) or
refutes it (the finder was wrong, drop it) — and for the large majority of candidates, that is the
whole story, entirely on the cheap tier. Only when the cheap verifier's answer is "refuted" does a
second, independent, more expensive reviewer look at that one specific location one more time,
purely to check whether the cheap tier's refutation itself was correct. If the expensive reviewer
agrees it was a false alarm, the finding drops for good; if it disagrees, the finding survives into
the report despite having been refuted once. The expensive tier's entire job in this pipeline is
auditing refutations, never generating or confirming findings from scratch — which is exactly why it
can be small and still buy most of the benefit of a fully expensive-tier review.

## Red flags and common mistakes

| Tempting thought or mistake                                                                                                               | Reality                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This is a small follow-up, but let's re-run the whole fan-out to be safe"                                                                | Scope the re-review to the delta — re-scanning the whole diff for a tiny follow-up is the single largest measured source of wasted review cost in a real audited pipeline.                                                                                              |
| "The reviewer found it, so I have to fix it in this change" — or, since I'm already here, fix every adjacent thing I notice too           | Check whether the finding would still be true with this change's diff removed. If yes, it belongs to separate work, not this change — record it there rather than fixing it now or letting it grow this change's scope.                                                 |
| "It's pre-existing, so I don't need to touch it" (or, the mirror: defer a cheap fix because the bug is "pre-existing")                    | Provenance does not excuse a cheap fix any more than it obliges an expensive one. Run the fix-now cost test, not the provenance question — the session with context already loaded is the cheapest one that will ever fix it.                                           |
| "The re-review read it and it looks right this time"                                                                                      | A reading is a prediction, not a measurement. Past round one, run the failing test and watch it go green — review rounds past the first are dominated by regressions the _previous_ fix round itself introduced.                                                        |
| "One more round should settle this"                                                                                                       | Check whether this is a second consecutive "run it for real" on the same point — that pattern is itself the sign the loop is not converging.                                                                                                                            |
| "Zero changed files means there was nothing to review, so it's a pass" (often the result of launching the review from the wrong checkout) | Almost always the wrong checkout — a shared root sitting on the trunk branch reviews an empty or unrelated diff and returns a confident, meaningless clean result. Print the branch and changed-file count first, and treat a zero count as a hard failure, not a pass. |
| "A bare 'passed' verdict is enough to record"                                                                                             | "Was this reviewed" stops being answerable later — a rubber-stamp and a real fan-out become indistinguishable. Record the commit, the lane, and the fan-out counts alongside the verdict.                                                                               |
| "I'll leave this finding noted, for later"                                                                                                | Creates the appearance of having been handled while nothing was decided — worse than surfacing no finding at all. Every finding needs an explicit disposition before the merge.                                                                                         |
| "This could go wrong, so it's just as urgent as a confirmed bug"                                                                          | Floods the tracking system with items nobody can prioritize; a latent "could go wrong" concern belongs on a lighter ledger until it is actually observed to matter.                                                                                                     |
| "Let the fix-then-re-review loop keep going until everything's resolved"                                                                  | It does not converge to zero findings on its own — an uncapped loop burns unbounded budget arguing with itself. Set an explicit cap and exit through one of the three deliberate choices when it is hit.                                                                |

## Costs and limits

Calibration only pays off if the routing decision itself is cheap and reliable — a system that
spends as much effort deciding "how much review does this need" as the review would have cost has
calibrated nothing. The escalate-on-refute pattern buys most of its savings from the cheap tier
being genuinely competent at the bulk of the work; if the cheap tier is unreliable, the savings
evaporate and the expensive tier ends up re-doing work it was supposed to only spot-check. The
bounded fix-loop trades a small, accepted risk (occasionally stopping before every last theoretical
concern is resolved) for a much larger, avoided one (a loop that never converges and burns unbounded
review budget arguing with itself). And none of this replaces the judgment call at the center:
deciding whether a given finding is worth fixing now, deferring, or declining is not something a
lint rule or a cap can make for you — the mechanisms here bound the process around that judgment;
they do not substitute for it.

## See also

`subagents.md` for the delegation discipline a fix-round dispatch follows; `cloud-drains.md` for how
an unattended session's own review step is scoped and recorded; `landing-queue.md` and
`land-spine.md` for how a recorded, fully-dispositioned review gates the actual merge;
`plan-lanes.md` for how a unit of work's own risk profile feeds the calibration ladder in the first
place.
