// scripts/plan-adopt-branch.test.mjs — plan 3111.
//
// NEW-TEST-FILE JUSTIFICATION (the repo's one-line rule): this is the name-pair of a genuinely new
// module, `scripts/plan-adopt-branch.mjs`. The oracle-side half of the same plan is folded into the
// existing `scripts/queue-drain.test.mjs` rather than duplicated here, exactly as the rule intends.
//
// What is being pinned: the `adoptBranch:` stamp authority — the single writer of the signal that
// separates "a rival firing is executing right now" (exclude, plan 2863) from "a prior execution is
// DEAD and its branch is a hand-off" (select and adopt, plan 3111). Its five arms and, above all,
// the one that is dangerous to get wrong: `unavailable` must STRIP NOTHING. Mistaking an unreadable
// origin for "no branches found" would silently delete a live hand-off stamp and re-deadlock the
// plan the whole change exists to free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADOPT_BRANCH_KEY,
  applyAdoptBranchStamp,
  describeAdoptAction,
  planIdFromBasename,
  removeFrontmatterKey,
  resolveAdoptBranchNames,
  syncAdoptBranchStamp,
} from './plan-adopt-branch.mjs';
import { claimedIdOfBasename, readFrontmatterScalar } from './build-index-lib.mjs';

const BODY = (extra = '') =>
  `---\nsummary: 'a plan'\nstage: specced\n${extra}---\n\n> 🟩 **SEED-WRITE: NO** — test.\n\n# A plan\n`;
const STAMPED = (branch) => BODY(`${ADOPT_BRANCH_KEY}: ${branch}\n`);

// --- planIdFromBasename -----------------------------------------------------------------------

test('planIdFromBasename: reads the id off a normal plan basename', () => {
  assert.equal(planIdFromBasename('3073-App-no-prices-market-mode.md'), '3073');
  assert.equal(planIdFromBasename('3084-FABLE-App-hembesok.md'), '3084');
});

test('planIdFromBasename: canonicalises, so a zero-padded name cannot miss its plan', () => {
  assert.equal(planIdFromBasename('0912-X-padded.md'), planIdFromBasename('912-X-padded.md'));
});

test('planIdFromBasename: a LEGACY date-slugged plan carries NO id', () => {
  // Same discipline as ORIGIN_EXECUTED_BRANCH_RXS: a bare `\d{3,}` prefix would claim the id
  // "2026" for `2026-05-17-…`, which a REAL plan (`2026-FABLE-Price-…`) genuinely owns.
  assert.equal(planIdFromBasename('2026-05-17-vetpris-retry.md'), null);
  assert.equal(planIdFromBasename('2026-FABLE-Price-leak.md'), '2026');
});

test('planIdFromBasename: junk and empty input return null rather than throwing', () => {
  for (const v of [undefined, null, '', 'batch-2026-07-27-gt-pill-parity', 'notes.md'])
    assert.equal(planIdFromBasename(v), null, `${v}`);
});

// --- removeFrontmatterKey ---------------------------------------------------------------------

test('removeFrontmatterKey: deletes the key line and leaves every sibling intact', () => {
  const out = removeFrontmatterKey(STAMPED('worktree-3073-X'), ADOPT_BRANCH_KEY);
  assert.equal(readFrontmatterScalar(out, ADOPT_BRANCH_KEY), '');
  assert.equal(readFrontmatterScalar(out, 'stage'), 'specced');
  assert.equal(readFrontmatterScalar(out, 'summary'), 'a plan');
});

test('removeFrontmatterKey: a body with no frontmatter, or without the key, is unchanged', () => {
  const bare = '# no frontmatter here\n';
  assert.equal(removeFrontmatterKey(bare, ADOPT_BRANCH_KEY), bare);
  const body = BODY();
  assert.equal(removeFrontmatterKey(body, ADOPT_BRANCH_KEY), body);
});

test('removeFrontmatterKey: a CRLF file round-trips CRLF', () => {
  // plan 1328's EOL rule, reused rather than re-derived — a spliced LF into a CRLF plan is the
  // exact drift upsertFrontmatterKey's own header warns about.
  const crlf = STAMPED('worktree-3073-X').replace(/\n/g, '\r\n');
  const out = removeFrontmatterKey(crlf, ADOPT_BRANCH_KEY);
  assert.ok(!out.includes(ADOPT_BRANCH_KEY));
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF survived into a CRLF file');
});

