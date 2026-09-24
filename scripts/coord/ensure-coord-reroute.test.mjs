// scripts/ensure-coord-reroute.test.mjs
// plan 1770: unit-proof the cloud coord-push reroute — the gate (no-op unless BOTH a PAT and a proxy
// origin), the anchored proxy-shape match + URL-derived github repo, the installed git config (BOTH
// the pushInsteadOf rule AND the github-scoped credential helper), the load-bearing git semantic
// (pushInsteadOf beats the cloud env's forced insteadOf), and the shared installCoordRerouteOnce
// once-per-process latch with a bounded inner retry (transient throw absorbed, then latched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { g } from '../_land-sandbox.mjs';
import {
  ensureCoordReroute,
  installCoordRerouteOnce,
  _resetRerouteState,
  REROUTE_INSTALL_ATTEMPTS,
  githubUrlFromProxyOrigin,
  directHostUrlFromOrigin,
  PROXY_ORIGIN_RX,
} from './ensure-coord-reroute.mjs';

const PROXY_ORIGIN = 'http://local_proxy@127.0.0.1:54321/git/octocat/vetapp';
const GITHUB_URL = 'https://github.com/octocat/vetapp';

// One git runner with `--global` (and repo reads) pinned to an isolated global config file, so
// `--global` writes land in a temp file — never the operator's ~/.gitconfig. Trims by default; pass
// {raw:true} / {input} for the callers that need the untrimmed / stdin-fed form.
function gitCfg(globalCfg, args, { raw = false, input } = {}) {
  const out = execFileSync('git', args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg },
  });
  return raw ? out : out.trim();
}

