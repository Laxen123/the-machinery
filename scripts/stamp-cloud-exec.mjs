#!/usr/bin/env node
// scripts/stamp-cloud-exec.mjs  (plan 1781, Gap 2)
//
// Stamp a plan's `cloudExec: true|false` frontmatter axis — the dedicated
// "is this plan safe to run in an unattended CLOUD drain" signal, distinct from
// `execModel:` (which answers reasoning COST, not cloud-safety). Stamped at
// spec-pass time by the heavy model that already read the whole plan; the cloud
// drain then reads it via `queue-drain.mjs --cloud` instead of re-deriving cloud
// eligibility from a fragile in-prompt grep of external-key/seed keywords (the
// Gap-2 mis-fire this plan closes: a plan needing Playwright/Chrome or an
// unlisted key got picked and stalled; a plan that merely MENTIONS `claude -p`
// in prose got wrongly excluded).
//
// A `false` stamp REQUIRES `--reason` — recorded as a body banner (`> ☁️
// **cloudExec: false** — <reason>`) alongside the SEED-WRITE / Cost banners, so
// the WHY is never lost. Stamping `true` strips any stale reason banner.
//
// `--env trusted|full|webkit|browser` (plan 1925, extended plans 2250/2313): the
// SECOND cloud axis, `cloudEnv` — which environment KIND a cloud-runnable plan needs.
// `cloudExec` answers "may this run unattended in the cloud at all" (safety);
// `cloudEnv` answers "which network policy must the runner's environment have"
// (routing). `cloudEnv: full` means only a Full-egress-environment drain (queue-drain
// `--env full`) may pick it up; `cloudEnv: webkit` (plan 2313) means the plan's
// acceptance needs a live BROWSER-RENDERED page but consumes only DOM/HTML/anchors/
// `http_status` from it — satisfiable by WebKit, which a Full-egress lane provides
// (the 2206/2269 production proof), so the full lane admits it (there is no separate
// queue-drain `--env webkit` lane flag); `cloudEnv: browser` means only a lane with
// VERIFIED live headless-Chromium egress (queue-drain `--env browser`) may pick it
// up — pixels/crops/vision grades/structural hashes stay Chromium-pinned, and it is
// a strictly narrower pool than `full`/`webkit` today, since Full-egress
// demonstrably lacks working Chromium TLS egress (plan 2241's evidence: curl/Node
// https succeed, every headless-Chromium handshake resets); absent (or `trusted`)
// means the default Trusted drain pool. Stamp discriminator (plan 2313): the split
// is drawn on WHAT THE ACCEPTANCE CONSUMES, never "does it launch a browser" —
// DOM/HTML/anchors/status from a live page → `webkit`; pixels/vision/hashes →
// `browser`. One tool owns both axes — `--env` is only legal alongside a `true`
// stamp (a `false` plan is not cloud-runnable anywhere, so routing it is
// meaningless; the tool REFUSES), and both keys are written in the same atomic
// commit. Semantics reference: docs/coord/cloud-drains.md § The
// cloudEnv axis.
//
// The 2241 lesson, encoded as a CHECK not prose (plan 2250, extended plan 2313):
// this tool REFUSES to restamp `cloudEnv: browser` → `--env full`/`trusted`/`webkit`
// — the exact mistake the 2026-07-21 spec-sweep made on plan 2241 (assuming
// "Full-egress ⇒ Playwright works", which is false for this lane), and the same
// mistake one rung finer: a WebKit-capable lane still cannot run a pixel-acceptance
// plan (engine swap invalidates the shot corpus and what the vision judges see).
// See `assertNoBrowserDowngrade` below.
//
// `--repos <keys>` (plan 2577): the EXTRA-REPO axis — a comma-separated list of
// `scripts/coord/cloud-repos-lib.mjs` registry keys naming repos beyond vetapp the drain must
// clone to do this plan's work (today only `hobby-main`, the `98 Hobby/` umbrella repo).
// It is what retires rubric #4 for a registered repo: a plan whose only outside-the-clone
// surface is a REGISTERED repo is stamped `true --repos <key>`, not `false`. Orthogonal to
// `--env` (a hobby-main plan is perfectly Trusted-env runnable), so it is a separate axis
// and a separate banner slot, never a `cloudEnv` rung. Like `--env` it is TRUE-only, and
// absent it never clears an existing `cloudRepos` key.
//
// Usage:
//   node scripts/stamp-cloud-exec.mjs <id|basename> <true|false> [--env trusted|full|webkit|browser] [--repos <keys>] [--reason "..."] [--claude-dir-ok "..."] [--husky-ok "..."] [--dry]
//   e.g.  node scripts/stamp-cloud-exec.mjs 1784 true
//         node scripts/stamp-cloud-exec.mjs 1909 true --env full
//         node scripts/stamp-cloud-exec.mjs 2313 true --env webkit
//         node scripts/stamp-cloud-exec.mjs 2250 true --env browser
//         node scripts/stamp-cloud-exec.mjs 2531 true --repos hobby-main
//         node scripts/stamp-cloud-exec.mjs 1760 false --reason "price pipeline needs Playwright/Chrome the sandbox lacks"
//         node scripts/stamp-cloud-exec.mjs 2151 true --claude-dir-ok "only NAMES .claude/** in prose; the work is scripts/"
//
// `--claude-dir-ok "<justification>"` (plan 2151): the escape hatch for the
// `.claude/**` GATE below. Plan 2140 stopped unattended drains from NEEDING to edit
// `.claude/**` for the routine chain-registration case and added a prose bullet to the
// generated drain bodies telling them never to edit it otherwise. That prose is
// instruction-following — the exact guard class that already failed twice on 2026-07-20
// (a 109-minute and a 225-minute freeze: an `Edit` under `.claude/**` raises a harness
// `safetyCheck` ask, and an unattended cloud drain has nobody to approve it, so the
// session hangs until the window dies). So a plan whose WORK genuinely lands under
// `.claude/**` must not be stampable `cloudExec: true` at all: before a `true` stamp this
// tool scans the plan BODY for a `.claude/` path token and REFUSES on a hit, naming the
// matched line and pointing at the local lane. `--claude-dir-ok` overrides and records the
// justification as a body banner — the `--stub-ok` precedent in claim-plan.mjs.
//
// Two deliberate boundaries of that gate (both decided at spec-pass, 2026-07-20):
//   - It is CONSERVATIVE, not structural. There is no `fileSurface:` frontmatter key
//     anywhere in the plan corpus, so "the plan's file surface" can only be read out of
//     prose. The scan therefore ignores fenced code blocks and `## Do NOT touch` sections
//     (where naming `.claude/**` means the OPPOSITE of touching it) but will still fire on
//     a pure prose mention elsewhere. That over-block is the intended trade: the stamper
//     wielding the override is the heavy model that just read the whole plan, so a false
//     positive costs one flag while a false negative costs a 200-minute freeze.
//   - It is STAMP-TIME ONLY — `queue-drain.mjs --cloud` gets no second, independent check
//     at pick time. A hand-written `cloudExec: true` that never went through this tool is
//     out-of-contract, the same trust model every other frontmatter stamp already assumes;
//     paying a file-surface derivation per cloud pick to catch it is not worth it.
//
// The gate runs as a stamp-lib `preflight` (see stamp-lib.mjs's opts docs), NOT as a
// pre-check in main(). The rule stays here; only its TIMING is the lib's, and that timing
// is what makes it sound: the body it scans is the ff-synced copy inside the coord
// checkout (a pre-check against MAIN's working tree could clear the gate on a stale body
// that stampImpl then re-reads dirty), assertStampableStatus has already run (so an
// in-progress/ plan gets the status refusal, not a misleading `.claude/` one), and it fires
// ahead of the `--dry` branch (so a dry run reports the same outcome a real stamp would).
//
// The atomic core (withCoordCheckout isolation, ffMasterFromOrigin sync, snapshot →
// commit → push → path-scoped rollback with non-ff detection) lives in the shared
// stamp-lib.mjs (plan 1797 — one spine for every stamp-<axis> tool, never a second
// copy). Unlike stamp-exec-model there is NO filename mirror (cloudExec has no
// basename segment) and NO INDEX regen (cloudExec does not feed the bullet), so
// this is the leaner of the two stamps. Like it, it REFUSES in-progress/ and
// archive/ (assertStampableStatus — attributed to THIS tool since plan 1797).
//
// `--dry` prints the planned ops without mutating anything.
//
// `--husky-ok "<justification>"` (plan 2213): the SAME gate, extended to `.husky/**` —
// a shared git hook (`.husky/pre-push` etc). Plan 2197 reproduced the plan-2151 freeze
// anatomy on a different surface: the auto-mode classifier denies an unattended `Edit`
// under `.husky/**` (a shared git-hook write has no approver in a cloud session), and the
// claim froze (2026-07-21) — yet 2197 was stamped `cloudExec: true` while its own body
// named `.husky/pre-push:1452`, because the plan-2151 scan only recognised `.claude/`
// tokens. The `.husky/` check below reuses the exact same scan (fence-safe, Do-NOT-touch
// aware, frontmatter/own-banner exempt) via the shared `scanGatedPaths` core (both dirs are
// GATED_PATH_CLASSES registry entries since plan 2216) and gets its own
// independent override flag rather than widening `--claude-dir-ok`, so a refusal always
// names the specific directory it's about — `--claude-dir-ok` never silently clears a
// `.husky/` hit and vice versa. A plan naming BOTH gets a combined override banner if both
// flags are supplied.

