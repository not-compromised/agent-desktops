#!/usr/bin/env python3
"""Observe creation/destruction on concrete owned desktop connections only."""
import ctypes as C
import ctypes.util
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import sys
import uuid


def owned(path, kind):
    s = Path(path).stat()
    if s.st_uid != os.getuid() or s.st_mode & 0o022 or not kind(s.st_mode):
        raise ValueError('refusing unowned window event endpoint')
    return s


def hypr_identity():
    slot = os.environ.get('AGENT_DESKTOP', '')
    expected = os.environ.get('AGENT_DESKTOP_INSTANCE', '')
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    if not slot.isdecimal() or slot.startswith('0') or not expected or '/' in expected:
        raise ValueError('refusing non-agent Hyprland event endpoint')
    if os.environ.get('WAYLAND_DISPLAY') != 'wayland-agent-' + slot or 'WAYLAND_SOCKET' in os.environ:
        raise ValueError('refusing non-agent Hyprland display')
    root = Path(runtime)
    if not root.is_absolute() or str(root.resolve()) != runtime:
        raise ValueError('refusing non-agent runtime')
    if owned(root, stat.S_ISDIR).st_mode & 0o007:
        raise ValueError('refusing public runtime')
    instance = root / 'hypr' / ('agent-' + slot)
    actual = instance.resolve(strict=True)
    if actual.parent != root / 'hypr' or actual.name != expected:
        raise ValueError('refusing stale Hyprland instance')
    owned(actual, stat.S_ISDIR)
    display = (root / ('wayland-agent-' + slot)).resolve(strict=True)
    if display.parent != root:
        raise ValueError('refusing foreign Wayland socket')
    ws = owned(display, stat.S_ISSOCK)
    metadata = root / 'agent-desktop' / slot / 'nest'
    owned(metadata, stat.S_ISREG)
    names = [line.split('=', 1)[1] for line in metadata.read_text().splitlines()
             if line.startswith('NEST_WAYLAND_DISPLAY=')]
    if names != [display.name]:
        raise ValueError('refusing mismatched launcher metadata')
    events = actual / '.socket2.sock'
    if events.resolve(strict=True) != events:
        raise ValueError('refusing aliased Hyprland event socket')
    es = owned(events, stat.S_ISSOCK)
    return str(events), es.st_dev, es.st_ino, ws.st_dev, ws.st_ino


def address(value):
    try:
        result = int(value, 16)
    except (TypeError, ValueError):
        raise ValueError('invalid window address')
    if result <= 0:
        raise ValueError('invalid window address')
    return hex(result)


class Epochs:
    def __init__(self):
        self.prefix, self.counter, self.revision = uuid.uuid4().hex, 0, 0
        self.windows = {}

    def create(self, value):
        value = address(value)
        self.counter += 1
        self.revision += 1
        self.windows[value] = self.prefix + ':' + str(self.counter)

    def destroy(self, value):
        self.windows.pop(address(value), None)
        self.revision += 1

    def snapshot(self, values):
        if len(values) > 4096:
            raise ValueError('window inventory exceeded limit')
        result = {}
        for value in values:
            value = address(value)
            if value not in self.windows:
                self.counter += 1
                self.windows[value] = self.prefix + ':' + str(self.counter)
            result[value] = self.windows[value]
        return {'revision': self.revision, 'epochs': result}


class Hyprland:
    def __init__(self):
        before = hypr_identity()
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(1)
        self.socket.connect(before[0])
        _, uid, _ = struct.unpack('3i', self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid() or before != hypr_identity():
            raise ValueError('Hyprland event endpoint changed during connection')
        self.socket.setblocking(False)
        self.fd = self.socket.fileno()
        self.buffer = b''

    def watch(self, values):
        pass

    def drain(self, epochs):
        count = 0
        while select.select([self.fd], [], [], 0.1 if self.buffer else 0)[0]:
            chunk = self.socket.recv(65536)
            if not chunk:
                raise ValueError('Hyprland window event connection ended')
            self.buffer += chunk
            if len(self.buffer) > 262144:
                raise ValueError('Hyprland window events exceeded buffer limit')
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                kind, _, content = line.partition(b'>>')
                if kind in (b'openwindow', b'closewindow'):
                    value = content.split(b',', 1)[0].decode('ascii')
                    (epochs.create if kind == b'openwindow' else epochs.destroy)(value)
                count += 1
                if count > 8192:
                    raise ValueError('Hyprland window event budget exceeded')
        if self.buffer:
            raise ValueError('incomplete Hyprland window event; retry observation')


class XAnyEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', C.c_void_p), ('window', C.c_ulong)]


class XWindowEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int),
                ('display', C.c_void_p), ('parent', C.c_ulong), ('window', C.c_ulong)]


class XEvent(C.Union):
    _fields_ = [('type', C.c_int), ('any', XAnyEvent), ('window', XWindowEvent), ('padding', C.c_long * 24)]


class XErrorEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('display', C.c_void_p), ('resource_id', C.c_ulong),
                ('serial', C.c_ulong), ('error_code', C.c_ubyte),
                ('request_code', C.c_ubyte), ('minor_code', C.c_ubyte)]


XErrorHandler = C.CFUNCTYPE(C.c_int, C.c_void_p, C.POINTER(XErrorEvent))


