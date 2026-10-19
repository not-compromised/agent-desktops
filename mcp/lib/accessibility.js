import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('../../native/accessibility.py', import.meta.url));
const MAX_BYTES = 196608;
const unavailable = reason => ({ status: 'unavailable', reason, nodes: [], truncated: false });

function invoke(helper, request, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const clean = { ...env };
    for (const key of ['AT_SPI_BUS_ADDRESS', 'WAYLAND_SOCKET']) delete clean[key];
    const child = spawn('/usr/bin/python3', [helper], { env: clean, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, failure;
    const stop = reason => {
      failure ??= new Error(reason);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('accessibility query timed out'), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop('accessibility output exceeded its byte limit');
      else chunks.push(chunk);
    });
    // Provider errors may contain application content, so do not echo stderr.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('accessibility helper failed'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('accessibility helper returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function integer(value, fallback, max, name, minimum = 1) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < minimum || value > max) throw new Error(`${name} must be ${minimum}–${max}`);
  return value;
}

// Context comes from the backend's generation and exact managed-app registry.
// A missing registry deliberately cannot discover apps through the host bus.
export function createAccessibility({ context, instance, helper = HELPER, execute = invoke } = {}) {
  return {
    async query(n, options = {}, expected) {
      const timeoutMs = integer(options.timeout_ms, 3000, 10000, 'timeout_ms');
      const maxNodes = integer(options.max_nodes, 200, 500, 'max_nodes');
      const maxDepth = integer(options.max_depth, 8, 16, 'max_depth', 0);
      for (const key of ['role', 'name']) {
        if (options[key] !== undefined && (typeof options[key] !== 'string' || options[key].length > 512))
          throw new Error(`${key} must be a string of at most 512 characters`);
      }
      if (!expected) return unavailable('desktop generation is missing');
      const current = () => !instance || instance(n) === expected;
      if (!current()) return unavailable('desktop generation changed');
      let timer;
      const controller = new AbortController();
      const started = performance.now();
      try {
        const scoped = await Promise.race([
          Promise.resolve().then(() => context(n, expected, { signal: controller.signal })),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('accessibility context timed out')); }, timeoutMs); })
        ]);
        clearTimeout(timer);
        if (!current() || scoped?.instance !== expected) return unavailable('desktop generation changed');
        if (!scoped?.env?.DBUS_SESSION_BUS_ADDRESS || !scoped.desktop_cgroup)
          return unavailable('private accessibility session is unavailable');
        if (!Array.isArray(scoped.apps) || scoped.apps.length === 0)
          return unavailable('no managed application identities are registered for this desktop');
        if (scoped.apps.length > 256) return unavailable('managed application limit exceeded');
        const remaining = Math.floor(timeoutMs - (performance.now() - started));
        if (remaining < 1) return unavailable('accessibility query timed out');
        const result = await execute(helper, {
          desktop_cgroup: scoped.desktop_cgroup,
          apps: scoped.apps,
          window: options.window,
          role: options.role,
          name: options.name,
          max_nodes: maxNodes,
          max_depth: maxDepth,
          timeout_ms: remaining,
          max_bytes: MAX_BYTES,
          max_string: 512
        }, scoped.env, remaining);
        if (!current()) return unavailable('desktop generation changed');
        if (!['available', 'partial', 'unsupported', 'unavailable'].includes(result?.status) || !Array.isArray(result.nodes))
          return unavailable('accessibility helper returned an invalid result');
        return result;
      } catch (error) {
        return unavailable(error.message);
      } finally { clearTimeout(timer); controller.abort(); }
    }
  };
}
