import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk
import json
from pathlib import Path
import sys
import time

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
events = []
window = Gtk.Window(title='Owned tools verification')
window.set_default_size(1000, 800)
window.connect('destroy', Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
window.add(box)
box.pack_start(Gtk.Label(label='Agent Desktops owned tool verification'), False, False, 10)
entry = Gtk.Entry()
entry.get_accessible().set_name('Input field')
box.pack_start(entry, False, False, 10)
secret = Gtk.Entry()
secret.set_visibility(False)
secret.set_text('PASSWORD-MUST-NOT-APPEAR')
box.pack_start(secret, False, False, 10)
box.pack_start(Gtk.Button(label='Save fixture'), False, False, 10)
area = Gtk.DrawingArea()
area.set_can_focus(True)
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK)
def draw(widget, cr):
    cr.set_source_rgb(35/255, 80/255, 140/255)
    cr.paint()
area.connect('draw', draw)
box.pack_start(area, True, True, 0)
def record(kind, event):
    value = {'kind': kind, 'at': time.monotonic(), 'state': int(event.state)}
    if kind.startswith('key'):
        value['key'] = Gdk.keyval_name(event.keyval)
    if kind.startswith('button'):
        value['button'] = int(event.button)
        area.grab_focus()
    events.append(value)
    temporary = root / 'events.tmp'
    temporary.write_text(json.dumps(events))
    temporary.replace(root / 'events.json')
window.connect('key-press-event', lambda _, event: record('key-down', event))
window.connect('key-release-event', lambda _, event: record('key-up', event))
area.connect('button-press-event', lambda _, event: record('button-down', event))
area.connect('button-release-event', lambda _, event: record('button-up', event))
area.connect('motion-notify-event', lambda _, event: record('move', event))
(root / 'events.json').write_text('[]')
window.show_all()
Gtk.main()
