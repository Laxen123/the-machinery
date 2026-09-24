// scripts/coord/codex-auth-lib.mjs — the PURE core of the codex/ChatGPT login checks: shape,
// expiry, and the failure-class read of a codex transcript (plan 4096 T3; the functions
// themselves are plan 4019's and 3414's, moved here unchanged).
//
// WHY THIS FILE EXISTS. `gpt-review.mjs` needs exactly three of these — `decodeAuthB64`,
// `authPayloadReason`, `codexFailureClass` — and used to reach them by importing
// `codex-auth-check.mjs`, which drags in `hobby-env.mjs` (the `98 Hobby/` walk-up),
// `mint-codex-auth-b64.mjs` and `sol-cloud-probe.mjs`. That closure is the whole reason
// `gpt-review` and `scripts/hooks/review-round-cap-guard.mjs` were blocked at the coord-kit gate:
// a hobby-root walk-up is a vetapp fact, and nothing in the three functions below depends on it.
// Splitting the PURE core out (rather than moving the three commands) keeps the project-coupled
// halves — `fleetVsLocal`'s master-file comparison, the mint's `--apply` path, the probe's live
// `codex exec` runs — exactly where they were.
//
// ── THE NO-VALUES RULE (inherited from codex-auth-check.mjs / mint-codex-auth-b64.mjs) ─────
// Nothing here ever returns a token, a key, or any base64 of one. Reasons name the FIELD that is
// wrong and never quote its value.
//
// ── ONE COPY OF EACH RULE ──────────────────────────────────────────────────────────────────
// `implausibleAuthReason` came from `mint-codex-auth-b64.mjs` and `transportVerdict` from
// `sol-cloud-probe.mjs`; both of those modules now re-export from here rather than owning a
// definition, so "does this look like a login" and "is this transcript a dead token" still have
// exactly one implementation each — the property both of those files' headers already demanded.

/**
 * Pure: is this decoded payload shaped like a codex login at all? Field names only, never values.
 * The 16-char floor is a sanity bound, not a format check — a real access/refresh token is
 * hundreds of characters, so anything shorter is a truncated or placeholder paste.
 */
export function implausibleAuthReason(auth) {
  if (!auth || typeof auth !== 'object') return 'not a JSON object';
  const t = auth.tokens;
  if (!t || typeof t !== 'object') return 'no `tokens` object';
  for (const f of ['access_token', 'refresh_token']) {
    if (typeof t[f] !== 'string' || t[f].length < 16) return `\`tokens.${f}\` missing or too short`;
  }
  return null;
}

/**
 * Pure: the transport verdict for a `codex exec` transcript. `OK` only when the run exited 0 AND
 * its FINAL line is the marker — a run that printed the marker and then kept going, or crashed
 * with the marker somewhere in its output, has not proven transport. `TOKEN_ROTTEN` is the
 * ChatGPT login's rotated-refresh-token death; everything else is `FAILED`.
 */
export function transportVerdict(text = '', code = 0) {
  const last = (text.split('\n').pop() || '').trim();
  if (code === 0 && /^TRANSPORT_OK\b/.test(last)) return 'OK';
  return /refresh_token_reused|\b401\b/i.test(text) ? 'TOKEN_ROTTEN' : 'FAILED';
}

/** Pure: a JWT's middle segment, base64url → JSON, or null on anything that is not a 3-part JWT
 *  or fails to parse. An opaque (non-JWT) token is UNKNOWN, not expired — callers must not read
 *  `exp: null` as "expired". */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Pure: is the `access_token` expired, as of `now` (a REQUIRED parameter — the ambient-clock rule,
 * vetapp CLAUDE.md: a test injects a fixed instant, never races `Date.now()`). `now` is a `Date` or
 * an epoch-millisecond number.
 *
 * `id_token` is deliberately NOT consulted: measured, the live working local login carries an
 * `id_token` that expired 5 hours earlier (1-hour lifetime) while its `access_token` had 9.8 days
 * left — treating `id_token.exp` as a health signal would report every healthy login as broken.
 *
 * An exp check alone does not catch every death: the refresh token ROTATES on use, so a
 * rotated-away token can be well inside its `exp` window and already dead. `fleetVsLocal`
 * (codex-auth-check.mjs) is the check for THAT; this is one axis, reported, never the sole verdict.
 */
export function accessTokenExpiry(auth, now) {
  const payload = decodeJwtPayload(auth?.tokens?.access_token);
  const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) return { exp: null, expired: false, secondsLeft: null };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const secondsLeft = exp - Math.floor(nowMs / 1000);
  return { exp, expired: secondsLeft <= 0, secondsLeft };
}

/**
 * Pure: the ONE shape+expiry verdict on a decoded auth payload, so "does this look like a login"
 * and "is it still alive" cannot drift into three hand-rolled copies (plan 4019 fix round 2,
 * H1/H3 — round 1 already had this exact drift: gpt-review.mjs's `validateExistingAuth` checked
 * shape+expiry while codex-auth-check.mjs's env path checked shape only).
 *
 * `now` is deliberately OPTIONAL, not folded in unconditionally: `decodeAuthB64`'s own CLI caller
 * (`codex-auth-check.mjs`'s `main()`) needs the shape verdict (exit 3) and the expiry verdict
 * (exit 4) kept SEPARATELY distinguishable, so it computes expiry itself and never passes `now`
 * here — passing it would collapse both failures into exit 3 and lose the distinction that CLI's
 * own exit-code contract depends on.
 */
