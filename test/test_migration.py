import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import test_install
from test_install import SOURCE, installer


class MigrationTests(unittest.TestCase):
    setUp = test_install.InstallTests.setUp
    fake_run = test_install.InstallTests.fake_run
    def legacy(self):
        root = Path(self.tmp.name) / 'legacy'
        self.legacy_links = {
            self.home / '.local/bin/agent-desktop': root / 'scripts/common/agent-desktop',
            self.home / '.local/bin/agent-desktops': root / 'apps/agent-desktops/agent-desktops',
            self.home / '.config/systemd/user/agent-desktops-watch.service': root / 'apps/agent-desktops/agent-desktops-watch.service',
            self.home / '.local/share/applications/us.pmserver.AgentDesktops.desktop': root / 'apps/agent-desktops/agent-desktops.desktop',
        }
        for path, target in self.legacy_links.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('legacy source, do not overwrite')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
        entry = root / 'mcp/hypr-desktop/index.js'
        entry.parent.mkdir(parents=True)
        entry.touch()
        unit = self.home / '.config/systemd/user/hypr-desktop.service'
        unit.write_text(f'[Service]\nExecStart=/usr/bin/node "{entry}"\nRestart=on-failure\n')
        state = self.home / '.local/share/hypr-desktop'
        state.mkdir(parents=True)
        (state / 'token').write_text('existing-private-token\n')
        (state / 'url').write_text('https://desktop.example.com/hypr-desktop/mcp\n')
        (state / 'local-url').write_text('http://127.0.0.1:17873/mcp\n')
        (state / 'leases.json').write_text('{"preserved":true}')
        profile = self.home / '.local/share/agent-desktop/profiles/1/cookies'
        profile.parent.mkdir(parents=True)
        profile.write_text('saved login')
        self.legacy_unit = unit.read_bytes()
        return root

    def activate(self, root=None, backend='hyprland', fail=False, port=17873, **options):
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if fail and args == ('systemctl', '--user', 'enable', '--now', 'hypr-desktop.service'):
                raise subprocess.CalledProcessError(1, args)
            return self.fake_run(*args, **kwargs)
        def process(args, **kwargs):
            return subprocess.CompletedProcess(args, 1 if 'is-active' in args or 'is-enabled' in args else 0, '', '')
        with patch.object(installer, 'run', side_effect=run), patch.object(installer.subprocess, 'run', side_effect=process), patch.object(installer.shutil, 'which', return_value='/usr/bin/node'):
            installer.install(self.home, SOURCE, port, None, True, backend, root, **options)
        return calls

    def test_explicit_adoption_preserves_data_endpoints_and_old_source(self):
        root = self.legacy()
        self.activate(root)
        state = self.home / '.local/share/hypr-desktop'
        self.assertEqual((state / 'token').read_text(), 'existing-private-token\n')
        self.assertEqual((state / 'leases.json').read_text(), '{"preserved":true}')
        self.assertEqual((state / 'url').read_text(), 'https://desktop.example.com/hypr-desktop/mcp\n')
        self.assertEqual((self.home / '.local/share/agent-desktop/profiles/1/cookies').read_text(), 'saved login')
        for target in self.legacy_links.values():
            self.assertEqual(target.read_text(), 'legacy source, do not overwrite')
        self.assertFalse((self.home / '.local/share/applications/us.pmserver.AgentDesktops.desktop').exists())
        self.assertTrue((self.home / '.local/share/applications/org.omarchy.AgentDesktops.desktop').is_file())
        receipt = next(state.glob('legacy-installation-*.json'))
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.activate()
        self.assertEqual((state / 'url').read_text(), 'https://desktop.example.com/hypr-desktop/mcp\n')

    def test_failed_adoption_restores_every_original_link_and_service(self):
        root = self.legacy()
        with self.assertRaises(subprocess.CalledProcessError):
            self.activate(root, fail=True)
        self.assertEqual((self.home / '.config/systemd/user/hypr-desktop.service').read_bytes(), self.legacy_unit)
        for path, target in self.legacy_links.items():
            self.assertTrue(path.is_symlink(), path)
            self.assertEqual(path.readlink(), target)
        self.assertFalse((self.home / '.local/share/hypr-desktop/installation.json').exists())
        self.activate(root)

    def test_private_wrappers_and_skills_remain_owned_by_integration(self):
        root = self.legacy()
        skill = self.home / '.codex/skills/agent-desktop'
        skill.parent.mkdir(parents=True)
        skill.symlink_to(root / 'private-skill')
        self.activate(root, skip_skills=True, skip_command_links=True)
        for name in ('agent-desktop', 'agent-desktops'):
            path = self.home / '.local/bin' / name
            self.assertEqual(path.readlink(), self.legacy_links[path])
        self.assertEqual(skill.readlink(), root / 'private-skill')
        self.activate()
        installer.uninstall(self.home, start=False)
        self.assertTrue(skill.is_symlink())
        self.assertTrue((self.home / '.local/bin/agent-desktop').is_symlink())

    def test_adoption_refuses_foreign_unit_even_with_explicit_root(self):
        root = self.legacy()
        unit = self.home / '.config/systemd/user/hypr-desktop.service'
        unit.write_text(unit.read_text() + 'ExecStartPre=/private/hook\n')
        before = unit.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'Unrecognized legacy service'):
            self.activate(root)
        self.assertEqual(unit.read_bytes(), before)
        self.assertFalse((self.home / '.local/share/agent-desktop/package').exists())

    def test_xvfb_installs_without_graphical_configuration_or_viewer(self):
        self.config.unlink()
        calls = self.activate(backend='xvfb')
        self.assertFalse(any(args[0] in ('hyprctl', 'gdbus') for args in calls))
        unit = (self.home / '.config/systemd/user/hypr-desktop.service').read_text()
        self.assertIn('AGENT_DESKTOP_BACKEND=xvfb', unit)
        self.assertIn('WantedBy=default.target', unit)
        self.assertFalse((self.home / '.config/systemd/user/agent-desktops-watch.service').exists())
        self.assertFalse((self.home / '.local/bin/agent-desktops').exists())
        installer.uninstall(self.home, start=False)
        self.assertTrue((self.home / '.local/share/hypr-desktop/token').exists())

    def test_active_legacy_desktops_block_adoption_before_changes(self):
        root = self.legacy()
        def run(*args, **kwargs):
            if 'list-units' in args:
                self.assertIn('pm-agent-desktop-*.service', args)
                return subprocess.CompletedProcess(args, 0, 'pm-agent-desktop-2.service loaded active running\n', '')
            return self.fake_run(*args, **kwargs)
        with patch.object(installer, 'run', side_effect=run), patch.object(installer.shutil, 'which', return_value='/usr/bin/node'):
            with self.assertRaisesRegex(RuntimeError, 'Release active agent desktops'):
                installer.install(self.home, SOURCE, 17873, None, True, 'hyprland', root)
        self.assertEqual((self.home / '.config/systemd/user/hypr-desktop.service').read_bytes(), self.legacy_unit)

    def test_legacy_viewer_blocks_adoption_before_changes(self):
        root = self.legacy()
        def run(*args, **kwargs):
            if args[0] == 'gdbus' and args[-1] == 'us.pmserver.AgentDesktops':
                return subprocess.CompletedProcess(args, 0, '(true,)\n', '')
            return self.fake_run(*args, **kwargs)
        with patch.object(installer, 'run', side_effect=run), patch.object(installer.shutil, 'which', return_value='/usr/bin/node'):
            with self.assertRaisesRegex(RuntimeError, 'Close Agent Desktops'):
                installer.install(self.home, SOURCE, 17873, None, True, 'hyprland', root)
        self.assertEqual((self.home / '.config/systemd/user/hypr-desktop.service').read_bytes(), self.legacy_unit)

    def test_adoption_and_updates_preserve_service_environment_and_custom_port(self):
        root = self.legacy()
        unit = self.home / '.config/systemd/user/hypr-desktop.service'
        unit.write_text(unit.read_text() + 'Environment=HYPR_DESKTOP_HOSTS=desktop.example.com\nEnvironment=AGENT_DESKTOP_VIEWER_ORIGINS=https://desktop.example.com\nEnvironment=AGENT_DESKTOP_VNC_BASE=16000\n')
        self.activate(root, port=None)
        self.activate(port=None)
        text = unit.read_text()
        self.assertIn('HYPR_DESKTOP_HOSTS=desktop.example.com', text)
        self.assertIn('AGENT_DESKTOP_VIEWER_ORIGINS=https://desktop.example.com', text)
        self.assertIn('AGENT_DESKTOP_VNC_BASE=16000', text)
        self.assertIn('HYPR_DESKTOP_PORT=17873', text)
        self.assertEqual((self.home / '.local/share/hypr-desktop/local-url').read_text(), 'http://127.0.0.1:17873/mcp\n')

    def test_custom_legacy_state_is_refused_before_changing_the_installation(self):
        root = self.legacy()
        unit = self.home / '.config/systemd/user/hypr-desktop.service'
        unit.write_text(unit.read_text() + 'Environment=HYPR_DESKTOP_STATE=/other/private/state\n')
        before = unit.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'Custom legacy state'):
            self.activate(root)
        self.assertEqual(unit.read_bytes(), before)
        self.assertFalse((self.home / '.local/share/agent-desktop/package').exists())
