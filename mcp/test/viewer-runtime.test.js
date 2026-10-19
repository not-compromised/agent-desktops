import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';
import { installViewer } from '../lib/viewer.js';
import { Settings } from '../lib/settings.js';
import { Leases } from '../lib/leases.js';
import { createLifecycle } from '../lib/lifecycle.js';

const token = 'test-only-peer-token-at-least-32-characters';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const leases = new Leases();
  const lease = leases.claim('test task');
  let acquired = 0, released = 0;
  const tcp = createServer(socket => { socket.write('RFB 003.008\n'); socket.on('error', () => {}); socket.on('data', data => socket.write(data)); });
  tcp.listen(0, '127.0.0.1'); await new Promise(resolve => tcp.once('listening', resolve));
  const stopped = [];
  const nest = { ready: async () => true, info: () => ({ password: 'vnc-only-password' }), stop: async n => stopped.push(n) };
  const settings = new Settings();
  const lifecycle = createLifecycle({ leases, nest, settings });
  const streams = { async acquire(n, generation) {
    assert.equal(n, lease.desktop); assert.equal(generation, lease.generation); acquired++;
    return { endpoint: { host: '127.0.0.1', port: tcp.address().port }, release() { released++; } };
  }, async close() {} };
  const app = express(), origins = [];
  const attach = installViewer(app, { host: 'hub', leases, nest, lifecycle, settings, token, origins, streams, wayland: false, catalog: { read: async () => [], close() {} }, t3: { async close() {} }, ...options });
  const listener = app.listen(0, '127.0.0.1'); attach(listener);
  await new Promise(resolve => listener.once('listening', resolve));
  const base = `http://127.0.0.1:${listener.address().port}`; origins.push(base);
  const clients = [];
  t.after(async () => { await attach.close(); clients.forEach(ws => ws.terminate()); await wait(20); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); await new Promise(resolve => tcp.close(resolve)); });
  const socket = (path, headers = { Origin: base }) => { const ws = new WebSocket(base.replace('http:', 'ws:') + path, { headers }); clients.push(ws); ws.on('error', () => {}); return ws; };
  const rejected = (path, headers) => new Promise((resolve, reject) => {
    const ws = socket(path, headers);
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
    ws.once('open', () => reject(new Error('unexpected admission')));
  });
  return { base, leases, lease, socket, rejected, stopped, counts: () => ({ acquired, released }) };
}

test('human cleanup requires bearer auth and exact generation; passwordless viewer cannot close desktops', async t => {
  const f = await fixture(t);
  const path = f.base + `/hypr-desktop/viewer/${f.lease.desktop}/close`;
  const post = (generation, auth = token) => fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ generation }) });
  assert.equal((await post(f.lease.generation, 'wrong')).status, 401);
  assert.equal((await post('stale')).status, 404);
  assert.deepEqual(f.stopped, []);
  assert.equal((await fetch(f.base + '/api/desktops/hub/1/close', { method: 'POST' })).status, 404);
  assert.equal((await post(f.lease.generation)).status, 200);
  assert.deepEqual(f.stopped, [f.lease.desktop]);
  assert.equal(f.leases.byHandle.has(f.lease.handle), false);
});

test('sound writes require JSON and same-origin, peer auth, and a live generation', async t => {
  const f = await fixture(t);
  const path = '/api/desktops/hub/1/audio';
  const body = JSON.stringify({ generation: f.lease.generation, muted: true });
  assert.equal((await fetch(f.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(f.base + path, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'text/plain' }, body })).status, 415);
  const post = payload => fetch(f.base + path, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await post({ muted: true })).status, 404);
  assert.equal((await post({ generation: f.lease.generation, muted: 'true' })).status, 400);
  const result = await (await post({ generation: f.lease.generation, muted: true })).json();
  assert.equal(result.available, false);
  assert.equal((await fetch(f.base + '/viewer/1/audio?generation=' + f.lease.generation)).status, 401);
  f.leases.release(f.lease.handle);
  assert.equal((await post({ generation: f.lease.generation, muted: true })).status, 404);
});


test('native fleet sound relay authenticates and forwards exact host, generation, and mute choice', async t => {
  const calls = [], peerApp = express();
  peerApp.use(express.json());
  peerApp.all('/hypr-desktop/viewer/2/audio', (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    calls.push({ method: req.method, generation: req.query.generation, body: req.body });
    res.json({ available: true, muted: req.body?.muted ?? true, streams: 1 });
  });
  const peer = peerApp.listen(0, '127.0.0.1'); await new Promise(r => peer.once('listening', r));
  t.after(async () => { peer.closeAllConnections(); await new Promise(r => peer.close(r)); });
  const f = await fixture(t, { agents: true, peers: [{ id: 'desktop-a', url: `http://127.0.0.1:${peer.address().port}`, token }] });
  const path = '/hypr-desktop/viewer/agents/audio/desktop-a/2';
  assert.equal((await fetch(f.base + path)).status, 401);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(f.base + path + '?generation=game-session', { headers })).status, 200);
  const changed = await fetch(f.base + path, { method: 'POST', headers, body: JSON.stringify({ generation: 'game-session', muted: false }) });
  assert.equal((await changed.json()).muted, false);
  assert.deepEqual(calls, [{method:'GET',generation:'game-session',body:undefined},{method:'POST',generation:undefined,body:{generation:'game-session',muted:false}}]);
  assert.equal((await fetch(f.base + path.replace('desktop-a', 'unknown'), { headers })).status, 404);
});

