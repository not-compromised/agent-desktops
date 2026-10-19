import { sendAsset } from '../../shared/server-assets.js';
import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const viewer = path.resolve(here, '../viewer');

export async function createPreview(dataDir) {
  const source = JSON.parse(await readFile(path.join(dataDir, 'fleet.json'), 'utf8'));
  await readFile(path.join(dataDir, 'desktop.png'));
  // Copy display metadata only. No credentials, live agent identifiers, or remote URLs leave this boundary.
  const agents = new Map();
  const fleet = {
    hosts: source.hosts.map(h => ({ id: String(h.id), online: Boolean(h.online) })),
    desktops: source.desktops.map((d, i) => ({
      host: String(d.host), desktop: Number(d.desktop), generation: `preview-${i}`,
      title: String(d.title || d.owner || 'Agent desktop'), owner: 'Preview',
      agentId: (() => { const key = d.agentId || i; if (!agents.has(key)) agents.set(key, `preview-agent-${agents.size}`); return agents.get(key); })(),
      agentStatus: d.agentStatus || 'Ready', ready: true, held: true, icon: ''
    }))
  };
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.get('/health', (_req, res) => res.json({ preview: true }));
  app.get('/api/desktops', (_req, res) => res.json(fleet));
  app.get('/api/desktops/:host/:desktop/connect', (req, res) => {
    const d = fleet.desktops.find(d => d.host === req.params.host && String(d.desktop) === req.params.desktop && d.generation === req.query.generation);
    if (!d) return res.status(404).json({ error: 'Preview desktop missing.' });
    res.json({ generation: d.generation, password: '' });
  });
  const sound = new Map();
  const previewAudio = (req, res) => {
    const generation = req.method === 'POST' ? req.body?.generation : req.query.generation;
    const d = fleet.desktops.find(d => d.host === req.params.host && String(d.desktop) === req.params.desktop && d.generation === generation);
    if (!d) return res.status(404).json({ error: 'Preview desktop missing.' });
    if (req.method === 'POST') {
      if (typeof req.body.muted !== 'boolean') return res.status(400).json({ error: 'muted must be a boolean.' });
      sound.set(d.generation, req.body.muted);
    }
    res.json({ available: true, muted: sound.get(d.generation) ?? true, streams: 0 });
  };
  app.get('/api/desktops/:host/:desktop/audio', previewAudio);
  app.post('/api/desktops/:host/:desktop/audio', express.json({ limit: '1kb' }), previewAudio);
  app.get('/sample-desktop.png', (_req, res) => sendAsset(res, path.resolve(dataDir, 'desktop.png')));
  app.get('/novnc/core/rfb.js', (_req, res) => sendAsset(res, path.join(here, 'rfb.js')));
  app.get('/', async (_req, res) => {
    const html = await readFile(path.join(viewer, 'index.html'), 'utf8');
    res.type('html').send(html.replace('<title>Agent desktops</title>', '<title>Desktop viewer preview</title>')
      .replace('<span>Desktops</span>', '<span>Preview · inert desktop</span>'));
  });
  app.use('/shared', express.static(path.resolve(here, '../../shared'), { index: false }));
  app.get('/vendor/marked.js', (_req, res) => sendAsset(res, path.resolve(here, '../../node_modules/marked/lib/marked.esm.js')));
  app.get('/vendor/purify.js', (_req, res) => sendAsset(res, path.resolve(here, '../../node_modules/dompurify/dist/purify.es.mjs')));
  app.use(express.static(viewer, { index: false }));
  app.use((_req, res) => res.status(404).json({ error: 'Preview route unavailable.' }));
  return app;
}

export function previewAddress() {
  const bind = process.env.PREVIEW_BIND === 'bridge'
    ? Object.values(networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)?.address
    : '127.0.0.1';
  if (!bind) throw new Error('Preview bridge address missing');
  return bind;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createPreview(process.env.PREVIEW_DATA || path.join(here, 'data'));
  const bind = previewAddress();
  app.listen(Number(process.env.PORT || 8019), bind);
}
