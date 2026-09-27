// scripts/local-drain-filter.test.mjs — plan 2396. The regression pin for the /local-drain
// Step-2 cloud-eligibility filter.
//
// THE PIN (acceptance criterion 1): a plan whose `summary:` exceeds 1500 bytes, with
// `cloudExec: true` after it, MUST classify as cloud-eligible. The filter used to read the stamp
// out of a fixed 1500-BYTE prefix, so exactly this shape read as `unset` and a cloud-reserved
// plan was offered to the local session (4 of 11 plans misread on the 2026-07-25 board, 2 in the
// unsafe direction). Without this fixture the bug reintroduces on any future refactor — so the
// first test below asserts against a REAL >1500-byte summary, not a token-sized one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCloudExecStamp,
  stampFor,
  partitionPools,
  partitionBatches,
  runOracle,
  main,
  UNSET,
  NO_FRONTMATTER,
} from './local-drain-filter.mjs';

// A plan-shaped body. `summaryPad` inflates the summary value the way real plans do (2378's is
// ~1900 chars), which is what pushes the later keys past any byte window.
function planContent({ summaryLen = 0, keys = [], eol = '\n' } = {}) {
  const summary = `The filter misreads the stamp. ${'x'.repeat(Math.max(0, summaryLen))}`;
  const lines = ['---', `summary: '${summary}'`, ...keys, '---', '', '# A plan', ''];
  return lines.join(eol);
}

const LONG_SUMMARY = 2000; // comfortably past the old 1500-byte window

test('readCloudExecStamp: cloudExec: true is FOUND past byte 1500 (plan 2396 regression pin)', () => {
  const content = planContent({
    summaryLen: LONG_SUMMARY,
    keys: ['stage: specced', 'cloudExec: true', 'execModel: sonnet'],
  });
  // Guard the fixture itself: if the summary ever shrinks below the old window the test stops
  // pinning the bug while still passing.
  assert.ok(
    content.indexOf('cloudExec:') > 1500,
    `fixture must place cloudExec: past byte 1500 (got ${content.indexOf('cloudExec:')})`,
  );
  assert.equal(readCloudExecStamp(content), 'true');
  // And the exact shape the OLD byte-slice read produced — proof the fixture is the RED case.
  const oldRead = (content.slice(0, 1500).match(/^cloudExec:\s*(\S+)/m) || [])[1] || 'unset';
  assert.equal(oldRead, 'unset', 'the old byte-sliced read misses this stamp');
});

test('readCloudExecStamp: cloudExec: false past byte 1500 also reads correctly', () => {
  const content = planContent({
    summaryLen: LONG_SUMMARY,
    keys: ['cloudExec: false'],
  });
  assert.equal(readCloudExecStamp(content), 'false');
});

test('readCloudExecStamp: a frontmatter block that OMITS cloudExec reads unset', () => {
  assert.equal(readCloudExecStamp(planContent({ keys: ['stage: specced'] })), UNSET);
});

test('readCloudExecStamp: no frontmatter block at all is DISTINCT from unset (acceptance 4)', () => {
  assert.equal(readCloudExecStamp('# A plan with no frontmatter\n\nbody\n'), NO_FRONTMATTER);
  assert.notEqual(NO_FRONTMATTER, UNSET);
});

test('readCloudExecStamp: a trailing YAML inline comment is stripped', () => {
  const content = planContent({ keys: ['cloudExec: true # cloud sweep 2026-07-25'] });
  assert.equal(readCloudExecStamp(content), 'true');
});

test('readCloudExecStamp: a quoted value is unquoted, and case is normalized', () => {
  assert.equal(readCloudExecStamp(planContent({ keys: ["cloudExec: 'TRUE'"] })), 'true');
});

test('readCloudExecStamp: CRLF content parses identically to LF', () => {
  const crlf = planContent({ summaryLen: LONG_SUMMARY, keys: ['cloudExec: true'], eol: '\r\n' });
  assert.equal(readCloudExecStamp(crlf), 'true');
});

test('readCloudExecStamp: a `cloudExec:` line in the BODY is not mistaken for the stamp', () => {
  const content = [
    '---',
    'summary: x',
    '---',
    '',
    'The bug: `cloudExec: true` was misread.',
    '',
  ].join('\n');
  assert.equal(readCloudExecStamp(content), UNSET);
});

