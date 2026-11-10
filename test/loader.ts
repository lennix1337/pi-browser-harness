import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

export async function load() {
  const home = mkdtempSync(join(tmpdir(), 'pi-browser-discovery-'));
  const agent = join(home, 'agent'), cwd = join(home, 'project');
  mkdirSync(agent); mkdirSync(cwd);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [fileURLToPath(new URL('../', import.meta.url))] }));
  const loader = new DefaultResourceLoader({ cwd, agentDir: agent, disabledBuiltinExtensions: ['mcp'], noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.ok(loader.getSkills().skills.some(s => s.name === 'pi-browser-harness'));
  const extension = loaded.extensions.find(e => e.tools.has('browser_harness'));
  assert.ok(extension);
  const shutdown = extension.handlers.get('session_shutdown')?.[0] as undefined | (() => Promise<void>);
  return { tool: extension.tools.get('browser_harness')!.definition, shutdown, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
