import importlib.util
import io
import mmap
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('xvfb_held', ROOT / 'held/xvfb-held.py')
held = importlib.util.module_from_spec(spec)
spec.loader.exec_module(held)


class FakeX:
    def __init__(self):
        self.events = []

    def code(self, name):
        return {'a': 38, 'b': 56, 'Control_L': 37, 'Control_R': 105,
                'Shift_L': 50, 'Shift_R': 62, 'Alt_L': 64, 'Alt_R': 108,
                'Super_L': 133, 'Super_R': 134}[name]

    def key(self, code, down):
        self.events.append(('key', code, down))

    def button(self, code, down):
        self.events.append(('button', code, down))

    def move(self, x, y):
        self.events.append(('move', x, y))

    def sync(self):
        pass


class ResidentInputTests(unittest.TestCase):
    def setUp(self):
        self.x = FakeX()
        self.memory = mmap.mmap(-1, 272)
        self.addCleanup(self.memory.close)
        self.worker = held.Worker(self.x, self.memory)

    def test_keys_and_buttons_remain_down_across_mouse_and_key_commands(self):
        self.worker.command('SET', ['5000', 'Control_L', 'left'])
        self.worker.command('MOVE', ['10', '20'])
        self.worker.command('KEY', ['a'])
        self.assertEqual(self.worker.keys, {37})
        self.assertEqual(self.worker.buttons, {1})
        self.assertEqual(self.memory[37], 1)
        self.assertEqual(self.memory[257], 1)
        self.assertNotIn(('key', 37, False), self.x.events)
        self.assertNotIn(('button', 1, False), self.x.events)

    def test_replacing_keys_does_not_interrupt_an_existing_drag(self):
        self.worker.set('5000', 'Control_L', 'left')
        self.x.events.clear()
        self.worker.set('5000', 'Shift_L', 'left')
        self.assertIn(('key', 37, False), self.x.events)
        self.assertIn(('key', 50, True), self.x.events)
        self.assertFalse(any(event[0] == 'button' for event in self.x.events))

    def test_release_clears_all_pressed_state_including_interrupted_temporary_events(self):
        self.worker.set('5000', 'Control_L,a', 'right')
        self.worker.event(56, True)
        self.worker.release()
        self.assertFalse(any(self.memory[:264]))
        self.assertEqual(self.worker.keys, set())
        self.assertIn(('key', 56, False), self.x.events)
        self.assertIn(('button', 3, False), self.x.events)

    def test_a_conflicting_click_or_key_does_not_release_held_input(self):
        self.worker.set('5000', 'a', 'left')
        with self.assertRaisesRegex(ValueError, 'held key'):
            self.worker.command('KEY', ['a'])
        with self.assertRaisesRegex(ValueError, 'held button'):
            self.worker.command('CLICK', ['1', '2', 'left'])
        self.assertNotIn(('key', 38, False), self.x.events)
        self.assertNotIn(('button', 1, False), self.x.events)

    def test_invalid_sets_are_refused_before_releasing_existing_state(self):
        self.worker.set('5000', 'a', 'left')
        previous = list(self.x.events)
        for state in [('30001', 'b', ''), ('500', 'a,a', ''), ('500', '', 'extra')]:
            with self.assertRaises(ValueError):
                self.worker.set(*state)
        self.assertEqual(self.x.events, previous)


FAKE_GUARDIAN = r'''
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location('held', sys.argv[1])
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
log = sys.argv[2]
def emit(s):
    fd = os.open(log, os.O_WRONLY|os.O_APPEND|os.O_CREAT, 0o600)
    os.write(fd, (s+'\n').encode()); os.close(fd)
class Lib:
    def XConnectionNumber(self, d): return d
    def XCloseDisplay(self, d): os.close(d)
class X:
    def __init__(self): self.x=Lib(); self.d=os.open('/dev/null',os.O_RDONLY)
    def code(self, n): return {'a':38,'Control_L':37}[n]
    def key(self,c,d): emit(f'{os.getpid()} key {c} {d}')
    def button(self,c,d): emit(f'{os.getpid()} button {c} {d}')
    def sync(self): pass
    def move(self,x,y):
        if x==99: os._exit(9)
        emit(f'{os.getpid()} move {x} {y}')
h.XTest=X
sys.exit(h.run())
'''


def line(kind, *args):
    return ' '.join([kind, *(str(a).encode().hex() or '-' for a in args)]) + '\n'


