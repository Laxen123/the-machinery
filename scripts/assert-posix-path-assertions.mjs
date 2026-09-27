#!/usr/bin/env node
// Platform-dependent test-assertion gate for the `scripts/**/*.test.mjs` battery (plan 2490) AND,
// since plan 2853, the Python test tree under `backend/scripts/**/*.py`. The module is NOT renamed
// for the wider scope — see the WAIVER MARKERS note near the end of this header for the same
// non-rename call on the waiver comment.
//
// THE CLASS. Cloud drains run on Linux; local sessions run on Windows. A test that asserts a path
// SPELLING passes in one place and fails in the other, and the author never sees it. Worse, the
// failure surfaces at an arbitrary later time on an UNRELATED plan: the plan-2273 import-closure
// selector pulls a test into the battery because the pushed diff touched something the test
// transitively imports, so the session that pays the cost is not the one that introduced the bug
// and the bisect points at the innocent plan's diff. That is exactly what happened when plan 2478's
// a lock-path test (green in the cloud, 2/4 red on every Windows checkout) blocked plan
// 2462's push. This gate owns the class so the next one cannot land.
//
// THE THREE SHAPES IT BLOCKS — (1) and (2) are verbatim plan-2478 regressions; (3) was added by
// plan 2552 after the class recurred a THIRD time (plans 2501, 2503, then the 2026-07-27
// pass-cache-kernel red) through a gap this header used to bless as clean:
//
// SCOPE (plan 4113): shapes (1)-(3) below are **JS only**. They live in `analyze()`, whose entry
// regex `ASSERT_EQ_RX` matches JS `assert.*(...)` call syntax, and `analyzeFor` dispatches `.py`
// files to `analyzePython`, which implements shapes (4)/(5) only and does no equality-assertion
// scanning at all. So a Python instance of this path-spelling class — a bare `assert x == y` with
// a POSIX literal expected side against a `Path`-derived actual — is invisible to this gate
// whatever the operands look like, and is caught by REVIEW and by the local Windows land
// preflight instead, which is where plan 4113's instance was found.
//
//   (1) `posix-literal-expected` — an equality assertion whose EXPECTED side is a drive-less
//       absolute string literal, compared against a path-derived actual:
//           const common = resolveCommonDirPath({ anchor: '/somewhere', _exec: () => '.git\n' });
//           assert.equal(common.replaceAll('\\', '/'), '/somewhere/.git');
//       On Windows a leading slash is drive-RELATIVE, so `resolve('/somewhere', '.git')` yields
//       `C:\somewhere\.git` and the assertion can only ever hold on Linux. FIX: derive the
//       expectation the same way the actual is derived, or pin the platform by injecting
//       `path.posix` / `path.win32` into the unit under test (the plan-2489 pattern).
//
//   (2) `unnormalized-path-compare` — an equality assertion between two identifiers both bound to
//       path-producing expressions, compared raw:
//           const fromMain = resolveCommonDirPath({ anchor: mainDir });
//           const fromWorktree = resolveCommonDirPath({ anchor: wtDir });
//           assert.equal(fromWorktree, fromMain);
//       git itself is the source here: on Windows it reports the main clone's common dir with `/`
//       and a linked worktree's with `\`, so a raw compare fails on a pair that IS the same path.
//       FIX: `assertSamePath(a, b)` from scripts/test-path-assert.mjs.
//
//   (3) `join-rooted-literal` — an equality-assertion operand containing a native `join(…)` whose
//       FIRST argument is a drive-less absolute string literal:
//           assert.equal(resolveCacheDir(git, 'gate-pass-cache'), join('/repo/.git', 'gate-pass-cache'));
//       This LOOKS portable — the expectation is derived through the native `path` module, not
//       hardcoded — but `join` and `resolve` disagree on exactly this input:
//           join('/repo/.git', x)     =   \repo\.git\…   (stays drive-LESS)
//           resolve('/repo/.git', x)  = C:\repo\.git\…   (prepends the current drive)
//       so the fixture is silently COUPLED to the implementation still building its path with
//       `join`. Every `resolveCommonDirPath` / `resolveLockPath` migration (plans 2478, 2489,
//       2507) flips an implementation from join-shaped to resolve-shaped and reds the fixture on
//       Windows only — POSIX cannot see it, because there the two primitives agree exactly.
//       FIX: anchor the fixture — `const anchor = resolve('/c')`, then feed `anchor` to BOTH the
//       unit under test and the expectation (`join(anchor, …)`). A drive-QUALIFIED anchor makes
//       `join` and `resolve` agree on every platform, so the fixture survives any future
//       primitive migration instead of merely tracking today's one.
//
//       Judged UNCONDITIONALLY on the operand, with no condition on the other side: measured
//       against the live corpus (2026-07-27) every such operand was a latent or live instance and
//       zero legitimate ones existed, and an other-side condition would let the real
//       `assert.deepEqual(installCwds, [join('/main', …)])` array shape escape.
//
//       KNOWN BOUND — a `resolve('/…', …)`-rooted expectation is NOT flagged. It is the landed
//       remedy for incident #3 and agrees with the resolve-shaped implementations the codebase is
//       migrating TOWARD; flagging it would indict the fix. It can only re-red under a
//       resolve→join BACK-migration, which is against the direction of travel. The anchor idiom
//       above is robust to both directions and is what the corpus was migrated to.
//
// WHAT IT DELIBERATELY DOES **NOT** FLAG (each of these was measured against the real corpus, and
// flagging it would make this gate a false-positive factory rather than a gate):
//   • A drive-less absolute literal used as an INPUT — `resolveGuardRanges('/repo', …)`,
//     `{ repoRoot: '/repo' }`, `loadHobbyEnv('/nonexistent-root-for-test')`. A fixture anchor is
//     not an assertion about a spelling; only the compared-against side is.
//   • A `resolve`-rooted derivation — `const anchor = resolve('/somewhere')`,
//     `assert.equal(d, resolve('/repo/.git', 'x'))`. `resolve` drive-qualifies a rooted literal
//     exactly as the implementations it is compared against do, so these hold on every platform;
//     `resolve('/x')` is in fact the RECOMMENDED fix for shape (1) and the gate must not flag its
//     own remedy. NOTE this exemption is `resolve`-ONLY. It used to be written as a blanket
//     "derivation through the native `path` module", with `join('/root', …)` as its own example
//     and "both sides drive-relativize identically" as the rationale — which is FALSE for `join`
//     (it stays drive-less where `resolve` drive-qualifies) and is precisely the hole incident #3
//     came through. That is now shape (3) above.
//   • A URL/route path — `assert.equal(r.path, '/v1/claude_code/routines/…')`. Nothing on the actual
//     side is path-derived, so the literal is never mistaken for a filesystem path.
//
// EXEMPTIONS (in precedence order, all checked per violation):
//   • The enclosing `test(…)` block explicitly pins a platform — `_path: posix`, `_path: win32`, or
//     a `posix.` / `win32.` call. Pinning makes the assertion platform-INDEPENDENT, which is the
//     pattern the plan prescribes for validating Windows semantics from any host; a POSIX literal
//     is then the correct expectation, not a bug.
//   • A waiver comment `// path-assert-ok: <reason>` on the violating line, or anywhere in the
//     contiguous comment block directly above it. The reason is REQUIRED (a bare marker does not
//     waive) so the next reader learns why.
//   • `scripts/assert-posix-path-assertions.test.mjs` — this gate's own test file, whose fixtures
//     must contain violating text by construction. Structural, mirroring assert-color-tokens'
//     `__tests__/**` exemption; it is the ONLY path-based exemption and there is no allowlist file.
//
//   (6) `ambient-git-state` (plan 3622) — the THIRD axis, and the one neither of the other two can
//       see: an assumption about what the host FILESYSTEM CONTAINS. Shapes (1)-(3) judge a path
//       SPELLING and (4)-(5) judge platform SYMBOLS; this judges ambient STATE.
//       SCOPE: **JS only** (`scripts/**/*.test.mjs`). `analyzePython` implements shapes (4)/(5)
//       and does NOT call this one — every pattern below is written against JS `//` comments and
//       `const`/`let`/`var` binding syntax. The Python tree has the same class (plan 3622's own
//       sweep found three live instances under a planted ancestor repo) and the same remedy — the
//       `no_repo_dir` fixture in the project's data pipeline conftest — but a Python
//       instance is caught by review and by that fixture, NOT by this gate. Do not read the
//       module-level "AND the Python test tree" scope line above as covering this shape.
//           test('exits 0 outside any git repo', () => {
//             const root = mkdtempSync(join(tmpdir(), 'cswl-nogit-'));   // ← flagged
//       `mkdtempSync(join(tmpdir(), …))` is outside a git repository only while the MACHINE has no
//       repo above `tmpdir()`. A sandbox with a stray `/tmp/.git`, a TMPDIR under a checkout, or a
//       CI image that git-inits its work root all break that, and — exactly like the path shapes —
//       the break lands on whichever UNRELATED plan the plan-2273 import-closure selector next
//       pulls the test into. That is not hypothetical: it is the plan-3595 cloud drain, whose
//       scripts-battery gate went red on `main-checkout-clean-guard.test.mjs` and held 4 finished
//       commits for ~3.5h (`output/reports/2026-09-01-drain-3595-stall-structural-root-cause.md`).
//       The failure has TWO faces and the quiet one is worse: `install-main.test.mjs` went hard RED
//       under a planted ancestor repo, while `clear-stale-worktree-lock.test.mjs`,
//       `gate-pass-cache.test.mjs` and `git-maintenance-guard.test.mjs` all still PASSED — for the
//       wrong reason, silently exercising the has-a-repo branch, leaving the invariant each is
//       NAMED for with no coverage at all. A gate is the only thing that sees that second face.
//       FLAGGED ON: a test whose own title (or the comment block directly above it) claims an
//       outside-a-repo condition, whose root is bound from a bare `mkdtempSync`, with no cover.
//       COVERS (all keyed to the BINDING, never file-wide — `gate-pass-cache.test.mjs` git-inits
//       its other roots in the same file): the root is `git init`ed; a `.git` marker is planted in
//       it; `GIT_CEILING_DIRECTORIES` fences the walk; or the root simply is not an `mkdtempSync`
//       binding at all — which is what `test-helpers/no-repo-root.mjs`'s `makeNoRepoRoot()` (the
//       landed remedy) makes true, so the fixed corpus goes clean with no waiver anywhere.
//       FIX: `makeNoRepoRoot()`, or `git init` the root when a repo is what the test really wants,
//       or `// ambient-git-ok: <reason>`.
//       KNOWN BOUND — a test that makes the assumption WITHOUT saying so in its title or header
//       comment is NOT flagged. Measured, and accepted for the same reason shape (3)'s and (4)'s
//       bounds are: a file-wide phrase scan hits 17 corpus files (all of them error-STRING
//       assertions like `/fatal|not a git repository/`, which assert nothing about the filesystem),
//       while the title-and-header scoping returns exactly 4 — every one a true positive. A false
//       positive across this corpus is far more expensive than this false negative, and a test
//       whose name does not state the condition it depends on has a naming problem first.
//
// HOW IT RUNS. Range-scoped like the rest of the `run_range_guard` family (assert-color-tokens,
// assert-seed-io-seam, …): only lines ADDED in the pushed range can block, so the pre-existing
// corpus never gates an unrelated push. Unlike those guards it needs WHOLE-FILE context — shape (2)
// is only decidable by knowing where an identifier was bound, and the platform-pin exemption is
// only decidable by knowing the enclosing test block — so it reads each touched file's post-image
// at the range tip (`readFileAtTip`, the same committed-ref-never-the-working-tree discipline) and
// then keeps only the violations whose line text was added by the range. Fail-open SKIP on an
// unresolvable base or a failed read, exactly like its siblings: the done-worktree land re-runs it.
//
// `--all` scans the whole working-tree corpus instead (the plan-2490 acceptance-2 sweep, and the
// way to check the gate is not a false-positive factory after changing a pattern).
//
// PYTHON SHAPES (plan 2853) — (4) and (5), added when this gate's diff-scoped-corpus-sweep-and-
// waiver machinery turned out to be exactly the right shape for a second, unrelated failure class:
// Python tests that fake `sys.platform` (or `os.name`) without faking the PLATFORM SYMBOLS the
// faked branch actually consumes. The motivating incident: `_pp_proc.kill_tree` calls
// `os.killpg(os.getpgid(pid), signal.SIGKILL)`. Python evaluates a call's arguments before making
// the call, so on a Windows host `signal.SIGKILL` — which does not exist there — raised an
// `AttributeError` AFTER `os.getpgid` had already run but BEFORE `os.killpg` was ever reached, and
// `kill_tree`'s own `except Exception: pass` swallowed it silently. The test
// (the project's data pipeline `test_pp_proc.py`) monkeypatched `sys.platform` to
// `"linux"` to exercise the POSIX branch, and monkeypatched `os.getpgid`/`os.killpg` too — but
// WITHOUT `raising=False`, so on Windows the `setattr` calls themselves raised before either fake
// ever took effect. It surfaced as a missing `calls["killpg_args"]` key while `calls["getpgid_pid"]`
// WAS present — reads exactly like a bug in `killpg`, and is really a missing constant several calls
// upstream. That is why a setattr-only rule is not sufficient on its own: it catches the `setattr`
// that lacks `raising=False` (shape 4), but the *reference* to a platform-only symbol with no
// `setattr` involved at all — the bare `signal.SIGKILL` used as an expected VALUE in the assertion —
// needs a rule that looks at REFERENCES, not calls. Hence shape (5).
//
//   (4) `py-unguarded-platform-setattr` — a `monkeypatch.setattr` targeting a platform-only `os` /
//       `signal` / `subprocess` attribute WITHOUT a `raising=False` argument:
//           monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid)
//       On the platform that lacks the attribute, `setattr` itself raises `AttributeError` before
//       the fake ever takes effect. Matches both the member-expression target form (`_pp_proc.os`,
//       `lib.os`, bare `os`/`signal`/`subprocess`) and the dotted-string form
//       (`monkeypatch.setattr("os.getpgid", …)`). Judged SYMBOL-keyed, not fake-keyed: it does NOT
//       require the file to also fake `sys.platform` first. Corpus contact showed the fake-platform
//       condition buys nothing — a `setattr` of `os.getpgid` without `raising=False` raises on
//       Windows whether or not `sys.platform` was faked in the same test — and costs a dependency
//       this rule does not need. Symbol-keyed is strictly more correct and had zero measured false
//       positives against the corpus. FIX: add `raising=False`, or skip the test on the platform
//       that lacks the symbol.
//
//   (5) `py-uncovered-platform-symbol` — a DIRECT reference to a platform-only symbol (a
//       module-qualified attribute access like `signal.SIGKILL` / `os.getpgid` /
//       `subprocess.CREATE_NO_WINDOW`, including through a dotted prefix like `_pp_proc.os.getpgid`;
//       or an `import fcntl` / `import msvcrt` of a platform-only MODULE) with NO cover anywhere in
//       the same file. This is the shape a setattr-only rule cannot see: `signal.SIGKILL` used as a
//       bare expected value, never itself the target of a `monkeypatch.setattr`, is still not
//       evaluable on the platform that lacks it. A REFERENCE is never a bare identifier — a local
//       variable named `grp` (real corpus shape, `test_2223_twin_fold_engine.py:252`) must not be
//       mistaken for `import grp`; only a module-qualified `<mod>.NAME` or a line-initial
//       `import`/`from` statement counts. A COVER is any of: a `monkeypatch.setattr` naming that
//       SAME attribute WITH `raising=False`; a `pytest.mark.skipif(...)` mentioning `sys.platform` or
//       `os.name` (file-level — the whole file already will not run on the wrong platform, so nothing
//       else in it needs its own guard); a module-level `pytestmark = ...skipif...` (the same shape,
//       module-scoped, and matched by the same pattern as the decorator form); a bare, MODULE-LEVEL
//       `pytest.skip(...)` mentioning the same (the `allow_module_level=True` collection-time-skip
//       shape — also file-level, since it IS the whole-file skip); `pytest.importorskip("<that
//       module>")`; or a `getattr(<mod>, "<NAME>", …)` / `hasattr(<mod>, "<NAME>")` guard naming it. A
//       `pytest.skip(...)` call sitting INSIDE a `def` block is judged differently — see the second
//       KNOWN BOUND bullet below.
//
//   Both directions, symmetric, same shapes and message format with the direction named in each
//   `detail` string ("POSIX-only — absent on Windows" / "Windows-only — absent on Linux") — the
//   POSIX-only tables protect the Windows gate (every local dev host on this machine), the
//   Windows-only tables protect the Linux cloud gate (the cloud drains). Operator ruling
//   2026-08-05, verbatim: "Yes, both directions."
//
//   Every symbol in the platform tables (below, near `PY_MODULE_TABLES`) was verified with
//   `hasattr()` on BOTH platforms before being added — see the header of that table and
//   `scripts/assert-posix-path-assertions.test.mjs` for the measured evidence. A symbol that exists
//   on BOTH platforms (`signal.SIGTERM`, `os.kill`) must never appear in either table: that exact
//   trap is why the tables are measured rather than guessed, and why they carry a standing warning
//   to keep measuring on every future addition.
//
//   KNOWN BOUNDs for (4) and (5), same "measured, not merely postulated" discipline as shape (3)'s:
//     • The `raising=False` setattr cover and the skipif/pytestmark/module-level-`pytest.skip`/
//       importorskip cover are judged FILE-level, not per-test-function. A file with one skipif'd test
//       and one unguarded test passes whole. Deliberate: a fixture or `conftest.py` can legitimately
//       supply the `raising=False` setattr or the skip from OUTSIDE the test function that consumes
//       it, and a false positive across a 753-file Python corpus is far more expensive than this false
//       negative. The getattr/hasattr cover is scoped to its innermost enclosing `def` instead — see
//       the REVIEW-DRIVEN REFINEMENTS note below — and a `pytest.skip(...)` CALL sitting INSIDE a
//       `def` is scoped the SAME way (the SECOND REVIEW PASS note further below): it is a runtime
//       statement that only ever skips the one test it executes inside, unlike a decorator or a
//       module-level collection-time skip, so treating it as file-wide let one test's unconditional
//       skip silence an unrelated test's real violation elsewhere in the same file.
//     • The diff filter (same `violationsIntroduced` used by the JS shapes, below) matches on ADDED
//       line text, so a diff that DELETES a cover without touching the reference line does not
//       report. Same residual the JS arm already carries for its own exemptions.
//     • Shape (5) cannot see a platform-only symbol reached DYNAMICALLY — `getattr(os, name)` with a
//       computed `name` — only a literal module-qualified attribute or a literal import statement.
//
//   REVIEW-DRIVEN REFINEMENTS (2026-08-05, same plan) — six corpus-measured gaps closed together
//   because they touch the same handful of functions:
//     • Comments are stripped from EVERY line before shape (5) scans it, so `# os.getpgid is absent
//       on Windows` no longer reads as a live use (`isCommentLine` alone only catches a WHOLE-line
//       comment). Safe with a `#` inside a string: the comment boundary is found on the
//       string-BLANKED view of the line (`stripPyStringLiterals` is length-preserving), so a `#` that
//       survives blanking can only be a genuine comment marker.
//     • The skipif/pytestmark/importorskip file-level cover now ALSO exempts shape (4): a
//       `monkeypatch.setattr` inside a test the whole file already skips on the wrong platform needs
//       no `raising=False` of its own.
//     • `from os import getpgid` / `from signal import SIGKILL, SIGUSR1` and `import os as o` /
//       `import signal as sig` are now tracked — a from-import binds the imported NAME to that
//       module's symbol (flagged at the import statement itself, since Python evaluates it eagerly:
//       on the platform that lacks the symbol the import fails before the test body ever runs — and
//       at any later bare use of that name too); an `import X as Y` alias resolves through to its
//       canonical module wherever `Y.symbol` appears, exactly like `X.symbol` would. Both are parsed
//       off literal import/from statements only, never a bare-word scan, so a local variable sharing
//       a name (the `grp` pin above) still cannot be mistaken for one.
//     • A getattr/hasattr cover is now scoped to its enclosing `def` block, unlike the setattr/skip
//       covers above (deliberately file-level, per the KNOWN BOUND). A getattr/hasattr call is a
//       PROBE, not a mutation or a collection-time skip: it proves the symbol's existence was
//       checked, not that any later access is actually gated on the result, so trusting it file-wide
//       measurably let a probe in one test silence an unguarded access in a wholly unrelated one.
//     • One setattr call missing `raising=False` used to also read as its own shape (5) reference on
//       the same line — one offence, two findings. Shape (5) now skips a reference already reported
//       as an unguarded setattr on that exact line; a different line still reports separately.
//     • The cover detectors used to each `lines.join('\n')` and regex the RAW text independently —
//       three full-file passes, and a comment or a fixture string containing e.g.
//       `pytest.importorskip("fcntl")` as TEXT could counterfeit a real cover. They now share one
//       per-line comment-stripped pass (computed once per file) instead of each re-deriving it, and
//       read from that tokenized form rather than the raw source.
//
// SECOND REVIEW PASS (2026-08-05, same plan) — the refinements directly above were applied to SOME
// detectors and not others, leaving an asymmetry a second review pass measured and closed:
//     • The tokenized (comment-stripped, string-blanked) view above was not actually reaching the
//       setattr scanner, the importorskip cover, or the skipif/skip cover — each still scanned raw or
//       partially-raw text, so a `monkeypatch.setattr(...)` written inside a COMMENT still counted as a
//       real call, and a comment or fixture STRING containing text like `raising=False` or
//       `pytest.importorskip("fcntl")` could still counterfeit a cover in the OTHER direction. Every
//       scanner and cover detector now routes through one shared primitive, `scanCallSites` — the call
//       SITE is matched on the blanked view, its arguments read from the comment-stripped-but-
//       string-preserved view — computed once per file and threaded through all of them.
//     • Alias resolution (the `import os as _os` handling above) reached reference detection but not
//       the setattr-target resolver or the getattr/hasattr cover detector, so an ALIASED setattr or
//       guard was neither flagged nor honoured as a cover. Both now take the same `aliasMap` reference
//       detection already built. A comma-joined `import os as a, signal as b` — previously silently
//       dropping every alias after the first — now populates the alias map for every piece.
//     • `async def` did not match the def-scanner at all, so every async test collapsed into function
//       span -1 and shared ONE non-scope with every other async test in the file; nested `def`s were
//       found as their own spans but `pyEnclosingSpan` returned the OUTERMOST match instead of the
//       innermost. `PY_DEF_RX` now accepts an optional `async` prefix, and `pyEnclosingSpan` picks the
//       span with the latest start among those containing the line.
//     • A parenthesised multi-line `from` import (`from signal import (\n    SIGKILL,\n)`) parsed as
//       nothing; a from-import whose captured list has more `(` than `)` is now joined with subsequent
//       lines (capped, mirroring every other continuation join in this file) before being split.
//     • A runtime `pytest.skip(...)` CALL sitting inside a test body used to be judged by the same
//       file-level rule as a `pytest.mark.skipif` decorator, so one test's unconditional skip could
//       silence an unrelated test's real violation elsewhere in the file. It is now scoped to its
//       enclosing function (mirroring the getattr/hasattr guard's own scoping); a `pytest.skip(...)`
//       OUTSIDE every function (the `allow_module_level=True` collection-time-skip shape) remains
//       file-wide, since that IS what it does at runtime.
//     • The `--all` corpus walker excluded every dot-directory, but `inScope` and the `:(glob)` git
//       pathspec both admit one (git's `**` matches dotfiles like any other segment) — the walker now
//       excludes only the specific non-source directories (`node_modules`, `__pycache__`, `.venv`),
//       matching what the diff-scoped gate actually judges. It also used to `.sort()` its own return at
//       EVERY recursion level; sorting now happens once, at the top.
//
// WAIVER MARKERS. `// path-assert-ok: <reason>` (JS) / `# path-assert-ok: <reason>` (Python) keep
// working everywhere, unchanged — the historical name, from when this gate's whole scope was POSIX
// path assertions. `// platform-assert-ok: <reason>` / `# platform-assert-ok: <reason>` is accepted
// as an alias on EVERY shape, JS and Python alike, because the gate's scope is now
// "platform-dependent test assumptions" of which POSIX path assertions were only the first family.
// Neither the module nor the historical marker is renamed for this — a rename would break every
// waiver comment already sitting in the corpus, for a purely cosmetic gain.
// AMBIENT LOAD STATE (plan 4005) — (7), the FOURTH axis and the first about the machine's
// resources rather than its filesystem or platform. Neither real free memory nor real elapsed
// wall-clock time is a property of the code under test — both are properties of THIS host at
// the moment the test happens to run, and this repo runs ~5-7 parallel sessions sharing one box
// on purpose. Motivating incident: three `scripts/*.test.mjs` files (plan 4005) each asserted on
// one of these — `pre-push-hook.test.mjs` compared an xdist worker count computed from two
// independent live `os.freemem()` reads minutes apart; `pre-push-battery-cap.test.mjs` held
// several real child-process invocations to guessed `wallMs < N` wall-clock ceilings;
// `sol-run.test.mjs`'s fixture ticked a real timer that raced the module's own real quiet-window
// clock — and all three turned four plans' land attempts into 10, 4, 2, and 1 extra rounds
// (`docs/handoff/infra-debt.md`, `scripts-battery-load-flake-trio-blocks-local-lands`) before
// this axis had a gate. Scope: **JS only** (`scripts/**/*.test.mjs`) — Python's very different
// memory/timing primitives make a symmetric pass a separate, unscoped effort, not this plan's.
//
//   (7a) `ambient-load-freemem` — a bare `os.freemem()` / `freemem()` / `os.totalmem()` /
//        `totalmem()` CALL. Cannot mistake the injected-fake PROPERTY shape corpus tests already
//        use (`freemem: () => 40_000_000_000`) for a violation — that identifier is followed by
//        `:`, never `(`, so the call-shaped pattern below simply does not match it. Nor a MEMBER
//        call on anything other than `os` (`fakeOs.freemem()`), nor a same-named helper's own
//        DECLARATION (`function freemem() { … }`), nor the text appearing as PROSE inside a string
//        or a single- or multi-line template literal — round-1 review, plan 4005; see
//        `FREEMEM_TOTALMEM_CALL_RX` and `templateLiteralInteriorLines` near the shape's code.
//        FIX: inject the reading — an `opts.freemem`-shaped parameter with a live default (the
//        `test-queue.mjs` / `pytest-memory-budget.mjs` seam), or an env pin
//        (`PYTEST_MEMORY_FREE_BYTES`) for a real CLI subprocess a test cannot hand `opts` to
//        directly.
//
//   (7b) `ambient-load-elapsed-ceiling` — TWO bound-then-compared shapes, not a bare regex over
//        arbitrary arithmetic (a `Date.now() + N` used once to build a FIXED injected timestamp —
//        `const farFuture = Date.now() + 10_000_000` fed into a fake `now: () => farFuture` — is
//        legitimate test DATA, not a poll deadline, and measured corpus contact (coord-git.test.mjs,
//        done-worktree.test.mjs, heal-main.test.mjs, pre-yield-guard.test.mjs) found exactly that
//        shape and nothing else, so a bare-arithmetic rule would have been a false-positive factory).
//        Both are scoped to the binding's OWN ENCLOSING TEST BLOCK (module-scope bindings fall back
//        to the whole file) — round-1 review, plan 4005: two unrelated tests binding a common
//        conventional name (`deadline`, `elapsedMs`) must not cross-attribute one test's comparison
//        to the other's binding, and each violation is reported at the COMPARISON line (with the
//        binding line also carried in `texts`), not the binding alone, so diff-scoped enforcement
//        sees either one added on its own:
//          • a name bound from `Date.now() + <expr>` that is ALSO compared against `Date.now()`
//            again, either operand order — the classic ambient poll-deadline shape this plan's own
//            T2 fix carries as `appearDeadline`/`reapDeadline`. Measured corpus contact wraps this in
//            a `while(...)` loop, but the property judged is the comparison itself; the loop keyword
//            is not itself required.
//          • a name bound from a real elapsed-time DELTA (`process.hrtime.bigint() - x`,
//            `Date.now() - x`, `performance.now() - x`) later compared with `<`/`<=` (a CEILING —
//            "must not take longer than") against a bare numeric literal, a NAMED CONSTANT, or a
//            simple one-operator arithmetic expression of either — `wallMs < 30_000`,
//            `elapsed < PREP_MS`, `elapsed < PREP_MS / 2` (widened by round-1 review, plan 4005,
//            after a genuine corpus miss at the bare-literal-only shape:
//            `landing-queue-watch.test.mjs`'s `elapsed < PREP_MS / 2`). `>`/`>=` (a FLOOR — "must
//            take at least this long", e.g. a grace-period minimum-wait assertion) is NOT flagged
//            regardless of RHS shape: load can only make a real duration LONGER, never shorter, so a
//            floor comparison cannot be the ambient-load false-red this shape exists to catch.
//        FIX: if the real property is "X happened before a cap could fire" (a kill preceded a
//        child's own natural completion, a real exit code proves it was not a timeout kill),
//        assert that ORDER or IDENTITY instead of an elapsed ceiling. If duration genuinely is the
//        property, drive a PURE function with an injected clock (never a real spawned child — a
//        fake clock cannot drive one). A poll loop waiting on a real signal keeps at most ONE
//        generous, NAMED hang backstop instead of several tuned figures — and still waives, since
//        it is still a real wall-clock bound, just a deliberately loose one.
//
//   Neither sub-shape reads inside a multi-line TEMPLATE-LITERAL fixture body (a spawned child's
//   own source-as-string, e.g. `sol-run.test.mjs`'s `fixture(\`...\`)` idiom) — that text is real
//   JS, but it belongs to the child process, not to this file's own bindings or calls (round-1
//   review, plan 4005; see `templateLiteralInteriorLines`).
//
//   Both sub-shapes waive with `// ambient-load-ok: <reason>` — a genuine hang backstop or the one
//   real-spawn smoke test a fixture-timing fix may leave in place both need one.
//
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { errText, resolveGuardRanges } from './coord/coord-git.mjs';
import {
  fetchRangeDiff,
  readFileAtTip,
  rangeTip,
  collectAddedByFile as collectAddedByFileShared,
  splitCallArgs,
} from './seam-guard-lib.mjs';

