import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { serve } from '../server.mjs';

test('local desktops survive fleet outage, ended generations disappear, and remote tiles recover', async () => {
  let rows = [{ desktop: 1, generation: 'new', ready: true, held: true, owner: 'Local task' }];
  let mode = 'online';
  const upstream = createServer((req, res) => {
    if (req.url.startsWith('/local/')) return res.end(JSON.stringify({ desktops: rows }));
    if (mode === 'hang') return;
    if (mode === 'error') { res.statusCode = 503; return res.end(); }
    res.end(JSON.stringify({ hosts: [{ id: 'desktop-a', online: false }, { id: 'desktop-b', online: true }], desktops: [
      { host: 'desktop-a', desktop: 1, generation: 'old', ready: true },
      { host: 'desktop-b', desktop: 1, generation: 'remote', ready: true }
    ] }));
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const app = await serve({ fleet: true, desktopURL: url, token: 'fixture',
    localDesktop: { host: 'desktop-a', url: url + '/local', token: 'local-fixture' },
    catalog: { close() {} } });
  const read = async () => { const r = await fetch(app.url + 'api/desktops'); assert.equal(r.status, 200); return r.json(); };
  const expire = () => new Promise(r => setTimeout(r, 550));
  try {
    let data = await read();
    assert.deepEqual(data.desktops.filter(d => d.host === 'desktop-a').map(d => d.generation), ['new']);
    assert.ok(!data.warning.includes('desktop-a offline'));
    mode = 'hang'; await expire();
    const start = Date.now(); data = await read();
    assert.ok(Date.now() - start < 3000, 'unresponsive fleet cannot impose the old 25-second timeout');
    assert.equal(data.desktops.find(d => d.host === 'desktop-a').ready, true);
    assert.equal(data.desktops.find(d => d.host === 'desktop-b').reconnecting, true);
    assert.match(data.warning, /Fleet discovery unavailable/);
    mode = 'error'; rows = []; await expire(); data = await read();
    assert.equal(data.desktops.filter(d => d.host === 'desktop-a').length, 0, 'ended local lease cannot be resurrected');
    mode = 'online'; await expire(); data = await read();
    assert.equal(data.desktops.find(d => d.host === 'desktop-b').ready, true);
    assert.equal(data.desktops.filter(d => d.host === 'desktop-a').length, 0);
  } finally { await app.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
});