test('stampFor: a vanished file is the mid-move race (missing), not an unreadable defect', () => {
  // exists is pinned so the assertion does not silently depend on the test runner's cwd.
  const r = stampFor('does/not/exist.md', { exists: () => true });
  assert.equal(r.kind, 'missing');
});

// plan 2396 review finding [0]: ENOENT alone must NOT be treated as the race. A wrong cwd makes
// every read ENOENT too, and routing that into the tolerated bucket is exactly the "systematic
// defect masquerading as queue churn" task 4 forbids.
test('stampFor: ENOENT with the plans root ALSO missing is a wrong-cwd defect, not the race', () => {
  const r = stampFor('docs/superpowers/plans/ready/whatever.md', { exists: () => false });
  assert.equal(r.kind, 'unreadable');
  assert.equal(r.code, 'ENOENT');
  assert.match(r.message, /WRONG CWD/);
  assert.match(r.message, /MAIN checkout/);
});

test('partitionPools: a wrong cwd surfaces as unreadable[] + a warning, NOT as staleDropped[]', () => {
  const enoent = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  const pools = [
    [
      'sonnet',
      {
        eligible: [
          { slug: '1111-A-one', path: 'docs/superpowers/plans/ready/1111-A-one.md' },
          { slug: '2222-B-two', path: 'docs/superpowers/plans/ready/2222-B-two.md' },
        ],
      },
    ],
  ];
  const out = partitionPools(pools, { readFile: enoent, exists: () => false });
  assert.equal(out.staleDropped.length, 0, 'a wrong cwd must not be reported as queue churn');
  assert.equal(out.unreadable.length, 2);
  assert.equal(out.localOnly.length, 0);
  assert.equal(out.warnings.length, 2);
  assert.match(out.warnings[0], /UNREADABLE/);
});

test('partitionPools: a genuine mid-move race still reports staleDropped[], with no warning', () => {
  const enoent = () => {
    const e = new Error('ENOENT: no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  const pools = [
    ['fable', { eligible: [{ slug: '3333-C-three', path: 'docs/superpowers/plans/ready/x.md' }] }],
  ];
  const out = partitionPools(pools, { readFile: enoent, exists: () => true });
  assert.equal(out.staleDropped.length, 1);
  assert.equal(out.unreadable.length, 0);
  assert.equal(out.warnings.length, 0, 'an ordinary race is not a defect and must not warn');
});

test('stampFor: a non-ENOENT read failure is `unreadable`, not the race (plan 2396 task 4)', () => {
  const boom = () => {
    const e = new Error('permission denied');
    e.code = 'EACCES';
    throw e;
  };
  const r = stampFor('some/plan.md', { readFile: boom });
  assert.equal(r.kind, 'unreadable');
  assert.equal(r.code, 'EACCES');
});

// --- partitionPools over a real on-disk corpus --------------------------------

test('partitionPools: the >1500-byte-summary plan lands in droppedCloudEligible, not localOnly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-drain-filter-'));
  try {
    const write = (name, content) => {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    };
    const longCloud = write(
      'long-cloud.md',
      planContent({ summaryLen: LONG_SUMMARY, keys: ['cloudExec: true'] }),
    );
    const longLocal = write(
      'long-local.md',
      planContent({ summaryLen: LONG_SUMMARY, keys: ['cloudExec: false'] }),
    );
    const unstamped = write('unstamped.md', planContent({ keys: ['stage: specced'] }));
    const noFm = write('no-fm.md', '# no frontmatter\n');
    const gone = join(dir, 'vanished.md');

    const out = partitionPools([
      [
        'sonnet',
        {
          eligible: [
            { slug: 'long-cloud', path: longCloud },
            { slug: 'long-local', path: longLocal },
            { slug: 'unstamped', path: unstamped },
            { slug: 'no-fm', path: noFm },
            { slug: 'vanished', path: gone },
          ],
        },
      ],
      ['fable', { eligible: [{ slug: 'long-cloud-fable', path: longCloud }] }],
    ]);

    assert.deepEqual(
      out.droppedCloudEligible,
      [
        { slug: 'long-cloud', lane: 'sonnet' },
        { slug: 'long-cloud-fable', lane: 'fable' },
      ],
      'a >1500-byte-summary cloudExec: true plan is cloud-eligible in BOTH lanes',
    );
    assert.deepEqual(
      out.localOnly.map((e) => [e.slug, e.cloudExec]),
      [
        ['long-local', 'false'],
        ['unstamped', UNSET],
        ['no-fm', NO_FRONTMATTER],
      ],
      'only genuinely non-cloud plans stay local, each carrying its own read stamp',
    );
    assert.deepEqual(
      out.staleDropped.map((e) => e.slug),
      ['vanished'],
    );
    assert.deepEqual(out.unreadable, []);
    assert.equal(out.warnings.length, 1, 'the no-frontmatter plan warns');
    assert.match(out.warnings[0], /NO USABLE FRONTMATTER no-fm/);
    // plan 2396 review finding [1]: frontmatterEnd() === -1 covers BOTH a missing opening fence
    // and an unterminated block, so the warning must not assert only the former.
    assert.match(out.warnings[0], /no CLOSING fence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partitionPools: a non-race read failure goes to unreadable[] and warns', () => {
  const boom = () => {
    const e = new Error('is a directory');
    e.code = 'EISDIR';
    throw e;
  };
  const out = partitionPools([['sonnet', { eligible: [{ slug: 's', path: 'p.md' }] }]], {
    readFile: boom,
  });
  assert.deepEqual(out.localOnly, []);
  assert.deepEqual(out.staleDropped, []);
  assert.equal(out.unreadable.length, 1);
  assert.equal(out.unreadable[0].code, 'EISDIR');
  assert.match(out.warnings[0], /UNREADABLE s \(sonnet\)/);
  assert.match(out.warnings[0], /NOT the mid-move race/);
});