import { fileURLToPath } from 'node:url';
import { parseArgs, assertOneOf } from './coord/coord-git.mjs';
import {
  upsertFrontmatterKey,
  frontmatterEnd,
  readFrontmatterScalar,
} from './coord/build-index-lib.mjs';
import { stampFrontmatterAxis } from './coord/stamp-lib.mjs';
import { VALID_CLOUD_REPOS, parseCloudRepos, formatCloudRepos } from './coord/cloud-repos-lib.mjs';

export const VALID_CLOUD_EXEC = ['true', 'false'];

// CLOUD_ENV_RUNGS (plan 2323): the AUTHORITATIVE ordered table for the `cloudEnv`
// superset ladder — one row per rung, replacing 4 hand-maintained literal sites
// (here + 3 more in queue-drain.mjs) that a rung addition (1925/2003 → 2250 →
// 2313) had to touch by hand, silently, if a spot was missed (e.g. missing the
// queue-drain exclude-set membership makes the oracle report `all_blocked`
// instead of `all_fable_or_stub` — see plan 2323's Problem section).
//
// Each row:
//   - `value`: the frontmatter string (`VALID_CLOUD_ENV` below is this column,
//     order-preserved).
//   - `rank`: the ADMISSION rank a lane must advertise to run this rung — NOT a
//     distinct integer per rung. `full` and `webkit` share rank 1: a Full-egress
//     lane's WebKit live-render capability (the 2206/2269 production proof)
//     admits both identically, so a rank-based lane check (queue-drain's
//     `laneRank = browserEnv ? Infinity : fullEnv ? 1 : 0`) treats them the
//     same. `browser` alone sits at rank 2 — verified live-Chromium egress no
//     lane advertises today. `trusted` is rank 0, the floor: always admitted.
//   - `exclude`/`excludeReason`: the queue-drain exclude code + human message
//     used when a plan's rung outranks the lane. `null` for `trusted` (never
//     excluded on this axis).
//   - `pinned`: true only for `browser` (see assertNoBrowserDowngrade below) —
//     its acceptance consumes pixel/vision output an engine swap silently
//     invalidates, so the downgrade guard refuses restamping AWAY from a
//     pinned rung to anything lower-ranked. Non-pinned rungs (webkit→
//     full/trusted) are deliberately unguarded — lossy on semantics but
//     strands nothing (plan-2313 judgment call).
export const CLOUD_ENV_RUNGS = [
  { value: 'trusted', rank: 0, exclude: null, excludeReason: null, pinned: false },
  {
    value: 'full',
    rank: 1,
    exclude: 'full-env',
    excludeReason:
      'cloudEnv: full — needs a Full-egress environment (live-host fetches / WebKit install); route to a full-lane drain (--env full)',
    pinned: false,
  },
  {
    value: 'webkit',
    rank: 1,
    exclude: 'webkit-env',
    excludeReason:
      'cloudEnv: webkit — needs live WebKit browser-render egress (DOM/HTML acceptance); ' +
      'a Full-egress lane provides it (plans 2206/2269) — route to a full-lane drain (--env full)',
    pinned: false,
  },
  {
    value: 'browser',
    rank: 2,
    exclude: 'browser-env',
    excludeReason:
      'cloudEnv: browser — needs a lane with verified live headless-Chromium egress ' +
      '(a plain Full-egress environment has fetch/WebKit egress but not verified ' +
      'Chromium-TLS egress, see the 2241 evidence in ' +
      'docs/coord/cloud-drains.md § The autonomy axis); since plan 3823 the browser body is ' +
      'the FLEET DEFAULT rather than a single-account exception — the account registry marks ' +
      'BOTH drain slots on all three live accounts `browser`, and the reconciler ' +
      'renders sonnet-browser.md / fable-browser.md for them. WHICH slots have that ' +
      'body pushed onto the live trigger, and which are enabled, are both LIVE state ' +
      'this literal must never assert: read the dated fleet log for the current binding, ' +
      'and ask ' +
      'the trigger-body sync tool (in dry-run mode) which bodies are actually in ' +
      'sync. ' +
      'You are seeing this code because the run that produced it asked for a LOWER ' +
      'rung: re-run with --env browser, or route to a local/interactive session.',
    pinned: true,
  },
];

