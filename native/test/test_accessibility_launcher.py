import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import tempfile
import shutil
import unittest


LAUNCHER = Path(__file__).resolve().parents[2] / 'bin/agent-desktop'


class AccessibilityLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agent-a11y-launcher-')
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name)
        self.socket = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.socket.close)
        self.socket.bind(str(self.runtime / 'wayland-agent-1'))
        self.metadata = self.runtime / 'agent-desktop/1/env'
        self.metadata.parent.mkdir(parents=True)
        self.metadata.write_text('DBUS_SESSION_BUS_ADDRESS=unix:path=/fixture-private-session\n')
        self.env = {**os.environ, 'XDG_RUNTIME_DIR': str(self.runtime),
                    'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/fixture-host-session',
                    'AT_SPI_BUS_ADDRESS': 'unix:path=/fixture-host-accessibility'}
        self.env.pop('AGENT_DESKTOP_PRIVATE_BUS', None)

    def test_command_receives_private_session_and_discards_host_accessibility_address(self):
        code = 'import os,json;print(json.dumps({k:os.environ.get(k) for k in ["DBUS_SESSION_BUS_ADDRESS","AT_SPI_BUS_ADDRESS"]}))'
        result = subprocess.run([str(LAUNCHER), 'run', '1', '--', '/usr/bin/python3', '-c', code],
                                env=self.env, capture_output=True, text=True, timeout=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/fixture-private-session',
                                                     'AT_SPI_BUS_ADDRESS': None})

    def test_env_output_clears_inherited_accessibility_address(self):
        result = subprocess.run([str(LAUNCHER), 'env', '1'], env=self.env,
                                capture_output=True, text=True, timeout=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('export DBUS_SESSION_BUS_ADDRESS=unix:path=/fixture-private-session', result.stdout)
        self.assertIn('unset AT_SPI_BUS_ADDRESS', result.stdout)
        self.assertNotIn('fixture-host', result.stdout)

    def test_internal_supervisor_refuses_host_bus_before_removing_metadata(self):
        before = self.metadata.read_text()
        result = subprocess.run([str(LAUNCHER), '_supervise', '1'], env=self.env,
                                capture_output=True, text=True, timeout=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('desktop private session bus is missing', result.stderr)
        self.assertEqual(self.metadata.read_text(), before)

    def test_supervisor_writes_raw_bus_and_reaps_accessibility_on_success_or_crash(self):
        for status in (0, 23):
            with self.subTest(status=status):
                root = self.runtime / str(status)
                commands = root / 'commands'
                commands.mkdir(parents=True)
                package = root / 'package'
                (package / 'bin').mkdir(parents=True)
                (package / 'native').mkdir()
                launcher = package / 'bin/agent-desktop'
                shutil.copy2(LAUNCHER, launcher)
                (package / 'native/accessibility.py').write_text('''import os,sys
from pathlib import Path
assert sys.argv[1] == '--enable'
assert os.environ.get('GSETTINGS_BACKEND') != 'memory'
Path(os.environ['FIXTURE_ROOT'], 'enabled').write_text(sys.argv[2])
''')
                runtime = root / 'runtime'
                (runtime / 'hypr').mkdir(parents=True)
                scripts = {
                    'start-hyprland': '''#!/bin/bash
mkdir -p "$XDG_RUNTIME_DIR/agent-desktop/919192"
printf 'NEST_WAYLAND_DISPLAY=fixture-wayland\\nNEST_HYPRLAND_INSTANCE_SIGNATURE=fixture-hypr\\nNEST_DISPLAY=\\n' > "$XDG_RUNTIME_DIR/agent-desktop/919192/nest"
while [[ ! -f $FIXTURE_ROOT/launcher.pid || ! -f $XDG_RUNTIME_DIR/agent-desktop/919192/env ]]; do sleep .01; done
cp "$XDG_RUNTIME_DIR/agent-desktop/919192/env" "$FIXTURE_ROOT/written-env"
exit "$FIXTURE_STATUS"
''',
                    'at-spi-bus-launcher': '''#!/bin/bash
[[ $# == 1 && $1 == --launch-immediately && $GSETTINGS_BACKEND == memory ]] || exit 64
trap 'exit 0' TERM
echo "$$" > "$FIXTURE_ROOT/launcher.pid"
while true; do sleep .02; done
''',
                    'hyprctl': '#!/bin/bash\nexit 0\n',
                    'jq': '#!/bin/bash\ncat >/dev/null\nexit 0\n',
                    'systemctl': '#!/bin/bash\nexit 0\n',
                }
                for name, contents in scripts.items():
                    command = commands / name
                    command.write_text(contents)
                    command.chmod(0o755)
                bus = 'unix:path=/fixture/private-bus,guid=0123456789abcdef'
                env = {**self.env, 'PATH': f'{commands}:/usr/bin:/bin', 'XDG_RUNTIME_DIR': str(runtime),
                       'FIXTURE_ROOT': str(root), 'FIXTURE_STATUS': str(status),
                       'AGENT_DESKTOP_PRIVATE_BUS': '1', 'DBUS_SESSION_BUS_ADDRESS': bus}
                process = subprocess.Popen([str(launcher), '_supervise', '919192'], env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                           start_new_session=True)
                try:
                    stdout, stderr = process.communicate(timeout=3)
                finally:
                    if process.poll() is None:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.communicate()
                self.assertEqual(process.returncode, status, stderr)
                self.assertIn(f'DBUS_SESSION_BUS_ADDRESS={bus}\n', (root / 'written-env').read_text())
                self.assertNotIn('\\,', (root / 'written-env').read_text())
                self.assertTrue((root / 'enabled').exists())
                with self.assertRaises(ProcessLookupError):
                    os.kill(int((root / 'launcher.pid').read_text()), 0)

    def test_supervisor_rejects_shell_metacharacters_before_mutating_runtime(self):
        before = self.metadata.read_text()
        result = subprocess.run([str(LAUNCHER), '_supervise', '1'], env={**self.env,
                                'AGENT_DESKTOP_PRIVATE_BUS': '1', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/bus;echo bad'},
                                capture_output=True, text=True, timeout=2)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bus address is invalid', result.stderr)
        self.assertEqual(self.metadata.read_text(), before)

    def test_stalled_accessibility_enable_is_killed_and_startup_cleans_up(self):
        root = self.runtime / 'stalled'
        commands = root / 'commands'
        commands.mkdir(parents=True)
        package = root / 'package'
        (package / 'bin').mkdir(parents=True)
        (package / 'native').mkdir()
        launcher = package / 'bin/agent-desktop'
        shutil.copy2(LAUNCHER, launcher)
        (package / 'native/accessibility.py').write_text('''import os,signal,time
from pathlib import Path
signal.signal(signal.SIGALRM, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(os.environ['FIXTURE_ROOT'], 'enable.pid').write_text(str(os.getpid()))
while True: time.sleep(60)
''')
        runtime = root / 'runtime'
        (runtime / 'hypr').mkdir(parents=True)
        scripts = {
            'start-hyprland': '''#!/bin/bash
mkdir -p "$XDG_RUNTIME_DIR/agent-desktop/919193"
metadata="$XDG_RUNTIME_DIR/agent-desktop/919193/nest"
printf 'NEST_WAYLAND_DISPLAY=fixture-wayland\\nNEST_HYPRLAND_INSTANCE_SIGNATURE=fixture-hypr\\nNEST_DISPLAY=\\n' > "$metadata"
while [[ -f $metadata ]]; do sleep .02; done
''',
            'at-spi-bus-launcher': '''#!/bin/bash
trap 'exit 0' TERM
echo "$$" > "$FIXTURE_ROOT/launcher.pid"
while true; do sleep .02; done
''',
            'hyprctl': '#!/bin/bash\nexit 0\n',
            'jq': '#!/bin/bash\ncat >/dev/null\nexit 0\n',
            'systemctl': '#!/bin/bash\nexit 0\n',
        }
        for name, contents in scripts.items():
            command = commands / name
            command.write_text(contents)
            command.chmod(0o755)
        env = {**self.env, 'PATH': f'{commands}:/usr/bin:/bin', 'XDG_RUNTIME_DIR': str(runtime),
               'FIXTURE_ROOT': str(root), 'AGENT_DESKTOP_PRIVATE_BUS': '1',
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/fixture/private-bus'}
        process = subprocess.Popen([str(launcher), '_supervise', '919193'], env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                   start_new_session=True)
        try:
            _, stderr = process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            self.fail('stalled accessibility enable exceeded the hard startup deadline')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        self.assertNotEqual(process.returncode, 0, stderr)
        self.assertFalse((runtime / 'agent-desktop/919193/env').exists())
        self.assertFalse((runtime / 'agent-desktop/919193/nest').exists())
        for name in ('enable.pid', 'launcher.pid'):
            self.assertTrue((root / name).exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int((root / name).read_text()), 0)


if __name__ == '__main__':
    unittest.main()
