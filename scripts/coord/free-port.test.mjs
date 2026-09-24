// scripts/coord/free-port.test.mjs — unit tests for the plan-1291 free-port probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { pickFreePort } from './free-port.mjs';

test('pickFreePort returns a valid ephemeral port that is actually bindable', async () => {
  const port = await pickFreePort();
  assert.equal(Number.isInteger(port), true);
  assert.ok(port >= 1024 && port <= 65535, `port ${port} outside sane range`);

  // The port must be free after the probe releases it: bind it ourselves.
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => srv.close(resolve));
  });
});

test('pickFreePort never hands out a port something else already holds', async () => {
  // Occupy a probed port, then probe again — the OS cannot re-assign a bound
  // port, so the second pick must differ (the "two calls don't collide" contract).
  const first = await pickFreePort();
  const holder = net.createServer();
  await new Promise((resolve, reject) => {
    holder.on('error', reject);
    holder.listen(first, '127.0.0.1', resolve);
  });
  try {
    const second = await pickFreePort();
    assert.notEqual(second, first, 'probe returned a port that is currently bound');
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});