// Re-exported (plan 3974 review round 2, finding 214563): `splitCallArgs` now lives in
// seam-guard-lib.mjs (the shared low-level module) so assert-lock-free-git-polls.mjs can import
// the one helper it needs without pulling in this whole other gate. This module keeps re-exporting
// it under the same name — its existing import sites below and its test file's import are
// unaffected.
export { splitCallArgs };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The Python side is deliberately BROAD here — `inScope` (below) does the precise filtering, exactly
// as it already does for the JS glob. A bare `backend/scripts/**/*.py` pathspec silently misses
// files directly IN `backend/scripts/` (a measured git footgun, not a hypothetical one); the
// explicit `:(glob)` magic form does not have that gap.
export const SCOPE_PATHSPECS = [':(glob)scripts/**/*.test.mjs', ':(glob)backend/scripts/**/*.py'];

// A Python test file: `test_*.py` or `conftest.py` by basename (the corpus convention — 753 files,
// all `test_*.py`, plus 2 `conftest.py`, zero `*_test.py`), OR any `.py` file living in a `__tests__`
// or `tests` directory. The directory clause deliberately pulls in a shared test HELPER that isn't
// itself collected by pytest but is imported by tests that are (e.g.
// `backend/scripts/__tests__/_test_price_rows.py`) — same blast radius as a collected test, same
// class of platform-dependent-fake bug.
const PY_TEST_BASENAME_RX = /^(?:test_.*|conftest)\.py$/;

export function inScope(path) {
  if (path.startsWith('scripts/') && path.endsWith('.test.mjs')) return true;
  if (path.startsWith('backend/scripts/') && path.endsWith('.py')) {
    const basename = path.slice(path.lastIndexOf('/') + 1);
    if (PY_TEST_BASENAME_RX.test(basename)) return true;
    if (path.includes('/__tests__/') || path.includes('/tests/')) return true;
  }
  return false;
}

// Which analyzer a path is judged by. `.py` → Python shapes (4)/(5); everything else → the
// original JS shapes (1)-(3). Exported so main() and the diff-scoped filter can route per file.
export function langFor(path) {
  return path.endsWith('.py') ? 'py' : 'js';
}

// This gate's own test file: its fixtures ARE violating source text, so scanning it is guaranteed
// self-indictment. The one structural exemption (see the header).
export const SELF_TEST_PATH = 'scripts/assert-posix-path-assertions.test.mjs';

