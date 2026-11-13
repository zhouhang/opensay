import json
from pathlib import Path
import subprocess
import tempfile
import unittest

KIT = Path(__file__).with_name('segment-kit')


class SegmentResolveTests(unittest.TestCase):
    def resolve(self, *, states, verified=False, assets=None):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            probe = {'templateId': 'fixture', 'rendererSha256': '0'*64,
                     'canvas': {'width': 1920, 'height': 1080, 'fps': 30},
                     'segments': [{'id': 'shot', 'states': [{'at': t} for t in states],
                                   'settleSeconds': states[-1] if states else 0,
                                   'ambient': False, 'suggestedShot': {'min': 2.5, 'ideal': 4, 'max': 8},
                                   'assetSlots': assets or ['text', 'image'],
                                   'assetSlotsVerified': verified, 'probeConfidence': 'high',
                                   'changeRate': 1, 'bottomOccupancy': 0}]}
            (root/'probe.json').write_text(json.dumps(probe))
            result = subprocess.run(['node', str(KIT/'resolve/resolve.mjs'), '--probe', str(root/'probe.json'),
                                     '--out', str(root/'resolved.json'), '--report', str(root/'report.json')],
                                    text=True, capture_output=True, check=False)
            return result.returncode, json.loads((root/'resolved.json').read_text()), json.loads((root/'report.json').read_text())

    def test_measured_long_gap_is_not_silently_accepted(self):
        code, resolved, report = self.resolve(states=[0.1, 9], verified=True)
        self.assertNotEqual(code, 0)
        self.assertFalse(report['production_ready'])
        self.assertEqual(report['segments'][0]['status'], 'needs-review')
        self.assertAlmostEqual(report['segments'][0]['cadenceGaps'][0]['seconds'], 8.9)
        self.assertNotIn('maxGapBetweenChanges', resolved['segments'][0]['policyApplied'])

    def test_source_slot_hints_do_not_become_proven_capabilities(self):
        code, resolved, report = self.resolve(states=[.1, 1.5, 2.9], verified=False)
        self.assertEqual(code, 0)  # Probe/resolve can complete while production is pending.
        self.assertFalse(report['production_ready'])
        self.assertEqual(resolved['segments'][0]['assetSlots'], [])
        self.assertFalse(resolved['segments'][0]['assetSlotsVerified'])

    def test_verified_slots_and_valid_cadence_are_preserved(self):
        code, resolved, report = self.resolve(states=[.1, 1.5, 2.9], verified=True, assets=['text'])
        self.assertEqual(code, 0)
        self.assertFalse(report['production_ready'])
        self.assertEqual(report['segments'][0]['status'], 'diagnostic-ok')
        self.assertEqual(resolved['segments'][0]['assetSlots'], ['text'])

    def test_regex_result_is_explicitly_a_candidate(self):
        snippet = f"import {{slotCandidates}} from {json.dumps((KIT/'probe/slot-candidates.mjs').as_uri())};console.log(JSON.stringify(slotCandidates('new Image(); document.createElement(\\\"video\\\")','x:number')));"
        result = subprocess.run(['node', '--input-type=module', '-e', snippet], text=True, capture_output=True, check=True)
        self.assertEqual(set(json.loads(result.stdout)), {'text', 'number', 'image', 'video'})


if __name__ == '__main__':
    unittest.main()
