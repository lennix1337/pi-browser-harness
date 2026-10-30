import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.');
const mutants = [
  ['ownership', 'src/controller.ts', 'if (!tab) throw new Error', 'if (false) throw new Error'],
  ['explicit-session', 'src/controller.ts', 'request = { action, ...tab, url:', 'request = { action, ...tab, session: undefined, url:'],
  ['endpoint', 'src/client.ts', "!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)", 'false'],
  ['no-replay', 'src/controller.ts', 'let result = await this.send(request, signal);', 'let result; try { result = await this.send(request, signal); } catch { result = await this.send(request, signal); }'],
  ['close-confirmation', 'src/controller.ts', 'if (result?.success !== true)', 'if (false)'],
  ['page-url', 'src/controller.ts', "if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)", 'if (false)'],
  ['concurrency', 'src/controller.ts', 'if (this.busy)', 'if (false)'],
  ['paging-offset', 'src/controller.ts', 'if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !Number.isInteger(limit) || limit < 1 || limit > 12000)', 'if (false)'],
];
for (const [name, file, before, after] of mutants) {
  const home = mkdtempSync(join(tmpdir(), 'pi-browser-mutant-'));
  try {
    for (const dir of ['src', 'test']) cpSync(join(root, dir), join(home, dir), { recursive: true });
    writeFileSync(join(home, 'package.json'), '{"type":"module"}');
    symlinkSync(join(root, 'node_modules'), join(home, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(home, file), source = readFileSync(path, 'utf8');
    if (source.split(before).length !== 2) throw new Error(name + ': ambiguous mutation anchor');
    writeFileSync(path, source.replace(before, after));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/controller.test.ts'], { cwd: home, encoding: 'utf8', timeout: 30000 });
    const output = result.stdout + result.stderr;
    if (result.status !== 1 || !/AssertionError|ERR_ASSERTION/.test(output)) throw new Error(name + ': not killed by assertion; ' + output.slice(-2000));
    console.log(name + ': killed by assertion');
  } finally { rmSync(home, { recursive: true, force: true }); }
}
console.log('8/8 boundary mutants killed');
