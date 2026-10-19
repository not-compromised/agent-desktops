import { sendAsset } from '../shared/server-assets.js';
import express from 'express';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { T3 } from './t3.mjs';
import { responseJSON, sendError, jsonBodyError } from './http-errors.mjs';
import { conversationId } from './conversation-id.mjs';
import { readSettings, saveSettings } from './settings.mjs';
import { DEFAULT_SETTINGS } from '../mcp/lib/settings.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const VENDOR = fileURLToPath(new URL('../node_modules/', import.meta.url));
const SHARED = fileURLToPath(new URL('../shared/', import.meta.url));
export { startCatalog } from './catalog.mjs';
import { startCatalog } from './catalog.mjs';

const desktopKey = ({ host, desktop, generation }) => `${host}/${desktop}/${generation}`;

export async function serve({ catalog, t3 = new T3(),
  desktopURL = 'http://127.0.0.1:7873', token = readFileSync(homedir() + '/.local/share/hypr-desktop/token', 'utf8').trim(),
  host = hostname(), request = fetch, fleet = false, localDesktop, configHome = homedir() } = {}) {
  catalog ||= fleet ? { close() {} } : startCatalog();
  const app = express(), router = express.Router(), server = createServer(app);
  const secret = randomBytes(32).toString('hex'), base = `/${secret}/`;
  const chats = new Map();
  let origin, current = [], refreshing, refreshedAt = 0, metadataWarning = '', cleanupDesktops = [];
  const known = new Map();
  let fleetHosts = [], settings = { ...DEFAULT_SETTINGS };
  const localTarget = () => fleet ? localDesktop : { url: desktopURL, token };
  const requireLocal = () => { const target = localTarget(); if (!target) throw Object.assign(new Error('Local desktop settings are unavailable on this computer.'), { status: 503 }); return target; };
  const desktop = async (path, body, target = { url: desktopURL, token }, timeout = 25000) => {
    const response = await request(target.url + '/hypr-desktop/viewer' + path, {
      method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeout), redirect: 'error' });
    return responseJSON(response, `Desktop service unavailable (${response.status}).`);
  };
  async function refresh() {
    if (fleet && current && Date.now() - refreshedAt < 500) return current;
    if (fleet) {
      refreshing ||= Promise.allSettled([
        desktop('/agents/fleet', undefined, undefined, 2000).then(data => {
          if (!Array.isArray(data?.hosts) || !Array.isArray(data?.desktops) || data.hosts.some(h => !h || typeof h.id !== 'string') || data.desktops.some(d => !d || typeof d.host !== 'string')) throw new Error('Invalid fleet snapshot');
          return data;
        }),
        localDesktop ? desktop('/desktops', undefined, localDesktop, 1500).then(data => {
          if (!Array.isArray(data?.desktops) || data.desktops.some(d => !d || typeof d !== 'object')) throw new Error('Invalid local snapshot');
          return data;
        }) : Promise.resolve(null)
      ]).then(([remote, local]) => {
        const remoteOK = remote.status === 'fulfilled';
        const localOK = local.status === 'fulfilled' && local.value;
        if (!remoteOK && !localOK) throw remote.reason;
        if (remoteOK) fleetHosts = remote.value.hosts;
        const data = remoteOK ? { hosts: [...remote.value.hosts], desktops: [...remote.value.desktops] }
          : { hosts: fleetHosts.map(h => ({ ...h, online: false })), desktops: [] };
        if (localOK) {
          settings = local.value.settings || settings;
          cleanupDesktops = local.value.desktops.map(({ desktop, generation }) => ({ host: localDesktop.host, desktop, generation }));
          const labels = new Map([...known, ...data.desktops.map(d => [desktopKey(d), d])]);
          data.desktops = data.desktops.filter(d => d.host !== localDesktop.host);
          data.desktops.push(...local.value.desktops.filter(d => d.held).map(d => ({
            ...labels.get(desktopKey({ ...d, host: localDesktop.host })), ...d, host: localDesktop.host, reconnecting: false
          })));
          data.hosts = data.hosts.filter(h => h.id !== localDesktop.host);
          data.hosts.push({ id: localDesktop.host, online: true });
        }
        const offline = new Set(data.hosts.filter(h => !h.online).map(h => h.id));
        const incoming = new Map(data.desktops.map(d => [desktopKey(d), d]));
        for (const [id, previous] of known) {
          if (incoming.has(id)) known.set(id, incoming.get(id));
          else if (offline.has(previous.host)) known.set(id, { ...previous, ready: false, reconnecting: true });
          else known.delete(id);
        }
        for (const [id, d] of incoming) if (!known.has(id)) known.set(id, d);
        current = [...known.values()]; metadataWarning = [!remoteOK ? 'Fleet discovery unavailable; local desktops remain available' : '', ...data.hosts.filter(h => !h.online).map(h => `${h.id} offline`)].filter(Boolean).join(' · ');
        refreshedAt = Date.now(); return current;
      }).finally(() => { refreshing = null; });
      return refreshing;
    }
    refreshing ||= Promise.all([desktop('/desktops'), catalog.read().then(value => {
      metadataWarning = ''; return value;
    }, error => { metadataWarning = `Session names unavailable: ${error.message}`; return []; })]).then(([status, labels]) => {
      settings = status.settings || settings;
      cleanupDesktops = status.desktops.map(({ desktop, generation }) => ({ host, desktop, generation }));
      current = status.desktops.filter(d => d.held).map(d => ({ ...d,
        ...labels.find(l => l.desktop === d.desktop && l.generation === d.generation) })).map(d => ({ ...d, host, agentId: conversationId(host, d.threadId) }));
      return current;
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  const route = (fn, conditional = false) => async (req, res) => {
    try {
      const value = await fn(req);
      if (!conditional) return res.json(value);
      const body = JSON.stringify(value);
      const revision = typeof conditional === 'function' ? conditional(value) : body;
      const etag = '"' + createHash('sha256').update(revision).digest('base64url') + '"';
      res.set('ETag', etag);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      res.type('json').send(body);
    } catch (error) { sendError(res, error); }
  };
  function streamTarget(source, number) {
    const local = fleet && localDesktop && source === localDesktop.host;
    return { url: local ? localDesktop.url : desktopURL, token: local ? localDesktop.token : token,
      connect: fleet && !local ? `/agents/connect/${source}/${number}` : `/${number}/connect`,
      stream: fleet && !local ? `/agents/stream/${source}/${number}` : `/stream/${number}` };
  }
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'" });
    next();
  });
  app.use(base, router);
  router.use(express.json({ limit: '128kb' }));
  const connection = { url: desktopURL, mode: new URL(desktopURL).protocol === 'https:' ? 'remote' : 'local' };
  router.get('/api/settings', route(() => ({ settings: readSettings(configHome), connection })));
  router.post('/api/settings', route(req => {
    const previous = readSettings(configHome), settings = saveSettings(req.body, configHome);
    return { settings, connection, restartRequired: JSON.stringify(previous.fleet) !== JSON.stringify(settings.fleet) };
  }));
  router.get('/api/desktops', route(async () => {
    const desktops = (await refresh()).map(({ idleMs, ...desktop }) => desktop);
    return { host, closeHost: fleet ? localDesktop?.host : host, cleanupDesktops, desktops, settings, warning: metadataWarning };
  }, true));
  const mutation = (req, res, next) => {
    if (req.headers.origin !== origin) return res.sendStatus(403);
    if (!req.is('application/json')) return res.sendStatus(415);
    next();
  };
  router.get('/api/preferences', route(async () => desktop('/settings', undefined, requireLocal())));
  router.post('/api/preferences', mutation, route(async req => {
    const value = await desktop('/settings', req.body, requireLocal());
    settings = value.settings; refreshedAt = 0;
    return value;
  }));
  for (const action of ['activity', 'keep-open']) router.post(`/api/desktops/:host/:number/${action}`, mutation, route(async req => {
    const source = req.params.host, number = Number(req.params.number), generation = req.body?.generation;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(source) || !Number.isSafeInteger(number) || number < 1
      || typeof generation !== 'string' || !generation || generation.length > 128
      || Object.keys(req.body).some(key => !['generation', ...(action === 'keep-open' ? ['minutes'] : [])].includes(key))
      || (action === 'keep-open' && (!Number.isInteger(req.body.minutes) || req.body.minutes < 0 || req.body.minutes > 1440)))
      throw Object.assign(new Error('Invalid desktop timer request.'), { status: 400 });
    if (!fleet && source !== host) throw Object.assign(new Error('Unknown desktop computer.'), { status: 404 });
    const target = streamTarget(source, number);
    const local = !fleet || source === localDesktop?.host;
    const path = local ? `/${number}/${action}` : `/agents/${action}/${source}/${number}`;
    return desktop(path, req.body, target);
  }));
  router.post('/api/desktops/close', mutation, route(async req => {
    const closeHost = fleet ? localDesktop?.host : host;
    const targets = req.body?.desktops;
    if (!closeHost || !Array.isArray(targets) || !targets.length || targets.length > 1024
      || targets.some(d => !d || d.host !== closeHost || !Number.isSafeInteger(d.desktop) || d.desktop < 1
        || typeof d.generation !== 'string' || !d.generation || d.generation.length > 128)
      || new Set(targets.map(d => d.desktop)).size !== targets.length)
      throw Object.assign(new Error('Invalid local desktop cleanup request.'), { status: 400 });
    const results = await Promise.all(targets.map(async d => {
      try {
        const result = await desktop(`/${d.desktop}/close`, { generation: d.generation }, fleet ? localDesktop : undefined, 120000);
        if (result.closed !== true) throw new Error('Desktop shutdown was not confirmed.');
        return { ...d, closed: true };
      } catch (error) { return { ...d, closed: false, error: error.message }; }
    }));
    refreshedAt = 0;
    return { results };
  }));
  router.get('/api/desktops/:host/:number/connect', route(req => {
    const target = streamTarget(encodeURIComponent(req.params.host), encodeURIComponent(req.params.number));
    return desktop(`${target.connect}?generation=${encodeURIComponent(req.query.generation || '')}`, undefined, target);
  }));
  router.get('/api/desktops/:number/connect', route(req => desktop(`/${encodeURIComponent(req.params.number)}/connect?generation=${encodeURIComponent(req.query.generation || '')}`)));
  const audioRoute = route(req => {
    const { host: source, number } = req.params;
    const generation = req.method === 'POST' ? req.body?.generation : req.query.generation;
    if (typeof generation !== 'string' || !generation || (req.method === 'POST' && typeof req.body?.muted !== 'boolean'))
      throw Object.assign(new Error('Invalid desktop sound request.'), { status: 400 });
    if (!fleet && source !== host) throw Object.assign(new Error('Unknown machine.'), { status: 404 });
    const local = fleet && localDesktop && source === localDesktop.host;
    const target = local ? localDesktop : undefined;
    const path = fleet && !local ? `/agents/audio/${encodeURIComponent(source)}/${encodeURIComponent(number)}` : `/${encodeURIComponent(number)}/audio`;
    return req.method === 'POST' ? desktop(path, { generation, muted: req.body.muted }, target)
      : desktop(`${path}?generation=${encodeURIComponent(generation)}`, undefined, target);
  });
  router.get('/api/desktops/:host/:number/audio', audioRoute);
  router.post('/api/desktops/:host/:number/audio', mutation, audioRoute);

  router.post('/api/chats', route(async req => {
    await refresh();
    const d = current.find(d => d.desktop === req.body.desktop && d.generation === req.body.generation && (!fleet || d.host === req.body.host));
    if (!d?.threadId) throw new Error('This desktop has no verified local T3 thread.');
    let entry = [...chats.entries()].find(([, value]) => value.agentId === d.agentId);
    if (!entry) { entry = [randomUUID(), { threadId: d.threadId, title: d.title, sourceHost: d.sourceHost, agentId: d.agentId }]; chats.set(...entry); }
    return { id: entry[0], title: entry[1].title, agentId: entry[1].agentId };
  }));
  const chat = req => {
    const result = chats.get(req.params.id);
    if (!result) throw Object.assign(new Error('Unknown chat.'), { status: 404 });
    return result;
  };
  router.get('/api/chats/:id', route(req => fleet ? desktop(`/agents/chat/${encodeURIComponent(chat(req).sourceHost)}/${encodeURIComponent(chat(req).threadId)}?${new URLSearchParams(req.query)}`) : t3.page(chat(req).threadId, req.query.before)));
  router.post('/api/chats/:id/messages', route(req => {
    if (![req.body.commandId, req.body.messageId].every(id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id)) || typeof req.body.text !== 'string') throw Object.assign(new Error('Invalid message.'), { status: 400, rejected: true });
    return fleet ? desktop(`/agents/chat/${encodeURIComponent(chat(req).sourceHost)}/${encodeURIComponent(chat(req).threadId)}`, req.body) : t3.send(chat(req).threadId, req.body.text, req.body.commandId, req.body.messageId);
  }));
  router.use('/shared', express.static(SHARED, { index: false }));
  router.use('/novnc', express.static(VENDOR + '@novnc/novnc', { index: false }));
  router.get('/vendor/marked.js', (req, res) => sendAsset(res, VENDOR + 'marked/lib/marked.esm.js'));
  router.get('/vendor/purify.js', (req, res) => sendAsset(res, VENDOR + 'dompurify/dist/purify.es.mjs'));
  router.get('/activity.js', (_req, res) => sendAsset(res, resolve(HERE, '../mcp/viewer/activity.js')));
  router.get('/audio.js', (_req, res) => sendAsset(res, resolve(HERE, '../mcp/viewer/audio.js')));
  router.get('/font.woff2', (req, res) => sendAsset(res, resolve(HERE, '../mcp/viewer/plex-sans.woff2')));
  router.use(express.static(HERE + 'web'));
  app.use(jsonBodyError);
  const streams = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, origin);
    const match = url.pathname.startsWith(base) && url.pathname.slice(base.length).match(/^stream\/([a-zA-Z0-9.-]+)\/([1-9]\d*)$/);
    if (!match || req.headers.origin !== origin || req.headers.host !== new URL(origin).host) return socket.destroy();
    const target = streamTarget(match[1], match[2]);
    const upstreamURL = new URL(target.url + '/hypr-desktop/viewer' + target.stream);
    upstreamURL.protocol = upstreamURL.protocol === 'https:' ? 'wss:' : 'ws:'; upstreamURL.search = new URLSearchParams({ generation: url.searchParams.get('generation') || '', profile: url.searchParams.get('profile') === 'preview' ? 'preview' : 'full' }).toString();
    streams.handleUpgrade(req, socket, head, downstream => {
      const upstream = new WebSocket(upstreamURL, { headers: { Authorization: `Bearer ${target.token}` }, handshakeTimeout: 8000, perMessageDeflate: false });
      const a = createWebSocketStream(downstream), b = createWebSocketStream(upstream);
      const close = () => { downstream.terminate(); upstream.terminate(); a.destroy(); b.destroy(); };
      for (const item of [downstream, upstream, a, b]) item.on('error', close);
      downstream.on('close', close); upstream.on('close', close); a.pipe(b).pipe(a);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: origin + base, async close() {
    for (const ws of streams.clients) ws.terminate();
    catalog.close(); await t3.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

export function viewerConfig(home = homedir()) {
  const settings = readSettings(home);
  const state = home + '/.local/share/hypr-desktop';
  const config = settings.fleet.url ? settings.fleet : {
    url: readFileSync(state + '/local-url', 'utf8').trim().replace(/\/mcp$/, ''), tokenFile: state + '/token'
  };
  const endpoint = new URL(config.url);
  const local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
  if ((!local && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Viewer requires local loopback HTTP or HTTPS without URL credentials.');
  if (typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) throw new Error('Viewer tokenFile must be an absolute path.');
  let localDesktop;
  try {
    const localURL = readFileSync(state + '/local-url', 'utf8').trim().replace(/\/mcp$/, '');
    const endpoint = new URL(localURL);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new Error('Local desktop endpoint must use loopback HTTP.');
    localDesktop = { host: hostname().split('.')[0], url: localURL, token: readFileSync(state + '/token', 'utf8').trim() };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { fleet: true, localDesktop, desktopURL: config.url.replace(/\/$/, ''), token: readFileSync(config.tokenFile, 'utf8').trim() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runtime = await serve(viewerConfig());
  process.stdout.write(JSON.stringify({ url: runtime.url }) + '\n');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; try { await runtime.close(); } finally { process.exit(); } };
  process.stdin.resume(); process.stdin.on('end', close); process.on('SIGTERM', close); process.on('SIGINT', close);
}
