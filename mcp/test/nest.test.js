import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNest as realCreateNest, keyArgs, nestEnv } from '../lib/nest.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const createNest = options => realCreateNest({ readSession: () => 'DBUS_SESSION_BUS_ADDRESS=unix:path=/test-private-bus', ...options });

test('key combos use physical-key tokens and cannot start persistent holders or inject helper options', () => {
  assert.deepEqual(keyArgs('Return'), ['Return']);
  assert.deepEqual(keyArgs('enter'), ['Return']);
  assert.deepEqual(keyArgs('ctrl+l'), ['ctrl+l']);
  assert.deepEqual(keyArgs('ctrl+shift+t'), ['ctrl+shift+t']);
  assert.deepEqual(keyArgs('super+Return'), ['super+Return']);
  assert.throws(() => keyArgs('hyper+x'), /unknown modifier/);
  for (const combo of ['--hold', 'down:a', 'ctrl+-t']) assert.throws(() => keyArgs(combo), /invalid key/i);
});

test('every nest command carries only that nest\'s names', () => {
  const e = nestEnv(3);
  assert.equal(e.WAYLAND_DISPLAY, 'wayland-agent-3');
  assert.equal(e.DISPLAY, ':93');
  assert.equal(e.HYPRLAND_INSTANCE_SIGNATURE, 'agent-3');
});

test('full and cropped captures use mutually exclusive grim selectors on the owned compositor', async () => {
  const calls = [];
  const png = Buffer.from('owned screenshot');
  const nest = createNest({ run: async (command, args, options) => {
    assert.equal(command, 'grim');
    if (args.includes('-o') && args.includes('-g')) throw new Error('-o and -g are mutually exclusive');
    calls.push({ args, env: options.env });
    return { stdout: png };
  } });
  assert.equal(await nest.capture(3), png);
  assert.equal(await nest.capture(3, { scale: 0.5, bounds: { x: 100, y: 200, width: 800, height: 600 } }), png);
  assert.ok(calls[0].args.includes('-o'));
  assert.equal(calls[0].args[calls[0].args.indexOf('-o') + 1], 'agent-main');
  assert.ok(!calls[0].args.includes('-g'));
  assert.ok(!calls[1].args.includes('-o'));
  assert.equal(calls[1].args[calls[1].args.indexOf('-g') + 1], '100,200 800x600');
  for (const call of calls) {
    assert.equal(call.env.WAYLAND_DISPLAY, 'wayland-agent-3');
    assert.equal(call.env.HYPRLAND_INSTANCE_SIGNATURE, 'agent-3');
    assert.equal(call.env.AGENT_DESKTOP_OUTPUT, 'agent-main');
    assert.equal(call.env.WAYLAND_SOCKET, undefined);
  }
});

test('cropped captures reject regions outside the owned output before invoking grim', async () => {
  const nest = createNest({ run: async () => { assert.fail('invalid bounds must not reach grim'); } });
  for (const bounds of [{ x: -1, y: 0, width: 10, height: 10 }, { x: 2500, y: 0, width: 100, height: 10 },
    { x: 0, y: 1400, width: 10, height: 100 }, { x: 0, y: 0, width: 0, height: 10 },
    { x: 0.5, y: 0, width: 10, height: 10 }]) {
    await assert.rejects(nest.capture(3, { bounds }), /bounds.*owned output/);
  }
});

test('input on one desktop is serialised, cursor moves precede clicks', async () => {
  const log = [];
  const run = async (cmd, args) => { log.push([cmd, ...args].join(' ')); await new Promise(r => setTimeout(r, 5)); return { stdout: '', stderr: '' }; };
  const nest = createNest({ run, launcher: '/bin/true' });
  await Promise.all([nest.click(1, 10, 20), nest.type(1, 'ab'), nest.key(1, 'ctrl+c')]);
  assert.deepEqual(log, [
    'agent-desktop-pointer --extent 2560x1440 move 10 20 click left',
    'agent-desktop-keyboard --delay 1 -t ab',
    'agent-desktop-keyboard ctrl+c'
  ].map(line => `${new URL('../../native/bin/', import.meta.url).pathname}${line}`));
});

