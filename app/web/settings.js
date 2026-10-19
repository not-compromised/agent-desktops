import { api } from './api.js';
const $ = id => document.getElementById(id), dialog = $('settings'), status = $('settings-status');
const opener = $('connection-open');
opener.onclick = async () => {
  dialog.showModal(); status.textContent = 'Loading settings'; $('settings-save').disabled = true;
  try {
    const { settings, connection } = await api('api/settings');
    $('auto-open').checked = settings.autoOpen;
    $('fleet-url').value = settings.fleet.url || ''; $('fleet-token-file').value = settings.fleet.tokenFile || '';
    $('connection-status').textContent = `${connection.mode === 'local' ? 'This machine' : 'Remote hub'} · ${connection.url}`;
    status.textContent = ''; $('settings-save').disabled = false;
  } catch (error) { status.textContent = `Settings unavailable: ${error.message}`; }
};
$('connection-close').onclick = () => dialog.close();
dialog.addEventListener('close', () => opener.focus());
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  const url = $('fleet-url').value.trim(), tokenFile = $('fleet-token-file').value.trim();
  if (Boolean(url) !== Boolean(tokenFile)) { status.textContent = 'Enter both a hub URL and its private token file path, or leave both blank for this machine.'; return; }
  if (url && (!url.startsWith('https://') || !tokenFile.startsWith('/'))) { status.textContent = 'Remote connections require an HTTPS URL and an absolute token file path.'; return; }
  $('settings-save').disabled = true; status.textContent = 'Saving settings';
  try {
    const result = await api('api/settings', { autoOpen: $('auto-open').checked, fleet: { url, tokenFile } });
    status.textContent = result.restartRequired ? 'Saved. Close and reopen Agent Desktops to apply the connection.' : 'Settings saved.';
  } catch (error) { status.textContent = `Could not save settings: ${error.message}`; }
  finally { $('settings-save').disabled = false; }
};
