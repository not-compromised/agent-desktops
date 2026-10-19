import { api } from './api.js';

export function installAudio(button, notice, desktop) {
  const path = `api/desktops/${encodeURIComponent(desktop.host)}/${desktop.desktop}/audio`;
  let state = null, busy = false, disposed = false, ready = false;
  button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5Z"/><path class="sound-wave" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/><path class="sound-slash" d="m15 9 6 6m0-6-6 6"/></svg>';
  function render(error = '') {
    button.disabled = busy || !ready || !state?.available;
    button.dataset.muted = String(!state?.available || state.muted);
    button.setAttribute('aria-pressed', String(Boolean(state?.available && !state.muted)));
    button.setAttribute('aria-label', `${state?.muted ? 'Unmute' : 'Mute'} desktop sound on ${desktop.host}`);
    button.title = error || state?.reason || (state?.available
      ? `Sound ${state.muted ? 'off' : 'on'} on ${desktop.host}` : 'Desktop sound unavailable');
    notice.textContent = error; notice.hidden = !error;
  }
  async function refresh() {
    if (busy || disposed || !ready || document.hidden || button.closest('[hidden]')) return;
    busy = true;
    try { state = await api(`${path}?generation=${encodeURIComponent(desktop.generation)}`); }
    catch { state = null; }
    finally { busy = false; if (!disposed) render(); }
  }
  button.onclick = async () => {
    if (busy || disposed || !ready || !state?.available) return;
    busy = true; render();
    let error = '';
    try { state = await api(path, { generation: desktop.generation, muted: !state.muted }); }
    catch (e) { error = e.message; }
    finally { busy = false; if (!disposed) render(error); }
  };
  const timer = setInterval(refresh, 5000);
  render();
  return {
    update(value) { ready = value.ready && !value.reconnecting; if (!ready) render(); else void refresh(); },
    dispose() { disposed = true; clearInterval(timer); button.onclick = null; }
  };
}