test('partitionPools: an unrecognized stamp value stays LOCAL and warns', () => {
  const out = partitionPools([['sonnet', { eligible: [{ slug: 's', path: 'p.md' }] }]], {
    readFile: () => planContent({ keys: ['cloudExec: yes'] }),
  });
  assert.deepEqual(
    out.localOnly.map((e) => e.cloudExec),
    ['yes'],
    'only an explicit `true` is cloud-eligible — anything else stalls locally, never in the cloud',
  );
  assert.match(out.warnings[0], /UNRECOGNIZED cloudExec: "yes"/);
});

// --- plan 2421: the oracle-supplied stamp is trusted; the file read is a fallback only --------

test('partitionPools: an oracle-supplied cloudExec is trusted outright — no file read at all', () => {
  const readFile = () => {
    throw new Error('must not be called — the oracle already supplied the stamp');
  };
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: 'cloud-one', path: 'irrelevant.md', cloudExec: 'true' },
            { slug: 'local-one', path: 'irrelevant.md', cloudExec: 'false' },
            { slug: 'unset-one', path: 'irrelevant.md', cloudExec: UNSET },
          ],
        },
      ],
    ],
    { readFile, exists: () => true },
  );
  assert.deepEqual(out.droppedCloudEligible, [{ slug: 'cloud-one', lane: 'sonnet' }]);
  assert.deepEqual(
    out.localOnly.map((e) => [e.slug, e.cloudExec]),
    [
      ['local-one', 'false'],
      ['unset-one', UNSET],
    ],
  );
  assert.deepEqual(out.staleDropped, []);
  assert.deepEqual(out.unreadable, []);
});

// sonnet-review fix [0]: trusting the oracle's supplied stamp must not skip the mid-move-race
// check entirely — a plan can be claimed/re-filed out of ready/ between the oracle's own scan
// and this filter run, and that must still land in staleDropped[], not silently in localOnly[].
test('partitionPools: an oracle-supplied stamp whose file has since vanished is staleDropped, not trusted', () => {
  const readFile = () => {
    throw new Error('must not be called — only existsSync should run on the trusted path');
  };
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [{ slug: 'moved-mid-race', path: 'gone.md', cloudExec: 'unset' }],
        },
      ],
    ],
    { readFile, exists: () => false },
  );
  assert.deepEqual(out.localOnly, []);
  assert.deepEqual(out.staleDropped, [
    { slug: 'moved-mid-race', lane: 'sonnet', path: 'gone.md', code: 'ENOENT' },
  ]);
});

test('partitionPools: an eligible entry with NO cloudExec field falls back to the file read', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            // no `cloudExec` key at all — an un-upgraded/sibling oracle — must still classify
            // correctly via the stampFor fallback, same as before plan 2421.
            { slug: 'legacy-oracle-item', path: 'p.md' },
          ],
        },
      ],
    ],
    { readFile: () => planContent({ keys: ['cloudExec: true'] }) },
  );
  assert.deepEqual(out.droppedCloudEligible, [{ slug: 'legacy-oracle-item', lane: 'sonnet' }]);
});

