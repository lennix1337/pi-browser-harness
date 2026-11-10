import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { browserHarnessExtension } from '../src/index.ts';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ENV = 'PI_BROWSER_HARNESS_ONLY_ROOT';

function load() {
  const handlers: string[] = [];
  const tools: { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }[] = [];
  browserHarnessExtension({ idle: { minutes: 1 } })({
    on: (event: string) => { handlers.push(event); },
    registerTool: (definition: (typeof tools)[number]) => { tools.push(definition); },
  } as never);
  return { handlers, tools };
}

function withEnv(value: string | undefined, run: () => void | Promise<void>) {
  const before = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  const restore = () => { if (before === undefined) delete process.env[ENV]; else process.env[ENV] = before; };
  return Promise.resolve().then(run).finally(restore);
}

test('unset or empty ONLY_ROOT registers the tool as before', async t => {
  for (const value of [undefined, '']) {
    await withEnv(value, () => {
      const interval = t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }) as never);
      const { handlers, tools } = load();
      assert.deepEqual(tools.map(tool => tool.name), ['browser_harness']);
      assert.deepEqual(handlers, ['session_shutdown']);
      assert.equal(interval.mock.callCount(), 1, 'the idle timer starts');
      interval.mock.restore();
    });
  }
});

test('ONLY_ROOT naming this package registers, whatever the spelling', async t => {
  const link = join(mkdtempSync(join(tmpdir(), 'pi-browser-root-')), 'link');
  try {
    symlinkSync(packageRoot, link, 'junction');
    const spellings = [packageRoot, packageRoot + '/', packageRoot.replaceAll('\\', '/'), join(packageRoot, 'src', '..'), link];
    if (process.platform === 'win32') spellings.push(packageRoot.toUpperCase(), packageRoot.toLowerCase());
    for (const value of spellings) {
      await withEnv(value, () => {
        const interval = t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }) as never);
        const { handlers, tools } = load();
        assert.equal(tools.length, 1, `registers for ${value}`);
        assert.deepEqual(handlers, ['session_shutdown']);
        assert.equal(interval.mock.callCount(), 1);
        interval.mock.restore();
      });
    }
  } finally { rmSync(join(link, '..'), { recursive: true, force: true }); }
});

test('ONLY_ROOT naming another path registers nothing: no tool, no handler, no timer', async t => {
  const other = mkdtempSync(join(tmpdir(), 'pi-browser-other-'));
  try {
    for (const value of [other, join(other, 'missing'), join(packageRoot, 'src')]) {
      await withEnv(value, () => {
        const interval = t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }) as never);
        const { handlers, tools } = load();
        assert.deepEqual(tools, [], `no tool for ${value}`);
        assert.deepEqual(handlers, [], 'no session_shutdown handler');
        assert.equal(interval.mock.callCount(), 0, 'no idle timer');
        interval.mock.restore();
      });
    }
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('status reports the package root and, in a checkout, the git HEAD', async () => {
  await withEnv(undefined, async () => {
    const { tools } = load();
    const ctx = { sessionManager: { getSessionId: () => 'root-status' } };
    const { details } = await tools[0]!.execute('call', { action: 'status' }, undefined, undefined, ctx);
    assert.equal(String(details.root).toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''), packageRoot.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''));
    if (details.head !== undefined) assert.match(String(details.head), /^[0-9a-f]{7,40}$/);
  });
});
