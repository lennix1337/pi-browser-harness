import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const home = process.env.PI_BROWSER_HARNESS_HOME ?? join(homedir(), '.cache', 'pi-browser-harness');
const record = join(home, 'browser.json');
export async function version(endpoint) {
  const res = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!res.ok) throw new Error('CDP version HTTP ' + res.status);
  return res.json();
}
function executable() {
  const candidates = [process.env.PI_BROWSER_HARNESS_EXECUTABLE,
    process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(p => p && existsSync(p));
  if (!found) throw new Error('Set PI_BROWSER_HARNESS_EXECUTABLE to an installed Edge/Chrome executable.');
  return found;
}
export async function waitForVersion(endpoint, expectedPath, probe = version, wait = delay, deadline = Date.now() + 15000) {
  let failure;
  while (Date.now() < deadline) {
    let info;
    try { info = await probe(endpoint); }
    catch (error) { failure = error; await wait(150); continue; }
    if (new URL(info.webSocketDebuggerUrl).pathname !== expectedPath) throw new Error('Profile CDP identity mismatch.');
    return info;
  }
  throw new Error('Browser CDP readiness failed (browser not relaunched): ' + (failure?.message ?? 'deadline'));
}
async function start(headless) {
  if (existsSync(record)) {
    const saved = JSON.parse(readFileSync(record, 'utf8'));
    const current = await version(saved.endpoint);
    if (current.webSocketDebuggerUrl !== saved.ws) throw new Error('Browser identity mismatch; refused to reuse. Inspect browser.json without killing other processes.');
    return { status: 'running', endpoint: saved.endpoint, profile: saved.profile };
  }
  // Always request a new ephemeral port from Chromium and read its profile-specific identity.
  // It cannot collide with, attach to, or replace an existing personal CDP port.
  mkdirSync(home, { recursive: true });
  const { mkdtempSync } = await import('node:fs');
  const profile = mkdtempSync(join(home, 'profile-'));
  const log = join(profile, 'browser.log');
  const logFd = openSync(log, 'a');
  const child = spawn(executable(), ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []), 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', logFd], windowsHide: headless });
  closeSync(logFd);
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure = new Error('Browser exited before readiness: ' + code); });
  child.unref();
  const active = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (existsSync(active)) {
      const [port, path] = readFileSync(active, 'utf8').trim().split(/\r?\n/);
      const endpoint = 'http://127.0.0.1:' + port;
      let info;
      try { info = await waitForVersion(endpoint, path, version, delay, deadline); }
      catch (error) { throw new Error(error.message + '; own browser log: ' + log); }
      writeFileSync(record, JSON.stringify({ endpoint, ws: info.webSocketDebuggerUrl, profile, pid: child.pid }, null, 2));
      return { status: 'started', endpoint, profile, configure: 'Set PI_BROWSER_HARNESS_CDP_URL to endpoint, or pass endpoint to browser_harness open.' };
    }
    await delay(150);
  }
  throw new Error('Browser readiness timed out. Inspect the newly created profile; outcome uncertain, no automatic restart.');
}
export async function closeConnection(url, Constructor = WebSocket) {
  return new Promise((resolve, reject) => {
    const ws = new Constructor(url);
    let sent = false;
    const timer = setTimeout(() => { ws.close(); reject(new Error('Browser close unconfirmed; inspect before retry.')); }, 5000);
    const ended = () => {
      clearTimeout(timer);
      if (sent) resolve();
      else reject(new Error('CDP failed before close dispatch; browser was not asked to close.'));
    };
    ws.addEventListener('open', () => { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); sent = true; });
    // Chromium may close its transport without a clean WS handshake when Browser.close succeeds.
    // The caller must independently observe that the same endpoint stopped responding.
    ws.addEventListener('error', ended);
    ws.addEventListener('close', ended);
  });
}
export async function waitForClosed(endpoint, probe = version, wait = delay) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await probe(endpoint); }
    catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return;
      // ECONNRESET/timeouts during shutdown are not proof of closure: observe until refusal.
      lastError = error;
    }
    await wait(100);
  }
  throw new Error('Browser closure not verified; outcome uncertain: ' + (lastError?.message ?? 'endpoint still responds'));
}
async function stop() {
  if (!existsSync(record)) return { status: 'not_started', scope: home };
  const saved = JSON.parse(readFileSync(record, 'utf8'));
  const current = await version(saved.endpoint);
  if (current.webSocketDebuggerUrl !== saved.ws) throw new Error('Browser identity mismatch; refused to close.');
  await closeConnection(saved.ws);
  // A WebSocket close alone does not prove the endpoint stopped serving.
  await waitForClosed(saved.endpoint);
  unlinkSync(record);
  return { status: 'closed', profileRetained: saved.profile };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
const [action, flag] = process.argv.slice(2);
try {
  if (!['start', 'stop', 'status'].includes(action) || (flag && !(action === 'start' && flag === '--headless')) || process.argv.length > 4) throw new Error('Usage: npm run browser -- start [--headless] | status | stop');
  const result = action === 'start' ? await start(flag === '--headless') : action === 'stop' ? await stop()
    : { status: existsSync(record) ? 'recorded' : 'not_started', ...(existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {}) };
  console.log(JSON.stringify(result));
} catch (error) { console.error(JSON.stringify({ status: 'error', message: error.message })); process.exitCode = 1; }
}