test('partitionPools: a mixed pool trusts the oracle-supplied entries and falls back for the rest', () => {
  let readCalls = 0;
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: 'supplied', path: 'irrelevant.md', cloudExec: 'false' },
            { slug: 'legacy', path: 'p.md' },
          ],
        },
      ],
    ],
    {
      readFile: () => {
        readCalls += 1;
        return planContent({ keys: ['cloudExec: true'] });
      },
      // the oracle-supplied entry still gets a cheap existsSync mid-move-race check (fix [0]) —
      // stub it present so this test isolates the readFile-skip behaviour it's pinning.
      exists: () => true,
    },
  );
  assert.equal(readCalls, 1, 'only the entry missing a supplied stamp triggers a file read');
  assert.deepEqual(
    out.localOnly.map((e) => e.slug),
    ['supplied'],
  );
  assert.deepEqual(out.droppedCloudEligible, [{ slug: 'legacy', lane: 'sonnet' }]);
});

test('partitionPools: an empty / absent eligible list is tolerated', () => {
  const out = partitionPools([
    ['sonnet', { eligible: [] }],
    ['fable', {}],
    ['ghost', null],
  ]);
  assert.deepEqual(out, {
    localOnly: [],
    droppedCloudEligible: [],
    staleDropped: [],
    unreadable: [],
    warnings: [],
  });
});

// --- plan 3461: a sol plan is admitted lane-agnostically under BOTH oracle runs --------------
//
// queue-drain.mjs's `--lane` gate never excludes an `execModel: sol` plan under either the
// default (sonnet) or `--lane fable` invocation, so `eligible[]` reports the SAME slug from
// BOTH pools. Before round 1's fix that meant a duplicate row in `localOnly` (or
// `droppedCloudEligible`) — /local-drain would see the same plan twice.
//
// plan 3461 round 2: round 1's dedup INFERRED the lane from a second, differently-labelled
// sighting — correct only when both sightings actually arrive. queue-drain.mjs now stamps
// every `eligible[]` entry with its OWN resolved `lane` (via `toItem`), and every fixture below
// carries that field explicitly, exactly as the real oracle output would — the tests exercise
// reading `e.lane`, never inferring it from which pool/how-many-times a plan was seen.

test('partitionPools: a sol plan eligible in BOTH pools yields ONE localOnly entry, lane "sol"', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: '9001-sol-plan', path: 'irrelevant.md', cloudExec: 'false', lane: 'sol' },
          ],
        },
      ],
      [
        'fable',
        {
          eligible: [
            { slug: '9001-sol-plan', path: 'irrelevant.md', cloudExec: 'false', lane: 'sol' },
          ],
        },
      ],
    ],
    { exists: () => true },
  );
  assert.equal(out.localOnly.length, 1, 'a sol plan reported by both oracle runs must not double');
  assert.deepEqual(out.localOnly[0].lane, 'sol');
  assert.equal(out.localOnly[0].slug, '9001-sol-plan');
});

test('partitionPools: a sol plan stamped cloudExec: true in BOTH pools yields ONE dropped entry, lane "sol"', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: '9002-sol-cloud', path: 'irrelevant.md', cloudExec: 'true', lane: 'sol' },
          ],
        },
      ],
      [
        'fable',
        {
          eligible: [
            { slug: '9002-sol-cloud', path: 'irrelevant.md', cloudExec: 'true', lane: 'sol' },
          ],
        },
      ],
    ],
    { exists: () => true },
  );
  assert.deepEqual(out.droppedCloudEligible, [{ slug: '9002-sol-cloud', lane: 'sol' }]);
});

test('partitionPools: a sonnet-native plan present in ONLY the sonnet pool keeps lane "sonnet"', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            {
              slug: '9003-sonnet-only',
              path: 'irrelevant.md',
              cloudExec: 'false',
              lane: 'sonnet',
            },
          ],
        },
      ],
      ['fable', { eligible: [] }],
    ],
    { exists: () => true },
  );
  assert.deepEqual(
    out.localOnly.map((e) => [e.slug, e.lane]),
    [['9003-sonnet-only', 'sonnet']],
    'a plan seen under only ONE lane keeps that lane — the sol merge fires only on a genuine double-sighting',
  );
});

test('partitionPools: a fable-native plan present in ONLY the fable pool keeps lane "fable"', () => {
  const out = partitionPools(
    [
      ['sonnet', { eligible: [] }],
      [
        'fable',
        {
          eligible: [
            { slug: '9004-fable-only', path: 'irrelevant.md', cloudExec: 'false', lane: 'fable' },
          ],
        },
      ],
    ],
    { exists: () => true },
  );
  assert.deepEqual(
    out.localOnly.map((e) => [e.slug, e.lane]),
    [['9004-fable-only', 'fable']],
  );
});

