from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SKILL_ROOT = Path(__file__).parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
TESTS = SKILL_ROOT / "tests"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(TESTS))

import package_approval  # noqa: E402
from test_release_package import make_handoff, write_json  # noqa: E402


RELEASE = SCRIPTS / "release.py"


def run_release(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RELEASE), *args],
        text=True,
        capture_output=True,
        check=False,
    )


class PackageApprovalTests(unittest.TestCase):
    def approve(
        self,
        root: Path,
        handoff: Path,
        output_dir: Path,
        *,
        ttl_seconds: int = 900,
    ) -> Path:
        approval = root / "package-approval.json"
        result = run_release(
            "package-approve",
            "--handoff",
            str(handoff),
            "--output-dir",
            str(output_dir),
            "--confirmed-by-user",
            "--ttl-seconds",
            str(ttl_seconds),
            "--output",
            str(approval),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(approval.is_file())
        return approval

    def test_package_requires_approval_argument_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            result = run_release(
                "package", "--handoff", str(handoff), "--output", str(output)
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--approval", result.stderr)
            self.assertFalse(output.exists())

    def test_package_approve_rejects_implicit_confirmation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = root / "approval.json"
            result = run_release(
                "package-approve",
                "--handoff",
                str(handoff),
                "--output-dir",
                str(output),
                "--output",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--confirmed-by-user", result.stderr)
            self.assertFalse(approval.exists())
            self.assertFalse(output.exists())

    def test_expired_approval_is_rejected_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = root / "approval.json"
            issued = datetime(2026, 1, 1, tzinfo=timezone.utc)
            package_approval.create_package_approval(
                handoff,
                output,
                approval,
                confirmed_by_user=True,
                ttl_seconds=1,
                now=issued,
            )
            with self.assertRaisesRegex(package_approval.PackageApprovalError, "expired"):
                package_approval.verify_package_approval(
                    approval, handoff, output, now=issued + timedelta(seconds=2)
                )
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output.exists())

    def test_wrong_handoff_is_rejected_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            first_root = root / "first"
            second_root = root / "second"
            first_root.mkdir()
            second_root.mkdir()
            first = make_handoff(first_root)
            second = make_handoff(second_root)
            output = root / "publish"
            approval = self.approve(root, first, output)
            result = run_release(
                "package",
                "--handoff",
                str(second),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("different handoff", result.stderr)
            self.assertFalse(output.exists())

    def test_wrong_output_dir_is_rejected_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            approved_output = root / "approved-output"
            actual_output = root / "other-output"
            approval = self.approve(root, handoff, approved_output)
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(actual_output),
                "--approval",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("different output", result.stderr)
            self.assertFalse(actual_output.exists())

    def test_tampered_referenced_input_is_rejected_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = self.approve(root, handoff, output)
            handoff_value = json.loads(handoff.read_text(encoding="utf-8"))
            Path(handoff_value["captions"]).write_text("tampered captions", encoding="utf-8")
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("input bytes changed", result.stderr)
            self.assertFalse(output.exists())

    def test_tampered_handoff_is_rejected_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = self.approve(root, handoff, output)
            value = json.loads(handoff.read_text(encoding="utf-8"))
            value["title"] = "changed after approval"
            write_json(handoff, value)
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("handoff changed", result.stderr)
            self.assertFalse(output.exists())

    def test_valid_current_approval_builds_package(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            output = root / "publish"
            approval = self.approve(root, handoff, output)
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / "publish_package.json").is_file())
            receipt = json.loads(approval.read_text(encoding="utf-8"))
            self.assertEqual(receipt["schema_version"], "release-package-approval-v1")
            self.assertEqual(receipt["release_revision_id"], "release-test-r1")
            self.assertEqual(receipt["output_dir"], str(output.resolve()))
            self.assertEqual(
                set(receipt["inputs"]),
                {
                    "video",
                    "captions",
                    "cover_master",
                    "release_media_validation",
                    "cover_variants.douyin_cover",
                    "cover_variants.xiaohongshu_cover",
                    "cover_variants.wechat_channels_home",
                    "cover_variants.wechat_channels_share",
                },
            )

    def test_legacy_producer_skill_value_remains_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            handoff = make_handoff(root)
            value = json.loads(handoff.read_text(encoding="utf-8"))
            value["producer_skill"] = "ai-talking-head-video"
            write_json(handoff, value)
            output = root / "publish"
            approval = self.approve(root, handoff, output)
            result = run_release(
                "package",
                "--handoff",
                str(handoff),
                "--output",
                str(output),
                "--approval",
                str(approval),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            package = json.loads(
                (output / "publish_package.json").read_text(encoding="utf-8")
            )
            self.assertEqual(package["producer_skill"], "ai-talking-head-video")


if __name__ == "__main__":
    unittest.main()