export function isExempt(path) {
  return path === SELF_TEST_PATH;
}

// ── source-shape vocabulary ───────────────────────────────────────────────────

// "A BARE (non-member) call to a native `node:path` function named …" — the shared prefix of both
// native-call patterns below, so the matching RULE lives in exactly one place. The negative
// lookbehind keeps `[].join('')` and `posix.join(…)` / `win32.join(…)` out: an Array#join is not a
// path op, and an explicitly-pinned module produces a platform-independent value by construction
// (that is the fix, not the bug). The optional `path.` prefix is what lets the member form
// `path.join(…)` still match without the lookbehind rejecting it for the preceding dot.
const nativeCallRx = (names, flags) =>
  new RegExp(String.raw`(?<![.\w$])(?:path\s*\.\s*)?(?:${names})\s*\(`, flags);

// Any native path call that renders a PLATFORM-NATIVE path.
const NATIVE_PATH_CALL_RX = nativeCallRx('resolve|join|relative|normalize');

// Shape (3)'s narrower sibling: `join` specifically, and GLOBAL so one operand can be scanned for
// every occurrence. `resolve` is deliberately NOT in this set — it drive-qualifies a rooted literal
// and is the gate's own prescribed remedy (see the header's KNOWN BOUND).
const NATIVE_JOIN_CALL_RX_G = nativeCallRx('join', 'g');

// A call whose NAME says it yields a path — `resolveCommonDirPath(`, `entryPath(`, `lockDirFor(`.
// This is what makes shape (2) decidable without real dataflow: the binding's producer is named.
// The leading verb exclusion keeps ACTIONS on a file out: `readFile(…)` yields CONTENT, not a
// path, and treating its result as path-valued would invent a false `unnormalized-path-compare`
// between two file bodies. (`readFileSync` never matched anyway — it ends in `Sync`, not `File`.)
const FILE_ACTION_VERB = 'read|write|append|copy|open|create|delete|remove|unlink|stat';
const PATHISH_CALL_RX = new RegExp(
  String.raw`(?<![.\w$])(?!(?:${FILE_ACTION_VERB})[A-Z])[A-Za-z_$][\w$]*(?:Path|Dir|File)\s*\(`,
);

