#!/usr/bin/env node
// scripts/local-drain-filter.mjs — the /local-drain Step-2 cloud-eligibility filter (plan 2396).
//
// WHY THIS FILE EXISTS: the /local-drain runbook (`docs/coord/local-drain-loop.md`; it lived
// at `.claude/commands/local-drain.md` until plan 2694 relocated it) carried this filter as an inline
// `node - <<'EOF'` snippet whose stamp read was
//
//     fs.readFileSync(p,'utf8').slice(0,1500).match(/^cloudExec:\s*(\S+)/m)
//
// A plan's frontmatter LEADS with `summary:`, routinely a multi-sentence paragraph (2378's is
// ~1900 characters on its own), so `cloudExec:` frequently sits BEYOND byte 1500 — the regex then
// finds nothing and the stamp reads `unset`. `unset` counts as locally-executable, so a
// CLOUD-RESERVED plan gets offered to the local session. Measured on the 2026-07-25 board: 4 of
// the 11 offered plans misread, 2 of them in the unsafe direction (a `cloudExec: true` plan was
// claimed, cut, and had to be derailed mid-run).
//
// The fix is not a better regex — it is to stop hand-rolling a frontmatter parser at all. The ONE
// reader already exists: `readFrontmatterScalar` (build-index-lib.mjs), which `queue-drain.mjs`
// itself uses for these exact stamps. It is frontmatter-SCOPED (no byte window), CRLF-safe, and
// strips a trailing YAML inline comment (`cloudExec: true # …`) — a third class the byte-slice
// regex also got wrong. build-index-lib.mjs is sibling-ADOPTED (`coord.config.json`): importing
// it needs no sibling sync, EDITING it would — so this module only ever reads through it.
//
// A markdown command body cannot import an ESM module from a heredoc, and a heredoc cannot be
// unit-tested, so the filter lives here as a real module with a CLI entry point and the command
// body just calls it. That is also what makes the plan-2396 regression pin possible: a fixture
// plan whose `summary:` exceeds 1500 bytes must classify as cloud-eligible.
//
// eligibility authority: NOT this file. `scripts/queue-drain.mjs` decides what is drainable at all
// (both lanes); this module only partitions the oracle's `eligible[]` by the `cloudExec:` stamp.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { frontmatterEnd, readFrontmatterScalar } from './build-index-lib.mjs';

const execFileAsync = promisify(execFile);

// The two NON-value stamp readings, kept as named constants because both the filter's own
// bucketing and the command's end-of-run "unstamped" reporting compare against them.
// `unset` — a real frontmatter block that omits `cloudExec:`. `no-frontmatter` — no leading
// `---` block at all. Acceptance criterion 4 of plan 2396: these two must be reported
// DISTINCTLY. They are treated identically for eligibility (both mean "not stamped
// cloud-eligible" ⇒ local, matching the command's contract and queue-drain's `cloudExec !==
// 'true'` gate) but never collapsed in the OUTPUT, because a no-frontmatter plan is a
// malformed-file signal while `unset` is ordinary stamping debt.
export const UNSET = 'unset';
export const NO_FRONTMATTER = 'no-frontmatter';

// The stamp values that mean something to the filter. Anything else (a typo, `yes`, `True ish`)
// is carried through verbatim and WARNED about: it stays local, because only an explicit `true`
// admits a plan to the cloud drains — the same stall-not-damage direction queue-drain takes.
//
// `true` is deliberately ABSENT: it is consumed by the `stamp === 'true'` branch in
// partitionPools and `continue`s before this set is ever consulted, so listing it here would be
// dead weight that ALSO papers over a future reordering — if that early branch were removed,
// a pre-listed `true` would suppress the UNRECOGNIZED warning and let a cloud-reserved plan
// slide into localOnly silently, which is the exact failure plan 2396 exists to prevent.
const KNOWN_STAMPS = new Set(['false', UNSET, NO_FRONTMATTER]);

