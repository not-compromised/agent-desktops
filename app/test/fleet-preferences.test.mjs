import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../server.mjs';
import { chromium } from 'playwright';

const defaults = { idleMinutes: 30, browserStartup: 'fresh', viewerStartup: 'open', streamQuality: 'auto', notificationSeconds: 4 };
test('native settings belong to the local computer and desktop actions preserve generation and backend errors', async t => {
  const writes = [];
  const app = await serve({ fleet: true, host: 'desktop-a', token: 'remote-token', desktopURL: 'https://fleet.test',
    localDesktop: { host: 'desktop-a', url: 'http://local.test', token: 'local-token' },
    request: async (url, options) => {
      writes.push({ url, ...options });
      if (url.endsWith('/settings')) return Response.json({ settings: { ...defaults, ...JSON.parse(options.body || '{}') } });
      return Response.json({ error: 'This desktop has ended.' }, { status: 404 });
    } });
  t.after(() => app.close());
  const post = (path, body, origin = new URL(app.url).origin) => fetch(app.url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.deepEqual((await (await fetch(app.url + 'api/preferences')).json()).settings, defaults);
  assert.equal((await post('api/preferences', { idleMinutes: 15 }, 'http://evil.test')).status, 403);
  assert.equal((await post('api/preferences', { idleMinutes: 15 })).status, 200);
  assert.ok(writes.filter(c => c.url.endsWith('/settings')).every(c => c.url.startsWith('http://local.test/') && c.headers.Authorization === 'Bearer local-token'));
  assert.equal((await post('api/desktops/desktop-b/2/keep-open', { generation: 'g2', minutes: 15 })).status, 404);
  assert.equal(writes.at(-1).url, 'https://fleet.test/hypr-desktop/viewer/agents/keep-open/desktop-b/2');
  assert.deepEqual(JSON.parse(writes.at(-1).body), { generation: 'g2', minutes: 15 });
  assert.equal((await post('api/desktops/desktop-a/0/activity', { generation: 'g' })).status, 400);
  assert.equal((await post('api/desktops/desktop-a/2/activity', { generation: '' })).status, 400);
});

test('settings panel saves all preferences, custom idle time, and fits supported widths', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage(); let settings = defaults, saved;
  await page.route('**/api/desktops', route => route.fulfill({ json: { host: 'desktop-a', closeHost: 'desktop-a', settings, desktops: [], cleanupDesktops: [] } }));
  await page.route('**/api/preferences', route => {
    if (route.request().method() === 'POST') { saved = route.request().postDataJSON(); settings = { ...settings, ...saved }; }
    return route.fulfill({ json: { settings } });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByLabel('Auto-close after inactivity').selectOption('custom');
  await page.getByLabel('Custom idle minutes').fill('45');
  await page.getByLabel('Browser startup').selectOption('restore');
  await page.getByLabel('When an agent opens a desktop').selectOption('notify');
  await page.getByLabel('Stream quality').selectOption('resource');
  await page.getByLabel('Notification duration in seconds').fill('7');
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('settings-panel').hidden);
  assert.deepEqual(saved, { idleMinutes: 45, browserStartup: 'restore', viewerStartup: 'notify', streamQuality: 'resource', notificationSeconds: 7 });
});

test('countdown and timed overrides target the displayed generation, including remote desktops', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
  const now = Date.now(); const writes = [];
  let desktop = { host: 'desktop-b', desktop: 2, generation: 'same-number-new-lease', ready: false, idleMinutes: 15, closesAt: now + 12 * 60000, keepOpenUntil: null };
  await page.clock.install({ time: now });
  await page.route('**/api/desktops', route => route.fulfill({ json: { closeHost: 'desktop-a', settings: defaults, desktops: [desktop] } }));
  await page.route('**/api/desktops/desktop-b/2/activity', route => {
    writes.push(route.request().postDataJSON()); desktop = { ...desktop, closesAt: now + 15 * 60000 };
    return route.fulfill({ json: { desktop } });
  });
  await page.route('**/api/desktops/desktop-b/2/keep-open', route => {
    const body = route.request().postDataJSON(); writes.push(body);
    desktop = { ...desktop, keepOpenUntil: body.minutes ? now + body.minutes * 60000 : null, closesAt: now + Math.max(12, body.minutes) * 60000 };
    return route.fulfill({ json: { desktop } });
  });
  await page.goto(app.url);
  assert.equal(await page.locator('.timer-short').textContent(), 'Closes in 12 min');
  await page.getByRole('button', { name: 'More desktop actions' }).click();
  await page.getByRole('button', { name: 'Extend 15 min', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.desktop-timer').textContent === 'Closes in 15 min');
  await page.getByLabel('Keep this desktop open').selectOption('custom');
  await page.getByLabel('Custom hold minutes').fill('90');
  await page.getByRole('button', { name: 'Keep open', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.desktop-timer').textContent.includes('90 min'));
  await page.getByRole('button', { name: 'Clear keep-open override', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.desktop-timer').textContent === 'Closes in 12 min');
  assert.deepEqual(writes, [{ generation: 'same-number-new-lease' }, ...[90, 0].map(minutes => ({ generation: 'same-number-new-lease', minutes }))]);
});

import { fixture } from './fixtures/rfb.mjs';
test('controlled human input renews once then trails the latest input; watching and polling never renew', async t => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 874 } }); let activity = 0;
  await page.route('**/api/desktops/fixture/1/activity', route => { activity++; return route.fulfill({ json: { desktop: { generation: 'pixels', closesAt: Date.now() + 1800000 } } }); });
  await page.goto(app.url);
  await page.locator('.control:not(:disabled)').waitFor();
  await page.clock.install();
  await page.mouse.move(700, 400);
  await page.clock.runFor(6000);
  assert.equal(activity, 0);
  await page.locator('.control').click();
  await page.mouse.move(701, 401);
  await page.waitForFunction(() => document.querySelector('.control').getAttribute('aria-pressed') === 'true');
  await page.waitForTimeout(50);
  assert.equal(activity, 1);
  await page.mouse.move(710, 410);
  await page.clock.runFor(5000);
  await page.waitForTimeout(50);
  assert.equal(activity, 2);
  await page.clock.runFor(20000);
  assert.equal(activity, 2, 'there is no perpetual heartbeat');
  await page.mouse.move(720, 420);
  await page.keyboard.press('Escape');
  await page.clock.runFor(6000);
  const final = activity;
  await page.mouse.move(730, 430);
  await page.clock.runFor(6000);
  assert.equal(activity, final, 'watching input does not renew');
});

test('resource and sharp quality apply during control, and saved notice duration controls clipboard expiry', async t => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
  let settings = { ...defaults, streamQuality: 'resource', notificationSeconds: 7 };
  await page.route('**/api/desktops', async route => {
    const response = await route.fetch();
    return route.fulfill({ json: { ...await response.json(), settings } });
  });
  await page.route('**/api/preferences', route => {
    if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() };
    return route.fulfill({ json: { settings } });
  });
  await page.addInitScript(() => { window.webkit = { messageHandlers: { native: { postMessage(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'clipboard') window.dispatchEvent(new CustomEvent('native-clipboard', { detail: { request: message.request, text: 'Clipboard duration test' } }));
  } } } }; });
  await page.goto(app.url);
  await page.locator('.control:not(:disabled)').click();
  assert.equal(app.connections.at(-1).profile, 'preview', 'resource mode overrides enlarged/controlled full streaming');
  await page.locator('.desktop-actions summary').click();
  await page.locator('.desktop-menu .settings').click();
  await page.getByLabel('Stream quality').selectOption('sharp');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.control').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.screen canvas').length === 1);
  for (let i = 0; i < 100 && app.connections.at(-1).profile !== 'full'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(app.connections.at(-1).profile, 'full');
  assert.ok(!app.connections.at(-1).encodings.includes(-24), 'sharp full uses lossless negotiation');
  await page.clock.install();
  await page.getByRole('button', { name: 'Send clipboard' }).click();
  await page.mouse.move(700, 400);
  await page.clock.runFor(4500);
  assert.match(await page.locator('#status').textContent(), /^Clipboard sent/);
  await page.clock.runFor(2500);
  assert.equal(await page.locator('#status').textContent(), '');
});

