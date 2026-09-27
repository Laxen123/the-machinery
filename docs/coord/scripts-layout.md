# The `scripts/` layout: import boundaries

The coordination tooling is a tree of small Node modules under `scripts/`. Where a module is allowed
to import from sounds like a style question. It is not: three separate mechanisms in this design run
a _copy_ of part of that tree somewhere else — a test scaffold copies it into a disposable scratch
repository, the generic core is lifted out as its own repository, and consumers outside the tree
import it by path — and each copy breaks in a different way when a module reaches across a line it
did not know was there. None of those breaks fails at the edit that caused it. Each one lands green
and detonates later, in an unrelated test or in a different repository, with a stack trace that
points at an innocent file. The rules below exist to move that failure back to the push that
introduced it.

The rules are numbered, and other documents and tools cite them by number, so the numbers are
stable. One gate enforces all four: see [The gate](#the-gate) at the end.

## Rule 1 — a non-test module under `scripts/` never imports outside `scripts/`

**Legal**

```js
// scripts/<tool>.mjs
import { readStdinResult } from './coord/stdin-read.mjs'; // a scripts/ sibling
import { readFileSync } from 'node:fs'; // a node builtin
```

**Illegal**

```js
import { X } from '../shared/src/schemas.ts'; // escapes scripts/
import { Y } from '../backend/src/thing.mjs'; // escapes scripts/
import { Z } from './test-helpers/fixture.mjs'; // into the never-copied test-helpers/ dir
```

Hook modules live under `scripts/hooks/`, so for this rule they are ordinary `scripts/` modules: a
hook importing a `scripts/` sibling never escapes the tree in either direction, and the gate does
not distinguish them. Code shared between hooks and command tools still lives at `scripts/` level
(for example `scripts/coord/stdin-read.mjs`), with `scripts/hooks/lib/loader-common.mjs`
re-exporting it for the hooks that want one import point. That is a layering habit, not something
the gate enforces.

### Why

`scripts/test-helpers/isolated-plan-repo.mjs` builds a fully self-contained scratch repository for
the suites that exercise the plan-moving, plan-editing and stamping tools. It copies **only the
non-test `.mjs` tool tree under `scripts/`, minus `test-helpers/`,** into that repository and runs
the COPIES, so that a tool which resolves paths from its own directory operates on the scratch
repository instead of the real one.

A relative import that escapes `scripts/` therefore resolves to nothing inside the scratch
repository, and the copied tool dies:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '<tmp>/scratch-work-XXXX/shared/src/schemas.mjs'
  imported from <tmp>/scratch-work-XXXX/scripts/<tool>.mjs
```

Widening the scaffold to copy more of the tree is the wrong side to fix. The constraint is cheap;
copying foreign trees (`.claude/`, application source) into every scratch repository is not.

### The trap this closes: detection used to be accidental

Before the gate, a violation only turned a suite red **if some copied tool's import chain happened
to reach the offending module.** Both halves of that were observed in one sitting: adding a bad
import to a module that a copied tool imports broke a stamping suite at once, while an identical bad
import in a module no copied tool reached had sat in the tree for a long time with nothing ever
failing. It surfaced only because a tree-wide scan was run after the first case burned someone.

So the real failure mode is **a latent break that lands green and detonates much later**, when some
unrelated change adds an import edge into the offending module. At that point the stack trace names
a temp directory and an innocent test file, not the import that caused it.

### Nested directories

Nested non-test directories (`scripts/lib/**`, `scripts/coord/**`) are copied by the scaffold too —
its `copyScriptsTree` recurses into every nested directory **except `test-helpers/`**. So `./lib/…`
is legal and `./test-helpers/…` is not, and the gate enforces exactly that split. The two cannot
drift: the scaffold imports the list of uncopied directories (`UNCOPIED_ROOT_DIRS`) from the gate
module itself rather than keeping its own copy.

This is not the scaffold-widening rejected above. That boundary is about copying FOREIGN trees into
every scratch repository; a nested directory under `scripts/` is inside the boundary the rule
defends.

## Rule 2 — a CLI entry guard compares URL to URL, never a hand-built `file://` string

A `scripts/*.mjs` module that is both importable and runnable ends with a guard, so `main()` fires
when the file is run as a command but not when a test imports it. **Use `pathToFileURL`:**

```js
import { pathToFileURL } from 'node:url';
// …
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
```

The reverse direction is equally fine, because both sides are then native paths:

```js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
```

**Illegal:** building the URL by hand from `process.argv[1]` (`'file://' + process.argv[1]`). On
Linux the two strings happen to match. **On Windows `process.argv[1]` is a backslash path with a
drive letter while `import.meta.url` is `file:///C:/…`, so they never match** — `main()` is simply
never called. The module loads, prints nothing, and exits 0.

**Why this is worse than an ordinary bug: the failure is indistinguishable from success.** A gate
that never runs and a gate that finds nothing produce the same empty output and the same exit 0. In
the deployment this layout comes from, four modules carried the bad shape at once, two of them live
push gates that had silently stopped gating on every Windows push. It surfaced only because one of
them had a unit test asserting that the gate blocks, and that test went red.

Enforced by the same gate as Rule 1 (`kind: 'hand-built-entry-url'`), scanned with comments
stripped so a module may explain the trap in prose.

## Rule 3 — `scripts/coord/` may import only its own siblings and `node:` builtins

`scripts/` is split into layers. `scripts/coord/` is the generic coordination core — no
project-specific vocabulary — and `scripts/project/` is the adopting project's own layer, which may
depend on `coord/` freely. The direction is one-way: a non-test module under `scripts/coord/` may
import **only** `scripts/coord/**` and `node:` builtins. A bare package specifier (`'zod'`,
`'vitest'`) is legal from a core module only when it appears in `COORD_BARE_IMPORT_ALLOWLIST` (in
`scripts/assert-scripts-self-contained.mjs`). The list **starts empty**, and every addition needs a
one-line reason written right there — the same "nothing to grandfather" stance Rule 1 takes.

### Why

The core is meant to be lifted out as-is: a fresh checkout of `scripts/coord/` alone, with nothing
under `scripts/project/` or plain `scripts/`, must still load and run its own tests. A core module
reaching back into `../done-worktree-lib.mjs` or `../project/deploy.mjs` is legal under Rule 1 (it
never escapes `scripts/`), but it silently re-creates exactly the dependency this split exists to
cut. That break would surface only later, in the separate repository, far from the edit that caused
it. Rule 3 catches it at the push that introduces it instead.

**Legal**

```js
// scripts/coord/review-markers.mjs
import { readFileSync } from 'node:fs'; // a node builtin
import { buildPlanIdIndex } from './plan-id-index.mjs'; // a core sibling
```

**Illegal**

```js
import { SEAM } from '../done-worktree-lib.mjs'; // outside scripts/coord/ — Rule 3
import { SERVICES } from '../project/deploy.mjs'; // project layer, not core — Rule 3
import { z } from 'zod'; // bare specifier, not on COORD_BARE_IMPORT_ALLOWLIST — Rule 3
```

An import that escapes `scripts/` entirely from inside `scripts/coord/` (e.g.
`../../shared/src/schemas.ts`) is still reported as Rule 1's `escapes-scripts`. Rule 3 governs only
the boundary BETWEEN `scripts/coord/` and the rest of `scripts/`, never the outer one Rule 1 owns. It
also applies in one direction only: a `scripts/project/` module or a plain `scripts/*.mjs` importing
from `scripts/coord/` is unaffected.

### The three layers

| Layer                | What lives there                                                | May import                                 |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `scripts/coord/**`   | the generic coordination core, lifted out as-is                 | `scripts/coord/**` + `node:` builtins only |
| `scripts/project/**` | the adopting project's own registries, plugins and tools        | anything under `scripts/`                  |
| `scripts/*.mjs`      | path-invoked command entry points, and anything not yet layered | anything under `scripts/`                  |

A module that is BOTH a library and a command invoked by path does not choose: the library moves to
`scripts/coord/`, and a three-line path-compat shim stays at `scripts/<name>.mjs` importing and
running its exported entry point. That is why a `scripts/<name>.mjs` path that still resolves is not
evidence the module still lives there — read the file. A shim re-exports only the command entry, so
an importer that asks the old path for any other named export resolves fine and then dies at link
time with `does not provide an export named …`; import the module's real home instead.

### What Rule 3 does NOT catch, and what to check instead

Rule 3 is an IMPORT check. It is blind to four other ways a module can depend on its own location,
and none of them fails loudly:

1. **A project string literal inside a core module.** Rule 3 green does not mean generic. Grep the
   literals; route project facts through the project's configuration seam instead of hard-coding
   them.
2. **A fixed-depth path walk.** `join(dirname(fileURLToPath(import.meta.url)), '..')` is correct at
   exactly one depth; move the module one level down and it resolves to `scripts/` instead of the
   repository root. Nothing throws: readers fail open and globs match nothing, so the result is a
   SILENT NARROWING. Use `repoRootFrom` / `scriptsFileFrom` / `findScriptsDir` from
   `scripts/coord/scripts-anchor.mjs`, which anchor on the `scripts/` directory NAME. Never a marker
   file and never an existence probe: the isolated scaffold copies only the `scripts/` tree, so
   there is no configuration file and no `.git` to find there.
3. **An ASSET the import graph cannot see.** A test reporter resolved with
   `new URL('./reporter.mjs', import.meta.url)` is loaded by the test runner, never imported, so the
   graph never links the two and a move separates them — after which every run that attaches the
   reporter fails to START. Same class: a spawned sibling command, a committed data or script file
   beside the tools. Sweep for `new URL('./…')`, for `join(<own dir>, '<literal>')`, and for a spawn
   path built from the module's own directory.
4. **The module's PATH written as prose or as a command string** — a document line, a hook's
   `node scripts/<name>.mjs` invocation, a module's own header comment, an error message telling the
   reader what to run. `node scripts/coord/module-graph.mjs census` covers the invocation half; the
   prose half is a plain grep.

A test carries the same four hazards, with one of its own on top: **a test that asks for a module by
basename means the module, not the layer it sat in the day the test was written.** Use `scriptFile`
from `scripts/test-helpers/repo-script-path.mjs` for the real tree and the scaffold's `toolPath` for
a copied one — both resolve `scripts/coord/` FIRST, so a reader gets the module and never the shim.

## Rule 4 — a file outside `scripts/` imports only a `scripts/` path that exists

Rule 1 is one-way: it catches a `scripts/` module reaching OUT, and is blind to the opposite break.
When modules move from the flat layer into `scripts/coord/`, a path-compat shim is left only for a
module invoked by PATH as a command — never for an import specifier. So a consumer OUTSIDE `scripts/`
(a test-runner config, a front-end build script) that imports the pre-move flat path loads fine at
author time, because the move never ran it, and dies with `MODULE_NOT_FOUND` the next time something
actually invokes it.

Rule 4 closes that direction: a relative import from outside `scripts/` that resolves INTO
`scripts/` must point at a file that exists on disk. It scans every git-tracked `.ts`, `.tsx`,
`.mjs`, `.js` and `.cjs` file outside `scripts/`, honouring CommonJS `require(…)` as well as ESM
`import`, with comments and string literals blanked so an example inside prose never fires. A
violation (`kind: 'dead-scripts-import'`) names the `scripts/coord/` alternative when a file with the
same basename lives there — the common case after a move — so the fix is usually one repoint.

## The gate

All four rules are one mechanical gate: **`scripts/assert-scripts-self-contained.mjs`**, wired into
the pre-push hook (`scripts/hooks/pre-push-core.sh`) through `run_range_guard`. Run it by hand any
time:

```bash
node scripts/assert-scripts-self-contained.mjs      # one clean line, or every offender by rule
```

How it differs from the neighbouring diff-scoped gates:

- **It scans the working tree, not a committed diff, and has no allowlist.** There is nothing to
  grandfather — the tree was at zero violations when the gate landed — and a few hundred file reads
  are cheaper than the diff they would replace, so it always reports ground truth and a violation
  cannot hide behind a stale range.
- **The pushed range is used for one thing only:** skipping the Rules 1–3 scan when the push touches
  no `scripts/` file. A git failure while checking the range scans rather than skips.
- **Rule 4 is never range-skipped.** Its break lives on the consumer side, outside `scripts/`, so
  "this push touches no `scripts/` file" is exactly the shape where it matters.
- **An incomplete Rule 4 scan says so.** If the tracked-file listing fails, or a target cannot be
  checked for a reason other than "it does not exist", the scan reports itself SKIPPED rather than
  clean and still exits 0 — a transient git or file-system problem must not block every push on the
  machine, but "I could not check" must never read the same as "I checked and found nothing".

What Rules 1–3 scan: every `scripts/**/*.mjs` except `*.test.mjs` and everything under
`scripts/test-helpers/` — the two categories the scaffold never copies, which are therefore free to
import anywhere (test suites import hook modules deliberately, to test them). What they flag: any
relative specifier (in `from`, a bare `import`, `export … from`, or a dynamic `import()`) that
resolves outside `scripts/` (`escapes-scripts`), into `scripts/test-helpers/` from outside it
(`test-helpers`), outside `scripts/coord/` from inside it (`coord-boundary`), or a bare specifier
from inside `scripts/coord/` that is not on the allow-list (`coord-bare-import`); plus the
hand-built entry guard of Rule 2 (`hand-built-entry-url`). `node:` builtins are always legal, and
bare package specifiers are ignored outside `scripts/coord/`.

## What this costs

The rules forbid some imports that would work perfectly well in the real repository today, and the
fix — moving a shared piece into the right layer, or passing it in as a parameter — is occasionally
more work than the one-line import it replaces. That is the whole trade: a small, immediate,
explained refusal at push time, instead of a latent break that detonates later in a place that gives
no hint of its cause. The gate is also narrow on purpose. It proves that imports resolve inside the
tree a copy will carry; it does not prove that a core module is free of project vocabulary, path
assumptions or invisible assets, which is why Rule 3's list of blind spots is part of the rule and
not a footnote.

See also [`hooks.md`](hooks.md) § The thin-dispatcher pattern, for why hook logic lives in ordinary
modules under this tree in the first place, and § Diff-scoping, for the range-scoped gates this one
deliberately differs from.
