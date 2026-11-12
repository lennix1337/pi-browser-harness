import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller, render, type Args } from '../src/controller.ts';
import { endpoint, type Request } from '../src/client.ts';

const ok = (output = '', url = 'https://example.com/') => ({ status: 'ok', output, url });

function fixture(reply: (request: Request) => any = () => ok('done')) {
  const calls: Request[] = [];
  const controller = new Controller(async request => {
    calls.push(request);
    if (request.action === 'open') return { target: 'owned', session: 'explicit-session' };
    if (request.action === 'close') return { success: true };
    if (request.action === 'screenshot') return { data: Buffer.from('JPG').toString('base64'), format: 'jpeg', url: 'https://example.com/' };
    return reply(request);
  });
  return { controller, calls };
}

test('status is read-only; rejects unowned tabs and invalid actions before transport', async () => {
  const { controller, calls } = fixture();
  assert.equal((await controller.execute({})).isError, false);
  for (const action of ['exec', 'state', 'screenshot', 'close']) {
    const response = await controller.execute({ action, tab: 'personal', ...(action === 'exec' ? { code: '1' } : {}) });
    assert.equal(response.isError, true);
    assert.equal(response.value.status, 'invalid_input');
  }
  for (const args of [{ action: 'unknown' }, { action: 'status', tab: 'personal' }]) assert.equal((await controller.execute(args)).isError, true);
  assert.deepEqual(calls, []);
});

test('removed actions answer with the replacement instead of a bare unknown-action error', async () => {
  const { controller, calls } = fixture();
  await controller.execute({ action: 'open' });
  const hint = /inspect -> state; click\/type\/evaluate\/navigate -> exec with click\(id\)\/type\(id,text\)\/js\(expr\)\/goto\(url\)/;
  for (const action of ['inspect', 'click', 'type', 'evaluate', 'navigate', 'network', 'intercept_start', 'intercept_status', 'intercept_stop']) {
    const response = await controller.execute({ action, tab: 'owned' } as any);
    assert.equal(response.value.status, 'invalid_input', action);
    assert.match(response.value.message, hint, action);
    assert.ok(response.value.message.includes(`"${action}"`), action);
  }
  const network = await controller.execute({ action: 'network' } as any);
  assert.match(network.value.message, /network\(filter\)/);
  const intercept = await controller.execute({ action: 'intercept_start' } as any);
  assert.match(intercept.value.message, /intercept\(rules\)/);
  assert.equal(calls.length, 1, 'only the open reached the transport');
});

test('loopback only; no URL credentials, query, fragment, path, remote or non-HTTP', async () => {
  for (const url of ['https://127.0.0.1:9222', 'http://example.com', 'file:///test', 'http://user:pass@127.0.0.1:9222', 'http://127.0.0.1:9222/path', 'http://127.0.0.1:9222/?x=1', 'http://127.0.0.1:9222/#x']) assert.throws(() => endpoint(url));
  assert.equal(endpoint('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222');
  const { controller, calls } = fixture();
  for (const url of ['file:///test', 'javascript:alert(1)', 'https://user:password@example.com']) assert.equal((await controller.execute({ action: 'open', url })).isError, true);
  assert.deepEqual(calls, []);
});

test('open reports where exec is allowed; ownership, endpoint and session round-trip on every page action; closure confirmed', async () => {
  const { controller, calls } = fixture();
  const first = await controller.execute({ action: 'open', endpoint: 'http://127.0.0.1:9444', url: 'https://example.com' });
  assert.equal(first.value.tab, 'owned');
  assert.equal(first.value.endpoint, 'http://127.0.0.1:9444');
  assert.equal(first.value.exec, 'allowed');
  assert.equal(calls[1].action, 'exec');
  assert.equal(calls[1].code, 'goto("https://example.com")');
  await controller.execute({ action: 'exec', tab: 'owned', code: 'js("1")', timeout: 20 });
  assert.equal(calls[2].target, 'owned'); assert.equal(calls[2].session, 'explicit-session');
  assert.equal(calls[2].endpoint, 'http://127.0.0.1:9444');
  assert.equal(calls[2].timeout, 20);
  await controller.execute({ action: 'state', tab: 'owned', max: 500 });
  assert.equal(calls[3].action, 'state'); assert.equal(calls[3].max, 500);
  assert.equal(calls[3].session, 'explicit-session');
  const image = await controller.execute({ action: 'screenshot', tab: 'owned', full: true, maxWidth: 800 });
  assert.equal(Buffer.from(image.image!, 'base64').toString(), 'JPG');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(calls[4].full, true); assert.equal(calls[4].maxWidth, 800);
  assert.equal((await controller.execute({ action: 'close', tab: 'owned' })).isError, false);
  assert.equal((await controller.execute({ action: 'exec', tab: 'owned', code: '1' })).isError, true);
  assert.equal((await controller.execute({ action: 'state', tab: 'owned' })).isError, true);
});

test('every result starts with a JSON header line holding status, tab and url', async () => {
  const { controller } = fixture(() => ok('hello\nworld', 'https://example.com/next'));
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'exec', tab: 'owned', code: 'print(1)' });
  const [header, ...body] = render(result.value).split('\n');
  assert.deepEqual(JSON.parse(header), { status: 'ok', tab: 'owned', url: 'https://example.com/next' });
  assert.equal(body.join('\n'), 'hello\nworld');
  const failure = await controller.execute({ action: 'exec', tab: 'nope', code: '1' });
  assert.equal(JSON.parse(render(failure.value).split('\n')[0]).status, 'invalid_input');
  assert.equal(JSON.parse(render((await controller.execute({})).value).split('\n')[0]).status, 'ok');
  const status = render((await controller.execute({})).value);
  assert.ok(status.split('\n').length > 1 && JSON.parse(status.split('\n')[1]).tabs.includes('owned'));
});

