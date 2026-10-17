import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, viewerConfig } from '../server.mjs';

test('settings persist opening choice and remote connection privately, reset to local, and reject unsafe URLs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  const state = join(home, '.local/share/hypr-desktop');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'local-url'), 'http://127.0.0.1:17873/mcp');
  writeFileSync(join(state, 'token'), 'fixture-private-token');
  const tokenFile = join(home, 'hub-token');
  writeFileSync(tokenFile, 'fixture-remote-private-token', { mode: 0o600 });
  const runtime = await serve({ configHome: home, catalog: { read: async () => [], close() {} }, token: 'fixture',
    request: async () => Response.json({ desktops: [] }), t3: { close: async () => {} } });
  const call = (path, body) => fetch(runtime.url + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  try {
    const first = await call('api/settings');
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).settings, { autoOpen: true, fleet: { url: '', tokenFile: '' } });
    const saved = { autoOpen: false, fleet: { url: 'https://hub.example.com', tokenFile } };
    const response = await call('api/settings', saved);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).restartRequired, true);
    assert.deepEqual((await (await call('api/settings')).json()).settings, saved);
    assert.equal(viewerConfig(home).desktopURL, 'https://hub.example.com');
    const path = join(home, '.config/agent-desktops/settings.json');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!readFileSync(path, 'utf8').includes('fixture-remote-private-token'));
    for (const url of ['http://remote.example.com', 'https://user:password@hub.example.com', 'https://hub.example.com/?token=secret']) {
      const rejected = await call('api/settings', { ...saved, fleet: { ...saved.fleet, url } });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).rejected, true);
      assert.deepEqual((await (await call('api/settings')).json()).settings, saved);
    }
    const reset = { autoOpen: false, fleet: { url: '', tokenFile: '' } };
    assert.equal((await call('api/settings', reset)).status, 200);
    assert.equal(viewerConfig(home).desktopURL, 'http://127.0.0.1:17873');
    assert.equal((await (await call('api/settings', { ...reset, autoOpen: true })).json()).restartRequired, false);
    const large = await call('api/settings', { ...reset, padding: '字'.repeat(50000) });
    assert.equal(large.status, 413);
    assert.equal((await large.json()).rejected, true);
  } finally { await runtime.close(); rmSync(home, { recursive: true, force: true }); }
});
