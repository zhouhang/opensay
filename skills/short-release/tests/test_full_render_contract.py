"""Producer QC must be consumable by the release handoff without forged translation."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from test_release_package import make_handoff, builder, sha256, write_json

path = Path.home()/'.codex/skills/full-render/scripts/full_render.py'
spec = importlib.util.spec_from_file_location('producer_qc',path)
qc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qc)

class FullRenderContractTests(unittest.TestCase):
    def fixture(self, root, passed=True):
        handoff = json.loads(make_handoff(root).read_text())
        video = Path(handoff['video'])
        report = qc.qc_payload(video,sha256(video),[{'name':'fixture','passed':passed}])
        write_json(Path(handoff['release_media_validation']), report)
        return handoff

    def test_actual_producer_schema_consumed(self):
        with tempfile.TemporaryDirectory() as td:
            handoff = self.fixture(Path(td))
            self.assertEqual(builder.validate_handoff(handoff)['video'],Path(handoff['video']))

    def test_failed_qc_blocks_package(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(builder.HandoffError):
                builder.validate_handoff(self.fixture(Path(td),False))

    def test_changed_bytes_after_qc_block(self):
        with tempfile.TemporaryDirectory() as td:
            handoff = self.fixture(Path(td))
            Path(handoff['video']).write_bytes(b'changed-test-fixture')
            with self.assertRaises(builder.HandoffError):
                builder.validate_handoff(handoff)

    def test_late_relocation_requires_new_validation(self):
        with tempfile.TemporaryDirectory() as td:
            handoff = self.fixture(Path(td))
            destination = Path(td)/'archived.mp4'
            destination.write_bytes(Path(handoff['video']).read_bytes())
            handoff['video'] = str(destination)
            with self.assertRaises(builder.HandoffError):
                builder.validate_handoff(handoff)

if __name__ == '__main__':
    unittest.main()
