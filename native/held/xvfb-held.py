#!/usr/bin/env python3
"""Owned XTEST input with a separate process retaining the cleanup connection."""
import ctypes as C
import ctypes.util
import json
import mmap
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import struct
import sys
import time


BUTTONS = {'left': 1, 'middle': 2, 'right': 3}
ALIASES = {'ctrl': 'Control_L', 'control': 'Control_L', 'shift': 'Shift_L',
           'alt': 'Alt_L', 'super': 'Super_L', 'win': 'Super_L', 'logo': 'Super_L',
           'enter': 'Return', 'esc': 'Escape', 'space': 'space', 'tab': 'Tab',
           'backspace': 'BackSpace', 'delete': 'Delete', 'del': 'Delete'}


def owned_file(path):
    p = Path(path)
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o022:
        raise ValueError('refusing unowned or writable desktop metadata')
    d = p.parent.stat()
    if d.st_uid != os.getuid() or d.st_mode & 0o022:
        raise ValueError('refusing unowned or writable desktop directory')
    return p.read_bytes()


def identity():
    slot = os.environ.get('AGENT_DESKTOP', '')
    expected = os.environ.get('AGENT_DESKTOP_INSTANCE', '')
    metadata = os.environ.get('AGENT_DESKTOP_INFO', '')
    if not re.fullmatch(r'[1-9][0-9]*', slot) or not expected or not metadata:
        raise ValueError('refusing non-agent X11 endpoint')
    p = Path(metadata)
    if not p.is_absolute() or p.name != 'desktop.json' or p.parent.name != slot:
        raise ValueError('refusing non-agent X11 metadata path')
    data = json.loads(owned_file(p))
    auth = p.parent / 'Xauthority'
    owned_file(auth)
    display = data.get('display', '')
    if not re.fullmatch(r':[0-9]+', display) or data.get('instance') != expected:
        raise ValueError('refusing stale X11 generation')
    if os.environ.get('DISPLAY') != display or os.environ.get('XAUTHORITY') != str(auth):
        raise ValueError('refusing mismatched X11 display or authority')
    if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('WAYLAND_SOCKET'):
        raise ValueError('refusing mixed X11/Wayland endpoint')
    sock = Path('/tmp/.X11-unix') / ('X' + display[1:])
    s = sock.stat()
    if not stat.S_ISSOCK(s.st_mode) or s.st_uid != os.getuid():
        raise ValueError('refusing unowned X11 socket')
    return display, s.st_dev, s.st_ino, data['instance']


