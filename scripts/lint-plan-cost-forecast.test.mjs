// scripts/lint-plan-cost-forecast.test.mjs — unit tests for the pure
// findPlansMissingCost selector. Mirrors queue-drain.test.mjs (node:test,
// no fs/git). The parsing itself is covered by queue-drain.test.mjs's
// parseCost cases; here we assert the lint's flag-or-pass decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlansMissingCost } from './lint-plan-cost-forecast.mjs';

const withCost = (slug, line) => ({
  path: `docs/superpowers/plans/ready/${slug}`,
  content: `> 🟩 **SEED-WRITE: NO** — test.\n\n> 💰 **Cost forecast:** ${line}\n\n# ${slug}\n`,
});
const noCost = (slug) => ({
  path: `docs/superpowers/plans/ready/${slug}`,
  content: `> 🟩 **SEED-WRITE: NO** — test.\n\n# ${slug}\n`,
});

test('flags a ready plan with no cost banner', () => {
  assert.deepEqual(findPlansMissingCost([noCost('900-x-test.md')]), ['900-x-test.md']);
});

test('passes $0 / ~$2 / ~$85 / no-LLM banners (same parser the drain uses)', () => {
  assert.deepEqual(
    findPlansMissingCost([
      withCost('901-a.md', '$0 — frontend-only; no LLM/API/scraping spend.'),
      withCost('902-b.md', '~$2 — Google Geocoding (low-hundreds reqs, under $5).'),
      withCost('903-c.md', '~$85 — needs a claude -p fan-out; operator-scoped.'),
      withCost('904-d.md', 'No LLM spend.'),
    ]),
    [],
  );
});

test('flags prose-only / TBD cost text as unparseable', () => {
  assert.deepEqual(findPlansMissingCost([withCost('905-e.md', 'TBD — operator to estimate.')]), [
    '905-e.md',
  ]);
});

test('reports only the offending plans in a mixed batch', () => {
  assert.deepEqual(
    findPlansMissingCost([withCost('906-ok.md', '$0 — fine.'), noCost('907-bad.md')]),
    ['907-bad.md'],
  );
});
