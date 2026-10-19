import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

const BROWSERS = new Set(['brave', 'brave-browser', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']);
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
function running(profile) {
  const lock = join(profile, 'SingletonLock');
  if (!stat(lock)) return false;
  let owner;
  try { owner = readlinkSync(lock); } catch { return true; }
  const match = owner.match(/^(.*)-(\d+)$/);
  if (!match || match[1] !== hostname()) return true;
  try { process.kill(Number(match[2]), 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export function browserCommand(command, { profileBase, desktop, startup = 'fresh', extra = [] }) {
  const [bin, ...requested] = command;
  if (!BROWSERS.has(basename(bin))) return command;
  if (requested.some(arg => /^--(user-data-dir|profile-directory)(=|$)/.test(arg))) {
    throw new Error('Browser profiles are managed by the desktop; omit profile flags');
  }
  if (requested.some(arg => /^--(restore-last-session|no-startup-window)(=|$)/.test(arg))) {
    throw new Error('Browser startup is managed by Agent Desktops settings; omit startup flags');
  }
  const profile = join(profileBase, String(desktop), basename(bin));
  const dir = join(profile, 'Default');
  const file = join(dir, 'Preferences');
  for (const path of [profile, dir, file]) {
    if (stat(path)?.isSymbolicLink()) throw new Error('Managed browser profile must not be a symlink');
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!running(profile)) {
    let prefs = {};
    try { prefs = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read managed browser preferences: ${error.message}`); }
    if (!prefs || Array.isArray(prefs) || typeof prefs !== 'object') throw new Error('Invalid managed browser preferences');
    // Chromium's preference values differ from its StartupPref enum: LAST=1,
    // NEW_TAB=5. Preserve session files and unrelated profile preferences.
    prefs.session = { ...prefs.session, restore_on_startup: startup === 'restore' ? 1 : 5 };
    if (startup !== 'restore') prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true };
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
    renameSync(tmp, file);
  }
  const args = [...requested];
  if (startup === 'restore') args.unshift('--restore-last-session');
  else if (!args.some(arg => !arg.startsWith('-'))) args.push('about:blank');
  return [bin, `--user-data-dir=${profile}`, '--no-first-run', ...extra, ...args];
}
