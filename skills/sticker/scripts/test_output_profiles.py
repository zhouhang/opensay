"""Stage changes must preserve real time and never replay stale frame clocks."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).with_name('output_profiles.py')
spec = importlib.util.spec_from_file_location('output_profiles', MODULE)
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)


class OutputProfilesTests(unittest.TestCase):
    def test_preserves_confirmed_orientation_for_both_stages(self):
        cases = {
            '16:9': ((1920, 1080), (1920, 1080)),
            '9:16': ((1080, 1920), (1080, 1920)),
            '3:4': ((1080, 1440), (1080, 1440)),
            '1:1': ((1080, 1080), (1080, 1080)),
        }
        for ratio, (sample, full) in cases.items():
            with self.subTest(ratio=ratio):
                result = profiles.resolve_profiles({'aspect_ratio': ratio})
                for stage, size, fps in [('sample', sample, 30), ('full', full, 30)]:
                    self.assertEqual(result[stage], dict(width=size[0], height=size[1], fps=fps))

    def test_missing_orientation_is_not_defaulted(self):
        with self.assertRaisesRegex(ValueError, 'do not guess orientation'):
            profiles.resolve_profiles({})

    def test_duration_preserved_while_count_changes_to_sixty_fps(self):
        plan = {'output': {'width': 1920, 'height': 1080, 'fps': 30, 'durationFrames': 3810},
                'output_profiles': {'full': {'width': 3840, 'height': 2160, 'fps': 60}},
                'primary_audio': {'src': 'approved.wav'},
                'shots': [{'start': 0.0, 'end': 127.0}]}
        result, receipt = profiles.project_plan(plan, 'full')
        self.assertEqual(result['output']['durationFrames'], 7620)
        self.assertEqual(receipt['duration_seconds'], 127)
        self.assertEqual(result['primary_audio'], plan['primary_audio'])
        self.assertEqual(result['shots'], plan['shots'])
        self.assertEqual(plan['output']['durationFrames'], 3810)

    def test_stale_shot_clocks_block_fps_change(self):
        plan = {'aspect_ratio': '16:9', 'output': {'fps': 30},
                'output_profiles': {'full': {'fps': 60}},
                'shots': [{'startFrame': 30, 'endFrame': 90}]}
        with self.assertRaisesRegex(ValueError, 'Recompile frame-based fields'):
            profiles.project_plan(plan, 'full', 3)
        result, _ = profiles.project_plan(plan, 'sample', 3)
        self.assertEqual(result['shots'], plan['shots'])

    def test_stale_output_position_also_blocks_fps_change(self):
        plan = {'aspect_ratio': '16:9', 'output': {'fps': 30, 'startFrame': 90},
                'output_profiles': {'full': {'fps': 60}}}
        with self.assertRaisesRegex(ValueError, 'output.startFrame'):
            profiles.project_plan(plan, 'full', 3)

    def test_prepare_preserves_source_and_receipts_reference_it(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'episode_plan.json'
            raw = json.dumps({'aspect_ratio': '9:16', 'output': {'fps': 30},
                              'primary_audio': {'src': 'real.wav'}}).encode()
            source.write_bytes(raw)
            result = profiles.prepare(source, 'full', root / 'full', 10.25)
            self.assertEqual(source.read_bytes(), raw)
            self.assertEqual(result['source_plan']['sha256'], profiles.sha(source))
            derived = json.loads((root / 'full/episode_plan.json').read_text())
            self.assertEqual(derived['output']['fps'], 30)
            self.assertEqual(derived['output']['duration_seconds'], 10.25)
            self.assertIsNone(result['approval'])
            with self.assertRaisesRegex(ValueError, 'new stage output directory'):
                profiles.prepare(source, 'full', root / 'full', 10.25)

    def test_full_spec_rejects_wrong_rate_or_wrong_duration(self):
        _, receipt = profiles.project_plan({'aspect_ratio': '16:9',
            'output_profiles': {'full': {'width': 3840, 'height': 2160, 'fps': 60}}}, 'full', 10)
        self.assertFalse(profiles.check_spec(receipt, {
            'width': 3840, 'height': 2160, 'fps': 30, 'duration_frames': 300})['passed'])
        self.assertFalse(profiles.check_spec(receipt, {
            'width': 3840, 'height': 2160, 'fps': 60, 'duration_frames': 300})['passed'])
        self.assertTrue(profiles.check_spec(receipt, {
            'width': 3840, 'height': 2160, 'fps': 60, 'duration_frames': 600})['passed'])


if __name__ == '__main__':
    unittest.main()
