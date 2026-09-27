// scripts/coord/batch-paths.mjs (plan 1467) — single source of truth for the
// batch-FOLDER ABI: where a batch's files live, and the `batch.md` frontmatter
// contract.
//
// Batches became first-class FOLDERS under docs/superpowers/batches/<slug>/
// (plan 1467): a browsable folder per batch across its whole lifecycle, holding
//   • batch.md      — the roster entry (slug, lane, members, gate, status, theme)
//   • manifest.json — the claim manifest (written by claim-plan.mjs batch AT
//                     CLAIM; was docs/handoff/batches/<slug>.json before 1467)
//
// The claim manifest MOVED from the legacy docs/handoff/batches/<slug>.json into
// the folder. Every consumer (claim-plan, done-worktree, landing-queue,
// batches-view) resolves through THESE helpers so the new-path-first /
// legacy-fallback policy — and the batch.md frontmatter grammar — live in
// exactly ONE place, never four drifting copies (plan 1467 review contract).
//
// Grandfather rule (plan 1467): the two in-flight batches that were claimed
// BEFORE this migration keep their manifest at the legacy path until they land;
// resolveManifestRel reads new-first, legacy-second so both resolve cleanly, and
// a later sweep deletes the empty legacy dir once every old-path manifest lands.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// plan 4246 review fix: the ONE filename -> plan-id parser coord already shares (leading digits,
// minus the dateless `<YYYY>-MM-DD-` legacy shape), instead of a local regex that dropped
// date-slugged archive names like `029-2026-05-21-….md`.
import { claimedIdOfBasename } from './build-index-lib.mjs';
// plan 4246 review fix (b35525): the ONE `git cat-file --batch` maxBuffer coord agrees on.
import { GIT_MAXBUFFER } from './coord-git.mjs';

export const BATCHES_DIR_REL = 'docs/superpowers/batches';
export const LEGACY_BATCH_MANIFEST_DIR_REL = 'docs/handoff/batches';

// Subdirectories of BATCHES_DIR_REL that are NOT batch-slug folders and must be excluded when
// enumerating batches (the roster view AND claim-plan's candidateBatchSlugs). `archive/` holds
// landed batches (moved here on close-out, see batchArchiveDirRel); its per-slug children are
// lifecycle history, never live batches. Single source of truth so every enumerator agrees.
export const RESERVED_BATCH_DIRS = new Set(['archive']);

export const batchDirRel = (slug) => `${BATCHES_DIR_REL}/${slug}`;
export const batchMdRel = (slug) => `${BATCHES_DIR_REL}/${slug}/batch.md`;
export const newManifestRel = (slug) => `${BATCHES_DIR_REL}/${slug}/manifest.json`;
export const legacyManifestRel = (slug) => `${LEGACY_BATCH_MANIFEST_DIR_REL}/${slug}.json`;

// Where a batch FOLDER lands on close-out (plan 1467 archive-on-land contract): the whole
// docs/superpowers/batches/<slug>/ folder git-moves into docs/superpowers/batches/archive/<slug>/.
export const BATCHES_ARCHIVE_DIR_REL = `${BATCHES_DIR_REL}/archive`;
export const batchArchiveDirRel = (slug) => `${BATCHES_ARCHIVE_DIR_REL}/${slug}`;

// New-path-first, legacy-second. Returns { rel, legacy } for whichever manifest
// EXISTS on disk under `mainDir`, or { rel: null, legacy: false } when neither
// does (never claimed, or already landed — the caller's ground-truth check
// decides which). Repo-relative `rel` so callers can `git rm` / read it directly.
export function resolveManifestRel(mainDir, slug) {
  const primary = newManifestRel(slug);
  if (existsSync(join(mainDir, primary))) return { rel: primary, legacy: false };
  const legacy = legacyManifestRel(slug);
  if (existsSync(join(mainDir, legacy))) return { rel: legacy, legacy: true };
  return { rel: null, legacy: false };
}

// Existence-only convenience (landing-queue's pruneLandedBatches ground truth):
// true iff a manifest exists at EITHER path — a batch is "still live" while
// either survives, "landed" only once BOTH are gone.
export const manifestExists = (mainDir, slug) => resolveManifestRel(mainDir, slug).rel !== null;

// plan 1364 Ship 3 / plan 1467, relocated here from done-worktree-lib.mjs by plan 3962
// Decision 5: parse a batch manifest (docs/superpowers/batches/<slug>/manifest.json since
// 1467; legacy docs/handoff/batches/<slug>.json for grandfathered in-flight batches — the
// reader resolves the path, this stays fs-free), written by claim-plan.mjs batch's
// projectBatchClaim — see the plan-1364 Ship 1 diff. Mirrors parseLandPrepMarker's
// shape-validating contract: returns the object ONLY when it carries a non-empty `members`
// array (stringified — a numeric-looking id round-trips identically to what
// resolvePlanRelById expects); anything else (garbage / absent / empty members) is null.
// The caller (done-worktree.mjs readBatchManifest) treats null as "no manifest" and falls
// through to its own ground-truth check (is the branch already landed?) rather than
// trusting a corrupt manifest as real. Pure — no fs; the file read lives in the IO shell.
export function parseBatchManifest(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.members) || obj.members.length === 0) return null;
  return { ...obj, members: obj.members.map(String) };
}

