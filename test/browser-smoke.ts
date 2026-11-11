import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const { tool, shutdown, cleanup } = await load();
let mainTab: string | undefined, sentinel: string | undefined, crashTab: string | undefined;
const crashBridge = new BridgeSession();
const crashController = new Controller((request, signal) => crashBridge.send(request, signal));
const observations: Record<string, unknown> = { endpoint, upstream: 'browser-harness 0.1.13', externalInference: 0 };
async function call(who: string, args: any) {
  const result = await tool.execute('smoke-' + who, args, undefined, undefined, owner(who));
  assert.equal(result.isError, false, JSON.stringify(result.details));
  return { ...result, details: result.details as Record<string, any> };
}
function owner(id: string) { return { sessionManager: { getSessionId: () => id } } as any; }
const text = (result: { content: any[] }) => (result.content[0] as { text: string }).text;
/** Run one cell on an owned tab; every successful reply starts with the JSON header. */
async function cell(who: string, tab: string | undefined, code: string, timeout?: number) {
  const reply = await call(who, { action: 'exec', tab, code, ...(timeout ? { timeout } : {}) });
  const [header, ...body] = text(reply).split('\n');
  assert.equal(JSON.parse(header).status, 'ok');
  return { header: JSON.parse(header), output: body.join('\n') };
}
const nodeId = (listing: string, role: string, name: string) => Number(new RegExp(`\\[(\\d+)\\] ${role} "${name}"`).exec(listing)?.[1]);
const fetchCapture = (path = '/capture?token=fixture-secret', method = 'POST') => `fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'X-Remove':'old','Content-Type':'text/plain'},${method === 'GET' ? '' : "body:'original',"}}).then(r=>r.json())`;
const rules = () => `[{"match": {"urlPattern": "${base}/capture*", "urlContains": "/capture", "method": "POST", "resourceType": "XHR"},
  "edit": {"url": "${base}/capture-edited", "method": "PUT", "headers": {"X-Edit": "changed", "x-remove": None}, "postData": "Edited á body"}, "maxMatches": 2}]`;
