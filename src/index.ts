import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Controller, render } from './controller.ts';
import { BridgeSession, type Options as BridgeOptions } from './bridge-worker.ts';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './client.ts';
import { activity, closeIdle, record, touch } from '../scripts/browser.mjs';

/** The isolated browser closes after this long without a page action; 0 keeps it open. */
export interface IdleOptions { minutes?: number; everyMs?: number; record?: string; activity?: string }
export interface ExtensionOptions { bridge?: BridgeOptions; idle?: IdleOptions }

/** Same directory regardless of case (Windows), separators, trailing slash or links. */
function canonical(path: string): string {
  let real: string;
  try { real = realpathSync.native(path); } catch { real = resolve(path); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** PI_BROWSER_HARNESS_ONLY_ROOT lets a benchmark load two copies of this package and keep one registered. */
function selected(only = process.env.PI_BROWSER_HARNESS_ONLY_ROOT): boolean {
  return only === undefined || only === '' || canonical(only) === canonical(root);
}

function idleMinutes(value = process.env.PI_BROWSER_HARNESS_IDLE_MINUTES) {
  const minutes = value === undefined || value === '' ? 30 : Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 30;
}

// The options seam lets lifecycle tests inject a fake worker; Pi loads the default export with none.
export function browserHarnessExtension(options: ExtensionOptions = {}) {
  return (pi: ExtensionAPI) => extension(pi, options);
}

function extension(pi: ExtensionAPI, options: ExtensionOptions) {
  if (!selected()) return;
  const sessions = new Map<string, Controller>();
  // One persistent bridge per Pi session: its Python worker serves that session's actions and is ended on shutdown.
  const bridges = new Map<string, BridgeSession>();
  const idle = { minutes: options.idle?.minutes ?? idleMinutes(), file: options.idle?.record ?? record, used: options.idle?.activity ?? activity };
  // A browser left open after the work ended costs ~13 processes and their memory until someone notices it.
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try { await closeIdle(idle.file, idle.used, idle.minutes * 60_000); }
    catch { /* an unclassified probe failure is not proof the browser is idle; try again on the next tick */ }
    finally { checking = false; }
  };
  const timer = idle.minutes > 0 ? setInterval(check, options.idle?.everyMs ?? 60_000) : undefined;
  timer?.unref();
  const used = () => { try { touch(idle.used); } catch { /* the idle clock is advisory */ } };
  pi.on('session_shutdown', async () => {
    clearInterval(timer);
    await Promise.all([...bridges.values()].map(bridge => bridge.close()));
  });
  pi.registerTool({
    name: 'browser_harness', label: 'Browser Harness',
    description: 'Local browser control (browser-use/browser-harness). open makes an owned background tab on a loopback CDP endpoint (default :9333). exec runs a Python cell on that tab only; variables persist per tab. Helpers: goto(url) state() click(id) type(id,text) press(key) scroll(dy) upload(id,path) js(expr) wait_for(fn) wait_for_network_idle() network(filter) intercept(rules) dialog(accept=True) screenshot(); an acting cell prints the new state. state reads the page as [id] role "name". screenshot returns a JPEG. read pages long output. Never touches user tabs; no cloud, telemetry or recordings. Reload loses tab handles. Read the pi-browser-harness skill first.',
    parameters: Type.Object({
      action: Type.Optional(Type.Unsafe<string>({ type: 'string', enum: ['status', 'open', 'exec', 'state', 'screenshot', 'close', 'read'] })),
      endpoint: Type.Optional(Type.String({ description: 'open: loopback CDP origin' })),
      tab: Type.Optional(Type.String({ description: 'owned tab ID from open' })),
      url: Type.Optional(Type.String({ maxLength: 8192, description: 'open: HTTP(S) URL' })),
      code: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, description: 'exec: Python cell' })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: 'exec: seconds, default 30' })),
      max: Type.Optional(Type.Integer({ minimum: 100, maximum: 20000, description: 'state: characters' })),
      full: Type.Optional(Type.Boolean({ description: 'screenshot: whole page' })),
      maxWidth: Type.Optional(Type.Integer({ minimum: 100, maximum: 4096 })),
      receipt: Type.Optional(Type.String({ description: 'read: receipt of a cut output' })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, update, ctx) {
      const session = ctx.sessionManager.getSessionId();
      let controller = sessions.get(session);
      if (!controller) {
        if (sessions.size >= 32) throw new Error('32 browser session controllers retained; reload only after finishing/recording existing browser work.');
        const bridge = new BridgeSession(options.bridge);
        bridges.set(session, bridge);
        sessions.set(session, controller = new Controller((request, signal, progress) => bridge.send(request, signal, progress)));
      }
      const busy = params.action !== undefined && !['status', 'read'].includes(params.action);
      if (busy) used();
      const result = await controller.execute(params, signal, text => update?.({ content: [{ type: 'text', text: text.length > 1500 ? `...${text.slice(-1500)}` : text }], details: { status: 'running' } }));
      if (busy) used();
      const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[] = [{ type: 'text', text: render(result.value) }];
      if (result.image) content.push({ type: 'image', mimeType: result.mimeType ?? 'image/jpeg', data: result.image });
      return { content, details: result.value, isError: result.isError };
    },
  });
}

export default browserHarnessExtension();
