import { randomUUID } from 'node:crypto';
import { cdpAlive, endpoint, installation, type Request } from './client.ts';

export type Args = { action?: string; endpoint?: string; tab?: string; url?: string; code?: string; timeout?: number;
  max?: number; full?: boolean; maxWidth?: number; receipt?: string; offset?: number; limit?: number };
export type Progress = (text: string) => void;
export type Transport = (request: Request, signal?: AbortSignal, progress?: Progress) => Promise<any>;
export type Probe = (origin: string) => Promise<boolean>;
export type Outcome = { value: Record<string, any>; image?: string; mimeType?: string; isError: boolean };

const fields: Record<string, string[]> = {
  status: ['action'], open: ['action', 'endpoint', 'url'], exec: ['action', 'tab', 'code', 'timeout'],
  state: ['action', 'tab', 'max'], screenshot: ['action', 'tab', 'full', 'maxWidth'], close: ['action', 'tab'],
  read: ['action', 'receipt', 'offset', 'limit'],
};
/** Actions of the earlier one-call-per-effect surface. They answer with what replaces them. */
const removed = new Set(['navigate', 'inspect', 'click', 'type', 'evaluate', 'network', 'intercept_start', 'intercept_status', 'intercept_stop']);
const MIGRATION = 'inspect -> state; click/type/evaluate/navigate -> exec with click(id)/type(id,text)/js(expr)/goto(url); '
  + 'network -> exec with network(filter); intercept_* -> exec with intercept(rules)/intercept_status()/intercept_stop().';
export const OUTPUT_VIEW = 12000;
/** What the host keeps of a running cell's output: enough to show where it was, not to hold a runaway loop in memory. */
const PARTIAL_LIMIT = 200_000;
const DEFAULT_TIMEOUT = 30, MAX_TIMEOUT = 300, MAX_CODE = 65536;

function pageUrl(value: unknown): string {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Supply an HTTP(S) page URL (or about:blank).');
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  return value;
}
const integer = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
function validatePageArgs(action: string, args: Args) {
  if (action === 'exec') {
    if (typeof args.code !== 'string' || !args.code.trim() || args.code.length > MAX_CODE) throw new Error(`Supply code (1..${MAX_CODE} characters) for the cell.`);
    if (args.timeout !== undefined && !(typeof args.timeout === 'number' && args.timeout >= 1 && args.timeout <= MAX_TIMEOUT)) throw new Error(`timeout is seconds, 1..${MAX_TIMEOUT} (default ${DEFAULT_TIMEOUT}).`);
  }
  if (action === 'state' && args.max !== undefined && !integer(args.max, 100, 20000)) throw new Error('max is a character budget, 100..20000 (default 3000).');
  if (action === 'screenshot') {
    if (args.full !== undefined && typeof args.full !== 'boolean') throw new Error('full must be true or false.');
    if (args.maxWidth !== undefined && !integer(args.maxWidth, 100, 4096)) throw new Error('maxWidth is pixels, 100..4096 (default 1280).');
  }
}

/** The text a model reads: a JSON header line, then the cell's own output, then any remaining fields as one JSON line. */
export function render(value: Record<string, any>): string {
  const { status, tab, url, output, preview, ...rest } = value;
  const body = typeof output === 'string' ? output : typeof preview === 'string' ? preview : '';
  const tail = Object.keys(rest).length ? '\n' + JSON.stringify(rest) : '';
  return JSON.stringify({ status, tab, url }) + (body ? '\n' + body.replace(/\n$/, '') : '') + tail;
}

/** CDP's answer to `Target.closeTarget` for an id the browser does not have. */
const TAB_GONE = /No target with given id/i;
/** A killed or lost worker takes every tab's cell namespace with it; a plain error reply from a live worker does not. */
const WORKER_LOST = /Deadline exceeded|Aborted|worker|Bridge|exited/i;
export class Controller {
  private tabs = new Map<string, { endpoint: string; target: string; session: string }>();
  private receipts = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();
  constructor(private send: Transport, private alive: Probe = cdpAlive) {}

  /** Liveness of each browser that owns a tab; absent without tabs, so a bare status stays offline. */
  private async browsers() {
    const origins = [...new Set([...this.tabs.values()].map(tab => tab.endpoint))];
    if (!origins.length) return undefined;
    const states = await Promise.all(origins.map(async origin => [origin, await this.alive(origin) ? 'up' : 'unreachable'] as const));
    return Object.fromEntries(states);
  }

