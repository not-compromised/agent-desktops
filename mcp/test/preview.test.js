import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPreview } from '../preview/server.js';

test('preview exposes display metadata and refuses live transports', async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'desktop-preview-'));
  await writeFile(path.join(data, 'desktop.png'), Buffer.from('capture'));
  await writeFile(path.join(data, 'fleet.json'), JSON.stringify({ hosts: [{ id: 'fixture', online: true, token: 'secret' }], desktops: [
    { host: 'fixture', desktop: 1, generation: 'live-generation', agentId: 'live-thread-id', title: 'Task', password: 'secret' },
    { host: 'fixture', desktop: 2, generation: 'other-live-generation', agentId: 'live-thread-id', title: 'Task' }
  ] }));
  const app = await createPreview(data);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(data, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fleet = await (await fetch(base + '/api/desktops')).json();
  assert.equal(fleet.desktops[0].agentId, fleet.desktops[1].agentId);
  assert.doesNotMatch(JSON.stringify(fleet), /secret|live-thread|live-generation/);
  const connect = await fetch(base + '/api/desktops/fixture/1/connect?generation=preview-0');
  assert.deepEqual(await connect.json(), { generation: 'preview-0', password: '' });
  const sound = '/api/desktops/fixture/1/audio';
  assert.equal((await (await fetch(base + sound + '?generation=preview-0')).json()).muted, true);
  const unmute = await fetch(base + sound, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({generation:'preview-0',muted:false}) });
  assert.deepEqual(await unmute.json(), {available:true,muted:false,streams:0});
  assert.equal((await (await fetch(base + '/api/desktops/fixture/2/audio?generation=preview-1')).json()).muted, true);
  assert.equal((await fetch(base + '/view/fixture/1')).status, 404);
  assert.match(await (await fetch(base)).text(), /Preview · inert desktop/);
  assert.match(await (await fetch(base + '/novnc/core/rfb.js')).text(), /sendKey\(\) \{\}/);
  for (const resource of ['/shared/chat.js', '/shared/api.js', '/vendor/marked.js', '/vendor/purify.js'])
    assert.equal((await fetch(base + resource)).status, 200, resource);
});
