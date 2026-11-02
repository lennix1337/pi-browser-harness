import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { browserHarnessExtension } from '../src/index.ts';

// Real native tool entry point and real BridgeSession; only the Python worker is replaced by the protocol double.
const fixture = fileURLToPath(new URL('./fixtures/fake-bridge-worker.mjs', import.meta.url));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function loadExtension(options: Parameters<typeof browserHarnessExtension>[0]) {
  const handlers = new Map<string, () => Promise<unknown>>();
  let tool: { execute: (...args: unknown[]) => Promise<{ isError: boolean }> } | undefined;
  browserHarnessExtension(options)({
    on: (event: string, handler: () => Promise<unknown>) => { handlers.set(event, handler); },
    registerTool: (definition: typeof tool) => { tool = definition; },
  } as never);
  assert.ok(tool, 'browser_harness tool must be registered');
  return { handlers, tool };
}

test('session_shutdown ends the session worker and waits until it exited', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-browser-lifecycle-'));
  const log = join(dir, 'worker.log');
  process.env.FAKE_LOG = log;
  try {
    const { handlers, tool } = loadExtension({ bridge: { command: { python: process.execPath, args: [fixture] }, closeGraceMs: 2000 } });
    const ctx = { sessionManager: { getSessionId: () => 'session-1' } };
    const first = await tool.execute('call-1', { action: 'open', endpoint: 'http://127.0.0.1:9333' }, undefined, undefined, ctx);
    const second = await tool.execute('call-2', { action: 'open', endpoint: 'http://127.0.0.1:9333' }, undefined, undefined, ctx);
    assert.equal(first.isError, false);
    assert.equal(second.isError, false);

    const pids = readFileSync(log, 'utf8').split('\n').filter(line => line.startsWith('pid ')).map(line => Number(line.slice(4)));
    assert.equal(pids.length, 1, 'two actions of one session share one persistent worker');
    assert.equal(alive(pids[0]!), true, 'the worker runs while the session is open');

    const shutdown = handlers.get('session_shutdown');
    assert.ok(shutdown, 'session_shutdown must end the bridge');
    await shutdown();
    assert.equal(alive(pids[0]!), false, 'session_shutdown resolves only after the worker exited');
  } finally {
    delete process.env.FAKE_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});
