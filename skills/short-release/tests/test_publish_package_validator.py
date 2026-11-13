#!/usr/bin/env python3
"""Regression tests for the multi-platform publish-package validator."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from PIL import Image


SKILL_ROOT = Path(__file__).parents[1]
VALIDATOR_PATH = SKILL_ROOT / "scripts" / "validate_publish_package.py"
SPEC = importlib.util.spec_from_file_location("validate_publish_package", VALIDATOR_PATH)
if SPEC is None or SPEC.loader is None:  # pragma: no cover - import setup guard
    raise RuntimeError(f"cannot load validator from {VALIDATOR_PATH}")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


import release_gate  # noqa: E402
from description_interaction import DESCRIPTION_POLICY  # noqa: E402


VARIANT_RULES: dict[str, dict[str, Any]] = {
    "douyin_cover": {
        "platform": "douyin",
        "display_slot": "custom_cover",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "composition_mode": "platform_specific",
        "safe_rect": [72, 86, 936, 1240],
    },
    "xiaohongshu_cover": {
        "platform": "xiaohongshu",
        "display_slot": "video_note_cover",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "composition_mode": "platform_specific",
        "safe_rect": [72, 86, 936, 1240],
    },
    "wechat_channels_home": {
        "platform": "wechat_channels",
        "display_slot": "personal_homepage_card",
        "size": (1080, 1440),
        "aspect_ratio": "3:4",
        "preview_size": (180, 240),
        "composition_mode": "native_reflow",
        "safe_rect": [72, 86, 936, 954],
    },
    "wechat_channels_share": {
        "platform": "wechat_channels",
        "display_slot": "share_card",
        "size": (1600, 1200),
        "aspect_ratio": "4:3",
        "preview_size": (320, 240),
        "composition_mode": "platform_specific",
        "safe_rect": [96, 96, 1408, 984],
        "overlay_exclusion": [680, 480, 240, 240],
    },
}


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_image(path: Path, size: tuple[int, int], color: tuple[int, int, int]) -> None:
    Image.new("RGB", size, color).save(path, format="PNG")


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_package(root: Path, *, profile: bool = True) -> tuple[Path, dict[str, Any]]:
    video = root / "video.mp4"
    captions = root / "captions.srt"
    description = root / "description.txt"
    cover_master = root / "cover-master.png"
    media_validation = root / "release-media-validation.json"

    video.write_bytes(b"fake-but-nonempty-release-video")
    captions.write_text("1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n", encoding="utf-8")
    description.write_text("这是一份用于验证发布包的测试说明。\n", encoding="utf-8")
    write_image(cover_master, (1080, 1920), (12, 35, 61))
    write_json(
        media_validation,
        {
            "passed": True,
            "video": "video.mp4",
            "video_sha256": file_sha256(video),
        },
    )

    package: dict[str, Any] = {
        "status": "approved",
        "revision": "r1",
        "release_revision_id": "release-test-r1",
        "orientation": "portrait",
        "title": "这是一条完整的测试发布标题",
        "brand_name": "零号码农",
        "description": "用于验证三平台封面发布包。",
        "hashtags": ["AI", "效率", "教程", "短视频", "零号码农"],
        "video": "video.mp4",
        "captions": "captions.srt",
        "description_file": "description.txt",
        "cover_master": "cover-master.png",
        "release_media_validation": "release-media-validation.json",
        "publish_package_validation": "publish-package-validation.json",
    }

    if not profile:
        legacy_cover = root / "legacy-platform-cover.png"
        write_image(legacy_cover, (1080, 1440), (50, 75, 100))
        package.update(
            {
                "cover_platform": legacy_cover.name,
                "cover_platform_dimensions": [1080, 1440],
            }
        )
        package_path = root / "publish_package.json"
        write_json(package_path, package)
        return package_path, package

    package.update(
        {
            "cover_headline_text": package["title"],
            "cover_headline_lines": ["这是一条完整的", "测试发布标题"],
            "video": str(video.resolve()),
            "captions": str(captions.resolve()),
            "description_file": str(description.resolve()),
            "cover_master": str(cover_master.resolve()),
            "release_media_validation": str(media_validation.resolve()),
            "publish_package_validation": str(
                (root / "publish-package-validation.json").resolve()
            ),
        }
    )

    variant_paths: dict[str, str] = {}
    manifest_entries: list[dict[str, Any]] = []
    colors = {
        "douyin_cover": (220, 70, 60),
        "xiaohongshu_cover": (235, 90, 120),
        "wechat_channels_home": (40, 155, 100),
        "wechat_channels_share": (45, 115, 205),
    }
    for variant_id, rule in VARIANT_RULES.items():
        image_path = root / f"{variant_id}.png"
        preview_path = root / f"{variant_id}-preview.png"
        write_image(image_path, rule["size"], colors[variant_id])
        write_image(preview_path, rule["preview_size"], colors[variant_id])
        variant_paths[variant_id] = str(image_path.resolve())
        entry: dict[str, Any] = {
            "id": variant_id,
            "platform": rule["platform"],
            "display_slot": rule["display_slot"],
            "role": "primary" if variant_id == "douyin_cover" else "secondary",
            "path": str(image_path.resolve()),
            "dimensions": list(rule["size"]),
            "aspect_ratio": rule["aspect_ratio"],
            "composition_mode": rule["composition_mode"],
            "safe_rect": rule["safe_rect"],
            "thumbnail_preview": str(preview_path.resolve()),
            "upload_caveat": "按当前账号界面实测槽位上传，并在缩略图中复核。",
        }
        if "overlay_exclusion" in rule:
            entry["overlay_exclusion"] = rule["overlay_exclusion"]
        manifest_entries.append(entry)

    manifest = {
        "schema_version": "2.0",
        "cover_profile_id": "cn_social_covers_v2",
        "release_revision_id": package["release_revision_id"],
        "primary_cover_variant_id": "douyin_cover",
        "variants": manifest_entries,
    }
    manifest_path = root / "platform-cover-specs.json"
    write_json(manifest_path, manifest)

    package.update(
        {
            "cover_profile_id": "cn_social_covers_v2",
            "primary_cover_variant_id": "douyin_cover",
            "cover_variants_manifest": str(manifest_path.resolve()),
            "cover_variants": variant_paths,
            "cover_platform": variant_paths["douyin_cover"],
            "cover_platform_dimensions": [1080, 1440],
        }
    )
    package_path = root / "publish_package.json"
    write_json(package_path, package)
    return package_path, package


def add_participation(package_path: Path, package: dict[str, Any]) -> None:
    text = "AI 免费订酒店却向酒店收佣金，你能接受吗？"
    package.update({
        "description": "本期拆解 AI 的交易佣金模式。" + text,
        "description_policy": DESCRIPTION_POLICY,
        "description_interaction": {
            "type": "discussion",
            "text": text,
            "content_anchor": "本片解释酒店佣金如何支持免费的 AI 服务。",
            "answer_format": "接受或不接受，并说明一个原因。",
        },
    })
    package["platform_intro"] = package["description"] + "\n\n音乐署名：测试作曲者。"
    Path(package["description_file"]).write_text(package["description"] + "\n", encoding="utf-8")
    write_json(package_path, package)


class PublishPackageValidatorTests(unittest.TestCase):
    def test_package_with_bound_participation_and_music_intro_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, package = make_package(Path(temp_dir))
            add_participation(package_path, package)

            report = VALIDATOR.validate_package(package_path)

            self.assertTrue(report["passed"], report["errors"])
            self.assertFalse(any("description participation metadata" in item for item in report["warnings"]))
            self.assertEqual(report["release_revision_hash"], VALIDATOR.validate_package(package_path)["release_revision_hash"])

    def test_new_package_rejects_missing_or_mismatched_participation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, package = make_package(Path(temp_dir))
            add_participation(package_path, package)
            mutations = (
                ("missing", "description_interaction", None, "description_interaction must be an object"),
                ("wrong policy", "description_policy", "other-policy", "description_policy must be"),
                ("missing body sentence", "description", "为什么 AI 免费？", "description must contain"),
                ("credit only intro", "platform_intro", "音乐署名：测试作曲者。", "platform_intro must contain"),
                ("null intro", "platform_intro", None, "platform_intro must be a non-empty string"),
            )
            for label, field, value, expected_error in mutations:
                with self.subTest(label=label):
                    changed = json.loads(json.dumps(package))
                    if label == "missing":
                        del changed[field]
                    else:
                        changed[field] = value
                    write_json(package_path, changed)
                    report = VALIDATOR.validate_package(package_path)
                    self.assertFalse(report["passed"])
                    self.assertTrue(any(expected_error in item for item in report["errors"]), report["errors"])

    def test_participation_changes_make_saved_validation_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, package = make_package(Path(temp_dir))
            add_participation(package_path, package)
            before = VALIDATOR.validate_package(package_path)
            self.assertTrue(before["passed"], before["errors"])
            write_json(Path(package["publish_package_validation"]), before)
            self.assertEqual(release_gate.verify_release_ready(package_path)["status"], "package_validated")

            for field, value in (
                ("type", "experience"),
                ("content_anchor", "本片还提到 AI 下单时的利益冲突。"),
                ("answer_format", "说明自己的理由。"),
                ("platform_intro", package["platform_intro"] + "\n新增音乐署名说明。"),
            ):
                with self.subTest(field=field):
                    changed = json.loads(json.dumps(package))
                    if field == "platform_intro":
                        changed[field] = value
                    else:
                        changed["description_interaction"][field] = value
                    write_json(package_path, changed)
                    after = VALIDATOR.validate_package(package_path)
                    self.assertTrue(after["passed"], after["errors"])
                    self.assertNotEqual(before["release_revision_hash"], after["release_revision_hash"])
                    with self.assertRaisesRegex(release_gate.ReleaseGateError, "release_revision_hash changed"):
                        release_gate.verify_release_ready(package_path)

    def test_removing_new_metadata_cannot_reuse_saved_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, package = make_package(Path(temp_dir))
            add_participation(package_path, package)
            before = VALIDATOR.validate_package(package_path)
            write_json(Path(package["publish_package_validation"]), before)

            for removed in (
                ("description_policy",),
                ("description_interaction",),
                ("description_policy", "description_interaction"),
            ):
                with self.subTest(removed=removed):
                    changed = json.loads(json.dumps(package))
                    for field in removed:
                        del changed[field]
                    write_json(package_path, changed)
                    after = VALIDATOR.validate_package(package_path)
                    self.assertNotEqual(before["release_revision_hash"], after["release_revision_hash"])
                    with self.assertRaises(release_gate.ReleaseGateError):
                        release_gate.verify_release_ready(package_path)

    def test_historical_package_keeps_hash_and_remains_verifiable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, package = make_package(Path(temp_dir))
            package["platform_intro"] = "历史平台导语及音乐署名。"
            write_json(package_path, package)
            report = VALIDATOR.validate_package(package_path)
            previous_identity = {
                "release_revision_id": package["release_revision_id"],
                "status": package["status"],
                "orientation": package["orientation"],
                "cover_profile_id": package["cover_profile_id"],
                "primary_cover_variant_id": package["primary_cover_variant_id"],
                "title": package["title"].strip(),
                "description": package["description"],
                "hashtags": package["hashtags"],
                "artifact_hashes": report["artifact_hashes"],
                "cover_headline_text": package["cover_headline_text"],
                "cover_headline_lines": package["cover_headline_lines"],
            }
            expected_hash = hashlib.sha256(
                json.dumps(previous_identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
            ).hexdigest()
            self.assertTrue(report["passed"], report["errors"])
            self.assertEqual(report["release_revision_hash"], expected_hash)
            self.assertIn("legacy package: missing description participation metadata", report["warnings"])
            write_json(Path(package["publish_package_validation"]), report)
            self.assertEqual(release_gate.verify_release_ready(package_path)["release_revision_hash"], expected_hash)

    def test_complete_cn_social_covers_v2_package_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, _ = make_package(Path(temp_dir))

            report = VALIDATOR.validate_package(package_path)

            self.assertTrue(report["passed"], report["errors"])
            self.assertEqual(set(report["cover_variants"]), set(VARIANT_RULES))
            self.assertEqual(report["primary_cover_variant_id"], "douyin_cover")

    def test_each_required_variant_id_is_enforced(self) -> None:
        for variant_id in VARIANT_RULES:
            with self.subTest(variant_id=variant_id), tempfile.TemporaryDirectory() as temp_dir:
                package_path, package = make_package(Path(temp_dir))
                del package["cover_variants"][variant_id]
                write_json(package_path, package)

                report = VALIDATOR.validate_package(package_path)

                self.assertFalse(report["passed"])
                self.assertTrue(
                    any(f"cover_variants.{variant_id}" in error for error in report["errors"]),
                    report["errors"],
                )

    def test_cover_headline_must_match_title_after_line_join(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, package = make_package(root)
            package["cover_headline_lines"] = ["这是一条完整的", "另一个封面钩子"]
            write_json(package_path, package)

            report = VALIDATOR.validate_package(package_path)

            self.assertFalse(report["passed"])
            self.assertIn(
                "joined cover_headline_lines must equal title after removing Unicode whitespace",
                report["errors"],
            )

    def test_old_package_without_cover_headline_metadata_keeps_old_revision_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, package = make_package(root)
            del package["cover_headline_text"]
            del package["cover_headline_lines"]
            write_json(package_path, package)

            report = VALIDATOR.validate_package(package_path)
            old_identity = {
                "release_revision_id": package["release_revision_id"],
                "status": package["status"],
                "orientation": package["orientation"],
                "cover_profile_id": package["cover_profile_id"],
                "primary_cover_variant_id": package["primary_cover_variant_id"],
                "title": package["title"].strip(),
                "description": package["description"],
                "hashtags": package["hashtags"],
                "artifact_hashes": report["artifact_hashes"],
            }
            expected_old_hash = hashlib.sha256(
                json.dumps(
                    old_identity, ensure_ascii=False, sort_keys=True
                ).encode("utf-8")
            ).hexdigest()

            self.assertTrue(report["passed"], report["errors"])
            self.assertEqual(report["release_revision_hash"], expected_old_hash)
            self.assertTrue(
                any("missing cover headline parity metadata" in item for item in report["warnings"]),
                report["warnings"],
            )

    def test_wrong_variant_dimensions_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = make_package(root)
            write_image(root / "wechat_channels_home.png", (1080, 1439), (40, 155, 100))

            report = VALIDATOR.validate_package(package_path)

            self.assertFalse(report["passed"])
            self.assertTrue(
                any("cover_variants.wechat_channels_home size" in error for error in report["errors"]),
                report["errors"],
            )

    def test_manifest_and_package_map_path_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = make_package(root)
            manifest_path = root / "platform-cover-specs.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for entry in manifest["variants"]:
                if entry["id"] == "xiaohongshu_cover":
                    entry["path"] = "a-different-xiaohongshu-cover.png"
            write_json(manifest_path, manifest)

            report = VALIDATOR.validate_package(package_path)

            self.assertFalse(report["passed"])
            self.assertIn(
                "manifest path does not match cover_variants.xiaohongshu_cover",
                report["errors"],
            )

    def test_primary_cover_legacy_alias_mismatch_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, package = make_package(root)
            package["cover_platform"] = package["cover_variants"]["wechat_channels_share"]
            write_json(package_path, package)

            report = VALIDATOR.validate_package(package_path)

            self.assertFalse(report["passed"])
            self.assertIn(
                "cover_platform does not alias primary_cover_variant_id",
                report["errors"],
            )

    def test_non_primary_cover_bytes_change_release_revision_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = make_package(root)
            before = VALIDATOR.validate_package(package_path)
            self.assertTrue(before["passed"], before["errors"])

            write_image(root / "xiaohongshu_cover.png", (1080, 1440), (250, 185, 35))
            after = VALIDATOR.validate_package(package_path)

            self.assertTrue(after["passed"], after["errors"])
            self.assertNotEqual(before["release_revision_hash"], after["release_revision_hash"])
            self.assertNotEqual(
                before["artifact_hashes"]["cover_variant:xiaohongshu_cover"],
                after["artifact_hashes"]["cover_variant:xiaohongshu_cover"],
            )


    def test_legacy_package_without_profile_passes_with_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            package_path, _ = make_package(Path(temp_dir), profile=False)

            report = VALIDATOR.validate_package(package_path)

            self.assertTrue(report["passed"], report["errors"])
            self.assertTrue(
                any("legacy package: missing cover_profile_id" in warning for warning in report["warnings"]),
                report["warnings"],
            )


if __name__ == "__main__":
    unittest.main()
