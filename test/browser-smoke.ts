import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bridge } from '../src/client.ts';
import { BridgeSession } from '../src/bridge-worker.ts';
import { Controller } from '../src/controller.ts';
import { load } from './loader.ts';

const home = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'pi-browser-real-'));
process.env.PI_BROWSER_HARNESS_HOME = home;
const output = resolve(process.env.PI_BROWSER_HARNESS_EVIDENCE ?? '../local-validation/runs/browser-harness', 'smoke-' + Date.now());
mkdirSync(output, { recursive: true });
let writes = 0;
const received: { method?: string; url?: string; body: string; header: string | string[] | undefined; removed: string | string[] | undefined }[] = [];
const app = createServer((req, res) => {
  if (req.url?.startsWith('/capture')) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const record = { method: req.method, url: req.url, body, header: req.headers['x-edit'], removed: req.headers['x-remove'] };
      received.push(record);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/save') { writes++; res.end('Saved through browser'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/sentinel') { res.end('<title>Sentinel untouched</title><input id="draft" value="unsaved sentinel draft">'); return; }
  res.end('<title>Harness real flow</title><label>Name <input id="name" aria-label="Name"></label><button id="save" onclick="fetch(\'/save\',{method:\'POST\'}).then(r=>r.text()).then(text=>document.querySelector(\'#result\').textContent=text+\': \'+document.querySelector(\'#name\').value)">Save</button><p id="result" role="status">Waiting</p>');
});
await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
const port = (app.address() as any).port;
const base = 'http://127.0.0.1:' + port;
const launched = JSON.parse(execFileSync(process.execPath, ['scripts/browser.mjs', 'start', '--headless'], { encoding: 'utf8', env: process.env }));
const endpoint = launched.endpoint;
const { tool, cleanup } = await load();
let mainTab: string | undefined, sentinel: string | undefined, crashTab: string | undefined;
const crashBridge = new BridgeSession();
const crashController = new Controller((request, signal) => crashBridge.send(request, signal));
const observations: Record<string, unknown> = { endpoint, upstream: 'browser-harness 0.1.13', externalInference: 0 };
async function call(owner: string, args: any) {
  const result = await tool.execute('smoke-' + owner, args, undefined, undefined, { sessionManager: { getSessionId: () => owner } } as any);
  assert.equal(result.isError, false, JSON.stringify(result.details));
  return { ...result, details: result.details as Record<string, any> };
}
function waitFor(selector: string) {
  return `(async()=>{for(let i=0;i<100;i++){if(document.querySelector(${JSON.stringify(selector)}))return true;await new Promise(r=>setTimeout(r,30));}throw Error('DOM readiness not observed')})()`;
}
let primary: unknown;
try {
  sentinel = (await call('sentinel-owner', { action: 'open', endpoint, url: base + '/sentinel' })).details.tab;
  await call('sentinel-owner', { action: 'evaluate', tab: sentinel, expression: waitFor('#draft') });
  mainTab = (await call('task-owner', { action: 'open', endpoint, url: base + '/form' })).details.tab;
  assert.notEqual(mainTab, sentinel);
  await call('task-owner', { action: 'evaluate', tab: mainTab, expression: waitFor('#name') });
  const denied = await tool.execute('unowned', { action: 'close', tab: sentinel }, undefined, undefined, { sessionManager: { getSessionId: () => 'task-owner' } } as any);
  assert.equal(denied.isError, true);
  const inspected = (await call('task-owner', { action: 'inspect', tab: mainTab })).details;
  const snapshot = inspected.result;
  assert.equal(inspected.url, base + '/form', 'inspect reports the page the tab shows');
  const name = snapshot.nodes.find((node: any) => node.role === 'textbox' && node.name === 'Name');
  const save = snapshot.nodes.find((node: any) => node.role === 'button' && node.name === 'Save');
  assert.ok(name?.node); assert.ok(save?.node);
  assert.equal((await call('task-owner', { action: 'type', tab: mainTab, node: name.node, text: 'Pi browser harness' })).details.url, base + '/form', 'input reports its page');
  const field = (await call('task-owner', { action: 'evaluate', tab: mainTab, expression: 'document.querySelector("#name").value' })).details.result.value;
  assert.equal(field, 'Pi browser harness');
  await call('task-owner', { action: 'click', tab: mainTab, node: save.node });
  const visible = (await call('task-owner', { action: 'evaluate', tab: mainTab,
    expression: `(async()=>{for(let i=0;i<100;i++){const text=document.querySelector('#result').innerText;if(text.startsWith('Saved'))return text;await new Promise(r=>setTimeout(r,30));}throw Error('Result not observed')})()` })).details.result.value;
  assert.equal(visible, 'Saved through browser: Pi browser harness');
  assert.equal(writes, 1, 'exactly one server-side write, no replay');
  const network = (await call('task-owner', { action: 'network', tab: mainTab })).details;
  assert.equal(network.url, base + '/form', 'network reports the page the tab shows');
  assert.ok(network.result.requests.some((req: any) => req.method === 'POST' && req.url === base + '/save' && req.status === 200), 'network observes the owned tab POST');
  assert.ok(network.result.requests.every((req: any) => !String(req.url).endsWith('/sentinel')), 'network stays isolated to the owned tab');
  const filtered = (await call('task-owner', { action: 'network', tab: mainTab,
    filter: { method: 'POST', urlContains: '/save', resourceType: 'Fetch', status: 200 } })).details.result;
  assert.equal(filtered.totalRequests, 1, 'combined filters select the observed POST');
  assert.equal(filtered.requests[0].url, base + '/save');
  const absent = (await call('task-owner', { action: 'network', tab: mainTab,
    filter: { method: 'POST', urlContains: '/save', status: 409 } })).details.result;
  assert.equal(absent.totalRequests, 0, 'a mismatched status excludes the POST');
  const fetchCapture = (path = '/capture?token=fixture-secret', method = 'POST') => `fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'X-Remove':'old','Content-Type':'text/plain'},${method === 'GET' ? '' : "body:'original',"}}).then(r=>r.json())`;
  const rules = [{ match: { urlPattern: base + '/capture*', urlContains: '/capture', method: 'POST', resourceType: 'XHR' },
    edit: { url: base + '/capture-edited', method: 'PUT', headers: { 'X-Edit': 'changed', 'x-remove': null }, postData: 'Edited á body' }, maxMatches: 2 }];
  assert.equal((await call('task-owner', { action: 'intercept_start', tab: mainTab, rules })).details.result.active, true);
  const duplicate = await tool.execute('duplicate-editor', { action: 'intercept_start', tab: mainTab, rules }, undefined, undefined, { sessionManager: { getSessionId: () => 'task-owner' } } as any);
  assert.equal(duplicate.isError, true, 'cannot silently replace an active editor');
  const get = (await call('task-owner', { action: 'evaluate', tab: mainTab, expression: fetchCapture('/capture-other', 'GET') })).details.result.value;
  assert.equal(get.method, 'GET', 'method mismatch passes unchanged');
  const isolated = (await call('sentinel-owner', { action: 'evaluate', tab: sentinel, expression: fetchCapture() })).details.result.value;
  assert.equal(isolated.body, 'original', 'another tab is not intercepted');
  for (let i = 0; i < 2; i++) {
    const edited = (await call('task-owner', { action: 'evaluate', tab: mainTab, expression: fetchCapture() })).details.result.value;
    assert.deepEqual(edited, { method: 'PUT', url: '/capture-edited', body: 'Edited á body', header: 'changed' }, 'server receives edits, including Unicode and header deletion: ' + JSON.stringify((await call('task-owner', { action: 'intercept_status', tab: mainTab })).details.result));
  }
  const exhausted = (await call('task-owner', { action: 'evaluate', tab: mainTab, expression: fetchCapture() })).details.result.value;
  assert.equal(exhausted.body, 'original', 'bounded rules do not keep mutating saves');
  const journal = (await call('task-owner', { action: 'intercept_status', tab: mainTab })).details.result;
  assert.deepEqual(journal.matches, [2]);
  assert.equal(journal.events.length, 2);
  assert.ok(journal.events.every((event: any) => event.outcome === 'continued'));
  assert.ok(!JSON.stringify(journal).includes('fixture-secret') && !JSON.stringify(journal).includes('Edited á body'), 'no query/body values in interception journal');
  assert.equal((await call('task-owner', { action: 'intercept_stop', tab: mainTab })).details.result.active, false);
  // Cross-origin URLs must not forward this page's original authorization/cookies to another host.
  await call('task-owner', { action: 'intercept_start', tab: mainTab, rules: [{ match: { urlPattern: base + '/capture*' }, edit: { url: 'http://localhost:' + port + '/capture-leak' } }] });
  const skipped = (await call('task-owner', { action: 'evaluate', tab: mainTab, expression: fetchCapture() })).details.result.value;
  assert.equal(skipped.url, '/capture?token=fixture-secret');
  assert.equal((await call('task-owner', { action: 'intercept_status', tab: mainTab })).details.result.events[0].outcome, 'skipped_cross_origin');
  await call('task-owner', { action: 'intercept_stop', tab: mainTab });
  await call('task-owner', { action: 'intercept_start', tab: mainTab, rules });
  await call('task-owner', { action: 'intercept_stop', tab: mainTab });
  assert.equal((await call('task-owner', { action: 'evaluate', tab: mainTab, expression: fetchCapture() })).details.result.value.body, 'original', 'stop releases an unexhausted editor');

  // Exercise graceful EOF and hard worker loss with the same real CDP implementation.
  const owned = await crashController.execute({ action: 'open', endpoint, url: base + '/form' });
  assert.equal(owned.isError, false);
  crashTab = owned.value.tab;
  const crashCall = async (args: any, signal?: AbortSignal) => {
    const result = await crashController.execute({ tab: crashTab, ...args }, signal);
    assert.equal(result.isError, false, JSON.stringify(result.value));
    return result.value.result;
  };
  await crashCall({ action: 'evaluate', expression: waitFor('#name') });
  await crashCall({ action: 'intercept_start', rules });
  assert.equal((await crashCall({ action: 'evaluate', expression: fetchCapture() })).value.body, 'Edited á body');
  assert.deepEqual(await crashBridge.close(), { ended: 1, killed: 0 }, 'EOF cleans up the interceptor');
  assert.equal((await crashCall({ action: 'evaluate', expression: fetchCapture() })).value.body, 'original');
  await crashCall({ action: 'intercept_start', rules });
  const abort = new AbortController();
  const pending = crashController.execute({ action: 'evaluate', tab: crashTab, expression: 'new Promise(()=>{})' }, abort.signal);
  const killTimer = setTimeout(() => abort.abort(), 700);
  const uncertain = await pending;
  clearTimeout(killTimer);
  assert.equal(uncertain.value.status, 'outcome_uncertain');
  assert.equal((await crashCall({ action: 'evaluate', expression: fetchCapture() })).value.body, 'original', 'worker death releases interception without replay or hung requests');
  assert.equal((await crashCall({ action: 'intercept_status' })).active, false);
  assert.equal(received.length, 10, 'every fixture fetch reaches the server exactly once, never replayed');
  const image = await call('task-owner', { action: 'screenshot', tab: mainTab });
  const png = image.content.find((block: any) => block.type === 'image');
  assert.ok(png && png.type === 'image');
  const bytes = Buffer.from(png.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  writeFileSync(join(output, 'visible-result.png'), bytes);
  const unchanged = (await call('sentinel-owner', { action: 'evaluate', tab: sentinel,
    expression: '({title:document.title,url:location.href,draft:document.querySelector("#draft").value})' })).details.result.value;
  assert.deepEqual(unchanged, { title: 'Sentinel untouched', url: base + '/sentinel', draft: 'unsaved sentinel draft' });
  Object.assign(observations, { status: 'verified', mainTab, sentinel, field, visible, serverWrites: writes, screenshotBytes: bytes.length, sentinelUnchanged: true, unownedCloseRefused: true,
    interception: { methodHeaderBodyUrlEdits: true, boundedMatches: true, redactedJournal: true, crossOriginRefused: true, stop: true, eof: true, workerLoss: true, serverRequests: received.length } });
} catch (error) {
  primary = error;
  observations.status = "failed";
  observations.failure = String(error);
} finally {
  const failures: string[] = [];
  for (const [owner, tab] of [['task-owner', mainTab], ['sentinel-owner', sentinel]]) {
    if (tab) {
      try { await call(owner!, { action: 'close', tab }); }
      catch (error) { failures.push(String(error)); }
    }
  }
  if (crashTab) {
    try { assert.equal((await crashController.execute({ action: 'close', tab: crashTab })).isError, false); }
    catch (error) { failures.push('crash fixture tab: ' + error); }
  }
  try { await crashBridge.close(); }
  catch (error) { failures.push('crash fixture worker: ' + error); }
  try { await bridge({ action: 'shutdown', endpoint }); }
  catch (error) { failures.push('daemon cleanup: ' + error); }
  try { observations.browserCleanup = JSON.parse(execFileSync(process.execPath, ['scripts/browser.mjs', 'stop'], { encoding: 'utf8', env: process.env })); }
  catch (error) { failures.push('browser cleanup: ' + error); }
  cleanup();
  await new Promise<void>(resolve => app.close(() => resolve()));
  observations.cleanupFailures = failures;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(observations, null, 2));
  if (primary) throw new AggregateError([primary, ...failures], 'Browser flow failed; original and cleanup evidence retained in ' + output);
  assert.deepEqual(failures, [], 'owned resource cleanup');
}
console.log(JSON.stringify({ output, ...observations }));
