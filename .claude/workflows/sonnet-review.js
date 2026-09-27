export const meta = {
  name: "sonnet-review",
  description: "Verify-hybrid clone of the /code-review workflow with ESCALATE-ON-REFUTE verifiers (plan 1161). Finders/scope/sweep/synthesis AND the round-1 verifiers run claude-sonnet-high (the cheap bulk); only when a verifier REFUTES a candidate (the lone risky action — dropping a possibly-real finding) does an independent claude-opus-high adjudicator re-judge that location before the finding is dropped — REGARDLESS of the session model. Spends Opus on the one decision the bake-off shows it earns (adjudicating contested refutes) and nowhere else, ~1.1-1.4x pure-Sonnet vs full Opus-xhigh /code-review. Same fan-out logic: one finder per angle, one verifier per distinct (file,line) location, ranked capped report.",
  whenToUse: "Run via the /sonnet-review command for a cheap-but-trustworthy code review without flipping the session model. Pass args as \"<level> [target]\" — level is high (default), xhigh, or max (controls fan-out breadth only; round-1 verifiers stay Sonnet-high, refute-adjudicators stay Opus-high); target is an optional PR number, branch, ref range, path, or free-form review instructions (e.g. \"only review src/foo.ts\", \"focus on error handling\").",
  phases: [{"title":"Scope","detail":"Pin the diff command, changed files, applicable CLAUDE.md files, and conventions"},{"title":"Find","detail":"One finder agent per review angle (correctness + cleanup + conventions), pooled before verify"},{"title":"Verify","detail":"Sonnet verifier per distinct (file, line) location — CONFIRMED / PLAUSIBLE / REFUTED per candidate"},{"title":"Adjudicate","detail":"Opus re-judges ONLY the Sonnet-REFUTED candidates (one agent per location); a finding is dropped only if Opus also refutes"},{"title":"Sweep","detail":"Fresh finder hunting only for gaps (xhigh/max)"},{"title":"Synthesize","detail":"Merge duplicates, rank, cap the report"}],
}

// code-review: Scope → Find (barrier) → group-by-location → Verify → Sweep (xhigh/max) → Synthesize
// Effort parameterization mirrors the inline /code-review cells:
//   high  → 4 correctness + 5 cleanup angles × 6 → ≤10 findings
//   xhigh → 6 correctness + 5 cleanup angles × 8 → sweep → ≤15 findings
//   max   → same structure as xhigh (the API reasoning effort differs, not the fan-out)
const LEVEL_PARAMS = {
  high: { correctnessAngles: 4, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 6, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 6, perAngle: 8, maxFindings: 15, sweep: true },
}
const SWEEP_MAX = 8

// ─── The point of this fork: pin model+effort here so the review never inherits
// the (usually Opus-xhigh) session model. ESCALATE-ON-REFUTE (plan 1161, supersedes
// the plan-1143 full-Opus pin): finders, scope, sweep, synthesis AND the round-1
// verifiers all run Sonnet-high (the cheap bulk); ONLY when a verifier REFUTES a
// candidate (the lone risky action — dropping a possibly-real finding) does an
// independent Opus-high ADJUDICATOR re-judge that location. Bake-off
// codereview-verifier-model-2026-06-29 found Sonnet verifiers uphold a real bug
// 33/33 — the full-Opus pin's justification did not reproduce — but Opus is still the
// better adjudicator on a contested refute, so spend it there and nowhere else
// (~2.8x → ~1.1-1.4x pure-Sonnet). LEVEL still controls fan-out breadth only. These
// PINs + their `...` spreads AND the two-round verifyGroups/verifyOnce escalate-on-
// refute flow (below) are the divergences from the upstream /code-review workflow;
// re-apply ALL of them if you re-clone upstream.
// Plus angle-P (pre-existing-line auditor, plan 1719): inserted 4th in
// CORRECTNESS_ANGLES (runs at every level; counts bumped high 3→4, xhigh/max
// 5→6) after plan 1311 measured in-spine Sonnet-5 finders missing a
// pre-existing-line bug 0/2 that 4.6 caught 3/3 (and xhigh also 0/2 — effort
// does not fix it; the failure is hunk-fixation + comment-trust). Validated on
// the frozen c2 case: v1 (no comment-trust rules) 0/2; v2 as shipped 2/2
// exact, leak-free. c2 was in the tuning loop, so generalization is
// unvalidated — data: output/reports/1719-anglep-c2-validation/.
const PIN = { model: "sonnet", effort: "high" } // scope, finders, round-1 verifiers, sweep, synthesis
const ADJUDICATE_PIN = { model: "opus", effort: "high" } // refute-adjudicators only (escalation)

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const PAST_CAP_ARG = /(^|\s)--past-cap(?:=|\s+)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/g
const REVIEW_ARGS = RAW_ARGS.replace(PAST_CAP_ARG, "").trim()
const FIRST = REVIEW_ARGS.split(/\s+/)[0] || ""
// Own-property check so Object.prototype keys ("constructor", "toString") never parse as a level.
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TARGET = FIRST_IS_LEVEL ? REVIEW_ARGS.slice(FIRST.length).trim() : REVIEW_ARGS
const P = LEVEL_PARAMS[LEVEL]

