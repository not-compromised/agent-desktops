#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { invokeDesktop } from '../client.js';
import { createXvfb } from '../lib/xvfb.js';
import { Leases } from '../lib/leases.js';
import { createLifecycle } from '../lib/lifecycle.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to create and release test desktops on this machine');
const state = mkdtempSync(join(tmpdir(), 'pm-desktop-live-'));
const prefix = `pm-desktop-test-${process.pid}`;
const portBase = 20000 + Math.floor(Math.random() * 20000);
const fixture = createServer((req, res) => {
  const label = req.url === '/b' ? 'B' : 'A';
  res.setHeader('Content-Type', 'text/html');
  res.end(`<title>Desktop ${label}</title><style>body{font:32px Arial;padding:40px;background:#fff;color:#111}input{font:32px Arial;width:80%;padding:16px;background:rgb(232,238,242)}</style><h1>Desktop ${label}</h1><input autofocus placeholder="Type here" oninput="document.title='${label}:'+this.value">`);
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const fixtureURL = `http://127.0.0.1:${fixture.address().port}`;
const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
for (const file of ['token']) writeFileSync(join(state, file), randomBytes(32).toString('hex'), { mode: 0o600 });
writeFileSync(join(state, 'local-url'), `${base}/mcp`);
const nest = createXvfb({ state, prefix, portBase });
const claims = [];
let server, browser, attached = [];
async function eventually(fn, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(message);
}
async function start() {
  server = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    env: { ...process.env, HYPR_DESKTOP_HOSTS: 'desktop.example.test', AGENT_DESKTOP_VIEWER_ORIGINS: 'https://desktop.example.test', HYPR_DESKTOP_STATE: state, HYPR_DESKTOP_PORT: String(port), AGENT_DESKTOP_BACKEND: 'xvfb', AGENT_DESKTOP_UNIT_PREFIX: prefix, AGENT_DESKTOP_VNC_BASE: String(portBase) }, stdio: ['ignore', 'ignore', 'inherit']
  });
  await eventually(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, 'API failed to start');
}
async function stopServer() { if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); } }
const call = async (name, args = {}) => { const r = await invokeDesktop(name, args, { state }); if (r.isError) throw new Error(JSON.stringify(r)); return r; };
const observe = async handle => (await call('observe', { handle, scale: 0.5 })).structuredContent.frame_id;
try {
  await start();
  assert.equal((await fetch(`${base}/app.js`, { headers: { Origin: 'https://desktop.example.test' } })).status, 200);
  assert.equal((await fetch(`${base}/app.js`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  for (const owner of ['Local desktop check A', 'Local desktop check B']) {
    const d = (await call('claim', { owner })).structuredContent; claims.push(d);
  }
  const [a, b] = claims;
  assert.notEqual(nest.info(a.desktop).display, nest.info(b.desktop).display);
  const listeners = execFileSync('ss', ['-ltn'], { encoding: 'utf8' }).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/)[3]);
  for (const d of claims) {
    const endpoints = listeners.filter(endpoint => endpoint.endsWith(`:${nest.info(d.desktop).port}`));
    assert.ok(endpoints.length > 0);
    assert.ok(endpoints.every(endpoint => endpoint.startsWith('127.0.0.1:') || endpoint.startsWith('[::1]:')));
    const xPort = 6000 + Number(nest.info(d.desktop).display.slice(1));
    assert.equal(listeners.some(endpoint => endpoint.endsWith(`:${xPort}`)), false);
  }
  const fallback = execFileSync(fileURLToPath(new URL('../../bin/agent-desktop', import.meta.url)), ['tool', 'status', '{}'], { env: { ...process.env, HYPR_DESKTOP_STATE: state }, encoding: 'utf8' });
  assert.ok(fallback.includes('Local desktop check A'));
  console.log('PASS: documented shell fallback reaches local desktops; display/VNC ports stay private');
  for (const [d, path] of [[a, '/a'], [b, '/b']]) {
    await call('open', { handle: d.handle, command: ['brave', '--remote-debugging-port=0', fixtureURL + path] });
    const devtools = join(state, 'profiles', String(d.desktop), 'brave-browser', 'DevToolsActivePort');
    await eventually(() => existsSync(devtools), 'Browser failed to start');
    const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${readFileSync(devtools, 'utf8').split('\n')[0]}`); attached.push(cdp);
  }
  const pa = attached[0].contexts()[0].pages()[0], pb = attached[1].contexts()[0].pages()[0];
  await pa.waitForSelector('input'); await pb.waitForSelector('input');
  for (const [d, page] of [[a, pa], [b, pb]]) {
    const shot = await call('observe', { handle: d.handle, scale: 0.5 });
    const imagePath = join(state, `click-${d.desktop}.png`);
    writeFileSync(imagePath, Buffer.from(shot.content.find(c => c.type === 'image').data, 'base64'));
    // Locate the fixture's input in the actual captured frame, including browser chrome.
    const point = JSON.parse(execFileSync('python3', ['-c',
      'import json,sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");p=[(x,y) for y in range(im.height) for x in range(im.width) if im.getpixel((x,y))==(232,238,242)];assert p;print(json.dumps({"x":min(x for x,y in p)+max(x for x,y in p),"y":min(y for x,y in p)+max(y for x,y in p)}))', imagePath], { encoding: 'utf8' }));
    await call('click', { handle: d.handle, frame_id: shot.structuredContent.frame_id, ...point });
  }
  await call('type', { handle: a.handle, text: 'Only A' });
  await eventually(async () => await pa.locator('input').inputValue() === 'Only A', 'Input did not reach A');
  assert.equal(await pb.locator('input').inputValue(), '');
  await pa.evaluate(() => localStorage.setItem('isolation', 'A'));
  assert.equal(await pb.evaluate(() => localStorage.getItem('isolation')), null);
  await call('type', { handle: b.handle, text: 'Only B' });
  assert.equal(await pb.locator('input').inputValue(), 'Only B');
  assert.equal(await pa.locator('input').inputValue(), 'Only A');
  const frame = await observe(a.handle);
  // The fixture's input bounds come from its rendered DOM, not guessed coordinates.
  const bounds = await pa.locator('input').boundingBox();
  const win = (await nest.windows(a.desktop))[0];
  await call('move', { handle: a.handle, frame_id: frame, x: win.x + Math.round(bounds.x), y: win.y + Math.round(bounds.y) });
  assert.equal((await invokeDesktop('move', { handle: a.handle, frame_id: frame, x: 5, y: 5 }, { state })).isError, true);
  console.log('PASS: local displays, browser storage and keyboard input are isolated; old frames are rejected');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  assert.equal((await fetch(`${base}/api/desktops`)).status, 200);
  await page.goto(base);
  await page.getByRole('link', { name: 'Watch', exact: true }).first().waitFor();
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: join(state, `picker-${width}.png`) });
  }
  await page.getByRole('link', { name: 'Watch', exact: true }).first().click();
  await page.getByText('Watching live · input locked', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas || canvas.width !== 2560) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let light = 0; for (let i = 0; i < pixels.length; i += 400) if (pixels[i] > 200) light++;
    return light > 500;
  });
  for (const width of [402, 768, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: join(state, `viewer-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.locator('#keys').pressSequentially(' viewer');
  assert.equal(await page.locator('#keys').inputValue(), ' viewer');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await eventually(async () => await pa.locator('input').inputValue() === 'Only A viewer', 'Viewer keyboard failed');
  assert.equal(await pb.locator('input').inputValue(), 'Only B');
  await call('key', { handle: a.handle, combo: 'ctrl+a' });
  await call('type', { handle: a.handle, text: 'Selected and replaced' });
  assert.equal(await pa.locator('input').inputValue(), 'Selected and replaced');
  await page.getByRole('button', { name: 'Fit to screen', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: tailnet viewer displays real pixels at 402/768/1440; viewer input reaches only A');

  const before = nest.info(a.desktop).instance;
  await stopServer(); await start();
  await call('windows', { handle: a.handle });
  assert.equal(nest.info(a.desktop).instance, before);
  console.log('PASS: API restart preserves ownership, screens and apps');

  const oldFrame = await observe(a.handle);
  const info = nest.info(a.desktop);
  // This PID was allocated by this test and its cgroup must match before failure injection.
  const group = readFileSync(`/proc/${info.pid}/cgroup`, 'utf8');
  assert.ok(group.includes(`/${prefix}-${a.desktop}.service`));
  assert.equal(readlinkSync(`/proc/${info.pid}/exe`), realpathSync(process.execPath));
  assert.ok(readFileSync(`/proc/${info.pid}/cmdline`, 'utf8').includes('xvfb-supervisor.js'));
  process.kill(info.pid, 'SIGKILL');
  await eventually(async () => { try { return nest.info(a.desktop).instance !== before && await nest.ready(a.desktop); } catch { return false; } }, 'Desktop did not recover');
  assert.equal((await invokeDesktop('move', { handle: a.handle, frame_id: oldFrame, x: 10, y: 10 }, { state })).isError, true);
  assert.equal(await pb.locator('input').inputValue(), 'Only B');
  console.log('PASS: failed desktop recovers, old frames fail, B stays intact');

  const bPid = nest.info(b.desktop).pid;
  const appGroups = execFileSync('systemctl', ['--user', 'list-units', '--plain', '--no-legend', `${prefix}-${b.desktop}-app-*.service`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(s => s.trim().split(/\s+/)[0]);
  await call('release', { handle: b.handle });
  assert.equal(existsSync(`/proc/${bPid}`), false);
  for (const unit of appGroups) {
    const active = execFileSync('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim();
    assert.ok(['inactive', 'failed'].includes(active));
  }
  assert.equal(await nest.ready(a.desktop), true);
  await call('release', { handle: a.handle });
  claims.length = 0;
  const expiredLeases = new Leases({ now: () => 0, idleMs: 1 });
  const expiry = createLifecycle({ leases: expiredLeases, nest });
  const expired = await expiry.claim('Expiry verification');
  claims.push(expired);
  const expiredPid = nest.info(expired.desktop).pid;
  expiredLeases.now = () => 2;
  await expiry.reap();
  assert.equal(expiredLeases.status().length, 0);
  assert.equal(existsSync(`/proc/${expiredPid}`), false);
  claims.length = 0;
  console.log('PASS: release closes managed apps, leaves sibling intact, and idle reaper stops expired desktops');
  console.log(`Evidence: ${state}`);
} finally {
  await browser?.close();
  for (const cdp of attached) await cdp.close().catch(() => {});
  for (const d of claims) { try { await nest.stop(d.desktop); } catch (e) { console.error('Cleanup failed:', e.message); } }
  await stopServer(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
