import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BridgeSession } from '../src/bridge-worker.ts';
import { bridgeDeadline } from '../src/client.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-bridge-worker.mjs', import.meta.url));
const source = fileURLToPath(new URL('../src/bridge-worker.ts', import.meta.url));
const FAKE = ['FAKE_LOG', 'FAKE_EXIT_AFTER', 'FAKE_IGNORE_EOF', 'FAKE_HANG_PING_ONCE'];
const ENDPOINT = 'http://127.0.0.1:9555';
const OTHER = 'http://127.0.0.1:9556';

function session(options: { deadlineMs?: number; healthMs?: number } = {}) {
  return new BridgeSession({
    command: { python: process.execPath, args: [fake], passEnv: FAKE },
    healthMs: options.healthMs ?? 1000, helloMs: 5000, closeGraceMs: 300, deadlineMs: options.deadlineMs,
  });
}
/** Environment switches for the fake worker, restored after the test. */
function withEnv(values: Record<string, string>, body: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return body().finally(() => {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value);
  });
}
const echo = (s: BridgeSession, payload: unknown, endpoint = ENDPOINT) => s.send({ action: 'echo', endpoint, payload });

test('the default worker is the Python bridge in serve mode, not one process per action', () => {
  const defaults = new BridgeSession();
  assert.deepEqual(defaults.command.args.slice(-1), ['--serve']);
  assert.match(defaults.command.args[0], /python[\\/]bridge\.py$/);
});

test('one long-lived worker serves many actions on the same endpoint', async () => {
  const s = session();
  const pids = [];
  for (let i = 0; i < 5; i++) pids.push((await echo(s, i)).pid);
  assert.equal(new Set(pids).size, 1, 'the same process answered every action');
  assert.equal(s.liveWorkers, 1);
  await s.close();
});

test('a worker is bound to one endpoint; another endpoint gets its own worker', async () => {
  const s = session();
  const a = (await echo(s, 'a')).pid;
  const b = (await echo(s, 'b', OTHER)).pid;
  assert.notEqual(a, b);
  assert.equal(s.liveWorkers, 2);
  await s.close();
});

test('a worker that exited between actions is replaced before dispatch, without an error', async () => {
  await withEnv({ FAKE_EXIT_AFTER: '1' }, async () => {
    const s = session();
    const first = (await echo(s, 1)).pid;
    const second = (await echo(s, 2)).pid;
    assert.notEqual(first, second, 'the replacement answered; nothing was replayed');
    await s.close();
  });
});

