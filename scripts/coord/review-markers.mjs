// scripts/coord/review-markers.mjs — moved from scripts/done-worktree-lib.mjs (plan 3959 T2). (dangling-ok: historical pre-move path, code lives here now)
//
// The generic review-tooling core: session-entry resolution, the sha-pinned marker family
// (review/wiki/conclusion parse+upsert+identity), and the findings-sidecar/disposition
// machinery. No fs, no child_process, no git — every function here is a total function of its
// inputs, same contract done-worktree-lib.mjs's own header states (the IO shell feeds these
// functions git/fs output and consumes their decisions). No vetapp-specific vocabulary: nothing
// here mentions a clinic, a market, or a deploy target.
//
// Rule 3 (docs/coord/scripts-layout.md): a non-test module under scripts/coord/ may
// import only scripts/coord/** and node: builtins. Two callers this module's functions used to
// default a parameter FROM broke that boundary — LEGACY_PATHS (scripts/coord/coord-config.mjs) and
// SESSION_ENTRY_DATE_SHAPE (scripts/coord/build-handoff-lib.mjs) both live outside scripts/coord/. No
// PRODUCTION call site of the affected functions ever relied on either default (every real
// caller — record-marker-cli.mjs, done-worktree.mjs, record-review.mjs — already passes `paths`
// explicitly), so:
//   - `paths` is now a REQUIRED parameter (no default) on isArchiveSessionPath,
//     sessionEntryPathspec, rankSessionFiles, pickSessionFile, resolveSessionEntry — a pure
//     signature narrowing, not a behavior change for any real caller.
//   - SESSION_ENTRY_DATE_SHAPE's value is inlined as SESSION_ENTRY_BASENAME_SHAPE below (the
//     literal is tiny and stable); review-markers.test.mjs pins it equal to the canonical
//     build-handoff-lib.mjs export so a future edit to either cannot drift silently — the same
//     "second, independently-maintained copy + a drift-asserting test" pattern this file's own
//     PYTEST_PREFLIGHT_CLOSURE precedent in done-worktree-lib.mjs already uses.
//
// findingsGate, reviewSeam, enqueueReadinessRefusal, isReviewableDiff, conclusionReviewSeam, and
// the wiki/conclusion marker-family delegates (parseWikiMarker*, parseConclusionMarker*,
// upsertWikiMarker, upsertConclusionMarker) stay in done-worktree-lib.mjs: they call the private
// `seam()` helper against the land spine's `SEAM` enum (both explicitly staying per this plan's
// own "Inherited premises" until program step 3), so they are land-spine gates, not generic
// marker plumbing — done-worktree-lib.mjs imports the primitives it still needs (MARKER_FAMILIES,
// parseMarkerCurrent, parseMarkerAny, upsertMarker, markerIdentityMatch, classifyAndBlocks,
// findingWithCanonicalKey) back from here for their sole benefit.

// ── session-entry resolution (plan 2838 protocol) ──────────────────────────────────

// plan 2838: a session ENTRY is a `.md` file matching `<YYYY-MM-DD>-…-session-<n>.md` — never a
// sidecar (findingsSidecarPath's `.findings.json`, which legitimately quotes sibling slugs in its
// findings' free text). Inlined from build-handoff-lib.mjs's SESSION_ENTRY_DATE_SHAPE — see this
// file's header for why it is a second literal rather than an import, and
// review-markers.test.mjs for the drift guard.
const SESSION_ENTRY_BASENAME_SHAPE = String.raw`\d{4}-\d{2}-\d{2}`;
const SESSION_ENTRY_BASENAME_RX = new RegExp(`^${SESSION_ENTRY_BASENAME_SHAPE}-.+\\.md$`, 'i');

// plan 642: one predicate for "is this the frozen pre-205 handoff archive?". Plan 639 relocated
// the 738 KB pre-205 history to handoff/sessions/archive/handoff-pre-205-history.md. Close-out /
// review writes must NEVER resolve to or mutate that subtree, and `git grep`'s lexical order
// (archive/… sorts AFTER every 2026-* entry) would otherwise let it win the old
// `hits[hits.length-1]`. Shared by pickSessionFile's filter + the close-out write guard so "what
// counts as archive" has exactly one definition. `paths` (a LEGACY_PATHS-shaped
// `{ sessionsDir, … }`) is a REQUIRED parameter — see this file's header note.
export function isArchiveSessionPath(p, paths) {
  return String(p || '').includes(`${paths.sessionsDir}/archive/`);
}

export function isSessionEntryPath(p) {
  return SESSION_ENTRY_BASENAME_RX.test(
    String(p || '')
      .split('/')
      .pop() || '',
  );
}

// plan 2838: the ONE pathspec every session-entry grep uses — `*.md` only (no sidecars), with
// the frozen pre-205 archive excluded (plan 642). Shared by record-marker-cli.findSessionFile and
// done-worktree.findSessionFileUncached so the two programs' resolution can never fork. Note git
// pathspecs match `*` across `/` by default, so this also covers any nested entry.
export function sessionEntryPathspec(paths) {
  return [`${paths.sessionsDir}/*.md`, `:(exclude)${paths.sessionsDir}/archive/`];
}

// plan 2838: the slug-independent form of the Branch line — "does this entry declare a branch at
// all?", which is how a LEGACY entry (no Branch line, so genuinely un-attributable) is told from
// another session's entry (a Branch line that the anchored pass already proved is not ours).
// Deliberately matches EVERY committed Branch form, not just the backticked worktree one:
// `**Branch:** none — …` and `**Branch:** resuming in existing worktree …` are both live on
// origin/master, and treating either as "legacy, therefore claimable" is the same hijack this
// plan closes. ERE, line-anchored.
export const SESSION_BRANCH_LINE_PATTERN = '^\\*\\*Branch:\\*\\*';

// plan 2838: every session entry claim-plan writes carries a structured ownership line,
// `**Branch:** \`worktree-<slug>\`` (2201 of 2296 live entries at spec-pass; the ~95 without it
// predate the line). Matching that ANCHORED form instead of a bare slug substring is the
// difference between "this session OWNS the slug" and "some file mentions the slug". Anchored
// means LINE-anchored: a plain fixed-string match would also fire on prose anywhere in a sibling
// entry that quotes the line. The slug sits in backticks ANYWHERE on that line rather than
// immediately after the label, because a real committed form is `**Branch:** resuming in
// existing worktree \`worktree-<slug>\` at …` — requiring the label-adjacent form would strand
// it. The backticks are load-bearing on both sides: without the closer, `worktree-2838-Foo`
// would also anchor `worktree-2838-Foo-extra`.
export function sessionEntryAnchor(slug) {
  // Slugs are ASCII letters/digits/._- (claim-plan-lib.assertSlugCharset), so `.` is the only
  // metacharacter that can appear — escape it rather than trusting the charset to hold forever.
  const safe = String(slug).replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
  return `${SESSION_BRANCH_LINE_PATTERN}.*\`worktree-${safe}\``;
}

// plan 2838: the owner a session entry declares for ITSELF, read from its own first Branch line.
// Returns the slug when that line names a `worktree-<slug>`; '' when the line exists but declares
// no worktree (`**Branch:** none — …`); null when the entry has no Branch line at all (legacy).
// The '' / null distinction matters: null is "unknown, cannot judge", '' is "explicitly no
// worktree" — neither is a conflict, but only null is claimable by the resolver's fallback.
export function sessionEntryOwnerSlug(content) {
  const line = String(content || '').match(/^\*\*Branch:\*\*.*$/m);
  if (!line) return null;
  const text = line[0].replace(/^\*\*Branch:\*\*/, '');
  const m = text.match(/`worktree-([^`]+)`/);
  if (!m) return '';
  // re-review 2838 [0]/[1]: a `**Branch:** none` line may still MENTION a worktree in its prose
  // — `**Branch:** none — … One throwaway worktree \`worktree-562-…\` was cut …` and
  // `**Branch:** (none yet … a \`worktree-skane-hero-photos\` is created …` are both committed.
  // Those sessions declare NO worktree; reading the historical mention as ownership would let a
  // live branch of that name resolve onto their entry — the very hijack this plan closes. A
  // `none` BEFORE the first backticked worktree is the declaration; anything after it is prose.
  if (/\bnone\b/i.test(text.slice(0, m.index))) return '';
  return m[1];
}

// plan 642/2838: rank the session-entry hits in the raw stdout of a `git grep -l … --
// handoff/sessions/*.md`, OLDEST first. Three defenses against the 639-exposed mis-resolution
// where the archived pre-205 history captured the close-out write (134 land, session 555:
// flipped an unrelated archived plan to ✅ COMPLETED, left the real entry stuck IN PROGRESS,
// pulled stale carry-forwards):
//   1. drop anything under handoff/sessions/archive/ — belt-and-suspenders for the callers'
//      `:(exclude)…` pathspec, so a git build that ignores the magic pathspec still can't
//      surface the archive.
//   2. plan 2838: drop anything that is not a `.md` ENTRY — the same belt for the `*.md` half of
//      sessionEntryPathspec (see isSessionEntryPath for the incident).
//   3. order by (date prefix, session number) instead of lexically, so a multi-session plan (K=3
//      retry queue, re-pickup) resolves to the latest session rather than whichever sorts last
//      (e.g. session-9 vs session-100).
// Pure (no I/O) — the `git grep` stays in the callers.
export function rankSessionFiles(grepOutput, paths) {
  const hits = String(grepOutput || '')
    .split('\n')
    .filter(Boolean)
    // plan 1286: callers now grep origin/master as well as HEAD (record-review lands via the
    // coord-checkout push, so origin is the marker's source of truth) — strip either ref prefix.
    .map((l) => l.replace(/^(?:HEAD|origin\/master):/, ''))
    .filter((p) => !isArchiveSessionPath(p, paths))
    .filter((p) => isSessionEntryPath(p));
  const key = (p) => {
    const base = p.split('/').pop() || '';
    const dm = base.match(/(\d{4}-\d{2}-\d{2})/);
    // Per-plan entries are `-session-<N>[drain]` (601, 601drain → 601). A non-numbered file (the
    // drain's shared `-session-drain-orchestrate.md` meta-log, which mentions many plan slugs)
    // gets sess=0 ON PURPOSE so it can never out-rank a real numbered per-plan entry on the same
    // date — flipping that shared log's first Status line would be the same wrong-file
    // corruption this resolver exists to prevent.
    const sm = base.match(/-session-(\d+)/);
    return { date: dm ? dm[1] : '', sess: sm ? parseInt(sm[1], 10) : 0, path: p };
  };
  return hits
    .map(key)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.sess !== b.sess) return a.sess - b.sess;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    })
    .map((k) => k.path);
}

