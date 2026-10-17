import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';

const exec = promisify(execFile);
const reject = (message, status = 409) => Object.assign(new Error(message), { status, rejected: true });
const protocol = { 'x-t3-orchestration-protocol': '2' };
const lifetime = 15 * 60 * 1000;
const readJSON = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function resolveT3Runtime({ home = homedir(), env = process.env } = {}) {
  const baseDir = env.AGENT_DESKTOP_T3_BASE_DIR || join(home, '.t3');
  const state = readJSON(join(baseDir, 'userdata/server-runtime.json'));
  let executable = env.AGENT_DESKTOP_T3_CLI;
  if (!executable) {
    const service = readJSON(join(baseDir, 'runtime/service-state.json'));
    if (service?.protocol === 3 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(service.activeVersion)) {
      executable = join(baseDir, 'runtime/versions', service.activeVersion, 't3');
    }
  }
  if (!executable || !isAbsolute(executable)) throw reject('T3 chat needs the current T3 executable. Set AGENT_DESKTOP_T3_CLI to its absolute path.');
  try { if (!statSync(executable).isFile()) throw new Error(); } catch { throw reject('The configured T3 executable is unavailable.'); }
  const url = env.AGENT_DESKTOP_T3_URL || state?.origin || 'http://127.0.0.1:3773';
  const endpoint = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw reject('T3 chat requires a local T3 server origin.');
  }
  return { executable, baseDir, url: endpoint.origin };
}

export function turnCommand(thread, text, commandId, messageId) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw reject('Enter a message of at most 100,000 characters.', 400);
  if (!thread?.id || !thread.modelSelection || !thread.runtimeMode || !thread.interactionMode) throw reject('This T3 version does not provide the required V2 thread settings.');
  return { type: 'message.dispatch', commandId, threadId: thread.id, messageId,
    createdBy: 'user', creationSource: 'web', text, attachments: [],
    modelSelection: thread.modelSelection, dispatchMode: { type: 'start_immediately' }, deliveryIntent: 'auto' };
}

function messages(items = [], threadId) {
  const result = new Map();
  for (const row of items) {
    const item = row.item;
    if (!item || !['user_message', 'assistant_message'].includes(item.type) || typeof item.text !== 'string') continue;
    const nativeId = item.messageId || row.sourceItemId;
    const id = row.sourceThreadId === threadId ? nativeId : `${row.sourceThreadId}/${nativeId}`;
    result.set(id, { id, role: item.type === 'user_message' ? 'user' : 'assistant', text: item.text,
      createdAt: item.startedAt || item.updatedAt, updatedAt: item.updatedAt, streaming: Boolean(item.streaming), attachments: item.attachments || [] });
  }
  return [...result.values()];
}

