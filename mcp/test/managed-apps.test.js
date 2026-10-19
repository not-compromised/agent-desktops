import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagedApps } from '../lib/managed-apps.js';

test('accessibility accepts only exact launched units and rejects an app unit restarted under the same name', async () => {
  let generation = 'one', invocation = 'original';
  const apps = createManagedApps({ unit: n => `desktop-${n}.service`, instance: () => generation,
    env: () => ({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/owned' }), execute: async (_cmd, args) => {
      const desktop = args[2] === 'desktop-1.service';
      return { stdout: `ControlGroup=/owned/${args[2]}\nInvocationID=${desktop ? 'desktop-id' : invocation}\nBindsTo=desktop-1.service\nActiveState=active\n` };
    } });
  const name = apps.allocate(1);
  assert.match(name, /^desktop-1-app-[a-f0-9-]+\.service$/);
  assert.deepEqual((await apps.context(1, 'one')).apps, []);
  await apps.activated(1, name);
  assert.equal((await apps.context(1, 'one')).apps.length, 1);
  invocation = 'restarted';
  assert.deepEqual((await apps.context(1, 'one')).apps, []);
  generation = 'two';
  await assert.rejects(apps.context(1, 'one'), /generation changed/);
  assert.deepEqual((await apps.context(1, 'two')).apps, []);
});
