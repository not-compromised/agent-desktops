// Keep each desktop's commands and shutdown in one queue. Different desktops
// can work concurrently; a number stays reserved until shutdown succeeds.
import { leaseGeneration } from './leases.js';
import { cancelObservation } from './observation.js';
export function createLifecycle({ leases, nest, notify = async () => {}, settings }) {
  const pending = new Map();
  const active = new Set();
  const serial = (desktop, fn) => {
    const next = (pending.get(desktop) ?? Promise.resolve()).then(fn, fn);
    pending.set(desktop, next.catch(() => {}));
    return next;
  };
  const withHandle = (handle, fn) => {
    const l = leases.byHandle.get(handle);
    if (!l) return Promise.reject(new Error(`unknown handle ${handle}`));
    return serial(l.desktop, () => {
      if (leases.byHandle.get(handle) !== l) throw new Error(`unknown handle ${handle}`);
      return fn(l);
    });
  };
  const identified = (desktop, generation, fn) => serial(desktop, async () => {
    const l = [...leases.byHandle.values()].find(l => l.desktop === desktop && leaseGeneration(l) === generation && leases.live(l));
    if (!l) throw Object.assign(new Error('This desktop has ended.'), { status: 404 });
    return fn(l);
  });
  const metadata = l => leases.status().find(d => d.desktop === l.desktop);
  const stop = async l => {
    cancelObservation(l);
    await nest.stop(l.desktop);
    leases.release(l.handle);
    await notify("Agent desktop closed", `${l.owner}: desktop ${l.desktop} and its managed apps have stopped.`);
  };
  const reap = async () => {
    const results = await Promise.allSettled([...leases.byHandle.values()]
      .filter(l => !leases.live(l))
      .map(l => { cancelObservation(l); return serial(l.desktop, async () => {
        if (leases.byHandle.get(l.handle) === l && !leases.live(l)) await stop(l);
      }); }));
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'desktop cleanup failed');
  };
  return {
    run: (handle, fn, { activity = true } = {}) => withHandle(handle, async l => {
      if (!leases.live(l)) leases.touch(handle);
      if (activity) { leases.touch(handle); active.add(l); }
      try { return await fn(l); }
      finally {
        if (activity) { active.delete(l); l.lastUsed = leases.now(); leases.save(); }
      }
    }),
    updateSettings: patch => {
      if (!settings) throw Object.assign(new Error('Desktop settings are unavailable.'), { status: 503 });
      settings.validate(patch);
      // Persist tombstones first: an idle-time increase must never resurrect failed cleanup.
      if (Object.hasOwn(patch, 'idleMinutes')) leases.freezeExpired(active);
      const value = settings.update(patch);
      leases.idleMs = value.idleMinutes * 60000;
      return value;
    },
    activity: (desktop, generation) => identified(desktop, generation, l => {
      leases.touch(l.handle); return metadata(l);
    }),
    keepOpen: (desktop, generation, minutes) => {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
        return Promise.reject(Object.assign(new Error('Keep-open duration must be 0–1440 minutes.'), { status: 400 }));
      return identified(desktop, generation, l => {
        const previous = l.keepOpenUntil;
        l.keepOpenUntil = minutes ? leases.now() + minutes * 60000 : null;
        try { leases.save(); } catch (error) { l.keepOpenUntil = previous; throw error; }
        return metadata(l);
      });
    },
    reap,
    claim: async owner => {
      // Allocation is synchronous, before startup yields to another request.
      const l = leases.claim(owner);
      return serial(l.desktop, async () => {
        try {
          await notify("Opening an agent desktop", `${owner}: desktop ${l.desktop} will open${nest.placement ? ` as a ${nest.placement}` : " in the background. Open Agent Desktops to watch"}.`);
          await nest.stop(l.desktop);
          await nest.start(l.desktop);
          leases.touch(l.handle);
          return l;
        } catch (error) {
          // Keep ownership if cleanup fails, so no other claim can inherit it.
          await stop(l);
          throw error;
        }
      });
    },
    release: handle => {
      const lease = leases.byHandle.get(handle);
      if (lease) cancelObservation(lease);
      return withHandle(handle, async l => { await stop(l); return l; });
    },
    closeDesktop: (desktop, generation) => {
      const target = [...leases.byHandle.values()].find(l => l.desktop === desktop && leaseGeneration(l) === generation);
      if (target) cancelObservation(target);
      return serial(desktop, async () => {
        const lease = [...leases.byHandle.values()].find(l => l.desktop === desktop
        && leaseGeneration(l) === generation);
        if (!lease) throw Object.assign(new Error('This desktop has ended.'), { status: 404 });
        await stop(lease);
        return { desktop, generation, closed: true };
      });
    }
  };
}
