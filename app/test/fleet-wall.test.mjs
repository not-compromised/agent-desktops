import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture } from './fixtures/rfb.mjs';
import { serve } from '../server.mjs';

const defaults = { idleMinutes: 30, browserStartup: 'fresh', viewerStartup: 'open', streamQuality: 'auto', notificationSeconds: 4 };

const geometry = page => page.evaluate(() => [...document.querySelectorAll('.tile')].map(tile => {
  const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  return { tile: box(tile), screen: box(tile.querySelector('.screen')), canvas: box(tile.querySelector('.screen canvas')) };
}));

test('wall tiles take the desktop shape, share one size, and re-flow with the window', async t => {
  const app = await fixture(5, { width: 1600, height: 1000 }), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 768, height: 874 } });
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 5);
  await page.waitForFunction(() => { const s = document.querySelector('.screen').getBoundingClientRect(); return Math.abs(s.width / s.height - 1.6) < 0.01; });
  const narrow = await geometry(page);
  await page.setViewportSize({ width: 1440, height: 874 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok((await geometry(page))[0].tile.width > narrow[0].tile.width, 'widening the window re-flows the wall within a frame');
  const wide = await geometry(page);
  for (const { screen, canvas } of wide) {
    assert.ok(Math.abs(screen.width / screen.height - 1.6) < 0.01, `picture keeps the desktop's 16:10 shape: ${JSON.stringify(screen)}`);
    assert.ok(screen.width - canvas.width < 2 && screen.height - canvas.height < 2, 'the desktop fills its picture without bars');
    assert.equal(screen.width, wide[0].screen.width, 'every tile is the same size');
  }
  const lastRow = wide.filter(g => g.tile.y === wide.at(-1).tile.y);
  const centre = (lastRow[0].tile.x + lastRow.at(-1).tile.x + lastRow.at(-1).tile.width) / 2;
  assert.ok(Math.abs(centre - 720) < 2, 'an incomplete last row is centred');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const tile = page.locator('.tile').nth(1), controls = tile.locator('.controls');
  await page.mouse.move(1, 1);
  assert.equal(await controls.evaluate(el => getComputedStyle(el).opacity), '0', 'controls stay out of sight at rest');
  const before = await geometry(page);
  await tile.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelectorAll('.tile')[1].querySelector('.controls')).opacity === '1');
  assert.deepEqual(await geometry(page), before, 'revealing controls never moves or resizes a picture');
});

test('captions show host, group and countdown only when they tell desktops apart; waiting is the loudest strip', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', desktopURL: 'http://127.0.0.1:9', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const now = Date.now(), row = (desktop, extra) => ({ host: 'desktop-a', desktop, generation: `g${desktop}`, ready: false, closesAt: now + 30 * 60000, ...extra });
  let desktops = [row(1, { agentId: 'a', agentStatus: 'Working' }), row(2, { agentId: 'a', agentStatus: 'Working' }), row(3, { agentId: 'b', agentStatus: 'Waiting for you', closesAt: now + 3 * 60000 })];
  await page.route('**/api/desktops', route => route.fulfill({ json: { closeHost: 'desktop-a', settings: defaults, desktops } }));
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3);
  const shown = selector => page.locator(selector).evaluateAll(els => els.map(el => el.checkVisibility({ visibilityProperty: true })));
  assert.deepEqual(await shown('.host'), [false, false, false], 'one machine needs no host labels');
  assert.deepEqual(await shown('.mark'), [true, true, false], 'only the agent with two desktops is marked');
  assert.deepEqual(await shown('.timer-short'), [false, false, true], 'only the desktop about to close shows its countdown');
  const strip = await page.locator('.tile-footer').evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
  assert.notEqual(strip[2], strip[0], 'waiting for you lights its strip');
  desktops = [row(1, { agentId: 'a' }), row(2, { host: 'desktop-b', agentId: 'a' })];
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);
  assert.deepEqual(await shown('.host'), [true, true], 'mixed machines label their hosts');
  assert.deepEqual(await shown('.mark'), [false, false], 'a page of one agent has nothing to tell apart');
});
