import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeConnection } from '../scripts/browser.mjs';

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
