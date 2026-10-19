import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function fixture() {
  const app = express(), sent = [], attempts = [];
  const state = { rejected: false, uncertain: false, settings: { autoOpen: true, fleet: { url: '', tokenFile: '' } } };
  app.use(express.json({ limit: '512kb' }));
  app.get('/api/desktops', (_, res) => res.json({ desktops: [{ host: 'fixture', desktop: 1, generation: 'one', title: 'Build editor', owner: 'Task', held: true, ready: true, threadId: 'thread' }] }));
  app.get('/api/desktops/:host/:number/connect', (_, res) => res.json({ generation: 'one', password: 'fixture' }));
  app.get('/api/chats/:id', (_, res) => res.json({ snapshotSequence: 1, thread: { id: 'thread', title: 'Build editor', messages: [] }, page: { hasMore: false } }));
  app.post('/api/chats/:id/messages', (req, res) => {
    attempts.push(req.body);
    if (state.uncertain) { state.uncertain = false; return res.status(503).json({ error: 'Delivery not confirmed.' }); }
    if (state.rejected || req.body.text.length > 100000) return res.status(400).json({ error: 'Enter a message of at most 100,000 characters.', rejected: true });
    sent.push(req.body); res.json({ sequence: 2 });
  });
  app.get('/api/settings', (_, res) => res.json({ settings: state.settings, connection: { url: 'http://127.0.0.1:7873', mode: 'local' } }));
  app.post('/api/settings', (req, res) => { state.settings = req.body; res.json({ settings: state.settings, restartRequired: Boolean(req.body.fleet.url) }); });
  app.get('/rfb.js', (_, res) => res.type('js').send(`export default class RFB extends EventTarget { constructor(){ super(); setTimeout(() => { this.dispatchEvent(new Event('connect')); this.dispatchEvent(new Event('firstframe')); }, 0); } disconnect() {} }`));
  app.get('/vendor/purify.js', (_, res) => res.sendFile(root + 'node_modules/dompurify/dist/purify.es.mjs'));
  app.get('/vendor/marked.js', (_, res) => res.sendFile(root + 'node_modules/marked/lib/marked.esm.js'));
  app.get('/audio.js', (_, res) => res.sendFile(root + 'mcp/viewer/audio.js'));
  app.get('/activity.js', (_, res) => res.sendFile(root + 'mcp/viewer/activity.js'));
  app.get('/api/preferences', (_, res) => res.json({settings: {idleMinutes:30,browserStartup:'fresh',viewerStartup:'open',streamQuality:'auto',notificationSeconds:4}}));
  app.use('/shared', express.static(root + 'shared'));
  app.use(express.static(process.env.UX_WEB_ROOT || root + 'app/web'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 500, height: 760 } });
  return { state, sent, attempts, page, url: `http://127.0.0.1:${server.address().port}/`,
    async close() { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('oversized native draft can be corrected without reopening the conversation', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.url + 'chat.html?id=chat'); await f.page.locator('#draft:not(:disabled)').waitFor();
    await f.page.locator('#draft').fill('a'.repeat(100001)); await f.page.locator('#send').click();
    await f.page.locator('#send-error').filter({ hasText: /100,000/ }).waitFor();
    await f.page.locator('#draft').fill('Corrected message'); await f.page.locator('#send').click();
    await f.page.waitForFunction(() => document.getElementById('draft').value === '', null, { timeout: 1500 });
    assert.equal(f.sent.at(-1).text, 'Corrected message');
  } finally { await f.close(); }
});

test('definite native rejection permits editing while uncertain retries retain identity', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.url + 'chat.html?id=chat'); await f.page.locator('#draft:not(:disabled)').waitFor();
    f.state.rejected = true;
    await f.page.locator('#draft').fill('Rejected message'); await f.page.locator('#send').click();
    await f.page.locator('#send-error').filter({ hasText: /100,000/ }).waitFor();
    f.state.rejected = false;
    await f.page.locator('#draft').fill('Accepted message'); await f.page.locator('#send').click();
    await f.page.waitForFunction(() => document.getElementById('draft').value === '', null, { timeout: 1500 });
    assert.equal(f.sent.at(-1).text, 'Accepted message');
    f.state.uncertain = true;
    await f.page.locator('#draft').fill('Unconfirmed message'); await f.page.locator('#send').click();
    await f.page.locator('#send-error').filter({ hasText: /Delivery not confirmed/ }).waitFor();
    const original = f.attempts.at(-1);
    await f.page.locator('#draft').fill('Changed message'); await f.page.locator('#send').click();
    await f.page.locator('#send-error').filter({ hasText: /unchanged/ }).waitFor();
    assert.equal(f.attempts.at(-1), original, 'editing an uncertain send cannot dispatch another message');
    await f.page.locator('#draft').fill('Unconfirmed message'); await f.page.locator('#send').click();
    await f.page.waitForFunction(() => document.getElementById('draft').value === '', null, { timeout: 1500 });
    assert.deepEqual(f.attempts.at(-1), original, 'a retry preserves both identity fields');
  } finally { await f.close(); }
});

test('native desktop actions remain visible and usable beside chat on a small screen', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.url); await f.page.locator('.tile').waitFor();
    await f.page.locator('.tile').hover();
    assert.equal(await f.page.locator('.size').isVisible(), true);
    assert.equal(await f.page.locator('.control').isVisible(), true);
    await f.page.locator('.size').click(); assert.equal(await f.page.locator('.size').getAttribute('aria-label'), 'Tile');
    await f.page.locator('.control:not(:disabled)').click();
    assert.equal(await f.page.locator('.control').getAttribute('aria-pressed'), 'true');
    await f.page.keyboard.press('Escape');
    assert.equal(await f.page.locator('.control').getAttribute('aria-pressed'), 'false');
  } finally { await f.close(); }
});

test('native settings expose local status, auto-open and remote token-file configuration', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.url); await f.page.locator('.tile').waitFor();
    await f.page.locator('.tile').hover();
    await f.page.getByRole('button', { name: 'More desktop actions' }).click();
    await f.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await f.page.getByRole('button', { name: 'Remote connection and automatic opening' }).click();
    await f.page.getByText('This machine · http://127.0.0.1:7873', { exact: true }).waitFor();
    await f.page.getByLabel('Open automatically when a new batch starts').uncheck();
    await f.page.getByLabel('Remote hub URL').fill('https://hub.example.com');
    await f.page.getByLabel('Private token file path').fill('/home/test/private/hub-token');
    await f.page.locator('#settings-save').click();
    await f.page.getByText('Saved. Close and reopen Agent Desktops to apply the connection.', { exact: true }).waitFor();
    assert.deepEqual(f.state.settings, { autoOpen: false, fleet: { url: 'https://hub.example.com', tokenFile: '/home/test/private/hub-token' } });
    await f.page.getByLabel('Remote hub URL').fill(''); await f.page.getByLabel('Private token file path').fill('');
    await f.page.locator('#settings-save').click(); await f.page.getByText('Settings saved.', { exact: true }).waitFor();
    assert.deepEqual(f.state.settings.fleet, { url: '', tokenFile: '' });
    await f.page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await f.page.locator('#connection-open').evaluate(el => el === document.activeElement), true);
  } finally { await f.close(); }
});
