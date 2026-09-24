# Subject-knowledge vault

A codebase and its procedural runbooks can tell a reader what the system does today and how to
operate it, but neither has anywhere to hold _why_ — why a decision went one way rather than
another, what was tried and rejected, what is currently understood about how some external system
behaves, what a defect class looks like the third time it recurs. Left homeless, that knowledge
lives in chat transcripts and in whichever agent happened to learn it last, which means every new
session re-derives it from scratch, re-makes a rejected choice, or ships a fix for a defect class
someone already diagnosed. The vault exists to give that knowledge exactly one durable, discoverable
home, so it compounds across sessions instead of evaporating at the end of each one.

## Ownership boundary: one fact, one home

A project accumulates three different kinds of knowledge, and conflating them is the single biggest
way a vault rots into duplication or goes stale:

- **The committed dataset** holds structured, per-item facts — what is true of this specific record
  right now. It owns data, not narrative.
- **Runbooks** hold procedure — how to run a process, what a command does, what order steps happen
  in. They own steps, not rationale.
- **The vault** holds subject synthesis — what is currently understood about a durable subject _and
  why_: how something behaves, what decision was made and the reasoning behind it, what was tried
  and rejected, the standing verdict on a recurring question.

The rule that keeps these from drifting into each other is that a fact has exactly one prose home.
The other two stores may _link_ to it; they never restate or copy it. A page that starts quoting
per-item data, or that turns into a numbered how-to, has wandered out of its lane — move that
content to the store that owns it and leave a one-line pointer behind. This is the same discipline
as the write-once-read-many idea behind avoiding a second source of truth anywhere else in a system:
two places that can each claim to be authoritative will eventually disagree, and whichever one a
reader happens to open first is indistinguishable from the truth until it turns out not to be.

## Push pages and pull pages

Not every vault page costs the same thing to have around. Some pages are **pushed**: a loader
mechanism watches for their subject being mentioned — in a prompt, in an assistant's own reply, or
by a touched file path — and injects the page into the working context automatically, with no one
having to remember to go look it up. The rest are **pulled**: a reader opens them on demand, by
following a link or searching a catalog, and nothing forces them into context otherwise.

That distinction is not cosmetic; it dictates how a page has to be written. A pushed page is paid
for by every session that so much as mentions its subject, whether or not that session needs the
page's full depth, so it has to open with the load-bearing facts and keep them short: what the
subject currently is, what to watch out for, where to go for more. A pulled page has no such
pressure — a reader who opened it deliberately wants the depth — so it can run long, carry full
history, and read more like a reference article than a briefing.

## Budgets: auto-injection is not free

Attention is a scarce resource for a model working a large context, and past a few thousand tokens,
adding more text to something that gets pushed into every relevant session actually _reduces_ the
odds any single fact in it gets used — dilution, not addition. A pushed page has to be sized
deliberately rather than left to grow by accretion, with a real ceiling enforced mechanically rather
than left to good intentions: a page that keeps growing past its budget is worth more as two pages,
or as one short page plus a pulled companion holding the depth.

Push cost is also counted **per context that would see the page**, not once per human session. A
delegated worker started from a parent session inherits that parent's identity for some purposes but
not others, and if a loader keyed injection only off the parent's session state, the first context
to mention a subject would silently eat the page's cost on behalf of every sibling worker that never
got to see it. The fix is to key injection at the level of the context that actually receives it —
each worker gets its own chance to load the page it needs, and the same page never injects twice
into one context that already has it.

## The fold marker: keeping the pushed part small

A page does not have to choose between being short (cheap to push) and being complete (useful once
opened). A single marker line splits the page body into two zones: everything above it is the
**head** — what gets pushed, budgeted tightly — and everything below it is the **tail** —
pull-on-demand depth that a reader reaches by opening the page directly, budgeted loosely or not at
all. A page with no marker is entirely head, which is exactly why a page that keeps growing without
ever getting a marker is the failure mode to watch for: it is quietly increasing what every
mentioning session pays, one paragraph at a time.

Write-backs should **fold into** the existing head rather than append to it. A finding that
supersedes an old claim replaces that claim's text in place; it does not sit next to it as a newer,
contradictory paragraph while the reader is left to guess which one is current. A page whose "last
updated" note has turned into a running list of past changes is the visible symptom of folding not
happening — the fix is to compress that note to the latest fact and point at the project's own
change log for history, not to let the list keep growing.