class XTest:
    def __init__(self):
        before = identity()
        self.x = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
        self.t = C.CDLL(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
        self.x.XOpenDisplay.argtypes = [C.c_char_p]
        self.x.XOpenDisplay.restype = C.c_void_p
        self.x.XCloseDisplay.argtypes = [C.c_void_p]
        self.x.XConnectionNumber.argtypes = [C.c_void_p]
        self.x.XConnectionNumber.restype = C.c_int
        self.x.XSync.argtypes = [C.c_void_p, C.c_int]
        self.x.XStringToKeysym.argtypes = [C.c_char_p]
        self.x.XStringToKeysym.restype = C.c_ulong
        self.x.XKeysymToKeycode.argtypes = [C.c_void_p, C.c_ulong]
        self.x.XKeysymToKeycode.restype = C.c_ubyte
        self.x.XkbKeycodeToKeysym.argtypes = [C.c_void_p, C.c_ubyte, C.c_int, C.c_int]
        self.x.XkbKeycodeToKeysym.restype = C.c_ulong
        self.t.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.t.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.t.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
        self.d = self.x.XOpenDisplay(before[0].encode())
        if not self.d:
            raise ValueError('cannot connect to authenticated owned X11 display')
        fd = self.x.XConnectionNumber(self.d)
        with socket.socket(fileno=os.dup(fd)) as peer:
            _, uid, _ = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid != os.getuid() or before != identity():
            self.x.XCloseDisplay(self.d)
            raise ValueError('X11 endpoint changed during connection')

    def sync(self):
        self.x.XSync(self.d, 0)

    def key(self, code, down):
        if not self.t.XTestFakeKeyEvent(self.d, code, int(down), 0):
            raise ValueError('XTEST key event failed')

    def button(self, code, down):
        if not self.t.XTestFakeButtonEvent(self.d, code, int(down), 0):
            raise ValueError('XTEST button event failed')

    def move(self, x, y):
        if not 0 <= x < 2560 or not 0 <= y < 1440:
            raise ValueError('coordinates outside owned desktop')
        if not self.t.XTestFakeMotionEvent(self.d, -1, x, y, 0):
            raise ValueError('XTEST motion event failed')
        self.sync()

    def code(self, name):
        name = ALIASES.get(name.lower(), name)
        sym = self.x.XStringToKeysym(name.encode())
        code = self.x.XKeysymToKeycode(self.d, sym) if sym else 0
        if not code:
            raise ValueError('key unavailable in desktop keymap: ' + name)
        return code

    def character(self, char):
        sym = {'\n': 0xff0d, '\t': 0xff09}.get(char, ord(char) if ord(char) < 256 else ord(char) | 0x1000000)
        if ord(char) < 32 and char not in '\n\t' or ord(char) == 127:
            raise ValueError('control character in text')
        for level in (0, 1):
            for code in range(8, 256):
                if self.x.XkbKeycodeToKeysym(self.d, code, 0, level) == sym:
                    return code, level
        raise ValueError('character unavailable in desktop keymap')


def announce(line):
    print(line, flush=True)


class Worker:
    def __init__(self, x, state):
        self.x, self.state = x, state
        self.keys, self.buttons = set(), set()

    def event(self, code, down, button=False):
        index = code + (256 if button else 0)
        if down:
            self.state[index:index + 1] = b'\1'
        (self.x.button if button else self.x.key)(code, down)
        self.x.sync()
        if not down:
            self.state[index:index + 1] = b'\0'

    def release(self):
        for code in range(8, 256):
            if self.state[code]:
                self.event(code, False)
        for code in range(1, 8):
            if self.state[256 + code]:
                self.event(code, False, True)
        self.keys.clear()
        self.buttons.clear()
        self.state[264:272] = struct.pack('d', 0)

    def set(self, ms, keys, buttons):
        ms = int(ms)
        names = keys.split(',') if keys else []
        button_names = buttons.split(',') if buttons else []
        if not 100 <= ms <= 30000 or len(names) > 16 or len(set(names)) != len(names):
            raise ValueError('invalid held keys or deadline')
        if len(button_names) > 3 or len(set(button_names)) != len(button_names) or any(b not in BUTTONS for b in button_names):
            raise ValueError('invalid held buttons')
        next_keys = {self.x.code(name) for name in names}
        next_buttons = {BUTTONS[b] for b in button_names}
        if len(next_keys) != len(names):
            raise ValueError('held aliases identify the same key')
        self.state[264:272] = struct.pack('d', time.monotonic() + ms / 1000 if next_keys or next_buttons else 0)
        for code in self.keys - next_keys:
            self.event(code, False)
        for code in self.buttons - next_buttons:
            self.event(code, False, True)
        for code in next_keys - self.keys:
            self.event(code, True)
        for code in next_buttons - self.buttons:
            self.event(code, True, True)
        self.keys, self.buttons = next_keys, next_buttons

    def tap(self, code, modifiers=()):
        if code in self.keys:
            raise ValueError('cannot tap a held key')
        temporary = set(modifiers) - self.keys
        for mod in temporary:
            self.event(mod, True)
        self.event(code, True)
        self.event(code, False)
        for mod in temporary:
            self.event(mod, False)

    def command(self, kind, args):
        if kind == 'SET' and len(args) == 3:
            self.set(*args)
        elif kind == 'RELEASE' and not args:
            self.release()
        elif kind == 'MOVE' and len(args) == 2:
            self.x.move(*map(int, args))
        elif kind == 'KEY' and len(args) == 1:
            parts = args[0].split('+')
            mods = [self.x.code(p) for p in parts[:-1]]
            self.tap(self.x.code(parts[-1]), mods)
        elif kind == 'TYPE' and len(args) == 1:
            modifier_codes = {self.x.code(n) for n in ['Shift_L', 'Shift_R', 'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Super_L', 'Super_R']}
            if self.keys - modifier_codes:
                raise ValueError('cannot type while an ordinary key is held')
            sequence = [self.x.character(char) for char in args[0]]
            for code, shift in sequence:
                self.tap(code, [self.x.code('Shift_L')] if shift else [])
        elif kind in ('CLICK', 'DRAG') and len(args) == (3 if kind == 'CLICK' else 6):
            drag = kind == 'DRAG'
            code = BUTTONS[args[4 if drag else 2]]
            if code in self.buttons:
                raise ValueError('cannot click or drag with an already held button')
            self.x.move(int(args[0]), int(args[1]))
            self.event(code, True, True)
            if drag:
                x, y, tx, ty = map(int, args[:4])
                ms = int(args[5])
                if not 100 <= ms <= 2000:
                    raise ValueError('drag duration outside limits')
                for step in range(1, 11):
                    self.x.move(round(x + (tx - x) * step / 10), round(y + (ty - y) * step / 10))
                    time.sleep(ms / 10000)
            self.event(code, False, True)
        elif kind == 'SCROLL' and len(args) == 4:
            x, y, dy, dx = map(int, args)
            if abs(dy) > 100 or abs(dx) > 100:
                raise ValueError('scroll exceeds 100 steps')
            self.x.move(x, y)
            for amount, negative, positive in [(dy, 4, 5), (dx, 6, 7)]:
                for _ in range(abs(amount)):
                    self.event(negative if amount < 0 else positive, True, True)
                    self.event(negative if amount < 0 else positive, False, True)
        else:
            raise ValueError('unsupported resident input command')

    def run(self):
        def stopped(*_):
            raise InterruptedError('holder stopped')
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, stopped)
        C.CDLL(None).prctl(1, signal.SIGTERM)
        try:
            for line in sys.stdin:
                if len(line) > 100000:
                    raise ValueError('command too large')
                parts = line.strip().split(' ')
                args = ['' if p == '-' else bytes.fromhex(p).decode('utf-8') for p in parts[1:]]
                self.command(parts[0], args)
                announce('ok')
        except BaseException as exc:
            self.release()
            announce('error ' + str(exc))
            return 1
        finally:
            self.release()
        return 0