// Ref-scoped twin of resolveManifestRel (plan 1523): the SAME new-path-first /
// legacy-second order, reading through a caller-supplied `readAtRef(rel)` (typically
// `(rel) => git(root, ['show', `${ref}:${rel}`])`, which throws when the path is absent
// at that ref) instead of existsSync — the reader is injected so this module stays free
// of the git helper and each caller picks its own ref (HEAD, origin/master, an arbitrary
// sha). This is THE shared resolution algorithm for every ref-based manifest read
// (assert-pipeline-field-specreview's Gate 1, landing-queue's batch-liveness check) —
// never re-roll the candidate loop in a consumer, or the precedence policy forks from
// the disk resolver's. Precedence matches resolveManifestRel exactly: the first
// READABLE path wins regardless of content validity (content errors are the caller's
// to judge). Returns { rel, raw, legacy } on the first successful read, or
// { rel: null, raw: null, legacy: false } when neither candidate reads; `misses`
// carries each failed candidate as { rel, error } for the caller's diagnostics.
export function resolveManifestAtRef(slug, readAtRef) {
  // Expressed over the TRI-STATE resolver below rather than re-rolling the candidate loop
  // (this module's own "never re-roll the candidate loop" rule applies to itself first).
  // The adapter collapses every throw to `absent`, which is exactly this function's legacy
  // — and defective, see resolveManifestAtRefTri's header — contract.
  const tri = resolveManifestAtRefTri(slug, (rel) => {
    try {
      return { state: 'present', raw: readAtRef(rel) };
    } catch (error) {
      return { state: 'absent', error };
    }
  });
  return { rel: tri.rel, raw: tri.raw, legacy: tri.legacy, misses: tri.misses };
}

// TRI-STATE twin of resolveManifestAtRef (plan 3459). Same candidate order, same
// first-hit-wins precedence — but it can say "could not read" instead of folding that into
// "not there", which is the whole point.
//
// The defect it closes: `git show <ref>:<path>` exits non-zero BOTH when the path is absent
// at that commit AND when the read itself faulted (no such ref, an unreadable tree object,
// a torn object store). resolveManifestAtRef catches every throw as a miss, returns
// `{rel: null}`, and landing-queue's caller degrades that to `[]` members — which downstream
// reads as "the batch landed". That is the one direction that PRUNES A LIVE ENTRY, or lets a
// steal past the 🟢 LANDING gate of a batch that is actively mid-land.
//
// `probe(rel)` returns one of:
//   { state: 'present', raw }        — the path is there at this snapshot; `raw` is its content
//   { state: 'absent'[, error] }     — the path is genuinely NOT there at this snapshot (DATA)
//   { state: 'fault', error }        — the read could not be performed (a REFUSAL for the caller)
// The caller owns the primitive that can tell those apart — `git ls-tree` separates absent
// (exit 0, empty stdout) from fault (non-zero exit), where `git show` cannot.
//
// A FAULT SHORT-CIRCUITS: if the NEW path could not be read we must not go on to conclude
// "absent" from the legacy path either, because a fault at the first candidate leaves the
// batch's liveness genuinely unknown. Returns `{ fault: { rel, error } }` and stops.
export function resolveManifestAtRefTri(slug, probe) {
  const misses = [];
  for (const rel of [newManifestRel(slug), legacyManifestRel(slug)]) {
    const r = probe(rel);
    if (r.state === 'present') {
      return { rel, raw: r.raw, legacy: rel !== newManifestRel(slug), misses, fault: null };
    }
    if (r.state === 'fault') {
      return { rel: null, raw: null, legacy: false, misses, fault: { rel, error: r.error } };
    }
    misses.push({ rel, error: r.error });
  }
  return { rel: null, raw: null, legacy: false, misses, fault: null };
}

// ── batch.md frontmatter contract (plan 1467) ──────────────────────────────
//   ---
//   slug: batch-deeplink-repair
//   lane: 🟥                       # 🟥 (any member seed-writes) | 🟩
//   members: [1444, 1453]          # inline array of plan ids
//   gate: null                     # null (runnable now) | free-text blocker
//   status: proposed               # proposed | claimed | landed
//   ---
//
//   # <slug>
//
//   <theme prose + banner reasons…>
//
// The parser is deliberately forgiving (a malformed roster entry must never
// crash the /batches view): missing keys degrade to sane defaults, unknown
// frontmatter lines are ignored.

