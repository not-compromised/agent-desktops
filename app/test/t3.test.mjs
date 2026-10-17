import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { T3 } from '../t3.mjs';

const thread = { id: 'thread-one', title: 'Keep original settings', modelSelection: { instanceId: 'codex', model: 'gpt-6' }, runtimeMode: 'full-access', interactionMode: 'plan' };
const item = (id, role, text) => ({ position: Number(id), sourceThreadId: thread.id, sourceItemId: id, visibility: 'local', item: { id, type: role + '_message', messageId: 'message-' + id, text, updatedAt: '2026-10-16T10:00:00Z', startedAt: '2026-10-16T09:00:00Z', streaming: false } });
async function fixture() {
  const requests = [], commands = [];
  let drop = false;
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    assert.equal(req.headers['x-t3-orchestration-protocol'], '2');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/history?')) return res.end(JSON.stringify({ snapshotSequence: 4, items: [item('1', 'user', 'Older')], nextCursor: null, hasMoreHistory: false }));
    assert.equal(req.url, '/api/orchestration/threads/thread-one/bounded');
    res.end(JSON.stringify({ snapshotSequence: 4, projection: { thread, messages: [], visibleTurnItems: [item('2', 'assistant', 'Latest')], runs: [] }, historyCursor: 'opaque/cursor', hasMoreHistory: true }));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', (socket, req) => {
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('orchestrationProtocol'), '2');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    socket.on('message', data => {
      const request = JSON.parse(String(data));
      assert.equal(request._tag, 'Request'); assert.equal(request.tag, 'orchestration.dispatchCommand');
      commands.push(request.payload);
      if (drop) { drop = false; return socket.terminate(); }
      socket.send(JSON.stringify({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Success', value: { sequence: 5 } } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const t3 = new T3({ url: `http://127.0.0.1:${server.address().port}`, issue: async () => ({ token: 'fixture-token', sessionId: 'fixture-session' }), revoke: async () => {} });
  return { t3, requests, commands, drop() { drop = true; }, async close() { await t3.close(); for (const s of ws.clients) s.terminate(); await new Promise(resolve => server.close(resolve)); } };
}
test('V2 bounded/history responses preserve the viewer page contract without full history reads', async () => {
  const f = await fixture();
  try {
    const latest = await f.t3.page(thread.id);
    assert.equal(latest.thread.id, thread.id); assert.equal(latest.thread.messages[0].text, 'Latest');
    assert.equal(latest.thread.messages[0].id, 'message-2', 'local message IDs must acknowledge a pending submission in the viewer');
    assert.deepEqual(latest.page, { hasMore: true, beforeCursor: 'opaque/cursor' });
    const older = await f.t3.page(thread.id, latest.page.beforeCursor);
    assert.equal(older.thread.messages[0].text, 'Older'); assert.equal(older.page.hasMore, false);
    assert.ok(f.requests.at(-1).includes('/history?cursor=opaque%2Fcursor&view=conversation'));
  } finally { await f.close(); }
});
test('V2 dispatch retries one command and preserves model and server-owned runtime/interaction settings', async () => {
  const f = await fixture();
  try {
    f.drop();
    await assert.rejects(f.t3.send(thread.id, 'Continue', 'command-one', 'message-one'));
    await f.t3.send(thread.id, 'Continue', 'command-one', 'message-one');
    assert.deepEqual(f.commands[0], f.commands[1]);
    assert.equal(f.commands[0].type, 'message.dispatch');
    assert.equal(f.commands[0].threadId, thread.id); assert.equal(f.commands[0].messageId, 'message-one');
    assert.deepEqual(f.commands[0].modelSelection, thread.modelSelection);
    assert.deepEqual(f.commands[0].dispatchMode, { type: 'start_immediately' });
    assert.equal(f.commands[0].deliveryIntent, 'auto');
    assert.equal(f.commands[0].runtimeMode, undefined); assert.equal(f.commands[0].interactionMode, undefined);
    await assert.rejects(f.t3.send(thread.id, 'Changed', 'command-one', 'message-one'), /same message/);
    assert.equal(f.commands.length, 2);
    assert.equal(f.t3.pending.size, 0);
    assert.ok(!JSON.stringify([...f.t3.completed]).includes('Continue'), 'successful receipt cache contains fingerprints, not conversation text');
  } finally { await f.close(); }
});
test('unsupported V2 history is a definite rejection before dispatch', async () => {
  const t3 = new T3({ issue: async () => ({ token: 'fixture-token' }), revoke: async () => {}, request: async () => Response.json({ thread }) });
  await assert.rejects(t3.send(thread.id, 'Continue', 'command-one', 'message-one'), error => error.rejected === true && /V2|protocol|bounded/.test(error.message));
  await t3.close();
});

test('CLI discovery uses the managed current runtime and rejects path traversal without executing it', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveT3Runtime } = await import('../t3.mjs');
  const home = mkdtempSync(join(tmpdir(), 'agent-t3-runtime-'));
  try {
    const base = join(home, '.t3');
    mkdirSync(join(base, 'runtime/versions/1.0.0'), { recursive: true });
    mkdirSync(join(base, 'userdata'), { recursive: true });
    const executable = join(base, 'runtime/versions/1.0.0/t3');
    writeFileSync(executable, 'this is a fixture, never execute');
    writeFileSync(join(base, 'runtime/service-state.json'), JSON.stringify({ protocol: 3, activeVersion: '1.0.0' }));
    writeFileSync(join(base, 'userdata/server-runtime.json'), JSON.stringify({ origin: 'http://127.0.0.1:4555' }));
    assert.deepEqual(resolveT3Runtime({ home, env: {} }), { executable, baseDir: base, url: 'http://127.0.0.1:4555' });
    writeFileSync(join(base, 'runtime/service-state.json'), JSON.stringify({ protocol: 3, activeVersion: '../../other' }));
    assert.throws(() => resolveT3Runtime({ home, env: {} }), /current T3 executable/);
    assert.throws(() => resolveT3Runtime({ home, env: { AGENT_DESKTOP_T3_CLI: executable, AGENT_DESKTOP_T3_URL: 'https://remote.example' } }), /local T3/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('a failed settings read is rejected before any dispatch and releases its pending submission', async () => {
  const t3 = new T3({ issue: async () => ({ token: 'fixture-token' }), revoke: async () => {}, request: async () => { throw new Error('offline'); } });
  await assert.rejects(t3.send(thread.id, 'Continue', 'command-one', 'message-one'), error => error.rejected === true && /No message was sent/.test(error.message));
  assert.equal(t3.pending.size, 0);
  await t3.close();
});