class Xvfb:
    def __init__(self):
        spec = importlib.util.spec_from_file_location('held_identity', Path(__file__).parent / 'held/xvfb-held.py')
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        before = guard.identity()
        self.x = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
        self.x.XOpenDisplay.argtypes = [C.c_char_p]
        self.x.XOpenDisplay.restype = C.c_void_p
        self.x.XConnectionNumber.argtypes = [C.c_void_p]
        self.x.XConnectionNumber.restype = C.c_int
        self.x.XDefaultRootWindow.argtypes = [C.c_void_p]
        self.x.XDefaultRootWindow.restype = C.c_ulong
        self.x.XTranslateCoordinates.argtypes = [C.c_void_p, C.c_ulong, C.c_ulong, C.c_int, C.c_int,
                                                C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_ulong)]
        self.x.XTranslateCoordinates.restype = C.c_int
        self.x.XGetGeometry.argtypes = [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int),
                                       C.POINTER(C.c_int), C.POINTER(C.c_uint), C.POINTER(C.c_uint),
                                       C.POINTER(C.c_uint), C.POINTER(C.c_uint)]
        self.x.XGetGeometry.restype = C.c_int
        self.x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
        self.x.XSetErrorHandler.argtypes = [XErrorHandler]
        self.x.XSetErrorHandler.restype = C.c_void_p
        self.x.XSync.argtypes = [C.c_void_p, C.c_int]
        self.x.XPending.argtypes = [C.c_void_p]
        self.x.XNextEvent.argtypes = [C.c_void_p, C.POINTER(XEvent)]
        self.d = self.x.XOpenDisplay(before[0].encode())
        if not self.d:
            raise ValueError('cannot connect to owned X11 event display')
        self.fd = self.x.XConnectionNumber(self.d)
        with socket.socket(fileno=os.dup(self.fd)) as peer:
            _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid() or before != guard.identity():
            raise ValueError('X11 event endpoint changed during connection')
        self.error = None
        def failed(_display, event):
            self.error = (event.contents.error_code, event.contents.resource_id)
            return 0
        self._error_handler = XErrorHandler(failed)
        self.x.XSetErrorHandler(self._error_handler)
        self.x.XSelectInput(self.d, self.x.XDefaultRootWindow(self.d), 1 << 19)
        self.sync()

    def sync(self):
        self.x.XSync(self.d, 0)
        if self.error is not None:
            # In particular, BadWindow means it closed between enumeration and
            # subscription. End this monitor rather than publish an unwatched ID.
            raise ValueError('Owned X11 window changed while subscribing to its events')

    def watch(self, values):
        if len(values) > 4096:
            raise ValueError('window inventory exceeded limit')
        for value in values:
            # Openbox reparents clients inside frames. Root notifications then
            # describe the frame, so observe each client directly as well.
            self.x.XSelectInput(self.d, int(address(value), 16), (1 << 17) | (1 << 19))
        self.sync()

    def geometry(self, values):
        result = {}
        root = self.x.XDefaultRootWindow(self.d)
        for value in values:
            key = address(value)
            window = int(key, 16)
            x, y, child = C.c_int(), C.c_int(), C.c_ulong()
            parent, local_x, local_y = C.c_ulong(), C.c_int(), C.c_int()
            width, height, border, depth = C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
            # XGetGeometry's origin is parent-relative after Openbox reparents
            # a client. Translate the client origin itself to the root instead.
            translated = self.x.XTranslateCoordinates(self.d, window, root, 0, 0,
                                                      C.byref(x), C.byref(y), C.byref(child))
            measured = self.x.XGetGeometry(self.d, window, C.byref(parent), C.byref(local_x), C.byref(local_y),
                                           C.byref(width), C.byref(height), C.byref(border), C.byref(depth))
            self.sync()
            if not translated or not measured or not width.value or not height.value:
                raise ValueError('Owned X11 client geometry is unavailable')
            result[key] = {'x': x.value, 'y': y.value, 'w': width.value, 'h': height.value}
        return result

    def drain(self, epochs):
        # XSync orders a snapshot after all server events already processed.
        self.sync()
        count = 0
        while self.x.XPending(self.d):
            event = XEvent()
            self.x.XNextEvent(self.d, C.byref(event))
            if not event.any.send_event:
                if event.type == 16:
                    epochs.create(hex(event.window.window))
                elif event.type == 17:
                    epochs.destroy(hex(event.window.window))
            count += 1
            if count > 8192:
                raise ValueError('X11 window event budget exceeded')


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def run():
    backend = os.environ.get('AGENT_DESKTOP_WINDOW_BACKEND')
    monitor = Hyprland() if backend == 'wayland' else Xvfb() if backend == 'xvfb' else None
    if monitor is None:
        raise ValueError('unknown owned window event backend')
    epochs = Epochs()
    emit({'event': 'ready'})
    buffer = b''
    while True:
        ready, _, _ = select.select([0, monitor.fd], [], [])
        if monitor.fd in ready:
            monitor.drain(epochs)
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                return
            buffer += chunk
            if len(buffer) > 262144:
                raise ValueError('window inventory request exceeded limit')
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                request = json.loads(line)
                if set(request) != {'id', 'addresses'} or not isinstance(request['addresses'], list):
                    raise ValueError('invalid window inventory request')
                monitor.watch(request['addresses'])
                geometry = {'geometry': monitor.geometry(request['addresses'])} if backend == 'xvfb' else {}
                monitor.drain(epochs)
                emit({'id': request['id'], **epochs.snapshot(request['addresses']), **geometry})


if __name__ == '__main__':
    try:
        run()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