test('native visual wait distinguishes unmet conditions from capture failures', async () => {
  let outcome = 'satisfied still t=120 first=- last=- change=- ignored=- why=- late=- frames=2\n';
  const calls = [];
  const nest = createNest({ run: async (cmd, args, options) => { calls.push({ cmd, args, options });
    if (outcome === 'lost') throw Object.assign(new Error('lost compositor'), { code: 1 });
    if (outcome.startsWith('unsatisfied')) throw Object.assign(new Error('timeout'), { code: 124, stdout: outcome });
    return { stdout: outcome };
  } });
  const options = { mode: 'still', timeout_ms: 1000, quiet_ms: 200 };
  assert.equal((await nest.wait(2, options)).satisfied, true);
  assert.equal(calls[0].options.env.WAYLAND_DISPLAY, 'wayland-agent-2');
  outcome = 'unsatisfied changing t=1000 first=10 last=990 change=0,0,10,10 ignored=- why=- late=- frames=20\n';
  assert.equal((await nest.wait(2, options)).satisfied, false);
  outcome = 'lost';
  await assert.rejects(nest.wait(2, options), /lost compositor/);
});

test('native input uses the compositor generation authorized by its caller', async () => {
  const generations = [];
  const nest = createNest({ run: async (_cmd, _args, options) => { generations.push(options.env.AGENT_DESKTOP_INSTANCE); return { stdout: '' }; } });
  await Promise.all([nest.type(1, 'text', 'validated-instance'), nest.click(1, 10, 20, 'left', 'validated-instance')]);
  assert.deepEqual(generations, ['validated-instance', 'validated-instance']);
});

test('visual wait process deadlines report an unmet condition instead of running past the budget', async () => {
  const nest = createNest({ run: async (_cmd, _args, options) => {
    assert.equal(options.timeout, 50);
    throw Object.assign(new Error('deadline'), { killed: true, signal: 'SIGTERM' });
  } });
  const result = await nest.wait(1, { mode: 'change', quiet_ms: 50, timeout_ms: 50 }, 'validated-instance');
  assert.equal(result.satisfied, false);
  assert.equal(result.reason, 'timeout');
});

test('browser launches have distinct profiles and stop with their desktop service', async t => {
  const profiles = mkdtempSync(join(tmpdir(), 'agent-browser-test-'));
  t.after(() => rmSync(profiles, { recursive: true, force: true }));
  const calls = [];
  const nest = createNest({ profileBase: profiles, run: async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; } });
  await nest.open(1, ['brave', 'about:blank']);
  await nest.open(5, ['brave', 'about:blank']);
  for (const [index, n] of [1, 5].entries()) {
    const [cmd, args] = calls.filter(([cmd]) => cmd === 'systemd-run')[index];
    assert.equal(cmd, 'systemd-run');
    assert.ok(args.includes(`BindsTo=agent-desktop-${n}.service`));
    assert.ok(args.includes(`After=agent-desktop-${n}.service`));
    assert.ok(args.some(arg => arg === `--user-data-dir=${join(profiles, String(n), 'brave')}`));
    assert.ok(args.includes(`WAYLAND_DISPLAY=wayland-agent-${n}`));
  }
});

test('agent desktop apps never save their mute into the user\'s per-app sound', async () => {
  // WirePlumber keys saved volume/mute by app name; an agent's muted Brave must
  // not make the user's own Brave start muted.
  const calls = [];
  const nest = createNest({ launcher: '/bin/true', run: async (cmd, args) => { calls.push([cmd, args]); return { stdout: '', stderr: '' }; } });
  await nest.open(2, ['mattermost']);
  await nest.exec(2, 'virt-viewer', 1000);
  const launches = calls.filter(([cmd]) => cmd === 'systemd-run').map(([, args]) => args);
  assert.equal(launches.length, 2);
  for (const args of launches) {
    assert.ok(args.includes('PULSE_PROP=state.restore-props=false'), 'PulseAudio clients opt out of stream-restore');
    assert.ok(args.includes('PIPEWIRE_PROPS={state.restore-props=false}'), 'native PipeWire clients opt out of stream-restore');
  }
});