// plan 642: choose the CURRENT (most-recent) session entry from a grep's raw stdout. The thin
// most-recent-wins tip of rankSessionFiles — see resolveSessionEntry for the resolution PROTOCOL
// (anchored first, ambiguity refused) that both programs now drive.
export function pickSessionFile(grepOutput, paths) {
  const ranked = rankSessionFiles(grepOutput, paths);
  return ranked.length ? ranked[ranked.length - 1] : null;
}

// plan 2838: the shared session-entry RESOLUTION PROTOCOL, driven by both record-marker-cli
// (every record-*/repin write) and done-worktree (the reviewSeam + FINDINGS_OPEN land gates), so
// a mis-resolve can neither clobber a stranger's record nor pass a land on their dispositions.
// `grep(pattern, pathspec)` is the caller's ref-bound `git grep -l -F <pattern> <ref> --
// <pathspec…>`, returning stdout ('' on no match — the caller swallows git's exit-1).
//
// Returns { sf, candidates, anchored, ambiguous }:
//
//   1. ANCHORED (the normal path). Entries whose own `**Branch:**` line names this slug. More
//      than one is LEGITIMATE — a re-pickup / retry writes a fresh entry per session for the
//      same plan — and plan 642's most-recent-wins is exactly right there, so this path never
//      refuses. That is the deliberate reading of "genuinely ambiguous": an anchored hit is a
//      session ASSERTING ownership of the slug, and a slug maps to exactly one plan.
//   2. FALLBACK (legacy entries predating the Branch line). Bare mentions, where a hit proves
//      only that some file names the slug — the dangerous class. Any mention that HAS a Branch
//      line is dropped: the anchored pass already proved that line does not name us, so the
//      entry demonstrably belongs to another session. What survives is legacy-only, and >1 of
//      those is un-disambiguatable → `ambiguous`, for the caller to refuse loudly. A silent
//      most-recent tiebreak here is what turned a mis-resolve into a clobber.
export function resolveSessionEntry(grep, slug, paths, readEntry = null) {
  const none = { sf: null, candidates: [], anchored: false, ambiguous: false, ownerConflict: null };
  if (!slug) return none;
  const spec = sessionEntryPathspec(paths);

  // The anchored grep is a cheap PREFILTER, not the authority (re-review 2838 [0]/[1]): a regex
  // cannot tell `**Branch:** \`worktree-X\`` from `**Branch:** none — … \`worktree-X\` was cut …`,
  // and both are committed. Re-derive each candidate's owner from the file with the same parser
  // assertSessionEntryOwner uses, so a session that declares NO worktree can never be captured by
  // its own prose. Without a reader the grep stands alone — the pre-verification behaviour.
  let anchored = rankSessionFiles(grep(sessionEntryAnchor(slug), spec, 'regex'), paths);
  const ranked = anchored;
  // plan 4021 review round 2 (b4b258/71e883): a dropped candidate is still RECORDED with why, so
  // the per-family marker walk (resolveSessionChainOverRefs → pickMarkerSourceEntry) can halt on
  // it instead of silently walking past it. The write target below is unchanged.
  const rejected = [];
  if (anchored.length && typeof readEntry === 'function') {
    anchored = anchored.filter((p) => {
      let owner;
      try {
        owner = sessionEntryOwnerSlug(readEntry(p));
      } catch {
        rejected.push({ path: p, reason: 'unreadable' }); // cannot prove ownership
        return false;
      }
      if (owner === slug) return true;
      rejected.push({ path: p, reason: 'owner' });
      return false;
    });
  }
  if (anchored.length) {
    return {
      sf: anchored[anchored.length - 1],
      candidates: anchored,
      anchored: true,
      ambiguous: false,
      ownerConflict: null,
      ranked,
      rejected,
    };
  }

  // review round 3 (939d7d): every return below keeps `rejected`, so a ref whose anchored candidates
  // were ALL dropped still hands them to the chain walk instead of losing them.
  const unresolved = { ...none, ranked, rejected };
  const mentions = rankSessionFiles(grep(slug, spec, 'fixed'), paths);
  if (!mentions.length) return unresolved;
  // Restricting the pathspec to the mention set keeps this to one extra grep over ≤N files.
  const declared = new Set(
    rankSessionFiles(grep(SESSION_BRANCH_LINE_PATTERN, mentions, 'regex'), paths),
  );
  const legacy = mentions.filter((p) => !declared.has(p));
  if (!legacy.length) return unresolved;
  if (legacy.length > 1) {
    return {
      sf: null,
      candidates: legacy,
      anchored: false,
      ambiguous: true,
      ownerConflict: null,
      rejected,
    };
  }
  return {
    sf: legacy[0],
    candidates: legacy,
    anchored: false,
    ambiguous: false,
    ownerConflict: null,
    rejected,
  };
}

// plan 2838, review [5]/[13]/[15]/[18]: the resolver's OWN answer, re-checked against the
// resolved entry's self-declared owner. `readEntry(path) → content | null`.
//
// Why this exists on top of resolveSessionEntry: the two greps above prove a NEGATIVE (no entry
// anchors this slug, and the surviving fallback candidate declares no branch), which is only as
// good as the grep. This re-derives the POSITIVE from the file itself, so a mismatch refuses
// however the entry was reached. It is also the half that protects the LEGACY population: all
// 1093 committed sidecars predate the `slug` stamp and are therefore un-ownable by
// sidecarOwnerConflict, but their sibling ENTRIES have carried the Branch line all along. Returns
// the resolution with `ownerConflict: {path, owner}` set when the entry belongs to someone else —
// callers refuse on it exactly as they do on `ambiguous`.
export function assertSessionEntryOwner(resolution, slug, readEntry) {
  if (!resolution?.sf || typeof readEntry !== 'function') return resolution;
  let content;
  try {
    content = readEntry(resolution.sf);
  } catch {
    return resolution; // unreadable → cannot judge; the caller's own gates still apply
  }
  const owner = sessionEntryOwnerSlug(content);
  // null (no Branch line) and '' (declares no worktree) are both "not a conflict" — only a
  // Branch line naming a DIFFERENT worktree slug is.
  if (!owner || owner === slug) return resolution;
  return { ...resolution, sf: null, ownerConflict: { path: resolution.sf, owner } };
}

// plan 4021 review round 2 (ae1b7d): the ONE ref-walking session-entry CHAIN resolver, shared by
// record-marker-cli.findSessionEntryChain and done-worktree.findSessionFileUncached so the writer
// and the land gate can never resolve differently. I/O is injected per ref: `grepFor(ref)` returns
// resolveSessionEntry's grep, `readEntryFor(ref)` its reader. Fail CLOSED per ref and never fall
// through on a refusal (a wrong-owner or un-disambiguatable answer on one ref is not improved by
// asking the next); `report(message)` receives the refusal text. Review round 3 (5ffd98/41f896): a
// lookup that THROWS on a ref — a grep or read failure its wrapper could not classify as absence —
// is a refusal as well, reported with its reason; it is never "no hit there" followed by a
// fall-through to an older ref. Returns { sf, entries, anchored, ref } or null.
//
// `entries` is the per-family marker WALK, newest first, for pickMarkerSourceEntry: owned paths as
// strings, and every anchored candidate the resolver had to DROP as `{ path, halt }` (review
// b4b258/71e883) so the walk halts on it rather than resurrecting an older marker past it. One
// exception: a candidate NEWER than `sf` whose own Branch line names another owner (or declares
// none) is positively not this slug's entry, so it is left out; an unreadable one is kept
// wherever it sits, because "could not read" is never "not ours". Review round 3 (939d7d): the
// candidates a fresher ref dropped while resolving NOTHING there are carried into the next ref's
// walk, ranked among its own candidates under that same rule.
export function resolveSessionChainOverRefs({
  refs,
  slug,
  paths,
  tool,
  report,
  grepFor,
  readEntryFor,
}) {
  const carried = [];
  for (const ref of refs) {
    const readEntry = readEntryFor(ref);
    let r;
    try {
      r = assertSessionEntryOwner(
        resolveSessionEntry(grepFor(ref), slug, paths, readEntry),
        slug,
        readEntry,
      );
    } catch (e) {
      report(sessionEntryLookupErrorMessage(tool, slug, ref, e));
      return null;
    }
    if (r.ambiguous) {
      report(ambiguousSessionEntryMessage(tool, slug, r.candidates));
      return null;
    }
    if (r.ownerConflict) {
      report(sessionEntryOwnerMessage(tool, slug, r.ownerConflict));
      return null;
    }
    if (r.sf) {
      return {
        sf: r.sf,
        entries: markerWalkEntries(r, carried, paths),
        anchored: Boolean(r.anchored),
        ref,
      };
    }
    carried.push(...(r.rejected || []));
  }
  const unreadable = carried.find((x) => x.reason === 'unreadable');
  if (unreadable) {
    report(
      sessionEntryLookupErrorMessage(tool, slug, refs.join(', '), {
        message: `${unreadable.path} anchors this slug but could not be read`,
      }),
    );
  }
  return null;
}

