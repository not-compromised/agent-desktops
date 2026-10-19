#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import socket
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler


CLOSE_AFTER = 180


def auto_open_target():
    try:
        monitors = json.loads(subprocess.check_output(['hyprctl', '-j', 'monitors'], timeout=2))
        windows = json.loads(subprocess.check_output(['hyprctl', '-j', 'clients'], timeout=2))
        if not isinstance(monitors, list) or not isinstance(windows, list):
            raise ValueError('Invalid compositor snapshot')
        if sum(m['focused'] is True for m in monitors) != 1:
            raise ValueError('Cannot identify the focused monitor')
        for monitor in sorted(monitors, key=lambda m: m['id']):
            if monitor['focused'] or not monitor.get('dpmsStatus', True) or monitor.get('disabled', False):
                continue
            workspace = monitor['activeWorkspace']['id']
            if type(workspace) is not int or workspace <= 0:
                continue
            if monitor['specialWorkspace']['id'] != 0:
                continue
            if any(w['monitor'] == monitor['id'] and w['mapped'] and
                   (w['fullscreen'] != 0 or w.get('fullscreenClient', 0) != 0) for w in windows):
                continue
            return workspace
        return None
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        raise OSError('Cannot safely place the automatic viewer') from exc


def prepare_auto_open(title):
    workspace = auto_open_target()
    if workspace is None:
        return False
    # Apply before mapping. Moving an already mapped window would steal focus first.
    code = ('hl.window_rule({ name = "agent-desktops-auto-open", '
            'match = { initial_title = ' + json.dumps('^' + title + '$') + ' }, '
            'workspace = "' + str(workspace) + ' silent", '
            'no_initial_focus = true }) '
            'return "ready"')
    result = subprocess.check_output(['hyprctl', 'repl', code], timeout=2, text=True).strip()
    if result != 'ready':
        raise OSError('Compositor did not confirm automatic viewer placement')
    return True


class Watcher:
    def __init__(self, launch, close=lambda: None, clock=time.monotonic, notify=lambda desktop, seconds: None, settings=None):
        self.settings = settings
        self.launch = launch
        self.close = close
        self.clock = clock
        self.active = False
        self.closing = None
        self.known = {}
        self.notify = notify
        self.notified = set()
        self.opened = False
        self.viewer_startup = None
        self.notification_seconds = 4

    def update(self, fleet):
        opening = read_settings(self.settings).get('autoOpen', True)
        desktops, hosts = fleet['desktops'], fleet['hosts']
        configured = {host['id'] for host in hosts}
        self.known = {host: count for host, count in self.known.items() if host in configured}
        if not isinstance(desktops, list) or not isinstance(hosts, list) or not hosts:
            raise ValueError('Invalid fleet snapshot')
        if 'settings' in fleet:
            settings = fleet['settings']
            mode = settings.get('viewerStartup') if isinstance(settings, dict) else None
            if mode in ('open', 'notify'):
                self.viewer_startup = mode
                seconds = settings.get('notificationSeconds')
                if type(seconds) is int and seconds > 0:
                    self.notification_seconds = seconds
        elif self.viewer_startup is None:
            self.viewer_startup = 'open'
        online = {h['id'] for h in hosts if h.get('online') is True}
        identities = {(d.get('host'), d.get('desktop'), d.get('generation')) for d in desktops}
        self.notified = {identity for identity in self.notified if identity[0] not in online or identity in identities}
        for host in hosts:
            if host.get('online') is True:
                self.known[host['id']] = sum(d['host'] == host['id'] for d in desktops)
        empty = bool(self.known) and not any(self.known.values())
        if any(d.get('ready') for d in desktops):
            if self.viewer_startup == 'open' and opening and not self.opened:
                self.launch()
                self.active = True
                self.opened = True
            elif self.viewer_startup == 'notify':
                for desktop in desktops:
                    identity = (desktop.get('host'), desktop.get('desktop'), desktop.get('generation'))
                    if not desktop.get('ready') or not identity[2] or identity in self.notified:
                        continue
                    # Local claims already notify through the owning backend.
                    if desktop.get('host') != fleet.get('localHost'):
                        self.notify(desktop, self.notification_seconds)
                    self.notified.add(identity)
                self.active = True
            if self.viewer_startup == 'open':
                self.notified.update(identity for identity in identities if identity[2])
        elif empty and self.active:
            self.active = False
            self.opened = False
            self.closing = self.clock() + CLOSE_AFTER
        if not empty:
            self.closing = None
        elif self.closing is not None and self.clock() >= self.closing:
            self.close()
            self.closing = None


