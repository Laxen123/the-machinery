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

**The concrete folder names.** The shipped tools spell the lanes as directories under the plans root:
`pending-approval/` (resting), `ready/`, `in-progress/`, `waiting-blocked/`, `waiting-operator/`,
`waiting-date/`, `waiting-trip/` (the waiting-condition lane — see § waiting-trip),
`waiting-grill/` (a question only a human can answer, whose answer is _content_ the item needs
before it can be fully specified — see § Grill at spec time), `archive/`, and `parked/`. The plans
root itself holds no items, only the lane folders. `ready/` means exactly "nobody is on this"; an
`in-progress/` item is normally backed by a live claim, but an unattended session may also hold one
claim-less, identified by a marker line in its body naming the branch it is building.

**Optional category subfolders.** A lane may hold ONE optional level of lowercase category
subfolders (`<lane>/[<category>/]<item>.md`), purely so related items clump when a human browses the
tree. The lane is always the first path segment and the only one that carries meaning: every gate,
stamp, board row and drain decision keys on it alone, and a category folder carries no semantics
whatsoever. Categories are never auto-assigned (a fresh mint lands flat; grouping happens only on an
explicit move to `<lane>/<category>`), two levels of nesting is a lint error, and `archive/` stays
flat, because the land always archives to `archive/<basename>` and a category there would diverge
from where the next land puts its file. Board and index references carry the real relative path, so
a link resolves in any editor. Every enumerator — the index builder, the drain oracle, the board
lint, the stamp reader — walks the tree through ONE shared walker. Never hand-roll a non-recursive
directory scan of a lane: an item in a subfolder then silently vanishes from that one surface with
no error anywhere, which on a coordination surface is worse than a crash.

**Recurring items re-file instead of archiving.** An item whose whole deliverable is running on a
cadence declares `heartbeat: <days>` in its frontmatter. On land, the landing spine re-files it to
`waiting-date/`, bumps the date on its blocked-by line by that many days, and stamps a last-run
status line, instead of archiving it. Without the key a recurring item archives and is then re-filed
by hand, and the archive-consistency lint fires on every push in between.

## waiting-trip

`waiting-trip/` is the concrete folder for the waiting-condition lane, and it is the only lane
whose contract is _may never fire_. Every other waiting lane has a tracked release valve — a named
upstream item lands, a human answers a marker, a date arrives — and without one of its own this lane
becomes a magnet for quiet deferral: work nobody re-evaluates, sitting behind conditions nobody
tests. Keep it honest:

- **Use it ONLY when doing nothing is the correct default** — the work becomes worth doing _only
  if_ an external condition recurs, and the user-facing surface is already protected (or the issue
  may genuinely never happen). Good fits: a bug class that may not recur behind an existing guard;
  an arm only worth building once enough cases accumulate.
- **Work that is definitely needed, with only its timing deferred, does NOT go here.** File it by
  what actually gates it: `waiting-blocked/` (a named upstream item), `waiting-operator/` (a human
  action or decision), `waiting-date/` (a calendar trip), or `ready/`.
- **Tells that you are mis-filing into this lane:** the body says the work "is needed eventually";
  the condition is a soft "re-evaluate in a few months"; or the real gate is a sibling item landing
  or a human go-ahead. Watch for **circular** preconditions too — a trip condition that waits for an
  output the item itself produces is never satisfiable by waiting.
- **Every item here states, in one line, why never firing is an acceptable outcome.** If you cannot
  write that line, it is not a trip item — re-file it.

**The `tripCheck:` marker** is the lane's release valve. Every item carries one single-line
frontmatter scalar, in one of two forms:

- `tripCheck: manual — <who would observe it, and where>` — a human-observed trip (a sighting in
  production, a user report, a decision only a person can make). Never executed; reported as
  `manual`.
- `tripCheck: '<shell command>'` — a command-form probe. **Exit 0 means TRIPPED, exit 1 quiet,
  exit 2 or higher a probe error, and running out of time a probe timeout** (chosen so a plain
  `grep -q <pattern>` already exits 0 on a match). The command must be read-only, local, fast, and
  rooted in the repository — never a path under an ignored scratch directory (it is not committed)
  and never a network call (a reachability check is a manual trip, not a command one). Quote it as a
  single-quoted YAML scalar (double any literal `'`); the reader deliberately never comment-strips
  this key, so a literal `#` inside the command survives.