// Prompt fragments shared with the inline /code-review cells (one source of truth).
const CORRECTNESS_ANGLES = [{"label":"angle-A","text":"### Angle A — line-by-line diff scan\n\nRead every hunk in the diff, line by line. Then Read the enclosing function for\neach hunk — bugs in unchanged lines of a touched function are in scope (the PR\nre-exposes or fails to fix them). For every line ask: what input, state, timing,\nor platform makes this line wrong? Look for inverted/wrong conditions,\noff-by-one, null/undefined deref, missing `await`, falsy-zero checks,\nwrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.\n"},{"label":"angle-B","text":"### Angle B — removed-behavior auditor\n\nFor every line the diff DELETES or replaces, name the invariant or behavior it\nenforced, then search the new code for where that invariant is re-established.\nIf you can't find it, that's a candidate: a removed guard, a dropped error\npath, a narrowed validation, a deleted test that was covering a real case.\n"},{"label":"angle-C","text":"### Angle C — cross-file tracer\n\nFor each function the diff changes, find its callers (Grep for the symbol) and\ncheck whether the change breaks any call site: a new precondition, a changed\nreturn shape, a new exception, a timing/ordering dependency. Also check callees:\ndoes a parallel change in the same PR make a call unsafe?\n"},{"label":"angle-P","text":"### Angle P — pre-existing-line auditor\n\nTreat every hunk in the diff as CORRECT — do not re-review added or changed\nlines (other angles own them). Instead, for each function or method the diff\ntouches, read the ENTIRE post-change function and audit ONLY the lines the\ndiff did NOT touch. Shipping this PR re-exposes those lines: a latent bug\namong them ships with the change.\n\nFor each untouched line ask the line-by-line questions (inverted/wrong\ncondition, off-by-one, null/undefined deref, missing await, swallowed error,\nwrong variable). Give special weight to operations whose correctness depends\non WHICH BASE or TARGET they act against — a diff applied or checked against\nthe working tree vs HEAD vs the index, a path resolved against cwd vs repo\nroot, a comparison against a cached/stale snapshot vs the live value. For\neach such operation, name the base the code actually uses and the base the\nfunction's stated purpose implies; a mismatch is a candidate.\n\nTwo rules while auditing:\n1. Comments are CLAIMS, not evidence. A header or inline comment describing\n   what a call does (or why it is safe) proves nothing — verify the claim\n   against the call's actual semantics and the surrounding code. A line whose\n   comment says the safe thing while the code does the unsafe thing is the\n   highest-value candidate there is.\n2. For EVERY external command, library call, or API call, name the implicit\n   DEFAULT it operates on — which base, ref, directory, file set, encoding,\n   or point in time — and check that default against what the enclosing\n   function's contract requires. A call whose default target is mutable or\n   volatile state (the working tree, cwd, wall-clock now, a cache) where the\n   contract implies a committed or stable base (HEAD, the repo root, a\n   snapshot) is a candidate even when every comment says it is fine.\n\nReport candidates ONLY at lines the diff did not add or modify; if a\ncandidate sits on a hunk line, drop it.\n"},{"label":"angle-D","text":"### Angle D — language-pitfall specialist\n\nScan for the classic pitfalls of the diff's language/framework — for example:\nJS falsy-zero, `==` coercion, closure-captured loop var; Python mutable default\nargs, late-binding closures; Go nil-map write, range-var capture; SQL injection;\ntimezone/DST drift; float equality. Flag any instance the diff introduces.\n"},{"label":"angle-E","text":"### Angle E — wrapper/proxy correctness\n\nWhen the PR adds or modifies a type that wraps another (cache, proxy, decorator,\nadapter): check that every method routes to the wrapped instance and not back\nthrough a registry/session/global — e.g. a caching provider holding a\n`delegate` field that resolves IDs via `session.get(...)` instead of\n`delegate.get(...)` will re-enter the cache or recurse. Also check that the\nwrapper forwards all the methods the callers actually use.\n"}]
const CLEANUP_ANGLES = [{"label":"reuse","text":"### Reuse\n\nFlag new code that re-implements something the codebase\nalready has — Grep shared/utility modules and files adjacent to the change,\nand name the existing helper to call instead.\n"},{"label":"simplification","text":"### Simplification\n\nFlag unnecessary complexity the diff adds: redundant or derivable state,\ncopy-paste with slight variation, deep nesting, dead code left behind. Name\nthe simpler form that does the same job.\n"},{"label":"efficiency","text":"### Efficiency\n\nFlag wasted work the diff introduces: redundant computation or repeated I/O,\nindependent operations run sequentially, blocking work added to startup or\nhot paths. Also flag long-lived objects built from closures or captured\nenvironments — they keep the entire enclosing scope alive for the object's\nlifetime (a memory leak when that scope holds large values); prefer a\nclass/struct that copies only the fields it needs. Name the cheaper\nalternative.\n"},{"label":"altitude","text":"### Altitude\n\nCheck that each change is implemented at the right depth, not as a fragile\nbandaid. Special cases layered on shared infrastructure are a sign the fix\nisn't deep enough — prefer generalizing the underlying mechanism over adding\nspecial cases.\n"},{"label":"conventions","text":"### Conventions (CLAUDE.md)\n\nFind the CLAUDE.md files that govern the changed code: the user-level\n~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or\nCLAUDE.local.md in a directory that is an ancestor of a changed file (a\ndirectory's CLAUDE.md only applies to files at or below it). Read each one\nthat exists, then check the diff for clear violations of the rules they state.\n\nOnly flag a violation when you can quote the exact rule and the exact line\nthat breaks it — no style preferences, no vague \"spirit of the doc\"\ninferences. In the finding, name the CLAUDE.md path and quote the rule so the\nreport can cite it. If no CLAUDE.md applies, return nothing for this angle.\n\nKnown non-finding (do not re-raise; wontfixed 3x in 2026-07/08 reviews): the\nuser-level CLAUDE.md rule \"Full URLs / paths — always\" governs operator-facing\nOUTPUT (chat, commits, messages addressed to the operator), NOT tracked repo\nfiles. Repo-relative paths inside tracked docs and code are this repo's\nconvention — never flag a tracked file for using them.\n"}]
const VERDICT_LADDER = "- **CONFIRMED** — can name the inputs/state that trigger it and the wrong\n  output or crash. Quote the line.\n- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,\n  config). State what would confirm it.\n- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.\n  Quote the line that proves it."
const VERDICT_LADDER_RECALL = "**PLAUSIBLE by default** — do not refute a candidate for being \"speculative\" or\n\"depends on runtime state\" when the state is realistic: concurrency races,\nnil/undefined on a rare-but-reachable path (error handler, cold cache, missing\noptional field), falsy-zero treated as missing, off-by-one on a boundary the\ncode does not exclude, retry storms / partial failures, regex/allowlist that\nlost an anchor. These are PLAUSIBLE.\n\n**REFUTED** only when constructible from the code: factually wrong (quote the\nactual line); provably impossible (type/constant/invariant — show it); already\nhandled in this diff (cite the guard); or pure style with no observable effect."
const CLEANUP_PRECEDENCE = "Cleanup, altitude, and conventions candidates use the same\n`file`/`line`/`summary` shape; in `failure_scenario`, state the concrete\ncost (what is duplicated, wasted, harder to maintain, or which CLAUDE.md rule\nis broken) instead of a crash. Correctness bugs always outrank cleanup,\naltitude, and conventions findings when the output cap forces a cut.\n"
const SWEEP_GAP_FOCUS = "moved/extracted code that dropped a guard\nor anchor; second-tier footguns (dataclass default evaluated once, `hash()`\nnon-determinism, lock-scope shrink, predicate methods with side effects);\nsetup/teardown asymmetry in tests; config defaults flipped."
// plan 2936 T3 — the disposition policy's severity floor, stated in the FINDER prompts so
// sub-floor noise dies at the source instead of costing a disposition at land time. This copy is
// VENDORED: `scripts/gpt-review.mjs` exports the canonical `SEVERITY_FLOOR_NOTE` and
// `scripts/gpt-review.test.mjs` reads THIS file and asserts the exact string is present, so the
// two lanes cannot drift. Edit both or neither — the drift check fails the push otherwise.
const SEVERITY_FLOOR_NOTE = "### Severity floor (docs/coord/review.md § Disposition policy) — Do not report perf micro-optimizations or one-line infra/tooling-debt observations that neither affect correctness nor block lands nor corrupt data; policy declines them by rule, so they only cost a disposition. A genuine defect of any size is still in scope."
// VENDORED byte-identically from scripts/gpt-review.mjs (Workflow sandbox is import-free).
const FINDING_TAG_NOTE = "### Required finding tags\n- `preExisting` — TRUE when the defect would still be present with this plan's diff removed. Answer it by checking whether the flagged line or behaviour is INSIDE the reviewed range's `+` side. Return `preExistingWhy` as one line.\n- `blocksLand` — TRUE only when the finding is a correctness defect on the plan's OWN target surface whose residual cost is data corruption, a wrong user-facing value, a blocked land or push, or a broken contract another module relies on. FALSE for: a wrong or missing warning/log line; a perf or tidiness change; a theoretical input no caller produces; an edge case on a warn-only, report-builder or docs-generator surface (the blast-radius floor); and anything whose fix would change the land's risk class. Return `blocksLandWhy` as one line.\n- A re-raise of a finding already dispositioned `wontfix`, with no new evidence, is `blocksLand: false`."
// plan 2957 T2 — the materialized-diff header: one artifact path + one orientation sentence,
// replacing the per-finder `git diff` command on the DEFAULT (no explicit target) path. Two
// defect classes die with it: refs moving mid-review handing different finders different
// diffs, and unstated orientation leaving `reversed-diff-misread` to each model.
// This copy is VENDORED (the Workflow sandbox has no module imports): the canonical renderer
// is `buildScopeBlock` in `scripts/gpt-review.mjs`, and `scripts/gpt-review.test.mjs` renders
// THIS template with fixed values and asserts byte-equality with the runner's output. Because
// the wording interpolates, it must stay a SINGLE-LINE JSON-parseable string literal — that is
// what the test's `workflowConst()` extractor can read. A template literal or a multi-line
// string silently exempts the wording from the drift guard. Edit both lanes or neither.
const DIFF_ORIENTATION_TEMPLATE = "Diff file (read this — do not run `git diff` yourself): {diffPatchPath}\nLines beginning `+` are the code under review (branch tip {headSha}); lines beginning `-` are the pre-change base.\n"

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["diffCommand", "files", "summary"],
  properties: {
    diffCommand: { type: "string" },
    // plan 2957 T2: the materialized diff. The Workflow script has no filesystem or git
    // access, so the SCOPE AGENT resolves the endpoints once and writes the patch; these
    // two fields carry it to every finder/verifier/sweep agent. Optional by design —
    // absent on the explicit-target path and whenever materialization failed, where
    // `diffCommand` stays the fallback so no agent is left with neither.
    diffPatchPath: { type: "string", description: "ABSOLUTE path to the materialized diff written by the scope agent" },
    headSha: { type: "string", description: "the resolved branch-tip sha the '+' side of that diff represents" },
    files: { type: "array", items: { type: "string" } },
    // plan 3093: the data-artifact exclusion's no-silent-truncation sentence, emitted
    // VERBATIM by `scripts/review-diff-scope.mjs` (the one place the exclude list lives —
    // this runtime cannot import it, so the scope agent shells out to its CLI). Optional:
    // absent/empty whenever nothing was excluded, which is the ordinary code-only review.
    excludedNote: { type: "string", description: "ONLY the 'note' field printed by scripts/review-diff-scope.mjs, copied verbatim — never your own prose. Omit entirely when nothing was excluded; never repurpose this field to explain an empty or unresolved scope (use worktreeCandidates and summary for that)." },
    // plan 3245: when the default diff resolves to zero files, the worktrees whose branch
    // carries commits ahead of origin/master — so a genuinely empty scope can name where
    // the work actually lives instead of silently reporting clean. Optional: absent/empty
    // whenever the scope wasn't empty, or no such worktree exists.
    worktreeCandidates: { type: "array", items: {
      type: "object", required: ["branch", "path"],
      properties: {
        branch: { type: "string" },
        path: { type: "string", description: "ABSOLUTE path to the worktree" },
      },
    }},
    claudeMdFiles: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
    // plan 2936 T1: findings already dispositioned in an earlier round of THIS review,
    // read off the session's findings sidecar by the scope agent (the workflow script
    // itself cannot read files). Optional: absent/empty is the normal first-round case.
    priorDispositions: { type: "array", items: {
      type: "object", required: ["file", "summary", "type"],
      properties: {
        file: { type: "string", description: "repo-relative path the finding was recorded against" },
        // null is a VALID recorded value — a file-level finding has no line (the gpt-review
        // lane emits `line: f.line ?? null`). A bare {type:"number"} rejects it and loses the
        // whole injection to a schema failure.
        line: { type: ["number", "null"] },
        summary: { type: "string" },
        type: { enum: ["wontfix", "plan", "deferred-by-tag"] },
        reason: { type: "string", description: "the wontfix/deferred-by-tag reason string, or the target plan id for a 'plan' deferral" },
      },
    }},
  },
}
const CANDIDATES_SCHEMA = {
  type: "object", required: ["candidates"],
  properties: {
    candidates: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario"],
      properties: {
        file: { type: "string", description: "repo-relative path exactly as listed under Changed files in the review scope" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
      },
    }},
  },
}
// One verifier per distinct (file, line) location, returning a verdict per
// candidate at that location — instead of one verifier per candidate. Cuts
// verifier-agent count by the cross-finder location-collision rate (~40% at
// p50) without dropping any candidate.
// VENDORED byte-identically from scripts/gpt-review.mjs as JSON text: the
// import-free Workflow parses it, and the runner's drift test compares the full string.
const GROUP_VERDICT_SCHEMA_JSON = "{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"verdicts\"],\"properties\":{\"verdicts\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"additionalProperties\":false,\"required\":[\"index\",\"verdict\",\"evidence\",\"preExisting\",\"preExistingWhy\",\"blocksLand\",\"blocksLandWhy\"],\"properties\":{\"index\":{\"type\":\"integer\"},\"verdict\":{\"enum\":[\"CONFIRMED\",\"PLAUSIBLE\",\"REFUTED\"]},\"evidence\":{\"type\":\"string\"},\"preExisting\":{\"type\":\"boolean\"},\"preExistingWhy\":{\"type\":\"string\",\"pattern\":\"^[^\\\\r\\\\n]+$\"},\"blocksLand\":{\"type\":\"boolean\"},\"blocksLandWhy\":{\"type\":\"string\",\"pattern\":\"^[^\\\\r\\\\n]+$\"}}}}}}"
const GROUP_VERDICT_SCHEMA = JSON.parse(GROUP_VERDICT_SCHEMA_JSON)
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "decisions"],
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: {
      type: "object", required: ["index"],
      properties: {
        index: { type: "number", description: "the [i] label of a finding to keep in the report" },
        merge: { type: "array", items: { type: "number" }, description: "[i] labels of findings that describe the same root cause, folded into this one" },
      },
    }},
  },
}