// --- applyAdoptBranchStamp (pure) ---------------------------------------------------------------

test('applyAdoptBranchStamp: exactly ONE branch on an unstamped body → stamped', () => {
  const r = applyAdoptBranchStamp(BODY(), ['worktree-3073-X']);
  assert.equal(r.action, 'stamped');
  assert.equal(r.branch, 'worktree-3073-X');
  assert.equal(readFrontmatterScalar(r.content, ADOPT_BRANCH_KEY), 'worktree-3073-X');
});

test('applyAdoptBranchStamp: a stamp that already agrees → noop, byte-identical content', () => {
  const body = STAMPED('worktree-3073-X');
  const r = applyAdoptBranchStamp(body, ['worktree-3073-X']);
  assert.equal(r.action, 'noop');
  assert.equal(r.content, body, 'an idempotent re-stamp must not manufacture a diff (or a commit)');
});

test('applyAdoptBranchStamp: a stamp naming a DIFFERENT single branch is corrected', () => {
  const r = applyAdoptBranchStamp(STAMPED('worktree-3073-old'), ['claude/drain-3073-new']);
  assert.equal(r.action, 'stamped');
  assert.equal(readFrontmatterScalar(r.content, ADOPT_BRANCH_KEY), 'claude/drain-3073-new');
});

test('applyAdoptBranchStamp: NO branches + an existing stamp → stripped (the branch landed)', () => {
  const r = applyAdoptBranchStamp(STAMPED('worktree-3073-X'), []);
  assert.equal(r.action, 'stripped');
  assert.equal(r.branch, 'worktree-3073-X', 'the dead value is reported so the log can name it');
  assert.equal(readFrontmatterScalar(r.content, ADOPT_BRANCH_KEY), '');
});

test('applyAdoptBranchStamp: NO branches and no stamp → noop', () => {
  const body = BODY();
  const r = applyAdoptBranchStamp(body, []);
  assert.equal(r.action, 'noop');
  assert.equal(r.content, body);
});

test('applyAdoptBranchStamp: MORE THAN ONE branch → ambiguous, writes nothing, names all', () => {
  // Plan 2855 had three execution branches at once. Which one a taker continues is a human call,
  // never an unattended one — so the authority must refuse rather than pick the first.
  const body = STAMPED('worktree-3073-X');
  const branches = ['claude/drain-3073-X', 'worktree-3073-X'];
  const r = applyAdoptBranchStamp(body, branches);
  assert.equal(r.action, 'ambiguous');
  assert.equal(r.content, body, 'ambiguity must never silently pick one');
  assert.deepEqual(r.branches, branches);
});

test('applyAdoptBranchStamp: ambiguity on an UNSTAMPED body also refuses', () => {
  const body = BODY();
  const r = applyAdoptBranchStamp(body, ['a-3073', 'b-3073']);
  assert.equal(r.action, 'ambiguous');
  assert.equal(r.content, body);
});

test('applyAdoptBranchStamp: a nullish / non-array branch list reads as none, never throws', () => {
  for (const v of [null, undefined, [null, undefined]])
    assert.equal(applyAdoptBranchStamp(BODY(), v).action, 'noop');
});

