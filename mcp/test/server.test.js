import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Leases } from '../lib/leases.js';
import { createLifecycle } from '../lib/lifecycle.js';
import { buildServer } from '../lib/server.js';

// A nest that records what it was asked instead of touching a desktop.
function fakeNest(overrides = {}) {
  const calls = [];
  const nest = {
    calls,
    readyDesktops: new Set(),
    ready(n) { return nest.readyDesktops.has(n); },
    async start(n) { calls.push(['start', n]); nest.readyDesktops.add(n); },
    async stop(n) { calls.push(['stop', n]); nest.readyDesktops.delete(n); },
    async windows(n) { calls.push(['windows', n]); return nest.win ?? []; },
    async capture(n, o) { calls.push(['capture', n, o]); return Buffer.from('png'); },
    async move(n, x, y) { calls.push(['move', n, x, y]); },
    async click(n, x, y, b) { calls.push(['click', n, x, y, b]); },
    async scroll(n, x, y, dy, dx) { calls.push(['scroll', n, x, y, dy, dx]); },
    async type(n, t) { calls.push(['type', n, t]); },
    async key(n, k) { calls.push(['key', n, k]); },
    async wait(n, options) { calls.push(['wait', n, options]); return { satisfied: true, reason: options.mode, elapsed_ms: 1 }; },
    async open(n, cmd) { calls.push(['open', n, cmd]); return 4242; },
    async exec(n, c) { calls.push(['exec', n, c]); return { code: 0, stdout: 'hi', stderr: '' }; },
    ...overrides
  };
  return nest;
}

async function connect(nest, leases = new Leases()) {
  const lifecycle = createLifecycle({ leases, nest });
  const handler = createMcpHandler(() => buildServer({ leases, nest, host: 'testbox', lifecycle }));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  const client = new Client({ name: 'test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, call, handler, leases, lifecycle };
}

test('speaks the 2026-07-28 era and lists a deterministic tool set', async () => {
  const { client } = await connect(fakeNest());
  assert.equal(client.getProtocolEra(), 'modern');
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.deepEqual(names, ['status', 'claim', 'release', 'keep_open', 'open', 'run', 'observe', 'windows', 'window', 'held_input', 'move', 'click', 'scroll', 'drag', 'type', 'key', 'wait']);
});

test('claim, observe, click flow; stale frames and foreign handles are refused', async () => {
  const nest = fakeNest();
  const { call } = await connect(nest);
  const claimed = await call('claim', { owner: 'test thread' });
  assert.equal(claimed.isError, undefined);
  const { handle, desktop, show } = claimed.structuredContent;
  assert.equal(desktop, 1);
  assert.match(show, /background desktop/);

  const before = await call('click', { handle, frame_id: 'f1-none', x: 1, y: 1 });
  assert.equal(before.isError, true);
  assert.match(before.content[0].text, /observe before/);

  const obs = await call('observe', { handle, scale: 0.5 });
  const image = obs.content.find(c => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'png');
  const frame = obs.structuredContent.frame_id;
  assert.match(obs.content.find(c => c.type === 'text').text, new RegExp(`frame_id ${frame}`));

  const clicked = await call('click', { handle, frame_id: frame, x: 100, y: 200, button: 'right' });
  assert.equal(clicked.isError, undefined);
  assert.deepEqual(nest.calls.at(-1), ['click', 1, 100, 200, 'right']);
  assert.equal((await call('click', { handle, frame_id: frame, x: 100, y: 200 })).isError, true, 'input requires a fresh observation after a click');

  await call('observe', { handle });
  const stale = await call('click', { handle, frame_id: frame, x: 1, y: 1 });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /stale frame/);

  const foreign = await call('type', { handle: 'd2-deadbeef', text: 'x' });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /unknown handle/);

  await call('type', { handle, text: 'hello' });
  await call('key', { handle, combo: 'ctrl+l' });
  assert.deepEqual(nest.calls.slice(-2), [['type', 1, 'hello'], ['key', 1, 'ctrl+l']]);

  const released = await call('release', { handle });
  assert.match(released.content[0].text, /released desktop 1/);
  assert.equal((await call('type', { handle, text: 'x' })).isError, true);
});

