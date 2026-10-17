from pathlib import Path
import runpy
import tempfile
import unittest

module = runpy.run_path(str(Path(__file__).parents[1] / 'theme.py'))


class ThemeTest(unittest.TestCase):
    def test_omarchy_palette_and_semantic_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'colors.toml'
            path.write_text('background = "#fafafa"\nforeground = "#111111"\naccent = "#0088ff"\nlighter_background = "#eeeeee"\nselection = "#cccccc"\n')
            colors = module['palette'](path)
            self.assertEqual(colors['background'], '#fafafa')
            self.assertEqual(colors['surface'], '#eeeeee')
            self.assertEqual(colors['border'], '#cccccc')

    def test_missing_malformed_and_injected_values_use_safe_fallbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'colors.toml'
            self.assertEqual(module['palette'](path), module['DEFAULTS'])
            path.write_text('invalid toml')
            self.assertEqual(module['palette'](path), module['DEFAULTS'])
            path.write_text('accent = "red; background: url(https://bad.example)"')
            self.assertEqual(module['palette'](path), module['DEFAULTS'])

    def test_switching_theme_updates_the_stylesheet_once_without_navigation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'colors.toml'
            watch = module['ThemeWatch'].__new__(module['ThemeWatch'])
            updates = []
            watch.apply, watch.path, watch.current = updates.append, path, None
            watch.poll(); watch.poll()
            self.assertEqual(len(updates), 1)
            path.write_text('accent = "#123456"')
            watch.poll()
            self.assertEqual(len(updates), 2)
            self.assertEqual(updates[-1]['accent'], '#123456')


if __name__ == '__main__':
    unittest.main()
