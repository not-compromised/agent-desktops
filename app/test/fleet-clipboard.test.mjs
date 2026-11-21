import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture } from './fixtures/rfb.mjs';

const XK = { Control_L: 0xffe3, Shift_L: 0xffe1, v: 0x76, Insert: 0xff63, Num_Lock: 0xff7f, KP_1: 0xffb1, KP_Decimal: 0xffae, KP_End: 0xff9c, Left: 0xff51, 1: 0x31, period: 0x2e };
const NAMES = Object.fromEntries(Object.entries(XK).map(([name, keysym]) => [keysym, name]));
const describe = input => input.map(e => 'clipboard' in e ? `clipboard ${e.clipboard}` : `${NAMES[e.keysym] || e.keysym.toString(16)} ${e.down ? 'down' : 'up'}`);

async function controlledDesktop(options) {
  const app = await fixture(1, options), browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 874 } });
  await page.addInitScript(() => {
    window.clipboardRequests = [];
    window.webkit = { messageHandlers: { native: { postMessage(raw) {
      const request = JSON.parse(raw);
      if (request.type === 'clipboard') window.clipboardRequests.push(request);
    } } } };
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.control').getAttribute('aria-pressed') === 'true');
  const box = await page.locator('.screen canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const input = () => app.connections.at(-1).input;
  const cdp = await page.context().newCDPSession(page);
  return {
    app, browser, page, input,
    async numpad(key, code, keyCode, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp'])
        await cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, isKeypad: true, modifiers, ...(type === 'keyDown' && key.length === 1 ? { text: key } : {}) });
    },
    mark: () => input().length,
    since: mark => describe(input().slice(mark)),
    requests: () => page.evaluate(() => window.clipboardRequests.length),
    reply: text => page.evaluate(text => window.dispatchEvent(new CustomEvent('native-clipboard', {
      detail: { request: window.clipboardRequests.at(-1).request, text }
    })), text),
    async settle(count) {
      for (let i = 0; i < 200 && input().length < count; i++) await new Promise(r => setTimeout(r, 10));
      await new Promise(r => setTimeout(r, 50));
    }
  };
}

test('a paste key sends the host clipboard to the desktop first, even when the keys are released before it arrives', async () => {
  const desk = await controlledDesktop();
  try {
    const { page } = desk;
    assert.equal(await page.getByRole('button', { name: 'Send clipboard' }).count(), 0, 'no separate clipboard step');
    let mark = desk.mark();
    await page.keyboard.down('Control'); await page.keyboard.down('v');
    await page.keyboard.up('v'); await page.keyboard.up('Control');
    assert.equal(await desk.requests(), 1, 'Ctrl+V asks the host for its clipboard');
    await desk.reply('Hello from the host ✓\nsecond line');
    await desk.settle(mark + 5);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'clipboard Hello from the host ✓\nsecond line',
      'v down', 'v up', 'Control_L up'], 'the desktop holds the text before it sees Ctrl+V');

    mark = desk.mark();
    await page.keyboard.press('Control+v');
    await desk.reply('Hello from the host ✓\nsecond line');
    await desk.settle(mark + 4);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'v down', 'v up', 'Control_L up'],
      'an unchanged host clipboard leaves whatever was copied inside the desktop');

    mark = desk.mark();
    await page.keyboard.press('Shift+Insert');
    await desk.reply('Shift+Insert text');
    await desk.settle(mark + 5);
    assert.deepEqual(desk.since(mark), ['Shift_L down', 'clipboard Shift+Insert text', 'Insert down', 'Insert up', 'Shift_L up']);

    mark = desk.mark();
    await page.keyboard.press('Control+v');
    await desk.reply(null);
    await desk.settle(mark + 4);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'v down', 'v up', 'Control_L up'], 'a host image leaves the desktop clipboard alone');
    mark = desk.mark();
    await page.keyboard.press('Control+v');
    await desk.reply('Shift+Insert text');
    await desk.settle(mark + 5);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'clipboard Shift+Insert text', 'v down', 'v up', 'Control_L up'],
      'copying the same text again after something else on the host sends it again');

    mark = desk.mark();
    await page.keyboard.press('v');
    await desk.settle(mark + 2);
    assert.deepEqual(desk.since(mark), ['v down', 'v up'], 'plain typing never touches the clipboard');
    assert.equal(await desk.requests(), 5);
  } finally { await desk.browser.close(); await desk.app.close(); }
});

