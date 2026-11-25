import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const home = process.env.PI_BROWSER_HARNESS_HOME ?? join(homedir(), '.cache', 'pi-browser-harness');
export const record = join(home, 'browser.json');
/** Touched by every browser_harness page action; its mtime is the browser's last use. */
export const activity = join(home, 'last-used');
export async function version(endpoint) {
  const res = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1500), redirect: 'error' });
  if (!res.ok) throw new Error('CDP version HTTP ' + res.status);
  return res.json();
}
/** Chromium builds Playwright downloaded (`npx playwright install chromium`), newest first. */
export function playwrightChromium(root = join(homedir(), '.cache', 'ms-playwright'), list = readdirSync) {
  let builds;
  try { builds = list(root).filter(name => /^chromium-\d+$/.test(name)); } catch { return []; }
  builds.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return builds.flatMap(build => ['chrome-linux-arm64', 'chrome-linux'].map(dir => join(root, build, dir, 'chrome')));
}
export function executable(selected = process.env.PI_BROWSER_HARNESS_EXECUTABLE, available = existsSync, extra = playwrightChromium()) {
  if (selected) {
    if (!available(selected)) throw new Error('Configured browser executable does not exist: ' + selected);
    return selected;
  }
  const candidates = [
    process.platform === 'win32' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', ...extra];
  const found = candidates.find(p => p && available(p));
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
/**
 * The browser recorded in `file`, if any. A record whose endpoint refuses connections names a browser that is gone
 * (closed by hand, crashed, machine restarted): nothing listens there, so the stale record is removed and `gone` is set.
 * Any other probe failure is not proof and is rethrown with the record kept.
 */
export async function recordedBrowser(file, probe = version) {
  if (!existsSync(file)) return {};
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  try { return { saved, current: await probe(saved.endpoint) }; }
  catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    unlinkSync(file);
    return { saved, gone: true };
  }
}
// external: Windows may return EBUSY or partial contents while Chromium writes DevToolsActivePort.

export function readActivePort(file, read = readFileSync) {
  let text;
  try { text = read(file, 'utf8'); }
  catch (error) { if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) return null; throw error; }
  const [port, path] = text.trim().split(/\r?\n/);
  return /^\d+$/.test(port ?? '') && path?.startsWith('/devtools/browser/') ? { port, path } : null;
}
// external: Windows can retain Chrome headless windows after exit; chrome-headless-shell avoids them.