class GuardianTests(unittest.TestCase):
    def start(self):
        tmp = tempfile.TemporaryDirectory(prefix='held-guardian-')
        self.addCleanup(tmp.cleanup)
        log = Path(tmp.name) / 'events'
        p = subprocess.Popen([sys.executable, '-c', FAKE_GUARDIAN,
                              str(ROOT / 'held/xvfb-held.py'), str(log)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True)
        def close():
            if p.poll() is None:
                p.terminate()
            p.communicate(timeout=3)
        self.addCleanup(close)
        return p, log

    def send(self, p, kind, *args):
        p.stdin.write(line(kind, *args)); p.stdin.flush()
        self.assertTrue(select.select([p.stdout], [], [], 2)[0], 'resident did not answer')
        self.assertEqual(p.stdout.readline().strip(), 'ok')

    def test_native_guardian_releases_on_deadline_without_more_requests(self):
        p, log = self.start()
        self.send(p, 'SET', 150, 'Control_L,a', 'left')
        p.wait(timeout=3)
        remaining = p.stdout.read()
        self.assertIn('expired\nclosed\n', remaining)
        events = log.read_text()
        self.assertIn('key 37 False', events)
        self.assertIn('key 38 False', events)
        self.assertIn('button 1 False', events)
        downs = [e.split()[0] for e in events.splitlines() if e.endswith(' True')]
        ups = [e.split()[0] for e in events.splitlines() if e.endswith(' False')]
        self.assertTrue(set(downs).isdisjoint(ups), 'cleanup must come from independent guardian')

    def test_guardian_releases_after_input_worker_crash(self):
        p, log = self.start()
        self.send(p, 'SET', 30000, 'a', 'right')
        p.stdin.write(line('MOVE', 99, 1)); p.stdin.flush()
        p.wait(timeout=3)
        self.assertIn('closed', p.stdout.read())
        events = log.read_text()
        self.assertIn('key 38 False', events)
        self.assertIn('button 3 False', events)

    def test_eof_releases_without_waiting_for_deadline(self):
        p, log = self.start()
        self.send(p, 'SET', 30000, 'a', 'left')
        p.stdin.close(); p.stdin = None
        p.wait(timeout=3)
        self.assertEqual(p.returncode, 0, p.stderr.read())
        self.assertIn('key 38 False', log.read_text())
        self.assertIn('button 1 False', log.read_text())

    def test_helpers_refuse_personal_or_unspecified_endpoints(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith('AGENT_DESKTOP')}
        for command in [[str(ROOT / 'bin/agent-desktop-held')],
                        [sys.executable, str(ROOT / 'held/xvfb-held.py')]]:
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn('refusing non-agent', result.stderr)


class WaylandModifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='held-xkb-')
        cls.addClassCleanup(cls.tmp.cleanup)
        source = Path(cls.tmp.name) / 'modifiers.c'
        source.write_text('''
#define AGENT_HELD_TEST
#include "''' + str(ROOT / 'held/held.c') + '''"
int main(int argc, char **argv) {
    struct xkb_context *ctx = xkb_context_new(XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
    struct xkb_rule_names names = {.layout = "us"};
    keymap = xkb_keymap_new_from_names(ctx, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap) return 2;
    for (size_t m = 0; m < NMODS; m++) pressable |= mod_mask((int)m);
    for (int i = 1; i < argc && key_count < 16; i++) {
        const char *as; struct hit h;
        if (!find_keysym(key_sym(argv[i], &as), &h)) return 3;
        pressed_keys[key_count++] = h.code;
    }
    printf("%u %d\\n", mask_for_codes(pressed_keys, key_count), ordinary_keys());
    return 0;
}
''')
        cls.binary = Path(cls.tmp.name) / 'modifiers'
        flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'wayland-client', 'xkbcommon'], text=True).split()
        subprocess.run(['cc', '-O2', '-o', str(cls.binary), str(source),
                        str(ROOT / 'keyboard/virtual-keyboard-unstable-v1-protocol.c'),
                        str(ROOT / 'pointer/wlr-virtual-pointer-unstable-v1-protocol.c'),
                        *flags, '-lm'], check=True, capture_output=True)

    def result(self, *names):
        return tuple(map(int, subprocess.check_output([str(self.binary), *names], text=True).split()))

    def test_right_modifiers_produce_same_depressed_state_as_left(self):
        for name in ('Control', 'Shift', 'Alt', 'Super'):
            left = self.result(name + '_L')
            self.assertNotEqual(left[0], 0)
            self.assertEqual(left[1], 0)
            self.assertEqual(self.result(name + '_R'), left)

    def test_both_sides_remain_modifiers_without_becoming_ordinary_keys(self):
        control = self.result('Control_L')[0]
        shift = self.result('Shift_L')[0]
        self.assertEqual(self.result('Control_L', 'Control_R', 'Shift_L', 'Shift_R'), (control | shift, 0))
        self.assertEqual(self.result('Control_R', 'Shift_R', 'a'), (control | shift, 1))


