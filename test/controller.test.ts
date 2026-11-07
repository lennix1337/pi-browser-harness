import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, type Args } from '../src/controller.ts';
import { endpoint, type Request } from '../src/client.ts';

test('network filters apply only to owned tabs and validate filter fields before dispatch', async () => {
  const { controller, calls } = fixture();
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'network', tab: 'owned', filter: { method: 'POST', urlContains: '/save', resourceType: 'Fetch', status: 200 } });
  assert.equal(result.isError, false);
  assert.deepEqual(calls.at(-1)?.filter, { method: 'POST', urlContains: '/save', resourceType: 'Fetch', status: 200 });
  const before = calls.length;
  assert.equal((await controller.execute({ action: 'network', tab: 'unowned', filter: { method: 'POST' } })).isError, true);
  assert.equal((await controller.execute({ action: 'network', tab: 'owned', filter: { method: 'POST', unexpected: 'x' } as any })).isError, true);
  assert.equal(calls.length, before);
});

test('interception validates bounded rules and ownership before any transport', async () => {
  const { controller, calls } = fixture();
  await controller.execute({ action: 'open' });
  const rules = [{ match: { urlPattern: 'http://localhost:1234/api/*', method: 'POST', resourceType: 'Fetch' }, edit: { postData: '{"name":"edited"}', headers: { 'X-Test': 'yes' } } }];
  const start = await controller.execute({ action: 'intercept_start', tab: 'owned', rules } as any);
  assert.equal(start.isError, false);
  assert.deepEqual(calls.at(-1)?.rules, rules);
  for (const action of ['intercept_start', 'intercept_status', 'intercept_stop']) {
    assert.equal((await controller.execute({ action, tab: 'personal', ...(action === 'intercept_start' ? { rules } : {}) } as any)).value.status, 'invalid_input');
  }
  const before = calls.length;
  for (const invalid of [[], Array(17).fill(rules[0]), [{ ...rules[0], maxMatches: 0 }], [{ ...rules[0], maxMatches: 101 }],
    [{ match: {}, edit: { method: 'POST' } }], [{ ...rules[0], edit: {} }], [{ ...rules[0], edit: { method: 'POST\r\nX: x' } }],
    [{ ...rules[0], edit: { url: 'https://u:p@example.com' } }], [{ ...rules[0], edit: { headers: { Host: 'other' } } }],
    [{ ...rules[0], edit: { headers: { 'X-Test': 'x\r\ny' } } }], [{ ...rules[0], edit: { postData: 'x'.repeat(65537) } }],
    [{ ...rules[0], unexpected: true }], [{ ...rules[0], match: { ...rules[0].match, status: 200 } }]]) {
    assert.equal((await controller.execute({ action: 'intercept_start', tab: 'owned', rules: invalid } as any)).value.status, 'invalid_input');
  }
  assert.equal(calls.length, before);
  assert.equal((await controller.execute({ action: 'intercept_status', tab: 'owned' })).isError, false);
  assert.equal((await controller.execute({ action: 'intercept_stop', tab: 'owned' })).isError, false);
});

