#!/usr/bin/env node
// scripts/orchestrator-usage-refresh.mjs — force-refresh the OAuth usage meter
// (.usage_cache.json) that scripts/orchestrator-budget.mjs reads. Mirrors what
// the statusline does in curl, in Node. The brain calls this before a 🟥
// seed-write land because the cache can be ≤2.5 min stale (spec 2026-06-21,
// plan 913 component 2).
//
// Pure usageRequest / tokenFromCredentials carry the unit tests; the fetch + fs
// write are the thin CLI (not unit-tested — network/integration).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfigDir } from './coord/coord-config.mjs';
import { atomicWriteJsonSync } from './coord/atomic-write.mjs';
import { httpsGetStatus } from './https-status.mjs';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

// --- pure --------------------------------------------------------------------

// The HTTP request shape the statusline uses — bearer token + the OAuth beta header.
export function usageRequest(token) {
  return {
    url: USAGE_URL,
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
  };
}

// Pull the access token out of a parsed .credentials.json (null if absent).
export function tokenFromCredentials(creds) {
  return creds?.claudeAiOauth?.accessToken ?? null;
}

// The cloud-session promo credit (plan 4232). The usage response carries it under the
// opaque key `iguana_necktie` — the same balance as the "Cloud session credits" bar in
// claude.ai Settings → Usage (proven 2026-09-27: this endpoint and the claude.ai cookie
// endpoint returned the identical object). Returns null when the field is absent or has no
// dollar limit, so a caller can never mistake "no credit on this account" for "$0 left".
export const CLOUD_CREDIT_KEY = 'iguana_necktie';

export function cloudCreditFromUsage(usage) {
  const c = usage?.[CLOUD_CREDIT_KEY];
  if (!c || typeof c.limit_dollars !== 'number' || typeof c.remaining_dollars !== 'number') {
    return null;
  }
  return {
    limitDollars: c.limit_dollars,
    usedDollars: typeof c.used_dollars === 'number' ? c.used_dollars : null,
    remainingDollars: c.remaining_dollars,
    expiresAt: c.resets_at ?? null,
    lockedReason: c.locked_reason ?? null,
  };
}

// --- fs / network ------------------------------------------------------------

function cfgDir() {
  return resolveConfigDir();
}

// Pull the OAuth access token out of `<configDir>/.credentials.json` (null on any
// failure). Exported so cloud-usage-guard reuses it instead of re-implementing the same
// read verbatim (plan 1959 finding [5]).
export function readCredsToken(configDir = cfgDir()) {
  try {
    return tokenFromCredentials(
      JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}

// Force-refresh helper over the shared agent:false HTTPS call (plan 1959 finding [3]).
// Rejects on missing token / non-2xx / timeout / bad JSON — the caller (brain) falls back
// to the on-disk cache. httpsGetStatus never rejects, so we translate its {status, error}
// into the throw shape this function's callers already expect.
async function fetchUsage(token, { timeoutMs = 8000 } = {}) {
  const { url, headers } = usageRequest(token);
  const { status, body, error } = await httpsGetStatus(url, headers, {
    timeoutMs,
    timeoutMessage: 'usage API timeout',
  });
  if (error) throw new Error(error);
  if (status < 200 || status >= 300) throw new Error(`usage API ${status}`);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`usage API bad JSON: ${e.message}`);
  }
}

// The cloud-session credit of the account whose config dir is `configDir` (plan 4232).
// Never throws: `{ credit }` on a readable balance, `{ credit: null, reason }` otherwise —
// the launcher refuses on any null, so an unreadable balance can never start a drain that
// quietly bills the plan. The token is read and sent, never returned or printed.
export async function readCloudCredit(
  configDir,
  { readToken = readCredsToken, fetchUsageFn = fetchUsage } = {},
) {
  const token = readToken(configDir);
  if (!token) return { credit: null, reason: `no OAuth token in ${configDir}` };
  let usage;
  try {
    usage = await fetchUsageFn(token);
  } catch (e) {
    return { credit: null, reason: e.message };
  }
  const credit = cloudCreditFromUsage(usage);
  return credit
    ? { credit }
    : { credit: null, reason: `usage response carries no ${CLOUD_CREDIT_KEY} credit` };
}

// Fetch the live usage meter and overwrite .usage_cache.json. Returns the parsed
// usage object. Throws on missing token / non-2xx / timeout — the caller (brain)
// falls back to the on-disk cache, which is at worst ~2.5 min stale.
async function refresh(opts = {}) {
  const token = readCredsToken();
  if (!token) throw new Error('no OAuth token in .credentials.json');
  const data = await fetchUsage(token, opts);
  // Atomic write via the shared helper (plan 1761 — this was a third hand-rolled
  // tmp+rename copy, without the fsync / close-error / temp-cleanup hardening) so a
  // concurrent statusline refresh — which writes the SAME .usage_cache.json every
  // ~2.5 min — can never observe a torn file.
  atomicWriteJsonSync(join(cfgDir(), '.usage_cache.json'), data);
  return data;
}

async function main() {
  try {
    const data = await refresh();
    console.log(
      JSON.stringify({
        refreshed: true,
        five_hour_utilization: data?.five_hour?.utilization ?? null,
      }),
    );
    return 0;
  } catch (e) {
    console.error('orchestrator-usage-refresh:', e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Set exitCode and let the loop drain naturally (the agent:false socket is
  // already closed) rather than process.exit() — avoids the Windows libuv race.
  main().then((c) => {
    process.exitCode = c;
  });
}
