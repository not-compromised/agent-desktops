export function installWatchControls({ root, stage, desktops, typing, notice, reveal, narrow }) {
  let timer = null, keyboard = false, suspended = false, eligible = false, tap = null;
  const pointers = new Set();
  const hidden = () => root.classList.contains('controls-hidden');
  function show() {
    if (hidden()) root.classList.remove('controls-hidden');
    if (!reveal.hidden) reveal.hidden = true;
  }
  function allowed() {
    return !suspended && !document.hidden && narrow.matches && root.classList.contains('selected')
      && !root.classList.contains('controlling')
      && desktops.classList.contains('single') && typing.hidden && !notice.textContent
      && !stage.querySelector('.tile:not([hidden]) .control:disabled')
      && !stage.querySelector('.tile:not([hidden]) .note:not([hidden])')
      && !stage.querySelector('details[open]') && !keyboard;
  }
  function clearTimer() { clearTimeout(timer); timer = null; }
  function schedule() {
    if (timer || hidden() || pointers.size) return;
    timer = setTimeout(() => {
      timer = null;
      if (!allowed() || pointers.size) return;
      root.classList.add('controls-hidden');
      reveal.hidden = false;
    }, 3000);
  }
  function sync() {
    const next = allowed();
    if (!next) { clearTimer(); show(); }
    else if (!eligible) schedule();
    eligible = next;
  }
  function activity() { clearTimer(); show(); eligible = allowed(); if (eligible) schedule(); }
  reveal.onclick = () => { activity(); if (keyboard) document.getElementById('stage-title').focus({ preventScroll: true }); };
  root.addEventListener('pointerdown', event => {
    keyboard = false;
    pointers.add(event.pointerId);
    if (pointers.size === 1) tap = { x: event.clientX, y: event.clientY, target: event.target, moved: false };
    else tap = null;
    clearTimer();
    if (!event.target.closest('.screen') && event.target !== reveal) show();
  }, true);
  root.addEventListener('pointermove', event => {
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) tap.moved = true;
    if (event.pointerType === 'mouse' && !pointers.size && !hidden()) activity();
  }, true);
  function end(event) {
    pointers.delete(event.pointerId);
    if (event.type === 'pointerup' && tap && !tap.moved && tap.target.closest('.screen') && !tap.target.closest('button,summary,input,video,a')) show();
    tap = null;
    clearTimer(); eligible = allowed(); if (eligible) schedule();
  }
  root.addEventListener('pointerup', end, true);
  root.addEventListener('pointercancel', end, true);
  root.addEventListener('lostpointercapture', end, true);
  root.addEventListener('keydown', () => { keyboard = true; activity(); }, true);
  root.addEventListener('focusin', event => {
    // Touch focus arrives after pointerup; revealing bars here moves Fit before its click.
    if (!pointers.size && !event.target.closest('.screen')) keyboard = true;
    if (keyboard) activity();
  });
  root.addEventListener('toggle', activity, true);
  const observer = new MutationObserver(sync);
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled', 'open'], childList: true, characterData: true });
  narrow.addEventListener('change', activity);
  window.addEventListener('resize', activity);
  document.addEventListener('visibilitychange', () => { pointers.clear(); tap = null; activity(); });
  window.addEventListener('pagehide', () => { suspended = true; pointers.clear(); clearTimer(); show(); });
  window.addEventListener('pageshow', () => { suspended = false; activity(); });
  return { reveal: activity };
}