A command-form item whose probe is structurally slow may stamp its own budget,
`tripCheckTimeoutMs: <ms>`, beside the marker. It defaults to 90 seconds when absent, is clamped to
between 1 second and 10 minutes (with a warning, rather than taken literally), and a malformed value
falls back to the default instead of crashing the whole table. Raising one item's budget carries no
risk to the rest of the lane, because probes also share one **total-run budget** (default 15
minutes): a row whose turn comes after the budget is spent never runs and reads `budget-exhausted`,
and a row that does start gets the smaller of its own budget and what is left.

`node scripts/trip-status.mjs [--timeout-ms <n>] [--total-budget-ms <n>]` walks the lane (category
subfolders included), runs every command-form probe with its hard timeout, captures the exit code
only, and prints one row per item: TRIPPED, quiet, manual, probe-error, probe-timeout, no-marker,
budget-exhausted, or moved (a sibling re-filed the item mid-run; re-running settles it). It exits
non-zero when at least one item TRIPPED, so a board-wide review pass runs it and treats a tripped
row as a promotion candidate instead of eyeballing the whole lane. **Probe-error and probe-timeout
are different readings and must not be conflated:** an error is a genuine fault in that item's own
command and wants fixing; a timeout means the command needed more time than it was given — raise
that item's `tripCheckTimeoutMs`, or re-probe on the spot with `--timeout-ms`. A `no-marker` row is
an item missing its stamp: add one.

## Plan naming

An item's basename is `NNNN-<Category>-<slug>.md`, with an optional executor-lane display segment
between the id and the category for the non-default lanes (see § Executor lanes and model
allocation). The name matters because it is load-bearing far beyond display: once an item is
claimed, its branch, landing-queue slug, claim record and worktree directory all key on the
basename.

- **The category is a closed taxonomy, enforced at mint.** The project lists its categories in
  `coord.config.json` (`planCategories.allowlist`); the mint tool hard-fails an unknown category and
  prints the valid set. An empty allowlist means "no category gate". The gate is forward-only for
  claimed items: an existing basename off the allowlist stays valid for every move, edit and land
  tool, and an `in-progress/` item is never renamed.
- **Unclaimed items may be renamed to conformance at sweep time**, because nothing downstream keys
  on their name yet. The rename path is one tool call:
  `node scripts/move-plan.mjs <id> [<lane>] --rename <new-basename>`. With no lane it is a pure
  rename (the body carried over byte-identical);
  with one it renames and re-files in the same commit, and either way the file move and the index
  resync ride ONE pushed commit with no guard override and no hand git. It refuses — before any move,
  and `--force` waives none of these — a held claim (including your own), a source or destination of
  `in-progress/`, `archive/` or `parked/`, a basename collision, and a name that breaks the grammar.
  Never rename by hand with a guard override: that is the failure the tool exists to end.
- **Hard versus soft.** The rename gate REFUSES on the `.md` extension, a path separator, the
  `<id>-[<LANE>-]<Category>-<slug>.md` shape, an id that no longer matches the item being renamed, a
  category outside the taxonomy, and the shared slug charset (deliberately permissive, since slugs
  legitimately carry camelCase code identifiers). It only WARNS on conventions no string check can
  judge — for example, whether an item is single-scope. A project that wants a scope token (a region
  code, a subsystem stage) as the first slug token configures it under `planNaming` in
  `coord.config.json`; the gate then warns on a token that is the wrong SPELLING of a known one,
  naming the code to use, and the review checklists enforce the convention itself. A convention
  that is widely unenforced in the live corpus stays soft: a hard gate on it would refuse renames
  that fix something else while tripping over an orthogonal rule.

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
- **loop** — `hitl` or `afk`: does resolving the questions that remain mid-run need a human live? A
  separate axis from both the executor lane and the waiting lanes (an `afk` item can still be
  approval-parked; a `hitl` item can be fully unblocked). It is forward-only (absent means
  "unstamped", not `afk`) and it is **a note to humans, not a guard**: the drain oracle does not read
  it, so never rely on it to keep an item out of an unattended run. An item that needs a human live
  belongs in a waiting lane, or must say so in its body where the oracle's prose gate can see it.

## Executor lanes and model allocation

