#!/usr/bin/env node
// scripts/coord/landing-queue-ref.mjs (plan 3973)
// The landing-queue DOCUMENT's transport: the whole `landing-queue.md` lives as the one file in
// the tree of a commit chain on the coord ref `refs/heads/coord/landing-queue`, written by CAS
// (compare-and-swap) push. Sibling of queue-heartbeat-ref.mjs, which owns the per-slug liveness
// stamp on `refs/heads/coord/queue-heartbeat/<slug>`.
//
// WHY A REF AND NOT A MASTER COMMIT. Measured 2026-09-12 over 7 days: 1,358 of master's 7,920
// commits were `coord(queue): …` bookkeeping — every enqueue, dequeue, mark-holding, requeue —
// and every one of them moved the tip every in-flight branch had to rebase past (plan 3941's
// 23-commit branch replayed six times at the queue head in one day). The queue is transient
// FIFO state, not source history; archived plan 1011 proposed this move in 2026-06 and shipped
// only its baseline tool. Off master, a queue write is one object push on a ref nothing rebases
// onto.
//
// WHY CAS AND NOT THE HEARTBEAT'S FORCE PUSH. The heartbeat ref has ONE writer per slug, so
// last-write-wins is correct there. The queue doc has MANY writers (every session's verbs), and
// a forced push would silently drop a sibling's enqueue that landed between our read and our
// write. So the write is the claim-CAS shape from claim-plan.mjs `acquireRef`: build a commit
// whose PARENT is the tip we read, push it NON-force; a rejected non-fast-forward means a rival
// wrote first — re-read, re-run the transform, retry (bounded). Exactly one writer wins each
// round, and the loser's transform re-runs against the winner's doc, which is what makes
// concurrent enqueues commute into FIFO push order (the same property coordWrite's rebase-retry
// gave the master-doc transport).
//
// THE LOCAL VIEW (plan 3973 D1) is the ordinary remote-tracking ref
// `refs/remotes/origin/coord/landing-queue`, never a local branch: a plain `git fetch origin`
// with the default refspec refreshes it for free, and the explicit refspec below refreshes it in
// a single-branch clone (a cloud sandbox). Readers that must not pay a fetch per call (the
// redgreen statusline poller, session-priority's spawn hot path) read that ref as-is.
//
// TRI-STATE READS (plan 3973 D3, the plan-3459 rule): ABSENT is data (no queue yet — the ref has
// never been written), FAULT is a refusal (origin unreachable, an unreadable object). The two
// must never collapse: a fetch failure read as "empty queue" would let a displacement verb
// judge a queue it never saw. `readQueueRef` proves ABSENT only by an `ls-remote` that succeeds
// and lists nothing (fetch mode) or by a missing local tracking ref (no-fetch mode).
//
// FAIL-SAFE DIRECTIONS mirror queue-heartbeat-ref.mjs: a write that cannot land THROWS (a verb
// must never report success over a dropped write); a read that cannot be trusted reports a
// fault the caller must honour, never a synthesized empty doc presented as the queue.
//
// OBJECT CHURN: one blob + one tree + one commit per write, all reachable from the ref's tip
// chain, so nothing here is a prune candidate; the chain itself is the queue's history
// (`git log refs/remotes/origin/coord/landing-queue`), which measure-land-duration.mjs mines
// for the post-cut-over enqueue/dequeue markers (plan 3973 D5).

import {
  git as coordGit,
  gitWithLockRetry,
  errText,
  sleepSync,
  lsRemoteTimed,
} from './coord-git.mjs';
import { loadCoordConfig } from './coord-config.mjs';
// coord-refs.mjs is the ONE authority for coordination ref names (plan 3756) — never hand-build.
import { coordRef, COORD_PREFIX } from './coord-refs.mjs';
import { classifyPushResult } from './claim-plan-lib.mjs';
import {
  initialQueueDoc,
  isQueueTombstone,
  parseQueue,
  renderQueueRow,
} from './landing-queue-lib.mjs';

/** The queue document's ref on origin (branch-shaped: the proxy-safe namespace, plan 3756). */
export const QUEUE_REF = coordRef('landing-queue');
/** The local remote-tracking view of QUEUE_REF (plan 3973 D1). */
export const QUEUE_REF_LOCAL = `refs/remotes/origin/${QUEUE_REF.slice('refs/heads/'.length)}`;
/** The explicit, forced fetch refspec — forced so a single-branch clone still tracks it. */
export const QUEUE_FETCH_REFSPEC = `+${QUEUE_REF}:${QUEUE_REF_LOCAL}`;
/**
 * The file name inside the ref's tree. This module is the ONLY one that knows it: every reader
 * goes through `readQueueDoc` below, every writer through `mutateQueueRef`.
 */
export const QUEUE_DOC_NAME = 'landing-queue.md';
/** The CAS retry budget (plan 3973 D2: bounded, ~150 doc writes/day so contention is rare). */
export const QUEUE_CAS_ATTEMPTS = 12;
/** The `Queue-Attempt:` trailer every ref commit carries — T4 counts collisions from it. */
export const QUEUE_ATTEMPT_TRAILER = 'Queue-Attempt';

// Plan bodies reach `refs/heads/*` through the cloud proxy; this ref rides the same namespace.
if (!QUEUE_REF.startsWith(COORD_PREFIX)) {
  throw new Error(`landing-queue-ref: ${QUEUE_REF} is outside the coord namespace`);
}

