import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../native/bin/agent-desktop-held', import.meta.url));
const XVFB = fileURLToPath(new URL('../../native/held/xvfb-held.py', import.meta.url));
const buttonNames = new Set(['left', 'middle', 'right']);
const error = message => Object.assign(new Error(message), { code: 'HELD_INPUT_FAILED' });

// env must describe the already-authorized generation. quarantine must stop that
// generation only, and retain its lease when stopping cannot be confirmed.
export function createHeldInput({ backend = 'wayland', env, quarantine, start = spawn, now = Date.now } = {}) {
  if (typeof env !== 'function' || typeof quarantine !== 'function') throw new Error('held input requires env and quarantine');
  if (!['wayland', 'xvfb'].includes(backend)) throw new Error('unknown held input backend');
  const sessions = new Map();
  const blocked = new Map();
  const queues = new Map();
  const serial = (n, fn) => {
    const next = (queues.get(n) ?? Promise.resolve()).then(fn, fn);
    queues.set(n, next.catch(() => {}));
    return next;
  };
  const invalidate = (session, reason) => {
    if (session.failed) return session.failure;
    session.failed = true;
    clearTimeout(session.timer);
    if (sessions.get(session.n) === session) sessions.delete(session.n);
    session.child.stdin.destroy();
    session.child.kill('SIGTERM');
    session.failure = Promise.resolve().then(() => quarantine(session.n, session.expected, reason));
    blocked.set(session.n, session.failure);
    session.failure.then(() => { if (blocked.get(session.n) === session.failure) blocked.delete(session.n); }, () => {});
    for (const request of session.requests.splice(0)) session.failure.then(() => request.reject(reason), request.reject);
    session.failure.catch(() => {});
    return session.failure;
  };
  const request = (session, command, args = []) => new Promise((resolve, reject) => {
    if (session.failed) { reject(error('held input session has ended')); return; }
    const timer = setTimeout(() => {
      const failure = error('held input helper did not acknowledge command');
      invalidate(session, failure).then(() => reject(failure), reject);
    }, 5000);
    session.requests.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: reason => { clearTimeout(timer); reject(reason); } });
    session.child.stdin.write([command, ...args.map(value => Buffer.from(String(value)).toString('hex') || '-')].join(' ') + '\n', err => {
      if (err) invalidate(session, err);
    });
  });
  const create = (n, expected) => {
    if (!Number.isSafeInteger(n) || n < 1 || !expected) throw error('owned desktop and generation are required');
    const child = start(backend === 'xvfb' ? 'python3' : BIN, backend === 'xvfb' ? [XVFB] : [], {
      env: { ...env(n, expected), AGENT_DESKTOP: String(n), AGENT_DESKTOP_INSTANCE: expected },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const session = { n, expected, child, requests: [], keys: [], buttons: [], expires_at: null, buffer: '', stderr: '', failed: false };
    sessions.set(n, session);
    child.stderr.on('data', data => { session.stderr = (session.stderr + data).slice(-2000); });
    child.stdout.on('data', data => {
      session.buffer += data;
      if (session.buffer.length > 65536) { invalidate(session, error('held input helper response exceeded limit')); return; }
      let end;
      while ((end = session.buffer.indexOf('\n')) !== -1) {
        const line = session.buffer.slice(0, end); session.buffer = session.buffer.slice(end + 1);
        if (line === 'released' || line === 'expired') {
          clearTimeout(session.timer); session.keys = []; session.buttons = []; session.expires_at = null;
          continue;
        }
        if (line === 'closed') {
          session.closed = true;
          clearTimeout(session.timer);
          if (sessions.get(session.n) === session) sessions.delete(session.n);
          for (const pending of session.requests.splice(0)) pending.reject(error('held input session ended after confirmed cleanup'));
          continue;
        }
        const pending = session.requests.shift();
        if (!pending) { invalidate(session, error('unexpected held input helper response')); return; }
        if (line === 'ok') pending.resolve();
        else {
          const reason = error(line.startsWith('error ') ? line.slice(6) : 'invalid held input helper response');
          invalidate(session, reason).then(() => pending.reject(reason), pending.reject);
        }
      }
    });
    child.on('error', reason => { invalidate(session, reason); });
    child.on('exit', (code, signal) => {
      if (!session.closed && !session.failed) invalidate(session, error(`held input helper exited (${signal ?? code}): ${session.stderr}`));
    });
    return session;
  };
  const matching = (n, expected) => {
    const session = sessions.get(n);
    if (session && session.expected !== expected) throw error('held input desktop generation changed; release the old session before reuse');
    return session;
  };
  const release = (n, expected) => serial(n, async () => {
    if (blocked.has(n)) await blocked.get(n);
    const session = sessions.get(n);
    if (!session) return;
    if (expected !== undefined && session.expected !== expected) throw error('held input desktop generation changed');
    await request(session, 'RELEASE');
    clearTimeout(session.timer);
    session.closed = true;
    sessions.delete(n);
    session.child.stdin.end();
  });
  return {
    state: n => {
      const s = sessions.get(n);
      return s && !s.failed ? { keys: [...s.keys], buttons: [...s.buttons], expires_at: s.expires_at }
        : { keys: [], buttons: [], expires_at: null };
    },
    active: n => {
      const s = sessions.get(n);
      return !!s && !s.failed && (s.keys.length > 0 || s.buttons.length > 0);
    },
    set: (n, { keys = [], buttons = [], timeout_ms = 5000 }, expected) => serial(n, async () => {
      if (blocked.has(n)) await blocked.get(n);
      if (!Array.isArray(keys) || keys.length > 16 || new Set(keys).size !== keys.length || keys.some(k => typeof k !== 'string' || !/^[A-Za-z0-9_]+$/.test(k))) throw error('keys must be at most 16 distinct XKB names');
      if (!Array.isArray(buttons) || buttons.length > 3 || new Set(buttons).size !== buttons.length || buttons.some(b => !buttonNames.has(b))) throw error('buttons must be distinct left, middle or right');
      if (!Number.isInteger(timeout_ms) || timeout_ms < 100 || timeout_ms > 30000) throw error('held input timeout must be 100–30000 ms');
      const session = matching(n, expected) ?? (keys.length || buttons.length ? create(n, expected) : null);
      if (!session) return { keys: [], buttons: [], expires_at: null };
      await request(session, 'SET', [timeout_ms, keys.join(','), buttons.join(',')]);
      clearTimeout(session.timer);
      session.keys = [...keys]; session.buttons = [...buttons];
      session.expires_at = keys.length || buttons.length ? now() + timeout_ms : null;
      if (session.expires_at) session.timer = setTimeout(() => {
        // Native deadlines release independently. This is a second watchdog for
        // a stopped helper, including one blocked inside a compositor request.
        request(session, 'RELEASE').then(() => {
          session.keys = []; session.buttons = []; session.expires_at = null;
        }).catch(() => {});
      }, timeout_ms);
      return { keys: [...session.keys], buttons: [...session.buttons], expires_at: session.expires_at };
    }),
    command: (n, kind, args, expected) => serial(n, async () => {
      const session = matching(n, expected);
      if (!session) throw error('no resident input session');
      if (!['move', 'click', 'scroll', 'drag', 'key', 'type'].includes(kind) || !Array.isArray(args)) throw error('unsupported resident input command');
      await request(session, kind.toUpperCase(), args);
    }),
    release,
    // Only the backend's verified service-stop path may call this. A release
    // request or a failed cleanup attempt is never evidence that input ended.
    confirmStopped: n => {
      const session = sessions.get(n);
      if (session) {
        session.closed = true;
        session.failed = true;
        clearTimeout(session.timer);
        sessions.delete(n);
        session.child.stdin.destroy();
        session.child.kill('SIGTERM');
        for (const pending of session.requests.splice(0)) pending.reject(error('owned desktop has stopped'));
      }
      blocked.delete(n);
    },
    closeAll: () => Promise.allSettled([...sessions.values()].map(s => release(s.n, s.expected)).concat([...blocked.values()])).then(results => {
      const failures = results.filter(r => r.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'held input cleanup failed');
    })
  };
}
