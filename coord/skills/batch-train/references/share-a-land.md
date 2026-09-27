# Share-a-land criterion — fold vs. batch vs. leave separate

**Canonical source for this test.** Referenced (not restated) from: `board-pass` (Phase 1 batch
sweep), `consolidate` (step 1's decision fork), `spec-pass` (batch-mode step 5). Edit this file when
the criterion changes — don't let a fourth copy grow in a fifth skill.

## The question

Two or more open plans overlap somehow — same subsystem, same files, same incident. Before proposing
anything, ask exactly one question: **would these share a land?** The answer routes to one of three
outcomes. Getting this fork wrong is the single most common plan-curation mistake (folding things that
should have batched, or batching true duplicates).

## The three outcomes

1. **Leave separate.** They share a category tag or a vague theme but have disjoint file-surfaces and
   unrelated concerns. Folding or batching only enlarges blast radius for no benefit. **Outside the
   small-🟩-sonnet class** (see § The small-🟩-sonnet class below) this is the default — don't
   manufacture work; proposing nothing is a valid result. **Inside that class the default inverts:**
   batch is the default, and leaving a member solo needs the written reason.

2. **Batch (`batch-train`).** The plans are coupled **mainly by land overlap** — the same mutex class,
   the same handful of shared files, the same subsystem a reviewer would want to see together — but
   **each is still a coherent standalone unit**: its own acceptance criteria, independently sensible
   even if the others didn't exist. This is the common case for coordination-machinery plans. Batching
   is cheap: it keeps per-plan identity (archive granularity, independent re-park/revert) while
   collapsing to one worktree/review/land.

   Eligibility (the `claim-plan.mjs batch` script re-enforces these — treat your own check as a fast
   fail, not the only gate):
   - 2–5 members for ordinary plans. **Sizing doctrine (operator 2026-07-06): batch size scales
     INVERSELY with member weight** — trivial single-shard DQ adjudications with front-loaded
     decision rules (disjoint records, homogeneous 🟥) may ride up to ~8 per train, since every solo
     land pays the same fixed tax (claim + worktree + review + queue slot + merge/gates + teardown)
     and for one-row work the tax dwarfs the work. Heavy/fable/sol members never ride regardless
     (plan 3341: `sol` is a single Opus-orchestrated session by design, no batch conductor for it).
     (`claim-plan.mjs`'s `checkBatchEligibility` ceiling is being raised 5→8 to match — until that
     plan lands the script still rejects >5.)
   - Every member `stage: specced` + `execModel: sonnet` (no residual design judgment owed — a
     mechanical train has no slot for judgment mid-run).
   - No member stamped `loop: hitl` (plan 1668): a hitl plan resolves only through a live operator
     exchange — no slot for that on a mechanical train either. An absent `loop:` key is unconstrained
     (the stamp is forward-only from adoption, no backfill); only an explicit `hitl` excludes. This
     exclusion is prose-enforced at selection (board-pass sweep / batch-train step 1) — the
     `claim-plan.mjs batch` script does not yet check it.
   - Homogeneous seed-write mutex class: all `🟩`, or all `🟥` **with overlapping data shard-sets**
     (disjoint-shard `🟥` plans don't need to serialize and make poor train partners).
   - None operator-urgent, none likely to derail (shaky acceptance criteria → back to `spec-pass`
     first, not onto a train).

3. **Fold (`consolidate`'s body-merge, via `fold-procedure.md`).** The coherence test says these
   **aren't really separate units** — true duplicates describing the same fix, or a work item that was
   mistakenly split into pieces that don't stand alone. Reserve this for the narrow case; it destroys
   per-plan identity (the folded originals leave `ready/` for good), so it should be the less common
   outcome of the two.

   Eligibility:
   - Unclaimed (no held claim ref — check `claim-plan.mjs status <id>`, not a raw `git ls-remote`,
     since a released ref is tombstoned rather than deleted — no `in-progress/`/board row) and not
     archived.
   - Genuinely coupled — shared file-surface or near-duplicate concern, not merely a shared category
     tag (`Infra` spans done-worktree tooling, the price pipeline, CI — different subsystems).
   - Sized to fit one context window: would one person build the combined plan in one worktree and one
     reviewer sign off in one pass? If unsure, lean smaller — several coherent folds beat one catch-all.

## The small-🟩-sonnet class — batch is the default (ruling carried from plan 2459, landed via plan 2516)

> The 2026-07-24 board-pass precedent — "'shares a queue slot' is not a batching reason" — is
> OVERTURNED for the class 2459 Task 1 defines: small 🟩 `execModel: sonnet` `loop: afk` members
> with no file-overlap edges. For that class, **batch is the default and solo needs the reason**.
> Basis: the 2026-07-25 review-cost empirics in `docs/coord/plan-lanes.md` § Batch lanes
> (finder fan-out flat f=9–11 solo vs batch; only verifiers scale) plus the queue-bottleneck
> measurement (~12 min serialized head-time per land). The strict share-a-land test stays in
> force for everything else — 🟥, fable-lane, sol-lane, `loop: hitl`, large or overlapping members.

**Class definition — EVERY member must satisfy ALL of:**

- `🟩` (no seed write), `execModel: sonnet`, and `loop: afk` — an explicit `hitl` excludes; an
  absent `loop:` key does not (same forward-only convention as the eligibility rules above);
- **≤5 non-docs files** touched;
- free of file-overlap edges with the other members.

"Different subsystems" / "disjoint files" are **NOT** sufficient reasons to leave such a set
separate — for this class, solo needs a written reason in the batches README's "Not batched, with
reasons" section.

**Dissolution is the board-pass's job.** A batch dissolves ONLY when a board-pass reconcile says so
explicitly. A single-plan claim must never dissolve a train implicitly — a member of a
`status: proposed`, `gate: null` batch is ineligible for solo claim (enforced in code by
`claim-plan.mjs` since plan 2459 Task 2), with the explicit operator override logged in the claim
commit and the plan body. Members of a GATED batch (`gate` non-null) stay individually claimable so
a gate can never freeze them.

## Cross-cutting pitfalls (apply to both batch and fold)

- **A shared tag is not a shared mutex class or file-surface.** Verify the real overlap yourself; don't
  take "both tagged Infra" as sufficient.
- **Mixed `🟥`/`🟩` needs a reason.** Combining them (fold OR batch) serializes the `🟩` member(s)
  behind the seed-write landing mutex — surface that tradeoff explicitly rather than silently absorbing
  it.
- **Claimed / `in-progress/` plans are off-limits to both paths.** A live worktree owns them; surface
  the conflict, don't fold or batch around it.
- **When genuinely torn between batch and fold**, default to batch. It's reversible (a batched plan can
  still be pulled solo later); a fold is not (the originals are archived).