## Loaders: a page appearing unprompted is the mechanism working

The push side is implemented by a family of lightweight hooks — call them loaders — that watch three
different signals: the human's own prompt naming a subject, the assistant's own reply naming a
subject the human never did, and a tool touching a file path that a page has declared as its own.
Any one of those firing injects the matching page into context, once per context, with a
compaction-aware reset so a long session that gets summarized doesn't end up holding neither the
compacted knowledge nor a fresh chance to reload it.

The practical consequence, worth stating plainly because it looks surprising the first time: **a
subject page appearing in context without anyone having asked for it is the loaders doing their job,
not a bug.** A session that is confused by an unprompted page appearing should look for what it just
said or touched that named the subject, not assume something misfired.

## Write-back: fold in what you learned, same session

When a session learns something durable about a subject the vault owns, that finding is folded into
the subject's page **in the same session it was learned**, not deferred to a later cleanup pass that
may never happen. Folding means correcting the existing claim in place rather than appending a
contradictory note beside it, bumping the page's own "updated" marker, and appending one line to the
vault's chronological log so a reader scanning recent history sees that the page changed and roughly
why. Skipping this step is how the vault decays into a snapshot of whatever was true when the page
was first written, rather than staying an accurate account of what is true now.

## Retire-back: the harder, mirrored half

Write-back adds what a session learned. **Retire-back** is its mirror and, in practice, the harder
discipline to keep: a change that makes an existing vault claim false has to prune every page
carrying that claim, in the same motion that made it false. The two are symmetric for a reason — a
vault claim that no longer holds is not a harmless leftover. Because pushed pages are auto-injected,
a stale claim left standing does not sit quietly waiting to be noticed; it gets re-taught to every
future session that mentions the subject, as if it were still true, until a human happens to catch
the contradiction in conversation and by then it may have already influenced several sessions' worth
of decisions. Retiring a claim the moment it goes false is cheaper than living with that repeated
re-teaching, and cheaper still than the eventual cleanup once several pages disagree with each other
about what happened.

Two bounds keep retire-back from over-correcting:

- **Judge each page in its own subsystem's vocabulary, never by a global find-and-replace.** A term
  that stopped being accurate in the specific mechanism that just changed can still be the right
  word somewhere else entirely — a global sweep that renames or deletes every occurrence of a phrase
  treats two unrelated subsystems as if they shared a vocabulary just because they share a word.
- **Keep genuinely historical statements as dated history, not as live claims.** Retire-back prunes
  claims that teach a model of the world that no longer holds; it does not erase the record that a
  model, a decision, or an approach _once existed and was later superseded_. "We used to do X, until
  Y" is a fine, permanent sentence. "We do X" is not, once it stopped being true.

## Commit discipline: straight to the trunk, never a side branch

Vault pages land directly on the project's trunk through one dedicated tool, never as part of a
work-item's own branch. This matters because the pages that get pushed the most — the hot,
high-traffic ones — are exactly the pages many concurrent sessions are likely to be editing at once.
A branch that carries a vault-page edit alongside its own unrelated work conflicts with every other
branch touching the same page the moment either one tries to reach the trunk, turning an ordinary
knowledge update into a merge fight over content that has nothing to do with the actual change under
review. Routing every vault write through one small, dedicated tool means concurrent edits to the
same page resolve as ordinary sequential writes to a shared resource, the way a claim or any other
shared coordination state does, rather than as a branch-merge collision that stalls someone else's
unrelated work.

## What this costs

A vault is not free to run. It needs a loader mechanism maintained and budgeted, it needs sessions
to actually perform write-back and retire-back rather than skip them under time pressure, and a page
that grows past its head budget without anyone splitting it degrades the attention of every session
that mentions its subject rather than failing loudly. The payoff is that a subject's current
understanding, and the reasoning behind it, survive past the session that produced them — but only
as long as the two disciplines above are actually kept up, session after session. A vault that is
written to but never retired-from is worse than no vault: it actively teaches a stale model of the
world with the authority of an automatically-injected page.

See also: `rule-tiers.md` (the layered instruction files the vault sits beside, not inside),
`bake-offs.md` (comparison verdicts are exactly the kind of durable rationale the vault owns),
`hooks.md`, `subagents.md`.
