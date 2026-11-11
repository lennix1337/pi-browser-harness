// Protocol double of python/bridge.py --serve. No browser, no CDP: it lets the host-side tests drive
// crashes, hangs, oversized, split and noisy replies, EOF and start failure deterministically.
// Behaviour switches come from the environment the test sets before it spawns the worker.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.env.FAKE_LOG;
const exitAfter = Number(process.env.FAKE_EXIT_AFTER ?? 0);       // exit right after the Nth reply (crash between actions)
const ignoreEof = process.env.FAKE_IGNORE_EOF === '1';            // keep running after the host closes stdin
const hangPingOnce = process.env.FAKE_HANG_PING_ONCE;              // first ping never answers (marker file)
let endpoint, served = 0;

const write = (message, then) => process.stdout.write(JSON.stringify(message) + '\n', then);
function answer(message) {
  served++;
  if (exitAfter && served >= exitAfter) write(message, () => process.exit(0));
  else write(message);
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.control === 'hello') {
    if (logFile) appendFileSync(logFile, `pid ${process.pid}\n`);
    if (message.endpoint.includes('fail-start')) return write({ id: message.id, control: 'error', error: 'endpoint refused' }, () => process.exit(1));
    endpoint = message.endpoint;
    return write({ id: message.id, control: 'ready' });
  }
  if (message.control === 'ping') {
    if (hangPingOnce && !existsSync(hangPingOnce)) { writeFileSync(hangPingOnce, 'hung'); return; }
    return write({ id: message.id, ok: true, control: 'pong' });
  }
  if (logFile) appendFileSync(logFile, message.action + '\n');
  if (message.endpoint !== endpoint) return write({ id: message.id, ok: false, error: 'request endpoint does not match this worker' });
  const reply = { id: message.id, ok: true, result: { pid: process.pid, payload: message.payload } };
  switch (message.action) {
    case 'echo': return answer(reply);
    case 'open': return answer({ id: message.id, ok: true, result: { target: 'fake-tab', session: 'fake-session' } });
    case 'env': return answer({ id: message.id, ok: true, result: { env: process.env } });
    case 'crash': return process.exit(3);
    case 'hang': return;
    case 'big': return answer({ id: message.id, ok: true, result: 'x'.repeat(9 * 1024 * 1024) });
    case 'noise': process.stdout.write('not a protocol message\n'); return answer(reply);
    case 'split': {
      const text = JSON.stringify(reply) + '\n';
      const cut = Math.floor(text.length / 3);
      process.stdout.write(text.slice(0, cut));
      setTimeout(() => process.stdout.write(text.slice(cut, cut * 2)), 20);
      setTimeout(() => process.stdout.write(text.slice(cut * 2)), 40);
      return;
    }
    default: return write({ id: message.id, ok: false, error: 'unknown action' });
  }
});
process.stdin.on('end', () => { if (ignoreEof) setInterval(() => {}, 1000); else process.exit(0); });