Who executes an item is decided once, at review time, and stamped — never re-derived by whichever
session happens to pick the item up. The stamp names a **lane**, not a model pin:

- **The cheap default lane** — a dispatched, mechanical worker executes the item. Right when every
  hard call can be made once, up front.
- **The heavy-judgment lane** — a heavy reasoning session executes the item as a _thin orchestrator_
  over cheap workers: it makes the decisions and dispatches the bulk work, instead of doing the bulk
  work in its own context. Right when judgment recurs step by step through execution.
- **The alternate-vendor lane** — a different vendor's model writes the code while a heavy session
  orchestrates, so the bulk spend lands on a different subscription. The same thin-orchestrator
  shape applies, with that vendor's CLI dispatches standing in for cheap workers.

The shipped tools spell these `execModel: sonnet | fable | sol`, and an absent key reads as the
cheap lane (the grandfather clause for items that predate the stamp). The heavy label names the LANE
— interleaved judgment, not drainable by a cheap worker — never a specific model: the lane's
default executor is the strongest model that is cost-effective for it, and escalating to a pricier
tier is a per-item exception the review must EARN by writing down why the default heavy model will
not do. No written justification means no escalation. Spend the scarce top tier first on the
judgment surfaces a human reads live (review passes, grilling sittings), never on unattended
execution, where a silently worse call surfaces only at review, if then.

**The default lane is data, never prose.** Which lane a front-loadable item defaults to lives in
`scripts/exec-model-default.json`, read with `node scripts/exec-model-default.mjs` and flipped with
`node scripts/exec-model-default.mjs set <lane> --reason "<the human's instruction>"`. A flip is a
config-only, review-exempt edit. No doc, skill or prompt restates the current value — they all point
at the toggle — so a flip needs no prose sweep and cannot leave a stale copy behind. The one
script-enforced default (the backfill for a no-judgment item, below) reads the same toggle, so a
flip moves both together. A flip never touches an item that is already stamped.

**The three-case allocation rule** — the review sorts every item into exactly one:

| Judgment shape                                   | Route                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Front-loadable (every hard call can be made now) | Stamp reviewed, with whatever lane the toggle names (the alternate-vendor lane only when the item is eligible for it). Who executes follows the STAMP.                               |
| Interleaved (judgment recurs through execution)  | The heavy lane (or the alternate-vendor lane when eligible), run under the thin-orchestrator doctrine; a small item runs inline.                                                     |
| Mechanical (no judgment at all)                  | Self-stamp `specReview: exempt-mechanical` — no review pass needed. Every writer into `ready/` then backfills the toggle's lane and adds or omits the basename lane marker to match. |

A **hard gate** overrides the table: the coordination mutex and write-spine scripts are never
executed on the cheap lane, whatever the toggle and the shape say.

**The review's exit test.** A review does not only challenge the framing — it must leave the item
_drainable_. Before stamping the cheap lane, answer: **could a cheap worker execute this without a
judgment call on a correctness-critical surface?**

- **No, but the calls can be made now** → make them in the item body, as an
  `## Execution notes for the drain` section pinning (a) _placement_ — where in the existing flow
  each change goes (the usual failure is correct code in the wrong spot, for example outside a
  retrying critical section); (b) the known _failure modes_ that placement avoids; (c) a
  _do-not-touch_ list scoping the blast radius; (d) a _test-harness pointer_ — which existing test
  file is the pattern.
- **No, and the calls genuinely cannot be front-loaded** (data-dependent adjudication, taste, design
  that emerges from what execution uncovers) → the heavy lane. That is what the label is FOR: an
  earned classification, not a worry-driven default.
- **Yes** → stamp and promote; do not gold-plate.

Four further questions ride the same pass:

- **Shape, not judgment.** A cheap-lane item is executed by a dispatched worker, and a dispatched
  worker backgrounds nothing while each foreground call is capped. So an item whose work is ONE
  long-running process — a multi-hour crawl, a detached tool polled across turns — cannot be
  cheap-lane even with every call pinned: the worker would run it as capped slices, losing in-flight
  work at every kill and silently starving any unit that needs longer than a slice. It needs a
  top-level session, i.e. the heavy lane, on shape alone; say so in the cost banner so the lane is
  not read as a judgment claim. This question only ever moves an item OUT of the dispatched-worker
  lane.