test('claim replaces a leftover desktop before handing it over', async () => {
  const nest = fakeNest();
  nest.readyDesktops = new Set([2, 3, 4]);
  nest.win = [{ address: '0x1', class: 'foot', title: 't', x: 0, y: 0, w: 1, h: 1, focused: true }];
  const { call } = await connect(nest);
  const { structuredContent } = await call('claim', {});
  assert.equal(structuredContent.desktop, 1);
  assert.deepEqual(nest.calls.slice(0, 3), [['stop', 1], ['start', 1]]);
});

test('status needs no handle and describes background desktop viewing', async () => {
  const nest = fakeNest();
  const leases = new Leases();
  leases.claim('someone');
  nest.readyDesktops.add(1);
  const { call } = await connect(nest, leases);
  const text = (await call('status')).content[0].text;
  assert.match(text, /desktop 1: ready, held by someone, idle 0 min, windows 0, background desktop/);
  assert.doesNotMatch(text, /desktop 4:/);
});

test('open injects a browser profile and run reports the exit code', async () => {
  const nest = fakeNest();
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const opened = await call('open', { handle, command: ['brave', 'https://example.com'] });
  assert.match(opened.content[0].text, /started brave/);
  assert.deepEqual(nest.calls.at(-1), ['open', 1, ['brave', 'https://example.com']]);
  const ran = await call('run', { handle, command: 'echo hi' });
  assert.match(ran.content[0].text, /exit 0[\s\S]*hi/);
});

test('six simultaneous claims start six desktops and releasing one closes only its own', async () => {
  const nest = fakeNest();
  const { call } = await connect(nest);
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => call('claim', { owner: `task ${i}` })));
  assert.equal(nest.readyDesktops.size, 6);
  assert.match(claims[5].structuredContent.show, /background desktop/);
  const { handle, desktop } = claims[2].structuredContent;
  assert.equal((await call('release', { handle })).isError, undefined);
  assert.equal(nest.readyDesktops.has(desktop), false);
  assert.equal(nest.readyDesktops.size, 5);
  assert.equal((await call('windows', { handle })).isError, true);
});

test('idle cleanup closes abandoned desktops without needing another claim', async () => {
  let now = 0;
  const leases = new Leases({ now: () => now, idleMs: 1000 });
  const nest = fakeNest();
  const { call, lifecycle } = await connect(nest, leases);
  const { handle } = (await call('claim')).structuredContent;
  now = 1001;
  await lifecycle.reap();
  assert.equal(nest.readyDesktops.size, 0);
  assert.deepEqual(leases.status(), []);
  assert.equal((await call('windows', { handle })).isError, true);
});

test('failed shutdown keeps ownership and a later release can retry', async () => {
  const nest = fakeNest();
  const { call, leases } = await connect(nest);
  const { handle } = (await call('claim')).structuredContent;
  const stop = nest.stop;
  nest.stop = async () => { throw new Error('stop failed'); };
  assert.equal((await call('release', { handle })).isError, true);
  assert.equal(leases.touch(handle).desktop, 1);
  nest.stop = stop;
  assert.equal((await call('release', { handle })).isError, undefined);
  assert.equal(nest.readyDesktops.size, 0);
});

test('failed startup is cleaned up and does not consume the desktop', async () => {
  const nest = fakeNest({ start: async () => { throw new Error('startup failed'); } });
  const { call, leases } = await connect(nest);
  assert.equal((await call('claim')).isError, true);
  assert.deepEqual(leases.status(), []);
  assert.deepEqual(nest.calls, [['stop', 1], ['stop', 1]]);
});