class Discovery:
    def __init__(self):
        self.hosts = []
        self.pool = ThreadPoolExecutor(max_workers=2)
        self.settings = None

    def read(self, remote, local, host):
        fleet = self.pool.submit(remote)
        own = self.pool.submit(local)
        try:
            data = fleet.result()
            if not isinstance(data, dict) or not isinstance(data.get('hosts'), list) or not isinstance(data.get('desktops'), list):
                raise ValueError('Invalid fleet snapshot')
            if any(not isinstance(h, dict) or not isinstance(h.get('id'), str) for h in data['hosts']) or any(
                    not isinstance(d, dict) or not isinstance(d.get('host'), str) for d in data['desktops']):
                raise ValueError('Invalid fleet rows')
            self.hosts = data['hosts']
        except (OSError, ValueError, KeyError, TypeError):
            data = {'hosts': [{**h, 'online': False} for h in self.hosts], 'desktops': []}
        try:
            own_data = own.result()
            desktops = own_data['desktops']
            if not isinstance(desktops, list) or any(not isinstance(d, dict) for d in desktops):
                raise ValueError('Invalid local snapshot')
            settings = own_data.get('settings')
            if settings is not None:
                if not isinstance(settings, dict) or settings.get('viewerStartup') not in ('open', 'notify'):
                    raise ValueError('Invalid local viewer setting')
                self.settings = dict(settings)
            elif self.settings is None:
                self.settings = {'viewerStartup': 'open'}
            data = {'hosts': [h for h in data['hosts'] if h['id'] != host] + [{'id': host, 'online': True}],
                    'desktops': [d for d in data['desktops'] if d['host'] != host] +
                    [{**d, 'host': host} for d in desktops if d.get('held')]}
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if not data['hosts'] or not any(h.get('online') for h in data['hosts']):
            raise OSError('Desktop discovery unavailable')
        data['settings'] = self.settings
        data['localHost'] = host
        return data

    def close(self):
        self.pool.shutdown(wait=True)


def request_snapshot(url, token_file):
    token = Path(token_file).read_text().strip()
    request = Request(url, headers={'Authorization': 'Bearer ' + token})
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with build_opener(NoRedirect).open(request, timeout=2) as response:
        return json.load(response)


def read_settings(path=None):
    try:
        settings = json.loads((path or Path.home() / '.config/agent-desktops/settings.json').read_text())
    except FileNotFoundError:
        settings = {}
    if not isinstance(settings, dict) or not isinstance(settings.get('autoOpen', True), bool):
        raise ValueError('settings.json autoOpen must be a boolean')
    return settings


def connection():
    settings = read_settings()
    if 'fleet' in settings:
        config = settings['fleet']
    else:
        try:
            config = json.loads((Path.home() / '.config/agent-desktops/fleet.json').read_text())
        except FileNotFoundError:
            config = {}
    if not isinstance(config, dict):
        raise ValueError('Fleet connection must contain a URL and private token file path')
    if not config.get('url') and not config.get('tokenFile'):
        state = Path.home() / '.local/share/hypr-desktop'
        config = {'url': (state / 'local-url').read_text().strip().removesuffix('/mcp'), 'tokenFile': str(state / 'token')}
    endpoint = urlparse(config['url'])
    local = endpoint.scheme == 'http' and endpoint.hostname in ('127.0.0.1', 'localhost')
    if (not local and endpoint.scheme != 'https') or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise ValueError('Viewer requires local loopback HTTP or HTTPS without URL credentials')
    if not Path(config['tokenFile']).is_absolute():
        raise ValueError('Viewer tokenFile must be an absolute path')
    return config