// Read the `cloudExec:` stamp from a plan file's CONTENT. Never a byte prefix: the frontmatter
// block is located by the repo's single fence rule (frontmatterEnd) and the scalar read by the
// repo's single frontmatter reader (readFrontmatterScalar), lower-cased for comparison.
export function readCloudExecStamp(content) {
  const text = String(content);
  // readFrontmatterScalar returns '' both for "no frontmatter" and for "key absent" — the
  // distinction acceptance criterion 4 needs, so ask frontmatterEnd directly for it.
  if (frontmatterEnd(text.split(/\r?\n/)) === -1) return NO_FRONTMATTER;
  const raw = readFrontmatterScalar(text, 'cloudExec');
  return raw ? raw.toLowerCase() : UNSET;
}

// The plans ROOT, used to tell a vanished FILE apart from a vanished TREE. queue-drain.mjs emits
// repo-relative paths, so both failures arrive as ENOENT and only the root's existence
// distinguishes them.
export const PLANS_ROOT = 'docs/superpowers/plans';

// Read one plan file's stamp, classifying a read FAILURE by kind. The old snippet mapped every
// read error to `null` → `staleDropped`, which is correct ONLY for the mid-move race it was
// written for (a parallel session claimed/re-filed the plan between the oracle's listing and
// this read ⇒ ENOENT). Any OTHER errno is a real defect — a permission problem, a directory
// where a file is expected — and must not masquerade as queue churn (plan 2396 task 4).
//
// ENOENT IS NOT ENOUGH ON ITS OWN to call it a race (plan 2396 review finding [0]). A wrong cwd
// — the very defect this file's header warns about, since the oracle emits repo-RELATIVE paths —
// makes EVERY read throw ENOENT too, and routing that to the tolerated bucket is precisely the
// "systematic parse regression masquerading as queue churn" task 4 forbids. Discriminate on the
// PLANS ROOT: if `docs/superpowers/plans` resolves from the cwd, the tree is there and a single
// missing file really is the mid-move race; if the root itself is absent, the cwd is wrong and
// every read is about to fail for one systematic reason. `exists` is injectable for tests.
export function stampFor(
  planPath,
  { readFile = (p) => readFileSync(p, 'utf8'), exists = (p) => existsSync(p) } = {},
) {
  let content;
  try {
    content = readFile(planPath);
  } catch (e) {
    const code = (e && e.code) || 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Windows reports ENOTDIR when a parent path component vanished; same two cases apply.
      if (exists(PLANS_ROOT)) return { kind: 'missing', code };
      return {
        kind: 'unreadable',
        code,
        message:
          `${code} reading ${planPath}, and the plans root ${PLANS_ROOT} does not resolve from ` +
          `the current directory either — this is a WRONG CWD, not the mid-move race. Run the ` +
          `filter from the MAIN checkout.`,
      };
    }
    return { kind: 'unreadable', code, message: (e && e.message) || String(e) };
  }
  return { kind: 'stamp', stamp: readCloudExecStamp(content) };
}

