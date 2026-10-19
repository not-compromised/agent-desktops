import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../server.mjs';
import { chromium } from 'playwright';

test('close action is local, authenticated, generation-specific, and reports partial failures', async t => {
  const calls = [];
  const app = await serve({ fleet: true, host: 'desktop-a', token: 'fleet-secret', desktopURL: 'https://fleet.test',
    localDesktop: { host: 'desktop-a', url: 'http://127.0.0.1:7873', token: 'local-secret' },
    request: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/agents/fleet')) return Response.json({ hosts: [{ id: 'desktop-b', online: true }], desktops: [{ host: 'desktop-b', desktop: 3, generation: 'remote', held: true }] });
      if (url.endsWith('/desktops')) return Response.json({ desktops: [1, 2, 4].map(desktop => ({ desktop, generation: 'current', held: desktop !== 4 })) });
      if (url.endsWith('/2/close')) return Response.json({ error: 'Cannot stop desktop' }, { status: 503 });
      return Response.json({ closed: true });
    } });
  t.after(() => app.close());
  const origin = new URL(app.url).origin;
  const post = (body, headers = { Origin: origin, 'Content-Type': 'application/json' }) => fetch(app.url + 'api/desktops/close', { method: 'POST', headers, body: JSON.stringify(body) });
  const body = { desktops: [1, 2].map(desktop => ({ host: 'desktop-a', desktop, generation: 'current' })) };
  assert.equal((await post(body, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post(body, { Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ desktops: [{ host: 'desktop-b', desktop: 3, generation: 'remote' }] })).status, 400);
  const snapshot = await (await fetch(app.url + 'api/desktops')).json();
  assert.deepEqual(snapshot.cleanupDesktops.map(d => d.desktop), [1, 2, 4], 'cleanup includes expired leases retained after failed shutdown');
  assert.ok(!snapshot.desktops.some(d => d.desktop === 4));
  const response = await post(body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.results[0].closed, true);
  assert.equal(result.results[1].closed, false);
  const stops = calls.filter(c => c.url.endsWith('/close'));
  assert.equal(stops.length, 2);
  assert.ok(stops.every(c => c.url.startsWith('http://127.0.0.1:7873/')));
  assert.ok(stops.every(c => c.headers.Authorization === 'Bearer local-secret'));
  assert.deepEqual(JSON.parse(stops[0].body), { generation: 'current' });
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('cleanup remains available for expired retained desktops when there are no active tiles', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage();
  const target = { host: 'desktop-a', desktop: 4, generation: 'expired' };
  await page.route('**/api/desktops', route => route.fulfill({ json: { host: 'desktop-a', closeHost: 'desktop-a', desktops: [], cleanupDesktops: [target] } }));
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Close all on desktop-a', exact: true }).click();
  assert.match(await page.getByRole('dialog').textContent(), /1 agent desktop on desktop-a/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('More menu confirms all local desktops, including hidden pages, and cancel closes nothing', async t => {
  const app = await serve({ host: 'desktop-a', token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
  const desktops = Array.from({ length: 9 }, (_, i) => ({ host: 'desktop-a', desktop: i + 1, generation: `g${i}`, ready: false }));
  const writes = [];
  await page.route('**/api/desktops', route => route.fulfill({ json: { host: 'desktop-a', closeHost: 'desktop-a', cleanupDesktops: desktops, desktops: [...desktops, { host: 'desktop-b', desktop: 1, generation: 'remote', ready: false }] } }));
  await page.route('**/api/desktops/close', route => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { results: writes.at(-1).desktops.map(d => ({ ...d, closed: true })) } });
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'More desktop actions' }).first().click();
  await page.getByRole('button', { name: 'Close all on desktop-a', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.textContent(), /9 agent desktops on desktop-a/);
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  }
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.length, 0);
  await page.getByRole('button', { name: 'More desktop actions' }).first().click();
  await page.getByRole('button', { name: 'Close all on desktop-a', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Close desktops', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Closed 9'));
  assert.deepEqual(writes, [{ desktops: desktops.map(({ host, desktop, generation }) => ({ host, desktop, generation })) }]);
});
