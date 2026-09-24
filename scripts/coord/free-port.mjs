// scripts/coord/free-port.mjs — OS free-port probe (plan 1291).
//
// The done-worktree spine's WebKit mobile preflight used to let verify-mobile.mjs
// default to the canonical :3000 — under ~5-7 parallel sessions a sibling's dev
// server on :3000 either got REUSED (the gate silently tested the WRONG worktree's
// build) or raced the spawn (spurious MOBILE_FAILED, observed on the 1262 land).
// The spine now asks the OS for a dedicated ephemeral port per land and passes it
// as VERIFY_MOBILE_PORT, so the gate always spawns its OWN server on the diff
// under test. Ephemeral ports (Windows/Linux: 49152+) can never collide with the
// canonical 3000 or the sibling pair-shift ports (3010/3011/…).
//
// There is an unavoidable small TOCTOU window between close() here and the dev
// server binding the port — acceptable: nothing else on this host allocates from
// the ephemeral range at that rate, and the pre-existing failure mode (a fixed
// :3000 collision) was near-certain under parallel load rather than near-impossible.

import net from 'node:net';

/**
 * Bind :0 on loopback, read the OS-assigned ephemeral port, release it.
 * @returns {Promise<number>} a port that was free at probe time
 */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