function markerWalkEntries(r, carried, paths) {
  const why = new Map();
  for (const x of [...carried, ...(r.rejected || [])]) {
    if (why.get(x.path) !== 'unreadable') why.set(x.path, x.reason);
  }
  if (!r.anchored) {
    // a legacy resolution is a single bare mention; only a candidate nobody could READ halts it
    const halts = [...why]
      .filter(([, reason]) => reason === 'unreadable')
      .map(([path, halt]) => ({ path, halt }));
    return [...halts, r.sf];
  }
  const own = r.ranked || r.candidates;
  const ranked = carried.length
    ? rankSessionFiles([...new Set([...own, ...carried.map((x) => x.path)])].join('\n'), paths)
    : own;
  const at = ranked.indexOf(r.sf);
  const out = [];
  for (let i = ranked.length - 1; i >= 0; i--) {
    const halt = why.get(ranked[i]);
    if (!halt) out.push(ranked[i]);
    else if (i <= at || halt === 'unreadable') out.push({ path: ranked[i], halt });
  }
  return out;
}

// ── plan 4021 review rounds 2+3: the ONE strict read classification ─────────────────────────
// ABSENCE is only (a) git saying the path or the ref does not exist, or (b) the filesystem saying
// ENOENT while an lstat of the SAME path also finds nothing. Everything else — a dangling symlink
// (reads ENOENT, yet the link is there), ENOTDIR, EACCES, EISDIR, a corrupt object, a spawn
// failure — means "could not find out", and every marker / findings reader treats it as an ERROR
// that halts, never as "nothing recorded" (review 4fcf38/2a36b2/5ffd98/41f896/8a3528/33ce2a).
//
// Why not import seam-guard-lib.mjs's PATH_ABSENT_RX (review 3f6485): Rule 3 of
// docs/coord/scripts-layout.md forbids a scripts/coord/ module from importing anything
// outside scripts/coord/. This is therefore the single copy that record-marker-cli, record-review
// and done-worktree all route through; it is a superset of that regex (it also knows the
// missing-REF wordings `git show` and `git grep` print).
const GIT_PATH_ABSENT_RX =
  /does not exist in '|exists on disk, but not in '|invalid object name|not a valid object name|unknown revision|unable to resolve revision/i;
export function isGitPathAbsentError(e) {
  return GIT_PATH_ABSENT_RX.test(`${e?.stdout || ''}${e?.stderr || ''}${e?.message || ''}`);
}

// `git grep -l` exits 1 with no output on no match, and a missing ref is absence too. Any other
// failure (a corrupt tree, a spawn error) is not a search result at all.
export function gitGrepNoMatch(e) {
  const quiet = !String(e?.stdout || '').trim() && !String(e?.stderr || '').trim();
  return (e?.status === 1 && quiet) || isGitPathAbsentError(e);
}

// The grep wrapper both programs hand resolveSessionChainOverRefs: '' on no match, rethrow the rest.
export function grepOrNoMatch(runGrep) {
  try {
    return runGrep();
  } catch (e) {
    if (gitGrepNoMatch(e)) return '';
    throw e;
  }
}

// `probeLink()` is the caller's lstat of the path that failed to read (injected: no I/O here).
export function isFsPathAbsentError(e, probeLink) {
  if (e?.code !== 'ENOENT' || typeof probeLink !== 'function') return false;
  try {
    probeLink();
    return false; // something IS at the path — a dangling symlink reads ENOENT
  } catch (l) {
    return l?.code === 'ENOENT';
  }
}

// The ONE origin-first candidate read (the origin/master copy, then the working-tree copy) behind
// record-marker-cli.readSessionCandidates and done-worktree.sessionDocCandidates. Non-strict keeps
// the historical contract (every failure is skipped) for advisory readers. `strict` is for marker
// SOURCE selection: only a genuine absence is skipped, and any other failure THROWS, so
// pickMarkerSourceEntry halts on it instead of judging the entry from its one readable copy.
// `probeTree` is the lstat of the working-tree path; without it a tree ENOENT cannot prove absence.
export function originFirstCandidates(showOrigin, readTree, { strict = false, probeTree } = {}) {
  const out = [];
  try {
    out.push(showOrigin());
  } catch (e) {
    if (strict && !isGitPathAbsentError(e)) throw e;
  }
  try {
    out.push(readTree());
  } catch (e) {
    if (strict && !isFsPathAbsentError(e, probeTree)) throw e;
  }
  return out;
}

// plan 4021: the READ-side marker source for one marker family. resolveSessionEntry's `sf` (the
// NEWEST owned entry) stays the WRITE target of every record-*/repin; this only decides which
// entry a land-time READ of ONE family consults. Why: an adopting session's `claim-plan acquire`
// mints a fresh anchored entry with no markers, and newest-wins let it shadow the older entry that
// holds the branch's still-valid Review:/Wiki: marker (plan 3982, twice on 2026-09-14).
//
// `entries` is newest-first: [sf, ...older anchored candidates]. `read(path) → string[]` yields
// that entry's candidate contents (the caller's origin-first, working-tree-second view; a write
// path passes the one tree it writes).
//   - Every content of every entry consulted is OWNERSHIP-checked, the newest included (review
//     321957): the resolver verified the owner on a REF, but a caller may read another copy (the
//     working tree) that says something else. For an anchored resolution a content must name
//     `slug`; for a legacy one (`anchored: false`, a single entry with no Branch line) it must
//     not name ANOTHER slug — the same line assertSessionEntryOwner draws.
//   - The newest entry wins whenever all its contents are owned and one carries a marker of
//     `family`, even a STALE one: a newer record supersedes, and validity stays the caller's
//     parseMarkerCurrent.
//   - Otherwise the walk goes to the newest OLDER entry that is readable, wholly owned, and
//     carries a marker of `family`. Older entries that are readable, owned and marker-less are
//     skipped (the adoption shape).
//   - The walk HALTS — the family resolves to no marker, exactly the pre-4021 land behaviour — at
//     the first entry that is UNREADABLE (the read throws or yields nothing: review 0b3b0d, "we
//     could not find out" is never "nothing recorded") or CONTESTED (a content naming another
//     owner). Halting rather than skipping is deliberate: skipping an entry we could not judge is
//     exactly how an older marker would be resurrected past a newer record nobody could read.
//     A halt returns `{ path: entries[0], contents: [], fallback: false, halted: {reason, path} }`.
//   - Nothing recorded for this family anywhere → the newest entry, not a fallback.
//   - Review round 2: an entry may arrive as `{ path, halt }` — a candidate the resolver itself
//     could not read or attribute (resolveSessionChainOverRefs). The walk halts on it exactly as
//     on a read failure here. A legacy copy is ownerless only when it has NO Branch line at all
//     (review bb4455): `**Branch:** none` declares "no worktree", which never supplies a marker.
// Family-scoped: a Review marker never makes an entry the Wiki source, and vice versa.
// Returns { path, contents, fallback, halted? }, or null for an empty list.
export function pickMarkerSourceEntry(family, slug, entries, read, { anchored = true } = {}) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const pathOf = (e) => (typeof e === 'string' ? e : e.path);
  const newest = pathOf(entries[0]);
  const readOrNull = (e) => {
    if (typeof e !== 'string') return null;
    try {
      const out = read(e);
      return Array.isArray(out) && out.length ? out : null;
    } catch {
      return null;
    }
  };
  if (!slug) return { path: newest, contents: readOrNull(entries[0]) || [], fallback: false };
  const halt = (reason, path) => ({
    path: newest,
    contents: [],
    fallback: false,
    halted: { reason, path },
  });
  const owns = (c, legacyOk) => {
    const owner = sessionEntryOwnerSlug(c);
    return owner === slug || (legacyOk && owner === null);
  };
  const hasMarker = (contents) => contents.some((c) => parseMarkerAny(family, c));
  let newestContents = null;
  for (const [i, e] of entries.entries()) {
    if (typeof e !== 'string') return halt(e.halt, e.path);
    const contents = readOrNull(e);
    if (!contents) return halt('unreadable', e);
    if (!contents.every((c) => owns(c, i === 0 && !anchored))) return halt('owner', e);
    if (i === 0) newestContents = contents;
    if (hasMarker(contents)) return { path: e, contents, fallback: i > 0 };
  }
  return { path: newest, contents: newestContents, fallback: false };
}

// plan 4021 (review fb94f6): the raw text of the LAST line in `content` carrying a marker of
// `family` — the per-line twin of parseMarkerAny's last-match rule — or null. Unaltered, so every
// trailing token the family's writers splice after the sha (patch-id, review scope, review-round,
// past-cap) survives a carry-forward.
export function markerLineOf(family, content) {
  const rx = new RegExp(markerRegExp(family).source, 'i');
  let last = null;
  for (const line of String(content || '').split(/\r?\n/)) if (rx.test(line)) last = line;
  return last;
}

// Pure: `content` with every machine-marker line of `family` removed (whole line incl. newline;
// anchored on `@ <sha>` so a prose `**Review:**` line is never matched). The ONE strip rule,
// shared by upsertMarker and carryMarkerLine so a carried line and a written line replace alike.
// Review round 2 (f4cea5): built FROM markerRegExp, the parser's own grammar, so a line
// markerLineOf/parseMarkerAny recognise is always a line this strips (no duplicate after a carry).
export function stripMarkerLines(family, content) {
  const stripRx = new RegExp(`^.*${markerRegExp(family).source}.*\\r?\\n?`, 'gim');
  return String(content).replace(stripRx, '');
}

// plan 4021 review round 3 (ac5821): the trailing tokens record-review splices after
// `@ <sha>[ patch-id:…]`, in exactly the grammar it writes them (describeReviewScope,
// appendMarkerRoundSuffix, describeReviewPastCap). Read from the start of the tail, one token at a
// time; the first text that is not one of them ends the metadata. A token whose own text is
// marker-shaped (a past-cap reason quoting `Review: NITS @ <sha>`) ends it too and is dropped:
// parseMarkerAny keeps the LAST match, so preserving it would re-parse as the marker itself.
const MARKER_TRAILING_TOKEN_RX =
  /^\s+(?:scope-narrowed\[excluded=\d+\]|review-round:\d+|past-cap-reason="(?:\\.|[^"\\])*")/;
