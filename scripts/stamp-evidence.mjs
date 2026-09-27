#!/usr/bin/env node
// scripts/stamp-evidence.mjs  (plan 2943)
//
// Stamp a plan's `evidence:` frontmatter class — the second enforcement seam of the
// operator-adopted evidence floor (2026-08-06, docs/coord/plan-lanes.md § The evidence
// floor): a NEW plan may be minted as its own vehicle only when its wrongness was OBSERVED
// (wave output, the live site, a measured corpus/staged-rows run) or operator-commissioned;
// a LATENT finding (review/audit/code-reading "could go wrong", nothing observed wrong)
// folds to a line instead. `evidence:` is the durable record of which class a given plan
// carries, so `move-plan <id> ready` can refuse promoting a `latent` product-family plan
// (see move-plan.mjs's `assertEvidenceFloorOk`) instead of relying on prose discipline alone
// (the plan-2864 lesson: prose does not bind).
//
// Mirrors scripts/stamp-cloud-exec.mjs (the plan-1781 pattern — frontmatter merge +
// coordWrite, atomic snapshot/commit/push/rollback via the shared stamp-lib.mjs spine) but is
// deliberately the LEANER of the two: `evidence` has no body banner, no filename-rename
// segment (unlike `stamp-exec-model`'s FABLE- mirror), no second axis (unlike `cloudEnv`),
// and no INDEX regen (evidence does not feed the INDEX bullet, same as cloudExec). Do NOT
// extend `stamp-exec-model.mjs` — its FABLE- filename-segment rename machinery is entangled
// with `execModel` alone and has nothing to do with this axis.
//
// Usage:
//   node scripts/stamp-evidence.mjs <id|basename> <value> [--dry]
//   e.g.  node scripts/stamp-evidence.mjs 2943 observed-wave
//         node scripts/stamp-evidence.mjs 2943 latent --dry
//
// Valid values (docs/coord/plan-lanes.md § The evidence floor):
//   observed-wave      — surfaced in daily-wave output
//   observed-live       — surfaced on the live site
//   observed-measured   — surfaced by a measured corpus/staged-rows run
//   operator            — operator-commissioned or operator-reported
//   latent              — review/audit/code-reading "could go wrong"; nothing observed wrong
//
// A MISSING `evidence:` key is never a refusal anywhere downstream (forward-only stamping,
// the grandfathered-pool precedent `loop:`/`bulkShaped:` already set) — this tool only ever
// WRITES a value, it never validates the absence of one.
//
// Like stamp-cloud-exec, this REFUSES `in-progress/` and `archive/` targets
// (assertStampableStatus, via the shared stamp-lib spine) — a stamp lands only on a plan
// still resting in a stampable folder. `--dry` previews without mutating anything.

import { fileURLToPath } from 'node:url';
import { parseArgs, assertOneOf } from './coord/coord-git.mjs';
import { upsertFrontmatterKey } from './coord/build-index-lib.mjs';
import { stampFrontmatterAxis } from './coord/stamp-lib.mjs';

// The five-value evidence-floor vocabulary (docs/coord/plan-lanes.md § The evidence
// floor). Order-preserved for usage/error messages — no ranking semantics, unlike
// stamp-cloud-exec's CLOUD_ENV_RUNGS ladder.
export const VALID_EVIDENCE = [
  'observed-wave',
  'observed-live',
  'observed-measured',
  'operator',
  'latent',
];

// Merge `evidence: <value>` into the leading `---` frontmatter block (shared upsert — never
// clobbers sibling keys, creates a block if the body has none). Thin named export mirroring
// stamp-cloud-exec's setFrontmatterKey, kept for the same reason: existing sibling tests
// import a pure per-axis wrapper rather than reaching into build-index-lib directly.
export function setFrontmatterKey(content, key, value) {
  return upsertFrontmatterKey(content, key, value);
}

const USAGE = `usage: stamp-evidence.mjs <id|basename> <${VALID_EVIDENCE.join('|')}> [--dry]`;

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  // --dry is a bare boolean — filter it BEFORE parseArgs (which would otherwise swallow the
  // next token as its value), the same footgun stamp-exec-model/stamp-cloud-exec strip.
  const dry = rawArgs.includes('--dry');
  const { cmd: idOrName, positionals } = parseArgs(rawArgs.filter((a) => a !== '--dry'));
  const target = positionals[0];

  if (!idOrName || !target) {
    console.error(USAGE);
    return 2;
  }
  try {
    assertOneOf(target, VALID_EVIDENCE, { label: 'evidence value', prefix: 'stamp-evidence' });
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const result = await stampFrontmatterAxis({
    tool: 'stamp-evidence',
    idOrName,
    dry,
    mutateBody: (body) => setFrontmatterKey(body, 'evidence', target),
    commitSubject: ({ basename }) => `docs(plans): stamp ${basename} evidence: ${target}`,
    dryPreview: () => [`[dry] set evidence: ${target}`],
  });

  if (result.dry)
    console.log(`stamp-evidence: [dry] ${result.basename} → evidence: ${target} (no changes made)`);
  else console.log(`stamp-evidence: ${result.basename} → evidence: ${target} — committed + pushed`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error('stamp-evidence:', e.message);
      process.exit(e.fatal ? 2 : 1);
    },
  );
}
