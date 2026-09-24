// scripts/coord/optional-import.test.mjs — name-pair of scripts/coord/optional-import.mjs.
// NEW-FILE JUSTIFICATION: the name-pair of a genuinely new module (plan 4096 T1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importOptional, isMissingModule } from './optional-import.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'optional-import-'));
  writeFileSync(join(dir, 'present.mjs'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'broken-dep.mjs'), "import './not-there.mjs';\nexport const y = 2;\n");
  writeFileSync(join(dir, 'throws.mjs'), "throw new Error('plugin boom');\n");
  return dir;
}

test('importOptional returns the namespace when the module exists', async () => {
  const dir = sandbox();
  try {
    const url = pathToFileURL(join(dir, 'present.mjs'));
    const ns = await importOptional(url, () => import(url.href));
    assert.equal(ns.x, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importOptional returns null ONLY when the optional module itself is absent', async () => {
  const dir = sandbox();
  try {
    const url = pathToFileURL(join(dir, 'absent.mjs'));
    assert.equal(await importOptional(url, () => import(url.href)), null);
    // the href string form is accepted too
    assert.equal(await importOptional(url.href, () => import(url.href)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importOptional RETHROWS when the optional module exists but one of ITS imports is missing', async () => {
  const dir = sandbox();
  try {
    const url = pathToFileURL(join(dir, 'broken-dep.mjs'));
    await assert.rejects(
      importOptional(url, () => import(url.href)),
      (e) => e.code === 'ERR_MODULE_NOT_FOUND' && /not-there\.mjs/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importOptional RETHROWS when the optional module exists but throws while loading', async () => {
  const dir = sandbox();
  try {
    const url = pathToFileURL(join(dir, 'throws.mjs'));
    await assert.rejects(
      importOptional(url, () => import(url.href)),
      /plugin boom/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isMissingModule: the message fallback matches the head path only, never the importer', () => {
  const dir = join(tmpdir(), 'x');
  const url = pathToFileURL(join(dir, 'plugin.mjs'));
  const own = Object.assign(
    new Error(
      `Cannot find module '${join(dir, 'plugin.mjs')}' imported from ${join(dir, 'main.mjs')}`,
    ),
    {
      code: 'ERR_MODULE_NOT_FOUND',
    },
  );
  const dep = Object.assign(
    new Error(
      `Cannot find module '${join(dir, 'dep.mjs')}' imported from ${join(dir, 'plugin.mjs')}`,
    ),
    {
      code: 'ERR_MODULE_NOT_FOUND',
    },
  );
  assert.equal(isMissingModule(own, url), true);
  assert.equal(isMissingModule(dep, url), false);
  // `err.url`, when Node supplies it, is authoritative
  assert.equal(
    isMissingModule({ code: 'ERR_MODULE_NOT_FOUND', url: url.href, message: '' }, url),
    true,
  );
  assert.equal(
    isMissingModule(
      { code: 'ERR_MODULE_NOT_FOUND', url: url.href + 'x', message: own.message },
      url,
    ),
    false,
  );
  // any other error class is never "missing"
  assert.equal(isMissingModule(Object.assign(new Error('x'), { code: 'ENOENT' }), url), false);
  assert.equal(isMissingModule(null, url), false);
});

test('importOptional refuses a non-function loader', async () => {
  await assert.rejects(importOptional('file:///x.mjs', null), /literal import/);
});