function markerTrailingTokens(rest) {
  let kept = '';
  let tail = String(rest || '');
  for (let m = MARKER_TRAILING_TOKEN_RX.exec(tail); m; m = MARKER_TRAILING_TOKEN_RX.exec(tail)) {
    tail = tail.slice(m[0].length);
    if (Object.values(MARKER_FAMILIES).some((f) => markerRegExp(f).test(m[0]))) break;
    kept += m[0];
  }
  return kept;
}

// plan 4021 review round 3 (3ba933/4de3b4): the FULL recorded identity of the last `family` marker
// line in `content` — verdict, detail, sha, patch-id AND its grammar-defined trailing tokens — so a
// freshness check compares everything the land contract reads. Null when no marker line exists.
export function markerLineIdentity(family, content) {
  const line = markerLineOf(family, content);
  if (line === null) return null;
  const m = new RegExp(markerRegExp(family).source, 'i').exec(line);
  const parsed = parseMarkerAny(family, m[0]);
  return {
    result: parsed[family.resultField],
    detail: parsed.detail ?? '',
    sha: parsed.sha,
    patchId: parsed.patchId,
    tail: markerTrailingTokens(line.slice(m.index + m[0].length)).trim(),
  };
}

// Is `now` still the marker a gate approved as `gate`? Every identity field must match, and the
// (sha, patch-id) pin must be either the gate's own or HEAD's (a sibling already re-pinned it).
export function markerIdentityUnchanged(gate, now, headSha, headPatchId = null) {
  if (!gate || !now) return false;
  if (now.result !== gate.result || now.detail !== gate.detail || now.tail !== gate.tail) {
    return false;
  }
  const pin = (sha, pid) => `${String(sha).toLowerCase()} ${normalizeMarkerPatchId(pid) ?? ''}`;
  const nowPin = pin(now.sha, now.patchId);
  return nowPin === pin(gate.sha, gate.patchId) || nowPin === pin(headSha, headPatchId);
}

// plan 4021 review round 2 (998229/59ba2e/781252): RE-PIN the last marker line of `family` in
// place — only its `@ <sha>` and patch-id token move; the verdict, detail and the trailing tokens
// after them (scope, review-round, past-cap-reason) are kept unchanged. Round 3 (ac5821): only
// tokens of that grammar are kept (markerTrailingTokens), never arbitrary trailing text. Placement
// matches upsertMarker (every same-family line stripped, the marker appended last). Null when
// `content` carries no marker of the family. Pure.
export function repinMarkerLine(family, content, sha, patchId = null) {
  const line = markerLineOf(family, content);
  if (line === null) return null;
  const m = new RegExp(markerRegExp(family).source, 'i').exec(line);
  const pid = normalizeMarkerPatchId(patchId);
  const head = m[0].slice(0, m[0].indexOf('@'));
  const moved =
    line.slice(0, m.index) +
    `${head}@ ${sha}${pid ? ` patch-id:${pid}` : ''}` +
    markerTrailingTokens(line.slice(m.index + m[0].length));
  const cleaned = stripMarkerLines(family, content);
  const sep = cleaned === '' || cleaned.endsWith('\n') ? '' : '\n';
  return `${cleaned}${sep}${moved}\n`;
}

// plan 4021 (review fb94f6): CARRY FORWARD — `content` (the newest owned entry) with the marker
// line of `family` copied UNALTERED from `sourceText` (the older owned entry pickMarkerSourceEntry
// fell back to), replacing any marker line of that family already there. Returns null when the
// source carries no such marker. Pure; the write flows own the I/O and the rollback.
export function carryMarkerLine(family, content, sourceText) {
  const line = markerLineOf(family, sourceText);
  if (line === null) return null;
  const cleaned = stripMarkerLines(family, content);
  const sep = cleaned === '' || cleaned.endsWith('\n') ? '' : '\n';
  return `${cleaned}${sep}${line}\n`;
}

// plan 2838: the ONE wrong-owner refusal message, twin of ambiguousSessionEntryMessage.
export function sessionEntryOwnerMessage(tool, slug, conflict) {
  return (
    `${tool}: REFUSED — the only session entry matching "${slug}" belongs to ANOTHER session:\n` +
    `  ${conflict.path}\n` +
    `  its **Branch:** line declares \`worktree-${conflict.owner}\`\n` +
    `Writing there would record onto that session's entry (and replace its findings sidecar) — ` +
    `plan 2838's observed incident. Nothing was written. Record your own claim session entry ` +
    `first, or add a \`**Branch:** \\\`worktree-${slug}\\\`\` line to the entry that owns this slug.`
  );
}

// plan 4021 review round 3 (5ffd98/41f896): the refusal a session-entry lookup prints when a ref
// could not be searched or read. Git's own last diagnostic line is kept as the reason.
export function sessionEntryLookupErrorMessage(tool, slug, ref, e) {
  const lines = String(e?.stderr || e?.message || e || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    `${tool}: REFUSED — could not look up the session entry for "${slug}" on ${ref}: ` +
    `${lines[lines.length - 1] || 'unknown error'}. A lookup that fails is not "no entry there", so ` +
    `no older ref was consulted and nothing was decided from it. Re-run once the ref reads cleanly ` +
    `(e.g. after \`git fetch origin\`).`
  );
}

// plan 2838: the ONE ambiguity refusal message — every candidate NAMED, plus the concrete remedy,
// so the operator is not left guessing which entry the tool would have written to.
export function ambiguousSessionEntryMessage(tool, slug, candidates) {
  return (
    `${tool}: AMBIGUOUS session entry for slug "${slug}" — ${candidates.length} legacy entries ` +
    `mention it and none anchors it with a \`${sessionEntryAnchor(slug)}\` line:\n` +
    candidates.map((c) => `  - ${c}`).join('\n') +
    `\nRefusing rather than silently picking the most-recent one (plan 2838: that tiebreak once ` +
    `overwrote a sibling session's dispositioned findings). Add the \`**Branch:**\` line to the ` +
    `entry that actually owns this slug, then re-run.`
  );
}

// ── recording protocol guard ────────────────────────────────────────────────────────

// The record-side counterpart of the parse*Marker staleness guards below (plan 1105). A
// review/wiki marker may only be recorded from INSIDE worktree-<slug>, because only there does
// ambient HEAD equal the sha parseReviewMarker / parseWikiMarker recompute against at land time.
// Recording from any other checkout (notably the MAIN checkout on master, even with --slug) would
// silently pin THAT checkout's tip — a sha the staleness guard always rejects, so the land
// mis-seams REVIEW_NEEDED / WIKI_CHECKPOINT despite a recorded verdict. Returns { ok:true } to
// proceed, else { ok:false, message } (`tool` names the caller for the message, e.g.
// 'record-review'); a detached HEAD gets an accurate, non-"cd-in" hint.
export function checkRecordBranch(branch, slug, tool = 'record') {
  if (branch === `worktree-${slug}`) return { ok: true };
  const where = (branch || '').trim() === 'HEAD' ? 'a detached HEAD' : `"${branch}"`;
  return {
    ok: false,
    message:
      `${tool}: on ${where}, but recording requires being on the worktree-${slug} branch — ` +
      `checkout/cd into that worktree to record (HEAD here is a different commit than the worktree ` +
      `tip the land's staleness guard recomputes, so it would pin a sha the land rejects).`,
  };
}

