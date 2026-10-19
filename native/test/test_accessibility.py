import importlib.util
import os
from pathlib import Path
import unittest
from types import SimpleNamespace


SPEC = importlib.util.spec_from_file_location('accessibility', Path(__file__).parents[1] / 'accessibility.py')
a11y = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(a11y)
DESKTOP = '/user.slice/agent-desktop-1.service'
APP = '/user.slice/agent-desktop-1-app-exact.service'


class FakeBus:
    def __init__(self, address, fixture):
        self.address, self.fixture = address, fixture
        self.closed = False

    def peer(self, name):
        self.fixture.calls.append(('peer', self.address, name))
        pid = self.fixture.peers[self.address][name]
        return name, pid, os.getuid()

    def property(self, name, path, prop):
        self.fixture.calls.append(('property', name, path, prop))
        node = self.fixture.nodes[name, path]
        return len(node.get('children', [])) if prop == 'ChildCount' else node['name']

    def call(self, name, path, interface, method, signature=None, args=None):
        self.fixture.calls.append(('call', name, path, method))
        if method == 'GetAddress':
            return ('accessibility',)
        node = self.fixture.nodes[name, path]
        if method == 'GetRoleName':
            return (node['role'],)
        if method == 'GetChildAtIndex':
            return (node['children'][args[0]],)
        if method == 'GetExtents':
            return ((10, 10, 100, 100),)
        raise AssertionError(method)

    def close(self):
        self.closed = True


class Fixture:
    def __init__(self):
        self.calls, self.buses = [], []
        self.peers = {
            'session': {a11y.DBUS: 10, 'org.a11y.Bus': 11},
            'accessibility': {a11y.DBUS: 12, a11y.REGISTRY: 13, ':owned': 20, ':foreign': 30},
        }
        self.identities = {pid: {'pid': pid, 'starttime': str(pid * 100), 'cgroup': group}
                           for pid, group in [(10, DESKTOP), (11, DESKTOP), (12, DESKTOP), (13, DESKTOP),
                                              (20, APP), (30, APP + '-foreign')]}
        self.nodes = {
            (a11y.REGISTRY, a11y.ROOT): {'role': 'desktop frame', 'name': 'desktop',
                                       'children': [(':owned', '/root'), (':foreign', '/root')]},
            (':owned', '/root'): {'role': 'application', 'name': 'Editor', 'children': [(':owned', '/frame')]},
            (':owned', '/frame'): {'role': 'frame', 'name': 'Document',
                                  'children': [(':owned', '/save'), (':owned', '/password')]},
            (':owned', '/save'): {'role': 'push button', 'name': 'Save'},
            (':owned', '/password'): {'role': 'password text', 'name': 'secret', 'children': [(':owned', '/secret')]},
            (':owned', '/secret'): {'role': 'text', 'name': 'secret'},
        }

    def bus(self, address, deadline):
        bus = FakeBus(address, self)
        self.buses.append(bus)
        return bus

    def identity(self, pid):
        return dict(self.identities[pid])

    def query(self, **options):
        request = {'desktop_cgroup': DESKTOP, 'apps': [{'unit': APP.rsplit('/', 1)[1], 'cgroup': APP}],
                   'max_nodes': 100, 'max_depth': 8, 'max_string': 512, 'max_bytes': 196608,
                   'timeout_ms': 3000, **options}
        return a11y.Query(request, self.bus, self.identity).run('session')