// Partition the oracles' eligible[] lists into the four buckets /local-drain acts on, plus a
// human `warnings[]` list. `pools` is [[laneName, oracleResult], …].
//
//   localOnly[]            — pick from this ONLY. stamp false / unset / no-frontmatter / unknown.
//   droppedCloudEligible[] — stamp `true`, or a `landOnly` /cloud-land hand-off (plan 4255): reserved for the scheduled cloud drains.
//   staleDropped[]         — file vanished mid-read: a mid-move race, re-read next iteration.
//   unreadable[]           — read failed for a NON-race reason: a defect, surfaced loudly.
//
// plan 2421: `queue-drain.mjs` now carries the ALREADY-COMPUTED, richer-enum stamp on each
// `eligible[]` entry as `e.cloudExec` (via the same `readCloudExecStamp` this module exports —
// one normalization, not two). When present, the CONTENT re-read + re-normalization below is
// skipped for that entry — but a cheap existsSync still runs first (sonnet-review fix [0]): the
// oracle listed `e.path` at its own scan time, and a plan can move out of `ready/` (another
// session's claim/re-file) between that scan and this filter running, exactly the mid-move race
// staleDropped[] exists to catch. Trusting the supplied stamp with NO existence check at all
// would make that race silently invisible on the (now common) oracle-supplied path — an
// existsSync is orders of magnitude cheaper than the readFile+parse it replaces, so the race
// guard survives at effectively no cost. The full `stampFor` (existence AND content) fallback
// below fires only when the field is absent — an oracle that predates this plan.
// plan 3461 made a `sol` plan admissible LANE-AGNOSTICALLY: queue-drain.mjs's `--lane` gate
// (chain position ~8) never excludes an `execModel: sol` plan under EITHER the default (sonnet)
// or `--lane fable` invocation, so its `eligible[]` entry is reported by BOTH oracle runs — the
// same file, read twice. A genuine sonnet- or fable-native plan can never do this: queue-drain
// excludes it from the OTHER lane's run outright (`exclude: 'fable'` / the sonnet-lane
// equivalent), so it only ever reaches ONE pool's `eligible[]`.
//
// plan 3461 round 2: round 1 fixed this by INFERRING the lane from the accident of a second,
// differently-labelled sighting — the FIRST sighting kept its pool's raw label, and only a
// second sighting under a DIFFERENT pool label rewrote it to `'sol'`. That is backwards: a `sol`
// plan seen in only ONE pool (a partial oracle result, one lane's spawn failing, or the plan
// simply not surfacing twice in a given run) never got its second sighting, so it kept the raw
// sonnet/fable pool label and `/local-drain` dispatched a Claude worker for it instead of
// `codex exec` — silently, and it defeats the whole point of the lane. The lane must never
// depend on how many times a plan happened to be seen.
//
// The fix: queue-drain.mjs (`toItem`, plan 3461 round 2) now stamps EVERY `eligible[]` entry
// with its OWN resolved lane (`e.lane`, read straight off the plan's `execModel` via the one
// fail-closed resolver) — this module reads that field directly instead of trusting the pool
// label at all. `dedupeBySlug` is now a pure MERGE-not-INFER step: it folds a repeat sighting
// into the first entry and, since both sightings carry their own already-correct `lane`, treats
// a disagreement between them as an ANOMALY to surface (a race between the two independent
// oracle spawns, or a queue-drain bug) rather than a signal to act on.
//
// plan 3461 round 3: a disagreement is now WITHHELD from this cycle's output entirely — neither
// bucket — rather than "keep the first sighting". Round 2's keep-the-first rule quietly trusted
// whichever spawn's `Promise.all` slot resolved first, which is arbitrary: the sonnet and fable
// oracle spawns race each other, so "first" carries no information about which read is the
// STALE one. A `cloudExec: true` edit landing between the two independent scans can just as
// easily be visible only to the SECOND (discarded) sighting, which is exactly the case this
// partition exists to catch — handing a plan that just became cloud-reserved to the local drain.
// Withholding both this cycle costs nothing but one drain tick (the loop is cadence-driven, not
// one-shot), and it needs no judgment call about which side is "safer": a lane disagreement
// (same bucket, different resolved lane) has no obvious safer side the way a bucket disagreement
// does, so a uniform withhold-and-re-read-next-tick rule covers both without picking sides.
function dedupeBySlug(bucketsByName, ledger, bucketName, slug, lane, makeEntry, warnings) {
  const prior = ledger.get(slug);
  if (prior) {
    if (prior.withheld) return; // already pulled for a disagreement — nothing more to do
    // A genuine sol plan's two sightings always carry the SAME already-resolved lane (both
    // reads see the same file's execModel) and land in the same bucket (both reads see the
    // same cloudExec stamp) — this is the ordinary, expected merge. A mismatch on either axis
    // means the two independent oracle scans disagreed — most likely a concurrent stamp edit
    // between them — which is a data anomaly to surface, not a hint to act on.
    if (prior.bucket !== bucketName || prior.lane !== lane) {
      warnings.push(
        `INCONSISTENT SIGHTING ${slug}: first seen as ${prior.bucket}/${prior.lane}, also ` +
          `reported as ${bucketName}/${lane} — the two independent oracle runs disagree, most ` +
          `likely a concurrent execModel/cloudExec stamp edit between their two scans. Withheld ` +
          `from BOTH buckets this cycle (neither "first" sighting is trustworthy — the race is ` +
          `arbitrary) — the next drain tick re-reads a settled stamp.`,
      );
      const arr = bucketsByName[prior.bucket];
      const idx = arr.indexOf(prior.entry);
      if (idx !== -1) arr.splice(idx, 1);
      ledger.set(slug, { withheld: true });
    }
    return;
  }
  const entry = makeEntry();
  ledger.set(slug, { bucket: bucketName, lane, entry });
  bucketsByName[bucketName].push(entry);
}