// plan 3461 round 2: THE regression this file was found to enshrine as correct. A sol plan
// sighted in only ONE pool (a partial oracle result, one lane's spawn failing, or the plan
// simply not surfacing twice in a given run) must still read lane "sol" — never the raw pool
// label — because queue-drain now stamps `e.lane` on the entry itself, independent of which
// pool reported it. Two variants: sighted only via the sonnet pool, and only via the fable pool.
test('partitionPools: a sol plan sighted ONLY via the sonnet pool still reads lane "sol"', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: '9005-sol-solo', path: 'irrelevant.md', cloudExec: 'false', lane: 'sol' },
          ],
        },
      ],
      ['fable', { eligible: [] }],
    ],
    { exists: () => true },
  );
  assert.deepEqual(
    out.localOnly.map((e) => [e.slug, e.lane]),
    [['9005-sol-solo', 'sol']],
  );
});

test('partitionPools: a sol plan sighted ONLY via the fable pool still reads lane "sol"', () => {
  const out = partitionPools(
    [
      ['sonnet', { eligible: [] }],
      [
        'fable',
        {
          eligible: [
            { slug: '9006-sol-solo-fable', path: 'irrelevant.md', cloudExec: 'false', lane: 'sol' },
          ],
        },
      ],
    ],
    { exists: () => true },
  );
  assert.deepEqual(
    out.localOnly.map((e) => [e.slug, e.lane]),
    [['9006-sol-solo-fable', 'sol']],
  );
});

// plan 3461 round 2 finding [:170]/[:215]: dedup used to be scoped to each output BUCKET's own
// Map, so a slug whose two independent oracle scans disagree on `cloudExec` (a concurrent stamp
// edit between the sonnet and fable spawns) could land in BOTH `localOnly` and
// `droppedCloudEligible` — one bucket per sighting, since neither bucket's Map had ever seen the
// other's slug. The shared ledger folds this into ONE slug, deciding what happens to it below.
//
// plan 3461 round 3: round 2 kept the FIRST sighting, which is arbitrary — `Promise.all` order
// decides which oracle spawn's read "wins", and that has no relationship to which read is
// stale. A `cloudExec: true` edit landing between the two scans can be visible only to the
// discarded SECOND sighting just as easily as the kept first one, which would hand a
// cloud-reserved plan to the local drain — exactly the failure this partition exists to
// prevent. The fix withholds the slug from BOTH buckets this cycle instead of guessing: the
// drain runs on a cadence, so skipping one tick and re-reading a settled stamp next time is
// cheap and needs no judgment about which sighting to trust.
test(
  'partitionPools: a slug whose two sightings disagree on cloudExec is withheld from BOTH ' +
    'buckets this cycle, with a warning',
  () => {
    const out = partitionPools(
      [
        [
          'sonnet',
          {
            eligible: [
              { slug: '9007-race', path: 'irrelevant.md', cloudExec: 'false', lane: 'sonnet' },
            ],
          },
        ],
        [
          'fable',
          {
            eligible: [
              { slug: '9007-race', path: 'irrelevant.md', cloudExec: 'true', lane: 'sonnet' },
            ],
          },
        ],
      ],
      { exists: () => true },
    );
    assert.equal(out.localOnly.length, 0, 'neither sighting is trustworthy — withheld, not kept');
    assert.equal(out.droppedCloudEligible.length, 0, 'the other bucket must not get it either');
    assert.ok(
      out.warnings.some((w) => w.includes('9007-race') && w.includes('INCONSISTENT')),
      'a bucket-crossing disagreement must be surfaced, not silently resolved',
    );
    assert.ok(
      out.warnings.some((w) => w.includes('9007-race') && w.includes('Withheld from BOTH')),
      'the warning must say the plan was withheld, not which side was kept',
    );
  },
);