function fixture() {
  const calls: Request[] = [];
  const controller = new Controller(async request => {
    calls.push(request);
    if (request.action === 'open') return { target: 'owned', session: 'explicit-session' };
    if (request.action === 'close') return { success: true };
    if (request.action === 'screenshot') return { data: Buffer.from('PNG').toString('base64') };
    return { value: 'done' };
  });
  return { controller, calls };
}
test('status is read-only; rejects unowned tabs and invalid actions before transport', async () => {
  const { controller, calls } = fixture();
  assert.equal((await controller.execute({})).isError, false);
  for (const action of ['navigate', 'inspect', 'network', 'click', 'type', 'evaluate', 'screenshot', 'close']) {
    const response = await controller.execute({ action, tab: 'personal' });
    assert.equal(response.isError, true);
    assert.equal(response.value.status, 'invalid_input');
  }
  for (const args of [{ action: 'unknown' }, { action: 'status', tab: 'personal' }]) assert.equal((await controller.execute(args)).isError, true);
  assert.deepEqual(calls, []);
});
test('loopback only; no URL credentials, query, fragment, path, remote or non-HTTP', async () => {
  for (const url of ['https://127.0.0.1:9222', 'http://example.com', 'file:///test', 'http://user:pass@127.0.0.1:9222', 'http://127.0.0.1:9222/path', 'http://127.0.0.1:9222/?x=1', 'http://127.0.0.1:9222/#x']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  const { controller, calls } = fixture();
  for (const url of ['file:///test', 'javascript:alert(1)', 'https://user:password@example.com']) assert.equal((await controller.execute({ action: 'open', url })).isError, true);
  assert.deepEqual(calls, []);
});
test('ownership, endpoint and explicit session round-trip on every page action; closure confirmed', async () => {
  const { controller, calls } = fixture();
  const first = await controller.execute({ action: 'open', endpoint: 'http://127.0.0.1:9444', url: 'https://example.com' });
  assert.equal(first.value.tab, 'owned');
  assert.equal(calls[1].action, 'navigate');
  await controller.execute({ action: 'inspect', tab: 'owned' });
  assert.equal(calls[2].target, 'owned'); assert.equal(calls[2].session, 'explicit-session');
  assert.equal(calls[2].endpoint, 'http://127.0.0.1:9444');
  await controller.execute({ action: 'network', tab: 'owned' });
  assert.equal(calls[3].action, 'network');
  assert.equal(calls[3].target, 'owned'); assert.equal(calls[3].session, 'explicit-session');
  assert.equal(calls[3].endpoint, 'http://127.0.0.1:9444');
  const image = await controller.execute({ action: 'screenshot', tab: 'owned' });
  assert.equal(Buffer.from(image.image!, 'base64').toString(), 'PNG');
  assert.equal((await controller.execute({ action: 'close', tab: 'owned' })).isError, false);
  assert.equal((await controller.execute({ action: 'inspect', tab: 'owned' })).isError, true);
  assert.equal((await controller.execute({ action: 'network', tab: 'owned' })).isError, true);
});
test('failed navigation preserves created identity; uncertain effects never retried', async () => {
  let calls = 0;
  const controller = new Controller(async request => {
    calls++;
    if (request.action === 'open') return { target: 'new-owned', session: 's1' };
    throw new Error('Transport interrupted');
  });
  const result = await controller.execute({ action: 'open', url: 'https://example.com' });
  assert.equal(result.isError, true); assert.equal(result.value.status, 'outcome_uncertain');
  assert.deepEqual(result.value.tabs, ['new-owned']); assert.equal(calls, 2);
});
test('failed first-dispatch effects are never automatically retried', async () => {
  let calls = 0;
  const controller = new Controller(async request => {
    calls++;
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('Effect may already have reached the page');
  });
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'click', tab: 't', node: 123 });
  assert.equal(result.value.status, 'outcome_uncertain');
  assert.equal(calls, 2, 'one open plus exactly one click attempt');
});
test('failed close retains ownership; undefined close response cannot pretend success', async () => {
  const controller = new Controller(async request => request.action === 'open' ? { target: 't', session: 's' } : {});
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'close', tab: 't' });
  assert.equal(result.isError, true);
  assert.deepEqual((await controller.execute({})).value.tabs, ['t']);
});
test('bad arguments and pre-abort never dispatch', async () => {
  const { controller, calls } = fixture();
  await controller.execute({ action: 'open' });
  const invalid: Args[] = [{ action: 'evaluate', tab: 'owned', expression: '' }, { action: 'type', tab: 'owned', node: 1 },
    { action: 'click', tab: 'owned', node: 0 }, { action: 'navigate', tab: 'owned' }];
  for (const args of invalid) assert.equal((await controller.execute(args)).value.status, 'invalid_input');
  const abort = new AbortController(); abort.abort();
  assert.equal((await controller.execute({ action: 'inspect', tab: 'owned' }, abort.signal)).value.status, 'invalid_input');
  assert.equal(calls.length, 1);
});
test('parallel request cannot retarget or release another operation lock', async () => {
  let release!: (value: any) => void, calls = 0;
  const controller = new Controller(() => { calls++; if (calls > 1) return Promise.resolve({ target: 'wrong', session: 'wrong-session' }); return new Promise(resolve => { release = resolve; }); });
  const first = controller.execute({ action: 'open' });
  assert.equal((await controller.execute({ action: 'open' })).isError, true);
  assert.equal((await controller.execute({ action: 'open' })).isError, true);
  assert.equal(calls, 1);
  release({ target: 'own', session: 'session' }); await first;
});
test('pagination retains exact JSON and errors on invalid offsets/expired receipts', async () => {
  const large = { value: 'x'.repeat(11000) };
  const controller = new Controller(async request => request.action === 'open' ? { target: 't', session: 's' } : large);
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'evaluate', tab: 't', expression: 'document.body.innerText' });
  let current = result.value, text = current.preview;
  const receipt = current.receipt;
  while (current.next) {
    current = (await controller.execute(current.next.arguments)).value;
    text += current.preview;
  }
  assert.deepEqual(JSON.parse(text), large);
  assert.equal((await controller.execute({ action: 'read', receipt, offset: -1 })).isError, true);
  for (let i = 0; i < 8; i++) await controller.execute({ action: 'evaluate', tab: 't', expression: '1' });
  assert.equal((await controller.execute({ action: 'read', receipt })).isError, true);
});
test('controllers cannot address another session tabs', async () => {
  const a = fixture(), b = fixture();
  await a.controller.execute({ action: 'open' });
  assert.equal((await b.controller.execute({ action: 'close', tab: 'owned' })).isError, true);
  assert.equal(b.calls.length, 0);
});
test('the page a tab shows rides at the top of inspect/click results, even when a long result is paged', async () => {
  const nodes = Array.from({ length: 400 }, (_, i) => ({ node: i + 1, role: 'button', name: `Allow ${i}` }));
  const controller = new Controller(async request => {
    if (request.action === 'open') return { target: 'owned', session: 's' };
    if (request.action === 'inspect') return { url: 'https://accounts.google.com/o/oauth2/consent', nodes, totalNodes: nodes.length };
    if (request.action === 'click') return { dispatched: true, url: 'https://example.com/next' };
    return {};
  });
  await controller.execute({ action: 'open' });
  const inspected = await controller.execute({ action: 'inspect', tab: 'owned' });
  assert.equal(inspected.value.url, 'https://accounts.google.com/o/oauth2/consent');
  assert.ok(inspected.value.receipt, 'the long result is paged');
  assert.ok(JSON.stringify(inspected.value).indexOf('"url"') < JSON.stringify(inspected.value).indexOf('"preview"'), 'url comes before the page');
  assert.equal((await controller.execute({ action: 'click', tab: 'owned', node: 3 })).value.url, 'https://example.com/next');
  assert.equal((await controller.execute({ action: 'evaluate', tab: 'owned', expression: '1' })).value.url, undefined, 'no url reported, none invented');
});
test('a tab the browser no longer has is released on close instead of staying owned forever', async () => {
  const gone = new Controller(async request => {
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('{"code":-32602,"message":"No target with given id found"}');
  });
  await gone.execute({ action: 'open' });
  const closed = await gone.execute({ action: 'close', tab: 't' });
  assert.equal(closed.isError, false);
  assert.deepEqual((await gone.execute({})).value.tabs, []);
  assert.equal((await gone.execute({ action: 'inspect', tab: 't' })).value.status, 'invalid_input', 'the released handle is no longer addressable');
  const other = new Controller(async request => {
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('Deadline exceeded; external outcome uncertain.');
  });
  await other.execute({ action: 'open' });
  assert.equal((await other.execute({ action: 'close', tab: 't' })).value.status, 'outcome_uncertain');
  assert.deepEqual((await other.execute({})).value.tabs, ['t'], 'an uncertain close keeps the handle');
});
// 03/11: the isolated browser on :9333 died mid-session. Each later evaluate waited 40 s, came back
// outcome_uncertain with "next: status", and status still answered ok with the dead tabs, so the agent
// retried for 20 minutes until a curl of /json/version showed nothing listened there.
test('a timed-out call says when its browser no longer answers, and status shows it too', async () => {
  const probed: string[] = [];
  let up = false;
  const controller = new Controller(async request => {
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('Deadline exceeded; external outcome uncertain. Inspect before retrying.');
  }, async origin => { probed.push(origin); return up; });
  await controller.execute({ action: 'open', endpoint: 'http://127.0.0.1:9444' });
  const dead = await controller.execute({ action: 'evaluate', tab: 't', expression: 'document.title' });
  assert.equal(dead.value.status, 'outcome_uncertain');
  assert.equal(dead.value.browser, 'unreachable');
  assert.match(dead.value.recovery, /http:\/\/127\.0\.0\.1:9444 does not answer.*npm run browser -- start/);
  assert.deepEqual(probed, ['http://127.0.0.1:9444']);
  const status = await controller.execute({ action: 'status' });
  assert.deepEqual(status.value.browsers, { 'http://127.0.0.1:9444': 'unreachable' });
  up = true;
  const slow = await controller.execute({ action: 'evaluate', tab: 't', expression: 'document.title' });
  assert.equal(slow.value.browser, undefined);
  assert.match(slow.value.recovery, /^Do not replay an effect/);
  assert.deepEqual((await controller.execute({ action: 'status' })).value.browsers, { 'http://127.0.0.1:9444': 'up' });
});
test('status without owned tabs probes nothing', async () => {
  const probed: string[] = [];
  const controller = new Controller(async () => ({}), async origin => { probed.push(origin); return true; });
  assert.equal((await controller.execute({})).value.browsers, undefined);
  assert.deepEqual(probed, []);
});

test('an unknown action or field names itself and lists what the action accepts', async () => {
  const { controller, calls } = fixture();
  await controller.execute({ action: 'open' });
  const field = await controller.execute({ action: 'inspect', tab: 'owned', selector: 'body' } as any);
  assert.equal(field.value.status, 'invalid_input');
  assert.match(field.value.message, /unknown field "selector" for inspect; accepts: action, tab/i);
  const action = await controller.execute({ action: 'inspekt', tab: 'owned' } as any);
  assert.match(action.value.message, /unknown action "inspekt"; actions: status, open/i);
  assert.equal(calls.length, 1);
});
