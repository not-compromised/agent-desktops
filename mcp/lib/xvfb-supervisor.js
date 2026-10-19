import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { desktopPaths, rfbReady } from './xvfb.js';

const [state, number, portString] = process.argv.slice(2);
const n = Number(number), port = Number(portString);
const paths = desktopPaths(state, n);
mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
rmSync(paths.info, { force: true });
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  rmSync(paths.info, { force: true });
  for (const child of children) child.kill('SIGTERM');
  // systemd owns the whole cgroup, including apps; its stop timeout bounds cleanup.
  process.exit(code);
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
function start(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', (code, signal) => { console.error(`${cmd} exited: ${code ?? signal}`); stop(1); });
  return child;
}
try {
  writeFileSync(paths.auth, '', { mode: 0o600 });
  const cookie = randomBytes(16).toString('hex');
  execFileSync('xauth', ['-f', paths.auth, 'add', ':0', '.', cookie]);
  const x = start('Xvfb', ['-displayfd', '3', '-screen', '0', '2560x1440x24', '-nolisten', 'tcp', '-auth', paths.auth], { stdio: ['ignore', 'inherit', 'inherit', 'pipe'] });
  const display = await new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => reject(new Error('Xvfb startup timed out')), 15000);
    x.stdio[3].on('data', data => { value += data; if (/^\d+\n$/.test(value)) { clearTimeout(timer); resolve(`:${value.trim()}`); } });
  });
  execFileSync('xauth', ['-f', paths.auth, 'add', display, '.', cookie]);
  const instance = randomBytes(16).toString('hex');
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: paths.auth, XDG_SESSION_TYPE: 'x11' };
  delete env.WAYLAND_DISPLAY; delete env.WAYLAND_SOCKET; delete env.HYPRLAND_INSTANCE_SIGNATURE; delete env.AT_SPI_BUS_ADDRESS;
  const a11yRuntime = `/run/user/${process.getuid()}/agent-desktop-a11y-${n}-${instance}`;
  mkdirSync(a11yRuntime, { mode: 0o700 });
  const a11yLauncher = ['/usr/lib/at-spi-bus-launcher', '/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher'].find(existsSync);
  if (!a11yLauncher) throw new Error('at-spi-bus-launcher is required');
  const accessibility = start(a11yLauncher, ['--launch-immediately'], { env: { ...env, GSETTINGS_BACKEND: 'memory', XDG_RUNTIME_DIR: a11yRuntime } });
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [fileURLToPath(new URL('../../native/accessibility.py', import.meta.url)), '--enable', String(accessibility.pid)],
      { env: { ...env, XDG_RUNTIME_DIR: a11yRuntime }, stdio: ['ignore', 'inherit', 'inherit'] });
    children.push(child);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Accessibility startup timed out')); }, 5500);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Accessibility startup failed')); });
  });
  start('openbox', [], { env });
  const password = randomBytes(6).toString('hex').slice(0, 8);
  const passwdFile = `${paths.dir}/vnc-passwd`;
  execFileSync('x11vnc', ['-storepasswd', password, passwdFile], { stdio: 'ignore' });
  start('x11vnc', ['-display', display, '-auth', paths.auth, '-forever', '-shared', '-localhost', '-rfbport', String(port), '-rfbauth', passwdFile, '-noxdamage'], { env });
  for (let i = 0; i < 40; i++) {
    if (await rfbReady(port)) {
      writeFileSync(`${paths.info}.tmp`, JSON.stringify({ display, port, password, instance, pid: process.pid, bus: process.env.DBUS_SESSION_BUS_ADDRESS }), { mode: 0o600 });
      renameSync(`${paths.info}.tmp`, paths.info);
      break;
    }
    if (i === 39) throw new Error('VNC startup timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
} catch (error) { console.error(error.message); stop(1); }
