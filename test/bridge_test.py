import importlib.util
from pathlib import Path
import tempfile
import unittest
import io
import json
import os
import socket
import sys
import types
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "python/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ENDPOINT = "http://127.0.0.1:9333"


def version_response():
    response = io.BytesIO(json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/test"}).encode())
    response.geturl = lambda: ENDPOINT + "/json/version"
    return response


class Boundaries(unittest.TestCase):
    def test_local_endpoint(self):
        for url in ["https://127.0.0.1:9222", "http://example.com", "http://user:password@127.0.0.1:9222", "http://127.0.0.1:9222/path", "http://127.0.0.1:9222/?q=1", "http://127.0.0.1:9222/#x"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                bridge.local_endpoint(url)
        self.assertEqual(bridge.local_endpoint("http://127.0.0.1:9222/"), "http://127.0.0.1:9222")

    def test_os_lock_releases_even_on_error(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "lock"
            with self.assertRaises(RuntimeError):
                with bridge.startup_lock(path):
                    raise RuntimeError("interrupted")
            with bridge.startup_lock(path):
                pass

    def test_redirect_is_refused_before_network_follow(self):
        with self.assertRaises(ValueError):
            bridge.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://example.com/")

    def test_the_one_shot_path_is_gone(self):
        self.assertFalse(hasattr(bridge, "main"), "one request per process was removed; the persistent worker is the only path")
        self.assertFalse(hasattr(bridge, "act"))


class Serve(unittest.TestCase):
    """Persistent worker: one hello, then JSON-line requests answered by id on the same channel."""

    def run_worker(self, messages, root, answers=None, urlopen=None):
        inbox = [(json.dumps(message) + "\n").encode() for message in messages]
        outbox, calls = [], []
        answers = answers or {}

        def cdp(method, session_id=None, _response_timeout=5.0, **params):
            calls.append((method, session_id, params))
            answer = answers.get(method, {})
            if isinstance(answer, Exception):
                raise answer
            return answer(params) if callable(answer) else answer

        def send(request, response_timeout=5.0):
            return {"events": []}

        def read():
            return inbox.pop(0) if inbox else b""
        with patch.dict(os.environ, {"PI_BROWSER_HARNESS_HOME": root}), patch.object(bridge, "build_opener") as opener, \
                patch("browser_harness.admin.ensure_daemon") as ensure, patch("browser_harness.helpers.cdp", cdp), \
                patch("browser_harness.helpers._send", send):
            opener.return_value.open.side_effect = urlopen or (lambda *args, **kwargs: version_response())
            code = bridge.serve(read, outbox.append)
        return code, outbox, calls, ensure

    hello = {"id": 0, "control": "hello", "endpoint": ENDPOINT}
    page = {"Target.getTargetInfo": {"targetInfo": {"url": "http://127.0.0.1:8080/p"}}}

    def cell(self, i, code, **extra):
        return {"id": i, "action": "exec", "endpoint": ENDPOINT, "target": "owned", "session": "s", "code": code, **extra}

    def test_hello_configures_the_endpoint_runtime_and_acknowledges_by_id(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, calls, _ = self.run_worker([self.hello], root)
            self.assertEqual(code, 0)
            self.assertEqual(outbox, [{"id": 0, "control": "ready"}])
            self.assertEqual(calls, [])
            runtime = Path(root) / bridge.hashlib.sha256(ENDPOINT.encode()).hexdigest()[:16]
            self.assertTrue(runtime.is_dir())

    def test_ping_answers_without_verifying_or_touching_the_browser(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, calls, ensure = self.run_worker([self.hello, {"id": 7, "control": "ping"}], root)
            self.assertEqual(outbox[1], {"id": 7, "ok": True, "control": "pong"})
            self.assertEqual(calls, [])
            self.assertEqual(ensure.call_count, 0)

    def test_open_creates_a_background_tab_enables_its_domains_and_returns_identity(self):
        answers = {**self.page, "Target.createTarget": {"targetId": "owned"}, "Target.attachToTarget": {"sessionId": "s"}}
        with tempfile.TemporaryDirectory() as root:
            _, outbox, calls, ensure = self.run_worker([self.hello, {"id": 1, "action": "open", "endpoint": ENDPOINT}], root, answers)
            self.assertEqual(outbox[1]["result"], {"target": "owned", "session": "s"})
            methods = [(m, s) for m, s, _ in calls]
            self.assertEqual(methods[:2], [("Target.createTarget", None), ("Target.attachToTarget", None)])
            enabled = {m for m, s in methods if s == "s"}
            self.assertTrue({"Page.enable", "Network.enable", "DOM.enable", "Runtime.enable"} <= enabled)
            self.assertEqual(ensure.call_count, 1)

    def test_a_background_tab_is_not_throttled_because_it_is_told_it_has_focus(self):
        # A hidden tab runs chained timers about once a second (10 ms asked, ~1000 ms measured): waits in cells would crawl.
        answers = {**self.page, "Target.createTarget": {"targetId": "owned"}, "Target.attachToTarget": {"sessionId": "s"}}
        with tempfile.TemporaryDirectory() as root:
            _, outbox, calls, _ = self.run_worker([self.hello, {"id": 1, "action": "open", "endpoint": ENDPOINT}], root, answers)
            self.assertTrue(outbox[1]["ok"])
            self.assertIn(("Emulation.setFocusEmulationEnabled", "s", {"enabled": True}), calls)
            self.assertEqual(calls[0][2].get("background"), True, "the tab still opens in the background")

    def test_cells_on_one_tab_share_variables_across_requests_and_each_reply_carries_its_id(self):
        with tempfile.TemporaryDirectory() as root:
            _, outbox, _, _ = self.run_worker([self.hello, self.cell(1, "n = 20"), self.cell(2, "n + 22")], root, self.page)
            self.assertEqual([reply["id"] for reply in outbox], [0, 1, 2])
            self.assertEqual(outbox[2]["result"]["output"], "42\n")
            self.assertEqual(outbox[2]["result"]["url"], "http://127.0.0.1:8080/p")

    def test_a_cell_error_is_an_ok_reply_carrying_status_error_and_the_worker_keeps_serving(self):
        with tempfile.TemporaryDirectory() as root:
            _, outbox, _, _ = self.run_worker([self.hello, self.cell(1, "1/0"), {"id": 2, "control": "ping"}], root, self.page)
            self.assertTrue(outbox[1]["ok"])
            self.assertEqual(outbox[1]["result"]["status"], "error")
            self.assertEqual(outbox[2]["control"], "pong")

    def test_close_closes_the_target_and_forgets_the_namespace(self):
        with tempfile.TemporaryDirectory() as root:
            close = {"id": 2, "action": "close", "endpoint": ENDPOINT, "target": "owned", "session": "s"}
            answers = {**self.page, "Target.closeTarget": {"success": True}}
            _, outbox, calls, _ = self.run_worker([self.hello, self.cell(1, "n = 1"), close, self.cell(3, "n")], root, answers)
            self.assertEqual(outbox[2]["result"], {"success": True})
            self.assertIn(("Target.closeTarget", None, {"targetId": "owned"}), calls)
            self.assertEqual(outbox[3]["result"]["status"], "error", "variables did not survive the close")

    def test_a_session_that_ended_with_its_bridge_is_named_as_such_and_its_tab_can_still_be_closed(self):
        gone = RuntimeError("{'code': -32001, 'message': 'Session with given id not found.'}")
        with tempfile.TemporaryDirectory() as root:
            close = {"id": 2, "action": "close", "endpoint": ENDPOINT, "target": "owned", "session": "s"}
            answers = {**self.page, "Runtime.evaluate": gone, "Target.closeTarget": {"success": True}}
            _, outbox, calls, _ = self.run_worker([self.hello, self.cell(1, "n = 1"), close], root, answers)
            self.assertFalse(outbox[1]["ok"])
            self.assertIn("ended with its bridge worker", outbox[1]["error"])
            self.assertEqual(outbox[2]["result"], {"success": True})
            self.assertIn(("Target.closeTarget", None, {"targetId": "owned"}), calls)

    def test_the_removed_actions_are_refused_by_the_worker_too(self):
        with tempfile.TemporaryDirectory() as root:
            for action in ["evaluate", "navigate", "inspect", "click", "network", "intercept_start"]:
                _, outbox, calls, _ = self.run_worker([self.hello, {"id": 1, "action": action, "endpoint": ENDPOINT, "target": "owned", "session": "s"}], root)
                self.assertFalse(outbox[1]["ok"], action)
                self.assertIn("exec", outbox[1]["error"])
                self.assertEqual(calls, [])

    def test_screenshot_returns_a_jpeg_scaled_to_the_longest_side(self):
        answers = {**self.page, "Page.getLayoutMetrics": {"cssVisualViewport": {"clientWidth": 2000, "clientHeight": 1000}}, "Page.captureScreenshot": {"data": "AAAA"}}
        request = {"id": 1, "action": "screenshot", "endpoint": ENDPOINT, "target": "owned", "session": "s", "full": False, "maxWidth": 1000}
        with tempfile.TemporaryDirectory() as root:
            _, outbox, calls, _ = self.run_worker([self.hello, request], root, answers)
            self.assertEqual(outbox[1]["result"]["format"], "jpeg")
            shot = [params for method, session, params in calls if method == "Page.captureScreenshot"][0]
            self.assertEqual(shot["clip"]["scale"], 0.5)

    def test_a_request_for_another_endpoint_is_refused_and_the_worker_keeps_serving(self):
        with tempfile.TemporaryDirectory() as root:
            other = {**self.cell(1, "1"), "endpoint": "http://127.0.0.1:9444"}
            _, outbox, calls, _ = self.run_worker([self.hello, other, {"id": 2, "control": "ping"}], root)
            self.assertFalse(outbox[1]["ok"])
            self.assertIn("does not match", outbox[1]["error"])
            self.assertEqual(outbox[2]["control"], "pong")
            self.assertEqual(calls, [])

    def test_a_non_loopback_endpoint_fails_the_hello_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, _, _ = self.run_worker([{"id": 0, "control": "hello", "endpoint": "https://example.com"}], root)
            self.assertEqual(code, 1)
            self.assertEqual(outbox[0]["control"], "error")
            self.assertIn("loopback", outbox[0]["error"].lower())

    def test_an_endpoint_check_that_times_out_is_retried_once_because_nothing_was_dispatched(self):
        attempts = []

        def flaky(*args, **kwargs):
            attempts.append(1)
            if len(attempts) == 1:
                raise socket.timeout("timed out")
            return version_response()
        with tempfile.TemporaryDirectory() as root:
            _, outbox, _, _ = self.run_worker([self.hello, self.cell(1, "1")], root, self.page, urlopen=flaky)
            self.assertTrue(outbox[1]["ok"])
            self.assertEqual(len(attempts), 2)

    def test_a_second_endpoint_timeout_is_an_error_and_no_cell_ran(self):
        def down(*args, **kwargs):
            raise socket.timeout("timed out")
        with tempfile.TemporaryDirectory() as root:
            _, outbox, calls, _ = self.run_worker([self.hello, self.cell(1, "1")], root, self.page, urlopen=down)
            self.assertFalse(outbox[1]["ok"])
            self.assertEqual(calls, [])

    def test_a_cell_is_never_run_twice_even_when_it_fails_with_a_transport_error(self):
        runs = []
        with tempfile.TemporaryDirectory() as root:
            def failing(params):
                runs.append(1)
                raise RuntimeError("socket closed")
            answers = {**self.page, "Input.dispatchMouseEvent": failing}
            _, outbox, _, _ = self.run_worker([self.hello, self.cell(1, "cdp('Input.dispatchMouseEvent', type='mousePressed', x=1, y=1)")], root, answers)
            self.assertEqual(len(runs), 1)
            self.assertEqual(outbox[1]["result"]["status"], "outcome_uncertain")

    def test_configure_sets_the_runtime_and_drops_cloud_and_telemetry_settings(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"PI_BROWSER_HARNESS_HOME": root, "BROWSER_USE_API_KEY": "secret", "BU_CDP_WS": "ws://elsewhere"}):
            bridge.configure(ENDPOINT)
            self.assertNotIn("BROWSER_USE_API_KEY", os.environ)
            self.assertNotIn("BU_CDP_WS", os.environ)
            self.assertEqual(os.environ["BH_TELEMETRY"], "0")
            self.assertEqual(os.environ["BH_RECORD"], "0")
            self.assertEqual(os.environ["BU_CDP_URL"], ENDPOINT)

    def test_the_worker_ends_its_own_daemon_when_it_stops(self):
        sent = []
        worker = bridge.Worker(ENDPOINT)
        worker.release_daemon()  # no router yet: nothing was started, nothing to stop
        worker.router = types.SimpleNamespace(tabs={}, helpers=types.SimpleNamespace(_send=sent.append))
        worker.release_daemon()
        self.assertEqual(sent, [{"meta": "shutdown"}])
        worker.router.helpers._send = lambda request: (_ for _ in ()).throw(OSError("gone"))
        worker.release_daemon()  # a daemon already gone is not an error

    def test_each_session_talks_to_its_own_daemon(self):
        # A daemon has one event buffer and reading empties it: two sessions on one daemon would steal each other's events.
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"PI_BROWSER_HARNESS_HOME": root, "PI_BROWSER_HARNESS_DAEMON": "pi-1a2b3c4d"}):
            bridge.configure(ENDPOINT)
            self.assertEqual(os.environ["BU_NAME"], "pi-1a2b3c4d")
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"PI_BROWSER_HARNESS_HOME": root, "PI_BROWSER_HARNESS_DAEMON": "../escape"}):
            with self.assertRaises(ValueError):
                bridge.configure(ENDPOINT)

    def test_type_builtin_works_inside_a_cell(self):
        with tempfile.TemporaryDirectory() as root:
            _, outbox, _, _ = self.run_worker(
                [self.hello, self.cell(1, "type(42).__name__"), self.cell(2, "type('Dyn', (), {'x': 7}).x")],
                root,
                self.page,
            )
            self.assertEqual(outbox[1]["result"]["status"], "ok")
            self.assertEqual(outbox[1]["result"]["output"], "'int'\n")
            self.assertEqual(outbox[2]["result"]["status"], "ok")
            self.assertEqual(outbox[2]["result"]["output"], "7\n")


class TypeDispatch(unittest.TestCase):
    def test_dispatches_builtin_type_and_tab_helper(self):
        import repl

        calls = []

        def helper(id, text, enter=False):
            calls.append((id, text, enter))
            return f"typed:{id}:{text}:{enter}"

        self.assertIs(repl._type_dispatch(helper, 123), int)
        cls = repl._type_dispatch(helper, "Dyn", (), {"x": 7})
        self.assertIsInstance(cls, type)
        self.assertEqual(cls.x, 7)
        self.assertEqual(calls, [])

        self.assertEqual(repl._type_dispatch(helper, 5, "hello"), "typed:5:hello:False")
        self.assertEqual(repl._type_dispatch(helper, 5, "hello", True), "typed:5:hello:True")
        self.assertEqual(repl._type_dispatch(helper, 5, text="hi", enter=True), "typed:5:hi:True")
        self.assertEqual(repl._type_dispatch(helper, 5, text="only-kw"), "typed:5:only-kw:False")
        self.assertEqual(
            calls,
            [(5, "hello", False), (5, "hello", True), (5, "hi", True), (5, "only-kw", False)],
        )


if __name__ == "__main__":
    unittest.main()
