// Xvfb exposes screenshots rather than Wayland damage events. Sample only while
// an explicit bounded wait is running; ordinary observation never starts a loop.
export async function waitForFrames({ capture, mode, timeout_ms, quiet_ms,
  now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = now();
  let previous, changed = false, lastChange = start;
  while (now() - start <= timeout_ms) {
    let image;
    try {
      image = await capture(Math.max(1, Math.ceil(timeout_ms - (now() - start))));
    } catch (error) {
      const elapsed_ms = Math.round(now() - start);
      if (error.killed === true && error.signal === 'SIGTERM' && error.code === null && now() - start >= timeout_ms) {
        return { satisfied: false, reason: 'timeout', elapsed_ms };
      }
      throw error;
    }
    if (!Buffer.isBuffer(image) || !image.length) throw new Error('Visual wait received an empty capture');
    const current = now();
    const baseline = !previous;
    if (baseline) lastChange = current;
    if (previous && !image.equals(previous)) { changed = true; lastChange = current; }
    previous = image;
    if (!baseline && current - start <= timeout_ms && ((mode === 'change' && changed)
      || (mode !== 'change' && (mode === 'still' || changed) && current - lastChange >= quiet_ms))) {
      return { satisfied: true, reason: mode === 'change' ? 'changed' : mode === 'settle' ? 'settled' : 'still', elapsed_ms: Math.round(current - start) };
    }
    const remaining = timeout_ms - (now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(100, remaining));
  }
  return { satisfied: false, reason: changed ? 'changing' : 'nothing', elapsed_ms: Math.round(now() - start) };
}
