import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({ idleMinutes: 30, browserStartup: 'fresh', viewerStartup: 'open', streamQuality: 'auto', notificationSeconds: 4 });
const choices = { browserStartup: ['fresh', 'restore'], viewerStartup: ['open', 'notify'], streamQuality: ['auto', 'resource', 'sharp'] };
const invalid = () => Object.assign(new Error('Invalid desktop settings.'), { status: 400 });
export class Settings {
  constructor({ file = null } = {}) {
    this.file = file;
    this.value = { ...DEFAULT_SETTINGS };
    if (file) try { this.value = { ...this.value, ...this.validate(JSON.parse(readFileSync(file, 'utf8'))) }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read desktop settings: ${error.message}`); }
  }
  validate(patch) {
    if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw invalid();
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw invalid();
      if (choices[key] ? !choices[key].includes(value) : !Number.isInteger(value) || value < 1 || value > (key === 'idleMinutes' ? 1440 : 30)) throw invalid();
    }
    return patch;
  }
  read() { return { ...this.value }; }
  update(patch) {
    const next = { ...this.value, ...this.validate(patch) };
    if (this.file) {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, this.file);
    }
    this.value = next;
    return this.read();
  }
}
