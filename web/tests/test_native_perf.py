import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_perf", Path(__file__).parents[1] / "scripts/analyse-native-perf.py")
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


class NativePerfTests(unittest.TestCase):
    def test_unresolved_samples_remain_in_weighted_denominator(self):
        samples = perf.parse_leaves("1/2 10.123: 300 abc (/lib/c.so+0x100)\n1/3 10.124: 100 def ([anon:v8])\n")
        result = perf.summarize(samples, {"/lib/c.so": {0x100: "memcpy"}})
        self.assertEqual(result["samples"], 2)
        self.assertEqual(result["totalUserCycles"], 400)
        self.assertEqual(result["resolvedNativePercent"], 75)
        self.assertEqual(result["symbols"][1]["percent"], 25)
        self.assertEqual(result["threads"]["2"]["cycles"], 300)
        self.assertEqual(result["threads"]["3"]["percent"], 25)
        self.assertEqual(sum(t["cycles"] for t in result["threads"].values()), 400)

    def test_zero_offset_and_malformed_input(self):
        sample = perf.parse_leaves("1/2 10.1: 1 abc (/path with spaces/lib.so+0x0)")[0]
        self.assertEqual(sample["offset"], 0)
        self.assertEqual(sample["dso"], "/path with spaces/lib.so")
        with self.assertRaises(ValueError):
            perf.parse_leaves("unexpected output")

    def test_unknown_symbol_does_not_become_resolved(self):
        samples = perf.parse_leaves("1/2 10.1: 20 abc (/lib/c.so+0x100)")
        self.assertEqual(perf.summarize(samples, {})["resolvedNativePercent"], 0)

    def test_rejects_debug_symbols_from_another_build(self):
        with patch.object(perf.subprocess, "check_output", return_value="Build ID: abc123\n"):
            perf.check_build_id("/chrome", "chrome.debug", {"/chrome": "abc123"})
            with self.assertRaises(ValueError):
                perf.check_build_id("/chrome", "chrome.debug", {"/chrome": "bad123"})
            with self.assertRaises(ValueError):
                perf.check_build_id("/chrome", "chrome.debug", {})

    def test_dso_file_offsets_are_translated_to_elf_virtual_addresses(self):
        # Chrome's executable segment has a 4096-byte file/virtual displacement.
        segments = [(0, 0, 0x100), (0x1000, 0x2000, 0x3000)]
        self.assertEqual(perf.virtual_address(0x1012, segments), 0x2012)
        self.assertEqual(perf.virtual_address(0, segments), 0)
        with self.assertRaises(ValueError):
            perf.virtual_address(0x100, segments)
        with self.assertRaises(ValueError):
            perf.virtual_address(0x4000, segments)


if __name__ == "__main__":
    unittest.main()
