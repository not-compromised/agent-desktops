export async function responseJSON(response, fallback) {
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : fallback), {
    status: response.status,
    rejected: body?.rejected === true
  });
}

export function sendError(res, error) {
  res.status(error.status || 503).json({ error: error.message, rejected: error.rejected === true });
}

export function jsonBodyError(error, _req, res, next) {
  if (!['entity.too.large', 'entity.parse.failed'].includes(error.type)) return next(error);
  sendError(res, { status: error.status || 400, message: error.type === 'entity.too.large' ? 'The message is too large.' : 'Invalid request.', rejected: true });
}