const HUSKY0 = { HUSKY: '0' }; // a ref push carries no branch diff → no hook battery
// Probes whose FAILURE is an expected answer (a fetch of a not-yet-existing ref, a show of an
// absent path) must not spray git's `fatal:` line onto the caller's stderr — execFileSync
// inherits stderr unless told otherwise, and the error object carries the text anyway.
const QUIET = { stdio: ['ignore', 'pipe', 'pipe'] };
// git's "this ref must not exist" sentinel for an `update-ref <ref> <new> <old>` CAS.
const ZERO_OID = '0'.repeat(40);
// `git ls-remote` output `<sha>\t<ref>` → the sha, or null on empty output.
function shaFromLsRemote(out) {
  const line = String(out || '')
    .split('\n')
    .find((l) => l.trim());
  return line ? line.split('\t')[0].trim() || null : null;
}

// The fetch of the queue ref by explicit refspec, in the SAME round trip as `master` (plan 3973
// review round 3, keys da94f5 / 61f4ff): origin/master is the other side of the D4 divergence
// comparison and the seed view for an absent ref, and fetching only the refspec left that side
// at whatever this checkout last saw — so a master-side old-code write that landed since could
// pass the guard unseen. `{ ok, masterFetched }` or `{ ok: false, error, masterFetched }` — a
// missing remote ref ALSO fails the fetch (`couldn't find remote ref`), so a failure here is not
// yet a fault; `readQueueRef` disambiguates with ls-remote.
export function fetchQueueRef(mainDir, { gitImpl = coordGit } = {}) {
  try {
    gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master', QUEUE_FETCH_REFSPEC], {
      _git: gitImpl,
      ...QUIET,
    });
    return { ok: true, masterFetched: true };
  } catch (error) {
    // A named refspec whose remote ref does not exist fails the WHOLE fetch, master included —
    // the normal pre-cut-over state, where the master doc IS the live queue. Fetch it on its own
    // (the same fallback redgreen's freshCoordDoc takes) rather than hand the accessor a master
    // snapshot of unknown age and call the read freshened.
    let masterFetched = false;
    try {
      gitWithLockRetry(mainDir, ['fetch', '--quiet', 'origin', 'master'], {
        _git: gitImpl,
        ...QUIET,
      });
      masterFetched = true;
    } catch {
      /* origin unreachable — the caller's `fetched: false` says the doc may be stale */
    }
    return { ok: false, error, masterFetched };
  }
}

// Does the ref exist on ORIGIN? Tri-state, because "ls-remote failed" and "ls-remote listed
// nothing" are the two answers this module must never confuse (plan 3973 D3).
export function lsRemoteQueueRef(mainDir, { gitImpl = coordGit } = {}) {
  let out;
  try {
    // plan 1475's shared, 5s-capped helper (the same one every claim read goes through), not a
    // private `ls-remote` with its own timeout: a proxy that hangs must fail this read fast, and
    // a future fix to that cap must reach the queue too (plan 3973 review, key 87557c).
    out = lsRemoteTimed(mainDir, QUEUE_REF, { _git: gitImpl });
  } catch (error) {
    return { state: 'fault', error };
  }
  const sha = shaFromLsRemote(out);
  return sha ? { state: 'present', sha } : { state: 'absent' };
}

// A FAILED fetch of the queue ref, classified. This is the ONE place that decision lives,
// because a fetch fails IDENTICALLY for the two answers this module must never confuse: origin
// has no such ref (data: ABSENT — `fatal: couldn't find remote ref …`, the normal pre-cut-over
// state) and origin could not be reached (a FAULT). `ls-remote` is the arbiter, exactly as the
// tri-state rule in the header requires — an absence is PROVEN, never inferred from the failed
// fetch alone (plan 3973 review round 2, keys c0bd5b / ad2818 / b03ae5 / 07876e / f19b59 / ebcc3e).
function classifyFailedFetch(mainDir, fetchError, { gitImpl = coordGit, masterFetched = false }) {
  const ls = lsRemoteQueueRef(mainDir, { gitImpl });
  if (ls.state === 'absent') {
    // Origin is the authority: a stale local tracking ref (a ref origin no longer has) must not
    // resurrect a queue nobody else can see. Best-effort; a failure here only costs a later
    // bootstrap its first attempt. A no-op when nothing is tracked locally.
    try {
      gitImpl(mainDir, ['update-ref', '-d', QUEUE_REF_LOCAL], QUIET);
    } catch {
      /* nothing local to drop */
    }
    return { state: 'absent', fetched: true, masterFetched };
  }
  // ls-remote faulted, or it lists the ref while the fetch of it failed (transient): either way
  // this run did not get a trustworthy view.
  return { state: 'fault', error: fetchError, fetchFailed: true, masterFetched };
}

// The LOCAL tracking ref's tip, without a fetch: `for-each-ref` prints nothing (exit 0) for a
// missing ref and throws only on a genuine fault — the same reason the pinned snapshot in
// landing-queue.mjs probes with `ls-tree` rather than `show`.
function readLocalQueueTip(mainDir, { gitImpl = coordGit } = {}) {
  let out;
  try {
    out = gitImpl(mainDir, ['for-each-ref', '--format=%(objectname)', QUEUE_REF_LOCAL]);
  } catch (error) {
    return { state: 'fault', error };
  }
  const sha = String(out || '').trim();
  // `local: true` marks an absence proven only by THIS checkout's tracking ref — a single-branch
  // clone that never fetched the coord ref looks exactly like an empty queue here (plan 3973
  // review, key 81b940). Callers that must not mistake the two ask for `fetchIfAbsent` below.
  return sha ? { state: 'present', sha } : { state: 'absent', local: true };
}

