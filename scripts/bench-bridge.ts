// Per-action latency of the browser bridge through the real Controller (the same path the Pi tool uses).
// Each iteration opens an owned tab on a local page, reads its state, clicks by element id and reads the click count
// in cells, then closes it. The click effect is checked through js(), so a timing only counts when the action really ran.
//
//   node --import tsx scripts/bench-bridge.ts --endpoint http://127.0.0.1:PORT [--n 40] [--warmup 3] [--out file.json]
//
// The endpoint must be a browser the caller launched on purpose (e.g. `npm run browser -- start --headless` with its own
// PI_BROWSER_HARNESS_HOME). The script never picks an endpoint itself and never touches a personal browser.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Controller } from '../src/controller.ts';
import { BridgeSession } from '../src/bridge-worker.ts';

const PAGE = '<!doctype html><meta charset="utf-8"><title>Bench</title><button id="go" onclick="window.clicks=(window.clicks||0)+1">Go</button>';
const ACTIONS = ['open', 'state', 'click', 'js', 'close'] as const;

function parse(argv: string[]) {
  const option = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const endpoint = option('--endpoint');
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Pass --endpoint http://127.0.0.1:PORT of a browser you launched.');
  const n = Number(option('--n') ?? 40), warmup = Number(option('--warmup') ?? 3);
  const settleMs = Number(option('--settle-ms') ?? 0);
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(warmup) || warmup < 0) throw new Error('--n >= 1 and --warmup >= 0 (integers).');
  if (!Number.isInteger(settleMs) || settleMs < 0) throw new Error('--settle-ms >= 0 (integer).');
  return { endpoint, n, warmup, settleMs, out: option('--out') };
}

/** Nearest-rank percentile of a sorted sample. */
function percentile(sorted: number[], p: number) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 10) / 10;
  return { n: sorted.length, p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)),
    mean: round(sorted.reduce((sum, x) => sum + x, 0) / sorted.length), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) };
}

const options = parse(process.argv.slice(2));
const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const session = new BridgeSession();
const controller = new Controller((request, signal) => session.send(request, signal));
const samples: Record<(typeof ACTIONS)[number], number[]> = { open: [], state: [], click: [], js: [], close: [] };
const started = performance.now();
try {
  for (let i = 0; i < options.n + options.warmup; i++) {
    const measured = i >= options.warmup;
    const timed = async (action: (typeof ACTIONS)[number], args: Record<string, unknown>) => {
      const t0 = performance.now();
      const result = await controller.execute(args as any);
      const ms = performance.now() - t0;
      if (result.isError) throw new Error(`iteration ${i} ${action} failed: ${JSON.stringify(result.value).slice(0, 400)}`);
      if (measured) samples[action].push(ms);
      return result.value as Record<string, any>;
    };
    const { tab } = await timed('open', { action: 'open', endpoint: options.endpoint, url });
    // Unmeasured: lets the page finish loading so the next action does not measure page readiness.
    if (options.settleMs) await new Promise(done => setTimeout(done, options.settleMs));
    const state = await timed('state', { action: 'state', tab });
    const button = /\[(\d+)\] button "Go"/.exec(String(state.output));
    if (!button) throw new Error(`iteration ${i}: button not in the page state: ${String(state.output).slice(0, 300)}`);
    await timed('click', { action: 'exec', tab, code: `click(${button[1]})` });
    const counted = await timed('js', { action: 'exec', tab, code: 'js("window.clicks")' });
    if (String(counted.output).trim() !== '1') throw new Error(`iteration ${i}: click effect not observed (${JSON.stringify(counted.output)})`);
    await timed('close', { action: 'close', tab });
  }
} finally {
  await session.close();
  server.close();
}
const wallSeconds = Math.round((performance.now() - started) / 100) / 10;
const summary = Object.fromEntries(ACTIONS.map(action => [action, summarize(samples[action])]));
const report = { endpoint: options.endpoint, n: options.n, warmup: options.warmup,
  settleMs: options.settleMs, node: process.version, wallSeconds, summary, samples };
if (options.out) {
  const path = resolve(options.out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ n: options.n, wallSeconds, summary, out: options.out }));
