import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Leases } from '../lib/leases.js';
import { createLifecycle } from '../lib/lifecycle.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('slow work on one desktop does not block another; release waits for its own work', async () => {
  const stopped = [];
  const leases = new Leases();
  const lifecycle = createLifecycle({ leases, nest: { start: async () => {}, stop: async n => stopped.push(n) } });
  const a = await lifecycle.claim('a');
  const b = await lifecycle.claim('b');
  stopped.length = 0;
  const started = gate();
  const finish = gate();
  const work = lifecycle.run(a.handle, async () => { started.resolve(); await finish.promise; });
  await started.promise;
  const release = lifecycle.release(a.handle);
  await lifecycle.run(b.handle, async () => {});
  assert.deepEqual(stopped, []);
  finish.resolve();
  await work;
  await release;
  assert.deepEqual(stopped, [a.desktop]);
});

test('idle sweep rechecks activity after an in-flight operation renews its lease', async () => {
  let now = 0;
  const stopped = [];
  const leases = new Leases({ now: () => now, idleMs: 1000 });
  const lifecycle = createLifecycle({ leases, nest: { start: async () => {}, stop: async n => stopped.push(n) } });
  const a = await lifecycle.claim('a');
  stopped.length = 0;
  const started = gate();
  const finish = gate();
  const work = lifecycle.run(a.handle, async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  now = 1001;
  const reaped = lifecycle.reap();
  finish.resolve();
  await work;
  await reaped;
  assert.deepEqual(stopped, []);
  assert.equal(leases.byHandle.has(a.handle), true);
});

test('host announces before opening and reports closure after the managed desktop stops', async () => {
  const events = [];
  const lifecycle = createLifecycle({
    leases: new Leases(),
    nest: { start: async () => events.push('start'), stop: async () => events.push('stop') },
    notify: async title => events.push(title)
  });
  const lease = await lifecycle.claim('sandboxed agent');
  assert.deepEqual(events, ['Opening an agent desktop', 'stop', 'start']);
  events.length = 0;
  await lifecycle.release(lease.handle);
  assert.deepEqual(events, ['stop', 'Agent desktop closed']);
});

test('human close waits for owned work, invalidates its handle, and cannot close a reused generation', async () => {
  const leases = new Leases(), stopped = [];
  const lifecycle = createLifecycle({ leases, nest: { start: async () => {}, stop: async n => stopped.push(n) } });
  const a = await lifecycle.claim('a'), b = await lifecycle.claim('b');
  stopped.length = 0;
  const started = gate(), finish = gate();
  const work = lifecycle.run(a.handle, async () => { started.resolve(); await finish.promise; });
  await started.promise;
  const close = lifecycle.closeDesktop(a.desktop, a.generation);
  assert.deepEqual(stopped, []);
  finish.resolve(); await work;
  assert.deepEqual(await close, { desktop: a.desktop, generation: a.generation, closed: true });
  assert.deepEqual(stopped, [a.desktop]);
  assert.equal(leases.byHandle.has(b.handle), true);
  await assert.rejects(lifecycle.run(a.handle, () => {}), /unknown handle/);
  const replacement = await lifecycle.claim('replacement');
  stopped.length = 0;
  await assert.rejects(lifecycle.closeDesktop(a.desktop, a.generation), /ended/);
  assert.equal(leases.byHandle.has(replacement.handle), true);
  assert.deepEqual(stopped, []);
});

test('failed human shutdown retains ownership for retry', async () => {
  const leases = new Leases(), lease = leases.claim('a');
  let fail = true;
  const lifecycle = createLifecycle({ leases, nest: { stop: async () => { if (fail) throw new Error('stop failed'); } } });
  await assert.rejects(lifecycle.closeDesktop(lease.desktop, lease.generation), /stop failed/);
  assert.equal(leases.byHandle.has(lease.handle), true);
  fail = false;
  await lifecycle.closeDesktop(lease.desktop, lease.generation);
  assert.equal(leases.byHandle.has(lease.handle), false);
});
