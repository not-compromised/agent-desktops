import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopAudio } from '../lib/audio.js';
import { nestEnv } from '../lib/nest.js';

const exec = promisify(execFile);
const desktop = 99991;
const lease = { desktop, generation: `audio-check-${process.pid}` };
const leases = { byHandle: new Map([[lease.generation, lease]]), live: l => leases.byHandle.get(l.generation) === l };
const audio = createDesktopAudio({ leases, interval: 0 });
const children = [];
const owned = async () => {
  const graph = JSON.parse((await exec('pw-dump', [], { maxBuffer: 16 * 1024 * 1024 })).stdout);
  const clients = new Map(graph.filter(o => o.type.endsWith(':Client')).map(o => [o.id, o.info.props]));
  return graph.filter(o => o.type.endsWith(':Node') && o.info.props['client.api'] === 'jack')
    .map(o => ({ pid: Number(clients.get(o.info.props['client.id'])?.['pipewire.sec.pid']),
      links: graph.filter(l => l.type.endsWith(':Link') && l.info['output-node-id'] === o.id).length }))
    .filter(s => children.some(c => c.pid === s.pid));
};
const state = () => audio.state(desktop, lease.generation);
const probe = `
import ctypes, sys
al = ctypes.CDLL(sys.argv[1])
al.alcOpenDevice.restype = ctypes.c_void_p
al.alcCreateContext.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
al.alcCreateContext.restype = ctypes.c_void_p
al.alcMakeContextCurrent.argtypes = [ctypes.c_void_p]
dev = al.alcOpenDevice(None)
assert dev, 'OpenAL device failed to open'
ctx = al.alcCreateContext(dev, None)
assert ctx, 'OpenAL context failed to open'
assert al.alcMakeContextCurrent(ctx), 'OpenAL context failed to activate'
print('ready', flush=True)
sys.stdin.read()
`;
async function start(agent) {
  const env = { ...(agent ? nestEnv(desktop) : { ...process.env, DISPLAY: ':0', AGENT_DESKTOP: '', WAYLAND_DISPLAY: '', HYPRLAND_INSTANCE_SIGNATURE: '', PIPEWIRE_PROPS: '{state.restore-props=false}' }), ALSOFT_DRIVERS: 'jack' };
  // No source or buffer is created, so OpenAL emits only silence.
  const child = spawn('python3', ['-c', probe, process.argv[2] ?? 'libopenal.so.1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenAL startup timed out: ${stderr}`)), 5000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenAL exited ${code}: ${stderr}`)); });
  });
  return child;
}
async function waitForStreams(count) {
  for (let i = 0; i < 40; i++) {
    if ((await owned()).length === count) return;
    await delay(50);
  }
  throw new Error(`Expected ${count} OpenAL test streams`);
}
try {
  const agent = await start(true);
  const user = await start(false);
  await waitForStreams(2);
  assert.deepEqual(await state(), { available: true, muted: true, streams: 1 });
  let streams = await owned();
  assert.equal(streams.find(s => s.pid === agent.pid).links, 0);
  assert.equal(streams.find(s => s.pid === user.pid).links, 2);
  await audio.set(desktop, lease.generation, false);
  assert.ok((await owned()).every(s => s.links === 2));
  await audio.set(desktop, lease.generation, true);
  await start(true);
  await waitForStreams(3);
  await audio.tick();
  assert.equal((await state()).streams, 2);
  streams = await owned();
  for (const stream of streams) assert.equal(stream.links, stream.pid === user.pid ? 2 : 0);
  console.log('PASS: real OpenAL JACK mute/unmute, new-device mute, ordinary desktop untouched.');
} finally {
  await audio.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && child.pid > 1) {
      const exited = once(child, 'exit');
      child.stdin.end();
      await exited;
    }
  }
  assert.equal((await owned()).length, 0, 'test streams cleaned up');
}