export function partitionPools(pools, { readFile, exists = existsSync } = {}) {
  const localOnly = [];
  const droppedCloudEligible = [];
  const staleDropped = [];
  const unreadable = [];
  const warnings = [];
  // ONE ledger across BOTH eligibility buckets (plan 3461 round 2 finding, [:170]/[:215] in the
  // pre-fix file): a per-BUCKET Map (the round-1 shape) only caught a repeat sighting that
  // landed in the SAME bucket both times. A slug whose two independent oracle scans disagree on
  // `cloudExec` (a concurrent stamp edit between the sonnet and fable spawns, however rare) would
  // resolve to a DIFFERENT bucket on each sighting — the localOnly Map has never seen it, the
  // droppedCloudEligible Map has never seen it either, so both bucketing branches call it a
  // fresh slug and it survives in BOTH output buckets at once. One ledger keyed by slug alone
  // (not by (bucket, slug)) makes a bucket-crossing sighting visible to dedupeBySlug the same as
  // an ordinary same-bucket repeat — and (plan 3461 round 3) lets it splice the first sighting
  // back OUT of whichever bucket it landed in once a disagreement is found, so the withheld slug
  // ends up in neither.
  const ledger = new Map();
  const bucketsByName = { local: localOnly, dropped: droppedCloudEligible };
  // staleDropped[] and unreadable[] below are DELIBERATELY NOT deduped by slug, unlike the two
  // eligibility buckets above. A sol plan CAN hit either path twice (once per pool's own
  // existsSync/readFile call), but the two lane passes run genuinely independently — one race
  // window's ENOENT is not guaranteed to be the other's, since the file could vanish (or a
  // permission bit change) between the two checks. Collapsing them would risk hiding a real
  // per-lane difference behind a merge that only exists to fix a cosmetic double-print; the
  // eligible/dropped merge above exists for a REPORTING correctness reason (routing a sol pick
  // to the wrong worker tier), which these two buckets don't share. A duplicated diagnostic line
  // here is noise the operator reads past, not a wrong decision downstream. These two stay
  // tagged with the POOL label (`poolLane`), not the resolved lane — they are about which SCAN
  // failed, not about where the plan routes.
  for (const [poolLane, res] of pools) {
    for (const e of (res && res.eligible) || []) {
      // The plan's OWN resolved lane (plan 3461 round 2) — read off the oracle entry itself,
      // never off `poolLane` (which only says which `--lane` invocation reported this
      // sighting). Falls back to `poolLane` only for an oracle predating this field.
      const lane = typeof e.lane === 'string' && e.lane ? e.lane : poolLane;
      let stamp;
      if (typeof e.cloudExec === 'string' && e.cloudExec !== '') {
        if (!exists(e.path)) {
          staleDropped.push({ slug: e.slug, lane: poolLane, path: e.path, code: 'ENOENT' });
          continue;
        }
        stamp = e.cloudExec;
      } else {
        const r = stampFor(e.path, { readFile, exists });
        if (r.kind === 'missing') {
          staleDropped.push({ slug: e.slug, lane: poolLane, path: e.path, code: r.code });
          continue;
        }
        if (r.kind === 'unreadable') {
          unreadable.push({
            slug: e.slug,
            lane: poolLane,
            path: e.path,
            code: r.code,
            message: r.message,
          });
          warnings.push(
            `UNREADABLE ${e.slug} (${poolLane}): ${e.path} failed to read with ${r.code} — this is ` +
              `NOT the mid-move race; the stamp could not be judged. Check the cwd (run from the ` +
              `MAIN checkout) before treating it as queue churn.`,
          );
          continue;
        }
        stamp = r.stamp;
      }
      // plan 4255: a `landOnly` entry is a /cloud-land hand-off — its build is done and its land
      // was deliberately sent to a cloud drain to keep the land battery off this box, so a local
      // drain leaves it alone whatever its cloudExec says (a local land is the operator's explicit
      // override, run by hand, never picked up by a drain).
      if (stamp === 'true' || e.landOnly === true) {
        // A sol plan stamped cloudExec: true is possible in principle (cloud-safe AND
        // codex-exec-eligible are independent axes) — merge it the same way as the localOnly
        // path below rather than assuming only local-only stamps can double up.
        dedupeBySlug(
          bucketsByName,
          ledger,
          'dropped',
          e.slug,
          lane,
          () => ({ slug: e.slug, lane }),
          warnings,
        );
        continue;
      }
      if (stamp === NO_FRONTMATTER) {
        warnings.push(
          `NO USABLE FRONTMATTER ${e.slug} (${poolLane}): ${e.path} has no COMPLETE leading ` +
            `\`---\` … \`---\` block — either the opening fence is missing, or (just as likely, ` +
            `from a truncated write or a bad merge) an opening \`---\` is present with no ` +
            `CLOSING fence. Check for both. It carries no stamps either way, and is counted as ` +
            `locally-executable (same as unset), but this is a malformed plan file, not ` +
            `ordinary stamping debt.`,
        );
      } else if (!KNOWN_STAMPS.has(stamp)) {
        warnings.push(
          `UNRECOGNIZED cloudExec: ${JSON.stringify(stamp)} on ${e.slug} (${poolLane}) — only an ` +
            `explicit \`true\` is cloud-eligible, so it stays local. Likely a stamping typo.`,
        );
      }
      // NOTE: warnings above (NO USABLE FRONTMATTER / UNRECOGNIZED) are NOT deduped — they fire
      // once per pool pass, so a sol plan hitting one of those paths produces two identical
      // warning lines. Left alone deliberately (see the file-level rationale below `warnings`
      // is returned): duplicated warning TEXT is noise, not corruption — the operator still
      // sees exactly one plan to fix, and merging would need tracking which (code, reason) key
      // a given slug already warned under, for a benefit that is purely cosmetic.
      dedupeBySlug(
        bucketsByName,
        ledger,
        'local',
        e.slug,
        lane,
        () => ({ ...e, lane, cloudExec: stamp }),
        warnings,
      );
    }
  }
  return { localOnly, droppedCloudEligible, staleDropped, unreadable, warnings };
}