// Pure: do two hex shas identify the SAME commit? True when one is a prefix of the other (handles
// a 7-char marker sha vs a 40-char HEAD, and vice-versa) with both ≥7 hex (guards a trivially-short
// match; HEAD is always full-length so this only bites a too-short marker sha). The ONE staleness
// predicate the review marker, the wiki marker, and the findings record all share, so they can
// never drift.
export function sameCommitSha(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

// ── plan 2042: the ONE parameterized sha-pinned marker family ─────────────────────
// Three session-entry markers share one grammar — `<Label>: <VERDICT>[:detail] @ <sha>` (sha =
// the branch HEAD the verdict covered, 7–64 hex — sha1 today, sha256-safe) — and one lifecycle
// (record → staleness-guarded parse → mechanical repin). `resultField` names the verdict key
// each family's parsed object exposes (wiki's historical contract says `decision`, the others
// `verdict`).
// ── plan 2162: review PROVENANCE vocabulary (referenced by the review family below) ──
// The review method token records HOW a review ran so the land gate (and any audit) can tell a
// full /sonnet-review fan-out from the single-agent substitute a dispatched subagent falls back
// to (it has no Workflow tool).
export const REVIEW_METHODS = [
  'sonnet-review',
  'code-review',
  'gpt-review',
  'substitute',
  'self-read',
];
// The methods for which finder/verifier/adjudicator counts are MEANINGFUL — a real fan-out.
// buildReviewProvenance drops counts for any other method, so a stale --review-stats attached to
// `substitute` can't forge a `substitute f=6 v=4 adj=1` token.
export const REVIEW_FANOUT_METHODS = ['sonnet-review', 'code-review', 'gpt-review'];
// The ONE rendering of the "no provenance declared" state — shared by markerStatusRow (the
// land-halt table), record-review's report line, and done-worktree's land log, so a future audit
// grep can't miss two of three hand-drifted spellings.
export const REVIEW_PROVENANCE_UNDECLARED = 'provenance undeclared';

export const MARKER_FAMILIES = {
  review: {
    label: 'Review',
    verdicts: ['PASS', 'NITS', 'BUGS-FOUND'],
    // plan 2162: when a review marker carries no detail (legacy, or provenance undeclared),
    // markerStatusRow renders this hint instead of a bare verdict.
    undeclaredDetailHint: REVIEW_PROVENANCE_UNDECLARED,
    // plan 2162: the review marker carries a DETAIL — the review PROVENANCE (how the review ran:
    // sonnet-review full fan-out vs a hand-rolled substitute, with finder/verifier/refute-
    // adjudicator counts). The detail is built by buildReviewProvenance below. The detail group
    // is optional in markerRegExp, so a legacy `Review: PASS @ <sha>` still parses (as
    // provenance-undeclared).
    hasDetail: true,
    resultField: 'verdict',
  },
  wiki: {
    label: 'Wiki',
    verdicts: ['WROTE', 'SKIP'],
    hasDetail: true,
    resultField: 'decision',
  },
  conclusion: {
    label: 'Conclusion',
    verdicts: ['UPHELD', 'REFUTED', 'UNDERDETERMINED'],
    hasDetail: true,
    resultField: 'verdict',
  },
  // plan 4219: an independent judge's verdict on the branch's live pages. PASS-NOTES is listed
  // before PASS so the alternation never settles on the shorter prefix. The detail names the
  // judge, the recipes it covered and the evidence directory.
  liveCheck: {
    label: 'LiveCheck',
    verdicts: ['PASS-NOTES', 'PASS', 'FAIL', 'BLOCKED', 'SKIP'],
    hasDetail: true,
    resultField: 'verdict',
  },
};

// ── plan 2743: the rebase-STABLE half of a marker's identity ──────────────────────
// A marker pinned to the branch tip sha alone is invalidated by every rebase, and plan 1528's
// mechanical re-pin heals that by pushing a commit to master — which advances master, which
// invalidates the rebase base of every land currently prepping, including the one that just
// emitted it. So the marker carries a SECOND, rebase-stable identity alongside the sha: the range
// patch-id (land-lib.rangePatchId — the branch's whole content-diff vs its merge-base with
// origin/master), written as a trailing ` patch-id:<value>` token:
//
//   Review: PASS:sonnet-review f=6 v=4 adj=1 @ <sha> patch-id:<hex|empty>
//
// The token is OPTIONAL in the grammar — the same backward-compat trick plan 2162 used for the
// detail group. A legacy sha-only marker still parses (patchId null) and still takes the
// plan-1528 repin path unchanged; forward-only migration, no backfill.
//
// The value vocabulary is exactly rangePatchId's return domain: a hex digest, or the literal
// 'empty' it emits for an empty diff (git patch-id prints nothing on empty input, and two empty
// ranges must still compare equal). Anything else is refused at write time by
// normalizeMarkerPatchId rather than written as a token the parser reads back as null.
const PATCH_ID_VALUE = '[0-9a-f]{6,64}|empty';
const PATCH_ID_GROUP = `(?:\\s+patch-id:(${PATCH_ID_VALUE}))?`;
const PATCH_ID_VALUE_RX = new RegExp(`^(?:${PATCH_ID_VALUE})$`, 'i');

// Pure: the writable form of a patch-id token value, or null when it is absent or outside the
// vocabulary above. Strict on purpose — a value carrying whitespace, an '@' or a newline would
// break the one-line marker grammar, and a merely-unrecognised one would be written but read back
// as null (a marker that silently disagrees with itself).
export function normalizeMarkerPatchId(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  return PATCH_ID_VALUE_RX.test(s) ? s : null;
}

// The family's marker regex. The detail group `[^\n@]*` keeps the marker one line delimited by
// ` @ <sha>` (upsertMarker sanitizes '@'/newlines out of the detail for the same reason). Built
// fresh per call so the 'g' lastIndex can never leak between parses. Group order: verdict,
// [detail], sha, [patch-id] — parseMarkerAny consumes them positionally through that same
// `family.hasDetail` switch.
//
// Exported so a caller needing a PER-LINE test (record-review.mjs's recordedReviewRound, which
// walks the session entry line by line to find the round token on the marker's own line) can
// reuse this instead of restating the family's shape as a second hand-rolled regex that can
// drift from MARKER_FAMILIES.
export function markerRegExp(family) {
  const detail = family.hasDetail ? '(?::([^\\n@]*))?' : '';
  return new RegExp(
    `${family.label}:\\s*(${family.verdicts.join('|')})${detail}\\s*@\\s*([0-9a-f]{7,64})\\b${PATCH_ID_GROUP}`,
    'gi',
  );
}

// Staleness-BLIND parse (plan 1528 A1): the LAST marker in `text` as { <resultField>, detail?,
// sha } regardless of whether it matches HEAD. Feeds the mechanical re-pin (record-*.mjs repin):
// a STALE marker whose recorded tip is patch-id-identical to HEAD is re-recordable without a
// human; repinDecision owns that gate — this parser never decides, it only surfaces what was
// recorded.
export function parseMarkerAny(family, text) {
  if (!text) return null;
  let last = null;
  for (const m of String(text).matchAll(markerRegExp(family))) {
    // plan 2743: `patchId` is ALWAYS present on the result (null for a legacy sha-only marker) so
    // every consumer can test one uniformly-shaped field instead of guessing whether the key
    // exists.
    last = family.hasDetail
      ? {
          [family.resultField]: m[1].toUpperCase(),
          detail: (m[2] || '').trim(),
          sha: m[3].toLowerCase(),
          patchId: normalizeMarkerPatchId(m[4]),
        }
      : {
          [family.resultField]: m[1].toUpperCase(),
          sha: m[2].toLowerCase(),
          patchId: normalizeMarkerPatchId(m[3]),
        };
  }
  return last;
}

// plan 2086: the ONE marker-status display line — shared by done-worktree.mjs's land-halt marker
// table and record-marker.mjs's `check` command so the two can never print different text for the
// same repo state. Pure: `marker` is a parseMarkerAny result (staleness-blind) or null (nothing
// recorded).
// plan 2743: `headPatchId` (optional, value or thunk) lets the row tell a genuinely stale marker
// apart from one the read side now honors via its rebase-stable identity — without it a
// patch-id-current marker would be labelled "STALE" in the very table a session reads to decide
// what to do about it. Omitted ⇒ byte-identical output to before.
// plan 3295: `seedOnlyDelta` (optional, 5th arg) is threaded straight through to
// markerIdentityMatch — omitted (the wiki/conclusion rows never pass it) the row renders
// byte-identical to before.
export function markerStatusRow(family, marker, headSha, headPatchId = null, seedOnlyDelta = null) {
  if (!marker) return `${family.label}: not recorded`;
  const fresh = sameCommitSha(marker.sha, headSha);
  const how = fresh
    ? null
    : markerIdentityMatch(marker.sha, marker.patchId, headSha, headPatchId, seedOnlyDelta);
  const rebasePinned = how === 'patch-id';
  const seedOnlyPinned = how === 'seed-only';
  // plan 2162: surface the detail (for review, the provenance token) so a land-halt marker table
  // and `record-marker check` show HOW the review ran, not just the verdict — this is the
  // visibility half of ending the silent review-downgrade. A hasDetail family with no detail
  // recorded falls back to its declarative `undeclaredDetailHint` (review sets it to
  // REVIEW_PROVENANCE_UNDECLARED so a legacy / undeclared review marker reads as such); a family
  // with no hint renders bare. Kept in the MARKER_FAMILIES table, NOT a hardcoded label check
  // here, so the next hasDetail family opts in by adding the field.
  const detail = family.hasDetail
    ? marker.detail
      ? ` (${marker.detail})`
      : family.undeclaredDetailHint
        ? ` (${family.undeclaredDetailHint})`
        : ''
    : '';
  return (
    `${family.label}: ${marker[family.resultField]}${detail} @ ${marker.sha.slice(0, 9)} — ` +
    (fresh
      ? 'fresh (pins HEAD)'
      : rebasePinned
        ? `fresh (patch-id ${marker.patchId.slice(0, 9)} pins HEAD ${headSha.slice(0, 9)} across a rebase)`
        : seedOnlyPinned
          ? `fresh (seed-only delta carries HEAD ${headSha.slice(0, 9)} from ${marker.sha.slice(0, 9)})`
          : `STALE (HEAD is ${headSha.slice(0, 9)})`)
  );
}

// Staleness-GUARDED parse: the last marker ONLY when its <sha> identifies the same commit as
// `currentSha` (mutual hex-prefix match, ≥7 chars — sameCommitSha). Null when there is no marker,
// the sha is stale (a verdict for an older tip must NOT auto-skip the land-time gate), or
// `text`/`currentSha` is missing. The staleness guard is the whole safety story — a recorded
// verdict counts only for the exact tip it covered.
// plan 2743: the ONE dual-identity comparator — "does this recorded (sha, patch-id) pair still
// describe `currentSha`?" — shared by parseMarkerCurrent (markers) and findingsRecordIsCurrent
// (the findings sidecar, in done-worktree-lib.mjs). Those two MUST agree. Returns HOW it matched
// — 'sha' (fast path, no git) or 'patch-id' (rebase-stable fallback) — or null when stale, so a
// caller can tell them apart. `headPatchId` is a value or a thunk; omitted ⇒ sha-only, the
// pre-2743 behavior.
//
// A MISSING `recordedSha` is not an early return (operator ruling 2026-08-03, plan 2743 grill
// Q2): the three inline implementations this comparator replaced fell through to the patch-id
// comparison whenever the sha check failed — including when the record carried no sha at all —
// and an early return silently NARROWED findingsRecordIsCurrent for a sidecar written with a
// valid patchId and no sha. `sameCommitSha` already returns false for a falsy argument, so the
// fall-through is exactly the prior behavior with no extra guard. `currentSha` DOES still guard:
// with no current tip there is nothing to be current WITH, and the fast path could not run at
// all.
// plan 3295: `seedOnlyDelta` (optional, 5th arg — value or a `(recordedSha, currentSha) =>
// boolean` predicate) is the REVIEW-only third fallback, tried only after BOTH the sha fast path
// and the patch-id fallback have failed — same laziness contract as `headPatchId`. It is never
// wired into the wiki/conclusion call sites, so this stays a review opt-in, not a change to the
// shared comparator's default behavior for any other family.
export function markerIdentityMatch(
  recordedSha,
  recordedPatchId,
  currentSha,
  headPatchId = null,
  seedOnlyDelta = null,
) {
  if (!currentSha) return null;
  if (sameCommitSha(recordedSha, currentSha)) return 'sha';
  const recorded = normalizeMarkerPatchId(recordedPatchId);
  if (recorded) {
    const head = normalizeMarkerPatchId(
      typeof headPatchId === 'function' ? headPatchId() : headPatchId,
    );
    if (head && head === recorded) return 'patch-id';
  }
  if (seedOnlyDelta && recordedSha) {
    const ok =
      typeof seedOnlyDelta === 'function' ? seedOnlyDelta(recordedSha, currentSha) : seedOnlyDelta;
    if (ok) return 'seed-only';
  }
  return null;
}

// plan 2743 adds the rebase-stable SECOND chance, without touching the fast path: the sha
// comparison above still decides first and still spawns no git. Only on a sha MISMATCH, and only
// when the marker carries a patch-id, is `headPatchId` consulted — HEAD's own range patch-id,
// passed either as a value or as a THUNK the caller memoizes. Equal ⇒ the branch's content-diff
// vs master is byte-equivalent across the re-sha, i.e. a pure rebase: the review still covers
// exactly this content, so the marker is CURRENT and NO re-pin commit is needed. Unequal or
// uncomputable ⇒ stale, bit-for-bit today's behavior.
//
// This is the same proof repinDecision already demanded before agreeing to re-pin — the
// difference is only that honoring it here costs nothing, where re-pinning costs a commit on
// master. The result carries `rebasePinned: true` so a caller can tell the two apart.
//
// Keeping the core PURE: with `headPatchId` omitted the function is exactly as pure as before
// (text in, no git), which is how the unit tests drive it.
export function parseMarkerCurrent(
  family,
  text,
  currentSha,
  headPatchId = null,
  seedOnlyDelta = null,
) {
  if (!text || !currentSha) return null;
  const last = parseMarkerAny(family, text);
  if (!last) return null;
  const how = markerIdentityMatch(last.sha, last.patchId, currentSha, headPatchId, seedOnlyDelta);
  if (!how) return null;
  if (how === 'patch-id') return { ...last, rebasePinned: true };
  // plan 3295: seed-only carry — review only (nothing else ever passes seedOnlyDelta, so `how`
  // can never be 'seed-only' for any other family).
  if (how === 'seed-only') return { ...last, seedOnlyCarried: true };
  return last;
}

// Pure: upsert a single machine marker into a handoff session entry. Strips any prior
// machine-marker line(s) (whole line incl. its newline; anchored so a prose `**Review:**` line
// without `@ <sha>` is never matched), appends the fresh one — idempotent, one marker, newest sha
// wins. The detail (when the family carries one) is sanitized: an '@' (e.g. "see @anchor") or a
// newline in it would make the written marker parse back null and wedge the land on an
// already-recorded decision.
// plan 2743: `patchId` (optional) writes the rebase-stable identity token after the sha. A value
// outside rangePatchId's vocabulary is DROPPED by normalizeMarkerPatchId rather than written — a
// marker must never carry a token its own parser reads back as null. Omitted / null ⇒ a sha-only
// marker, exactly the legacy line. The strip regex below needs no change: its trailing `.*`
// already swallows any token following the sha.
export function upsertMarker(family, content, verdict, sha, detail = '', patchId = null) {
  let tail = '';
  if (family.hasDetail) {
    const clean = String(detail || '')
      .replace(/[@\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    tail = clean ? `:${clean}` : '';
  }
  const pid = normalizeMarkerPatchId(patchId);
  const marker = `${family.label}: ${verdict}${tail} @ ${sha}${pid ? ` patch-id:${pid}` : ''}`;
  const cleaned = stripMarkerLines(family, content);
  const sep = cleaned === '' || cleaned.endsWith('\n') ? '' : '\n';
  return `${cleaned}${sep}${marker}\n`;
}

// Review family delegates (plan 337 contract: parseReviewMarker returns the bare verdict string;
// read via recordedReviewMarker() in the spine to auto-skip REVIEW_NEEDED — plan 2162 folded the
// verdict+provenance read into one lookup).
// plan 3295: the ONLY two delegates that expose the optional `seedOnlyDelta` 5th param — a review
// marker recorded at sha X is honored at tip Y when the X..Y delta is seed-data-only (operator
// ruling 2026-08-19). parseWikiMarker / parseConclusionMarker (done-worktree-lib.mjs) deliberately
// do NOT take this param, so the carry can never reach those families by accident.
export function parseReviewMarker(text, currentSha, headPatchId = null, seedOnlyDelta = null) {
  const m = parseMarkerCurrent(
    MARKER_FAMILIES.review,
    text,
    currentSha,
    headPatchId,
    seedOnlyDelta,
  );
  return m ? m.verdict : null;
}

export function parseReviewMarkerAny(text) {
  return parseMarkerAny(MARKER_FAMILIES.review, text);
}

// plan 2162: the staleness-GUARDED review marker as the full { verdict, detail, sha } object
// (detail = the provenance token) — for surfacing HOW the review ran at land time, where
// parseReviewMarker (bare verdict) is not enough. Null when stale/absent, same as
// parseReviewMarker.
export function parseReviewMarkerFull(text, currentSha, headPatchId = null, seedOnlyDelta = null) {
  return parseMarkerCurrent(MARKER_FAMILIES.review, text, currentSha, headPatchId, seedOnlyDelta);
}

// plan 1528 A1: the patch-id gate for a mechanical marker re-pin — pure over the two range
// patch-ids (each computed by land-lib.rangePatchId over merge-base(origin/master, tip)..tip).
// Identical + both computable ⇒ the branch's content-vs-master diff is byte-equivalent across the
// re-sha (a pure rebase / clean replay), so re-recording the review + wiki markers at the new tip
// is bookkeeping, not judgment. Any other state refuses: `rework: true` marks the one arm (both
// computable but DIFFERENT) that proves the branch content actually changed — Phase B's requeue
// trip reads that flag; the uncomputable arms (old tip GC'd / unresolvable) refuse WITHOUT the
// rework claim.
export function repinDecision({ markerSha, headSha, oldPatchId, newPatchId }) {
  if (!markerSha) return { repin: false, why: 'no marker recorded' };
  if (!headSha) return { repin: false, why: 'no HEAD sha' };
  if (sameCommitSha(markerSha, headSha))
    return { repin: false, why: 'marker already pins HEAD — nothing to re-pin' };
  if (!oldPatchId || !newPatchId)
    return {
      repin: false,
      why: 'patch-id uncomputable (recorded tip unresolvable in this checkout, or diff failed) — re-review instead',
    };
  if (oldPatchId !== newPatchId)
    return {
      repin: false,
      rework: true,
      why: 'patch-ids differ — the branch content changed since the marker (rework, not a pure rebase); re-review the delta',
    };
  return { repin: true };
}

// Pure: upsert the review marker (plan 337, written by scripts/record-review.mjs) — the
// review-family delegate of the generic upsertMarker above. plan 2162: `detail` carries the
// review provenance token (buildReviewProvenance) — sanitized + one-line by upsertMarker.
// Defaults to '' so every existing call site (and a provenance-undeclared record) still works.
export function upsertReviewMarker(content, verdict, sha, detail = '', patchId = null) {
  return upsertMarker(MARKER_FAMILIES.review, content, verdict, sha, detail, patchId);
}

// ── plan 2162: review PROVENANCE — HOW a recorded review ran ──────────────────────
// Method vocabulary (REVIEW_METHODS, above the family table): sonnet-review = the full
// /sonnet-review Workflow fan-out; code-review = the built-in Opus-xhigh fan-out; gpt-review = the
// codex-CLI Luna-finder/Sol-adjudicator fan-out (plan 2663, the local-session default); substitute
// = a hand-rolled agent pass (no angle fan-out, no per-location verifiers, no refute-
// adjudication); self-read = the no-new-logic self-read tier. The detail token is `<method> [f=N
// v=N adj=N]`.
// Pure: build the provenance detail string from a method + optional counts. Returns '' when no
// method is given (a provenance-undeclared record). Counts are emitted ONLY for a fan-out method
// (REVIEW_FANOUT_METHODS) and ONLY when they are non-negative INTEGERS — a null/''/float/negative
// count is DROPPED, never coerced to 0 (a coerced `adj=0` would falsely certify zero
// refute-adjudications). Because parseable `f=`/`v=`/`adj=` are digits-only, dropping a
// non-integer here keeps the written marker and any re-read in sync. The `:`/`@`/newline that
// would break the one-line marker grammar can't occur (method is from the fixed vocabulary,
// counts are integers), and upsertMarker sanitizes defensively anyway.
export function buildReviewProvenance({ method, finders, verifiers, adjudicated } = {}) {
  if (!method) return '';
  const parts = [String(method)];
  if (REVIEW_FANOUT_METHODS.includes(method)) {
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? n : null;
    };
    const f = num(finders);
    const v = num(verifiers);
    const a = num(adjudicated);
    if (f !== null) parts.push(`f=${f}`);
    if (v !== null) parts.push(`v=${v}`);
    if (a !== null) parts.push(`adj=${a}`);
  }
  return parts.join(' ');
}

// ── plan 1205: review-findings record (findings-as-data land gate) ─────────────────
// A code review that reports findings persists them as DATA (scripts/record-review.mjs
// --findings) so the land can require each to be DISPOSITIONED before merging — closing the
// "pre-existing, I'll skip it" escape (operator directive 2026-06-30). The record is sha-pinned
// exactly like the `Review:` marker; a stale record (sha != HEAD) is ignored, so a re-review
// re-collects findings against the new tip.

const VALID_DISPOSITION_TYPES = new Set(['plan', 'fixed', 'wontfix', 'deferred-by-tag']);

// Exported since plan 3623 round 2: review-fix-brief needs the SAME identity contract the land
// gate canonicalizes against, and was hand-rolling a second copy of it. Two copies of "what makes
// a finding well-formed" is exactly how a brief comes to omit a blocker findingsGate still halts
// on.
export function normalizeFindingIdentity(finding) {
  const file = typeof finding?.file === 'string' ? finding.file.trim() : '';
  const summary = typeof finding?.summary === 'string' ? finding.summary.trim() : '';
  if (!file || !summary) return null;
  const lineNum = finding?.line == null ? null : Number(finding.line);
  return { file, line: Number.isFinite(lineNum) ? lineNum : null, summary };
}

export function findingKey(file, line, summary) {
  const f = normalizeFindingIdentity({ file, line, summary });
  const s = `${f?.file || ''}:${f?.line == null ? '' : f.line}:${f?.summary || ''}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// A malformed entry's raw `file` is the only lead anyone has for repairing it, and it must
// survive as a single readable line: it is rendered into the FINDINGS_OPEN halt message and into
// the fix brief. Collapse whitespace (a newline would forge an extra bullet in either surface) and
// cap the length, so an arbitrary sidecar string can neither hide the real text nor restructure
// the output.
export function malformedFindingPathText(value) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\s -]+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// The ONE malformed-entry shape, shared by the reader (findingWithCanonicalKey) and the writer
// (buildFindingsRecord) so a malformed path cannot survive one and be erased by the other. It
// must be IDEMPOTENT, because findingsGate (done-worktree-lib.mjs) re-canonicalizes an
// ALREADY-parsed record — reading only `file` meant the second pass saw an entry carrying
// `malformedFile` instead, and dropped the path again, so the real sequence (parse, then gate)
// still halted with nothing to act on.
// `malformedFile` is the RAW trimmed path (what a filesystem lookup must use); `malformedNote`
// carries its DISPLAY form.
export function malformedFindingEntry(rawFinding, index) {
  const claimed =
    typeof rawFinding?.malformedFile === 'string'
      ? rawFinding.malformedFile
      : typeof rawFinding?.file === 'string'
        ? rawFinding.file
        : '';
  const malformedFile = claimed.trim();
  const shown = malformedFindingPathText(malformedFile);
  return {
    index,
    malformedFile,
    malformedNote: `expected non-empty file and summary${shown ? ` (file: ${shown})` : ''}`,
  };
}

// Exported (unlike its done-worktree-lib.mjs past) so findingsGate there — which stays behind
// because it emits a SEAM-coded halt — can still canonicalize each raw sidecar entry the same
// way parseFindingsRecord does, without a second hand-rolled copy of this shape.
export function findingWithCanonicalKey(rawFinding, index) {
  const identity = normalizeFindingIdentity(rawFinding);
  if (!identity) {
    // Keep the raw path: every sidecar read comes through HERE first, so dropping `file` on the
    // floor here would mean `{file:'scripts/<name>.mjs', summary:' '}` reaches the fix worker as a
    // synthetic '(malformed finding)' with nothing to inspect, land still blocked. The gate's own
    // halt message was equally pathless. One owner for the malformed shape now.
    const { malformedFile, malformedNote } = malformedFindingEntry(rawFinding, index);
    return {
      malformedIndex: index,
      malformedFile,
      malformedReason: `malformed finding entry at index ${index}: ${malformedNote}`,
    };
  }
  const key =
    typeof rawFinding.key === 'string' && rawFinding.key.trim()
      ? rawFinding.key
      : findingKey(identity.file, identity.line, identity.summary);
  return { ...rawFinding, ...identity, key };
}

// plan 2864: the ONE coercion for the `rounds` counter, shared by the builder (which stamps it)
// and the parser (which reads it back), so the writer and the reader can never disagree about
// what a legal value is. The counter's domain is the POSITIVE integers — round 1 is the initial
// review, and there is no round 0 or -2 — so a non-integer, a float, or a zero/negative from a
// corrupt or hand-edited sidecar all fall back to 1 rather than being trusted. Never throws: a bad
// value here must not wedge the FINDINGS_OPEN gate reader over an advisory field.
// isSafeInteger, not isInteger: past 2^53 a JS integer stops being incrementable — `n + 1 === n` —
// so a sidecar carrying 1e300 would be a counter frozen forever below the cap. Out of the safe
// range is corrupt input, not a very long review.
export function normalizeRounds(rounds) {
  return Number.isSafeInteger(rounds) && rounds >= 1 ? rounds : 1;
}

// Marks an identity whose duplicate prior entries disagree about their disposition. Such an
// identity carries NOTHING forward: the finding reopens and a human dispositions it explicitly,
// rather than this code guessing which conflicting decision was meant (plan 3545 round 9).
const CONFLICTING_DUPLICATE = Symbol('conflicting-duplicate-disposition');

// plan 2864: `rounds` is the content-distinct review-round counter
// (docs/coord/review.md § Stopping rule) — the caller (record-review.mjs's
// prepare()) computes it against the prior record's `rounds` and the crossSha/patch-id-rework
// decision; this builder just stamps whatever integer it's handed, defaulting to 1 (the
// first-record case, and every existing call site that predates this field). Not derived from
// `prior` here — building `withoutCarry` / `withCarry` twice per record must not double-count.
export function buildFindingsRecord(
  verdict,
  sha,
  findings,
  prior = null,
  { carryAcrossSha = false, patchId = null, slug = null, rounds = null } = {},
) {
  const priorFindings = Array.isArray(prior?.findings) ? prior.findings : [];
  const priorByKey =
    prior && (sameCommitSha(prior.sha, sha) || carryAcrossSha)
      ? (() => {
          const seenByIdentity = new Map();
          for (const f of priorFindings) {
            if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
            const id = normalizeFindingIdentity(f);
            if (!id) continue;
            const key = findingKey(id.file, id.line, id.summary);
            // Compare through the canonical validator, so an invalid value is never "a decision"
            // and two spellings of the same decision still count as agreeing.
            const decision = JSON.stringify(normalizeDisposition(f.disposition) ?? null);
            const prior = seenByIdentity.get(key);
            if (prior === undefined) seenByIdentity.set(key, decision);
            else if (prior !== decision) seenByIdentity.set(key, CONFLICTING_DUPLICATE);
          }
          return new Map(
            [...seenByIdentity]
              .filter(([, decision]) => decision !== CONFLICTING_DUPLICATE && decision !== 'null')
              .map(([key, decision]) => [key, JSON.parse(decision)]),
          );
        })()
      : null;
  const seen = new Set();
  const out = [];
  for (const [index, f] of (Array.isArray(findings) ? findings : []).entries()) {
    const identity = normalizeFindingIdentity(f);
    if (!identity) {
      const { malformedFile, malformedNote } = malformedFindingEntry(f, index);
      out.push({
        key: null,
        file: '',
        line: null,
        // Present only when the entry actually claimed a path, so a pathless placeholder keeps
        // exactly the shape it has always had.
        ...(malformedFile ? { malformedFile } : {}),
        summary: `Malformed finding entry at index ${index}: ${malformedNote}`,
        disposition: null,
      });
      continue;
    }
    const { file, line, summary } = identity;
    const key = findingKey(file, line, summary);
    if (seen.has(key)) continue;
    seen.add(key);
    // An OMITTED disposition field carries forward the prior; an explicit one (incl. null) wins.
    const explicit = f && typeof f === 'object' && 'disposition' in f;
    let disposition = normalizeDisposition(f?.disposition);
    if (disposition == null && !explicit && priorByKey?.has(key)) disposition = priorByKey.get(key);
    const tags = normalizeFindingTags(f);
    out.push({
      key,
      file,
      line,
      summary,
      verdict: f?.verdict || null,
      kind: f?.kind || null,
      ...tags,
      disposition,
    });
  }
  // plan 2743: the sidecar carries the SAME rebase-stable identity as the marker. Without it the
  // marker survives a pure rebase (its patch-id fallback) while the sidecar does not, and the land
  // halts at FINDINGS_OPEN demanding a fresh review for a NITS/BUGS-FOUND branch whose findings are
  // all dispositioned.
  const pid = normalizeMarkerPatchId(patchId);
  // plan 2838: the sidecar now names its OWNER. Before this it carried no branch/plan identity at
  // all, so a whole-file replace of another session's dispositioned findings was not merely
  // reachable through a mis-resolve — it was undetectable afterwards. With the slug stamped,
  // sidecarOwnerConflict can refuse the write independently of how the entry was resolved.
  // Forward-only, exactly like plan 2743's patchId: a legacy sidecar has no `slug` and is
  // therefore un-ownable (nothing to conflict with) until its next record stamps one.
  const owner = String(slug || '').trim();
  const base = { sha };
  if (pid) base.patchId = pid;
  if (owner) base.slug = owner;
  // plan 2864: always stamped (unlike patchId/slug, which are omitted when absent) — "first
  // record ⇒ rounds:1" is the documented contract, not an optional extra.
  base.rounds = normalizeRounds(rounds);
  return { ...base, verdict, findings: out };
}

function oneLine(value, fallback) {
  const text = String(value || '')
    .trim()
    .replace(/\s*[\r\n]+\s*/g, ' ');
  return text || fallback;
}

export function normalizeFindingTags(finding) {
  const preExisting = typeof finding?.preExisting === 'boolean' ? finding.preExisting : false;
  const blocksLand = typeof finding?.blocksLand === 'boolean' ? finding.blocksLand : true;
  return {
    preExisting,
    preExistingWhy: oneLine(
      finding?.preExistingWhy,
      'untagged finding; safe legacy default is preExisting=false',
    ),
    blocksLand,
    blocksLandWhy: oneLine(
      finding?.blocksLandWhy,
      'untagged finding; safe legacy default is blocksLand=true',
    ),
  };
}

export function isMustFixFinding(finding) {
  const verdict = finding?.verdict;
  // plan 3623 item 2: ONE partition, not two — a REFUTED/PLAUSIBLE judgment is itself the "this
  // is advisory" signal (settled, regardless of tags). Collapsing the old two-list shape means a
  // verdict added to ONE list can no longer silently miss the other and reach the tag branch
  // unadvisedly.
  const advisoryVerdict = verdict === 'PLAUSIBLE' || verdict === 'REFUTED';
  if (advisoryVerdict) return false;
  // Any other verdict (absent, unknown, or UNVERIFIED) fails closed: the tag axis fails closed
  // too, not just the verdict axis. An UNVERIFIED verdict means the machinery never established
  // this finding is advisory — and its tags are not trustworthy either, because the path
  // Luna-REFUTED (advisory tags) -> Sol-failed -> classifyRound2 UNVERIFIED leaves those tags in
  // place with no adjudicator ever having confirmed them. Only the verifier schema's settled
  // outcomes (CONFIRMED) reach the tag axis at all.
  if (verdict !== 'CONFIRMED') return true;
  // verdict === 'CONFIRMED': only its own tags can clear this axis.
  const { preExisting, blocksLand } = normalizeFindingTags(finding);
  return blocksLand && !preExisting;
}

export function deferredByTagDisposition(finding) {
  const tags = normalizeFindingTags(finding);
  let reason =
    `preExisting=${tags.preExisting}: ${tags.preExistingWhy}; ` +
    `blocksLand=${tags.blocksLand}: ${tags.blocksLandWhy}`;
  if (tags.preExisting && finding?.verdict === 'CONFIRMED' && finding?.kind === 'correctness')
    reason +=
      '. Pre-existing correctness defects still require infra-debt or --plan --observed routing.';
  return {
    type: 'deferred-by-tag',
    preExisting: tags.preExisting,
    blocksLand: tags.blocksLand,
    reason,
  };
}

// plan 2838, defence in depth: may `slug` write this sidecar? A whole-file replace of someone
// else's dispositioned findings should not be reachable AT ALL — not even when the resolver is
// right and the operator simply passed the wrong --slug. Returns null when the write is allowed,
// or the refusal message naming both owners. An UNOWNED (legacy, pre-2838) record allows the
// write: its owner is genuinely unknown, and failing closed there would wedge every branch whose
// sidecar predates this plan. Pure.
//
// `sidecarOwnedBy` is the same predicate as a boolean — the land-side reader
// (done-worktree.recordedFindings) needs a silent fail-closed FILTER rather than an
// operator-facing message, and the two must not drift.
export function sidecarOwnedBy(record, slug) {
  const owner = String(record?.slug || '').trim();
  return !owner || owner === String(slug || '').trim();
}

export function sidecarOwnerConflict(prior, slug, sidecarRel) {
  const owner = String(prior?.slug || '').trim();
  const mine = String(slug || '').trim();
  if (!owner || !mine || owner === mine) return null;
  return (
    `REFUSED — ${sidecarRel} already holds the review record for a DIFFERENT plan:\n` +
    `  sidecar owner: ${owner}\n` +
    `  recording as:  ${mine}\n` +
    `Writing it would REPLACE that session's findings and their dispositions wholesale ` +
    `(plan 2838's observed incident). Nothing was written. If the session entry this resolved ` +
    `to is the wrong one, add a \`**Branch:** \\\`worktree-${mine}\\\`\` line to your own entry; ` +
    `if the sidecar's owner is genuinely stale, remove it deliberately first.`
  );
}

// Pure: how the land gate views ONE finding — 'ok' (dispositioned, plan exists) | 'open'
// (undispositioned or malformed — e.g. wontfix w/o reason) | 'dangling' (a 'plan' disposition
// naming a plan that does not exist). The ONE classifier findingsGate (done-worktree-lib.mjs) and
// record-review's "still open" count share, so the disposition-time and land-time views can never
// drift. planExists defaults to fail-closed.
export function classifyFinding(finding, planExists = () => false) {
  const d = normalizeDisposition(finding?.disposition);
  if (!d) return 'open';
  if (d.type === 'deferred-by-tag' && isMustFixFinding(finding)) return 'open';
  if (d.type === 'plan' && !planExists(d.planId)) return 'dangling';
  return 'ok';
}

// Pure: would this ONE finding, on its own, block a land? The single predicate shared by
// findingsGate (done-worktree-lib.mjs) and record-review's "still open" count.
// `finding` may be a raw sidecar entry (parseFindingsRecord already runs every finding through
// findingWithCanonicalKey, so a malformed entry reaches here carrying `malformedIndex`).
//   malformed        -> always blocks (it cannot be dispositioned at all).
//   classifyFinding 'ok'       -> never blocks.
//   classifyFinding 'dangling' -> blocks at ANY severity (plan 3623 item 4): a disposition naming
//                                  a plan that does not exist is a referential-integrity break, not
//                                  a severity question — routing-to-a-plan is exactly how an
//                                  advisory finding is supposed to be PRESERVED rather than dropped.
//   classifyFinding 'open'     -> blocks only when the finding is must-fix; an undispositioned
//                                  ADVISORY finding is precisely the case plan 3545 charters as
//                                  non-blocking.
// Exported (unlike its done-worktree-lib.mjs past) so findingsGate there — which classifies a
// finding ONCE via this same step rather than twice — can still reuse it.
export function classifyAndBlocks(finding, planExists) {
  if (finding && typeof finding === 'object' && 'malformedIndex' in finding)
    return { cls: null, blocks: true };
  const cls = classifyFinding(finding, planExists);
  if (cls === 'ok') return { cls, blocks: false };
  if (cls === 'dangling') return { cls, blocks: true };
  return { cls, blocks: isMustFixFinding(finding) };
}

export function findingBlocksLand(finding, planExists = () => false) {
  return classifyAndBlocks(finding, planExists).blocks;
}

// Coerce a disposition to the canonical shape or null. Accepts {type:'plan',planId},
// {type:'fixed'}, {type:'wontfix',reason}, {type:'deferred-by-tag',...}. Anything else → null.
export function normalizeDisposition(d) {
  if (!d || typeof d !== 'object' || !VALID_DISPOSITION_TYPES.has(d.type)) return null;
  if (d.type === 'plan') {
    const planId = String(d.planId || '').trim();
    if (!planId) return null;
    // plan 2942: an optional OBSERVED-evidence pointer rides INSIDE the disposition object, never
    // as a sibling field on the finding — buildFindingsRecord rebuilds each finding with a fixed
    // field set and would silently drop a sibling. `planId` stays a BARE id so planExistsAdvisory
    // / findingsGate keep matching it as a plan-tree filename prefix; the pointer is deliberately
    // advisory only — nothing gates on it.
    // The type guard belongs HERE, in the shared normalizer, not only in the batch parser — this
    // is the seam every reader passes through (the CLI, the carry-forward, classifyFinding, a
    // hand-edited or corrupt sidecar). `String(d.observed)` turned `123` into the truthy pointer
    // `"123"` and `{}` into `"[object Object]"`, either of which SUPPRESSES the evidence-floor
    // warning. A non-string is DROPPED rather than thrown on: normalize is used by the land gate,
    // so it must degrade to "no pointer" (which warns) instead of refusing a land.
    const observed = typeof d.observed === 'string' ? d.observed.trim() : '';
    return observed ? { type: 'plan', planId, observed } : { type: 'plan', planId };
  }
  if (d.type === 'wontfix') {
    const reason = String(d.reason || '').trim();
    return reason ? { type: 'wontfix', reason } : null; // reason is mandatory
  }
  if (d.type === 'deferred-by-tag') {
    const reason = oneLine(d.reason, '');
    if (!reason || typeof d.preExisting !== 'boolean' || typeof d.blocksLand !== 'boolean')
      return null;
    return {
      type: 'deferred-by-tag',
      preExisting: d.preExisting,
      blocksLand: d.blocksLand,
      reason,
    };
  }
  return { type: 'fixed' };
}

// Parse + shallow-validate a findings-record sidecar's JSON. Returns the record, or null when
// unparseable / shape-invalid. Callers gate only when a record EXISTS, so a corrupt record reads
// as "absent" (fail-open against a wedge) — but record-review writes it, so in practice it is
// always well-formed; the null path is the defensive floor.
export function parseFindingsRecord(text) {
  if (!text) return null;
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || !Array.isArray(r.findings)) return null;
  // plan 2864: `rounds` normalized HERE (not left to callers) so every reader of a parsed record —
  // record-review's re-record seam, the disposition subcommand, the FINDINGS_OPEN gate — sees the
  // same value without re-deriving it. Absent (a legacy sidecar that predates this field),
  // non-integer, or outside the counter's positive domain (corrupt/hand-edited) all fall back to
  // 1 via the shared normalizeRounds, same tolerance as the rest of this parse's fields — never a
  // throw; this parse is CLOSED on shape (findings must be an array) but OPEN on this one
  // advisory field.
  return {
    ...r,
    rounds: normalizeRounds(r.rounds),
    findings: r.findings.map(findingWithCanonicalKey),
  };
}

