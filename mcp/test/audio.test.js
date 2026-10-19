import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopAudio } from '../lib/audio.js';

function setup() {
  const live = new Map([['a', { desktop: 2, generation: 'a' }], ['b', { desktop: 3, generation: 'b' }]]);
  const streams = [
    { index: 11, client: 1, mute: false, properties: { 'window.x11.display': ':92', 'application.process.id': '221', 'pipewire.access.portal.app_id': 'game' } },
    { index: 12, client: 2, mute: false, properties: { 'window.x11.display': ':0' } },
    { index: 13, client: 3, mute: false, properties: { 'window.x11.display': ':93' } }
  ];
  const calls = [];
  let hook = () => {};
  const controller = createDesktopAudio({ leases: { byHandle: live, live: l => live.get(l.generation) === l }, interval: 0,
    processEnvironment: async pid => ({
      500: 'WAYLAND_DISPLAY=wayland-agent-2\0AGENT_DESKTOP=2\0',
      // gamescope started by a launcher that forwards only the desktop's socket names.
      600: 'WAYLAND_DISPLAY=wayland-agent-2\0DISPLAY=:92\0HYPRLAND_INSTANCE_SIGNATURE=agent-2\0',
      // A game under gamescope: gamescope's own sockets replace the desktop's, the marker inherits.
      700: 'WAYLAND_DISPLAY=gamescope-0\0DISPLAY=:3\0AGENT_DESKTOP=2\0',
      800: 'WAYLAND_DISPLAY=wayland-agent-2\0AGENT_DESKTOP=3\0'
    })[pid] ?? '',
    run: async args => {
      hook(args);
      if (args[0] === 'pw-dump') return { stdout: JSON.stringify(streams.flatMap(s => [
        { id: s.client, type: 'PipeWire:Interface:Client', info: { props: {} } },
        { id: s.index, type: 'PipeWire:Interface:Node', info: {
          props: { 'media.class': 'Stream/Output/Audio', 'client.id': s.client, 'object.serial': s.index + 100, ...s.properties },
          params: { Props: [{ mute: s.mute }] }
        } }
      ])) };
      calls.push(args);
      const stream = streams.find(s => String(s.index) === args[2]);
      if (stream) stream.mute = JSON.parse(args[4]).mute;
      return { stdout: '' };
    }
  });
  return { controller, live, streams, calls, setHook: fn => { hook = fn; } };
}

test('desktop defaults mute only its audio, including sandboxed game display, and unmute leaves other desktops alone', async () => {
  const { controller, streams, calls } = setup();
  assert.deepEqual(await controller.state(2, 'a'), { available: true, muted: true, streams: 1 });
  assert.deepEqual(streams.map(s => s.mute), [true, false, false]);
  await controller.set(2, 'a', false);
  assert.deepEqual(streams.map(s => s.mute), [false, false, false]);
  assert.ok(calls.every(c => c[0] === 'pw-cli' && c[2] === '11'));
});

test('native Wayland environment attribution is strict and ignores namespace PIDs', async () => {
  const { controller, streams } = setup();
  streams.push({ index: 20, client: 4, mute: false, properties: { 'application.process.id': '500' } },
    { index: 21, client: 5, mute: false, properties: { 'application.process.id': '500', 'pipewire.access.portal.app_id': 'sandbox' } });
  await controller.state(2, 'a');
  assert.equal(streams[3].mute, true);
  assert.equal(streams[4].mute, false);
});

test('a nested X11 display falls back to the process environment, which needs agreeing desktop names', async () => {
  const { controller, streams } = setup();
  streams.push({ index: 30, client: 6, mute: false, properties: { 'window.x11.display': ':3', 'application.process.id': '600' } },
    { index: 31, client: 7, mute: false, properties: { 'window.x11.display': ':3', 'application.process.id': '700' } },
    { index: 32, client: 8, mute: false, properties: { 'window.x11.display': ':3', 'application.process.id': '800' } },
    { index: 33, client: 9, mute: false, properties: { 'window.x11.display': ':3' } });
  assert.deepEqual(await controller.state(2, 'a'), { available: true, muted: true, streams: 3 });
  assert.deepEqual(streams.slice(3).map(s => s.mute), [true, true, false, false]);
  await controller.state(3, 'b');
  assert.equal(streams[5].mute, false);
});

