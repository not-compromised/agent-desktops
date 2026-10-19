import ast
from pathlib import Path
import shutil
import subprocess
import unittest


class PrivateBusTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('dbus-run-session') and shutil.which('gdbus'), 'D-Bus command tools unavailable')
    def test_owned_bus_cannot_activate_host_session_services(self):
        config = Path(__file__).parents[2] / 'config/session-bus.conf'
        result = subprocess.run(['dbus-run-session', '--config-file=' + str(config), '--',
                                 'gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus',
                                 '--object-path', '/org/freedesktop/DBus', '--method',
                                 'org.freedesktop.DBus.ListActivatableNames'],
                                capture_output=True, text=True, check=True, timeout=5)
        names = ast.literal_eval(result.stdout)[0]
        self.assertEqual(names, ['org.freedesktop.DBus'])