- **Evidence reach.** If step 1 is a premise check, name the committed path it reads and confirm
  that path is on trunk before stamping the item runnable unattended. Evidence that lives only on
  another session's unlanded branch makes the item blocked on that branch's land, not drainable.
- **The carrier.** When an item moves a decision out of deterministic code and into a judging step,
  verify — against the wire schema, the merge logic and the phase order, not by assertion — which
  step receives the undecided value and in which pass it is decided. An item that cannot answer is
  not ready to move the decision.
- **Inherited premises.** An item that is one child of a larger program assumes whatever the
  program assumed, and those premises are never among its own cited claims, so a premise check
  never looks at them. The child carries an `## Inherited premises` section — one line per
  mechanism, each naming where it can be verified — copied from the parent's proven-mechanisms list
  at mint time, and the review verifies it like any other claim. The index lint enforces the section
  for a `program:` child in `ready/`.

**Shapes that up-tier regardless of how mechanical they read**, because their failure mode is a
silently wrong conclusion rather than a broken diff: (1) **world-claim items**, whose deliverable is
a claim about external reality — every named source can agree and the conclusion still be wrong, so
phrase the question as "establish who or what operates here", never as a yes/no on the named thing;
(2) **root-cause diagnosis** ("find out why X is broken"); (3) **schema or axis design**. These are
the judgment failures humans catch and gates do not, so they are where heavy-lane spend pays.

**Enforcement points** — skills carry the procedure, but skills can be rationalized around, so these
make the stamps load-bearing:

1. **Mint stamp** — every fresh mint is written `stage: stub`.
2. **Promotion gate** — `move-plan <id> ready` refuses a stub with no `specReview`, naming the fix.
   Every writer into `ready/` — the interactive mover, a mint straight to `ready/`, and the land's
   auto-promotion of a newly unblocked item — runs the same check and the same two banner gates, so
   no path into `ready/` is looser than the interactive one. An unspecced unblocked item routes back
   to `pending-approval/`; a specced one failing a banner gate routes to `waiting-operator/`.
3. **Drain filter** — the drain oracle reads the lane from the **frontmatter field**, never the
   filename. A cheap-lane drain skips heavy-lane items; the alternate-vendor lane is admitted by
   any drain lane (an orchestrating drain session is already heavy-class), except in an environment
   with no route to that vendor's API, which refuses it permanently.
4. **Drift lint** — the basename's lane marker must agree with the frontmatter stamp. The marker is
   display-only (a file tree doubles as a board); the frontmatter is truth. Never rename by hand: the
   stamp tool and the mint, edit and move tools recompute the marked basename and rename in the same
   commit whenever their own write flips the stamp.
5. **Claim gate** — claiming refuses a stub with no `specReview`, closing the self-pickup bypass the
   promotion gate cannot see (an item claimed straight out of its own mint window never passes
   through `ready/`). The override is `--stub-ok "<authorization note>"`, recorded in the claim.

**One commit for the whole verdict.** The stamp tool,
`node scripts/stamp-exec-model.mjs <id> <lane> --spec-review <sha|exempt-mechanical>`, with an
optional `--provenance "<model>/<effort>"`, stamps the verdict; it also takes the
cloud axis (`--cloud-exec true|false [--env <rung>] [--reason "…"]`) and the routing move
(`--move ready|<waiting-lane>`), folding all of it into ONE commit instead of three. `--provenance`
self-declares which model and effort produced the verdict; omitting it stamps `undeclared`. The
single-axis tools remain the fallback for anything the combined form does not carry. No code path
clears a stamp as a side effect — every stamp tool merges one key and never touches its siblings —
so a derailed or red item keeps its review provenance. The one way to lose it is a full-body
replace that omits the stamp keys; prefer a find-and-replace edit whenever you are not genuinely
rewriting the whole file.

**Staleness is a judgment call, not code.** A `specReview` sha pins what the review saw. If more
than about two weeks have passed since that sha's commit date when someone picks the item up, treat
it as a stub again and re-review. A raw commit-count trigger does not work in a busy shared
repository: coordination commits alone move trunk by dozens a day, so a count trips on volume that
has nothing to do with the item's own drift.

