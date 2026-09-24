// scripts/coord/ensure-coord-reroute.mjs
// plan 1770: let Claude Code CLOUD sessions push the coordination refs (refs/claims/*,
// refs/coord/*) and ref-deletions that the mandatory in-cloud git proxy 403s.
//
// THE PROBLEM (diagnosed + proven, session 2026-07-13; full write-up in plan 1770). A cloud
// checkout pins `remote.origin.url` to `http://local_proxy@127.0.0.1:<per-boot-port>/git/<owner>/<repo>`.
// That proxy allows ordinary `refs/heads/*` creates but returns HTTP 403 on `refs/claims/*`,
// `refs/coord/*`, and ALL ref deletions — so every plan claim (a `refs/claims/<id>` CAS), every
// session-counter bump (`refs/coord/session-counter`), and every claim-release (a delete) fails,
// and a cloud session can execute+review+push a branch but can NEVER run the vetapp claim/land spine.
//
// THE FIX (run-time, because setup-time is impossible — plan 1728's abandoned approach). At RUN time
// the proxy's fingerprints exist (the origin URL is baked into `.git/config` at checkout, and a
// repo-scoped token is injected as an env var, under the name `coord.config.json`'s `gitPatEnvVar`
// key names, default GIT_PUSH_TOKEN), so we install a global git rule that
// reroutes only PUSHES straight to github.com while FETCHES stay on the proxy:
//   git config --global url."https://github.com/<owner>/<repo>".pushInsteadOf "<proxy-origin-url>"
// `pushInsteadOf` rewrites the push URL (proxy→github) and WINS over the env's forced insteadOf
// (github→proxy) for pushes, leaving fetch on the proxy (verified locally + against the live cloud
// git-config diagnostic). The github repo is DERIVED from the proxy origin's `<owner>/<repo>` path
// (never hardcoded) so a sibling repo that adopts this file reroutes to ITS OWN github repo, not
// this one's. A github-SCOPED credential helper feeds the PAT for the push; it reads the configured
// PAT env var from the env at push time so the token is NEVER written into a URL or config value,
// and it is scoped to the github.com credential context so it neither wipes nor shadows the ambient
// global helper the cloud env uses for the proxy.
//
// THE SECOND SHAPE (plan 2863). The FULL-egress envs are proxied DIFFERENTLY — origin is already the
// direct github URL, so the reroute above is a definitive no-op, yet a transparent proxy at
// `$HTTPS_PROXY` still 403s the coord refs. Its fix is a host-scoped proxy-unset, in its own
// mutually-exclusive branch below; see the block comment above `directHostUrlFromOrigin`.
//
// GATED so it is invisible/harmless everywhere else: a no-op unless the configured PAT env var is set
// AND `remote.origin.url` matches one of the two cloud shapes (local-proxy origin → reroute;
// direct-https origin PLUS `$HTTPS_PROXY` → bypass). On the operator's machine (no PAT set) and on any
// ordinary CI (no proxy origin, no proxy env) it touches nothing. Callers install it through the shared
// installCoordRerouteOnce() latch below (coord-git's git() push seam + the done-worktree spine
// up-front): one install episode per process, with a bounded inner retry to ride out a transient
// config-lock, then latch — so a blip never permanently disables it and a persistent failure never
// re-spawns git on every push.
//
// GIT PAT ENV VAR NAME: `coord.config.json`'s `gitPatEnvVar` key (a plain string), read directly
// (bespoke JSON.parse below) rather than via coord-config.mjs's loadCoordConfig — that module
// imports coord-git.mjs, which imports THIS file (see sleepSync's comment below), so a loadCoordConfig
// import here would cycle. Missing file/key/malformed value all degrade to the generic default
// GIT_PUSH_TOKEN, never a throw — a config-read failure must never block a push this module exists to
// unblock.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitRepoIsolatedEnv } from './child-env.mjs';

export const DEFAULT_GIT_PAT_ENV_VAR = 'GIT_PUSH_TOKEN';

// Bespoke direct read (see header comment) — mirrors cloud-checkout-preflight.mjs's
// readLocalHostDenylist in spirit: any failure (missing file, bad JSON, wrong type) degrades to the
// generic default rather than throwing.
export function readGitPatEnvVar(dir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir || process.cwd(), 'coord.config.json'), 'utf8'));
  } catch {
    return DEFAULT_GIT_PAT_ENV_VAR;
  }
  const name = raw && raw.gitPatEnvVar;
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_GIT_PAT_ENV_VAR;
}