// plan 3461 review: this function has NO sol-dedup fix, unlike partitionPools above, because a
// `sol` plan cannot appear in `runnableBatches[]` at all — `EXEC_LANE_TABLE.sol.batchable` is
// `false` (claim-plan-lib.mjs), and `claim-plan.mjs batch` refuses to form any batch containing
// a plan in a non-batchable lane (same file, `notBatchable` check). queue-drain.mjs's own
// `computeRunnableBatches` can therefore never place a sol member into a runnable train, so no
// batch entry is ever double-reported the way a solo eligible[] entry is. If `sol` ever becomes
// batchable, this function needs the same slug-merge partitionPools got.
//
// Partition the oracles' `runnableBatches[]` the same way (plan 2556). A batch-held plan is
// deliberately absent from `eligible[]` (the plan-2459 solo-claim hold), so before this
// existed a grouped pair was invisible to /local-drain entirely — the dead zone plan 2556
// closes: blocked from every drain by the hold, with no batch-capable executor anywhere.
//
//   localBatches[]              — takeable by THIS command, as one train.
//   droppedCloudEligibleBatches[] — every member stamped `true`: the scheduled cloud drains
//                                 own it (their own oracle call reports it runnable).
//
// A MIXED batch (some members `true`, some not) goes to localBatches WITH a loud warning,
// NOT to the dropped bucket. That is the one non-obvious call here, so it is stated
// explicitly: a mixed batch can never be runnable in the CLOUD lane, because its unstamped
// member is excluded as `cloud` at chain position 1 — before the batch gate at position 7 —
// so the cloud oracle never reports that batch at all. Withholding it locally too would
// re-create exactly the dead zone this plan exists to close. A local session is also
// strictly the more capable executor (`cloudExec: true` means cloud-SAFE, never cloud-ONLY),
// and taking it steals nothing from the cloud pool. The warning still fires because a mixed
// batch is a stamping defect a board-pass should resolve.
export function partitionBatches(pools, { readFile, exists = existsSync } = {}) {
  const localBatches = [];
  const droppedCloudEligibleBatches = [];
  const skippedBatches = [];
  const warnings = [];
  for (const [lane, res] of pools) {
    // The oracle's own withheld-train list, carried through verbatim (operator ruling
    // 2026-07-27: a train that cannot be taken is skipped with a LOGGED REASON, never
    // silently absent). Locally the usual cause is a member blocked underneath the hold or a
    // stale roster entry — either way the drain reports it instead of seeing "no batch".
    for (const sb of (res && res.skippedBatches) || []) skippedBatches.push({ ...sb, lane });
    for (const b of (res && res.runnableBatches) || []) {
      const paths = b.memberPaths || [];
      const stamps = [];
      let unresolvable = null;
      // plan 2421's optimization, applied to the batch path (plan 2556 review finding 6): the
      // oracle already read and normalized every member's stamp on this same scan and hands
      // them over as `memberCloudExec`, so re-reading each file here would duplicate exactly
      // the I/O the single-plan path stopped doing. A cheap existsSync still runs first — same
      // rationale as partitionPools: a member can leave ready/ between the oracle's scan and
      // this filter, and that mid-move race must stay visible rather than be trusted away.
      // The full stampFor fallback fires only when the field is absent (an older oracle).
      const supplied = Array.isArray(b.memberCloudExec) ? b.memberCloudExec : null;
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const s =
          supplied && typeof supplied[i] === 'string' && supplied[i] !== '' ? supplied[i] : null;
        if (s) {
          if (!exists(p)) {
            unresolvable = { path: p, code: 'ENOENT' };
            break;
          }
          stamps.push(s);
          continue;
        }
        const r = stampFor(p, { readFile, exists });
        if (r.kind !== 'stamp') {
          unresolvable = { path: p, code: r.code, message: r.message };
          break;
        }
        stamps.push(r.stamp);
      }
      if (unresolvable) {
        // One unreadable member makes the whole train un-judgeable — never guess it local.
        // Same mid-move-race tolerance the single-plan path has: the next iteration re-reads.
        warnings.push(
          `BATCH ${b.slug} (${lane}) skipped: member ${unresolvable.path} could not be read ` +
            `(${unresolvable.code}) so the train's cloud-eligibility is unjudgeable. ` +
            `${unresolvable.message ?? 'Likely the mid-move race — it re-reads next iteration.'}`,
        );
        continue;
      }
      const cloudCount = stamps.filter((s) => s === 'true').length;
      if (cloudCount === stamps.length && stamps.length > 0) {
        droppedCloudEligibleBatches.push({ slug: b.slug, lane, members: b.members });
        continue;
      }
      if (cloudCount > 0) {
        warnings.push(
          `MIXED cloudExec BATCH ${b.slug} (${lane}): ${cloudCount} of ${stamps.length} members ` +
            `are stamped \`true\`. Offered LOCALLY anyway — a mixed batch is never runnable in ` +
            `the cloud lane (an unstamped member is excluded before the batch gate), so ` +
            `withholding it here would leave it unexecutable everywhere. Worth a board-pass ` +
            `look: the members disagree about cloud-safety.`,
        );
      }
      localBatches.push({ ...b, lane, memberCloudExec: stamps });
    }
  }
  return { localBatches, droppedCloudEligibleBatches, skippedBatches, warnings };
}

