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
  assert.ok(call.args.includes('KillMode=control-group'));
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

test('Xvfb move/resize preserves requested client bounds with Openbox decorations', async t => {
  const f = fixture(t);
  let client = { address: '0x123', pid: 42, x: 30, y: 40, w: 300, h: 200 };
  const actions = [];
  const backend = createXvfb({ state: f.state, execute: async (cmd, args) => {
    actions.push({ cmd, args });
    if (cmd === 'xdotool') {
      const size = args.indexOf('windowsize'), move = args.indexOf('windowmove');
      if (size >= 0) { client.w = Number(args[size + 2]); client.h = Number(args[size + 3]); }
      if (move >= 0) { client.x = Number(args[move + 2]) + 1; client.y = Number(args[move + 3]) + 20; }
    } else if (cmd === 'wmctrl' && args.includes('-e')) {
      const [gravity, x, y, w, h] = args[args.indexOf('-e') + 1].split(',').map(Number);
      // EWMH StaticGravity positions the client origin, regardless of the
      // frame's 1px border and 20px titlebar observed in the real Openbox control.
      assert.equal(gravity, 10);
      client = { ...client, x, y, w, h };
    }
    return { stdout: '', stderr: '' };
  } });
  backend.windows = async () => [{ ...client }];
  for (const [x, y] of [[100, 100], [0, 0], [1560, 640]]) {
    const result = await backend.window(1, client, { action: 'move_resize', x, y, width: 1000, height: 800 }, f.info.instance);
    assert.deepEqual(result.bounds, { x, y, width: 1000, height: 800 });
  }
  assert.equal(actions.length, 3);
});

test('Xvfb refuses invalid client rectangles before moving or resizing', async t => {
  const f = fixture(t);
  f.backend.windows = async () => { throw new Error('Invalid geometry reached window verification'); };
  const before = f.calls.length;
  for (const bounds of [{ x: -1, y: 0, width: 100, height: 100 },
    { x: 2500, y: 0, width: 100, height: 100 }, { x: 0, y: 1400, width: 100, height: 100 },
    { x: 0, y: 0, width: 0, height: 100 }, { x: 0.5, y: 0, width: 100, height: 100 }]) {
    await assert.rejects(f.backend.window(1, { address: '0x123', pid: 42 }, { action: 'move_resize', ...bounds }, f.info.instance), /client bounds/);
  }
  assert.equal(f.calls.length, before);
});
