# Guard hooks

A rule written only in prose — in a handbook, a runbook, a comment — is a rule that has to be
_remembered_ by whoever is acting at the moment it matters, and the moment a rule matters most is
usually also the moment attention is thinnest: under time pressure, mid-recovery from some other
problem, deep in a long session that has drifted away from what the handbook says. An agent that has
read the rule a hundred times can still skip it the one time it counts, not out of disregard but
because the situation did not visibly resemble the rule's example. A guard hook turns the rule from
something that has to be remembered into something that is simply checked, every time, by code that
runs whether or not anyone thinks to invoke it. What it prevents is not any one specific mistake —
it prevents the class of mistake where a correct, well-documented rule fails purely because nobody
happened to bring it to mind at the right moment.

## Three families

Guard hooks in this design sit at three different points in an agent's and a repository's lifecycle,
and knowing which family a given rule belongs to is most of the design work:

1. **Agent-harness hooks** run _before_ the agent's tool call executes at all — before a shell
   command runs, before a file write lands. They can deny the call outright, and because they run
   pre-execution, a denial costs nothing: the dangerous action never happened. This is the right
   family for anything that must never even be attempted, and it is the only family that can act on
   the intent of a call (the exact command text, the exact file path) rather than its aftermath.
2. **Version-control hooks** run at commit and push time, against whatever is already staged or
   about to be sent. They cannot stop a bad edit from happening — the edit already exists in the
   working tree by the time they run — but they can stop it from becoming a permanent, shared fact
   (a commit, a pushed ref) that every other agent will now see and build on.
3. **Range-scoped lint gates**, invoked from inside the push hook, examine the actual diff being
   pushed rather than the whole repository. This is what lets a gate be strict without being
   punitive: it judges only what this push is introducing, never work that was already sitting in
   the repository before this agent touched it.

The three families are not redundant with each other. A harness hook is the cheapest and fastest
place to catch a mistake, but it only sees one tool call in isolation and has no view of the
repository's actual committed state; a push-time gate is slower (it runs once per push, not once per
call) but can reason about the whole diff, cross-reference committed history, and catch a pattern
that only becomes visible once several individually-innocuous edits are considered together.

## What each guard actually prevents

The concrete guards below are drawn from one real deployment of this design; the point is not the
specific list but the _shape_ — a guard exists for a failure that was observed to actually happen,
not for a hypothetical one, and each guard's scope is narrowed to exactly that failure so it does
not become a second source of prose-shaped friction.

| Guard                              | Family                                             | Prevents                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-owner worktree write guard   | harness (pre-write)                                | A second agent writing into a working tree it does not own, silently corrupting the owning agent's uncommitted state.                                                                                                                                                  |
| Clean-shared-checkout guard        | harness (pre-write)                                | Loose, uncommitted dirt landing in the one shared checkout that every coordination and merge operation depends on being clean.                                                                                                                                         |
| Merge-to-trunk guard               | harness (pre-command)                              | A hand-run merge or push straight to the trunk while any working tree still exists — bypassing the land spine's queue, gates, and seam discipline entirely.                                                                                                            |
| Trunk-checkout rewrite guard       | harness (pre-command)                              | A hand-run rebase, hard reset, or non-fast-forward merge run directly against the one shared checkout several agents depend on, instead of through the one sanctioned recovery tool.                                                                                   |
| Stale-lock removal guard           | harness (pre-command)                              | A raw delete of a version-control lock file — which can also delete a lock a live operation is actively using — instead of the tool that only removes a lock provably idle past a safe threshold.                                                                      |
| Unwrapped heavy-test-sweep guard   | harness (pre-command)                              | A whole-directory test sweep run without the parallelism wrapper that both speeds it up and gives it a fair scheduling slot alongside other agents' work.                                                                                                              |
| Land-timeout-shape guard           | harness (pre-command)                              | A merge-to-trunk operation launched with an ad hoc timeout value instead of the one value every long-running operator agreed the whole fleet should use — so a timed-out land is always diagnosed the same way.                                                        |
| Backgrounded-landing guard         | harness (pre-command)                              | An unattended agent handing its merge-to-trunk step to a background process and then blocking on it — a shape observed to leave the agent's own environment mid-wait with no way to notice the job finished.                                                           |
| Coordination-doc write guard       | harness (pre-write) + version-control (pre-commit) | A hand edit to a generated or multi-writer coordination document, instead of routing the change through the one tool that can make the edit atomically and without racing a concurrent writer.                                                                         |
| Archived-record immutability guard | harness (pre-write)                                | An edit to a record that has already been closed out and archived — silently changing history that other agents may already be relying on as a fixed reference.                                                                                                        |
| Range-scoped import-boundary lint  | push-time, diff-scoped                             | A module in a portion of the tree meant to be self-contained (because a test harness runs an isolated _copy_ of it) importing something outside that boundary — which works fine in the real repository and then fails only inside the isolated copy.                  |
| Range-scoped no-project-nouns lint | push-time, diff-scoped                             | A document meant to be read with zero context about this specific project quietly absorbing a fact — a name, a brand, a hostname — that only makes sense with that context, converting a reusable document back into project-specific folklore one sentence at a time. |

