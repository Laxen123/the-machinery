#!/usr/bin/env node
// scripts/coord/record-marker-cli.mjs  (plan 2042)
// The ONE record-CLI protocol behind the three sha-pinned marker writers —
// scripts/record-review.mjs (plan 337), record-wiki.mjs (plan 1074) and
// record-conclusion.mjs (plan 2033). Before this module the ~400-line protocol
// (session-file resolution, plan-1105 branch-refuse guard, plan-1286 coord-checkout
// routed write, plan-1528 repin with the patch-id gate) was copy-pasted per family, so
// every fix to the shared contract had to be hand-applied three times and missing one
// left that gate silently divergent. The three scripts keep their FILENAMES (the spine
// and the docs name them) and their per-family strings/validation; their bodies delegate
// here. record-review.mjs additionally layers its findings/disposition machinery on top
// of these primitives — that surface is review-specific and stays there.
//
// The marker grammar/parse/upsert themselves live in done-worktree-lib.mjs
// (MARKER_FAMILIES + parseMarkerAny/parseMarkerCurrent/upsertMarker) — this module owns
// only the CLI protocol around them.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveMain,
  pushMasterWithRebase,
  gitWithLockRetry,
  commitSubjectAtHead,
  isNothingToCommit,
  errText,
  GIT_MAXBUFFER,
  withCoordCheckout,
  coordWrite,
} from './coord-git.mjs';
import { loadCoordConfig } from './coord-config.mjs';
import { slugFromBranch } from './redgreen-lib.mjs';
// plan 3959 T2: the review-marker cluster moved to scripts/coord/review-markers.mjs.
import {
  parseMarkerAny,
  upsertMarker,
  checkRecordBranch,
  repinDecision,
  markerIdentityMatch,
  pickMarkerSourceEntry,
  carryMarkerLine,
  resolveSessionChainOverRefs,
  originFirstCandidates,
  sessionEntryOwnerSlug,
  markerLineOf,
  repinMarkerLine,
  grepOrNoMatch,
  markerLineIdentity,
  markerIdentityUnchanged,
} from './review-markers.mjs';
import {
  rangePatchId,
  rangePatchIdOnce,
  rangePatchIdOnceWithFetch,
  fetchOriginBeforePatchId,
} from './land-lib.mjs';
import { isDirty } from './pre-yield-guard.mjs';
import { gitRepoIsolatedEnv } from './child-env.mjs';

export function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_MAXBUFFER, // plan 850: uniform spine maxBuffer
    env: gitRepoIsolatedEnv(),
    ...opts,
  });
}

// plan 2891 review round 2: does ANYTHING exist at this path — including a dangling symlink,
// which `readFileSync` reports as ENOENT even though the link is real? lstat does not follow the
// link, so it answers about the path itself. The write journals use this to decide whether an
// unreadable path is theirs to DELETE on rollback (genuinely absent) or must be left untouched.
// Only ENOENT proves absence (review round 3, CONFIRMED). Any OTHER lstat failure — EACCES
// on the parent directory, EIO, ENOTDIR — means we could not find out, and "we could not
// find out" must never be answered as "nothing is there": that answer is what licenses the
// rollback to DELETE the path. Fail toward present, i.e. toward leaving it alone.
//
// Exported as its own pure predicate so the rule can be tested with an ERRNO ARGUMENT rather
// than by coaxing the real filesystem into raising one. The construct plan 2891's test used,
// `lstat("<regular-file>/child")`, raises ENOTDIR on POSIX but ENOENT on Windows, so that test
// asserted this rule only on the platform its cloud drain happened to run, and went red on the
// next local Windows push (vetapp CLAUDE.md: "a test exercising a platform-specific branch must
// make the platform a PARAMETER — and must supply that platform's SYMBOLS too"). No path shape
// raises the same non-ENOENT errno on both platforms, so the errno itself becomes the parameter.
export function lstatErrorMeansPresent(e) {
  return e?.code !== 'ENOENT';
}

export function pathPresent(abs) {
  try {
    lstatSync(abs);
    return true;
  } catch (e) {
    return lstatErrorMeansPresent(e);
  }
}

// plan 2891 review round 3: the ONE write-journal, shared by the re-pin's applyTo and
// record-review's own record path — two byte-alike copies before this, which is precisely how a
// hardening fix to one silently skips the other (the failure this whole plan is a burndown of).
//
// Snapshot every path a write may touch BEFORE the first write, then restore the lot on any
// throw: content for a file that existed, deletion for one that did not. BYTES, not text — a
// journal that round-tripped through a string decode could not promise to restore the file it
// read. A path we cannot snapshot for a reason OTHER than absence is `unrestorable` and left
// ALONE on rollback: guessing at content we never read is how a rollback becomes the corruption.
//
// Concurrency is bounded by what bounds every write here: the routed path owns a disposable
// coord-checkout under the coord lock, and coordWrite's assertCleanOutsidePathspec has already
// refused if anyone else left dirt on these paths; the --no-push path writes MAIN's own tree.
export function openWriteJournal(dir, relPaths) {
  const entries = relPaths.map((rel) => {
    const abs = join(dir, rel);
    try {
      return { abs, existed: true, bytes: readFileSync(abs) };
    } catch (e) {
      // ENOENT from a READ does not prove absence — a DANGLING SYMLINK reads ENOENT while the
      // link plainly exists, and treating that as "we created this file" made rollback rmSync
      // the operator's symlink (review round 2). lstat sees the link itself, so it decides.
      if (e?.code === 'ENOENT' && !pathPresent(abs)) return { abs, existed: false, bytes: null };
      return { abs, unrestorable: true };
    }
  });
  return {
    entries,
    bytesAt: (i) => entries[i].bytes,
    rollback() {
      for (const entry of entries) {
        if (entry.unrestorable) continue;
        try {
          if (entry.existed) writeFileSync(entry.abs, entry.bytes);
          else rmSync(entry.abs, { force: true });
        } catch {
          /* best-effort: one path's restore failing must not mask the original throw */
        }
      }
    },
  };
}

