import hashlib
import unittest
from pathlib import Path

PYTHON = Path(__file__).resolve().parents[1] / "python"
# browser-use 1.0.0, browser_use/ax.py (MIT). Replace the file and this pin together, never edit the file.
AX_SHA256 = "94dae4a9f7bc8f5bae02e377e14df46c343277ff0313c13837873dc1b98188df"


class Vendored(unittest.TestCase):
    def test_ax_is_the_pinned_upstream_file_byte_for_byte(self):
        self.assertEqual(hashlib.sha256((PYTHON / "ax.py").read_bytes()).hexdigest(), AX_SHA256)

    def test_the_notice_names_the_license_and_the_pin(self):
        notice = (PYTHON / "ax.NOTICE").read_text(encoding="utf-8")
        self.assertIn("MIT License", notice)
        self.assertIn(AX_SHA256, notice)
        self.assertIn("1.0.0", notice)


if __name__ == "__main__":
    unittest.main()
