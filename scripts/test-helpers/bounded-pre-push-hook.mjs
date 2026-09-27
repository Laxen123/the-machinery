// A synchronous test caller cannot run a timer while spawnSync blocks. This supervisor keeps
// an event loop alive and kills the shell tree BEFORE its root exits (Windows taskkill cannot
// discover orphan descendants after spawnSync's own timeout has already killed that root).
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { shExe } from '../coord/sh-exec.mjs';
import { killProcessTreeByPid } from '../coord/kill-tree.mjs';

const [hookPath, rawTimeout] = process.argv.slice(2);
const timeout = Number(rawTimeout);
if (!hookPath || !Number.isSafeInteger(timeout) || timeout <= 0) {
  throw new Error('bounded-pre-push-hook: expected hook path and positive timeout in milliseconds');
}
const child = spawn(shExe('sh'), ['-e', hookPath], { stdio: ['pipe', 'pipe', 'pipe'] });
const result = { timedOut: false, pid: child.pid };
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', (err) => {
  if (err.code !== 'EPIPE') result.inputError = err.message;
});
process.stdin.pipe(child.stdin);
// ambient-load-ok: plan 4228 requires a real hang backstop; 180s is 6.8x the measured 26.6s maximum.
const timer = setTimeout(() => {
  result.timedOut = true;
  result.killResult = killProcessTreeByPid(child.pid, { signal: 'SIGKILL' });
}, timeout);
child.on('error', (err) => {
  result.spawnError = err.message;
});
child.on('close', (code) => {
  clearTimeout(timer);
  writeSync(3, JSON.stringify(result));
  process.exitCode = result.timedOut ? 124 : (code ?? 1);
});
