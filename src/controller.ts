import { randomUUID } from 'node:crypto';
import { bridge, cdpAlive, endpoint, installation, type Request } from './client.ts';

export type Args = { action?: string; endpoint?: string; tab?: string; url?: string; expression?: string;
  node?: number; text?: string; receipt?: string; offset?: number; limit?: number };
export type Transport = (request: Request, signal?: AbortSignal) => Promise<any>;
export type Probe = (origin: string) => Promise<boolean>;
const fields: Record<string, string[]> = {
  status: ['action'], open: ['action', 'endpoint', 'url'], navigate: ['action', 'tab', 'url'],
  inspect: ['action', 'tab'], evaluate: ['action', 'tab', 'expression'], screenshot: ['action', 'tab'],
  click: ['action', 'tab', 'node'], type: ['action', 'tab', 'node', 'text'], close: ['action', 'tab'],
  read: ['action', 'receipt', 'offset', 'limit'],
};
function pageUrl(value: unknown): string {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Supply an HTTP(S) page URL (or about:blank).');
  const u = new URL(value);
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error('Use an HTTP(S) URL without embedded credentials.');
  return value;
}
/** CDP's answer to `Target.closeTarget` for an id the browser does not have. */
const TAB_GONE = /No target with given id/i;
export class Controller {
  private tabs = new Map<string, { endpoint: string; target: string; session: string }>();
  private receipts = new Map<string, string>();
  private busy = false;
  constructor(private send: Transport = bridge, private alive: Probe = cdpAlive) {}

  /** Liveness of each browser that owns a tab; absent without tabs, so a bare status stays offline. */
  private async browsers() {
    const origins = [...new Set([...this.tabs.values()].map(tab => tab.endpoint))];
    if (!origins.length) return undefined;
    const states = await Promise.all(origins.map(async origin => [origin, await this.alive(origin) ? 'up' : 'unreachable'] as const));
    return Object.fromEntries(states);
  }

  private project(result: unknown, extra: Record<string, unknown> = {}) {
    const full = JSON.stringify(result);
    if (full.length > 1024 * 1024) throw new Error('Result exceeds 1 MiB; narrow the extraction. External action may have completed.');
    if (full.length <= 4000) return { status: 'ok', ...extra, result };
    const receipt = randomUUID();
    this.receipts.set(receipt, full);
    while (this.receipts.size > 8) this.receipts.delete(this.receipts.keys().next().value!);
    return { status: 'ok', ...extra, ...this.read({ receipt }) };
  }
  private read(args: Args) {
    const value = this.receipts.get(args.receipt ?? '');
    if (value === undefined) throw new Error('Receipt unknown/expired. Only the latest 8 results in this session are retained.');
    const offset = args.offset ?? 0, limit = args.limit ?? 4000;
    if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !Number.isInteger(limit) || limit < 1 || limit > 12000) throw new Error('Use offset 0..totalChars and limit 1..12000.');
    const nextOffset = offset + limit < value.length ? offset + limit : undefined;
    return { receipt: args.receipt, preview: value.slice(offset, offset + limit), totalChars: value.length, offset,
      next: nextOffset === undefined ? undefined : { tool: 'browser_harness', arguments: { action: 'read', receipt: args.receipt, offset: nextOffset } } };
  }
  async execute(args: Args, signal?: AbortSignal): Promise<{ value: Record<string, any>; image?: string; isError: boolean }> {
    const action = args.action ?? 'status';
    let dispatched = false, acquired = false;
    try {
      if (!fields[action] || Object.keys(args).some(key => !fields[action].includes(key))) throw new Error('Unknown action/fields. Start with status; page actions require an owned tab ID.');
      if (action === 'status') return { value: { status: 'ok', ...installation(), tabs: [...this.tabs.keys()], browsers: await this.browsers() }, isError: false };
      if (action === 'read') return { value: { status: 'ok', ...this.read(args) }, isError: false };
      if (this.busy) throw new Error('Browser action already in progress for this session. Serialize interactions.');
      if (signal?.aborted) throw new Error('Aborted before dispatch');
      let request: Request;
      if (action === 'open') {
        if (this.tabs.size >= 16) throw new Error('16 owned tabs already open; close an unneeded owned tab first.');
        pageUrl(args.url ?? 'about:blank');
        request = { action, endpoint: endpoint(args.endpoint) };
      } else {
        const tab = this.tabs.get(args.tab ?? '');
        if (!tab) throw new Error('Tab is not owned by this Pi session. Use open, or status for owned IDs. Never adopt personal tabs.');
        if (action === 'navigate') pageUrl(args.url);
        if (action === 'evaluate' && (typeof args.expression !== 'string' || !args.expression.length || args.expression.length > 32768)) throw new Error('Supply expression (1..32768 characters).');
        if (['click', 'type'].includes(action) && (!Number.isInteger(args.node) || args.node! < 1)) throw new Error('Supply a positive backend node ID from a fresh inspect.');
        if (action === 'type' && (typeof args.text !== 'string' || args.text.length > 32768)) throw new Error('Supply text (<=32768 characters). Input inserts at the focused node; it does not clear it.');
        request = { action, ...tab, url: args.url, expression: args.expression, node: args.node, text: args.text };
      }
      this.busy = true; acquired = true; dispatched = true;
      let result = await this.send(request, signal);
      if (action === 'open') {
        if (typeof result?.target !== 'string' || typeof result?.session !== 'string') throw new Error('Bridge did not return tab identity; outcome uncertain.');
        this.tabs.set(result.target, { endpoint: request.endpoint, target: result.target, session: result.session });
        const tab = result.target;
        if (args.url && args.url !== 'about:blank') {
          await this.send({ action: 'navigate', ...this.tabs.get(tab)!, url: args.url }, signal);
        }
        return { value: { status: 'ok', tab, endpoint: request.endpoint,
          next: { tool: 'browser_harness', arguments: { action: 'inspect', tab } } }, isError: false };
      }
      if (action === 'close') {
        if (result?.success !== true) throw new Error('Browser did not confirm tab closure. Inspect before retry.');
        this.tabs.delete(args.tab!);
      }
      if (action === 'screenshot') {
        if (typeof result?.data !== 'string' || result.data.length > 6 * 1024 * 1024) throw new Error('Screenshot missing or exceeds 6 MiB.');
        return { value: { status: 'ok', tab: args.tab, format: 'png' }, image: result.data, isError: false };
      }
      // The page the tab shows rides at the top, even when a long result is paged, so a host can tell a consent page.
      const page = typeof result?.url === 'string' && result.url ? { url: result.url } : {};
      return { value: this.project(result, { tab: args.tab, ...page, ...(action === 'click' || action === 'type' ? { verification: 'Input dispatched only; inspect/evaluate the resulting state before claiming success.' } : {}) }), isError: false };
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
      return { value: { status: dispatched ? 'outcome_uncertain' : 'invalid_input',
        message: error instanceof Error ? error.message.slice(0, 500) : 'Browser request failed.',
        ...(dead ? { browser: 'unreachable' } : {}),
        tabs: [...this.tabs.keys()], next: { tool: 'browser_harness', arguments: { action: 'status' } },
        recovery: dead ? `The browser at ${origin} does not answer: it closed or crashed, and its tabs went with it. Start the isolated browser again (${installation().start}), open a new tab on the endpoint it prints, and read the page state there; do not replay effects.`
          : dispatched ? 'Do not replay an effect. Read the owned tab state first; closed/stale sessions never retarget.' : 'Correct input before executing.' }, isError: true };
    } finally { if (acquired) this.busy = false; }
  }
}
