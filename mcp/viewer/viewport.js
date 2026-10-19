const STORAGE = 'desktop-viewports-v1';
const DEFAULT = { mode: 'fit', zoom: 1, x: 0, y: 0 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function validView(value) {
  return value && ['fit', 'actual', 'zoom'].includes(value.mode)
    && [value.zoom, value.x, value.y].every(Number.isFinite)
    && value.zoom >= 1 && value.zoom <= 64 && Math.abs(value.x) <= 64 && Math.abs(value.y) <= 64;
}
export function readView(key, storage) {
  try {
    const value = JSON.parse(storage.getItem(STORAGE) || '{}')[key];
    if (validView(value)) return { ...value };
  } catch { /* Viewing still works when storage is disabled. */ }
  return { ...DEFAULT };
}
export function saveView(key, value, storage) {
  try {
    let saved;
    try { saved = JSON.parse(storage.getItem(STORAGE) || '{}'); } catch { saved = {}; }
    const entries = Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([id, v]) => id !== key && validView(v)).slice(-31);
    storage.setItem(STORAGE, JSON.stringify(Object.fromEntries([...entries, [key, value]])));
  } catch { /* Storage is optional and bounded to the last 32 desktops. */ }
}
export function boundedView(view, width, height, imageWidth, imageHeight, actualZoom) {
  const zoom = view.mode === 'fit' ? 1 : view.mode === 'actual' ? actualZoom : view.zoom;
  const scale = clamp(zoom, view.mode === 'actual' ? 0.01 : 1, Math.max(6, Math.min(64, actualZoom)));
  return {
    scale,
    x: clamp(view.x * width, -Math.max(0, (imageWidth * scale - width) / 2), Math.max(0, (imageWidth * scale - width) / 2)),
    y: clamp(view.y * height, -Math.max(0, (imageHeight * scale - height) / 2), Math.max(0, (imageHeight * scale - height) / 2))
  };
}

export function installViewport(screen, key, onChange) {
  let storage;
  try { storage = sessionStorage; } catch { /* Private browsing may deny storage. */ }
  let view = readView(key, storage), canvas = null, active = true, start = null, moved = false, suppressClick = false;
  const points = new Map();
  let rendered = { scale: 1, x: 0, y: 0 };
  function size() {
    return { width: screen.clientWidth, height: screen.clientHeight, imageWidth: canvas?.clientWidth || 0,
      imageHeight: canvas?.clientHeight || 0, actualZoom: canvas?.width / canvas?.clientWidth || 1 };
  }
  function render() {
    if (!canvas) return;
    const s = size();
    if (!s.width || !s.height || !s.imageWidth || !s.imageHeight) return;
    rendered = boundedView(view, s.width, s.height, s.imageWidth, s.imageHeight, s.actualZoom);
    canvas.style.transform = active ? `translate(${rendered.x}px, ${rendered.y}px) scale(${rendered.scale})` : '';
  }
  function changed() { render(); onChange(view.mode); }
  function save() { saveView(key, view, storage); }
  function centroid() {
    const values = [...points.values()].slice(0, 2);
    return { x: values.reduce((n, p) => n + p.x, 0) / values.length,
      y: values.reduce((n, p) => n + p.y, 0) / values.length,
      distance: values.length === 2 ? Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) : 0 };
  }
  function restart() { start = points.size ? { ...centroid(), ...rendered, originX: centroid().x, originY: centroid().y } : null; }
  function gesture(active) { screen.dispatchEvent(new CustomEvent('viewgesture', { bubbles: true, detail: { active } })); }
  function down(event) {
    if (!active || !canvas || event.target.closest('button,video')) return;
    if (event.pointerType !== 'touch') {
      const s = size();
      if (event.button !== 0 || (s.imageWidth * rendered.scale <= s.width && s.imageHeight * rendered.scale <= s.height)) return;
    }
    if (!points.size) { moved = false; suppressClick = false; gesture(true); }
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    screen.setPointerCapture(event.pointerId);
    if (points.size > 1) moved = true;
    restart();
    event.stopPropagation();
  }
  function move(event) {
    if (!points.has(event.pointerId)) return;
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const c = centroid(), s = size();
    if (!start || !s.width || !s.height) return;
    const dx = c.x - start.originX, dy = c.y - start.originY;
    if (Math.hypot(dx, dy) > 8 || points.size > 1) moved = true;
    if (!moved) return;
    if (points.size === 1 && s.imageWidth * start.scale <= s.width && s.imageHeight * start.scale <= s.height) return;
    const rect = screen.getBoundingClientRect();
    const scale = clamp(start.scale * (start.distance && c.distance ? c.distance / start.distance : 1), 1, Math.max(6, Math.min(64, s.actualZoom)));
    const ratio = scale / start.scale;
    const anchorX = start.originX - rect.left - s.width / 2, anchorY = start.originY - rect.top - s.height / 2;
    view = { mode: points.size === 1 && view.mode === 'actual' ? 'actual' : scale === 1 ? 'fit' : 'zoom', zoom: scale,
      x: (anchorX - (anchorX - start.x) * ratio + dx) / s.width,
      y: (anchorY - (anchorY - start.y) * ratio + dy) / s.height };
    changed();
    view.x = rendered.x / s.width; view.y = rendered.y / s.height;
    event.preventDefault(); event.stopPropagation();
  }
  function up(event) {
    if (!points.has(event.pointerId)) return;
    points.delete(event.pointerId);
    if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
    restart();
    if (!points.size) { suppressClick = moved; save(); gesture(false); }
    event.stopPropagation();
  }
  function click(event) {
    if (suppressClick && !event.target.closest('button,video')) {
      suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  function cancel() {
    const ids = [...points.keys()];
    points.clear(); start = null; suppressClick = false;
    for (const id of ids) if (screen.hasPointerCapture(id)) screen.releasePointerCapture(id);
    if (ids.length) { save(); gesture(false); }
  }
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up, lostpointercapture: up, click };
  for (const [event, fn] of Object.entries(events)) screen.addEventListener(event, fn, true);
  const resize = new ResizeObserver(render); resize.observe(screen);
  onChange(view.mode);
  return {
    attach(value) { cancel(); if (canvas) { resize.unobserve(canvas); canvas.style.transform = ''; } canvas = value; if (canvas) resize.observe(canvas); render(); },
    mode: () => view.mode,
    setMode(mode) { view = { ...DEFAULT, mode }; changed(); save(); },
    setActive(value) {
      active = value;
      if (!active) cancel();
      render();
    },
    dispose() { cancel(); resize.disconnect(); for (const [event, fn] of Object.entries(events)) screen.removeEventListener(event, fn, true); }
  };
}