// Path-valued sources that carry no `Path`/`Dir`/`File` in their name.
const PATH_SOURCE_CALL_RX = /\b(?:tmpdir|mkdtempSync|realpathSync|fileURLToPath|cwd)\s*\(/;

// An identifier whose own NAME says it holds a path — covers a destructured binding
// (`const { mainDir, wtDir } = makeRepoWithWorktree()`) whose producer name says nothing.
// `root` is in the BINDING-name set but deliberately NOT in the callee set above: `repoRoot` holds
// a path, while `hashInstallRoot(…)` / `normalizeInstallRoot(…)` TAKE a root and return something
// else (a hash, a cache key) — keying on the callee's `Root` suffix would misread those as paths.
// CamelCase-aware on purpose: the suffix must be a WORD of the identifier (an upper-case segment
// boundary) or the whole name. A case-insensitive `/(?:path|dir|file|root)$/i` would read `profile`
// as a path — and two such bindings compared would be reported as an unnormalized path compare.
const PATHISH_NAME_RX = /^(?:path|dir|file|root)$|(?:Path|Dir|File|Root)$/;

// The OUTERMOST callee of an initializer, e.g. `hashInstallRoot` in
// `hashInstallRoot(resolve('.', 'root-a'))`. Binding classification keys on this rather than on
// "some path call appears anywhere in the RHS", because the outermost call is what decides the
// value's TYPE: a path fed through a hash is a hash, and comparing two hashes raw is correct.
const LEADING_CALLEE_RX = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/;

// A hand-rolled separator normalization: `.replaceAll('\\', '/')` or `.replace(/\\/g, '/')`. Its
// presence marks the operand as path-derived (it is only ever written about paths).
const SEP_NORMALIZE_RX = /(?:replaceAll|replace)\s*\(\s*(?:'\\\\'|"\\\\"|\/\\\\\/g)/;

// The equality assertions whose second argument is the EXPECTED value.
const ASSERT_EQ_RX = /\bassert\s*\.\s*(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/;

const BARE_IDENT_RX = /^[A-Za-z_$][\w$]*$/;

// A simple `const|let|var NAME = RHS` declaration, capturing the bound name and the initializer.
// ONE definition, shared by `collectPathBindings` (shapes 1-3) and `analyzeAmbientGitState`
// (shape 6): both decide the same thing — which identifier a line binds and to what — and a
// second hand-typed copy is a silent-drift seam the moment either side widens what counts as a
// declaration (review finding [3], sonnet-review 2026-09-02).
const SIMPLE_BINDING_RX = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/;

// A reference to `name` as CODE — the negative lookarounds keep `dir` from matching inside
// `mainDir`, `dirname` or `--git-dir`. Built per name, so it is a factory rather than a constant;
// same single definition shared by shape (6)'s candidate scan and its cover scan.
const identRefRx = (name) => new RegExp(String.raw`(?<![\w$])${name}(?![\w$])`);

// A whole argument that is one quoted, drive-LESS absolute string literal (`'/somewhere/.git'`).
// `(?!\/)` excludes a `//host/share` UNC/protocol-relative form, which is a different animal.
const POSIX_ABS_LITERAL_RX = /^(['"])\/(?!\/)[^'"\n]+\1$/;

// A waiver: `//` (JS) or `#` (Python) followed by any marker word and a NON-EMPTY reason.
// `path-assert-ok` is the historical marker name — this gate's scope began as POSIX path assertions
// only. `platform-assert-ok` is the general alias added when the Python platform-symbol shapes (4)
// and (5) joined the gate (plan 2853); `ambient-git-ok` is shape (6)'s own marker (plan 3622);
// `ambient-load-ok` is shape (7)'s own marker (plan 4005). The module and the historical marker are
// never renamed, so every waiver comment already in the corpus keeps working unchanged. All four are
// interchangeable at the regex level — a marker is a marker; naming them separately is documentation
// for the reader, not a per-shape gate.
const WAIVER_MARKER_RX = String.raw`(?:(?:path|platform)-assert-ok|ambient-git-ok|ambient-load-ok):\s*\S`;
const WAIVER_RX = new RegExp(String.raw`//\s*${WAIVER_MARKER_RX}`);
const WAIVER_RX_PY = new RegExp(String.raw`#\s*${WAIVER_MARKER_RX}`);

// A platform pin inside a test block — `_path: posix`, `_path: win32`, `posix.resolve(…)`, or the
// member form `path.win32.join(…)` (hence the optional `path.` prefix: without it the lookbehind
// would reject `win32` for being preceded by a dot, and a legitimately pinned block would be
// reported). A bare `'win32'` STRING (`process.platform !== 'win32'`) is not a pin — it is followed
// by a quote, not a dot — and correctly does not exempt anything.
const PLATFORM_PIN_RX =
  /_path\s*:\s*(?:posix|win32)|(?<![.\w$])(?:path\s*\.\s*)?(?:posix|win32)\s*\./;

const TEST_BLOCK_START_RX = /^\s*(?:test|it)\s*\(/;

// `lang` defaults to 'js' so every existing call site (the JS shapes never pass it) is unaffected.
// Python's comment character is `#` only — this corpus's Python tests do not use triple-quoted
// strings as comments, so no docstring-as-comment handling is needed.
function isCommentLine(line, lang = 'js') {
  const t = line.trimStart();
  if (lang === 'py') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('/*') || /^\*(?:\s|\/|$)/.test(t);
}

// Identifiers bound anywhere in the file to a path-producing expression. Whole-file, order-free —
// a `const` inside a `try` block is as good as a top-level one, and a test's assertions always
// follow its bindings textually anyway.
export function collectPathBindings(lines) {
  const bindings = new Set();
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=/.exec(line);
    if (destructured) {
      for (const raw of destructured[1].split(',')) {
        // `{ mainDir, wtDir, cleanup }` and `{ dir: repoDir }` — the BOUND name is after any `:`.
        const name = raw.split(':').pop().trim();
        if (BARE_IDENT_RX.test(name) && PATHISH_NAME_RX.test(name)) bindings.add(name);
      }
      continue;
    }
    const simple = SIMPLE_BINDING_RX.exec(line);
    if (!simple) continue;
    const [, name, rhs] = simple;
    if (PATHISH_NAME_RX.test(name) || producesPath(rhs)) bindings.add(name);
  }
  return bindings;
}

// Does this initializer expression yield a path? Judged on the OUTERMOST call only (see
// LEADING_CALLEE_RX) when the RHS is a call; otherwise on the expression text, which covers the
// non-call idioms that still produce a path (`join(a, b).replaceAll(…)` is a call and handled
// above; `` `${dir}/x` `` and `a + '/x'` are not, and are conservatively treated as paths only when
// they carry an explicit path call).
function producesPath(rhs) {
  const call = LEADING_CALLEE_RX.exec(rhs.trim());
  const head = call ? `${call[1]}(` : null;
  if (head) {
    return (
      NATIVE_PATH_CALL_RX.test(head) || PATHISH_CALL_RX.test(head) || PATH_SOURCE_CALL_RX.test(head)
    );
  }
  return (
    NATIVE_PATH_CALL_RX.test(rhs) || PATHISH_CALL_RX.test(rhs) || PATH_SOURCE_CALL_RX.test(rhs)
  );
}

// Line spans (half-open, 0-based) of every `test(…)`/`it(…)` block. Block boundaries are the next
// block's start — cheap, and exact for the one-test-per-`test(` shape every file in this corpus
// uses. Lines before the first block are file scope and belong to no span.
export function testBlockSpans(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i++) if (TEST_BLOCK_START_RX.test(lines[i])) starts.push(i);
  return starts.map((start, k) => [start, k + 1 < starts.length ? starts[k + 1] : lines.length]);
}

// Line spans (half-open, 0-based) of `test(…)`/`it(…)` blocks that explicitly pin a path module.
// A pin at file scope (the `import { win32 } from 'node:path'` line) deliberately does NOT exempt
// anything: it says nothing about a given assertion.
export function platformPinnedSpans(lines) {
  return testBlockSpans(lines).filter(([start, end]) =>
    PLATFORM_PIN_RX.test(lines.slice(start, end).join('\n')),
  );
}

// Is the assertion at `i` waived by the comment block immediately above it? The scan walks the
// CONTIGUOUS run of comment lines and stops at the first line of code, so a waiver can only ever
// apply to the statement it sits on top of. Multi-line is the point: a one-line waiver rarely has
// room for a reason worth reading, and the reason is the whole value of the escape hatch.
function waivedFromAbove(lines, i, lang = 'js') {
  const waiverRx = lang === 'py' ? WAIVER_RX_PY : WAIVER_RX;
  for (let j = i - 1; j >= 0 && isCommentLine(lines[j], lang); j--) {
    if (waiverRx.test(lines[j])) return true;
  }
  return false;
}

// Is this operand a value derived from a path operation (as opposed to a plain string, a number, a
// URL route, or an unrelated object member)?
function isPathDerived(arg, bindings) {
  if (SEP_NORMALIZE_RX.test(arg)) return true;
  if (NATIVE_PATH_CALL_RX.test(arg)) return true;
  if (PATHISH_CALL_RX.test(arg)) return true;
  if (PATH_SOURCE_CALL_RX.test(arg)) return true;
  return BARE_IDENT_RX.test(arg) && bindings.has(arg);
}

// Shape (3): does this operand contain a native `join(…)` rooted at a drive-less absolute string
// literal? Returns that literal (for the message) or null.
//
// ALL native-join occurrences in the operand are scanned, not just the first: the real corpus shape
// `assert.deepEqual(installCwds, [join('/main', '.claude/worktrees/e1-slug')])` buries the call
// inside an array, and a nested one (`join(x, join('/a', 'b'))`) must not hide behind an innocent
// outer call. `splitCallArgs` is nesting- and quote-aware, so the FIRST argument it reports is the
// real first argument even when later ones contain commas inside a template or a nested call.
export function joinRootedLiteral(arg) {
  // The module-level global regex is reused rather than recompiled per call (analyze() reaches here
  // once or twice per equality assertion, across the whole corpus in `--all`). `lastIndex` is state
  // shared between calls, so it MUST be reset on entry: a previous call that returned early on a
  // match left it mid-string, and resuming from there would silently skip the head of this operand.
  NATIVE_JOIN_CALL_RX_G.lastIndex = 0;
  let m;
  while ((m = NATIVE_JOIN_CALL_RX_G.exec(arg)) !== null) {
    // `m[0]` ends at the opening paren, so its last index IS that paren — what splitCallArgs wants.
    const args = splitCallArgs(arg, m.index + m[0].length - 1);
    if (args && args.length > 0 && POSIX_ABS_LITERAL_RX.test(args[0])) return args[0];
  }
  return null;
}

// PURE core. Given a test file's full text, return every violation it contains as
// `{ line, endLine, kind, text, texts, detail }` (1-based line numbers; `text` is the trimmed first
// physical line, `texts` every trimmed line of the statement — the diff filter matches on `texts`
// so that editing only the EXPECTED value of a multi-line assertion still counts as introducing it).
//
// KNOWN BOUND: only the FIRST equality assertion on a physical line is judged (`ASSERT_EQ_RX.exec`,
// not a global scan). Measured against the corpus: zero test files put two assertions on one line,
// and prettier's 100-column wrap keeps it that way, so closing this would add loop/offset
// complexity for a shape that does not occur.
// ── Shape (6): ambient git state (plan 3622) ──────────────────────────────────

// A test that CLAIMS its root is outside a git repository. Matched against the `test(…)` title
// line and the contiguous comment block directly above the block — the same locality the waiver
// machinery uses, and deliberately NOT the whole file: a file-wide scan for these phrases hits 17
// corpus files, essentially all of them error-STRING assertions (`/fatal|not a git repository/`,
// `throw new Error('not a git repo')`) that assert nothing about the filesystem. Title-and-header
// scoped, the same sweep returns exactly 4 — every one a real instance of this class.
const NO_REPO_CLAIM_RX =
  /outside\s+(?:any|a)\s+(?:git\s+)?repo|not\s+(?:a|in\s+a)\s+git\s+repo|no\s+\.git\s+ancestor|no\s+git\s+context/i;

// A root bound from `mkdtempSync(…)`. The declaration itself is matched with the shared
// SIMPLE_BINDING_RX above. An arrow/function RHS is excluded: `const tmp = (p) =>
// mkdtempSync(…)` binds a FACTORY, not a root, and its call sites are judged on their own.
const MKDTEMP_CALL_RX = /\bmkdtempSync\s*\(/;
const FUNCTION_RHS_RX = /^(?:async\s+)?(?:function\b|\(?[^)]*\)?\s*=>)/;

// A cover establishes the root's git state as a FACT instead of leaving it to the machine.
//
// TWO SCOPING RULES, both of which the corpus forced (measured 2026-09-02 — with either one
// missing, 2 of the 4 real instances went unflagged behind a FALSE cover):
//
//   • Covers are scoped to the BINDING'S OWN REGION, not the file. `gate-pass-cache.test.mjs`
//     binds `dir` twice — once in its `tmpRepo()` fixture, which git-inits it, and once inside the
//     outside-a-repo test, which must not. A file-wide name-keyed search let the fixture's
//     `git init` cover the unrelated same-named binding in the test and cleared a true positive.
//     An in-block binding is therefore covered only from within its own block; a module-level one
//     from module scope plus the block under judgement.
//   • The identifier must appear as CODE, not inside a string literal. `git-maintenance-guard`'s
//     module-level command table contains the literal `'git --git-dir /a/.git gc'`, in which
//     `--git-dir` matches a bare `dir` reference and `/a/.git` matches the planted-marker cover —
//     a line that establishes nothing about anything covering a real instance. The reference test
//     runs on the string-STRIPPED line; the cover patterns still run on the original, because a
//     planted marker is legitimately written as the string literal `'.git'`.
const GIT_INIT_COVER_RX = /['"]init['"]/;
const GIT_WORD_RX = /\bgit\b/i;
const DOT_GIT_COVER_RX = /['"]\.git['"]|['"`][^'"`\n]*\/\.git\b/;
const CEILING_COVER_RX = /GIT_CEILING_DIRECTORIES/;
const STRING_LITERAL_RX = /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g;

// Does any line in `region` establish `name`'s git state? (git-init it, plant a `.git` marker in
// it, or fence git's ancestor walk for it.)
function ambientGitCovered(region, name) {
  const refRx = identRefRx(name);
  for (const line of region) {
    if (isCommentLine(line)) continue;
    if (CEILING_COVER_RX.test(line)) return true;
    if (!refRx.test(line.replace(STRING_LITERAL_RX, "''"))) continue;
    if (GIT_WORD_RX.test(line) && GIT_INIT_COVER_RX.test(line)) return true;
    if (DOT_GIT_COVER_RX.test(line)) return true;
  }
  return false;
}

// Shape (6). A test whose own title (or header comment) claims "outside a git repo", whose root
// comes from a bare `mkdtempSync`, and where nothing in the file establishes that claim.
//
// NO CALL-SITE CONDITION, by measurement. The obvious extra requirement — "and the root reaches a
// repo-ancestor lookup" — was checked against all four corpus instances and buys nothing: each one
// passes the root as a call argument, an array element, or a `cwd:` property, i.e. simply USES it,
// so the condition would be satisfied by every candidate while adding a second thing to get wrong.
// Same call the symbol-keyed (over fake-platform-keyed) judgement in shape (4) made, for the same
// reason. The claim itself is the discriminator: a test that says it is outside a repo and builds
// its root from `mkdtempSync` is making a statement about the machine either way.
export function analyzeAmbientGitState(lines) {
  const spans = testBlockSpans(lines);

  // Every `X = mkdtempSync(…)` binding, with the line it was defined on, split by scope.
  //
  // SCOPE IS KEYED ON INDENTATION, not on the `test(…)`-span model the platform-pin exemption
  // uses. Those spans run start-of-block → start-of-NEXT-block, so every top-level statement that
  // happens to sit BETWEEN two test blocks is misattributed to the preceding one. That is not a
  // corner case: `git-maintenance-guard.test.mjs` declares its shared `const dir = mkdtempSync(…)`
  // two thirds of the way down the file, between tests, and the span model classified it as
  // block-local to the test above it — so the claiming test further down never saw it as a
  // candidate and a real instance went unflagged. An unindented `const`/`let`/`var` is top-level
  // in every file in this prettier-formatted corpus; an indented one is inside something.
  const mkdtempDefs = [];
  const anyDefsAt = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    const m = SIMPLE_BINDING_RX.exec(lines[i]);
    if (!m) continue;
    const [, name, rhs] = m;
    const topLevel = !/^\s/.test(lines[i]);
    anyDefsAt.push({ name, line: i, topLevel });
    if (MKDTEMP_CALL_RX.test(rhs) && !FUNCTION_RHS_RX.test(rhs.trim()))
      mkdtempDefs.push({ name, line: i, topLevel });
  }
  const moduleDefs = mkdtempDefs.filter((d) => d.topLevel);

  const violations = [];
  for (const [start, end] of spans) {
    const header = [];
    for (let j = start - 1; j >= 0 && isCommentLine(lines[j]); j--) header.push(lines[j]);
    if (!NO_REPO_CLAIM_RX.test([lines[start], ...header].join('\n'))) continue;
    if (WAIVER_RX.test(lines[start]) || waivedFromAbove(lines, start)) continue;

    // WHICH lines actually carry the claim — needed by `texts` below, because the claim can live
    // wholly in the header comment over a generically-titled test, and a diff whose only new line
    // is that comment must still block. Per-line, with no whole-header fallback: a claim CANNOT
    // span the boundary, because every continuation line begins with a `//` / `/*` / `*` marker
    // and every NO_REPO_CLAIM_RX alternative joins its halves with `\s+` only, so the whole-join
    // test above can never match unless some single line already does. Listing only the carrying
    // lines is also what keeps the converse honest: an UNRELATED comment added above an
    // already-claiming test introduces nothing and must not be blamed for the violation.
    const claimTexts = [lines[start], ...header]
      .filter((l) => NO_REPO_CLAIM_RX.test(l))
      .map((l) => l.trim())
      .filter(Boolean);

    const body = lines.slice(start, end);
    // An in-block definition SHADOWS a module-level one of the same name — which is exactly how
    // the fixed call sites read (`const root = makeNoRepoRoot(…)` inside a block whose file also
    // binds `root = mkdtempSync(…)` in OTHER blocks). Without shadowing, a name reused across
    // sibling tests would report a block that does not have the problem.
    const shadowed = new Set(
      anyDefsAt.filter((d) => !d.topLevel && d.line >= start && d.line < end).map((d) => d.name),
    );
    const candidates = [
      ...mkdtempDefs.filter((d) => !d.topLevel && d.line >= start && d.line < end),
      ...moduleDefs.filter(
        (d) => !shadowed.has(d.name) && identRefRx(d.name).test(body.join('\n')),
      ),
    ];

    const moduleScope = lines.filter((l) => !/^\s/.test(l));
    for (const { name, line, topLevel } of candidates) {
      if (WAIVER_RX.test(lines[line]) || waivedFromAbove(lines, line)) continue;
      // An in-block binding is covered only from inside its own block; a top-level one from
      // top-level scope plus this block. See the two scoping rules above ambientGitCovered.
      const region = topLevel ? [...moduleScope, ...body] : body;
      if (ambientGitCovered(region, name)) continue;
      // `texts` carries EVERY line that could be the one a range added — the binding, plus each
      // line actually carrying the claim (the `test(…)` title and/or its header comment). The
      // diff-scoped gate keeps only violations whose `texts` intersect the added set
      // (`violationsIntroduced`), so a half listed here is a half that can slip through: anchoring
      // solely at the binding dropped a NEWLY ADDED claiming block over a pre-existing shared
      // `const dir = mkdtempSync(…)`, and anchoring only at the binding plus the title then still
      // dropped a claim added purely as a header COMMENT over a generically-titled test. Both
      // reported clean on precisely the diff this axis exists to stop. `line` stays on the
      // binding: that is where the fix goes. Adding an UNRELATED comment above an
      // already-claiming test still introduces nothing, because only claim-carrying lines are
      // listed — the violation was already there and this range did not create it.
      const bindingText = lines[line].trim();
      violations.push({
        line: line + 1,
        endLine: line + 1,
        kind: 'ambient-git-state',
        text: bindingText,
        texts: [...new Set([bindingText, ...claimTexts])],
        detail:
          `${name} (claimed at line ${start + 1}) — a bare mkdtempSync root in a test that claims it is outside a git repository, ` +
          `with nothing establishing that. Whether tmpdir() has a repo ANCESTOR is a property of ` +
          `the host, not of the path: the assertion holds until a machine has one (a sandbox with ` +
          `/tmp/.git, a TMPDIR under a checkout) and then fails — or, worse, keeps passing while ` +
          `silently exercising the has-a-repo branch instead. FIX: build the root with ` +
          `test-helpers/no-repo-root.mjs's makeNoRepoRoot(), git init it if a repo is what the ` +
          `test actually wants, or waive with // ambient-git-ok: <reason>`,
      });
    }
  }
  return violations;
}

// ── Shape (7): ambient load state (plan 4005) ─────────────────────────────────
// See the AMBIENT LOAD STATE header block near the top of this file for the class, the two
// sub-shapes, and the measured KNOWN BOUNDs (the `>= `/`>` floor exclusion; the fixed-timestamp
// exclusion for 7b's first sub-shape).

// (7a): a bare `os.freemem()` / `freemem()` / `os.totalmem()` / `totalmem()` CALL. Requires the
// identifier be followed directly by `(` — `freemem: () => 40_000_000_000` (the injected-fake
// property shape the corpus already uses throughout) has a `:` there instead, so it cannot match.
// Two further exclusions, same "measured against a real false-positive shape" discipline as the
// rest of this file (round-1 review, plan 4005):
//   • a MEMBER call on anything other than `os` — `fakeOs.freemem()` (an injected stand-in reached
//     through its own object) is not a live read. The negative lookbehind sits BEFORE the optional
//     `os.` prefix (mirroring `nativeCallRx`'s `path.` handling above), so it forbids being preceded
//     by a dot/word/`$` UNLESS that prefix is exactly `os.` — a bare call and an `os.`-qualified one
//     both still match; `fakeOs.freemem(` does not, because the position right before `freemem` is
//     itself preceded by a dot the lookbehind rejects and the optional group cannot retroactively
//     consume `fakeOs.` (it only ever matches the literal text `os.`).
//   • a DECLARATION of a same-named helper — `function freemem() { … }` — whose own parameter list
//     textually contains `freemem(` with nothing between the keyword and the name. `(?<!function\s+)`
//     rejects only that exact shape; a call reached through any other route still matches.
const FREEMEM_TOTALMEM_CALL_RX =
  /(?<!function\s+)(?<![.\w$])(?:os\s*\.\s*)?(freemem|totalmem)\s*\(/;

// A line's `` ` `` characters, ignoring an escaped one and anything after a `//` line comment,
// tracked across the WHOLE FILE as one stream — the same quote/escape bookkeeping `splitCallArgs`
// already does for a call's arguments, applied here to find TEMPLATE-LITERAL bodies instead.
// Returns the set of 0-based line indices that sit ENTIRELY inside a template literal spanning more
// than one line: a test fixture's source-as-string body (`fixture(\`...\`)`, the corpus idiom
// sol-run.test.mjs uses throughout). That text is real-looking JS, but it is the CHILD PROCESS's
// source, not this file's own — its `freemem()`/`Date.now()` shapes belong to the spawned child,
// not to a live read or a poll loop this gate should judge (round-1 review, plan 4005).
//
// The line where the template OPENS is deliberately NOT included — it usually still carries real
// code before the backtick (`const f = fixture(\``) — but the line where it CLOSES is, since every
// corpus fixture closes on a bare `` `); `` line with nothing else worth judging. KNOWN BOUND: a
// `/* … */` block comment spanning multiple lines is not tokenized out, so a backtick inside one
// could mis-toggle this state — unmeasured against the corpus, which is `//`-comment throughout
// (same convention `isCommentLine` already assumes elsewhere in this file).
function templateLiteralInteriorLines(lines) {
  const interior = new Set();
  let quote = null; // null | "'" | '"' | '`' — carried over only for a genuinely unterminated one
  // Block-comment state must be tracked, not just `//` (plan 4005 round-2 finding 46083f, which
  // REPRODUCED: a single unmatched backtick inside a `/* … */` comment — ordinary prose, e.g. naming
  // a `template literal` — used to open a template that never closed, so every later line in the
  // file was marked "template interior" and silently skipped. Measured on a probe file: 1 real
  // violation before, 0 after. A lint that stops reporting and says nothing is worse than one that
  // over-reports, so this case is carried by a unit test rather than left to inspection.
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (quote === '`' && !inBlockComment) interior.add(i);
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inBlockComment) {
        if (ch === '*' && line[c + 1] === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (quote) {
        if (ch === '\\') c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '/' && line[c + 1] === '/') break; // rest of the line is a comment, not code
      if (ch === '/' && line[c + 1] === '*') {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    }
  }
  return interior;
}

// (7b) sub-shape 1: a binding whose RHS is `Date.now() + <expr>` — a candidate poll deadline.
const DATE_NOW_PLUS_RX = /^Date\.now\(\)\s*\+\s*\S/;

// (7b) sub-shape 2: a binding whose RHS computes a real elapsed DELTA — `process.hrtime.bigint()
// - x`, `Date.now() - x`, or `performance.now() - x` (optionally wrapped, e.g. the
// `Number(process.hrtime.bigint() - start) / 1e6` shape this plan's own fix removed).
const ELAPSED_DELTA_RX =
  /(?:process\.hrtime\.bigint\(\)|Date\.now\(\)|performance\.now\(\))\s*-\s*[A-Za-z_$][\w$]*/;

function escapeIdent(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A comparison of `name` against `Date.now()` again, either operand order — the regex a caller
// scans a chosen LINE RANGE with (see the scoping note on the `dateNowPlusDefs` loop below; this
// used to be a whole-file `lines.some(...)` scan and cross-attributed two unrelated tests' same-named
// bindings, round-1 review, plan 4005). This turns a `Date.now() + <expr>` binding from a fixed
// injected TIMESTAMP (test data — measured corpus shape: `farFuture`/`nearPast`/`future` fed into an
// injected `now:` fake or a direct argument, never compared against `Date.now()` a second time) into
// an actual poll-deadline USE. NOT required to sit inside a `while(...)` specifically — measured
// corpus contact is a `while` loop, but the property judged is the comparison itself, and a
// `for`/recursive-poll shape reaching the same comparison is exactly as ambient-load-sensitive; a
// while-only requirement would only create a blind spot, not close one.
function dateNowDeadlineCompareRx(name) {
  const id = escapeIdent(name);
  return new RegExp(
    `\\bDate\\.now\\(\\)\\s*[<>]=?\\s*${id}\\b|\\b${id}\\s*[<>]=?\\s*Date\\.now\\(\\)`,
  );
}

// A CEILING comparison of `name` against a bare numeric literal, a named constant, or a simple
// one-operator arithmetic expression of either (`< 30_000`, `< PREP_MS`, `< PREP_MS / 2`,
// `< SOME_MS * 2`, `< 1e4`) — `<`/`<=` only. `>`/`>=` is a FLOOR ("took at least this long", e.g. a
// grace-period minimum-wait assertion) that real load can only make MORE true, never less — not the
// ambient-load false-red this shape exists to catch, so it is deliberately excluded rather than
// merely unmeasured. Widened from a bare-literal-only ceiling (round-1 review, plan 4005): the live
// corpus carries a genuine miss at that narrower shape — `landing-queue-watch.test.mjs`'s
// `elapsed < PREP_MS / 2` — and a NAMED-constant ceiling is exactly as ambient-load-sensitive as a
// literal one, merely spelled through a constant instead of inlining it. The LHS (`name`) is what
// keeps this from over-widening into "ordinary non-time comparisons": it is only ever a binding this
// file already proved is a real elapsed-time DELTA (`ELAPSED_DELTA_RX`, above), so any `<`/`<=`
// comparison against it is a ceiling on elapsed time regardless of how the RHS is spelled.
const ELAPSED_CEILING_TERM_RX_SRC = String.raw`(?:[\d_]+(?:\.[\d_]+)?(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*)`;
function elapsedCeilingCompareRx(name) {
  return new RegExp(
    String.raw`\b${escapeIdent(name)}\s*<=?\s*${ELAPSED_CEILING_TERM_RX_SRC}` +
      String.raw`(?:\s*[*/]\s*${ELAPSED_CEILING_TERM_RX_SRC})?`,
  );
}

// The [start, end) test-block span containing `line`, or null when it sits outside every
// `test(…)`/`it(…)` block (module scope) — same half-open span model `testBlockSpans` already
// uses for the platform-pin exemption.
function enclosingTestSpan(spans, line) {
  return spans.find(([s, e]) => line >= s && line < e) ?? null;
}

export function analyzeAmbientLoadState(lines) {
  const violations = [];
  const spans = testBlockSpans(lines);
  // Lines strictly inside a multi-line template-literal FIXTURE body — a spawned child's own
  // source-as-string, never this file's own code. Shared by every scan below (round-1 review, plan
  // 4005): the SAME false-positive class hits the bare-call scan (7a) and the binding-candidate
  // scan (7b) alike.
  const templateInterior = templateLiteralInteriorLines(lines);

  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]) || templateInterior.has(i)) continue;
    // Blank single-line quoted/templated text before matching: a STRING or single-line template
    // literal containing the text "freemem(" as PROSE (an assertion-failure message, a doc string)
    // is not a live call — `templateInterior` above handles the MULTI-line form of the same problem.
    const codeOnly = lines[i].replace(STRING_LITERAL_RX, "''");
    const m = FREEMEM_TOTALMEM_CALL_RX.exec(codeOnly);
    if (!m) continue;
    if (WAIVER_RX.test(lines[i]) || waivedFromAbove(lines, i)) continue;
    violations.push({
      line: i + 1,
      endLine: i + 1,
      kind: 'ambient-load-freemem',
      text: lines[i].trim(),
      texts: [lines[i].trim()],
      detail:
        `a bare live ${m[1]}() read — free/total memory is a property of the MACHINE at the ` +
        `moment this runs, not of the code under test, and varies under the same ` +
        `parallel-session load the memory axis already accounts for elsewhere (test-queue.mjs's ` +
        `opts.freemem / PYTEST_MEMORY_FREE_BYTES env pin). FIX: inject the reading, or waive ` +
        `with // ambient-load-ok: <reason>`,
    });
  }

  // Gather candidate bindings for 7b in one pass, then judge each by its LATER use. Lines inside a
  // multi-line template-literal fixture body are excluded here too, same reason as above.
  const dateNowPlusDefs = [];
  const elapsedDeltaDefs = [];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i]) || templateInterior.has(i)) continue;
    const m = SIMPLE_BINDING_RX.exec(lines[i]);
    if (!m) continue;
    const [, name, rhs] = m;
    const trimmedRhs = rhs.trim();
    if (DATE_NOW_PLUS_RX.test(trimmedRhs)) dateNowPlusDefs.push({ name, line: i });
    else if (ELAPSED_DELTA_RX.test(trimmedRhs)) elapsedDeltaDefs.push({ name, line: i });
  }

  for (const { name, line } of dateNowPlusDefs) {
    if (WAIVER_RX.test(lines[line]) || waivedFromAbove(lines, line)) continue;
    // Scoped to the binding's OWN enclosing test block (module scope falls back to the whole file,
    // exactly like the elapsed-delta branch below): two unrelated tests binding a common name
    // (`deadline`) must not cross-attribute one test's fixed injected TIMESTAMP into a violation
    // just because a DIFFERENT test polls its own same-named deadline (round-1 review, plan 4005 —
    // this file's own `deadline`-named bindings across separate tests are exactly that shape).
    const span = enclosingTestSpan(spans, line);
    const [from, to] = span ?? [0, lines.length];
    const cmpRx = dateNowDeadlineCompareRx(name);
    for (let j = from; j < to; j++) {
      if (isCommentLine(lines[j]) || templateInterior.has(j) || !cmpRx.test(lines[j])) continue;
      if (WAIVER_RX.test(lines[j]) || waivedFromAbove(lines, j)) continue;
      // Anchored at the COMPARISON line, not the binding — mirroring the elapsed-delta branch below:
      // `texts` carries both, so diff-scoped enforcement (`violationsIntroduced`) still blocks a
      // range whose only new line is the comparison over a pre-existing binding, or the reverse
      // (round-1 review, plan 4005 — the old binding-only anchor missed the first direction).
      violations.push({
        line: j + 1,
        endLine: j + 1,
        kind: 'ambient-load-elapsed-ceiling',
        text: lines[j].trim(),
        texts: [...new Set([lines[line].trim(), lines[j].trim()])],
        detail:
          `${name} — a Date.now()-based poll deadline compared against real elapsed time on a ` +
          `loaded host. FIX: wait on the fixture's own signal with at most ONE generous, NAMED ` +
          `hang backstop instead of a tuned figure, or waive with // ambient-load-ok: <reason>`,
      });
    }
  }

  for (const { name, line } of elapsedDeltaDefs) {
    // Scoped to the binding's OWN enclosing test block (module scope falls back to the whole
    // file, matching shape (6)'s treatment of a top-level binding): two different tests binding
    // the SAME conventional name (`elapsedMs`, `wallMs`) must not cross-attribute one test's
    // comparison to the other's binding — real corpus shape, `pre-push-hook.test.mjs` binds
    // `elapsedMs` twice, in two unrelated tests.
    const span = enclosingTestSpan(spans, line);
    const [from, to] = span ?? [0, lines.length];
    const cmpRx = elapsedCeilingCompareRx(name);
    for (let j = from; j < to; j++) {
      if (isCommentLine(lines[j]) || templateInterior.has(j) || !cmpRx.test(lines[j])) continue;
      if (WAIVER_RX.test(lines[j]) || waivedFromAbove(lines, j)) continue;
      violations.push({
        line: j + 1,
        endLine: j + 1,
        kind: 'ambient-load-elapsed-ceiling',
        text: lines[j].trim(),
        texts: [...new Set([lines[line].trim(), lines[j].trim()])],
        detail:
          `${name} held to a literal ceiling — a real elapsed-time reading compared against a ` +
          `guessed bound that a loaded host can miss. FIX: assert event ORDER or exit-code ` +
          `IDENTITY instead when the real property is "X happened before a cap could fire"; ` +
          `drive a PURE function with an injected clock when duration genuinely is the property ` +
          `(never a real spawned child — a fake clock cannot drive one); or waive with ` +
          `// ambient-load-ok: <reason>`,
      });
    }
  }

  return violations;
}

