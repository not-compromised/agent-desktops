import { api } from './api.js';

export function installSettings(onChange) {
  const panel = document.getElementById('settings-panel'), form = panel.querySelector('form'), error = panel.querySelector('[role=alert]');
  const idle = form.elements.idlePreset, custom = form.elements.idleCustom;
  let settings;
  const toggleCustom = () => { custom.closest('label').hidden = idle.value !== 'custom'; custom.required = idle.value === 'custom'; };
  idle.onchange = toggleCustom;
  function populate(value) {
    settings = value;
    idle.value = [5, 15, 30, 60].includes(value.idleMinutes) ? String(value.idleMinutes) : 'custom';
    custom.value = value.idleMinutes; toggleCustom();
    for (const field of ['browserStartup', 'viewerStartup', 'streamQuality', 'notificationSeconds']) form.elements[field].value = value[field];
  }
  async function open() {
    error.textContent = ''; panel.hidden = false;
    for (const field of form.querySelectorAll('select,input,[type=submit]')) field.disabled = true;
    try { populate((await api('api/preferences')).settings);
      for (const field of form.querySelectorAll('select,input,[type=submit]')) field.disabled = false;
      idle.focus(); }
    catch (reason) { error.textContent = reason.message; }
  }
  document.getElementById('settings-open').onclick = open;
  document.getElementById('settings-close').onclick = () => { panel.hidden = true; };
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.hidden = true; event.stopPropagation(); } });
  form.onsubmit = async event => {
    event.preventDefault(); if (!settings) return;
    const button = form.querySelector('[type=submit]'); button.disabled = true; error.textContent = '';
    try {
      const patch = { idleMinutes: Number(idle.value === 'custom' ? custom.value : idle.value),
        browserStartup: form.elements.browserStartup.value, viewerStartup: form.elements.viewerStartup.value,
        streamQuality: form.elements.streamQuality.value, notificationSeconds: Number(form.elements.notificationSeconds.value) };
      const value = (await api('api/preferences', patch)).settings;
      populate(value); onChange(value); panel.hidden = true;
    } catch (reason) { error.textContent = reason.message; }
    finally { button.disabled = false; }
  };
  return { open, update(value) { if (value && panel.hidden) populate(value); } };
}

export function countdown(desktop, now = Date.now()) {
  if (!Number.isFinite(desktop.closesAt)) return 'Timer unavailable';
  const minutes = Math.max(0, Math.ceil((desktop.closesAt - now) / 60000));
  if (!minutes) return 'Closing soon';
  return `Closes in ${minutes} min`;
}