test('failed input consumes its frame, and a recovered display rejects old frames', async () => {
  let instance = 'first';
  const nest = fakeNest({ instance: () => instance, click: async () => { throw new Error('input timed out after a side effect'); } });
  const { call } = await connect(nest);
  const { handle } = (await call('claim')).structuredContent;
  const first = (await call('observe', { handle })).structuredContent.frame_id;
  assert.equal((await call('click', { handle, frame_id: first, x: 1, y: 1 })).isError, true);
  const reuse = await call('move', { handle, frame_id: first, x: 1, y: 1 });
  assert.equal(reuse.isError, true);
  const second = (await call('observe', { handle })).structuredContent.frame_id;
  instance = 'replacement';
  const oldDisplay = await call('move', { handle, frame_id: second, x: 1, y: 1 });
  assert.equal(oldDisplay.isError, true);
  const third = (await call('observe', { handle })).structuredContent.frame_id;
  assert.equal((await call('move', { handle, frame_id: third, x: 1, y: 1 })).isError, undefined);
});

test('action feedback returns a new usable frame in one call and never captures after failure', async () => {
  const nest = fakeNest();
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const initial = (await call('observe', { handle })).structuredContent.frame_id;
  const result = await call('click', { handle, frame_id: initial, x: 10, y: 20, observe: true, settle_ms: 0 });
  assert.equal(result.isError, undefined);
  assert.ok(result.content.some(c => c.type === 'image'));
  assert.notEqual(result.structuredContent.frame_id, initial);
  assert.equal((await call('click', { handle, frame_id: initial, x: 10, y: 20 })).isError, true);
  assert.equal((await call('click', { handle, frame_id: result.structuredContent.frame_id, x: 10, y: 20 })).isError, undefined);
  nest.click = async () => { throw Error('input failed'); };
  const frame = (await call('observe', { handle })).structuredContent.frame_id;
  const failed = await call('click', { handle, frame_id: frame, x: 10, y: 20, observe: true, settle_ms: 0 });
  assert.equal(failed.isError, true);
  assert.ok(!failed.content.some(c => c.type === 'image'));
});

test('observation polling cannot retain desktops; bounded keep_open and actual actions can', async () => {
  let now = 0;
  const leases = new Leases({ now: () => now, idleMs: 60000 });
  const { call } = await connect(fakeNest(), leases);
  const { handle } = (await call('claim')).structuredContent;
  now = 30000;
  await call('observe', { handle }); await call('windows', { handle });
  await call('wait', { handle, ms: 50 }); await call('status');
  assert.equal(leases.status()[0].lastActivityAt, 0);
  const held = await call('keep_open', { handle, minutes: 5 });
  assert.equal(held.structuredContent.closesAt, 330000);
  now = 120000;
  assert.equal((await call('type', { handle, text: 'work' })).isError, undefined);
  assert.equal(leases.status()[0].lastActivityAt, 120000);
  await call('keep_open', { handle, minutes: 0 });
  now = 180001;
  assert.equal((await call('observe', { handle })).isError, true);
  assert.equal((await call('keep_open', { handle, minutes: 5 })).isError, true);
});

test('read-only polling lets an abandoned desktop expire at its original idle deadline', async () => {
  let now = 0;
  const leases = new Leases({ now: () => now, idleMs: 60000 });
  const { call } = await connect(fakeNest(), leases);
  const { handle } = (await call('claim')).structuredContent;
  now = 30000;
  await call('observe', { handle });
  await call('windows', { handle });
  await call('wait', { handle, ms: 50 });
  now = 61000;
  assert.equal((await call('observe', { handle })).isError, true, 'watching must not retain an abandoned task');
});