// A lane-only disagreement (same bucket both times, but a different resolved `lane`) must be
// withheld the same way — there is no "safer" lane to default to the way `dropped` is the
// safer bucket, so the uniform withhold-and-re-read rule covers this case too.
test('partitionPools: a slug whose two sightings agree on bucket but disagree on lane is also withheld', () => {
  const out = partitionPools(
    [
      [
        'sonnet',
        {
          eligible: [
            { slug: '9008-lane-race', path: 'irrelevant.md', cloudExec: 'false', lane: 'sonnet' },
          ],
        },
      ],
      [
        'fable',
        {
          eligible: [
            { slug: '9008-lane-race', path: 'irrelevant.md', cloudExec: 'false', lane: 'fable' },
          ],
        },
      ],
    ],
    { exists: () => true },
  );
  assert.equal(out.localOnly.length, 0, 'a lane disagreement is also withheld, not guessed at');
  assert.equal(out.droppedCloudEligible.length, 0);
  assert.ok(out.warnings.some((w) => w.includes('9008-lane-race') && w.includes('INCONSISTENT')));
});

// --- the oracle wrapper -------------------------------------------------------

// plan 2421: runOracle is now async (the default exec spawns via a promisified execFile so the
// two lanes can run concurrently) — these three still pin the exact tolerance shape, just via
// `await` instead of a synchronous return. A test's `exec` stub returning a plain (non-promise)
// value continues to work: `await <plain value>` resolves to that value unchanged.
test('runOracle: parses stdout JSON', async () => {
  const res = await runOracle([], { exec: () => '{"eligible":[{"slug":"a","path":"a.md"}]}' });
  assert.deepEqual(res.eligible, [{ slug: 'a', path: 'a.md' }]);
});

test('runOracle: a non-zero exit whose stdout holds the JSON is still parsed', async () => {
  const res = await runOracle([], {
    exec: () => {
      const e = new Error('exit 1');
      e.stdout = '{"eligible":[]}';
      throw e;
    },
  });
  assert.deepEqual(res, { eligible: [] });
});

// plan 3461 round 4 (review finding): a crash used to degrade to an EMPTY pool, indistinguishable
// downstream from "the oracle ran and legitimately found nothing" — a live regression could hide
// behind a plausible-looking "0 eligible" board. Mirroring ready-board.mjs's `runOracle`, a
// failure whose stdout does not parse now THROWS instead. The legitimate exit-1 empty-lane case
// (pinned two tests above) is unaffected — its stdout parses, so it never reaches this branch.
test('runOracle: an unparsable failure THROWS — never a silently empty pool', async () => {
  await assert.rejects(
    runOracle([], {
      exec: () => {
        throw new Error('spawn failed');
      },
    }),
    /oracle failed and printed no parseable JSON/,
  );
});

// plan 3461 round 5 (finding fcf89a, CONFIRMED): the crash-recovery branch used to accept ANY
// value `JSON.parse(e.stdout)` happened to produce — `null`, a bare scalar, an array all parse
// cleanly and all used to be returned as if they were a real oracle result. Downstream, both
// partitioners read the result via `(res && res.eligible) || []`, which folds every one of these
// into a false-EMPTY pool — exactly the plausible-looking "0 eligible" misreport round 4's throw
// exists to prevent. Each of these must now hit the SAME loud throw as an outright parse failure.
for (const [label, badStdout] of [
  ['null', 'null'],
  ['a bare number', '42'],
  ['an array', '[1,2,3]'],
]) {
  test(`runOracle: a crash whose recovered stdout is ${label} is rejected, not treated as an empty pool`, async () => {
    await assert.rejects(
      runOracle([], {
        exec: () => {
          const e = new Error('exit 1');
          e.stdout = badStdout;
          throw e;
        },
      }),
      /oracle failed and printed no parseable JSON/,
    );
  });
}

// --- main(): per-lane failure tolerance (plan 3461 round 4) ------------------
//
// `runOracle` now throws on a genuine crash (pinned above), so `main()` must catch each lane's
// outcome INDEPENDENTLY (never `Promise.all`, which would let one lane's rejection cancel the
// whole run) to keep the pre-existing promise that "one lane's spawn failure never blocks or
// fails the other's".

test("main: a crashed fable lane doesn't block the healthy sonnet lane, and is reported loudly, not as 0 eligible", async () => {
  const readFile = () => planContent({ keys: ['cloudExec: false'] });
  const exists = () => true;
  const warns = [];
  const exec = (_cmd, args) => {
    if (args.includes('fable')) throw new Error('fable oracle spawn failed');
    return '{"eligible":[{"slug":"a","path":"a.md"}]}';
  };
  const out = await main({
    exec,
    readFile,
    exists,
    log: () => {},
    warn: (s) => warns.push(s),
  });
  assert.equal(out.localOnly.length, 1, 'the healthy sonnet lane still surfaces its plan');
  assert.equal(out.localOnly[0].slug, 'a');
  assert.ok(
    out.warnings.some((w) => /ORACLE FAILURE \(fable lane\)/.test(w) && /UNKNOWN/.test(w)),
    'the crashed lane is named in the warnings, distinguished from an empty pool',
  );
  assert.ok(
    warns.some((w) => /ORACLE FAILURE \(fable lane\)/.test(w)),
    'the failure also reaches the warn() sink, not just the returned object',
  );
});

