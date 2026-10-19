import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../server.mjs';
import { chromium } from 'playwright';

test('native sound proxy protects writes and keeps local versus remote credentials on the server', async t => {
  const requests = [];
  const app = await serve({ fleet: true, host: 'desktop-a', token: 'fleet-secret', desktopURL: 'https://fleet.test',
    localDesktop: { host: 'desktop-a', url: 'http://127.0.0.1:7873', token: 'local-secret' },
    request: async (url, options) => {
      requests.push({ url, ...options });
      if (url.includes('generation=ended')) return new Response('{}', { status: 404 });
      return Response.json({ available: true, muted: true, streams: 1 });
    } });
  t.after(() => app.close());
  const path = app.url + 'api/desktops/desktop-a/2/audio';
  const origin = new URL(app.url).origin;
  const post = (headers, body = { generation: 'current', muted: false }) => fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'application/json' }, { muted: true })).status, 400);
  assert.equal(requests.length, 0);
  assert.equal((await post({ Origin: origin, 'Content-Type': 'application/json' })).status, 200);
  assert.equal(requests[0].url, 'http://127.0.0.1:7873/hypr-desktop/viewer/2/audio');
  assert.equal(requests[0].headers.Authorization, 'Bearer local-secret');
  assert.deepEqual(JSON.parse(requests[0].body), { generation: 'current', muted: false });
  await fetch(app.url + 'api/desktops/desktop-b/3/audio?generation=remote');
  assert.equal(requests[1].url, 'https://fleet.test/hypr-desktop/viewer/agents/audio/desktop-b/3?generation=remote');
  assert.equal(requests[1].headers.Authorization, 'Bearer fleet-secret');
  assert.notEqual((await fetch(path + '?generation=ended')).status, 200);
});

test('native sound button toggles exact generation and displays unavailable and rejected states', async t => {
  const app = await serve({ token: 'test', catalog: { close() {} } });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await app.close(); });
  assert.equal((await fetch(new URL('/audio.js', app.url))).status, 404, 'shared module stays behind native capability URL');
  const page = await browser.newPage();
  let muted = true, unavailable = false, reject = false;
  const writes = [];
  await page.route('**/api/desktops/desktop-a/2/audio*', async route => {
    if (route.request().method() === 'POST') {
      writes.push(route.request().postDataJSON());
      if (reject) return route.fulfill({ status: 503, json: { error: 'Audio host offline' } });
      muted = writes.at(-1).muted;
    }
    return route.fulfill({ json: { available: !unavailable, muted, streams: 1, ...(unavailable ? { reason: 'Host unavailable' } : {}) } });
  });
  // The overview hosts the button; its own polling is not under test.
  await page.route('**/wall.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.goto(app.url);
  await page.evaluate(async () => {
    document.body.innerHTML = '<button id="sound" class="sound"></button><span id="notice"></span>';
    const { installAudio } = await import('./audio.js');
    window.audio = installAudio(document.querySelector('#sound'), document.querySelector('#notice'), { host: 'desktop-a', desktop: 2, generation: 'current' });
    window.audio.update({ ready: true });
  });
  await page.getByRole('button', { name: 'Unmute desktop sound on desktop-a', exact: true }).waitFor();
  assert.equal(await page.locator('.sound-wave').isVisible(), false);
  assert.equal(await page.locator('.sound-slash').isVisible(), true);
  await page.getByRole('button', { name: 'Unmute desktop sound on desktop-a', exact: true }).click();
  await page.getByRole('button', { name: 'Mute desktop sound on desktop-a', exact: true }).waitFor();
  assert.equal(await page.locator('.sound-wave').isVisible(), true);
  assert.equal(await page.locator('.sound-slash').isVisible(), false);
  assert.deepEqual(writes, [{ generation: 'current', muted: false }]);
  reject = true;
  await page.getByRole('button', { name: 'Mute desktop sound on desktop-a', exact: true }).click();
  await page.getByText('Audio host offline').waitFor();
  assert.equal(await page.locator('#sound').getAttribute('aria-label'), 'Mute desktop sound on desktop-a');
  unavailable = true;
  await page.evaluate(() => window.audio.update({ ready: true }));
  await page.waitForFunction(() => document.querySelector('#sound').disabled);
  assert.equal(await page.locator('#sound').getAttribute('title'), 'Host unavailable');
  await page.evaluate(() => window.audio.dispose());
});
