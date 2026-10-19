import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { serve } from '../server.mjs';
import { installAgentFleet } from '../../mcp/lib/agent-fleet.js';
import { installDashboard } from '../../mcp/lib/dashboard.js';

async function fixture() {
  const state = { reject: true, uncertain: false }, attempts = [], runtimes = [];
  async function machine(host, peers = []) {
    const app = express();
    const row = { host, desktop: 1, generation: 'generation', handle: 'private-handle', owner: 'Agent', created: 1 };
    const status = async () => host === 'source' ? [{ desktop: 1, generation: row.generation, held: true, ready: false }] : [];
    const auth = (req, res, next) => req.headers.authorization === `Bearer ${host}-token` ? next() : res.sendStatus(401);
    app.get('/hypr-desktop/viewer/desktops', auth, async (_req, res) => res.json({ desktops: await status() }));
    const fleet = installAgentFleet(app, { host, peers, peerAuth: auth, localList: status, localInfo: async () => ({}),
      leases: { byHandle: new Map(host === 'source' ? [[row.handle, row]] : []), live: () => true },
      catalog: { read: async leases => host === 'source' ? leases.filter(l => l.host === host).map(l => ({ ...l, handle: undefined, threadId: 'thread', title: 'Original conversation' })) : [], close() {} },
      t3: { page: async () => ({ thread: { id: 'thread', messages: [] }, page: { hasMore: false } }),
        send: async (_thread, text, commandId, messageId) => {
          attempts.push({ text, commandId, messageId });
          if (state.reject) throw Object.assign(new Error('The server rejected this message before dispatch.'), { status: 400, rejected: true });
          if (state.uncertain) { state.uncertain = false; throw new Error('Delivery not confirmed.'); }
          return { sequence: 1 };
        }, close: async () => {} }
    });
    if (host === 'hub') installDashboard(app, { fleet, token: 'dashboard-signing-key', originOK: req => req.headers.origin === 'https://dashboard.example' });
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const runtime = { app, server, fleet, url: `http://127.0.0.1:${server.address().port}` }; runtimes.push(runtime); return runtime;
  }
  const source = await machine('source');
  const hub = await machine('hub', [{ id: 'source', url: source.url, token: 'source-token' }]);
  const native = await serve({ fleet: true, desktopURL: hub.url, token: 'hub-token', t3: { close: async () => {} } });
  let listing;
  for (let i = 0; i < 100; i++) {
    listing = await (await fetch(native.url + 'api/desktops')).json();
    if (listing.desktops[0]?.threadId) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(listing.desktops[0]?.threadId, 'thread');
  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const binding = { host: 'source', desktop: 1, generation: 'generation' };
  const chat = await (await post(native.url + 'api/chats', binding)).json();
  const dashboardChat = await (await post(hub.url + '/api/chats', binding, { Origin: 'https://dashboard.example' })).json();
  return { state, attempts, source, hub, native, chat, dashboardChat, post, async close() {
    await native.close();
    for (const r of runtimes.reverse()) { await r.fleet.close(); r.server.closeAllConnections(); await new Promise(resolve => r.server.close(resolve)); }
  } };
}

test('definite rejection survives source, hub, native and dashboard HTTP hops; uncertain delivery stays uncertain', async () => {
  const f = await fixture();
  const payload = { text: 'Rejected draft', commandId: 'command', messageId: 'message' };
  try {
    for (const [url, headers] of [[f.native.url + `api/chats/${f.chat.id}/messages`, {}], [f.hub.url + `/api/chats/${f.dashboardChat.id}/messages`, { Origin: 'https://dashboard.example' }]]) {
      const response = await f.post(url, payload, headers);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).rejected, true);
    }
    f.state.reject = false; f.state.uncertain = true;
    const response = await f.post(f.native.url + `api/chats/${f.chat.id}/messages`, payload);
    assert.equal(response.status, 503); assert.equal((await response.json()).rejected, false);
  } finally { await f.close(); }
});

test('a rejected native fleet draft can be corrected, while an uncertain retry keeps its original identity', async () => {
  const f = await fixture(); let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(f.native.url + `chat.html?id=${f.chat.id}`);
    await page.locator('#draft:not(:disabled)').waitFor();
    await page.locator('#draft').fill('Rejected draft'); await page.locator('#send').click();
    await page.locator('#send-error').filter({ hasText: /rejected this message/ }).waitFor();
    f.state.reject = false;
    await page.locator('#draft').fill('Corrected draft'); await page.locator('#send').click();
    await page.waitForFunction(() => document.getElementById('draft').value === '', null, { timeout: 1500 });
    assert.equal(f.attempts.at(-1).text, 'Corrected draft');
    f.state.uncertain = true;
    await page.locator('#draft').fill('Unconfirmed draft'); await page.locator('#send').click();
    await page.locator('#send-error').filter({ hasText: /Delivery not confirmed/ }).waitFor();
    const original = f.attempts.at(-1), count = f.attempts.length;
    await page.locator('#draft').fill('Changed draft'); await page.locator('#send').click();
    await page.locator('#send-error').filter({ hasText: /unchanged/ }).waitFor();
    assert.equal(f.attempts.length, count);
    await page.locator('#draft').fill('Unconfirmed draft'); await page.locator('#send').click();
    await page.waitForFunction(() => document.getElementById('draft').value === '', null, { timeout: 1500 });
    assert.deepEqual(f.attempts.at(-1), original);
  } finally { await browser?.close(); await f.close(); }
});

test('oversized JSON is a definite rejection before dispatch at native, hub, peer and dashboard boundaries', async () => {
  const f = await fixture();
  const payload = { text: 'x'.repeat(300000), commandId: 'command', messageId: 'message' };
  try {
    for (const [url, headers] of [
      [f.native.url + `api/chats/${f.chat.id}/messages`, {}],
      [f.hub.url + '/hypr-desktop/viewer/agents/chat/source/thread', { Authorization: 'Bearer hub-token' }],
      [f.source.url + '/hypr-desktop/viewer/agents/thread/thread', { Authorization: 'Bearer source-token' }],
      [f.hub.url + `/api/chats/${f.dashboardChat.id}/messages`, { Origin: 'https://dashboard.example' }]
    ]) {
      const response = await f.post(url, payload, headers);
      assert.equal(response.status, 413); assert.equal((await response.json()).rejected, true);
    }
    assert.equal(f.attempts.length, 0);
  } finally { await f.close(); }
});