// --- CLI --------------------------------------------------------------------

// Run the queue-drain oracle for one lane. Same tolerance the inline snippet had: queue-drain
// exits non-zero in ordinary "nothing eligible" situations, and its JSON is on stdout either
// way, so parse e.stdout before giving up on an empty pool.
//
// plan 2421: the default `exec` is now `execFileAsync` (a promisified `execFile`), which
// resolves `{stdout, stderr}` on success and REJECTS with an error carrying `.stdout`/`.stderr`
// on a non-zero exit (Node's documented promisify(execFile) shape) — so the non-zero-exit
// tolerance below is unchanged, only the spawn itself is now async/non-blocking. `await`ing a
// plain string (what the test suite's synchronous `exec` stubs return) resolves to that string
// unchanged, so the existing sync-stub tests keep passing without modification.
//
// plan 3461 round 4 (review finding): a genuine oracle CRASH (a bad flag, a spawn failure, a
// broken import in queue-drain.mjs or a sibling it requires) used to degrade to `{eligible:
// []}` — indistinguishable, downstream, from "the oracle ran and legitimately found nothing".
// The two are NOT the same: an empty pool is a plausible-looking board that reads as "nothing to
// do" while a live regression hides behind it. Mirroring ready-board.mjs's `runOracle`, a
// failure whose stdout does not parse now THROWS instead of degrading — the legitimate exit-1
// empty-lane case (queue-drain exits non-zero but still prints its JSON) is UNCHANGED above this
// point and never reaches the throw. The per-lane failure-tolerance contract `main()` documents
// below still holds: this function no longer swallows a crash for its OWN caller, but it is
// `main()`'s job (not this function's) to make sure one lane's throw never stops the other
// lane's spawn from being used.
//
// plan 3461 round 5 (finding fcf89a, CONFIRMED): the crash-recovery branch used to accept ANY
// value `JSON.parse(e.stdout)` happened to produce — `null`, a bare scalar, an array all parse
// cleanly and all used to `return` here as if they were a real oracle result. The two
// partitioners then read the result via `(res && res.eligible) || []`, which folds every one of
// those into a false-EMPTY pool — precisely the plausible-looking "0 eligible" misreport round
// 4's throw exists to prevent. A recovered value must be a non-null, non-array OBJECT to be
// trusted; anything else falls through to the same loud throw below as an unparseable crash.
export async function runOracle(args, { exec = execFileAsync } = {}) {
  try {
    const result = await exec('node', ['scripts/queue-drain.mjs', ...args], {
      encoding: 'utf8',
      maxBuffer: 1e8,
    });
    const stdout = typeof result === 'string' ? result : result.stdout;
    return JSON.parse(stdout);
  } catch (e) {
    let recovered;
    try {
      recovered = JSON.parse(e.stdout);
    } catch {
      recovered = undefined;
    }
    if (recovered === null || typeof recovered !== 'object' || Array.isArray(recovered)) {
      throw new Error(
        `local-drain-filter: the queue-drain oracle failed and printed no parseable JSON for ` +
          `\`node scripts/queue-drain.mjs ${args.join(' ')}\` — this lane's pool is UNKNOWN this ` +
          `cycle, not empty. Refusing to report it as "0 eligible", since that would look like a ` +
          `plausible, healthy board while a live regression hides behind it.\n` +
          (e?.stderr || e?.message || e),
      );
    }
    return recovered;
  }
}

