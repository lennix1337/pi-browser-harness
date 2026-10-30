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

if __name__ == "__main__":
    unittest.main()