// ─── Phase 0: Scope ───
phase("Scope")
const scope = await agent(
  "Establish the scope of a code review.\n\n" +
  (TARGET
    ? "Review target / instructions (passed by the user, verbatim): \"" + TARGET + "\". If it names a PR number, branch, ref range, or file path, build the matching git diff command for it; if it is a free-form instruction (e.g. only review certain files, focus on certain areas), honor any scope restriction when building the diff command and start from the current branch diff ('git diff @{upstream}...HEAD', falling back to 'git diff main...HEAD' or 'git diff HEAD~1') for whatever it does not narrow.\n" +
      // plan 3093: the explicit-target path builds its own command, so it appends the SAME
      // exclusion the default path gets from the CLI — one list, both branches. The CLI emits
      // exclude pathspecs ONLY (no ':/'), so appending them NARROWS and never widens: a
      // command already scoped to one file stays scoped to it. The opt-out is deliberate: a
      // target that names an excluded path is asking to review exactly what the rule drops.
      "   Then append the data-artifact exclusion to whatever diff command you built: run 'node scripts/review-diff-scope.mjs pathspecs' and append its output to that command's PATHSPEC LIST — after the existing '--' and any paths already there if the command has them, otherwise add a '--' first. Never add a second '--'. These are exclude-only pathspecs, so they only ever remove data-artifact paths; they cannot widen a target you already narrowed. SKIP this append (and say so in the conventions field) if the target explicitly names one of those excluded paths, since that target is asking to review exactly what the exclusion drops.\n" +
      // plan 3093 round-2 review (3 findings): without this, the explicit-target path never
      // emits excludedNote, so a data-only PR/branch reaches the empty-scope guard with no
      // way to tell "everything was an excluded artifact" from "nothing changed" — and gets
      // reported as "No changes found to review".
      // plan 3093 round-3 review: this used to have the AGENT subtract two --name-only
      // counts. Unspecified subtraction order, no test — a wrong sign silently omits the
      // note and a data-only PR reads back as "No changes found". The module computes it.
      // Conditional on ACTUALLY having appended the exclusion: when the target names an
      // excluded path the hunks are PRESENT, and a note telling finders they are absent
      // would suppress reporting on the very thing the user asked to review.
      "   Then, ONLY IF you appended the exclusion above (skip this entirely if you took the opt-out): run 'node scripts/review-diff-scope.mjs note-for <the same commits/range your diff command uses> -- <the same paths your diff command uses, if any>'. Return its output verbatim as excludedNote; if it prints nothing, omit excludedNote. Do not compute this count yourself.\n" +
      // Same defect the default path had at round 2, on this branch: an intentionally
      // empty filtered diff is a VALID data-only result, not a failed scoping.
      "   One consequence to expect: if the target touches ONLY excluded data artifacts, your filtered diff command is legitimately EMPTY. That is a valid result, not a failure — return it with excludedNote set, and do NOT widen the command or drop the exclusion to make it non-empty.\n"
    : "No explicit target — review the current branch, and MATERIALIZE the diff once so every downstream agent reads the same bytes:\n" +
      "   a. Resolve the endpoints ONCE: 'git merge-base origin/master HEAD' (fall back to the upstream branch, then 'main', then 'HEAD~1' if origin/master is unavailable) and 'git rev-parse HEAD'. Remember the merge-base command's own SHA result as mergeBase (used below at step c) — step f passes this SAME sha as '--base' so it never re-resolves the origin/master -> upstream -> main -> HEAD~1 chain a second time.\n" +
      "   b. Create the scratch dir if needed ('mkdir -p .scratch' at the repo root — .scratch/ is the gitignored session-scratch convention; NEVER write the patch to a tracked path, which would dirty the worktree and fail the done-worktree preflight).\n" +
      // plan 3093: the CLI does the write. It excludes changed data artifacts
      // (backend/data, output, backend/src/data/seed, input, pnpm-lock.yaml) at diff
      // ASSEMBLY, which is what keeps a data-heavy land inside the finder timeouts. The
      // exclude list lives ONLY in scripts/review-diff-scope.mjs — never restate it here,
      // or the two review lanes will drift apart the first time it changes.
      "   c. Materialize the SCOPED patch with ONE command, from the repo root:\n" +
      "        node scripts/review-diff-scope.mjs materialize --out .scratch/sonnet-review-diff-<headSha>.patch <mergeBase> <headSha> --include-worktree\n" +
      "      It prints ONE line of JSON: {outPath, bytes, files, excludedFiles, note, diffCommand}. Do NOT run 'git diff' yourself and do NOT hand-assemble the patch — this command already excludes changed data artifacts (pipeline outputs, seed rows, review reports — whether committed in the range or merely edited in the working tree), which is what keeps a data-heavy branch inside the finder time limits. '--include-worktree' makes it append the uncommitted changes when there are any.\n" +
      // plan 3093 round-2 review (3 findings): a bare `bytes > 0` gate rejects the ONE
      // case this plan exists for. A data-only range legitimately materializes an EMPTY
      // patch with excludedFiles > 0, and treating that as a failed materialization sends
      // the agent into the fallback, where it rebuilds an UNSCOPED diff and reviews the
      // very artifacts the exclusion dropped — the opposite of the intent.
      "   d. Read the JSON's 'bytes' and 'excludedFiles'. Two valid outcomes: bytes > 0 is an ordinary non-empty diff; bytes == 0 WITH excludedFiles > 0 is also VALID and expected — it means every changed file was an excluded data artifact, which is a real result, NOT a failed materialization. Treat only bytes == 0 AND excludedFiles == 0 as a genuinely empty range. In all three cases return 'outPath' as diffPatchPath and the resolved sha as headSha, and do NOT run the diff a second time; that JSON IS the confirmation.\n" +
      "   e. Return the JSON's 'diffCommand' verbatim as diffCommand, and its 'note' verbatim as excludedNote (omit excludedNote when 'note' is empty). diffCommand is not merely a record: it is the fallback every downstream agent is told to run if the artifact turns out to be missing or empty, and the CLI already built it to reproduce EVERYTHING the artifact covers — so never substitute a plainer 'git diff' of your own, which would silently review a different set of bytes than the artifact did.\n" +
      // plan 3245: a cloud-drain top-level session runs the Workflow tool from its cwd —
      // the MAIN checkout on master — while the actual work lives in .claude/worktrees/<slug>.
      // Left alone, that makes 'bytes==0 AND excludedFiles==0' resolve as a genuinely clean
      // review instead of the wrong-checkout bug it usually is. This step is the one place
      // that ACTS on the diagnosis (the throw below only reports it) — do not skip it.
      "   f. If bytes is 0 AND excludedFiles is 0 (a genuinely empty scoped diff — not merely an artifacts-only one), do not report 'no changes' yet. First run 'git rev-parse --abbrev-ref HEAD'. If it is anything other than 'master', this is an ordinary empty range on your own branch — leave worktreeCandidates empty and fall through to reporting it empty.\n" +
      "      If it IS 'master', hunt for the worktree the work actually lives in using the SAME resolver the review-round cap guard uses (plan 3618 — one resolver, so the guard and this scope phase can never disagree about which branch is under review): run 'node scripts/coord/review-round-cap.mjs resolve-target-branch --cwd . --base <mergeBase from step a>' at the repo root — passing step a's OWN already-resolved merge-base sha via '--base' so this call reuses the EXACT base that produced the empty result instead of re-resolving the origin/master -> upstream -> main -> HEAD~1 chain a second time, which could legitimately land on a DIFFERENT ref if availability moved between step a and now (a concurrent fetch, a reconfigured upstream). It prints ONE line of JSON: {status, branch, path, candidates?, baseRef?}. status 'resolved' means exactly one worktree carries a non-empty diff against that base — return that single {branch, path} (path ABSOLUTE) as worktreeCandidates. status 'ambiguous' means more than one did — its 'candidates' array (each {branch, path}) IS worktreeCandidates verbatim. status 'none' or 'current' (or the command failing outright) means none did, or it could not resolve a base ref at all — leave worktreeCandidates empty. With '--base' passed, the JSON's 'baseRef' is that SAME sha echoed back verbatim — remember it as RESOLVED_BASE_REF, step i below reuses it.\n" +
      "      If worktreeCandidates has zero or more than one entry, stop here — do not guess which one is meant. Report the empty result as usual, with worktreeCandidates set (leave files empty and excludedNote OMITTED — do not put this diagnosis in excludedNote, that field is reserved for scripts/review-diff-scope.mjs's own output and nothing else; explain the situation in the summary field instead) and let the caller re-run against the right one.\n" +
      "      If worktreeCandidates has EXACTLY ONE entry, re-materialize the diff FROM THAT WORKTREE — this fixes the review, it does not just diagnose it. Do NOT reuse the CLI's 'materialize' subcommand for this (it always diffs the process's OWN cwd, never a path you hand it); build it by hand instead, INCLUDING the worktree's own uncommitted changes (parity with step c's --include-worktree — a worktree mid-edit is exactly the case this recovery exists for):\n" +
      "        i.   'git -C <path> merge-base RESOLVED_BASE_REF HEAD' and 'git -C <path> rev-parse HEAD' — the worktree's own endpoints. Use RESOLVED_BASE_REF (the JSON's own 'baseRef' from the hunt above — with '--base' passed, this equals step a's own mergeBase) here, NOT step a's mergeBase VARIABLE directly — this command runs with '-C <path>' against a DIFFERENT checkout (the worktree's own), so using the shared sha explicitly (rather than assuming the two names always agree) keeps this step correct even if a future edit ever lets the CLI's baseRef diverge from mergeBase. Only fall back to step a's own mergeBase value if the JSON carried no 'baseRef' field at all (the command failed outright).\n" +
      "        ii.  'node scripts/review-diff-scope.mjs pathspecs' — safe to run regardless of cwd (it prints a fixed pathspec list, no git access).\n" +
      "        iii. 'git -C <path> diff <mergeBase> <headSha> -- <pathspecs from ii>' redirected to '.scratch/sonnet-review-diff-<headSha>.patch' at the repo root (create the dir first, as in step b) — the same exclusion the CLI applies, run against the worktree's tree instead of the main checkout's. THEN also run 'git -C <path> diff HEAD -- <pathspecs from ii>' and APPEND its output to the same file ONLY if it is non-empty — this is the worktree's uncommitted diff, and skipping it silently drops any change not yet committed there.\n" +
      "        iv.  'git -C <path> diff --name-only <mergeBase> <headSha> -- <pathspecs>', UNIONED with 'git -C <path> diff --name-only HEAD -- <pathspecs>' when that second diff was non-empty in iii, for the changed-file list (de-duplicate). Return each file as an ABSOLUTE path formed by joining <path> with the repo-relative name using a FORWARD SLASH always, never a backslash even on Windows — git's own path output is already forward-slash, and a mixed separator breaks the exact-string matching every downstream candidate/verifier relies on. A repo-relative path here would have every downstream finder Read the MAIN checkout's unchanged copy instead of the worktree's; the absolute path is what actually moves them onto the worktree's file contents.\n" +
      "        v.   Set diffPatchPath to the file from iii, headSha to the sha from i, diffCommand to the command(s) from i and iii that you actually ran (with the worktree path, so it is directly rerunnable), and excludedNote from 'node scripts/review-diff-scope.mjs note-for <mergeBase> <headSha> -- <pathspecs>' run with the worktree as cwd (omit if it prints nothing — and if you also appended the HEAD diff in iii, note that in the conventions field instead of trying to fold it into this command, since note-for only covers the committed range).\n" +
      "        This OVERRIDES steps a-e's result entirely for files/diffPatchPath/headSha/diffCommand/excludedNote — the worktree's diff is the review, do not merge the two.\n" +
      "   Otherwise (step f did not fire, or bytes/excludedFiles made it a non-empty or artifacts-only result), use the JSON's 'files' array for the changed-file list in step 2 — it is already the scoped list, matching the bytes in the artifact.\n" +
      "   If the command fails for any reason, omit diffPatchPath and headSha and fall back to determining a diff command yourself, running it, and confirming it is non-empty — step d's confirmation never happened. Say so in the conventions field.\n") +
  // Instruction 1 is the explicit-target path's diff-resolution step. On the default path steps
  // a-d already resolved, ran, and confirmed the diff, so repeating it would run the same git
  // diff twice in one scope phase — but ONLY when they succeeded; the fallback branch never got
  // its confirmation, so it must still run and check the command itself.
  (TARGET
    ? "\n1. Determine the exact diff command(s) for the review and run them. Non-empty is the ordinary case — but an EMPTY result is VALID and must be returned as-is whenever excludedNote is set, since that means the target touched only excluded data artifacts. Never widen the command or drop the exclusion to force a non-empty diff.\n"
    : "\n1. If steps a-d succeeded, this is already done — carry those results forward and do not re-run the diff. If you fell back with no artifact, determine the diff command(s) and run them NOW to confirm they produce a non-empty diff.\n") +
  "2. List the changed files.\n" +
  "3. Summarize what changed in one paragraph.\n" +
  "4. List the CLAUDE.md files that apply to the changed files (the user-level ~/.claude/CLAUDE.md, the repo-root CLAUDE.md, plus any CLAUDE.md or CLAUDE.local.md in a directory that is an ancestor of a changed file). Read each one that exists and note conventions a reviewer should know.\n\n" +
  "5. Collect the findings ALREADY DISPOSITIONED in an earlier round of this same review, so the finders do not re-litigate them.\n" +
  "   - The sidecar lives beside this session's handoff entry: 'docs/handoff/sessions/<session>.findings.json' (the '.md' entry with '.findings.json' in place of '.md'). Find the one for THIS work: the current branch is 'worktree-<slug>', so run 'git rev-parse --abbrev-ref HEAD', strip the 'worktree-' prefix, and look for the sidecar whose top-level \"slug\" field equals that slug.\n" +
  "   - SLUG GUARD: if the sidecar you find has a \"slug\" that does NOT equal the current slug, it belongs to a DIFFERENT plan — skip it entirely and return priorDispositions as an empty array. Never inject another plan's dispositions.\n" +
  "   - If no sidecar file exists, return priorDispositions as an empty array — that is the normal first-round case. If a sidecar EXISTS but cannot be read or parsed, do NOT treat it as absent: return an empty array and say so explicitly in the conventions field so the omission is visible.\n" +
  "   - Include ONLY findings whose disposition type is 'wontfix', 'plan', or 'deferred-by-tag'. Do NOT include 'fixed' findings: a re-report of a fixed finding is a regression signal worth surfacing.\n" +
  "   - For each, return file, line, summary, type, and reason TRUNCATED to 200 characters. `reason` carries what that disposition type recorded: the wontfix reason string, the target plan id for a deferral, or the tag rationale for a deferred-by-tag. Cap the list at 120 entries, newest rounds first; if you drop any, say how many in the conventions field.\n\n" +
  "Return diffCommand exactly as a reviewer should run it. Structured output only.",
  { ...PIN, label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the review scope." }
}
// plan 3245 rehearsal finding: a scope agent asked to diagnose a genuinely empty scope
// stuffed its worktree-hunt explanation into excludedNote instead of worktreeCandidates —
// syntactically valid against the schema, and it routed straight into the artifacts-only
// PASS branch below, which is exactly the pass-shaped output this plan exists to prevent.
// Prompt wording cannot close that loophole (an agent free to write prose can always
// mis-file it), so the code enforces the SHAPE a REAL excludedNote always has: the fixed
// `<N> changed data-artifact file(s) under` clause review-diff-scope.mjs's excludedNote()
// always emits right after the prefix (gpt-review round-2 review, plan 3245: a prefix-only
// check still admits "Excluded from this diff: <any fabricated prose>"). Anything that
// doesn't match this shape is discarded — never trusted as the carve-out.
const EXCLUDED_NOTE_RE = /^Excluded from this diff: \d+ changed data-artifact file\(s\) under /
if (typeof scope.excludedNote === "string" && !EXCLUDED_NOTE_RE.test(scope.excludedNote)) {
  scope.excludedNote = undefined
}
// plan 3245 review finding (angle-P): a schema-satisfying but bogus files array (e.g. an
// empty string) would have `scope.files.length` stay non-zero and slip PAST the guard
// below without ever reaching a real finder — the exact "reviews nothing, reports clean"
// failure mode this plan exists to close, just reached a different way. Filter to real
// paths before the length check, and use the filtered list everywhere downstream.
scope.files = (Array.isArray(scope.files) ? scope.files : []).filter(f => typeof f === "string" && f.trim() !== "")
if (!scope.files || scope.files.length === 0) {
  // plan 3093: an empty file list has two meanings now, and reporting the wrong one is a
  // false clean. "Nothing changed" is the old case; "everything that changed was an
  // excluded data artifact" is a real, correct PASS on a land that may have moved
  // hundreds of files — so the summary must SAY which, or a 700-file land reads back as
  // "no changes found". Round-1 review caught this on both the empty-scope return and the
  // note being discarded with it. This carve-out is UNCHANGED by plan 3245 below.
  if (scope.excludedNote) {
    return {
      level: LEVEL, target: TARGET || undefined,
      summary: "No reviewable changes: every changed file is an excluded data artifact. " + scope.excludedNote,
      findings: [], stats: { finders: 0, candidates: 0, verifierAgents: 0, escalated: 0, verified: 0 },
    }
  }
  // plan 3245: a genuinely empty scope (no excludedNote either) used to return here as a
  // pass-shaped "No changes found to review." report — exit 0, zero findings, indistinguishable
  // from a review that actually read the diff. Hit live from a cloud-drain top-level session
  // (Workflow cwd = the main checkout on master, work living in .claude/worktrees/<slug>):
  // record-review.mjs PASS then satisfied the mandatory-review land gate having read no line
  // of the diff. A thrown workflow error surfaces to the invoking session as a FAILED run —
  // never reuse pass-shaped summary text here, that is exactly what made the incident invisible.
  const candidates = Array.isArray(scope.worktreeCandidates) ? scope.worktreeCandidates : []
  const lines = [
    "[sonnet-review] EMPTY SCOPE — refusing to report a review of nothing.",
    "",
    "The diff resolved to zero changed files, so no finder read anything. This run FAILED — do NOT record any review verdict for it (no PASS/NITS/BUGS-FOUND).",
    "",
  ]
  // plan 3245 review finding (claude-data-grounding arm): the scope agent is explicitly told
  // to explain a zero/multi-candidate outcome via `summary` — but nothing ever read it back,
  // so that explanation was silently dropped from the one place a human sees it.
  if (typeof scope.summary === "string" && scope.summary.trim() !== "") {
    lines.push("Scope agent's diagnosis: " + scope.summary.trim(), "")
  }
  if (candidates.length === 1) {
    lines.push(
      "One worktree carries commits ahead of origin/master, but re-materializing the diff from it ALSO came up empty:",
      "",
      "  " + candidates[0].branch + "\n      " + candidates[0].path,
      "",
      "Check that worktree by hand — its branch may already be merged, or the change may be uncommitted.",
    )
  } else if (candidates.length > 1) {
    lines.push(
      "More than one worktree carries commits ahead of origin/master, so the scope could not be resolved automatically:",
      "",
      ...candidates.map(c => "  " + c.branch + "\n      " + c.path),
      "",
      "Re-run /sonnet-review from the right worktree, or pass an explicit target naming the one you mean (e.g. \"origin/master...<branch>\").",
    )
  } else {
    lines.push(
      "No worktree in this repo carries commits ahead of origin/master either — there is nothing here to review. Check you are in the right repo and on the right branch."
    )
  }
  throw new Error(lines.join("\n"))
}
log(LEVEL + " review: " + scope.files.length + " changed files" +
  (scope.excludedNote ? " (data artifacts excluded)" : ""))

const claudeMdFiles = scope.claudeMdFiles || []
// plan 2936 T1: prompt-only suppression. There is deliberately NO post-filter on the
// finders' output — fuzzy file+summary matching would risk suppressing a genuinely NEW
// finding in the same file, the wrong failure mode under a precision-first ladder.
const PRIOR_DISPOSITION_CAP = 120
const PRIOR_DISPOSITION_REASON_MAX = 200
const rawPriorDispositions = Array.isArray(scope.priorDispositions) ? scope.priorDispositions : []
// The scope-agent prompt asks for these bounds; enforcing them here makes them a property of
// the lane rather than of the agent's compliance. No silent caps — the drop is logged.
const validPriorDispositions = rawPriorDispositions
  // Semantic validation, mirroring the gpt-review lane's normalizeDisposition routing: a
  // {type:"wontfix"} with no reason, a {type:"plan"} with no plan id, or a
  // {type:"deferred-by-tag"} with no tag rationale, satisfies the SCHEMA
  // but carries no rationale to reassess. Injecting it tells a finder an issue was already
  // declined while supplying nothing to judge that against — strictly worse than staying silent,
  // because it suppresses a re-report and explains nothing.
  .filter(d => d && (d.type === "wontfix" || d.type === "plan" || d.type === "deferred-by-tag") && typeof d.reason === "string" && d.reason.trim() !== "")
const priorDroppedCount = Math.max(0, validPriorDispositions.length - PRIOR_DISPOSITION_CAP)
const priorDispositions = validPriorDispositions
  .slice(0, PRIOR_DISPOSITION_CAP)
  .map(d => (d.reason.length > PRIOR_DISPOSITION_REASON_MAX
    ? { ...d, reason: d.reason.slice(0, PRIOR_DISPOSITION_REASON_MAX) }
    : d))
if (priorDroppedCount > 0) log("prior-dispositions: capped at " + PRIOR_DISPOSITION_CAP + " — dropped " + priorDroppedCount + " older entrie(s)")
if (priorDispositions.length > 0) log("carrying " + priorDispositions.length + " prior disposition(s) into the finder prompts")
// plan 2957 T2: prefer the materialized artifact; fall back to the rerunnable command whenever
// the scope agent did not produce one (explicit-target path, or a materialization failure).
// Never leave the agents with neither — the fallback is the pre-2957 behaviour, not an error.
const MATERIALIZED = typeof scope.diffPatchPath === "string" && scope.diffPatchPath.trim() !== ""
  && typeof scope.headSha === "string" && scope.headSha.trim() !== ""
const DIFF_HEADER = MATERIALIZED
  // ONE left-to-right pass with a function replacer, never two chained string replaces: a
  // single pass can neither re-scan an inserted value (a path that literally contains
  // "{headSha}" would otherwise swallow the sha) nor re-read a `$&`/`$1` sequence in the
  // substituted text as a replacement pattern.
  ? DIFF_ORIENTATION_TEMPLATE.replace(/\{diffPatchPath\}|\{headSha\}/g,
      m => (m === "{headSha}" ? scope.headSha : scope.diffPatchPath)) +
    // Lane divergence from the runner's buildScopeBlock, and deliberate: the runner
    // materializes the patch in its own code, so it KNOWS the file is there. Here an AGENT
    // wrote it and the sandbox cannot stat the result — a wrong path or a silently-failed
    // write would otherwise leave every finder with an unreadable artifact, no fallback, and
    // a clean-looking review of a diff nobody read. Naming the command keeps that recoverable.
    // Phrased to override the line above it explicitly. That line is parity-locked to the
    // runner's buildScopeBlock and states the prohibition flatly, so the exception has to be
    // named here or an agent reading top-to-bottom obeys the prohibition and stops.
    "EXCEPTION to the line above: if that file is missing or empty, the prohibition does not apply — do NOT report an empty review, and instead fall back to running: " + scope.diffCommand + "\n"
  : "Diff command: " + scope.diffCommand + "\n"
// The read instruction each finder/verifier gets must match the header it was handed — including
// its exception. A flat "do not run `git diff` yourself" here would contradict the header's
// missing-or-empty fallback in the one case the fallback exists for, and the flatter, more
// often-repeated prohibition is the one a model follows.
const DIFF_READ_INSTRUCTION = MATERIALIZED
  ? "Read the diff file named in the scope block above (do not run `git diff` yourself — unless that file is missing or empty, in which case run the fallback command named beside it)"
  : "Run the diff command above"
if (MATERIALIZED) log("materialized diff: " + scope.diffPatchPath + " (tip " + scope.headSha + ")")
else log("no materialized diff — finders will run the diff command themselves")
const SCOPE_BLOCK =
  "## Review scope\n" +
  DIFF_HEADER +
  // plan 3093: no silent truncation — when the data-artifact exclusion dropped files, its
  // count and paths sit right beside the file list so a finder can tell "data moved but is
  // out of scope" from "data did not change". Byte-unchanged when nothing was excluded.
  (scope.excludedNote ? scope.excludedNote + "\n" : "") +
  "Changed files (" + scope.files.length + "):\n" +
  scope.files.map(f => "  - " + f).join("\n") + "\n" +
  "Applicable CLAUDE.md files (" + claudeMdFiles.length + "):\n" +
  (claudeMdFiles.length > 0 ? claudeMdFiles.map(f => "  - " + f).join("\n") : "  (none)") + "\n\n" +
  "## What changed\n" + scope.summary + "\n\n" +
  "## Conventions\n" + (scope.conventions || "(none noted)") + "\n" +
  // The user's verbatim target/instructions ride along to every finder,
  // verifier, and sweep agent so focus areas and skip requests are honored,
  // not just used for diff scoping.
  (TARGET
    ? "\n## User instructions (verbatim)\n" + TARGET + "\nHonor any scope restrictions or focus areas stated above — they take precedence over your angle's default breadth. Do not surface findings the instructions ask to skip.\n"
    : "") +
  (priorDispositions.length > 0
    ? "\n## Already dispositioned in earlier review rounds\n" +
      "Do not re-report these unless the diff since the recorded review sha changed the relevant facts; a changed-facts re-report must state what changed.\n" +
      priorDispositions.map(d =>
        "  - " + d.file + (typeof d.line === "number" ? ":" + d.line : "") + " — " + d.summary +
        " [" + d.type + (d.reason ? ": " + d.reason : "") + "]"
      ).join("\n") + "\n"
    : "") +
  "\n" + SEVERITY_FLOOR_NOTE + "\n"

// ─── Prompts ───
const FINDER_PROMPT = f =>
  "## Code-review finder — " + f.label + "\n\n" + SCOPE_BLOCK + "\n" +
  DIFF_READ_INSTRUCTION + " and review ONLY through the lens of your assigned angle:\n\n" +
  f.text + "\n" +
  (f.kind === "cleanup" ? CLEANUP_PRECEDENCE + "\n" : "") +
  "Surface up to " + P.perAngle + " candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario — the user-visible consequence (error, wrong output, data loss), not an intermediate state (value stale, set grows). " +
  "Pass every candidate with a nameable failure scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. " +
  "If nothing qualifies, return an empty list.\n\nStructured output only."

// Finders may return absolute, repo-relative, or backslash-separated paths
// for the same file. Normalize once at ingest by suffix-matching against
// scope.files (which the Scope agent returns repo-relative) so every
// downstream consumer — group key, verifier prompt header, synthesis block,
// final report — sees the same path. Longest match wins so that when one
// changed-file path is itself a suffix of another (util/x.ts vs a/util/x.ts),
// an absolute path canonicalizes to the more-specific entry.
const canonFile = raw => {
  if (!raw) return ""
  const p = raw.replace(/\\/g, "/")
  let best = ""
  for (const sf of scope.files) {
    // plan 3245: normalize scope.files entries too, not just the finder's raw path — the
    // worktree-recovery branch (step f above) can hand back absolute paths, and a backslash
    // that slips into just ONE side of this comparison silently fails to canonicalize,
    // fragmenting the same file across finders/verifiers under two different loc() keys.
    const nsf = sf.replace(/\\/g, "/")
    if ((p === nsf || p.endsWith("/" + nsf)) && nsf.length > best.length) best = nsf
  }
  return best || p
}
const ingest = (cs, cap, kind) => cs.slice(0, cap).map(c => ({ ...c, file: canonFile(c.file), kind }))
const loc = c => c.file + (c.line != null ? ":" + c.line : "")
const inBounds = (i, n) => Number.isInteger(i) && i >= 0 && i < n

const GROUP_VERIFIER_PROMPT = group =>
  "## Code-review verifier\n\n" + SCOPE_BLOCK + "\n" +
  "## Candidate findings at " + loc(group[0]) + "\n" +
  group.map((c, i) =>
    "[" + i + "] Summary: " + c.summary + "\n" +
    "    Failure scenario: " + c.failure_scenario
  ).join("\n") + "\n\n" +
  DIFF_READ_INSTRUCTION + ", read the relevant file(s), and return one verdict per candidate. " +
  "Judge EACH candidate independently on its own claim — candidates at the same location may describe distinct issues, the same issue, or a mix. " +
  "Reference each by its [i] index.\n\n" +
  VERDICT_LADDER + "\n\n" + VERDICT_LADDER_RECALL + "\n\n" + FINDING_TAG_NOTE + "\n\n" +
  "Structured output only. Evidence must quote or cite the relevant line(s)."

// ─── Same-location verifier merge — group ingested candidates by loc(c), one
// verifier agent per location returning N verdicts. Grouping is not dedup: every
// candidate keeps its own verdict; the synthesis step merges semantic dupes. A
// candidate the verifier did not render a verdict on (agent died, or it omitted
// that index) is dropped — so unverified candidates never reach the report as
// fabricated PLAUSIBLE. Trade-off: one verifier-agent failure drops every
// candidate at that location instead of one.
//
// ESCALATE-ON-REFUTE (plan 1161): round 1 runs the cheap Sonnet verifier (PIN).
// A candidate it marks CONFIRMED/PLAUSIBLE survives directly; one it REFUTES — the
// only risky action, dropping a possibly-real finding — is NOT dropped on that
// lone refute. Instead an independent Opus-high ADJUDICATOR (ADJUDICATE_PIN)
// re-judges those locations; its verdict replaces round 1's, so a candidate is
// dropped only if Opus ALSO refutes. An adjudicator that dies/omits a verdict keeps
// the round-1 REFUTED (the candidate stays dropped) — degrading to the proven-safe
// Sonnet-single-refute baseline, never fabricating a PLAUSIBLE into the report. Opus
// is thus spent only on the refute minority — the one decision the bake-off
// (codereview-verifier-model-2026-06-29) showed it earns.
let verifierAgents = 0
let escalatedRefutes = 0

// One verifier agent per (file,line) group, returning a verdict per candidate.
// `pin` selects the model (Sonnet round 1 vs Opus adjudication); `tag`/`phaseTag`
// label the agent. `dropOnMiss` decides the fate of a candidate the agent gave no
// verdict for: round 1 DROPS it (true — unverified never reaches the report);
// adjudication KEEPS it as-is (false — a candidate Opus could not re-judge stays at
// its round-1 REFUTED, dropped, never fabricated up to a PLAUSIBLE in the report).
async function verifyOnce(candidates, pin, tag, phaseTag, dropOnMiss) {
  const byLoc = Object.create(null)
  for (const c of candidates) (byLoc[loc(c)] ||= []).push(c)
  const groups = Object.values(byLoc)
  verifierAgents += groups.length
  const out = await parallel(groups.map(g => async () => {
    const short = g[0].file.split("/").pop()
    const r = await agent(GROUP_VERIFIER_PROMPT(g), { ...pin, label: tag + ":" + short + "(" + g.length + ")", phase: phaseTag, schema: GROUP_VERDICT_SCHEMA })
    const byIdx = {}
    if (r) for (const v of r.verdicts) if (inBounds(v.index, g.length)) byIdx[v.index] = v
    return g.flatMap((c, i) => byIdx[i] ? [{ ...c, verdict: byIdx[i].verdict, evidence: byIdx[i].evidence, preExisting: byIdx[i].preExisting, preExistingWhy: byIdx[i].preExistingWhy, blocksLand: byIdx[i].blocksLand, blocksLandWhy: byIdx[i].blocksLandWhy }] : (dropOnMiss ? [] : [c]))
  }))
  return out.filter(Boolean).flat()
}

async function verifyGroups(candidates) {
  // Round 1 — Sonnet. Missing verdict → drop (unverified never reaches the report).
  const round1 = await verifyOnce(candidates, PIN, "verify", "Verify", true)
  const refutedR1 = round1.filter(c => c.verdict === "REFUTED")
  const settled = round1.filter(c => c.verdict !== "REFUTED")
  if (refutedR1.length === 0) return round1
  // Round 2 — Opus adjudicates only the refutes, one agent per distinct location.
  // `escalated` counts those Opus AGENTS (distinct refuted locations) — the
  // cost-relevant unit, matching verifierAgents — not the candidate count. A
  // candidate Opus cannot re-judge keeps its round-1 REFUTED (dropOnMiss=false).
  escalatedRefutes += new Set(refutedR1.map(loc)).size
  const adjudicated = await verifyOnce(refutedR1, ADJUDICATE_PIN, "adjudicate", "Adjudicate", false)
  return settled.concat(adjudicated)
}

// ─── Find (barrier) → group → Verify. The barrier is the deliberate trade
// for cross-finder location merge: grouping needs every finder's output, so
// wall-clock += max(finder) − median(finder) vs the old per-finder pipeline.
const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles)
  .map(a => ({ ...a, kind: "correctness" }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: "cleanup" })))