// The session entry OWNING the slug — shared resolver with done-worktree.mjs
// (done-worktree-lib.resolveSessionEntry): `*.md` entries only, the frozen pre-205 archive
// excluded, the anchored `**Branch:**` ownership line preferred over a bare mention, and an
// un-disambiguatable legacy match refused rather than silently resolved. plan 642 unified the
// call sites (previously byte-identical buggy copies) onto one helper; plan 2838 moved the
// PROTOCOL into the shared lib so done-worktree's land gates read the same file this writes.
//
// The fix lives HERE, inside the resolver, not at any call site — there are three in this
// module (:449, :464, :603) plus record-review's two and record-marker's one, and fixing one
// leaves the rest mis-resolving. Returns null (never throws) on no-entry OR on ambiguity; the
// ambiguity case prints its named-candidate block first, so the caller's existing
// `noSessionEntry` refusal carries the reason on stderr and its exit code is unchanged.
// plan 2891 T5 items (1)/(5): the ref list is now a PARAMETER, because the two kinds of caller
// need different ones and hard-coding `HEAD` silently gave the wrong answer to one of them.
//
//   WRITE paths (the record/repin `prepare`/`gate` hooks) must resolve against the tree they
//   are about to WRITE — `HEAD` — and that is the default. The routed default path passes the
//   freshened coord-checkout as `dir`, whose HEAD already IS origin/master, so it loses
//   nothing; the `--no-push` path writes MAIN's working tree, where resolving a name that
//   exists only on origin would make the very next readFileSync throw ENOENT.
//
//   READ-ONLY paths (repin's cheap pre-gate, `record-marker check`) must resolve ORIGIN-FIRST,
//   exactly like done-worktree's own findSessionFileUncached: the routed record write lands the
//   session entry on origin/master WITHOUT touching MAIN's tree or its remote-tracking ref, so
//   a HEAD-only grep on MAIN defeats the origin-first fallback those callers then rely on
//   (readSessionCandidates reads origin first) and reports a just-recorded entry as absent.
//   Before this, the two halves of the same lookup disagreed about which refs exist.
//
// Fail CLOSED per ref, and never fall through on a refusal: a wrong-owner or un-disambiguatable
// answer on origin is not improved by asking HEAD the same question (done-worktree's resolver
// draws the identical line, and these two must stay the same protocol).
export const ORIGIN_FIRST_REFS = ['origin/master', 'HEAD'];

export function findSessionFile(dir, slug, paths, tool = 'record', opts = {}) {
  return findSessionEntryChain(dir, slug, paths, tool, opts)?.sf ?? null;
}

// plan 4021: the whole resolution CHAIN behind findSessionFile — `{ sf, entries, anchored }`, `sf`
// the newest owned entry (the WRITE target, exactly what findSessionFile returns) and `entries`
// the per-family marker walk, newest first, including the candidates the resolver dropped as halt
// states. Review round 2 (ae1b7d): the ref walk is the ONE shared resolveSessionChainOverRefs
// done-worktree also drives. Null on no entry / ambiguity / owner conflict.
export function findSessionEntryChain(dir, slug, paths, tool = 'record', { refs = ['HEAD'] } = {}) {
  return resolveSessionChainOverRefs({
    refs,
    slug,
    paths,
    tool,
    report: (msg) => console.error(msg),
    // `mode` picks the matcher: 'regex' for the line-anchored Branch-line patterns, 'fixed' for
    // the bare-slug fallback (a slug may contain `.`, a regex metacharacter).
    // review round 3 (41f896): only "no match" or a missing ref is an empty answer; any other grep
    // failure throws, and the shared chain resolver refuses on it with git's reason.
    grepFor: (ref) => (pattern, pathspec, mode) =>
      grepOrNoMatch(() =>
        git([
          '-C',
          dir,
          'grep',
          '-l',
          mode === 'regex' ? '-E' : '-F',
          pattern,
          ref,
          '--',
          ...pathspec,
        ]),
      ),
    readEntryFor: (ref) => (p) => git(['-C', dir, 'show', `${ref}:${p}`]),
  });
}

// plan 4021 (review fb94f6): which owned entry holds `family`'s marker, for a WRITE flow. The ONE
// selection rule is pickMarkerSourceEntry (shared with done-worktree's land reads); this only
// feeds it the chain and a reader. Writes never move: they stay in `sf`, the newest owned entry.
// When `src.fallback` is true the newest entry carries no marker of this family and the flow must
// CARRY the older marker forward into `sf` before proceeding as it always has. `read` defaults to
// the tree the flow writes (`dir`'s working copy); a read-only pre-gate passes its origin-first
// view instead. Returns { sf, src } or null when no owned entry resolves.
export function resolveMarkerSource(dir, slug, paths, family, tool, { refs, read } = {}) {
  const chain = findSessionEntryChain(dir, slug, paths, tool, refs ? { refs } : {});
  if (!chain) return null;
  const reader = read || ((p) => [readFileSync(join(dir, p), 'utf8')]);
  const src = pickMarkerSourceEntry(family, slug, chain.entries, reader, {
    anchored: chain.anchored,
  });
  return { sf: chain.sf, src };
}

// plan 4021 (review fb94f6): the carried text for `sf` — `beforeText` (sf's current content, as
// the caller's write journal snapshotted it) with `family`'s marker line copied from `sourceText`
// (the content of `fromSf` the caller's apply-time marker source selection just read). Pure; the
// caller writes and rolls back. Review round 2:
//   - both texts must still declare `worktree-<slug>` (47c8b1/877e1b/755889) — an owner change
//     inside a freshen-and-retry window refuses rather than stamping another session's verdict;
//   - `sf` already carrying the IDENTICAL line is a no-op (bf23ed/7ef812: a concurrent sibling
//     carried it first), while a DIFFERENT marker there still throws (a newer record is never
//     replaced by an older one), as does a source that no longer carries one.
export function carryMarkerForward(family, tool, slug, sf, fromSf, beforeText, sourceText) {
  for (const [rel, text] of [
    [sf, beforeText],
    [fromSf, sourceText],
  ]) {
    if (sessionEntryOwnerSlug(text) !== slug) {
      throw new Error(
        `${tool}: ${rel} no longer declares \`worktree-${slug}\` as its owner — nothing carried; re-run.`,
      );
    }
  }
  const line = markerLineOf(family, sourceText);
  if (line === null) {
    throw new Error(
      `${tool}: ${fromSf} no longer carries a ${family.label}: marker to carry forward into ${sf} — nothing carried; re-run.`,
    );
  }
  const have = markerLineOf(family, beforeText);
  if (have === line) return beforeText;
  if (have !== null) {
    throw new Error(
      `${tool}: ${sf} gained a different ${family.label}: marker since the carry-forward from ${fromSf} was planned — nothing carried; re-run.`,
    );
  }
  return carryMarkerLine(family, beforeText, sourceText);
}