const stripWrap = (s) =>
  String(s ?? '')
    .trim()
    .replace(/^["'`]|["'`]$/g, '');

// Inline `[1444, 1453]` → ['1444','1453']. Tolerates surrounding backticks and
// stray model glyphs (a legacy roster cell carried `1467 🟢`); keeps the leading
// id token only.
export function parseMembersValue(raw) {
  if (raw == null) return [];
  return String(raw)
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => (s.trim().match(/\d{2,}/) || [])[0])
    .filter(Boolean);
}

export function parseBatchMd(content) {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content || '');
  const meta = {};
  let body = content || '';
  if (fm) {
    body = (content || '').slice(fm[0].length);
    for (const line of fm[1].split('\n')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) meta[m[1]] = m[2].trim();
    }
  }
  const gateRaw = meta.gate;
  const gate = gateRaw == null || gateRaw === '' || gateRaw === 'null' ? null : stripWrap(gateRaw);
  const theme = body
    .replace(/^\s*#[^\n]*\n?/, '') // drop leading blank lines + the H1
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
  return {
    slug: stripWrap(meta.slug),
    lane: stripWrap(meta.lane),
    members: parseMembersValue(meta.members),
    gate,
    status: stripWrap(meta.status) || 'proposed',
    theme,
  };
}

export function renderBatchMd({
  slug,
  lane,
  members,
  gate = null,
  status = 'proposed',
  theme = '',
}) {
  return (
    [
      '---',
      `slug: ${slug}`,
      `lane: ${lane}`,
      `members: [${members.map(String).join(', ')}]`,
      `gate: ${gate == null || gate === '' ? 'null' : gate}`,
      `status: ${status}`,
      '---',
      '',
      `# ${slug}`,
      '',
      String(theme || '').trim(),
    ].join('\n') + '\n'
  );
}

// ── runnable-batch membership (plan 2459 Task 2) ────────────────────────────
// Guard runnable-batch members against a SOLO claim (leak B: ~7 recorded "landed/claimed
// solo before any train ran" dissolutions, docs/superpowers/batches/README.md). Both
// single-plan claim paths — queue-drain.mjs's oracle and claim-plan.mjs's `acquire` —
// need the SAME question answered: "is this plan id a member of a batch that is
// runnable RIGHT NOW?" This is the one shared member-lookup helper both consume, so the
// "runnable" definition (status: proposed AND gate: null/absent) lives in exactly one
// place.
//
// A `gate:` non-null batch is DELIBERATELY excluded from the returned map — its members
// stay individually claimable so a gate can never freeze them (plan 2459 Task 2, item 5).
//
// Archived members are FINISHED CARS, not missing ones (plan 4246 — this replaces the old
// plan-2459 item-6 "stale-roster safety" note). Every reader below takes an optional
// `archivedIds` (a Set of plan ids, or a thunk returning one — see readArchivedPlanIds) and
// splits each runnable batch's `members:` into LIVE ids and ids whose plan file already sits
// in the plans archive lane (shipped OR closed — either way it is never claimed again). Then:
//   • no member archived     → unchanged: the batch holds every listed member.
//   • ≥2 live members left    → the batch stays runnable with EXACTLY the live members; the
//                               archived ids are dropped from the train and from the hold map.
//   • ≤1 live member left     → the batch is DISSOLVED: it holds nothing, so its survivor is
//                               solo-claimable in queue-drain AND at claim-plan's solo gate.
// A member that is NOT archived but merely out of ready/ (waiting-*, in-progress,
// pending-approval) is still a live member: the all-or-nothing train rule keeps withholding
// the whole batch for it. Only the archive lane counts as "finished".
//
// Why the rule lives here: the old note argued a stale archived id was harmless because an
// archived plan is never presented for claiming again. True for that id, but it missed the
// other direction — the archived member made the WHOLE train untakeable (queue-drain's
// `not-in-ready-pool` blocker) while the batch still held its surviving members from solo
// claims: a deadlock only a hand edit of batch.md could clear (batch-2026-09-26-profile-ui /
// batch-2026-09-26-scripts-checks). One definition (batchLiveness) now drives the bulk oracle
// and the single-plan claim gate alike, so the two can never disagree about a hold. Called
// WITHOUT `archivedIds`, every reader reports batch.md's frontmatter as written, exactly as
// before (fixture callers). Iterating "what does the roster still expect" for cleanup remains
// the board-pass reconcile's job (plan 2459 Task 3), not this guard's.
// Canonical plan-id key for the held-map (plan 2459 review, finding `queue-drain.mjs:508`).
// Plan ids appear in TWO spellings that must compare equal: a roster's `members:` list and a
// plan FILENAME keep legacy sub-100 ids zero-padded (`007-P07-…md`), while `queue-drain.mjs`'s
// parsePlanMeta carries the id as a NUMBER (`Number(idM[1])` → 7) and re-strings it at lookup.
// Keying the map on the raw token made `has('7')` miss the key `'007'`, so a legacy member of a
// runnable batch was silently NOT excluded — the guard failing open on exactly the leak-B class
// it exists to close. Canonicalizing at the ONE place the map is built (and at the one place it
// is read) makes both spellings agree. A non-numeric id is left verbatim rather than becoming
// NaN, so a malformed roster entry can still only ever fail to match — never match the wrong id.
export function canonicalPlanId(id) {
  const s = String(id).trim();
  return /^\d+$/.test(s) ? String(Number(s)) : s;
}

