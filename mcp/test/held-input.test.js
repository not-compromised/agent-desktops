import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createHeldInput } from '../lib/held-input.js';

function fixture({ fail, quarantine = async () => {} } = {}) {
  const calls = [], children = [], stopped = [];
  const start = (file, argv, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = [];
    child.kill = signal => { child.killed.push(signal); return true; };
    child.stdin = new Writable({ write(buffer, _encoding, callback) {
      const [kind, ...hex] = buffer.toString().trim().split(' ');
      const args = hex.map(h => h === '-' ? '' : Buffer.from(h, 'hex').toString());
      calls.push([kind, ...args]);
      queueMicrotask(() => child.stdout.write(fail?.(kind, args) ? 'error rejected command\n' : 'ok\n'));
      callback();
    }});
    children.push({ file, argv, options, child });
    return child;
  };
  const held = createHeldInput({ start, env: (n, instance) => ({ SELECTED: `${n}:${instance}` }),
    quarantine: async (...args) => { stopped.push(args); await quarantine(...args); } });
  return { held, calls, children, stopped };
}

test('held keys and buttons survive ordinary commands and exact replacement preserves one resident device owner', async () => {
  const { held, calls, children } = fixture();
  const first = await held.set(2, { keys: ['Control_L'], buttons: ['left'], timeout_ms: 1000 }, 'generation');
  assert.deepEqual(first.keys, ['Control_L']);
  assert.equal(held.active(2), true);
  const state = held.state(2);
  assert.deepEqual(state.keys, ['Control_L']);
  state.keys.push('a');
  assert.deepEqual(held.state(2).keys, ['Control_L']);
  await held.command(2, 'move', [100, 200], 'generation');
  await held.command(2, 'key', ['a'], 'generation');
  await held.set(2, { keys: ['Shift_L'], buttons: ['left'], timeout_ms: 1000 }, 'generation');
  assert.equal(children.length, 1);
  assert.equal(children[0].options.env.AGENT_DESKTOP_INSTANCE, 'generation');
  assert.equal(children[0].options.env.SELECTED, '2:generation');
  assert.deepEqual(calls.slice(0, 3), [['SET', '1000', 'Control_L', 'left'], ['MOVE', '100', '200'], ['KEY', 'a']]);
  const released = await held.set(2, { keys: [], buttons: [] }, 'generation');
  assert.deepEqual(released, { keys: [], buttons: [], expires_at: null });
  assert.equal(held.active(2), false);
  await held.closeAll();
});

test('a hold expires without another caller and ordinary commands never extend its watchdog', async () => {
  const { held, calls } = fixture();
  await held.set(1, { keys: ['a'], timeout_ms: 100 }, 'g');
  await held.command(1, 'move', [20, 30], 'g');
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(held.active(1), false);
  assert.deepEqual(calls.at(-1), ['RELEASE']);
  await held.closeAll();
});

test('old-generation commands never reach the resident helper', async () => {
  const { held, calls } = fixture();
  await held.set(1, { keys: ['a'] }, 'old');
  await assert.rejects(held.command(1, 'move', [1, 2], 'new'), /generation changed/);
  await assert.rejects(held.set(1, { keys: ['b'] }, 'new'), /generation changed/);
  await assert.rejects(held.release(1, 'new'), /generation changed/);
  assert.equal(calls.length, 1);
  await held.release(1, 'old');
});

test('input failure quarantines the owned generation before returning and blocks reuse until confirmed stop', async () => {
  let finish;
  const { held, stopped, children } = fixture({ fail: kind => kind === 'KEY', quarantine: () => new Promise(resolve => { finish = resolve; }) });
  await held.set(1, { keys: ['Control_L'] }, 'g');
  let returned = false;
  const failed = held.command(1, 'key', ['a'], 'g').catch(e => { returned = true; throw e; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  assert.equal(stopped[0][0], 1); assert.equal(stopped[0][1], 'g');
  const replacement = held.set(1, { keys: ['b'] }, 'next');
  assert.equal(children.length, 1);
  finish();
  await assert.rejects(failed, /rejected command/);
  await replacement;
  assert.equal(children.length, 2);
  await held.closeAll();
});

test('uncertain cleanup keeps the desktop blocked and a confirmed guardian close needs no quarantine', async () => {
  const { held, children, stopped } = fixture({ quarantine: async () => { throw new Error('stop unconfirmed'); } });
  await held.set(1, { keys: ['a'] }, 'g');
  children[0].child.emit('exit', 9, 'SIGKILL');
  await assert.rejects(held.set(1, { keys: ['b'] }, 'next'), /stop unconfirmed/);
  assert.equal(stopped.length, 1);
  assert.equal(children.length, 1);
  await assert.rejects(held.release(1, 'g'), /stop unconfirmed/);
  await assert.rejects(held.closeAll(), /cleanup failed/);
  const safe = fixture();
  await safe.held.set(2, { buttons: ['left'] }, 'g');
  safe.children[0].child.stdout.write('expired\nclosed\n');
  safe.children[0].child.emit('exit', 0, null);
  assert.equal(safe.held.active(2), false);
  assert.equal(safe.stopped.length, 0);
});

test('invalid and unbounded holds never create a native connection', async () => {
  const { held, children } = fixture();
  for (const state of [{ keys: ['a', 'a'] }, { keys: ['--hold'] }, { buttons: ['extra'] }, { timeout_ms: 30001 }, { timeout_ms: 0 }]) {
    await assert.rejects(held.set(1, state, 'g'));
  }
  await assert.rejects(held.set(0, { keys: ['a'] }, 'g'), /owned desktop/);
  await assert.rejects(held.set(1, { keys: ['a'] }, ''), /generation/);
  assert.equal(children.length, 0);
});

test('only a backend-confirmed desktop stop permits reuse after uncertain cleanup', async () => {
  const { held, children } = fixture({ quarantine: async () => { throw new Error('stop unconfirmed'); } });
  await held.set(1, { keys: ['a'] }, 'old');
  children[0].child.emit('exit', 9, 'SIGKILL');
  await assert.rejects(held.release(1), /stop unconfirmed/);
  await assert.rejects(held.set(1, { keys: [] }, 'old'), /stop unconfirmed/);
  assert.equal(children.length, 1);
  held.confirmStopped(1);
  assert.deepEqual(held.state(1), { keys: [], buttons: [], expires_at: null });
  await held.set(1, { keys: ['b'] }, 'replacement');
  assert.equal(children.length, 2);
  assert.equal(children[1].options.env.AGENT_DESKTOP_INSTANCE, 'replacement');
  await held.closeAll();
});