// plan 4021 review round 2 (2321da/30cbc6/58cc37/9d41e4): the ONE refusal a WRITE flow prints when
// its marker source selection HALTED (pickMarkerSourceEntry's `halted`): an owned entry on the
// walk could not be read, or a copy of it names another owner. Writing anyway would record onto,
// or disposition, an entry nobody could attribute.
export function markerSourceHaltMessage(tool, halted) {
  const why =
    halted.reason === 'owner' ? 'a copy of it declares another owner' : 'it could not be read';
  return (
    `${tool}: REFUSED — could not judge session entry ${halted.path}: ${why}. ` +
    `Nothing was written; restore that entry (or record a fresh claim entry) and re-run.`
  );
}

// The shared "no session entry" refusal — the claim entry must exist before recording.
export function noSessionEntry(tool, slug, paths) {
  console.error(
    `${tool}: no handoff session entry references slug "${slug}" under ${paths.sessionsDir}/ — record the claim entry first.`,
  );
  return 1;
}

// plan 2086: origin-first read of a session file's content, falling back to MAIN's own
// working-tree copy — the ONE candidate-list reader every marker consumer needs, because the
// routed DEFAULT record-*.mjs write path lands a marker on origin/master via a disposable
// coord-checkout (plan 1286/2042) that never touches MAIN's own checked-out files. A reader
// that only opens MAIN's working copy (e.g. a plain readFileSync) reports a marker recorded
// moments earlier via the routed path as "not recorded" — the review-[0]/[1]/[8] finding
// this closes. Mirrors done-worktree.mjs's own sessionDocCandidates (kept private there,
// same shape) so a family walker tries origin first, then the working tree, per candidate —
// the --no-push / offline record path writes ONLY the working tree, so a caller must still
// fall back rather than trust origin alone. Returns up to two content strings, origin first.
// plan 4021 review round 2 (1b7464): the shared originFirstCandidates. `strict` (marker SOURCE
// selection) throws on any failure other than a genuine absence; advisory readers keep the default.
export function readSessionCandidates(MAIN, sf, { strict = false } = {}) {
  return originFirstCandidates(
    () => git(['-C', MAIN, 'show', `origin/master:${sf}`]),
    () => readFileSync(join(MAIN, sf), 'utf8'),
    // review round 3 (4fcf38/2a36b2): the lstat lets the shared classifier tell a missing file
    // from a dangling symlink, which also reads ENOENT.
    { strict, probeTree: () => lstatSync(join(MAIN, sf)) },
  );
}

// plan 2891 T5 item (4): pick the FRESHEST marker across readSessionCandidates' ordered
// content list, instead of the first that merely PARSES.
//
// The candidates are origin/master and MAIN's working tree, in that order, and they can hold
// DIFFERENT markers: a `--no-push` record lands only in MAIN's tree, so "first parseable wins"
// reported that branch as sitting behind whatever stale marker origin still carried. The
// consumers then disagreed with the LAND, whose own recordedMarker walks the same two
// candidates and stops at the first CURRENT one ("so neither source can shadow it") — this is
// that same rule, spelled once and shared, rather than a third hand-rolled walk.
//
// "Freshest" is by recorded IDENTITY, not by file mtime or candidate order: a marker whose sha
// (or, across a pure rebase, whose range patch-id) still describes HEAD is current, and current
// beats stale wherever it sits. With no current marker anywhere, the first PARSEABLE one wins —
// unchanged from before, so a genuinely stale branch reports exactly what it used to.
// `headPatchId` may be the memoized thunk every caller already holds.
export function pickFreshestMarker(family, candidates, headSha, headPatchId = null) {
  let firstParseable = null;
  for (const content of candidates) {
    const marker = parseMarkerAny(family, content);
    if (!marker) continue;
    if (markerIdentityMatch(marker.sha, marker.patchId, headSha, headPatchId)) return marker;
    if (!firstParseable) firstParseable = marker;
  }
  return firstParseable;
}

