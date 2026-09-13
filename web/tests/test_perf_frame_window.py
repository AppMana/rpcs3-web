import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('window', Path(__file__).parents[1] / 'scripts/perf-frame-window.py')
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


class FrameWindowTests(unittest.TestCase):
    def test_native_and_browser_boundaries_use_the_same_clock(self):
        native = {'flips': {'frames': [{'emuFlipId': 10, 'monotonicUs': 1000000},
                                      {'emuFlipId': 20, 'monotonicUs': 2000000}]}}
        browser = {'clock': {'offsetUs': -9000000, 'uncertaintyUs': 50},
                   'flipTimings': [{'emuFlipId': 10, 'hostTimeMs': 10000},
                                   {'emuFlipId': 20, 'hostTimeMs': 11000}]}
        a, b = window.boundaries(native, 10, 20), window.boundaries(browser, 10, 20)
        self.assertEqual(a['startSeconds'], b['startSeconds'])
        self.assertEqual(a['endSeconds'], b['endSeconds'])
        self.assertEqual(b['clockUncertaintyUs'], 50)
        browser['perfWindow'] = {'startedAtFrame': 11}
        with self.assertRaisesRegex(ValueError, 'does not cover'):
            window.boundaries(browser, 10, 20)

    def test_filter_is_half_open_and_rejects_uncovered_windows(self):
        text = '\n'.join(f'1/2 {t:.9f}: 100 1000 (module)' for t in [0.5, 1, 1.5, 2, 3])
        selected, count = window.select_samples(text, {'startSeconds': 1, 'endSeconds': 2})
        self.assertEqual(count, 2)
        self.assertIn('1.000000000:', selected)
        self.assertNotIn('2.000000000:', selected)
        with self.assertRaisesRegex(ValueError, 'bracket'):
            window.select_samples(text, {'startSeconds': 0, 'endSeconds': 2})

    def test_missing_duplicate_and_dropped_boundaries_fail(self):
        report = {'flips': {'frames': [{'emuFlipId': 10, 'monotonicUs': 1000000}]}}
        with self.assertRaisesRegex(ValueError, 'missing'):
            window.boundaries(report, 10, 20)
        report['flips']['frames'] *= 2
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            window.boundaries(report, 10, 20)
        report['flips']['dropped'] = 1
        with self.assertRaisesRegex(ValueError, 'drops'):
            window.boundaries(report, 10, 20)


if __name__ == '__main__':
    unittest.main()
