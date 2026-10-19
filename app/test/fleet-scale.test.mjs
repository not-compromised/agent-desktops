import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture } from './fixtures/rfb.mjs';


test('Enlarge fits a 1440p desktop to the display through resize and reconnect', async () => {
  const app = await fixture(1, { width: 2560, height: 1440 });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.addInitScript(() => {
      window.webkit = { messageHandlers: { native: { postMessage(value) {
        const message = JSON.parse(value);
        if (message.type === 'fullscreen') document.documentElement.classList.toggle('native-fullscreen', message.enabled);
      } } } };
    });
    await page.goto(app.url);
    await page.locator('.control:not(:disabled)').waitFor();
    await page.getByRole('button', { name: 'Enlarge', exact: true }).click();
    const canvas = page.locator('.screen canvas');
    const fit = async (width, height) => {
      await page.waitForFunction(({ width, height }) => {
        const c = document.querySelector('.screen canvas'), box = c?.getBoundingClientRect();
        return c?.width === 2560 && c?.height === 1440 && Math.abs(box.width - width) < 1 && Math.abs(box.height - height) < 1;
      }, { width, height });
      assert.ok(await canvas.evaluate(c => {
        const box = c.getBoundingClientRect(), screen = c.closest('.screen').getBoundingClientRect();
        return box.left >= screen.left && box.top >= screen.top && box.right <= screen.right + 1 && box.bottom <= screen.bottom + 1
          && c.parentElement.scrollWidth <= c.parentElement.clientWidth && c.parentElement.scrollHeight <= c.parentElement.clientHeight;
      }), 'the whole desktop fits without scrolling or cropping');
    };
    await fit(1920, 1080);
    await page.mouse.move(960, 1070);
    await page.waitForFunction(() => document.querySelector('.tile-footer').getBoundingClientRect().bottom <= innerHeight);
    await fit(1920, 1080);
    await page.mouse.move(100, 100);
    for (const [width, height, shownWidth, shownHeight] of [[2560, 1440, 2560, 1440], [1280, 1024, 1280, 720], [1080, 1920, 1080, 607.5], [1920, 1080, 1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await fit(shownWidth, shownHeight);
    }
    const previous = await canvas.elementHandle();
    app.disconnect();
    await page.waitForFunction(el => !el.isConnected, previous);
    await page.locator('.control:not(:disabled)').waitFor();
    await fit(1920, 1080);
    await page.mouse.move(960, 1070);
    await page.getByRole('button', { name: 'Tile', exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('native-fullscreen'));
    assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).getAttribute('aria-pressed'), 'false');
  } finally { await browser.close(); await app.close(); }
});


test('profile replacement waits for painted pixels, preserves control, and keeps lossless negotiation', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    await page.goto(app.url); await page.locator('.control:not(:disabled)').waitFor();
    assert.equal(app.connections[0].profile, 'preview');
    assert.ok(app.connections[0].encodings.includes(-30), 'preview negotiates JPEG quality 2');
    const old = await page.locator('.screen canvas').elementHandle();
    app.hold();
    await page.getByRole('button', { name: 'Enlarge', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 2);
    assert.equal(await old.evaluate(c => c.isConnected && getComputedStyle(c.parentElement.parentElement).opacity === '1'), true, 'old image remains painted');
    assert.equal(app.connections[0].socket.readyState, 1, 'old stream stays connected while replacement warms');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    const full = app.connections.at(-1);
    // Wait for real protocol negotiation before releasing its first pixels.
    for (let i = 0; i < 100 && !full.encodings.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(full.profile, 'full');
    assert.ok(!full.encodings.some(e => e >= -32 && e <= -23), 'full stream never requests lossy JPEG quality');
    assert.ok(!full.encodings.includes(50) && !full.encodings.includes(21), 'H.264 and standalone JPEG are excluded');
    assert.ok(full.encodings.includes(7) && full.encodings.includes(0), 'Tight and raw remain interoperable');
    app.resume();
    await page.waitForFunction(c => !c.isConnected, old);
    assert.equal(await page.locator('.screen canvas').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Lock input', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('.screen canvas').evaluate(c => c.getBoundingClientRect().width <= c.closest('.screen').clientWidth));
  } finally { await browser.close(); await app.close(); }
});

test('failed and cancelled replacements retain the current stream without accumulating canvases', async () => {
  const app = await fixture(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
    await page.goto(app.url); await page.locator('.control:not(:disabled)').waitFor();
    const old = await page.locator('.screen canvas').elementHandle();
    app.hold();
    await page.locator('.size').click();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 2);
    app.connections.at(-1).socket.terminate();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 1);
    assert.equal(await old.evaluate(c => c.isConnected), true);
    await page.locator('.size').click();
    app.resume();
    assert.equal(await old.evaluate(c => c.isConnected), true, 'returning to preview reuses its still-live connection');
    app.hold();
    await page.locator('.size').click();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 2);
    await page.locator('.size').click();
    app.resume();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 1);
    assert.equal(await old.evaluate(c => c.isConnected), true, 'a cancelled first frame cannot adopt the old candidate');
    assert.equal(app.connections[0].socket.readyState, 1);
  } finally { await browser.close(); await app.close(); }
});


test('watch mode keeps the local pointer visible independently for each desktop', async () => {
  const app = await fixture(2), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(app.url);
    await page.waitForFunction(() => document.querySelectorAll('.control:not(:disabled)').length === 2);
    const tiles = page.locator('.tile');
    const cursor = async index => {
      const canvas = tiles.nth(index).locator('canvas').first();
      await canvas.hover();
      return canvas.evaluate(c => getComputedStyle(c).cursor);
    };
    assert.equal(await cursor(0), 'default', 'watching must not hide the local pointer');
    assert.equal(await cursor(1), 'default');
    await tiles.nth(0).locator('.control').click();
    await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 2);
    assert.equal(await cursor(0), 'none', 'controlled tile retains the remote cursor policy');
    assert.equal(await cursor(1), 'default', 'controlling one tile cannot hide the pointer over another');
    await page.keyboard.press('Escape');
    assert.equal(await cursor(0), 'default', 'Escape restores the pointer');
    await tiles.nth(0).locator('.control').click();
    await tiles.nth(0).locator('.control').click();
    assert.equal(await cursor(0), 'default', 'Lock input restores the pointer');
    await tiles.nth(0).locator('.control').click();
    app.disconnect();
    await page.waitForFunction(() => !document.querySelector('.controlling'));
    await page.waitForFunction(() => document.querySelectorAll('.control:not(:disabled)').length === 2);
    assert.equal(await cursor(0), 'default', 'reconnection starts with a visible watch cursor');
    assert.equal(await cursor(1), 'default');
  } finally { await browser.close(); await app.close(); }
});
