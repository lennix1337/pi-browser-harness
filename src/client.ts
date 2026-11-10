import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export function endpoint(value = process.env.PI_BROWSER_HARNESS_CDP_URL ?? 'http://127.0.0.1:9333') {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
    || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('Use a loopback HTTP CDP origin, e.g. http://127.0.0.1:9333. Remote/cloud endpoints require a separate explicit integration.');
  }
  return u.origin;
}
export type Request = Record<string, unknown> & { action: string; endpoint: string };
// Upstream gives screenshot IPC 60s (not its ordinary 5s); keep host cancellation outside that bound.
export const bridgeDeadline = (action: string) => action === 'screenshot' ? 75000 : 45000;
export async function bridge(request: Request, signal?: AbortSignal): Promise<any> {
  if (!existsSync(python)) throw new Error(`Runtime missing. Run npm run setup in ${root}`);
  if (signal?.aborted) throw new Error('Aborted before dispatch');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [join(root, 'python/bridge.py')], {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const chunks: Buffer[] = [];
    let bytes = 0, failure: string | undefined;
    const stop = (reason: string) => { failure = reason; child.kill(); };
    const abort = () => stop('Aborted; external outcome uncertain. Inspect before retrying.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Deadline exceeded; external outcome uncertain. Inspect before retrying.'), bridgeDeadline(request.action));
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 8 * 1024 * 1024) stop('Response exceeds 8 MiB; outcome uncertain. Narrow the query before continuing.');
      else chunks.push(data);
    });
    // Python diagnostics can contain page content; the structured bridge error is the supported surface.
    child.stderr.resume();
    child.stdin.on('error', () => { failure = 'Bridge input delivery failed; external outcome uncertain. Inspect before retrying.'; });
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(new Error(failure));
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (code !== 0 || reply.ok !== true) throw new Error(reply.error ?? `Bridge exited ${code}`);
        resolve(reply.result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Whether a CDP origin still answers: one GET of /json/version, never a page attach. */
export async function cdpAlive(origin: string, timeoutMs = 2000): Promise<boolean> {
  try { return (await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).ok; }
  catch { return false; }
}

/** Short git HEAD of this package copy, or undefined when it is not a checkout or git is slow/absent. */
function head(): string | undefined {
  if (!existsSync(join(root, '.git'))) return undefined;
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
  catch { return undefined; }
}

export function installation() {
  const sha = head();
  return { root: realpathSync.native(root), ...(sha ? { head: sha } : {}), installed: existsSync(python), version: 'browser-harness 0.1.13',
    defaultEndpoint: endpoint(), runtimeHome: process.env.PI_BROWSER_HARNESS_HOME ?? join(homedir(), '.cache', 'pi-browser-harness'),
    setup: `cd ${root} && npm run setup`, start: `cd ${root} && npm run browser -- start`,
    scope: 'Owned tabs only; status never attaches or launches (it only asks each owned tab\'s browser /json/version). Local CDP. No cloud, telemetry or recordings.' };
}