// The ONE batches-folder walk (plan 2518 item 5). Before this extraction the readdir +
// RESERVED_BATCH_DIRS skip + read + parseBatchMd sequence existed TWICE — here (for the
// runnable-member map) and in batches-view.mjs's loadBatchFolders (for the roster view) —
// so a change to the folder ABI had to be made in two places or silently drift.
//
// A GENERATOR on purpose: the runnable-member map consumes the whole walk, while the
// single-id lookup below (plan 2518 item 4) breaks out at its first hit, so the walk must
// be able to stop early instead of always materializing every folder.
//
// Iteration is SORTED by folder name — deterministic, independent of the platform's
// readdir order. This is a deliberate (tiny) behaviour change for readRunnableBatchMembers,
// whose "first-match wins on a data-error double listing" tiebreak previously depended on
// raw fs order; batches-view.mjs already sorted. The tiebreak only fires on malformed data
// (one plan id listed by two runnable batches) and now resolves the same way everywhere.
//
// `onSkip(name, why)` lets a caller REPORT a dropped folder (batches-view warns) while the
// default stays silent (the guard path must never print during a queue-drain tick).
//
// `at` (plan 4246 review fix b35525) switches the SOURCE from local disk to a git COMMIT:
// `{ repoRoot, ref, batchesRel = BATCHES_DIR_REL, _exec, onFault }` (or a thunk returning one,
// resolved when the walk starts — queue-drain only learns its origin sha after building the
// roster). The folder list comes from one `git ls-tree` at `ref` and every batch.md from one
// `git cat-file --batch`, so a caller judging against origin (queue-drain's origin read of
// ready/, claim-plan's resolvePlanAtOrigin sha) reads the roster from the SAME snapshot as
// everything else instead of mixing it with a possibly-stale local checkout. A null `ref` walks
// nothing. A git fault calls `onFault(error)` and walks nothing when the caller supplied one,
// and is rethrown otherwise (claim-plan's gate refuses rather than guessing).
export function* walkBatchFolders(batchesDir, { onSkip, at } = {}) {
  const src = typeof at === 'function' ? at() : at;
  if (src) {
    yield* walkBatchFoldersAtRef(src, onSkip);
    return;
  }
  let entries;
  try {
    entries = readdirSync(batchesDir, { withFileTypes: true });
  } catch {
    return; // no batches dir at all — nothing to walk
  }
  const names = entries
    .filter((e) => e.isDirectory() && !RESERVED_BATCH_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    let content;
    try {
      content = readFileSync(join(batchesDir, name, 'batch.md'), 'utf8');
    } catch {
      onSkip?.(name, 'no readable batch.md'); // a stray dir — skip, never crash
      continue;
    }
    const batch = parseBatchMd(content);
    // `b.slug || name`: the folder name is the fallback identity when batch.md omits slug.
    yield { name, batch, slug: batch.slug || name };
  }
}

// The git-commit half of walkBatchFolders: same sorted order, same reserved-dir skip, same
// `onSkip` for a folder with no (readable) batch.md, same yielded shape.
function* walkBatchFoldersAtRef(
  { repoRoot, ref, batchesRel = BATCHES_DIR_REL, _exec = execFileSync, onFault },
  onSkip,
) {
  if (!ref) return;
  const prefix = `${batchesRel.replace(/\/+$/, '')}/`;
  let blobs;
  try {
    blobs = lsTreeBlobs(repoRoot, ref, prefix, { _exec });
  } catch (e) {
    if (!onFault) throw e;
    onFault(e);
    return;
  }
  const folders = new Map(); // folder name -> batch.md blob sha (null when absent)
  for (const { sha, path } of blobs) {
    if (!path.startsWith(prefix)) continue;
    const segs = path.slice(prefix.length).split('/');
    if (segs.length < 2 || RESERVED_BATCH_DIRS.has(segs[0])) continue; // top-level files, archive/
    if (!folders.has(segs[0])) folders.set(segs[0], null);
    if (segs.length === 2 && segs[1] === 'batch.md') folders.set(segs[0], sha);
  }
  const names = [...folders.keys()].sort();
  const withMd = names.filter((n) => folders.get(n));
  let contents;
  try {
    contents = readBlobsBatched(
      repoRoot,
      withMd.map((n) => folders.get(n)),
      { _exec },
    );
  } catch (e) {
    if (!onFault) throw e;
    onFault(e);
    return;
  }
  const byName = new Map(withMd.map((n, i) => [n, contents[i]]));
  for (const name of names) {
    const content = byName.get(name);
    if (typeof content !== 'string') {
      onSkip?.(name, 'no readable batch.md');
      continue;
    }
    const batch = parseBatchMd(content);
    yield { name, batch, slug: batch.slug || name };
  }
}