// Order-preserving values column of CLOUD_ENV_RUNGS — kept as a separate export
// since `VALID_CLOUD_ENV` is the existing public name several call sites import.
export const VALID_CLOUD_ENV = CLOUD_ENV_RUNGS.map((r) => r.value);

// plan 2250 (extended plan 2313): the 2241 lesson as a check, not prose.
// `readFrontmatterScalar` reads the ff-synced body the caller (main's preflight) is
// handed — never a separate fs read, so this can't drift from the body the stamp
// itself is about to mutate. Throws `{fatal: true}` (the same shape the gated-path
// refusals use) when the plan is ALREADY stamped `cloudEnv: browser` and the caller
// is about to overwrite it with anything less capable (`full`, `trusted`, or —
// since plan 2313 — `webkit`): that is the same false "a lesser lane can still run
// this" assumption plan 2241's spec-sweep made, at any rung down. `webkit` is
// explicitly a downgrade here: a `browser` plan's acceptance consumes PIXELS
// (crops, vision grades, structural hashes), and swapping engines to WebKit
// invalidates the cached shot corpus and changes what the vision judges see — a
// genuinely DOM-only plan should never have been stamped `browser` in the first
// place (fix the mis-stamp via edit-plan with the re-adjudication written into the
// plan body, not a silent restamp). Any other transition (browser→browser,
// trusted/full/webkit/absent→anything) is untouched. Deliberately NOT guarded
// (plan-2313 judgment call): webkit→full/trusted — the full lane is the universal
// drain lane and admits every non-browser rung, so that downgrade is lossy on
// semantics but strands nothing; adding an unrequested guard there widens the
// blast radius for no routing gain.
export function assertNoBrowserDowngrade(body, newEnv) {
  const newRung = CLOUD_ENV_RUNGS.find((r) => r.value === newEnv);
  if (!newRung) return; // unknown/absent newEnv — nothing to guard (matches pre-2323 behavior)
  const existing = readFrontmatterScalar(body, 'cloudEnv');
  const existingRung = existing && CLOUD_ENV_RUNGS.find((r) => r.value === existing.toLowerCase());
  if (!existingRung || !existingRung.pinned) return;
  if (newRung.rank >= existingRung.rank) return; // same-or-higher rung: not a downgrade
  throw Object.assign(
    new Error(
      `stamp-cloud-exec: refusing to restamp cloudEnv: ${existingRung.value} → ${newEnv} — this plan's ` +
        'acceptance needs live headless-Chromium egress (the 2241 evidence: a Full-egress ' +
        'environment passes curl/Node fetches but every headless-Chromium TLS handshake ' +
        'resets, and a Trusted environment blocks live-host fetches outright — see ' +
        'docs/coord/cloud-drains.md § The cloudEnv axis), and its acceptance ' +
        'consumes pixels/vision output a WebKit engine swap would silently change (the ' +
        'plan-2313 DOM-vs-pixels split). No lesser lane can actually run this plan. If a ' +
        'cloud lane has since gained verified Chromium egress, stamp --env browser instead.',
    ),
    { fatal: true },
  );
}

// Merge `cloudExec: <value>` into the leading `---` frontmatter block (shared
// upsert — never clobbers sibling keys, creates a block if the body has none).
export function setFrontmatterKey(content, key, value) {
  return upsertFrontmatterKey(content, key, value);
}

// The one body-banner regex — a blockquote line naming cloudExec. Matched
// case/emoji-tolerantly so an operator-hand-typed variant is still recognised and
// replaced (never duplicated). Anchored to the blockquote form the banners use.
const CLOUD_REASON_RX = /^>.*\*\*cloudExec:.*$/im;

