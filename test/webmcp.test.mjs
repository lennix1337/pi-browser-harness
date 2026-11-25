import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeSession } from '../src/bridge-worker.ts';
import { Controller } from '../src/controller.ts';

const REGISTER_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Mug Shop</title></head>
<body>
  <h1>Mug Shop</h1>
  <p>Mugs: <span id="counter">0</span></p>
  <script>
    let count = 0;
    const render = () => { document.getElementById('counter').textContent = String(count); };
    navigator.modelContext.registerTool({
      name: 'add_mugs',
      description: 'Add mugs to the cart',
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      execute(args) {
        const delta = Number(args && args.count || 0);
        count += delta;
        render();
        return { total: count, added: delta };
      },
    });
    navigator.modelContext.registerTool({
      name: 'reset_cart',
      description: 'Reset the cart counter',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        count = 0;
        render();
        return { total: count };
      },
    });
  </script>
</body>
</html>`;

const PROVIDE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Provided Tools</title></head>
<body>
  <p>Label: <span id="label">initial</span></p>
  <script>
    navigator.modelContext.provideContext({
      tools: [
        {
          name: 'set_label',
          description: 'Set the label text',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          execute({ text }) {
            document.getElementById('label').textContent = text;
            return { label: text };
          },
        },
        {
          name: 'always_fail',
          description: 'Throws a tool error',
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            throw new Error('inventory locked');
          },
        },
      ],
    });
  </script>
</body>
</html>`;

const PLAIN_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Plain Page</title></head>
<body>
  <h1>No tools here</h1>
  <button>Click me</button>