export function headlessExecutable(selected = process.env.PI_BROWSER_HARNESS_HEADLESS_EXECUTABLE, cache = join(homedir(), '.cache', 'headless-shell'), available = existsSync) {
  if (selected) {
    if (!available(selected)) throw new Error('Configured headless browser executable does not exist: ' + selected);
    return selected;
  }
  const root = join(cache, 'chrome-headless-shell');
  const exe = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const dirs = path => readdirSync(path, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  const builds = existsSync(root) ? dirs(root).flatMap(build => dirs(join(root, build))
    .map(dir => join(root, build, dir, exe)).filter(p => existsSync(p))
    .map(path => ({ path, version: (build.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number) }))) : [];
  builds.sort((a, b) => { for (let i = 0; i < 4; i++) if ((a.version[i] ?? 0) !== (b.version[i] ?? 0)) return (b.version[i] ?? 0) - (a.version[i] ?? 0); return 0; });
  return builds[0]?.path ?? null;
}
// external: A fresh Chromium ephemeral port prevents attachment to an existing personal CDP endpoint.

function launchBrowser(profile, logFd, headless) {
  return spawn((headless && headlessExecutable()) || executable(), ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    ...(headless ? ['--headless=new'] : []), 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', logFd], windowsHide: headless });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

function killTree(pid) {
  // external: Windows taskkill /T includes the browser child processes.
  if (process.platform === 'win32') return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0;
  // external: A detached POSIX browser is a process group leader.
  try { process.kill(-pid, 'SIGKILL'); return true; } catch (error) { return error.code === 'ESRCH'; }
}

async function endLaunched(child, kill, confirmMs) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return 'exited';
  const reported = kill(child.pid);
  const left = () => alive(child.pid) || (process.platform !== 'win32' && alive(-child.pid));
  for (let waited = 0; left() && waited < confirmMs; waited += 50) await delay(50);
  return reported && !left() ? 'closed' : 'unconfirmed';
}
const AFTER_FAILED_START = {
  closed: pid => `the browser this start opened (pid ${pid}) was closed; start can be run again.`,
  exited: pid => pid === undefined ? 'no browser process was started.' : `the browser process this start opened (pid ${pid}) had already exited.`,
  unconfirmed: pid => `the browser this start opened (pid ${pid}) could not be confirmed closed; inspect pid ${pid} before starting again.`,
};
/** A Linux host with no X11 or Wayland display (a server, a VM over SSH) can only run a headless browser. */
export function noDisplay(platform = process.platform, env = process.env) {
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * `io` is the test seam: `dir` holds the record and the profile, `launch` starts the process (it may be async),
 * `readyMs` bounds the wait for its debugging port, `kill` ends the launched tree when that wait fails and
 * `confirmMs` bounds the wait for that tree to be gone.
 */
export async function start(headless, io = {}) {
  headless ||= noDisplay();
  // external: A cold Chromium launch can take over 15 seconds to write DevToolsActivePort.
  const { dir = home, launch = launchBrowser, readyMs = 45000, kill = killTree, confirmMs = 2000 } = io;
  const file = join(dir, 'browser.json');
  const { saved, current, gone } = await recordedBrowser(file);
  if (saved && !gone) {
    if (current.webSocketDebuggerUrl !== saved.ws) throw new Error('Browser identity mismatch; refused to reuse. Inspect browser.json without killing other processes.');
    return { status: 'running', endpoint: saved.endpoint, profile: saved.profile };
  }
  mkdirSync(dir, { recursive: true });
  const { mkdtempSync } = await import('node:fs');
  const profile = mkdtempSync(join(dir, 'profile-'));
  const log = join(profile, 'browser.log');
  const logFd = openSync(log, 'a');
  let child;
  try { child = await launch(profile, logFd, headless); }
  finally { closeSync(logFd); }
  let failure;
  child.once('error', error => { failure = error; });
  child.once('exit', code => { failure = new Error('Browser exited before readiness: ' + code); });
  child.unref();
  try {
    const active = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + readyMs;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const ready = readActivePort(active);
      if (ready) {
        const { port, path } = ready;
        const endpoint = 'http://127.0.0.1:' + port;
        let info;
        try { info = await waitForVersion(endpoint, path, version, delay, deadline); }
        catch (error) { throw new Error(error.message + '; own browser log: ' + log); }
        writeFileSync(file, JSON.stringify({ endpoint, ws: info.webSocketDebuggerUrl, profile, pid: child.pid }, null, 2));
        return { status: 'started', endpoint, profile, configure: 'Set PI_BROWSER_HARNESS_CDP_URL to endpoint, or pass endpoint to browser_harness open.' };
      }
      await delay(150);
    }
    throw new Error('Browser readiness timed out; own browser log: ' + log);
  } catch (error) {
    // external: Without a stored record, later stop and idle cleanup cannot find the launched browser.
    const outcome = await endLaunched(child, kill, confirmMs);
    throw new Error(`${error.message}; ${AFTER_FAILED_START[outcome](child.pid)}`, { cause: error });
  }
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
    // external: Chromium may close the transport without a clean WebSocket handshake after Browser.close.

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
      // external: ECONNRESET or timeout during shutdown does not prove the browser has closed.
      lastError = error;
    }
    await wait(100);
  }
  throw new Error('Browser closure not verified; outcome uncertain: ' + (lastError?.message ?? 'endpoint still responds'));
}
async function stop() {
  const { saved, current, gone } = await recordedBrowser(record);
  if (!saved) return { status: 'not_started', scope: home };
  if (gone) return { status: 'not_running', profileRetained: saved.profile };
  if (current.webSocketDebuggerUrl !== saved.ws) throw new Error('Browser identity mismatch; refused to close.');
  await closeConnection(saved.ws);
  // external: A closed WebSocket does not prove the CDP endpoint stopped serving.
  await waitForClosed(saved.endpoint);
  unlinkSync(record);
  return { status: 'closed', profileRetained: saved.profile };
}
export function touch(file = activity) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, String(Date.now()));
}
const mtime = file => { try { return statSync(file).mtimeMs; } catch { return 0; } };
/**
 * Closes the recorded browser once nothing used it for `idleMs`: the launch record's mtime counts as a use, so a
 * browser started and never driven gets the full window too. Only the browser whose identity matches the record is
 * closed, with the same verified closure as `stop`; `0` disables it.
 */
export async function closeIdle(file = record, used = activity, idleMs, io = {}) {
  const { now = Date.now(), probe = version, close = closeConnection, closed = waitForClosed } = io;
  if (!idleMs) return { status: 'disabled' };
  const { saved, current, gone } = await recordedBrowser(file, probe);
  if (!saved) return { status: 'not_started' };
  if (gone) return { status: 'not_running' };
  const idle = now - Math.max(mtime(file), mtime(used));
  if (idle < idleMs) return { status: 'in_use', idleMs: idle };
  if (current.webSocketDebuggerUrl !== saved.ws) return { status: 'refused', message: 'Browser identity mismatch; not closed.' };
  await close(saved.ws);
  await closed(saved.endpoint);
  unlinkSync(file);
  return { status: 'closed_idle', idleMinutes: Math.round(idle / 60000), profileRetained: saved.profile };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
const [action, flag] = process.argv.slice(2);
let stream = process.stdout, code = 0, answer;
try {
  if (!['start', 'stop', 'status'].includes(action) || (flag && !(action === 'start' && flag === '--headless')) || process.argv.length > 4) throw new Error('Usage: npm run browser -- start [--headless] | status | stop');
  answer = action === 'start' ? await start(flag === '--headless') : action === 'stop' ? await stop()
    : { status: existsSync(record) ? 'recorded' : 'not_started', ...(existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : {}) };
} catch (error) { stream = process.stderr; code = 1; answer = { status: 'error', message: error.message }; }
// external: An open WebSocket can keep Node alive after a command has answered.

stream.write(JSON.stringify(answer) + '\n', () => process.exit(code));
}
