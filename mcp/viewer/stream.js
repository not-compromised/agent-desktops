import RFB from '/novnc/core/rfb.js';
import { api } from '/api.js';
import { installViewport } from '/viewport.js';
import { installAudio } from '/audio.js';
import { installActivity } from '/activity.js';

// Phones and tablets: Take control fills the viewport, Fullscreen is the browser's video player.
export const narrow = matchMedia('(max-width: 1199px)');

export function installFullscreen(stage, onChange) {
  let owner = null;
  const viewport = window.visualViewport;
  function resize() {
    stage.style.setProperty('--view-height', `${viewport?.height ?? window.innerHeight}px`);
    stage.style.setProperty('--view-top', `${viewport?.offsetTop ?? 0}px`);
  }
  function clear() {
    if (!owner) return;
    owner = null;
    stage.classList.remove('immersive');
    onChange(null);
  }
  async function leave() {
    clear();
    if (document.fullscreenElement === stage) await document.exitFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) clear();
  });
  viewport?.addEventListener('resize', resize);
  viewport?.addEventListener('scroll', resize);
  window.addEventListener('resize', resize);
  return {
    async enter(tile) {
      if (owner === tile) return leave();
      owner = tile;
      resize(); stage.classList.add('immersive');
      onChange(tile);
      // iPhone browsers without element fullscreen keep the same interactive viewport.
      if (stage.requestFullscreen) {
        try {
          await stage.requestFullscreen();
          if (owner !== tile && document.fullscreenElement === stage) await document.exitFullscreen();
        } catch { /* The expanded viewport remains usable if fullscreen is refused. */ }
      }
    },
    leave,
    owner: () => owner,
    release(tile) { if (owner === tile) void leave(); },
    stop() { void leave(); }
  };
}

const KEYS = { enter: 0xff0d, escape: 0xff1b, backspace: 0xff08 };
export const keysym = char => { const cp = char.codePointAt(0); return cp > 255 ? 0x01000000 + cp : cp; };