test('main: both lanes crashing still returns a report (never throws), with two ORACLE FAILURE warnings', async () => {
  const exec = () => {
    throw new Error('both spawns dead');
  };
  const out = await main({
    exec,
    readFile: () => '',
    exists: () => true,
    log: () => {},
    warn: () => {},
  });
  assert.deepEqual(out.localOnly, []);
  assert.deepEqual(out.droppedCloudEligible, []);
  assert.equal(out.warnings.filter((w) => /^ORACLE FAILURE/.test(w)).length, 2);
});

// --- plan 2556: batch partitioning -------------------------------------------
//
// THE GAP THIS CLOSES: a batch-held plan is deliberately absent from the oracle's
// `eligible[]` (the plan-2459 solo-claim hold), so before this a board-pass-grouped pair was
// invisible to /local-drain entirely — blocked from every drain by the hold, with no
// batch-capable executor anywhere to take it instead.
//
// NO sol-double-report test exists for `partitionBatches` (plan 3461 review): a `sol` plan
// cannot reach `runnableBatches[]` at all, so the duplicate-across-pools shape `partitionPools`
// above is pinned against cannot occur here. `EXEC_LANE_TABLE.sol.batchable` is `false`
// (claim-plan-lib.mjs) and `claim-plan.mjs batch` refuses to form a batch containing any
// non-batchable-lane member — so queue-drain.mjs's own `computeRunnableBatches` never places a
// sol plan into a runnable train in the first place. Nothing to dedup.

// A batch entry in the shape queue-drain's runnableBatches emits.
function batchEntry(slug, members, dir) {
  return {
    slug,
    members: members.map((m) => String(m.id)),
    memberSlugs: members.map((m) => `${m.id}-X-test`),
    memberPaths: members.map((m) => join(dir, `${m.id}-X-test.md`)),
    seedWrite: 'no',
  };
}
function writeMembers(dir, members) {
  for (const m of members) {
    writeFileSync(
      join(dir, `${m.id}-X-test.md`),
      planContent({ keys: m.cloud === null ? [] : [`cloudExec: ${m.cloud}`] }),
    );
  }
}

