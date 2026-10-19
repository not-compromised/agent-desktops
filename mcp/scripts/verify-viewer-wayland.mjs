// Live browser + WayVNC check on one owned, disposable agent desktop.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import express from 'express';
import { chromium } from 'playwright';
import { Leases } from '../lib/leases.js';
import { createNest } from '../lib/nest.js';
import { installViewer } from '../lib/viewer.js';
import { createViewerStreams } from '../lib/viewer-streams.js';
import { invokeDesktop } from '../client.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to open a disposable agent desktop.');
const evidence = mkdtempSync(join(tmpdir(), 'mobile-viewer-proof-'));
const call = async (name, args) => {
  const result = await invokeDesktop(name, args);
  assert.ok(!result.isError, JSON.stringify(result)); return result;
};
const claimed = (await call('claim', { owner: 'dashboard viewer acceptance' })).structuredContent;
const leases = new Leases(), lease = leases.claim('Mobile viewer acceptance'); lease.desktop = claimed.desktop;
const nest = createNest(), origins = [], host = hostname().split('.')[0];
const encoders = [];
const streams = createViewerStreams({ nest, wayland: true, command: process.env.WAYVNC_TEST_COMMAND || 'wayvnc', spawnProcess: (...args) => {
  const child = spawn(...args); encoders.push(child); return child;
} });
const app = express();
const attach = installViewer(app, { host, leases, nest, origins, streams, wayland: true, token: 'live-test-only-token-not-a-real-secret', peers: [] });
const listener = app.listen(0, '127.0.0.1'); attach(listener);
await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}`; origins.push(base);
let browser;
try {
  const output = join(evidence, 'typed.txt');
  await call('open', { handle: claimed.handle, command: ['foot', '--title=Viewer acceptance', 'bash', '-c', `printf 'LIVE DESKTOP\\nWatch is read-only. Take control to type.\\n'; read -r line; printf '%s' "$line" > ${output}; for ((i=0;i<1200;i++)); do printf '\\rLive updates: %04d' "$i"; sleep 0.1; done`] });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ isMobile: true, hasTouch: true });
  const network = await page.context().newCDPSession(page); await network.send('Network.enable');
  let bytes = 0;
  network.on('Network.webSocketFrameReceived', ({ response }) => { bytes += Buffer.byteLength(response.payloadData, response.opcode === 2 ? 'base64' : 'utf8'); });
  const measure = async label => {
    const child = encoders.at(-1);
    const stats = () => readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ');
    const ticks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
    const start = stats(), before = bytes, time = Date.now();
    await new Promise(resolve => setTimeout(resolve, 2000));
    const end = stats(), seconds = (Date.now() - time) / 1000;
    console.log(`${label}: ${((Number(end[11]) + Number(end[12]) - Number(start[11]) - Number(start[12])) / ticks / seconds * 100).toFixed(1)}% of one CPU core; ${((bytes - before) * 8 / seconds / 1e6).toFixed(3)} Mbit/s received`);
  };
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.locator('#agents .row').waitFor();
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `picker fits ${width}`);
    await page.screenshot({ path: join(evidence, `picker-${width}.png`), fullPage: true });
  }
  assert.equal((await page.request.get(base + '/favicon.svg')).status(), 200);
  assert.equal((await page.request.get(base + '/apple-touch-icon.png')).status(), 200);
  await page.locator('#agents .row').click();
  await page.locator('.tile .control:not(:disabled)').waitFor({ timeout: 15000 });
  const bookmarked = page.url(); assert.match(bookmarked, /#\/session\//);
  const canvas = page.locator('.screen canvas'); await canvas.waitFor();
  assert.ok(await canvas.evaluate(c => c.width > 1000 && c.height > 500), 'real desktop framebuffer received');
  await new Promise(resolve => setTimeout(resolve, 1500));
  await measure('Static terminal after initial frame');
  await page.screenshot({ path: join(evidence, 'watching.png'), fullPage: true });
  await canvas.click({ position: { x: 80, y: 40 } }); await page.keyboard.type('BLOCKED');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
  assert.equal(await page.locator('.control').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.locator('#keys').fill('MOBILE');
  assert.equal(await page.locator('#keys').inputValue(), 'MOBILE', 'draft stays visible before sending');
  assert.equal(existsSync(output), false, 'draft has not reached the desktop');
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  for (let i = 0; i < 40; i++) { try { if (readFileSync(output, 'utf8') === 'MOBILE') break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.equal(readFileSync(output, 'utf8'), 'MOBILE', 'watch blocks typing; explicit control permits mobile input');
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await measure('Terminal updating 10 times/second');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).getAttribute('aria-pressed'), 'false', 'Escape returns to watch');
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `viewer fits ${width}`);
    await page.screenshot({ path: join(evidence, `viewer-${width}.png`), fullPage: true });
  }
  await page.locator('#hide-keyboard').click();
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
  assert.equal(await page.locator('.control').getAttribute('aria-pressed'), 'true', 'fullscreen retains control');
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'keys');
  await page.getByRole('button', { name: 'Hide keyboard', exact: true }).click();
  assert.equal(await page.locator('#typing').isVisible(), false);
  await page.screenshot({ path: join(evidence, 'interactive-fullscreen.png'), fullPage: true });
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  assert.equal(await page.locator('.control').getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 402, height: 874 });
  await page.locator('#back').click();
  await page.locator('#agents .row').waitFor();
  for (let i = 0; i < 30 && existsSync(`/proc/${encoders.at(-1).pid}`); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(existsSync(`/proc/${encoders.at(-1).pid}`), false, 'last disconnect stops the encoder');
  assert.ok(await nest.ready(claimed.desktop), 'closing viewer leaves agent desktop running');
  await page.goto(bookmarked); await page.locator('.tile .control:not(:disabled)').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.setViewportSize({ width: 402, height: 874 });
  await page.locator('#back').click();
  assert.deepEqual(errors, []);
  console.log(`PASS live pixels, watch-only input, mobile control, reconnect, favicon and responsive layout on ${host}`);
  console.log(`Evidence: ${evidence}`);
} finally {
  await browser?.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); await streams.close();
  await call('release', { handle: claimed.handle });
  console.log(`Released test desktop ${claimed.desktop}`);
}