test('future streams follow desktop policy and a new generation gets the muted default', async () => {
  const { controller, streams, live } = setup();
  await controller.set(2, 'a', false);
  streams.push({ index: 20, client: 4, mute: true, properties: { 'window.x11.display': ':92' } });
  await controller.tick();
  assert.equal(streams[3].mute, false);
  live.delete('a'); live.set('new', { desktop: 2, generation: 'new' });
  await controller.tick();
  assert.equal(streams[0].mute, true);
  assert.equal(streams[3].mute, true);
  await assert.rejects(controller.set(2, 'a', false), { status: 404 });
});

test('expired generation or a replaced stream cannot be mutated after discovery', async () => {
  const { controller, streams, live, calls, setHook } = setup();
  let reads = 0;
  setHook(args => { if (args[0] === 'pw-dump' && ++reads === 2) streams[0] = { ...streams[0], client: 90, properties: { 'window.x11.display': ':0' } }; });
  await controller.state(2, 'a');
  assert.equal(calls.length, 0);
  setHook(args => { if (args[0] === 'pw-dump') live.delete('a'); });
  await assert.rejects(controller.set(2, 'a', false), { status: 404 });
  assert.equal(calls.length, 0);
});

test('audio failure and unsupported hosts are unavailable, not successful mutes', async () => {
  const leases = { byHandle: new Map([['a', { desktop: 2, generation: 'a' }]]), live: () => true };
  for (const enabled of [true, false]) {
    const audio = createDesktopAudio({ leases, enabled, interval: 0, run: async () => { throw new Error('missing'); } });
    assert.equal((await audio.state(2, 'a')).available, false);
    await assert.rejects(audio.set(2, 'a', 'yes'), { status: 400 });
  }
});


function jackSetup({ failDisconnect = () => false } = {}) {
  const lease = { desktop: 2, generation: 'a' };
  const leases = { byHandle: new Map([['a', lease]]), live: () => true, save: () => { saved = structuredClone(lease); } };
  let saved;
  const node = (id, client, api) => ({ id, type: 'PipeWire:Interface:Node', info: { props: { 'client.id': client, 'object.serial': id + 100, 'client.api': api } } });
  const port = (id, node, direction) => ({ id, type: 'PipeWire:Interface:Port', info: { direction, props: { 'node.id': node, 'object.serial': id + 100, 'format.dsp': '32 bit float mono audio' } } });
  const link = (id, output, input) => ({ id, type: 'PipeWire:Interface:Link', info: { 'output-port-id': output, 'input-port-id': input, props: { 'object.serial': id + 100 } } });
  const graph = [
    { id: 0, type: 'PipeWire:Interface:Core', info: { cookie: 123 } },
    { id: 1, type: 'PipeWire:Interface:Client', info: { props: { 'window.x11.display': ':92' } } },
    { id: 2, type: 'PipeWire:Interface:Client', info: { props: { 'window.x11.display': ':0' } } },
    node(10, 1, 'jack'), node(11, 2, 'jack'), node(12, 2, 'alsa'),
    port(20, 10, 'output'), port(21, 10, 'output'), port(22, 11, 'output'), port(23, 12, 'input'), port(24, 12, 'input'),
    link(30, 20, 23), link(31, 21, 24), link(32, 22, 23)
  ];
  const calls = [];
  let ignoreWrites = false;
  const run = async args => {
    if (args[0] === 'pw-dump') return { stdout: JSON.stringify(graph) };
    if (args[0] === '-f') return { stdout: '[]' }; // The broken PulseAudio controller misses DSP nodes.
    calls.push(args);
    if (!ignoreWrites && args[0] === 'pw-link') {
      if (args[1] === '-d') {
        if (failDisconnect(args[2])) throw new Error('disconnect failed');
        assert.ok(saved?.audioRoutes?.length, 'routes must be durable before disconnecting');
        const index = graph.findIndex(o => o.id === Number(args[2]));
        graph.splice(index, 1);
      } else graph.push(link(40 + calls.length, Number(args.at(-2)), Number(args.at(-1))));
    }
    return { stdout: '' };
  };
  const create = () => createDesktopAudio({ leases, run, interval: 0 });
  return { controller: create(), create, leases, lease, graph, calls, ignoreWrites: () => { ignoreWrites = true; } };
}

