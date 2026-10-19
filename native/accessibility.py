#!/usr/bin/python3
"""Read a bounded AT-SPI tree over an explicitly owned desktop bus."""
import json
import os
from pathlib import Path
import sys
import time
import shutil
import subprocess


ACCESSIBLE = 'org.a11y.atspi.Accessible'
REGISTRY = 'org.a11y.atspi.Registry'
ROOT = '/org/a11y/atspi/accessible/root'
DBUS = 'org.freedesktop.DBus'
DBUS_PATH = '/org/freedesktop/DBus'
A11Y_PATH = '/org/a11y/bus'


class Unavailable(Exception):
    pass


class Budget(Exception):
    pass


class NotOwned(Exception):
    pass


def dependency(name):
    executable = shutil.which(name)
    if executable:
        return executable
    for directory in ('/usr/lib', '/usr/libexec', '/usr/lib/at-spi2-core'):
        path = f'{directory}/{name}'
        if os.access(path, os.X_OK):
            return path
    raise Unavailable(f'Missing runtime dependency: {name}')


def process_identity(pid):
    try:
        root = Path('/proc') / str(pid)
        stat = (root / 'stat').read_text()
        start = stat.rsplit(')', 1)[1].split()[19]
        groups = (root / 'cgroup').read_text().splitlines()
    except (OSError, IndexError):
        raise Unavailable('process identity is unavailable') from None
    unified = [line[3:] for line in groups if line.startswith('0::')]
    if len(unified) != 1:
        raise Unavailable('cgroup v2 process identity is unavailable')
    return {'pid': pid, 'starttime': start, 'cgroup': unified[0]}


def within(group, expected):
    return group == expected or group.startswith(expected + '/')


def valid_group(group):
    return (isinstance(group, str) and group.startswith('/') and group != '/'
            and '\x00' not in group and all(part not in ('.', '..', '') for part in group[1:].split('/')))