// Upsert ONE cloudExec body banner (the `false` reason banner, or the plan-2151
// `.claude/` override banner — both match CLOUD_REASON_RX, so a plan never carries
// two). Placement mechanics live in upsertBannerBy below.
export function upsertCloudExecBanner(content, banner) {
  return upsertBannerBy(content, CLOUD_REASON_RX, banner);
}

// The plan-2577 `cloudRepos` banner slot. A SEPARATE slot from CLOUD_REASON_RX on
// purpose: the extra-repo axis is orthogonal to cloud-safety, so a plan can legitimately
// carry both a gate-override banner and a cloudRepos banner at once. The two regexes
// cannot cross-match — one requires the literal `**cloudExec:`, the other `**cloudRepos:`
// — so `stripCloudExecReason` also leaves this banner alone.
const CLOUD_REPOS_RX = /^>.*\*\*cloudRepos:.*$/im;

export function upsertCloudReposBanner(content, keys) {
  const list = keys.map((k) => `\`${k}\``).join(' + ');
  return upsertBannerBy(
    content,
    CLOUD_REPOS_RX,
    `> 📦 **cloudRepos: ${formatCloudRepos(keys)}** — the drain must clone ${list} beside the ` +
      'vetapp checkout before working this plan (scripts/coord/cloud-repos-lib.mjs).',
  );
}

// Shared upsert used by both banner slots: replace an existing banner of THIS kind in
// place, else insert right after the LAST top-of-body banner line (SEED-WRITE / Cost
// forecast — the natural neighbours), else immediately after the frontmatter block.
function upsertBannerBy(content, rx, banner) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (rx.test(content)) return content.replace(rx, banner);
  const lines = content.split(/\r?\n/);
  // Prefer to sit just below the LAST existing banner. That includes banners in the other
  // slot (and one this same mutateBody call just inserted), not only SEED-WRITE / Cost
  // forecast: anchoring on those two alone would splice a newly-added banner AHEAD of a
  // banner written moments earlier, so body order stopped reflecting stamp chronology for a
  // reader reconstructing which override or repo requirement was recorded most recently
  // (sonnet-review finding, plan 2577). No data was lost either way — this is ordering only.
  let anchor = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^>.*(SEED-WRITE|Cost forecast|\*\*cloudExec:|\*\*cloudRepos:)/i.test(lines[i])) anchor = i;
  }
  if (anchor === -1) {
    // No banners — fall in right after the frontmatter block, if any.
    const end = frontmatterEnd(lines);
    anchor = end === -1 ? -1 : end;
  }
  // Insert after `anchor` (or at the very top when anchor === -1).
  lines.splice(anchor + 1, 0, banner);
  return lines.join(eol);
}

const normReason = (s) => String(s).replace(/\s+/g, ' ').trim();

// The `false`-stamp reason banner.
export function upsertCloudExecReason(content, reason) {
  return upsertCloudExecBanner(content, `> ☁️ **cloudExec: false** — ${normReason(reason)}`);
}

// The shared override-banner shape for any gated-path class (plan 2216): a `true` stamp that
// deliberately cleared a class's gate records WHY, so a later reader (or a re-spec asking why
// this plan is cloud-eligible despite naming a gated path) is never left guessing.
function upsertGateOverride(content, label, justification) {
  return upsertCloudExecBanner(
    content,
    `> ☁️ **cloudExec: true — \`${label}\` gate overridden** — ${normReason(justification)}`,
  );
}

// The plan-2151 `--claude-dir-ok` override banner. Thin wrapper kept as a named export —
// existing call sites and tests import it directly.
export function upsertClaudeDirOverride(content, justification) {
  return upsertGateOverride(content, '.claude/', justification);
}

// The plan-2213 `--husky-ok` override banner — same shape, `.husky/` gate.
export function upsertHuskyOverride(content, justification) {
  return upsertGateOverride(content, '.husky/', justification);
}

// A plan naming BOTH gated dirs with both override flags supplied: one combined banner
// (CLOUD_REASON_RX only ever keeps one) naming every overridden gate.
export function upsertCombinedGateOverride(content, overrides) {
  const labels = overrides.map((o) => `\`${o.label}\``).join(' + ');
  const text = overrides.map((o) => `${o.label}: ${normReason(o.justification)}`).join('; ');
  return upsertCloudExecBanner(
    content,
    `> ☁️ **cloudExec: true — ${labels} gates overridden** — ${text}`,
  );
}

// Strip a stale cloudExec reason banner (used when stamping `true`). Also collapses
// the blank-line run the removal would double down to a single blank. Line-based
// (split on /\r?\n/, collapse consecutive empties, re-join with the file's own eol)
// so it is EOL-agnostic — a bare `/\n{3,}/` collapse silently no-ops on CRLF content
// because the interleaved `\r` breaks the run of `\n`s. Pure string→string.
export function stripCloudExecReason(content) {
  if (!CLOUD_REASON_RX.test(content)) return content;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const kept = content.split(/\r?\n/).filter((l) => !CLOUD_REASON_RX.test(l));
  const out = [];
  for (const l of kept) {
    if (l === '' && out.length > 0 && out[out.length - 1] === '') continue; // collapse doubled blanks
    out.push(l);
  }
  return out.join(eol);
}

// A `.claude/` path token: the literal segment followed by a slash, not preceded by a
// word char or hyphen (so `.claude-work/`, `~/.claude-alt/` and a bare prose ".claude
// dir" do NOT fire — only an actual path INTO the directory does). `.claude/**` matches.
//
// Since plan 3765 this gate no longer catches ordinary HOOK work: every hook implementation
// lives at `scripts/hooks/**`, and only the thin wiring (`.claude/settings.json`), the
// slash-commands (`.claude/commands/**`) and the workflows (`.claude/workflows/**`) are left
// under `.claude/`. A plan whose work is hook LOGIC is therefore cloud-drainable; a plan that
// genuinely rewires settings.json still is not.
const CLAUDE_DIR_RX = /(?<![\w-])\.claude\//;