// A throwaway repo + an ISOLATED global gitconfig. Returns {dir, globalCfg, cleanup}.
function makeRepo({ origin, extraGlobal } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coord-reroute-'));
  const globalCfg = join(dir, '.gitconfig-global');
  writeFileSync(globalCfg, extraGlobal || '');
  execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  if (origin) g(dir, ['remote', 'add', 'origin', origin]);
  return { dir, globalCfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Run ensureCoordReroute with `--global` writes pinned to `globalCfg` for the duration (the helper's
// git() runner inherits process.env), restoring the ambient GIT_CONFIG_GLOBAL afterwards.
function rerouteWithGlobal(dir, globalCfg, env) {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    return ensureCoordReroute(dir, { _env: env });
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
}

// A remote's fetch/push URL under the isolated global config — the view git uses at push time.
function remoteUrls(dir, globalCfg) {
  return {
    fetch: gitCfg(globalCfg, ['-C', dir, 'remote', 'get-url', 'origin']),
    push: gitCfg(globalCfg, ['-C', dir, 'remote', 'get-url', '--push', 'origin']),
  };
}

// All values of a git-config key (empty array when unset). NUL-delimited (`-z`) so an EMPTY value (the
// credential-context reset sentinel) is preserved, not swallowed by trim()/newline-splitting.
function globalConfigValues(globalCfg, key) {
  let out;
  try {
    out = gitCfg(globalCfg, ['config', '--global', '--get-all', '-z', key], { raw: true });
  } catch {
    return []; // exit 1 when the key is absent
  }
  if (!out) return [];
  const parts = out.split('\0');
  parts.pop(); // drop the trailing '' after the final NUL terminator
  return parts;
}

test('githubUrlFromProxyOrigin: derives owner/repo, anchors local_proxy userinfo, tolerates path shape', () => {
  assert.equal(githubUrlFromProxyOrigin(PROXY_ORIGIN), GITHUB_URL);
  assert.equal(
    githubUrlFromProxyOrigin('http://local_proxy@127.0.0.1:9/git/octocat/tandapp'),
    'https://github.com/octocat/tandapp',
    'derives the SIBLING repo, not a hardcoded vetapp',
  );
  // owner/repo are the two segments after the `/git/` mount; trailing segments are tolerated.
  assert.equal(
    githubUrlFromProxyOrigin('http://local_proxy@h/git/octocat/vetapp/extra'),
    GITHUB_URL,
  );
  // A SHORT path missing the repo must return null (a safe no-op), NOT mis-derive `git/<owner>`.
  assert.equal(githubUrlFromProxyOrigin('http://local_proxy@h/git/octocat'), null);
  // No `/git/` mount at all → null (never silently reroute to a wrong repo).
  assert.equal(githubUrlFromProxyOrigin('http://local_proxy@h/octocat/vetapp'), null);
  // A host or user that merely CONTAINS 'local_proxy' must NOT match (the substring-match bug).
  assert.equal(githubUrlFromProxyOrigin('https://mirror-of-local_proxy.example.com/git/a/b'), null);
  assert.equal(githubUrlFromProxyOrigin('http://local_proxy2@host/git/a/b'), null);
  assert.equal(githubUrlFromProxyOrigin('https://github.com/octocat/vetapp'), null);
  assert.ok(!PROXY_ORIGIN_RX.test('https://mirror-of-local_proxy.example.com/git/a/b'));
  assert.ok(PROXY_ORIGIN_RX.test(PROXY_ORIGIN));
});

test('ensureCoordReroute: no-op when GIT_PUSH_TOKEN is unset (the local-machine case)', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN });
  try {
    const r = ensureCoordReroute(dir, { _env: {} });
    assert.equal(r.applied, false);
    assert.equal(remoteUrls(dir, globalCfg).push, PROXY_ORIGIN); // nothing written
    assert.deepEqual(globalConfigValues(globalCfg, 'credential.https://github.com.helper'), []);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: no-op when origin is NOT the local proxy (ordinary github/CI origin)', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = ensureCoordReroute(dir, { _env: { GIT_PUSH_TOKEN: 'tok' } });
    assert.equal(r.applied, false);
    assert.match(r.reason, /not the local proxy/);
    assert.equal(remoteUrls(dir, globalCfg).push, GITHUB_URL); // untouched
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: a git failure reading origin THROWS (retriable), not a latchable no-op', () => {
  // With a PAT set but no origin, `git config --get remote.origin.url` exits non-zero → throw, so the
  // caller retries rather than mis-latching a transient .git/config failure as a definitive no-op.
  const { dir, cleanup } = makeRepo({ origin: null });
  try {
    assert.throws(() => ensureCoordReroute(dir, { _env: { GIT_PUSH_TOKEN: 'tok' } }));
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: installs the reroute on a proxied cloud checkout: PUSH → github, FETCH → proxy', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' });
    assert.equal(r.applied, true);
    assert.equal(r.origin, PROXY_ORIGIN);
    assert.equal(r.githubUrl, GITHUB_URL);
    const { fetch, push } = remoteUrls(dir, globalCfg);
    assert.equal(push, GITHUB_URL, 'push must resolve to github');
    assert.equal(fetch, PROXY_ORIGIN, 'fetch must stay on the proxy');
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: installs the github-SCOPED credential helper, not a global wipe', () => {
  // A pre-existing ambient global credential.helper must SURVIVE — the reroute scopes its change to
  // the github.com credential context, never deletes the helper the cloud env uses for the proxy.
  const { dir, globalCfg, cleanup } = makeRepo({
    origin: PROXY_ORIGIN,
    extraGlobal: '[credential]\n\thelper = manager\n',
  });
  try {
    assert.equal(rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' }).applied, true);
    assert.deepEqual(
      globalConfigValues(globalCfg, 'credential.helper'),
      ['manager'],
      'ambient survives',
    );
    const scoped = globalConfigValues(globalCfg, 'credential.https://github.com.helper');
    assert.equal(scoped.length, 2, 'empty reset + our helper');
    assert.equal(scoped[0], '');
    assert.match(scoped[1], /password=\$GIT_PUSH_TOKEN/);
    assert.doesNotMatch(scoped[1], /manager/);
  } finally {
    cleanup();
  }
});

test('credential fill for github.com resolves to OUR PAT, overriding an ambient generic helper', () => {
  // The strongest proof the reroute actually AUTHENTICATES: with a benign ambient generic
  // credential.helper installed (returning a WRONG password), a real `git credential fill` for
  // github.com must still return OUR x-access-token / $GIT_PUSH_TOKEN — the github-context empty reset
  // makes ours the only helper github sees. (Ambient is a harmless inline shell fn, never GCM.)
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN });
  try {
    gitCfg(globalCfg, [
      'config',
      '--global',
      'credential.helper',
      '!f() { echo username=ambient; echo password=WRONG; }; f',
    ]);
    assert.equal(rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'SECRET123' }).applied, true);
    const filled = execFileSync('git', ['-C', dir, 'credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_PUSH_TOKEN: 'SECRET123' },
    });
    assert.match(filled, /username=x-access-token/);
    assert.match(filled, /password=SECRET123/);
    assert.doesNotMatch(
      filled,
      /WRONG|ambient/,
      'the ambient wrong helper must NOT win for github',
    );
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: pushInsteadOf BEATS the cloud env forced insteadOf (github→proxy)', () => {
  // Reproduce the cloud shape: origin is the proxy AND a global insteadOf rewrites github→proxy.
  const extraGlobal = `[url "${PROXY_ORIGIN}"]\n\tinsteadOf = ${GITHUB_URL}\n`;
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN, extraGlobal });
  try {
    assert.equal(rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' }).applied, true);
    const { fetch, push } = remoteUrls(dir, globalCfg);
    assert.equal(push, GITHUB_URL, 'pushInsteadOf must beat insteadOf for push');
    assert.equal(fetch, PROXY_ORIGIN, 'fetch stays on the proxy');
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: idempotent — a second install accumulates neither config value', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN });
  try {
    rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' });
    rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' });
    assert.deepEqual(globalConfigValues(globalCfg, `url.${GITHUB_URL}.pushInsteadOf`), [
      PROXY_ORIGIN,
    ]);
    assert.equal(globalConfigValues(globalCfg, 'credential.https://github.com.helper').length, 2);
    assert.equal(remoteUrls(dir, globalCfg).push, GITHUB_URL);
  } finally {
    cleanup();
  }
});