**The alternate-vendor lane's own rules.** It never batches (batch eligibility requires the cheap
lane, and there is no batch conductor for an orchestrated-vendor session). Its code is reviewed by
the normal review lane — cross-vendor diversity is not a routing requirement. And its rework rule
switches on a **repeated finding, not a round count**: keep the vendor's model while each round's
finding set shrinks or changes, and switch to the default lane only when the SAME finding (same
file, same location, same defect class) comes back unfixed after two consecutive rounds — a model
switch helps against a model's blind spot, not against a genuinely hard fix. Record the switch in
the item body and hand the switched-to worker the earlier rounds' findings so it does not start
cold.

Rationale for the whole scheme: heavy-model spend at review time is one-time and buys parallel
unattended execution; heavy-model spend at execution time is several times larger per item and
serializes on one session. The lane choice is not the safety net — the gate ladder (mandatory
review, pre-push gates, land gates) is.

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
The lint is scoped to `ready/` (the queue the drain consumes) and to tracked files only, so an
untracked or foreign item never gates an unrelated push; an item promoted from a waiting lane is
checked when it enters `ready/`. The same check also runs at promotion time in every writer into
`ready/`, through ONE shared predicate, so a mover and the lint can never disagree about what
"parseable" means.

A few mechanical details decide whether the banners actually parse:

- **One line, fixed grammar.** The cost banner names both axes on one line —
  `> 💰 **Cost forecast:** Cash $0 · Claude ~$12 — <what the spend is for>` — because the parser
  reads to end of line. A missing, prose-only, "to be decided" or half-written banner (one axis label
  present, or a label with no figure) parses as _unknown_. A legacy single-figure banner stays valid
  and is read as the real-money axis.
- **A missing mutation banner reads as "yes".** The drain oracle treats an absent or unreadable
  mutation banner as the conservative answer for both sorting and serialization.
- **The ceiling, and when a real-money question is worth asking.** The standing per-item ceiling is
  project config (`operatorSpendCeilingUsd` in `coord.config.json`). Inside an approved item, a
  session spends real money up to that ceiling without asking — under it, a figure is a fact in the
  banner, not a question for a human. A **data-pass item** (a bulk re-run of an existing process over
  many records, with no code change behind it) always asks before it spends, whatever its forecast;
  a **code-change item** gets the full ceiling, including the re-run it needs to prove its own fix.
  The durable form of that line is a `spendClass: code-change | data-pass` frontmatter key stamped at
  review time; when present it always wins, and a path-based heuristic over the item's task list is
  only the fallback for an item that never stamped it.
- **Park and continue, never halt.** When the drain meets an item its cost gate will not run, it
  moves that item to `waiting-operator/` with a blocked-by line naming the cost pause and keeps
  draining; the item is named in the run's closing skip list. A cost gate that ENDS the run on the
  first expensive item turns one unreadable banner into a whole idle window.
- **Cost is never a blocker on its own.** Because the drain pauses before spending, a cost-gated
  item is safe in `ready/`. There is deliberately no "cost" value for a waiting-lane unblock marker —
  a move to `waiting-operator/` citing cost alone auto-routes to `ready/` — and a blocked-by line
  names items and decisions only, never a spend clause.

## The evidence floor

A review process is extremely good at surfacing latent "could go wrong" concerns, and if every one
of them becomes its own tracked item, the backlog fills with items nobody can prioritize against
each other: measured on one busy backlog, over half of all new items were minted from review
findings or code reading with no observed wrong output at all, and each one cost a full item cycle
(mint, review, pickup with cold context, its own review, its own land) plus a human's attention.
The review machine, not observed failure, had become the item factory. The evidence floor keys the
vehicle on **how the problem was found**, not on how bad it sounds:

- **Evidence decides the vehicle.** A surfaced issue may be minted as its OWN item only when its
  wrongness was OBSERVED: in the output of a real run of the workload, on a live surface, in a
  measured run over a real corpus, or reported or commissioned by a human. A LATENT finding (review,
  audit, or code reading says it could go wrong; nothing observed wrong) first takes the fix-now
  test (`review.md` § Disposition policy), and on failure becomes ONE LINE in the running debt
  ledger — never its own item. Urgent live wrongness still jumps every queue.
- **The ruler never gets items.** Measurement tooling — census scripts, row validators, report
  plumbing — does not ship to users. A defect in it is fixed inline by the session that needs the
  measurement, or takes a debt line. Items minted by reviews of OTHER ruler fixes are the chain this
  rule kills. A ruler defect that invalidates an already-reported verdict is a human escalation, not
  an item.
