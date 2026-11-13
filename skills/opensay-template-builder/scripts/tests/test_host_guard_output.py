"""Exercise the real CLI output path in isolated files; no production writes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'host_guard.py'
SCHEMA = 'opensay-builder-host-context-v1'


class HostReportOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='opensay-host-output-test-')
        self.root = Path(self.temp.name)
        self.library = self.root / 'library'
        self.library.mkdir()
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, destination, refresh=False, library=None):
        args = [sys.executable, str(SCRIPT), '--report', str(destination), '--library-root', str(library or self.library)]
        if refresh:
            args.append('--refresh-report')
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return result, json.loads(result.stdout)

    def assert_rejected_unchanged(self, path, refresh=False):
        original = path.read_bytes()
        result, payload = self.run_cli(path, refresh=refresh)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertFalse(payload['report_written'])
        self.assertEqual(path.read_bytes(), original)

    def test_create_new_report(self):
        path = self.work / 'context.json'
        result, payload = self.run_cli(path)
        self.assertIn(result.returncode, [0, 3], result.stdout + result.stderr)
        self.assertEqual(json.loads(path.read_text())['schema'], SCHEMA)
        self.assertFalse(payload['authenticated'])

    def test_existing_report_needs_explicit_refresh(self):
        path = self.work / 'context.json'
        path.write_text(json.dumps({'schema': SCHEMA, 'old': 'preserve-unless-explicit'}))
        self.assert_rejected_unchanged(path)
        result, _ = self.run_cli(path, refresh=True)
        self.assertIn(result.returncode, [0, 3])
        self.assertEqual(json.loads(path.read_text())['schema'], SCHEMA)
        self.assertNotIn('old', json.loads(path.read_text()))

    def test_capability_file_never_overwritten(self):
        path = self.work / 'capability.json'
        path.write_text('{"schema":"opensay-template-capability-v1","important":true}')
        self.assert_rejected_unchanged(path)
        self.assert_rejected_unchanged(path, refresh=True)

    def test_other_schema_and_non_json_never_overwritten(self):
        for name, data in [('different.json', '{"schema":"another-report-v1"}'), ('source.txt', 'keep source bytes')]:
            with self.subTest(name=name):
                path = self.work / name
                path.write_text(data)
                self.assert_rejected_unchanged(path)
                self.assert_rejected_unchanged(path, refresh=True)

    def test_new_output_and_existing_same_schema_inside_library_rejected(self):
        for refresh in [False, True]:
            with self.subTest(refresh=refresh):
                path = self.library / 'context.json'
                if refresh:
                    path.write_text(json.dumps({'schema': SCHEMA}))
                    self.assert_rejected_unchanged(path, refresh=True)
                else:
                    result, _ = self.run_cli(path)
                    self.assertEqual(result.returncode, 2)
                    self.assertFalse(path.exists())

    def test_parent_symlink_into_library_cannot_bypass(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.library, target_is_directory=True)
        destination = alias / 'context.json'
        result, _ = self.run_cli(destination)
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.library / 'context.json').exists())

    def test_symlink_to_existing_file_rejected(self):
        actual = self.work / 'real.json'
        actual.write_text(json.dumps({'schema': SCHEMA, 'preserve': True}))
        alias = self.work / 'alias.json'
        alias.symlink_to(actual)
        self.assert_rejected_unchanged(alias)
        self.assert_rejected_unchanged(alias, refresh=True)

    def test_custom_template_marker_protected_without_root_argument(self):
        custom = self.root / 'custom-template'
        custom.mkdir()
        (custom / 'capability.json').write_text('{"schema":"template"}')
        destination = custom / 'nested/context.json'
        result, _ = self.run_cli(destination)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(destination.exists())

    def test_hardlinked_report_cannot_refresh_another_file(self):
        actual = self.work / 'real.json'
        actual.write_text(json.dumps({'schema': SCHEMA, 'preserve': True}))
        alias = self.work / 'hardlink.json'
        os.link(actual, alias)
        self.assert_rejected_unchanged(alias, refresh=True)

    def test_refresh_missing_file_is_not_creation(self):
        destination = self.work / 'missing.json'
        result, _ = self.run_cli(destination, refresh=True)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(destination.exists())


if __name__ == '__main__':
    unittest.main()
