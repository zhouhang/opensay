from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image


SKILL_ROOT = Path(__file__).parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import build_publish_package as builder  # noqa: E402
import release_gate  # noqa: E402


COLORS = {
    "douyin_cover": (220, 70, 60),
    "xiaohongshu_cover": (235, 90, 120),
    "wechat_channels_home": (40, 155, 100),
    "wechat_channels_share": (45, 115, 205),
}


def write_image(path: Path, size: tuple[int, int], color: tuple[int, int, int]) -> None:
    Image.new("RGB", size, color).save(path, format="PNG")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def make_handoff(root: Path, *, status: str = "approved") -> Path:
    assets = root / "assets"
    assets.mkdir()
    video = assets / "master.mp4"
    captions = assets / "captions.srt"
    cover_master = assets / "cover-master.png"
    media_report = assets / "release-media-validation.json"
    video.write_bytes(b"approved-video-bytes")
    captions.write_text("1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n", encoding="utf-8")
    write_image(cover_master, (1080, 1920), (12, 35, 61))
    write_json(
        media_report,
        {
            "passed": True,
            "video": str(video.resolve()),
            "video_sha256": sha256(video),
        },
    )
    variants: dict[str, str] = {}
    for variant_id, rule in builder.validator.REQUIRED_COVER_VARIANTS.items():
        path = assets / f"{variant_id}.png"
        write_image(path, rule["size"], COLORS[variant_id])
        variants[variant_id] = str(path.resolve())
    handoff = {
        "schema_version": "video-release-handoff-v1",
        "producer_skill": "talking-short",
        "status": status,
        "revision": "r1",
        "release_revision_id": "release-test-r1",
        "orientation": "portrait",
        "title": "这是一条完整的测试发布标题",
        "cover_headline_text": "这是一条完整的测试发布标题",
        "cover_headline_lines": ["这是一条完整的", "测试发布标题"],
        "brand_name": "零号码农",
        "description": "用于验证共享发布包。你最想让 AI 替你完成哪一步？",
        "description_interaction": {
            "type": "interaction",
            "text": "你最想让 AI 替你完成哪一步？",
            "content_anchor": "本片演示使用 AI 完成工作步骤，邀请观众选择自己的需求。",
        },
        "hashtags": ["AI", "效率", "教程", "短视频", "零号码农"],
        "video": str(video.resolve()),
        "captions": str(captions.resolve()),
        "cover_master": str(cover_master.resolve()),
        "cover_variants": variants,
        "release_media_validation": str(media_report.resolve()),
        "primary_cover_variant_id": "douyin_cover",
        "title_alternatives": ["备选标题一", "备选标题二"],
        "production_manifest": str((assets / "production-manifest.json").resolve()),
    }
    handoff_path = root / "video-release-handoff.json"
    write_json(handoff_path, handoff)
    return handoff_path


def make_unique_size_handoff(root: Path) -> Path:
    handoff_path = make_handoff(root)
    handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
    assets = root / "assets"
    shared = assets / "cover-1080x1440.png"
    share = assets / "cover-1600x1200.png"
    bilibili = assets / "cover-1920x1080.png"
    write_image(shared, (1080, 1440), (220, 70, 60))
    write_image(share, (1600, 1200), (45, 115, 205))
    write_image(bilibili, (1920, 1080), (35, 45, 80))
    handoff.update({
        "target_platforms": ["douyin", "xiaohongshu", "wechat_channels", "bilibili"],
        "cover_asset_strategy": "one_asset_per_dimensions",
        "cover_assets_by_size": {
            "1080x1440": str(shared.resolve()),
            "1600x1200": str(share.resolve()),
            "1920x1080": str(bilibili.resolve()),
        },
        "platform_cover_map": {
            "douyin_cover": "1080x1440",
            "xiaohongshu_cover": "1080x1440",
            "wechat_channels_home": "1080x1440",
            "wechat_channels_share": "1600x1200",
            "bilibili_cover": "1920x1080",
        },
        "cover_variants": {
            "douyin_cover": str(shared.resolve()),
            "xiaohongshu_cover": str(shared.resolve()),
            "wechat_channels_home": str(shared.resolve()),
            "wechat_channels_share": str(share.resolve()),
            "bilibili_cover": str(bilibili.resolve()),
        },
    })
    write_json(handoff_path, handoff)
    return handoff_path