// The doc at a given ref commit. A failure here is unambiguously a fault: the sha came from a
// ref that exists, so the path is known present. Exported for the history miners
// (measure-land-duration.mjs, plan 3973 D5) so nothing outside this module spells the file name.
export function readDocAtSha(mainDir, sha, { gitImpl = coordGit } = {}) {
  try {
    return { state: 'present', doc: gitImpl(mainDir, ['show', `${sha}:${QUEUE_DOC_NAME}`]), sha };
  } catch (error) {
    return { state: 'fault', error, sha };
  }
}

// Read the queue document from the ref. Tri-state:
//   { state: 'present', doc, sha }   the doc at the ref tip (the local tracking ref, freshened
//                                    first when `fetch` is true)
//   { state: 'absent' }              proven: ls-remote lists no such ref (fetch mode, and after a
//                                    `fetchIfAbsent` fetch that failed), or the local tracking
//                                    ref does not exist (no-fetch mode — then `local: true`,
//                                    because this checkout may simply never have fetched the ref;
//                                    `fetchIfAbsent` turns that into one explicit fetch before
//                                    the answer is believed)
//   { state: 'fault', error, fetchFailed, unverifiedLocalAbsence }
//                                    the ref could not be read — a failed fetch AND ls-remote
//                                    (fetchFailed: true; `unverifiedLocalAbsence: true` when that
//                                    happened under `fetchIfAbsent`, i.e. the local absence could
//                                    not be proven either way), or an unreadable object. Callers
//                                    that displace a head MUST refuse on this; reporters may
//                                    degrade to the cached local tip via
//                                    `readQueueRef(…, { fetch: false })`.
// `fetched: true` rides on any result this call actually refreshed (or authoritatively probed)
// from origin — the accessor below turns it into its own `fetched` field, so a no-fetch reader
// cannot present a cached tracking ref as a freshened one.
export function readQueueRef(
  mainDir,
  { fetch = true, fetchIfAbsent = false, gitImpl = coordGit } = {},
) {
  let fetched = false;
  // Whether THIS read refreshed origin/master too (the combined fetch above, or its master-only
  // fallback). The master doc is a second document with its own freshness, and the accessor
  // reports it separately so a master-sourced doc cannot ride the ref's `fetched` flag.
  let masterFetched = false;
  if (fetch) {
    const f = fetchQueueRef(mainDir, { gitImpl });
    masterFetched = f.masterFetched === true;
    if (!f.ok) return classifyFailedFetch(mainDir, f.error, { gitImpl, masterFetched });
    fetched = true;
  }
  let tip = readLocalQueueTip(mainDir, { gitImpl });
  if (!fetch && fetchIfAbsent && tip.state === 'absent') {
    // A MISSING tracking ref is not a proven empty queue — it is "this checkout has never seen
    // the ref" (a single-branch clone, a fresh sandbox). The no-fetch readers that would act on
    // "not queued" (the spawn scheduler, the close-out) pay ONE fetch here rather than believe
    // it. And when that fetch FAILS the absence is still unproven, so it goes through the same
    // arbiter every other fetch failure does: origin saying "no such ref" makes the absence real,
    // anything else is a FAULT the caller must honour — returning the unproven local absence as
    // data is what hid a live landing head from the spawn scheduler and the close light.
    const f = fetchQueueRef(mainDir, { gitImpl });
    masterFetched = f.masterFetched === true;
    if (!f.ok) {
      const c = classifyFailedFetch(mainDir, f.error, { gitImpl, masterFetched });
      return c.state === 'fault' ? { ...c, unverifiedLocalAbsence: true } : c;
    }
    fetched = true;
    tip = readLocalQueueTip(mainDir, { gitImpl });
  }
  if (tip.state !== 'present') return fetched ? { ...tip, fetched, masterFetched } : tip;
  return { ...readDocAtSha(mainDir, tip.sha, { gitImpl }), fetched, masterFetched };
}

// ── The master doc (the pre-3973 transport) ─────────────────────────────────────────────────
// Read ONLY for two transitional purposes: seeding the ref the first time (plan 3973 D3) and the
// loud-fail check that catches an old-code session still writing the master doc (D4). FOUR-state:
// 'tombstone' (the cut-over pointer — the normal post-3973 state), 'present' (a real queue table:
// pre-cut-over, or an old-code writer), 'absent' (PROVEN: the path does not exist at a resolvable
// origin/master, or this repo has no origin/master at all — a fresh test repo), 'fault' (the read
// itself failed: a corrupt/unreadable object, a git failure that is not an answer).
//
// ABSENT and FAULT must never collapse (plan 3973 review, keys ee6e2a / bf9290 / a23b64): with
// the ref also absent, a faulted master read swallowed as "no master doc" makes the next WRITE
// bootstrap the ref from an empty document and silently drop every waiter the master doc still
// carried. The same rule the ref's own tri-state read follows, applied to the retired transport.
export function readMasterQueueDoc(mainDir, { gitImpl = coordGit } = {}) {
  let rel;
  try {
    rel = loadCoordConfig(mainDir).paths.queueFile;
  } catch (error) {
    // `loadCoordConfig` returns the DEFAULTS for a repo with no `coord.config.json` at all — it
    // throws only when the file exists and could not be read, parsed or validated. That is a
    // FAULT, not "this repo configures no queue file": collapsing it to absent, with the ref
    // absent too, lets the next write bootstrap an empty queue over every master-side waiter
    // (plan 3973 review round 2, keys 597d2e / 738e52).
    return { state: 'fault', error, configFailed: true };
  }
  // `ls-tree` first: it is silent and exit-0 on an absent path (the same reason the pinned
  // snapshot in landing-queue.mjs probes with it), where a bare `show` prints `fatal:`.
  let listed;
  try {
    listed = gitImpl(mainDir, ['ls-tree', 'origin/master', '--', rel], QUIET);
  } catch (error) {
    // The ONE ls-tree failure that is an answer rather than a fault: this checkout has no
    // origin/master to read (a fresh repo before its first push). Anything else — a broken
    // object store, a git that could not run — is a fault the caller must honour.
    try {
      gitImpl(mainDir, ['rev-parse', '--verify', '--quiet', 'origin/master'], QUIET);
    } catch {
      return { state: 'absent', rel };
    }
    return { state: 'fault', error, rel };
  }
  if (!String(listed || '').trim()) return { state: 'absent', rel };
  let raw;
  try {
    raw = gitImpl(mainDir, ['show', `origin/master:${rel}`], QUIET);
  } catch (error) {
    // ls-tree just proved the path IS there, so a failed show is unreadable content, never
    // "no queue doc" — the exact collapse that let an empty bootstrap discard live waiters.
    return { state: 'fault', error, rel };
  }
  return isQueueTombstone(raw) ? { state: 'tombstone', rel } : { state: 'present', raw, rel };
}