// The local-proxy userinfo anchor: `local_proxy` must be the userinfo USERNAME immediately after the
// scheme (optionally `:password`), NOT a loose substring — a host like `mirror-of-local_proxy.example.com`
// or a user `local_proxy2@` must NOT match. Owner/repo is then extracted structurally (URL parse), not
// by a brittle end-anchored path regex, so a slightly-different proxy path shape still resolves.
export const PROXY_ORIGIN_RX = /^https?:\/\/local_proxy(?::[^@]*)?@/;

// The credential CONTEXT the scoped helper answers, for a given host URL. Host-level (not repo-path)
// so it matches without needing `useHttpPath` — the injected PAT is github-scoped, and a cloud coord
// session pushes to exactly one github repo, so host scoping is both sufficient and predictable.
const credentialContextFor = (hostUrl) => `credential.${hostUrl}.helper`;
const GITHUB_CREDENTIAL_CONTEXT = credentialContextFor('https://github.com');

// The credential helper VALUE: a one-shot shell function answering github's credential query with the
// PAT read from the ambient env (under the configured `gitPatEnvVar` name) at push time (never
// persisted). x-access-token is github's conventional username for a PAT over https.
function credentialHelperFor(patEnvVar) {
  return `!f() { echo username=x-access-token; echo "password=$${patEnvVar}"; }; f`;
}

// Derive the canonical github https URL from a local-proxy origin. The origin must have `local_proxy`
// as its userinfo user (PROXY_ORIGIN_RX) AND the observed proxy path shape `/git/<owner>/<repo>[/…]`;
// `<owner>/<repo>` are the two segments right after the `git` mount (tolerating trailing segments, but
// NOT a short path missing the repo — that returns null, a SAFE no-op, rather than mis-deriving a bogus
// `git/<owner>` repo). Returns null for any non-proxy origin, an unparseable URL, or a path with no
// `/git/` mount or fewer than owner+repo after it — the caller then leaves pushes on the proxy 403 it
// already handles, never silently rerouting to a wrong repo.
export function githubUrlFromProxyOrigin(origin) {
  if (!PROXY_ORIGIN_RX.test(origin)) return null;
  let pathname;
  try {
    ({ pathname } = new URL(origin));
  } catch {
    return null;
  }
  const segs = pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  const gitIdx = segs.indexOf('git');
  if (gitIdx < 0) return null; // require the observed `/git/` mount
  const rel = segs.slice(gitIdx + 1);
  if (rel.length < 2) return null; // need at least <owner>/<repo> after the mount
  return `https://github.com/${rel[0]}/${rel[1]}`;
}

// ─── The FULL-egress fingerprint (plan 2863) ────────────────────────────────
// A SECOND cloud shape the plan-1770 branch above is definitively blind to. In the FULL-egress
// (`FETCH_VANTAGE=datacenter`) envs, `remote.origin.url` is ALREADY the direct github https URL — so
// `githubUrlFromProxyOrigin` returns null and the reroute is a no-op — yet a TRANSPARENT egress proxy
// still sits at `$HTTPS_PROXY`, and it hard-403s `refs/claims/*` and ref DELETEs while REPLACING the
// github `Authorization` header outright. No credential-side fix can work there: the proxy overwrites
// the very header the helper feeds it. The proven fix is to take github OUT of the proxy's path for
// this host — `git config --global http.<host>.proxy ""` (git's documented "disable proxying"
// sentinel). With exactly that one line, session 2732 claimed plan 2860, pushed coord writes, and
// LANDED including the branch delete (docs/handoff/infra-debt.md:170).
//
// Left unfixed this is not a rare degradation but a PERMANENT one: the claim can never succeed, the
// plan never leaves `ready/`, and every account's cron re-picks it from scratch forever. Measured cost
// before the fix: 9+ redundant full plan executions across five plans in a single day.
//
// Derive the host URL from origin, never hardcode github — same principle as
// `githubUrlFromProxyOrigin`, so a sibling repo adopting this file bypasses ITS OWN host's proxy.
// Returns null for anything that is not a bare `https://<host>[:port]/…` origin: a userinfo-bearing
// URL (the local-proxy shape handled above), a non-https scheme, or an unparseable URL.