</body>
</html>`;

describe('WebMCP helpers and state output', () => {
  let home;
  let env;
  let server;
  let base;
  let endpoint;
  let bridge;
  let controller;
  const tabs = [];

  async function openTab(path) {
    const opened = await controller.execute({ action: 'open', endpoint, url: base + path });
    assert.equal(opened.isError, false, JSON.stringify(opened.value));
    tabs.push(opened.value.tab);
    return opened.value.tab;
  }

  async function execJson(tab, expr) {
    const result = await controller.execute({
      action: 'exec',
      tab,
      code: `import json\nprint(json.dumps(${expr}))`,
    });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    return JSON.parse(result.value.output.trim());
  }

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'pi-browser-webmcp-'));
    env = { ...process.env, PI_BROWSER_HARNESS_HOME: home };
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/register') { res.end(REGISTER_HTML); return; }
      if (req.url === '/provide') { res.end(PROVIDE_HTML); return; }
      res.end(PLAIN_HTML);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const launched = JSON.parse(execFileSync(process.execPath, ['scripts/browser.mjs', 'start', '--headless'], { encoding: 'utf8', env }));
    endpoint = launched.endpoint;
    const prevHome = process.env.PI_BROWSER_HARNESS_HOME;
    process.env.PI_BROWSER_HARNESS_HOME = home;
    bridge = new BridgeSession();
    controller = new Controller((request, signal) => bridge.send(request, signal));
    if (prevHome === undefined) delete process.env.PI_BROWSER_HARNESS_HOME;
    else process.env.PI_BROWSER_HARNESS_HOME = prevHome;
  });

  after(async () => {
    for (const tab of tabs) {
      try { await controller.execute({ action: 'close', tab }); } catch {}
    }
    try { await bridge?.close(); } catch {}
    try { execFileSync(process.execPath, ['scripts/browser.mjs', 'stop'], { encoding: 'utf8', env }); } catch {}
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  test('registerTool page: lists both tools, calls them to mutate DOM, errors on unknown name, and reports webmcp line in state()', async () => {
    const tab = await openTab('/register');

    const listed = await execJson(tab, 'webmcp_tools()');
    assert.deepEqual(listed, [
      {
        name: 'add_mugs',
        description: 'Add mugs to the cart',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      },
      {
        name: 'reset_cart',
        description: 'Reset the cart counter',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    const stateBefore = await controller.execute({ action: 'state', tab });
    assert.equal(stateBefore.isError, false, JSON.stringify(stateBefore.value));
    assert.match(stateBefore.value.output, /^webmcp: add_mugs, reset_cart$/m);

    const added = await execJson(tab, 'webmcp_call("add_mugs", {"count": 2})');
    assert.deepEqual(added, { total: 2, added: 2 });
    const domCount = await execJson(tab, 'js("document.getElementById(\'counter\').textContent")');
    assert.equal(domCount, '2');

    const reset = await execJson(tab, 'webmcp_call("reset_cart", {})');
    assert.deepEqual(reset, { total: 0 });
    const afterReset = await execJson(tab, 'js("document.getElementById(\'counter\').textContent")');
    assert.equal(afterReset, '0');

    const unknown = await controller.execute({
      action: 'exec',
      tab,
      code: 'webmcp_call("no_such_tool", {})',
    });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.value.status, 'error');
    assert.match(unknown.value.message, /no_such_tool/);
    assert.match(unknown.value.message, /add_mugs/);
  });

  test('provideContext page: lists tools, runs them, reports state line, and surfaces tool execution errors', async () => {
    const tab = await openTab('/provide');

    const listed = await execJson(tab, 'webmcp_tools()');
    assert.deepEqual(listed.map(t => t.name), ['set_label', 'always_fail']);

    const stateOut = await controller.execute({ action: 'state', tab });
    assert.equal(stateOut.isError, false, JSON.stringify(stateOut.value));
    assert.match(stateOut.value.output, /^webmcp: set_label, always_fail$/m);

    const updated = await execJson(tab, 'webmcp_call("set_label", {"text": "ready"})');
    assert.deepEqual(updated, { label: 'ready' });
    const domLabel = await execJson(tab, 'js("document.getElementById(\'label\').textContent")');
    assert.equal(domLabel, 'ready');

    const failed = await controller.execute({
      action: 'exec',
      tab,
      code: 'webmcp_call("always_fail", {})',
    });
    assert.equal(failed.isError, true);
    assert.match(failed.value.message, /inventory locked/);
  });

  test('page without tools returns [] and omits the webmcp line from state()', async () => {
    const tab = await openTab('/plain');

    const listed = await execJson(tab, 'webmcp_tools()');
    assert.deepEqual(listed, []);

    const stateOut = await controller.execute({ action: 'state', tab });
    assert.equal(stateOut.isError, false, JSON.stringify(stateOut.value));
    assert.doesNotMatch(stateOut.value.output, /\bwebmcp:/);

    const unknown = await controller.execute({
      action: 'exec',
      tab,
      code: 'webmcp_call("add_mugs", {"count": 1})',
    });
    assert.equal(unknown.isError, true);
    assert.equal(unknown.value.status, 'error');
    assert.match(unknown.value.message, /add_mugs/);
  });

  test('native navigator.modelContext is preserved and never overridden by the shim', async () => {
    const tab = await openTab('/plain');
    const preserved = await execJson(tab, `js("""(() => {
      const native = {
        marker: 'native-impl',
        listTools() {
          return [{ name: 'native_echo', description: 'Native tool', inputSchema: { type: 'object' } }];
        },
        executeTool(name, args) {
          if (name !== 'native_echo') throw new Error('missing');
          return { native: true, args };
        },
      };
      Object.defineProperty(navigator, 'modelContext', { value: native, configurable: true, writable: true });
      return navigator.modelContext === native;
    })()""")`);
    assert.equal(preserved, true);

    const afterReShim = await controller.execute({
      action: 'exec',
      tab,
      code: 'import repl, json\njs(repl.WEBMCP_SHIM_JS)\nprint(json.dumps(js("navigator.modelContext && navigator.modelContext.marker")))',
    });
    assert.equal(afterReShim.isError, false, JSON.stringify(afterReShim.value));
    assert.equal(JSON.parse(afterReShim.value.output.trim()), 'native-impl');

    const listed = await execJson(tab, 'webmcp_tools()');
    assert.deepEqual(listed, [{ name: 'native_echo', description: 'Native tool', inputSchema: { type: 'object' } }]);

    const called = await execJson(tab, 'webmcp_call("native_echo", {"x": 7})');
    assert.deepEqual(called, { native: true, args: { x: 7 } });
  });
});