test('Minecraft JACK playback is muted, routes survive an API restart, and user JACK links stay intact', async () => {
  const { controller, create, graph, calls, leases, lease } = jackSetup();
  assert.deepEqual(await controller.state(2, 'a'), { available: true, muted: true, streams: 1 });
  assert.deepEqual(graph.filter(o => o.type.endsWith(':Link')).map(o => o.id), [32]);
  await controller.close();
  leases.byHandle.set('a', JSON.parse(JSON.stringify(lease)));
  const restarted = create();
  await restarted.set(2, 'a', false);
  assert.equal(graph.filter(o => o.type.endsWith(':Link')).length, 3);
  assert.ok(calls.every(c => !c.includes('32')), 'user audio is untouched');
  await restarted.set(2, 'a', true);
  assert.deepEqual(graph.filter(o => o.type.endsWith(':Link')).map(o => o.id), [32]);
  await restarted.close();
});

test('JACK mute must be observed, and unmute never reconnects a recycled port', async () => {
  const first = jackSetup();
  first.ignoreWrites();
  await assert.rejects(first.controller.state(2, 'a'), /not reached/);
  await first.controller.close();
  const { controller, graph, calls } = jackSetup();
  await controller.state(2, 'a');
  graph.find(o => o.id === 24).info.props['object.serial'] = 999;
  await controller.set(2, 'a', false);
  assert.ok(!calls.some(c => c[0] === 'pw-link' && c.at(-1) === '24'));
  await controller.close();
});


test('JACK capture and MIDI clients do not prevent desktop unmute', async () => {
  const { controller, graph } = jackSetup();
  graph.push({ id: 13, type: 'PipeWire:Interface:Node', info: { props: { 'client.id': 1, 'client.api': 'jack', 'object.serial': 113 } } },
    { id: 25, type: 'PipeWire:Interface:Port', info: { direction: 'input', props: { 'node.id': 13, 'format.dsp': '32 bit float mono audio', 'object.serial': 125 } } });
  assert.equal((await controller.state(2, 'a')).streams, 1);
  await controller.set(2, 'a', false);
  await controller.close();
});

test('a failed route save leaves JACK links connected and retries durability before disconnecting', async () => {
  const { controller, graph, leases, lease } = jackSetup();
  const save = leases.save;
  leases.save = () => { throw new Error('disk full'); };
  await assert.rejects(controller.state(2, 'a'), /disk full/);
  assert.equal(lease.audioRoutes, undefined);
  assert.equal(graph.filter(o => o.type.endsWith(':Link')).length, 3);
  leases.save = save;
  await controller.state(2, 'a');
  assert.deepEqual(graph.filter(o => o.type.endsWith(':Link')).map(o => o.id), [32]);
  await controller.close();
});

test('unmute consumes saved routes so later application routing changes are preserved', async () => {
  const { controller, graph, lease } = jackSetup();
  await controller.state(2, 'a');
  await controller.set(2, 'a', false);
  const output = graph.find(o => o.type.endsWith(':Link') && o.info['output-port-id'] === 20);
  output.info['input-port-id'] = 24;
  await controller.tick();
  assert.equal(graph.filter(o => o.type.endsWith(':Link') && o.info['output-port-id'] === 20).length, 1);
  assert.deepEqual(lease.audioRoutes, []);
  await controller.state(2, 'a');
  assert.equal(graph.filter(o => o.type.endsWith(':Link')).length, 3);
  await controller.close();
});


test('mute retry preserves every pending route after a partial disconnect failure', async () => {
  let fail = true;
  const { controller, graph } = jackSetup({ failDisconnect: id => id === '31' && fail });
  graph.find(o => o.id === 31).info['output-port-id'] = 20;
  await assert.rejects(controller.state(2, 'a'), /disconnect failed/);
  fail = false;
  await controller.state(2, 'a');
  await controller.set(2, 'a', false);
  const targets = graph.filter(o => o.type.endsWith(':Link') && o.info['output-port-id'] === 20).map(o => o.info['input-port-id']).sort();
  assert.deepEqual(targets, [23, 24]);
  await controller.close();
});
