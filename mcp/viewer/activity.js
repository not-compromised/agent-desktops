// Only actual controlled canvas input renews a desktop. A trailing send reflects
// the latest input; there is no heartbeat after the user stops interacting.
export function installActivity(screen, enabled, post, onError = () => {}) {
  let timer, pending = false, inFlight, lastSent = 0, disposed = false;
  function cancel() { clearTimeout(timer); timer = null; pending = false; inFlight?.abort(); }
  function touch() {
    if (disposed || !enabled()) return;
    pending = true;
    if (timer || inFlight) return;
    const delay = Math.max(0, 5000 - (Date.now() - lastSent));
    if (delay) timer = setTimeout(() => { timer = null; void send(); }, delay);
    else void send();
  }
  async function send() {
    if (disposed || !pending || !enabled()) return;
    pending = false; const request = new AbortController(); inFlight = request; lastSent = Date.now();
    try { await post(request.signal); }
    catch (error) { if (!request.signal.aborted) { cancel(); onError(error); } }
    finally { if (inFlight === request) inFlight = null; if (pending) touch(); }
  }
  function input(event) { if (event.target?.tagName === 'CANVAS' && event.key !== 'Escape') touch(); }
  const events = ['pointermove', 'pointerdown', 'wheel', 'keydown', 'keyup'];
  for (const type of events) screen.addEventListener(type, input, true);
  return { touch, cancel, dispose() { disposed = true; cancel(); for (const type of events) screen.removeEventListener(type, input, true); } };
}
