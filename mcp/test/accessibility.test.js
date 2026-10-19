import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessibility } from '../lib/accessibility.js';

const context = async () => ({
  instance: 'generation-one',
  env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/owned-session' },
  desktop_cgroup: '/user.slice/agent-desktop-1.service',
  apps: [{ unit: 'app-exact.service', cgroup: '/user.slice/app-exact.service', invocation_id: 'launch-one' }]
});
const options = extra => ({ context, instance: () => 'generation-one', ...extra });

test('queries receive only the selected generation and exact registered app identities', async () => {
  let request;
  const a11y = createAccessibility(options({ execute: async (_helper, data) => {
    request = data;
    return { status: 'available', nodes: [{ role: 'push button', name: 'Save' }], truncated: false };
  } }));
  const result = await a11y.query(1, { role: 'push button', name: 'Save', max_nodes: 20 }, 'generation-one');
  assert.equal(result.status, 'available');
  assert.equal(request.max_nodes, 20);
  assert.equal(request.desktop_cgroup, '/user.slice/agent-desktop-1.service');
  assert.deepEqual(request.apps, (await context()).apps);
});

test('missing private bus or managed registry cannot query the helper', async () => {
  for (const scoped of [{ ...await context(), env: {} }, { ...await context(), apps: [] }]) {
    const a11y = createAccessibility(options({ context: async () => scoped,
      execute: async () => { throw new Error('helper must not run'); } }));
    const result = await a11y.query(1, {}, 'generation-one');
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.nodes, []);
    assert.doesNotMatch(result.reason, /helper must not run/);
  }
});

test('generation change discards content returned by the old helper', async () => {
  let generation = 'generation-one';
  const a11y = createAccessibility(options({ instance: () => generation, execute: async () => {
    generation = 'generation-two';
    return { status: 'available', nodes: [{ name: 'old content' }] };
  } }));
  const result = await a11y.query(1, {}, 'generation-one');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.nodes, []);
  assert.match(result.reason, /generation changed/);
});

test('stale context and absent expected generation are refused', async () => {
  const a11y = createAccessibility(options({ execute: async () => { throw new Error('must not run'); } }));
  assert.equal((await a11y.query(1, {}, 'generation-two')).status, 'unavailable');
  assert.equal((await a11y.query(1, {})).status, 'unavailable');
  const stale = createAccessibility(options({ context: async () => ({ ...await context(), instance: 'old' }) }));
  assert.equal((await stale.query(1, {}, 'generation-one')).status, 'unavailable');
});

test('context lookup is included in the total deadline', async () => {
  const a11y = createAccessibility(options({ context: () => new Promise(() => {}) }));
  const started = performance.now();
  const result = await a11y.query(1, { timeout_ms: 30 }, 'generation-one');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /timed out/);
  assert.ok(performance.now() - started < 500);
});

test('caller cannot raise tree or deadline limits', async () => {
  const a11y = createAccessibility(options());
  for (const query of [{ max_nodes: 501 }, { max_depth: 17 }, { timeout_ms: 10001 }, { name: 'x'.repeat(513) }])
    await assert.rejects(a11y.query(1, query, 'generation-one'));
});

async function fixture(t, program) {
  const root = await mkdtemp(join(tmpdir(), 'agent-a11y-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = join(root, 'helper.py');
  await writeFile(helper, program);
  return helper;
}

test('real helper subprocess has a hard timeout', async t => {
  const helper = await fixture(t, 'import time\ntime.sleep(60)\n');
  const a11y = createAccessibility(options({ helper }));
  const started = performance.now();
  const result = await a11y.query(1, { timeout_ms: 100 }, 'generation-one');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /timed out/);
  assert.ok(performance.now() - started < 1000);
});

test('real helper subprocess cannot exceed the output cap', async t => {
  const helper = await fixture(t, 'import sys\nsys.stdout.write("x"*250000)\n');
  const a11y = createAccessibility(options({ helper }));
  const result = await a11y.query(1, {}, 'generation-one');
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /byte limit/);
});

test('helper does not inherit the host accessibility address or Wayland connection', async t => {
  const helper = await fixture(t, 'import os,json\nprint(json.dumps({"status":"available","nodes":[],"truncated":False,"leaked":any(k in os.environ for k in ["AT_SPI_BUS_ADDRESS","WAYLAND_SOCKET"])}))\n');
  const a11y = createAccessibility(options({ helper, context: async () => ({ ...await context(),
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/owned-session', AT_SPI_BUS_ADDRESS: 'unix:path=/host', WAYLAND_SOCKET: '3' } }) }));
  const result = await a11y.query(1, {}, 'generation-one');
  assert.equal(result.status, 'available');
  assert.equal(result.leaked, false);
});

test('actual helper reports unavailable without a private session', async () => {
  const a11y = createAccessibility(options({ context: async () => ({ ...await context(),
    env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent-agent-test-bus' } }) }));
  const result = await a11y.query(1, {}, 'generation-one');
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.nodes, []);
});

test('context lookup stops spawning work after its total query deadline', async () => {
  const { createManagedApps } = await import('../lib/managed-apps.js');
  let calls = 0;
  const registry = createManagedApps({ unit: n => `desktop-${n}.service`, instance: () => 'generation', env: () => ({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture' }), execute: async (_cmd, args, options) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 12);
      if (options.signal?.aborted) { clearTimeout(timer); reject(new Error('aborted')); }
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
    });
    return { stdout: `ActiveState=active\nControlGroup=/owned/${args[2]}\nInvocationID=original\nBindsTo=desktop-1.service\n` };
  } });
  for (let i = 0; i < 8; i++) await registry.activated(1, registry.allocate(1));
  const a11y = createAccessibility({ context: registry.context, instance: () => 'generation' });
  assert.equal((await a11y.query(1, { timeout_ms: 25 }, 'generation')).status, 'unavailable');
  const stoppedAt = calls;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, stoppedAt, 'no more unit queries start after the reported timeout');
});
