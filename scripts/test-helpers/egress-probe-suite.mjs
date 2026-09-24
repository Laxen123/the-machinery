// scripts/test-helpers/egress-probe-suite.mjs — the ONE parameterized test suite
// for the per-engine egress probes (plan 2313 review fix, round 2: the two test
// files each duplicated the same 6-7 assertion bodies with only names swapped, so
// a contract change to the shared probe core could be asserted in one file and
// silently forgotten in the other). Each engine's test file calls
// runEgressProbeSuite() with its engine-named surface; engine-specific flavor
// (e.g. the chromium 2241 ERR_CONNECTION_RESET shape) stays in the caller as
// extra tests on top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowserEngine } from './fake-browser-engine.mjs';

// `name` — the exported probe function's name, for test titles.
// `probe` — the engine-named wrapper (e.g. probeWebkitEgress).
// `launchKey` — the wrapper's injectable-launcher option name (e.g. 'launchWebkit').
// `launchErrorMessage` — an engine-flavored launch-failure message to model.
export function runEgressProbeSuite({ name, probe, launchKey, launchErrorMessage }) {
  test(`${name}: PASS when goto resolves`, async () => {
    const result = await probe({
      url: 'https://example.com',
      [launchKey]: async () => fakeBrowserEngine({}),
    });
    assert.equal(result.pass, true);
    assert.equal(result.error, null);
    assert.equal(result.url, 'https://example.com');
    assert.equal(typeof result.durationMs, 'number');
  });

  test(`${name}: FAIL (not launchFailed) on a navigation error`, async () => {
    const result = await probe({
      url: 'https://example.com',
      [launchKey]: async () =>
        fakeBrowserEngine({ nav: new Error('navigation blew up at https://example.com/') }),
    });
    assert.equal(result.pass, false);
    assert.match(result.error, /navigation blew up/);
    assert.equal(result.launchFailed, undefined);
  });

  test(`${name}: launchFailed=true when the engine's launch() itself throws (no browser, no navigation)`, async () => {
    const result = await probe({
      url: 'https://example.com',
      [launchKey]: async () => fakeBrowserEngine({ launchError: new Error(launchErrorMessage) }),
    });
    assert.equal(result.pass, false);
    assert.equal(result.launchFailed, true);
    assert.match(result.error, /launch failed/);
  });

  test(`${name}: launchFailed=true when the launcher resolver itself throws`, async () => {
    const result = await probe({
      url: 'https://example.com',
      [launchKey]: async () => {
        throw new Error('module not found');
      },
    });
    assert.equal(result.pass, false);
    assert.equal(result.launchFailed, true);
  });

  test(`${name}: defaults url to https://example.com and timeoutMs to 10000 when omitted`, async () => {
    const captured = {};
    const result = await probe({ [launchKey]: async () => fakeBrowserEngine({ captured }) });
    assert.equal(result.pass, true);
    assert.equal(captured.url, 'https://example.com');
    assert.equal(captured.opts.timeout, 10000);
  });

  test(`${name}: passes url/timeoutMs through to page.goto`, async () => {
    const captured = {};
    await probe({
      url: 'https://1.1.1.1',
      timeoutMs: 15000,
      [launchKey]: async () => fakeBrowserEngine({ captured }),
    });
    assert.equal(captured.url, 'https://1.1.1.1');
    assert.equal(captured.opts.timeout, 15000);
  });
}