// --- syncAdoptBranchStamp (fs + injected origin reader) ------------------------------------------

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'plan-adopt-'));
  const rel = 'docs/superpowers/plans/ready/3073-App-no-prices.md';
  mkdirSync(join(root, 'docs/superpowers/plans/ready'), { recursive: true });
  return {
    root,
    rel,
    write: (content) => writeFileSync(join(root, rel), content),
    read: () => readFileSync(join(root, rel), 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const mapOf = (obj) =>
  new Map(
    Object.entries(obj).map(([k, v]) => [k, [].concat(v).map((name) => ({ name, fresh: false }))]),
  );

test('syncAdoptBranchStamp: stamps the file in place when origin carries one branch', () => {
  const t = makeTree();
  try {
    t.write(BODY());
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => mapOf({ 3073: 'worktree-3073-App-no-prices' }),
      log: () => {},
    });
    assert.equal(r.action, 'stamped');
    assert.equal(readFrontmatterScalar(t.read(), ADOPT_BRANCH_KEY), 'worktree-3073-App-no-prices');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: strips a dead stamp when origin carries nothing for the id', () => {
  const t = makeTree();
  try {
    t.write(STAMPED('worktree-3073-App-no-prices'));
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => mapOf({ 2999: 'worktree-2999-X' }),
      log: () => {},
    });
    assert.equal(r.action, 'stripped');
    assert.equal(readFrontmatterScalar(t.read(), ADOPT_BRANCH_KEY), '');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: an ambiguous id writes NOTHING and logs every branch', () => {
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-App-no-prices');
    t.write(before);
    const logs = [];
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => mapOf({ 3073: ['worktree-3073-App-no-prices', 'claude/drain-3073-App'] }),
      log: (m) => logs.push(m),
    });
    assert.equal(r.action, 'ambiguous');
    assert.equal(t.read(), before, 'the file is untouched');
    assert.match(logs.join('\n'), /AMBIGUOUS/);
    assert.match(logs.join('\n'), /claude\/drain-3073-App/);
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: origin UNAVAILABLE (null) STRIPS NOTHING and never throws', () => {
  // THE arm that is dangerous to get wrong: an unreadable origin is not "no branches found". If it
  // were treated as such, a transient blip would delete a LIVE hand-off stamp and re-deadlock the
  // plan out of every cloud drain — the exact failure this whole change removes.
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-App-no-prices');
    t.write(before);
    const logs = [];
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => null,
      log: (m) => logs.push(m),
    });
    assert.equal(r.action, 'unavailable');
    assert.equal(t.read(), before, 'the live stamp SURVIVES an unreadable origin');
    assert.match(logs.join('\n'), /WARNING/);
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: a THROWING origin reader is caught — unavailable, file untouched', () => {
  // The contract every one of the three ready/-writers relies on, and the close-out spine in
  // particular: a throw there would abort a land mid-flight.
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-App-no-prices');
    t.write(before);
    const logs = [];
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => {
        throw new Error('could not read from remote repository');
      },
      log: (m) => logs.push(m),
    });
    assert.equal(r.action, 'unavailable');
    assert.equal(t.read(), before);
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: an UNREADABLE plan file is unavailable, not a throw', () => {
  const t = makeTree();
  try {
    const r = syncAdoptBranchStamp(t.root, 'docs/superpowers/plans/ready/3073-App-gone.md', {
      lsRemote: () => mapOf({ 3073: 'worktree-3073-X' }),
      log: () => {},
    });
    assert.equal(r.action, 'unavailable');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: an id-less (legacy date-slugged) plan is a silent noop', () => {
  const t = makeTree();
  try {
    let called = false;
    const r = syncAdoptBranchStamp(t.root, 'docs/superpowers/plans/ready/2026-05-17-legacy.md', {
      lsRemote: () => {
        called = true;
        return new Map();
      },
      log: () => {},
    });
    assert.equal(r.action, 'noop');
    assert.equal(called, false, 'no id ⇒ not even a network round trip');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp: accepts an ABSOLUTE plan path as well as a repo-relative one', () => {
  const t = makeTree();
  try {
    t.write(BODY());
    const r = syncAdoptBranchStamp(t.root, join(t.root, t.rel), {
      lsRemote: () => mapOf({ 3073: 'worktree-3073-X' }),
      log: () => {},
    });
    assert.equal(r.action, 'stamped');
    assert.equal(readFrontmatterScalar(t.read(), ADOPT_BRANCH_KEY), 'worktree-3073-X');
  } finally {
    t.cleanup();
  }
});

// --- syncAdoptBranchStamp: same-sha collapse (plan 3767) -----------------------------------------
// `collapseSameShaBranches` (queue-drain.mjs) folds N execution branches at ONE tip into their
// preferred name — an override adopt's un-retired source (T1's delete refused inside a cloud
// sandbox, plan 3756) is one finished branch, not an unresolved rival. `mapOfWithSha` mirrors
// `mapOf` above but carries the `sha` field the collapse needs — `mapOf` deliberately omits it
// (today's "no sha data available" shape, which must never collapse).
const mapOfWithSha = (obj) =>
  new Map(
    Object.entries(obj).map(([k, entries]) => [
      k,
      entries.map(({ name, sha }) => ({
        name,
        sha,
        fresh: false,
        gateBlocked: false,
        status: null,
      })),
    ]),
  );