const masterReadFault = (master) =>
  Object.assign(
    new Error(
      master.configFailed
        ? `landing-queue-ref: coord.config.json could not be read (` +
            `${String(master.error?.message ?? master.error).trim()}), so the pre-3973 queue doc's ` +
            `path at origin/master is unknown — it may still carry queue entries, so this read ` +
            `refuses rather than treat it as absent. Fix coord.config.json and retry.`
        : `landing-queue-ref: the pre-3973 queue doc${master.rel ? ` (${master.rel})` : ''} at ` +
            `origin/master could not be read (` +
            `${String(master.error?.message ?? master.error).trim()}) — it may still carry queue ` +
            `entries, so this read refuses rather than treat it as absent. Fix the object store / ` +
            `connectivity to origin and retry.`,
    ),
    { cause: master.error },
  );

// A queue document that does not PARSE is a fault, never an empty queue (plan 3973 review round
// 2, key fb32a3): with the master doc tombstoned the D4 comparison never runs, so nothing else
// looks at the text — a reader would judge a queue it could not read and a writer would overwrite
// it. The one-line heal is to inspect the document and push a repaired one.
const queueDocFault = (error, where, inspect) =>
  Object.assign(
    new Error(
      `landing-queue-ref: ${where} could not be read as a queue table (` +
        `${String(error?.message ?? error).trim()}) — a malformed queue doc is a fault, never an ` +
        `empty queue, so this read refuses. Inspect it with \`${inspect}\` and heal it.`,
    ),
    { cause: error },
  );

// THE validation point (plan 3973 review round 3, keys d38ef3 / db4f11 / 7b7642 / c9d223 /
// 79758c / d836ca / 603f09 / 4d7903). EVERY document `readQueueDoc` can hand back — the freshly
// fetched ref, the cached tracking ref after a failed fetch, and the pre-cut-over master
// fallback — passes through here exactly once, and the parse it produces is returned to the
// caller so nothing re-parses the same text. Two ways to fail, one verdict:
//   - the sentinels are missing (`parseQueue` throws), or
//   - the sentinels survived while the TABLE HEADER did not. That text parses to `entries: []`,
//     which is byte-for-byte the answer an empty queue gives: a reader would report "nobody is
//     queued" and the next mutation would rewrite the doc from that empty list, dropping every
//     waiting land. A corrupt document is a fault on every transport, not just the ref's.
// Exported (plan 3973 review round 4, key 4ba3a8) so `migrate`'s own direct reads of the master
// document meet the SAME check instead of a bare `parseQueue` that accepts a headerless table —
// one validator, not a second parser with a weaker rule.
export function validateQueueDoc(doc, where, inspect) {
  let parsed;
  try {
    parsed = parseQueue(doc);
  } catch (error) {
    return { parsed: null, fault: queueDocFault(error, where, inspect) };
  }
  if (!parsed.sawHeader) {
    return {
      parsed: null,
      fault: queueDocFault(
        new Error('the QUEUE region carries no table header row'),
        where,
        inspect,
      ),
    };
  }
  return { parsed, fault: null };
}

// The synthesized-empty answer every unreadable branch returns: a doc that PARSES (so no caller
// crashes on it) with `source` saying it is empty because nothing could be read.
// Derived THROUGH parseQueue rather than hand-built (plan 3973 review round 4, key e963b1): an
// unreadable read must hand back exactly the parse a genuinely empty queue gives, and a future
// parser field would otherwise appear on one of the two and not the other.
const EMPTY_PARSE = parseQueue(initialQueueDoc());
const unreadable = (fault, { fetched = false } = {}) => ({
  doc: initialQueueDoc(),
  parsed: EMPTY_PARSE,
  sha: null,
  source: 'none',
  fetched,
  fault,
});

