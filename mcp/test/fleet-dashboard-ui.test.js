import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Browser tests for the dashboard frontend. The backend is mocked at its HTTP
// contract (DASHBOARD-API.md) and noVNC at its import boundary, under the real CSP.
const viewer = fileURLToPath(new URL('../viewer/', import.meta.url));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";
const FAKE_RFB = `export default class RFB extends EventTarget {
  constructor(target, url, options) {
    super(); this.url = url; this.options = options; this.viewOnly = true; this.keys = []; this.disconnected = false;
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; canvas.tabIndex = -1; target.append(canvas);
    canvas.addEventListener('keydown', e => this.keys.push('dom:' + e.key));
    // A live desktop repaints; the canvas stream behind the video player only carries painted frames.
    const paint = canvas.getContext('2d'); let tick = 0;
    this.painter = setInterval(() => { paint.fillStyle = tick++ % 2 ? '#123' : '#321'; paint.fillRect(0, 0, 320, 180); }, 50);
    (window.__rfb ||= []).push(this);
    this.timer = setTimeout(() => this.dispatchEvent(new Event('connect')), 10);
  }
  sendKey(code) { this.keys.push(code); }
  disconnect() { clearTimeout(this.timer); clearInterval(this.painter); this.disconnected = true; setTimeout(() => this.dispatchEvent(new Event('disconnect')), 0); }
}`;
const ICON = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#7cc"/></svg>').toString('base64');
const desk = (host, desktop, generation, extra = {}) => ({ host, desktop, generation, owner: 'Agent', held: true, ready: true, idleMs: 1000, title: 'Task', icon: '', agentStatus: 'Working', agentId: null, ...extra });

