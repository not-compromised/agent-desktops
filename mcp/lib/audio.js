import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { leaseGeneration as generation } from './leases.js';

const exec = promisify(execFile);
const ended = () => Object.assign(new Error('This desktop has ended.'), { status: 404 });
const routeKey = route => JSON.stringify([route.cookie, route.output, route.input]);
const X11_DISPLAY = /^:9([1-9]\d*)(?:\.0)?$/;
// The names nest.js gives every process it launches. A game under gamescope or
// wine reports gamescope's nested X display and inherits only some of these, so
// any one name attributes; names that disagree do not.
const NEST_NAMES = [['AGENT_DESKTOP', /^([1-9]\d*)$/], ['WAYLAND_DISPLAY', /^wayland-agent-([1-9]\d*)$/], ['DISPLAY', X11_DISPLAY], ['HYPRLAND_INSTANCE_SIGNATURE', /^agent-([1-9]\d*)$/]];

export function environmentDesktop(environ) {
  const env = Object.fromEntries(environ.split('\0').map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  const named = new Set(NEST_NAMES.map(([name, pattern]) => pattern.exec(env[name] ?? '')).filter(Boolean).map(m => Number(m[1])));
  return named.size === 1 ? [...named][0] : undefined;
}

export function createDesktopAudio({ leases, enabled = true,
  run = ([command, ...args]) => exec(command, args, { timeout: 3000, maxBuffer: 16 * 1024 * 1024 }),
  processEnvironment = async pid => readFile(`/proc/${pid}/environ`, 'utf8'), interval = 1000 } = {}) {
  const preferences = new Map();
  let chain = Promise.resolve(), closed = false, ticking;
  const active = () => [...leases.byHandle.values()].filter(l => leases.live(l));
  const key = l => `${l.desktop}/${generation(l)}`;
  const check = (n, g) => {
    const l = active().find(l => l.desktop === n && generation(l) === g);
    if (!l) throw ended();
    return l;
  };
  const serial = fn => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  const list = async () => {
    const graph = JSON.parse((await run(['pw-dump'])).stdout);
    const cookie = graph.find(o => o.type === 'PipeWire:Interface:Core')?.info?.cookie;
    const clients = new Map(graph.filter(o => o.type === 'PipeWire:Interface:Client').map(o => [o.id, o.info?.props ?? {}]));
    const ports = graph.filter(o => o.type === 'PipeWire:Interface:Port');
    const links = graph.filter(o => o.type === 'PipeWire:Interface:Link');
    const nodes = graph.filter(o => o.type === 'PipeWire:Interface:Node');
    const audioOutputs = node => ports.filter(p => p.info?.props?.['node.id'] === node.id
      && p.info?.direction === 'output' && p.info?.props?.['format.dsp']?.includes('audio'));
    const streams = nodes.filter(o => o.info?.props?.['media.class'] === 'Stream/Output/Audio'
      || (o.info?.props?.['client.api'] === 'jack' && audioOutputs(o).length > 0));
    return Promise.all(streams.map(async stream => {
      const nodeProps = stream.info.props;
      const client = clients.get(nodeProps['client.id']) ?? {};
      const props = { ...client, ...nodeProps };
      let desktop;
      const display = props['window.x11.display'];
      const shown = typeof display === 'string' ? X11_DISPLAY.exec(display) : null;
      if (shown) desktop = Number(shown[1]);
      else if (!props['pipewire.access.portal.app_id'] && props['pipewire.client.access'] !== 'flatpak') {
        // Flatpak's application PID is in its private namespace, not host /proc.
        const pid = props['client.api'] === 'pipewire-pulse'
          ? props['application.process.id'] : client['pipewire.sec.pid'] ?? props['application.process.id'];
        if (/^[1-9]\d*$/.test(String(pid))) {
          try { desktop = environmentDesktop(await processEnvironment(pid)); } catch { /* Unattributable streams remain untouched. */ }
        }
      }
      const outputPorts = audioOutputs(stream);
      const jack = props['client.api'] === 'jack';
      const outgoing = links.filter(l => outputPorts.some(p => p.id === l.info?.['output-port-id']));
      const endpoint = id => ports.find(p => p.id === id)?.info?.props?.['object.serial'];
      const routes = outgoing.map(l => ({ cookie, output: endpoint(l.info['output-port-id']),
        input: endpoint(l.info['input-port-id']), passive: l.info.props?.['link.passive'] === true }));
      const availableRoutes = ports.map(p => ({ id: p.id, serial: p.info?.props?.['object.serial'] }));
      const identity = JSON.stringify([cookie, stream.id, nodeProps['client.id'], nodeProps['object.serial'],
        client['object.serial'], props['application.process.id'], display]);
      return { index: stream.id, identity, desktop,
        jack, cookie, ports: availableRoutes, links: outgoing.map((l, i) => ({ id: l.id, serial: l.info.props?.['object.serial'], route: routes[i] })),
        outputs: outputPorts.map(p => p.info.props['object.serial']),
        muted: jack ? outgoing.length === 0 : stream.info.params?.Props?.find(p => typeof p.mute === 'boolean')?.mute };
    }));
  };
  const saveRoutes = (lease, routes) => {
    if (JSON.stringify(routes) === JSON.stringify(lease.audioRoutes)) return;
    const previous = lease.audioRoutes;
    lease.audioRoutes = routes;
    try { leases.save?.(); }
    catch (error) { lease.audioRoutes = previous; throw error; }
  };
  const unavailable = reason => ({ available: false, muted: true, streams: 0, reason });
  const reconcile = async (n, g, requested) => {
    const lease = check(n, g);
    if (!enabled) return unavailable('Sound control is unavailable on this host.');
    let streams;
    try { streams = await list(); } catch { return unavailable('The host audio service is unavailable.'); }
    check(n, g);
    if (typeof requested === 'boolean') preferences.set(key(lease), requested);
    const muted = preferences.get(key(lease)) ?? true;
    const matching = streams.filter(s => s.desktop === n);
    for (const stream of matching) {
      if (!stream.jack && stream.muted === muted) continue;
      const fresh = (await list()).find(s => s.identity === stream.identity && s.desktop === n);
      if (!fresh) continue;
      check(n, g);
      if (!fresh.jack) {
        await run(['pw-cli', 'set-param', String(fresh.index), 'Props', JSON.stringify({ mute: muted })]);
        continue;
      }
      // JACK DSP nodes have no mute property. Keep their routes durably before
      // disconnecting, so unmute still works after an API restart.
      const valid = (lease.audioRoutes ?? []).filter(r => r.cookie === fresh.cookie
        && fresh.ports.some(p => p.serial === r.output) && fresh.ports.some(p => p.serial === r.input));
      const routes = new Map(valid.map(r => [routeKey(r), r]));
      if (muted) for (const link of fresh.links) routes.set(routeKey(link.route), link.route);
      saveRoutes(lease, [...routes.values()]);
      if (muted) {
        for (const link of fresh.links) {
          const current = (await list()).find(s => s.identity === fresh.identity && s.desktop === n);
          if (!current?.links.some(l => l.id === link.id && l.serial === link.serial)) continue;
          check(n, g);
          await run(['pw-link', '-d', String(link.id)]);
        }
      } else {
        for (const route of routes.values()) {
          if (!fresh.outputs.includes(route.output)) continue;
          const current = (await list()).find(s => s.identity === fresh.identity && s.desktop === n);
          if (!current || current.links.some(l => routeKey(l.route) === routeKey(route))) continue;
          const output = current.ports.find(p => p.serial === route.output);
          const input = current.ports.find(p => p.serial === route.input);
          if (!output || !input) continue;
          check(n, g);
          await run(['pw-link', ...(route.passive ? ['-P'] : []), String(output.id), String(input.id)]);
        }
      }
    }
    check(n, g);
    const observed = (await list()).filter(s => s.desktop === n);
    const incomplete = observed.some(s => s.muted !== muted || (!muted && s.jack
      && (lease.audioRoutes ?? []).some(r => r.cookie === s.cookie && s.outputs.includes(r.output)
        && s.ports.some(p => p.serial === r.input) && !s.links.some(l => routeKey(l.route) === routeKey(r)))));
    if (incomplete) throw new Error('Desktop sound has not reached the requested state. Try again.');
    if (!muted && lease.audioRoutes?.length) saveRoutes(lease, []);
    return { available: true, muted, streams: observed.length };
  };
  const tick = () => ticking ||= serial(async () => {
    if (closed) return;
    const live = active();
    const keys = new Set(live.map(key));
    for (const k of preferences.keys()) if (!keys.has(k)) preferences.delete(k);
    for (const l of live) {
      try { await reconcile(l.desktop, generation(l)); } catch { /* State reads report failures. */ }
    }
  }).finally(() => { ticking = null; });
  const timer = enabled && interval > 0 ? setInterval(tick, interval) : null;
  timer?.unref();
  return {
    state: (n, g) => serial(() => reconcile(n, g)),
    set: (n, g, muted) => {
      if (typeof muted !== 'boolean') return Promise.reject(Object.assign(new Error('muted must be a boolean.'), { status: 400 }));
      return serial(() => reconcile(n, g, muted));
    },
    tick,
    close: async () => { closed = true; clearInterval(timer); await chain; }
  };
}
