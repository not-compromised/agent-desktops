// The tool surface. One McpServer per request (stateless core): the factory is
// cheap and closes over the shared lease table and nest layer.
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { HandleError, leaseGeneration } from './leases.js';
import { createObservation } from './observation.js';


const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });

function windowsText(ws) {
  if (!ws.length) return 'no windows';
  return ws.map(w => `${w.focused ? '*' : ' '} [${w.class}] ${w.title}  at ${w.x},${w.y} ${w.w}x${w.h}`).join('\n');
}

export function buildServer({ leases, nest, host, lifecycle }) {
  const placement = nest.placement || 'background desktop; open Agent Desktops from the app launcher to watch or take control';
  const server = new McpServer({ name: 'hypr-desktop', version: '1.0.0' });

  const observation = createObservation({ nest, leases });
  const snapshot = (l, scale) => observation.capture(l, { scale });
  const feedback = {
    observe: z.boolean().optional().describe('Return the resulting screenshot in this call, avoiding a separate observe call'),
    scale: z.number().min(0.1).max(1).optional(),
    settle_ms: z.number().int().min(0).max(2000).optional().describe('Before the resulting screenshot; default 100ms')
  };

  // Handle tools serialize with shutdown and map errors to isError
  // results, so the model reads "claim again" instead of a transport failure.
  const withLease = (fn, activity = true) => args => lifecycle.run(args.handle, async lease => {
    try {
      if (!(await nest.ready(lease.desktop))) return fail(`desktop ${lease.desktop} is not running; release this handle and claim another desktop`);
      if (nest.instance) {
        const instance = nest.instance(lease.desktop);
        if (lease.instance !== instance) leases.frames.delete(lease.desktop);
        lease.instance = instance;
      }
      const result = await fn(lease, args);
      if (!result.isError && args.observe) {
        await new Promise(resolve => setTimeout(resolve, args.settle_ms ?? 100));
        return snapshot(lease, args.scale ?? 0.5);
      }
      return result;
    } catch (e) {
      return fail(e instanceof HandleError ? e.message : `${e.message ?? e}`);
    }
  }, { activity }).catch(e => fail(e.message));
  const generationArgs = lease => nest.instance ? [lease.instance] : [];
  const handle = z.string().describe('handle returned by claim');
  const frame = z.string().describe('frame_id from the latest observe');

  server.registerTool('status', {
    description: `Allocated agent desktops on ${host}: running, held or free, idle time. Needs no handle.`,
    inputSchema: z.object({})
  }, async () => {
    const lines = [];
    for (const s of leases.status()) {
      const state = await nest.ready(s.desktop) ? 'ready' : 'stopped';
      const hold = s.held ? `held by ${s.owner}, idle ${Math.round(s.idleMs / 60000)} min` : `expired, cleanup pending for ${s.owner}`;
      let windows = '-';
      if (state === 'ready') {
        try { windows = String((await nest.windows(s.desktop)).length); } catch { windows = '?'; }
      }
      lines.push(`desktop ${s.desktop}: ${state}, ${hold}, windows ${windows}, ${placement}`);
    }
    return text(lines.join('\n') || 'No agent desktops allocated. Claim to start one.');
  });

  server.registerTool('claim', {
    description: 'Spawn a desktop for this task. Call again for additional desktops as needed. Returns a handle for every other tool, the desktop number, and its placement. Tell the user which desktop opened; they can arrange its window themselves. Leases expire after the configured inactivity duration; watching does not renew them. Release when done.',
    inputSchema: z.object({ owner: z.string().max(80).optional().describe('who is claiming, e.g. "claude: fix login page"') })
  }, async ({ owner }) => {
    let lease;
    try { lease = await lifecycle.claim(owner); }
    catch (e) { return fail(`could not spawn desktop: ${e.message}`); }
    return {
      content: [{ type: 'text', text: `claimed desktop ${lease.desktop}; handle ${lease.handle}. Location: ${placement}.` }],
      structuredContent: { handle: lease.handle, desktop: lease.desktop, show: placement }
    };
  });

  server.registerTool('release', {
    description: 'Close this desktop and all its apps. Its browser profile is kept on disk.',
    inputSchema: z.object({ handle })
  }, async ({ handle: h }) => {
    try { const l = await lifecycle.release(h); return text(`released desktop ${l.desktop}`); } catch (e) { return fail(e.message); }
  });

  server.registerTool('keep_open', {
    description: 'Keep this desktop open for a bounded intentional wait without polling. Minutes 1–1440; 0 cancels the override. Manual release still closes it.',
    inputSchema: z.object({ handle, minutes: z.number().int().min(0).max(1440) })
  }, async ({ handle: h, minutes }) => {
    const lease = leases.byHandle.get(h);
    if (!lease) return fail('unknown handle; claim a desktop first');
    try {
      const metadata = await lifecycle.keepOpen(lease.desktop, leaseGeneration(lease), minutes);
      return { ...text(`desktop ${lease.desktop} closes at ${new Date(metadata.closesAt).toISOString()}`), structuredContent: metadata };
    } catch (error) { return fail(error.message); }
  });

  server.registerTool('open', {
    description: 'Launch a program inside the desktop and return at once. Browsers get their own profile (nothing of the user\'s is logged in). Follow with observe.',
    inputSchema: z.object({ ...feedback, handle, command: z.array(z.string()).min(1).describe('argv, e.g. ["brave", "https://example.com"]') })
  }, withLease(async (l, { command }) => {
    leases.frames.delete(l.desktop); await nest.open(l.desktop, command);
    return text(`started ${command[0]} on desktop ${l.desktop}; observe to see it`);
  }));

  server.registerTool('run', {
    description: 'Run a shell command inside the desktop (its own display and desktop session) and wait for it. For window plumbing (hyprctl clients, dispatch) or anything open does not cover.',
    inputSchema: z.object({ handle, command: z.string(), timeout_ms: z.number().int().min(100).max(120000).optional() })
  }, withLease(async (l, { command, timeout_ms }) => {
    leases.frames.delete(l.desktop);
    const r = await nest.exec(l.desktop, command, timeout_ms);
    return { ...text(`exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`), isError: r.code !== 0 };
  }));

  server.registerTool('observe', {
    description: 'Observe the owned desktop. pixels returns bounded screenshots, optionally a visible window region or ordered burst. Only the final frame_id authorizes input; coordinates always use full desktop pixels. accessibility queries the private desktop bus without images or host fallback.',
    inputSchema: z.discriminatedUnion('mode', [
      z.object({ handle, mode: z.literal('pixels').default('pixels'), scale: z.number().min(0.1).max(1).optional(), window_id: z.string().optional(), frames: z.number().int().min(1).max(12).default(1), interval_ms: z.number().int().min(100).max(1000).default(150) }).strict(),
      z.object({ handle, mode: z.literal('accessibility'), window_id: z.string().optional(), role: z.string().max(100).optional(), name: z.string().max(200).optional(), max_nodes: z.number().int().min(1).max(500).default(100), max_depth: z.number().int().min(0).max(12).default(8) }).strict()
    ])
  }, withLease(async (l, args) => {
    if (args.mode === 'accessibility') {
      const window = args.window_id ? await observation.resolve(l, args.window_id) : undefined;
      const result = await nest.accessibility(l.desktop, { ...args, window: window ? { pid: window.pid, title: window.title, bounds: { x: window.x, y: window.y, width: window.w, height: window.h } } : undefined }, ...generationArgs(l));
      return { ...text(JSON.stringify(result)), structuredContent: result };
    }
    return observation.capture(l, args);
  }, false));

  server.registerTool('windows', {
    description: 'List owned windows with opaque window_id references. Window actions also require the latest frame_id from observe.',
    inputSchema: z.object({ handle }).strict()
  }, withLease(async l => {
    const windows = await observation.inventory(l);
    return { ...text(windowsText(windows)), structuredContent: { windows } };
  }, false));

  server.registerTool('window', {
    description: 'Focus, close, position/resize or set fullscreen for a window issued by this desktop. Requires the latest observation. Closing requests normal app closure. Returns the observed result or an explicit timeout.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({ handle, frame_id: frame, window_id: z.string(), action: z.enum(['focus', 'close']) }).strict(),
      z.object({ handle, frame_id: frame, window_id: z.string(), action: z.literal('move_resize'), x: z.number().int().min(0).max(2559), y: z.number().int().min(0).max(1439), width: z.number().int().min(1).max(2560), height: z.number().int().min(1).max(1440) }).strict(),
      z.object({ handle, frame_id: frame, window_id: z.string(), action: z.literal('fullscreen'), enabled: z.boolean() }).strict()
    ])
  }, withLease(async (l, args) => {
    leases.checkFrame(l.desktop, args.frame_id);
    const window = await observation.resolve(l, args.window_id);
    if (args.action === 'move_resize' && (args.x + args.width > 2560 || args.y + args.height > 1440)) throw new Error('Window bounds must fit the desktop');
    leases.frames.delete(l.desktop);
    const result = await nest.window(l.desktop, window, args, ...generationArgs(l));
    return { ...text(JSON.stringify(result)), structuredContent: result };
  }));

  server.registerTool('held_input', {
    description: 'Replace the complete held keys/buttons on this desktop. Individual XKB key names, no chords. Adding input requires a fresh frame. Holds expire independently after timeout_ms, at most 30 seconds; observations never extend them. Empty arrays release everything even without a frame.',
    inputSchema: z.object({ handle, keys: z.array(z.string().regex(/^[A-Za-z0-9_]+$/).max(64)).max(16), buttons: z.array(z.enum(['left', 'middle', 'right'])).max(3), frame_id: frame.optional(), timeout_ms: z.number().int().min(100).max(30000).default(5000) }).strict()
  }, withLease(async (l, args) => {
    const previous = nest.heldState?.(l.desktop) ?? { keys: [], buttons: [] };
    if (args.keys.some(key => !previous.keys.includes(key)) || args.buttons.some(button => !previous.buttons.includes(button))) {
      leases.checkFrame(l.desktop, args.frame_id);
    }
    leases.frames.delete(l.desktop);
    const result = await nest.heldInput(l.desktop, args, ...generationArgs(l));
    return { ...text(JSON.stringify(result)), structuredContent: result };
  }));

  const point = { ...feedback, handle, frame_id: frame, x: z.number().int().min(0).max(2559), y: z.number().int().min(0).max(1439) };
  server.registerTool('move', { description: 'Move the cursor to x,y (full-size pixels of the latest frame).', inputSchema: z.object(point) },
    withLease(async (l, a) => { leases.checkFrame(l.desktop, a.frame_id); leases.frames.delete(l.desktop); await nest.move(l.desktop, a.x, a.y, ...generationArgs(l)); return text(`cursor at ${a.x},${a.y}`); }));

  server.registerTool('click', {
    description: 'Move to x,y and click. Observe again afterwards.',
    inputSchema: z.object({ ...point, button: z.enum(['left', 'right', 'middle']).optional() })
  }, withLease(async (l, a) => { leases.checkFrame(l.desktop, a.frame_id); leases.frames.delete(l.desktop); await nest.click(l.desktop, a.x, a.y, a.button, ...generationArgs(l)); return text(`clicked ${a.button ?? 'left'} at ${a.x},${a.y}`); }));

  server.registerTool('scroll', {
    description: 'Move to x,y and scroll; dy positive scrolls down.',
    inputSchema: z.object({ ...point, dy: z.number().int(), dx: z.number().int().optional() })
  }, withLease(async (l, a) => { leases.checkFrame(l.desktop, a.frame_id); leases.frames.delete(l.desktop); await nest.scroll(l.desktop, a.x, a.y, a.dy, a.dx, ...generationArgs(l)); return text(`scrolled ${a.dy},${a.dx ?? 0} at ${a.x},${a.y}`); }));

  server.registerTool('drag', {
    description: 'Drag from a visible starting point to a destination, releasing the button before returning. Coordinates use the latest full-size frame.',
    inputSchema: z.object({ ...point, to_x: z.number().int().min(0).max(2559), to_y: z.number().int().min(0).max(1439),
      button: z.enum(['left', 'right', 'middle']).default('left'), duration_ms: z.number().int().min(100).max(2000).default(400) })
  }, withLease(async (l, a) => {
    leases.checkFrame(l.desktop, a.frame_id); leases.frames.delete(l.desktop);
    await nest.drag(l.desktop, a.x, a.y, a.to_x, a.to_y, a.button, a.duration_ms, ...generationArgs(l));
    return text(`dragged to ${a.to_x},${a.to_y}`);
  }));

  server.registerTool('type', {
    description: 'Type text into the focused window.',
    inputSchema: z.object({ ...feedback, handle, text: z.string().min(1).max(10000) })
  }, withLease(async (l, a) => { leases.frames.delete(l.desktop); await nest.type(l.desktop, a.text, ...generationArgs(l)); return text(`typed ${a.text.length} chars`); }));

  server.registerTool('key', {
    description: 'Press a key combo, e.g. "Return", "ctrl+l", "ctrl+shift+t", "Escape".',
    inputSchema: z.object({ ...feedback, handle, combo: z.string().min(1).max(40) })
  }, withLease(async (l, a) => { leases.frames.delete(l.desktop); await nest.key(l.desktop, a.combo, ...generationArgs(l)); return text(`pressed ${a.combo}`); }));

  server.registerTool('wait', {
    description: 'Wait for visible stillness, a change, or a change followed by stillness. ms is the maximum wait; timeouts report an unmet condition. Choose sleep for a fixed delay. Does not renew ownership.',
    inputSchema: z.object({ handle, ms: z.number().int().min(50).max(30000), mode: z.enum(['still', 'change', 'settle', 'sleep']).default('still'), quiet_ms: z.number().int().min(50).max(2000).default(300) })
  }, withLease(async (l, a) => {
    leases.frames.delete(l.desktop);
    let result;
    if (a.mode === 'sleep') {
      await new Promise(resolve => setTimeout(resolve, a.ms));
      result = { satisfied: true, reason: 'slept', elapsed_ms: a.ms };
    } else {
      result = await nest.wait(l.desktop, { mode: a.mode, timeout_ms: a.ms, quiet_ms: Math.min(a.quiet_ms, a.ms) }, ...generationArgs(l));
    }
    if (nest.instance && nest.instance(l.desktop) !== l.instance) throw new Error('Desktop restarted during wait; observe again');
    return { ...text(`${result.satisfied ? 'satisfied' : 'unsatisfied'}: ${result.reason}; ${result.elapsed_ms} ms`),
      structuredContent: result, ...(result.satisfied ? {} : { isError: true }) };
  }, false));

  return server;
}
