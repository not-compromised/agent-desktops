import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const invalid = message => Object.assign(new Error(message), { status: 400, rejected: true });
const read = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['autoOpen', 'fleet'].includes(key)) || typeof value.autoOpen !== 'boolean')
    throw invalid('Settings require an automatic-opening choice and a connection.');
  const fleet = value.fleet;
  if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet) ||
      Object.keys(fleet).some(key => !['url', 'tokenFile'].includes(key)) ||
      typeof fleet.url !== 'string' || typeof fleet.tokenFile !== 'string')
    throw invalid('Connection requires a URL and a private token file path.');
  if (!fleet.url && !fleet.tokenFile) return { autoOpen: value.autoOpen, fleet: { url: '', tokenFile: '' } };
  let endpoint;
  try { endpoint = new URL(fleet.url); } catch { throw invalid('Enter a valid HTTPS connection URL.'); }
  const loopback = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  if ((!loopback && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw invalid('Connections require HTTPS, or HTTP on loopback localhost, without URL credentials.');
  if (!isAbsolute(fleet.tokenFile)) throw invalid('Choose an absolute path to the private token file.');
  return { autoOpen: value.autoOpen, fleet: { url: fleet.url.replace(/\/$/, ''), tokenFile: fleet.tokenFile } };
}
export function readSettings(home = homedir()) {
  const root = join(home, '.config/agent-desktops');
  const saved = read(join(root, 'settings.json'));
  const legacy = saved?.fleet === undefined ? read(join(root, 'fleet.json')) : null;
  return validateSettings({ autoOpen: saved?.autoOpen ?? true, fleet: saved?.fleet ?? legacy ?? { url: '', tokenFile: '' } });
}
export function saveSettings(value, home = homedir()) {
  const settings = validateSettings(value), root = join(home, '.config/agent-desktops');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'settings.json'), temporary = path + '.' + randomUUID();
  try { writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return settings;
}
