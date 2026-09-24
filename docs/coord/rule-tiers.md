# Rule tiers: three layers of instruction file

A single instruction file that tries to hold everything an agent needs to know eventually fails in
two different directions at once. Written narrow, it repeats the same general operating advice —
verify before trusting memory, prefer read-only exploration, keep parallel work honest — in every
project's own file, so a lesson learned once has to be re-taught, differently worded, in every
repository an agent ever touches. Written broad, it drowns the handful of facts genuinely specific
to _this_ repository under paragraphs of advice that would be equally true anywhere, so the one rule
a reader actually needed to find is buried in restatements of common sense. The fix is neither:
split instructions into layers by how widely each rule actually applies, and let an agent inherit
the wide layers rather than re-reading them, project by project, forever.

## The three tiers

- **Global** — rules true of every repository an agent works in, regardless of what the repository
  does. Verify against the current state of a system rather than trusting recalled context. Prefer a
  read-only action over a mutating one when you are not certain which is correct. These are
  properties of doing careful work at all, not properties of any one codebase.
- **Umbrella** — rules shared by a family of related projects: a standing git workflow, branch
  hygiene conventions, a shared operating posture, shared tooling patterns. Narrower than global (a
  different family of projects would not necessarily inherit them), broader than any single project
  in the family.
- **Project** — rules true of this one repository and nowhere else: its architecture, its deployment
  targets, its specific gates and their names, the shape of its own data.

An agent starting work resolves these in order, narrowest first: project-tier instructions take
precedence where they exist, falling back to the umbrella tier, falling back to the global tier for
anything neither of the narrower two addresses. A rule stated at a wider tier is inherited
automatically by everything narrower; a rule stated at a narrower tier can refine or override what a
wider tier says, but should rarely need to — if a project-tier file is routinely contradicting its
umbrella, that is usually a sign the rule was placed at the wrong tier in the first place.

## The placement test

Before writing a new rule into any instruction file, ask one question: **would this rule still be
true in the next project?** If it would — if it is really a property of careful work, or of the
family's shared workflow, rather than a fact about this one codebase — it belongs a tier up from
wherever the temptation is to put it. Writing it at the narrow tier anyway means every sibling
project has to independently rediscover and re-state the same lesson, which is precisely the
duplication the layering exists to prevent. The test runs in both directions: a rule that only makes
sense with knowledge of this repository's specific tooling or data does not belong a tier up either,
because forcing it onto every unrelated project pollutes their instructions with advice that will
never apply.

## Keep each tier small: let the gate carry the detail

The single biggest way an instruction file balloons past being readable is restating, in prose,
something a hook or an automated gate already enforces deterministically. If a mechanism will refuse
a bad action outright and print exactly what was wrong and how to fix it, the instruction file does
not need a paragraph anticipating that failure — it needs one line pointing at the fact that the
gate exists and what it is called. The gate's own failure message carries the operational detail
because it is generated at the moment the detail is needed, current with whatever the mechanism
actually checks today; a paragraph in an instruction file describing the same check goes stale the
moment the mechanism's logic changes and nobody remembers to update the prose to match. The project
tier is the layer where this discipline matters most, because it is the layer most likely to
accumulate one paragraph per gate, one incident at a time, until the file that was supposed to be
quick to read has become a full incident log.

## The multi-runtime mirroring problem

A project is not always worked by a single kind of agent. Different agent runtimes each look for
their own conventionally-named instruction file, and once more than one runtime works the same
repository, the naive fix — write the same guidance twice, once per filename each runtime expects —
guarantees drift: two copies of the same rule edited at different times by different people (or
different agents) will disagree with each other sooner rather than later, and neither copy will
reliably say which one is current.

The durable fix is to keep exactly one file as the single source of truth and have every other
runtime's configuration point at it as a fallback, rather than maintaining a second copy of its
content. A symlink looks like the obvious mechanism for this and is not always portable across every
filesystem and tool a project's contributors use, so the pointer is often a small piece of
configuration — "when you don't find your own conventional file, read this one instead" — rather
than a filesystem-level alias. Whichever mechanism is used, the property that matters is the same:
editing the rule happens exactly once, in exactly one file, and every runtime that reads project
instructions sees that edit on its very next run, with no separate regeneration or re-sync step for
a human or agent to forget.

