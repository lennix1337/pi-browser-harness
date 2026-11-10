"""The REPL cell runtime: persistent namespace per tab, a guarded cdp(), refusal before running, error vs uncertain,
dialog policy and event routing. No browser: browser_harness.helpers is replaced by a recording double."""
import importlib.util
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

PYTHON = Path(__file__).resolve().parents[1] / "python"
sys.path.insert(0, str(PYTHON))
spec = importlib.util.spec_from_file_location("repl", PYTHON / "repl.py")
repl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repl)

ENDPOINT = "http://127.0.0.1:9333"


class FakeAx:
    """Stands in for the vendored AxHelpers: records what the cell helpers ask of it."""

    def __init__(self, cdp, log=print, on_event=None):
        self.cdp, self.log, self.acted, self.calls = cdp, log, False, []

    def state(self, max=3000):
        self.acted = False
        self.log(f"[1] button \"Save\" (max {max})")
        return repl.ax.Printed("state")

    def click(self, id):
        self.acted = True
        self.calls.append(("click", id))
        self.log(f"[ok] click [{id}] -> no change")
        return repl.ax.Printed("click")

    def type(self, id, text, enter=False):
        self.acted = True
        self.calls.append(("type", id, text, enter))
        return repl.ax.Printed("type")

    def settle(self, cap_ms=800, quiet_ms=80, since=0):
        return {"why": "quiet"}


class Harness:
    """A recording double of browser_harness.helpers.cdp/_send, installed for the duration of a test."""

    def __init__(self, test):
        self.calls, self.events, self.fail = [], [], {}
        self.answers = {"Target.getTargetInfo": {"targetInfo": {"url": "http://127.0.0.1:8080/page"}}}
        from browser_harness import helpers
        self.helpers = helpers
        for p in (patch.object(helpers, "cdp", self.cdp), patch.object(helpers, "_send", self.send)):
            p.start()
            test.addCleanup(p.stop)

    def cdp(self, method, session_id=None, _response_timeout=5.0, **params):
        self.calls.append((method, session_id, params))
        if method in self.fail:
            raise RuntimeError(self.fail[method])
        return self.answers.get(method, {})

    def send(self, request, response_timeout=5.0):
        if request == {"meta": "drain_events"}:
            events, self.events = self.events, []
            return {"events": events}
        return {}

    def methods(self):
        return [call[0] for call in self.calls]


def make_tab(test, **kwargs):
    harness = Harness(test)
    router = repl.Router(min_interval=0)
    tab = repl.Tab(router, ENDPOINT, "owned-target", "owned-session", ax_factory=FakeAx, **kwargs)
    return harness, router, tab


class Guard(unittest.TestCase):
    def test_refuses_what_would_leave_the_owned_tab_before_running_anything(self):
        for code in ["import browser_harness", "from browser_harness import helpers", "import websockets", "import cdp_use.client",
                     "import socket", "import subprocess", "from subprocess import run", "import ctypes", "from os import system",
                     "_send({'meta': 'x'})", "import os\nos.system('calc')", "__import__('socket')", "import importlib"]:
            with self.subTest(code=code), self.assertRaises(repl.Refused):
                repl.check_code(code)

    def test_ordinary_cells_pass(self):
        for code in ["import json, re, time", "x = 1\nx + 1", "from urllib.parse import quote", "import os\nos.environ.get('A')"]:
            repl.check_code(code)

    def test_a_refused_cell_is_an_error_with_no_effect_and_nothing_sent(self):
        harness, _, tab = make_tab(self)
        result = tab.run("import subprocess\nclick(3)")
        self.assertEqual(result["status"], "error")
        self.assertIn("subprocess", result["error"])
        self.assertEqual(set(harness.methods()) - {"Target.getTargetInfo"}, set(), "only the tab's url is read")


