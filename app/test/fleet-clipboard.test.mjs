import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture } from './fixtures/rfb.mjs';

test('explicit clipboard transfer reaches RFB; lock and disconnect discard delayed clipboard', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
    await page.addInitScript(() => {
      window.clipboardRequests = [];
      window.webkit = { messageHandlers: { native: { postMessage(raw) {
        const request = JSON.parse(raw);
        if (request.type === 'clipboard') window.clipboardRequests.push(request);
      } } } };
    });
    await page.goto(app.url); await page.locator('.control:not(:disabled)').waitFor();
    const send = page.getByRole('button', { name: 'Send clipboard' });
    assert.equal(await send.count(), 0, 'clipboard is offered only while controlling');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await send.click();
    assert.equal(await send.isDisabled(), true);
    const reply = text => page.evaluate(text => window.dispatchEvent(new CustomEvent('native-clipboard', {
      detail: { request: window.clipboardRequests.at(-1).request, text }
    })), text);
    await reply('Harmless clipboard sample\nsecond line');
    for (let i = 0; i < 100 && !app.connections.some(c => c.clipboard.length); i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(app.connections.flatMap(c => c.clipboard), ['Harmless clipboard sample\nsecond line']);
    await send.click();
    await page.getByRole('button', { name: 'Lock input', exact: true }).click();
    await reply('must not cross lock');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await send.click();
    app.disconnect();
    await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
    await reply('must not cross reconnect');
    await page.waitForTimeout(100);
    assert.deepEqual(app.connections.flatMap(c => c.clipboard), ['Harmless clipboard sample\nsecond line']);
    assert.equal(await send.count(), 0, 'reconnecting returns to watch mode without the clipboard action');
    for (const width of [402, 768, 1440]) {
      await page.setViewportSize({ width, height: 874 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  } finally { await browser.close(); await app.close(); }
});
