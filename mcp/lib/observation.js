import { randomUUID } from 'node:crypto';

const states = new WeakMap();
const state = lease => {
  let value = states.get(lease);
  if (!value || value.instance !== lease.instance) {
    value?.controller?.abort();
    value = { instance: lease.instance, windows: new Map() };
    states.set(lease, value);
  }
  return value;
};
export const cancelObservation = lease => states.get(lease)?.controller?.abort();
const identity = window => `${window.address}:${window.pid ?? ''}:${window.lifetime ?? ''}`;
const dimensions = { x: 0, y: 0, width: 2560, height: 1440 };
function boundsOf(window) {
  const x = Math.max(0, window.x), y = Math.max(0, window.y);
  const width = Math.min(2560, window.x + window.w) - x;
  const height = Math.min(1440, window.y + window.h) - y;
  if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0)
    throw new Error('Window has no visible region on this desktop');
  return { x, y, width, height };
}
export function createObservation({ nest, leases }) {
  const check = lease => {
    if (nest.instance && nest.instance(lease.desktop) !== lease.instance)
      throw new Error('Desktop restarted during observation; observe again');
  };
  const inventory = async (lease, { signal } = {}) => {
    signal?.throwIfAborted();
    check(lease);
    const windows = await nest.windows(lease.desktop, { signal });
    signal?.throwIfAborted();
    check(lease);
    const s = state(lease), previous = s.windows;
    s.windows = new Map();
    return windows.map(window => {
      const old = [...previous].find(([, w]) => identity(w) === identity(window));
      const id = old?.[0] ?? `w-${randomUUID()}`;
      s.windows.set(id, window);
      const { address, process_start, lifetime, ...visible } = window;
      return { ...visible, window_id: id };
    });
  };
  const resolve = async (lease, id) => {
    const known = state(lease).windows.get(id);
    if (!known) throw new Error('Stale or foreign window; observe this desktop again');
    const current = (await nest.windows(lease.desktop)).find(w => identity(w) === identity(known));
    check(lease);
    if (!current) { state(lease).windows.delete(id); throw new Error('Window has closed; observe again'); }
    return current;
  };
  return {
    inventory, resolve,
    async capture(lease, { scale = 1, window_id, frames = 1, interval_ms = 150 } = {}) {
      if ((frames - 1) * interval_ms > 5000) throw new Error('Capture interval budget exceeds 5000 ms');
      const s = state(lease), controller = new AbortController();
      s.controller = controller;
      const timeout = setTimeout(() => controller.abort(), frames === 1 ? 15000 : 10000);
      const started = performance.now(), captures = [], images = [];
      let bytes = 0;
      // An interrupted capture cannot leave the preceding screenshot actionable.
      leases.frames.delete(lease.desktop);
      try {
        for (let index = 0; index < frames; index++) {
          const delay = index * interval_ms - (performance.now() - started);
          if (delay > 0) await new Promise((resolve, reject) => {
            const aborted = () => { clearTimeout(timer); reject(new Error('Capture cancelled or timed out')); };
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', aborted); resolve(); }, delay);
            controller.signal.addEventListener('abort', aborted, { once: true });
          });
          controller.signal.throwIfAborted(); check(lease);
          const window = window_id ? await resolve(lease, window_id) : null;
          const bounds = window ? boundsOf(window) : dimensions;
          const png = await nest.capture(lease.desktop, { scale, ...(window ? { bounds } : {}), signal: controller.signal, timeout_ms: frames === 1 ? 15000 : Math.max(1, Math.ceil(10000 - (performance.now() - started))) });
          controller.signal.throwIfAborted(); check(lease);
          if (window && JSON.stringify(boundsOf(await resolve(lease, window_id))) !== JSON.stringify(bounds))
            throw new Error('Window moved during capture; observe again');
          bytes += Math.ceil(png.length / 3) * 4;
          if (bytes > 16 * 1024 * 1024) throw new Error('Capture exceeds the 16 MiB image budget; reduce scale or frames');
          captures.push({ index, captured_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started), bounds });
          images.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
        }
        const windows = await inventory(lease, { signal: controller.signal });
        controller.signal.throwIfAborted();
        const frame_id = leases.newFrame(lease.desktop);
        const result = { frame_id, windows, frames: captures, coordinate_space: 'desktop', width: 2560, height: 1440, scale,
          capture_kind: window_id ? 'visible_window_region' : 'desktop' };
        return { content: [...images, { type: 'text', text: `frame_id ${frame_id}; desktop ${lease.desktop} 2560x1440; scale ${scale}. Coordinates always use full desktop pixels. ${window_id ? 'Visible window region, including any overlapping windows. ' : ''}${JSON.stringify(result)}` }], structuredContent: result };
      } finally {
        clearTimeout(timeout);
        if (s.controller === controller) delete s.controller;
      }
    }
  };
}