// `git ls-tree -r <ref> -- <relDir>` → `[{ sha, path }]` for every blob under `relDir` at that
// COMMIT (plan 4246 review fix: shared by queue-drain's ready/ listing, the archive listing and
// the batch roster, so all three read one snapshot the same way). A path absent at the ref exits
// 0 with empty output (data); a git fault throws through `_exec`. Each line is
// `<mode> <type> <sha>\t<path>`, split on the FIRST tab.
export function lsTreeBlobs(repoRoot, ref, relDir, { _exec = execFileSync } = {}) {
  if (!repoRoot) throw new Error('lsTreeBlobs: no repoRoot available');
  if (!ref) throw new Error('lsTreeBlobs: no ref (commit sha) available');
  const out = _exec('git', ['-C', repoRoot, 'ls-tree', '-r', ref, '--', relDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: GIT_MAXBUFFER,
  });
  const entries = [];
  for (const line of String(out).split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const parts = line.slice(0, tab).trim().split(/\s+/);
    if (parts[1] !== 'blob' || !parts[2]) continue;
    entries.push({ sha: parts[2], path: line.slice(tab + 1) });
  }
  return entries;
}

// plan 3816 fix round (review Fix 1), MOVED here from queue-drain.mjs by plan 4246's review fix so
// the batch roster read (walkBatchFoldersAtRef above) shares it — queue-drain imports and
// re-exports it unchanged. ONE `git cat-file --batch` call for a whole SET of blob shas.
// `encoding: null` — NOT the string `'buffer'`, which throws `Unknown encoding: buffer` when
// `input` is also a string, because Node encodes `input` with this same value — is what makes
// `out` a raw Buffer, so this can slice by the BYTE size cat-file's header reports rather than a
// pre-decoded utf8 string (a multi-byte character straddling a size boundary would corrupt every
// later offset).
//
// Returns contents aligned index-for-index with `shas`; a missing or malformed blob resolves to
// `null` at its own index rather than throwing, so one vanished/truncated blob cannot take down
// the whole read — once the stream stops being parseable, every remaining index degrades to
// `null` too, since a malformed header means the position of the NEXT object is no longer known.
export function readBlobsBatched(repoRoot, shas, { _exec = execFileSync } = {}) {
  if (!repoRoot) throw new Error('readBlobsBatched: no repoRoot available');
  if (shas.length === 0) return [];
  const input = shas.join('\n') + '\n';
  const out = _exec('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input,
    encoding: null,
    maxBuffer: GIT_MAXBUFFER,
    timeout: 15000,
  });
  const contents = [];
  let offset = 0;
  let unrecoverable = false;
  for (let i = 0; i < shas.length; i++) {
    if (unrecoverable) {
      contents.push(null);
      continue;
    }
    const nl = out.indexOf(0x0a, offset);
    if (nl === -1) {
      unrecoverable = true;
      contents.push(null);
      continue;
    }
    const header = out.slice(offset, nl).toString('utf8').trim();
    offset = nl + 1;
    const parts = header.split(/\s+/);
    const size = parts.length >= 3 ? parseInt(parts[2], 10) : NaN;
    if (parts[1] === 'missing') {
      contents.push(null); // a vanished blob — no body follows, offset stays correct
      continue;
    }
    if (!Number.isFinite(size) || offset + size > out.length) {
      unrecoverable = true;
      contents.push(null);
      continue;
    }
    contents.push(out.slice(offset, offset + size).toString('utf8'));
    offset += size + 1; // the trailing newline cat-file --batch appends after each object
  }
  return contents;
}

// A batch GUARDS its members only while it is runnable: still open for the taking
// (`status: proposed`) and not withheld behind an unmet trip (`gate: null`). Single
// predicate so the map build and the single-id lookup can never disagree about it.
export function isRunnableBatch(batch) {
  return batch.status === 'proposed' && batch.gate === null;
}

// The canonical plan id a plan FILENAME claims, or null (not a `.md`, or no id). Uses the shared
// claimedIdOfBasename, so `4187-UI-….md`, legacy `007-P07-….md` and a date-slugged archive name
// `029-2026-05-21-….md` all parse, while a dateless `2026-05-17-notes.md` does not. Exported so
// queue-drain's two Blocked-by archive readers parse archive names exactly this way too.
export function planIdOfFilename(name) {
  if (!String(name).endsWith('.md')) return null;
  const raw = claimedIdOfBasename(name);
  return raw ? canonicalPlanId(raw) : null;
}