export function analyze(text) {
  const lines = text.split('\n');
  const bindings = collectPathBindings(lines);
  const pinned = platformPinnedSpans(lines);
  const isPinned = (i) => pinned.some(([s, e]) => i >= s && i < e);
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    const m = ASSERT_EQ_RX.exec(lines[i]);
    if (!m) continue;

    // Join continuation lines so a multi-line assertion is judged as one call. Capped so a
    // malformed file cannot make the scan quadratic.
    let stmt = lines[i];
    let end = i;
    let args = splitCallArgs(stmt, m.index + m[0].length - 1);
    while (args === null && end + 1 < lines.length && end - i < 20) {
      end += 1;
      stmt += `\n${lines[end]}`;
      args = splitCallArgs(stmt, m.index + m[0].length - 1);
    }
    if (args === null || args.length < 2) continue;

    const span = lines.slice(i, end + 1);
    if (span.some((l) => WAIVER_RX.test(l)) || waivedFromAbove(lines, i)) continue;
    if (isPinned(i)) continue;

    const [actual, expected] = args;
    const record = (kind, detail) =>
      violations.push({
        line: i + 1,
        endLine: end + 1,
        kind,
        text: lines[i].trim(),
        // Blank lines are dropped: an added empty line must never match a violation's span.
        texts: span.map((l) => l.trim()).filter(Boolean),
        detail,
      });

    if (POSIX_ABS_LITERAL_RX.test(expected) && isPathDerived(actual, bindings)) {
      record(
        'posix-literal-expected',
        `expected ${expected} — a drive-less absolute literal compared against a path-derived value`,
      );
    } else if (POSIX_ABS_LITERAL_RX.test(actual) && isPathDerived(expected, bindings)) {
      record(
        'posix-literal-expected',
        `actual ${actual} — a drive-less absolute literal compared against a path-derived value`,
      );
    } else if (
      BARE_IDENT_RX.test(actual) &&
      BARE_IDENT_RX.test(expected) &&
      bindings.has(actual) &&
      bindings.has(expected)
    ) {
      record(
        'unnormalized-path-compare',
        `${actual} vs ${expected} — two path-valued bindings compared raw`,
      );
    } else {
      // Shape (3). Last in the chain so an assertion that is ALSO shape (1) or (2) keeps its more
      // specific kind — one assertion is one offence, and the fix advice covers all three.
      // The EXPECTED side is checked first: it is where the hand-built path lives in every
      // measured instance, and it is the side the fix rewrites.
      const lit = joinRootedLiteral(expected) ?? joinRootedLiteral(actual);
      if (lit) {
        record(
          'join-rooted-literal',
          `join(${lit}, …) — a native join rooted at a drive-less absolute literal; on Windows ` +
            `join() stays drive-less where the resolve()-shaped implementations this codebase is ` +
            `migrating toward drive-qualify`,
        );
      }
    }
  }
  // Shapes (6) and (7) are binding-scoped rather than assertion-scoped, so each runs its own pass
  // over the same lines and its violations join the same list — one report, one waiver
  // vocabulary, one range-scoping filter downstream.
  violations.push(...analyzeAmbientGitState(lines));
  violations.push(...analyzeAmbientLoadState(lines));
  violations.sort((a, b) => a.line - b.line);
  return violations;
}

// ── Python platform-symbol vocabulary (plan 2853) ──────────────────────────────

// Every name below was checked with `hasattr()` on THIS Windows host and is verified absent —
// evidence is in `scripts/assert-posix-path-assertions.test.mjs`. Extended on corpus contact; every
// addition must be measured with `hasattr()` on BOTH platforms first — a symbol present on both
// (e.g. `signal.SIGTERM`, `os.kill`) must NEVER appear here, or the gate becomes a false-positive
// factory the moment it fires on a portable symbol.
export const POSIX_ONLY_OS = new Set([
  'getpgid',
  'killpg',
  'setsid',
  'fork',
  'forkpty',
  'geteuid',
  'getegid',
  'getuid',
  'getgid',
  'setuid',
  'setgid',
  'setpgrp',
  'getpgrp',
  'wait3',
  'wait4',
]);
export const POSIX_ONLY_SIGNAL = new Set([
  'SIGKILL',
  'SIGUSR1',
  'SIGUSR2',
  'SIGHUP',
  'SIGQUIT',
  'SIGPIPE',
  'SIGALRM',
  'SIGCHLD',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGWINCH',
]);
export const POSIX_ONLY_MODULES = new Set(['fcntl', 'pwd', 'grp', 'termios', 'resource']);

// Windows-only names, each CPython-doc-marked "Availability: Windows" and confirmed present on this
// host. Their POSIX absence is documented, not independently measured here (no POSIX host to hand) —
// see the plan-2853 report for the citation trail per name.
export const WINDOWS_ONLY_OS = new Set(['startfile']);
export const WINDOWS_ONLY_SUBPROCESS = new Set([
  'CREATE_NEW_PROCESS_GROUP',
  'CREATE_NO_WINDOW',
  'CREATE_NEW_CONSOLE',
  'DETACHED_PROCESS',
  'STARTUPINFO',
  'STARTF_USESHOWWINDOW',
  'CREATE_BREAKAWAY_FROM_JOB',
]);
export const WINDOWS_ONLY_SIGNAL = new Set(['CTRL_BREAK_EVENT', 'CTRL_C_EVENT']);
export const WINDOWS_ONLY_MODULES = new Set(['msvcrt', 'winreg', 'winsound']);

// Per-module { posix, windows } symbol tables for the three modules shapes (4)/(5) reach through
// attribute access. `subprocess` has no POSIX-only attribute in this corpus (empty set, not absent —
// keeps the lookup uniform across all three modules).
const PY_MODULE_TABLES = {
  os: { posix: POSIX_ONLY_OS, windows: WINDOWS_ONLY_OS },
  signal: { posix: POSIX_ONLY_SIGNAL, windows: WINDOWS_ONLY_SIGNAL },
  subprocess: { posix: new Set(), windows: WINDOWS_ONLY_SUBPROCESS },
};

function platformDirection(module, symbol) {
  const table = PY_MODULE_TABLES[module];
  if (table?.posix.has(symbol)) return 'POSIX-only — absent on Windows';
  if (table?.windows.has(symbol)) return 'Windows-only — absent on Linux';
  return null;
}

// The last segment of a (possibly dotted) module expression must be exactly `os`/`signal`/
// `subprocess` — `_pp_proc.os` and `lib.os` both match via the prefix; `osx` or `posix` do not
// (word-boundary anchored on both ends).
const SETATTR_TARGET_MODULE_RX = /(?:^|\.)(os|signal|subprocess)$/;

