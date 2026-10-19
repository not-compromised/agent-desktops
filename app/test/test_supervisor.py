"""Exercise the installed launcher with fixture commands, never a real compositor."""
import os
from pathlib import Path
import subprocess
import tempfile
import shutil
import unittest


class SupervisorTest(unittest.TestCase):
    def supervise(self, compositor_status):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = root / 'commands'
            commands.mkdir()
            package = root / 'package'
            (package / 'bin').mkdir(parents=True)
            (package / 'native').mkdir()
            launcher = package / 'bin/agent-desktop'
            shutil.copy2(Path(__file__).parents[2] / 'bin/agent-desktop', launcher)
            (package / 'native/accessibility.py').write_text('''import os,sys
from pathlib import Path
assert sys.argv[1] == '--enable'
assert os.environ.get('GSETTINGS_BACKEND') != 'memory'
Path(os.environ['FIXTURE_ROOT'], 'enabled').write_text(sys.argv[2])
''')
            runtime = root / 'run'
            (runtime / 'hypr').mkdir(parents=True)
            scripts = {
                'start-hyprland': '''#!/bin/bash
mkdir -p "$XDG_RUNTIME_DIR/agent-desktop/919191"
printf 'NEST_WAYLAND_DISPLAY=fixture-wayland\\nNEST_HYPRLAND_INSTANCE_SIGNATURE=fixture-hypr\\nNEST_DISPLAY=\\n' > "$XDG_RUNTIME_DIR/agent-desktop/919191/nest"
while [[ ! -f $XDG_RUNTIME_DIR/agent-desktop/919191/env ]]; do sleep .01; done
exit "$FIXTURE_STATUS"
''',
                'at-spi-bus-launcher': '''#!/bin/bash
printf '%s\\n' "$@" > "$FIXTURE_ROOT/launcher-args"
printf '%s' "${GSETTINGS_BACKEND:-}" > "$FIXTURE_ROOT/launcher-settings"
trap 'exit 0' TERM
while true; do sleep .1; done
''',
                'hyprctl': '#!/bin/bash\nexit 0\n',
                'jq': '#!/bin/bash\ncat >/dev/null\nexit 0\n',
                'systemctl': '#!/bin/bash\nexit 0\n',
            }
            for name, content in scripts.items():
                path = commands / name
                path.write_text(content)
                path.chmod(0o755)
            environment = {**os.environ, 'PATH': str(commands) + ':/usr/bin:/bin',
                           'XDG_RUNTIME_DIR': str(runtime),
                           'FIXTURE_STATUS': str(compositor_status),
                           'FIXTURE_ROOT': str(root),
                           'AGENT_DESKTOP_PRIVATE_BUS': '1',
                           'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/fixture-private-bus'}
            result = subprocess.run([str(launcher),
                                     '_supervise', '919191'], env=environment,
                                    capture_output=True, text=True, timeout=10)
            self.assertFalse((runtime / 'agent-desktop/919191/env').exists())
            self.assertFalse((runtime / 'hypr/agent-919191').exists())
            self.assertEqual((root / 'launcher-args').read_text(), '--launch-immediately\n')
            self.assertEqual((root / 'launcher-settings').read_text(), 'memory')
            self.assertTrue((root / 'enabled').exists())
            return result

    def test_compositor_crash_fails_the_unit_so_systemd_can_restart_it(self):
        result = self.supervise(23)
        self.assertEqual(result.returncode, 23, result.stderr)

    def test_intentional_compositor_exit_stays_successful(self):
        result = self.supervise(0)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
