const etags = new Map();
export async function api(path, body, conditional = false, timeout = body ? 30000 : 8000, signal) {
  const response = await fetch(path, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    ...(!body && conditional && etags.has(path) ? { headers: { 'If-None-Match': etags.get(path) } } : {}),
    cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  });
  if (response.status === 304 && conditional) return null;
  let value;
  try { value = await response.json(); } catch { value = {}; }
  if (!response.ok) throw Object.assign(new Error(value.error || 'Desktop service unreachable.'), { rejected: value.rejected === true, status: response.status });
  if (conditional && response.headers.has('etag')) { etags.set(path, response.headers.get('etag')); if (etags.size > 32) etags.delete(etags.keys().next().value); }
  return value;
}