export function createTile(initial, { onControl, onFocus, onChat, fullscreenView }, key) {
  let d = initial;
  const root = document.createElement('article'); root.className = 'tile';
  root.innerHTML = '<div class="screen"><span class="note" role="status"></span><button class="controlling-note" type="button" hidden>Controlling · Esc to watch</button>'
    + '<button class="reset-view" type="button" hidden>Fit</button>'
    + '<video class="player" muted autoplay playsinline hidden aria-label="Live desktop video"></video></div>'
    + '<div class="tile-bar"><img class="icon" alt="" hidden><span class="title"></span>'
    + '<span class="where"></span><span class="status"></span><span class="actions">'
    + '<button class="sound" type="button" disabled>Sound</button><span class="sound-error" role="status" hidden></span>'
    + '<button class="control" type="button" disabled aria-pressed="false">Take control</button>'
    + '<button class="keyboard" type="button" aria-expanded="false" aria-controls="typing" hidden>Keyboard</button>'
    + '<button class="fullscreen" type="button" disabled aria-pressed="false">Full Screen</button>'
    + '<details class="more"><summary aria-label="More">⋯</summary><div class="menu"><button class="chat" type="button">Chat</button><button class="focus-desktop" type="button">Focus desktop</button><button class="fit" type="button">Actual size</button><button class="reconnect" type="button">Reconnect</button></div></details>'
    + '</span></div>';
  const q = sel => root.querySelector(sel);
  const screen = q('.screen'), note = q('.note'), controlNote = q('.controlling-note'), video = q('.player');
  const icon = q('.icon'), title = q('.title');
  const control = q('.control'), keyboard = q('.keyboard'), fullscreen = q('.fullscreen'), fit = q('.fit'), reconnect = q('.reconnect'), more = q('.more');
  let rfb, holder, attempt = 0, connecting = false, disposed = false, profile = 'preview', wantsControl = false, shown = true, sole = false, focused = false, playing = null, restoreFocus = false;
  const tile = {};
  q('.chat').onclick = () => { more.open = false; onChat(); };
  const audio = installAudio(q('.sound'), q('.sound-error'), d);
  const activity = installActivity(screen, () => !!rfb && wantsControl && !rfb.viewOnly,
    signal => api(`/api/desktops/${encodeURIComponent(d.host)}/${d.desktop}/activity`, { generation: d.generation }, signal),
    error => status(error.message));
  const resetView = q('.reset-view'), focusDesktop = q('.focus-desktop');
  const viewport = installViewport(screen, key, mode => {
    fit.textContent = mode === 'fit' ? 'Actual size' : 'Fit to screen';
    resetView.hidden = wantsControl || mode === 'fit';
  });
  function applyView() {
    const fitted = viewport.mode() !== 'actual';
    if (rfb) {
      rfb.scaleViewport = wantsControl ? fitted : true;
      rfb.clipViewport = wantsControl && !fitted;
      rfb.dragViewport = wantsControl && !fitted;
    }
    viewport.setActive(!wantsControl);
    resetView.hidden = wantsControl || viewport.mode() === 'fit';
  }
  function inputState() {
    root.classList.toggle('controlling', wantsControl); controlNote.hidden = !wantsControl;
    control.textContent = wantsControl ? 'Watch' : 'Take control';
    control.setAttribute('aria-pressed', String(wantsControl));
    keyboard.hidden = !wantsControl;
    applyView();
  }
  function watch() {
    activity.cancel();
    if (!wantsControl) return;
    wantsControl = false; if (rfb) rfb.viewOnly = true;
    inputState(); onControl(tile, false); quality();
  }
  // The native player shows a copy of the canvas; it never accepts input, so it only exists in watch mode.
  function hidePlayer() {
    if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen();
    video.hidden = true;
  }
  function stopPlayer() {
    playing?.getTracks().forEach(track => track.stop()); playing = null;
    video.pause(); video.srcObject = null; hidePlayer();
  }
  video.addEventListener('webkitendfullscreen', hidePlayer);
  video.addEventListener('fullscreenchange', () => { if (document.fullscreenElement !== video) hidePlayer(); });
  function startPlayer() {
    const canvas = holder?.querySelector('canvas');
    if (!narrow.matches || !canvas?.captureStream || !(video.webkitEnterFullscreen || video.requestFullscreen)) return;
    stopPlayer();
    playing = canvas.captureStream(15); video.srcObject = playing;
    void video.play().catch(() => {});
  }
  function stop(preserveControl = false) {
    activity.cancel();
    if (!preserveControl && wantsControl) { wantsControl = false; onControl(tile, false); }
    attempt++; connecting = false;
    stopPlayer();
    const old = rfb; rfb = null; old?.disconnect();
    viewport.attach(null); holder?.remove(); holder = null;
    if (!preserveControl) fullscreenView.release(tile);
    fullscreen.disabled = true;
    control.disabled = true; inputState();
  }
  function status(text) { note.hidden = !text; note.textContent = text || ''; }
  async function connect() {
    if (rfb || connecting || disposed || !shown || document.hidden || !d.ready || d.reconnecting) return;
    connecting = true; const current = ++attempt; status('Connecting');
    try {
      const info = await api(`/api/desktops/${encodeURIComponent(d.host)}/${d.desktop}/connect?generation=${encodeURIComponent(d.generation)}`);
      if (disposed || current !== attempt || document.hidden) return;
      const url = new URL(`/view/${encodeURIComponent(d.host)}/${d.desktop}`, location.href);
      url.searchParams.set('generation', info.generation); url.searchParams.set('profile', profile);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      holder = document.createElement('div'); holder.className = 'canvas'; screen.prepend(holder);
      const connection = new RFB(holder, url.href, { credentials: { password: info.password } });
      rfb = connection;
      applyView();
      viewport.attach(holder.querySelector('canvas'));
      connection.resizeSession = false; connection.viewOnly = !wantsControl; connection.background = '#0b0d0c';
      connection.qualityLevel = profile === 'preview' ? 2 : 8; connection.compressionLevel = profile === 'preview' ? 6 : 2;
      connection.addEventListener('connect', () => {
        if (rfb !== connection) return;
        status(''); control.disabled = false; inputState();
        fullscreen.disabled = false;
        startPlayer();
      });
      connection.addEventListener('disconnect', () => {
        if (rfb !== connection) return;
        stop(); status('Disconnected · reconnecting');
      });
      connection.addEventListener('securityfailure', () => { if (rfb === connection) status('Stream refused'); });
    } catch (error) { if (current === attempt) status(error.message); }
    finally { if (current === attempt) connecting = false; }
  }
  function quality() {
    const next = wantsControl || focused || sole || screen.clientWidth >= 900 ? 'full' : 'preview';
    if (next !== profile) { profile = next; stop(true); void connect(); }
  }
  control.onclick = () => {
    if (!rfb) return;
    wantsControl = !wantsControl; rfb.viewOnly = !wantsControl;
    inputState(); onControl(tile, wantsControl); quality();
  };
  controlNote.onclick = watch;
  keyboard.onclick = () => onControl(tile, wantsControl, true);
  fit.onclick = () => {
    viewport.setMode(viewport.mode() === 'fit' ? 'actual' : 'fit'); more.open = false; applyView();
  };
  resetView.onclick = () => { viewport.setMode('fit'); applyView(); };
  focusDesktop.onclick = () => { more.open = false; onFocus(tile); };
  reconnect.onclick = () => { more.open = false; stop(true); void connect(); };
  fullscreen.onclick = async () => {
    if (!narrow.matches) return onFocus(tile);
    if (!rfb) return;
    if (fullscreenView.owner() === tile) return fullscreenView.leave();
    if (!playing || video.readyState < 1) {
      if (!sole) { restoreFocus = true; onFocus(tile); }
      return fullscreenView.enter(tile);
    }
    watch(); video.hidden = false;
    try {
      // Apple's native video player is distinct from fullscreening the page.
      if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else await video.requestFullscreen();
      await video.play();
    } catch { hidePlayer(); status('Fullscreen video is unavailable in this browser'); }
  };
  function update(value) {
    q('.chat').disabled = !value.chatAvailable;
    q('.chat').title = value.chatAvailable ? 'Open verified conversation' : value.chatUnavailableReason || 'No verified conversation';
    d = value; audio.update(d);
    icon.hidden = !d.icon; if (d.icon && icon.getAttribute('src') !== d.icon) icon.src = d.icon;
    title.textContent = d.title || d.owner || 'Agent desktop';
    q('.where').textContent = `${d.host} · ${d.desktop}`;
    const badge = q('.status');
    badge.textContent = d.reconnecting ? 'Reconnecting' : !d.ready ? 'Unavailable' : d.agentStatus || 'Unknown';
    badge.dataset.status = badge.textContent;
    if (!d.ready || d.reconnecting) { stop(); status(d.reconnecting ? 'Host reconnecting' : 'Desktop unavailable'); }
    else void connect();
  }
  function layout({ shown: visible, sole: only, focused: big }) {
    shown = visible; sole = only; focused = big;
    root.hidden = !shown;
    root.classList.toggle('focused', focused);
    focusDesktop.textContent = focused ? 'Show all desktops' : 'Focus desktop';
    focusDesktop.hidden = sole && !focused;
    updateFullscreen();
    if (!sole) fullscreenView.release(tile);
    if (!shown) stop(); else { quality(); void connect(); }
  }
  function updateFullscreen() {
    const active = narrow.matches ? fullscreenView.owner() === tile : focused;
    fullscreen.textContent = active ? 'Exit Full Screen' : 'Full Screen';
    fullscreen.setAttribute('aria-pressed', String(active));
  }
  function immersed() {
    if (restoreFocus && fullscreenView.owner() !== tile) {
      restoreFocus = false;
      if (focused && !disposed) onFocus(tile);
    }
    updateFullscreen();
  }
  function viewportChanged() { updateFullscreen(); stopPlayer(); startPlayer(); }
  narrow.addEventListener('change', viewportChanged);
  const resize = new ResizeObserver(() => { if (shown) quality(); });
  resize.observe(screen);
  Object.assign(tile, {
    root, key, update, layout, stop, watch, quality, immersed,
    controlling: () => wantsControl,
    sendKey(code) { if (rfb && wantsControl) { rfb.sendKey(code); activity.touch(); } },
    sendText(text) { for (const char of text) tile.sendKey(keysym(char)); },
    dispose() { activity.dispose(); audio.dispose(); narrow.removeEventListener('change', viewportChanged); disposed = true; resize.disconnect(); stop(); viewport.dispose(); root.remove(); }
  });
  return tile;
}
export { KEYS };