// A `.husky/` path token (plan 2213) — same shape as CLAUDE_DIR_RX, so `.husky-foo/` and
// a bare prose ".husky dir" don't fire, only an actual path into the shared hooks dir.
const HUSKY_DIR_RX = /(?<![\w-])\.husky\//;

// The gated-path registry (plan 2216): one entry per directory `stamp-cloud-exec` refuses to
// stamp `cloudExec: true` for by default. Adding a new gated class means ONE new entry here —
// the CLI flag, the `trueOnly` validation, the "REQUIRES a justification" check, the
// activeOverrides construction, and the preflight's REFUSING block are all derived from this
// array in main() below, instead of a hand-copied ~5-call-site duplicate per class (the
// plan-2213 review finding this plan closes). `findClaudeDirReference`/`findHuskyDirReference`
// and `upsertClaudeDirOverride`/`upsertHuskyOverride` stay as named exports — existing tests and
// call sites depend on their exact names and banner text — but are now thin wrappers over this
// registry-driven core.
const GATED_PATH_CLASSES = [
  {
    label: '.claude/',
    flag: 'claude-dir-ok',
    rx: CLAUDE_DIR_RX,
    upsertOverride: upsertClaudeDirOverride,
    incident:
      'An unattended CLOUD drain cannot write under `.claude/**`: the harness raises ' +
      'a `safetyCheck` ask that nobody is there to approve, and the session FREEZES ' +
      'until the window dies (2026-07-20: two freezes, 109 and 225 minutes).',
  },
  {
    label: '.husky/',
    flag: 'husky-ok',
    rx: HUSKY_DIR_RX,
    upsertOverride: upsertHuskyOverride,
    incident:
      'An unattended CLOUD drain cannot write a shared git hook under `.husky/**`: ' +
      'the auto-mode classifier denies the write (a shared git-hook write has no ' +
      'approver in an unattended session), and the claim FREEZES until the window ' +
      'dies (2026-07-21: plan 2197 froze on an unattended Edit to `.husky/pre-push`, ' +
      'the same anatomy as the two 2026-07-20 `.claude/` freezes).',
  },
];

function classByLabel(label) {
  return GATED_PATH_CLASSES.find((c) => c.label === label);
}

// The full `REFUSING cloudExec: true` message for a hit on `cls` — same shape regardless of
// which gated directory fired, only the incident text + matched line differ.
function gateRefusalMessage(cls, hit) {
  return (
    `REFUSING cloudExec: true — this plan's body names a \`${cls.label}\` path on line ` +
    `${hit.lineNo}:\n` +
    `    ${hit.line}\n` +
    `${cls.incident} Route this plan to the LOCAL lane instead — leave cloudExec unstamped, ` +
    'or stamp it `false --reason "..."`.\n' +
    'If that line is only a MENTION and no step actually writes under ' +
    `\`${cls.label}**\` (prose, a cross-reference, a keyword), re-run with --${cls.flag} ` +
    '"<why this is safe>" — the justification is recorded as a body banner.'
  );
}

// The carve-out heading whose whole section is exempt: naming `.claude/**` under
// `## Do NOT touch` / `## Do-not-touch` means the OPPOSITE of touching it.
const DO_NOT_TOUCH_RX = /^#{1,6}\s*\**do[\s-]*no[t]?[\s-]*touch/im;

// Mirrors build-index-lib's private HEADING_LEVEL_RX — needed locally so
// doNotTouchBounds can walk headings using the SAME fence-safety this file already
// computes (see doNotTouchBounds below), instead of a second full re-scan of `content`
// through build-index-lib's `sectionBounds` (plan 2151 review, findings 1+2).
const HEADING_LEVEL_RX = /^(#{1,6})\s/;

// The CLOSED fenced-code regions of `lines`, as [start, end) char offsets.
//
// Deliberately NOT a running `inFence` toggle (plan 2151 review, finding 0): an
// unterminated opening fence — an everyday markdown typo — would leave the toggle stuck
// ON and silently exempt the entire rest of the document, including the real Scope
// section, turning the gate into a no-op exactly when the plan is sloppiest. Only a fence
// that actually CLOSES creates an exempt region; an unmatched opener is treated as
// ordinary prose and its tail is scanned. Both failure directions are then conservative:
// worst case the gate over-blocks and the stamper reaches for --claude-dir-ok.
function closedFenceRanges(lines) {
  const ranges = [];
  let openStart = null;
  let openChar = null;
  let pos = 0;
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1; // +1 for the '\n' this split consumed
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (!fence) continue;
    // A fence only CLOSES on its own char, so a ~~~ line inside a ``` block is content.
    if (openStart === null) {
      openStart = lineStart;
      openChar = fence[1][0];
    } else if (fence[1][0] === openChar) {
      ranges.push([openStart, pos]);
      openStart = null;
      openChar = null;
    }
  }
  return ranges;
}