async function fixture() {
  const state = { hosts: [{ id: 'hub', online: true }, { id: 'desktop-a', online: true }, { id: 'desktop-b', online: true }], desktops: [], connects: [], activities: [], down: false };
  const app = express();
  app.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP }); next(); });
  app.get('/novnc/core/rfb.js', (_req, res) => res.type('application/javascript').send(FAKE_RFB));
  app.get('/api/desktops', (_req, res) => state.down ? res.status(503).json({ error: 'down' }) : res.json({ hosts: state.hosts, desktops: state.desktops }));
  app.get('/api/desktops/:host/:n/connect', (req, res) => { state.connects.push(`${req.params.host}/${req.params.n}/${req.query.generation}`); res.json({ generation: req.query.generation, password: 'vnc' }); });
  app.post('/api/desktops/:host/:n/activity', express.json(), (req, res) => { state.activities.push({ host: req.params.host, desktop: Number(req.params.n), generation: req.body.generation }); res.json({ desktop: {} }); });
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../../node_modules/marked/lib/marked.esm.js', import.meta.url))));
  app.get('/vendor/purify.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../../node_modules/dompurify/dist/purify.es.mjs', import.meta.url))));
  app.use('/shared', express.static(fileURLToPath(new URL('../../shared/', import.meta.url))));
  app.use(express.static(viewer));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { state, page, errors, url: `http://127.0.0.1:${server.address().port}/`,
    rfbs: () => page.evaluate(() => (window.__rfb || []).map(r => ({ url: r.url, viewOnly: r.viewOnly, keys: r.keys, disconnected: r.disconnected }))),
    live: async host => (await page.evaluate(() => (window.__rfb || []).map(r => ({ url: r.url, viewOnly: r.viewOnly, keys: r.keys, disconnected: r.disconnected })))).filter(r => !r.disconnected && r.url.includes(`/view/${host}/`)),
    fits: async () => { for (const width of [402, 768, 1440]) { await page.setViewportSize({ width, height: 874 }); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal overflow at ${width}`); } },
    async close() { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const sharedAgent = () => [
  desk('desktop-a', 1, 'g1', { title: 'Build dashboard', icon: ICON, agentId: 'hub/thread-a' }),
  desk('desktop-b', 2, 'g2', { title: 'Build dashboard', icon: ICON, agentId: 'hub/thread-a' }),
  desk('desktop-a', 3, 'g3', { title: 'Build dashboard', agentStatus: 'Unknown' }),
  desk('desktop-b', 1, 'g4', { title: 'Fix login', agentStatus: 'Waiting for you', agentId: 'desktop-b/thread-b' })
];

test('fleet dashboard: empty state, verified grouping, focus-safe polling, offline retention, widths', async () => {
  const f = await fixture();
  try {
    await f.page.goto(f.url);
    await f.page.getByText('No active desktops', { exact: true }).waitFor();
    assert.equal(await f.page.locator('#notice').innerText(), '');
    await f.fits();
    f.state.desktops = sharedAgent();
    await f.page.waitForFunction(() => document.querySelectorAll('#agents li').length === 3);
    const names = await f.page.locator('#agents .name').allInnerTexts();
    assert.deepEqual(names, ['Fix login', 'Build dashboard', 'Build dashboard'], 'attention first; title never groups');
    const rows = f.page.locator('#agents li');
    assert.equal(await rows.nth(1).locator('.where').innerText(), 'desktop-a/1  desktop-b/2');
    assert.equal(await rows.nth(1).locator('.icon').getAttribute('src'), ICON);
    assert.equal(await rows.nth(2).locator('.where').innerText(), 'desktop-a/3');
    assert.deepEqual(await f.page.locator('#hosts li .count').allInnerTexts(), ['', '2', '2']);
    assert.deepEqual(await f.rfbs(), [], 'discovery never opens a stream');
    await rows.nth(1).locator('.row').click();
    await f.page.waitForFunction(() => document.querySelectorAll('.tile:not([hidden])').length === 2);
    assert.equal(await f.page.locator('#stage-title').innerText(), 'Build dashboard');
    assert.deepEqual(await f.page.locator('.tile .where').allInnerTexts(), ['desktop-a · 1', 'desktop-b · 2']);
    assert.deepEqual(await f.page.locator('.tile .title').allInnerTexts(), ['Build dashboard', 'Build dashboard'], 'each screen carries its session title');
    assert.deepEqual(await f.page.locator('.tile .icon').evaluateAll(els => els.map(e => e.getAttribute('src'))), [ICON, ICON], 'each screen carries its project favicon');
    assert.ok(await f.page.locator('.tile .title').evaluateAll(els => els.every(e => e.compareDocumentPosition(e.closest('.tile').querySelector('.screen')) & Node.DOCUMENT_POSITION_PRECEDING)), 'title sits below the screen');
    await f.page.waitForFunction(() => (window.__rfb || []).length === 2);
    assert.ok((await f.rfbs()).every(r => r.url.includes('profile=') && r.viewOnly));
    await f.page.waitForFunction(() => document.querySelectorAll('.tile .control:not(:disabled)').length === 2);
    const before = (await f.rfbs()).length;
    await f.page.waitForTimeout(4500);
    assert.equal((await f.rfbs()).length, before, 'unchanged polls do not reconnect streams');
    await f.fits();
    await f.page.setViewportSize({ width: 402, height: 874 });
    assert.equal(await f.page.locator('#rail').isVisible(), false, 'phone shows the selected agent alone');
    await f.page.locator('#back').click();
    await f.page.locator('#rail').waitFor({ state: 'visible' });
    assert.ok((await f.rfbs()).every(r => r.disconnected), 'closing the view disconnects');
    await f.page.setViewportSize({ width: 1440, height: 900 });
    await f.page.locator('#agents li').nth(1).locator('.row').focus();
    f.state.desktops[3].agentStatus = 'Working';
    await f.page.waitForFunction(() => document.querySelector('#agents li:nth-child(2) .status').textContent === 'Working');
    assert.equal(await f.page.evaluate(() => document.activeElement?.closest('li')?.dataset.group), 'agent:hub/thread-a', 'polling keeps the focused row');
    await f.page.locator('#agents li').nth(1).locator('.row').click();
    await f.page.waitForFunction(() => (window.__rfb || []).filter(r => !r.disconnected).length === 2);
    f.state.hosts[2].online = false; f.state.desktops = f.state.desktops.filter(d => d.host !== 'desktop-b');
    await f.page.waitForFunction(() => document.querySelector('#hosts li:nth-child(3)').classList.contains('offline'));
    assert.deepEqual(await f.page.locator('.tile .where').allInnerTexts(), ['desktop-a · 1', 'desktop-b · 2'], 'offline host keeps known tiles');
    assert.equal(await f.page.locator('.tile').nth(1).locator('.status').innerText(), 'Reconnecting');
    f.state.hosts[2].online = true;
    await f.page.waitForFunction(() => document.querySelectorAll('.tile').length === 1, null, { timeout: 10000 });
    await f.page.locator('#agents li').filter({ hasText: 'desktop-a/3' }).locator('.row').click();
    await f.page.waitForFunction(() => [...document.querySelectorAll('.tile .where')].map(e => e.textContent).join() === 'desktop-a · 3');
    f.state.desktops = [];
    await f.page.waitForFunction(() => document.querySelectorAll('#agents li').length === 0);
    assert.equal(await f.page.locator('#stage-empty').innerText(), 'This desktop has ended', 'a closed desktop leaves its view saying so');
    assert.equal(await f.page.locator('#rail-state').innerText(), 'No active desktops');
    await f.fits();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('bfcache: a persisted pagehide suspends streams, pageshow resumes them without a reload', async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent();
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.waitForFunction(() => (window.__rfb || []).filter(r => !r.disconnected).length === 2);
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.ok((await f.rfbs()).every(r => r.disconnected), 'pagehide closes the streams');
    assert.equal(await f.page.locator('.tile').count(), 2, 'tiles are kept for resumption');
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await f.page.waitForFunction(() => (window.__rfb || []).filter(r => !r.disconnected).length === 2);
    assert.ok((await f.rfbs()).filter(r => !r.disconnected).every(r => r.viewOnly), 'resumed streams start in watch mode');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('control: explicit Take control, Escape returns to watching without reaching the desktop, one controller at a time', async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent();
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.waitForFunction(() => document.querySelectorAll('.tile .control:not(:disabled)').length === 2);
    const first = f.page.locator('.tile').nth(0), second = f.page.locator('.tile').nth(1);
    await first.locator('.control').click();
    assert.equal(await first.locator('.control').getAttribute('aria-pressed'), 'true');
    assert.equal(await first.locator('.controlling-note').isVisible(), true);
    await f.page.waitForFunction(() => (window.__rfb || []).some(r => !r.disconnected && r.url.includes('/view/desktop-a/') && r.url.includes('profile=full') && !r.viewOnly));
    await first.locator('.keyboard').click();
    await f.page.locator('#keys').fill('hi');
    await f.page.keyboard.press('Enter');
    assert.deepEqual((await f.live('desktop-a'))[0].keys, [104, 105, 0xff0d], 'phone typing reaches the controlled desktop');
    await f.page.locator('canvas').first().focus();
    await f.page.keyboard.press('Escape');
    await f.page.waitForFunction(() => document.querySelector('.tile .control').getAttribute('aria-pressed') === 'false');
    const after = await f.rfbs();
    assert.ok(after.every(r => r.viewOnly || r.disconnected), 'watch mode after Escape');
    assert.ok(after.every(r => !r.keys.includes(0xff1b) && !r.keys.includes('dom:Escape')), 'Escape is consumed, not forwarded');
    assert.equal(await f.page.locator('#typing').isVisible(), false);
    await second.locator('.control').click();
    await first.locator('.control').click();
    assert.equal(await second.locator('.control').getAttribute('aria-pressed'), 'false', 'only one tile controls at a time');
    assert.equal(await first.locator('.control').getAttribute('aria-pressed'), 'true');
    await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.ok((await f.rfbs()).every(r => r.disconnected), 'a hidden page disconnects streams');
    assert.equal(await f.page.locator('.tile').count(), 2, 'tiles stay; agents keep running');
    await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await f.page.waitForFunction(() => (window.__rfb || []).filter(r => !r.disconnected).length === 2);
    assert.ok((await f.rfbs()).filter(r => !r.disconnected).every(r => r.viewOnly), 'reconnects always start in watch mode');
    assert.ok(f.state.connects.every(c => c === 'desktop-a/1/g1' || c === 'desktop-b/2/g2'), 'reconnects use the exact generation');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('service outage shows one line, then recovers into the list without a reload', async () => {
  const f = await fixture();
  try {
    f.state.down = true;
    await f.page.goto(f.url);
    await f.page.getByText('Desktop service unreachable. Check Tailscale.').waitFor();
    assert.equal(await f.page.locator('#agents li').count(), 0);
    f.state.down = false; f.state.desktops = sharedAgent();
    await f.page.waitForFunction(() => document.querySelectorAll('#agents li').length === 3, null, { timeout: 10000 });
    assert.equal(await f.page.locator('#rail-state').isVisible(), false);
    f.state.down = true;
    await f.page.locator('#notice').filter({ hasText: 'retrying' }).waitFor({ timeout: 10000 });
    assert.equal(await f.page.locator('#agents li').count(), 3, 'known rows survive a failed poll');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('desktop: Full Screen expands one tile and restores the group without changing control', async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent();
    await f.page.goto(f.url);
    await f.page.locator('#agents .row').filter({ hasText: 'Build dashboard' }).first().click();
    await f.page.locator('.tile:visible').first().waitFor();
    const tiles = f.page.locator('.tile:visible');
    assert.equal(await tiles.count(), 2);
    assert.equal(await f.page.getByRole('button', { name: 'Enlarge', exact: true }).count(), 0);
    await tiles.first().locator('.control:not(:disabled)').click();
    await tiles.first().getByRole('button', { name: 'Full Screen', exact: true }).click();
    assert.equal(await tiles.count(), 1);
    assert.equal(await tiles.first().evaluate(el => el.classList.contains('focused')), true);
    assert.equal(await f.page.evaluate(() => document.fullscreenElement), null);
    assert.equal(await tiles.first().locator('.control').getAttribute('aria-pressed'), 'true');
    await tiles.first().getByRole('button', { name: 'Exit Full Screen', exact: true }).click();
    assert.equal(await tiles.count(), 2);
    assert.equal(await tiles.first().locator('.control').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('mobile: grouped Take control survives fleet refresh and Watch restores both tiles', async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent().slice(0, 2);
    await f.page.addInitScript(() => { Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined }); });
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.goto(f.url + '#/agent/hub%2Fthread-a');
    const first = f.page.locator('.tile').first();
    await first.locator('.control:not(:disabled)').click();
    assert.equal(await first.locator('.control').getAttribute('aria-pressed'), 'true');
    f.state.desktops[0].agentStatus = 'Ready';
    await f.page.waitForFunction(() => document.querySelector('.tile .status').textContent === 'Ready');
    assert.equal(await first.locator('.control').getAttribute('aria-pressed'), 'true', 'fleet refresh must not end control');
    assert.equal(await f.page.locator('.tile:visible').count(), 1, 'only the controlled desktop fills the phone');
    await first.locator('.keyboard').click();
    await f.page.locator('#keys').fill('hi');
    await f.page.locator('#enter').click();
    assert.deepEqual((await f.live('desktop-a'))[0].keys, [104, 105, 0xff0d]);
    await first.locator('.control').click();
    assert.equal(await f.page.locator('.tile:visible').count(), 2);
    assert.equal(await f.page.locator('#stage').evaluate(el => el.classList.contains('immersive')), false);
    assert.ok((await f.rfbs()).filter(r => !r.disconnected).every(r => r.viewOnly));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('mobile: Take control fills the viewport and keeps the control bar and typing; Watch restores the page', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [desk('desktop-a', 1, 'g1')];
    // iPhone browsers have no element fullscreen; the layout must fill the viewport on its own.
    await f.page.addInitScript(() => { Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined }); });
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.goto(f.url + '#/session/desktop-a/1/g1');
    await f.page.locator('.control:not(:disabled)').click();
    await f.page.waitForFunction(() => document.querySelector('#stage').classList.contains('immersive'));
    assert.equal(await f.page.locator('.fullscreen').isVisible(), false, 'the video player is not offered while controlling');
    const stage = await f.page.locator('#stage').boundingBox();
    assert.ok(stage.y === 0 && stage.width >= 400 && stage.height >= 872, 'the stage fills the viewport');
    for (const name of ['.control', '.keyboard', '.more summary']) assert.equal(await f.page.locator(name).isVisible(), true, `${name} stays reachable`);
    assert.equal(await f.page.evaluate(() => { const r = document.querySelector('#back').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#stage') !== null; }), true, 'the stage covers page navigation');
    await f.page.locator('.keyboard').click();
    assert.equal(await f.page.evaluate(() => document.activeElement?.id), 'keys');
    await f.page.setViewportSize({ width: 402, height: 480 });
    await f.page.waitForFunction(() => document.querySelector('#stage').getBoundingClientRect().height <= 481);
    const typing = await f.page.locator('#typing').boundingBox();
    assert.ok(typing.y >= 0 && typing.y + typing.height <= 481, 'typing controls fit above the keyboard-sized viewport');
    assert.ok((await f.page.locator('.screen').boundingBox()).height > 0, 'desktop remains visible');
    await f.page.locator('#keys').fill('hi'); await f.page.locator('#enter').click();
    assert.deepEqual((await f.live('desktop-a'))[0].keys, [104, 105, 0xff0d]);
    await f.page.locator('.control').click();
    await f.page.waitForFunction(() => !document.querySelector('#stage').classList.contains('immersive'));
    assert.equal(await f.page.locator('#typing').isVisible(), false);
    assert.equal(await f.page.locator('#back').isVisible(), true, 'Watch returns the page');
    assert.equal((await f.live('desktop-a'))[0].viewOnly, true);
    assert.ok(f.state.connects.every(c => c === 'desktop-a/1/g1'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('mobile: leaving element fullscreen by the browser also ends control', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [desk('desktop-a', 1, 'g1')];
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.goto(f.url + '#/session/desktop-a/1/g1');
    await f.page.locator('.control:not(:disabled)').click();
    await f.page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    await f.page.evaluate(() => document.exitFullscreen());
    await f.page.waitForFunction(() => document.querySelector('.control').getAttribute('aria-pressed') === 'false');
    assert.equal(await f.page.locator('#stage').evaluate(el => el.classList.contains('immersive')), false);
    assert.equal((await f.live('desktop-a'))[0].viewOnly, true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const grouped of [false, true]) test(`mobile: Full Screen opens the live player directly, grouped=${grouped}`, async () => {
  const f = await fixture();
  try {
    f.state.desktops = grouped ? sharedAgent() : [desk('desktop-a', 1, 'g1')];
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.goto(grouped ? f.url : f.url + '#/session/desktop-a/1/g1');
    if (grouped) await f.page.locator('#agents .row').filter({ hasText: 'Build dashboard' }).first().click();
    await f.page.locator('.tile:visible').first().waitFor();
    assert.equal(await f.page.getByRole('button', { name: 'Enlarge', exact: true }).count(), 0);
    assert.equal(await f.page.getByRole('button', { name: 'Full Screen', exact: true }).count(), grouped ? 2 : 1);
    await f.page.locator('.fullscreen:not(:disabled)').first().waitFor();
    assert.equal(await f.page.locator('.player').first().isVisible(), false, 'the player stays out of the page until asked');
    await f.page.waitForFunction(() => document.querySelector('.player').readyState >= 1, null, { timeout: 5000 });
    await f.page.locator('.fullscreen').first().click();
    await f.page.waitForFunction(() => document.fullscreenElement?.classList.contains('player'));
    assert.equal(await f.page.locator('.player').first().isVisible(), true);
    assert.equal(await f.page.locator('.player').first().evaluate(v => v.srcObject?.getVideoTracks().length), 1, 'the player shows the canvas stream');
    assert.equal((await f.live('desktop-a'))[0].viewOnly, true, 'the player never grants input');
    assert.equal(await f.page.locator('#stage').evaluate(el => el.classList.contains('immersive')), false, 'the page layout is untouched');
    await f.page.evaluate(() => document.exitFullscreen());
    await f.page.waitForFunction(() => !document.fullscreenElement);
    await f.page.locator('.player').first().waitFor({ state: 'hidden' });
    assert.equal((await f.live('desktop-a')).length, 1, 'leaving the player keeps the stream');
    assert.equal(await f.page.locator('.control').first().getAttribute('aria-pressed'), 'false');
    assert.ok(f.state.connects.every(c => c === 'desktop-a/1/g1' || (grouped && c === 'desktop-b/2/g2')));
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.equal(await f.page.locator('.player').first().evaluate(v => v.srcObject), null, 'closing the stream stops the capture');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const mode of ['native', 'unavailable', 'refused']) test(`mobile: player fallback ${mode} restores the tile group on exit`, async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent();
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.addInitScript(mode => {
      HTMLCanvasElement.prototype.captureStream = undefined;
      if (mode !== 'native') Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: mode === 'unavailable' ? undefined : () => Promise.reject(new Error('Fullscreen refused'))
      });
    }, mode);
    await f.page.goto(f.url);
    await f.page.locator('#agents .row').filter({ hasText: 'Build dashboard' }).first().click();
    await f.page.locator('.fullscreen:not(:disabled)').first().click();
    await f.page.getByRole('button', { name: 'Exit Full Screen', exact: true }).waitFor();
    assert.equal(await f.page.locator('.tile:visible').count(), 1);
    if (mode === 'native') await f.page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    await f.page.getByRole('button', { name: 'Exit Full Screen', exact: true }).click();
    assert.equal(await f.page.locator('.tile:visible').count(), 2);
    assert.equal(await f.page.locator('#stage').evaluate(el => el.classList.contains('immersive')), false);
    assert.ok((await f.rfbs()).filter(r => !r.disconnected).every(r => r.viewOnly));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('mobile viewer uses the viewport in both orientations and keeps controls reachable', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [sharedAgent()[0]];
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.locator('.control:not(:disabled)').waitFor();
    for (const [width, height] of [[402, 874], [874, 402], [768, 874], [320, 568]]) {
      await f.page.setViewportSize({ width, height });
      const screen = await f.page.locator('.screen').boundingBox();
      assert.ok(screen.width >= width - 2, 'stream spans the available width');
      assert.ok(screen.height >= height - 110, 'navigation and controls use at most 110px');
      assert.equal(await f.page.locator('#rail').isVisible(), false);
      assert.equal(await f.page.locator('#top').isVisible(), false);
      await f.page.locator('.more summary').click();
      const menu = await f.page.locator('.more .menu').boundingBox();
      assert.ok(menu.y >= 0 && menu.y + menu.height <= height, 'menu opens inside viewport');
      await f.page.locator('.fit').click();
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
    }
    await f.page.setViewportSize({ width: 402, height: 480 });
    await f.page.locator('.control:not(:disabled)').click();
    await f.page.locator('.keyboard').click();
    const typing = await f.page.locator('#typing').boundingBox();
    assert.ok(typing.y + typing.height <= 480, 'typing fits a keyboard-sized viewport');
    assert.ok((await f.page.locator('.screen').boundingBox()).height > 0);
    await f.page.locator('#hide-keyboard').click();
    await f.page.locator('.control').click();
    await f.page.waitForFunction(() => !document.querySelector('#stage').classList.contains('immersive'));
    await f.page.locator('#back').click();
    await f.page.locator('#rail').waitFor({ state: 'visible' });
    assert.equal(await f.page.locator('#top').isVisible(), true);
    assert.equal(await f.page.locator('#rail').isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('watching hides mobile controls, tap restores them, interaction keeps them available', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [sharedAgent()[0]];
    await f.page.setViewportSize({ width: 874, height: 402 });
    await f.page.clock.install();
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.locator('.control:not(:disabled)').waitFor();
    await f.page.clock.runFor(3200);
    assert.equal(await f.page.locator('#stage-head').isVisible(), false, 'watching releases header space');
    assert.ok((await f.page.locator('.screen').boundingBox()).height >= 400, 'video gets full viewport height');
    await f.page.locator('#show-controls').click();
    assert.equal(await f.page.locator('#stage-head').isVisible(), true);
    assert.equal(await f.page.locator('.more').getAttribute('open'), null, 'Controls does not click through to More');
    await f.page.clock.runFor(3200);
    await f.page.locator('.screen').click({ position: { x: 150, y: 150 } });
    assert.equal(await f.page.locator('#stage-head').isVisible(), true, 'tap restores navigation');
    assert.equal((await f.live('desktop-a'))[0].viewOnly, true, 'revealing controls never grants remote input');
    await f.page.locator('.more summary').click();
    await f.page.clock.runFor(4000);
    assert.equal(await f.page.locator('.menu').isVisible(), true, 'open menu stays open');
    await f.page.locator('.more summary').click();
    await f.page.keyboard.press('Tab');
    await f.page.clock.runFor(4000);
    assert.equal(await f.page.locator('#stage-head').isVisible(), true, 'keyboard navigation keeps controls visible');
    await f.page.locator('.screen').click({ position: { x: 50, y: 100 } });
    await f.page.locator('#back').focus();
    await f.page.clock.runFor(4000);
    assert.equal(await f.page.locator('#stage-head').isVisible(), true, 'assistive focus keeps controls visible without a keypress');
    await f.page.locator('.control').click();
    await f.page.clock.runFor(4000);
    assert.equal(await f.page.locator('.tile-bar').isVisible(), true, 'remote control keeps controls visible');
    await f.page.locator('.keyboard').click();
    await f.page.clock.runFor(4000);
    assert.equal(await f.page.locator('#typing').isVisible(), true);
    await f.page.locator('#hide-keyboard').click();
    await f.page.locator('.control').click();
    await f.page.clock.runFor(3200);
    await f.page.keyboard.press('Tab');
    assert.equal(await f.page.locator('#stage-head').isVisible(), true, 'Tab reveals hidden controls');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('focused desktop survives a phone-width resize, group switching and reload without restoring control', async () => {
  const f = await fixture();
  try {
    f.state.desktops = sharedAgent();
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.locator('.control:not(:disabled)').first().waitFor();
    await f.page.locator('.tile').nth(1).locator('.fullscreen').click();
    await f.page.locator('.tile:visible .more summary').click();
    await f.page.locator('.tile:visible .fit').click();
    await f.page.setViewportSize({ width: 402, height: 874 });
    assert.equal(await f.page.locator('.tile:visible .where').innerText(), 'desktop-b · 2');
    assert.equal(await f.page.locator('.tile:visible .fit').textContent(), 'Fit to screen', 'Actual size survives navigation');
    await f.page.reload();
    await f.page.locator('.control:not(:disabled)').last().waitFor();
    assert.equal(await f.page.locator('.tile:visible .where').innerText(), 'desktop-b · 2');
    assert.equal(await f.page.locator('.tile:visible .fit').textContent(), 'Fit to screen', 'Actual size survives navigation');
    assert.ok((await f.rfbs()).filter(r => !r.disconnected).every(r => r.viewOnly));
    await f.page.locator('#back').click();
    await f.page.locator('#agents .row').filter({ hasText: 'desktop-a/1' }).click();
    assert.equal(await f.page.locator('.tile:visible .where').innerText(), 'desktop-b · 2');
    assert.equal(await f.page.locator('.tile:visible .fit').textContent(), 'Fit to screen', 'Actual size survives navigation');
    f.state.desktops[1].generation = 'replacement';
    await f.page.waitForFunction(() => document.querySelectorAll('.tile:not([hidden])').length === 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('mobile: one touch on Fit resets a restored zoom while controls stay hidden', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [sharedAgent()[0]];
    await f.page.setViewportSize({ width: 402, height: 874 });
    await f.page.clock.install();
    await f.page.addInitScript(() => sessionStorage.setItem('desktop-viewports-v1', JSON.stringify({
      'desktop-a/1/g1': { mode: 'zoom', zoom: 3, x: 0.2, y: 0 }
    })));
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/thread-a'));
    await f.page.locator('.control:not(:disabled)').waitFor();
    await f.page.clock.runFor(3200);
    assert.equal(await f.page.locator('#stage-head').isVisible(), false);
    const reset = f.page.locator('.reset-view'), bounds = await reset.boundingBox();
    const cdp = await f.page.context().newCDPSession(f.page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await reset.isVisible(), false, 'first touch activates Fit rather than moving it before click');
    assert.equal(await f.page.locator('.fit').textContent(), 'Actual size');
    assert.equal(await f.page.locator('#stage-head').isVisible(), false, 'touch focus on the player does not reveal navigation');
    assert.equal((await f.live('desktop-a'))[0].viewOnly, true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('desktop timer activity comes only from controlled input, not passive watching or polling', async () => {
  const f = await fixture();
  try {
    f.state.desktops = [desk('desktop-a', 1, 'activity-generation', { agentId: 'hub/activity-thread' })];
    await f.page.goto(f.url + '#/agent/' + encodeURIComponent('hub/activity-thread'));
    await f.page.locator('.control:not(:disabled)').waitFor();
    const canvas = f.page.locator('.tile canvas').first();
    await canvas.hover();
    await canvas.click();
    await f.page.waitForTimeout(5200);
    assert.deepEqual(f.state.activities, [], 'watch gestures and polling do not renew');
    await f.page.locator('.control').click();
    await f.page.waitForFunction(() => (window.__rfb || []).some(r => !r.disconnected && !r.viewOnly));
    await canvas.click();
    await f.page.waitForFunction(() => document.querySelector('.control').getAttribute('aria-pressed') === 'true');
    await f.page.waitForTimeout(100);
    assert.deepEqual(f.state.activities[0], { host: 'desktop-a', desktop: 1, generation: 'activity-generation' });
    await f.page.locator('.control').click();
    const count = f.state.activities.length;
    await canvas.hover(); await canvas.click();
    await f.page.waitForTimeout(5200);
    assert.equal(f.state.activities.length, count, 'returning to watch cancels trailing renewal');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