test('syncAdoptBranchStamp (plan 3767): a same-sha pair — the 3652 shape — stamps the worktree- name', () => {
  const t = makeTree();
  try {
    t.write(BODY());
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () =>
        mapOfWithSha({
          3073: [
            { name: 'claude/drain-3073-App-no-prices', sha: 'abc123' },
            { name: 'worktree-3073-App-no-prices', sha: 'abc123' },
          ],
        }),
      log: () => {},
    });
    assert.equal(r.action, 'stamped');
    assert.equal(r.branch, 'worktree-3073-App-no-prices');
    assert.equal(readFrontmatterScalar(t.read(), ADOPT_BRANCH_KEY), 'worktree-3073-App-no-prices');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (plan 3767): a stamp already naming the RETIRED duplicate is kept — noop, no needless re-stamp', () => {
  const t = makeTree();
  try {
    // the body was already stamped against the branch T1's retire delete failed to remove
    // (a cloud sandbox refusing the DELETE, plan 3756) — the collapse now folds it away in
    // favour of the canonical worktree- name, and the existing stamp must survive as-is.
    const before = STAMPED('claude/drain-3073-App-no-prices');
    t.write(before);
    const logs = [];
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () =>
        mapOfWithSha({
          3073: [
            { name: 'claude/drain-3073-App-no-prices', sha: 'abc123' },
            { name: 'worktree-3073-App-no-prices', sha: 'abc123' },
          ],
        }),
      log: (m) => logs.push(m),
    });
    assert.equal(r.action, 'noop');
    assert.equal(
      t.read(),
      before,
      'the existing stamp is left byte-identical — no re-stamp commit',
    );
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (plan 3767): DIVERGENT shas do not collapse — stays ambiguous exactly as before', () => {
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-App-no-prices');
    t.write(before);
    const logs = [];
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () =>
        mapOfWithSha({
          3073: [
            { name: 'claude/drain-3073-App-no-prices', sha: 'aaa111' },
            { name: 'worktree-3073-App-no-prices', sha: 'bbb222' },
          ],
        }),
      log: (m) => logs.push(m),
    });
    assert.equal(r.action, 'ambiguous');
    assert.equal(t.read(), before, 'the file is untouched');
    assert.match(logs.join('\n'), /AMBIGUOUS/);
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (plan 3767): a NAME-ONLY map (no sha) still stays ambiguous — the pre-3767 shape, unchanged', () => {
  // Same fixture as the pre-existing "an ambiguous id writes NOTHING" test above, but pinned
  // here explicitly against plan 3767's own collapse: no sha data means never collapse.
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-App-no-prices');
    t.write(before);
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => mapOf({ 3073: ['worktree-3073-App-no-prices', 'claude/drain-3073-App'] }),
      log: () => {},
    });
    assert.equal(r.action, 'ambiguous');
    assert.equal(t.read(), before);
  } finally {
    t.cleanup();
  }
});

// --- describeAdoptAction ------------------------------------------------------------------------

test('describeAdoptAction: every arm renders a line naming what actually happened', () => {
  const b = '3073-App-no-prices.md';
  assert.match(
    describeAdoptAction(b, { action: 'stamped', branch: 'w-3073' }),
    /adoptBranch: w-3073/,
  );
  assert.match(describeAdoptAction(b, { action: 'stripped', branch: 'w-3073' }), /stripped/);
  assert.match(
    describeAdoptAction(b, { action: 'ambiguous', branches: ['a', 'b'] }),
    /NOT stamped.*a, b/,
  );
  assert.match(describeAdoptAction(b, { action: 'unavailable', branches: [] }), /unchanged/);
  assert.match(describeAdoptAction(b, { action: 'noop', branches: [] }), /no change/);
});

// --- plan 3111 review-fix round ------------------------------------------------------------------

test('planIdFromBasename (finding 11/12): delegates to the SHARED claimedIdOfBasename parser', async () => {
  // The regression this pins: a hand-rolled second parser can accept a different basename set
  // than move-plan's resolver, so a plan move-plan recognises returns no id here and its
  // ready/-writer silently skips the stamp. Assert agreement on the shapes that differ.
  const { canonicalPlanId } = await import('./batch-paths.mjs');
  for (const b of [
    '3073-App-no-prices.md',
    '2026-FABLE-Price-leak.md',
    '2026-05-17-legacy.md',
    '0912-X-padded.md',
    'batch-2026-07-27-gt-pill-parity.md',
    '3111-FABLE-Infra-x.md',
  ]) {
    const shared = claimedIdOfBasename(b);
    assert.equal(
      planIdFromBasename(b),
      shared ? canonicalPlanId(shared) : null,
      `must agree with the shared parser on ${b}`,
    );
  }
});

