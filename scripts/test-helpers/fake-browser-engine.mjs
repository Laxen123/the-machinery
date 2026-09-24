// scripts/test-helpers/fake-browser-engine.mjs — the ONE fake Playwright
// BrowserType double shared by the egress-probe tests (plan 2313 review fix;
// probe-chromium-egress.test.mjs and probe-webkit-egress.test.mjs each hand-rolled
// an identical copy). Shaped exactly like the real API surface the probes touch:
// `.launch()` returns a fake browser whose `.newPage()` returns a fake page whose
// `.goto()` resolves or rejects per `nav`. `captured`, when passed, is filled with
// the url/opts a test wants to assert on.
export function fakeBrowserEngine({ launchError, nav, captured } = {}) {
  let closed = false;
  return {
    async launch() {
      if (launchError) throw launchError;
      return {
        async newPage() {
          return {
            async goto(url, opts) {
              if (captured) {
                captured.url = url;
                captured.opts = opts;
              }
              if (nav instanceof Error) throw nav;
              return { url, opts };
            },
          };
        },
        async close() {
          closed = true;
        },
        wasClosed: () => closed,
      };
    },
  };
}