class GuardedCdp(unittest.TestCase):
    def test_cdp_always_uses_the_owned_session_even_when_the_cell_names_another(self):
        harness, _, tab = make_tab(self)
        result = tab.run("cdp('Runtime.evaluate', session_id='someone-elses', expression='1')")
        self.assertEqual(result["status"], "ok")
        call = [c for c in harness.calls if c[0] == "Runtime.evaluate"][0]
        self.assertEqual(call[1], "owned-session")
        self.assertNotIn("session_id", call[2])

    def test_target_and_browser_domains_are_refused_except_the_own_target_info(self):
        harness, _, tab = make_tab(self)
        for method in ["Target.createTarget", "Target.closeTarget", "Target.attachToTarget", "Target.getTargets", "Browser.close", "Browser.getVersion"]:
            with self.subTest(method=method):
                result = tab.run(f"cdp({method!r})")
                self.assertEqual(result["status"], "error")
                self.assertIn("refused", result["error"])
        self.assertEqual(set(harness.methods()) - {"Target.getTargetInfo"}, set())
        ok = tab.run("cdp('Target.getTargetInfo', targetId='another-tab')")
        self.assertEqual(ok["status"], "ok")
        info = [c for c in harness.calls if c[0] == "Target.getTargetInfo"][0]
        self.assertEqual(info[2], {"targetId": "owned-target"}, "the target is forced to the owned one")

    def test_the_tab_url_is_reported_after_every_cell(self):
        _, _, tab = make_tab(self)
        self.assertEqual(tab.run("1")["url"], "http://127.0.0.1:8080/page")


class Cells(unittest.TestCase):
    def test_variables_persist_between_cells_of_one_tab_but_not_between_tabs(self):
        _, router, tab = make_tab(self)
        other = repl.Tab(router, ENDPOINT, "other-target", "other-session", ax_factory=FakeAx)
        tab.run("counter = 41")
        self.assertEqual(tab.run("counter + 1")["output"].strip(), "42")
        self.assertEqual(other.run("counter")["status"], "error")

    def test_the_last_expression_is_echoed_and_prints_are_captured(self):
        _, _, tab = make_tab(self)
        self.assertEqual(tab.run("print('a')\n'b'")["output"], "a\n'b'\n")
        self.assertEqual(tab.run("None")["output"], "")

    def test_an_exception_before_any_effect_is_an_error(self):
        _, _, tab = make_tab(self)
        result = tab.run("print('before')\n1/0")
        self.assertEqual(result["status"], "error")
        self.assertIn("ZeroDivisionError", result["error"])
        self.assertEqual(result["output"], "before\n")

    def test_an_exception_after_an_effect_is_outcome_uncertain_with_the_action_lines_kept(self):
        _, _, tab = make_tab(self)
        result = tab.run("click(7)\nraise RuntimeError('boom')")
        self.assertEqual(result["status"], "outcome_uncertain")
        self.assertIn("[ok] click [7]", result["output"])
        self.assertIn("boom", result["error"])

    def test_a_raw_effectful_cdp_call_counts_as_an_effect_but_a_read_does_not(self):
        harness, _, tab = make_tab(self)
        harness.answers["Page.getLayoutMetrics"] = {}
        self.assertEqual(tab.run("cdp('Page.getLayoutMetrics')\n1/0")["status"], "error")
        self.assertEqual(tab.run("cdp('Input.dispatchMouseEvent', type='mousePressed', x=1, y=1)\n1/0")["status"], "outcome_uncertain")

    def test_a_cell_that_acted_ends_with_the_state_and_one_that_only_read_does_not(self):
        _, _, tab = make_tab(self)
        acted = tab.run("click(3)")
        self.assertIn('[1] button "Save"', acted["output"])
        self.assertEqual(acted["output"].count("[ok] click [3]"), 1)
        self.assertNotIn('"Save"', tab.run("1 + 1")["output"])

    def test_state_after_a_failed_acting_cell_is_still_printed(self):
        _, _, tab = make_tab(self)
        result = tab.run("click(3)\nraise ValueError('x')")
        self.assertIn('[1] button "Save"', result["output"])

    def test_the_state_helper_passes_max_and_is_not_an_effect(self):
        _, _, tab = make_tab(self)
        result = tab.run("state(max=500)\n1/0")
        self.assertEqual(result["status"], "error")
        self.assertIn("max 500", result["output"])

    def test_system_exit_does_not_end_the_repl(self):
        _, _, tab = make_tab(self)
        self.assertEqual(tab.run("raise SystemExit(1)")["status"], "error")
        self.assertEqual(tab.run("2 + 2")["output"].strip(), "4")

    def test_goto_refuses_non_http_urls_before_any_cdp_call(self):
        harness, _, tab = make_tab(self)
        for url in ["file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/"]:
            with self.subTest(url=url):
                self.assertEqual(tab.run(f"goto({url!r})")["status"], "error")
        self.assertEqual(set(harness.methods()) - {"Target.getTargetInfo"}, set())

    def test_upload_needs_existing_files(self):
        _, _, tab = make_tab(self)
        self.assertEqual(tab.run("upload(4, '/definitely/not/here.txt')")["status"], "error")