test('a cell that raised after an effect is reported uncertain, with the output printed so far and no replay', async () => {
  const { controller, calls } = fixture(() => ({ status: 'outcome_uncertain', output: '[ok] click [3]\n', error: 'TimeoutError: wait_for timed out', url: 'https://example.com/' }));
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'exec', tab: 'owned', code: 'click(3)\nwait_for("x")' });
  assert.equal(result.isError, true);
  assert.equal(result.value.status, 'outcome_uncertain');
  assert.match(render(result.value), /\[ok\] click \[3\]/);
  assert.match(render(result.value), /TimeoutError/);
  assert.equal(calls.length, 2, 'one open plus exactly one exec attempt');
});

test('uncertain transport failures are never retried; a killed worker says the REPL restarted', async () => {
  let calls = 0;
  const controller = new Controller(async request => {
    calls++;
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('Deadline exceeded; external outcome uncertain. Inspect before retrying.');
  });
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'exec', tab: 't', code: 'js("1")' });
  assert.equal(result.value.status, 'outcome_uncertain');
  assert.match(result.value.message, /REPL restarted, variables lost/);
  assert.equal(calls, 2);
  const python = new Controller(async request => {
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('boom');
  });
  await python.execute({ action: 'open' });
  assert.doesNotMatch((await python.execute({ action: 'exec', tab: 't', code: '1' })).value.message, /REPL restarted/, 'a plain error reply keeps the namespace');
});

test('failed open+goto preserves the created identity', async () => {
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
  const invalid: Args[] = [{ action: 'exec', tab: 'owned', code: '' }, { action: 'exec', tab: 'owned' }, { action: 'exec', tab: 'owned', code: 'x'.repeat(65537) },
    { action: 'exec', tab: 'owned', code: '1', timeout: 0 }, { action: 'exec', tab: 'owned', code: '1', timeout: 301 },
    { action: 'state', tab: 'owned', max: 0 }, { action: 'screenshot', tab: 'owned', maxWidth: 10 }];
  for (const args of invalid) assert.equal((await controller.execute(args)).value.status, 'invalid_input', JSON.stringify(args));
  const abort = new AbortController(); abort.abort();
  assert.equal((await controller.execute({ action: 'state', tab: 'owned' }, abort.signal)).value.status, 'invalid_input');
  assert.equal(calls.length, 1);
});