- **Promotion is by observation only.** A ledger line becomes an item when a real run implicates
  it, a live surface shows it, or a human asks. Nothing is deleted; a genuine latent bug waits at
  most about one run cycle before it is observed.
- **The class is a stampable value**, because prose does not bind. The key is `evidence:`, one of
  `observed-wave`, `observed-live`, `observed-measured`, `operator` or `latent` (a "wave" being one
  batch run of the real workload). Stamp it with `node scripts/stamp-evidence.mjs <id> <value>`, or at mint time with
  `next-plan-id.mjs claim --evidence <value>`. `move-plan <id> ready` **refuses** an item stamped
  `latent` in any category the project lists under `planCategories.evidenceGated` in
  `coord.config.json`, naming both exits: fold it to a debt-ledger line, or upgrade the class once a
  fresh observation supports it. Coordination and infrastructure categories are normally left
  ungated, because their own, stricter severity floor already governs them. A MISSING key never
  refuses — the stamp is forward-only, with no backfill.
- **Deferrals carry the pointer too.** Dispositioning a review finding to a new item takes
  `record-review.mjs disposition <key> --plan <id> --observed "<pointer to the observation>"`, and
  warns (never blocks) without one. The observation is stored as its own structured field, never
  folded into the item id, which other gates match as a filename prefix.

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

## Grill at spec time

The review's exit test (§ Executor lanes and model allocation) asks whether a worker can execute
without a _technical_ judgment call. Its twin asks whether a session can execute **without asking a
human mid-run** — and for a technical-design or plan-scope fork (split or fold, which lane, which
model, whether to file a follow-up) the answer is always yes. The session picks its recommended
option, writes it into the item body as a `## Session decisions` entry — the option chosen plus a
one-line why, in the session's own decision voice — and proceeds. A human sees a design choice only
when it changes what users see or costs money. `## Session decisions` is inert by construction: no
tool requires it, none blocks on its absence, and it never counts as an open question.

Only a question that genuinely needs one of a fixed set of **human-only axes** may park:

| Axis          | What it covers                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `product`     | What users see — wording, layout, taste, a display default                                     |
| `policy`      | A rule or default for a repeated ambiguity, a taxonomy boundary, a legal or privacy posture    |
| `money`       | Real money above the standing spend ceiling                                                    |
| `access`      | Credentials, accounts, dashboards, a physical action only the human can take                   |
| `data-ruling` | A hand edit of authoritative data that policy reserves for a human, or a sign-off on a dataset |
| `hold`        | A blanket hold the human imposed (operator lane only)                                          |
| `manual`      | An out-of-band action (operator lane only)                                                     |

A question that fits no axis is, by definition, a session decision — never a park. Two shapes are
never a question at all: "land now, or wait for a better moment?" on an already reviewed and gated
item (landing is one self-invoked call — run it), and "may I write this debt-ledger line?" (filing
a sub-floor line is pre-authorized, like a stamp).

**Never ask inline during a sweep** — an unattended ten-item review pass must not block on question
one. Write the question into a `## Grill questions` section in the item body, in exactly one shape:
**a numbered list and nothing else**. Every item opens with `N. ` at column 0 followed immediately by
its own `` `[axis: <tag>]` `` marker, and any context or recommended answer goes INDENTED underneath;
a bullet, a bold line, a sub-heading or bare unindented prose anywhere in the section is refused
outright, never read as a question of its own. Then park the item with
`node scripts/move-plan.mjs <id> waiting-grill`, which refuses:

- a body with no non-empty `## Grill questions` section, or one that is not the numbered-list-only
  shape (naming the offending line);
- an item missing a recognised axis marker OPENING its own text — fail-closed, naming the axis list
  and pointing at `## Session decisions` as the alternative;
- a re-park whose questions section is byte-identical (whitespace aside) to the previous park,
  naming that park's commit;
- an item already carrying the literal token `[RESOLVED]`, `[RULED]` or `[ANSWERED]` immediately
  after its axis tag. The token is a DECLARATION the writer emits in that fixed position, not
  something inferred from prose, so "see ruling R1 below" inside an item never trips it — and never
  satisfies it either.

