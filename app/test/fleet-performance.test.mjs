import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { serve } from '../server.mjs';
import { chromium } from 'playwright';

async function peer(label) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ generation: 'one', password: '', peer: label }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => {
    calls.push({ url: req.url, auth: req.headers.authorization });
    socket.send(label); socket.on('message', data => socket.send(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, async close() {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  } };
}
const inert = { catalog: { close() {} } };

test('same-host connection info and pixels stay local; remote streams retain fleet routing', async () => {
  const local = await peer('local'), fleet = await peer('fleet');
  const app = await serve({ ...inert, fleet: true, desktopURL: fleet.url, token: 'fleet-secret',
    localDesktop: { host: 'desktop-a', url: local.url, token: 'local-secret' } });
  try {
    for (const [host, expected] of [['desktop-a', local], ['desktop-b', fleet]]) {
      const info = await (await fetch(app.url + `api/desktops/${host}/1/connect?generation=one`)).json();
      assert.equal(info.peer, host === 'desktop-a' ? 'local' : 'fleet');
      const url = new URL(`stream/${host}/1?generation=one&profile=preview`, app.url); url.protocol = 'ws:';
      const socket = new WebSocket(url, { origin: new URL(app.url).origin });
      const [data] = await once(socket, 'message'); assert.equal(data.toString(), info.peer);
      socket.close(); await once(socket, 'close');
      assert.ok(expected.calls.every(call => call.auth === `Bearer ${info.peer}-secret`));
    }
    assert.ok(local.calls.every(call => !call.url.includes('/agents/')));
    assert.ok(fleet.calls.every(call => call.url.includes('/agents/')));
    assert.equal(local.calls.length, 2); assert.equal(fleet.calls.length, 2);
  } finally { await app.close(); await local.close(); await fleet.close(); }
});

test('discovery coalesces nearby readers and unchanged polls carry no JSON body', async () => {
  let reads = 0, status = 'Working';
  const app = await serve({ ...inert, fleet: true, desktopURL: 'https://fleet.example', token: 'test',
    request: async () => { reads++; return Response.json({ hosts: [{ id: 'desktop-a', online: true }], desktops: [
      { host: 'desktop-a', desktop: 1, generation: 'one', ready: true, agentStatus: status, idleMs: reads * 1000 }
    ] }); } });
  try {
    const first = await fetch(app.url + 'api/desktops'), etag = first.headers.get('etag');
    assert.ok(etag); await first.json();
    for (let i = 0; i < 4; i++) {
      const next = await fetch(app.url + 'api/desktops', { headers: { 'If-None-Match': etag } });
      assert.equal(next.status, 304); assert.equal(await next.text(), '');
    }
    assert.equal(reads, 1, 'separate windows share a fresh discovery snapshot');
    await new Promise(r => setTimeout(r, 550));
    const unchanged = await fetch(app.url + 'api/desktops', { headers: { 'If-None-Match': etag } });
    assert.equal(unchanged.status, 304, 'idle counters do not invalidate visible content');
    status = 'Waiting for you'; await new Promise(r => setTimeout(r, 550));
    const changed = await fetch(app.url + 'api/desktops', { headers: { 'If-None-Match': etag } });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).desktops[0].agentStatus, status);
  } finally { await app.close(); }
});

test('an idle overview does no DOM work and polls conditionally', async () => {
  const desks = Array.from({ length: 8 }, (_, n) => ({ host: 'fixture', desktop: n + 1, generation: 'one',
    ready: false, title: 'Task', threadId: 'thread', sourceHost: 'fixture', agentId: 'fixture/thread' }));
  const app = await serve({ ...inert, fleet: true, desktopURL: 'https://fleet.example', token: 'test',
    request: async () => Response.json({ hosts: [], desktops: desks }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let unchanged = 0;
    page.on('response', response => { if (response.status() === 304) unchanged++; });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8);
    await page.evaluate(() => {
      window.mutations = 0;
      new MutationObserver(records => { window.mutations += records.length; })
        .observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await page.waitForTimeout(2300);
    assert.equal(await page.evaluate(() => window.mutations), 0);
    assert.ok(unchanged > 0, 'the overview sends conditional polls');
  } finally { await browser.close(); await app.close(); }
});
