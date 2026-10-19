// Everything that touches a nested desktop. Each nest is reachable under the
// stable names the launcher keeps symlinked (wayland-agent-N, :9N, hypr/agent-N),
// so every command here runs with those in its environment and can only ever
// reach that nest: the real seat's names are never set on anything this file
// spawns. `run` is injectable so the tool layer can be tested without a nest.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { browserCommand } from './browser.js';
import { verifyWindowAction } from './window.js';
import { createManagedApps } from './managed-apps.js';
import { createAccessibility } from './accessibility.js';
import { createHeldInput } from './held-input.js';
import { createWindowLifetimes } from './window-lifetimes.js';

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const OUTPUT = 'agent-main';
const RUN = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const PROFILES = join(homedir(), '.local/share/agent-desktop/profiles');
const MAX_OUTPUT = 20000;
// WirePlumber saves a stream's volume and mute under its app name; the audio
// controller's mute on an agent's Brave would otherwise mute the user's Brave.
// bin/agent-desktop sets the same pair for apps started in the nest.
export const NO_SOUND_RESTORE = {
  PULSE_PROP: 'state.restore-props=false',
  PIPEWIRE_PROPS: '{state.restore-props=false}'
};

export function nestEnv(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid desktop number');
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'WAYLAND_SOCKET', 'AGENT_DESKTOP_INSTANCE', 'AT_SPI_BUS_ADDRESS'].includes(key))),
    WAYLAND_DISPLAY: `wayland-agent-${n}`,
    DISPLAY: `:9${n}`,
    HYPRLAND_INSTANCE_SIGNATURE: `agent-${n}`,
    XDG_RUNTIME_DIR: RUN,
    AGENT_DESKTOP: String(n),
    AGENT_DESKTOP_OUTPUT: OUTPUT,
    ...NO_SOUND_RESTORE
  };
}

function resolveLauncher() {
  const inRepo = join(HERE, '..', '..', 'bin', 'agent-desktop');
  return existsSync(inRepo) ? inRepo : 'agent-desktop';
}

