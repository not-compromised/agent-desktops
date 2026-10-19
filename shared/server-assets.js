import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sendAsset(res, file) {
  const path = file instanceof URL ? fileURLToPath(file) : resolve(file);
  // Restrict traversal to the asset directory, not hidden installation ancestors.
  return res.sendFile(basename(path), { root: dirname(path) });
}