test('syncAdoptBranchStamp (finding 18/14): a shared map rides the ONE lsRemote seam', () => {
  const t = makeTree();
  try {
    t.write(BODY());
    let called = false;
    const r = syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => {
        called = true;
        return mapOf({ 3073: 'worktree-3073-X' });
      },
      log: () => {},
    });
    assert.equal(r.action, 'stamped');
    assert.equal(called, true, 'the ONE seam is what a sharing caller injects');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (finding 18/14): a shared map of null is UNAVAILABLE, never "no branches"', () => {
  // The caller resolved origin itself AND FAILED. Collapsing that into an empty map would strip
  // a live hand-off stamp — the exact confusion this module is built to prevent, arriving via
  // the new shared-map path.
  const t = makeTree();
  try {
    const before = STAMPED('worktree-3073-X');
    t.write(before);
    const r = syncAdoptBranchStamp(t.root, t.rel, { lsRemote: () => null, log: () => {} });
    assert.equal(r.action, 'unavailable');
    assert.equal(t.read(), before, 'nothing stripped');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (finding 18/14): an EMPTY shared map still strips (a readable origin)', () => {
  const t = makeTree();
  try {
    t.write(STAMPED('worktree-3073-X'));
    const r = syncAdoptBranchStamp(t.root, t.rel, { lsRemote: () => new Map(), log: () => {} });
    assert.equal(r.action, 'stripped', 'an empty map is a successful read of an origin with none');
  } finally {
    t.cleanup();
  }
});

test('syncAdoptBranchStamp (finding 14): the write is atomic and leaves no temp file behind', () => {
  const t = makeTree();
  try {
    t.write(BODY());
    syncAdoptBranchStamp(t.root, t.rel, {
      lsRemote: () => mapOf({ 3073: 'worktree-3073-X' }),
      log: () => {},
    });
    assert.equal(readFrontmatterScalar(t.read(), ADOPT_BRANCH_KEY), 'worktree-3073-X');
    // Round-2 findings 1/13: the write goes through the SHARED atomic primitive, whose temp
    // name is `<path>.tmp.<pid>` (atomic-write.mjs's TMP_SEP). Nothing may survive it —
    // coordWrite asserts a clean tree right after this runs.
    const leftovers = readdirSync(join(t.root, 'docs/superpowers/plans/ready')).filter(
      (f) => f !== '3073-App-no-prices.md',
    );
    assert.deepEqual(leftovers, [], 'no temp file may survive a successful sync');
  } finally {
    t.cleanup();
  }
});

test('planIdFromBasename (round-2 findings 6/8/15): the id set matches the ORACLE, not just the claim parser', () => {
  // `claimedIdOfBasename` alone is LOOSER than the origin-branch parser this id is compared
  // against: it excludes only an `NNNN-DD-DD-` date shape. A basename the two disagree on would
  // be stamped against a map that structurally cannot contain its branch — silently wrong in
  // the direction that re-runs already-committed work.
  assert.equal(planIdFromBasename('3073-123-followup.md'), null, 'a numeric second segment');
  assert.equal(planIdFromBasename('3073-2026-05-17-legacy.md'), null, 'a date second segment');
  // The shapes that DO carry an id are unchanged.
  assert.equal(planIdFromBasename('3073-App-no-prices.md'), '3073');
  assert.equal(planIdFromBasename('2026-FABLE-Price-leak.md'), '2026');
});

test('planIdFromBasename (round-2 findings 6/8/15): agrees with ORIGIN_EXECUTED_BRANCH_RXS exactly', async () => {
  // The property that actually matters: for any basename, "this module derives an id" iff "the
  // oracle derives the same id from the matching worktree- branch". Assert it over both the
  // agreeing and the previously-disagreeing shapes.
  const { planIdsFromRemoteHeads } = await import('./queue-drain.mjs');
  for (const stem of [
    '3073-App-no-prices',
    '2026-FABLE-Price-leak',
    '3073-123-followup',
    '3073-2026-05-17-legacy',
    '2026-05-17-legacy',
  ]) {
    const fromBranch = planIdsFromRemoteHeads(
      `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/worktree-${stem}`,
    );
    const oracleId = [...fromBranch.keys()][0] ?? null;
    assert.equal(planIdFromBasename(`${stem}.md`), oracleId, `must agree on ${stem}`);
  }
});