const finderOuts = await parallel(FINDERS.map(f => () =>
  agent(FINDER_PROMPT(f), { ...PIN, label: f.label, phase: "Find", schema: CANDIDATES_SCHEMA }).then(r => {
    if (!r) return []
    log(f.label + ": " + r.candidates.length + " candidates")
    return ingest(r.candidates, P.perAngle, f.kind)
  })
))
const allCandidates = finderOuts.filter(Boolean).flat()
let candidatesSeen = allCandidates.length

let verified = await verifyGroups(allCandidates)

// ─── Sweep (xhigh/max): one fresh finder hunting only for gaps ───
if (P.sweep) {
  phase("Sweep")
  const knownBlock = verified.length > 0
    ? verified.map(c => "- " + loc(c) + " — " + c.summary).join("\n")
    : "(none)"
  const sweep = await agent(
    "## Code-review sweep — gaps only\n\n" + SCOPE_BLOCK + "\n" +
    "## Already-found candidates (do NOT re-derive or re-confirm these)\n" + knownBlock + "\n\n" +
    DIFF_READ_INSTRUCTION + " and re-read the enclosing functions, looking ONLY for defects not already listed. " +
    "Focus on what the first pass tends to miss: " + SWEEP_GAP_FOCUS + "\n\n" +
    "Surface up to " + SWEEP_MAX + " additional candidates. If nothing new, return an empty list — do not pad.\n\nStructured output only.",
    { ...PIN, label: "sweep", phase: "Sweep", schema: CANDIDATES_SCHEMA }
  )
  if (sweep && sweep.candidates.length > 0) {
    const sliced = ingest(sweep.candidates, SWEEP_MAX, "correctness")
    candidatesSeen += sliced.length
    log("sweep: " + sliced.length + " candidates")
    const sweepVerified = await verifyGroups(sliced)
    verified = verified.concat(sweepVerified)
  }
}