// The CHEAP archive listing the batch-liveness check needs (plan 4246): plan ids by FILENAME
// only — never a file content read. The archive lane is 1000s of files; queue-drain's
// content-reading readArchivedIds answers a different question (shipped vs closed) that
// liveness does not ask, and only runs when a Blocked-by line needs it. The lane is
// lint-enforced flat, but a one-level category subfolder is tolerated the way the shared plan
// walker tolerates it. Returns a Set of canonicalPlanId keys.
//
// ONE helper, two SOURCES (plan 4246 review fix) — the caller picks the source that matches
// where it read everything else:
//   { repoRoot, ref, archiveRel }  — names at a git COMMIT (lsTreeBlobs, names only), for a
//                                    caller that judges against origin (queue-drain's origin
//                                    read of ready/, claim-plan's resolvePlanAtOrigin sha), so a
//                                    member archived on origin but not yet pulled locally counts.
//                                    `archiveRel` is repo-relative (plan 3960's ARCHIVE_FOLDER).
//   { archiveDir }                 — names on local disk, only where the caller itself reads the
//                                    local tree (queue-drain's `--ready` / `source: 'tree'` mode).
// Fails SAFE either way: a missing dir, an absent path at the ref, or a git fault yields an EMPTY
// set (a fault is also logged to stderr), so nothing counts as archived and every batch keeps
// holding exactly as it did before this rule existed.
export function readArchivedPlanIds({
  archiveDir,
  repoRoot,
  ref,
  archiveRel,
  _exec = execFileSync,
  log = console.error,
} = {}) {
  const ids = new Set();
  const add = (name) => {
    const id = planIdOfFilename(name);
    if (id) ids.add(id);
  };
  if (repoRoot) {
    if (!ref || !archiveRel) return ids;
    const prefix = `${archiveRel.replace(/\/+$/, '')}/`;
    let blobs;
    try {
      blobs = lsTreeBlobs(repoRoot, ref, prefix, { _exec });
    } catch (e) {
      log(
        `batch-paths: readArchivedPlanIds — git ls-tree ${String(ref).slice(0, 12)} ${prefix} ` +
          `failed (${e?.message ?? e}); treating no batch member as archived.`,
      );
      return ids;
    }
    for (const { path } of blobs) {
      if (!path.startsWith(prefix)) continue;
      const segs = path.slice(prefix.length).split('/');
      if (segs.length <= 2) add(segs[segs.length - 1]);
    }
    return ids;
  }
  if (!archiveDir) return ids;
  const scan = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth === 0) scan(join(dir, e.name), 1);
        continue;
      }
      add(e.name);
    }
  };
  scan(archiveDir, 0);
  return ids;
}

// A batch keeps holding only while at least this many of its members are still live.
export const MIN_LIVE_BATCH_MEMBERS = 2;

// THE live-membership rule (plan 4246) — see the section header above. Pure. `archived` is a
// Set of canonical ids, or null/undefined for "no archive information" (nothing dropped).
// Returns { live, archived, dissolved }, `live`/`archived` as member tokens in roster order.
// `dissolved` is true only when at least one member is archived AND fewer than
// MIN_LIVE_BATCH_MEMBERS remain live — a roster with nothing archived is never dissolved here
// (an empty or one-member roster is a roster defect for the caller to report, not liveness).
export function batchLiveness(batch, archived) {
  const live = [];
  const gone = [];
  for (const id of batch.members) {
    (archived && archived.has(canonicalPlanId(id)) ? gone : live).push(id);
  }
  const dissolved = gone.length > 0 && live.length < MIN_LIVE_BATCH_MEMBERS;
  return { live, archived: gone, dissolved };
}

// The logged reason for a dissolved batch (queue-drain's skippedBatches).
export function dissolvedBatchReason({ live, archived }) {
  const n = live.length;
  return (
    `dissolved: only ${n} live member${n === 1 ? '' : 's'} left ` +
    `(${archived.map(String).join(', ')} archived)` +
    (n === 1 ? ` — ${live[0]} is claimable solo` : '')
  );
}

// `archivedIds` option → a memoized resolver: a thunk is invoked at most once per reader call,
// and only once a runnable batch actually needs judging (no runnable batch → no listing).
function archivedResolver(archivedIds) {
  if (archivedIds == null) return () => null;
  if (typeof archivedIds !== 'function') return () => archivedIds;
  let memo;
  return () => (memo ??= archivedIds() ?? null);
}