test('planIdFromBasename (round-3 findings 4/5/6): the oracle shape is IMPORTED, not re-spelled', async () => {
  // Round 2 fixed the id asymmetry with a LOCAL copy of the oracle's regex; three round-3 angles
  // flagged that copy as the same drift one layer down. The rule now has ONE spelling —
  // queue-drain's exported PLAN_BASENAME_ID_RX — and this asserts the leaf actually uses it
  // rather than agreeing with it by coincidence.
  const { PLAN_BASENAME_ID_RX } = await import('./queue-drain.mjs');
  for (const name of [
    '3073-App-no-prices.md',
    '2026-FABLE-Price-leak.md',
    '3073-123-followup.md',
    '3073-2026-05-17-legacy.md',
    '2026-05-17-legacy.md',
  ]) {
    const shapeOk = PLAN_BASENAME_ID_RX.test(name);
    assert.equal(
      planIdFromBasename(name) !== null,
      shapeOk && Boolean(claimedIdOfBasename(name)),
      `must follow the exported shape for ${name}`,
    );
  }
});

// --- resolveAdoptBranchNames: the ONE collapse both callers share (plan 3767, gpt-review fix) ----
// The first cut wired `collapseSameShaBranches` into `syncAdoptBranchStamp` only, while the CLI's
// `main()` kept its own `(map.get(id) || []).map((b) => b.name)`. Five review angles landed on the
// same consequence: `node scripts/plan-adopt-branch.mjs <id>` — the DOCUMENTED repair command for
// exactly this deadlock — still reported `ambiguous` and wrote no stamp. One exported resolver now
// serves both, so the two paths cannot drift again, and the drift itself is unit-testable (the CLI
// has no test seam of its own).

test('resolveAdoptBranchNames (plan 3767): a same-sha pair resolves to the worktree- name, the other as a duplicate', () => {
  const r = resolveAdoptBranchNames(
    [
      { name: 'claude/drain-3652-X', sha: 'abc123' },
      { name: 'worktree-3652-X', sha: 'abc123' },
    ],
    BODY(),
  );
  assert.deepEqual(r.names, ['worktree-3652-X']);
  assert.deepEqual(r.duplicates, ['claude/drain-3652-X']);
  assert.equal(r.keepStamp, null, 'nothing to keep — the body carries no stamp');
});

test('resolveAdoptBranchNames (plan 3767): a stamp naming the folded-away duplicate is KEPT, not re-stamped', () => {
  const r = resolveAdoptBranchNames(
    [
      { name: 'claude/drain-3652-X', sha: 'abc123' },
      { name: 'worktree-3652-X', sha: 'abc123' },
    ],
    BODY('adoptBranch: claude/drain-3652-X\n'),
  );
  assert.equal(
    r.keepStamp,
    'claude/drain-3652-X',
    'a match against EITHER same-tip name is a match — re-stamping onto the preferred name ' +
      'would be a commit with no functional effect',
  );
});

test('resolveAdoptBranchNames (plan 3767): DIVERGENT shas resolve to BOTH names — still a human call', () => {
  const r = resolveAdoptBranchNames(
    [
      { name: 'claude/drain-2855-a', sha: 'aaa111' },
      { name: 'worktree-2855-b', sha: 'bbb222' },
    ],
    BODY(),
  );
  assert.deepEqual(r.names, ['claude/drain-2855-a', 'worktree-2855-b']);
  assert.deepEqual(r.duplicates, []);
  assert.equal(r.keepStamp, null);
  assert.equal(
    applyAdoptBranchStamp(BODY(), r.names).action,
    'ambiguous',
    'the names this resolver hands the CLI still reach the ambiguous arm when they must',
  );
});

test('resolveAdoptBranchNames (plan 3767): an empty/absent entry list is an empty name list, never a throw', () => {
  assert.deepEqual(resolveAdoptBranchNames([], BODY()).names, []);
  assert.deepEqual(resolveAdoptBranchNames(undefined, BODY()).names, []);
});
