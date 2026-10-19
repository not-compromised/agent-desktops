import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time
import unittest


@unittest.skipUnless(os.environ.get('DESKTOP_THEME_GUI_TESTS'), 'Requires an owned agent desktop')
class NativeStreamTest(unittest.TestCase):
    def test_pixels_visibility_and_fullscreen_in_webkit(self):
        # Gtk.Application registration is process-wide. Keep this real native
        # instance separate from the theme test and the user's running viewer.
        if not os.environ.get('DESKTOP_STREAM_TEST_CHILD'):
            result = subprocess.run([sys.executable, '-W', 'ignore::DeprecationWarning', __file__],
                env={**os.environ, 'DESKTOP_STREAM_TEST_CHILD': '1'}, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return
        import gi
        gi.require_version('Gtk', '3.0')
        gi.require_version('WebKit2', '4.1')
        from gi.repository import Gtk, Gio, Gdk, WebKit2
        directory = Path(__file__).parent
        peer = subprocess.Popen(['node', '--input-type=module', '-e',
            "import {fixture} from './fixtures/rfb.mjs'; const app=await fixture(); console.log(app.url); console.log(app.fixtureURL);"],
            cwd=directory, stdout=subprocess.PIPE, text=True)
        code = runpy.run_path(str(directory.parent/'agent-desktops'), run_name='stream_test')
        app = code['Desktops']()
        app.set_application_id('org.omarchy.AgentDesktops.StreamTest')
        app.set_flags(Gio.ApplicationFlags.NON_UNIQUE)
        app.register(None)
        app.url = peer.stdout.readline().strip()
        fixture_url = peer.stdout.readline().strip()
        self.assertTrue(app.url.startswith('http://127.0.0.1:'))
        win = app.window('Synthetic native stream test', app.url)
        view = win.get_child()
        # Pixels below must arrive without GPU painting or compositing (tools#365).
        self.assertEqual(view.get_settings().get_hardware_acceleration_policy(),
                         WebKit2.HardwareAccelerationPolicy.NEVER)

        def pump(seconds=.05):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                while Gtk.events_pending(): Gtk.main_iteration_do(False)
                time.sleep(.005)

        def js(source):
            result = []
            def done(view, task, *_):
                result.append(view.run_javascript_finish(task).get_js_value().to_string())
            view.run_javascript(source, None, done, None)
            deadline = time.monotonic() + 5
            while not result and time.monotonic() < deadline: pump()
            self.assertTrue(result, 'WebKit callback completed')
            return result[0]

        def until(source):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if js(source) == 'true': return
                pump(.1)
            self.fail(f'WebKit condition timed out: {source}')

        def assert_fits():
            until("""(() => {
                const c = document.querySelector('.screen canvas');
                if (!c) return false;
                const box = c.getBoundingClientRect(), area = c.closest('.screen').getBoundingClientRect();
                return c.width === 1600 && c.height === 1000
                    && Math.abs(box.width / box.height - 1.6) < .001
                    && box.width <= area.width + 1 && box.height <= area.height + 1
                    && (Math.abs(box.width - area.width) < 1 || Math.abs(box.height - area.height) < 1)
                    && c.parentElement.scrollWidth <= c.parentElement.clientWidth
                    && c.parentElement.scrollHeight <= c.parentElement.clientHeight;
            })()""")

        try:
            until('!!document.querySelector(".control:not(:disabled)")')
            js('document.querySelector(".desktop-menu .settings").click()')
            until('!document.querySelector("#settings-panel select").disabled')
            js("""(() => { const form = document.querySelector('#settings-panel form');
                form.elements.idlePreset.value = 'custom'; form.elements.idlePreset.dispatchEvent(new Event('change'));
                form.elements.idleCustom.value = '45'; form.elements.browserStartup.value = 'restore';
                form.elements.viewerStartup.value = 'notify'; form.elements.streamQuality.value = 'resource';
                form.elements.notificationSeconds.value = '7'; form.requestSubmit(); })()""")
            until('document.getElementById("settings-panel").hidden')
            from urllib.request import urlopen
            stored = json.loads(urlopen(app.url + 'api/settings').read())['settings']
            self.assertEqual(stored, dict(idleMinutes=45, browserStartup='restore', viewerStartup='notify',
                streamQuality='resource', notificationSeconds=7))
            # Restore stream defaults for the existing fullscreen/clipboard checks.
            js('document.querySelector(".desktop-menu .settings").click()')
            until('!document.querySelector("#settings-panel select").disabled')
            js("""(() => { const form = document.querySelector('#settings-panel form');
                form.elements.idlePreset.value = '30'; form.elements.idlePreset.dispatchEvent(new Event('change'));
                form.elements.browserStartup.value = 'fresh'; form.elements.viewerStartup.value = 'open';
                form.elements.streamQuality.value = 'auto'; form.elements.notificationSeconds.value = '4'; form.requestSubmit(); })()""")
            until('document.getElementById("settings-panel").hidden')
            js('document.querySelector(".size").click()')
            until('document.documentElement.classList.contains("native-fullscreen")')
            self.assertTrue(win.get_window().get_state() & Gdk.WindowState.FULLSCREEN)
            until('document.querySelector(".tile-footer").getBoundingClientRect().top >= innerHeight')
            self.assertEqual(js('getComputedStyle(document.querySelector(".tile")).borderTopWidth'), '0px')
            self.assertEqual(js('JSON.stringify(document.querySelector(".screen").getBoundingClientRect().toJSON())'),
                             js('JSON.stringify({x:0,y:0,width:innerWidth,height:innerHeight,top:0,right:innerWidth,bottom:innerHeight,left:0})'))
            assert_fits()
            pixels = js('JSON.stringify([...document.querySelector(".screen canvas").getContext("2d").getImageData(10,10,1,1).data])')
            self.assertEqual(json.loads(pixels), [120, 120, 120, 255])
            js('document.querySelector(".control").click()')
            until('document.querySelector(".control").getAttribute("aria-pressed") === "true"')
            js('''(() => { const r = document.querySelector('.control-note').getBoundingClientRect();
                window.badgePoint = {x: r.right - 4, y: r.top + r.height / 2};
                document.dispatchEvent(new PointerEvent('pointermove', {clientX: badgePoint.x, clientY: badgePoint.y})); })()''')
            self.assertEqual(js('getComputedStyle(document.querySelector(".control-note")).opacity'), '0')
            self.assertEqual(js('document.elementFromPoint(badgePoint.x, badgePoint.y).tagName'), 'CANVAS')
            pump(.1)
            self.assertEqual(js('getComputedStyle(document.querySelector(".control-note")).opacity'), '0')
            js('document.dispatchEvent(new PointerEvent("pointermove", {clientX: innerWidth / 2, clientY: innerHeight / 2}))')
            self.assertEqual(js('getComputedStyle(document.querySelector(".control-note")).opacity'), '1')
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text('Native harmless clipboard sample', -1)
            js('document.querySelector(".clipboard").click()')
            until('document.getElementById("status").textContent.startsWith("Clipboard sent.")')
            from urllib.request import urlopen
            with urlopen(fixture_url + '/clipboard-test') as response:
                self.assertEqual(json.load(response), ['Native harmless clipboard sample'])
            js('''(() => { const r = document.getElementById('status').getBoundingClientRect();
                document.dispatchEvent(new PointerEvent('pointermove', {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2})); })()''')
            self.assertEqual(js('document.getElementById("status").textContent'), '')
            js('document.dispatchEvent(new PointerEvent("pointermove", {clientX: innerWidth / 2, clientY: innerHeight / 2}))')
            self.assertEqual(js('document.getElementById("status").textContent'), '')
            js('document.querySelector(".clipboard").click()')
            until('document.getElementById("status").textContent.startsWith("Clipboard sent.")')
            pump(4.1)
            self.assertEqual(js('document.getElementById("status").textContent'), '')
            js('document.querySelector(".close-desktops").click()')
            until('document.getElementById("cleanup").open')
            self.assertIn('1 agent desktop on fixture', js('document.getElementById("cleanup-description").textContent'))
            js('document.getElementById("cleanup-cancel").click()')
            self.assertEqual(js('document.getElementById("cleanup").open'), 'false')
            win.hide()
            until('document.hidden && document.querySelectorAll(".screen canvas").length === 0')
            win.show_all()
            until('!!document.querySelector(".control:not(:disabled)")')
            self.assertEqual(js('document.querySelector(".control").getAttribute("aria-pressed")'), 'false')
            assert_fits()
            js('document.querySelector(".size").click()')
            until('!document.documentElement.classList.contains("native-fullscreen")')
            self.assertEqual(js('document.querySelector(".size").getAttribute("aria-label")'), 'Enlarge')
            js('document.querySelector(".size").click()')
            until('document.documentElement.classList.contains("native-fullscreen")')
            win.unfullscreen()
            until('!document.documentElement.classList.contains("native-fullscreen")')
            assert_fits()
        finally:
            win.destroy()
            pump(.1)
            peer.terminate()
            peer.wait(timeout=5)
            peer.stdout.close()


if __name__ == '__main__': unittest.main()