// The one positional flag-value lookup (`--name <value>`) shared by resolveRecordTarget
// and parseDetailArg (review 2042 [5] — was two identical inline closures).
function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Shared resolution for every record/repin/disposition flow: derive slug (from --slug or
// the worktree-<slug> branch), the main checkout, config, and HEAD. Returns { code } (the
// caller returns it verbatim) on any refusal / clean no-op, or the resolved fields on
// success. `tool` names the caller in error messages. The session FILE is resolved by
// each flow against the checkout it writes (plan 1286): the routed default path resolves
// inside the fresh coord-checkout; --no-push/--dry resolve against MAIN's HEAD.
export function resolveRecordTarget(argv, tool) {
  // slug: explicit --slug, else derive from the current branch (worktree-<slug>).
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  let slug = flagValue(argv, '--slug');
  if (!slug) {
    // plan 1616: derive via the canonical slugFromBranch (redgreen-lib.mjs) rather than a
    // separate inline `/^worktree-(.+)$/` copy — the same detector done-worktree.mjs uses.
    const derived = slugFromBranch(branch);
    if (!derived) {
      // plan 1105: --slug no longer enables recording from another checkout (the branch guard below
      // refuses it), so don't advertise it here — the only fix is to cd into the plan's worktree.
      console.error(
        `${tool}: not on a worktree-* branch ("${branch}") — cd into the plan's worktree to record (the marker must pin the worktree HEAD the land checks).`,
      );
      return { code: 2 };
    }
    slug = derived;
  }

  const MAIN = resolveMain();
  const cfg = loadCoordConfig(MAIN);
  // Single-file-layout repos (config-less + sibling subprojects that synced these scripts)
  // have no per-session marker convention — a clean no-op there. Checked BEFORE the worktree
  // refuse below so a sibling never gets a hard exit-2 where it used to exit 0 cleanly.
  if (cfg.handoffLayout !== 'sessions') {
    console.error(
      `${tool}: the marker convention targets per-session handoff entries; this repo uses the single-file layout — nothing recorded.`,
    );
    return { code: 0 };
  }

  // plan 1105: refuse to record from any checkout other than worktree-<slug> — only there does
  // ambient HEAD equal the sha the done-worktree staleness guard recomputes. (When slug was derived
  // from the branch above this is always satisfied; the gate bites the explicit-`--slug`-from-master
  // footgun.)
  const branchCheck = checkRecordBranch(branch, slug, tool);
  if (!branchCheck.ok) {
    console.error(branchCheck.message);
    return { code: 2 };
  }

  const sha = git(['rev-parse', 'HEAD']).trim();
  return { slug, branch, MAIN, cfg, sha };
}

// detail = the positional args after the verdict, minus the flags + their values
// (`--detail <s>` wins when given). Shared by the wiki/conclusion record flows.
export function parseDetailArg(argv) {
  const flagVals = new Set();
  for (const f of ['--slug', '--detail']) {
    const i = argv.indexOf(f);
    if (i >= 0) flagVals.add(i + 1);
  }
  return (
    flagValue(argv, '--detail') ??
    argv
      .slice(1)
      .filter((a, idx) => !a.startsWith('--') && !flagVals.has(idx + 1))
      .join(' ')
      .trim()
  );
}

// plans 1528/1775: the ONE "same review round" proof — two tips whose content-diffs vs their
// merge-base with origin/master are patch-id-identical carry the same reviewed content (a pure
// re-sha). Shared by every family's repin gate and record-review's re-record disposition carry
// so they can't drift (review 1775 [4]). Local git only over the ambient worktree —
// deliberately NO fetch here: the routed record path was just freshened by
// resolveCoordCheckout, repin freshens the ref itself BEFORE any lock, and a stale
// origin/master only ever refuses MORE (the diff would swallow master commits), never
// accepts more. An in-lock fetch would also expose the shared coord-write lock to a hung
// Windows GCM credential dialog (review 1775 [0] — the plan-810/774 class).
// plan 2743: `newPatchId` may be supplied by a caller that already memoized HEAD's range
// patch-id (rangePatchIdOnce), so a repin no longer computes the single most expensive call in
// this module twice per invocation — once for the rebase-stable pre-check and again here.
// Omitted ⇒ computed, exactly as before.
export function patchIdenticalDecision(oldSha, newSha, newPatchId = undefined) {
  return repinDecision({
    markerSha: oldSha,
    headSha: newSha,
    oldPatchId: rangePatchId('.', oldSha),
    newPatchId: newPatchId === undefined ? rangePatchId('.', newSha) : newPatchId,
  });
}

// Commit marker path(s) under MAIN — the local (--no-push) commit engine every family's
// commit*Marker wrapper delegates to. Since plan 1286 this is ONLY the --no-push
// (offline/test) path — the default record/disposition/repin flows route through
// withCoordCheckout + coordWrite (atomic marker+push, no MAIN commit, no MAIN rebase).
// plan 980: the add + commit route through gitWithLockRetry (the same wrapper coordWrite
// uses), so an index.lock / transient index-write retries instead of crashing (which
// would mis-seam the land REVIEW_NEEDED/WIKI_CHECKPOINT). The no-op probe uses
// `git status --porcelain` (NOT `git diff --quiet`): an extra path can be a brand-new
// UNTRACKED file (the findings sidecar), and `git diff` is blind to untracked paths even
// when named explicitly (plan 1205 review [1]); `status --porcelain` reports both, so an
// empty result is a true no-op. A per-session handoff entry is NOT the board / INDEX
// generated region, so the plan-421 Coord-Write trailer guard does not apply — a plain
// pathspec commit is fine. Seams (_git for the read-only no-op check, _gitRetry, _push,
// retryOpts) are injectable for tests.
export function commitMarkerCommit(
  MAIN,
  paths,
  {
    commitMsg,
    noPush = false,
    _git = git,
    _gitRetry = gitWithLockRetry,
    _push = pushMasterWithRebase,
    retryOpts = {},
  } = {},
) {
  const env = { ...gitRepoIsolatedEnv(), HUSKY: '0' };
  try {
    const dirty = _git(['-C', MAIN, 'status', '--porcelain', '--', ...paths], { env });
    if (!isDirty(String(dirty))) return { noop: true }; // shared porcelain predicate (pre-yield-guard)
  } catch {
    /* a status failure is treated conservatively as "changed" → fall through and commit */
  }
  _gitRetry(MAIN, ['add', '--', ...paths], { env, ...retryOpts });
  try {
    _gitRetry(MAIN, ['commit', '-m', commitMsg, '--', ...paths], { env, ...retryOpts });
  } catch (e) {
    // plan 980: gitWithLockRetry retries a transient `unable to write new index file`; on a
    // half-land (git created the commit + moved HEAD, then the index write failed) the retried
    // commit finds nothing staged → "nothing to commit". The marker commit IS at HEAD —
    // tolerate it (gated on commitSubjectAtHead, never a bare "nothing to commit") and fall
    // through to push, so a transient AV file-lock no longer fails the record with the marker
    // already committed (which would mis-seam the land).
    if (!(isNothingToCommit(errText(e)) && commitSubjectAtHead(MAIN, commitMsg))) throw e;
  }
  if (!noPush) _push(MAIN);
  return { noop: false, pushed: !noPush };
}

// Factory for the per-family commit*Marker wrappers the CLIs export for their tests
// (review 2042 [4] — was three near-identical wrappers). `verdictKey` names the option
// each family's historical signature carries the verdict under ('decision' for wiki,
// 'verdict' otherwise); `extraPaths` (review's findings sidecar) and `detail` default
// away harmlessly for the families that never pass them.
export function makeCommitMarker(scope, { verdictKey = 'verdict' } = {}) {
  return function commitMarker(MAIN, sf, opts = {}) {
    const {
      slug,
      detail = '',
      sha,
      noPush = false,
      extraPaths = [],
      commitMsg: commitMsgOverride,
      _git,
      _gitRetry,
      _push,
      retryOpts,
    } = opts;
    const detailTail = detail ? ` (${detail})` : '';
    return commitMarkerCommit(MAIN, [sf, ...extraPaths], {
      commitMsg:
        commitMsgOverride ||
        `chore(${scope}): record ${opts[verdictKey]} @ ${sha.slice(0, 9)} for ${slug}${detailTail}`,
      noPush,
      _git,
      _gitRetry,
      _push,
      retryOpts,
    });
  };
}

// The dry / --no-push / routed-default trichotomy every record-style write shares.
// hooks:
//   prepare(dir)        → { code } (refusal, returned verbatim) | payload ({ sf, … })
//   mutateIn(dir, p)    → write the marker (+ any extras) into `dir`; MUST be idempotent
//                         against coordWrite's freshen-and-retry (re-read the freshened
//                         file each attempt — the session entry / sidecar is single-owner
//                         per worktree, so a re-merge against the same inputs is stable)
//   relPaths(p)         → paths to commit (default [p.sf])
//   commitMessage(p)    → commit subject
//   dryLine(p)          → the [dry] preview line
//   report(res, p)      → final console line + exit code
export function runRecordFlow({ tool, MAIN, dry, noPush }, hooks) {
  const relPaths = hooks.relPaths || ((p) => [p.sf]);
  if (dry) {
    const p = hooks.prepare(MAIN);
    if (p.code !== undefined) return p.code;
    console.log(hooks.dryLine(p));
    return 0;
  }
  if (noPush) {
    // Local-only escape hatch (offline / tests): write + pathspec-commit on MAIN, no push.
    // Leaves MAIN's local master one commit ahead — heal-main / the next sanctioned push
    // carries it. The DEFAULT path below never touches MAIN.
    const p = hooks.prepare(MAIN);
    if (p.code !== undefined) return p.code;
    // plan 4021 review round 2 (27dc8a): the same contract coordWrite applies — an ARRAY returned by
    // mutateIn is the authoritative path list for this write (a carried sidecar the declared list
    // could not know about), an empty one is a clean no-op, anything else keeps the declared list.
    const written = hooks.mutateIn(MAIN, p);
    if (Array.isArray(written) && written.length === 0) return hooks.report({ noop: true }, p);
    const res = commitMarkerCommit(MAIN, Array.isArray(written) ? written : relPaths(p), {
      commitMsg: hooks.commitMessage(p),
      noPush: true,
    });
    return hooks.report(res, p);
  }
  // plan 1286 (extended to every family by 1312 / 2033): the DEFAULT path runs the whole
  // write against the DISPOSABLE coord-checkout under the coord-write lock
  // (withCoordCheckout + coordWrite) — never the shared MAIN checkout. That makes
  // marker+push ATOMIC (coordWrite rolls the commit back scoped on a failed push — no
  // committed-but-unpushed "already recorded" confusion), and no retry ever rebases MAIN
  // (the transient-detached-HEAD class every sibling saw).
  return withCoordCheckout(
    MAIN,
    // plan 2393 lever 1: `lockCtx` hands the coord lock back after coordWrite's commit so the push
    // + verify run unserialized. Safe — `hooks.report` is console output only, so coordWrite is the
    // last mutation of the coord-checkout here.
    (cdir, lockCtx) => {
      const p = hooks.prepare(cdir);
      if (p.code !== undefined) return p.code;
      const res = coordWrite(cdir, {
        relPaths: relPaths(p),
        mutate: () => hooks.mutateIn(cdir, p),
        message: hooks.commitMessage(p),
        tool,
        lockCtx,
      });
      return hooks.report(res, p);
    },
    { tool },
  );
}

// plan 1528 A1: mechanically re-pin a STALE marker (and any sha-pinned extras) to the
// current worktree HEAD — the ONE repin implementation all three families run. Allowed
// ONLY when the recorded tip's range patch-id equals HEAD's (both vs their merge-base
// with origin/master) — the "pure rebase, nothing re-authored" proof; repinDecision owns
// the gate. Verdict/detail (and, for review, the findings sidecar with its dispositions)
// carry over UNCHANGED — bookkeeping after a re-sha, never a way to skip a re-review
// (any content change ⇒ patch-ids differ ⇒ refusal). Run from inside the worktree (the
// plan-1105 branch guard). The spine (done-worktree) invokes this automatically after
// its own rebases and before the gate seams, so a marker halted purely by a re-sha never
// reaches the session (the plan-1450 incident halted for it TWICE).
//
// desc: { tool, scope, family, nothingHint } + optional review hooks
//   probeExtras(dir, sf, marker, slug)    → extra payload stashed on the gate result; a
//                                           `{refuse: <msg>}` refuses the re-pin before any write
//   repinRelPaths(g)                      → routed-path relPaths (default [g.sf])
//   applyExtras(dir, sf, marker, newSha, newPatchId, slug) → re-pin extras; returns rel paths
//
// Usage: <record-cli> repin [--slug <slug>] [--no-push] [--no-fetch] [--dry]
// Exit codes: 0 re-pinned or already current · 1 no session entry · 2 refusal (branch/
// layout) · 3 no marker recorded · 4 patch-ids DIFFER (rework — re-review the delta,
// don't re-pin) · 5 gate uncomputable (recorded tip unresolvable in this checkout).
export function runRepinFlow(desc, argv) {
  const rtool = `${desc.tool} repin`;
  const has = (name) => argv.includes(name);
  const dry = has('--dry');
  const noPush = has('--no-push');
  const noFetch = has('--no-fetch');
  const t = resolveRecordTarget(argv, rtool);
  if (t.code !== undefined) return t.code;
  const { slug, MAIN, cfg, sha } = t;
  const fam = desc.family;
  const verdictOf = (marker) => marker[fam.resultField];
  const headPatchId = rangePatchIdOnce('.', sha);

  // The no-marker / already-pins-HEAD classifier the pre-gate and gate() share (review
  // 2042 [6] — one wording, one staleness short-circuit; a fix to either can't drift).
  // Returns an exit code, or undefined to proceed to the patch-id gate.
  const markerPreCheck = (marker, sfName, halted = null) => {
    if (!marker) {
      // plan 4021: a halted source selection (an unreadable or contested owned entry) is reported
      // as what it is, not as a plain absence.
      const why = halted
        ? ` (could not judge ${halted.path}: ${halted.reason === 'owner' ? 'a copy declares another owner' : 'unreadable'})`
        : '';
      console.error(
        `${rtool}: no ${fam.label}: marker recorded in ${sfName}${why} — nothing to re-pin (${desc.nothingHint}).`,
      );
      return 3;
    }
    // plan 2743 — THE churn stop, and (operator ruling 2026-08-03, grill Q3 / finding [4])
    // routed through the SHARED `markerIdentityMatch` rather than a hand-rolled sha-then-
    // patch-id pair. This CLI and the land-time read side must answer "is this marker still
    // current?" identically — a standalone `repin` that re-pinned a marker done-worktree
    // already honors (or vice versa) is precisely the twin-drift this consolidation exists to
    // end. The comparator also normalizes both patch-ids, which the hand-rolled `===` did not,
    // and takes the THUNK, so a legacy sha-only marker no longer forces `git patch-id` to run
    // before falling through.
    //
    // A dual-pinned marker whose recorded patch-id already equals HEAD's is CURRENT by content
    // identity, and the land's read side (parseMarkerCurrent's rebase-stable fallback) honors it
    // as such. Re-pinning it here would spend a commit ON MASTER to record a new sha for content
    // the very same patch-id comparison just proved unchanged — and THAT commit is what advanced
    // master under every other land prepping at the time, forcing their rebases, which emitted
    // their own re-pins (326 such commits in one day; six on a single marker inside six minutes).
    // Doing nothing is both cheaper and more correct.
    //
    // Deliberately BEFORE the patch-id gate below, not folded into it: the gate's job is
    // to decide whether a re-pin is PERMITTED, this decides it is not NEEDED. A legacy
    // sha-only marker (patchId null) falls straight through to that gate, unchanged.
    const how = markerIdentityMatch(marker.sha, marker.patchId, sha, headPatchId);
    if (how === 'sha') {
      console.log(`${rtool}: marker already pins HEAD (${sha.slice(0, 9)}) — no change`);
      return 0;
    }
    if (how === 'patch-id') {
      console.log(
        `${rtool}: marker @ ${marker.sha.slice(0, 9)} is patch-id-pinned (${marker.patchId.slice(0, 9)}) ` +
          `and HEAD ${sha.slice(0, 9)} carries the same range patch-id — rebase-stable, no re-pin needed (plan 2743)`,
      );
      return 0;
    }
    return undefined;
  };

  // Best-effort ref freshen FIRST — skipped under --no-fetch, the spine path: its
  // repinShaPinnedMarkers fetches ONCE for all three families instead of once per
  // subprocess (plan 2042), so the speculative no-marker case exits fetch-free there. A
  // STANDALONE repin keeps the pre-refactor fetch-BEFORE-pre-gate order (review 2042 [0]):
  // the pre-gate reads origin/master, and a marker recorded via the routed coord-checkout
  // push is visible to this checkout ONLY after a fetch (the routed write advances neither
  // MAIN's tree nor its remote-tracking ref) — pre-gating on a stale ref would spuriously
  // exit 3 "nothing to re-pin" right after a successful record. Both patch-ids are
  // computed against merge-base with origin/master, and a stale ref only ever REFUSES
  // more (the diff would swallow master commits), never accepts more — so an offline /
  // skipped fetch stays safe, just stricter. plan 3447: routed through the shared
  // fetchOriginBeforePatchId policy (land-lib.mjs) rather than an inline fetch — the
  // record path (record-review.mjs) now honors the same policy, so the two patch-id
  // consumers on this family can no longer drift on fetch behavior.
  fetchOriginBeforePatchId('.', { noFetch });

  // Cheap pre-gate against MAIN's freshest available view: the spine calls repin
  // speculatively on every stale-marker halt AND after every rebase, and MOST lands carry
  // no marker for most families — the common no-marker case must exit without a
  // coord-checkout spin-up. Origin-first (the routed record path lands markers there
  // without advancing MAIN's tree), then the working copy. Any mis-read here degrades
  // toward the SAFE side (the pre-1528 halt); the routed write below re-gates
  // authoritatively in the freshened coord-checkout.
  {
    // plan 2891 T5 item (1): ORIGIN-FIRST resolution. This pre-gate is READ-ONLY (it only names
    // the file readSessionCandidates then reads origin-first), and resolving it against MAIN's
    // own HEAD defeated that fallback: a session entry that reached origin via the routed record
    // write — the DEFAULT path — is invisible to MAIN's HEAD until something ff's it, so a repin
    // moments after a successful record exited 1 "no session entry".
    // plan 4021 (review fb94f6): the marker is read from the owned entry that HOLDS it — the
    // newest, or (after an adoption) the older entry the write below will carry it forward from.
    const r0 = resolveMarkerSource(MAIN, slug, cfg.paths, fam, rtool, {
      refs: ORIGIN_FIRST_REFS,
      read: (p) => readSessionCandidates(MAIN, p, { strict: true }),
    });
    if (!r0) return noSessionEntry(rtool, slug, cfg.paths);
    const pre = pickFreshestMarker(fam, r0.src.contents, sha, headPatchId);
    const code = markerPreCheck(pre, r0.src.fallback ? r0.src.path : r0.sf, r0.src.halted);
    if (code !== undefined) return code;
  }

  // Gate on the marker as recorded in the given checkout's freshest session-doc view. The
  // patch-ids come from the ambient worktree (the only checkout guaranteed to hold both
  // the recorded tip and HEAD).
  // plan 4021 (review fb94f6): CARRY FORWARD. When the newest owned entry (`sf`, still the write
  // target) carries no marker of this family and an older owned entry does, `carryFrom` names that
  // entry: applyTo first copies its marker line (and, via the family's carryExtras, its sidecar)
  // into `sf`, then re-pins `sf` exactly as before. The gate reads the marker, and probes extras,
  // at the entry that holds them.
  const gate = (dir) => {
    const resolved = resolveMarkerSource(dir, slug, cfg.paths, fam, rtool);
    if (!resolved) return { code: noSessionEntry(rtool, slug, cfg.paths) };
    const { sf, src } = resolved;
    const carryFrom = src.fallback ? src.path : null;
    const marker = parseMarkerAny(fam, src.contents[0] ?? '');
    const pcode = markerPreCheck(marker, carryFrom ?? sf, src.halted);
    if (pcode !== undefined) return { code: pcode };
    const d = patchIdenticalDecision(marker.sha, sha, headPatchId());
    if (!d.repin) {
      console.error(
        `${rtool}: REFUSED — ${d.why} (marker ${verdictOf(marker)} @ ${marker.sha.slice(0, 9)}, HEAD ${sha.slice(0, 9)})`,
      );
      return { code: d.rework ? 4 : 5 };
    }
    // plan 2838 re-review [6]/[10]/[13]: probeExtras runs at GATE time — before applyTo writes
    // anything — so a family whose extras have an ownership contract (review's findings sidecar)
    // refuses HERE rather than after the marker has already been rewritten. `refuse` is the
    // family's opt-in: a message ⇒ exit 2, nothing written on any path.
    const extra = desc.probeExtras ? desc.probeExtras(dir, carryFrom ?? sf, marker, slug) : null;
    if (extra?.refuse) {
      console.error(`${rtool}: ${extra.refuse}`);
      return { code: 2 };
    }
    // plan 4021 review round 2 (63f2df/b813aa): the carry's own refusal, at gate time too.
    const carryPlan = carryFrom && desc.planCarry ? desc.planCarry(dir, carryFrom, sf, slug) : null;
    if (carryPlan?.refuse) {
      console.error(`${rtool}: ${carryPlan.refuse}`);
      return { code: 2 };
    }
    // review round 3 (3ba933/4de3b4): the FULL identity the patch-id gate approved, for applyTo
    const identity = markerLineIdentity(fam, src.contents[0] ?? '');
    return { sf, marker, extra, carryFrom, identity };
  };

  // Rewrite the marker (+ any sha-pinned extras) carrying verdict/detail verbatim with
  // only the sha re-pinned. Returns the rel paths written.
  //
  // plan 2743: the re-pin also STAMPS HEAD's range patch-id, which is what migrates a
  // legacy sha-only marker forward. Reaching here means the gate proved the patch-ids
  // identical, so this is the same content the review covered — and once the token is on
  // the line, the pre-check above short-circuits every LATER rebase of this branch, so a
  // marker can take this (commit-emitting) path at most once. Forward-only, no backfill.
  const applyTo = (dir, sf, marker, identity) => {
    const abs = join(dir, sf);
    // plan 4021 review round 2 (47c8b1/877e1b/755889/bf23ed/781252): the marker source is
    // re-derived from the tree THIS attempt writes, not reused from gate time. A freshen-and-retry
    // can change an entry's owner (the picker halts), let a sibling carry first (no fallback left,
    // nothing to carry), or change the marker itself — which refuses, because the patch-id gate
    // only ever approved the marker it read.
    const fresh = resolveMarkerSource(dir, slug, cfg.paths, fam, rtool);
    if (!fresh || fresh.src.halted || fresh.sf !== sf) {
      throw new Error(
        fresh?.src.halted
          ? markerSourceHaltMessage(rtool, fresh.src.halted)
          : `${rtool}: the newest owned session entry is no longer ${sf} in ${dir} — nothing written; re-run.`,
      );
    }
    const carryFrom = fresh.src.fallback ? fresh.src.path : null;
    // review round 3 (3ba933/4de3b4): compare the whole identity — verdict, detail, trailing
    // identity tokens, and the (sha, patch-id) pin as the gate read it or as a sibling re-pinned it.
    const unchanged = markerIdentityUnchanged(
      identity,
      markerLineIdentity(fam, fresh.src.contents[0] ?? ''),
      sha,
      headPatchId(),
    );
    if (!unchanged) {
      throw new Error(
        `${rtool}: the ${fam.label}: marker changed since the re-pin gate read ${verdictOf(marker)} @ ${marker.sha.slice(0, 9)} — nothing written; re-run.`,
      );
    }
    // ── plan 2891 T6: a WRITE JOURNAL, not a marker-only rollback ────────────────────────────
    //
    // plan 2844 review [b797d0]/[0de93e]/[bca8b5]/[fa12e7] established the rollback: applyExtras
    // can THROW (review's apply-time re-assert of the malformed-sidecar refusal probeExtras
    // already gates on, for a sidecar that goes bad BETWEEN gate and apply), the marker is
    // written FIRST, and an un-restored throw leaves a half-applied re-pin — on the --no-push
    // path that write lands in MAIN's working tree with no commit following, so the marker reads
    // re-pinned while its sidecar is untouched, committable later by accident, and a retry sees
    // the marker as already current.
    //
    // What that rollback covered was the MARKER only. A family whose applyExtras mutates its
    // extra files and THEN fails left those mutations behind — and a file it CREATED before
    // failing was not even a candidate for restoration. Unreachable today (record-review is the
    // one family implementing the hook, and it validates before it writes), so this is
    // defence-in-depth: the family DECLARES up front, via `extraJournalPaths`, every path its
    // applyExtras may touch; we snapshot each one BEFORE the first write and restore the lot on
    // any throw — content for a file that existed, deletion for one that did not.
    //
    // Bytes, not text: a journal that round-tripped through a string decode could not promise to
    // restore the file it read. A path we cannot snapshot for a reason OTHER than absence is
    // marked unrestorable and left ALONE on rollback — guessing at content we never read is how
    // a rollback becomes the corruption. (The concurrent-writer worry is bounded by the same
    // thing that bounds every write here: the routed path owns a disposable coord-checkout under
    // the coord lock, and coordWrite's assertCleanOutsidePathspec has already refused if anyone
    // else left dirt on these paths; the --no-push path writes MAIN's tree, which is the
    // caller's own.)
    const journal = openWriteJournal(dir, [
      sf,
      ...(desc.extraJournalPaths ? desc.extraJournalPaths(sf) : []),
    ]);
    const rollback = () => journal.rollback();
    // The marker's pre-write text comes from the journal's OWN snapshot rather than a second
    // readFileSync: two reads of the same file can observe different content, and the upsert
    // must be computed from exactly the bytes the rollback would restore.
    let before = journal.bytesAt(0)?.toString('utf8');
    if (before === undefined) {
      throw new Error(
        `${rtool}: cannot read ${sf} in ${dir} — the session entry must exist to re-pin its marker.`,
      );
    }
    // plan 2838: the family's extras get the SLUG too — the review sidecar needs it both to
    // stamp its owner on a legacy record and to refuse a re-pin onto a stranger's (review [6]).
    //
    // The MARKER WRITE ITSELF is inside the guard (plan 2891 review round 1, CONFIRMED): it used
    // to sit outside, so an ENOSPC/EIO thrown DURING that write — after the file had already
    // been truncated — left a partial marker in MAIN's tree with no rollback, which is exactly
    // the half-applied state this block exists to prevent. The rel-path list is inside for the
    // same reason (re-review [angle-A]): `[sf, ...extras]` throws its own TypeError when a
    // family returns a non-iterable, and that throw outside the guard would skip the rollback
    // too. One `try` covers the marker write, the family's throw, and our use of its return.
    try {
      // plan 4021 (review fb94f6): the carry runs INSIDE the same journal — the family's extra
      // journal paths are declared against `sf`, which is exactly where carryExtras writes.
      const carried = [];
      if (carryFrom) {
        before = carryMarkerForward(fam, rtool, slug, sf, carryFrom, before, fresh.src.contents[0]);
        if (desc.carryExtras) carried.push(...desc.carryExtras(dir, carryFrom, sf, slug));
      }
      // review round 2 (998229/59ba2e): re-pin IN PLACE — only sha + patch-id move, so a carried
      // (or any) marker keeps its review-round / scope / past-cap tokens.
      const repinned = repinMarkerLine(fam, before, sha, headPatchId());
      if (repinned === null) {
        throw new Error(`${rtool}: ${sf} carries no ${fam.label}: marker to re-pin in ${dir}.`);
      }
      writeFileSync(abs, repinned);
      const extras = desc.applyExtras
        ? desc.applyExtras(dir, sf, marker, sha, headPatchId(), slug)
        : [];
      return [...new Set([sf, ...carried, ...extras])];
    } catch (e) {
      rollback();
      throw e;
    }
  };

  const carriedNote = (g) => (g.carryFrom ? ` (carried forward from ${g.carryFrom})` : '');

  // honest audit trail: "re-pin", never "record" (review 1528 [7])
  const message = (marker) =>
    `chore(${desc.scope}): re-pin ${verdictOf(marker)} ${marker.sha.slice(0, 9)} → ${sha.slice(0, 9)} for ${slug} (patch-id-identical rebase, plan 1528)`;

  if (dry) {
    const g = gate(MAIN);
    if (g.code !== undefined) return g.code;
    console.log(
      `[dry] ${rtool}: would re-pin ${verdictOf(g.marker)} ${g.marker.sha.slice(0, 9)} → ${sha.slice(0, 9)} in ${g.sf}${carriedNote(g)}`,
    );
    return 0;
  }

  if (noPush) {
    const g = gate(MAIN);
    if (g.code !== undefined) return g.code;
    const paths = applyTo(MAIN, g.sf, g.marker, g.identity);
    const res = commitMarkerCommit(MAIN, paths, { commitMsg: message(g.marker), noPush: true });
    // Success line only on a real write (review 2042 [1] — a concurrent re-pin can make
    // this a no-op between gate() and the commit; don't claim a write that didn't happen).
    if (!res.noop)
      console.log(
        `${rtool}: re-pinned ${verdictOf(g.marker)} → @ ${sha.slice(0, 9)} in ${g.sf}${carriedNote(g)} (push skipped)`,
      );
    return 0;
  }

  return withCoordCheckout(
    MAIN,
    // plan 2393 lever 1: same seam as the record path above — only a console line follows.
    (cdir, lockCtx) => {
      const g = gate(cdir);
      if (g.code !== undefined) return g.code;
      const relPaths = desc.repinRelPaths ? desc.repinRelPaths(g) : [g.sf];
      coordWrite(cdir, {
        // The DECLARED list, fixed at gate time: it is what coordWrite's foreign-dirt
        // pre-check measures against, and the fallback for a family whose mutate returns
        // nothing. plan 2891 T2/T5 item (2): it is no longer what gets STAGED — `applyTo`
        // returns the paths this attempt actually wrote, against the FRESHENED tree, and
        // coordWrite stages those. A sidecar that appeared (or vanished) inside the retry
        // window used to be missed (or `git add`-ed while absent, failing the whole write)
        // because the gate-time list could not know about it.
        relPaths,
        lockCtx,
        // Idempotent under coordWrite's freshen-and-retry: the upsert re-reads the freshened
        // session file each attempt; any extra re-pin is deterministic for (marker, sha).
        mutate: () => applyTo(cdir, g.sf, g.marker, g.identity),
        message: message(g.marker),
        tool: desc.tool,
      });
      console.log(
        `${rtool}: re-pinned ${verdictOf(g.marker)} ${g.marker.sha.slice(0, 9)} → @ ${sha.slice(0, 9)} in ${g.sf}${carriedNote(g)} + pushed`,
      );
      return 0;
    },
    { tool: desc.tool },
  );
}

// The whole record-CLI main() for the SIMPLE (marker-only) families — wiki and
// conclusion, whose record flow is: validate verdict → extract detail → resolve target →
// upsert into the session entry. record-review keeps its own main (findings ingest +
// disposition subcommand) built on the same primitives.
// desc additionally carries:
//   detailRequired(verdict, detail) → full refusal message | null
export function runRecordMain(desc, argv) {
  if ((argv[0] || '') === 'repin') return runRepinFlow(desc, argv.slice(1));
  const fam = desc.family;
  const verdict = (argv[0] || '').toUpperCase();
  const has = (name) => argv.includes(name);
  const dry = has('--dry');
  const noPush = has('--no-push');

  if (!fam.verdicts.includes(verdict)) {
    console.error(
      `${desc.tool}: first arg must be ${fam.verdicts.join(' | ')} (got "${argv[0] ?? ''}")`,
    );
    return 2;
  }

  const detail = fam.hasDetail ? parseDetailArg(argv) : '';
  const missing = desc.detailRequired ? desc.detailRequired(verdict, detail) : null;
  if (missing) {
    console.error(missing);
    return 2;
  }

  const t = resolveRecordTarget(argv, desc.tool);
  if (t.code !== undefined) return t.code;
  const { slug, MAIN, cfg, sha } = t;
  const detailTail = detail ? ` (${detail})` : '';
  // plan 2743: stamp the rebase-stable identity alongside the sha at RECORD time. LAZY (a
  // memoized thunk, resolved at the write below) so every refusal that precedes the write still
  // costs nothing — `git diff | git patch-id` over a whole branch is the most expensive call in
  // this module, and a rejected invocation writes nothing. Memoized rather than called inline
  // because mutateIn is re-run by coordWrite's freshen-and-retry.
  // plan 3447: the fetch-before-patch-id policy rides INSIDE that thunk (review findings
  // d52c68 / 11ea1e) — this shared flow backs record-wiki and record-conclusion, so without it
  // those two families stamped a patch-id against a never-refreshed origin/master and then read
  // as stale at the land. Composed rather than fetched eagerly above, so the "every refusal
  // that precedes the write costs nothing" property stated just above still holds.
  const headPatchId = rangePatchIdOnceWithFetch('.', sha);

  return runRecordFlow(
    { tool: desc.tool, MAIN, dry, noPush },
    {
      // Resolve the session file against the GIVEN checkout dir, so the routed
      // (coord-checkout) and --no-push/--dry (MAIN) paths share one resolver. Resolving
      // against the FRESHENED coord-checkout (not stale MAIN) is what lets the DEFAULT
      // path see a claim session entry that only just landed on origin.
      prepare: (dir) => {
        const sf = findSessionFile(dir, slug, cfg.paths, desc.tool);
        if (!sf) return { code: noSessionEntry(desc.tool, slug, cfg.paths) };
        return { sf };
      },
      mutateIn: (dir, p) => {
        const abs = join(dir, p.sf);
        writeFileSync(
          abs,
          upsertMarker(fam, readFileSync(abs, 'utf8'), verdict, sha, detail, headPatchId()),
        );
      },
      commitMessage: () =>
        `chore(${desc.scope}): record ${verdict} @ ${sha.slice(0, 9)} for ${slug}${detailTail}`,
      dryLine: (p) =>
        `[dry] ${desc.tool}: would write "${fam.label}: ${verdict}${detail ? `:${detail}` : ''} @ ${sha}` +
        `${headPatchId() ? ` patch-id:${headPatchId()}` : ''}" into ${p.sf}`,
      report: (res, p) => {
        if (res.noop) {
          console.log(
            `${desc.tool}: ${verdict} @ ${sha.slice(0, 9)} already recorded in ${p.sf} (no change)`,
          );
          return 0;
        }
        console.log(
          `${desc.tool}: recorded ${verdict} @ ${sha.slice(0, 9)} in ${p.sf}${noPush ? ' (push skipped)' : ' + pushed'}`,
        );
        return 0;
      },
    },
  );
}