// A quoted, bare identifier string — the symbol-name argument of the member-expression `setattr`
// form: `monkeypatch.setattr(_pp_proc.os, "getpgid", …)`.
const QUOTED_IDENT_RX = /^(['"])([A-Za-z_]\w*)\1$/;

// A quoted DOTTED string — the dotted-string `setattr` form: `monkeypatch.setattr("os.getpgid", …)`.
const QUOTED_DOTTED_RX = /^(['"])([\w]+(?:\.[\w]+)+)\1$/;

// Resolve a `monkeypatch.setattr(target, name, …)` call's first two arguments to a
// `{ module, symbol }` pair, or null when the call does not target one of the three tracked modules.
// Handles both call forms (see the header): member-expression target + quoted name, or one quoted
// dotted string carrying both. `aliasMap` is threaded through so an ALIASED target (`monkeypatch.
// setattr(_os, "getpgid", …)` after `import os as _os`) resolves to its canonical module exactly like
// `_pp_proc.os` does — round-2 finding: this used to be the one detector `buildAttrRefRx` taught about
// aliases that never received the alias map at all.
function resolveSetattrTarget(arg0, arg1, aliasMap) {
  const dotted = QUOTED_DOTTED_RX.exec(arg0.trim());
  if (dotted) {
    const parts = dotted[2].split('.');
    const symbol = parts[parts.length - 1];
    const rawModule = parts[parts.length - 2];
    const module = aliasMap.get(rawModule) ?? rawModule;
    return PY_MODULE_TABLES[module] ? { module, symbol } : null;
  }
  const target = arg0.replace(/\s+/g, '');
  const m = SETATTR_TARGET_MODULE_RX.exec(target);
  let module;
  if (m) {
    module = m[1];
  } else {
    // An ALIAS name never satisfies SETATTR_TARGET_MODULE_RX (it is anchored on the literal
    // os/signal/subprocess word) — resolve it through the alias map before giving up. The alias key
    // is the LAST dotted segment, so both a bare `_os` and a dotted `_pp_proc._os` reach here.
    const resolved = aliasMap.get(target.split('.').pop());
    if (!resolved) return null;
    module = resolved;
  }
  const name = QUOTED_IDENT_RX.exec(arg1.trim());
  if (!name) return null;
  return { module, symbol: name[2] };
}

// One shared per-file, per-line pass for EVERY call-site pattern the Python analysis below looks
// for — THIRD REVIEW PASS (2026-08-05) finding 599b2c/5399d1: `scanCallSites` used to be invoked
// separately per detector (setattr, getattr/hasattr, importorskip, skipif, skip), each
// independently re-walking all `lines.length` lines with its OWN regex — up to six full-file scans
// per file in `--all`, worsened by `hasFileLevelPlatformCover` and `scanSkipCallCovers` BOTH
// scanning `PYTEST_SKIP_CALL_RX` a second time for the very same call sites. `patterns` is
// `{ name: startRx }`; the call SITE is matched against `codeOnlyLines` (comment-stripped AND
// string-blanked, so a call written inside a comment or a fixture/docstring string is never
// mistaken for a live one) and its arguments are read from `realCodeLines` (comment-stripped, string
// content PRESERVED — quoted argument text like `"getpgid"` or `raising=False` is genuine data most
// consumers below need). `codeArgs` — the SAME split, read from the blanked view instead — is ALSO
// returned for the one consumer (`hasFileLevelPlatformCover`'s skipif check) that must not let a
// REASON STRING merely containing text like "sys.platform" counterfeit a structural condition
// (finding 6e44cf). Both views share the same per-line comment-boundary index (`pyFileViews`), so a
// match position found in one lands on the identical column in the other — continuation lines are
// joined from both views in lockstep too, so a stray paren inside a trailing inline comment on a
// wrapped call can never desync the bracket count. Returns `{ name: Call[] }`, one entry per pattern.
function scanAllCallSites(lines, codeOnlyLines, realCodeLines, patterns) {
  const names = Object.keys(patterns);
  const result = Object.fromEntries(names.map((n) => [n, []]));
  for (let i = 0; i < lines.length; i++) {
    for (const name of names) {
      const rx = patterns[name];
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(codeOnlyLines[i])) !== null) {
        const openIdx = m.index + m[0].length - 1;
        let stmt = realCodeLines[i];
        let codeStmt = codeOnlyLines[i];
        let end = i;
        let args = splitCallArgs(stmt, openIdx);
        while (args === null && end + 1 < lines.length && end - i < 20) {
          end += 1;
          stmt += `\n${realCodeLines[end]}`;
          codeStmt += `\n${codeOnlyLines[end]}`;
          args = splitCallArgs(stmt, openIdx);
        }
        if (args === null) continue;
        result[name].push({
          line: i,
          endLine: end,
          args,
          codeArgs: splitCallArgs(codeStmt, openIdx) ?? [],
        });
      }
    }
  }
  return result;
}

const SETATTR_CALL_RX = /\bmonkeypatch\s*\.\s*setattr\s*\(/g;
const RAISING_FALSE_RX = /^raising\s*=\s*False$/;

// Every `monkeypatch.setattr(...)` call in the file, from the shared `scanAllCallSites` pass (round-2:
// this used to scan raw `lines` directly, so a `monkeypatch.setattr(...)` written inside a COMMENT
// counted as a real call, and a comment or fixture string containing `raising=False` text could not
// itself fabricate a cover here — but neither could a genuine call's OWN `raising=False` kwarg be
// told apart from one, which is exactly why the call-site/argument split exists). `text`/`texts`/the
// waiver scan still read the RAW `lines` — a waiver is a comment BY DEFINITION, so it would vanish
// from the comment-stripped view.
function scanSetattrCalls(lines, setattrSites, aliasMap) {
  const calls = [];
  for (const call of setattrSites) {
    if (call.args.length < 2) continue;
    const span = lines.slice(call.line, call.endLine + 1);
    const resolved = resolveSetattrTarget(call.args[0], call.args[1], aliasMap);
    calls.push({
      line: call.line,
      endLine: call.endLine,
      module: resolved?.module ?? null,
      symbol: resolved?.symbol ?? null,
      hasRaisingFalse: call.args.some((a) => RAISING_FALSE_RX.test(a.trim())),
      waived: span.some((l) => WAIVER_RX_PY.test(l)) || waivedFromAbove(lines, call.line, 'py'),
      text: lines[call.line].trim(),
      texts: span.map((l) => l.trim()).filter(Boolean),
    });
  }
  return calls;
}

// A module-qualified attribute reference: `os.getpgid`, `signal.SIGKILL`,
// `subprocess.CREATE_NO_WINDOW`, with an optional dotted prefix (`_pp_proc.os.getpgid`,
// `lib.os.getpgid`). Never a bare identifier — the trailing module name must be immediately followed
// by `.NAME`, which a local variable like `grp` never is. Built PER FILE (not a module-level const)
// because the alternation also carries this file's `import X as Y` aliases (`_os`, `sig`, …) resolved
// through `aliasMap` at match time — see `collectPyImportMaps` below.
function buildAttrRefRx(aliasMap) {
  const names = ['os', 'signal', 'subprocess', ...aliasMap.keys()];
  return new RegExp(
    String.raw`(?:[A-Za-z_]\w*\s*\.\s*)*\b(${names.join('|')})\s*\.\s*([A-Za-z_]\w*)`,
    'g',
  );
}

// A line-initial `import X` / `from X import ...` of a platform-only MODULE (never a bare word
// reference elsewhere on the line — anchored to the statement start).
const PY_IMPORT_RX = /^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/;

// `import <module1> [as <alias1>], <module2> [as <alias2>], …` — the WHOLE comma-joined list after
// `import `, captured so EVERY piece can be walked, not just the first. Round-2 finding 8f2a1b: the
// previous single-alias regex silently dropped every alias after the first in `import os as a, signal
// as b` — the KNOWN BOUND that used to excuse this was wrong; the shape just hadn't been measured yet.
const PY_IMPORT_LINE_RX = /^\s*import\s+(.+)$/;

// One piece of that comma-joined list: a bare module (`os`) or an aliased one (`os as _os`).
const PY_IMPORT_PIECE_RX = /^([A-Za-z_][\w.]*)\s*(?:\bas\s+([A-Za-z_]\w*))?$/;

// `from <module> import <name1>, <name2> as <alias>, …` — captured whenever `<module>` is one of the
// three tracked modules (finding a048d9/dbe6d7: `from signal import SIGKILL`, `from os import
// getpgid`). Only the module + the (possibly parenthesised) import-list TEXT are captured here; the
// parenthesised-continuation join happens in `collectPyImportMaps`, below.
const PY_FROM_IMPORT_RX = /^\s*from\s+([A-Za-z_]\w*)\s+import\s+(.+)$/;

// Best-effort string blanking, THIRD REVIEW PASS (2026-08-05): a single-line quote is blanked
// exactly as before, but a `'''`/`\"\"\"` triple-quoted string is now tracked ACROSS THE WHOLE FILE
// too (finding 5cdd5f — the previous per-line-only scan could not see a multi-line triple-quoted
// span at all, so a docstring merely CONTAINING example text like `pytest.importorskip("fcntl")` or
// `raising=False` counterfeited a real cover, exactly the shape the single-line string blanking
// already prevented for a plain string). A stateful character scan threads `inTriple` (the active
// delimiter, or null) from one line to the next; only the portion that IS the triple-quoted string
// is blanked — code before its opener or after its closer on the same line (`s = """x"""` self-
// closing, or the tail of a line that closes a span opened earlier) is scanned normally for
// single-line quotes. Blanked in BOTH the codeOnly view (so a structural call-site/attribute-
// reference regex never matches text sitting inside a docstring) and the realCodeOnly view (so an
// import-statement regex reading the string-preserved view cannot mistake a docstring's example
// `import fcntl` for a real one either) — a triple-quoted span is prose, not data any detector below
// needs to read, unlike a single-line string's quoted ARGUMENT text (`getattr(os, "getpgid", …)`),
// which stays preserved in realCodeOnly exactly as before. Still best-effort, not full tokenization
// (an f-string's `{expr}` interior, a triple-quote appearing inside an already-open single-quoted
// string, etc. are not specially handled) — the measured corpus shape this closes is a docstring or
// comment-style example, not arbitrary Python syntax.
function scanPyStrings(lines) {
  const codeOnlyLines = new Array(lines.length);
  const realCodeLines = new Array(lines.length);
  let inTriple = null; // the active delimiter ("'''" or `"""`) while a span crosses lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let code = '';
    let real = '';
    let pos = 0;
    let quote = null; // active SINGLE-line quote char while scanning this line
    while (pos < line.length) {
      if (inTriple) {
        const closeIdx = line.indexOf(inTriple, pos);
        const end = closeIdx === -1 ? line.length : closeIdx + inTriple.length;
        code += ' '.repeat(end - pos);
        real += ' '.repeat(end - pos);
        pos = end;
        if (closeIdx !== -1) inTriple = null;
        continue;
      }
      if (quote) {
        const c = line[pos];
        if (c === '\\' && pos + 1 < line.length) {
          code += '  ';
          real += line.slice(pos, pos + 2);
          pos += 2;
          continue;
        }
        code += ' ';
        real += c;
        if (c === quote) quote = null;
        pos += 1;
        continue;
      }
      const c = line[pos];
      if (c === "'" || c === '"') {
        const triple = line.slice(pos, pos + 3);
        if (triple === "'''" || triple === '"""') {
          const closeIdx = line.indexOf(triple, pos + 3);
          const end = closeIdx === -1 ? line.length : closeIdx + 3;
          code += ' '.repeat(end - pos);
          real += ' '.repeat(end - pos);
          pos = end;
          if (closeIdx === -1) inTriple = triple;
          continue;
        }
        quote = c;
        code += ' ';
        real += c;
        pos += 1;
        continue;
      }
      code += c;
      real += c;
      pos += 1;
    }
    codeOnlyLines[i] = code;
    realCodeLines[i] = real;
  }
  return { codeOnlyLines, realCodeLines };
}

// Computes the string-blanked view and the comment boundary ONCE per file, returning both derived
// per-line arrays a caller needs off it — `codeOnlyLines` (blanked AND comment-stripped: what every
// STRUCTURAL regex below wants — an attribute reference, an import statement, a call SITE — immune
// to a comment merely mentioning a symbol name (finding a171fb) and to a string literal merely
// CONTAINING symbol-shaped text (finding ea084a's `s = "getattr(os, 'getpgid')"`, which blanks away
// entirely)) and `realCodeLines` (comment-stripped, single-line string content PRESERVED: what a
// cover detector wants when it needs to read a quoted ARGUMENT — `getattr(os, "getpgid", …)`,
// `pytest.importorskip("fcntl")` — comment-safe without blanking away the very data being read).
function pyFileViews(lines) {
  const { codeOnlyLines, realCodeLines } = scanPyStrings(lines);
  const codeOnly = new Array(lines.length);
  const realCodeOnly = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const idx = codeOnlyLines[i].indexOf('#');
    codeOnly[i] = idx === -1 ? codeOnlyLines[i] : codeOnlyLines[i].slice(0, idx);
    realCodeOnly[i] = idx === -1 ? realCodeLines[i] : realCodeLines[i].slice(0, idx);
  }
  return { codeOnlyLines: codeOnly, realCodeLines: realCodeOnly };
}

// Per-file import maps, built in one pass (finding a048d9/dbe6d7/eb6606/8f2a1b):
//   • `aliasMap`: `import <module> as <alias>` → canonical module, consumed by `buildAttrRefRx`,
//     `resolveSetattrTarget`, and `scanGetattrGuardCovers` alike (round-2: the latter two used to be
//     alias-blind, so an aliased setattr target or getattr/hasattr guard was neither flagged nor
//     honoured as a cover).
//   • `fromBindings`: every name a `from <module> import …` binds into local scope → `{ module,
//     symbol }`, so a LATER bare use of that name (`SIGKILL` after `from signal import SIGKILL`)
//     still counts as a reference — see `findPlatformSymbolRefs`.
//   • `fromImportRefs`: an immediate reference at the import statement itself for every bound name
//     that is platform-only. Python evaluates a `from` import eagerly, so on the platform that lacks
//     the symbol the import ITSELF fails (before the test body, and independently of whether the
//     name is ever used later) — the import line is therefore already sufficient evidence on its own.
// Parsed off literal `import`/`from` statements only, never a bare-word scan — a local variable that
// happens to share a bound name is not reachable through this map at all, only through
// `findPlatformSymbolRefs`' bare-use scan, which resolves purely through `fromBindings`. `realCodeLines`
// is `analyzePython`'s precomputed `pyFileViews(lines).realCodeLines` array (round-2: this used to
// call a per-line string-blanking helper fresh per line even though the caller had already computed it).
//   • `fromImportLines`: every line index that is PART OF a `from …` import statement — the first
//     line plus any parenthesised continuation lines. `findPlatformSymbolRefs` excludes all of them
//     from its "later bare use" scan (round-2 finding: a multi-line `from signal import (\n
//     SIGKILL,\n)` used to leave its continuation line's bare `SIGKILL` text unrecognized as part of
//     the import statement, so it was ALSO counted as a separate "later use" reference on that same
//     line — one import, two findings).
function collectPyImportMaps(lines, realCodeLines) {
  const aliasMap = new Map();
  const fromBindings = new Map();
  const fromImportRefs = [];
  const fromImportLines = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i], 'py')) continue;
    const real = realCodeLines[i];
    // A `;`-separated compound statement (`import os as _os; _os.getpgid(1)`, `import os as o;
    // import signal as sig`) is split into its individual statements first — finding 63e8e3: the
    // import-line regex used to capture EVERYTHING after `import ` to the end of the physical line,
    // so a trailing `; <code>` (or a second `; import …`) was swallowed as one unparseable piece and
    // its own alias silently dropped.
    let matchedImport = false;
    for (const stmt of real.split(';')) {
      const importMatch = PY_IMPORT_LINE_RX.exec(stmt);
      if (!importMatch) continue;
      matchedImport = true;
      for (const raw of importMatch[1].split(',')) {
        const piece = PY_IMPORT_PIECE_RX.exec(raw.trim());
        if (!piece) continue;
        const [, module, alias] = piece;
        if (alias && PY_MODULE_TABLES[module]) aliasMap.set(alias, module);
      }
    }
    if (matchedImport) continue;
    const fromMatch = PY_FROM_IMPORT_RX.exec(real);
    if (!fromMatch || !PY_MODULE_TABLES[fromMatch[1]]) continue;
    const module = fromMatch[1];
    let importList = fromMatch[2];
    let end = i;
    // Parenthesised continuation form: `from signal import (\n    SIGKILL,\n)` (round-2 finding: this
    // used to parse as nothing — a from-import ending in an unclosed `(` is joined with subsequent
    // REAL (comment-stripped, string-preserved) lines until its parens balance).
    while (
      (importList.match(/\(/g) || []).length > (importList.match(/\)/g) || []).length &&
      end + 1 < lines.length &&
      end - i < 20
    ) {
      end += 1;
      importList += `\n${realCodeLines[end]}`;
    }
    for (let j = i; j <= end; j++) fromImportLines.add(j);
    for (const raw of importList.replace(/[()]/g, '').split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const pieceAs = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(piece);
      const symbol = pieceAs ? pieceAs[1] : piece;
      const localName = pieceAs ? pieceAs[2] : piece;
      if (!BARE_IDENT_RX.test(symbol) || !BARE_IDENT_RX.test(localName)) continue;
      fromBindings.set(localName, { module, symbol });
      if (platformDirection(module, symbol))
        fromImportRefs.push({ line: i, kind: 'attr', module, symbol });
    }
  }
  return { aliasMap, fromBindings, fromImportRefs, fromImportLines };
}

// Every platform-only symbol REFERENCE in the file: `{ line, kind: 'attr'|'import', module, symbol }`
// (`symbol` is null for an `import` reference — the module import IS the reference).
function findPlatformSymbolRefs(
  lines,
  codeOnlyLines,
  aliasMap,
  fromBindings,
  fromImportRefs,
  fromImportLines,
) {
  const attrRefRx = buildAttrRefRx(aliasMap);
  const fromNameRx =
    fromBindings.size > 0
      ? new RegExp(String.raw`\b(?:${[...fromBindings.keys()].join('|')})\b`, 'g')
      : null;

  const refs = [...fromImportRefs];
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i], 'py')) continue;
    const codeOnly = codeOnlyLines[i];
    // Read off `codeOnly` (blanked AND comment-stripped), not the raw `lines[i]` — a docstring or
    // fixture string containing example text like `import fcntl` or `from signal import SIGKILL`
    // blanks away entirely in this view (round-3's cross-line triple-quote scanner, `scanPyStrings`
    // above), so it is no longer mistaken for a real import statement the way scanning `lines[i]`
    // directly used to (round-3 false-positive finding: import detection was the one detector left
    // reading the raw line after every other structural regex in this file had already moved onto
    // this same blanked view).
    const importMatch = PY_IMPORT_RX.exec(codeOnly);
    if (importMatch) {
      // `from <module> import …` reaches here too — PY_IMPORT_RX matches the "from"-prefixed form,
      // capturing the FROM module — and that shape names exactly one module, no list to walk. A bare
      // `import <mod1>[, <mod2>, …]` can name several though (finding 7d6735: `import fcntl, msvcrt`
      // used to check only the FIRST comma-separated module, silently missing every one after it).
      const isFromImport = /^\s*from\s+/.test(codeOnly);
      const modules = isFromImport
        ? [importMatch[1].split('.')[0]]
        : codeOnly
            .replace(/^\s*import\s+/, '')
            .split(',')
            .map(
              (piece) =>
                piece
                  .trim()
                  .split(/\s+as\s+/)[0]
                  .split('.')[0],
            );
      for (const module of modules) {
        if (POSIX_ONLY_MODULES.has(module) || WINDOWS_ONLY_MODULES.has(module)) {
          refs.push({ line: i, kind: 'import', module, symbol: null });
        }
      }
    }
    attrRefRx.lastIndex = 0;
    let m;
    while ((m = attrRefRx.exec(codeOnly)) !== null) {
      const [, rawModule, symbol] = m;
      const module = aliasMap.get(rawModule) ?? rawModule;
      if (platformDirection(module, symbol)) refs.push({ line: i, kind: 'attr', module, symbol });
    }
    // A later bare use of a `from <module> import <name>`-bound name — skip every line of the import
    // statement itself (single-line or, round-2, parenthesised-multi-line), already reported via
    // `fromImportRefs` above.
    if (fromNameRx && !fromImportLines.has(i)) {
      fromNameRx.lastIndex = 0;
      let fm;
      while ((fm = fromNameRx.exec(codeOnly)) !== null) {
        const info = fromBindings.get(fm[0]);
        if (info && platformDirection(info.module, info.symbol)) {
          refs.push({ line: i, kind: 'attr', module: info.module, symbol: info.symbol });
        }
      }
    }
  }
  return refs;
}

// Optional `async ` prefix (round-2 finding: an `async def` used to collapse into span -1 — no def
// matched, no scope — and every getattr/hasattr guard AND every reference in every async test then
// shared that same non-scope, so a guard in one async test wrongly covered an unguarded use in another).
const PY_DEF_RX = /^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/;

// Line spans (half-open, 0-based) of each `def ...(): ...` block, delimited by INDENTATION: a block
// ends at the first later non-blank, non-comment line whose indentation is <= the def line's own.
// NESTED defs are found too (every line is scanned, not just the top level), so `spans` holds BOTH an
// outer function's span and any inner one — `pyEnclosingSpan` below picks the innermost. Mirrors how
// `platformPinnedSpans` (JS side, above) scopes a platform pin to its enclosing `test(...)` block.
function pyFunctionSpans(lines) {
  const spans = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF_RX.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim() || isCommentLine(lines[j], 'py')) continue;
      if (lines[j].length - lines[j].trimStart().length <= indent) {
        end = j;
        break;
      }
    }
    spans.push([i, end]);
  }
  return spans;
}

