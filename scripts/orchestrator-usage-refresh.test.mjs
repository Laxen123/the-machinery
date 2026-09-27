// scripts/orchestrator-usage-refresh.test.mjs — unit tests for the live
// OAuth-usage refresh. Pure request-builder + token extractor only (no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usageRequest,
  tokenFromCredentials,
  cloudCreditFromUsage,
  readCloudCredit,
} from './orchestrator-usage-refresh.mjs';

test('usageRequest builds the OAuth usage URL + bearer + beta header', () => {
  const { url, headers } = usageRequest('tok-123');
  assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(headers.Authorization, 'Bearer tok-123');
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('tokenFromCredentials extracts the nested accessToken', () => {
  assert.equal(tokenFromCredentials({ claudeAiOauth: { accessToken: 'abc' } }), 'abc');
});

test('tokenFromCredentials returns null when absent / malformed', () => {
  assert.equal(tokenFromCredentials({}), null);
  assert.equal(tokenFromCredentials(null), null);
  assert.equal(tokenFromCredentials({ claudeAiOauth: {} }), null);
});

// --- plan 4232: the cloud-session promo credit ------------------------------------------

const CREDIT_USAGE = {
  seven_day: { utilization: 12, limit_dollars: null, remaining_dollars: null },
  iguana_necktie: {
    utilization: 0,
    resets_at: '2026-11-05T07:59:00+00:00',
    limit_dollars: 250,
    used_dollars: 1.5,
    remaining_dollars: 248.5,
    locked_reason: null,
  },
};

test('cloudCreditFromUsage reads the iguana_necktie dollar balance', () => {
  assert.deepEqual(cloudCreditFromUsage(CREDIT_USAGE), {
    limitDollars: 250,
    usedDollars: 1.5,
    remainingDollars: 248.5,
    expiresAt: '2026-11-05T07:59:00+00:00',
    lockedReason: null,
  });
});

test('cloudCreditFromUsage is null when the account carries no dollar credit', () => {
  assert.equal(cloudCreditFromUsage({ seven_day: CREDIT_USAGE.seven_day }), null);
  assert.equal(cloudCreditFromUsage({ iguana_necktie: null }), null);
  assert.equal(cloudCreditFromUsage({ iguana_necktie: { limit_dollars: null } }), null);
  assert.equal(cloudCreditFromUsage(null), null);
});

test('readCloudCredit reads the given config dir and never returns the token', async () => {
  const seen = [];
  const r = await readCloudCredit('/cfg/home', {
    readToken: (dir) => (seen.push(dir), 'secret-tok'),
    fetchUsageFn: async (tok) => (seen.push(tok), CREDIT_USAGE),
  });
  assert.deepEqual(seen, ['/cfg/home', 'secret-tok']);
  assert.equal(r.credit.remainingDollars, 248.5);
  assert.ok(!JSON.stringify(r).includes('secret-tok'));
});

test('readCloudCredit names the reason on every unreadable path', async () => {
  const noTok = await readCloudCredit('/cfg/x', { readToken: () => null });
  assert.equal(noTok.credit, null);
  assert.match(noTok.reason, /no OAuth token in \/cfg\/x/);
  const httpErr = await readCloudCredit('/cfg/x', {
    readToken: () => 't',
    fetchUsageFn: async () => {
      throw new Error('usage API 401');
    },
  });
  assert.deepEqual(httpErr, { credit: null, reason: 'usage API 401' });
  const noField = await readCloudCredit('/cfg/x', {
    readToken: () => 't',
    fetchUsageFn: async () => ({ seven_day: {} }),
  });
  assert.equal(noField.credit, null);
  assert.match(noField.reason, /iguana_necktie/);
});
