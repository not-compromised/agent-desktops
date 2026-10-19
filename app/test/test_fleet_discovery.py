from pathlib import Path
import runpy
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).parents[1]
watch = runpy.run_path(str(ROOT/'watch.py'))


class DurabilityTest(unittest.TestCase):
    def test_local_launches_during_outage_and_empty_local_can_rearm(self):
        discovery = watch['Discovery']()
        launches = []
        watcher = watch['Watcher'](lambda: launches.append(True), lambda: None)
        def outage(): raise OSError('fleet down')
        rows = [{'desktop': 1, 'held': True, 'ready': True}]
        try:
            for count in [1, 1, 0, 1]:
                rows = rows[:count] if count == 0 else [{'desktop': 1, 'held': True, 'ready': True}]
                watcher.update(discovery.read(outage, lambda: {'desktops': rows}, 'desktop-a'))
            self.assertEqual(len(launches), 2)
        finally: discovery.close()

    def test_local_empty_overrides_stale_fleet_and_offline_remote_stays_known(self):
        discovery = watch['Discovery']()
        remote = {'hosts': [{'id': 'desktop-a', 'online': False}, {'id': 'desktop-b', 'online': True}],
                  'desktops': [{'host': 'desktop-a', 'ready': True}]}
        try:
            data = discovery.read(lambda: remote, lambda: {'desktops': []}, 'desktop-a')
            self.assertEqual(data['desktops'], [])
            self.assertIn({'id': 'desktop-a', 'online': True}, data['hosts'])
            def outage(): raise OSError('down')
            data = discovery.read(outage, lambda: {'desktops': []}, 'desktop-a')
            self.assertIn({'id': 'desktop-b', 'online': False}, data['hosts'])
        finally: discovery.close()

    def test_malformed_fleet_cannot_hide_a_healthy_local_desktop(self):
        discovery = watch['Discovery']()
        try:
            for value in [None, [], {'hosts': [None], 'desktops': []}]:
                result = discovery.read(lambda: value, lambda: {'desktops': [{'held': True, 'ready': True}]}, 'desktop-a')
                self.assertEqual(result['desktops'][0]['host'], 'desktop-a')
        finally: discovery.close()
