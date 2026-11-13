"""The user types title, description and hashtags in the chat; nothing is written for them."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import record_user_release as rec  # noqa: E402
from user_release_source import validate_user_release_source  # noqa: E402

MSG = "标题：别让剪辑消耗你的表达欲\n简介：一句话交给 agent，口播直接出片。\n标签：#口播 #剪辑 #AI工具 #效率 #OpenSay"
TAGS = ["口播", "剪辑", "AI工具", "效率", "OpenSay"]


class UserChatReleaseTests(unittest.TestCase):
    def test_exact_user_words_are_recorded_and_validate(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = rec.build(MSG, "别让剪辑消耗你的表达欲", "一句话交给 agent，口播直接出片。", TAGS, Path(d))
            self.assertTrue(r["passed"], r)
            copy = json.loads(Path(r["release_copy"]).read_text(encoding="utf-8"))
            errors: list[str] = []
            validate_user_release_source(copy, errors)
            self.assertEqual(errors, [])
            self.assertEqual(copy["title_source"]["field"], "user-supplied")

    def test_rewritten_text_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = rec.build(MSG, "别让剪辑消耗表达欲", "一句话交给 agent，口播直接出片。", TAGS, Path(d))   # title shortened
            self.assertFalse(r["passed"])
            self.assertTrue(any("title must appear verbatim" in e for e in r["errors"]))
            self.assertFalse((Path(d) / "release_copy.json").exists())

    def test_missing_tags_are_reported_not_filled(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = rec.build(MSG, "别让剪辑消耗你的表达欲", "一句话交给 agent，口播直接出片。", TAGS[:3], Path(d))
            self.assertFalse(r["passed"])
            self.assertTrue(any("exactly five" in e for e in r["errors"]))

    def test_invented_tag_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = rec.build(MSG, "别让剪辑消耗你的表达欲", "一句话交给 agent，口播直接出片。", TAGS[:4] + ["爆款"], Path(d))
            self.assertFalse(r["passed"])
            self.assertTrue(any("every hashtag must appear" in e for e in r["errors"]))

    def test_tampered_snapshot_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            r = rec.build(MSG, "别让剪辑消耗你的表达欲", "一句话交给 agent，口播直接出片。", TAGS, Path(d))
            copy = json.loads(Path(r["release_copy"]).read_text(encoding="utf-8"))
            snap = Path(copy["user_release_source"]["snapshot_path"])
            data = json.loads(snap.read_text(encoding="utf-8")); data["description"] = "改过的简介"
            snap.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            errors: list[str] = []
            validate_user_release_source(copy, errors)
            self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
