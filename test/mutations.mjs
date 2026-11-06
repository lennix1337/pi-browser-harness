import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.');
const mutants = [
  ['ownership', 'src/controller.ts', 'if (!tab) throw new Error', 'if (false) throw new Error'],
  ['intercept-validation', 'src/controller.ts', "if (action === 'intercept_start') validateRules(args.rules);", ''],
  ['intercept-limit', 'python/interception.py', "self.counts[index] >= rule.get('maxMatches', 1)", 'False', 'test/interception_test.py'],
  ['intercept-origin', 'python/interception.py', "if 'url' in e and origin(e['url']) != origin(req['url']):", 'if False:', 'test/interception_test.py'],
  ['intercept-method', 'python/interception.py', "('method' in m and m['method'].upper() != req['method'].upper())", 'False', 'test/interception_test.py'],
  ['intercept-resource-type', 'python/interception.py', "('resourceType' in m and m['resourceType'] != event.get('resourceType'))", 'False', 'test/interception_test.py'],
  ['intercept-session', 'python/interception.py', "message.get('method') == 'Fetch.requestPaused' and message.get('sessionId') == self.session", "message.get('method') == 'Fetch.requestPaused'", 'test/interception_test.py'],
  ['explicit-session', 'src/controller.ts', 'request = { action, ...tab, url:', 'request = { action, ...tab, session: undefined, url:'],
  ['endpoint', 'src/client.ts', "!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)", 'false'],
  ['no-replay', 'src/controller.ts', 'let result = await this.send(request, signal);', 'let result; try { result = await this.send(request, signal); } catch { result = await this.send(request, signal); }'],
  ['close-confirmation', 'src/controller.ts', 'if (result?.success !== true)', 'if (false)'],
  ['page-url', 'src/controller.ts', "if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)", 'if (false)'],
  ['concurrency', 'src/controller.ts', 'if (this.busy)', 'if (false)'],
  ['paging-offset', 'src/controller.ts', 'if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !Number.isInteger(limit) || limit < 1 || limit > 12000)', 'if (false)'],
  ['shutdown-close', 'src/index.ts', 'await Promise.all([...bridges.values()].map(bridge => bridge.close()));', '', 'test/extension-lifecycle.test.ts'],
  ['idle-window', 'scripts/browser.mjs', "if (idle < idleMs) return { status: 'in_use', idleMs: idle };", '', 'test/browser.test.mjs'],
  ['idle-reads-count', 'src/index.ts', "const busy = params.action !== undefined && !['status', 'read'].includes(params.action);", 'const busy = true;', 'test/extension-lifecycle.test.ts'],
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