The return path is a **batched grilling sitting** (the `/grill-lane` skill): it opens by re-routing
any question whose axis looks wrong (to `## Session decisions`, or to the correct axis) before a
human is asked something they did not need to answer, interviews the rest, records the answers as
`## Operator rulings`, folds durable defaults into the owning docs, and routes each item out. A
recorded answer MOVES its question to the rulings section (preferred), or stays behind for the
record marked with the literal token. `move-plan <id> ready` out of the grill lane is refused until
the rulings exist.

**Which lane: route by what the human's reply looks like.** A go/no-go or timing call on an
already-specified action goes to `waiting-operator/`, with an `unblock: decision` marker and a
blocked-by line carrying one axis tag (`unblock: manual` — the human must personally act — admits
only the `manual` and `access` axes). A reply that is _content_ which must be written into the body
before execution can be fully specified, and that fits an axis, goes to `waiting-grill/`. An item
needing both parks in the grill lane first; the approval hold follows once the rulings exist.

Why front-load it: a heavy model's spend at review time is paid once and buys unattended execution;
the same question discovered mid-run stalls a session, or worse, gets role-played on the human's
behalf.

## Park visibility

Unattended executors meet forks they cannot resolve, and the shape of their exit decides whether
anyone ever notices. A three-tier ladder governs them:

1. **Fix in-session, autonomously** — a confirmed correctness finding on the item's own target
   surface, up to the review round cap (`review.md` § Stopping rule); a clean scoped re-review ends
   the loop.
2. **Defer, disposition, keep landing** — an out-of-scope or other-subsystem finding, but only after
   it fails the fix-now test, routed per the severity floor (`review.md` § Disposition policy).
   Filing an item or a debt line is pre-authorized and does not stop the run.
3. **Park to a human — never decide, never file around it** — product judgment, real-money spend,
   policy inversions, anything that needs a human live.

**A tier-3 park must be VISIBLE within the same run.** The failure it prevents: an executor that
parks by writing a hand-off note and stopping, leaving the item claim-held in `in-progress/`, is read
by every later sweep as a stalled session rather than a decided park — the human's eventual answer
arrives a day late and turns out to be the hand-off's own recommendation. So:

- **Filter first.** A technical-design or plan-scope fork is answered on the spot and written to
  `## Session decisions` (§ Grill at spec time), never parked. Only a genuinely human-only question
  still parks.
- **Self-move out of `in-progress/`.** Write the decision into a `## Grill questions` section first
  (numbered list, each item opening with its axis marker, context indented), naming the exact
  decision and the recommended answer, then run `node scripts/move-plan.mjs <id> waiting-grill`. If
  the body genuinely cannot carry a questions section, fall back to
  `move-plan <id> waiting-operator --blocked-by "[axis: <tag>] <the decision>" --unblock decision`
  — never leave the item un-moved.
- **Keep the hand-off section** naming the branch pushed to the remote: that branch is the durable
  pointer for whoever adopts the work.
- **Release the claim** (`node scripts/release-claim.mjs release <id>`). A held claim does not help
  adoption — adoption refuses a claim held by another session at any age — it only forces every
  later body edit through an override and reads as "claimed" to every drain until someone
  force-releases it.

Return paths: the grilling sitting sweeps `waiting-grill/`; the `/unblock-lane` skill walks
`waiting-operator/` (triaging decision-blocked items, which it interviews, from action-blocked ones,
which it reports, and spec-blocked stubs, which it hands to a review pass). A board-wide review pass
reports the grill lane's size and oldest age and nudges a sitting once it holds three or more items
or its oldest is a week old.

## Batch lanes

A **batch** rides 2–5 small, homogeneous, reviewed items through one worktree, one review and one
land, instead of N of each. It exists to kill the fixed per-land tax — the pre-push gates, the
review fan-out, the claim, board and index bookkeeping — that dominates a small item's total cost.
Small coordination-tooling items are exactly the shape it targets.

**A batched review is not heavier in aggregate.** Measured on real review markers, a batch review's
finder fan-out is the same size as ONE solo review's; only the verifier stage scales with the diff.
So one four-member batch review runs roughly half the total review agents of the four solo reviews
it replaces, and it runs before enqueue, off the queue's serialized path — it trades cheap parallel
tokens for scarce serialized land slots. The argument does hold for heavy-judgment items: a union of
design-heavy diffs dilutes finder attention and couples fix passes, so heavy-lane batches stay small
and judgment-dense items prefer solo lands.

