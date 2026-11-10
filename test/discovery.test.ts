import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './loader.ts';

test('fresh Pi settings discover the packaged tool/skill and execute native read-only status', async () => {
  const { tool, cleanup } = await load();
  try {
    const result = await tool.execute('status', {}, undefined, undefined, { sessionManager: { getSessionId: () => 'fresh-browser' } } as any);
    assert.equal(result.isError, false);
    assert.deepEqual((result.details as any).tabs, []);
    assert.equal((result.details as any).version, 'browser-harness 0.1.13');
  } finally { cleanup(); }
});

test('the tool definition stays compact: seven actions, one cell field, at most 1600 characters of description and schema', async () => {
  const { tool, cleanup } = await load();
  try {
    const schema = tool.parameters as any;
    const size = tool.description.length + JSON.stringify(schema).length;
    assert.ok(size <= 1600, `definition is ${size} characters`);
    assert.deepEqual(schema.properties.action.enum, ['status', 'open', 'exec', 'state', 'screenshot', 'close', 'read']);
    for (const gone of ['expression', 'node', 'text', 'filter', 'rules']) assert.equal(schema.properties[gone], undefined, gone);
    assert.ok(schema.properties.code && schema.properties.timeout);
  } finally { cleanup(); }
});

test('a tool result is a JSON header line followed by the details, and a removed action names its replacement', async () => {
  const { tool, cleanup } = await load();
  try {
    const ctx = { sessionManager: { getSessionId: () => 'header-browser' } } as any;
    const status = await tool.execute('status', {}, undefined, undefined, ctx);
    const text = (status.content[0] as { text: string }).text;
    assert.deepEqual(JSON.parse(text.split('\n')[0]), { status: 'ok' });
    const old = await tool.execute('old', { action: 'inspect', tab: 'x' } as any, undefined, undefined, ctx);
    assert.equal(old.isError, true);
    const message = (old.content[0] as { text: string }).text;
    assert.equal(JSON.parse(message.split('\n')[0]).status, 'invalid_input');
    assert.match(message, /inspect -> state; click\/type\/evaluate\/navigate -> exec/);
  } finally { cleanup(); }
});
