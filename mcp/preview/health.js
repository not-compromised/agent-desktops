import { previewAddress } from './server.js';

try {
  const response = await fetch(`http://${previewAddress()}:${process.env.PORT || 8019}/health`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok || (await response.json()).preview !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