export function directHostUrlFromOrigin(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  // Userinfo means a credentialed/proxied origin (`local_proxy@…`), never the direct shape.
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  return `https://${u.host}`; // `host` keeps an explicit port; `hostname` would drop it
}

// Is a transparent egress proxy configured for this process AND actually in front of `host`? Both
// spellings of each variable are read because the cloud env sets the upper-case one while much
// tooling honours the lower-case one. An empty value is "unset" (git and curl both treat it so).
//
// The NO_PROXY check is the narrowing the review asked for: if the host is ALREADY exempted from the
// proxy, there is no proxy in its path and nothing for us to bypass — so we must not write a global
// config entry for it. Matching follows the curl/git convention: a bare host matches itself, and a
// leading-dot (or bare parent) entry matches subdomains. A lone `*` disables proxying entirely.
function proxiedHost(env, host) {
  if (!(env.HTTPS_PROXY || env.https_proxy)) return false;
  const bare = String(host).split(':')[0].toLowerCase();
  const noProxy = String(env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (noProxy.includes('*')) return false;
  return !noProxy.some((e) => bare === e || bare.endsWith(`.${e}`));
}

// Run a git command, returning trimmed stdout. `dir` scopes repo-local reads (`-C <dir>`); global
// config writes ignore it. Throws on non-zero exit (caller decides whether that is fatal).
function git(args, { dir } = {}) {
  const full = dir ? ['-C', dir, ...args] : args;
  return execFileSync('git', full, { encoding: 'utf8', env: gitRepoIsolatedEnv() }).trim();
}

/**
 * Idempotently install the cloud coord-push reroute IFF this is a proxied cloud checkout with a PAT.
 * Distinguishes DEFINITIVE no-ops (return {applied:false}) from RETRIABLE failures (throw): a missing
 * PAT (not a cloud session) and a non-proxy origin are definitive; a git failure reading origin or
 * writing config is left to THROW so installCoordRerouteOnce()'s bounded inner retry can absorb it.
 *
 * @param {string} [dir] repo dir to read `remote.origin.url` from (default: git's cwd resolution);
 *   also where `coord.config.json`'s `gitPatEnvVar` is read from.
 * @param {object} [opts]
 * @param {object} [opts._env] env to read the configured PAT var from (test seam; default process.env).
 * @param {(args:string[],o?:object)=>string} [opts._git] git runner (test seam; default execFileSync).
 * @returns {{applied:boolean, mode?:'proxy-reroute'|'proxy-bypass', reason?:string, origin?:string, githubUrl?:string, hostUrl?:string}}
 *   applied:true only when config was written. `mode` names WHICH cloud shape was fixed:
 *   'proxy-reroute' = the local-proxy origin got a pushInsteadOf to github (plan 1770);
 *   'proxy-bypass'  = a direct-https origin behind a transparent egress proxy got that proxy
 *                     unset for its host (plan 2863). `githubUrl`/`hostUrl` are per-mode.
 */
export function ensureCoordReroute(dir, { _env = process.env, _git = git } = {}) {
  const patEnvVar = readGitPatEnvVar(dir);
  const pat = _env[patEnvVar];
  // Local machine (and any env without the token): the reroute is neither needed nor safe to install
  // (we have no PAT to authenticate the github push). DEFINITIVE — the env will not sprout a PAT
  // mid-process, so latch and never re-check. This is also the local hot path (no git spawn at all).
  if (!pat) return { applied: false, reason: `${patEnvVar} unset (local/non-cloud)` };

  // Read origin WITHOUT swallowing failures: a genuine "no origin" only happens with a PAT set but no
  // remote (pathological), and a transient locked/corrupt .git/config should be RETRIED, not latched
  // off — so we let this throw to installCoordRerouteOnce()'s bounded inner retry rather than
  // mis-reporting it as a definitive no-op.
  const origin = _git(['config', '--get', 'remote.origin.url'], { dir });
  // Only a local-proxy origin needs the pushInsteadOf reroute; an ordinary github/other origin (e.g. a
  // PAT set on a non-proxied CI) must be left untouched by THAT branch. A non-proxy origin is
  // DEFINITIVE (the origin won't morph), so it falls through to the FULL-egress branch and then
  // returns — never throws.
  const githubUrl = githubUrlFromProxyOrigin(origin);
  if (!githubUrl) {
    // ── FULL-egress branch (plan 2863) — mutually exclusive with the local-proxy branch below by
    // construction: `githubUrlFromProxyOrigin` returned null, so this origin is NOT the proxy shape.
    // All three fingerprint conditions must hold. The PAT gate above already returned for the
    // operator's local machine, and requiring `$HTTPS_PROXY` keeps this off any ordinary non-proxied
    // CI that happens to carry a PAT — so an unconditional proxy-unset can never mutate a human's
    // global git config. There is no pushInsteadOf here and nothing to derive a repo from: the origin
    // is already the right URL, the ONLY thing wrong is the proxy in front of it.
    //
    // On the ENV-gated vs PROBE-gated asymmetry (raised in review, and deliberate): the ROUTINE
    // PROSE retries the bypass only after a probe has actually failed, because that text is shared
    // byte-identically with the trusted lane and must be inert where claiming already works. This
    // function has no probe to gate on — it runs inside a push seam — so it gates on the fingerprint
    // instead, and the fingerprint is what keeps it equally inert: the trusted lane's origin IS the
    // local-proxy shape and takes the branch below, and a machine with no PAT returned long ago.
    const candidateHost = directHostUrlFromOrigin(origin);
    const hostUrl =
      candidateHost && proxiedHost(_env, new URL(candidateHost).host) ? candidateHost : null;
    if (hostUrl) {
      // Credential helper FIRST, proxy-unset LAST — the same fail-safe ordering as the branch below:
      // if the credential step throws, the proxy is still in place and pushes keep 403ing the way the
      // caller already handles, rather than reaching the host unauthenticated. Both writes are
      // `--replace-all` idempotent, so the bounded retry converges.
      _git(['config', '--global', '--replace-all', credentialContextFor(hostUrl), '']);
      _git([
        'config',
        '--global',
        '--add',
        credentialContextFor(hostUrl),
        credentialHelperFor(patEnvVar),
      ]);
      // Git's documented "disable proxying" sentinel for this host: an EMPTY http.<url>.proxy value.
      _git(['config', '--global', '--replace-all', `http.${hostUrl}.proxy`, '']);
      return { applied: true, mode: 'proxy-bypass', origin, hostUrl };
    }
    return { applied: false, reason: `origin is not the local proxy (${origin})` };
  }

  // Install the github-scoped credential helper FIRST, then the pushInsteadOf rewrite LAST, so a
  // partial failure fails SAFE: if the credential step throws, pushInsteadOf is not yet installed and
  // pushes still go to the proxy (the known, already-handled 403) rather than to github unauthenticated.
  // A throw propagates to installCoordRerouteOnce()'s bounded inner retry; every write below is
  // idempotent, so a retry converges. The credential change is CONFINED to the github.com context: `--replace-all
  // …helper ""` resets JUST that context's helper list (an empty value is git's "clear the inherited
  // list" sentinel), then `--add …helper <ours>` makes ours the only helper github sees — WITHOUT
  // touching the ambient global `credential.helper` the cloud env uses for the proxy fetch, and WITHOUT
  // answering any non-github host.
  _git(['config', '--global', '--replace-all', GITHUB_CREDENTIAL_CONTEXT, '']);
  _git(['config', '--global', '--add', GITHUB_CREDENTIAL_CONTEXT, credentialHelperFor(patEnvVar)]);
  // --replace-all keeps re-invocation idempotent: the pushInsteadOf value is set to exactly this
  // origin, never accumulated. Pushes to the proxy URL are rewritten to the github URL; fetches, which
  // git does not run through pushInsteadOf, stay on the proxy.
  _git(['config', '--global', '--replace-all', `url.${githubUrl}.pushInsteadOf`, origin]);

  return { applied: true, mode: 'proxy-reroute', origin, githubUrl };
}

// Inner retries WITHIN a single install episode, to ride out a brief `--global` config-lock (a Windows
// AV/FS lock, or — only ever on a shared local clone, never a single-process cloud sandbox — a sibling
// mid-write). Small backoff between tries; a lock clears in ms. This handles transience WHERE IT
// OCCURS so the OUTER latch can fire exactly once per process (no per-push git-spawn storm).
export const REROUTE_INSTALL_ATTEMPTS = 3;
const REROUTE_RETRY_BACKOFF_MS = 100;

// Synchronous sleep (ensureCoordReroute's git calls are execFileSync, so the retry loop must block the
// thread). Atomics.wait on a throwaway SharedArrayBuffer is the standard sync-sleep; a lock held by
// another OS process can clear mid-wait. Kept local so this module has no coord-git import (coord-git
// imports THIS — the reverse would cycle).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Process-global install latch. Keyed to the process, not per-origin, by DESIGN: every coord push in a
// single process targets the one vetapp clone/origin — the disposable coord-checkout is a linked
// worktree of the SAME clone sharing the SAME origin — so one latch is correct (see plan 1770 review
// disposition). `done` closes after the SINGLE install episode below (whatever its outcome).
let _rerouteState = { done: false };

// Test seam: reset the module latch between cases.
export function _resetRerouteState() {
  _rerouteState = { done: false };
}

/**
 * The ONE reroute entry point every caller shares (coord-git's git() push seam + done-worktree's
 * up-front spine call), so the latch + the retry + the log/catch wrapper live in exactly one place —
 * not duplicated per call site, and not double-installing across the two. Idempotent and cheap once
 * latched (returns immediately). Never throws: a reroute failure must never block the push itself (a
 * persistent cloud failure surfaces as the same proxy 403 the caller already handles).
 *
 * RETRY POLICY (plan 1770, settled across four review rounds — the design that dominates all of them):
 * transience is handled WHERE IT OCCURS via a BOUNDED INNER retry (REROUTE_INSTALL_ATTEMPTS, short
 * backoff) that rides out a brief `--global` config-lock within THIS call, and the OUTER latch then
 * fires exactly ONCE per process. So a transient blip is absorbed (never permanently disables the
 * reroute — the earlier latch-before-attempt bug) AND a persistent failure never re-spawns git on
 * every push for a multi-hour window (the earlier unbounded-retry cost) — it exhausts the few inner
 * tries once, logs once, and latches off (retrying across pushes could not fix a persistent failure
 * anyway, and the push 403s identically either way).
 *
 * @param {string} [dir] repo dir passed through to ensureCoordReroute.
 * @param {object} [opts]
 * @param {(m:string)=>void} [opts.log] logger (default console.error).
 * @param {(d:string)=>object} [opts._ensure] ensureCoordReroute injection (test seam).
 * @param {(ms:number)=>void} [opts._sleep] sleep injection (test seam; default real sync sleep).
 * @returns {{done:boolean, applied?:boolean}} a SNAPSHOT of the outcome (a copy, not the live object).
 */
export function installCoordRerouteOnce(
  dir,
  { log = (m) => console.error(m), _ensure = ensureCoordReroute, _sleep = sleepSync } = {},
) {
  if (_rerouteState.done) return { ..._rerouteState };
  _rerouteState.done = true; // ONE install episode per process — latch now, whatever its outcome
  let lastErr;
  for (let attempt = 1; attempt <= REROUTE_INSTALL_ATTEMPTS; attempt++) {
    try {
      const r = _ensure(dir);
      if (r.applied)
        log(
          r.mode === 'proxy-bypass'
            ? `[coord-git] cloud coord-push proxy bypass installed (pushes to ${r.hostUrl} skip $HTTPS_PROXY)`
            : `[coord-git] cloud coord-push reroute installed (pushes ${r.origin} → ${r.githubUrl})`,
        );
      return { ..._rerouteState, applied: !!r.applied };
    } catch (e) {
      lastErr = e;
      if (attempt < REROUTE_INSTALL_ATTEMPTS) _sleep(REROUTE_RETRY_BACKOFF_MS);
    }
  }
  // Exhausted the inner tries — a persistent failure (read-only HOME, a stuck lock). Log ONCE; pushes
  // stay on the proxy (the same 403 the caller already handles). No cross-push re-probe storm.
  log(
    `[coord-git] coord-push reroute install failed after ${REROUTE_INSTALL_ATTEMPTS} attempts ` +
      `(pushes stay on the proxy): ${lastErr.message}`,
  );
  return { ..._rerouteState };
}
