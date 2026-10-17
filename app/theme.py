"""Optional Omarchy palette integration; no dependency on desktop helper tooling."""
from pathlib import Path
import re
import tomllib


DEFAULTS = {
    'background': '#10131a', 'foreground': '#dce3ed', 'accent': '#86b7ff',
    'muted': '#8a95a6', 'surface': '#1b2230', 'border': '#354156',
    'red': '#ff8895', 'green': '#8bd5a6', 'yellow': '#f0ce80',
}


def palette(path=None):
    path = path or Path.home() / '.local/state/omarchy/current/theme/colors.toml'
    try:
        values = tomllib.loads(path.read_text())
    except (OSError, ValueError):
        values = {}
    colors = dict(DEFAULTS)
    aliases = {'surface': 'lighter_background', 'border': 'selection', 'muted': 'dark_foreground'}
    for name in colors:
        value = values.get(name, values.get(aliases.get(name)))
        if isinstance(value, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', value):
            colors[name] = value
    return colors


class ThemeWatch:
    def __init__(self, window, apply, path=None):
        from gi.repository import GLib
        self.apply = apply
        self.path = path
        self.current = None
        self.poll()
        source = GLib.timeout_add_seconds(1, self.poll)
        window.connect('destroy', lambda *_: GLib.source_remove(source))

    def poll(self):
        colors = palette(self.path)
        if colors != self.current:
            self.apply(colors)
            self.current = colors
        return True