// The loud-fail message (plan 3973 D4). A non-tombstone master doc beside a live ref that is not
// BYTE-IDENTICAL to it means an old-code session wrote the queue where nobody reads it any more;
// the difference is reconciled by ONE bounded heal, never silently merged by a reader.
export function migrateNeededMessage(rel, divergence = {}) {
  const {
    unparseable = false,
    masterOnly = [],
    refOnly = [],
    changed = [],
    masterOnlyAudit = 0,
    refOnlyAudit = 0,
    orderDiffers = false,
    auditOrderDiffers = false,
  } = divergence;
  const plural = (n, one, many) => (n === 1 ? one : many);
  const what = unparseable
    ? 'a table this code cannot parse'
    : [
        masterOnly.length
          ? `${plural(masterOnly.length, 'entry', 'entries')} ${masterOnly.join(', ')} the ref lacks`
          : '',
        refOnly.length
          ? `${plural(refOnly.length, 'entry', 'entries')} ${refOnly.join(', ')} the ref has and it lacks`
          : '',
        changed.length
          ? `${plural(changed.length, 'a changed row', `${changed.length} changed rows`)} (${changed.join(', ')})`
          : '',
        masterOnlyAudit ? `${masterOnlyAudit} audit line(s) the ref lacks` : '',
        refOnlyAudit ? `${refOnlyAudit} audit line(s) the ref has and it lacks` : '',
        !masterOnly.length && !refOnly.length && !changed.length && orderDiffers
          ? 'a different row order'
          : '',
        // The audit region diverges by ORDER alone too, and that is the whole difference when
        // both `…OnlyAudit` counts are zero — without this clause the refusal fell through to
        // the bare "it differs" (plan 3973 review round 3, key 35e276).
        !masterOnlyAudit && !refOnlyAudit && auditOrderDiffers
          ? 'a different audit-line order'
          : '',
      ]
        .filter(Boolean)
        .join(', ');
  return (
    `the landing queue lives on ${QUEUE_REF} (plan 3973), but ${rel} on origin/master still ` +
    `carries a queue table that does not match the ref's doc — ${what || 'it differs'} — so an ` +
    `old-code session wrote it there. Run \`node scripts/landing-queue.mjs migrate\` to fold it ` +
    `into the ref and re-tombstone the master doc; until then the two queues cannot be ` +
    `reconciled and this read refuses.`
  );
}

// How the master doc differs from the ref's doc — the D4 trigger. Takes the two PARSES, not the
// two texts (plan 3973 review round 4, keys c57dab / 4c907e): both callers already hold a parse
// that went through `validateQueueDoc`, and re-parsing here both duplicated that O(n) work and
// let a document the validator would have refused reach the comparison as an innocuous empty
// queue. `masterParsed: null` means the master document did not validate — it cannot be proven
// equal, so it diverges by definition. The EOL normalization this used to do before parsing is
// gone with the raw text: `parseQueue` trims every cell and every audit line, so a CRLF document
// and its LF twin produce identical parses (the round-3 CRLF case still asserts it).
//
// The test is BYTE-IDENTITY of both regions: every serialized row (all eleven columns) and every
// audit line, in BOTH directions. The old "a subset is harmless" carve-out is gone (plan 3973
// review, keys 0ad6b9 / 78d384 / 987e1d / bc0fc5 / acb542): it made an old-code dequeue, an
// old-code heartbeat, an old-code state flip and a reorder all invisible — precisely the writes
// that leave a phantom head, a stale liveness stamp or the wrong FIFO order behind after
// `migrate` tombstones master. The per-difference breakdown exists only to word the refusal;
// `diverged` is the verdict, and it is the OR of EVERY axis below — never of the order flags
// alone, which is what let a changed row ride in on the row-order flag (round 4, keys bfd914 /
// 90e33f / 96d4e9).
export function masterDocDivergence(masterParsed, refParsed) {
  const empty = {
    masterOnly: [],
    refOnly: [],
    changed: [],
    masterOnlyAudit: 0,
    refOnlyAudit: 0,
    orderDiffers: false,
    auditOrderDiffers: false,
    unparseable: false,
    error: null,
  };
  if (!masterParsed) return { ...empty, diverged: true, unparseable: true };
  const m = masterParsed;
  const r = refParsed ?? { entries: [], auditLines: [] };
  const mBySlug = new Map(m.entries.map((e) => [e.slug, renderQueueRow(e)]));
  const rBySlug = new Map(r.entries.map((e) => [e.slug, renderQueueRow(e)]));
  const mAudit = new Set(m.auditLines);
  const rAudit = new Set(r.auditLines);
  const masterOnly = [...mBySlug.keys()].filter((s) => !rBySlug.has(s));
  const refOnly = [...rBySlug.keys()].filter((s) => !mBySlug.has(s));
  const changed = [...mBySlug.keys()].filter(
    (s) => rBySlug.has(s) && rBySlug.get(s) !== mBySlug.get(s),
  );
  const masterOnlyAudit = m.auditLines.filter((l) => !rAudit.has(l)).length;
  const refOnlyAudit = r.auditLines.filter((l) => !mAudit.has(l)).length;
  // One order flag PER REGION, both reported (plan 3973 review round 3, keys 35e276 / 9e10de):
  // the rows and the audit lines each diverge by sequence alone, and `migrate` warns about
  // whichever of the two it is about to discard with the tombstone. ORDER is the sequence of the
  // items BOTH sides carry — row identity is the slug, audit-line identity is the line itself —
  // so a changed heartbeat cell reports as a changed ROW and an appended audit line as an
  // audit-line the other side lacks, neither of them as a reorder the operator should undo with
  // `overtake`/`demote` (round 4, keys bfd914 / 90e33f / 96d4e9 / 00891a / cad6ef).
  const orderDiffers =
    m.entries
      .map((e) => e.slug)
      .filter((s) => rBySlug.has(s))
      .join('\n') !==
    r.entries
      .map((e) => e.slug)
      .filter((s) => mBySlug.has(s))
      .join('\n');
  const auditOrderDiffers =
    m.auditLines.filter((l) => rAudit.has(l)).join('\n') !==
    r.auditLines.filter((l) => mAudit.has(l)).join('\n');
  return {
    ...empty,
    diverged:
      masterOnly.length > 0 ||
      refOnly.length > 0 ||
      changed.length > 0 ||
      masterOnlyAudit > 0 ||
      refOnlyAudit > 0 ||
      orderDiffers ||
      auditOrderDiffers,
    masterOnly,
    refOnly,
    changed,
    masterOnlyAudit,
    refOnlyAudit,
    orderDiffers,
    auditOrderDiffers,
  };
}