// plan 3461 round 5 (finding fe729e, PLAUSIBLE): `laneNames` used to be a bare array of NAMES,
// held in sync only by POSITION with a separately-written `Promise.allSettled([...])` array of
// spawn calls below — a future lane add/reorder could update one and not the other, mislabelling
// an oracle failure and excluding the wrong pool from this cycle's output. ONE table names each
// lane and its own CLI args exactly once; both the spawn list and the settled-results walk below
// are derived from IT, so the two can no longer disagree about which entry is which lane.
const LANES = [
  { name: 'sonnet', args: [] },
  { name: 'fable', args: ['--lane', 'fable'] },
];

// plan 2421 [3]: the two lane oracles are fully independent (each scans the whole `ready/`
// board once) — running the two `execFile` spawns concurrently instead of blocking sequentially
// on each roughly halves Step-2 wall-clock.
//
// plan 3461 round 4: failure tolerance is per-lane and unchanged in EFFECT — one lane's spawn
// failure never blocks or prevents the other lane's plans from being offered — but the SHAPE
// changed from "each runOracle degrades to {eligible:[]} on its own" to "each lane's outcome is
// caught independently, right here". `runOracle` above now THROWS on a genuine crash rather than
// swallowing it, so `Promise.all` (which rejects as soon as ANY input rejects, discarding the
// other lane's result) would turn one lane's crash into a hard failure of the WHOLE filter —
// exactly the coupling this comment has always promised does not happen. `Promise.allSettled`
// keeps the two spawns concurrent (same wall-clock win) while resolving each independently: a
// crashed lane is reported as a LOUD, specific warning and excluded from this cycle's pool
// (`partitionPools`/`partitionBatches` already treat a `null` pool as empty, via their existing
// `(res && res.eligible) || []` guards — no change needed there), while the surviving lane's
// pool is used exactly as it would be on any other cycle. The next drain tick re-runs the failed
// lane's oracle fresh, so a transient crash costs one tick, never a stall of the healthy lane.
export async function main({
  exec,
  readFile,
  exists,
  log = console.log,
  warn = console.error,
} = {}) {
  const settled = await Promise.allSettled(LANES.map((lane) => runOracle(lane.args, { exec })));
  const oracleFailures = [];
  const pools = settled.map((r, i) => {
    const { name } = LANES[i];
    if (r.status === 'fulfilled') return [name, r.value];
    oracleFailures.push(
      `ORACLE FAILURE (${name} lane): ${r.reason?.message ?? r.reason} — this lane's ` +
        `pool is UNKNOWN this cycle, not empty, so it is excluded from local/dropped/batches ` +
        `rather than reported as "0 eligible". The other lane is unaffected and still ran.`,
    );
    return [name, null];
  });
  const plans = partitionPools(pools, { readFile, exists });
  const batches = partitionBatches(pools, { readFile, exists });
  // One `warnings[]` on the output, as the command body documents — a caller must not have
  // to know that two partitioners (plus a possible oracle failure) produced it.
  const out = {
    ...plans,
    localBatches: batches.localBatches,
    droppedCloudEligibleBatches: batches.droppedCloudEligibleBatches,
    skippedBatches: batches.skippedBatches,
    warnings: [...oracleFailures, ...plans.warnings, ...batches.warnings],
  };
  log(JSON.stringify(out, null, 2));
  for (const w of out.warnings) warn(`local-drain-filter: ${w}`);
  return out;
}

// `node scripts/local-drain-filter.mjs` — the whole of /local-drain's Step-2 filter.
//
// Identity test rather than a basename `endsWith` (plan 4061): `endsWith` would still match once
// coord-core step 4 moves this module behind a shim at the same invoked path, firing the CLI in
// both files. Behaviour today is identical — see the note in `gate-pass-cache.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