// ── plan 2863: the FULL-egress branch (direct-https origin BEHIND a transparent $HTTPS_PROXY) ───────
// The second cloud shape. Origin is already the github URL, so the pushInsteadOf reroute above is a
// definitive no-op — but the transparent egress proxy still 403s the coord refs, and it REPLACES the
// Authorization header so no credential-side fix can reach it. The fix is a host-scoped proxy-unset.
const GITHUB_PROXY_KEY = 'http.https://github.com.proxy';

test('directHostUrlFromOrigin: derives the host from a direct https origin, rejects every other shape', () => {
  assert.equal(directHostUrlFromOrigin(GITHUB_URL), 'https://github.com');
  assert.equal(
    directHostUrlFromOrigin('https://git.example.com/team/sibling'),
    'https://git.example.com',
    'derives the SIBLING host, never a hardcoded github',
  );
  assert.equal(
    directHostUrlFromOrigin('https://github.com:8443/octocat/vetapp'),
    'https://github.com:8443',
    'an explicit port is part of the host',
  );
  // The local-proxy shape must fall to the OTHER branch — userinfo disqualifies it here.
  assert.equal(directHostUrlFromOrigin(PROXY_ORIGIN), null);
  // Userinfo-shaped URL fixture, not an e-mail address — the scrub gate's email shape matches
  // the userinfo@host substring on its own.
  assert.equal(directHostUrlFromOrigin('https://user@github.com/a/b'), null); // personal-data-ok: fixture URL, not an email
  // Non-https and unparseable origins are not this shape.
  assert.equal(directHostUrlFromOrigin('git@github.com:octocat/vetapp.git'), null);
  assert.equal(directHostUrlFromOrigin('http://github.com/a/b'), null);
  assert.equal(directHostUrlFromOrigin('not a url'), null);
});

