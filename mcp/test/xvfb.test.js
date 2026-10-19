import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createXvfb, desktopPaths } from '../lib/xvfb.js';
import { createViewerStreams } from '../lib/viewer-streams.js';

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), 'desktop-xvfb-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const paths = desktopPaths(state, 1);
  mkdirSync(paths.dir, { recursive: true });
  const info = { display: ':123', port: 15901, password: 'private-vnc', bus: 'unix:path=/test-bus', instance: 'first-supervisor' };
  const save = () => writeFileSync(paths.info, JSON.stringify(info)); save();
  const calls = [];
  let stopped = true;
  const backend = createXvfb({ state, execute: async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'xprop') return { stdout: '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x123' };
    if (cmd === 'systemctl') return { stdout: args.includes('LoadState') ? 'loaded' : stopped ? 'inactive' : 'active' };
    return { stdout: 'ok', stderr: '' };
  }, probe: async port => port === info.port });
  return { backend, state, info, calls, save, failStop: () => { stopped = false; } };
}

test('headless desktop starts an independent supervised session and survives backend recreation', async t => {
  const f = fixture(t);
  await f.backend.start(1);
  const call = f.calls.find(c => c.cmd === 'systemd-run');
  assert.ok(call.args.includes('--unit=pm-agent-desktop-1.service'));
  assert.ok(call.args.includes('Restart=on-failure'));
  assert.ok(call.args.includes('systemd-inhibit'));
  assert.ok(call.args.includes('--what=idle'));
  assert.ok(call.args.includes('--what=sleep'));
  assert.equal(call.args.filter(arg => arg === 'systemd-inhibit').length, 2);
  assert.ok(call.args.includes('dbus-run-session'));
  assert.ok(call.args.some(s => s.endsWith('/mcp/lib/xvfb-supervisor.js')));
  assert.deepEqual(call.args.slice(-3), [f.state, '1', '15901']);
  assert.equal(createXvfb({ state: f.state }).instance(1), 'first-supervisor');
  f.info.instance = 'replacement-supervisor'; f.save();
  assert.equal(f.backend.instance(1), 'replacement-supervisor');
  assert.deepEqual(await f.backend.health(1), { display: true, windows: true, vnc: true });
});

test('headless managed apps use only their private X display and stop with their own desktop', async t => {
  const f = fixture(t);
  await f.backend.open(1, ['brave', 'https://example.test']);
  const call = f.calls.find(c => c.cmd === 'systemd-run');
  for (const value of ['BindsTo=pm-agent-desktop-1.service', 'After=pm-agent-desktop-1.service', 'DISPLAY=:123', 'XDG_SESSION_TYPE=x11', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test-bus', '--ozone-platform=x11']) assert.ok(call.args.includes(value), value);
  assert.ok(call.args.includes(`XAUTHORITY=${desktopPaths(f.state, 1).auth}`));
  assert.ok(call.args.includes(`--user-data-dir=${f.state}/profiles/1/brave-browser`));
  assert.ok(call.args.includes('WAYLAND_DISPLAY'));
  assert.ok(call.args.includes('HYPRLAND_INSTANCE_SIGNATURE'));
  await assert.rejects(f.backend.open(1, ['brave', '--user-data-dir=/foreign']), /profile/);
  await f.backend.stop(1);
  f.failStop();
  await assert.rejects(f.backend.stop(1), /did not stop/);
});

test('Xvfb streaming reuses its authenticated loopback VNC without starting WayVNC', async t => {
  const f = fixture(t);
  const streams = createViewerStreams({ nest: f.backend, wayland: false, spawnProcess: () => { throw Error('must not launch WayVNC'); } });
  const stream = await streams.acquire(1, 'lease-generation');
  assert.deepEqual(stream.endpoint, { host: '127.0.0.1', port: 15901 });
  await stream.release(); await streams.close();
  assert.equal(f.backend.info(1).password, 'private-vnc');
  assert.throws(() => createXvfb({ state: f.state, portBase: 80 }), /port base/);
  assert.throws(() => createXvfb({ state: f.state, prefix: '../foreign' }), /prefix/);
});