// The INNERMOST span enclosing `line`, or -1. Round-2 finding: a plain `Array#findIndex` returns the
// FIRST span containing `line` in array order — and since `pyFunctionSpans` pushes an outer `def`
// before any function nested inside it, that first match is always the OUTERMOST (widest) span, the
// opposite of what every caller wants. The innermost is the containing span with the LATEST start.
function pyEnclosingSpan(spans, line) {
  let best = -1;
  for (let i = 0; i < spans.length; i++) {
    const [s, e] = spans[i];
    if (line < s || line >= e) continue;
    if (best === -1 || s > spans[best][0]) best = i;
  }
  return best;
}

const GETATTR_HASATTR_CALL_RX = /\b(?:getattr|hasattr)\s*\(/g;
const QUOTED_IDENT_ARG_RX = /^(['"])([A-Za-z_]\w*)\1$/;

// `"<spanIndex>:<module>.<symbol>"` covers named by a `getattr(<mod>, "<NAME>", …)` /
// `hasattr(<mod>, "<NAME>")` guard, SCOPED to the enclosing (innermost) `def` block (`spanIndex` is -1
// for a guard outside any function). Finding c49a16: unlike the setattr/skip covers above —
// deliberately FILE-level, because a fixture or conftest.py can legitimately supply the
// `raising=False` setattr or the skip from OUTSIDE the consuming test (see the KNOWN BOUND) — a
// getattr/hasattr call is a PROBE, not a mutation or a collection-time skip: it proves the symbol's
// existence was CHECKED, not that any later access is actually gated on the result. Trusting it
// file-wide let a probe in one test silence an unguarded access in a wholly unrelated one, so it is
// scoped like the JS side's `platformPinnedSpans` instead. `aliasMap` is threaded through (round-2:
// this detector used to read only the LITERAL module name, so a guard written as `getattr(_os,
// "getpgid", …)` after `import os as _os` neither resolved nor covered anything).
function scanGetattrGuardCovers(getattrHasattrSites, spans, aliasMap) {
  const covered = new Set();
  for (const call of getattrHasattrSites) {
    if (call.args.length < 2) continue;
    const rawModule = call.args[0].replace(/\s+/g, '').split('.').pop();
    const module = aliasMap.get(rawModule) ?? rawModule;
    if (!PY_MODULE_TABLES[module]) continue;
    const symMatch = QUOTED_IDENT_ARG_RX.exec(call.args[1].trim());
    if (!symMatch) continue;
    covered.add(`${pyEnclosingSpan(spans, call.line)}:${module}.${symMatch[2]}`);
  }
  return covered;
}

const IMPORTORSKIP_CALL_RX = /\bpytest\s*\.\s*importorskip\s*\(/g;
const QUOTED_MODULE_ARG_RX = /^(['"])([\w.]+)\1$/;

// `"<spanIndex>:<module>"` covers named by a `pytest.importorskip("<module>")` call, SCOPED to the
// enclosing (innermost) `def` block exactly like the getattr/hasattr guard above (`spanIndex` is -1
// for a call outside any function — a MODULE-level `importorskip` fails collection for the whole
// file, so it correctly covers everything). Finding 0a0dfa: this used to add every skipped module to
// a FILE-wide set regardless of where the call sat, so a test-local `importorskip("fcntl")` inside
// one test silenced an unguarded `import fcntl` in a wholly unrelated test in the same file — the
// same over-trusting shape the getattr/hasattr guard's own c49a16 fix already closed for its cousin.
// Round-2 finding (still true here): this used to regex-scan the file's REAL (string-preserved) text
// directly, so a fixture STRING merely CONTAINING the text `pytest.importorskip("fcntl")` — never
// itself a call — could counterfeit a real cover; the call SITE is now found on the blanked view, and
// only the argument of a call that survives there is read from the real one.
function scanImportorskipCovers(importorskipSites, spans) {
  const covered = new Set();
  for (const call of importorskipSites) {
    const mod = QUOTED_MODULE_ARG_RX.exec((call.args[0] ?? '').trim());
    if (!mod) continue;
    const spanIndex = pyEnclosingSpan(spans, call.line);
    covered.add(`${spanIndex}:${mod[2].split('.')[0]}`);
  }
  return covered;
}

const SYS_PLATFORM_OR_OS_NAME_RX = /sys\s*\.\s*platform|os\s*\.\s*name/;
const SKIPIF_MARK_CALL_RX = /\bpytest\s*\.\s*mark\s*\.\s*skipif\s*\(/g;
const PYTEST_SKIP_CALL_RX = /\bpytest\s*\.\s*skip\s*\(/g;

// A `pytest.mark.skipif(...)` call (including the `pytestmark = ...` module-level assignment form,
// which is the same call text) whose CONDITION mentions `sys.platform` or `os.name`. Tested against
// `call.codeArgs` — the string-BLANKED view — not `call.args`, on purpose (finding 6e44cf): the
// latter preserves quoted text, so `@pytest.mark.skipif(False, reason="sys.platform is irrelevant")`
// used to read as a real platform condition even though the condition is a literal `False` and the
// match only came from the human-readable REASON string. A genuine `sys.platform == "..."` condition
// is never inside quotes, so it still matches on the blanked view exactly the same. File-level and
// generic on purpose otherwise (see the header's shape-5 KNOWN BOUND): once present, the WHOLE file
// already will not run on the wrong platform, so every reference in it is covered — shape (4) too,
// since plan 2853's review pass (finding b72cae). A bare, module-level `pytest.skip(...)` (the
// `allow_module_level=True` collection-time-skip shape) mentioning the same is ALSO file-level here —
// see `scanSkipCallCovers` below for the different, per-function treatment a `pytest.skip(...)` INSIDE
// a `def` gets. `skipSites` is the SAME pre-scanned `PYTEST_SKIP_CALL_RX` list `scanSkipCallCovers`
// consumes (finding 5399d1: these two used to each independently re-scan the whole file for the
// identical call pattern).
function hasFileLevelPlatformCover(skipifSites, skipSites, spans) {
  for (const call of skipifSites) {
    if (SYS_PLATFORM_OR_OS_NAME_RX.test(call.codeArgs.join(', '))) return true;
  }
  for (const call of skipSites) {
    if (pyEnclosingSpan(spans, call.line) !== -1) continue; // scoped instead — see scanSkipCallCovers.
    if (SYS_PLATFORM_OR_OS_NAME_RX.test(call.args.join(', '))) return true;
  }
  return false;
}

// Span indices (see `pyFunctionSpans`/`pyEnclosingSpan`) covered by a runtime `pytest.skip(...)` CALL,
// mentioning `sys.platform`/`os.name`, that sits INSIDE a `def` block — mapped to the EARLIEST such
// skip call's own line in that span, not merely a boolean "somewhere in here" (finding 229495: a
// `pytest.skip(...)` is a RUNTIME statement, so it can only ever protect an access that runs AFTER
// it; `monkeypatch.setattr(os, "getpgid", fake)` on line 2 of a function followed by
// `pytest.skip("...sys.platform...")` on line 3 still raises on Windows at line 2, before the skip is
// ever reached, and used to be silently waved through because the whole span was marked covered
// regardless of statement order). Round-2 finding: a bare `pytest.skip(...)` used to be judged by the
// SAME file-level rule as `pytest.mark.skipif` — but a decorator/`pytestmark` genuinely gates the
// whole file's collection, while a `pytest.skip(...)` CALL inside one test body is a runtime
// statement that only ever skips THAT test; treating it as file-wide let one test's unconditional
// skip silence an unrelated test's real violation elsewhere in the same file. Scoped to the enclosing
// span instead — mirrors the getattr/hasattr guard's own scoping (finding c49a16's sibling). A skip
// found OUTSIDE every span (index -1) is genuinely file-wide instead (the `allow_module_level=True`
// shape) and is handled by `hasFileLevelPlatformCover` above, not here.
function scanSkipCallCovers(skipSites, spans) {
  const covered = new Map(); // spanIndex -> earliest covering skip-call line in that span
  for (const call of skipSites) {
    if (!SYS_PLATFORM_OR_OS_NAME_RX.test(call.args.join(', '))) continue;
    const spanIndex = pyEnclosingSpan(spans, call.line);
    if (spanIndex === -1) continue;
    const prior = covered.get(spanIndex);
    if (prior === undefined || call.line < prior) covered.set(spanIndex, call.line);
  }
  return covered;
}

// PURE core, Python side. Mirrors `analyze()`'s contract: given a test file's full text, return
// every violation as `{ line, endLine, kind, text, texts, detail }` (1-based line numbers).
//
// Every per-line derived view (`codeOnlyLines`, `realCodeLines`) and the function-span table is
// computed exactly ONCE here and threaded through every detector below, instead of each detector
// re-deriving its own text with a fresh `lines.join('\n')` (finding 5446c1) off the raw, un-tokenized
// source (finding ea084a). `aliasMap` is built FIRST (round-2) so both `scanSetattrCalls` and
// `scanGetattrGuardCovers` — the two detectors round 1 left alias-blind — can resolve through it.
export function analyzePython(text) {
  const lines = text.split('\n');
  const { codeOnlyLines, realCodeLines } = pyFileViews(lines);
  const spans = pyFunctionSpans(lines);

  // One shared per-file scan for every call-site pattern below (finding 599b2c/5399d1) — replaces
  // what used to be up to six independent full-file `scanCallSites` passes, one PYTEST_SKIP_CALL_RX
  // scan duplicated between hasFileLevelPlatformCover and scanSkipCallCovers among them.
  const sites = scanAllCallSites(lines, codeOnlyLines, realCodeLines, {
    setattr: SETATTR_CALL_RX,
    getattrHasattr: GETATTR_HASATTR_CALL_RX,
    importorskip: IMPORTORSKIP_CALL_RX,
    skipif: SKIPIF_MARK_CALL_RX,
    skip: PYTEST_SKIP_CALL_RX,
  });

  const { aliasMap, fromBindings, fromImportRefs, fromImportLines } = collectPyImportMaps(
    lines,
    realCodeLines,
  );
  const setattrCalls = scanSetattrCalls(lines, sites.setattr, aliasMap);
  const coveredBySetattr = new Set(
    setattrCalls.filter((c) => c.hasRaisingFalse && c.module).map((c) => `${c.module}.${c.symbol}`),
  );
  const coveredByGetattrGuard = scanGetattrGuardCovers(sites.getattrHasattr, spans, aliasMap);
  const coveredByImportorskip = scanImportorskipCovers(sites.importorskip, spans);
  const fileWideCover = hasFileLevelPlatformCover(sites.skipif, sites.skip, spans);
  const skipCoveredSpans = scanSkipCallCovers(sites.skip, spans);
  // A `pytest.skip(...)` cover only protects a REFERENCE from its own line onward (finding 229495 —
  // see scanSkipCallCovers's header comment): a bare boolean "this span is covered" would wrongly
  // clear an access that runs BEFORE the skip statement is ever reached.
  const isPlatformCovered = (line) => {
    if (fileWideCover) return true;
    const skipLine = skipCoveredSpans.get(pyEnclosingSpan(spans, line));
    return skipLine !== undefined && line >= skipLine;
  };
  // `pytest.importorskip` cover-lookup: true when EITHER a module-level call covers the whole file
  // (`-1:<module>`, spanIndex -1) or a call in the SAME function covers this reference's own span
  // (finding 0a0dfa — see scanImportorskipCovers's header comment).
  const importorskipCovers = (module, line) =>
    coveredByImportorskip.has(`-1:${module}`) ||
    coveredByImportorskip.has(`${pyEnclosingSpan(spans, line)}:${module}`);

  const violations = [];

  // Shape (4). A file-level skip/pytestmark/importorskip cover exempts it too (finding b72cae): a
  // test the whole file already will not run on the wrong platform needs no `raising=False` of its
  // own — the same reasoning the KNOWN BOUND above already applies to shape (5). A per-function
  // `pytest.skip(...)` cover (round-2) exempts a setattr in that SAME function too.
  const shape4Flagged = new Set(); // `${line}:${module}.${symbol}` — feeds the shape-5 dedupe below.
  for (const c of setattrCalls) {
    if (c.hasRaisingFalse || c.waived || !c.module || isPlatformCovered(c.line)) continue;
    const direction = platformDirection(c.module, c.symbol);
    if (!direction) continue;
    shape4Flagged.add(`${c.line}:${c.module}.${c.symbol}`);
    violations.push({
      line: c.line + 1,
      endLine: c.endLine + 1,
      kind: 'py-unguarded-platform-setattr',
      text: c.text,
      texts: c.texts,
      detail: `${c.module}.${c.symbol} — ${direction} — monkeypatch.setattr without raising=False`,
    });
  }

  // Shape (5).
  for (const ref of findPlatformSymbolRefs(
    lines,
    codeOnlyLines,
    aliasMap,
    fromBindings,
    fromImportRefs,
    fromImportLines,
  )) {
    if (isPlatformCovered(ref.line)) continue;
    if (isCommentLine(lines[ref.line], 'py')) continue;
    if (WAIVER_RX_PY.test(lines[ref.line]) || waivedFromAbove(lines, ref.line, 'py')) continue;
    if (ref.kind === 'import') {
      if (importorskipCovers(ref.module, ref.line)) continue;
      const direction = POSIX_ONLY_MODULES.has(ref.module)
        ? 'POSIX-only — absent on Windows'
        : 'Windows-only — absent on Linux';
      violations.push({
        line: ref.line + 1,
        endLine: ref.line + 1,
        kind: 'py-uncovered-platform-symbol',
        text: lines[ref.line].trim(),
        texts: [lines[ref.line].trim()],
        detail: `import ${ref.module} — ${direction} — no cover in this file`,
      });
      continue;
    }
    const key = `${ref.module}.${ref.symbol}`;
    // Finding 74f4f2: an unguarded setattr already reports shape (4) for this exact line+symbol —
    // don't also report shape (5) for the same offence. A DIFFERENT line stays a separate report.
    if (shape4Flagged.has(`${ref.line}:${key}`)) continue;
    if (coveredBySetattr.has(key)) continue;
    if (coveredByGetattrGuard.has(`${pyEnclosingSpan(spans, ref.line)}:${key}`)) continue;
    violations.push({
      line: ref.line + 1,
      endLine: ref.line + 1,
      kind: 'py-uncovered-platform-symbol',
      text: lines[ref.line].trim(),
      texts: [lines[ref.line].trim()],
      detail: `${key} — ${platformDirection(ref.module, ref.symbol)} — no cover in this file`,
    });
  }

  return violations;
}

// Dispatches on a language tag. The ONE place that decides `analyze` vs `analyzePython` — `analyzeFor`
// and `violationsIntroduced` are both thin wrappers over this, and `runCorpusSweep`'s two loops route
// through `analyzeFor` directly, so there is exactly one dispatcher, not the two independent ternaries
// that used to sit here (finding 8ecfaa: `analyzeFor` was exported and tested but never actually
// called from production code, which could silently drift from the inline dispatch everywhere else).
function analyzeByLang(lang, text) {
  return lang === 'py' ? analyzePython(text) : analyze(text);
}

// Dispatches on `langFor(path)`. The single entry point main(), the diff-scoped filter, and the
// `--all` corpus sweep all use this — so neither has to branch on the extension itself.
export function analyzeFor(path, text) {
  return analyzeByLang(langFor(path), text);
}

// ── diff scoping ──────────────────────────────────────────────────────────────

// Map of in-scope file → Set of trimmed line texts ADDED by the range. The walk itself is the
// shared seam-guard-lib primitive; only this gate's scope predicates are bound here.
export function collectAddedByFile(diffText) {
  return collectAddedByFileShared(diffText, { inScope, isExempt });
}

// Keep only the violations the range INTRODUCED. Matching on line TEXT rather than line number is
// deliberate: an added line's number in the post-image is a second thing that can drift (a rename,
// a `--find-renames` remap), whereas its text is exactly what the diff reports. The residual is a
// safe-direction false positive — re-adding an identical violating line elsewhere in the same file
// is still reported, which is correct anyway.
//
// ANY line of a multi-line assertion counts, not just its first: a diff that rewrites only the
// expected value of an already-multi-line `assert.equal(\n  actual,\n  '/somewhere/.git',\n)` adds
// no new first line, and matching on that alone would let the introduced violation through.
export function violationsIntroduced(fileText, addedTexts, lang = 'js') {
  const violations = analyzeByLang(lang, fileText);
  return violations.filter((v) => v.texts.some((t) => addedTexts.has(t)));
}

// ── reporting ─────────────────────────────────────────────────────────────────

const FIX_ADVICE = [
  '',
  'A path SPELLING is platform-specific; a path IDENTITY is not. Fix by one of:',
  '',
  '  • compare through the shared helper —',
  "      import { assertSamePath } from './test-path-assert.mjs';",
  '      assertSamePath(fromWorktree, fromMain);',
  '    (it normalizes separators + drive-letter case, and prints both raw and normalized forms',
  '     on failure, so a REAL mismatch is still readable.)',
  '',
  '  • ANCHOR the fixture — hoist a drive-QUALIFIED root and feed it to BOTH the unit under test',
  '    and the expectation, instead of hardcoding a POSIX literal on either side:',
  "      const anchor = resolve('/c');                    // C:\\c on Windows, /c on POSIX",
  '      assert.equal(entryPath(anchor, KEY), join(anchor, `${KEY}.json`));',
  '    join() and resolve() agree on a drive-qualified root, so the fixture survives a future',
  '    migration between them. Merely swapping the EXPECTED side to `resolve(…)` is not enough for',
  "    [join-rooted-literal]: it re-couples the fixture to the implementation's CURRENT primitive,",
  '    which is the disease, not the cure.',
  '    (Exception — when a drive-LESS input is the POINT of the case, i.e. it is what exercises the',
  '     drive-prepending branch, keep the input and derive the expectation with the SAME primitive',
  '     the implementation uses. A `resolve(…)`-rooted expectation is deliberately not flagged.)',
  '',
  '  • pin the platform when the POINT of the case is Windows (or POSIX) semantics: inject',
  '    `_path: win32` / `_path: posix` into the unit under test (the plan-2489 pattern). A pinned',
  '    test block is exempt from this gate — and it validates Windows behaviour from ANY host,',
  '    which a real Windows runner would be needed for otherwise.',
  '',
  'Genuinely-deliberate case (e.g. two strings that must be BYTE-identical, not merely equivalent):',
  'waive it in place with `// path-assert-ok: <reason>` on the line or the line above.',
  '',
  'Why this is gated: cloud drains run on Linux and local sessions run on Windows, so a POSIX-only',
  'path assertion lands green and then blocks an UNRELATED plan whose diff happens to pull the test',
  'into the import-closure battery (plan 2478 → 2462). Plan 2490.',
  '',
];

const PY_KINDS = new Set(['py-unguarded-platform-setattr', 'py-uncovered-platform-symbol']);

const AMBIENT_LOAD_KINDS = new Set(['ambient-load-freemem', 'ambient-load-elapsed-ceiling']);

const AMBIENT_LOAD_FIX_ADVICE = [
  '',
  'Free memory and real elapsed wall-clock time are properties of the MACHINE at the moment a test',
  'happens to run, not of the code under test, and this repo runs several parallel sessions sharing',
  'one box on purpose. Fix by one of:',
  '',
  '  • inject the reading instead of calling it live —',
  '      perSlotWorkerBudgetDetail(cpu, env, { freemem: () => 40_000_000_000 })',
  '    (or the `PYTEST_MEMORY_FREE_BYTES` / `PYTEST_MEMORY_BUDGET` env pins, for a real CLI',
  '     subprocess a test cannot hand `opts` to directly.)',
  '',
  '  • assert event ORDER or exit-code IDENTITY instead of an elapsed ceiling, when the real',
  '    property is "X happened before a cap could fire" —',
  '      assert.match(stdout, /LAST_STATUS=1$/m); // a real failure, never the timeout kill code',
  '',
  '  • drive a PURE function with an injected clock when duration genuinely is the property (never',
  '    a real spawned child — a fake clock cannot drive one).',
  '',
  '  • a poll loop waiting on a real signal keeps at most ONE generous, NAMED hang backstop instead',
  '    of several tuned figures — and still waives, since it remains a real wall-clock bound.',
  '',
  'Genuinely-deliberate case (a named hang backstop, the one real-spawn smoke test a fixture-timing',
  'fix may leave in place): waive it in place with `// ambient-load-ok: <reason>` on the line or the',
  'line above.',
  '',
  'Why this is gated: three `scripts/*.test.mjs` files each asserted on live machine state — two',
  'independent `os.freemem()` reads minutes apart, several `wallMs < N` wall-clock ceilings, a',
  'fixture timer racing a module quiet-window clock — and cost three plans 10, 4, 2, and 1 extra',
  'land attempts before this axis had a gate. Plan 4005.',
  '',
];

const PY_FIX_ADVICE = [
  '',
  'A test that exercises a platform-specific branch must make the platform a PARAMETER, and must',
  "supply that platform's SYMBOLS too, not just its name. Faking `sys.platform` without faking",
  '`os.getpgid` / `os.killpg` / `signal.SIGKILL` (or whichever platform-only attribute the branch',
  'actually reaches) is a half-injection that only appears to work on the platform that already had',
  'them. Fix by one of:',
  '',
  '  • add `raising=False` to the `monkeypatch.setattr` —',
  '      monkeypatch.setattr(_pp_proc.os, "getpgid", fake_getpgid, raising=False)',
  '',
  '  • for a CONSTANT consumed as an argument (never itself the target of a setattr), fake it too —',
  '      monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)',
  '',
  '  • or skip the test outright on the platform that lacks the symbol —',
  '      @pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only: os.getpgid/killpg")',
  '',
  'Genuinely-deliberate case: waive it in place with `# path-assert-ok: <reason>` or',
  '`# platform-assert-ok: <reason>` on the line or the line above.',
  '',
  'Why this is gated: `_pp_proc.kill_tree` called `os.killpg(os.getpgid(pid), signal.SIGKILL)`; on a',
  'Windows host `signal.SIGKILL` does not exist, so argument evaluation raised AFTER `getpgid` ran but',
  "BEFORE `killpg` ever did, and `kill_tree`'s own `except Exception: pass` swallowed it — it read",
  'like a `killpg` bug and was really a missing constant several calls upstream. Plan 2853.',
  '',
];

// Shape (7) REPORTS but does not BLOCK (plan 4005, round-2 decision). Shapes (1)-(6) are unchanged
// and still block.
//
// Why this one is advisory while its siblings are not: (1)-(6) key on a small, closed vocabulary
// (a POSIX path literal, a named platform symbol, a tmpdir root) that is cheap to recognise
// exactly. (7) has to decide whether an arbitrary line of JS is executable host code, which means
// lexing the language — comments, string and template nesting, interpolation, multi-line bindings —
// with regexes over raw lines. Two review rounds on this file argued that point 25 more ways, and
// round 1's own fix for a false POSITIVE introduced a silent false NEGATIVE (46083f: one unmatched
// backtick in a block comment blinded the rest of the file). That is the honest signal about how
// far a line-based scanner gets, and a gate that can be wrong in both directions should not be able
// to reject an unrelated session's push while it settles.
//
// This repo already reasons this way where a guard cannot be exact: `worktree-guard.sh`'s pytest
// sweep deny "fails OPEN by design and is not a guarantee" for the same reason — a false DENY parks
// an unattended session on a prompt nobody can approve, and one missed sweep is the cheaper error.
// `hand-rolled-step-guard.mjs` WARNS and never blocks on the same principle.
//
// KNOWN BOUNDS, pinned so the next reader does not rediscover them as bugs (all surfaced by the
// plan-4005 review rounds, all judged acceptable for an advisory and none of them silent):
//   - a shorthand/class method named `freemem() {}` reads as a live call (0 occurrences in the
//     corpus today, so this is hypothetical rather than measured);
//   - an aliased namespace import (`import * as o from 'node:os'; o.freemem()`) is not recognised;
//   - a single-line fixture template is not distinguished from host code;
//   - a live `${...}` interpolation inside a multi-line template is skipped with the fixture body;
//   - a binding split across lines is not seen;
//   - `STRING_LITERAL_RX` does not model escaped quotes.
// Promoting (7) to blocking is a deliberate follow-up: it wants these closed, most likely by
// lexing with a real parser rather than another regex round.
const AMBIENT_LOAD_ADVISORY = true;

/** Pure: does this violation set contain anything that may FAIL the gate? Shape (7) findings are
 *  reported either way (see AMBIENT_LOAD_ADVISORY above) but never decide the exit code while the
 *  advisory flag stands, so a run whose only findings are ambient-load exits 0. */
export function hasBlockingViolation(byFile) {
  for (const vs of byFile.values()) {
    for (const v of vs) {
      if (!AMBIENT_LOAD_ADVISORY || !AMBIENT_LOAD_KINDS.has(v.kind)) return true;
    }
  }
  return false;
}

function report(byFile) {
  // The heading states what this run will actually DO, and names the axis honestly: an
  // ambient-load-only run neither blocks nor found a path/symbol problem, and saying "BLOCKED —
  // platform-dependent path/symbol assertion(s)" over a lone timing finding misdescribes both
  // (round-1 finding 2948d5).
  const blocking = hasBlockingViolation(byFile);
  const onlyAmbient = !blocking;
  console.error(
    onlyAmbient
      ? '\nassert-posix-path-assertions: ADVISORY — ambient-load-sensitive assertion(s) in test ' +
          'code (reported, not blocking):\n'
      : '\nassert-posix-path-assertions: BLOCKED — new platform-dependent path/symbol assertion(s):\n',
  );
  let hasJsKind = false;
  let hasPyKind = false;
  let hasAmbientLoadKind = false;
  for (const [file, vs] of byFile) {
    console.error(`  ✗ ${file}`);
    for (const v of vs) {
      console.error(`      line ${v.line} [${v.kind}] ${v.detail}`);
      console.error(`        ${v.text}`);
      if (PY_KINDS.has(v.kind)) hasPyKind = true;
      else if (AMBIENT_LOAD_KINDS.has(v.kind)) hasAmbientLoadKind = true;
      else hasJsKind = true;
    }
  }
  if (hasJsKind) console.error(FIX_ADVICE.join('\n'));
  if (hasAmbientLoadKind) console.error(AMBIENT_LOAD_FIX_ADVICE.join('\n'));
  if (hasPyKind) console.error(PY_FIX_ADVICE.join('\n'));
}

// ── main (skipped when imported as a module for the unit test) ────────────────

// Explicit non-source directories to never descend into — NOT a blanket "skip every dot-directory"
// rule (that used to live here and was the bug, round-2 finding: `inScope` and the `:(glob)` git
// pathspec both admit a hidden directory — git's `**` glob magic matches dotfiles the same as any
// other path segment — so a walker that silently excluded every `.foo/` diverged from what the
// diff-scoped gate actually judges, and `--all` could report "corpus clean" over files the push-time
// gate does see). `.venv` is named explicitly instead: a checked-in virtualenv would be large and, by
// construction, holds no `test_*.py`/`conftest.py` content; `__pycache__` likewise churns every run
// and can never hold source. Applied to BOTH the JS and Python walk below; harmless on the JS side,
// which never has one of these under `scripts/` today, and keeps the two walks from silently drifting
// on this rule in only one of them (finding 1aa121).
export const CORPUS_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.venv']);

// Every in-scope file under `rel`, repo-relative. Unsorted — `walkFilesUnder` is the RECURSIVE part,
// shared by both the JS (`scripts/`) and Python (`backend/scripts/`) corpora, matching SCOPE_PATHSPECS
// rather than a flat top-level glob: `scripts/` is not flat (`scripts/lib/decision-dossier/
// inline.test.mjs` exists), and a `--all` that scanned only the top level would report "corpus clean"
// over files the diff-scoped gate does judge. `inScope` alone decides membership, so this walker
// needs no JS/Python branch of its own — used to be two near-identical copies (finding 1aa121).
function walkFilesUnder(rel) {
  const out = [];
  for (const entry of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (CORPUS_SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkFilesUnder(`${rel}/${entry.name}`));
      continue;
    }
    const child = `${rel}/${entry.name}`;
    if (inScope(child)) out.push(child);
  }
  return out;
}

// Sorted ONCE, at the top — round-2 finding: `listFilesUnder` used to BE the recursive function and
// `.sort()` its own return at every level, so a leaf subtree was sorted, handed unsorted into its
// parent's `out.push(...)`, and re-sorted again at every ancestor up to the root — an O(depth) pile of
// wasted sorts on top of the one that actually matters.
function listFilesUnder(rel) {
  return walkFilesUnder(rel).sort();
}

// `--all`: sweep the whole working-tree corpus, JS AND Python (plan 2490 acceptance 2; Python side
// added plan 2853). Not what the hook runs — an unconditional corpus grep would block every
// unrelated push on a pre-existing instance. Routes every file through `analyzeFor` (the one
// authoritative dispatcher, finding 8ecfaa) rather than picking `analyze`/`analyzePython` by hand.
function runCorpusSweep() {
  const jsFiles = listFilesUnder('scripts').filter((f) => !isExempt(f));
  const pyFiles = listFilesUnder('backend/scripts').filter((f) => !isExempt(f));
  const byFile = new Map();
  let total = 0;
  for (const file of [...jsFiles, ...pyFiles]) {
    const vs = analyzeFor(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
    if (vs.length) {
      byFile.set(file, vs);
      total += vs.length;
    }
  }
  if (total === 0) {
    console.log(
      `assert-posix-path-assertions: corpus clean (${jsFiles.length} scripts/**/*.test.mjs + ` +
        `${pyFiles.length} backend/scripts/**/*.py scanned).`,
    );
    process.exit(0);
  }
  console.error(`\nassert-posix-path-assertions: corpus sweep — ${total} instance(s):\n`);
  for (const [file, vs] of byFile) {
    console.error(`  ✗ ${file}`);
    for (const v of vs) console.error(`      line ${v.line} [${v.kind}] ${v.text}`);
  }
  if (!hasBlockingViolation(byFile)) {
    console.error(
      '\nassert-posix-path-assertions: every instance above is ambient-load (shape 7), which is ' +
        'ADVISORY — reported, never blocking. Exiting 0; see AMBIENT_LOAD_ADVISORY for why and ' +
        'for the known bounds.',
    );
    process.exit(0);
  }
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--all') return runCorpusSweep();

  const ranges = resolveGuardRanges(REPO_ROOT, argv);
  const SKIP =
    'assert-posix-path-assertions: SKIPPED (origin/master unresolvable or a diff/blob read failed — ' +
    'the done-worktree land re-runs this gate, so a skipped worktree push is re-checked).';
  if (ranges === null) {
    console.log(SKIP);
    process.exit(0);
  }

  const byFile = new Map();
  for (const range of ranges) {
    let diffText;
    try {
      diffText = fetchRangeDiff(REPO_ROOT, range, SCOPE_PATHSPECS);
    } catch (e) {
      console.log(`${SKIP} [${errText(e)}]`);
      process.exit(0);
    }
    const tip = rangeTip(range);
    for (const [file, addedTexts] of collectAddedByFile(diffText)) {
      // The post-image as COMMITTED at this range's tip — never the working tree, which on a
      // multi-ref push belongs to whichever branch happens to be checked out (the plan-1737
      // wrong-ref lesson). A file deleted by the range has no post-image and no added lines.
      const res = readFileAtTip(REPO_ROOT, tip, file);
      if (!res.ok) {
        if (res.absent) continue;
        console.log(`${SKIP} [${file}: ${errText(res.error)}]`);
        process.exit(0);
      }
      // De-duplicated by line+kind: a rare multi-ref push can carry the SAME file in two ranges
      // (e.g. a branch and the master it was cut from), and reporting one violation twice reads
      // like two separate offences.
      const existing = byFile.get(file) ?? [];
      const seen = new Set(existing.map((v) => `${v.line}:${v.kind}`));
      const fresh = violationsIntroduced(res.content, addedTexts, langFor(file)).filter(
        (v) => !seen.has(`${v.line}:${v.kind}`),
      );
      if (fresh.length) byFile.set(file, [...existing, ...fresh]);
    }
  }

  if (byFile.size === 0) {
    console.log(
      'assert-posix-path-assertions: clean (no new platform-dependent path/symbol assertions in ' +
        'scripts/**/*.test.mjs or backend/scripts/**/*.py).',
    );
    process.exit(0);
  }
  report(byFile);
  if (!hasBlockingViolation(byFile)) {
    console.error(
      '\nassert-posix-path-assertions: every finding above is ambient-load (shape 7), which is ' +
        'ADVISORY — reported, never blocking. Exiting 0; see AMBIENT_LOAD_ADVISORY for why and ' +
        'for the known bounds.',
    );
    process.exit(0);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
