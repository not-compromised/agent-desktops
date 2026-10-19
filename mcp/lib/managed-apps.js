import { randomUUID } from 'node:crypto';

export function createManagedApps({ execute, unit, instance, env }) {
  const desktops = new Map();
  const properties = async (name, signal) => {
    signal?.throwIfAborted();
    const { stdout } = await execute('systemctl', ['--user', 'show', name, '-p', 'ControlGroup', '-p', 'InvocationID', '-p', 'BindsTo', '-p', 'ActiveState'], { timeout: 1500, signal });
    return Object.fromEntries(String(stdout).trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  };
  return {
    allocate(n, { track = true } = {}) {
      const name = `${unit(n).slice(0, -8)}-app-${randomUUID()}.service`;
      if (!track) return name;
      const expected = instance(n);
      let registry = desktops.get(n);
      if (registry?.instance !== expected) { registry = { instance: expected, names: new Map() }; desktops.set(n, registry); }
      if (registry.names.size >= 256) throw new Error('Managed application limit reached; close apps or release this desktop');
      registry.names.set(name, null);
      return name;
    },
    async activated(n, name) {
      const registry = desktops.get(n);
      if (!registry || !registry.names.has(name)) throw new Error('Application launch was not registered');
      const p = await properties(name);
      if (p.ActiveState !== 'active') { registry.names.delete(name); return; }
      if (!p.ControlGroup || !p.InvocationID || !p.BindsTo.split(' ').includes(unit(n))) throw new Error('Managed application identity is unavailable');
      registry.names.set(name, { cgroup: p.ControlGroup, invocation_id: p.InvocationID });
    },
    forget: (n, name) => desktops.get(n)?.names.delete(name),
    clear: n => desktops.delete(n),
    async context(n, expected, { signal } = {}) {
      signal?.throwIfAborted();
      if (!expected || instance(n) !== expected) throw new Error('Desktop generation changed');
      const desktop = await properties(unit(n), signal);
      if (desktop.ActiveState !== 'active' || !desktop.ControlGroup || !desktop.InvocationID) throw new Error('Desktop unit identity is unavailable');
      const registry = desktops.get(n);
      const apps = [];
      if (registry?.instance === expected) {
        for (const [name, identity] of registry.names) {
          const p = await properties(name, signal);
          if (p.ActiveState !== 'active') { registry.names.delete(name); continue; }
          if (!identity || p.ControlGroup !== identity.cgroup || p.InvocationID !== identity.invocation_id || !p.BindsTo.split(' ').includes(unit(n))) continue;
          apps.push({ unit: name, cgroup: p.ControlGroup, invocation_id: p.InvocationID });
        }
      }
      if (instance(n) !== expected) throw new Error('Desktop generation changed');
      return { instance: expected, env: env(n), desktop_cgroup: desktop.ControlGroup, apps };
    }
  };
}