export function authPayloadReason(auth, now) {
  const reason = implausibleAuthReason(auth);
  if (reason) return reason;
  if (now !== undefined) {
    const expiry = accessTokenExpiry(auth, now);
    if (expiry.expired) return `access token expired (exp ${expiry.exp})`;
  }
  return null;
}

/**
 * Pure: base64 → UTF-8 → JSON.parse, then the SAME shape check `mint-codex-auth-b64.mjs` uses
 * before minting onto four cloud accounts. `Buffer.from(x, 'base64')` essentially never throws —
 * garbage decodes "successfully" — so `JSON.parse` is the first real check. Never includes the
 * input value in the returned reason. `now` is optional and forwarded to `authPayloadReason` —
 * see that function's header for why the CLI never passes it.
 */
export function decodeAuthB64(b64, now) {
  if (typeof b64 !== 'string' || b64.length === 0) {
    return { ok: false, auth: null, reason: 'the codex auth b64 payload is empty or not a string' };
  }
  let auth;
  try {
    auth = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, auth: null, reason: `not valid JSON after base64 decode (${e.message})` };
  }
  const reason = authPayloadReason(auth, now);
  if (reason) return { ok: false, auth, reason };
  return { ok: true, auth, reason: null };
}

// The exact two-token shape codex emits (measured 2026-09-14, plan 4019 § Why): "You've hit your
// usage limit. Upgrade to Plus to continue using Codex … try again at Oct 14th, 2026 11:21 AM."
// ONE pattern requiring both phrases in the SAME error region, not two independent `.test()`
// calls each free to match anywhere in the combined transcript (fix round 1, G5 / finding
// ca1aad): the independent form let an UNRELATED "try again at" elsewhere in stdout — a retry
// backoff message, a doc excerpt the diff quotes — combine with a merely-mentioned "usage limit"
// to false-positive as this failure, hiding the real cause and reporting a false reset date. The
// 200-char window covers the measured real message (the two phrases sit ~80 chars apart) with
// room for codex to vary the wording between them.
//
// fix round 2, H7 (findings cfd884/6706a7): a character count alone is PROXIMITY, not an error
// REGION boundary — 200 chars of ordinary prose can easily contain an incidental "usage limit"
// mention and an unrelated "try again at" a paragraph later. Codex emits prose, not a
// machine-parseable error structure, so there is no error-region delimiter to anchor on except
// the one the format DOES offer: a blank line is a real paragraph break in this transcript, and
// the pattern below refuses to cross one. `(?!\n[ \t]*\n)` is evaluated at every position the
// `{0,200}?` body would otherwise consume, so the match stops dead at the first blank line
// instead of reading through it — turning a pure proximity heuristic into one anchored on the
// only region boundary this format has, per the round-1 G5 ruling's original intent. The same
// "anchor on the error region, not any occurrence anywhere in the text" discipline
// `transportVerdict` above already applies to its own OK marker.
//
// fix round 3, J3 (findings ede865/a68d51/19b6a6/248eed/d56365/51e267/d80103 — six angles): the
// H7 guard above was LF-only (`\n[ \t]*\n`). A Windows transcript's paragraph break is
// `\r\n\r\n`, which that lookahead never matches — codex's raw child stdout/stderr is
// accumulated and classified with no CRLF normalization anywhere in gpt-review.mjs, and this
// rule's own gates run on Windows — so on the platform this repo's push gate actually runs on,
// the H7 boundary was not there at all. Widening the lookahead to accept an optional `\r` before
// each `\n` is preferred over normalizing the input: normalizing would copy the whole transcript
// on every classification call to fix a two-character problem.
const USAGE_LIMIT_RE = /usage limit(?:(?!\r?\n[ \t]*\r?\n)[\s\S]){0,200}?try again at ([^\n.]+)/i;

/**
 * Pure: classify a codex failure from its transcript, so a drain can say "codex usage limit,
 * reported reset <date>" without a human opening `finders/*.stderr.txt`. One of `ok` /
 * `usage-limit` / `token-rotten` / `transport`. Delegates the token-rotten half to
 * `transportVerdict()` above rather than re-rolling its 401/`refresh_token_reused` rule — a second
 * copy that disagrees with the first is the exact failure that function's own header warns
 * against. `code` alone can never discriminate: codex returns rc=1 for auth, quota and bad-args
 * alike, so the text is the only signal that can.
 *
 * `reportedResetAt` is named for what it IS, never for what it decides: the date codex prints in
 * its own error text, reported as-is, NOT an authoritative schedule. Measured 2026-09-14 (plan
 * 4019 sitting): the same session that hit "try again at Oct 14th, 2026" that morning was usable
 * again — clean exit 0 — the same afternoon, so the date codex prints has already been observed
 * wrong. A caller must not use it to decide "do not retry until then"; a cheap one-call probe,
 * not this string, is the trustworthy signal for whether the limit has actually cleared.
 */
export function codexFailureClass(text = '', code = 0) {
  const t = String(text ?? '');
  const usageLimitMatch = USAGE_LIMIT_RE.exec(t);
  if (usageLimitMatch) {
    return { class: 'usage-limit', reportedResetAt: usageLimitMatch[1].trim() };
  }
  const verdict = transportVerdict(t, code);
  if (verdict === 'TOKEN_ROTTEN') return { class: 'token-rotten', reportedResetAt: null };
  if (verdict === 'OK') return { class: 'ok', reportedResetAt: null };
  return { class: 'transport', reportedResetAt: null };
}
