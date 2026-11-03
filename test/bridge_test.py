import importlib.util
from pathlib import Path
import tempfile
import unittest
import io
import json
import os
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "python/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class Boundaries(unittest.TestCase):
    def test_screenshot_preserves_explicit_session_and_upstream_operation_timeout(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"BH_HOME": root, "PI_BROWSER_HARNESS_HOME": root}):
            from browser_harness import admin, helpers
            response = io.BytesIO(json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/test"}).encode())
            response.geturl = lambda: "http://127.0.0.1:9333/json/version"
            calls = []
            def cdp(method, **params):
                calls.append((method, params))
                return {"data": "fakepng"}
            with patch.object(bridge, "build_opener") as opener, patch.object(admin, "ensure_daemon"), patch.object(helpers, "cdp", cdp):
                opener.return_value.open.return_value = response
                result = bridge.main({"action": "screenshot", "endpoint": "http://127.0.0.1:9333", "target": "owned", "session": "owned-session"})
            self.assertEqual(result, {"data": "fakepng"})
            method, params = calls[0]
            self.assertEqual(method, "Page.captureScreenshot")
            self.assertEqual(params["session_id"], "owned-session")
            self.assertEqual(params["_response_timeout"], helpers.SCREENSHOT_IPC_RESPONSE_TIMEOUT_SECONDS)
            self.assertEqual(len(calls), 1)

    def test_slow_page_actions_get_a_longer_ipc_budget_than_the_5s_default(self):
        # evaluate (awaited promises) and navigate routinely outlast the 5s daemon default; a timeout there
        # leaves the effect uncertain even though the page was still working.
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"BH_HOME": root, "PI_BROWSER_HARNESS_HOME": root}):
            from browser_harness import admin, helpers
            for action, extra, method in [("evaluate", {"expression": "1"}, "Runtime.evaluate"), ("navigate", {"url": "about:blank"}, "Page.navigate")]:
                with self.subTest(action=action):
                    calls = []
                    def cdp(m, **params):
                        calls.append((m, params))
                        return {"result": {"value": 1}}
                    with patch.object(bridge, "build_opener") as opener, patch.object(admin, "ensure_daemon"), patch.object(helpers, "cdp", cdp):
                        opener.return_value.open.return_value = version_response()
                        bridge.main({"action": action, "endpoint": ENDPOINT, "target": "owned", "session": "s", **extra})
                    self.assertEqual(calls[0][0], method)
                    self.assertGreater(calls[0][1]["_response_timeout"], helpers.DEFAULT_IPC_RESPONSE_TIMEOUT_SECONDS)
                    self.assertLess(calls[0][1]["_response_timeout"], 45)

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


ENDPOINT = "http://127.0.0.1:9333"

def version_response():
    response = io.BytesIO(json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/test"}).encode())
    response.geturl = lambda: ENDPOINT + "/json/version"
    return response

class Serve(unittest.TestCase):
    """Persistent worker: one hello, then JSON-line requests answered by id on the same channel."""

    def run_worker(self, messages, root, evaluate=None):
        inbox = [(json.dumps(message) + "\n").encode() for message in messages]
        outbox = []
        calls = []
        def cdp(method, **params):
            calls.append((method, params))
            if evaluate is not None:
                return evaluate(method, params)
            return {"result": {"type": "number", "value": 2}}
        def read():
            return inbox.pop(0) if inbox else b""
        with patch.dict(os.environ, {"PI_BROWSER_HARNESS_HOME": root}), patch.object(bridge, "build_opener") as opener, \
                patch("browser_harness.admin.ensure_daemon") as ensure, patch("browser_harness.helpers.cdp", cdp):
            opener.return_value.open.side_effect = lambda *args, **kwargs: version_response()
            code = bridge.serve(read, outbox.append)
        return code, outbox, calls, ensure

    def test_hello_configures_the_endpoint_runtime_and_acknowledges_by_id(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, calls, _ = self.run_worker([{"id": 0, "control": "hello", "endpoint": ENDPOINT}], root)
            self.assertEqual(code, 0)
            self.assertEqual(outbox, [{"id": 0, "control": "ready"}])
            self.assertEqual(calls, [])
            runtime = Path(root) / bridge.hashlib.sha256(ENDPOINT.encode()).hexdigest()[:16]
            self.assertTrue(runtime.is_dir(), "the worker uses the same per-endpoint runtime as the one-shot call")

    def test_many_actions_reuse_one_worker_and_each_reply_carries_its_request_id(self):
        with tempfile.TemporaryDirectory() as root:
            hello = {"id": 0, "control": "hello", "endpoint": ENDPOINT}
            evaluate = lambda i: {"id": i, "action": "evaluate", "endpoint": ENDPOINT, "target": "owned", "session": "s", "expression": "1"}
            code, outbox, calls, ensure = self.run_worker([hello, evaluate(1), evaluate(2)], root)
            self.assertEqual(code, 0)
            self.assertEqual([reply["id"] for reply in outbox], [0, 1, 2])
            self.assertTrue(all(reply["ok"] for reply in outbox[1:]))
            self.assertEqual(outbox[1]["result"]["value"], 2)
            self.assertEqual(ensure.call_count, 2, "each action still self-heals the daemon before dispatch")
            self.assertEqual([method for method, _ in calls], ["Runtime.evaluate", "Runtime.evaluate"])

    def test_ping_answers_without_verifying_or_touching_the_browser(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, calls, ensure = self.run_worker([{"id": 0, "control": "hello", "endpoint": ENDPOINT}, {"id": 7, "control": "ping"}], root)
            self.assertEqual(outbox[1], {"id": 7, "ok": True, "control": "pong"})
            self.assertEqual(calls, [])
            self.assertEqual(ensure.call_count, 0)

    def test_a_request_for_another_endpoint_is_refused_and_the_worker_keeps_serving(self):
        with tempfile.TemporaryDirectory() as root:
            other = {"id": 1, "action": "inspect", "endpoint": "http://127.0.0.1:9444", "target": "t", "session": "s"}
            code, outbox, calls, _ = self.run_worker([{"id": 0, "control": "hello", "endpoint": ENDPOINT}, other, {"id": 2, "control": "ping"}], root)
            self.assertFalse(outbox[1]["ok"])
            self.assertIn("does not match", outbox[1]["error"])
            self.assertEqual(outbox[2]["control"], "pong")
            self.assertEqual(calls, [])

    def test_a_failed_action_is_one_error_reply_and_the_worker_keeps_serving(self):
        def fail(method, params):
            raise RuntimeError("No target with given id found")
        with tempfile.TemporaryDirectory() as root:
            evaluate = {"id": 1, "action": "evaluate", "endpoint": ENDPOINT, "target": "gone", "session": "s", "expression": "1"}
            code, outbox, calls, _ = self.run_worker([{"id": 0, "control": "hello", "endpoint": ENDPOINT}, evaluate, {"id": 2, "control": "ping"}], root, evaluate=fail)
            self.assertEqual(code, 0)
            self.assertEqual(outbox[1], {"id": 1, "ok": False, "error": "No target with given id found"})
            self.assertEqual(outbox[2]["control"], "pong")

    def test_a_non_loopback_endpoint_fails_the_hello_and_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as root:
            code, outbox, _, _ = self.run_worker([{"id": 0, "control": "hello", "endpoint": "https://example.com"}], root)
            self.assertEqual(code, 1)
            self.assertEqual(outbox[0]["control"], "error")
            self.assertIn("loopback", outbox[0]["error"].lower())

if __name__ == "__main__":
    unittest.main()
