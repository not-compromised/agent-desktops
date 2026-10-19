import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest


BIN = Path(__file__).resolve().parents[1] / 'bin'


class NativeEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='agent-native-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.socket = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.socket.close)
        self.socket.bind(str(self.root / 'wayland-42'))
        (self.root / 'wayland-agent-7').symlink_to('wayland-42')
        self.metadata = self.root / 'agent-desktop/7/nest'
        self.metadata.parent.mkdir(parents=True)
        self.metadata.write_text('NEST_WAYLAND_DISPLAY=wayland-42\n')
        instance = self.root / 'hypr/test-instance'
        instance.mkdir(parents=True)
        (instance.parent / 'agent-7').symlink_to('test-instance')
        self.env = {**os.environ, 'AGENT_DESKTOP': '7',
                    'XDG_RUNTIME_DIR': str(self.root), 'WAYLAND_DISPLAY': 'wayland-agent-7',
                    'AGENT_DESKTOP_INSTANCE': 'test-instance'}
        self.env.pop('WAYLAND_SOCKET', None)

    def result(self, helper, **env):
        return subprocess.run([str(BIN / f'agent-desktop-{helper}')],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=2)

    def assert_refused(self, **env):
        for helper in ('keyboard', 'pointer', 'still'):
            with self.subTest(helper=helper, env=env):
                result = self.result(helper, **env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('refusing non-agent Wayland endpoint', result.stderr)

    def test_valid_owned_endpoint_reaches_argument_validation_without_connecting(self):
        for helper in ('keyboard', 'pointer', 'still'):
            with self.subTest(helper=helper):
                result = self.result(helper)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('usage:', result.stderr)
                self.assertNotIn('refusing', result.stderr)

    def test_read_execute_runtime_permissions_reach_argument_validation(self):
        self.root.chmod(0o750)
        for helper in ('keyboard', 'pointer', 'still'):
            with self.subTest(helper=helper):
                result = self.result(helper)
                self.assertIn('usage:', result.stderr)
                self.assertNotIn('refusing', result.stderr)

    def test_group_writable_or_world_accessible_runtime_is_refused(self):
        for mode in (0o770, 0o755):
            with self.subTest(mode=oct(mode)):
                self.root.chmod(mode)
                self.assert_refused()

    def test_host_alias_mismatched_slot_and_inherited_connection_are_refused(self):
        self.assert_refused(WAYLAND_DISPLAY='wayland-42')
        self.assert_refused(AGENT_DESKTOP='8')
        self.assert_refused(AGENT_DESKTOP='7/../8')
        self.assert_refused(WAYLAND_SOCKET='0')
        self.assert_refused(WAYLAND_SOCKET='')

    def test_socket_alias_outside_runtime_is_refused(self):
        with tempfile.TemporaryDirectory(prefix='agent-other-') as other:
            sock = socket.socket(socket.AF_UNIX)
            self.addCleanup(sock.close)
            path = Path(other) / 'wayland-42'
            sock.bind(str(path))
            alias = self.root / 'wayland-agent-7'
            alias.unlink()
            alias.symlink_to(path)
            self.assert_refused()

    def test_absent_socket_regular_file_and_stale_launcher_metadata_are_refused(self):
        self.metadata.write_text('NEST_WAYLAND_DISPLAY=wayland-99\n')
        self.assert_refused()
        self.metadata.unlink()
        self.assert_refused()
        self.metadata.write_text('NEST_WAYLAND_DISPLAY=wayland-42\n')
        (self.root / 'wayland-42').unlink()
        self.assert_refused()
        (self.root / 'wayland-42').write_text('not a socket')
        self.assert_refused()

    def test_wrong_generation_or_public_runtime_is_refused(self):
        self.assert_refused(AGENT_DESKTOP_INSTANCE='old-instance')
        self.assert_refused(AGENT_DESKTOP_INSTANCE='')
        instance = self.env.pop('AGENT_DESKTOP_INSTANCE')
        self.assert_refused()
        self.env['AGENT_DESKTOP_INSTANCE'] = instance
        self.root.chmod(0o755)
        self.assert_refused()

    def test_group_writable_socket_or_metadata_is_refused(self):
        (self.root / 'wayland-42').chmod(0o770)
        self.assert_refused()
        (self.root / 'wayland-42').chmod(0o700)
        self.metadata.chmod(0o666)
        self.assert_refused()

    def test_persistent_input_modes_are_rejected_before_any_connection(self):
        for helper, args in (('keyboard', ['down:super']), ('keyboard', ['--hold']),
                             ('pointer', ['--hold']), ('pointer', ['pause'])):
            with self.subTest(helper=helper, args=args):
                result = subprocess.run([str(BIN / f'agent-desktop-{helper}'), *args],
                                        env=self.env, capture_output=True, text=True, timeout=2)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('cannot connect', result.stderr)


if __name__ == '__main__':
    unittest.main()