const KEY_ALIASES = { enter: 'Return', esc: 'Escape', space: 'space', tab: 'Tab', backspace: 'BackSpace', del: 'Delete', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next' };
const MODS = new Set(['ctrl', 'shift', 'alt', 'logo', 'super', 'win']);

export function keyArgs(combo) {
  const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key combo');
  const key = parts.pop();
  const mods = parts.map(m => m.toLowerCase()).map(m => (m === 'win' || m === 'logo' ? 'super' : m));
  for (const m of mods) if (!MODS.has(m)) throw new Error(`unknown modifier ${m}`);
  const name = KEY_ALIASES[key.toLowerCase()] ?? key;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid key name; use an XKB name such as minus or plus');
  return [[...mods, name].join('+')];
}

export function createNest({ run = (cmd, args, opts) => execFileP(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }), launcher = resolveLauncher(), profileBase = PROFILES, settings = () => ({ browserStartup: 'fresh' }), readSession = n => readFileSync(`${RUN}/agent-desktop/${n}/env`, 'utf8') } = {}) {
  const chains = new Map();
  // One desktop, one input stream: parallel tool calls from the same session
  // must not interleave keystrokes or move the cursor under a click.
  const serial = (n, fn) => {
    const prev = chains.get(n) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(n, next.catch(() => {}));
    return next;
  };
  // The nest's signature travels in the environment: hyprctl -i wants an index
  // or a full signature, not the agent-N symlink name.
  const hyprctl = (n, args, options = {}) => run('hyprctl', args, { env: nestEnv(n), timeout: 3000, ...options });
  const repl = (n, lua) => hyprctl(n, ['repl', lua]);
  const instance = n => {
    try { return readlinkSync(`${RUN}/hypr/agent-${n}`).split('/').at(-1); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const desktopEnv = n => {
    const env = nestEnv(n);
    const contents = readSession(n);
    const bus = contents.match(/^DBUS_SESSION_BUS_ADDRESS=(.+)$/m)?.[1];
    if (!bus || !/^unix:(?:path|abstract)=[A-Za-z0-9_./,=:-]+$/.test(bus)) throw new Error('Private desktop session bus is unavailable; release and claim again');
    env.DBUS_SESSION_BUS_ADDRESS = bus;
    delete env.AT_SPI_BUS_ADDRESS;
    return env;
  };
  const held = createHeldInput({ env: (n, expected) => ({ ...nestEnv(n), AGENT_DESKTOP_INSTANCE: expected }), quarantine: async (n, expected) => {
    if (instance(n) !== expected) return;
    await run(launcher, ['stop', String(n)], { timeout: 60000 });
    if (instance(n) === expected) throw new Error('Input cleanup failed; desktop remains quarantined');
  } });
  const windows = createWindowLifetimes({ env: n => nestEnv(n), instance });
  const managedApps = createManagedApps({ execute: run, unit: n => `agent-desktop-${n}.service`, instance, env: desktopEnv });
  const accessibility = createAccessibility({ context: managedApps.context, instance });
  const native = (n, tool, args, timeout, expected) => run(join(HERE, '../../native/bin', `agent-desktop-${tool}`), args,
    { env: { ...nestEnv(n), AGENT_DESKTOP_INSTANCE: expected ?? '' }, timeout: timeout ?? 5000 });
  const pointer = (n, args, timeout, expected) => native(n, 'pointer', ['--extent', '2560x1440', ...args], timeout, expected);

  const focusOutput = n => repl(n, `hl.dispatch(hl.dsp.focus({ monitor = '${OUTPUT}' }))`);
  const appArgs = (n, command, track = true) => {
    const e = desktopEnv(n);
    const name = managedApps.allocate(n, { track });
    return [
    '--user', '--collect', `--unit=${name}`,
    '-p', `BindsTo=agent-desktop-${n}.service`, '-p', `After=agent-desktop-${n}.service`,
    '--', 'env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'AT_SPI_BUS_ADDRESS',
    ...['WAYLAND_DISPLAY', 'DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'AGENT_DESKTOP', 'AGENT_DESKTOP_OUTPUT', 'DBUS_SESSION_BUS_ADDRESS', ...Object.keys(NO_SOUND_RESTORE)]
      .map(key => `${key}=${e[key]}`),
    ...command
  ]; };

  return {
    instance,
    accessibility: accessibility.query,
    heldInput: held.set,
    heldState: n => held.state(n),
    releaseInput: held.release,
    closeInput: async () => { windows.closeAll(); await held.closeAll(); },
    ready(n) {
      return existsSync(`${RUN}/agent-desktop/${n}/env`) && existsSync(`${RUN}/wayland-agent-${n}`);
    },
    async start(n) {
      await run(launcher, ['start', String(n)], { timeout: 60000 });
    },
    async stop(n) {
      try { await held.release(n); } catch { /* Confirm shutdown below before clearing uncertain input. */ }
      await run(launcher, ['stop', String(n)], { timeout: 60000 });
      if (instance(n)) throw new Error('Desktop stop was not confirmed');
      held.confirmStopped(n);
      windows.stop(n);
      managedApps.clear(n);
    },
    async windows(n, { signal: outerSignal } = {}) {
      return windows.inventory(n, async monitorSignal => {
      const signal = monitorSignal && outerSignal ? AbortSignal.any([monitorSignal, outerSignal]) : monitorSignal || outerSignal;
      const { stdout } = await hyprctl(n, ['-j', 'clients'], { signal });
      return JSON.parse(stdout)
        .filter(c => c.mapped)
        .map(c => ({ address: c.address, pid: c.pid, fullscreen: c.fullscreen === 2, class: c.class, title: c.title, x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1], focused: c.focusHistoryID === 0 }));
      });
    },
    async capture(n, { scale, bounds, timeout_ms = 15000, signal } = {}) {
      const args = ['-o', OUTPUT, '-c', '-t', 'png', '-l', '1'];
      if (scale && scale !== 1) args.push('-s', String(scale));
      if (bounds) args.push('-g', `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
      args.push('-');
      const { stdout } = await run('grim', args, { env: nestEnv(n), encoding: 'buffer', timeout: timeout_ms, signal });
      return stdout;
    },
    async window(n, target, args, expected = instance(n)) {
      if (!/^0x[0-9a-f]+$/i.test(target.address)) throw new Error('Invalid owned window address');
      const selector = `window = 'address:${target.address}'`;
      const calls = args.action === 'focus' ? [`hl.dsp.focus({ ${selector} })`] :
        args.action === 'close' ? [`hl.dsp.window.close({ ${selector} })`] :
        args.action === 'fullscreen' ? [`hl.dsp.window.fullscreen({ ${selector}, mode = 'fullscreen', action = '${args.enabled ? 'set' : 'unset'}' })`] :
        [`hl.dsp.window.float({ ${selector}, action = 'set' })`, `hl.dsp.window.resize({ ${selector}, x = ${args.width}, y = ${args.height} })`, `hl.dsp.window.move({ ${selector}, x = ${args.x}, y = ${args.y} })`];
      return verifyWindowAction({ windows: this.windows, instance, execute: async () => {
        for (const call of calls) {
          if (instance(n) !== expected) throw new Error('Desktop changed before window action');
          const result = await run('hyprctl', ['-i', expected, 'repl', `hl.dispatch(${call})`], { env: { ...nestEnv(n), HYPRLAND_INSTANCE_SIGNATURE: expected }, timeout: 5000 });
          if (/error|invalid|unknown/i.test(result.stdout)) throw new Error(`Window action failed: ${result.stdout}`);
        }
      } }, n, target, args, expected);
    },
    move(n, x, y, expected = instance(n)) {
      return serial(n, () => held.active(n) ? held.command(n, 'move', [x, y], expected) : pointer(n, ['move', String(x), String(y)], undefined, expected));
    },
    click(n, x, y, button = 'left', expected = instance(n)) {
      return serial(n, () => held.active(n) ? held.command(n, 'click', [x, y, button], expected) : pointer(n, ['move', String(x), String(y), 'click', button], undefined, expected));
    },
    scroll(n, x, y, dy, dx = 0, expected = instance(n)) {
      return serial(n, () => held.active(n) ? held.command(n, 'scroll', [x, y, dy, dx], expected) : pointer(n, ['move', String(x), String(y),
        ...(dy ? ['scroll', String(dy)] : []), ...(dx ? ['hscroll', String(dx)] : [])], undefined, expected));
    },
    drag(n, x, y, toX, toY, button = 'left', durationMs = 400, expected = instance(n)) {
      return serial(n, () => {
        if (held.active(n)) return held.command(n, 'drag', [x, y, toX, toY, button, durationMs], expected);
        const args = ['move', String(x), String(y), 'down', button];
        const steps = 10;
        for (let step = 1; step <= steps; step++) args.push('sleep', String(Math.round(durationMs / steps)), 'move',
          String(Math.round(x + (toX - x) * step / steps)), String(Math.round(y + (toY - y) * step / steps)));
        args.push('up', button);
        return pointer(n, args, durationMs + 5000, expected);
      });
    },
    type(n, text, expected = instance(n)) {
      return serial(n, () => held.active(n) ? held.command(n, 'type', [text], expected) : native(n, 'keyboard', ['--delay', '1', '-t', text], 60000, expected));
    },
    key(n, combo, expected = instance(n)) {
      return serial(n, () => held.active(n) ? held.command(n, 'key', keyArgs(combo), expected) : native(n, 'keyboard', keyArgs(combo), undefined, expected));
    },
    async wait(n, { mode, timeout_ms, quiet_ms }, expected = instance(n)) {
      const started = performance.now();
      let output;
      try {
        output = await native(n, 'still', [mode, '--quiet', String(quiet_ms), '--timeout', String(timeout_ms), '--start', String(timeout_ms), '--first', String(Math.min(timeout_ms, 2000))], timeout_ms, expected);
      } catch (error) {
        if (error.killed && error.signal === 'SIGTERM') return { satisfied: false, reason: 'timeout', elapsed_ms: Math.round(performance.now() - started) };
        if (error.code !== 124) throw error;
        output = error;
      }
      const result = String(output.stdout).match(/^(satisfied|unsatisfied) ([a-z-]+) .+$/m);
      if (!result) throw new Error('Visual wait returned no valid condition result');
      const elapsed_ms = Math.round(performance.now() - started);
      if (elapsed_ms > timeout_ms) return { satisfied: false, reason: 'timeout', elapsed_ms };
      return { satisfied: result[1] === 'satisfied', reason: result[2], elapsed_ms };
    },
    // Launch and let go. Browsers get a profile of their own: single-instance
    // browsers otherwise hand the launch to the user's running instance.
    async open(n, command) {
      await focusOutput(n);
      const managed = browserCommand(command, { profileBase, desktop: n, startup: settings().browserStartup });
      const args = appArgs(n, managed);
      await run('systemd-run', ['--quiet', '--service-type=exec', ...args], { timeout: 15000 });
      await managedApps.activated(n, args.find(arg => arg.startsWith('--unit=')).slice(7));
    },
    async exec(n, command, timeoutMs = 30000) {
      try {
        await focusOutput(n);
        const { stdout, stderr } = await run('systemd-run', ['--quiet', '--pipe', '--wait', '-p', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`, ...appArgs(n, ['bash', '-c', command], false)], { env: nestEnv(n), timeout: timeoutMs + 5000 });
        return { code: 0, stdout: String(stdout).slice(0, MAX_OUTPUT), stderr: String(stderr).slice(0, MAX_OUTPUT) };
      } catch (e) {
        return { code: e.code ?? 1, stdout: String(e.stdout ?? '').slice(0, MAX_OUTPUT), stderr: String(e.stderr ?? e.message).slice(0, MAX_OUTPUT) };
      }
    }
  };
}