def snapshot(discovery):
    config = connection()
    state = Path.home() / '.local/share/hypr-desktop'
    def remote():
        return request_snapshot(config['url'].rstrip('/') + '/hypr-desktop/viewer/agents/fleet', config['tokenFile'])
    def local():
        url = (state / 'local-url').read_text().strip().removesuffix('/mcp')
        endpoint = urlparse(url)
        if endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', 'localhost') or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError('Local desktop endpoint must use loopback HTTP')
        return request_snapshot(url + '/hypr-desktop/viewer/desktops', state / 'token')
    return discovery.read(remote, local, socket.gethostname().split('.')[0])


def running():
    from gi.repository import Gio, GLib
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    return bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', 'NameHasOwner',
                         GLib.Variant('(s)', ('org.omarchy.AgentDesktops',)),
                         None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]


def ready():
    from gi.repository import Gio, GLib
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        result = bus.call_sync('org.omarchy.AgentDesktops', '/org/omarchy/AgentDesktops',
                               'org.gtk.Actions', 'Describe',
                               GLib.Variant('(s)', ('viewer-ready',)),
                               None, Gio.DBusCallFlags.NONE, 1000, None)
        return result.unpack()[0][2] == [True]
    except GLib.Error:
        return False


def close_viewer():
    from gi.repository import Gio, GLib
    try:
        if not running():
            return
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync('org.omarchy.AgentDesktops', '/org/omarchy/AgentDesktops',
                      'org.gtk.Actions', 'Activate',
                      GLib.Variant('(sava{sv})', ('fleet-empty', [], {})),
                      None, Gio.DBusCallFlags.NO_AUTO_START, 2000, None)
    except GLib.Error as exc:
        raise OSError('Could not close the viewer; will retry') from exc


def await_ready(check=ready, sleep=time.sleep, attempts=20):
    for _ in range(attempts):
        if check():
            return
        sleep(0.5)
    raise OSError('Viewer did not finish starting; will retry')


class Launcher:
    def __init__(self):
        self.starting = False

    def __call__(self):
        from gi.repository import GLib
        try:
            exists = running()
        except GLib.Error as exc:
            raise OSError('Session bus unavailable') from exc
        if exists and not self.starting:
            subprocess.run([str(Path(__file__).with_name('agent-desktops')), '--auto-open'], check=True, timeout=5)
            return
        if not exists:
            if auto_open_target() is None:
                raise OSError('Waiting for an unfocused monitor without a fullscreen app')
            subprocess.run(['systemd-run', '--user', '--collect', '--quiet',
                            '--property=Type=exec', '--property=PartOf=graphical-session.target',
                            '--setenv=PATH=' + os.environ['PATH'],
                            str(Path(__file__).with_name('agent-desktops')), '--auto-open'],
                           check=True, timeout=5)
            self.starting = True
        await_ready()
        self.starting = False


def notify_desktop(desktop, seconds):
    subprocess.run(['notify-send', '--app-name=Agent Desktops', f'--expire-time={seconds * 1000}',
                    'Agent desktop ready',
                    f"Desktop {desktop['desktop']} on {desktop['host']} is ready. Open Agent Desktops to watch."],
                   check=True, timeout=5)


def main():
    watcher = Watcher(Launcher(), close_viewer, notify=notify_desktop)
    discovery = Discovery()
    error = None
    while True:
        try:
            watcher.update(snapshot(discovery))
            error = None
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
            message = str(exc)
            if message != error:
                print('Agent Desktops watcher: ' + message, flush=True)
            error = message
        time.sleep(3)


if __name__ == '__main__':
    main()