class AccessibilityTests(unittest.TestCase):
    def test_startup_enables_only_the_launched_owner_and_reads_property_back(self):
        f = Fixture()
        f.identities[os.getpid()] = {'pid': os.getpid(), 'starttime': 'self', 'cgroup': DESKTOP}
        enabled = False
        calls = []

        def factory(address, deadline):
            bus = f.bus('session' if not f.buses else 'accessibility', deadline)
            bus.GLib = SimpleNamespace(Variant=lambda signature, value: value)
            original = bus.call

            def call(name, path, interface, method, signature=None, args=None):
                nonlocal enabled
                calls.append((name, path, method, args))
                if path == '/org/a11y/status':
                    if method == 'Set':
                        enabled = args == ('org.a11y.Status', 'IsEnabled', True)
                        return ()
                    return (enabled,)
                return original(name, path, interface, method, signature, args)

            bus.call = call
            return bus

        a11y.enable(11, factory, f.identity)
        self.assertTrue(enabled)
        self.assertTrue(any(call[2] == 'Get' for call in calls))
        self.assertTrue(all(bus.closed for bus in f.buses))

    def test_startup_refuses_host_bus_or_another_launcher_before_setting_property(self):
        for host_daemon, wrong_owner in [(True, False), (False, True)]:
            with self.subTest(host_daemon=host_daemon, wrong_owner=wrong_owner):
                f = Fixture()
                f.identities[os.getpid()] = {'pid': os.getpid(), 'starttime': 'self', 'cgroup': DESKTOP}
                if host_daemon:
                    f.identities[10]['cgroup'] = '/host.service'
                if wrong_owner:
                    f.peers['session']['org.a11y.Bus'] = 12
                with self.assertRaises(a11y.Unavailable):
                    a11y.enable(11, lambda _address, deadline: f.bus('session', deadline), f.identity)
                self.assertFalse(any(call[-1] == 'Set' for call in f.calls))

    def test_startup_wait_is_bounded_when_owner_does_not_appear(self):
        f = Fixture()
        f.identities[os.getpid()] = {'pid': os.getpid(), 'starttime': 'self', 'cgroup': DESKTOP}
        del f.peers['session']['org.a11y.Bus']
        elapsed = [0.0]
        with self.assertRaises(a11y.Unavailable):
            a11y.enable(11, lambda _address, deadline: f.bus('session', deadline), f.identity,
                        clock=lambda: elapsed[0], sleep=lambda delay: elapsed.__setitem__(0, elapsed[0] + delay), timeout_ms=100)
        self.assertGreaterEqual(elapsed[0], .1)
        self.assertTrue(all(bus.closed for bus in f.buses))

    def test_owned_tree_redacts_password_without_requesting_its_name_or_children(self):
        f = Fixture()
        result = f.query()
        self.assertEqual(result['status'], 'available', result)
        self.assertEqual([node['name'] for node in result['nodes']], ['Editor', 'Document', 'Save', '[redacted]'])
        self.assertNotIn(('property', ':owned', '/password', 'Name'), f.calls)
        self.assertNotIn(('property', ':owned', '/password', 'ChildCount'), f.calls)
        self.assertFalse(any(call[1:3] == (':foreign', '/root') for call in f.calls))
        self.assertTrue(all(bus.closed for bus in f.buses))

    def test_query_filters_bounded_owned_nodes(self):
        result = Fixture().query(role='PUSH BUTTON', name='sav')
        self.assertEqual([node['name'] for node in result['nodes']], ['Save'])

    def test_host_session_is_refused_before_accessibility_activation(self):
        f = Fixture()
        f.identities[10]['cgroup'] = '/user.slice/host.service'
        result = f.query()
        self.assertEqual(result['status'], 'unavailable')
        self.assertFalse(any(call[-1] == 'GetAddress' for call in f.calls))

    def test_host_accessibility_daemon_and_registry_are_refused(self):
        for pid in (11, 12, 13):
            with self.subTest(pid=pid):
                f = Fixture()
                f.identities[pid]['cgroup'] = '/user.slice/host.service'
                result = f.query()
                self.assertEqual(result['status'], 'unavailable')
                self.assertEqual(result['nodes'], [])

    def test_pid_reuse_during_read_discards_all_results(self):
        f = Fixture()
        original = f.identity
        reads = 0

        def changing(pid):
            nonlocal reads
            result = original(pid)
            if pid == 20:
                reads += 1
                if reads > 15:
                    result['starttime'] = 'replacement'
            return result

        f.identity = changing
        result = f.query()
        self.assertEqual(result['status'], 'unavailable', result)
        self.assertEqual(result['nodes'], [])

    def test_node_depth_string_and_byte_budgets_are_explicit(self):
        for options, reason in [({'max_nodes': 2}, 'node-limit'), ({'max_depth': 0}, 'depth-limit'), ({'max_depth': 1}, 'depth-limit'),
                                ({'max_string': 3}, 'string-limit'), ({'max_bytes': 1100}, 'output-limit')]:
            with self.subTest(options=options):
                result = Fixture().query(**options)
                self.assertIn(result['status'], ('partial', 'unavailable'))
                self.assertIn(reason, result['limits'])

    def test_unique_window_match_returns_only_its_tree(self):
        result = Fixture().query(window={'pid': 20, 'title': 'Document'})
        self.assertEqual(result['status'], 'available', result)
        self.assertEqual([node['name'] for node in result['nodes']], ['Document', 'Save', '[redacted]'])

    def test_ambiguous_or_missing_window_never_returns_full_application(self):
        for title in ('Absent', 'Document'):
            with self.subTest(title=title):
                f = Fixture()
                if title == 'Document':
                    f.nodes[':owned', '/root']['children'].append((':owned', '/second'))
                    f.nodes[':owned', '/second'] = {'role': 'frame', 'name': 'Document'}
                result = f.query(window={'pid': 20, 'title': title})
                self.assertEqual(result['status'], 'unavailable', result)
                self.assertEqual(result['nodes'], [])

    def test_process_identity_uses_kernel_starttime_and_cgroup(self):
        identity = a11y.process_identity(os.getpid())
        self.assertEqual(identity['pid'], os.getpid())
        self.assertTrue(identity['starttime'].isdigit())
        self.assertTrue(identity['cgroup'].startswith('/'))

    def test_registry_path_must_be_the_exact_recorded_unit(self):
        with self.assertRaises(a11y.Unavailable):
            Fixture().query(apps=[{'unit': 'different.service', 'cgroup': APP}])


if __name__ == '__main__':
    unittest.main()
