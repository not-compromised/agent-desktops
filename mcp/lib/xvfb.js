import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { browserCommand } from './browser.js';
import { waitForFrames } from './visual-wait.js';
import { verifyWindowAction } from './window.js';
import { createManagedApps } from './managed-apps.js';
import { createAccessibility } from './accessibility.js';
import { createHeldInput } from './held-input.js';
import { createWindowLifetimes } from './window-lifetimes.js';

const exec = promisify(execFile);
export function desktopPaths(state, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid desktop number');
  const dir = join(state, 'desktops', String(n));
  return { dir, info: join(dir, 'desktop.json'), auth: join(dir, 'Xauthority') };
}
export async function rfbReady(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let data = '';
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => done(false));
    socket.on('error', () => done(false));
    socket.on('end', () => done(false));
    socket.on('data', chunk => { data += chunk; if (data.length >= 12) done(/^RFB 003\.\d{3}\n/.test(data)); });
  });
}
export function createXvfb({ state, prefix = 'pm-agent-desktop', portBase = 15900, execute = exec, probe = rfbReady, settings = () => ({ browserStartup: 'fresh' }) } = {}) {
  if (!Number.isSafeInteger(portBase) || portBase < 1024 || portBase >= 65535) throw new Error('invalid VNC port base');
  if (!/^[a-z][a-z0-9-]+$/.test(prefix)) throw new Error('invalid unit prefix');
  const unit = n => `${prefix}-${n}.service`;
  const info = n => JSON.parse(readFileSync(desktopPaths(state, n).info, 'utf8'));
  const env = n => {
    const d = info(n);
    const e = { ...process.env, DISPLAY: d.display, XAUTHORITY: desktopPaths(state, n).auth, DBUS_SESSION_BUS_ADDRESS: d.bus, XDG_SESSION_TYPE: 'x11' };
    for (const key of ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'ELECTRON_RUN_AS_NODE', 'AT_SPI_BUS_ADDRESS', 'WAYLAND_SOCKET']) delete e[key];
    return e;
  };
  const run = (n, cmd, args, opts = {}) => execute(cmd, args, { env: env(n), timeout: 5000, maxBuffer: 64 * 1024 * 1024, ...opts });
  const health = async n => {
    try {
      if (!existsSync(desktopPaths(state, n).info)) return { display: false, windows: false, vnc: false };
      const results = await Promise.allSettled([
        run(n, 'xdpyinfo', []),
        run(n, 'xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']),
        probe(info(n).port)
      ]);
      return { display: results[0].status === 'fulfilled',
        windows: results[1].status === 'fulfilled' && /window id # 0x[1-9a-f]/i.test(results[1].value.stdout),
        vnc: results[2].status === 'fulfilled' && results[2].value === true };
    } catch { return { display: false, windows: false, vnc: false }; }
  };
  const held = createHeldInput({ backend: 'xvfb', env: (n, expected) => {
    if (info(n).instance !== expected) throw new Error('Desktop generation changed');
    return { ...env(n), AGENT_DESKTOP_INFO: desktopPaths(state, n).info };
  }, quarantine: async (n, expected) => {
    if (!existsSync(desktopPaths(state, n).info) || info(n).instance !== expected) return;
    await execute('systemctl', ['--user', 'stop', unit(n)], { timeout: 20000 });
    const { stdout } = await execute('systemctl', ['--user', 'show', unit(n), '-p', 'ActiveState', '--value']);
    if (!['inactive', 'failed'].includes(stdout.trim())) throw new Error('Input cleanup failed; desktop remains quarantined');
  } });
  const windows = createWindowLifetimes({ backend: 'xvfb', instance: n => info(n).instance, env: n => ({ ...env(n), AGENT_DESKTOP_INFO: desktopPaths(state, n).info }) });
  const managedApps = createManagedApps({ execute, unit, instance: n => info(n).instance, env });
  const accessibility = createAccessibility({ context: managedApps.context, instance: n => info(n).instance });
  const appArgs = (n, command, track = true) => {
    const e = env(n);
    const name = managedApps.allocate(n, { track });
    return ['--user', '--collect', '--quiet', `--unit=${name}`,
      '-p', `BindsTo=${unit(n)}`, '-p', `After=${unit(n)}`, '-p', 'TimeoutStopSec=5',
      '--', 'env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'WAYLAND_DISPLAY', '-u', 'HYPRLAND_INSTANCE_SIGNATURE', '-u', 'AT_SPI_BUS_ADDRESS',
      'XDG_SESSION_TYPE=x11', `DISPLAY=${e.DISPLAY}`, `XAUTHORITY=${e.XAUTHORITY}`, `DBUS_SESSION_BUS_ADDRESS=${e.DBUS_SESSION_BUS_ADDRESS}`, ...command];
  };
  return {
    placement: 'local Xvfb desktop; open Agent Desktops to view',
    accessibility: accessibility.query,
    heldInput: held.set,
    heldState: n => held.state(n),
    releaseInput: held.release,
    closeInput: async () => { windows.closeAll(); await held.closeAll(); },
    info, health, unit, instance: n => info(n).instance,
    async ready(n) { return Object.values(await health(n)).every(Boolean); },
    async start(n) {
      desktopPaths(state, n);
      if (portBase + n > 65535) throw new Error('desktop port range exhausted');
      await execute('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit(n)}`,
        '-p', 'Restart=on-failure', '-p', 'RestartSec=2', '-p', 'KillMode=control-group', '-p', 'StartLimitBurst=3', '-p', 'StartLimitIntervalSec=60', '-p', 'TimeoutStopSec=5',
        '--', ...['idle', 'sleep'].flatMap(what => ['systemd-inhibit', `--what=${what}`,
          `--who=agent-desktop-${n}`, '--why=Agent desktop is open', '--mode=block']),
        'dbus-run-session', `--config-file=${fileURLToPath(new URL('../../config/session-bus.conf', import.meta.url))}`, '--', process.execPath,
        fileURLToPath(new URL('./xvfb-supervisor.js', import.meta.url)), state, String(n), String(portBase + n)], { timeout: 10000 });
      for (let i = 0; i < 80; i++) {
        if (await this.ready(n)) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error(`desktop ${n} did not become ready; inspect journalctl --user -u ${unit(n)}`);
    },
    async stop(n) {
      try { await held.release(n); } catch { /* Retry the owned service stop even after input cleanup failed. */ }
      const { stdout: load } = await execute('systemctl', ['--user', 'show', unit(n), '-p', 'LoadState', '--value']);
      if (load.trim() === 'not-found') { held.confirmStopped(n); windows.stop(n); managedApps.clear(n); return; }
      await execute('systemctl', ['--user', 'stop', unit(n)], { timeout: 20000 });
      const { stdout } = await execute('systemctl', ['--user', 'show', unit(n), '-p', 'ActiveState', '--value']);
      if (!['inactive', 'failed'].includes(stdout.trim())) throw new Error(`desktop ${n} did not stop`);
      held.confirmStopped(n);
      windows.stop(n);
      managedApps.clear(n);
    },
    async windows(n, { signal: outerSignal } = {}) {
      return windows.inventory(n, async monitorSignal => {
      const signal = monitorSignal && outerSignal ? AbortSignal.any([monitorSignal, outerSignal]) : monitorSignal || outerSignal;
      const { stdout } = await run(n, 'xprop', ['-root', '_NET_CLIENT_LIST', '_NET_ACTIVE_WINDOW'], { signal });
      const ids = (stdout.split('\n')[0].match(/0x[0-9a-f]+/gi) || []).filter(id => id !== '0x0');
      const focused = stdout.split('\n')[1]?.match(/0x[0-9a-f]+/i)?.[0];
      return (await Promise.all(ids.map(async address => {
        try {
          const { stdout: props } = await run(n, 'xprop', ['-id', address, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS', '_NET_WM_PID', '_NET_WM_STATE'], { signal });
          const title = props.match(/(?:_NET_WM_NAME|WM_NAME)\([^)]*\) = "(.*)"/)?.[1] || '';
          return { address, pid: Number(props.match(/_NET_WM_PID\(CARDINAL\) = (\d+)/)?.[1]) || null, fullscreen: /_NET_WM_STATE[^\n]*_NET_WM_STATE_FULLSCREEN/.test(props), class: props.match(/WM_CLASS.*= (.*)/)?.[1] || '', title,
            focused: address === focused };
        } catch (error) { if (signal?.aborted) throw error; return null; }
      }))).filter(Boolean);
      });
    },
    async capture(n, { scale = 1, bounds, timeout_ms = 15000, signal } = {}) {
      const { stdout } = await run(n, 'maim', ['--format=png', ...(bounds ? ['--geometry', `${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`] : [])], { encoding: 'buffer', timeout: timeout_ms, signal });
      if (scale === 1) return stdout;
      return new Promise((resolve, reject) => {
        const child = execFile('python3', ['-c', 'import sys,io;from PIL import Image;im=Image.open(sys.stdin.buffer);im.resize((round(im.width*float(sys.argv[1])),round(im.height*float(sys.argv[1])))).save(sys.stdout.buffer,"PNG")', String(scale)],
          { encoding: 'buffer', timeout: timeout_ms, signal, maxBuffer: 64 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out));
        child.stdin.on('error', () => {}); child.stdin.end(stdout);
      });
    },
    async window(n, target, args, expected = info(n).instance) {
      if (args.action === 'move_resize' && (![args.x, args.y, args.width, args.height].every(Number.isSafeInteger)
          || args.x < 0 || args.y < 0 || args.width < 1 || args.height < 1
          || args.x + args.width > 2560 || args.y + args.height > 1440))
        throw new Error('Window client bounds must fit the desktop');
      const command = args.action === 'focus' ? ['windowactivate', '--sync', target.address] :
        args.action === 'close' ? ['windowclose', target.address] : null;
      return verifyWindowAction({ windows: this.windows, instance: n => info(n).instance, execute: async () => {
        if (info(n).instance !== expected) throw new Error('Desktop changed before window action');
        if (command) await run(n, 'xdotool', command);
        // StaticGravity positions the client origin directly. ConfigureRequest's
        // default gravity instead positions Openbox's decorated frame origin.
        else if (args.action === 'move_resize') await run(n, 'wmctrl', ['-ir', target.address, '-e', `10,${args.x},${args.y},${args.width},${args.height}`]);
        else await run(n, 'wmctrl', ['-ir', target.address, '-b', `${args.enabled ? 'add' : 'remove'},fullscreen`]);
      } }, n, target, args, expected);
    },
    async move(n, x, y, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'move', [x, y], expected);
      await run(n, 'xdotool', ['mousemove', String(x), String(y)]);
    },
    async click(n, x, y, button = 'left', expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'click', [x, y, button], expected);
      await run(n, 'xdotool', ['mousemove', String(x), String(y), 'click', String({ left: 1, middle: 2, right: 3 }[button])]); },
    async drag(n, x, y, toX, toY, button = 'left', durationMs = 400, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'drag', [x, y, toX, toY, button, durationMs], expected);
      const code = String({ left: 1, middle: 2, right: 3 }[button]);
      try {
        const args = ['mousemove', String(x), String(y), 'mousedown', code];
        for (let step = 1; step <= 10; step++) args.push('sleep', String(durationMs / 10000), 'mousemove',
          String(Math.round(x + (toX - x) * step / 10)), String(Math.round(y + (toY - y) * step / 10)));
        args.push('mouseup', code);
        await run(n, 'xdotool', args, { timeout: durationMs + 5000 });
      } finally {
        await run(n, 'xdotool', ['mouseup', code]);
      }
    },
    wait(n, options, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      return waitForFrames({ ...options, capture: timeout_ms => this.capture(n, { timeout_ms }) });
    },
    async scroll(n, x, y, dy, dx = 0, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'scroll', [x, y, dy, dx], expected);
      if (Math.abs(dy) > 100 || Math.abs(dx) > 100) throw new Error('scroll is limited to 100 steps per call');
      await this.move(n, x, y);
      for (const [amount, negative, positive] of [[dy, 4, 5], [dx, 6, 7]]) {
        if (amount) await run(n, 'xdotool', ['click', '--repeat', String(Math.abs(amount)), '--delay', '10', String(amount < 0 ? negative : positive)]);
      }
    },
    async type(n, text, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'type', [text], expected);
      await run(n, 'xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', text], { timeout: 30000 }); },
    async key(n, combo, expected = info(n).instance) {
      if (info(n).instance !== expected) throw new Error('Desktop generation changed');
      if (held.active(n)) return held.command(n, 'key', [combo], expected);
      await run(n, 'xdotool', ['key', '--clearmodifiers', '--', combo]); },
    async open(n, command) {
      let [bin, ...args] = command;
      if (bin === 'brave') bin = 'brave-browser';
      const managed = browserCommand([bin, ...args], { profileBase: join(state, 'profiles'), desktop: n,
        startup: settings().browserStartup, extra: ['--start-maximized', '--ozone-platform=x11'] });
      const launchArgs = appArgs(n, managed);
      await execute('systemd-run', ['--service-type=exec', ...launchArgs], { timeout: 15000 });
      await managedApps.activated(n, launchArgs.find(arg => arg.startsWith('--unit=')).slice(7));
    },
    async exec(n, command, timeoutMs = 30000) {
      try {
        const { stdout, stderr } = await execute('systemd-run', ['--pipe', '--wait', '-p', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`, ...appArgs(n, ['bash', '-c', command], false)], { timeout: timeoutMs + 6000, maxBuffer: 1024 * 1024 });
        return { code: 0, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000) };
      } catch (e) { return { code: e.code ?? 1, stdout: String(e.stdout || '').slice(0, 20000), stderr: String(e.stderr || e.message).slice(0, 20000) }; }
    }
  };
}
