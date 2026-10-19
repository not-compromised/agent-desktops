import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Settings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { Leases } from '../lib/leases.js';
import { createLifecycle } from '../lib/lifecycle.js';

test('host settings persist with private permissions and reject invalid updates without changing saved values', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'desktop-settings-')), 'settings.json');
  const settings = new Settings({ file });
  assert.deepEqual(settings.read(), DEFAULT_SETTINGS);
  settings.update({ idleMinutes: 15, viewerStartup: 'notify' });
  assert.equal(new Settings({ file }).read().idleMinutes, 15);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const patch of [{ idleMinutes: 0 }, { idleMinutes: 1.5 }, { streamQuality: 'bad' }, { unknown: 1 }]) assert.throws(() => settings.update(patch));
  assert.equal(settings.read().idleMinutes, 15);
  writeFileSync(file, '{bad');
  assert.throws(() => new Settings({ file }), /settings/i);
});

test('changing inactivity duration updates live desktops but cannot resurrect retained expired desktops after restart', () => {
  let now = 0;
  const dir = mkdtempSync(join(tmpdir(), 'desktop-timers-'));
  const settings = new Settings({ file: join(dir, 'settings.json') });
  const leases = new Leases({ file: join(dir, 'leases.json'), now: () => now, idleMs: 60000 });
  const old = leases.claim('expired'); now = 61000;
  const recent = leases.claim('live');
  const lifecycle = createLifecycle({ leases, settings, nest: {} });
  lifecycle.updateSettings({ idleMinutes: 60 });
  assert.equal(leases.live(old), false);
  assert.equal(leases.live(recent), true);
  assert.equal(leases.status().find(d => d.desktop === recent.desktop).closesAt, 3661000);
  const restarted = new Leases({ file: join(dir, 'leases.json'), now: () => now, idleMs: settings.read().idleMinutes * 60000 });
  assert.equal(restarted.live(restarted.byHandle.get(old.handle)), false);
});

test('watching does not renew; actual input and timed hold do, but stale and expired identities cannot revive', async () => {
  let now = 0;
  const leases = new Leases({ now: () => now, idleMs: 60000 });
  const lifecycle = createLifecycle({ leases, nest: { start: async () => {}, stop: async () => {} } });
  const l = await lifecycle.claim('a'); now = 30000;
  await lifecycle.run(l.handle, async () => {}, { activity: false });
  assert.equal(leases.status()[0].lastActivityAt, 0);
  await lifecycle.activity(l.desktop, l.generation);
  assert.equal(leases.status()[0].closesAt, 90000);
  await lifecycle.keepOpen(l.desktop, l.generation, 10);
  assert.equal(leases.status()[0].keepOpenUntil, 630000);
  await assert.rejects(lifecycle.keepOpen(l.desktop, 'stale', 10), /ended/);
  await lifecycle.keepOpen(l.desktop, l.generation, 0);
  now = 90001;
  await assert.rejects(lifecycle.activity(l.desktop, l.generation), /ended/);
  await assert.rejects(lifecycle.keepOpen(l.desktop, l.generation, 10), /ended/);
});

test('failed preferences write preserves effective duration and preferences', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-write-'));
  const blocked = join(dir, 'blocked'); writeFileSync(blocked, 'not a directory');
  const settings = new Settings(); settings.file = join(blocked, 'settings.json');
  const leases = new Leases({ idleMs: 1800000 });
  const lifecycle = createLifecycle({ leases, settings, nest: {} });
  assert.throws(() => lifecycle.updateSettings({ idleMinutes: 5 }));
  assert.equal(settings.read().idleMinutes, 30);
  assert.equal(leases.idleMs, 1800000);
});

test('queued manual close wins over later keep-open change', async () => {
  const leases = new Leases();
  const lifecycle = createLifecycle({ leases, nest: { start: async () => {}, stop: async () => {} } });
  const l = await lifecycle.claim('owned');
  const close = lifecycle.closeDesktop(l.desktop, l.generation);
  const hold = lifecycle.keepOpen(l.desktop, l.generation, 10);
  await close; await assert.rejects(hold, /ended/);
  assert.equal(leases.status().length, 0);
});

test('changing duration during a running action does not freeze its eventual renewal', async () => {
  let now = 0, finish, started;
  const leases = new Leases({ now: () => now, idleMs: 60000 });
  const lifecycle = createLifecycle({ leases, settings: new Settings(), nest: { start: async () => {}, stop: async () => {} } });
  const l = await lifecycle.claim('work');
  const ready = new Promise(resolve => { started = resolve; });
  const work = lifecycle.run(l.handle, () => { started(); return new Promise(resolve => { finish = resolve; }); });
  await ready; now = 120000;
  lifecycle.updateSettings({ idleMinutes: 60 });
  finish(); await work;
  assert.equal(leases.live(l), true);
  assert.equal(leases.status()[0].closesAt, 3720000);
});