test('ensureCoordReroute: FULL-egress fingerprint installs helper + host-scoped proxy-unset', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://proxy.internal:8080',
    });
    assert.equal(r.applied, true);
    assert.equal(r.mode, 'proxy-bypass');
    assert.equal(r.hostUrl, 'https://github.com');
    // The empty value IS git's documented "disable proxying" sentinel for this host.
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), ['']);
    const scoped = globalConfigValues(globalCfg, 'credential.https://github.com.helper');
    assert.equal(scoped.length, 2, 'empty reset + our helper');
    assert.match(scoped[1], /password=\$GIT_PUSH_TOKEN/);
    // No pushInsteadOf in this mode — the origin is ALREADY the right URL.
    assert.deepEqual(globalConfigValues(globalCfg, `url.${GITHUB_URL}.pushInsteadOf`), []);
    assert.equal(remoteUrls(dir, globalCfg).push, GITHUB_URL, 'origin URL untouched');
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: lowercase https_proxy fingerprints too', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      https_proxy: 'http://proxy.internal:8080',
    });
    assert.equal(r.applied, true);
    assert.equal(r.mode, 'proxy-bypass');
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: a direct origin with NO proxy env stays a no-op (ordinary CI / trusted lane)', () => {
  // The guard that keeps an unconditional proxy-unset from ever mutating a non-proxied environment's
  // global git config: the PAT alone is not the fingerprint, $HTTPS_PROXY must be there too.
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok' });
    assert.equal(r.applied, false);
    assert.match(r.reason, /not the local proxy/);
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), [], 'nothing written');
    assert.deepEqual(globalConfigValues(globalCfg, 'credential.https://github.com.helper'), []);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: an empty HTTPS_PROXY value is "unset", not a fingerprint', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, { GIT_PUSH_TOKEN: 'tok', HTTPS_PROXY: '' });
    assert.equal(r.applied, false);
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), []);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: the two cloud branches are MUTUALLY EXCLUSIVE (proxy origin wins)', () => {
  // A local-proxy origin with $HTTPS_PROXY also set must still take the plan-1770 reroute and must NOT
  // write a proxy-unset — the trusted lane's working push path stays byte-for-byte what it was.
  const { dir, globalCfg, cleanup } = makeRepo({ origin: PROXY_ORIGIN });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://proxy.internal:8080',
    });
    assert.equal(r.applied, true);
    assert.equal(r.mode, 'proxy-reroute', 'the proxy-origin branch wins');
    assert.equal(r.githubUrl, GITHUB_URL);
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), [], 'no proxy-unset written');
    assert.equal(remoteUrls(dir, globalCfg).push, GITHUB_URL);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: the FULL-egress branch is idempotent — no value accumulates', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  const env = { GIT_PUSH_TOKEN: 'tok', HTTPS_PROXY: 'http://proxy.internal:8080' };
  try {
    rerouteWithGlobal(dir, globalCfg, env);
    rerouteWithGlobal(dir, globalCfg, env);
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), ['']);
    assert.equal(globalConfigValues(globalCfg, 'credential.https://github.com.helper').length, 2);
  } finally {
    cleanup();
  }
});