// Fence-aware Do-NOT-touch section bounds, built on the SAME paired-fence detection as
// closedFenceRanges above (plan 2151 review, finding 2). build-index-lib's `sectionBounds`
// is the shared heading scanner elsewhere in the codebase, but it tracks fences with a
// running `inFence` TOGGLE — precisely the unsafe pattern closedFenceRanges was written to
// avoid: an unclosed fence inside `## Do NOT touch` leaves it stuck "in fence" through EOF,
// silently swallowing a real `## Scope` section that follows (and everything it declares)
// into the exempt carve-out. This local scan reuses `closedRanges` (fences ALREADY paired
// here) to decide which candidate heading lines to trust, so both halves of this gate share
// one fence-safety guarantee instead of two different ones. Mirrors sectionBounds' return
// shape ({ start, end }: start = right after the heading line, end = the next same-or-
// shallower heading or EOF) so callers don't need to know which scanner produced it.
function doNotTouchBounds(lines, lineStart, closedRanges, srcLength) {
  const inClosedFence = (i) =>
    closedRanges.some(([s, e]) => lineStart[i] >= s && lineStart[i] + lines[i].length <= e);
  const boundaryHeadings = [];
  let anchor = null;
  for (let i = 0; i < lines.length; i++) {
    if (inClosedFence(i)) continue;
    const m = HEADING_LEVEL_RX.exec(lines[i]);
    if (m) boundaryHeadings.push({ lineStart: lineStart[i], level: m[1].length });
    if (anchor === null && DO_NOT_TOUCH_RX.test(lines[i])) {
      // DO_NOT_TOUCH_RX's `\s*` after the hashes is looser than HEADING_LEVEL_RX's required
      // `\s` (e.g. `##Do not touch` with no space matches the former but not `m` above), so the
      // anchor's own level is derived independently rather than reused from `m`, which may be
      // null here.
      anchor = {
        lineStart: lineStart[i],
        lineEnd: lineStart[i] + lines[i].length,
        level: /^#{1,6}/.exec(lines[i])[0].length,
      };
    }
  }
  if (!anchor) return null;
  let end = srcLength;
  for (const b of boundaryHeadings) {
    if (b.lineStart <= anchor.lineStart || b.level > anchor.level) continue;
    end = b.lineStart;
    break;
  }
  return { start: anchor.lineEnd, end };
}

// The shared scan core (plan 2213, generalized to N registered classes in plan 2216): a plan
// BODY's lines/line-start offsets/closed-fence-ranges/frontmatter-bounds/Do-NOT-touch-bounds are
// computed exactly ONCE, then every class in `classes` is tested against that SAME per-line loop
// — replacing the old one-full-document-parse-per-class approach (previously two independent
// calls, one per gated directory). Skips the regions where naming a gated path is not a
// declaration of file surface (plan 2151): the frontmatter block, CLOSED fenced code blocks
// (illustrative snippets), the `## Do NOT touch` section, and this tool's OWN cloudExec banner
// line (plan 2151 review, finding 1 — an override banner it writes itself contains a literal
// gated-path token, so without this skip a later plain re-stamp of the same plan would refuse,
// citing the tool's own audit trail). INLINE code spans are deliberately NOT skipped —
// backticked paths in a Scope section are exactly where a real file surface is declared. Only
// the FIRST Do-NOT-touch section is exempted; a second one would merely be scanned, i.e. err
// toward refusing. Returns a Map<label, {lineNo, line}> — one entry per class that hit, each the
// FIRST matching line for that class.
function scanGatedPaths(content, classes) {
  const src = String(content).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  // Char offset of each line's start (lineStart[i] + lines[i].length + 1 = lineStart[i+1]).
  const lineStart = [];
  for (let i = 0, pos = 0; i < lines.length; i++) {
    lineStart.push(pos);
    pos += lines[i].length + 1;
  }

  const skip = closedFenceRanges(lines);

  const fmEnd = frontmatterEnd(lines);
  if (fmEnd !== -1) skip.push([0, lineStart[fmEnd] + lines[fmEnd].length + 1]);

  const dnt = doNotTouchBounds(lines, lineStart, skip, src.length);
  // dnt.start sits at the end of the heading LINE; back up to that line's start so a
  // heading that itself names the path (`## Do NOT touch \`.claude/**\``) is exempt too.
  if (dnt) skip.push([src.lastIndexOf('\n', dnt.start - 1) + 1, dnt.end]);

  const hits = new Map();
  for (let i = 0; i < lines.length; i++) {
    const from = lineStart[i];
    if (skip.some(([s, e]) => from >= s && from + lines[i].length <= e)) continue;
    // The tool's OWN banners are never a file-surface declaration. Both slots must be skipped:
    // exempting only the cloudExec one would let a cloudRepos banner whose registry `note`/`url`
    // text happened to contain a `.claude/`/`.husky/` token make the next plain `true` restamp
    // REFUSE by citing a banner this tool wrote itself — the exact self-citation bug the
    // CLOUD_REASON_RX exemption exists to prevent (sonnet-review finding, plan 2577).
    if (CLOUD_REASON_RX.test(lines[i]) || CLOUD_REPOS_RX.test(lines[i])) continue;
    for (const cls of classes) {
      if (hits.has(cls.label)) continue; // first hit per class wins
      if (cls.rx.test(lines[i])) hits.set(cls.label, { lineNo: i + 1, line: lines[i].trim() });
    }
  }
  return hits;
}

// Scan a plan BODY for a `.claude/` path token (plan 2151 — see scanGatedPaths for the shared
// exemptions). Returns { lineNo, line } for the first hit, or null.
export function findClaudeDirReference(content) {
  const cls = classByLabel('.claude/');
  return scanGatedPaths(content, [cls]).get(cls.label) ?? null;
}

// Scan a plan BODY for a `.husky/` path token (plan 2213 — same exemptions as the
// `.claude/` scan above). Returns { lineNo, line } for the first hit, or null.
export function findHuskyDirReference(content) {
  const cls = classByLabel('.husky/');
  return scanGatedPaths(content, [cls]).get(cls.label) ?? null;
}