test('a worker that does not answer the health check is killed and replaced before dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-worker-health-'));
  try {
    await withEnv({ FAKE_HANG_PING_ONCE: join(dir, 'hung') }, async () => {
      const s = session({ healthMs: 300 });
      const first = (await echo(s, 1)).pid;
      const second = (await echo(s, 2)).pid;
      assert.notEqual(first, second);
      assert.equal(s.liveWorkers, 1, 'the unresponsive worker is gone');
      await s.close();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a crash during a request is outcome uncertain, never replayed; the next action starts a fresh worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-worker-crash-'));
  try {
    const log = join(dir, 'actions.log');
    await withEnv({ FAKE_LOG: log }, async () => {
      const s = session();
      const before = (await echo(s, 'before')).pid;
      await assert.rejects(s.send({ action: 'crash', endpoint: ENDPOINT }), /outcome uncertain/);
      const after = (await echo(s, 'after')).pid;
      assert.notEqual(before, after);
      const actions = readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(actions.filter(action => action === 'crash'), ['crash'], 'the effect request was sent exactly once');
      await s.close();
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a request past its deadline kills the worker: outcome uncertain, and the next action gets a fresh worker', async () => {
  const s = session({ deadlineMs: 300 });
  const before = (await echo(s, 'before')).pid;
  await assert.rejects(s.send({ action: 'hang', endpoint: ENDPOINT }), /Deadline exceeded; external outcome uncertain/);
  assert.equal(s.liveWorkers, 0, 'a worker past its deadline is not reused');
  assert.notEqual((await echo(s, 'after')).pid, before);
  await s.close();
});

test('aborting an in-flight request kills the worker and reports outcome uncertain', async () => {
  const s = session();
  await echo(s, 'warm');
  const abort = new AbortController();
  const pending = s.send({ action: 'hang', endpoint: ENDPOINT }, abort.signal);
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /Aborted; external outcome uncertain/);
  assert.equal(s.liveWorkers, 0);
  await s.close();
});

test('an action aborted before dispatch never reaches a worker', async () => {
  const s = session();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(s.send({ action: 'echo', endpoint: ENDPOINT, payload: 1 }, abort.signal), /Aborted before dispatch/);
  assert.equal(s.liveWorkers, 0, 'no worker was started for it');
  await s.close();
});

test('a reply over 8 MiB is refused and its worker is killed', async () => {
  const s = session();
  await echo(s, 'warm');
  await assert.rejects(s.send({ action: 'big', endpoint: ENDPOINT }), /Response exceeds 8 MiB/);
  assert.equal(s.liveWorkers, 0);
  assert.ok((await echo(s, 'after')).pid, 'the next action starts a worker');
  await s.close();
});

test('a reply split over several writes is reassembled exactly', async () => {
  const s = session();
  const reply = await s.send({ action: 'split', endpoint: ENDPOINT, payload: { text: 'pagina ação ✓' } });
  assert.deepEqual(reply.payload, { text: 'pagina ação ✓' });
  await s.close();
});

test('output that is not a protocol message kills the worker: outcome uncertain, never guessed', async () => {
  const s = session();
  await echo(s, 'warm');
  await assert.rejects(s.send({ action: 'noise', endpoint: ENDPOINT }), /protocol.*outcome uncertain/i);
  assert.equal(s.liveWorkers, 0);
  await s.close();
});

test('a worker that fails to start reports the error and leaves nothing running', async () => {
  const s = session();
  await assert.rejects(echo(s, 1, 'http://127.0.0.1:9557/fail-start'), /endpoint refused/);
  assert.equal(s.liveWorkers, 0);
  await s.close();
});

test('close ends idle workers cleanly through EOF and leaves none behind', async () => {
  const s = session();
  await echo(s, 1);
  await echo(s, 2, OTHER);
  assert.deepEqual(await s.close(), { ended: 2, killed: 0 });
  assert.equal(s.liveWorkers, 0);
});

test('close kills a worker that ignores EOF after the grace period; its in-flight request reports uncertain', async () => {
  await withEnv({ FAKE_IGNORE_EOF: '1' }, async () => {
    const s = session();
    await echo(s, 'warm');
    const pending = s.send({ action: 'hang', endpoint: ENDPOINT });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(await s.close(), { ended: 0, killed: 1 });
    await assert.rejects(pending, /uncertain/);
  });
});

test('close is idempotent and the session keeps working: a new worker starts lazily', async () => {
  const s = session();
  const first = (await echo(s, 1)).pid;
  await s.close();
  await s.close();
  const second = (await echo(s, 2)).pid;
  assert.notEqual(first, second);
  await s.close();
});

test('requests in one session are serialized: each concurrent caller gets its own reply, in order', async () => {
  const s = session();
  const replies = await Promise.all([1, 2, 3].map(payload => echo(s, payload)));
  assert.deepEqual(replies.map(reply => reply.payload), [1, 2, 3]);
  await s.close();
});

test('a session without close does not keep the Node process alive', () => {
  const code = `
    const { BridgeSession } = await import(${JSON.stringify(pathToFileURL(source).href)});
    const s = new BridgeSession({ command: { python: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fake)}] } });
    await s.send({ action: 'echo', endpoint: ${JSON.stringify(ENDPOINT)}, payload: 'left running' });
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.signal, null, 'the process exited on its own instead of being killed by the timeout');
  assert.equal(result.status, 0, result.stderr);
});

test('the worker runs with an allowlisted environment: no tokens or cloud keys from the Pi process', async () => {
  await withEnv({ BROWSER_USE_API_KEY: 'k-1', OPENAI_API_KEY: 'k-2', GITHUB_TOKEN: 'k-3', SLACK_BOT_TOKEN: 'k-4', PI_BROWSER_HARNESS_HOME: tmpdir() }, async () => {
    const s = session();
    try {
      const { env } = await s.send({ action: 'env', endpoint: ENDPOINT });
      for (const secret of ['BROWSER_USE_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN']) assert.equal(env[secret], undefined, secret);
      assert.ok(Object.keys(env).some(key => key.toUpperCase() === 'PATH'), 'the interpreter still finds its runtime');
      assert.equal(env.PI_BROWSER_HARNESS_HOME, tmpdir(), 'the runtime directory the host chose reaches the worker');
      assert.equal(env.PYTHONIOENCODING, 'utf-8');
    } finally { await s.close(); }
  });
});

test('each session names its own upstream daemon: one event buffer must never be read by two sessions', async () => {
  const [a, b] = [session(), session()];
  try {
    const first = (await a.send({ action: 'env', endpoint: ENDPOINT })).env.PI_BROWSER_HARNESS_DAEMON;
    const again = (await a.send({ action: 'env', endpoint: OTHER })).env.PI_BROWSER_HARNESS_DAEMON;
    const second = (await b.send({ action: 'env', endpoint: ENDPOINT })).env.PI_BROWSER_HARNESS_DAEMON;
    assert.match(first, /^pi-[0-9a-f]{8}$/);
    assert.equal(again, first, 'one session keeps its daemon across endpoints and worker restarts');
    assert.notEqual(second, first);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('a cell gets its own timeout plus a margin before the worker is killed; screenshots keep the upstream bound', () => {
  assert.equal(bridgeDeadline({ action: 'exec', timeout: 30 }), 35000);
  assert.equal(bridgeDeadline({ action: 'exec', timeout: 120 }), 125000);
  assert.equal(bridgeDeadline({ action: 'exec' }), 35000);
  assert.equal(bridgeDeadline({ action: 'screenshot' }), 75000);
  assert.equal(bridgeDeadline({ action: 'state' }), 45000);
});