test('requests of one session queue in order instead of being refused, and never overlap', async () => {
  const order: string[] = [];
  let running = 0, overlap = false;
  const controller = new Controller(async request => {
    if (request.action === 'open') return { target: 'own', session: 's' };
    running++; overlap ||= running > 1;
    order.push(`start ${request.code}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push(`end ${request.code}`);
    running--;
    return ok(String(request.code));
  });
  await controller.execute({ action: 'open' });
  const results = await Promise.all(['a', 'b', 'c'].map(code => controller.execute({ action: 'exec', tab: 'own', code })));
  assert.deepEqual(results.map(r => r.value.status), ['ok', 'ok', 'ok']);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(overlap, false);
});

test('a request aborted while queued never dispatches and does not block the ones behind it', async () => {
  let release!: () => void, sent: unknown[] = [];
  const controller = new Controller(async request => {
    if (request.action === 'open') return { target: 'own', session: 's' };
    sent.push(request.code);
    if (request.code === 'first') await new Promise<void>(resolve => { release = resolve; });
    return ok(String(request.code));
  });
  await controller.execute({ action: 'open' });
  const first = controller.execute({ action: 'exec', tab: 'own', code: 'first' });
  const abort = new AbortController();
  const second = controller.execute({ action: 'exec', tab: 'own', code: 'second' }, abort.signal);
  const third = controller.execute({ action: 'exec', tab: 'own', code: 'third' });
  abort.abort();
  assert.equal((await second).value.status, 'invalid_input');
  release();
  assert.equal((await first).value.status, 'ok');
  assert.equal((await third).value.status, 'ok');
  assert.deepEqual(sent, ['first', 'third']);
});

test('output over 12000 characters is cut in the result and kept whole behind a receipt', async () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
  const { controller } = fixture(() => ok(big));
  await controller.execute({ action: 'open' });
  const result = await controller.execute({ action: 'exec', tab: 'owned', code: 'print(1)' });
  assert.ok(result.value.output.length <= 12100);
  assert.ok(result.value.output.includes('line 0') && result.value.output.includes('line 2999'), 'head and tail survive');
  assert.equal(result.value.totalChars, big.length);
  let current: any = (await controller.execute({ action: 'read', receipt: result.value.receipt, offset: 0, limit: 12000 })).value, text = current.preview;
  while (current.next) {
    current = (await controller.execute(current.next.arguments)).value;
    text += current.preview;
  }
  assert.equal(text, big);
  const receipt = result.value.receipt;
  assert.equal((await controller.execute({ action: 'read', receipt, offset: -1 })).isError, true);
  for (let i = 0; i < 8; i++) await controller.execute({ action: 'exec', tab: 'owned', code: 'print(2)' });
  assert.equal((await controller.execute({ action: 'read', receipt })).isError, true, 'only the latest 8 receipts are kept');
});

test('controllers cannot address another session tabs', async () => {
  const a = fixture(), b = fixture();
  await a.controller.execute({ action: 'open' });
  assert.equal((await b.controller.execute({ action: 'close', tab: 'owned' })).isError, true);
  assert.equal(b.calls.length, 0);
});

test('the page a tab shows rides in the header, and is never invented', async () => {
  const controller = new Controller(async request => {
    if (request.action === 'open') return { target: 'owned', session: 's' };
    return request.code === 'blank' ? { status: 'ok', output: '' } : ok('x', 'https://accounts.google.com/o/oauth2/consent');
  });
  await controller.execute({ action: 'open' });
  const shown = await controller.execute({ action: 'exec', tab: 'owned', code: 'x' });
  assert.equal(JSON.parse(render(shown.value).split('\n')[0]).url, 'https://accounts.google.com/o/oauth2/consent');
  const blank = await controller.execute({ action: 'exec', tab: 'owned', code: 'blank' });
  assert.equal(JSON.parse(render(blank.value).split('\n')[0]).url, undefined);
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
  assert.equal((await gone.execute({ action: 'state', tab: 't' })).value.status, 'invalid_input', 'the released handle is no longer addressable');
  const other = new Controller(async request => {
    if (request.action === 'open') return { target: 't', session: 's' };
    throw new Error('Deadline exceeded; external outcome uncertain.');
  });
  await other.execute({ action: 'open' });
  assert.equal((await other.execute({ action: 'close', tab: 't' })).value.status, 'outcome_uncertain');
  assert.deepEqual((await other.execute({})).value.tabs, ['t'], 'an uncertain close keeps the handle');
});

// 03/11: the isolated browser on :9333 died mid-session. Each later call waited 40 s, came back
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
  const dead = await controller.execute({ action: 'exec', tab: 't', code: 'js("document.title")' });
  assert.equal(dead.value.status, 'outcome_uncertain');
  assert.equal(dead.value.browser, 'unreachable');
  assert.match(dead.value.recovery, /http:\/\/127\.0\.0\.1:9444 does not answer.*npm run browser -- start/);
  assert.deepEqual(probed, ['http://127.0.0.1:9444']);
  const status = await controller.execute({ action: 'status' });
  assert.deepEqual(status.value.browsers, { 'http://127.0.0.1:9444': 'unreachable' });
  up = true;
  const slow = await controller.execute({ action: 'exec', tab: 't', code: 'js("document.title")' });
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
  const field = await controller.execute({ action: 'state', tab: 'owned', selector: 'body' } as any);
  assert.equal(field.value.status, 'invalid_input');
  assert.match(field.value.message, /unknown field "selector" for state; accepts: action, tab, max/i);
  const action = await controller.execute({ action: 'stat', tab: 'owned' } as any);
  assert.match(action.value.message, /unknown action "stat"; actions: status, open, exec, state, screenshot, close, read/i);
  assert.equal(calls.length, 1);
});

test('a cell that dies mid-run returns the output it had printed and reports it as progress', async () => {
  const controller = new Controller(async (request, _signal, progress) => {
    if (request.action === 'open') return { target: 't', session: 's' };
    progress?.('tab 1\n'); progress?.('tab 2\n');
    throw new Error('Aborted; external outcome uncertain');
  });
  await controller.execute({ action: 'open' });
  const seen: string[] = [];
  const result = await controller.execute({ action: 'exec', tab: 't', code: 'loop()' }, undefined, text => seen.push(text));
  assert.equal(result.value.status, 'outcome_uncertain');
  assert.equal(result.value.output, 'tab 1\ntab 2\n');
  assert.deepEqual(seen, ['tab 1\n', 'tab 1\ntab 2\n']);
});
