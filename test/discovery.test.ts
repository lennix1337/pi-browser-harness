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
