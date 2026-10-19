const notices = new Set();
let pointer;

function update() {
  for (const notice of notices) notice.update();
}
document.addEventListener('pointermove', event => { pointer = event; update(); }, true);
document.addEventListener('pointerdown', event => { pointer = event; update(); }, true);
document.addEventListener('pointerout', event => { if (!event.relatedTarget) { pointer = null; update(); } }, true);
window.addEventListener('resize', update);
document.addEventListener('scroll', update, true);

// Keep the rectangle while invisible, so revealing it cannot retrigger hover.
export function clearOnPointer(element, dismiss) {
  const notice = { update() {
    const box = element.getBoundingClientRect();
    const over = pointer && box.width > 0 && box.height > 0
      && pointer.clientX >= box.left && pointer.clientX < box.right
      && pointer.clientY >= box.top && pointer.clientY < box.bottom;
    element.classList.toggle('pointer-clear', Boolean(over));
    if (over) dismiss?.();
  } };
  notices.add(notice);
  return { update: notice.update, dispose() { notices.delete(notice); } };
}

export function statusNotices(element) {
  let warning = '', toast = '', timer;
  const hover = clearOnPointer(element, () => { if (toast) dismiss(); });
  function render() { element.textContent = toast || warning; hover.update(); }
  function dismiss() { clearTimeout(timer); toast = ''; render(); }
  return {
    set(text) { warning = text || ''; render(); },
    notify(text, duration = 4000) { clearTimeout(timer); toast = text; if (duration) timer = setTimeout(dismiss, duration); render(); }
  };
}
