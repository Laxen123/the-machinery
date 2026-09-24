# Plan lanes

When several agents work the same backlog at once, "what is the state of this work item" has to be
answerable by every agent, every human, and every scheduler tool without a round trip to whoever
last touched it. A separate status database — a table of item IDs and states, updated alongside the
work itself — solves that only until the two disagree: a crash, a race, or a forgotten update leaves
the tracker claiming one thing while the filesystem says another, and every reader downstream
inherits the lie. The failure this design prevents is exactly that: two agents both believing an
item is theirs to start, or a scheduler offering an item nobody has actually finished gating,
because the record of "where is it" drifted from the thing itself.

The fix is to make the location **be** the state. A unit of work is a plain text file with a small
metadata header (frontmatter), and it lives in exactly one **lane** — one directory — at a time.
Reading the tree IS reading the board; there is no cache to go stale and no second copy to
reconcile. Every tool that needs to know an item's state — a lint, a scheduler, a human skimming the
backlog — lists a directory or greps a frontmatter key, never queries a service.

## The lane set

| Lane                     | Meaning                                                                                                                                                                                                                                                                                 | Who may pick it up                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **resting** (unapproved) | Default landing spot for a freshly authored item. Not yet reviewed for framing, scope, or cost.                                                                                                                                                                                         | Nobody, by default — see below.                               |
| **ready**                | Released: reviewed enough to hand to any worker, including an unattended one. Nobody is currently working it.                                                                                                                                                                           | Any agent or scheduler.                                       |
| **in-progress**          | A worker holds the claim lock (see `claims.md`) and is actively executing, or is paused mid-execution.                                                                                                                                                                                  | Nobody else — it is held.                                     |
| **waiting-blocked**      | Blocked on a _named_ upstream item landing first.                                                                                                                                                                                                                                       | Whoever clears the blocker, or a promotion job once it lands. |
| **waiting-operator**     | Blocked on a human decision or a manual action only a human can take. Cost alone is never a reason to sit here.                                                                                                                                                                         | The human who owns the decision.                              |
| **waiting-date**         | Blocked on a calendar trip — including a recurring item whose entire job is to fire on a cadence and never leave this state.                                                                                                                                                            | Whoever picks it up once the date arrives.                    |
| **waiting-condition**    | Blocked on an external condition that **may never occur**. This is the one lane where "nothing ever happens" is an acceptable, planned-for outcome.                                                                                                                                     | Whoever picks it up if the condition fires.                   |
| **archive**              | Shipped or closed. Terminal.                                                                                                                                                                                                                                                            | Nobody — it is done.                                          |
| **parked** _(optional)_  | A deliberate long-term freeze: alive and resurrectable, but explicitly not being worked and excluded from every scan (no scheduler sees it, no lint enforces its shape). Distinct from `archive` (not terminal) and from `waiting-*` (nothing is actively watching for it to un-block). | Nobody, until an explicit un-park move.                       |

An item moves between lanes only through a small set of sanctioned moves — promote, claim, block,
unblock, park, archive — each of which is a single atomic operation that repaths the file (typically
a version-control move) and updates its header in the same step. There is no "set status to X" write
that leaves the file sitting in the wrong directory; state and location change together or not at
all. A lint sweeps the whole tree on every push and refuses a file whose header contradicts the
folder it sits in (for example, a "reviewed" stamp on a file still resting in the unapproved lane).

## Why a fresh item rests, rather than going straight to ready

An item minted under time pressure — typically written mid-execution of some other task, by whatever
agent happened to notice the gap — carries **framing debt** by default: the wrong file named, the
wrong scope drawn, a dependency nobody checked. That debt is cheap to catch with one review pass
before any worker touches the item, and expensive to discover after an unattended worker has already
spent a session executing the wrong thing.

So a fresh mint rests, unreviewed, with no pressure on the minting agent to route it anywhere
same-session. There is exactly one **normal exit**: a review pass (below) reads the item, verifies
its claims against the current state of the repository, and either stamps it reviewed and routes it
out, or sends it back with what is wrong. The minting agent may still short-circuit this — pick the
item up immediately, or promote it directly if it is already fully specified — but that is an
explicit override, never the default path. Because nothing forces same-session routing, an item can
rest safely for arbitrarily long with zero cost to anyone; the review pass, not a deadline, is what
moves it.

## Frontmatter keys that matter

A handful of header keys are what a _machine_ — a scheduler, a lint, an unattended worker pool —
actually reads to make a routing decision. Free-form prose in the body is for humans; these are for
tools:

- **priority** — a coarse tier a scheduler drains in order, highest tier first, first-in-first-out
  within a tier. Nothing preempts a job already running.
- **executor-model lane stamp** — which tier of agent is expected to execute this item (a cheap
  default worker, or a heavier reasoning model that orchestrates its own sub-dispatches). Set once,
  at review time, so an unattended dispatcher never has to guess which capability class an item
  needs.
- **stage / review stamp** — has this item passed the review pass yet ("stub" vs "reviewed"), and a
  hash pinning which body sha the last review actually looked at, so a body edit made after the
  stamp is visibly unreviewed again.
- **cloud-eligibility** — can this item run inside a fully unattended, sandboxed worker with no
  human present, or does it need an interactive session (a decision only a person can make
  mid-execution, a credential only a live session holds, and so on).