export class T3 {
  constructor({ url, issue, revoke, request = fetch, socket = (url, options) => new WebSocket(url, options), runtime = resolveT3Runtime, timeout = 15000 } = {}) {
    this.url = url; this.request = request; this.socket = socket; this.runtime = runtime; this.timeout = timeout;
    this.pending = new Map(); this.completed = new Map(); this.sockets = new Set(); this.timers = new Set(); this.expirations = new Map(); this.closed = false;
    const cli = async args => {
      this.location ||= this.runtime();
      this.url ||= this.location.url;
      return exec(this.location.executable, [...args, '--base-dir', this.location.baseDir], { timeout: this.timeout, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    };
    this.issue = issue || (async () => {
      try {
        const { stdout } = await cli(['auth', 'session', 'issue', '--ttl', '8h', '--label', 'Agent Desktops', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--json']);
        const auth = JSON.parse(stdout);
        if (typeof auth.token !== 'string' || typeof auth.sessionId !== 'string') throw new Error();
        return auth;
      } catch (error) { throw reject(error.rejected ? error.message : 'T3 session setup failed. Configure a current T3 V2 executable and its base directory.'); }
    });
    this.revoke = revoke || (id => cli(['auth', 'session', 'revoke', id]));
  }
  async credentials() {
    if (this.closed) throw reject('T3 chat has closed. Reopen Agent Desktops.');
    this.auth ||= this.issue().catch(error => { this.auth = null; throw error; });
    return this.auth;
  }
  async call(path, retry = true) {
    const auth = await this.credentials();
    const response = await this.request((this.url || 'http://127.0.0.1:3773') + path, {
      headers: { ...protocol, Authorization: `Bearer ${auth.token}` }, redirect: 'error', signal: AbortSignal.timeout(this.timeout)
    });
    if (response.status === 401 && retry) {
      if (this.auth && await this.auth === auth) { this.auth = null; await this.revoke(auth.sessionId).catch(() => {}); }
      return this.call(path, false);
    }
    if (!response.ok) throw reject(`T3 V2 history unavailable (${response.status}). Check the server version and session permissions.`);
    return response.json();
  }
  async page(thread, cursor) {
    const path = `/api/orchestration/threads/${encodeURIComponent(thread)}`;
    if (cursor) {
      const result = await this.call(`${path}/history?${new URLSearchParams({ cursor, view: 'conversation' })}`);
      if (!Array.isArray(result.items) || typeof result.hasMoreHistory !== 'boolean') throw reject('This T3 version does not provide V2 paginated history.');
      return { snapshotSequence: result.snapshotSequence, thread: { id: thread, messages: messages(result.items, thread) }, page: { hasMore: result.hasMoreHistory, beforeCursor: result.nextCursor } };
    }
    const result = await this.call(path + '/bounded');
    if (result.projection?.thread?.id !== thread || !Array.isArray(result.projection.visibleTurnItems) || typeof result.hasMoreHistory !== 'boolean') throw reject('This T3 version does not provide the required V2 bounded history.');
    return { snapshotSequence: result.snapshotSequence, thread: { ...result.projection.thread, messages: messages(result.projection.visibleTurnItems, thread) }, page: { hasMore: result.hasMoreHistory, beforeCursor: result.historyCursor } };
  }
  async dispatch(command) {
    const auth = await this.credentials();
    const url = new URL('/ws', this.url || 'http://127.0.0.1:3773');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    return new Promise((resolve, rejectPromise) => {
      const socket = this.socket(url, { headers: { Authorization: `Bearer ${auth.token}` }, handshakeTimeout: this.timeout, maxPayload: 1024 * 1024 });
      this.sockets.add(socket);
      const id = randomUUID();
      let settled = false, submitted = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.sockets.delete(socket); socket.terminate();
        if (error) rejectPromise(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('T3 did not confirm the message. Retry the same submission.')), this.timeout);
      socket.on('open', () => {
        submitted = true;
        socket.send(JSON.stringify({ _tag: 'Request', id, tag: 'orchestration.dispatchCommand', payload: command, headers: [] }));
      });
      socket.on('message', data => {
        try {
          const frames = JSON.parse(String(data));
          for (const frame of Array.isArray(frames) ? frames : [frames]) {
            if (frame._tag === 'Ping') { socket.send(JSON.stringify({ _tag: 'Pong' })); continue; }
            if (frame._tag !== 'Exit' || String(frame.requestId) !== id) continue;
            if (frame.exit?._tag === 'Success') return finish(null, frame.exit.value);
            // A server-side dispatch failure may follow intake: keep the same command for retries.
            return finish(new Error('T3 could not confirm the message. Retry the same submission.'));
          }
        } catch { finish(new Error('T3 returned an unsupported RPC response. Retry the same submission.')); }
      });
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        finish(reject(`T3 V2 dispatch unavailable (${response.statusCode}). Check the server version and session permissions.`));
      });
      socket.on('error', () => finish(submitted ? new Error('T3 did not confirm the message. Retry the same submission.') : reject('Cannot connect to the T3 V2 server.')));
      socket.on('close', () => finish(new Error('T3 did not confirm the message. Retry the same submission.')));
    });
  }
  remember(map, key, value) {
    map.set(key, value);
    const timer = setTimeout(() => { this.timers.delete(timer); this.expirations.delete(value); if (map.get(key) === value) map.delete(key); }, lifetime);
    timer.unref(); this.timers.add(timer); this.expirations.set(value, timer);
  }
  forget(map, key) {
    const value = map.get(key), timer = this.expirations.get(value);
    clearTimeout(timer); this.timers.delete(timer); this.expirations.delete(value); map.delete(key);
  }
  async send(threadId, text, commandId, messageId) {
    if (![commandId, messageId].every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id)) || typeof text !== 'string' || !text.trim() || text.length > 100000) throw reject('Invalid message.', 400);
    const fingerprint = createHash('sha256').update(JSON.stringify([threadId, text, messageId])).digest('hex');
    const completed = this.completed.get(commandId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) throw reject('A retry must keep the same message and thread.', 400);
      return completed.result;
    }
    let pending = this.pending.get(commandId);
    if (!pending) {
      if (this.pending.size >= 128) throw reject('Too many unconfirmed messages. Retry an outstanding submission first.');
      pending = { fingerprint, command: this.page(threadId).then(({ thread }) => turnCommand(thread, text, commandId, messageId)).catch(error => {
        throw error.rejected ? error : reject('T3 thread settings could not be read. No message was sent.');
      }) };
      this.remember(this.pending, commandId, pending);
      pending.command.catch(() => { if (this.pending.get(commandId) === pending) this.forget(this.pending, commandId); });
    }
    if (pending.fingerprint !== fingerprint) throw reject('A retry must keep the same message and thread.', 400);
    const command = await pending.command;
    let result;
    try { result = await this.dispatch(command); }
    catch (error) { if (error.rejected && this.pending.get(commandId) === pending) this.forget(this.pending, commandId); throw error; }
    this.forget(this.pending, commandId);
    this.remember(this.completed, commandId, { fingerprint, result });
    if (this.completed.size > 256) this.forget(this.completed, this.completed.keys().next().value);
    return result;
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const socket of this.sockets) socket.terminate();
    this.pending.clear(); this.completed.clear(); this.expirations.clear();
    if (this.auth) { const auth = await this.auth.catch(() => null); if (auth) await this.revoke(auth.sessionId).catch(() => {}); }
  }
}