class Dialogs(unittest.TestCase):
    def dialog(self, kind, message="sure?"):
        return {"method": "Page.javascriptDialogOpening", "session_id": "owned-session", "params": {"type": kind, "message": message, "defaultPrompt": "d"}}

    def handled(self, harness):
        return [c for c in harness.calls if c[0] == "Page.handleJavaScriptDialog"]

    def test_alert_and_beforeunload_are_accepted_confirm_and_prompt_are_dismissed_and_reported(self):
        harness, router, tab = make_tab(self)
        harness.events = [self.dialog("alert", "hi"), self.dialog("beforeunload"), self.dialog("confirm"), self.dialog("prompt")]
        router.pump()
        self.assertEqual([c[2]["accept"] for c in self.handled(harness)], [True, True, False, False])
        self.assertTrue(all(c[1] == "owned-session" for c in self.handled(harness)))
        report = tab.run("1")["output"]
        self.assertIn("[dialog confirm] \"sure?\" (dismissed)", report)
        self.assertIn("[dialog alert] \"hi\" (accepted)", report)
        self.assertNotIn("(dismissed)", tab.run("1")["output"], "a report is delivered once")

    def test_dialog_accept_true_makes_confirm_and_prompt_accepted(self):
        harness, router, tab = make_tab(self)
        tab.run("dialog(accept=True)")
        harness.events = [self.dialog("confirm")]
        router.pump()
        self.assertTrue(self.handled(harness)[-1][2]["accept"])
        self.assertIn("(accepted)", tab.run("1")["output"])

    def test_a_dialog_of_another_session_is_not_handled_by_this_tab(self):
        harness, router, tab = make_tab(self)
        event = self.dialog("confirm")
        event["session_id"] = "not-ours"
        harness.events = [event]
        router.pump()
        self.assertEqual(self.handled(harness), [])


class Network(unittest.TestCase):
    def request(self, session, rid, url, method="GET", kind="Fetch"):
        return {"method": "Network.requestWillBeSent", "session_id": session, "params": {"requestId": rid, "type": kind, "request": {"method": method, "url": url}}}

    def test_events_are_routed_by_session_and_filtered_by_the_network_helper(self):
        harness, router, tab = make_tab(self)
        harness.events = [self.request("owned-session", "r1", "http://x/save", "POST"), self.request("owned-session", "r2", "http://x/list"),
                          self.request("sentinel-session", "r3", "http://x/sentinel"),
                          {"method": "Network.responseReceived", "session_id": "owned-session", "params": {"requestId": "r1", "type": "Fetch", "response": {"url": "http://x/save", "status": 200, "mimeType": "application/json"}}}]
        router.pump()
        got = tab.run("[(r['method'], r['url'], r.get('status')) for r in network(method='post', urlContains='/save', status=200)]")["output"]
        self.assertIn("('POST', 'http://x/save', 200)", got)
        self.assertNotIn("sentinel", tab.run("[r['url'] for r in network()]")["output"])

    def test_network_rejects_unknown_filter_fields(self):
        _, _, tab = make_tab(self)
        self.assertEqual(tab.run("network(bogus=1)")["status"], "error")
        self.assertEqual(tab.run("network(status=99)")["status"], "error")


class Output(unittest.TestCase):
    def test_close_drops_the_namespace_and_stops_serving_events(self):
        harness, router, tab = make_tab(self)
        tab.close()
        self.assertNotIn("owned-session", router.tabs)

    def test_state_and_screenshot_entry_points_do_not_run_cell_code(self):
        harness, _, tab = make_tab(self)
        harness.answers["Page.getLayoutMetrics"] = {"cssVisualViewport": {"clientWidth": 2560, "clientHeight": 1000}, "cssContentSize": {"width": 2560, "height": 4000}}
        harness.answers["Page.captureScreenshot"] = {"data": "AAAA"}
        shot = tab.screenshot(full=False, max_width=1280)
        self.assertEqual(shot["data"], "AAAA")
        capture = [c for c in harness.calls if c[0] == "Page.captureScreenshot"][0]
        self.assertEqual(capture[2]["format"], "jpeg")
        self.assertAlmostEqual(capture[2]["clip"]["scale"], 0.5)
        full = tab.screenshot(full=True, max_width=1280)
        capture = [c for c in harness.calls if c[0] == "Page.captureScreenshot"][-1]
        self.assertTrue(capture[2]["captureBeyondViewport"])
        self.assertEqual(capture[2]["clip"]["height"], 4000)
        self.assertAlmostEqual(capture[2]["clip"]["scale"], 0.32)
        self.assertEqual(full["format"], "jpeg")


if __name__ == "__main__":
    unittest.main()