- **blocked-by** — mandatory in every `waiting-*` lane, naming the plan id, operator decision, date,
  or condition that gates the item. A live blocked-by line is only legal inside a `waiting-*` lane;
  a write-time gate refuses to leave one standing on an item filed anywhere a scheduler would
  otherwise treat as immediately takeable, and refuses to leave a stale one (the blocker already
  cleared) standing at all.

## The two mandatory banners

Every item carries two short, single-line banners near the top of the body, because these are the
two facts an unattended scheduler must extract without reading a word of prose:

1. **A mutation banner** — does this item write to the shared, authoritative dataset that many
   workers read and write concurrently? This is the single bit that decides how aggressively the
   landing mechanism has to serialize this item's merge against others (see `landing-queue.md`) — a
   "yes" item can silently clobber another in-flight item's writes to the same data if two such
   items are ever allowed to merge unserialized.
2. **A cost-forecast banner** — the expected spend to execute this item, kept on two separate axes:
   real money leaving an account (paid APIs, external services) versus computation billed against a
   subscription. Only the real-money axis gates anything; the computation axis is informational. An
   unattended drain reads this banner and makes exactly one of three moves: proceed silently (zero
   real-money cost, or a code-change item under a standing per-item ceiling), pause for an explicit
   human go-ahead (a bulk data-pass with any nonzero real-money cost always asks, regardless of the
   figure — spending real money on a mechanical re-run is a decision a machine does not get to make
   for a human), or — if the banner is missing, unparseable, or half-written — pause on the very
   first such item and stall the entire unattended run.

Both banners are enforced by a lint that blocks any push touching the ready lane if a tracked item
there carries a missing or malformed banner. The point is narrow and mechanical: "the lint is clean"
should be equivalent to "the scheduler will never stall on this item for an unreadable forecast."

## The two-ledger idea: fog vs. out-of-scope

Not every idea worth tracking is a work item yet. Two very different kinds of "not now" show up on a
live backlog, and conflating them into one list is a mistake in either direction:

- **Fog** — an in-scope question that is too dim to phrase as a precise work item yet. The right
  test is not "is this important" but "can I state the question precisely enough, right now, for
  someone else to act on it later" — if yes, it is a work item (however blocked); if no, it is fog.
  A fog entry is periodically re-tested against a trip condition, and the moment it can be phrased
  precisely, it **graduates into** one or more real items.
- **Out-of-scope** — an idea that was deliberately killed as beyond the current goal. Out-of-scope
  entries **never graduate back** on their own; they return only if the goal itself is redrawn, as a
  fresh entry, never by resurrecting the old one.

These need **opposite** write disciplines on the same conceptual list: fog entries are living and
expected to move; out-of-scope entries are permanent tombstones. A single ledger with one graduation
rule gets one of the two wrong — either a killed idea can silently drift back onto the active
backlog because nothing distinguishes "still open" from "closed for good," or a genuinely open
question sits unexamined because it reads, at a glance, like something already settled. Splitting
them into two labeled sections of one small document — never the backlog of real items itself —
keeps both disciplines legible: one section is swept for graduation candidates on every review pass,
the other is appended to and never re-read as a to-do list.

## The review rituals: spec-pass and board-pass

Two rituals are what actually moves an item out of the resting lane, and they operate at different
scope:

- **A single-item review pass** is a heavy-reasoning-model challenge applied to one item: verify
  every factual claim the item makes against the _current_ state of the repository (not the state
  when it was written — things ship out from under a resting item constantly), confirm the work is
  not already done, check for overlapping or dependent items in flight, check internal consistency
  (no contradictions, acceptance criteria that are actually falsifiable), and sanity-check both
  mandatory banners against what the item's own steps would actually do. The output is a
  **verdict**, not polished prose — most resting items were minted mid-execution of something else,
  so the default assumption going in is that the framing, not the detail, is what is wrong. A
  passing verdict stamps the item reviewed and routes it out of the resting lane in the same pass —
  to ready, or to the matching waiting lane if it turns out to be genuinely blocked.
- **A board-wide review pass** runs on a cadence over the _entire_ backlog rather than one item, and
  is deliberately two-phase: a sweep phase reads everything and produces a ranked, durable proposal
  (which stubs are ready to graduate, which items should fold together, which should close); an
  execute phase runs only on a human's per-item go-ahead, reusing the sweep's own analysis rather
  than re-deriving it. The human turn between the two phases is the only gate — there is no
  additional approval layered on top of it.

Both rituals write through the same stamping authority, so a board-wide pass re-verdicting one item
mid-sweep and a standalone single-item pass never disagree about what a "reviewed" stamp means.

## What this costs

The lane-as-state design has a real cost: every mutation is a full file move plus a header rewrite,
never a cheap in-place flag flip, and every reader that wants to know "is anything blocked on item
N" has to walk the tree rather than run one indexed query. At a few thousand items this is
negligible; it would not scale to a backlog with millions of entries without an index layer sitting
_beside_ — never replacing — the lanes themselves.

See also: `claims.md` (the lock that gates entry into in-progress), `landing-queue.md` (what
serializes an in-progress item's merge back to trunk), `land-spine.md`, `review.md`,
`rule-tiers.md`, `bake-offs.md`.
