import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { start } from '../scripts/browser.mjs';

// What `start` leaves behind, with real processes standing in for the browser. Kept apart from browser.test.mjs
// because these tests wait on processes, and the mutation harness runs a whole file per mutant.
const tree = fileURLToPath(new URL('./fixtures/process-tree.mjs', import.meta.url));
const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
/** Starts the fixture tree the way the launcher starts a browser (detached); resolves once parent and child run. */
async function launchTree(dir) {
  const file = join(dir, 'pids');
  const root = spawn(process.execPath, [tree, file], { detached: true, stdio: 'ignore', windowsHide: true });
  for (let waited = 0; waited < 20_000; waited += 25) {
    const pids = existsSync(file) ? /^parent (\d+)\nchild (\d+)\n$/.exec(readFileSync(file, 'utf8')) : null;
    if (pids) return { root, parent: Number(pids[1]), child: Number(pids[2]) };
    await delay(25);
  }
  root.kill('SIGKILL');
  throw new Error('fixture tree did not start');
}
/** Ends whatever a test left of its own fixture processes, and removes its folder; runs even when an assertion failed. */
function reap(dir, ...pids) {
  for (const pid of pids.filter(pid => pid !== undefined)) {
    try { process.kill(pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; } // ESRCH: the test already ended it
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

test('a launch that becomes ready is recorded and left running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-start-'));
  const ready = fileURLToPath(new URL('./fixtures/ready-browser.mjs', import.meta.url));
  let browser;
  try {
    const launch = profile => (browser = spawn(process.execPath, [ready, profile], { detached: true, stdio: 'ignore', windowsHide: true }));
    const result = await start(true, { dir, launch, kill: () => assert.fail('a browser that became ready is never ended') });
    const saved = JSON.parse(readFileSync(join(dir, 'browser.json'), 'utf8'));
    assert.equal(result.status, 'started');
    assert.deepEqual([saved.endpoint, saved.profile, saved.pid], [result.endpoint, result.profile, browser.pid]);
    assert.match(saved.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/stand-in$/);
    assert.equal(running(browser.pid), true);
  } finally { reap(dir, browser?.pid); }
});
test('a launch that never becomes ready ends the browser it started, children included, and leaves no record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-start-'));
  let launched;
  try {
    const failure = await start(true, { dir, readyMs: 50, launch: async () => (launched = await launchTree(dir)).root }).catch(error => error);
    assert.ok(failure instanceof Error, 'a browser that never opens its debugging port is a failed start');
    assert.equal(running(launched.parent), false, 'the process start launched is gone');
    assert.equal(running(launched.child), false, 'and so is the child that process had started');
    assert.equal(existsSync(join(dir, 'browser.json')), false, 'a failed start records no browser');
    assert.match(failure.message, /^Browser readiness timed out; .*was closed; start can be run again\.$/);
    assert.ok(failure.message.includes(`(pid ${launched.parent})`), failure.message);
  } finally { reap(dir, launched?.parent, launched?.child); }
});
test('the fixture child outlives a parent-only kill, so only ending the whole tree passes the test above', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-start-'));
  let launched;
  try {
    launched = await launchTree(dir);
    process.kill(launched.parent, 'SIGKILL');
    for (let waited = 0; running(launched.parent) && waited < 5000; waited += 25) await delay(25);
    assert.equal(running(launched.parent), false);
    await delay(500); // room for a shared job or console to take the child down with its parent, if one did
    assert.equal(running(launched.child), true, 'only the parent was killed');
  } finally { reap(dir, launched?.parent, launched?.child); }
});
test('a failed start whose browser cannot be confirmed closed says so and names the pid, never that it was closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-start-'));
  let launched;
  try {
    // A kill that reports success and ends nothing: what is still running decides the message, not the report.
    // Nothing is dying here, so the wait for it is cut short; the real kill above keeps the production window.
    const stuck = { dir, readyMs: 50, confirmMs: 100, launch: async () => (launched = await launchTree(dir)).root, kill: () => true };
    const failure = await start(true, stuck).catch(error => error);
    assert.ok(failure instanceof Error);
    assert.equal(running(launched.parent), true, 'the browser is in fact still running');
    assert.match(failure.message, /^Browser readiness timed out; .*could not be confirmed closed; inspect pid \d+ before starting again\.$/);
    assert.ok(failure.message.includes(`inspect pid ${launched.parent} `), failure.message);
    assert.equal(existsSync(join(dir, 'browser.json')), false);
  } finally { reap(dir, launched?.parent, launched?.child); }
});
test('a browser that ended by itself or never started is reported as that, and nothing is killed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-start-'));
  const untouched = { dir, kill: () => assert.fail('there is no running process to end') };
  try {
    const quits = () => spawn(process.execPath, ['-e', 'process.exit(7)'], { detached: true, stdio: 'ignore', windowsHide: true });
    await assert.rejects(start(true, { ...untouched, launch: quits }), /Browser exited before readiness: 7; the browser process this start opened \(pid \d+\) had already exited\.$/);
    const missing = () => spawn(join(dir, 'no-such-browser'), [], { detached: true, stdio: 'ignore', windowsHide: true });
    await assert.rejects(start(true, { ...untouched, launch: missing }), /ENOENT; no browser process was started\.$/);
    assert.equal(existsSync(join(dir, 'browser.json')), false);
  } finally { reap(dir); }
});
