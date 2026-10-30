import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "python/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

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

if __name__ == "__main__":
    unittest.main()