  private keep(text: string): string {
    const receipt = randomUUID();
    this.receipts.set(receipt, text);
    while (this.receipts.size > 8) this.receipts.delete(this.receipts.keys().next().value!);
    return receipt;
  }
  /** At most OUTPUT_VIEW characters of output; a longer one is kept whole behind a receipt and cut in the middle. */
  private view(output: string): Record<string, unknown> {
    if (output.length <= OUTPUT_VIEW) return { output };
    const receipt = this.keep(output), half = OUTPUT_VIEW / 2;
    return { output: `${output.slice(0, half)}\n... ${output.length - OUTPUT_VIEW} characters cut; read receipt ${receipt} for all of it ...\n${output.slice(-half)}`,
      receipt, totalChars: output.length, next: { tool: 'browser_harness', arguments: { action: 'read', receipt } } };
  }
  private read(args: Args) {
    const value = this.receipts.get(args.receipt ?? '');
    if (value === undefined) throw new Error('Receipt unknown/expired. Only the latest 8 results in this session are retained.');
    const offset = args.offset ?? 0, limit = args.limit ?? OUTPUT_VIEW;
    if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !Number.isInteger(limit) || limit < 1 || limit > OUTPUT_VIEW) throw new Error(`Use offset 0..totalChars and limit 1..${OUTPUT_VIEW}.`);
    const nextOffset = offset + limit < value.length ? offset + limit : undefined;
    return { receipt: args.receipt, preview: value.slice(offset, offset + limit), totalChars: value.length, offset,
      next: nextOffset === undefined ? undefined : { tool: 'browser_harness', arguments: { action: 'read', receipt: args.receipt, offset: nextOffset } } };
  }

  /** Requests of one session run one at a time, first come first served; a request aborted while it waits never dispatches. */
  private async turn(signal?: AbortSignal): Promise<() => void> {
    const before = this.tail;
    let release!: () => void;
    this.tail = before.then(() => new Promise<void>(resolve => { release = resolve; }));
    if (!signal) { await before; return release; }
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error('Aborted before dispatch')); signal.addEventListener('abort', onAbort, { once: true }); });
    try { await Promise.race([before, aborted]); }
    catch (error) { before.then(() => release?.()); throw error; }
    finally { signal.removeEventListener('abort', onAbort); }
    return release;
  }

  /** `progress` receives the whole output a running cell has printed so far; an exec that dies keeps it as its output. */
  async execute(args: Args, signal?: AbortSignal, progress?: Progress): Promise<Outcome> {
    const action = args.action ?? 'status';
    let partial = '';
    let dispatched = false, release: (() => void) | undefined;
    try {
      if (removed.has(action)) throw new Error(`Action "${action}" was removed; ${MIGRATION}`);
      const accepted = fields[action];
      if (!accepted) throw new Error(`Unknown action "${action}"; actions: ${Object.keys(fields).join(', ')}. Start with status; page actions require an owned tab ID.`);
      const stray = Object.keys(args).find(key => !accepted.includes(key));
      if (stray !== undefined) throw new Error(`Unknown field "${stray}" for ${action}; accepts: ${accepted.join(', ')}.`);
      if (action === 'status') return { value: { status: 'ok', ...installation(), tabs: [...this.tabs.keys()], browsers: await this.browsers() }, isError: false };
      if (action === 'read') return { value: { status: 'ok', ...this.read(args) }, isError: false };
      if (signal?.aborted) throw new Error('Aborted before dispatch');
      release = await this.turn(signal);
      if (signal?.aborted) throw new Error('Aborted before dispatch');
      if (action === 'open') return await this.open(args, signal, () => { dispatched = true; });
      const tab = this.tabs.get(args.tab ?? '');
      if (!tab) throw new Error('Tab is not owned by this Pi session. Use open, or status for owned IDs. Never adopt personal tabs.');
      validatePageArgs(action, args);
      const request: Request = { action, ...tab };
      if (action === 'exec') Object.assign(request, { code: args.code, timeout: args.timeout ?? DEFAULT_TIMEOUT });
      if (action === 'state') request.max = args.max ?? 3000;
      if (action === 'screenshot') Object.assign(request, { full: args.full ?? false, maxWidth: args.maxWidth ?? 1280 });
      dispatched = true;
      const onOutput = action === 'exec' ? (text: string) => { if (partial.length < PARTIAL_LIMIT) partial += text; progress?.(partial); } : undefined;
      const result = await this.send(request, signal, onOutput);
      if (action === 'close') {
        if (result?.success !== true) throw new Error('Browser did not confirm tab closure. Inspect before retry.');
        this.tabs.delete(args.tab!);
        return { value: { status: 'ok', tab: args.tab }, isError: false };
      }
      if (action === 'screenshot') {
        if (typeof result?.data !== 'string' || result.data.length > 6 * 1024 * 1024) throw new Error('Screenshot missing or exceeds 6 MiB.');
        return { value: { status: 'ok', tab: args.tab, ...(result.url ? { url: result.url } : {}), format: 'jpeg', width: result.width, height: result.height },
          image: result.data, mimeType: 'image/jpeg', isError: false };
      }
      return this.cell(args.tab!, result);
    } catch (error) {
      // Closing a tab the browser no longer has (closed by hand, crashed) changes nothing there: release the handle,
      // or it would count against the 16-tab limit and list as owned forever.
      if (action === 'close' && dispatched && error instanceof Error && TAB_GONE.test(error.message)) {
        this.tabs.delete(args.tab!);
        return { value: { status: 'ok', tab: args.tab, note: 'The browser no longer had this tab; ownership released.' }, isError: false };
      }
      // A browser that stopped answering explains a timeout better than any retry: its tabs are gone with it.
      const origin = dispatched ? this.tabs.get(args.tab ?? '')?.endpoint ?? (action === 'open' ? endpoint(args.endpoint) : undefined) : undefined;
      const dead = origin !== undefined && !await this.alive(origin);
      const text = error instanceof Error ? error.message.slice(0, 500) : 'Browser request failed.';
      const lost = dispatched && action === 'exec' && WORKER_LOST.test(text) ? ' REPL restarted, variables lost.' : '';
      return { value: { status: dispatched ? 'outcome_uncertain' : 'invalid_input', ...(args.tab ? { tab: args.tab } : {}),
        message: text + lost,
        ...(partial ? this.view(partial) : {}),
        ...(dead ? { browser: 'unreachable' } : {}),
        tabs: [...this.tabs.keys()], next: { tool: 'browser_harness', arguments: { action: 'status' } },
        recovery: dead ? `The browser at ${origin} does not answer: it closed or crashed, and its tabs went with it. Start the isolated browser again (${installation().start}), open a new tab on the endpoint it prints, and read the page state there; do not replay effects.`
          : dispatched ? 'Do not replay an effect. Read the owned tab state first; closed/stale sessions never retarget.' : 'Correct input before executing.' }, isError: true };
    } finally { release?.(); }
  }

  /** A cell's or state's result: its status, the page it ended on and its output, cut to what fits a reply. */
  private cell(tab: string, result: any): Outcome {
    if (typeof result?.status !== 'string' || typeof result?.output !== 'string') throw new Error('Bridge returned a malformed cell result; outcome uncertain.');
    const status = result.status;
    const value = { status, tab, ...(typeof result.url === 'string' && result.url ? { url: result.url } : {}), ...this.view(result.output),
      ...(typeof result.error === 'string' && result.error ? { message: result.error.slice(0, 1500) } : {}),
      ...(status === 'outcome_uncertain' ? { recovery: 'An effect was dispatched before the cell failed. Do not replay it: read state first.' } : {}) };
    return { value, isError: status !== 'ok' };
  }

  private async open(args: Args, signal: AbortSignal | undefined, dispatch: () => void): Promise<Outcome> {
    if (this.tabs.size >= 16) throw new Error('16 owned tabs already open; close an unneeded owned tab first.');
    const url = pageUrl(args.url ?? 'about:blank');
    const origin = endpoint(args.endpoint);
    dispatch();
    const result = await this.send({ action: 'open', endpoint: origin }, signal);
    if (typeof result?.target !== 'string' || typeof result?.session !== 'string') throw new Error('Bridge did not return tab identity; outcome uncertain.');
    this.tabs.set(result.target, { endpoint: origin, target: result.target, session: result.session });
    const tab = result.target;
    const opened = { endpoint: origin, exec: 'allowed',
      note: 'exec runs Python cells on this owned tab only (goto, state, click, type, js, network, ...); it never reaches other tabs.',
      next: { tool: 'browser_harness', arguments: { action: 'state', tab } } };
    if (url === 'about:blank') return { value: { status: 'ok', tab, ...opened }, isError: false };
    const loaded = this.cell(tab, await this.send({ action: 'exec', ...this.tabs.get(tab)!, code: `goto(${JSON.stringify(url)})`, timeout: DEFAULT_TIMEOUT }, signal));
    return { value: { ...loaded.value, ...opened, status: loaded.value.status }, isError: loaded.isError };
  }
}