// plan 3973 (T2): the axis-building + validation core, factored out of main() so
// stamp-exec-model.mjs's combined `--cloud-exec`/`--env` form can reuse it VERBATIM
// instead of duplicating the gated-path/browser-downgrade/trueOnly/false-requires-reason
// rules a second time. Takes already-parsed values (argv-shape parsing — `--repos`
// strictness, the usage-line, `--dry` peeling — stays the CLI's own job in main() below,
// since stamp-exec-model.mjs's combined form doesn't expose `--repos`/gated-path override
// flags at all). Throws a plain `Error` on any validation failure, with the EXACT message
// text main() has always printed (minus the `return 2`) — so every caller's catch block
// prints `e.message` and exits 2, byte-identical to before this refactor for
// stamp-cloud-exec.mjs's own CLI. Returns `{ axis, describe }`: `axis` is the
// stampFrontmatterAxis-shaped object (tool/preflight/mutateBody/commitSubject/dryPreview —
// no idOrName/dry, which stay top-level and caller-owned), `describe` is the human
// stamp-description string both CLIs print on success.
export function buildCloudExecAxis(target, { env, repos, reason, overrideFlags = {} } = {}) {
  assertOneOf(target, VALID_CLOUD_EXEC, { label: 'cloudExec value', prefix: 'stamp-cloud-exec' });
  if (env !== undefined) {
    assertOneOf(env, VALID_CLOUD_ENV, { label: '--env value', prefix: 'stamp-cloud-exec' });
  }
  // `--env` and every gated-path override flag are TRUE-only, and had grown one verbatim
  // copy of the same guard per flag (plan 2151 review, finding 5; plan 2216 folds the
  // per-gated-class copies into the registry loop below). `--reason` is deliberately NOT
  // folded in: its rule is the different "REQUIRED when false", not "only legal with true".
  const trueOnly = [
    [
      '--env',
      env,
      'a cloudExec: false plan is not cloud-runnable in ANY environment, so routing it to ' +
        'one is meaningless. Stamp it true (with --env) once its blocker clears, or drop --env.',
    ],
    [
      '--repos',
      repos,
      'a cloudExec: false plan is never cloned into a drain sandbox at all, so naming the ' +
        'extra repos it would need there says nothing. Stamp it true (with --repos) once its ' +
        'blocker clears, or drop --repos.',
    ],
    ...GATED_PATH_CLASSES.map((cls) => [
      `--${cls.flag}`,
      overrideFlags[cls.flag],
      `it overrides the \`${cls.label}\` gate, and that gate only guards the \`true\` direction. ` +
        'Drop the flag.',
    ]),
  ];
  for (const [name, value, why] of trueOnly) {
    if (value !== undefined && target !== 'true') {
      throw new Error(
        `stamp-cloud-exec: ${name} is only legal alongside a \`true\` stamp — ${why}`,
      );
    }
  }
  if (target === 'false' && (!reason || typeof reason !== 'string' || !reason.trim())) {
    throw new Error(
      'stamp-cloud-exec: a `false` stamp REQUIRES --reason "<why not cloud-safe>" — ' +
        'the reason is recorded as a body banner so a future reader / re-spec knows why ' +
        '(e.g. needs Playwright/Chrome, an unlisted key, or seed-sandbox tooling the cloud lacks).',
    );
  }
  for (const cls of GATED_PATH_CLASSES) {
    const value = overrideFlags[cls.flag];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error(
        `stamp-cloud-exec: --${cls.flag} REQUIRES a justification — it is recorded as a body ` +
          'banner so the override is never silent.',
      );
    }
  }

  // The ONE decision of which body-banner op this stamp performs, so mutateBody and
  // dryPreview can never describe different outcomes (plan 2151 review, finding 6). A
  // `true` stamp normally STRIPS any stale banner; with one or more gated-path override
  // flags it replaces it with the override record instead (same banner slot, so no kind
  // ever coexists with another — a plan overriding every gated dir gets ONE combined banner).
  const activeOverrides = GATED_PATH_CLASSES.map(
    (cls) =>
      overrideFlags[cls.flag] !== undefined && {
        cls,
        label: cls.label,
        justification: overrideFlags[cls.flag],
      },
  ).filter(Boolean);
  const bannerOp =
    target === 'false'
      ? {
          apply: (body) => upsertCloudExecReason(body, reason),
          dry: `insert body banner: cloudExec false — ${reason}`,
        }
      : activeOverrides.length >= 2
        ? {
            apply: (body) => upsertCombinedGateOverride(body, activeOverrides),
            dry:
              `insert body banner: cloudExec true — ` +
              `${activeOverrides.map((o) => `\`${o.label}\``).join(' + ')} gates overridden — ` +
              activeOverrides.map((o) => `${o.label}: ${o.justification}`).join('; '),
          }
        : activeOverrides.length === 1
          ? {
              apply: (body) =>
                activeOverrides[0].cls.upsertOverride(body, activeOverrides[0].justification),
              dry:
                `insert body banner: cloudExec true — ${activeOverrides[0].label} gate overridden — ` +
                activeOverrides[0].justification,
            }
          : {
              apply: stripCloudExecReason,
              dry: 'strip any stale cloudExec reason banner',
            };

  const axis = {
    tool: 'stamp-cloud-exec',
    // ── The plan-2151 `.claude/` gate + the plan-2213 `.husky/` gate, registry-driven since
    // plan 2216 (see the header) ── A stamp-lib preflight, NOT a pre-check out here: only the
    // lib can hand us the ff-synced body from inside the coord checkout, and only after
    // assertStampableStatus has already refused an in-progress/ or archive/ plan. Both matter
    // — reading MAIN's working tree instead let a stale body clear the gate, and gating ahead
    // of the status check surfaced a `.claude/` refusal for a plan whose real blocker was its
    // folder (plan 2151 review, findings 1-3). Each gated dir checks independently — supplying
    // one override flag skips only ITS gate, never the other. The body is parsed ONCE (via
    // scanGatedPaths) for every class not already overridden, then classes are checked for a
    // hit in registration order — same effective behavior as the old two-independent-`if`s,
    // one shared parse instead of one full document scan per class.
    preflight:
      target === 'true'
        ? (body) => {
            // plan 2250: the 2241 lesson as a check, not prose — refuse BEFORE the
            // gated-path scan (a cheaper, more specific failure than mixing it into
            // that loop). Runs on the ff-synced body, same as the gated-path scan.
            assertNoBrowserDowngrade(body, env);
            const pending = GATED_PATH_CLASSES.filter(
              (cls) => overrideFlags[cls.flag] === undefined,
            );
            if (pending.length === 0) return; // every gated class already overridden
            const hits = scanGatedPaths(body, pending);
            for (const cls of pending) {
              const hit = hits.get(cls.label);
              if (hit)
                throw Object.assign(new Error(gateRefusalMessage(cls, hit)), { fatal: true });
            }
          }
        : undefined,
    mutateBody: (body) => {
      body = setFrontmatterKey(body, 'cloudExec', target);
      // Both cloud axes land in ONE atomic commit — never a stamp where cloudExec
      // flipped but the env routing didn't. Absent --env leaves any existing
      // cloudEnv key untouched (the axes are independent; a bare cloudExec
      // restamp must not silently clear a plan's routing).
      if (env !== undefined) body = setFrontmatterKey(body, 'cloudEnv', env);
      // Third axis (plan 2577), same all-in-one-commit rule: never a stamp where
      // cloudExec flipped but the extra-repo routing didn't. Applied AFTER bannerOp so
      // a `true` stamp's stripCloudExecReason (a line filter + blank-run collapse)
      // cannot run over the freshly-inserted cloudRepos banner.
      body = bannerOp.apply(body);
      if (repos !== undefined) {
        body = setFrontmatterKey(body, 'cloudRepos', formatCloudRepos(repos));
        body = upsertCloudReposBanner(body, repos);
      }
      return body;
    },
    commitSubject: ({ basename }) =>
      `docs(plans): stamp ${basename} cloudExec: ${target}${env !== undefined ? ` cloudEnv: ${env}` : ''}` +
      `${repos !== undefined ? ` cloudRepos: ${formatCloudRepos(repos)}` : ''}`,
    dryPreview: () => [
      `[dry] set cloudExec: ${target}`,
      ...(env !== undefined ? [`[dry] set cloudEnv: ${env}`] : []),
      `[dry] ${bannerOp.dry}`,
      ...(repos !== undefined
        ? [`[dry] set cloudRepos: ${formatCloudRepos(repos)} + upsert its banner`]
        : []),
    ],
  };

  const describe =
    `cloudExec: ${target}${env !== undefined ? ` + cloudEnv: ${env}` : ''}` +
    (repos !== undefined ? ` + cloudRepos: ${formatCloudRepos(repos)}` : '') +
    GATED_PATH_CLASSES.map((cls) =>
      overrideFlags[cls.flag] !== undefined ? ` (\`${cls.label}\` gate overridden)` : '',
    ).join('');

  return { axis, describe };
}

