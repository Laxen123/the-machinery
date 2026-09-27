// scripts/https-status.test.mjs — unit tests for the shared agent:false HTTPS call
// (plan 1959). The happy-path network buffering is integration (exercised by the live
// cloud-usage-guard --report / routine-ctl fire paths), same split as the callers. What
// IS unit-testable network-free — and is the correctness-critical invariant — is the
// NEVER-REJECT contract: a synchronous header-validation throw must resolve with an error
// field, not reject, so the fail-safe callers (getUsage → GO, fetchUsage/fireCall → their
// own throw shape) stay in control instead of crashing on an unhandled rejection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpsRequestStatus, httpsGetStatus } from './https-status.mjs';

// A control byte passes a naive \s-only filter but makes Node's header validator throw
// ERR_INVALID_CHAR synchronously while constructing the request — before any socket.
const CTRL = String.fromCharCode(1);

test('httpsRequestStatus resolves (never rejects) on a synchronous header-validation throw', async () => {
  const res = await httpsRequestStatus('https://api.anthropic.com/never-reached', {
    headers: { 'x-probe': `value${CTRL}` },
  });
  assert.equal(res.status, 0);
  assert.equal(res.body, '');
  assert.deepEqual(res.headers, {});
  assert.ok(res.error, 'carries an error field instead of throwing');
});

test('httpsRequestStatus resolves for the POST (host/path) target form too', async () => {
  const res = await httpsRequestStatus(
    { host: 'api.anthropic.com', path: '/never-reached' },
    { method: 'POST', headers: { authorization: `Bearer x${CTRL}` }, body: '{}' },
  );
  assert.equal(res.status, 0);
  assert.ok(res.error);
});

test('httpsGetStatus delegates the never-reject contract for the GET callers', async () => {
  const res = await httpsGetStatus('https://api.anthropic.com/never-reached', {
    Authorization: `Bearer tok${CTRL}`,
  });
  assert.equal(res.status, 0);
  assert.equal(res.body, '');
  assert.ok(res.error, 'a bad Authorization byte resolves with an error, never throws');
});

test('httpsGetStatus with NO timeoutMs still resolves (never rejects) — default-arg regression', async () => {
  // Regression (plan 1959 review [0]): timeoutMs had no default, so req.setTimeout(undefined)
  // threw a synchronous TypeError inside the Promise executor and REJECTED — the exact
  // unhandled-rejection crash this module exists to prevent. A refused loopback connection
  // reaches the setTimeout line (no synchronous header throw), so this exercises that path;
  // with the fix, timeoutMs floors to a finite default and the connection error resolves.
  const res = await httpsGetStatus('https://127.0.0.1:1/', {});
  assert.equal(res.status, 0);
  assert.ok(res.error, 'resolves with an error, never rejects when timeoutMs is omitted');
});
