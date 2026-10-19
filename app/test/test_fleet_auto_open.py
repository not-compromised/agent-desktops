import json
from pathlib import Path
import runpy
import subprocess
import unittest
from unittest.mock import Mock, patch

module = runpy.run_path(str(Path(__file__).parents[1] / 'watch.py'))


def monitor(identity, focused=False):
    return {'id': identity, 'focused': focused, 'activeWorkspace': {'id': identity + 1},
            'specialWorkspace': {'id': 0}}


class AutoOpenTest(unittest.TestCase):
    def target(self, monitors, windows=()):
        with patch.object(subprocess, 'check_output', side_effect=[json.dumps(monitors), json.dumps(windows)]):
            return module['auto_open_target']()

    def test_uses_an_unfocused_monitor_even_when_the_focused_one_is_fullscreen(self):
        self.assertEqual(self.target([monitor(0, True), monitor(1)],
            [{'monitor': 0, 'mapped': True, 'fullscreen': 2}]), 2)

    def test_skips_fullscreen_on_other_monitors(self):
        self.assertEqual(self.target([monitor(0, True), monitor(1), monitor(2)],
            [{'monitor': 1, 'mapped': True, 'fullscreen': 2}]), 3)
        self.assertIsNone(self.target([monitor(0, True), monitor(1)],
            [{'monitor': 1, 'mapped': True, 'fullscreen': 0, 'fullscreenClient': 2}]))

    def test_single_monitor_and_no_available_monitor_defer(self):
        self.assertIsNone(self.target([monitor(0, True)]))
        other = monitor(1)
        other['specialWorkspace']['id'] = -98
        self.assertIsNone(self.target([monitor(0, True), other]))
        other['specialWorkspace']['id'] = 0
        other['dpmsStatus'] = False
        self.assertIsNone(self.target([monitor(0, True), other]))

    def test_unknown_focus_or_compositor_failure_cannot_launch(self):
        for monitors in [[], [monitor(0)], [monitor(0, True), monitor(1, True)]]:
            with self.assertRaises(OSError): self.target(monitors)
        for result in ['not json', '{}', '[{}]']:
            with patch.object(subprocess, 'check_output', return_value=result):
                with self.assertRaises(OSError): module['auto_open_target']()
        with patch.object(subprocess, 'check_output', side_effect=FileNotFoundError):
            with self.assertRaises(OSError): module['auto_open_target']()

    def test_launch_retries_after_a_suitable_monitor_becomes_available(self):
        launcher = module['Launcher']()
        start = Mock()
        with patch.dict(launcher.__call__.__func__.__globals__, {
                'running': lambda: False, 'await_ready': lambda: None}), \
                patch.object(subprocess, 'run', start), \
                patch.object(subprocess, 'check_output', side_effect=[
                    json.dumps([monitor(0, True)]), '[]',
                    json.dumps([monitor(0, True), monitor(1)]), '[]']):
            watcher = module['Watcher'](launcher, lambda: None)
            fleet = {'hosts': [{'id': 'remote', 'online': True}],
                     'desktops': [{'host': 'remote', 'ready': True}]}
            with self.assertRaises(OSError): watcher.update(fleet)
            self.assertFalse(watcher.active)
            start.assert_not_called()
            watcher.update(fleet)
            self.assertTrue(watcher.active)
            start.assert_called_once()

    def test_placement_is_confirmed_before_mapping(self):
        with patch.object(subprocess, 'check_output', side_effect=[
                json.dumps([monitor(0, True), monitor(1)]), '[]', 'ready\n']) as query:
            self.assertTrue(module['prepare_auto_open']('Agent Desktops auto 123'))
            rule = query.call_args.args[0][2]
            self.assertIn('workspace = "2 silent"', rule)
            self.assertIn('no_initial_focus = true', rule)
        with patch.object(subprocess, 'check_output', side_effect=[
                json.dumps([monitor(0, True), monitor(1)]), '[]', 'error']):
            with self.assertRaises(OSError): module['prepare_auto_open']('Agent Desktops auto 123')


if __name__ == '__main__': unittest.main()
