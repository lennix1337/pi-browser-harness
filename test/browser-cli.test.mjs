import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The launcher as a command: what it prints, where, and that the process ends. No browser.
const cli = fileURLToPath(new URL('../scripts/browser.mjs', import.meta.url));
const env = home => ({ ...process.env, PI_BROWSER_HARNESS_HOME: home });

/** A CDP endpoint that answers /json/version, accepts the browser WebSocket and then never answers nor closes it. */
async function silentBrowser() {
  const sockets = new Set();
  const seen = { frames: 0 };
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/silent` }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => { seen.frames++; });
    socket.on('error', () => { /* the command went away while the socket was held open: that is the point */ });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/devtools/browser/silent`, seen,
    close() { for (const socket of sockets) socket.destroy(); server.close(); } };
}

test('stop answers and ends even when the browser never drops its connection', async () => {
  const browser = await silentBrowser();
  const home = mkdtempSync(join(tmpdir(), 'browser-cli-'));
  writeFileSync(join(home, 'browser.json'), JSON.stringify({ endpoint: browser.endpoint, ws: browser.ws, profile: join(home, 'profile-silent') }));
  const command = spawn(process.execPath, [cli, 'stop'], { env: env(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '', capped = false;
  command.stdout.on('data', chunk => { out += chunk; });
  command.stderr.on('data', chunk => { err += chunk; });
  // The answer comes after the 5 s the launcher gives Browser.close. A command still running long after that is held
  // by the open socket and would never end: the cap ends it so this test fails instead of hanging.
  const cap = setTimeout(() => { capped = true; command.kill('SIGKILL'); }, 20_000);
  try {
    const [code] = await once(command, 'close');
    assert.equal(capped, false, `the command had answered (${err.trim()}) and was still running after 20 s`);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(err), { status: 'error', message: 'Browser close unconfirmed; inspect before retry.' });
    assert.equal(out, '');
    assert.ok(browser.seen.frames >= 1, 'Browser.close reached the browser');
    assert.ok(existsSync(join(home, 'browser.json')), 'an unconfirmed close keeps the record');
  } finally {
    clearTimeout(cap);
    command.kill('SIGKILL');
    browser.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the command prints one JSON line, on stdout when it worked and on stderr when it did not, and exits accordingly', () => {
  const home = mkdtempSync(join(tmpdir(), 'browser-cli-'));
  try {
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: env(home), encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const none = run('status');
    assert.deepEqual([none.status, JSON.parse(none.stdout), none.stderr], [0, { status: 'not_started' }, '']);
    const saved = { endpoint: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1/devtools/browser/x', profile: 'p', pid: 1 };
    writeFileSync(join(home, 'browser.json'), JSON.stringify(saved));
    const recorded = run('status');
    assert.deepEqual([recorded.status, JSON.parse(recorded.stdout), recorded.stderr], [0, { status: 'recorded', ...saved }, '']);
    assert.ok(recorded.stdout.endsWith('}\n'), 'the whole line reached the pipe before the exit');
    const usage = run('restart');
    assert.equal(usage.status, 1);
    assert.equal(usage.stdout, '');
    assert.match(JSON.parse(usage.stderr).message, /^Usage: npm run browser -- start \[--headless\] \| status \| stop$/);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 5 }); }
});
