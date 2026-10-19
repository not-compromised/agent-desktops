import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForFrames } from '../lib/visual-wait.js';

function fixture(frames) {
  let time = 0, index = 0;
  return { capture: async () => Buffer.from(frames[Math.min(index++, frames.length - 1)]),
    now: () => time, sleep: async ms => { time += ms; } };
}

test('still waits restart the quiet interval after a visible change', async () => {
  const result = await waitForFrames({ ...fixture(['a', 'b', 'c', 'c', 'c']), mode: 'still', quiet_ms: 200, timeout_ms: 1000 });
  assert.equal(result.satisfied, true);
  assert.equal(result.elapsed_ms, 400);
});

test('change and settle require an observed change; silence is not success', async () => {
  for (const mode of ['change', 'settle']) {
    assert.equal((await waitForFrames({ ...fixture(['a']), mode, quiet_ms: 100, timeout_ms: 300 })).satisfied, false);
  }
  assert.equal((await waitForFrames({ ...fixture(['a', 'b']), mode: 'change', quiet_ms: 100, timeout_ms: 300 })).elapsed_ms, 100);
  assert.equal((await waitForFrames({ ...fixture(['a', 'b']), mode: 'settle', quiet_ms: 100, timeout_ms: 300 })).elapsed_ms, 200);
});

test('capture failures and empty images cannot be reported as a settled desktop', async () => {
  const options = { mode: 'still', quiet_ms: 50, timeout_ms: 100 };
  await assert.rejects(waitForFrames({ ...options, capture: async () => { throw Error('lost display'); } }), /lost display/);
  await assert.rejects(waitForFrames({ ...options, capture: async () => Buffer.alloc(0) }), /empty/i);
});

test('a slow first screenshot establishes a baseline rather than proving stillness', async () => {
  let time = 0, calls = 0;
  const result = await waitForFrames({ mode: 'still', quiet_ms: 50, timeout_ms: 100,
    now: () => time, sleep: async ms => { time += ms; },
    capture: async () => { calls++; time += 75; return Buffer.from('image'); } });
  assert.equal(result.satisfied, false);
  assert.equal(calls, 2);
});