def run():
    worker_x, guardian_x = XTest(), XTest()
    state = mmap.mmap(-1, 272)
    guardian_pid = os.getpid()
    pid = os.fork()
    if pid == 0:
        # Closing the unused guardian connection never reconnects an alias.
        os.close(guardian_x.x.XConnectionNumber(guardian_x.d))
        C.CDLL(None).prctl(1, signal.SIGTERM)
        if os.getppid() != guardian_pid:
            os._exit(1)
        os._exit(Worker(worker_x, state).run())
    os.close(worker_x.x.XConnectionNumber(worker_x.d))
    os.close(0)
    def stopped(*_):
        raise InterruptedError('guardian stopped')
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stopped)
    expired, status, reaped = False, 1, False
    try:
        while True:
            ended, value = os.waitpid(pid, os.WNOHANG)
            if ended:
                status = os.waitstatus_to_exitcode(value)
                reaped = True
                break
            deadline = struct.unpack('d', state[264:272])[0]
            if deadline and time.monotonic() >= deadline:
                expired = True
                break
            time.sleep(0.01)
    except BaseException:
        pass
    finally:
        # Freeze before reading the shared pressed bitmap. The worker records
        # every press before XTEST and clears it only after a confirmed release.
        if not reaped:
            try:
                os.kill(pid, signal.SIGSTOP)
                _, value = os.waitpid(pid, os.WUNTRACED)
                reaped = not os.WIFSTOPPED(value)
            except (ProcessLookupError, ChildProcessError):
                reaped = True
        for code in range(8, 256):
            if state[code]:
                guardian_x.key(code, False)
        for code in range(1, 8):
            if state[256 + code]:
                guardian_x.button(code, False)
        guardian_x.sync()
        if not reaped:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        if expired:
            announce('expired')
        announce('closed')
        guardian_x.x.XCloseDisplay(guardian_x.d)
    return 0 if expired else status


if __name__ == '__main__':
    try:
        sys.exit(run())
    except Exception as exc:
        print(str(exc), file=sys.stderr, flush=True)
        sys.exit(2)