async function main() {
  // --dry is a bare boolean — filter it BEFORE parseArgs (which would otherwise
  // swallow the next token as its value), the same footgun stamp-exec-model strips.
  const dry = process.argv.includes('--dry');
  const {
    cmd: idOrName,
    positionals,
    flags,
  } = parseArgs(process.argv.slice(2).filter((a) => a !== '--dry'));
  const target = positionals[0];
  const reason = flags.reason;
  const env = flags.env;
  // plan 2577: the extra-repo axis. `undefined` when the flag is absent (leaves any
  // existing cloudRepos key untouched, same contract as --env); otherwise the parsed,
  // deduped key list. Parsed STRICT — a typo must refuse loudly here rather than leave a
  // plan stamped-but-unclonable, which a drain would skip forever with no signal.
  let repos;
  if (flags.repos !== undefined) {
    try {
      repos = parseCloudRepos(flags.repos, { strict: true });
    } catch (e) {
      console.error(`stamp-cloud-exec: ${e.message}`);
      return 2;
    }
    if (repos.length === 0) {
      console.error(
        'stamp-cloud-exec: --repos REQUIRES at least one registry key — ' +
          `known keys: ${VALID_CLOUD_REPOS.join(', ')}. Drop the flag if the plan needs no extra repo.`,
      );
      return 2;
    }
  }
  // One override-flag value per registered gated-path class (plan 2216) — `overrideFlags[cls.flag]`
  // replaces the old one-hand-declared-variable-per-class pattern.
  const overrideFlags = Object.fromEntries(
    GATED_PATH_CLASSES.map((cls) => [cls.flag, flags[cls.flag]]),
  );
  if (!idOrName || !target) {
    const gatedFlagUsage = GATED_PATH_CLASSES.map((cls) => `[--${cls.flag} "..."] `).join('');
    console.error(
      'usage: stamp-cloud-exec.mjs <id|basename> <true|false> [--env trusted|full|webkit|browser] ' +
        `[--repos ${VALID_CLOUD_REPOS.join('|')}] [--reason "..."] ${gatedFlagUsage}[--dry]`,
    );
    return 2;
  }

  let built;
  try {
    built = buildCloudExecAxis(target, { env, repos, reason, overrideFlags });
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const result = await stampFrontmatterAxis({ idOrName, dry, ...built.axis });

  if (result.dry)
    console.log(`stamp-cloud-exec: [dry] ${result.basename} → ${built.describe} (no changes made)`);
  else console.log(`stamp-cloud-exec: ${result.basename} → ${built.describe} — committed + pushed`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('stamp-cloud-exec:', e.message);
      process.exit(e.fatal ? 2 : 1);
    },
  );
}
