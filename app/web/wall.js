import { installAudio } from './audio.js';
import RFB from './rfb.js';
import { clipboardText } from './clipboard.js';
import { api, native } from './api.js';
import { clearOnPointer, statusNotices } from './notices.js';
import { installSettings, countdown } from './preferences.js';
import { installActivity } from './activity.js';
const tiles = document.getElementById('tiles'), status = document.getElementById('status');
const notices = statusNotices(status);
let settings = { idleMinutes: 30, browserStartup: 'fresh', viewerStartup: 'open', streamQuality: 'auto', notificationSeconds: 4 };
const notify = (text, duration = settings.notificationSeconds * 1000) => notices.notify(text, duration);
const settingsUI = installSettings(value => { applySettings(value); notify('Settings saved.'); void refresh(true); });
function applySettings(value) {
  if (!value) return; settings = value; settingsUI.update(value);
  for (const tile of active.values()) tile.quality();
}
const cleanup = document.getElementById('cleanup');
let closeHost, cleanupTargets = [], closing = false;
document.querySelector('#empty .close-desktops').onclick = confirmCleanup;
document.getElementById('cleanup-cancel').onclick = () => cleanup.close();
document.getElementById('cleanup-confirm').onclick = async () => {
  if (closing || !cleanupTargets.length) return;
  closing = true;
  const targets = cleanupTargets;
  cleanup.close();
  updateCleanupButtons();
  try {
    const { results } = await api('api/desktops/close', { desktops: targets }, false, 125000);
    const closed = results.filter(r => r.closed).length, failed = results.filter(r => !r.closed);
    if (failed.length) notify(`Closed ${closed} agent desktops. Could not close ${failed.map(d => `${d.host}/${d.desktop}: ${d.error}`).join(' · ')}`, 0);
    else notify(`Closed ${closed} agent desktops on ${closeHost}.`);
    void refresh(true);
  } catch (error) { notify(error.message, 0); }
  finally { closing = false; updateCleanupButtons(); }
};
function updateCleanupButtons() {
  for (const button of tiles.querySelectorAll('.close-desktops')) {
    button.textContent = closeHost ? `Close all on ${closeHost}` : 'Close all agent desktops';
    button.disabled = closing || !lastSnapshot?.cleanupDesktops?.length;
  }
  const emptyClose = document.querySelector('#empty .close-desktops');
  emptyClose.hidden = !lastSnapshot?.cleanupDesktops?.length;
  emptyClose.disabled = closing;
  emptyClose.textContent = `Close all on ${closeHost}`;
}
function confirmCleanup() {
  cleanupTargets = lastSnapshot.cleanupDesktops.filter(d => d.host === closeHost)
    .map(({ host, desktop, generation }) => ({ host, desktop, generation }));
  if (!cleanupTargets.length || closing) return;
  document.getElementById('cleanup-description').textContent = `${cleanupTargets.length} agent desktop${cleanupTargets.length === 1 ? '' : 's'} on ${closeHost} will close, including desktops on other pages and in other agent groups.`;
  cleanup.showModal();
}
const empty = document.getElementById('empty');
const active = new Map(), attention = new Map();
let focused, refreshing = false, page = 0, lastLayout, lastAttention, lastSnapshot, refreshFailed = false, refreshRequested = false;
const group = new URLSearchParams(location.search).get('agent');
const overview = document.getElementById('overview');
overview.hidden = !group; overview.onclick = () => native({ type: 'overview' });
const pager = document.getElementById('pager'), wallbar = document.querySelector('.wallbar');
wallbar.hidden = !group;
pager.onclick = () => { page++; void refresh(true); };
const hostOf = d => d.host || 'local';
const slot = d => `${encodeURIComponent(hostOf(d))}/${d.desktop}`;
const key = d => `${slot(d)}/${d.generation}`;
function groupColor(id) {
  let hash = 0; for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return `hsl(${(hash >>> 0) % 360} 65% 65%)`;
}
let lastAspect = 16 / 9;
const setLabel = (button, text) => { if (button.getAttribute('aria-label') !== text) { button.setAttribute('aria-label', text); button.title = text; } };
// One tile size per page, from the first known desktop shape; wall.css owns
// the gap and caption-strip sizes this solver must leave room for.
function layout() {
  const root = document.documentElement;
  root.classList.toggle('enlarged', Boolean(focused));
  const count = focused ? 1 : active.size;
  if (!count) { lastLayout = null; return; }
  const aspect = lastAspect = [...active.values()].map(t => t.aspect()).find(Boolean) || lastAspect;
  const signature = JSON.stringify([tiles.clientWidth, tiles.clientHeight, focused, aspect, [...active.keys()], root.className]);
  if (lastLayout === signature) return;
  lastLayout = signature;
  if (!focused) {
    const style = getComputedStyle(tiles), gap = parseFloat(style.getPropertyValue('--gap')), strip = parseFloat(style.getPropertyValue('--strip'));
    const box = tiles.getBoundingClientRect(), width = box.width - 2 * gap, height = box.height - 2 * gap;
    let best = { size: 0, columns: 1 };
    for (let columns = 1; columns <= count; columns++) {
      const rows = Math.ceil(count / columns);
      const size = Math.min((width - (columns - 1) * gap) / columns, ((height - (rows - 1) * gap) / rows - strip) * aspect);
      if (size > best.size) best = { size, columns };
    }
    const size = Math.max(0, Math.floor(best.size));
    tiles.style.setProperty('--tile-w', `${size}px`);
    tiles.style.setProperty('--screen-h', `${Math.floor(size / aspect)}px`);
    tiles.style.setProperty('--wall-w', `${best.columns * size + (best.columns - 1) * gap}px`);
  }
  for (const [id, tile] of active) {
    setLabel(tile.root.querySelector('.size'), focused === id ? 'Tile' : 'Enlarge');
    tile.root.hidden = Boolean(focused && focused !== id);
    if (tile.root.hidden) tile.stop(); else tile.quality();
  }
}
function tile(d) {
  const root = document.createElement('article'); root.className = 'tile';
  root.innerHTML = '<div class="screen"></div><div class="tile-footer"><span class="mark" aria-hidden="true"></span><div class="identity"><img alt=""><span></span><small class="host"></small></div><div class="meta"><span class="agent-status" role="status"></span><span class="timer-short"></span></div><span class="sound-error popover" role="status" hidden></span><div class="controls"><button class="sound" disabled>Sound</button><button class="control" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path class="take" d="M5 3l13 7-6 1.5L9 18z"/><g class="padlock"><rect x="5" y="11" width="14" height="9"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></g></svg></button><button class="clipboard" disabled hidden aria-label="Send clipboard" title="Send clipboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H6v16h12V5h-3"/><rect x="9" y="3" width="6" height="4"/></svg></button><button class="chat">Chat</button><button class="size"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="grow" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><path class="shrink" d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/></svg></button><details class="desktop-actions"><summary role="button" aria-label="More desktop actions" title="More desktop actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="19" cy="12" r=".6"/></svg></summary><div class="desktop-menu popover"><span class="desktop-timer"></span><span class="hold-expiry" hidden></span><button class="extend">Extend</button><form class="keep-open"><label>Keep this desktop open<select name="minutes"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option><option value="120">2 hours</option><option value="custom">Custom</option></select></label><label class="hold-custom" hidden>Custom hold minutes<input name="custom" type="number" min="1" max="1440" step="1"></label><button type="submit">Keep open</button></form><button class="clear-hold" hidden>Clear keep-open override</button><button class="settings">Settings</button><button class="close-desktops" disabled>Close all agent desktops</button></div></details></div></div>';
  root.querySelector('.close-desktops').onclick = () => { root.querySelector('.desktop-actions').open = false; confirmCleanup(); };
  root.querySelector('.settings').onclick = () => { root.querySelector('.desktop-actions').open = false; void settingsUI.open(); };
  const screen = root.querySelector('.screen'), identity = root.querySelector('.identity span'), icon = root.querySelector('img');
  const note = document.createElement('span'); note.className = 'stream-status'; screen.append(note);
  let rfb, current, pending, attempt = 0, connecting = false, disposed = false, profile = 'preview', wantsControl = false, revision, aspect;
  const audio = installAudio(root.querySelector('.sound'), root.querySelector('.sound-error'), d);
  const control = root.querySelector('.control'), clipboard = root.querySelector('.clipboard');
  clipboard.hidden = !window.webkit?.messageHandlers?.native;
  let clipboardRequest;
  function timerState() {
    const text = countdown(d);
    for (const element of root.querySelectorAll('.desktop-timer, .timer-short')) if (element.textContent !== text) element.textContent = text;
    root.classList.toggle('closing', Number.isFinite(d.closesAt) && d.closesAt - Date.now() <= 5 * 60000);
    const holdText = d.keepOpenUntil > Date.now() ? `Hold expires in ${Math.ceil((d.keepOpenUntil - Date.now()) / 60000)} min` : '';
    const holdExpiry = root.querySelector('.hold-expiry');
    if (holdExpiry.textContent !== holdText) holdExpiry.textContent = holdText;
    if (holdExpiry.hidden !== !holdText) holdExpiry.hidden = !holdText;
    const extend = root.querySelector('.extend'), extendText = `Extend ${d.idleMinutes || settings.idleMinutes} min`;
    if (extend.textContent !== extendText) extend.textContent = extendText;
    const clearHold = root.querySelector('.clear-hold'), hidden = !(d.keepOpenUntil > Date.now());
    if (clearHold.hidden !== hidden) clearHold.hidden = hidden;
  }
  function resultState(value) {
    const row = typeof value.desktop === 'object' ? value.desktop : value;
    if (row.generation === d.generation && Number.isFinite(row.closesAt)) { d = { ...d, ...row }; timerState(); }
  }
  async function adjust(minutes) {
    try {
      resultState(await api(`api/desktops/${slot(d)}/keep-open`, { generation: d.generation, minutes }));
      void refresh(true);
    } catch (error) { notify(error.message, 0); }
  }
  root.querySelector('.extend').onclick = async () => {
    try { resultState(await api(`api/desktops/${slot(d)}/activity`, { generation: d.generation })); void refresh(true); }
    catch (error) { notify(error.message, 0); }
  };
  const holdForm = root.querySelector('.keep-open');
  holdForm.elements.minutes.onchange = () => {
    const custom = holdForm.elements.minutes.value === 'custom';
    holdForm.querySelector('.hold-custom').hidden = !custom; holdForm.elements.custom.required = custom;
  };
  holdForm.onsubmit = event => { event.preventDefault(); void adjust(Number(holdForm.elements.minutes.value === 'custom' ? holdForm.elements.custom.value : holdForm.elements.minutes.value)); };
  root.querySelector('.clear-hold').onclick = () => adjust(0);
  const inputActivity = installActivity(screen, () => wantsControl && Boolean(rfb) && !disposed,
    async signal => resultState(await api(`api/desktops/${slot(d)}/activity`, { generation: d.generation }, false, 30000, signal)),
    error => { watch(); notify(error.message, 0); });
  const countdownTimer = setInterval(timerState, 1000);

  clipboard.onclick = async () => {
    const client = rfb;
    if (!wantsControl || !client || clipboardRequest) return;
    const request = new AbortController(); clipboardRequest = request; clipboard.disabled = true;
    try {
      const text = await clipboardText(request.signal);
      if (request.signal.aborted || rfb !== client || !wantsControl) return;
      client.clipboardPasteFrom(text); inputActivity.touch();
      notify('Clipboard sent. Click inside the desktop and press Ctrl+V.');
    } catch (error) {
      if (!request.signal.aborted) notices.set(error.message);
    } finally {
      if (clipboardRequest === request) clipboardRequest = null;
      clipboard.disabled = !rfb;
    }
  };
  const controlNote = document.createElement('button');
  controlNote.className = 'control-note'; controlNote.textContent = 'You’re controlling · Esc to watch'; controlNote.hidden = true; screen.append(controlNote);
  const controlHover = clearOnPointer(controlNote);
  function inputState() {
    if (!wantsControl) { clipboardRequest?.abort(); clipboardRequest = null; }
    clipboard.disabled = !rfb || Boolean(clipboardRequest);
    root.classList.toggle('controlling', wantsControl); controlNote.hidden = !wantsControl;
    controlHover.update();
    setLabel(control, wantsControl ? 'Lock input' : 'Take control');
    control.setAttribute('aria-pressed', String(wantsControl));
  }
  function watch() {
    inputActivity.cancel(); wantsControl = false; if (rfb) rfb.viewOnly = true; inputState(); quality();
  }
  controlNote.onclick = watch;
  function retire(connection) {
    if (!connection || connection.closed) return;
    connection.closed = true; clearTimeout(connection.timer);
    connection.rfb.viewOnly = true; connection.rfb.disconnect(); connection.canvas.remove();
  }
  function cancelPending() {
    attempt++; connecting = false;
    const old = pending; pending = null; retire(old);
  }
  function stop() {
    inputActivity.cancel(); cancelPending(); wantsControl = false;
    const old = current; current = null; rfb = null; retire(old);
    control.disabled = true; inputState();
  }
  async function connect() {
    if (connecting || pending || disposed || root.hidden || document.hidden || !d.ready || current?.profile === profile) return;
    connecting = true; const token = ++attempt, nextProfile = profile;
    if (!current) { note.textContent = 'Connecting'; note.hidden = false; }
    let candidate;
    try {
      const info = await api(`api/desktops/${slot(d)}/connect?generation=${encodeURIComponent(d.generation)}`);
      if (disposed || token !== attempt || document.hidden || root.hidden) return;
      const url = new URL(`stream/${slot(d)}?generation=${encodeURIComponent(info.generation)}&profile=${nextProfile}`, location.href); url.protocol = 'ws:';
      const canvas = document.createElement('div'); canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none'; screen.prepend(canvas);
      candidate = canvas;
      const client = new RFB(canvas, url.href, { credentials: { password: info.password } });
      const next = { rfb: client, canvas, profile: nextProfile }; pending = next;
      client.scaleViewport = true; client.resizeSession = false; client.viewOnly = true;
      client.lossless = nextProfile === 'full'; client.qualityLevel = nextProfile === 'preview' ? 2 : 8;
      client.compressionLevel = nextProfile === 'preview' ? 6 : 2; client.background = '#090b0d';
      const failed = () => {
        if (next.closed) return;
        if (pending === next) { pending = null; connecting = false; }
        if (current === next) { current = null; rfb = null; wantsControl = false; control.disabled = true; inputState(); }
        retire(next);
        if (!current) { note.hidden = false; note.textContent = 'Reconnecting'; }
      };
      client.addEventListener('disconnect', failed);
      next.timer = setTimeout(failed, 15000);
      client.addEventListener('firstframe', () => {
        if (pending !== next || token !== attempt || disposed) return;
        clearTimeout(next.timer);
        clipboardRequest?.abort(); clipboardRequest = null;
        const old = current; if (old) old.rfb.viewOnly = true;
        current = next; pending = null; rfb = client;
        client.viewOnly = !wantsControl;
        canvas.style.opacity = ''; canvas.style.pointerEvents = '';
        retire(old); note.hidden = true; control.disabled = false; inputState();
        const pixels = canvas.querySelector('canvas');
        if (pixels?.height && pixels.width / pixels.height !== aspect) { aspect = pixels.width / pixels.height; layout(); }
      }, { once: true });
    } catch (error) {
      candidate?.remove();
      if (token === attempt) { cancelPending(); if (!current) { note.hidden = false; note.textContent = error.message; } }
    }
    finally { if (token === attempt) connecting = false; }
  }
  control.onclick = () => {
    if (!rfb) return;
    wantsControl = rfb.viewOnly; rfb.viewOnly = !wantsControl;
    inputState();
    quality();
  };
  root.querySelector('.size').onclick = () => {
    focused = focused === key(d) ? null : key(d);
    native({ type: 'fullscreen', enabled: Boolean(focused) });
    layout();
  };
  function update(value) {
    audio.update(value);
    d = value; timerState();
    const nextRevision = JSON.stringify(d);
    if (nextRevision === revision) { void connect(); return; }
    revision = nextRevision;
    identity.textContent = d.title || d.owner; identity.title = `${d.title || d.owner} · ${hostOf(d)} desktop ${d.desktop}`;
    const badge = root.querySelector('.agent-status');
    const chat = root.querySelector('.chat');
    chat.disabled = !d.threadId;
    chat.title = d.threadId ? 'Open the verified T3 conversation' : d.chatUnavailableReason || 'Chat requires a supported T3 conversation with verified desktop ownership. Continue in your agent client.';
    chat.setAttribute('aria-description', chat.title);
    chat.setAttribute('aria-label', `Chat · ${d.title || d.owner}`);
    badge.textContent = d.reconnecting ? 'Reconnecting' : !d.ready ? 'Offline' : d.agentStatus || '';
    badge.classList.toggle('offline', d.reconnecting || !d.ready);
    root.classList.toggle('attention', d.agentStatus === 'Waiting for you');
    root.querySelector('.host').textContent = hostOf(d);
    root.style.setProperty('--agent-color', d.agentId ? groupColor(d.agentId) : 'transparent');
    root.classList.toggle('grouped', Boolean(d.grouped));
    icon.hidden = !d.icon; if (d.icon && icon.src !== d.icon) icon.src = d.icon;
    if (!d.ready) { stop(); note.hidden = false; note.textContent = d.reconnecting ? 'Reconnecting' : 'Desktop unavailable'; } else void connect();
  }
  root.querySelector('.chat').onclick = async () => {
    try { const chat = await api('api/chats', { host: d.host, desktop: d.desktop, generation: d.generation }); native({ type: 'chat', ...chat }); }
    catch (error) { notify(error.message, 0); }
  };
  function quality() {
    const menu = root.querySelector('.desktop-menu');
    const maxHeight = `${screen.clientHeight}px`, maxWidth = `${Math.max(0, root.clientWidth - 8)}px`;
    if (menu.style.maxHeight !== maxHeight) menu.style.maxHeight = maxHeight;
    if (menu.style.maxWidth !== maxWidth) menu.style.maxWidth = maxWidth;
    const next = settings.streamQuality === 'resource' ? 'preview' : settings.streamQuality === 'sharp' ? 'full' : wantsControl || focused === key(d) || screen.clientWidth >= 900 ? 'full' : 'preview';
    if (next !== profile) { profile = next; cancelPending(); void connect(); }
  }
  const resize = new ResizeObserver(quality); resize.observe(screen);
  tiles.append(root); profile = screen.clientWidth >= 900 ? 'full' : 'preview'; inputState(); update(d);
  return { root, update, stop, quality, watch, retry: connect, controlling: () => wantsControl, aspect: () => aspect, dispose() { clearInterval(countdownTimer); inputActivity.dispose(); controlHover.dispose(); audio.dispose(); disposed = true; resize.disconnect(); stop(); root.remove(); } };
}
async function reconcileAttention(data) {
  if (group || !data) return;
  const waiting = new Map(data.desktops.filter(d => d.agentId && d.agentStatus === 'Waiting for you')
    .map(d => [d.agentId, { agentId: d.agentId, title: d.title || d.owner || 'Agent' }]));
  for (const id of attention.keys()) if (!waiting.has(id)) attention.delete(id);
  for (const [id] of waiting) if (!attention.has(id)) {
    const d = data.desktops.find(row => row.agentId === id && row.threadId);
    if (d) try { attention.set(id, await api('api/chats', { host: d.host, desktop: d.desktop, generation: d.generation })); } catch { /* Retry verified binding next refresh. */ }
  }
  const chats = [...attention.values()], revision = JSON.stringify(chats);
  if (revision !== lastAttention) { lastAttention = revision; native({ type: 'attention', chats }); }
}
async function refresh(force = false) {
  if (force) refreshRequested = true;
  if (refreshing || (document.hidden && group)) return;
  refreshing = true;
  let failed = false;
  try {
    const fresh = await api('api/desktops', undefined, !refreshFailed);
    const render = refreshRequested; refreshRequested = false;
    if (!fresh && !render) {
      await reconcileAttention(lastSnapshot);
      for (const tile of active.values()) tile.retry();
      return;
    }
    const data = fresh || lastSnapshot;
    lastSnapshot = data;
    closeHost = data.closeHost; applySettings(data.settings);
    document.getElementById('settings-computer').textContent = closeHost ? `Applies to ${closeHost} only.` : 'Local settings are unavailable on this computer.';
    notices.set(data.warning);
    await reconcileAttention(data);
    const all = data.desktops.filter(d => !group || d.agentId === group);
    empty.hidden = all.length > 0 || Boolean(data.warning);
    empty.querySelector('p').textContent = group ? 'No active desktops for this agent' : 'No active desktops';
    const pages = Math.ceil(all.length / 8); page = pages ? page % pages : 0;
    pager.hidden = pages <= 1; pager.textContent = `Page ${page + 1} of ${pages} · Next`;
    wallbar.hidden = !group && pager.hidden;
    const shown = all.slice(page * 8, (page + 1) * 8);
    const ids = new Set(shown.map(key));
    for (const [id, item] of active) if (!ids.has(id)) {
      item.dispose(); active.delete(id);
      if (focused === id) { focused = null; native({ type: 'fullscreen', enabled: false }); }
    }
    // Host and group marks appear only when they tell desktops apart.
    const agents = new Map();
    for (const d of shown) if (d.agentId) agents.set(d.agentId, (agents.get(d.agentId) || 0) + 1);
    for (const row of shown) {
      const d = { ...row, grouped: agents.size > 1 && agents.get(row.agentId) > 1 }, id = key(d);
      if (active.has(id)) active.get(id).update(d); else active.set(id, tile(d));
    }
    tiles.classList.toggle('hosts', new Set(shown.map(hostOf)).size > 1);
    updateCleanupButtons();
    layout();
    refreshFailed = false;
  } catch (error) { failed = refreshFailed = true; empty.hidden = true; notices.set(error.message); }
  // After a failure the pending request waits for the next poll; retrying here spins the page.
  finally { refreshing = false; if (refreshRequested && !failed && !document.hidden) void refresh(); }
}
let escapeConsumed = false;
window.addEventListener('pointerdown', () => document.documentElement.classList.remove('keyboard-navigation'), true);
window.addEventListener('keydown', event => {
  if (event.key === 'Tab') document.documentElement.classList.add('keyboard-navigation');
  if (event.key !== 'Escape' || ![...active.values()].some(tile => tile.controlling())) return;
  event.preventDefault(); event.stopImmediatePropagation(); escapeConsumed = true;
  for (const tile of active.values()) tile.watch();
}, true);
window.addEventListener('keyup', event => {
  if (event.key === 'Escape' && escapeConsumed) { event.preventDefault(); event.stopImmediatePropagation(); escapeConsumed = false; }
}, true);
// Centring padding keeps the content box fixed; watch the outer box.
new ResizeObserver(layout).observe(tiles, { box: 'border-box' });
new MutationObserver(layout).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
document.addEventListener('visibilitychange', () => { if (document.hidden) for (const item of active.values()) item.stop(); else void refresh(true); });
window.addEventListener('pagehide', () => { for (const item of active.values()) item.dispose(); });
void refresh(); setInterval(refresh, 2000);