const surviving = verified.filter(c => c.verdict !== "REFUTED")
const refuted = verified.filter(c => c.verdict === "REFUTED")
log("Verify done: " + verified.length + " verified → " + surviving.length + " kept, " + refuted.length + " refuted")

const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: candidatesSeen,
  verifierAgents,
  escalated: escalatedRefutes,
  verified: verified.length,
  refuted: refuted.length,
}

if (surviving.length === 0) {
  return {
    level: LEVEL, target: TARGET || undefined,
    summary: "No findings survived verification.",
    findings: [],
    stats,
  }
}

// ─── Synthesize: rank, merge semantic dupes, cap ───
phase("Synthesize")
// Correctness bugs outrank cleanup findings when the cap forces a cut;
// CONFIRMED outranks PLAUSIBLE within each group.
const rank = c => (c.kind === "cleanup" ? 2 : 0) + (c.verdict === "PLAUSIBLE" ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  "### [" + i + "] " + loc(c) + " (" + c.verdict + (c.kind === "cleanup" ? ", cleanup" : "") + ")\n" +
  c.summary + "\nFailure scenario: " + c.failure_scenario + "\nVerifier evidence: " + c.evidence + "\n"
).join("\n")

const report = await agent(
  "## Synthesis: final code-review report\n\n" +
  ranked.length + " findings survived independent verification (" + LEVEL + "-effort review). They are numbered [0]-[" + (ranked.length - 1) + "] below.\n\n" + block + "\n" +
  "## Instructions\n" +
  "Return decisions about findings BY INDEX — never re-emit finding text.\n" +
  "1. For each distinct defect, emit one decision with its index. When several findings describe the same defect (same root cause), keep one entry and list the others in its merge array.\n" +
  "2. Order decisions most-severe first. Correctness bugs always outrank cleanup findings.\n" +
  "3. Keep at most " + P.maxFindings + " decisions; omit the least severe beyond the cap.\n" +
  "4. Write a 2-3 sentence summary of the review.\n\nStructured output only.",
  { ...PIN, label: "synthesize", schema: REPORT_SCHEMA }
)