test('partitionBatches: an all-local batch is offered in localBatches with its member stamps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldf-batch-'));
  try {
    const members = [
      { id: 2510, cloud: 'false' },
      { id: 2523, cloud: 'false' },
    ];
    writeMembers(dir, members);
    const out = partitionBatches([
      ['sonnet', { runnableBatches: [batchEntry('batch-local', members, dir)] }],
    ]);
    assert.equal(out.localBatches.length, 1);
    assert.equal(out.localBatches[0].slug, 'batch-local');
    assert.equal(out.localBatches[0].lane, 'sonnet');
    assert.deepEqual(out.localBatches[0].memberCloudExec, ['false', 'false']);
    assert.deepEqual(out.droppedCloudEligibleBatches, []);
    assert.deepEqual(out.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partitionBatches: an ALL-cloud-eligible batch is dropped for the scheduled cloud drains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldf-batch-'));
  try {
    const members = [
      { id: 2532, cloud: 'true' },
      { id: 2533, cloud: 'true' },
    ];
    writeMembers(dir, members);
    const out = partitionBatches([
      ['fable', { runnableBatches: [batchEntry('batch-cloud', members, dir)] }],
    ]);
    assert.deepEqual(out.localBatches, []);
    assert.equal(out.droppedCloudEligibleBatches.length, 1);
    assert.equal(out.droppedCloudEligibleBatches[0].slug, 'batch-cloud');
    assert.deepEqual(out.droppedCloudEligibleBatches[0].members, ['2532', '2533']);
    assert.deepEqual(out.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE CALL THIS PINS: a MIXED batch is offered LOCALLY, not dropped. It can never be runnable
// in the cloud lane — the unstamped member is excluded as `cloud` at chain position 1, before
// the batch gate at position 7 — so the cloud oracle never reports that batch at all.
// Withholding it here too would re-create the exact dead zone plan 2556 closes.
test('partitionBatches: a MIXED-stamp batch is offered locally WITH a warning, never dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldf-batch-'));
  try {
    const members = [
      { id: 2600, cloud: 'true' },
      { id: 2601, cloud: 'false' },
    ];
    writeMembers(dir, members);
    const out = partitionBatches([
      ['fable', { runnableBatches: [batchEntry('batch-mixed', members, dir)] }],
    ]);
    assert.deepEqual(
      out.localBatches.map((b) => b.slug),
      ['batch-mixed'],
    );
    assert.deepEqual(out.droppedCloudEligibleBatches, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /MIXED cloudExec BATCH batch-mixed \(fable\)/);
    assert.match(out.warnings[0], /1 of 2 members/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An unstamped member is ordinary stamping debt, not a defect — it means "local", same as the
// single-plan path treats `unset`.
test('partitionBatches: an UNSET member keeps the batch local without a warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldf-batch-'));
  try {
    const members = [
      { id: 2700, cloud: null },
      { id: 2701, cloud: 'false' },
    ];
    writeMembers(dir, members);
    const out = partitionBatches([
      ['fable', { runnableBatches: [batchEntry('batch-unset', members, dir)] }],
    ]);
    assert.deepEqual(
      out.localBatches.map((b) => b.slug),
      ['batch-unset'],
    );
    assert.deepEqual(out.localBatches[0].memberCloudExec, [UNSET, 'false']);
    assert.deepEqual(out.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// One unreadable member makes the whole train un-judgeable — never guess it local.
test('partitionBatches: an unreadable member skips the whole batch and warns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ldf-batch-'));
  try {
    const members = [
      { id: 2800, cloud: 'false' },
      { id: 2801, cloud: 'false' },
    ];
    writeMembers(dir, members);
    rmSync(join(dir, '2801-X-test.md'), { force: true });
    const out = partitionBatches(
      [['fable', { runnableBatches: [batchEntry('batch-gone', members, dir)] }]],
      { exists: () => true }, // plans root resolves ⇒ classified as the mid-move race
    );
    assert.deepEqual(out.localBatches, []);
    assert.deepEqual(out.droppedCloudEligibleBatches, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /BATCH batch-gone \(fable\) skipped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partitionBatches: an absent runnableBatches list is tolerated (an oracle predating plan 2556)', () => {
  const out = partitionBatches([
    ['sonnet', { eligible: [] }],
    ['fable', {}],
    ['ghost', null],
  ]);
  assert.deepEqual(out, {
    localBatches: [],
    droppedCloudEligibleBatches: [],
    skippedBatches: [],
    warnings: [],
  });
});

// Operator ruling 2026-07-27: a withheld train is reported, never silently absent. The
// oracle computes the reason; the filter carries it through with its lane attached.
test('partitionBatches: the oracle skippedBatches list is carried through, lane-tagged', () => {
  const out = partitionBatches([
    [
      'fable',
      {
        runnableBatches: [],
        skippedBatches: [
          {
            slug: 'batch-held',
            reason: 'not every member is takeable here: 99 (blocked-under-hold)',
            blockers: [{ id: '99', cause: 'blocked-under-hold' }],
          },
        ],
      },
    ],
  ]);
  assert.deepEqual(out.localBatches, []);
  assert.equal(out.skippedBatches.length, 1);
  assert.equal(out.skippedBatches[0].slug, 'batch-held');
  assert.equal(out.skippedBatches[0].lane, 'fable');
  assert.match(out.skippedBatches[0].reason, /blocked-under-hold/);
});

test('partitionPools (plan 4255): a land-only /cloud-land hand-off is left for the cloud drains, even when cloudExec is false', () => {
  const pools = [
    [
      'fable',
      {
        eligible: [
          {
            slug: '4255-A-handed-off',
            path: 'docs/superpowers/plans/ready/4255-A-handed-off.md',
            cloudExec: 'false',
            lane: 'fable',
            landOnly: true,
          },
          {
            slug: '4256-B-plain',
            path: 'docs/superpowers/plans/ready/4256-B-plain.md',
            cloudExec: 'false',
            lane: 'fable',
          },
        ],
      },
    ],
  ];
  const out = partitionPools(pools, { exists: () => true });
  assert.deepEqual(
    out.localOnly.map((e) => e.slug),
    ['4256-B-plain'],
  );
  assert.deepEqual(
    out.droppedCloudEligible.map((e) => e.slug),
    ['4255-A-handed-off'],
  );
});
