import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture } from './fixtures/rfb.mjs';

test('control indicator clears its area without flickering or swallowing remote clicks', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
    await page.goto(app.url);
    await page.locator('.control:not(:disabled)').click();
    const badge = page.locator('.control-note');
    await badge.waitFor();
    const box = await badge.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    assert.equal(await badge.evaluate(el => getComputedStyle(el).opacity), '0');
    await page.waitForTimeout(100);
    assert.equal(await badge.evaluate(el => getComputedStyle(el).opacity), '0', 'must stay hidden over its old area');
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).tagName, { x, y }), 'CANVAS');
    await page.mouse.click(x, y);
    for (let i = 0; i < 100 && !app.connections.some(c => c.pointers.some(p => p.buttons === 1)); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(app.connections.some(c => c.pointers.some(p => p.buttons === 1)), 'click reaches the remote RFB peer');
    assert.equal(await page.locator('.control').getAttribute('aria-pressed'), 'true');
    await page.mouse.move(700, 400);
    assert.equal(await badge.evaluate(el => getComputedStyle(el).opacity), '1');
    await page.keyboard.press('Escape');
    assert.equal(await badge.isVisible(), false);
  } finally { await browser.close(); await app.close(); }
});

test('clipboard confirmation dismisses permanently on hover and expires four seconds after the latest send', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
    await page.addInitScript(() => {
      window.webkit = { messageHandlers: { native: { postMessage(raw) {
        const request = JSON.parse(raw);
        if (request.type === 'clipboard') window.dispatchEvent(new CustomEvent('native-clipboard', {
          detail: { request: request.request, text: 'Harmless clipboard test' }
        }));
      } } } };
    });
    await page.goto(app.url);
    await page.locator('.control:not(:disabled)').click();
    const status = page.locator('#status'), send = page.getByRole('button', { name: 'Send clipboard' });
    await send.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Clipboard sent.'));
    const box = await status.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await status.textContent(), '');
    await page.mouse.move(700, 400);
    assert.equal(await status.textContent(), '', 'leaving cannot resurrect the confirmation');
    await page.clock.install();
    await send.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Clipboard sent.'));
    await page.clock.runFor(3000);
    await send.click();
    await page.clock.runFor(1500);
    assert.match(await status.textContent(), /^Clipboard sent\./, 'old timeout cannot clear the latest notice');
    await page.clock.runFor(2500);
    assert.equal(await status.textContent(), '');
  } finally { await browser.close(); await app.close(); }
});