// ── THE accessor ────────────────────────────────────────────────────────────────────────────
// Every reader of the queue document goes through this (plan 3973 T1). Returns
//   { doc, parsed, sha, source, fetched, fault }
//   doc      the document text, always a VALIDATED queue doc (initialQueueDoc() when empty) —
//            every source passes through `validateQueueDoc` above, so a malformed or headerless
//            document is a `fault` with a synthesized empty doc, never data
//   parsed   that validation's own parse, so a caller never parses the same text twice
//   sha      the ref commit the doc came from (null when it came from elsewhere)
//   source   'ref'        the ref, freshened (or the local tracking ref when fetch: false)
//            'ref-cached' the local tracking ref, because this call's fetch FAILED
//            'master'     the ref is absent; the doc is origin/master's (pre-cut-over) table,
//                         from which the first write bootstraps the ref (D3)
//            'empty'      the ref is absent and there is no master table: a fresh queue
//            'none'       nothing readable — `doc` is a synthesized empty queue, which a
//                         reporter must say is empty because NOTHING COULD BE READ
//   fetched  false whenever the RETURNED DOC did not come from a fetch that succeeded — the
//            fetch was attempted and failed, or none was asked for (`fetch: false` and the
//            `fetchIfAbsent` fetch never fired, because the tracking ref was already there), or
//            the answer rests on the master read — the pre-cut-over table, or the `empty` verdict
//            its tombstone/absence gives — and it was origin/master's fetch that failed; either
//            way the doc may be arbitrarily stale, and a reporter must SAY so rather than
//            present it as the queue
//   fault    an Error when the read cannot be trusted: the ref unreadable, or the D4 loud-fail
//            (a non-tombstone master doc beside a live ref — see migrateNeededMessage)
// `loudFail` defaults to `fetch`: the fetching readers (the verbs, the watcher via `status`,
// reconcile-board) carry the D4 check; the no-fetch hot-path readers (redgreen's statusline
// tick, session-priority's spawn path) skip its two extra git spawns — they are fail-open
// reporters, and the next fetching reader refuses for everyone anyway. `loudFail: false` is also
// what the heal itself (`migrate`) passes.
export function readQueueDoc(
  mainDir,
  { fetch = true, fetchIfAbsent = false, gitImpl = coordGit, loudFail = fetch } = {},
) {
  const r = readQueueRef(mainDir, { fetch, fetchIfAbsent, gitImpl });
  // What the READ actually did, not what was asked for: a `fetch: false` reader that took the
  // `fetchIfAbsent` fetch did freshen the ref, and one that did not is looking at a tracking ref
  // of unknown age. The statusline keys its "may be stale" marking off exactly this.
  const freshened = r.fetched === true;
  // …and the master doc's own freshness, which is NOT the ref's: the master fallback below is a
  // different document on a different ref, so it reports `fetched` from this flag alone.
  const masterFresh = r.masterFetched === true;
  let parsed = null;
  if (r.state === 'fault' && r.fetchFailed) {
    // Degrade to the cached tracking ref for the doc, but say the fetch failed: a reporter shows
    // the last-known queue, a displacing verb refuses on `fetched: false`. The cached text gets
    // the SAME validation the fetched one does — a malformed doc that happened to be cached is
    // no more an empty queue than a malformed doc that was just fetched.
    const cached = readQueueRef(mainDir, { fetch: false, gitImpl });
    if (cached.state === 'present') {
      const v = validateQueueDoc(
        cached.doc,
        `the cached queue document on ${QUEUE_REF_LOCAL}` +
          `${cached.sha ? ` (${String(cached.sha).slice(0, 10)})` : ''}`,
        `git show ${cached.sha ?? QUEUE_REF_LOCAL}:${QUEUE_DOC_NAME}`,
      );
      if (v.fault) return unreadable(v.fault);
      return {
        doc: cached.doc,
        parsed: v.parsed,
        sha: cached.sha,
        source: 'ref-cached',
        fetched: false,
        fault: null,
      };
    }
    return unreadable(r.error);
  }
  if (r.state === 'fault') {
    return unreadable(r.error, { fetched: freshened });
  }
  if (r.state === 'present') {
    const v = validateQueueDoc(
      r.doc,
      `the queue document on ${QUEUE_REF}${r.sha ? ` (${String(r.sha).slice(0, 10)})` : ''}`,
      `git show ${r.sha ?? QUEUE_REF}:${QUEUE_DOC_NAME}`,
    );
    if (v.fault) return unreadable(v.fault, { fetched: freshened });
    parsed = v.parsed;
  }
  // The master doc is consulted only where it can change the answer: the seed view for an
  // absent ref (D3), and the D4 check when this reader carries it.
  const master =
    r.state === 'absent' || loudFail
      ? readMasterQueueDoc(mainDir, { gitImpl })
      : { state: 'skipped' };
  if (r.state === 'absent') {
    // A master doc that could not be READ is not an empty queue: with the ref absent too, the
    // next write would bootstrap from this document, so an unreadable one must refuse instead
    // of seeding a queue that silently loses every waiter (key ee6e2a).
    //
    // …but only for a reader that CARRIES the loud fail, symmetrically with the ref-present
    // branch below (plan 3973 review round 2, key 288fc9). `loudFail: false` is the heal's own
    // flag: `migrate` read origin/master's doc itself, folds THAT copy, and tombstones it in the
    // same coordWrite — so a transient failure of the accessor's SECOND, redundant master read
    // must not abort the one bounded heal every other reader's refusal points at.
    if (master.state === 'fault' && loudFail) {
      return unreadable(masterReadFault(master), { fetched: freshened });
    }
    if (master.state === 'present') {
      // The pre-cut-over table is a queue document like any other: it goes through the SAME
      // validation (a corrupt one must not read as an empty queue and seed the ref from it),
      // and its `fetched` is the MASTER fetch's outcome, never the ref probe's — the ref's
      // absence being proven says nothing about how old this checkout's origin/master is.
      const v = validateQueueDoc(
        master.raw,
        `the pre-3973 queue doc (${master.rel}) at origin/master`,
        `git show origin/master:${master.rel}`,
      );
      if (v.fault) return unreadable(v.fault, { fetched: masterFresh });
      return {
        doc: master.raw,
        parsed: v.parsed,
        sha: null,
        source: 'master',
        fetched: masterFresh,
        fault: null,
      };
    }
    // "There is no queue anywhere" rests on the MASTER read as much as on the ref probe: the
    // tombstone (or the absent path) was read off this checkout's origin/master, so when that
    // fetch failed the answer may be a snapshot predating every waiter the live master doc
    // carries. Reporting it fresh is what let a write bootstrap an empty ref over them (plan
    // 3973 review round 4, keys b96256 / 7ed479 / 714a0e).
    return {
      doc: initialQueueDoc(),
      parsed: EMPTY_PARSE,
      sha: null,
      source: 'empty',
      fetched: freshened && masterFresh,
      fault: null,
    };
  }
  let fault = null;
  if (loudFail && master.state === 'fault') {
    // The D4 check could not be answered — the master doc may be a live old-code queue. A
    // reader that carries the check refuses rather than pass it vacuously.
    fault = masterReadFault(master);
  } else if (loudFail && master.state === 'present') {
    // The master side of the comparison is a queue document like any other, so it meets the one
    // validation point too (plan 3973 review round 4, key 4c907e): a headerless master table
    // parses to `entries: []`, and without this it compared EQUAL to an empty ref and passed the
    // check silently — after which `migrate` would tombstone it and drop its waiter. A document
    // that does not validate cannot be proven equal, so it is reported as divergence-unparseable
    // and the refusal names the same heal. Both sides pass their already-validated parse in.
    const v = validateQueueDoc(
      master.raw,
      `the pre-3973 queue doc (${master.rel}) at origin/master`,
      `git show origin/master:${master.rel}`,
    );
    const divergence = masterDocDivergence(v.parsed, parsed);
    if (divergence.diverged) fault = new Error(migrateNeededMessage(master.rel, divergence));
  }
  return { doc: r.doc, parsed, sha: r.sha, source: 'ref', fetched: freshened, fault };
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────

// One CAS write: blob → tree → commit (parent = the tip we read, or none for a bootstrap) →
// NON-force push. `{ ok: true, sha }` on a win; `{ ok: false, nonFf: true, error }` when origin
// rejected the push as a non-fast-forward (a rival wrote first — the caller re-reads and
// retries); THROWS on any other push failure (auth, network, a hook) — see the fail-safe above.
export function writeQueueRefCAS(mainDir, { parentSha = null, doc, message, gitImpl = coordGit }) {
  if (typeof doc !== 'string' || !doc) throw new Error('landing-queue-ref: doc must be text');
  const blob = gitImpl(mainDir, ['hash-object', '-w', '--stdin'], { input: doc }).trim();
  const tree = gitImpl(mainDir, ['mktree'], {
    input: `100644 blob ${blob}\t${QUEUE_DOC_NAME}\n`,
  }).trim();
  const args = ['commit-tree', tree, '-m', message];
  if (parentSha) args.splice(2, 0, '-p', parentSha);
  const commit = gitImpl(mainDir, args).trim();
  try {
    // gitWithLockRetry: the push also updates the local tracking ref, and under 5–7 sessions
    // sharing one `.git` that ref-lock can race a sibling's fetch (a transient, retried there).
    // A non-ff rejection is NOT a lock condition, so it surfaces immediately, as required.
    gitWithLockRetry(mainDir, ['push', '--quiet', 'origin', `${commit}:${QUEUE_REF}`], {
      env: HUSKY0,
      _git: gitImpl,
      ...QUIET,
    });
  } catch (error) {
    const r = classifyPushResult({ ok: false, stderr: errText(error) });
    if (r.lost) return { ok: false, nonFf: true, error };
    throw error;
  }
  // A single-branch clone's push does not touch refs/remotes/origin/*; pin the local view to what
  // origin now holds so a no-fetch reader (redgreen, session-priority) sees this write at once.
  // COMPARE-AND-SWAP on the local ref (plan 3973 review, key 58b143): between our push and this
  // line a sibling can fetch a NEWER tip into the same tracking ref (5–7 sessions share one
  // `.git`), and an unconditional set would REWIND the local view over the sibling's write —
  // exactly the stale-doc failure a no-fetch reader cannot detect. Pass the tip we built on as
  // the expected old value (the all-zero oid for a bootstrap: "this ref must not exist yet"), so
  // the update applies only while the local view is still the one we wrote from.
  try {
    gitImpl(mainDir, ['update-ref', QUEUE_REF_LOCAL, commit, parentSha || ZERO_OID], QUIET);
  } catch {
    // Someone else moved it — never force it backwards; re-fetch so the local view ends up at
    // least as new as origin (best effort; the next fetching read refreshes it anyway).
    fetchQueueRef(mainDir, { gitImpl });
  }
  return { ok: true, sha: commit };
}

// The parentless seed for the ABSENT case (plan 3973 D3). A lost race means a sibling seeded
// first: re-read and hand back the winner's view so the caller can re-run its transform on it.
export function bootstrapQueueRef(mainDir, doc, { message, gitImpl = coordGit } = {}) {
  const w = writeQueueRefCAS(mainDir, {
    parentSha: null,
    doc,
    message: message ?? `coord(queue): bootstrap ${QUEUE_REF} (plan 3973)`,
    gitImpl,
  });
  if (w.ok) return { ok: true, sha: w.sha };
  return { ok: false, nonFf: true, winner: readQueueRef(mainDir, { fetch: true, gitImpl }) };
}

// The jittered back-off between CAS attempts (200–800 ms). Injectable so the unit tests do not
// sleep; `Atomics.wait`-based because the whole file family is synchronous.
export function jitteredSleep(sleep = sleepSync) {
  sleep(200 + Math.floor(Math.random() * 600));
}

// The bounded read → transform → CAS loop every queue verb writes through (plan 3973 D2).
//   mutate(doc, { queueSha, attempt, source }) returns the NEW doc text (or the same text /
//   null for "no change"). It is RE-RUN on every attempt against the freshened doc — that
//   re-run is what makes concurrent writes commute — so it must be a pure function of its input.
// Returns { sha, attempts, unchanged, bootstrapped }; throws after the last attempt, or at once
// on a read fault (the verb must not write over a queue it could not read).
//   - An ABSENT ref is materialized by the first write (even from an unchanged doc), so the next
//     reader pays no master-doc fallback — EXCEPT while origin/master still carries the
//     pre-3973 table, where only `migrate` (which passes `loudFail: false` and tombstones the
//     master doc in the same motion) may seed it. See the refusal in the loop.
//   - A present ref with an unchanged doc is a no-op: no commit, `sha` = the tip read — the
//     twin of coordWrite's empty-diff short-circuit, which dequeue's idempotency relied on.
export function mutateQueueRef(
  mainDir,
  {
    message,
    mutate,
    attempts = QUEUE_CAS_ATTEMPTS,
    gitImpl = coordGit,
    sleep = jitteredSleep,
    loudFail = true,
    commitMessage = (attempt) =>
      `${message}\n\n${QUEUE_ATTEMPT_TRAILER}: ${attempt}\nCoord-Write: landing-queue`,
  },
) {
  if (typeof mutate !== 'function') throw new Error('landing-queue-ref: mutate required');
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const view = readQueueDoc(mainDir, { fetch: true, gitImpl, loudFail });
    if (view.fault) {
      throw Object.assign(
        new Error(`landing-queue-ref: cannot write the queue — ${view.fault.message}`),
        { cause: view.fault, refusal: true },
      );
    }
    if (!view.fetched) {
      // `fetched` is the freshness of the doc actually returned, so this also catches the
      // pre-cut-over shape where the ref is absent and it was ORIGIN/MASTER's fetch that failed:
      // seeding the ref from a stale master table would drop every waiter added since.
      throw Object.assign(
        new Error(
          `landing-queue-ref: cannot write the queue — the queue document (source ` +
            `${view.source}) could not be fetched from origin, so it may be stale. Fix ` +
            `connectivity to origin and retry.`,
        ),
        { refusal: true },
      );
    }
    if (view.source === 'master' && loudFail) {
      // The ref does not exist yet and origin/master still carries the pre-3973 TABLE. Seeding
      // the ref from it here would be a split brain one write later: the ref would carry this
      // write, the master doc would not, and the D4 identity check would then refuse for every
      // reader until someone healed it. Only `migrate` may cross that line, because it seeds
      // and TOMBSTONES the master doc in one motion — which is why it, and only it, disarms the
      // loud fail (plan 3973 review, keys 0ad6b9 / 324e39).
      throw Object.assign(
        new Error(
          `landing-queue-ref: cannot write the queue — ${QUEUE_REF} has never been written and ` +
            `the pre-3973 queue table on origin/master is still the live document. Run ` +
            `\`node scripts/landing-queue.mjs migrate\` to seed the ref from it and tombstone ` +
            `the master doc; until then this write would leave two divergent queues.`,
        ),
        { refusal: true },
      );
    }
    const next = mutate(view.doc, { queueSha: view.sha, attempt, source: view.source });
    const doc = next == null ? view.doc : next;
    if (view.sha && doc === view.doc) {
      return { sha: view.sha, attempts: attempt, unchanged: true, bootstrapped: false };
    }
    const w = writeQueueRefCAS(mainDir, {
      parentSha: view.sha,
      doc,
      message: commitMessage(attempt),
      gitImpl,
    });
    if (w.ok) {
      return { sha: w.sha, attempts: attempt, unchanged: false, bootstrapped: !view.sha };
    }
    last = w.error;
    if (attempt < attempts) sleep();
  }
  const err = new Error(
    `landing-queue-ref: ${QUEUE_REF} contended after ${attempts} attempts (every CAS push was ` +
      `rejected non-fast-forward) — a sibling is writing the queue faster than this session can ` +
      `re-read it; retry.`,
  );
  err.cause = last;
  throw err;
}