const jsonOf = (expression: string) => `import json\nprint(json.dumps(js(${JSON.stringify(expression)})))`;
let primary: unknown;
try {
  sentinel = (await call('sentinel-owner', { action: 'open', endpoint, url: base + '/sentinel' })).details.tab;
  await cell('sentinel-owner', sentinel, 'wait_for(lambda: js("!!document.querySelector(\'#draft\')"))');
  const opened = await call('task-owner', { action: 'open', endpoint, url: base + '/form' });
  mainTab = opened.details.tab;
  assert.equal(opened.details.exec, 'allowed');
  assert.notEqual(mainTab, sentinel);
  assert.equal(JSON.parse(text(opened).split('\n')[0]).url, base + '/form', 'the header names the page the tab shows');
  const denied = await tool.execute('unowned', { action: 'close', tab: sentinel }, undefined, undefined, owner('task-owner'));
  assert.equal(denied.isError, true);
  const removed = await tool.execute('old', { action: 'inspect', tab: mainTab }, undefined, undefined, owner('task-owner'));
  assert.match(text(removed), /inspect -> state/);

  // The cell loop: state -> act by id -> the acting cell prints the new state; the server confirms the write.
  const listing = text(await call('task-owner', { action: 'state', tab: mainTab }));
  assert.equal(JSON.parse(listing.split('\n')[0]).url, base + '/form');
  const name = nodeId(listing, 'textbox', 'Name'), save = nodeId(listing, 'button', 'Save');
  assert.ok(name && save, listing);
  const typed = await cell('task-owner', mainTab, `type(${name}, 'Pi browser harness')`);
  assert.match(typed.output, /\[ok\] type/, 'an acting cell appends its result');
  assert.equal((await cell('task-owner', mainTab, 'js("document.querySelector(\'#name\').value")')).output.trim(), "'Pi browser harness'", 'the last expression is echoed');
  const clicked = await cell('task-owner', mainTab, `click(${save})\nwait_for("Saved through browser")\njs("document.querySelector('#result').innerText")`);
  assert.match(clicked.output, /'Saved through browser: Pi browser harness'/);
  assert.equal(writes, 1, 'exactly one server-side write, no replay');

  // The namespace persists per tab across cells, and never leaks to another tab.
  await cell('task-owner', mainTab, 'kept = {"n": 41}');
  assert.equal((await cell('task-owner', mainTab, 'kept["n"] + 1')).output.trim(), '42');
  const otherTab = (await call('task-owner', { action: 'open', endpoint })).details.tab;
  const missing = await tool.execute('ns', { action: 'exec', tab: otherTab, code: 'kept' }, undefined, undefined, owner('task-owner'));
  assert.equal(missing.isError, true);
  assert.match(text(missing), /NameError/);
  await call('task-owner', { action: 'close', tab: otherTab });

  // Network observation is scoped to the owned tab.
  const seen = await cell('task-owner', mainTab, 'print([(r["method"], r["url"], r["status"]) for r in network(method="POST", urlContains="/save", status=200)])');
  assert.ok(seen.output.includes(`('POST', '${base}/save', 200)`), seen.output + (await cell('task-owner', mainTab, 'print(network())')).output);
  assert.equal((await cell('task-owner', mainTab, 'print(len(network(urlContains="/sentinel")))')).output.trim(), '0', 'network stays isolated to the owned tab');

  // A cell cannot reach beyond the tab: the guard refuses before anything runs.
  for (const code of ['import socket', 'cdp("Target.createTarget", url="about:blank")', 'from browser_harness import helpers']) {
    const refused = await tool.execute('guard', { action: 'exec', tab: mainTab, code }, undefined, undefined, owner('task-owner'));
    assert.equal(refused.isError, true, code);
    assert.match(text(refused), /refused/i, code);
  }

  // Dialogs: confirm() is dismissed and reported, in seconds, instead of hanging the cell.
  const started = Date.now();
  const dialog = await cell('task-owner', mainTab, `print(js("confirm('sure?')"))`);
  assert.match(dialog.output, /\[dialog confirm\] "sure\?" \(dismissed\)/);
  assert.match(dialog.output, /False/);
  assert.ok(Date.now() - started < 5000, `dialog resolved in ${Date.now() - started} ms`);
  const accepted = await cell('task-owner', mainTab, `dialog(accept=True)\nprint(js("confirm('go?')"))`);
  assert.match(accepted.output, /\(accepted\)/);
  assert.match(accepted.output, /True/);
  const alerted = await cell('task-owner', mainTab, `js("alert('hi')")`);
  assert.match(alerted.output, /\[dialog alert\] "hi" \(accepted\)/);

  // Request editing from inside a cell: edits reach the server; the journal holds no values.
  const run = async (who: string, tab: string | undefined, expression: string) => JSON.parse((await cell(who, tab, jsonOf(expression))).output.trim());
  assert.match((await cell('task-owner', mainTab, `print(intercept(${rules()})["active"])`)).output, /True/);
  const duplicate = await tool.execute('duplicate-editor', { action: 'exec', tab: mainTab, code: `intercept(${rules()})` }, undefined, undefined, owner('task-owner'));
  assert.equal(duplicate.isError, true, 'cannot silently replace an active editor');
  assert.equal((await run('task-owner', mainTab, fetchCapture('/capture-other', 'GET'))).method, 'GET', 'method mismatch passes unchanged');
  assert.equal((await run('sentinel-owner', sentinel!, fetchCapture())).body, 'original', 'another tab is not intercepted');
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await run('task-owner', mainTab, fetchCapture()), { method: 'PUT', url: '/capture-edited', body: 'Edited á body', header: 'changed' }, 'server receives edits, including Unicode and header deletion');
  }
  assert.equal((await run('task-owner', mainTab, fetchCapture())).body, 'original', 'bounded rules do not keep mutating saves');
  const journal = JSON.parse((await cell('task-owner', mainTab, 'import json\nprint(json.dumps(intercept_status()))')).output.trim());
  assert.deepEqual(journal.matches, [2]);
  assert.ok(journal.events.every((event: any) => event.outcome === 'continued'));
  assert.ok(!JSON.stringify(journal).includes('fixture-secret') && !JSON.stringify(journal).includes('Edited á body'), 'no query/body values in the journal');
  assert.match((await cell('task-owner', mainTab, 'print(intercept_stop()["active"])')).output, /False/);
  await cell('task-owner', mainTab, `intercept([{"match": {"urlPattern": "${base}/capture*"}, "edit": {"url": "http://localhost:${port}/capture-leak"}}])`);
  assert.equal((await run('task-owner', mainTab, fetchCapture())).url, '/capture?token=fixture-secret', 'cross-origin edits are skipped');
  await cell('task-owner', mainTab, 'intercept_stop()');
  await cell('task-owner', mainTab, `intercept(${rules()})`);
  await cell('task-owner', mainTab, 'intercept_stop()');
  assert.equal((await run('task-owner', mainTab, fetchCapture())).body, 'original', 'stop releases an unexhausted editor');

  // A cell past its deadline kills the REPL: outcome uncertain, variables lost, tab still owned and usable.
  const hung = await tool.execute('hang', { action: 'exec', tab: mainTab, code: 'while True:\n    pass', timeout: 1 }, undefined, undefined, owner('task-owner'));
  assert.equal(hung.isError, true);
  assert.equal((hung.details as any).status, 'outcome_uncertain');
  assert.match(text(hung), /REPL restarted, variables lost/);
  const lost = await tool.execute('lost', { action: 'exec', tab: mainTab, code: 'kept', timeout: 20 }, undefined, undefined, owner('task-owner'));
  assert.match(text(lost), /NameError/);
  assert.equal((await cell('task-owner', mainTab, 'js("document.querySelector(\'#result\').innerText")')).output.trim(), "'Saved through browser: Pi browser harness'", 'the tab survived the REPL restart');

  // Exercise graceful EOF and hard worker loss with the same real CDP implementation.
  const owned = await crashController.execute({ action: 'open', endpoint, url: base + '/form' });
  assert.equal(owned.isError, false);
  crashTab = owned.value.tab;
  const crashCell = async (code: string) => {
    const result = await crashController.execute({ action: 'exec', tab: crashTab, code });
    assert.equal(result.isError, false, JSON.stringify(result.value));
    return result.value.output as string;
  };
  const crashFetch = async () => JSON.parse(await crashCell(jsonOf(fetchCapture())));
  await crashCell(`intercept(${rules()})`);
  assert.equal((await crashFetch()).body, 'Edited á body');
  const abort = new AbortController();
  const pending = crashController.execute({ action: 'exec', tab: crashTab, code: 'js("new Promise(()=>{})")', timeout: 60 }, abort.signal);
  const killTimer = setTimeout(() => abort.abort(), 700);
  const uncertain = await pending;
  clearTimeout(killTimer);
  assert.equal(uncertain.value.status, 'outcome_uncertain');
  assert.equal((await crashFetch()).body, 'original', 'worker death releases interception without replay or hung requests');
  assert.match(await crashCell('print(intercept_status()["active"])'), /False/);
  assert.equal(received.length, 9, 'every fixture fetch reaches the server exactly once, never replayed');
  // A graceful end (EOF) also ends the worker's daemon, and with it the tab's CDP session: named plainly, and the tab can still be closed.
  assert.deepEqual(await crashBridge.close(), { ended: 1, killed: 0 });
  const ended = await crashController.execute({ action: 'exec', tab: crashTab, code: '1' });
  assert.equal(ended.isError, true);
  assert.match(JSON.stringify(ended.value), /ended with its bridge worker/);
  assert.equal((await crashController.execute({ action: 'close', tab: crashTab })).isError, false);
  crashTab = undefined;

  const image = await call('task-owner', { action: 'screenshot', tab: mainTab });
  const jpeg = image.content.find((block: any) => block.type === 'image');
  assert.ok(jpeg && jpeg.type === 'image');
  assert.equal(jpeg.mimeType, 'image/jpeg');
  const bytes = Buffer.from(jpeg.data, 'base64');
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  writeFileSync(join(output, 'visible-result.jpg'), bytes);
  const unchanged = await run('sentinel-owner', sentinel!, '({title:document.title,url:location.href,draft:document.querySelector("#draft").value})');
  assert.deepEqual(unchanged, { title: 'Sentinel untouched', url: base + '/sentinel', draft: 'unsaved sentinel draft' });
  Object.assign(observations, { status: 'verified', mainTab, sentinel, serverWrites: writes, screenshotBytes: bytes.length, sentinelUnchanged: true, unownedCloseRefused: true,
    repl: { namespacePersists: true, perTab: true, guard: true, dialogs: true, deadlineRestart: true },
    interception: { methodHeaderBodyUrlEdits: true, boundedMatches: true, redactedJournal: true, crossOriginRefused: true, stop: true, eof: true, workerLoss: true, serverRequests: received.length } });
} catch (error) {
  primary = error;
  observations.status = "failed";
  observations.failure = String(error);
} finally {
  const failures: string[] = [];
  for (const [who, tab] of [['task-owner', mainTab], ['sentinel-owner', sentinel]]) {
    if (tab) {
      try { await call(who!, { action: 'close', tab }); }
      catch (error) { failures.push(String(error)); }
    }
  }
  if (crashTab) {
    try { assert.equal((await crashController.execute({ action: 'close', tab: crashTab })).isError, false); }
    catch (error) { failures.push('crash fixture tab: ' + error); }
  }
  try { await crashBridge.close(); }
  catch (error) { failures.push('crash fixture worker: ' + error); }
  try { await shutdown?.(); }
  catch (error) { failures.push('session shutdown: ' + error); }
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