test('all desktop menu controls remain reachable in an eight-desktop wall at small sizes', async t => {
  const app = await fixture(8, { width: 640, height: 360 }), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage();
  await page.goto(app.url);
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8);
  for (const height of [600, 874]) for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height });
    for (const index of [0, 7]) {
      const tile = page.locator('.tile').nth(index), more = tile.locator('.desktop-actions summary');
      await more.click();
      const box = await tile.boundingBox(), menu = await tile.locator('.desktop-menu').boundingBox();
      assert.ok(menu.y >= box.y && menu.y + menu.height <= box.y + box.height, `menu remains within tile ${index} at ${width}x${height}: ${JSON.stringify({ box, menu })}`);
      for (const selector of ['.extend', '.keep-open select', '.keep-open [type=submit]', '.settings', '.close-desktops']) {
        const control = tile.locator(selector);
        await control.scrollIntoViewIfNeeded();
        assert.ok(await control.evaluate(element => {
          const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit === element || element.contains(hit);
        }), `${selector} can be reached at ${width}x${height}`);
      }
      await more.click();
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
});

test('a short keep-open override shows its expiry separately from the longer idle closeout', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage(); const now = Date.now();
  await page.clock.install({ time: now });
  await page.route('**/api/desktops', route => route.fulfill({ json: { closeHost: 'desktop-a', settings: defaults,
    desktops: [{ host: 'desktop-a', desktop: 1, generation: 'hold', idleMinutes: 60, ready: false, closesAt: now + 60 * 60000, keepOpenUntil: now + 15 * 60000 }] } }));
  await page.goto(app.url);
  await page.getByRole('button', { name: 'More desktop actions' }).click();
  assert.equal(await page.locator('.desktop-timer').textContent(), 'Closes in 60 min');
  assert.equal(await page.locator('.hold-expiry').textContent(), 'Hold expires in 15 min');
  await page.clock.runFor(15 * 60000);
  assert.equal(await page.locator('.desktop-timer').textContent(), 'Closes in 45 min');
  assert.equal(await page.locator('.hold-expiry').isVisible(), false);
  assert.equal(await page.locator('.clear-hold').isVisible(), false);
});