Several of these are deliberately **warn-only** rather than blocking: a guard that only warns is
appropriate when the mistake it is naming is a missed _opportunity_ (a hand-rolled version of a step
a purpose-built tool already does better) rather than a correctness hazard, and when blocking would
punish a genuinely one-off situation the guard's author did not anticipate. The choice between warn
and block is made once, deliberately, per guard — never left to whichever mood the guard's author
was in that day.

## The thin-dispatcher pattern

A guard hook's own entry point — the file the harness or the version-control tool actually invokes —
is kept as short as possible: read the input, call into an ordinary module, print the module's
verdict, exit. All of the actual logic — what counts as a match, what the message should say, which
edge cases are exemptions — lives in that ordinary module, which is then unit-tested exactly like
any other piece of code in the repository: constructed inputs in, an expected verdict out, no
harness, no live git operation, no tool-call machinery required to exercise it.

This matters because a hook's own dispatcher is awkward to test directly — it reads from a specific
input channel the harness provides and its correctness is entangled with the harness's exact
invocation contract — while the logic behind it, once separated out, is not awkward at all. Folding
logic into the dispatcher itself trades a small amount of directness for a permanent loss of test
coverage on exactly the code most likely to need a careful edge case fixed later.

**The pattern only works if the module layer stays self-contained.** A test harness that wants to
exercise this tooling end to end, safely, against a disposable scratch repository rather than the
real one, does so by copying the whole _tool_ tree — dispatcher and module together — into a
temporary location and running the copy there. If a module reaches outside that tree to import
something from elsewhere in the real repository, the copy breaks: the import resolves to nothing,
because nothing outside the copied tree came along. So the rule that makes the thin-dispatcher
pattern actually reliable is a layout rule sitting one level below it: **a non-test module inside
this tool tree may import only from siblings inside the same tree, plus the language's own built-ins
— never from anything outside it.** Anything a module genuinely needs from outside that boundary
arrives as an explicit parameter or through an injected dependency container, resolved by whoever
calls the module, never as a bare import reaching across the boundary. This rule is itself
mechanically enforced — a violation is caught the same way any other guard catches a violation,
rather than relying on a reviewer to notice an out-of-place import line.

## Diff-scoping

A gate that judges the _entire_ repository, every time, punishes an agent for debt that was already
there before that agent touched anything — which is both unfair (the agent did not create the
problem) and self-defeating (it makes every unrelated push a referendum on unrelated history,
eventually training everyone to route around the gate rather than fix the debt it is flagging). A
diff-scoped gate instead computes the specific set of lines a given push is actually _introducing_ —
the diff against the point where this branch forked from the trunk — and judges only that. Pre-
existing debt elsewhere in the file, or in a sibling file the push never touched, is invisible to
the gate; it will be judged the day some push actually changes it, and not before. This is what lets
a gate be strict without becoming a permanent source of unrelated friction: strictness is cheap to
sustain exactly because it is scoped to what a given agent actually did.

## Waiver-in-place

Every rule a lint enforces will eventually have a genuine, deliberate exception — a line that really
does need to do the thing the lint flags, for a reason a human considered and accepted. The
mechanism for that exception is a marker comment sitting directly on or immediately above the
flagged line, carrying a **non-empty reason** written in the same commit: a bare marker with no
reason does not waive anything, precisely because a marker that waives silently is indistinguishable
from a marker nobody thought about. Writing the reason inline, at the site of the exception, beats
maintaining a separate allowlist file for two reasons: the reason travels with the code it excuses,
so a later reader sees it in context instead of having to cross-reference a second document; and an
allowlist file is itself an unreviewed, growing surface that nobody re-checks once an entry is
added, while an inline waiver is re-reviewed every time the surrounding code is.

## Fail-open versus fail-closed

A guard that cannot determine, with confidence, whether the thing in front of it is safe has two
options: refuse by default (fail-closed) or allow by default (fail-open). The choice is not a matter
of house style — it follows from one question: **is there a gate downstream that will catch the same
problem if this guard lets it through?** If yes, fail open — the guard is a fast, cheap first line,
and a miss here is caught later at comparatively low cost, so an uncertain match should not block
real work over an inference the guard cannot make reliably. If no — if this guard is the only thing
standing between an unsafe action and it actually happening, with no downstream recheck — fail
closed, because a miss here is not caught anywhere.

An unattended agent makes this choice especially consequential in one specific way: a guard that
fails closed on an ambiguous case, with no human present to grant an exception, does not just delay
that agent — it parks it indefinitely on a prompt nobody is watching. That failure mode has to be
weighed explicitly against the cost of the rare false negative a fail-open choice accepts instead.

**A guard that fails open is a cost reducer, not a guarantee.** It shrinks the _frequency_ of the
mistake it targets — most instances get caught, cheaply, right at the point of the mistake — without
promising that every instance will be. Anyone relying on such a guard as the sole protection against
a given failure has misunderstood what it does; a fail-open guard earns its place by being paired
with something downstream that actually closes the gap, whether that is another gate, a periodic
full sweep, or a human review that would eventually notice the pattern.

See [`worktrees.md`](worktrees.md) for the ownership and clean-checkout rules several of the guards
above enforce, and [`land-spine.md`](land-spine.md) for the merge-to-trunk step the merge and
timeout guards protect.
