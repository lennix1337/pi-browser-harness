import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.');
const mutants = [
  ['ownership', 'src/controller.ts', 'if (!tab) throw new Error', 'if (false) throw new Error'],
  ['removed-action', 'src/controller.ts', 'if (removed.has(action)) throw', 'if (false) throw'],
  ['explicit-session', 'src/controller.ts', 'const request: Request = { action, ...tab };', 'const request: Request = { action, ...tab, session: undefined };'],
  ['endpoint', 'src/client.ts', "!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)", 'false'],
  ['no-replay', 'src/controller.ts', 'const result = await this.send(request, signal);', 'let result; try { result = await this.send(request, signal); } catch { result = await this.send(request, signal); }'],
  ['close-confirmation', 'src/controller.ts', 'if (result?.success !== true)', 'if (false)'],
  ['page-url', 'src/controller.ts', "if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)", 'if (false)'],
  ['fifo-queue', 'src/controller.ts', 'release = await this.turn(signal);', 'release = () => undefined;'],
  ['output-cut', 'src/controller.ts', 'if (output.length <= OUTPUT_VIEW) return { output };', 'if (true) return { output };'],
  ['worker-lost-notice', 'src/controller.ts', "dispatched && action === 'exec' && WORKER_LOST.test(text)", 'false'],
  ['paging-offset', 'src/controller.ts', 'if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !Number.isInteger(limit) || limit < 1 || limit > OUTPUT_VIEW)', 'if (false)'],
  ['worker-env-allowlist', 'src/bridge-worker.ts', 'ENV_ALLOWED.has(key.toUpperCase()) ||', 'true ||', 'test/bridge-worker.test.ts'],
  ['daemon-per-session', 'src/bridge-worker.ts', ', PI_BROWSER_HARNESS_DAEMON: daemon }', ' }', 'test/bridge-worker.test.ts'],
  ['shutdown-close', 'src/index.ts', 'await Promise.all([...bridges.values()].map(bridge => bridge.close()));', '', 'test/extension-lifecycle.test.ts'],
  ['idle-window', 'scripts/browser.mjs', "if (idle < idleMs) return { status: 'in_use', idleMs: idle };", '', 'test/browser.test.mjs'],
  ['only-root-inverted', 'src/index.ts', 'canonical(only) === canonical(root)', 'canonical(only) !== canonical(root)', 'test/only-root.test.ts'],
  ['only-root-removed', 'src/index.ts', 'if (!selected()) return;', '', 'test/only-root.test.ts'],
  ['idle-reads-count', 'src/index.ts', "const busy = params.action !== undefined && !['status', 'read'].includes(params.action);", 'const busy = true;', 'test/extension-lifecycle.test.ts'],
  ['cell-session-forced', 'python/repl.py', "The session is always the owned tab's, whatever the cell passes.\"\"\"", "\"\"\"; return self.helpers.cdp(method, session_id=session_id or self.session, **params)", 'test/repl_test.py'],
  ['target-refusal', 'python/repl.py', 'if method.split(".")[0] in ("Target", "Browser") and method != "Target.getTargetInfo":', 'if False:', 'test/repl_test.py'],
  ['import-refusal', 'python/repl.py', 'if name.split(".")[0] in BLOCKED_MODULES:', 'if False:', 'test/repl_test.py'],
  ['effect-is-uncertain', 'python/repl.py', '"outcome_uncertain" if self.effect else "error"', '"error"', 'test/repl_test.py'],
  ['reads-are-not-effects', 'python/repl.py', 'return READ_METHOD.match(method) is None', 'return True', 'test/repl_test.py'],
  ['dialog-policy', 'python/repl.py', 'accept = kind in ("alert", "beforeunload") or self.dialog_accept', 'accept = True', 'test/repl_test.py'],
  ['daemon-name', 'python/bridge.py', 'BU_NAME=daemon_name(),', 'BU_NAME="pi",', 'test/bridge_test.py'],
  ['redirect', 'python/bridge.py', 'raise ValueError("CDP redirects refused before following")', 'return None', 'test/bridge_test.py'],
  ['background-focus', 'python/bridge.py', 'cdp("Emulation.setFocusEmulationEnabled", session_id=session, enabled=True)', 'pass', 'test/bridge_test.py'],
  ['stale-session', 'python/bridge.py', 'self.require_live(target, session)', 'pass', 'test/bridge_test.py'],
  ['vendored-ax-pin', 'python/ax.py', 'Same names, defaults, waits and printed text as Pi.', 'Same names, defaults, waits and printed text as Pi!', 'test/vendor_test.py'],
  ['intercept-limit', 'python/interception.py', "self.counts[index] >= rule.get('maxMatches', 1)", 'False', 'test/interception_test.py'],
  ['intercept-origin', 'python/interception.py', "if 'url' in e and origin(e['url']) != origin(req['url']):", 'if False:', 'test/interception_test.py'],
  ['intercept-method', 'python/interception.py', "('method' in m and m['method'].upper() != req['method'].upper())", 'False', 'test/interception_test.py'],
  ['intercept-resource-type', 'python/interception.py', "('resourceType' in m and m['resourceType'] != event.get('resourceType'))", 'False', 'test/interception_test.py'],
  ['intercept-session', 'python/interception.py', "message.get('method') == 'Fetch.requestPaused' and message.get('sessionId') == self.session", "message.get('method') == 'Fetch.requestPaused'", 'test/interception_test.py'],
];
for (const [name, file, before, after, testFile = 'test/controller.test.ts'] of mutants) {
  const home = mkdtempSync(join(tmpdir(), 'pi-browser-mutant-'));
  try {
    for (const dir of ['src', 'test', 'scripts', 'python']) cpSync(join(root, dir), join(home, dir), { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"type":"module"}');
    symlinkSync(join(root, 'node_modules'), join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(home, file), source = readFileSync(path, 'utf8');
    if (source.split(before).length !== 2) throw new Error(name + ': ambiguous mutation anchor');
    writeFileSync(path, source.replace(before, after));
    const pythonTest = testFile.endsWith('.py');
    const result = pythonTest
      ? spawnSync(join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [testFile], { cwd: home, encoding: 'utf8', timeout: 30000 })
      : spawnSync(process.execPath, ['--import', 'tsx', '--test', testFile], { cwd: home, encoding: 'utf8', timeout: 30000 });
    const output = result.stdout + result.stderr;
    if (result.status !== 1 || !/AssertionError|ERR_ASSERTION/.test(output)) throw new Error(name + ': not killed by assertion; ' + output.slice(-2000));
    console.log(name + ': killed by assertion');
  } finally { rmSync(home, { recursive: true, force: true }); }
}
console.log(`${mutants.length}/${mutants.length} boundary mutants killed`);
