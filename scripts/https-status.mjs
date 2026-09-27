#!/usr/bin/env node
// scripts/https-status.mjs — the ONE `agent:false` HTTPS call shared by the
// usage-metering scripts (plan 1959, consolidating the triplicated boilerplate in
// cloud-usage-guard `getUsage`, orchestrator-usage-refresh `fetchUsage`, and
// routine-ctl `fireCall`).
//
// WHY agent:false: Node's global `fetch` (and the default keep-alive agent) pool the
// socket; exiting the process while that socket is mid-close trips a libuv
// UV_HANDLE_CLOSING assertion on Windows — a call that already succeeded then reports a
// non-zero exit and the caller mis-reads it as a failure. `agent:false` closes the socket
// after the response instead, sidestepping the race. (This is the note every one of the
// three original call sites carried.)
//
// CONTRACT: `httpsRequestStatus` ALWAYS resolves `{ status, body, headers, error? }` and
// NEVER rejects — so each caller layers its own status policy (fail-safe GO, reject-on-
// non-2xx, redacted-throw) on top without re-implementing the socket plumbing. The
// try/catch covers `https.request` validating a header value and throwing ERR_INVALID_CHAR
// SYNCHRONOUSLY on a control / non-Latin1 byte (a broad-scanned bearer token can carry
// one); we still resolve, so the never-reject contract holds. On a network error or a
// timeout the result is `{ status: 0, body: '', headers: {}, error }` (timeout surfaces as
// `error: 'timeout'`; callers that want a labelled message wrap it themselves).

import { request as httpsRequest } from 'node:https';

// Timeout floor when a caller omits timeoutMs. A bare `req.setTimeout(undefined, …)` throws
// a synchronous TypeError, and inside the Promise executor that would REJECT — breaking the
// never-rejects contract for any caller using the documented-optional timeoutMs (e.g. the
// 2-arg httpsGetStatus form). So timeoutMs ALWAYS resolves to a finite number here.
const DEFAULT_TIMEOUT_MS = 10_000;

// `target` is passed straight to https.request: a URL string (the GET callers) or an
// options object with host/path (the POST caller). method / headers / body layer on top of
// it via the opts arg — pass them there, not inside an options-object `target`, so the
// forced `agent:false` and the opts win deterministically. On a timeout the error text is
// `timeoutMessage` (default 'timeout') so a caller keeps its own labelled string.
export function httpsRequestStatus(
  target,
  { method = 'GET', headers = {}, body = null, timeoutMs, timeoutMessage = 'timeout' } = {},
) {
  return new Promise((resolve) => {
    const onResponse = (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    };
    let req;
    try {
      req =
        typeof target === 'string'
          ? httpsRequest(target, { method, headers, agent: false }, onResponse)
          : httpsRequest({ ...target, method, headers, agent: false }, onResponse);
    } catch (e) {
      // Synchronous header-validation throw (ERR_INVALID_CHAR) — resolve, don't reject.
      resolve({ status: 0, body: '', headers: {}, error: e.message });
      return;
    }
    req.on('error', (e) => resolve({ status: 0, body: '', headers: {}, error: e.message }));
    // Guard AND default: never call setTimeout with a non-number (would throw → reject).
    const ms = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    req.setTimeout(ms, () => req.destroy(new Error(timeoutMessage)));
    if (body != null) req.write(body);
    req.end();
  });
}

// GET convenience — the exact seam plan 1959 finding [3] named: `httpsGetStatus(url,
// headers, { timeoutMs }) -> { status, body, headers, error? }`. `headers` is included in
// the result (a superset of the finding's {status,body,error}) because getUsage reads the
// Retry-After response header off it to back off a 429'd account. getUsage / fetchUsage
// wrap this; the POST caller (fireCall) wraps httpsRequestStatus directly. timeoutMessage
// is forwarded so a GET caller keeps its own labelled timeout string.
export function httpsGetStatus(url, headers, { timeoutMs, timeoutMessage } = {}) {
  return httpsRequestStatus(url, { method: 'GET', headers, timeoutMs, timeoutMessage });
}