test('drag requires owned fresh coordinates, consumes the frame and can return a new observation', async () => {
  const nest = fakeNest({ async drag(...args) { nest.calls.push(['drag', ...args]); } });
  const { call } = await connect(nest);
  const { handle } = (await call('claim')).structuredContent;
  assert.equal((await call('drag', { handle: 'foreign', frame_id: 'missing', x: 1, y: 2, to_x: 3, to_y: 4 })).isError, true);
  const frame = (await call('observe', { handle })).structuredContent.frame_id;
  const result = await call('drag', { handle, frame_id: frame, x: 1, y: 2, to_x: 300, to_y: 400, duration_ms: 500, observe: true, settle_ms: 0 });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent.frame_id);
  assert.ok(nest.calls.some(entry => JSON.stringify(entry) === JSON.stringify(['drag', 1, 1, 2, 300, 400, 'left', 500])));
  assert.equal((await call('drag', { handle, frame_id: frame, x: 1, y: 2, to_x: 3, to_y: 4 })).isError, true);
  assert.equal((await call('drag', { handle, frame_id: result.structuredContent.frame_id, x: 1, y: 2, to_x: 2560, to_y: 4 })).isError, true);
});

test('visual waits return a condition result, invalidate prior coordinates and never renew ownership', async () => {
  let now = 0;
  const leases = new Leases({ now: () => now });
  const nest = fakeNest({ async wait(n, options) { nest.calls.push(['wait', n, options]); return { satisfied: true, reason: 'still', elapsed_ms: 25 }; } });
  const { call } = await connect(nest, leases);
  const { handle } = (await call('claim')).structuredContent;
  const frame = (await call('observe', { handle })).structuredContent.frame_id;
  now = 1000;
  const result = await call('wait', { handle, ms: 1000, mode: 'still', quiet_ms: 200 });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.satisfied, true);
  assert.equal(leases.status()[0].lastActivityAt, 0);
  assert.equal((await call('click', { handle, frame_id: frame, x: 1, y: 2 })).isError, true);
  assert.deepEqual(nest.calls.find(entry => entry[0] === 'wait'), ['wait', 1, { mode: 'still', timeout_ms: 1000, quiet_ms: 200 }]);
});

test('a visual timeout is reported as unmet, and a restarted desktop cannot satisfy an old wait', async () => {
  let instance = 'original';
  const nest = fakeNest({ instance: () => instance, async wait() { return { satisfied: false, reason: 'timeout', elapsed_ms: 50 }; } });
  const { call } = await connect(nest);
  const { handle } = (await call('claim')).structuredContent;
  const result = await call('wait', { handle, ms: 50, mode: 'change' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.satisfied, false);
  nest.wait = async () => { instance = 'replacement'; return { satisfied: true, reason: 'still', elapsed_ms: 10 }; };
  const replaced = await call('wait', { handle, ms: 50 });
  assert.equal(replaced.isError, true);
  assert.match(replaced.content[0].text, /restarted/i);
});

test('window references stay within the observed generation and require fresh frames for actions', async () => {
  let instance = 'first';
  const nest = fakeNest({ instance: () => instance, window: async (...args) => { nest.calls.push(['window', ...args]); return { satisfied: true }; } });
  nest.win = [{ address: '0x123', pid: 12, title: 'Owned', class: 'fixture', x: 100, y: 50, w: 300, h: 200 }];
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const seen = (await call('observe', { handle })).structuredContent;
  assert.ok(seen.windows[0].window_id);
  assert.equal(seen.windows[0].address, undefined);
  assert.equal((await call('window', { handle, frame_id: seen.frame_id, window_id: '0x123', action: 'close' })).isError, true);
  assert.equal((await call('window', { handle, frame_id: seen.frame_id, window_id: seen.windows[0].window_id, action: 'focus' })).isError, undefined);
  assert.equal((await call('window', { handle, frame_id: seen.frame_id, window_id: seen.windows[0].window_id, action: 'close' })).isError, true);
  instance = 'replacement';
  const stale = await call('observe', { handle, window_id: seen.windows[0].window_id });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Stale or foreign window/);
});

