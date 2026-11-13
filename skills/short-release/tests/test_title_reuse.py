from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from title_source import validate_title_source
import build_publish_package as builder
import validate_publish_package as validator
from test_release_package import make_handoff
from test_publish_package_validator import make_package


def inherited_title(title: str) -> dict:
    return {
        "policy": "reuse-upstream-title-v1", "field": "原创标题", "value": title,
        "sha256": hashlib.sha256(title.encode("utf-8")).hexdigest(),
        "record_id": "rec-test-only", "approval_note": "offline test fixture approval",
    }


class TitleReuseTests(unittest.TestCase):
    def test_missing_source_is_optional_only_for_legacy(self) -> None:
        errors = []
        validate_title_source({"title": "旧项目标题"}, errors)
        self.assertEqual(errors, [])
        validate_title_source({"title": "新项目标题"}, errors, required=True)
        self.assertTrue(errors)

    def test_rewrite_punctuation_or_case_changes_are_rejected(self) -> None:
        title = "Codex可以做什么？"
        for changed in ("codex可以做什么？", "Codex可以做什么!", " " + title):
            errors = []
            validate_title_source({"title": changed, "title_source": inherited_title(title)}, errors)
            self.assertTrue(any("exactly equal" in item for item in errors))

    def test_invalid_source_metadata_is_rejected_without_crashing(self) -> None:
        for key, value in (("sha256", "wrong"), ("approval_note", " "),
                           ("record_id", ""), ("field", []), ("policy", "generate-new")):
            with self.subTest(key=key):
                source = inherited_title("前置确定的标题")
                source[key] = value
                errors = []
                validate_title_source({"title": source["value"], "title_source": source}, errors)
                self.assertTrue(errors)

    def test_user_supplied_title_needs_no_pool_record(self) -> None:
        source = inherited_title("用户已确定的标题")
        source["field"] = "user-supplied"
        del source["record_id"]
        errors = []
        validate_title_source({"title": source["value"], "title_source": source}, errors, required=True)
        self.assertEqual(errors, [])

    def test_package_accepts_nonempty_short_inherited_titles(self) -> None:
        for title, field in (("AI的前世今生", "原创标题"), ("短", "原创标题"),
                             ("短", "user-supplied")):
            with self.subTest(title=title, field=field), tempfile.TemporaryDirectory() as tmp:
                path, package = make_package(Path(tmp))
                source = inherited_title(title)
                source["field"] = field
                if field == "user-supplied":
                    del source["record_id"]
                package.update(title=title, title_source=source,
                               cover_headline_text=title, cover_headline_lines=[title])
                path.write_text(json.dumps(package, ensure_ascii=False))
                report = validator.validate_package(path)
                self.assertTrue(report["passed"], report["errors"])

    def test_short_legacy_title_keeps_existing_length_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, package = make_package(Path(tmp))
            title = "AI的前世今生"
            package.update(title=title, cover_headline_text=title, cover_headline_lines=[title])
            path.write_text(json.dumps(package, ensure_ascii=False))
            report = validator.validate_package(path)
            self.assertFalse(report["passed"])
            self.assertIn("title is too short", report["errors"])

    def test_invalid_inherited_short_title_still_fails(self) -> None:
        mutations = (("sha256", "wrong"), ("policy", "generate-new"),
                     ("approval_note", " "), ("record_id", ""), ("field", []))
        for key, value in mutations:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as tmp:
                path, package = make_package(Path(tmp))
                title = "AI的前世今生"
                source = inherited_title(title)
                source[key] = value
                package.update(title=title, title_source=source,
                               cover_headline_text=title, cover_headline_lines=[title])
                path.write_text(json.dumps(package, ensure_ascii=False))
                report = validator.validate_package(path)
                self.assertFalse(report["passed"])
                self.assertIn("title is too short", report["errors"])
                self.assertTrue(any("title_source" in item for item in report["errors"]), report)

    def test_short_title_must_still_equal_its_inherited_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, package = make_package(Path(tmp))
            title = "AI的前世今生"
            package.update(title=title, title_source=inherited_title("另一个标题"),
                           cover_headline_text=title, cover_headline_lines=[title])
            path.write_text(json.dumps(package, ensure_ascii=False))
            report = validator.validate_package(path)
            self.assertFalse(report["passed"])
            self.assertTrue(any("exactly equal" in item for item in report["errors"]), report)

    def test_empty_inherited_titles_remain_invalid(self) -> None:
        for title in ("", " "):
            with self.subTest(title=title), tempfile.TemporaryDirectory() as tmp:
                path, package = make_package(Path(tmp))
                package.update(title=title, title_source=inherited_title(title),
                               cover_headline_text=title, cover_headline_lines=[title])
                path.write_text(json.dumps(package, ensure_ascii=False))
                report = validator.validate_package(path)
                self.assertFalse(report["passed"])
                self.assertIn("title is too short", report["errors"])
                self.assertIn("title_source.value must be a non-empty string", report["errors"])

    def test_inherited_short_title_does_not_bypass_cover_or_media_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path, package = make_package(Path(tmp))
            title = "AI的前世今生"
            package.update(title=title, title_source=inherited_title(title),
                           cover_headline_text="封面改了标题", cover_headline_lines=[title])
            path.write_text(json.dumps(package, ensure_ascii=False))
            report = validator.validate_package(path)
            self.assertFalse(report["passed"])
            self.assertTrue(any("cover_headline_text must equal title" in item
                                for item in report["errors"]), report)
            package["cover_headline_text"] = title
            path.write_text(json.dumps(package, ensure_ascii=False))
            Path(package["video"]).write_bytes(b"changed-after-media-validation")
            report = validator.validate_package(path)
            self.assertFalse(report["passed"])
            self.assertIn("video bytes changed after release media validation", report["errors"])

    def test_sticker_handoff_requires_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            handoff = json.loads(make_handoff(Path(tmp)).read_text())
            handoff["producer_skill"] = "sticker"
            with self.assertRaisesRegex(builder.HandoffError, "title_source"):
                builder.validate_handoff(handoff)

    def test_build_preserves_title_and_source_and_hash_binds_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = make_handoff(root)
            handoff = json.loads(path.read_text())
            handoff["producer_skill"] = "sticker"
            handoff["title_source"] = inherited_title(handoff["title"])
            path.write_text(json.dumps(handoff, ensure_ascii=False))
            package_path, report = builder.build_package(path, root / "publish")
            self.assertTrue(report["passed"], report)
            package = json.loads(package_path.read_text())
            self.assertEqual(package["title"], handoff["title_source"]["value"])
            self.assertEqual(package["title_source"], handoff["title_source"])
            mutated = copy.deepcopy(package)
            mutated["title_source"]["approval_note"] = "different approval"
            args = (package["release_revision_id"], report["artifact_hashes"])
            self.assertNotEqual(validator.compute_revision_hash(package, *args),
                                validator.compute_revision_hash(mutated, *args))
            package["title"] += "！"
            package_path.write_text(json.dumps(package, ensure_ascii=False))
            self.assertFalse(validator.validate_package(package_path)["passed"])



if __name__ == "__main__":
    unittest.main()