function browserFixture(t, settings = () => ({ browserStartup: 'fresh' })) {
  const profiles = mkdtempSync(join(tmpdir(), 'agent-browser-test-'));
  t.after(() => rmSync(profiles, { recursive: true, force: true }));
  const dir = join(profiles, '1', 'brave');
  mkdirSync(join(dir, 'Default'), { recursive: true });
  const prefs = join(dir, 'Default', 'Preferences');
  writeFileSync(prefs, JSON.stringify({ session: { restore_on_startup: 1, startup_urls: ['https://old.example'] }, profile: { exit_type: 'Crashed', custom: true }, other: 42 }));
  const calls = [];
  const nest = createNest({ profileBase: profiles, settings, run: async (cmd, args) => { if (cmd === 'systemd-run') calls.push(args); return { stdout: '' }; } });
  return { nest, dir, prefs, calls };
}

test('fresh startup preserves profile data but avoids restored tabs and a crash restore', async t => {
  const { nest, prefs, calls } = browserFixture(t);
  await nest.open(1, ['brave', 'https://requested.example']);
  const value = JSON.parse(readFileSync(prefs));
  assert.equal(value.session.restore_on_startup, 5);
  assert.equal(value.profile.exit_type, 'Normal');
  assert.equal(value.profile.custom, true);
  assert.equal(value.other, 42);
  assert.deepEqual(value.session.startup_urls, ['https://old.example']);
  assert.ok(calls[0].includes('https://requested.example'));
  assert.ok(!calls[0].includes('--restore-last-session'));
});

test('fresh startup opens a blank page without an explicit URL, restore is an explicit preference', async t => {
  let mode = 'fresh';
  const { nest, prefs, calls } = browserFixture(t, () => ({ browserStartup: mode }));
  await nest.open(1, ['brave']);
  assert.ok(calls[0].includes('about:blank'));
  mode = 'restore';
  await nest.open(1, ['brave']);
  assert.ok(calls[1].includes('--restore-last-session'));
  assert.equal(JSON.parse(readFileSync(prefs)).session.restore_on_startup, 1);
});

test('an already running managed browser is never edited on disk', async t => {
  const { nest, dir, prefs } = browserFixture(t);
  const before = readFileSync(prefs, 'utf8');
  symlinkSync(`localhost-${process.pid}`, join(dir, 'SingletonLock'));
  await nest.open(1, ['brave', 'https://requested.example']);
  assert.equal(readFileSync(prefs, 'utf8'), before);
});

test('managed browser launches refuse profile overrides and startup overrides', async t => {
  const { nest, calls } = browserFixture(t);
  for (const arg of ['--user-data-dir=/normal-profile', '--profile-directory=Other', '--restore-last-session']) {
    await assert.rejects(nest.open(1, ['brave', arg]), /managed|startup/i);
  }
  assert.equal(calls.length, 0);
});


test('a stale managed browser lock permits new startup preferences without deleting retained sessions', async t => {
  const { nest, dir, prefs } = browserFixture(t);
  symlinkSync(`${hostname()}-2147483647`, join(dir, 'SingletonLock'));
  mkdirSync(join(dir, 'Default', 'Sessions'));
  const session = join(dir, 'Default', 'Sessions', 'Session_123');
  writeFileSync(session, 'retained-session');
  await nest.open(1, ['brave']);
  assert.equal(JSON.parse(readFileSync(prefs)).session.restore_on_startup, 5);
  assert.equal(readFileSync(session, 'utf8'), 'retained-session');
});

test('invalid or symlinked managed preferences cannot be overwritten', async t => {
  const { nest, prefs, calls } = browserFixture(t);
  writeFileSync(prefs, '{corrupt');
  await assert.rejects(nest.open(1, ['brave']), /Cannot read managed/);
  assert.equal(readFileSync(prefs, 'utf8'), '{corrupt');
  rmSync(prefs);
  symlinkSync('/normal-profile/Preferences', prefs);
  await assert.rejects(nest.open(1, ['brave']), /symlink/);
  assert.equal(calls.length, 0);
});
