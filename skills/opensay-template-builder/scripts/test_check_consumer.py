import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_consumer', Path(__file__).with_name('check_consumer.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdmissionWrapperTests(unittest.TestCase):
    def fixture(self, root, report, *, exit_code=0, mutate=False):
        template = root / 'template'
        (template / 'capability').mkdir(parents=True)
        manifest = template / 'capability/consumer.v1.json'
        manifest.write_text(json.dumps({'schema': 'opensay-consumer-v1', 'template_id': 'opensay.test'}))
        (root / '.opensay').mkdir()
        script = 'import json,sys\nfrom pathlib import Path\n'
        if mutate:
            script += f'Path({str(manifest)!r}).write_text("changed")\n'
        script += f'print(json.dumps({report!r}))\nsys.exit({exit_code})\n'
        (root / '.opensay/opensay.py').write_text(script)
        return template

    def test_shared_success_is_bound_to_current_contract(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            template = self.fixture(root, {'structure_valid': True, 'production_ready': True,
                                          'evidence_current': True, 'modules': ['one'], 'errors': []})
            result = module.check(template, modules=['one'])
            self.assertTrue(result['passed'])
            self.assertEqual(result['requested_modules'], ['one'])
            self.assertEqual(len(result['contract']['sha256']), 64)
            self.assertEqual(result['user_approval'], 'not_evaluated')

    def test_exit_zero_without_ready_or_current_evidence_is_rejected(self):
        for report in ({'passed': True}, {'structure_valid': True, 'production_ready': False, 'evidence_current': True},
                       {'structure_valid': True, 'production_ready': True, 'evidence_current': False}):
            with self.subTest(report=report), tempfile.TemporaryDirectory() as d:
                template = self.fixture(Path(d), report)
                self.assertFalse(module.check(template)['passed'])

    def test_nonzero_and_changed_contract_cannot_be_signed(self):
        for exit_code, mutate in ((2, False), (0, True)):
            with self.subTest(exit_code=exit_code, mutate=mutate), tempfile.TemporaryDirectory() as d:
                template = self.fixture(Path(d), {'structure_valid': True, 'production_ready': True,
                                                 'evidence_current': True, 'errors': []},
                                        exit_code=exit_code, mutate=mutate)
                self.assertFalse(module.check(template)['passed'])

    def test_missing_consumer_does_not_fallback_to_metadata(self):
        with tempfile.TemporaryDirectory() as d:
            template = Path(d) / 'template'
            template.mkdir()
            (template / 'capability.json').write_text('{"status":"ready"}')
            self.assertFalse(module.check(template)['passed'])


if __name__ == '__main__':
    unittest.main()