class ReleasePackageTests(unittest.TestCase):
    def test_new_handoff_rejects_missing_interaction_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            path = make_handoff(root)
            handoff = json.loads(path.read_text())
            del handoff["description_interaction"]
            write_json(path, handoff)
            with self.assertRaisesRegex(builder.HandoffError, "description_interaction"):
                builder.build_package(path, root / "publish")
            self.assertFalse((root / "publish").exists())

    def test_new_handoff_cannot_drop_interaction_from_publish_intro(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            path = make_handoff(root)
            handoff = json.loads(path.read_text())
            handoff["platform_intro"] = "用于验证共享发布包。音乐署名：测试音乐。"
            write_json(path, handoff)
            with self.assertRaisesRegex(builder.HandoffError, "platform_intro"):
                builder.build_package(path, root / "publish")
            self.assertFalse((root / "publish").exists())

    def test_removing_participation_metadata_invalidates_current_verification(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = builder.build_package(make_handoff(root), root / "publish")
            package = json.loads(package_path.read_text())
            del package["description_policy"]
            del package["description_interaction"]
            write_json(package_path, package)
            with self.assertRaises(release_gate.ReleaseGateError):
                release_gate.verify_release_ready(package_path)

    def test_native_master_alias_builds_and_verifies(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            path = make_unique_size_handoff(root)
            handoff = json.loads(path.read_text())
            handoff["cover_master"] = handoff["cover_variants"]["douyin_cover"]
            write_json(path, handoff)
            package, report = builder.build_package(path, root / "publish")
            self.assertTrue(report["passed"], report["errors"])
            self.assertEqual(release_gate.verify_release_ready(package)["status"], "package_validated")

    def test_native_master_requires_strategy_and_exact_alias(self) -> None:
        for mode in ("legacy", "unbound", "wrong_size", "wrong_mapping"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                path = make_unique_size_handoff(root)
                handoff = json.loads(path.read_text())
                handoff["cover_master"] = handoff["cover_variants"]["douyin_cover"]
                if mode == "legacy":
                    del handoff["cover_asset_strategy"]
                elif mode == "unbound":
                    other = root / "unapproved-master.png"
                    write_image(other, (1080, 1440), (1, 2, 3))
                    handoff["cover_master"] = str(other)
                elif mode == "wrong_size":
                    write_image(Path(handoff["cover_master"]), (1080, 1400), (1, 2, 3))
                else:
                    handoff["platform_cover_map"]["douyin_cover"] = "1600x1200"
                write_json(path, handoff)
                with self.assertRaises(ValueError):
                    builder.build_package(path, root / "publish")

    def test_unique_size_strategy_builds_five_slots_from_three_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, report = builder.build_package(
                make_unique_size_handoff(root), root / "publish"
            )
            package = json.loads(package_path.read_text(encoding="utf-8"))

            self.assertTrue(report["passed"], report["errors"])
            self.assertEqual(len(set(package["cover_variants"].values())), 3)
            self.assertEqual(set(package["cover_variants"]), set(builder.validator.CONFIGURED_COVER_VARIANTS))
            self.assertEqual(package["cover_asset_strategy"], "one_asset_per_dimensions")
            self.assertEqual(
                sorted(package["cover_assets_by_size"]),
                ["1080x1440", "1600x1200", "1920x1080"],
            )
            manifest = json.loads(
                Path(package["cover_variants_manifest"]).read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["cover_assets_by_size"], package["cover_assets_by_size"])

    def test_builds_complete_package_and_current_gate_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"

            package_path, report = builder.build_package(handoff, output)

            self.assertTrue(report["passed"], report["errors"])
            package = json.loads(package_path.read_text(encoding="utf-8"))
            self.assertEqual(package["schema_version"], "video-release-package-v1")
            self.assertEqual(package["cover_profile_id"], "cn_social_covers_v2")
            self.assertEqual(package["description_policy"], "content-participation-v1")
            source_handoff = json.loads(handoff.read_text())
            self.assertEqual(
                package["description_interaction"], source_handoff["description_interaction"]
            )
            self.assertIn(
                package["description_interaction"]["text"],
                (output / "publish_copy.md").read_text(),
            )
            self.assertEqual(package["cover_headline_text"], package["title"])
            self.assertEqual(
                "".join(package["cover_headline_lines"]), package["title"]
            )
            self.assertEqual(set(package["cover_variants"]), set(COLORS))
            self.assertTrue((output / "publish_copy.md").is_file())
            self.assertEqual(
                release_gate.require_current_publish_validation(package_path),
                (output / "publish_package_validation.json").resolve(),
            )
            verification = release_gate.verify_release_ready(package_path)
            self.assertEqual(verification["status"], "package_validated")
            self.assertEqual(
                report["release_revision_hash"],
                builder.validator.validate_package(package_path)["release_revision_hash"],
            )

    def test_slot_previews_have_required_sizes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = builder.build_package(make_handoff(root), root / "publish")
            package = json.loads(package_path.read_text(encoding="utf-8"))
            manifest_path = Path(package["cover_variants_manifest"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for entry in manifest["variants"]:
                with self.subTest(variant=entry["id"]), Image.open(
                    entry["thumbnail_preview"]
                ) as preview:
                    expected = builder.validator.REQUIRED_COVER_VARIANTS[entry["id"]][
                        "preview_size"
                    ]
                    self.assertEqual(preview.size, expected)

    def test_changed_non_primary_cover_invalidates_current_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            package_path, _ = builder.build_package(make_handoff(root), root / "publish")
            package = json.loads(package_path.read_text(encoding="utf-8"))
            changed = Path(package["cover_variants"]["xiaohongshu_cover"])
            write_image(changed, (1080, 1440), (1, 2, 3))

            with self.assertRaises(release_gate.ReleaseGateError):
                release_gate.require_current_publish_validation(package_path)

    def test_media_report_relative_video_is_resolved_from_report_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            media_path = Path(handoff["release_media_validation"])
            media = json.loads(media_path.read_text(encoding="utf-8"))
            media["video"] = "master.mp4"
            write_json(media_path, media)

            _, report = builder.build_package(handoff_path, root / "publish")

            self.assertTrue(report["passed"], report["errors"])

    def test_refuses_overwrite_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            builder.build_package(handoff, output)

            with self.assertRaises(builder.HandoffError):
                builder.build_package(handoff, output)

            _, report = builder.build_package(handoff, output, force=True)
            self.assertTrue(report["passed"], report["errors"])

    def test_handoff_identity_and_copy_fields_require_schema_types(self) -> None:
        invalid_values = {
            "producer_skill": 123,
            "revision": True,
            "release_revision_id": 123,
            "title": ["not", "a", "string"],
            "cover_headline_text": ["not", "a", "string"],
            "cover_headline_lines": "not a line array",
            "brand_name": {"not": "a string"},
            "description": 0,
        }
        for field, invalid_value in invalid_values.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                handoff_path = make_handoff(root)
                handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
                handoff[field] = invalid_value
                write_json(handoff_path, handoff)

                with self.assertRaises(builder.HandoffError):
                    builder.build_package(handoff_path, root / "publish")
                self.assertFalse((root / "publish").exists())

    def test_handoff_rejects_cover_headline_that_rewrites_title(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            handoff["cover_headline_text"] = "测试标题换了另一个钩子"
            handoff["cover_headline_lines"] = ["测试标题", "换了另一个钩子"]
            write_json(handoff_path, handoff)

            with self.assertRaisesRegex(
                builder.HandoffError, "cover_headline_text must equal title"
            ):
                builder.build_package(handoff_path, root / "publish")
            self.assertFalse((root / "publish").exists())

    def test_handoff_allows_only_visual_whitespace_in_line_wrapping(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            handoff["cover_headline_text"] = "这是一条完整的测试发布标题"
            handoff["cover_headline_lines"] = ["这是一条完整的 ", "测试发布标题"]
            write_json(handoff_path, handoff)

            package_path, report = builder.build_package(
                handoff_path, root / "publish"
            )

            self.assertTrue(report["passed"], report["errors"])
            self.assertTrue(package_path.is_file())

    def test_force_rejects_same_revision_id_with_changed_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            output = root / "publish"
            package_path, _ = builder.build_package(handoff_path, output)
            original_package = package_path.read_bytes()
            original_copy = (output / "publish_copy.md").read_bytes()

            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            handoff["title"] = "同一个发布版本不允许偷偷更换标题"
            write_json(handoff_path, handoff)

            with self.assertRaises(builder.HandoffError):
                builder.build_package(handoff_path, output, force=True)
            self.assertEqual(package_path.read_bytes(), original_package)
            self.assertEqual((output / "publish_copy.md").read_bytes(), original_copy)

    def test_force_same_input_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            output = root / "publish"
            package_path, first_report = builder.build_package(handoff_path, output)
            tracked = [
                output / "publish_copy.md",
                output / "cover" / "platforms" / "platform-cover-specs.json",
                package_path,
                output / "publish_package_validation.json",
                *sorted((output / "cover" / "platforms" / "previews").glob("*.png")),
            ]
            before = {path: path.read_bytes() for path in tracked}

            rebuilt_path, second_report = builder.build_package(
                handoff_path, output, force=True
            )

            self.assertEqual(rebuilt_path, package_path)
            self.assertEqual(
                second_report["release_revision_hash"],
                first_report["release_revision_hash"],
            )
            self.assertEqual({path: path.read_bytes() for path in tracked}, before)

    def test_force_rejects_stale_existing_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            output = root / "publish"
            builder.build_package(handoff_path, output)
            report_path = output / "publish_package_validation.json"
            report = json.loads(report_path.read_text(encoding="utf-8"))
            report["release_revision_hash"] = "0" * 64
            write_json(report_path, report)
            tracked = [
                output / "publish_copy.md",
                output / "cover" / "platforms" / "platform-cover-specs.json",
                output / "publish_package.json",
                report_path,
                *sorted((output / "cover" / "platforms" / "previews").glob("*.png")),
            ]
            before = {path: path.read_bytes() for path in tracked}

            with self.assertRaises(builder.HandoffError):
                builder.build_package(handoff_path, output, force=True)
            self.assertEqual({path: path.read_bytes() for path in tracked}, before)

    def test_force_rejects_changed_cover_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff_path = make_handoff(root)
            output = root / "publish"
            builder.build_package(handoff_path, output)
            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            cover_path = Path(handoff["cover_variants"]["douyin_cover"])
            write_image(cover_path, (1080, 1440), (1, 2, 3))
            tracked = [
                output / "publish_copy.md",
                output / "cover" / "platforms" / "platform-cover-specs.json",
                output / "publish_package.json",
                output / "publish_package_validation.json",
                *sorted((output / "cover" / "platforms" / "previews").glob("*.png")),
            ]
            before = {path: path.read_bytes() for path in tracked}

            with self.assertRaises(builder.HandoffError):
                builder.build_package(handoff_path, output, force=True)
            self.assertEqual({path: path.read_bytes() for path in tracked}, before)

    def test_nonapproved_handoff_is_rejected_before_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root, status="draft")
            output = root / "publish"

            with self.assertRaises(builder.HandoffError):
                builder.build_package(handoff, output)
            self.assertFalse(output.exists())

    def test_release_cli_package_and_verify(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = root / "package-approval.json"
            approval_result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "release.py"),
                    "package-approve",
                    "--handoff",
                    str(handoff),
                    "--output-dir",
                    str(output),
                    "--confirmed-by-user",
                    "--output",
                    str(approval),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(approval_result.returncode, 0, approval_result.stderr)
            package_result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "release.py"),
                    "package",
                    "--handoff",
                    str(handoff),
                    "--output",
                    str(output),
                    "--approval",
                    str(approval),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(package_result.returncode, 0, package_result.stderr)
            verify_result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "release.py"),
                    "verify",
                    "--package",
                    str(output / "publish_package.json"),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(verify_result.returncode, 0, verify_result.stderr)
            self.assertEqual(json.loads(verify_result.stdout)["status"], "package_validated")


if __name__ == "__main__":
    unittest.main()
