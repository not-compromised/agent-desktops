import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { browserCommand } from './browser.js';

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
    for (const key of ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'ELECTRON_RUN_AS_NODE']) delete e[key];
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
  const appArgs = (n, command) => {
    const e = env(n);
    return ['--user', '--collect', '--quiet', `--unit=${prefix}-${n}-app-${randomUUID()}`,
      '-p', `BindsTo=${unit(n)}`, '-p', `After=${unit(n)}`, '-p', 'TimeoutStopSec=5',
      '--', 'env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'WAYLAND_DISPLAY', '-u', 'HYPRLAND_INSTANCE_SIGNATURE',
      'XDG_SESSION_TYPE=x11', `DISPLAY=${e.DISPLAY}`, `XAUTHORITY=${e.XAUTHORITY}`, `DBUS_SESSION_BUS_ADDRESS=${e.DBUS_SESSION_BUS_ADDRESS}`, ...command];
  };
  return {
    placement: 'local Xvfb desktop; open Agent Desktops to view',
    info, health, unit, instance: n => info(n).instance,
    async ready(n) { return Object.values(await health(n)).every(Boolean); },
    async start(n) {
      desktopPaths(state, n);
      if (portBase + n > 65535) throw new Error('desktop port range exhausted');
      await execute('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit(n)}`,
        '-p', 'Restart=on-failure', '-p', 'RestartSec=2', '-p', 'StartLimitBurst=3', '-p', 'StartLimitIntervalSec=60', '-p', 'TimeoutStopSec=5',
        '--', 'systemd-inhibit', '--what=idle:sleep', `--who=agent-desktop-${n}`,
        '--why=Agent desktop is open', '--mode=block', 'dbus-run-session', '--', process.execPath,
        fileURLToPath(new URL('./xvfb-supervisor.js', import.meta.url)), state, String(n), String(portBase + n)], { timeout: 10000 });
      for (let i = 0; i < 80; i++) {
        if (await this.ready(n)) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error(`desktop ${n} did not become ready; inspect journalctl --user -u ${unit(n)}`);
    },
    async stop(n) {
      const { stdout: load } = await execute('systemctl', ['--user', 'show', unit(n), '-p', 'LoadState', '--value']);
      if (load.trim() === 'not-found') return;
      await execute('systemctl', ['--user', 'stop', unit(n)], { timeout: 20000 });
      const { stdout } = await execute('systemctl', ['--user', 'show', unit(n), '-p', 'ActiveState', '--value']);
      if (!['inactive', 'failed'].includes(stdout.trim())) throw new Error(`desktop ${n} did not stop`);
    },
    async windows(n) {
      const { stdout } = await run(n, 'xprop', ['-root', '_NET_CLIENT_LIST', '_NET_ACTIVE_WINDOW']);
      const ids = (stdout.split('\n')[0].match(/0x[0-9a-f]+/gi) || []).filter(id => id !== '0x0');
      const focused = stdout.split('\n')[1]?.match(/0x[0-9a-f]+/i)?.[0];
      return (await Promise.all(ids.map(async address => {
        try {
          const { stdout: props } = await run(n, 'xprop', ['-id', address, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS']);
          const { stdout: geometry } = await run(n, 'xdotool', ['getwindowgeometry', '--shell', address]);
          const g = Object.fromEntries(geometry.trim().split('\n').map(line => line.split('=')));
          const title = props.match(/(?:_NET_WM_NAME|WM_NAME)\([^)]*\) = "(.*)"/)?.[1] || '';
          return { address, class: props.match(/WM_CLASS.*= (.*)/)?.[1] || '', title,
            x: Number(g.X), y: Number(g.Y), w: Number(g.WIDTH), h: Number(g.HEIGHT), focused: address === focused };
        } catch { return null; }
      }))).filter(Boolean);
    },
    async capture(n, { scale = 1 } = {}) {
      const { stdout } = await run(n, 'maim', ['--format=png'], { encoding: 'buffer', timeout: 15000 });
      if (scale === 1) return stdout;
      return new Promise((resolve, reject) => {
        const child = execFile('python3', ['-c', 'import sys,io;from PIL import Image;im=Image.open(sys.stdin.buffer);im.resize((round(im.width*float(sys.argv[1])),round(im.height*float(sys.argv[1])))).save(sys.stdout.buffer,"PNG")', String(scale)],
          { encoding: 'buffer', timeout: 15000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => err ? reject(err) : resolve(out));
        child.stdin.on('error', () => {}); child.stdin.end(stdout);
      });
    },
    async move(n, x, y) { await run(n, 'xdotool', ['mousemove', String(x), String(y)]); },
    async click(n, x, y, button = 'left') { await run(n, 'xdotool', ['mousemove', String(x), String(y), 'click', String({ left: 1, middle: 2, right: 3 }[button])]); },
    async scroll(n, x, y, dy, dx = 0) {
      if (Math.abs(dy) > 100 || Math.abs(dx) > 100) throw new Error('scroll is limited to 100 steps per call');
      await this.move(n, x, y);
      for (const [amount, negative, positive] of [[dy, 4, 5], [dx, 6, 7]]) {
        if (amount) await run(n, 'xdotool', ['click', '--repeat', String(Math.abs(amount)), '--delay', '10', String(amount < 0 ? negative : positive)]);
      }
    },
    async type(n, text) { await run(n, 'xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', text], { timeout: 30000 }); },
    async key(n, combo) { await run(n, 'xdotool', ['key', '--clearmodifiers', '--', combo]); },
    async open(n, command) {
      let [bin, ...args] = command;
      if (bin === 'brave') bin = 'brave-browser';
      const managed = browserCommand([bin, ...args], { profileBase: join(state, 'profiles'), desktop: n,
        startup: settings().browserStartup, extra: ['--start-maximized', '--ozone-platform=x11'] });
      await execute('systemd-run', ['--service-type=exec', ...appArgs(n, managed)], { timeout: 15000 });
    },
    async exec(n, command, timeoutMs = 30000) {
      try {
        const { stdout, stderr } = await execute('systemd-run', ['--pipe', '--wait', '-p', `RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`, ...appArgs(n, ['bash', '-c', command])], { timeout: timeoutMs + 6000, maxBuffer: 1024 * 1024 });
        return { code: 0, stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000) };
      } catch (e) { return { code: e.code ?? 1, stdout: String(e.stdout || '').slice(0, 20000), stderr: String(e.stderr || e.message).slice(0, 20000) }; }
    }
  };
}
