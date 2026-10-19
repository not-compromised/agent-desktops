import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { boundedView, readView, saveView } from '../viewer/viewport.js';

const viewer = fileURLToPath(new URL('../viewer/', import.meta.url));
test('view preferences reject corrupt state, isolate generations, and bound stored desktops', () => {
  let raw = '{}';
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  saveView('desktop-a/1/g1', { mode: 'actual', zoom: 1, x: 0, y: 0 }, storage);
  assert.equal(readView('desktop-a/1/g1', storage).mode, 'actual');
  assert.equal(readView('desktop-a/1/g2', storage).mode, 'fit');
  for (let i = 0; i < 40; i++) saveView(`desktop-a/1/g${i}`, { mode: 'fit', zoom: 1, x: 0, y: 0 }, storage);
  assert.equal(Object.keys(JSON.parse(raw)).length, 32);
  for (const invalid of ['null', 'bad json', '{"key":{"mode":"zoom","zoom":1e100,"x":0,"y":0}}']) {
    raw = invalid; assert.equal(readView('key', storage).mode, 'fit');
    saveView('key', { mode: 'actual', zoom: 1, x: 0, y: 0 }, storage);
    assert.equal(readView('key', storage).mode, 'actual', 'new preferences replace malformed storage');
  }
  assert.equal(readView('key', { getItem() { throw Error('denied'); } }).mode, 'fit');
  assert.doesNotThrow(() => saveView('key', { mode: 'fit', zoom: 1, x: 0, y: 0 }, { getItem() { throw Error('denied'); } }));
});

test('zoom edges remain on screen after pan and orientation changes', () => {
  const view = { mode: 'zoom', zoom: 3, x: 10, y: -10 };
  assert.deepEqual(boundedView(view, 400, 600, 400, 225, 4), { scale: 3, x: 400, y: -37.5 });
  const landscape = boundedView(view, 800, 400, 800, 450, 2);
  assert.deepEqual(landscape, { scale: 3, x: 800, y: -475 });
  assert.deepEqual(boundedView({ mode: 'fit', zoom: 1, x: 10, y: 10 }, 400, 600, 400, 225, 4), { scale: 1, x: 0, y: 0 });
});

