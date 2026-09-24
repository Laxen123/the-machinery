// scripts/plan-cost-banner.test.mjs — unit tests for the shared cost-banner
// predicate (plan 1260). The parsing itself is covered by queue-drain.test.mjs's
// parseCost cases; here we assert the boolean predicate + the help text the lint
// and both movers all share, so they can never disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasParseableCostBanner,
  costBannerHelp,
  readyCostBannerError,
  COST_BANNER_EXAMPLES,
} from './plan-cost-banner.mjs';

const withCost = (line) =>
  `> 🟩 **SEED-WRITE: NO** — test.\n\n> 💰 **Cost forecast:** ${line}\n\n# T\n`;
const noCost = '> 🟩 **SEED-WRITE: NO** — test.\n\n# T\n';

test('hasParseableCostBanner: true for $0 / ~$2 / ~$85 / no-LLM banners', () => {
  for (const line of [
    '$0 — frontend-only; no LLM/API/scraping spend.',
    '~$2 — Google Geocoding (low-hundreds reqs, under $5).',
    '~$85 — needs a claude -p fan-out; operator-scoped.',
    'No LLM spend.',
  ]) {
    assert.equal(hasParseableCostBanner('900-x.md', withCost(line)), true, `should pass: ${line}`);
  }
});

test('hasParseableCostBanner: false for a missing banner', () => {
  assert.equal(hasParseableCostBanner('900-x.md', noCost), false);
});

test('hasParseableCostBanner: false for prose-only / TBD cost text', () => {
  assert.equal(hasParseableCostBanner('900-x.md', withCost('TBD — operator to estimate.')), false);
});

test('hasParseableCostBanner: basename is irrelevant to the cost parse (content-only)', () => {
  // A placeholder basename with no id prefix (the next-plan-id mint path) still parses cost.
  assert.equal(hasParseableCostBanner('mint.md', withCost('$0 — no LLM spend.')), true);
  assert.equal(hasParseableCostBanner('mint.md', noCost), false);
});

test('costBannerHelp: includes every example banner (the shape the fixer needs)', () => {
  const help = costBannerHelp();
  for (const ex of COST_BANNER_EXAMPLES) assert.ok(help.includes(ex), `help must show: ${ex}`);
  assert.match(help, /Cost forecast/);
});

test('readyCostBannerError: null when the banner is present, message+help when absent', () => {
  // present → null (the shared gate both movers call)
  assert.equal(readyCostBannerError('050-x.md', withCost('$0 — no LLM spend.'), 'INTRO'), null);
  // absent → the caller's intro + the shared help block (examples included)
  const msg = readyCostBannerError('050-x.md', noCost, 'INTRO-SENTENCE');
  assert.match(msg, /^INTRO-SENTENCE/);
  for (const ex of COST_BANNER_EXAMPLES) assert.ok(msg.includes(ex), `msg must show: ${ex}`);
});