// Assembler invariants:
//   1. No silent drops while there is room: every verified finding either appears
//      (as primary or merge note) or is omitted only because the cap is full.
//   2. The displayed primary is the synthesizer's choice (d.index) — it picks the
//      best-described representative; we only escalate the verdict label when a
//      merged member is CONFIRMED.
//   3. The summary describes the report actually returned.
const decisions = report && Array.isArray(report.decisions) ? report.decisions : []
const seen = new Set()
const claim = i => (inBounds(i, ranked.length) && !seen.has(i) ? (seen.add(i), true) : false)
const findingVerdictFields = (c, merged = []) => {
  const candidates = [c, ...merged]
  const verdictSource = candidates.find(candidate => candidate.verdict === "CONFIRMED") || c
  const preExistingSource = candidates.find(candidate => candidate.preExisting === false) || c
  const blocksLandSource = candidates.find(candidate => candidate.blocksLand === true) || c
  return {
    verdict: verdictSource.verdict,
    kind: c.kind,
    evidence: verdictSource.evidence,
    preExisting: preExistingSource.preExisting,
    preExistingWhy: preExistingSource.preExistingWhy,
    blocksLand: blocksLandSource.blocksLand,
    blocksLandWhy: blocksLandSource.blocksLandWhy,
  }
}
const findings = []
for (const d of decisions) {
  if (findings.length >= P.maxFindings) break
  if (!claim(d.index)) continue
  const c = ranked[d.index]
  const merged = (Array.isArray(d.merge) ? d.merge : []).filter(claim).map(i => ranked[i])
  const also = merged.length > 0 ? " [same root cause also at: " + merged.map(loc).join(", ") + "]" : ""
  findings.push({ file: c.file, line: c.line, summary: c.summary + also, failure_scenario: c.failure_scenario, ...findingVerdictFields(c, merged) })
}
const usedDecisions = findings.length > 0
let backfilled = 0
for (let i = 0; i < ranked.length && findings.length < P.maxFindings; i++) {
  if (seen.has(i)) continue
  const c = ranked[i]
  findings.push({ file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, ...findingVerdictFields(c) })
  backfilled++
}
const summary = usedDecisions && report
  ? report.summary + (backfilled > 0 ? " (" + backfilled + " additional verified finding" + (backfilled === 1 ? "" : "s") + " appended unmerged.)" : "")
  : "Synthesis step was skipped or its decisions were unusable — returning verified findings ranked, unmerged."

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary,
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}