// Apply a disposition to one finding by key. Returns { record, found }. Pure (clones).
// disposition is normalized; pass null to re-open. `found:false` ⇒ no finding had that key.
export function dispositionFinding(record, key, disposition) {
  let found = false;
  const norm = disposition == null ? null : normalizeDisposition(disposition);
  const findings = (record?.findings || []).map((f) => {
    if (f.key !== key) return f;
    found = true;
    return { ...f, disposition: norm };
  });
  return { record: { ...record, findings }, found };
}

// The findings sidecar lives beside the session entry — same dir, `.findings.json` in place of
// `.md`. ONE convention shared by the writer (record-review.mjs) and the reader (done-worktree.mjs
// recordedFindings) so they can never drift.
export function findingsSidecarPath(sessionFile) {
  return String(sessionFile).replace(/\.md$/i, '.findings.json');
}

// Pure: does a `git ls-tree -r --name-only … docs/superpowers/plans/` listing contain a plan file
// whose basename starts with `<id>-`? The ONE plan-existence matcher shared by record-review.mjs's
// advisory probe and done-worktree.mjs's authoritative land check, so the disposition-time and
// land-time checks can never disagree.
export function planIdInTree(lsTreeOutput, id) {
  const idStr = String(id || '')
    .trim()
    .toLowerCase();
  if (!idStr) return false;
  return String(lsTreeOutput || '')
    .split('\n')
    .some(
      (p) =>
        p.trim() &&
        p
          .split('/')
          .pop()
          .toLowerCase()
          .startsWith(idStr + '-'),
    );
}
