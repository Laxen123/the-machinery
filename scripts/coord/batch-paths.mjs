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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
// Stale-roster safety (plan 2459 Task 2, item 6): this function does NOT verify that a
// listed member still resolves anywhere claimable — it only reports batch.md's frontmatter
// verbatim. A roster whose members have ALL long since archived (batch-coord-smalls,
// batch-coord-decouple-spine style drift) still returns those stale ids here. Callers
// never refuse anything because of it, BY CONSTRUCTION: both consumers only ever look up
// an id they are ABOUT to claim or list (a ready/ scan, or a specific claim target) — an
// archived plan is never presented for claiming again, so its stale membership entry is
// simply never consulted. Never call this to iterate "what does the roster still expect"
// — that judgment belongs to the board-pass reconcile (plan 2459 Task 3), not this guard.
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
export function* walkBatchFolders(batchesDir, { onSkip } = {}) {
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

// A batch GUARDS its members only while it is runnable: still open for the taking
// (`status: proposed`) and not withheld behind an unmet trip (`gate: null`). Single
// predicate so the map build and the single-id lookup can never disagree about it.
export function isRunnableBatch(batch) {
  return batch.status === 'proposed' && batch.gate === null;
}

export function readRunnableBatchMembers(batchesDir) {
  const held = new Map(); // canonicalPlanId -> holding batch slug
  for (const { batch, slug } of walkBatchFolders(batchesDir)) {
    if (!isRunnableBatch(batch)) continue; // not runnable — never guards
    for (const id of batch.members) {
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
export function readRunnableBatches(batchesDir) {
  const out = [];
  for (const { batch, slug } of walkBatchFolders(batchesDir)) {
    if (!isRunnableBatch(batch)) continue;
    out.push({ slug, lane: batch.lane, members: batch.members, theme: batch.theme });
  }
  return out;
}

// Single-id lookup (plan 2518 item 4): the slug of the runnable batch holding `planId`, or
// null. claim-plan.mjs's acquire path asks about exactly ONE plan, and previously built the
// entire membership map to answer it — every batch folder read and parsed to look up one key.
// This stops at the first holding batch instead. Same first-match-wins tiebreak as the map
// build above, over the same sorted walk, so both answer identically for any given tree.
export function findRunnableBatchForPlan(batchesDir, planId) {
  const wanted = canonicalPlanId(planId);
  for (const { batch, slug } of walkBatchFolders(batchesDir)) {
    if (!isRunnableBatch(batch)) continue;
    if (batch.members.some((id) => canonicalPlanId(id) === wanted)) return slug;
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
export function lazyRunnableBatchMembers(batchesDir) {
  let held = null;
  const load = () => (held ??= readRunnableBatchMembers(batchesDir));
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
export function lazyBatchRoster(batchesDir) {
  let batches = null;
  let held = null;
  const load = () => {
    if (batches === null) {
      batches = readRunnableBatches(batchesDir);
      held = new Map();
      for (const b of batches) {
        for (const id of b.members) {
          const key = canonicalPlanId(id);
          if (!held.has(key)) held.set(key, b.slug); // first-match-wins, as readRunnableBatchMembers
        }
      }
    }
    return { batches, held };
  };
  return {
    has: (key) => load().held.has(key),
    get: (key) => load().held.get(key),
    list: () => load().batches,
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