// The ONE runnable-batch walk every reader below consumes: each runnable batch
// (isRunnableBatch) with its liveness verdict. A generator, so the single-id lookup can stop
// at its first hit.
function* walkRunnableBatchLiveness(batchesDir, { archivedIds, at } = {}) {
  const archived = archivedResolver(archivedIds);
  for (const { batch, slug } of walkBatchFolders(batchesDir, { at })) {
    if (!isRunnableBatch(batch)) continue; // not runnable — never guards
    yield { batch, slug, ...batchLiveness(batch, archived()) };
  }
}

export function readRunnableBatchMembers(batchesDir, { archivedIds, at } = {}) {
  const held = new Map(); // canonicalPlanId -> holding batch slug
  for (const { slug, live, dissolved } of walkRunnableBatchLiveness(batchesDir, {
    archivedIds,
    at,
  })) {
    if (dissolved) continue; // a dissolved batch holds nothing (plan 4246)
    for (const id of live) {
      const key = canonicalPlanId(id);
      if (!held.has(key)) held.set(key, slug); // first-match wins on a (data-error) double listing
    }
  }
  return held;
}

// The ROSTER twin of readRunnableBatchMembers (plan 2556): the same runnable batches, keyed
// the other way round — one entry per batch carrying its member list — for the caller that
// needs to ask "is this whole train takeable?" rather than "is this one plan held?".
// queue-drain's runnableBatches pass is that caller: the member->slug map cannot answer it,
// because reconstructing a batch's full membership from it would silently drop any member
// the first-match-wins tiebreak awarded to a different batch, turning a malformed roster
// into a train reported runnable while missing a car.
//
// Same walk, same `isRunnableBatch` predicate, same sorted-by-folder-name order — so this
// and the member map can never disagree about which batches are runnable. Members are
// returned VERBATIM from batch.md (canonicalize at the comparison site, exactly as the map
// build does); an empty-`members` roster entry is returned as-is and left for the caller to
// reject, since "a batch with no members" is a roster defect, not a runnability question.
//
// plan 4246: with `archivedIds`, `members` is the LIVE member list (archived ids dropped and
// listed in `archivedMembers`), and a DISSOLVED batch is left out — it is not runnable.
// readBatchRosterLiveness below is the same walk, also returning the dissolved batches.
export function readRunnableBatches(batchesDir, { archivedIds, at } = {}) {
  return readBatchRosterLiveness(batchesDir, { archivedIds, at }).runnable;
}

// ONE walk, both halves (plan 4246): `runnable` (what readRunnableBatches returns) and
// `dissolved` — runnable-status batches an archived member left with fewer than
// MIN_LIVE_BATCH_MEMBERS live members. Each entry is
// `{ slug, lane, members (live), archivedMembers, theme }`. queue-drain reports every dissolved
// batch in skippedBatches, so the log still says why a former train no longer holds anything.
export function readBatchRosterLiveness(batchesDir, { archivedIds, at } = {}) {
  const runnable = [];
  const dissolved = [];
  for (const { batch, slug, live, archived, dissolved: gone } of walkRunnableBatchLiveness(
    batchesDir,
    { archivedIds, at },
  )) {
    const entry = {
      slug,
      lane: batch.lane,
      members: live,
      archivedMembers: archived,
      theme: batch.theme,
    };
    (gone ? dissolved : runnable).push(entry);
  }
  return { runnable, dissolved };
}

// Single-id lookup (plan 2518 item 4): the slug of the runnable batch holding `planId`, or
// null. claim-plan.mjs's acquire path asks about exactly ONE plan, and previously built the
// entire membership map to answer it — every batch folder read and parsed to look up one key.
// This stops at the first holding batch instead. Same first-match-wins tiebreak as the map
// build above, over the same sorted walk, so both answer identically for any given tree.
//
// plan 4246: honours the SAME live-membership rule (batchLiveness) as the bulk readers — given
// the same `archivedIds`, a dissolved batch holds nothing and an archived id is never held.
export function findRunnableBatchForPlan(batchesDir, planId, { archivedIds, at } = {}) {
  const wanted = canonicalPlanId(planId);
  for (const { slug, live, dissolved } of walkRunnableBatchLiveness(batchesDir, {
    archivedIds,
    at,
  })) {
    if (dissolved) continue;
    if (live.some((id) => canonicalPlanId(id) === wanted)) return slug;
  }
  return null;
}

// A Map-shaped façade over readRunnableBatchMembers that defers the fs walk until the first
// lookup, then memoizes it (plan 2518 item 3). queue-drain's readReadyMetas built the map
// EAGERLY on every scan, even on a tick where no ready plan ever reached the batch-hold
// branch (an all-stub board, or a `--lane fable` run over an all-sonnet ready/) — the
// archivedIds precompute beside it was already demand-gated the same way.
//
// Exposes only `has`/`get`, which is the entire surface parsePlanMeta uses — so a plain Map
// remains a valid substitute for it (every existing caller and test that passes one keeps
// working), and parsePlanMeta itself stays pure: it never performs an fs read, it only
// touches an object the caller handed it.
export function lazyRunnableBatchMembers(batchesDir, { archivedIds, at } = {}) {
  let held = null;
  const load = () => (held ??= readRunnableBatchMembers(batchesDir, { archivedIds, at }));
  return {
    has: (key) => load().has(key),
    get: (key) => load().get(key),
  };
}