test('settings and timers require bearer auth and exact desktop identity', async t => {
  const f = await fixture(t);
  const post = (path, body, auth = token) => fetch(f.base + '/hypr-desktop/viewer' + path, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/settings', { idleMinutes: 15 }, 'wrong')).status, 401);
  assert.equal((await post('/settings', { idleMinutes: 15, unknown: true })).status, 400);
  assert.equal((await post('/settings', { idleMinutes: 15, streamQuality: 'resource' })).status, 200);
  const headers = { Authorization: `Bearer ${token}` };
  const saved = await (await fetch(f.base + '/viewer/settings', { headers })).json();
  assert.equal(saved.settings.idleMinutes, 15);
  const listing = await (await fetch(f.base + '/viewer/desktops', { headers })).json();
  assert.equal(listing.settings.streamQuality, 'resource');
  assert.equal(listing.desktops[0].idleMinutes, 15);
  assert.equal(listing.desktops[0].closesAt, listing.desktops[0].lastActivityAt + 900000);
  assert.equal((await post('/1/activity', { generation: f.lease.generation }, 'wrong')).status, 401);
  assert.equal((await post('/1/activity', { generation: 'stale' })).status, 404);
  assert.equal((await post('/1/keep-open', { generation: f.lease.generation, minutes: 1441 })).status, 400);
  const held = await (await post('/1/keep-open', { generation: f.lease.generation, minutes: 60 })).json();
  assert.ok(held.desktop.keepOpenUntil > listing.desktops[0].closesAt);
  assert.equal((await post('/1/activity', { generation: f.lease.generation })).status, 200);
  assert.equal((await fetch(f.base + '/api/desktops/hub/1/activity', { method: 'POST' })).status, 403);
  await post('/1/close', { generation: f.lease.generation });
  assert.equal((await post('/1/keep-open', { generation: f.lease.generation, minutes: 10 })).status, 404);
});

test('fleet timer writes forward exact identities with peer auth, and private web input requires origin and JSON', async t => {
  const peerApp = express(), calls = [];
  peerApp.use(express.json());
  peerApp.post('/hypr-desktop/viewer/2/:action', (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    calls.push({ action: req.params.action, body: req.body });
    res.json({ desktop: { desktop: 2, generation: req.body.generation, closesAt: 123456 } });
  });
  const peer = peerApp.listen(0, '127.0.0.1'); await new Promise(r => peer.once('listening', r));
  t.after(async () => { peer.closeAllConnections(); await new Promise(r => peer.close(r)); });
  const f = await fixture(t, { agents: true, peers: [{ id: 'desktop-a', url: `http://127.0.0.1:${peer.address().port}`, token }] });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  for (const action of ['activity', 'keep-open']) {
    const body = { generation: 'exact-generation', ...(action === 'keep-open' ? { minutes: 10 } : {}) };
    const path = f.base + `/hypr-desktop/viewer/agents/${action}/desktop-a/2`;
    assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })).status, 200);
  }
  const path = f.base + '/api/desktops/desktop-a/2/activity', body = JSON.stringify({ generation: 'web-generation' });
  assert.equal((await fetch(path, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await fetch(path, { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body })).status, 200);
  assert.deepEqual(calls, [
    { action: 'activity', body: { generation: 'exact-generation' } },
    { action: 'keep-open', body: { generation: 'exact-generation', minutes: 10 } },
    { action: 'activity', body: { generation: 'web-generation' } }
  ]);
});

test('Xvfb clients receive their private VNC credential only through a generation-bound connection', async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${token}` };
  const listing = await (await fetch(f.base + '/viewer/desktops', { headers })).json();
  assert.ok(!JSON.stringify(listing).includes('vnc-only-password'));
  assert.equal((await fetch(f.base + '/viewer/1/connect?generation=' + f.lease.generation)).status, 401);
  assert.equal((await fetch(f.base + '/viewer/1/connect?generation=old', { headers })).status, 404);
  const info = await (await fetch(f.base + '/viewer/1/connect?generation=' + f.lease.generation, { headers })).json();
  assert.equal(info.password, 'vnc-only-password');
  assert.equal(info.generation, f.lease.generation);
});

test('authenticated remote cleanup forwards the selected generation and never retries against a reused desktop', async t => {
  const calls = [], peerApp = express();
  peerApp.use(express.json());
  peerApp.post('/hypr-desktop/viewer/2/close', (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    calls.push(req.body);
    res.status(404).json({ error: 'The selected generation has ended.' });
  });
  const peer = peerApp.listen(0, '127.0.0.1'); await new Promise(resolve => peer.once('listening', resolve));
  t.after(async () => { peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve)); });
  const f = await fixture(t, { peers: [{ id: 'desktop-a', url: `http://127.0.0.1:${peer.address().port}`, token }] });
  const path = f.base + '/hypr-desktop/viewer/agents/close/desktop-a/2';
  const body = JSON.stringify({ generation: 'old-selected-generation' });
  assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body })).status, 404);
  assert.deepEqual(calls, [{ generation: 'old-selected-generation' }]);
});
