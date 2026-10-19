import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('../../native/window-lifetimes.py', import.meta.url));
const address = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid owned window address');
  return `0x${BigInt(value).toString(16)}`;
};

// readWindows is a callback so subscription always precedes the first inventory.
// A lost monitor is never silently replaced within the same generation.
export function createWindowLifetimes({ backend = 'wayland', env, instance, start = spawn, timeout_ms = 2000 } = {}) {
  const monitors = new Map();
  const queues = new Map();
  const serial = (n, fn) => {
    const next = (queues.get(n) ?? Promise.resolve()).then(fn, fn);
    queues.set(n, next.catch(() => {}));
    return next;
  };
  const close = (monitor, reason) => {
    if (monitor.failure) return;
    monitor.failure = reason;
    monitor.child.stdin.destroy(); monitor.child.kill('SIGTERM');
    monitor.rejectReady(reason);
    for (const request of monitor.pending.values()) request.reject(reason);
    monitor.pending.clear();
  };
  const open = (n, expected) => {
    const old = monitors.get(n);
    if (old?.expected === expected) return old;
    if (old) close(old, new Error('Desktop window monitor generation changed'));
    if (!Number.isSafeInteger(n) || n < 1 || !expected || instance(n) !== expected)
      throw new Error('Owned desktop generation is required for window inventory');
    const child = start('/usr/bin/python3', [HELPER], {
      env: { ...env(n, expected), AGENT_DESKTOP: String(n), AGENT_DESKTOP_INSTANCE: expected, AGENT_DESKTOP_WINDOW_BACKEND: backend },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => {});
    const monitor = { child, expected, ready, rejectReady, pending: new Map(), counter: 0, buffer: '', failure: null };
    monitors.set(n, monitor);
    const startup = setTimeout(() => close(monitor, new Error('Owned window monitor startup timed out')), timeout_ms);
    ready.then(() => clearTimeout(startup), () => clearTimeout(startup));
    child.stderr.resume();
    child.stdin.on('error', error => close(monitor, error));
    child.on('error', error => close(monitor, error));
    child.on('exit', () => close(monitor, new Error('Owned window event connection was lost; release and claim again')));
    child.stdout.on('data', data => {
      monitor.buffer += data;
      if (monitor.buffer.length > 1048576) { close(monitor, new Error('Window monitor response exceeded limit')); return; }
      let end;
      while ((end = monitor.buffer.indexOf('\n')) !== -1) {
        const line = monitor.buffer.slice(0, end); monitor.buffer = monitor.buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.event === 'ready') resolveReady();
          else {
            const request = monitor.pending.get(result.id);
            if (!request || !Number.isSafeInteger(result.revision) || !result.epochs || typeof result.epochs !== 'object')
              throw new Error('Invalid window monitor response');
            monitor.pending.delete(result.id); request.resolve(result);
          }
        } catch (error) { close(monitor, error); return; }
      }
    });
    return monitor;
  };
  const snapshot = (monitor, addresses) => new Promise((resolve, reject) => {
    if (monitor.failure) { reject(monitor.failure); return; }
    const id = ++monitor.counter;
    const timer = setTimeout(() => close(monitor, new Error('Owned window inventory synchronization timed out')), timeout_ms);
    monitor.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: reason => { clearTimeout(timer); reject(reason); } });
    monitor.child.stdin.write(JSON.stringify({ id, addresses }) + '\n', error => { if (error) close(monitor, error); });
  });
  return {
    inventory: (n, readWindows, expected = instance(n)) => serial(n, async () => {
      if (typeof readWindows !== 'function') throw new Error('Window inventory requires a reader callback');
      const monitor = open(n, expected);
      const deadline = performance.now() + timeout_ms;
      const controller = new AbortController();
      let budget;
      const work = async () => {
        await monitor.ready;
        for (let attempt = 0; attempt < 3; attempt++) {
          controller.signal.throwIfAborted();
          if (monitor.failure) throw monitor.failure;
          if (instance(n) !== expected) throw new Error('Desktop changed during window inventory');
          const before = await snapshot(monitor, []);
          const windows = await readWindows(controller.signal);
          controller.signal.throwIfAborted();
          if (windows.length > 4096) throw new Error('Window inventory exceeded limit');
          const after = await snapshot(monitor, windows.map(w => address(w.address)));
          controller.signal.throwIfAborted();
          if (instance(n) !== expected) throw new Error('Desktop changed during window inventory');
          if (before.revision !== after.revision) {
            if (performance.now() >= deadline) break;
            continue;
          }
          return windows.map(window => {
            const lifetime = after.epochs[address(window.address)];
            if (typeof lifetime !== 'string' || !lifetime) throw new Error('Window creation epoch is unavailable');
            return { ...window, lifetime };
          });
        }
        throw new Error('Windows changed during inventory; observe again');
      };
      try {
        return await Promise.race([work(), new Promise((_, reject) => {
          budget = setTimeout(() => {
            const reason = new Error('Owned window inventory exceeded its time budget');
            controller.abort(reason);
            close(monitor, reason); reject(reason);
          }, timeout_ms);
        })]);
      } finally { clearTimeout(budget); }
    }),
    stop: n => {
      const monitor = monitors.get(n);
      if (monitor) close(monitor, new Error('Owned desktop window monitor stopped'));
      monitors.delete(n);
    },
    closeAll: () => {
      for (const monitor of monitors.values()) close(monitor, new Error('Window monitoring ended'));
      monitors.clear();
    }
  };
}
