import importlib.util
import ctypes as C
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('window_lifetimes', ROOT / 'window-lifetimes.py')
lifetimes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifetimes)


class LifetimeTests(unittest.TestCase):
    def test_close_and_create_same_address_mints_distinct_lifetime(self):
        epochs = lifetimes.Epochs()
        initial = epochs.snapshot(['0x0042'])['epochs']['0x42']
        epochs.destroy('42')
        epochs.create('42')
        replacement = epochs.snapshot(['0x42'])
        self.assertNotEqual(initial, replacement['epochs']['0x42'])
        self.assertEqual(replacement['revision'], 2)

    def test_create_without_known_close_still_invalidates_reused_address(self):
        epochs = lifetimes.Epochs()
        initial = epochs.snapshot(['0x42'])['epochs']['0x42']
        epochs.create('42')
        self.assertNotEqual(initial, epochs.snapshot(['0x42'])['epochs']['0x42'])

    def test_monitor_replacement_can_never_reuse_epoch(self):
        first = lifetimes.Epochs().snapshot(['0x42'])['epochs']['0x42']
        second = lifetimes.Epochs().snapshot(['0x42'])['epochs']['0x42']
        self.assertNotEqual(first, second)

    def test_real_hypr_event_drain_recognizes_lifetime_events_and_socket_loss(self):
        source, destination = socket.socketpair()
        self.addCleanup(source.close); self.addCleanup(destination.close)
        monitor = object.__new__(lifetimes.Hyprland)
        monitor.socket, monitor.fd, monitor.buffer = destination, destination.fileno(), b''
        epochs = lifetimes.Epochs()
        initial = epochs.snapshot(['0x42'])['epochs']['0x42']
        source.sendall(b'activewindow>>app,title\nclosewindow>>42\nopenwindow>>42,1,app,same title\n')
        monitor.drain(epochs)
        self.assertNotEqual(initial, epochs.snapshot(['0x42'])['epochs']['0x42'])
        source.close()
        with self.assertRaisesRegex(ValueError, 'connection ended'):
            monitor.drain(epochs)

    def test_helpers_refuse_unowned_endpoints_before_observing_any_events(self):
        for backend in ('wayland', 'xvfb'):
            env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESKTOP')}
            env['AGENT_DESKTOP_WINDOW_BACKEND'] = backend
            p = subprocess.run([sys.executable, str(ROOT / 'window-lifetimes.py')], env=env,
                               capture_output=True, text=True, timeout=2)
            self.assertEqual(p.returncode, 2, p.stderr)
            self.assertIn('refusing non-agent', p.stderr)

    def test_stream_fragmentation_does_not_lose_creation_events(self):
        source, destination = socket.socketpair()
        self.addCleanup(source.close); self.addCleanup(destination.close)
        monitor = object.__new__(lifetimes.Hyprland)
        monitor.socket, monitor.fd, monitor.buffer = destination, destination.fileno(), b''
        epochs = lifetimes.Epochs()
        source.sendall(b'openwin')
        fragment = threading.Timer(0.01, lambda: source.sendall(b'dow>>42,1,app,title\n'))
        fragment.start()
        self.addCleanup(fragment.join)
        monitor.drain(epochs)
        self.assertEqual(epochs.revision, 1)
        self.assertIn('0x42', epochs.windows)

    def test_reparented_x11_client_destruction_invalidates_its_observed_lifetime(self):
        class Xlib:
            def __init__(self):
                self.selected = {1: 1 << 19}
                self.events = []

            def XSelectInput(self, display, window, mask):
                self.selected[window] = mask

            def XSync(self, display, discard):
                pass

            def XPending(self, display):
                return len(self.events)

            def XNextEvent(self, display, output):
                event = self.events.pop(0)
                C.memmove(output, C.byref(event), C.sizeof(event))

            def destroy_under_frame(self, client, frame):
                # Root is not the parent and receives no client notification.
                if self.selected.get(client, 0) & (1 << 17):
                    event = lifetimes.XEvent()
                    event.type = 17
                    event.window.parent = client
                    event.window.window = client
                    self.events.append(event)

        monitor = object.__new__(lifetimes.Xvfb)
        monitor.x, monitor.d, monitor.error = Xlib(), 123, None
        epochs = lifetimes.Epochs()
        initial = epochs.snapshot(['0x42'])['epochs']['0x42']
        monitor.watch(['0x42'])
        self.assertEqual(monitor.x.selected[1], 1 << 19)
        self.assertTrue(monitor.x.selected[0x42] & (1 << 17))
        monitor.x.destroy_under_frame(0x42, 0x999)
        monitor.drain(epochs)
        self.assertNotIn('0x42', epochs.windows)
        self.assertNotEqual(initial, epochs.snapshot(['0x42'])['epochs']['0x42'])

    def test_bad_window_during_subscription_fails_closed(self):
        class Xlib:
            def XSelectInput(self, display, window, mask):
                monitor.error = (3, window)

            def XSync(self, display, discard):
                pass

        monitor = object.__new__(lifetimes.Xvfb)
        monitor.x, monitor.d, monitor.error = Xlib(), 123, None
        with self.assertRaisesRegex(ValueError, 'changed while subscribing'):
            monitor.watch(['0x42'])


if __name__ == '__main__':
    unittest.main()