test('touch pinch, pan, fit, control isolation, and same-generation restoration in browser', async () => {
  const app = express();
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0}.screen{width:400px;height:600px;display:flex;overflow:hidden;touch-action:none}canvas{width:400px;height:225px;flex:none;margin:auto}
    </style><div class="screen"><canvas width="1600" height="900"></canvas></div>
    <script type="module">import { installViewport } from '/viewport.js';
    const screen = document.querySelector('.screen'), canvas = document.querySelector('canvas');
    window.changes = [];window.view = installViewport(screen,'desktop-a/1/g1',mode=>window.changes.push(mode)); window.view.attach(canvas);
    window.clicks = 0; screen.addEventListener('click',()=>window.clicks++);</script>`));
  app.use(express.static(viewer));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 700 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.view);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    const rect = () => page.locator('.screen canvas').boundingBox();
    await touch('touchStart', [{ x: 150, y: 300 }, { x: 250, y: 300 }]);
    await touch('touchMove', [{ x: 50, y: 300 }, { x: 350, y: 300 }]);
    await touch('touchEnd', []);
    assert.equal((await rect()).width, 1200, 'pinching makes text three times larger');
    assert.equal(await page.evaluate(() => window.clicks), 0, 'pinch never toggles viewer controls');
    await touch('touchStart', [{ x: 100, y: 300 }]);
    await touch('touchMove', [{ x: 390, y: 300 }]);
    await touch('touchEnd', []);
    assert.ok((await rect()).x > -400, 'one finger pans magnified desktop');
    const before = await rect();
    await page.reload(); await page.waitForFunction(() => window.view);
    assert.deepEqual(await rect(), before, 'same generation resumes zoom and position');
    await page.evaluate(() => window.view.setActive(false));
    assert.equal((await rect()).width, 400, 'control mode removes watch transform');
    await touch('touchStart', [{ x: 150, y: 300 }, { x: 250, y: 300 }]);
    await touch('touchMove', [{ x: 50, y: 300 }, { x: 350, y: 300 }]);
    await touch('touchEnd', []);
    await page.evaluate(() => window.view.setActive(true));
    assert.deepEqual(await rect(), before, 'control gestures never change watch preferences');
    await page.evaluate(() => window.view.setMode('fit'));
    assert.equal((await rect()).width, 400, 'Fit restores entire desktop');
    await page.evaluate(() => window.view.setMode('actual'));
    assert.equal((await rect()).width, 1600, 'Actual size renders native pixels');
    await page.reload(); await page.waitForFunction(() => window.view);
    assert.equal((await rect()).width, 1600, 'Actual size survives recreated tiles');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('installed noVNC keeps fitted geometry and sends no remote input for watch gestures', async () => {
  const { WebSocketServer } = await import('ws');
  const app = express();
  app.get('/', (_req, res) => res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0}.screen{position:relative;width:400px;height:600px;overflow:hidden;touch-action:none}.canvas{position:absolute;inset:0}.canvas>div{overflow:hidden!important}canvas{margin:auto!important;transform-origin:center}
    </style><div class="screen"><div class="canvas"></div></div><script type="module">
    import RFB from '/novnc/core/rfb.js';import { installViewport } from '/viewport.js';
    const screen=document.querySelector('.screen'), holder=document.querySelector('.canvas');
    window.view=installViewport(screen,'real/noVNC/g1',()=>{});
    const rfb=new RFB(holder,'ws://'+location.host+'/vnc');rfb.viewOnly=true;rfb.scaleViewport=true;rfb.clipViewport=false;
    view.attach(holder.querySelector('canvas'));rfb.addEventListener('connect',()=>window.connected=true);
    </script>`));
  app.use('/novnc', express.static(fileURLToPath(new URL('../../node_modules/@novnc/novnc/', import.meta.url))));
  app.use(express.static(viewer));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const sockets = new WebSocketServer({ server, path: '/vnc' });
  const inputs = [];
  sockets.on('connection', socket => {
    let stage = 0;
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('message', data => {
      if (stage === 0) { stage++; socket.send(Buffer.from([1, 1])); }
      else if (stage === 1) { stage++; socket.send(Buffer.alloc(4)); }
      else if (stage === 2) {
        stage++;
        const init = Buffer.alloc(24);
        init.writeUInt16BE(1600, 0); init.writeUInt16BE(900, 2);
        init[4] = 32; init[5] = 24; init[7] = 1;
        init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
        init[14] = 16; init[15] = 8;
        socket.send(init);
      } else if ([4, 5].includes(data[0])) inputs.push(data[0]);
    });
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 400, height: 700 }, hasTouch: true });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.connected);
    assert.deepEqual(await page.locator('.screen canvas').boundingBox(), { x: 0, y: 187.5, width: 400, height: 225 });
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [{ x: 150, y: 300 }, { x: 250, y: 300 }]);
    await touch('touchMove', [{ x: 50, y: 300 }, { x: 350, y: 300 }]);
    await touch('touchEnd', []);
    assert.deepEqual(await page.locator('.screen canvas').boundingBox(), { x: -400, y: -37.5, width: 1200, height: 675 });
    await page.evaluate(() => { const screen = document.querySelector('.screen'); screen.style.width = '700px'; screen.style.height = '400px'; });
    await page.setViewportSize({ width: 700, height: 400 });
    await page.waitForFunction(() => document.querySelector('canvas').clientWidth === 700);
    assert.equal((await page.locator('.screen canvas').boundingBox()).width, 2100, 'rotation preserves relative zoom with real noVNC');
    await page.evaluate(() => window.view.setMode('actual'));
    await page.waitForFunction(() => document.querySelector('.screen canvas').getBoundingClientRect().width === 1600);
    const beforePan = await page.locator('.screen canvas').boundingBox();
    await page.mouse.move(350, 200); await page.mouse.down(); await page.mouse.move(550, 250); await page.mouse.up();
    const afterPan = await page.locator('.screen canvas').boundingBox();
    assert.equal(afterPan.x, beforePan.x + 200, 'mouse drags actual-size desktop horizontally');
    assert.equal(afterPan.y, beforePan.y + 50, 'mouse drags actual-size desktop vertically');
    assert.deepEqual(inputs, [], 'watch gestures never send pointer or keyboard messages');
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(r => sockets.close(r));
    server.closeAllConnections(); await new Promise(r => server.close(r));
  }
});
