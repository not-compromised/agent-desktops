// Opt-in nested-within-nested input test. Never injects into the real seat.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv.includes('--live')) throw new Error('Pass --live to open a test desktop');
const repoArg = process.argv.indexOf('--repo');
const repo = repoArg < 0 ? fileURLToPath(new URL('../..', import.meta.url)) : resolve(process.argv[repoArg + 1]);
const launcher = resolve(repo, 'bin/agent-desktop');
const scratch = mkdtempSync(join(tmpdir(), 'agent-input-proof-'));
const events = join(scratch, 'events.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exec = (cmd, args, env = {}) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
const tool = (name, args) => {
  const result = JSON.parse(exec(launcher, ['tool', name, JSON.stringify(args)]));
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};
const claim = tool('claim', { owner: 'input lock live verification #196' }).structuredContent;
const handle = claim.handle;
const parent = { HYPRLAND_INSTANCE_SIGNATURE: `agent-${claim.desktop}` };
let child;
const hypr = (env, ...args) => exec('hyprctl', args, env).trim();
const log = () => readFileSync(events, 'utf8');
const inputEvents = text => text.match(/wl_(?:keyboard|pointer)#\d+\.(?:key|motion|button|axis)\(/g) || [];
const inside = command => tool('run', { handle, command });
try {
  tool('open', { handle, command: ['env', 'HYPRLAND_NO_SD_VARS=1', 'AGENT_DESKTOP_SELF=/bin/true', 'Hyprland', '-c', join(repo, 'config/nest.lua')] });
  let window;
  for (let i = 0; i < 80; i++) {
    window = JSON.parse(hypr(parent, '-j', 'clients')).find(w => w.class === 'aquamarine');
    if (window) break;
    await sleep(250);
  }
  assert.ok(window, 'child desktop maps');
  const instance = JSON.parse(exec('hyprctl', ['-j', 'instances'])).find(i => i.pid === window.pid);
  assert.ok(instance);
  child = { HYPRLAND_INSTANCE_SIGNATURE: instance.instance };
  hypr(child, 'output', 'create', 'headless', 'agent-main');
  hypr(child, 'reload');
  assert.equal(hypr(child, 'configerrors'), '');
  hypr(child, 'repl', 'hl.dispatch(hl.dsp.focus({ monitor = "agent-main" }))');
  tool('open', { handle, command: ['bash', '-c', `WAYLAND_DISPLAY=${instance.wl_socket} WAYLAND_DEBUG=1 foot --title=input-lock-proof sh -c 'sleep infinity' 2>${events}`] });
  await sleep(800);
  const app = JSON.parse(hypr(child, '-j', 'clients')).find(w => w.title === 'input-lock-proof');
  assert.ok(app?.mapped, 'event receiver is mapped');
  hypr(child, 'repl', 'hl.dispatch(hl.dsp.focus({ monitor = "agent-main" }))');
  const human = async () => {
    const frame = tool('observe', { handle, scale: 0.5 }).structuredContent;
    tool('click', { handle, frame_id: frame.frame_id, x: 600, y: 400 });
    tool('type', { handle, text: 'human' });
    tool('key', { handle, combo: 'shift+a' });
    const next = tool('observe', { handle, scale: 0.5 }).structuredContent;
    tool('scroll', { handle, frame_id: next.frame_id, x: 700, y: 500, dy: 10 });
    await sleep(200);
  };
  let offset = log().length;
  await human();
  assert.equal(inputEvents(log().slice(offset)).length, 0, 'default lock blocks human input');
  console.log('PASS default lock blocks human keyboard, click, movement and scroll');
  const agent = async () => {
    inside(`WAYLAND_DISPLAY=${instance.wl_socket} wtype -- agent`);
    hypr(child, 'repl', 'hl.dispatch(hl.dsp.cursor.move({ x = 600, y = 400 }))');
    inside(`WAYLAND_DISPLAY=${instance.wl_socket} wlrctl pointer click left`);
    await sleep(200);
  };
  offset = log().length;
  await agent();
  assert.ok(inputEvents(log().slice(offset)).some(e => e.includes('.key(')), 'agent typing reaches application');
  assert.ok(inputEvents(log().slice(offset)).some(e => e.includes('.button(')), 'agent clicking reaches application');
  console.log('PASS agent keyboard and click work while locked');
  // Exercise the real shortcut semantics inside the disposable parent compositor.
  // wtype supplies a temporary keymap rather than physical keyboard keycodes.
  hypr(parent, 'repl', 'hl.config({ input = { resolve_binds_by_sym = true } })');
  hypr(parent, 'repl', `hl.bind("SUPER + ALT + L", function() hl.exec_cmd("env HYPRLAND_INSTANCE_SIGNATURE=${instance.instance} hyprctl repl 'return agent_desktop_control(true)'") end, { release = true })`);
  tool('key', { handle, combo: 'super+alt+l' });
  await sleep(300);
  assert.equal(hypr(child, 'repl', 'return agent_desktop_control(false)'), 'unlocked', 'shortcut enabled control');
  offset = log().length;
  await human();
  const received = inputEvents(log().slice(offset));
  for (const kind of ['key', 'button', 'axis', 'motion']) assert.ok(received.some(e => e.includes(`.${kind}(`)), `unlocked human ${kind} reaches application`);
  console.log('PASS Super+Alt+L unlocks human keyboard, click, movement and scroll');
  tool('key', { handle, combo: 'super+alt+l' });
  await sleep(300);
  offset = log().length;
  await human();
  assert.equal(inputEvents(log().slice(offset)).length, 0, 'relock blocks human input');
  console.log('PASS Super+Alt+L relocks human input');
  offset = log().length;
  await agent();
  assert.ok(inputEvents(log().slice(offset)).length > 0);
  hypr(child, 'repl', 'return agent_desktop_control(true)');
  hypr(child, 'reload');
  assert.equal(hypr(child, 'configerrors'), '');
  assert.equal(hypr(child, 'repl', 'return agent_desktop_control(false)'), 'locked');
  console.log('PASS config reload returns to locked default');
  console.log(`Evidence: ${scratch}`);
} finally {
  tool('release', { handle });
  console.log(`Released test desktop ${claim.desktop}`);
}
