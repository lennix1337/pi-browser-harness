import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeConnection, waitForVersion, waitForClosed, executable, recordedBrowser, closeIdle, touch, readActivePort } from '../scripts/browser.mjs';

test('a locked or half-written DevToolsActivePort means not ready yet; other read errors still fail', () => {
  const failing = code => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(readActivePort('x', failing('EBUSY')), null);
  assert.equal(readActivePort('x', failing('ENOENT')), null);
  assert.equal(readActivePort('x', () => '9222\n'), null);
  assert.equal(readActivePort('x', () => ''), null);
  assert.deepEqual(readActivePort('x', () => '9222\r\n/devtools/browser/abc\n'), { port: '9222', path: '/devtools/browser/abc' });
  assert.throws(() => readActivePort('x', failing('EISDIR')), /EISDIR/);
});
test('explicit browser choice is respected; a missing executable never silently falls back', () => {
  assert.equal(executable('explicit-chrome', path => path === 'explicit-chrome'), 'explicit-chrome');
  assert.throws(() => executable('missing-chrome', () => false), /Configured browser executable does not exist/);
});
test('shutdown reset is not closure; only independent connection refusal confirms it', async () => {
  let probes = 0;
  await waitForClosed('http://127.0.0.1:1', async () => {
    probes++; throw new Error('fetch failed', { cause: { code: probes === 1 ? 'ECONNRESET' : 'ECONNREFUSED' } });
  }, async () => {});
  assert.equal(probes, 2);
  await assert.rejects(waitForClosed('http://127.0.0.1:1', async () => { throw new Error('unclassified'); }, async () => {}), /closure not verified/);
  await assert.rejects(waitForClosed('http://127.0.0.1:1', async () => ({still:'serving'}), async () => {}), /closure not verified/);
});
test('DevTools file can precede endpoint readiness; retry only the read probe, never browser launch', async () => {
  let probes = 0;
  const result = await waitForVersion('http://127.0.0.1:1', '/browser/identity', async () => {
    if (++probes === 1) throw new Error('version endpoint not ready');
    return { webSocketDebuggerUrl: 'ws://127.0.0.1:1/browser/identity' };
  }, async () => {});
  assert.equal(probes, 2);
  assert.equal(result.webSocketDebuggerUrl, 'ws://127.0.0.1:1/browser/identity');
});
test('a different browser identity is refused, never retried', async () => {
  let probes = 0;
  await assert.rejects(waitForVersion('http://127.0.0.1:1', '/browser/owned', async () => {
    probes++; return { webSocketDebuggerUrl: 'ws://127.0.0.1:1/browser/other' };
  }, async () => {}), /identity mismatch/);
  assert.equal(probes, 1);
});
test('post-dispatch abnormal WS close proceeds to independent endpoint verification, without resend', async () => {
  let sends = 0;
  class ClosingBrowser extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(message) { assert.deepEqual(JSON.parse(message), {id:1,method:'Browser.close'}); sends++; queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  }
  await closeConnection('ws://127.0.0.1:1/test', ClosingBrowser);
  assert.equal(sends, 1);
});
test('pre-dispatch connection failure cannot be classified as a successful close', async () => {
  class FailedBrowser extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
    close() {}
  }
  await assert.rejects(closeConnection('ws://127.0.0.1:1/test', FailedBrowser), /before close dispatch/);
});
test('a record whose endpoint refuses connections is stale and removed; other probe failures keep it', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'browser-record-')), 'browser.json');
  const saved = { endpoint: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1/browser/x', profile: 'p' };
  assert.deepEqual(await recordedBrowser(file, async () => assert.fail('no record, nothing to probe')), {});
  writeFileSync(file, JSON.stringify(saved));
  const alive = await recordedBrowser(file, async () => ({ webSocketDebuggerUrl: saved.ws }));
  assert.deepEqual(alive, { saved, current: { webSocketDebuggerUrl: saved.ws } });
  assert.ok(existsSync(file), 'a live browser keeps its record');
  await assert.rejects(recordedBrowser(file, async () => { throw new Error('fetch failed', { cause: { code: 'ECONNRESET' } }); }), /fetch failed/);
  assert.ok(existsSync(file), 'a reset or timeout is not proof the browser is gone');
  const stale = await recordedBrowser(file, async () => { throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }); });
  assert.deepEqual(stale, { saved, gone: true });
  assert.equal(existsSync(file), false, 'the stale record is removed so start and stop are not blocked forever');
});

test('an idle recorded browser is closed after the idle window; recent use, another identity or zero keep it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-idle-'));
  const file = join(dir, 'browser.json'), activity = join(dir, 'last-used');
  const saved = { endpoint: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1/browser/own', profile: 'p' };
  const minute = 60_000, now = Date.now();
  let closes = 0;
  const io = { now, probe: async () => ({ webSocketDebuggerUrl: saved.ws }), close: async ws => { assert.equal(ws, saved.ws); closes++; }, closed: async () => {} };
  assert.equal((await closeIdle(file, activity, 30 * minute, io)).status, 'not_started');
  writeFileSync(file, JSON.stringify(saved));
  const old = (now - 40 * minute) / 1000;
  utimesSync(file, old, old);
  touch(activity);
  assert.equal((await closeIdle(file, activity, 30 * minute, io)).status, 'in_use', 'a recent action keeps the browser');
  utimesSync(activity, old, old);
  assert.equal((await closeIdle(file, activity, 0, io)).status, 'disabled');
  const other = await closeIdle(file, activity, 30 * minute, { ...io, probe: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/browser/other' }) });
  assert.equal(other.status, 'refused', 'a browser with another identity at that port is never closed');
  assert.equal(closes, 0);
  const result = await closeIdle(file, activity, 30 * minute, io);
  assert.equal(result.status, 'closed_idle');
  assert.equal(closes, 1);
  assert.equal(existsSync(file), false, 'the record goes with the closed browser');
});
test('a browser started but never used counts its idle time from the launch record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-idle-'));
  const file = join(dir, 'browser.json');
  writeFileSync(file, JSON.stringify({ endpoint: 'http://127.0.0.1:1', ws: 'ws://x/own', profile: 'p' }));
  const io = { now: Date.now(), probe: async () => ({ webSocketDebuggerUrl: 'ws://x/own' }), close: async () => assert.fail('fresh launch must stay'), closed: async () => {} };
  assert.equal((await closeIdle(file, join(dir, 'absent'), 30 * 60_000, io)).status, 'in_use');
});
