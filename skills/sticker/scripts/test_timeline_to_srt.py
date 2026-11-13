import json
from pathlib import Path
import tempfile
import unittest

from timeline_to_srt import convert


class VoiceSrtTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.source = self.root / "timeline.json"
        self.output = self.root / "output.srt"
        self.rows = [{"start": 0.1, "end": 1.2, "text": "批准稿第一句。"},
                     {"start": 1.4, "end": 2.3, "text": "批准稿第二句。"}]

    def run_convert(self, payload):
        self.source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        convert(self.source, self.output)
        return self.output.read_text(encoding="utf-8")

    def test_tts_and_live_formats_preserve_text_and_timing(self):
        tts = self.run_convert({"sentences": self.rows, "total_duration": 2.5})
        live = self.run_convert({"timeline": self.rows, "audio": {"duration": 2.5},
                                 "alignment": {"located": 2, "total_sentences": 2}})
        self.assertEqual(tts, live)
        self.assertIn("00:00:00,100 --> 00:00:01,200", live)
        self.assertIn("批准稿第二句。", live)

    def test_partial_live_alignment_is_not_exported_as_complete_copy(self):
        with self.assertRaisesRegex(ValueError, "unlocated"):
            self.run_convert({"timeline": self.rows,
                              "alignment": {"located": 2, "total_sentences": 3}})
        self.assertFalse(self.output.exists())

    def test_media_duration_is_checked_for_video_and_audio(self):
        for kind in ("video", "audio"):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "total_duration"):
                self.run_convert({"timeline": self.rows, kind: {"duration": 2.0}})

    def test_invalid_timing_is_rejected(self):
        for bad_row in ({"start": -1, "end": 1}, {"start": 0, "end": float("nan")},
                        {"start": 0.0001, "end": 0.0002}):
            with self.subTest(row=bad_row), self.assertRaises(ValueError):
                self.run_convert({"sentences": [{**bad_row, "text": "不能导出的句子"}]})


if __name__ == "__main__":
    unittest.main()
