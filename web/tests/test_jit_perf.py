import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('jit_perf', Path(__file__).parents[1] / 'scripts/analyse-jit-perf.py')
jit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jit)


def dump(pid, records):
    return struct.pack('<IIIIIIQQ', 0x4A695444, 1, 40, 62, 0, pid, 0, 0) + b''.join(records)


def code(pid, time, address, name):
    payload = struct.pack('<IIQQQQ', pid, pid, address, address, 4, 1) + name.encode() + b'\0' + b'\x90' * 4
    return struct.pack('<IIQ', 0, 16 + len(payload), time) + payload


class JitPerfTests(unittest.TestCase):
    def test_reuse_is_resolved_by_process_address_and_sample_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'leaf-samples.txt').write_text(
                '10/10 1.000000000: 10 1000 ([anon:v8])\n'
                '10/10 3.000000000: 20 1000 ([anon:v8])\n'
                '11/11 3.000000000: 30 1000 ([anon:v8])\n'
                '10/10 3.000000000: 40 1004 (unknown)\n')
            (root / 'jit-10.dump').write_bytes(dump(10, [code(10, 500000000, 0x1000, 'old'), code(10, 2000000000, 0x1000, 'new')]))
            (root / 'jit-11.dump').write_bytes(dump(11, [code(11, 500000000, 0x1000, 'other-process')]))
            (root / 'script.log').write_text('Warning: lost 2 chunks\n')
            result = jit.analyse(root)
            self.assertEqual(result['totalUserCycles'], 100)
            self.assertEqual({e['symbol']: e['percent'] for e in result['symbols']},
                             {'old': 10, 'new': 20, 'other-process': 30, 'unresolved: unknown': 40})
            self.assertIn('lost 2', result['perfScriptWarnings'])

    def test_thread_totals_include_leaves_outside_top_ten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'leaf-samples.txt').write_text(''.join(
                f'10/11 1.000000000: 1 {4096 + i:x} (mapping-{i})\n'
                for i in range(12)))
            result = jit.analyse(root)
            self.assertEqual(len(result['threads']['11']), 10)
            self.assertEqual(result['threadTotals']['11'],
                             dict(cycles=12, percent=100, omittedCycles=2))

    def test_future_code_is_not_attributed_and_truncation_is_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'leaf-samples.txt').write_text('10/10 1.000000000: 5 1000 ([anon:v8])\n')
            (root / 'jit-10.dump').write_bytes(dump(10, [code(10, 2000000000, 0x1000, 'future'), struct.pack('<IIQ', 0, 100, 0)]))
            result = jit.analyse(root)
            self.assertEqual(result['symbols'][0]['symbol'], 'unresolved: [anon:v8]')
            self.assertEqual(result['records']['truncated_tail'], 1)

    def test_unsupported_moves_and_empty_samples_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'leaf-samples.txt').write_text('not perf output')
            with self.assertRaisesRegex(ValueError, 'no leaf samples'):
                jit.analyse(root)
            (root / 'leaf-samples.txt').write_text('10/10 1.000000000: 5 1000 ([anon:v8])\n')
            (root / 'jit-10.dump').write_bytes(dump(10, [struct.pack('<IIQ', 1, 16, 0)]))
            with self.assertRaisesRegex(ValueError, 'code moves'):
                jit.analyse(root)


if __name__ == '__main__':
    unittest.main()