// ONE memoized walk serving BOTH shapes (plan 2556 review, findings 0 + 5). queue-drain needs
// the member->slug map (per-plan hold lookup) AND the roster array (per-batch runnability), and
// wiring them as two independent lazy reads produced two defects at once:
//
//   • TWO walks of the batches tree on any tick where a batch was held — the map's walk plus
//     the roster's.
//   • Worse, the roster read was demand-gated on "some ready plan reads exclude:'batch'", which
//     is FALSE exactly when a runnable batch's members have ALL left ready/ (re-filed, claimed,
//     archived, or the roster names stale ids). No meta then reads 'batch', the roster was never
//     read, and the batch vanished from `runnableBatches` AND `skippedBatches` alike — silently,
//     which is precisely the failure the operator ruling's "logged reason" requirement exists to
//     prevent, and which the stale-roster case needs most since nothing else will ever surface it.
//
// Deriving both from one memoized walk removes the second walk and lets the caller consult the
// roster unconditionally without paying twice. The walk is still LAZY: a tree with no batches dir,
// or a caller that touches neither shape, performs no read at all — only the plan-2518 "skip the
// walk when no plan is held" gate is deliberately given up, and that gate is what caused the bug.
//
// plan 4246: `archivedIds` (Set or thunk — queue-drain passes a thunk over readArchivedPlanIds)
// applies the live-membership rule to both shapes, and `at` (see walkBatchFolders) reads the
// roster itself at a git commit instead of local disk; `dissolved()` exposes the batches it
// dissolved, off the same memoized walk, for queue-drain's skippedBatches log.
export function lazyBatchRoster(batchesDir, { archivedIds, at } = {}) {
  let batches = null;
  let dissolved = null;
  let held = null;
  const load = () => {
    if (batches === null) {
      ({ runnable: batches, dissolved } = readBatchRosterLiveness(batchesDir, { archivedIds, at }));
      held = new Map();
      for (const b of batches) {
        for (const id of b.members) {
          const key = canonicalPlanId(id);
          if (!held.has(key)) held.set(key, b.slug); // first-match-wins, as readRunnableBatchMembers
        }
      }
    }
    return { batches, dissolved, held };
  };
  return {
    has: (key) => load().held.has(key),
    get: (key) => load().held.get(key),
    list: () => load().batches,
    dissolved: () => load().dissolved,
  };
}

// The ONE composition of the batch-hold refusal text (plan 2518 item 1). The rule ("a member
// of a runnable batch may not be claimed solo") was worded twice — in queue-drain.mjs's
// parsePlanMeta as an eligibility exclusion, and in claim-plan-lib.mjs's
// checkBatchSoloClaimGate as a claim refusal — and two hand-written copies of one sentence
// drift the moment either is edited.
//
// Takes the RESOLVED slug, not a lookup structure: the two callers arrive at that slug by
// genuinely different routes (a bulk-scan map vs a single-id walk), so the message composer
// must sit below both rather than presume either shape. Returns the shared CORE; the claim
// path prefixes it with "plan <id> is a " to read as a sentence, which is exactly the
// difference the two copies carried before this extraction.
export function batchHoldReason(slug) {
  return (
    `member of runnable batch "${slug}" (status: proposed, gate: null) — take the ` +
    `whole train via \`claim-plan.mjs batch\`, or override with --override-batch-solo "<note>"`
  );
}

// Map-shaped lookup + verdict, for the BULK caller (queue-drain scans every ready plan
// against one precomputed map). Returns null when unheld, else { slug, reason }. The
// single-plan claim path does NOT come through here — it resolves its one slug via
// findRunnableBatchForPlan and composes with batchHoldReason directly.
export function batchHoldFor(planId, heldBy) {
  const slug = heldBy.get(canonicalPlanId(planId));
  if (!slug) return null;
  return { slug, reason: batchHoldReason(slug) };
}

// Idempotently set the frontmatter `status:` (proposed → claimed → landed). Adds
// the key just before the closing `---` if the batch.md predates it. Leaves a
// frontmatter-less file untouched (defensive — parseBatchMd would already have
// degraded it).
export function stampBatchStatus(content, status) {
  const fm = /^(---\n[\s\S]*?\n---\n?)/.exec(content || '');
  if (!fm) return content;
  let block = fm[1];
  if (/^status:.*$/m.test(block)) {
    block = block.replace(/^status:.*$/m, `status: ${status}`);
  } else {
    block = block.replace(/\n---(\n?)$/, `\nstatus: ${status}\n---$1`);
  }
  return block + content.slice(fm[1].length);
}
