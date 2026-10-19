import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { installAgentFleet } from './agent-fleet.js';
import { installDashboard } from './dashboard.js';
import { createViewerStreams } from './viewer-streams.js';
import { createDesktopAudio } from './audio.js';
import { leaseGeneration } from './leases.js';

export function loadViewerPeers(file, host) {
  let rows;
  try { rows = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(rows)) throw new Error('viewer-peers.json must be an array');
  const ids = new Set([host]);
  return rows.map(({ id, url, tokenFile }) => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate viewer peer id');
    ids.add(id);
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Viewer peers require HTTPS endpoints without URL credentials');
    if (typeof tokenFile !== 'string' || !tokenFile) throw new Error('Viewer peer requires a tokenFile');
    const token = readFileSync(resolve(file, '..', tokenFile), 'utf8').trim();
    if (token.length < 32) throw new Error('Viewer peer token is too short');
    return { id, url: endpoint.href.replace(/\/$/, ''), token };
  });
}

export function installViewer(app, { host = 'hub', leases, nest, lifecycle, settings, origins, token, peers = [], web = true, wayland = true, streams = createViewerStreams({ nest, wayland }), agents = true, catalog, t3, audio = createDesktopAudio({ leases, enabled: false }) }) {
  const prefix = '/hypr-desktop/viewer';
  const originOK = req => origins.includes(req.headers.origin);
  const authorized = req => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return typeof token === 'string' && token.length >= 32 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const peerAuth = (req, res, next) => authorized(req) ? next() : res.sendStatus(401);
  const current = (n, generation) => [...leases.byHandle.values()].find(l => l.desktop === n && leases.live(l) && leaseGeneration(l) === generation);
  const localList = async () => Promise.all(leases.status().map(async d => {
    let ready = false;
    try { ready = Boolean(await nest.ready(d.desktop)); if (ready && wayland) await nest.windows(d.desktop); } catch { ready = false; }
    return { ...d, ready };
  }));
  const localInfo = async (n, generation) => {
    const lease = current(n, generation);
    if (!lease) throw Object.assign(new Error('This desktop has ended. Choose a running desktop.'), { status: 404 });
    if (!(await nest.ready(n))) throw Object.assign(new Error('This desktop is unavailable.'), { status: 503 });
    if (current(n, generation) !== lease) throw Object.assign(new Error('This desktop has ended.'), { status: 404 });
    return { generation, password: wayland ? '' : nest.info(n).password };
  };
  const peer = id => peers.find(p => p.id === id);
  const remote = async (p, path, body) => {
    const response = await fetch(p.url + prefix + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${p.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) throw Object.assign(new Error(response.status === 404 ? 'This desktop has ended.' : `${p.id} is unavailable.`), { status: response.status === 404 ? 404 : 503 });
    return response.json();
  };
  const route = handler => async (req, res) => { try { res.json(await handler(req)); } catch (error) { res.status(error.status || 503).json({ error: error.message }); } };
  app.get([prefix + '/desktops', '/viewer/desktops'], peerAuth, route(async () => ({ desktops: await localList(), ...(settings ? { settings: settings.read() } : {}) })));
  app.get([prefix + '/settings', '/viewer/settings'], peerAuth, route(() => {
    if (!settings) throw Object.assign(new Error('Desktop settings are unavailable.'), { status: 503 });
    return { settings: settings.read() };
  }));
  app.post([prefix + '/settings', '/viewer/settings'], peerAuth, express.json({ limit: '1kb' }), route(req => ({ settings: lifecycle.updateSettings(req.body) })));
  const timerRequest = (req, action) => {
    const desktop = Number(req.params.number), body = req.body;
    const allowed = action === 'activity' ? ['generation'] : ['generation', 'minutes'];
    if (!Number.isSafeInteger(desktop) || desktop < 1 || !body || typeof body.generation !== 'string' || !body.generation || body.generation.length > 128 || Object.keys(body).some(k => !allowed.includes(k)))
      throw Object.assign(new Error('Invalid desktop timer request.'), { status: 400 });
    if (!lifecycle) throw Object.assign(new Error('Desktop timers are unavailable.'), { status: 503 });
    return Promise.resolve(action === 'activity' ? lifecycle.activity(desktop, body.generation) : lifecycle.keepOpen(desktop, body.generation, body.minutes)).then(desktop => ({ desktop }));
  };
  for (const action of ['activity', 'keep-open']) {
    app.post([prefix + '/:number/' + action, '/viewer/:number/' + action], peerAuth, express.json({ limit: '1kb' }), route(req => timerRequest(req, action)));
    if (agents) app.post([prefix + '/agents/' + action + '/:host/:number', '/viewer/agents/' + action + '/:host/:number'], peerAuth, express.json({ limit: '1kb' }), route(req => {
      if (req.params.host === host) return timerRequest(req, action);
      const p = peer(req.params.host);
      if (!p) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
      return remote(p, `/${encodeURIComponent(req.params.number)}/${action}`, req.body);
    }));
  }
  app.get([prefix + '/:number/connect', '/viewer/:number/connect'], peerAuth, route(req => localInfo(Number(req.params.number), req.query.generation)));
  const audioRequest = req => req.method === 'POST'
    ? audio.set(Number(req.params.number), req.body?.generation, req.body?.muted)
    : audio.state(Number(req.params.number), req.query.generation);
  app.get([prefix + '/:number/audio', '/viewer/:number/audio'], peerAuth, route(audioRequest));
  app.post([prefix + '/:number/audio', '/viewer/:number/audio'], peerAuth, express.json({ limit: '1kb' }), route(audioRequest));
  const closeDesktop = req => {
    const desktop = Number(req.params.number), generation = req.body?.generation;
    if (!Number.isSafeInteger(desktop) || desktop < 1 || typeof generation !== 'string' || !generation || generation.length > 128)
      throw Object.assign(new Error('Invalid desktop close request.'), { status: 400 });
    if (!lifecycle) throw Object.assign(new Error('Desktop cleanup is unavailable.'), { status: 503 });
    return lifecycle.closeDesktop(desktop, generation);
  };
  app.post([prefix + '/:number/close', '/viewer/:number/close'], peerAuth, express.json({ limit: '1kb' }), route(closeDesktop));
  if (agents) app.post(prefix + '/agents/close/:host/:number', peerAuth, express.json({ limit: '1kb' }), route(req => {
    if (req.params.host === host) return closeDesktop(req);
    const p = peer(req.params.host);
    if (!p) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
    return remote(p, `/${encodeURIComponent(req.params.number)}/close`, req.body);
  }));
  const webAudio = route(async req => {
    if (req.params.host === host) return audioRequest(req);
    const p = peer(req.params.host);
    if (!p) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
    const path = `/${encodeURIComponent(req.params.number)}/audio`;
    return req.method === 'POST' ? remote(p, path, req.body) : remote(p, path + `?generation=${encodeURIComponent(req.query.generation || '')}`);
  });
  if (agents) {
    app.get(prefix + '/agents/audio/:host/:number', peerAuth, webAudio);
    app.post(prefix + '/agents/audio/:host/:number', peerAuth, express.json({ limit: '1kb' }), webAudio);
  }
  const fleet = agents ? installAgentFleet(app, { host, peers, leases, peerAuth, localList, localInfo, catalog, t3 }) : null;
  if (web) {
    // This UI has no password. Enable it only behind the tailnet-only gateway;
    // the listener stays loopback-only. Peer/API bearer authentication is separate.
    app.use((req, res, next) => {
      if (req.headers.origin && !originOK(req)) return res.sendStatus(403);
      res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" });
      next();
    });
    if (fleet) installDashboard(app, { fleet, token, originOK });
    else app.get('/api/desktops', route(async () => {
      const machines = await Promise.all([{ id: host }, ...peers].map(async p => {
        try {
          const desktops = p.id === host ? await localList() : (await remote(p, '/desktops')).desktops;
          return { id: p.id, online: true, desktops: desktops.map(d => ({ ...d, host: p.id })) };
        } catch { return { id: p.id, online: false, desktops: [] }; }
      }));
      return { hosts: machines.map(({ id, online }) => ({ id, online })), desktops: machines.flatMap(m => m.desktops) };
    }));
    app.get('/api/desktops/:host/:number/connect', route(async req => {
      const { host: id, number } = req.params;
      if (id === host) return localInfo(Number(number), req.query.generation);
      const p = peer(id);
      if (!p) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
      return remote(p, `/${encodeURIComponent(number)}/connect?generation=${encodeURIComponent(req.query.generation || '')}`);
    }));
    app.get('/api/desktops/:host/:number/audio', webAudio);
    app.post('/api/desktops/:host/:number/audio', (req, res, next) => {
      if (!originOK(req)) return res.sendStatus(403);
      if (!req.is('application/json')) return res.sendStatus(415);
      next();
    }, express.json({ limit: '1kb' }), webAudio);
    app.post('/api/desktops/:host/:number/activity', (req, res, next) => {
      if (!originOK(req)) return res.sendStatus(403);
      if (!req.is('application/json')) return res.sendStatus(415);
      next();
    }, express.json({ limit: '1kb' }), route(req => {
      if (req.params.host === host) return timerRequest(req, 'activity');
      const p = peer(req.params.host);
      if (!p) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
      return remote(p, `/${encodeURIComponent(req.params.number)}/activity`, req.body);
    }));
    app.use('/shared', express.static(fileURLToPath(new URL('../../shared/', import.meta.url)), { index: false }));
    app.get('/vendor/marked.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../../node_modules/marked/lib/marked.esm.js', import.meta.url))));
    app.get('/vendor/purify.js', (_req, res) => res.sendFile(fileURLToPath(new URL('../../node_modules/dompurify/dist/purify.es.mjs', import.meta.url))));
    app.use('/novnc', express.static(fileURLToPath(new URL('../../node_modules/@novnc/novnc/', import.meta.url)), { dotfiles: 'deny', index: false }));
    app.use(express.static(fileURLToPath(new URL('../viewer/', import.meta.url))));
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  const serveLocal = async (ws, n, generation, profile) => {
    let resource, tcp, stream;
    let closed = false;
    const close = () => { if (closed) return; closed = true; tcp?.destroy(); stream?.destroy(); ws.terminate(); void resource?.release(); };
    ws.on('close', close); ws.on('error', close);
    try {
      const lease = current(n, generation);
      if (!lease) return close();
      resource = await streams.acquire(n, generation, profile);
      if (closed || current(n, generation) !== lease) { await resource.release(); return close(); }
      tcp = createConnection(resource.endpoint);
      stream = createWebSocketStream(ws);
      tcp.on('error', close); stream.on('error', close); tcp.on('close', close);
      tcp.pipe(stream).pipe(tcp);
      const timer = setInterval(() => { if (current(n, generation) !== lease) close(); }, 1000);
      timer.unref(); ws.on('close', () => clearInterval(timer));
    } catch { close(); }
  };
  const relay = (ws, p, n, generation, profile) => {
    const url = new URL(p.url + prefix + `/stream/${n}`); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('generation', generation); url.searchParams.set('profile', profile);
    const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${p.token}` }, handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024, perMessageDeflate: false });
    const downstream = createWebSocketStream(ws);
    const source = createWebSocketStream(upstream);
    const close = () => { ws.terminate(); upstream.terminate(); downstream.destroy(); source.destroy(); };
    for (const endpoint of [ws, upstream, downstream, source]) endpoint.on('error', close);
    ws.on('close', close); upstream.on('close', close);
    downstream.pipe(source).pipe(downstream);
  };
  const attach = listener => {
    listener.on('upgrade', async (req, socket, head) => {
      socket.on('error', () => {});
      const deny = code => socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);
      try {
        const url = new URL(req.url, 'http://localhost');
        const internal = url.pathname.match(/^\/(?:hypr-desktop\/)?viewer\/stream\/([1-9]\d*)$/);
        const fleetStream = url.pathname.match(/^\/hypr-desktop\/viewer\/agents\/stream\/([a-z][a-z0-9-]*)\/([1-9]\d*)$/);
        const external = url.pathname.match(/^\/view\/([a-z][a-z0-9-]*)\/([1-9]\d*)$/);
        if (internal || fleetStream ? !authorized(req) : !web || !external || !originOK(req)) return deny(403);
        const id = internal ? host : (fleetStream || external)[1], n = Number(internal?.[1] || (fleetStream || external)?.[2]);
        const generation = url.searchParams.get('generation');
        const profile = url.searchParams.get('profile') === 'preview' ? 'preview' : 'full';
        const p = id === host ? null : peer(id);
        if (id !== host && !p) return deny(404);
        if (!p) await localInfo(n, generation);
        wss.handleUpgrade(req, socket, head, ws => {
          let alive = true;
          ws.on('pong', () => { alive = true; });
          const timer = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 15000);
          timer.unref(); ws.on('close', () => clearInterval(timer));
          if (p) relay(ws, p, n, generation, profile); else void serveLocal(ws, n, generation, profile);
        });
      } catch (error) { deny(error.status || 503); }
    });
    listener.on('close', () => { void audio.close(); for (const ws of wss.clients) ws.terminate(); wss.close(); void streams.close(); });
  };
  attach.close = async () => { await audio.close(); await fleet?.close(); for (const ws of wss.clients) ws.terminate(); await streams.close(); };
  return attach;
}
