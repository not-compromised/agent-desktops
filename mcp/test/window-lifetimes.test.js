import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWindowLifetimes } from '../lib/window-lifetimes.js';

function fixture({ race, timeout_ms = 1000, backend = 'wayland', geometry } = {}) {
  const children = [], calls = [];
  let epoch = 1, revision = 0, generation = 'generation';
  const owner = createWindowLifetimes({ backend, timeout_ms, env: () => ({}), instance: () => generation, start: (_file, _args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({ write(data, _, done) {
      const request = JSON.parse(data.toString());
      calls.push(request);
      queueMicrotask(() => {
        race?.(request, () => { revision++; epoch++; });
        child.stdout.write(JSON.stringify({ id: request.id, revision,
          epochs: Object.fromEntries(request.addresses.map(a => [a, `${options.env.AGENT_DESKTOP_INSTANCE}:${epoch}`])), ...(geometry ? { geometry: geometry(request.addresses) } : {}) }) + '\n');
      }); done();
    }});
    children.push(child); queueMicrotask(() => child.stdout.write('{"event":"ready"}\n')); return child;
  } });
  return { owner, children, calls, replace: () => { epoch++; revision++; }, generation: next => { generation = next; } };
}
const window = { address: '0x00000a', pid: 42, title: 'same application' };

test('same-process address reuse receives a new lifetime even when other window fields match', async () => {
  const f = fixture();
  const first = (await f.owner.inventory(1, async () => [window], 'generation'))[0];
  assert.equal((await f.owner.inventory(1, async () => [window], 'generation'))[0].lifetime, first.lifetime);
  f.replace();
  const replacement = (await f.owner.inventory(1, async () => [window], 'generation'))[0];
  assert.notEqual(replacement.lifetime, first.lifetime);
  assert.equal(replacement.pid, first.pid);
  assert.equal(f.children.length, 1);
  f.owner.closeAll();
});

test('subscription precedes inventory and a close/create race repeats the entire inventory', async () => {
  let replace = true, reads = 0;
  const f = fixture({ race: (request, change) => { if (request.addresses.length && replace) { replace = false; change(); } } });
  const result = await f.owner.inventory(1, async () => { reads++; assert.equal(f.children.length, 1); return [window]; }, 'generation');
  assert.equal(reads, 2);
  assert.equal(result[0].lifetime, 'generation:2');
  f.owner.closeAll();
});

test('event connection loss fails closed and cannot silently mint replacement references', async () => {
  const f = fixture();
  await f.owner.inventory(1, async () => [window], 'generation');
  f.children[0].emit('exit', 1);
  await assert.rejects(f.owner.inventory(1, async () => [window], 'generation'), /connection was lost/);
  assert.equal(f.children.length, 1);
  f.generation('replacement');
  const result = await f.owner.inventory(1, async () => [window], 'replacement');
  assert.equal(result[0].lifetime, 'replacement:1');
  assert.equal(f.children.length, 2);
  f.owner.closeAll();
});

test('inventory races and stuck readers have bounded failure', async () => {
  const f = fixture({ race: (request, change) => { if (request.addresses.length) change(); } });
  await assert.rejects(f.owner.inventory(1, async () => [window], 'generation'), /changed during inventory/);
  assert.equal(f.calls.length, 6);
  f.owner.closeAll();
  const slow = fixture({ timeout_ms: 30 });
  let signal;
  await assert.rejects(slow.owner.inventory(1, abortSignal => { signal = abortSignal; return new Promise(() => {}); }, 'generation'), /time budget/);
  assert.equal(signal.aborted, true);
  slow.owner.closeAll();
});

test('desktop replacement during inventory never returns old content', async () => {
  const f = fixture();
  await assert.rejects(f.owner.inventory(1, async () => { f.generation('new'); return [window]; }, 'generation'), /Desktop changed/);
  f.owner.closeAll();
});


test('Xvfb inventory uses true client-root bounds rather than old xdotool frame offsets', async () => {
  for (const [x, y, offsetX, offsetY] of [[100, 100, 1, 20], [0, 0, 1, 20], [1560, 640, 1, 20],
    [100, 100, 0, 0], [0, 0, 0, 0], [1560, 640, 0, 0]]) {
    const f = fixture({ backend: 'xvfb', geometry: addresses => Object.fromEntries(addresses.map(a => [a, { x, y, w: 1000, h: 800 }])) });
    try {
      const result = await f.owner.inventory(1, async () => [{ ...window, x: x + offsetX, y: y + offsetY, w: 1000, h: 800 }], 'generation');
      assert.deepEqual({ x: result[0].x, y: result[0].y, w: result[0].w, h: result[0].h }, { x, y, w: 1000, h: 800 });
    } finally { f.owner.closeAll(); }
  }
});


test('Xvfb inventory fails closed on missing, partial or invalid client geometry', async () => {
  for (const geometry of [() => undefined, () => ({}), () => ({ '0xa': { x: 0, y: 0, w: 0, h: 800 } }),
    () => ({ '0xa': { x: 0.5, y: 0, w: 1000, h: 800 } }),
    () => ({ '0xa': { x: 0, y: 0, w: 1000, h: 800, pid: 99 } }),
    () => ({ '0xb': { x: 0, y: 0, w: 1000, h: 800 } })]) {
    const f = fixture({ backend: 'xvfb', geometry });
    try {
      await assert.rejects(f.owner.inventory(1, async () => [window], 'generation'), /client geometry/);
    } finally { f.owner.closeAll(); }
  }
});


test('empty Xvfb inventory still requires a geometry object', async () => {
  const f = fixture({ backend: 'xvfb', geometry: () => [] });
  try {
    await assert.rejects(f.owner.inventory(1, async () => [], 'generation'), /client geometry/);
  } finally { f.owner.closeAll(); }
});
