import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { serve } from '../../server.mjs';

// A fixed-size RFB peer exercises the real renderer and scroll container.
export async function fixture(count = 1, { width = 1600, height = 1000 } = {}) {
  let holdFrames = false; const waitingFrames = [], connections = [];
  let settings = { idleMinutes: 30, browserStartup: 'fresh', viewerStartup: 'open', streamQuality: 'auto', notificationSeconds: 4 };
  const desks = Array.from({ length: count }, (_, i) => ({ desktop: i + 1, generation: 'pixels', held: true, ready: true,
    lastActivityAt: Date.now(), keepOpenUntil: null }));
  const rows = () => desks.map(d => ({ ...d, idleMinutes: settings.idleMinutes, closesAt: Math.max(d.lastActivityAt + settings.idleMinutes * 60000, d.keepOpenUntil || 0) }));
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/clipboard-test') return res.end(JSON.stringify(connections.flatMap(c => c.clipboard)));
    if (url.pathname.endsWith('/settings')) {
      if (req.method === 'POST') settings = { ...settings, ...input };
      return res.end(JSON.stringify({ settings }));
    }
    if (url.pathname.includes('/connect')) return res.end(JSON.stringify({ generation: 'pixels', password: '' }));
    const action = url.pathname.match(/\/(\d+)\/(activity|keep-open)$/);
    if (action) {
      const desktop = desks.find(d => d.desktop === Number(action[1]) && d.generation === input.generation);
      if (!desktop) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'Desktop ended.' })); }
      if (action[2] === 'activity') desktop.lastActivityAt = Date.now();
      else desktop.keepOpenUntil = input.minutes ? Date.now() + input.minutes * 60000 : null;
      return res.end(JSON.stringify({ desktop: rows().find(d => d.desktop === desktop.desktop) }));
    }
    return res.end(JSON.stringify({ settings, desktops: rows() }));
  });
  const ws = new WebSocketServer({ server: upstream });
  ws.on('connection', (socket, req) => {
    const connection = { socket, profile: new URL(req.url, 'http://fixture').searchParams.get('profile'), encodings: [], clipboard: [], pointers: [] }; connections.push(connection);
    let stage = 0, pending = Buffer.alloc(0);
    socket.send('RFB 003.008\n');
    socket.on('message', data => {
      pending = Buffer.concat([pending, data]);
      while (pending.length) {
        let length;
        if (stage === 0) length = 12;
        else if (stage < 3) length = 1;
        else {
          const type = pending[0];
          if (type === 0) length = 20;
          else if (type === 2) { if (pending.length < 4) return; length = 4 + pending.readUInt16BE(2) * 4; }
          else if (type === 3) length = 10;
          else if (type === 4) length = 8;
          else if (type === 5) length = 6;
          else if (type === 6) { if (pending.length < 8) return; length = 8 + pending.readUInt32BE(4); }
          else throw new Error(`Unexpected RFB message ${type}`);
        }
        if (pending.length < length) return;
        const message = pending.subarray(0, length); pending = pending.subarray(length);
        if (stage === 0) { socket.send(Buffer.from([1, 1])); stage++; }
        else if (stage === 1) { socket.send(Buffer.alloc(4)); stage++; }
        else if (stage === 2) {
          const init = Buffer.alloc(24); init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          socket.send(init); stage++;
        } else if (message[0] === 5) {
          connection.pointers.push({ buttons: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
        } else if (message[0] === 6) {
          connection.clipboard.push(message.subarray(8).toString('latin1'));
        } else if (message[0] === 2) {
          connection.encodings = Array.from({ length: message.readUInt16BE(2) }, (_, i) => message.readInt32BE(4 + i * 4));
        } else if (message[0] === 3 && message[1] === 0) {
          const frame = Buffer.alloc(16 + width * height * 4, 120);
          frame.fill(0, 0, 16); frame.writeUInt16BE(1, 2); frame.writeUInt16BE(width, 8); frame.writeUInt16BE(height, 10);
          if (holdFrames) waitingFrames.push(() => socket.readyState === 1 && socket.send(frame)); else socket.send(frame);
        }
      }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const app = await serve({ desktopURL: `http://127.0.0.1:${upstream.address().port}`, host: 'fixture', token: 'test-only',
    catalog: { read: async () => [], close() {} } });
  return { ...app, fixtureURL: `http://127.0.0.1:${upstream.address().port}`, connections, hold() { holdFrames = true; }, resume() { holdFrames = false; for (const send of waitingFrames.splice(0)) send(); }, disconnect() { for (const client of ws.clients) client.terminate(); }, async close() { await app.close(); for (const client of ws.clients) client.terminate(); await new Promise(r => upstream.close(r)); } };
}
