import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeConnection, waitForVersion } from '../scripts/browser.mjs';

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