test('installCoordRerouteOnce: logs the BYPASS wording for a proxy-bypass install', () => {
  _resetRerouteState();
  const logs = [];
  installCoordRerouteOnce('/x', {
    _ensure: () => ({
      applied: true,
      mode: 'proxy-bypass',
      origin: GITHUB_URL,
      hostUrl: 'https://github.com',
    }),
    log: (m) => logs.push(m),
    _sleep: () => {},
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /proxy bypass installed/);
  assert.match(logs[0], /https:\/\/github\.com/);
});

// ── installCoordRerouteOnce: once-per-process latch + bounded inner retry ────────────────────────────
const noSleep = () => {}; // skip the real backoff in the retry tests

test('installCoordRerouteOnce: latches on an applied install — runs ensure exactly once', () => {
  _resetRerouteState();
  let calls = 0;
  const _ensure = () => {
    calls++;
    return { applied: true, origin: PROXY_ORIGIN, githubUrl: GITHUB_URL };
  };
  const logs = [];
  const st = installCoordRerouteOnce('/x', { _ensure, log: (m) => logs.push(m), _sleep: noSleep });
  installCoordRerouteOnce('/x', { _ensure, log: (m) => logs.push(m), _sleep: noSleep });
  assert.equal(calls, 1, 'a successful install latches — never re-run');
  assert.equal(st.done, true);
  assert.equal(st.applied, true);
  assert.equal(logs.filter((m) => /reroute installed/.test(m)).length, 1);
});

test('installCoordRerouteOnce: latches on a definitive no-op (unset PAT) — runs ensure exactly once', () => {
  _resetRerouteState();
  let calls = 0;
  const _ensure = () => {
    calls++;
    return { applied: false, reason: 'GIT_PUSH_TOKEN unset' };
  };
  const st = installCoordRerouteOnce('/x', { _ensure, log: () => {}, _sleep: noSleep });
  installCoordRerouteOnce('/x', { _ensure, log: () => {}, _sleep: noSleep });
  assert.equal(calls, 1, 'a stable no-op latches too, and does NOT waste inner retries');
  assert.equal(st.applied, false);
});

test('installCoordRerouteOnce: a transient throw is absorbed by the inner retry, then latched', () => {
  _resetRerouteState();
  let calls = 0;
  const _ensure = () => {
    calls++;
    if (calls === 1) throw new Error('transient config lock'); // clears on the retry
    return { applied: true, origin: PROXY_ORIGIN, githubUrl: GITHUB_URL };
  };
  const st = installCoordRerouteOnce('/x', { _ensure, log: () => {}, _sleep: noSleep });
  assert.equal(calls, 2, 'inner retry rode out the blip within the single episode');
  assert.equal(st.applied, true);
  installCoordRerouteOnce('/x', { _ensure, log: () => {}, _sleep: noSleep });
  assert.equal(calls, 2, 'latched — no re-probe on the next push');
});

test('installCoordRerouteOnce: a PERSISTENT failure exhausts the bound ONCE, then never re-probes', () => {
  _resetRerouteState();
  let calls = 0;
  const _ensure = () => {
    calls++;
    throw new Error('read-only HOME');
  };
  const logs = [];
  installCoordRerouteOnce('/x', { _ensure, log: (m) => logs.push(m), _sleep: noSleep });
  // Subsequent pushes must NOT re-spawn — the episode latched even though it failed.
  for (let i = 0; i < 5; i++)
    installCoordRerouteOnce('/x', { _ensure, log: (m) => logs.push(m), _sleep: noSleep });
  assert.equal(
    calls,
    REROUTE_INSTALL_ATTEMPTS,
    'exactly the inner-retry bound, never per-push after',
  );
  assert.equal(logs.length, 1, 'logged exactly once');
  assert.match(logs[0], /failed after 3 attempts/);
});

test('installCoordRerouteOnce: returns a SNAPSHOT, not the live mutable state', () => {
  _resetRerouteState();
  const captured = installCoordRerouteOnce('/x', {
    _ensure: () => ({ applied: true, origin: PROXY_ORIGIN, githubUrl: GITHUB_URL }),
    log: () => {},
    _sleep: noSleep,
  });
  captured.done = false; // mutating the returned copy must NOT affect the module latch
  const st2 = installCoordRerouteOnce('/x', {
    _ensure: () => assert.fail('must not re-run — the module stayed latched'),
    log: () => {},
    _sleep: noSleep,
  });
  assert.equal(st2.done, true);
});

test('installCoordRerouteOnce: never throws even when ensure throws (must not block the push)', () => {
  _resetRerouteState();
  assert.doesNotThrow(() =>
    installCoordRerouteOnce('/x', {
      _ensure: () => {
        throw new Error('boom');
      },
      log: () => {},
      _sleep: noSleep,
    }),
  );
});

// --- plan 2863 review round 1: narrow the FULL-egress fingerprint ------------------------------

test('ensureCoordReroute: a host already exempted by NO_PROXY is NOT bypassed', () => {
  // Review finding: "any direct HTTPS origin + any proxy env" was too broad a licence to mutate
  // global git config. If the host is already exempt there is no proxy in its path to bypass, so
  // writing a config entry for it is pure collateral.
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: 'github.com,example.org',
    });
    assert.equal(r.applied, false);
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), [], 'nothing written');
    assert.deepEqual(globalConfigValues(globalCfg, 'credential.https://github.com.helper'), []);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: NO_PROXY matches parent domains and honours a lone wildcard', () => {
  for (const noProxy of ['.github.com', 'GITHUB.COM', '*']) {
    const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
    try {
      const r = rerouteWithGlobal(dir, globalCfg, {
        GIT_PUSH_TOKEN: 'tok',
        https_proxy: 'http://p:8080',
        no_proxy: noProxy,
      });
      assert.equal(r.applied, false, `NO_PROXY=${noProxy} must exempt the host`);
    } finally {
      cleanup();
    }
  }
});

test('ensureCoordReroute: an UNRELATED NO_PROXY entry does not block the bypass', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: 'localhost,127.0.0.1,.internal',
    });
    assert.equal(r.applied, true);
    assert.equal(r.mode, 'proxy-bypass');
    // A substring trap: `hub.com` must NOT be read as covering `github.com`.
    assert.deepEqual(globalConfigValues(globalCfg, GITHUB_PROXY_KEY), ['']);
  } finally {
    cleanup();
  }
});

test('ensureCoordReroute: NO_PROXY suffix matching is dot-anchored, not substring', () => {
  const { dir, globalCfg, cleanup } = makeRepo({ origin: GITHUB_URL });
  try {
    const r = rerouteWithGlobal(dir, globalCfg, {
      GIT_PUSH_TOKEN: 'tok',
      HTTPS_PROXY: 'http://p:8080',
      NO_PROXY: 'hub.com',
    });
    assert.equal(r.applied, true, '`hub.com` must not exempt `github.com`');
  } finally {
    cleanup();
  }
});
