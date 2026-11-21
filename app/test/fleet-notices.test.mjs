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

test('a notice dismisses permanently on hover and expires four seconds after the latest one', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
    await page.goto(app.url);
    await page.locator('.control:not(:disabled)').waitFor();
    const status = page.locator('#status');
    const save = async () => {
      await page.locator('.desktop-actions summary').click();
      await page.locator('.desktop-menu .settings').click();
      await page.getByRole('button', { name: 'Save settings', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('settings-panel').hidden);
      assert.equal(await status.textContent(), 'Settings saved.');
    };
    await save();
    const box = await status.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await status.textContent(), '');
    await page.mouse.move(700, 400);
    assert.equal(await status.textContent(), '', 'leaving cannot resurrect the notice');
    await page.clock.install();
    await save();
    await page.clock.runFor(3000);
    await save();
    await page.clock.runFor(1500);
    assert.equal(await status.textContent(), 'Settings saved.', 'old timeout cannot clear the latest notice');
    await page.clock.runFor(2500);
    assert.equal(await status.textContent(), '');
  } finally { await browser.close(); await app.close(); }
});
