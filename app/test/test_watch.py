from pathlib import Path
import runpy
import unittest
from unittest.mock import Mock, patch

module = runpy.run_path(str(Path(__file__).parents[1] / 'watch.py'))
Watcher = module['Watcher']


def fleet(count=0, online=True, ready=True):
    return {'hosts': [{'id': 'remote', 'online': online}, {'id': 'local', 'online': True}],
            'desktops': [{'host': 'remote', 'ready': ready} for _ in range(count)]}


class WatchTest(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        home = patch.object(Path, 'home', return_value=Path(self.directory.name))
        home.start()
        self.addCleanup(home.stop)

    def test_first_desktop_opens_once_until_the_batch_ends(self):
        launches = []
        watcher = Watcher(lambda: launches.append(True))
        watcher.update(fleet())
        self.assertEqual(launches, [])
        watcher.update(fleet(1, ready=False))
        self.assertEqual(launches, [])
        watcher.update(fleet(1))
        watcher.update(fleet(8))
        # Closing the app does not alter the active fleet episode.
        watcher.update(fleet(2))
        self.assertEqual(len(launches), 1)
        watcher.update(fleet())
        watcher.update(fleet(1))
        self.assertEqual(len(launches), 2)

    def test_offline_hosts_retain_previously_active_desktops(self):
        launches = []
        watcher = Watcher(lambda: launches.append(True))
        watcher.update(fleet(1))
        watcher.update(fleet(0, online=False))
        watcher.update(fleet(1))
        self.assertEqual(len(launches), 1)
        watcher.update(fleet())
        watcher.update(fleet(1))
        self.assertEqual(len(launches), 2)

    def test_an_unused_sleeping_host_does_not_block_rearming(self):
        launches = []
        watcher = Watcher(lambda: launches.append(True))
        data = fleet(0, online=False)
        watcher.update(data)
        data['desktops'] = [{'host': 'local', 'ready': True}]
        watcher.update(data)
        data['desktops'] = []
        watcher.update(data)
        data['desktops'] = [{'host': 'local', 'ready': True}]
        watcher.update(data)
        self.assertEqual(len(launches), 2)

    def test_a_failed_launch_can_retry(self):
        def fail(): raise OSError('launch unavailable')
        watcher = Watcher(fail)
        with self.assertRaises(OSError): watcher.update(fleet(1))
        launches = []
        watcher.launch = lambda: launches.append(True)
        watcher.update(fleet(1))
        self.assertEqual(launches, [True])

    def test_child_startup_failure_does_not_consume_the_batch(self):
        watcher = Watcher(lambda: module['await_ready'](check=lambda: False, sleep=lambda _: None, attempts=2))
        with self.assertRaises(OSError): watcher.update(fleet(1))
        self.assertFalse(watcher.active)
        watcher.launch = lambda: module['await_ready'](check=lambda: True)
        watcher.update(fleet(1))
        self.assertTrue(watcher.active)

    def test_a_registered_but_unready_launch_is_not_treated_as_an_existing_viewer(self):
        launcher = module['Launcher']()
        watcher = Watcher(launcher)
        start = Mock()
        readiness = Mock(side_effect=[OSError('not ready'), OSError('still not ready'), None])
        with patch.dict(launcher.__call__.__func__.__globals__, {
                'running': Mock(side_effect=[False, True, True]),
                'subprocess': Mock(run=start), 'await_ready': readiness, 'auto_open_target': lambda: 2}):
            for _ in range(2):
                with self.assertRaises(OSError): watcher.update(fleet(1))
                self.assertFalse(watcher.active)
            watcher.update(fleet(1))
        self.assertEqual(start.call_count, 1)
        self.assertTrue(watcher.active)
        self.assertFalse(launcher.starting)

    def test_next_batch_forwards_auto_open_to_a_registered_hidden_app(self):
        launcher = module['Launcher']()
        command = Mock()
        with patch.dict(launcher.__call__.__func__.__globals__, {
                'running': lambda: True, 'subprocess': Mock(run=command),
                'await_ready': lambda: None}):
            launcher()
        self.assertEqual(command.call_count, 1)
        self.assertIn('--auto-open', command.call_args.args[0])

    def test_settings_changes_take_effect_without_restarting(self):
        import tempfile
        import json
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            launches = []
            watcher = Watcher(lambda: launches.append(True), settings=path)
            path.write_text(json.dumps({'autoOpen': False}))
            watcher.update(fleet(1))
            self.assertEqual(launches, [])
            path.write_text(json.dumps({'autoOpen': True}))
            watcher.update(fleet(1))
            self.assertEqual(launches, [True])
            watcher.update(fleet(2))
            self.assertEqual(launches, [True])

    def test_malformed_settings_do_not_open_or_consume_the_batch(self):
        settings = Path(self.directory.name) / 'settings.json'
        launches = []
        watcher = Watcher(lambda: launches.append(True), settings=settings)
        for invalid in ('{', '{"autoOpen": "false"}', '[]'):
            settings.write_text(invalid)
            with self.assertRaises(ValueError):
                watcher.update(fleet(1))
            self.assertFalse(watcher.active)
        settings.write_text('{"autoOpen": true}')
        watcher.update(fleet(1))
        self.assertEqual(launches, [True])

    def test_disabling_then_enabling_does_not_refocus_a_dismissed_active_batch(self):
        settings = Path(self.directory.name) / 'settings.json'
        launches = []
        watcher = Watcher(lambda: launches.append(True), settings=settings)
        watcher.update(fleet(1))
        settings.write_text('{"autoOpen": false}')
        watcher.update(fleet(2))
        settings.write_text('{"autoOpen": true}')
        watcher.update(fleet(2))
        self.assertEqual(launches, [True])
        watcher.update(fleet())
        watcher.update(fleet(1))
        self.assertEqual(launches, [True, True])

    def test_switching_fleets_forgets_hosts_no_longer_configured(self):
        launches = []
        watcher = Watcher(lambda: launches.append(True))
        watcher.update(fleet(1))
        watcher.update({'hosts': [{'id': 'local', 'online': True}], 'desktops': []})
        watcher.update({'hosts': [{'id': 'local', 'online': True}],
                        'desktops': [{'host': 'local', 'ready': True}]})
        self.assertEqual(launches, [True, True])

    def test_invalid_snapshot_cannot_rearm(self):
        watcher = Watcher(lambda: None)
        watcher.update(fleet(1))
        with self.assertRaises(ValueError): watcher.update({'desktops': [], 'hosts': []})
        self.assertTrue(watcher.active)


class LocalConfigurationTest(unittest.TestCase):
    def test_unified_fleet_settings_override_legacy_and_can_reset_to_local(self):
        import io
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / '.config/agent-desktops'
            config.mkdir(parents=True)
            state = home / '.local/share/hypr-desktop'
            state.mkdir(parents=True)
            (state / 'local-url').write_text('http://127.0.0.1:17873/mcp')
            (state / 'token').write_text('local-fixture-token')
            remote_token = home / 'remote-token'
            remote_token.write_text('remote-fixture-token')
            (config / 'fleet.json').write_text(json.dumps({'url': 'https://old.example.test', 'tokenFile': str(remote_token)}))
            cases = [
                ({'autoOpen': False}, 'https://old.example.test', 'remote-fixture-token'),
                ({'fleet': {'url': 'https://new.example.test', 'tokenFile': str(remote_token)}}, 'https://new.example.test', 'remote-fixture-token'),
                ({'fleet': {'url': '', 'tokenFile': ''}}, 'http://127.0.0.1:17873', 'local-fixture-token'),
            ]
            for settings, expected_url, expected_token in cases:
                with self.subTest(settings=settings):
                    (config / 'settings.json').write_text(json.dumps(settings))
                    opener = Mock()
                    opener.open.return_value = io.StringIO(json.dumps(fleet()))
                    with patch.object(Path, 'home', return_value=home), patch.dict(module['snapshot'].__globals__, {'build_opener': Mock(return_value=opener)}):
                        module['request_snapshot'](module['connection']()['url'].rstrip('/') + '/hypr-desktop/viewer/agents/fleet', module['connection']()['tokenFile'])
                    request = opener.open.call_args.args[0]
                    self.assertEqual(request.full_url, expected_url + '/hypr-desktop/viewer/agents/fleet')
                    self.assertEqual(request.get_header('Authorization'), 'Bearer ' + expected_token)

    def test_default_endpoint_and_custom_port_need_no_fleet_or_t3_configuration(self):
        import io
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / '.local/share/hypr-desktop'
            state.mkdir(parents=True)
            (state / 'local-url').write_text('http://127.0.0.1:17873/mcp\n')
            (state / 'token').write_text('fixture-token\n')
            opener = Mock()
            opener.open.return_value = io.StringIO(json.dumps(fleet()))
            with patch.object(Path, 'home', return_value=home), patch.dict(module['snapshot'].__globals__, {'build_opener': Mock(return_value=opener)}):
                self.assertEqual(module['request_snapshot'](module['connection']()['url'].rstrip('/') + '/hypr-desktop/viewer/agents/fleet', module['connection']()['tokenFile']), fleet())
            request = opener.open.call_args.args[0]
            self.assertEqual(request.full_url, 'http://127.0.0.1:17873/hypr-desktop/viewer/agents/fleet')
            self.assertEqual(request.get_header('Authorization'), 'Bearer fixture-token')


if __name__ == '__main__':
    unittest.main()