test('returning to watch mode or losing the stream discards a pending paste and releases its keys', async () => {
  const desk = await controlledDesktop();
  try {
    const { page, app } = desk;
    let mark = desk.mark();
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Escape');
    await desk.reply('must not cross lock');
    await page.waitForTimeout(100);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'Control_L up'], 'no key stays held on the desktop');

    const everything = () => app.connections.flatMap(c => describe(c.input));
    mark = everything().length;
    const takeControl = async () => {
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.screen canvas').length === 1 && document.querySelector('.screen canvas').closest('div').style.opacity === '');
      const box = await page.locator('.screen canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await takeControl();
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Escape');
    await takeControl();
    await desk.reply('read before control left');
    await page.waitForTimeout(200);
    assert.deepEqual(everything().slice(mark), ['Control_L down', 'Control_L up'],
      'a paste from an earlier control session never replays');

    await page.keyboard.press('Control+v');
    const before = app.connections.length;
    app.disconnect();
    await page.getByRole('button', { name: 'Take control', exact: true }).waitFor();
    await desk.reply('must not cross reconnect');
    await page.waitForTimeout(100);
    assert.ok(app.connections.length >= before);
    assert.ok(!app.connections.flatMap(c => c.clipboard).includes('must not cross reconnect'), 'nothing crosses a reconnect');
    for (const width of [402, 768, 1440]) {
      await page.setViewportSize({ width, height: 874 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  } finally { await desk.browser.close(); await desk.app.close(); }
});

test('on WayVNC, the desktop Num Lock follows the numpad and other keys leave it alone', async () => {
  const desk = await controlledDesktop({ qemuKeys: true });
  try {
    const { page, app } = desk;
    app.lockLights(false);
    await page.waitForTimeout(100);
    let mark = desk.mark();
    await desk.numpad('1', 'Numpad1', 97);
    await desk.numpad('.', 'NumpadDecimal', 110);
    await desk.settle(mark + 6);
    assert.deepEqual(desk.since(mark), ['Num_Lock down', 'Num_Lock up', 'KP_1 down', 'KP_1 up', 'KP_Decimal down', 'KP_Decimal up'],
      'a digit from the numpad turns the desktop Num Lock on first');

    app.lockLights(true);
    await page.waitForTimeout(100);
    mark = desk.mark();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('v');
    await desk.numpad('1', 'Numpad1', 97);
    await desk.settle(mark + 6);
    assert.deepEqual(desk.since(mark), ['Left down', 'Left up', 'v down', 'v up', 'KP_1 down', 'KP_1 up'],
      'keys that say nothing about Num Lock never switch it off');

    mark = desk.mark();
    await page.keyboard.down('Shift');
    await desk.numpad('End', 'Numpad1', 35, 8);
    await page.keyboard.up('Shift');
    await desk.settle(mark + 4);
    assert.deepEqual(desk.since(mark), ['Shift_L down', 'KP_End down', 'KP_End up', 'Shift_L up'],
      'Shift with the numpad says nothing about Num Lock');

    mark = desk.mark();
    await page.keyboard.down('Control'); await page.keyboard.down('v'); await page.keyboard.up('v'); await page.keyboard.up('Control');
    await page.keyboard.down('Shift');
    await desk.numpad('End', 'Numpad1', 35, 8);
    await page.keyboard.up('Shift');
    await desk.reply(null);
    await desk.settle(mark + 8);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'v down', 'v up', 'Control_L up', 'Shift_L down', 'KP_End down', 'KP_End up', 'Shift_L up'],
      'Shift held behind a pending paste still says nothing about Num Lock');

    mark = desk.mark();
    await page.keyboard.press('Numpad1');
    await desk.settle(mark + 4);
    assert.deepEqual(desk.since(mark), ['Num_Lock down', 'Num_Lock up', 'KP_End down', 'KP_End up'],
      'a navigation key from the numpad turns the desktop Num Lock off, matching the host');
  } finally { await desk.browser.close(); await desk.app.close(); }
});

test('on x11vnc, which takes keysyms and has no Num Lock state, numpad digits arrive as digits', async () => {
  const desk = await controlledDesktop();
  try {
    const { page } = desk;
    const mark = desk.mark();
    await desk.numpad('1', 'Numpad1', 97);
    await desk.numpad('.', 'NumpadDecimal', 110);
    await page.keyboard.press('Numpad1');
    await desk.settle(mark + 6);
    assert.deepEqual(desk.since(mark), ['1 down', '1 up', 'period down', 'period up', 'KP_End down', 'KP_End up']);
  } finally { await desk.browser.close(); await desk.app.close(); }
});

test('a desktop that cannot take clipboard text unannounced still receives it before the keystroke', async () => {
  const desk = await controlledDesktop({ clipboardProvide: false });
  try {
    const { page } = desk;
    const mark = desk.mark();
    await page.keyboard.press('Control+v');
    await desk.reply('plain cut text');
    await desk.settle(mark + 5);
    assert.deepEqual(desk.since(mark), ['Control_L down', 'clipboard plain cut text', 'v down', 'v up', 'Control_L up']);
  } finally { await desk.browser.close(); await desk.app.close(); }
});