This problem compounds with runtime-specific behavior that has no shared analogue at all — one
runtime's automatic startup context injection, another's distinct hook or plugin model, a third that
only auto-loads project rules from a specific directory and cannot be reached by any startup-time
injection at all. Those differences are real and cannot be papered over by a shared instruction
file; they belong in that runtime's own small, explicitly-scoped configuration, clearly separated
from the shared source of truth so a reader can tell at a glance which parts of an agent's context
are common across every runtime and which are peculiar to the one it happens to be running in.

## The generic operating rules

A handful of rules recur at the global tier across essentially every project, independent of what
the project does. Each earns its place at that tier because it is a property of doing careful,
accountable work with an agent, not a property of any particular codebase.

**Verify against the source of truth rather than trusting recalled context.** An agent's own memory
of a system's state — what a file contains, whether a check currently passes, what a remote branch
looks like — goes stale the instant something else changes it, and another agent or process changing
state concurrently is the normal case, not the exception. Re-reading the actual current state before
acting on it costs little; acting on a stale belief can cost an entire piece of work redone.

**A decision is only real once it exists in committed text, written the same session it was made.**
A decision that lives only in a conversation is not yet a decision anyone else can act on — the next
session, the next agent, or the same agent an hour later has no way to discover it except by
re-having the same conversation. Writing the decision down immediately, rather than deferring it to
some later cleanup pass, is what turns a moment's agreement into something the rest of the system
can actually rely on.

**Prefer minimum technical debt: fix the structural cause, not the local symptom, when the two
differ.** A quick patch that makes one instance of a problem go away while leaving the mechanism
that produced it intact is often the faster fix in the moment and the more expensive one overall,
because the same mechanism will produce the same problem again, elsewhere, later. Preferring the
structural fix when it is genuinely available is not a purity rule; it is an acknowledgment that the
local patch is _borrowing_ time from a future session that will have to diagnose the same class of
failure from scratch.

**Use read-only verbs for anything you are not certain about.** Reading, listing, and inspecting
carry no risk of the action being wrong; writing, deleting, and mutating do. When uncertain whether
an action is the correct one, the safe order of operations is to gather more information with a
read-only step first and commit to a mutating one only once that uncertainty is resolved — never the
reverse.

**Work in parallel by default, but only with a named mechanism, never a hope.** Doing several
independent pieces of work at once is valuable specifically because it is faster, but "faster" is
only true if the independent pieces really are independent — two efforts that quietly depend on each
other, run concurrently anyway, produce a race rather than a speedup. Parallel work is safe exactly
to the extent that a specific mechanism (a lock, a claim, a sequencing rule) actually enforces the
independence being assumed; running things in parallel because no conflict has _happened yet_ is not
the same guarantee, and tends to fail exactly when the workload is busiest.

**Never reproduce a person's words verbatim in an instruction file; state the rule instead.** A rule
is durable and portable; a quotation is neither. State the rule in your own words, along with the
reason it exists, so it survives the removal of the specific conversation that first produced it and
reads correctly to someone who was never part of that conversation at all.

## What this costs

Maintaining three tiers instead of one is real overhead: a new rule has to be classified before it
can be written down at all, and a genuinely ambiguous case — a rule that is _almost_ general but
carries one project-specific wrinkle — takes real judgment to place correctly. The alternative, one
flat file per project, is cheaper to start and more expensive to live with: every project re-teaches
the same lessons in its own words, a rule fixed in one place has to be remembered and separately
fixed everywhere else it was copied, and the file every session has to read before doing anything
else grows without bound. The tiered structure trades a small amount of upfront classification
effort for keeping every layer small, current, and inherited automatically by whatever sits beneath
it.

See also: `hooks.md` (the deterministic gates this page's discipline defers detail to), `wiki.md`,
`plan-lanes.md`, `land-spine.md`.