class Bus:
    def __init__(self, address, deadline):
        from gi.repository import Gio, GLib
        if not isinstance(address, str) or not address.startswith('unix:') or ';' in address:
            raise Unavailable('private Unix bus address is unavailable')
        self.Gio, self.GLib, self.deadline = Gio, GLib, deadline
        self.connection = Gio.DBusConnection.new_for_address_sync(
            address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None)
        self.connection.set_exit_on_close(False)

    def call(self, name, path, interface, method, signature=None, args=None):
        remaining = int((self.deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            raise Budget('deadline')
        params = self.GLib.Variant(signature, args) if signature else None
        result = self.connection.call_sync(name, path, interface, method, params, None,
                                           self.Gio.DBusCallFlags.NONE, min(remaining, 250), None)
        return result.unpack()

    def peer(self, name):
        unique = name if name.startswith(':') else self.call(DBUS, DBUS_PATH, DBUS, 'GetNameOwner', '(s)', (name,))[0]
        uid = self.call(DBUS, DBUS_PATH, DBUS, 'GetConnectionUnixUser', '(s)', (unique,))[0]
        pid = self.call(DBUS, DBUS_PATH, DBUS, 'GetConnectionUnixProcessID', '(s)', (unique,))[0]
        return unique, pid, uid

    def property(self, name, path, prop):
        return self.call(name, path, 'org.freedesktop.DBus.Properties', 'Get', '(ss)', (ACCESSIBLE, prop))[0]

    def close(self):
        self.connection.close_sync(None)


def enable(pid, bus_factory=Bus, identity=process_identity, clock=time.monotonic, sleep=time.sleep, timeout_ms=4000):
    deadline = clock() + timeout_ms / 1000
    expected, own = identity(pid), identity(os.getpid())
    if expected['cgroup'] != own['cgroup']:
        raise Unavailable('accessibility launcher is outside the owned desktop')
    session = accessibility = None
    try:
        session = bus_factory(os.environ.get('DBUS_SESSION_BUS_ADDRESS'), deadline)
        _, daemon_pid, uid = session.peer(DBUS)
        if uid != os.getuid() or identity(daemon_pid)['cgroup'] != own['cgroup']:
            raise Unavailable('desktop session bus is not owned')
        while True:
            if clock() >= deadline or identity(pid) != expected:
                raise Unavailable('accessibility launcher did not become ready')
            try:
                name, owner_pid, uid = session.peer('org.a11y.Bus')
            except Budget:
                raise
            except Exception:
                sleep(min(.025, max(0, deadline - clock())))
                continue
            if owner_pid != pid or uid != os.getuid():
                raise Unavailable('accessibility bus owner is not the launched process')
            session.call(name, A11Y_PATH, 'org.freedesktop.DBus.Properties', 'Set',
                         '(ssv)', ('org.a11y.Status', 'IsEnabled', session.GLib.Variant('b', True)))
            enabled = session.call(name, A11Y_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                                   '(ss)', ('org.a11y.Status', 'IsEnabled'))[0]
            if enabled is not True:
                raise Unavailable('accessibility was not enabled')
            address = session.call(name, A11Y_PATH, 'org.a11y.Bus', 'GetAddress')[0]
            accessibility = bus_factory(address, deadline)
            _, bus_pid, uid = accessibility.peer(DBUS)
            if uid != os.getuid() or identity(bus_pid)['cgroup'] != own['cgroup'] or identity(pid) != expected:
                raise Unavailable('accessibility bus identity changed')
            return address
    finally:
        for bus in (accessibility, session):
            if bus:
                try:
                    bus.close()
                except Exception:
                    pass


def initialize(pid, start=subprocess.Popen, bus_factory=Bus, identity=process_identity, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + 4
    launcher = dependency('at-spi2-registryd')
    address = enable(pid, bus_factory, identity, clock, sleep)
    registry = start([launcher], env={**os.environ, 'AT_SPI_BUS_ADDRESS': address, 'GSETTINGS_BACKEND': 'memory'},
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    bus = None
    try:
        own, expected = identity(os.getpid()), identity(registry.pid)
        if own['cgroup'] != expected['cgroup']:
            raise Unavailable('accessibility registry is outside the owned desktop')
        bus = bus_factory(address, deadline)
        while True:
            if clock() >= deadline or registry.poll() is not None:
                raise Unavailable('accessibility registry did not become ready')
            try:
                name, owner_pid, uid = bus.peer(REGISTRY)
            except Budget:
                raise
            except Exception:
                sleep(min(.025, max(0, deadline - clock())))
                continue
            if owner_pid != registry.pid or uid != os.getuid() or identity(registry.pid) != expected:
                raise Unavailable('accessibility registry owner is not the launched process')
            bus.call(name, ROOT, ACCESSIBLE, 'GetRoleName')
            if identity(registry.pid) != expected:
                raise Unavailable('accessibility registry identity changed')
            # The desktop unit now owns this process through its cgroup. Its
            # control-group shutdown also owns registries after this helper exits.
            return registry.pid
    except BaseException:
        registry.terminate()
        try:
            registry.wait(timeout=.5)
        except subprocess.TimeoutExpired:
            registry.kill()
            registry.wait(timeout=.5)
        raise
    finally:
        if bus:
            try:
                bus.close()
            except Exception:
                pass


class Query:
    def __init__(self, request, bus_factory=Bus, identity=process_identity, clock=time.monotonic):
        self.request = request
        self.clock, self.identity, self.bus_factory = clock, identity, bus_factory
        self.deadline = clock() + request['timeout_ms'] / 1000
        self.nodes, self.identities, self.reasons = [], {}, set()
        self.visited = 0
        self.seen = set()
        self.max_nodes, self.max_depth = request['max_nodes'], request['max_depth']
        self.max_string, self.max_bytes = request['max_string'], request['max_bytes']
        self.allowed = []
        desktop = request['desktop_cgroup']
        if not valid_group(desktop):
            raise Unavailable('desktop cgroup identity is unavailable')
        self.desktop = desktop
        for app in request['apps']:
            unit, group = app.get('unit'), app.get('cgroup')
            if (not isinstance(unit, str) or not unit.endswith('.service') or '/' in unit
                    or not valid_group(group) or group.rsplit('/', 1)[-1] != unit):
                raise Unavailable('managed application identity is invalid')
            self.allowed.append(group)

    def check(self):
        if self.clock() >= self.deadline:
            raise Budget('deadline')

    def owner(self, bus, name, groups):
        self.check()
        unique, pid, uid = bus.peer(name)
        if uid != os.getuid():
            raise NotOwned('bus peer belongs to another user')
        first = self.identity(pid)
        if not any(within(first['cgroup'], group) for group in groups):
            raise NotOwned('bus peer is outside the owned desktop')
        if self.identity(pid) != first:
            raise Unavailable('bus peer process identity changed')
        key = id(bus), unique
        if key in self.identities and self.identities[key] != first:
            raise Unavailable('bus peer process identity changed')
        self.identities[key] = first
        return unique, first

    def still_owned(self, bus, name):
        known = self.identities[(id(bus), name)]
        if self.identity(known['pid']) != known:
            raise Unavailable('application process identity changed')

    def children(self, bus, name, path, limit):
        count = bus.property(name, path, 'ChildCount')
        if not isinstance(count, int) or count < 0:
            raise Unavailable('invalid accessible child count')
        if count > limit:
            self.reasons.add('node-limit')
        for index in range(min(count, limit)):
            self.check()
            yield bus.call(name, path, ACCESSIBLE, 'GetChildAtIndex', '(i)', (index,))[0]

    def details(self, bus, name, path):
        role = bus.call(name, path, ACCESSIBLE, 'GetRoleName')[0]
        if not isinstance(role, str):
            raise Unavailable('invalid accessible role')
        role = role[:self.max_string]
        # Never request text/value interfaces, or any name from password nodes.
        if role.lower().replace('_', ' ').replace('-', ' ') == 'password text':
            return {'role': 'password text', 'name': '[redacted]', 'protected': True}
        label = bus.property(name, path, 'Name')
        if not isinstance(label, str):
            raise Unavailable('invalid accessible name')
        result = {'role': role, 'name': label[:self.max_string]}
        if len(label) > self.max_string:
            self.reasons.add('string-limit')
        return result

    def window_matches(self, bus, name, path, details):
        window = self.request.get('window')
        if not window:
            return True
        if details['role'] not in ('frame', 'window', 'dialog'):
            return False
        if window.get('title') is not None and details['name'] != window['title']:
            return False
        wanted = window.get('bounds')
        if wanted:
            rect = bus.call(name, path, 'org.a11y.atspi.Component', 'GetExtents', '(u)', (0,))[0]
            x, y, w, h = rect
            # Decorations can shift bounds; matching must still be unique.
            if not (w > 0 and h > 0 and x < wanted['x'] + wanted['width'] and y < wanted['y'] + wanted['height']
                    and x + w > wanted['x'] and y + h > wanted['y']):
                return False
        return True

    def visit(self, bus, ref, parent, depth, window_scanning=False):
        self.check()
        if self.visited >= self.max_nodes:
            self.reasons.add('node-limit')
            return
        name, path = ref
        if not name or path == '/org/a11y/atspi/null':
            return
        name, identity = self.owner(bus, name, self.allowed)
        key = name, path
        if key in self.seen:
            return
        self.seen.add(key)
        self.visited += 1
        details = self.details(bus, name, path)
        self.still_owned(bus, name)
        node_id = str(self.visited)
        if window_scanning:
            return (name, path, details, identity)
        role, label = self.request.get('role'), self.request.get('name')
        if (not role or details['role'].casefold() == role.casefold()) and (not label or label.casefold() in details['name'].casefold()):
            node = {'id': node_id, 'parent': parent, 'depth': depth, **details}
            self.nodes.append(node)
            if len(json.dumps(self.nodes, ensure_ascii=True).encode()) > self.max_bytes - 1024:
                self.nodes.pop()
                raise Budget('output-limit')
        if details.get('protected'):
            return
        if depth >= self.max_depth:
            if bus.property(name, path, 'ChildCount'):
                self.reasons.add('depth-limit')
            return
        for child in self.children(bus, name, path, self.max_nodes - self.visited):
            try:
                self.visit(bus, child, node_id, depth + 1)
            except Budget:
                raise
            except Unavailable:
                raise
            except NotOwned:
                continue
            except Exception:
                self.reasons.add('provider-error')
        self.still_owned(bus, name)

    def run(self, address):
        session = accessibility = None
        try:
            session = self.bus_factory(address, self.deadline)
            self.owner(session, DBUS, [self.desktop])
            a11y_address = session.call('org.a11y.Bus', A11Y_PATH, 'org.a11y.Bus', 'GetAddress')[0]
            self.owner(session, 'org.a11y.Bus', [self.desktop])
            accessibility = self.bus_factory(a11y_address, self.deadline)
            self.owner(accessibility, DBUS, [self.desktop])
            # The registry may activate on the private accessibility bus only.
            accessibility.call(REGISTRY, ROOT, ACCESSIBLE, 'GetRoleName')
            registry, _ = self.owner(accessibility, REGISTRY, [self.desktop])
            found = False
            window_matches = []
            for ref in self.children(accessibility, registry, ROOT, 256):
                try:
                    peer, identity = self.owner(accessibility, ref[0], self.allowed)
                    wanted = self.request.get('window')
                    if wanted:
                        target_identity = self.identity(wanted['pid'])
                        if target_identity['cgroup'] != identity['cgroup']:
                            continue
                        for child in self.children(accessibility, peer, ref[1], self.max_nodes - self.visited):
                            item = self.visit(accessibility, child, None, 0, window_scanning=True)
                            if item and self.window_matches(accessibility, item[0], item[1], item[2]):
                                window_matches.append(child)
                    else:
                        found = True
                        self.visit(accessibility, ref, None, 0)
                except Budget:
                    raise
                except NotOwned:
                    continue
                except Unavailable:
                    raise
                except Exception:
                    self.reasons.add('provider-error')
            if self.request.get('window'):
                if len(window_matches) != 1:
                    return self.result('unavailable', 'accessible window match is absent or ambiguous')
                self.seen.clear()
                found = True
                self.visit(accessibility, window_matches[0], None, 0)
            if not found:
                return self.result('unavailable' if self.reasons else 'unsupported', 'no registered application exposes accessibility')
            # A process moving out of its registered cgroup invalidates its data.
            for identity in self.identities.values():
                if self.identity(identity['pid']) != identity:
                    raise Unavailable('process identity changed during accessibility query')
            return self.result('partial' if self.reasons else 'available')
        except Budget as error:
            self.reasons.add(str(error))
            try:
                for identity in self.identities.values():
                    if self.identity(identity['pid']) != identity:
                        return self.result('unavailable', 'process identity changed during accessibility query', discard=True)
            except Exception:
                return self.result('unavailable', 'process identity could not be revalidated', discard=True)
            return self.result('partial' if self.nodes else 'unavailable', str(error))
        except Exception:
            return self.result('unavailable', 'private accessibility session could not be verified', discard=True)
        finally:
            for bus in (accessibility, session):
                if bus:
                    try:
                        bus.close()
                    except Exception:
                        pass

    def result(self, status, reason=None, discard=False):
        result = {'status': status, 'nodes': [] if discard else self.nodes,
                  'truncated': bool(self.reasons), 'visited': self.visited}
        if reason:
            result['reason'] = reason
        if self.reasons:
            result['limits'] = sorted(self.reasons)
        return result


def main():
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise Unavailable('accessibility request is too large')
        request = json.loads(raw)
        for key, maximum in [('max_nodes', 500), ('max_depth', 16), ('timeout_ms', 10000),
                             ('max_bytes', 196608), ('max_string', 512)]:
            if type(request.get(key)) is not int or not (0 if key == 'max_depth' else 1) <= request[key] <= maximum:
                raise Unavailable('invalid accessibility request limit')
        if not isinstance(request.get('apps'), list) or not 1 <= len(request['apps']) <= 256:
            raise Unavailable('managed applications are unavailable')
        window = request.get('window')
        if window and (not isinstance(window, dict) or type(window.get('pid')) is not int or window['pid'] <= 0
                       or not (window.get('title') or window.get('bounds'))):
            raise Unavailable('window PID and title or bounds are required')
        result = Query(request).run(os.environ.get('DBUS_SESSION_BUS_ADDRESS'))
    except Exception:
        result = {'status': 'unavailable', 'reason': 'accessibility prerequisites are unavailable', 'nodes': [], 'truncated': False}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    if sys.argv[1:] == ['--check']:
        try:
            from gi.repository import Gio
            dependency('at-spi-bus-launcher')
            dependency('at-spi2-registryd')
        except Exception as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
    elif len(sys.argv) == 3 and sys.argv[1] == '--enable':
        def startup_timeout(*_):
            raise Budget('startup deadline')
        try:
            import signal
            signal.signal(signal.SIGALRM, startup_timeout)
            signal.signal(signal.SIGTERM, startup_timeout)
            signal.signal(signal.SIGINT, startup_timeout)
            signal.alarm(5)
            initialize(int(sys.argv[2]))
        except Exception as error:
            reason = str(error) if isinstance(error, (Unavailable, Budget)) else type(error).__name__
            print(f'Owned desktop accessibility did not become ready: {reason}', file=sys.stderr)
            sys.exit(1)
        finally:
            signal.alarm(0)
    else:
        main()