class WaylandResidentLoopTests(unittest.TestCase):
    """Run the production protocol loop, replacing only compositor effects."""
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='held-loop-')
        cls.addClassCleanup(cls.tmp.cleanup)
        source = Path(cls.tmp.name) / 'loop.c'
        source.write_text(r'''
#define AGENT_HELD_TEST
#include "''' + str(ROOT / 'held/held.c') + r'''"
static const char *scenario;
static int injected, cleanups;
static void released(void) {
    fputs("cleanup\n", stderr);
    cleanups++;
    if ((!strcmp(scenario, "idle_cleanup_term") && cleanups == 1) ||
        (!strcmp(scenario, "deadline_cleanup_term") && cleanups == 2)) raise(SIGTERM);
}
static int command(char *kind, int count, char **args) {
    (void)args;
    if (strcmp(kind, "RELEASE") && strcmp(kind, "MOVE")) return 0;
    if ((!strcmp(kind, "RELEASE") && count != 0) || (!strcmp(kind, "MOVE") && count != 2)) return 0;
    if (!strcmp(kind, "RELEASE")) released();
    if (!injected++) {
        if (!strcmp(scenario, "release_alarm") || !strcmp(scenario, "failed_release") || !strcmp(scenario, "command_alarm") || !strcmp(scenario, "deadline_cleanup_term")) raise(SIGALRM);
        if (!strcmp(scenario, "release_term")) raise(SIGTERM);
        if (!strcmp(scenario, "cleanup_term")) { raise(SIGALRM); raise(SIGTERM); }
        if (!strcmp(scenario, "term_then_alarm")) { raise(SIGTERM); raise(SIGALRM); }
        if (!strcmp(scenario, "failed_release")) return 0;
    }
    return 1;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    scenario = argv[1];
    install_held_signals();
    if (!strcmp(scenario, "idle_alarm") || !strcmp(scenario, "idle_cleanup_term")) raise(SIGALRM);
    run_commands(command, released);
    return 0;
}
''')
        cls.binary = Path(cls.tmp.name) / 'loop'
        flags = subprocess.check_output(['pkg-config', '--cflags', '--libs', 'wayland-client', 'xkbcommon'], text=True).split()
        subprocess.run(['cc', '-O2', '-o', str(cls.binary), str(source),
                        str(ROOT / 'keyboard/virtual-keyboard-unstable-v1-protocol.c'),
                        str(ROOT / 'pointer/wlr-virtual-pointer-unstable-v1-protocol.c'),
                        *flags, '-lm'], check=True, capture_output=True)

    def result(self, scenario, commands='RELEASE\nRELEASE\n'):
        result = subprocess.run([str(self.binary), scenario], input=commands,
                                capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines(), result.stderr.splitlines()

    def test_successful_release_and_eof_confirm_cleanup(self):
        output, effects = self.result('control')
        self.assertEqual(output, ['ok', 'ok'])
        self.assertEqual(effects.count('cleanup'), 3)

    def test_deadline_during_successful_release_acknowledges_and_keeps_session_usable(self):
        output, effects = self.result('release_alarm')
        self.assertEqual(output, ['ok', 'expired', 'ok'])
        self.assertGreaterEqual(effects.count('cleanup'), 2)

    def test_deadline_before_next_command_cleans_up_and_keeps_session_usable(self):
        output, effects = self.result('idle_alarm')
        self.assertEqual(output, ['expired', 'ok', 'ok'])
        self.assertGreaterEqual(effects.count('cleanup'), 3)

    def test_failed_release_is_not_acknowledged_even_with_deadline(self):
        output, _ = self.result('failed_release')
        self.assertEqual(output, ['expired', 'error held input deadline expired'])

    def test_deadline_during_other_command_still_fails_closed(self):
        output, _ = self.result('command_alarm', 'MOVE 31 32\nRELEASE\n')
        self.assertEqual(output, ['expired', 'error held input deadline expired'])

    def test_invalid_commands_and_malformed_input_fail_closed(self):
        for commands in ['UNKNOWN\nRELEASE\n', 'RELEASE 31\nRELEASE\n',
                         'MOVE f 32\nRELEASE\n', 'MOVE zz 32\nRELEASE\n',
                         'MOVE ' + '31 ' * 9 + '\nRELEASE\n']:
            with self.subTest(commands=commands):
                output, effects = self.result('control', commands)
                self.assertEqual(output, ['error invalid or conflicting resident input command'])
                self.assertIn('cleanup', effects)

    def test_termination_during_deadline_cleanup_never_executes_next_command(self):
        for scenario, expected in [('idle_cleanup_term', []), ('deadline_cleanup_term', ['ok'])]:
            with self.subTest(scenario=scenario):
                output, _ = self.result(scenario)
                self.assertEqual(output, expected)

    def test_termination_during_release_is_not_acknowledged(self):
        for scenario in ['release_term', 'cleanup_term', 'term_then_alarm']:
            with self.subTest(scenario=scenario):
                output, _ = self.result(scenario)
                self.assertEqual(output, ['error invalid or conflicting resident input command'])


if __name__ == '__main__':
    unittest.main()
