import { execFileSync } from 'node:child_process';
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
/**
 * Host-side deadline of one request. A cell gets its own timeout plus a margin for the reply; a screenshot gets the
 * upstream IPC bound (60 s, not the ordinary 5 s) plus margin. The worker is killed when it passes.
 */
export const bridgeDeadline = (request: { action: string; timeout?: unknown }) =>
  request.action === 'exec' ? (typeof request.timeout === 'number' ? request.timeout : 30) * 1000 + 5000
    : request.action === 'screenshot' ? 75000 : 45000;

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