**Batching is an execution arrangement, never a body merge.** The items stay separate files in
their own lane folders; only where they execute and when they land are shared. Overlapping or
duplicate items go through a consolidation (which folds bodies into ONE item) — a different
operation.

**Eligibility is script-enforced** by `node scripts/claim-plan.mjs batch <id1> <id2> [...]`: 2–5
ids, every member reviewed and stamped the cheap lane, and homogeneous mutation banners (all "yes" or
all "no"). `--force` bypasses the lane and homogeneity checks only — never the member count, id
resolution, or the reviewed check; a stub member needs `--stub-ok "<authorization note>"` instead,
recorded in the claim.

**Lifecycle:**

1. `claim-plan.mjs batch <ids…> --slug batch-<date>-<theme>` — an all-or-release claim of every
   member, projected as ONE commit: every member moves to `in-progress/`, gets a board row tagged
   with the batch slug, and shares one session entry; a write-once membership manifest lands in the
   batch's own folder under `docs/superpowers/batches/<batch-slug>/`.
2. `cut-worktree.mjs <batch-slug>` — one worktree and one branch for the whole train.
3. A conductor (the `batch-train` skill) runs a fresh worker per member, sequentially, each
   member's commits prefixed `<id>:`.
4. ONE review over the branch's whole diff.
5. `done-worktree.mjs <batch-slug>` — batch-aware purely by manifest presence: one queue slot, one
   review marker, then one close-out commit that archives every member still in `in-progress/`
   (promoting their unblocked dependents), skips any member that was re-parked, releases every
   member's claim, removes every member's board row, and deletes the manifest.

**Derailment.** A member that goes wrong mid-train has its commits dropped, is moved to a waiting
lane, has its claim released and its board row removed. The manifest is never rewritten —
membership is static and live status is read off each member's folder, so a re-parked member's
close-out disposition reads "re-parked, skipped", not "archived".

**Where batch state lives.** No batch database: the write-once manifest (membership), one claim per
member (the live claim), and each item's folder (live status) are the whole model. **Crash-resume**
follows from it: a bare re-invoke of the land is idempotent, because manifest presence IS "batch
still live" (the successful close-out deletes it in the same commit that archives the members), and
a batch-prefixed landing-queue entry is pruned once its manifest no longer exists.

**The proposed-batch roster.** A board-wide review pass writes each proposed batch as a folder under
`docs/superpowers/batches/<slug>/` (a README with slug, lane, members and theme, plus a
`dependencies.md`), and the session that claims a batch deletes its roster entry in the same
session. `node scripts/batches-view.mjs` is a read-only view of the roster — one row per batch
with members, the per-member lane, dependencies, and two flags computed off a LIVE re-scan of the
lane folders rather than the roster's snapshot: a heavy-lane member (the whole row becomes a
heavy-lane batch, which only a heavy conductor may drain), and **drift** (a member no longer in
`ready/` since the row was written — the strongest sign a row is stale). Dependencies use a small
machine-parseable block the parser defines and the writer conforms to:

````text
## Dependencies

```dependencies
<left> <relation> <right> [: <free-text reason>]
```
````

where each side is a batch slug or an item id and the relation is `blocked-by`, `overlaps`, or
`order-after`; an absent section degrades to an empty column, never a crash. **A batch's gate holds
only OBJECTIVE conditions** ("item X lands", "date Y"): a human's approval of a proposed batch clears
the gate in the same pass, and "waiting on a go-ahead" is never parked in the gate field, where
nothing surfaces it.

## What this costs

The lane-as-state design has a real cost: every mutation is a full file move plus a header rewrite,
never a cheap in-place flag flip, and every reader that wants to know "is anything blocked on item
N" has to walk the tree rather than run one indexed query. At a few thousand items this is
negligible; it would not scale to a backlog with millions of entries without an index layer sitting
_beside_ — never replacing — the lanes themselves.

See also: `claims.md` (the lock that gates entry into in-progress), `landing-queue.md` (what
serializes an in-progress item's merge back to trunk), `land-spine.md`, `review.md`,
`rule-tiers.md`, `bake-offs.md`.