test('window capture discloses visible-region bounds and bursts return ordered evidence with one final frame', async () => {
  const nest = fakeNest();
  nest.win = [{ address: '0x1', title: 'fixture', class: 'test', x: -20, y: 50, w: 400, h: 200 }];
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const first = (await call('observe', { handle })).structuredContent;
  const burst = await call('observe', { handle, window_id: first.windows[0].window_id, frames: 3, interval_ms: 100 });
  assert.equal(burst.isError, undefined);
  assert.equal(burst.content.filter(c => c.type === 'image').length, 3);
  assert.equal(burst.structuredContent.capture_kind, 'visible_window_region');
  assert.deepEqual(burst.structuredContent.frames[0].bounds, { x: 0, y: 50, width: 380, height: 200 });
  assert.equal(burst.structuredContent.coordinate_space, 'desktop');
  assert.ok(burst.structuredContent.frames[2].elapsed_ms >= 190);
  assert.equal((await call('click', { handle, frame_id: first.frame_id, x: 1, y: 1 })).isError, true);
  assert.equal((await call('click', { handle, frame_id: burst.structuredContent.frame_id, x: 1, y: 1 })).isError, undefined);
  assert.equal((await call('observe', { handle, frames: 12, interval_ms: 1000 })).isError, true);
  assert.equal((await call('observe', { handle, mystery: true })).isError, true);
});

test('new held input needs an observation while cleanup remains possible after frame consumption', async () => {
  let held = { keys: [], buttons: [] };
  const nest = fakeNest({ heldState: () => held, heldInput: async (_n, args) => { held = { keys: args.keys, buttons: args.buttons }; return held; } });
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  assert.equal((await call('held_input', { handle, keys: ['w'], buttons: [] })).isError, true);
  const { frame_id } = (await call('observe', { handle })).structuredContent;
  assert.equal((await call('held_input', { handle, frame_id, keys: ['w'], buttons: ['left'], timeout_ms: 1000 })).isError, undefined);
  assert.equal((await call('held_input', { handle, keys: ['w', 'Shift_L'], buttons: [] })).isError, true);
  assert.equal((await call('held_input', { handle, keys: [], buttons: [] })).isError, undefined);
  assert.deepEqual(held, { keys: [], buttons: [] });
});

test('accessibility uses the owned resolved window and never produces a coordinate frame', async () => {
  const nest = fakeNest({ accessibility: async (_n, options) => { assert.equal(options.window.pid, 12); assert.deepEqual(options.window.bounds, { x: 100, y: 50, width: 300, height: 200 }); return { status: 'available', nodes: [{ role: 'push button', name: 'Save' }] }; } });
  nest.win = [{ address: '0x123', pid: 12, title: 'Owned', class: 'fixture', x: 100, y: 50, w: 300, h: 200 }];
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const { windows } = (await call('windows', { handle })).structuredContent;
  const result = await call('observe', { handle, mode: 'accessibility', window_id: windows[0].window_id, name: 'Save' });
  assert.equal(result.structuredContent.status, 'available');
  assert.equal(result.structuredContent.frame_id, undefined);
  assert.equal((await call('click', { handle, frame_id: 'guessed', x: 1, y: 1 })).isError, true);
});

test('release interrupts a blocked capture before stopping its desktop', async () => {
  let capturing;
  const started = new Promise(resolve => { capturing = resolve; });
  const nest = fakeNest({ capture: (_n, options) => new Promise((_, reject) => { capturing(); options.signal.addEventListener('abort', () => reject(new Error('Capture cancelled')), { once: true }); }) });
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const capture = call('observe', { handle, frames: 12 });
  await started;
  const release = call('release', { handle });
  assert.equal((await capture).isError, true);
  assert.equal((await release).isError, undefined);
  assert.equal(nest.readyDesktops.size, 0);
});

test('cancellation during the final window inventory cannot mint a successful frame', async () => {
  let inventoryStarted, finishInventory;
  const started = new Promise(resolve => { inventoryStarted = resolve; });
  const pending = new Promise(resolve => { finishInventory = resolve; });
  const nest = fakeNest({ windows: async () => { inventoryStarted(); return pending; } });
  const { call } = await connect(nest);
  const { handle } = (await call('claim', {})).structuredContent;
  const capture = call('observe', { handle });
  await started;
  const release = call('release', { handle });
  await new Promise(resolve => setImmediate(resolve));
  finishInventory([]);
  assert.equal((await capture).isError, true);
  assert.equal((await release).isError, undefined);
});
