from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


SKILL_ROOT = Path(__file__).parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import multipost_distribution as distribution  # noqa: E402
import multipost_release as release  # noqa: E402


REVISION_ID = "release-safe-r1"
REVISION_HASH = "a" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"safe-preview"


class FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://127.0.0.1:19528"
        self.create_calls: list[dict[str, object]] = []
        self.create_group_ids: list[str] = []
        self.submit_calls: list[dict[str, object]] = []
        self.submit_error: Exception | None = None
        self.health_response: dict[str, object] = {"status": "ok", "version": "test"}
        self.statuses: list[dict[str, object]] = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            }
        ]

    def health(self) -> dict[str, object]:
        return dict(self.health_response)

    def list_platforms(self) -> dict[str, object]:
        return {
            "platforms": [
                {
                    "id": "youtube",
                    "name": "YouTube",
                    "supportedContentTypes": ["VIDEO"],
                },
                {
                    "id": "instagram",
                    "name": "Instagram",
                    "supportedContentTypes": ["DYNAMIC"],
                },
                {
                    "id": "douyin",
                    "name": "Douyin",
                    "supportedContentTypes": ["VIDEO"],
                },
                {
                    "id": "wechat_channels",
                    "name": "WeChat Channels",
                    "supportedContentTypes": ["VIDEO"],
                },
            ]
        }

    def list_accounts(self) -> dict[str, object]:
        return {
            "accounts": [
                {"id": "account-1", "platform": "youtube", "isLoggedIn": True},
                {"id": "douyin-1", "platform": "douyin", "isLoggedIn": True},
                {"id": "ig-1", "platform": "instagram", "isLoggedIn": True},
                {
                    "id": "wx-1",
                    "platform": "wechat_channels",
                    "isLoggedIn": True,
                },
            ]
        }

    def create_publish(self, **kwargs: object) -> dict[str, object]:
        self.create_calls.append(dict(kwargs))
        group_id = self.create_group_ids.pop(0) if self.create_group_ids else "group-1"
        return {"groupId": group_id, "status": "preparing"}

    def get_publish_status(self, group_id: str) -> dict[str, object]:
        if len(self.statuses) > 1:
            return self.statuses.pop(0)
        return self.statuses[0]

    def take_screenshot(self, **kwargs: object) -> bytes:
        return PNG

    def submit_target(
        self, group_id: str, account_id: str, *, approval: dict[str, object]
    ) -> dict[str, object]:
        self.submit_calls.append(
            {"group_id": group_id, "account_id": account_id, "approval": approval}
        )
        if self.submit_error is not None:
            raise self.submit_error
        return {"groupId": group_id, "targets": [{"accountId": account_id}]}


class MultiPostReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.package = self.root / "publish" / "publish_package.json"
        self.package.parent.mkdir(parents=True)
        self.video = self.root / "approved-video.mp4"
        self.master_cover = self.root / "master.png"
        self.douyin_cover = self.root / "douyin.png"
        self.xhs_cover = self.root / "xhs.png"
        self.video.write_bytes(b"approved-video")
        for cover in (self.master_cover, self.douyin_cover, self.xhs_cover):
            cover.write_bytes(b"approved-cover-" + cover.name.encode())
        self.package.write_text(
            json.dumps(
                {
                    "video": str(self.video.resolve()),
                    "cover_master": str(self.master_cover.resolve()),
                    "cover_variants": {
                        "douyin_cover": str(self.douyin_cover.resolve()),
                        "xiaohongshu_cover": str(self.xhs_cover.resolve()),
                    },
                }
            ),
            encoding="utf-8",
        )
        self.targets = self.root / "targets.json"
        self.output = self.root / "evidence"
        self.client = FakeClient()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def verify(_: Path) -> dict[str, object]:
        return {
            "status": "package_validated",
            "release_revision_id": REVISION_ID,
            "release_revision_hash": REVISION_HASH,
        }

    def write_targets(self, targets: list[dict[str, object]]) -> None:
        self.targets.write_text(
            json.dumps({"schema_version": release.TARGETS_SCHEMA, "targets": targets}),
            encoding="utf-8",
        )

    def youtube_target(self) -> dict[str, object]:
        return {
            "platform": "youtube",
            "account_id": "account-1",
            "content_type": "VIDEO",
            "publish_timing": {"mode": "immediate"},
            "data": {
                "title": "精确标题",
                "content": "精确文案",
                "video": str(self.video.resolve()),
                "cover": str(self.master_cover.resolve()),
                "visibility": "public",
            },
        }

    def prepare_youtube(self) -> Path:
        self.write_targets([self.youtube_target()])
        result = release.prepare(
            self.package,
            self.targets,
            self.output,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        self.assertEqual(result["status"], "ready")
        return Path(result["targets"][0]["prepared"])

    def test_preflight_is_read_only_and_records_runtime_capabilities(self) -> None:
        output = self.root / "preflight.json"
        result = release.preflight(output, client=self.client)
        self.assertEqual(result["status"], "preflight_ok")
        self.assertEqual(result["runtime_version"], "test")
        self.assertEqual(result["platforms"]["platforms"][0]["id"], "youtube")
        self.assertEqual(self.client.create_calls, [])
        self.assertTrue(output.is_file())

    def test_preflight_rejects_unhealthy_or_unversioned_runtime(self) -> None:
        unsafe_health = (
            {"status": "error", "version": "test"},
            {"status": "unknown", "version": "test"},
            {"status": "ok"},
            {"version": "test"},
        )
        for index, health in enumerate(unsafe_health):
            with self.subTest(health=health):
                self.client.health_response = health
                output = self.root / f"preflight-{index}.json"
                with self.assertRaises(release.MultiPostReleaseError):
                    release.preflight(output, client=self.client)
                self.assertFalse(output.exists())
                self.assertEqual(self.client.create_calls, [])

    def test_prepare_verifies_runtime_and_forces_auto_submit_false(self) -> None:
        prepared = self.prepare_youtube()
        self.assertEqual(len(self.client.create_calls), 1)
        call = self.client.create_calls[0]
        self.assertIs(call["auto_submit"], False)
        self.assertEqual(call["account_ids"], ["account-1"])
        self.assertEqual(call["content_type"], "VIDEO")
        self.assertEqual(call["data"]["visibility"], "public")
        self.assertNotIn("scheduledPublishTime", call["data"])
        self.assertNotIn("control", call["data"])
        evidence = json.loads(prepared.read_text(encoding="utf-8"))
        self.assertEqual(evidence["status"], "ready")
        self.assertEqual(evidence["runtime_version"], "test")
        self.assertEqual(evidence["canary_status"], "passed")
        self.assertEqual(evidence["runtime_canary"]["platform"], "youtube")
        self.assertEqual(evidence["runtime_canary"]["content_type"], "VIDEO")
        self.assertEqual(evidence["runtime_canary"]["runtime_status"], "ready")
        self.assertEqual(evidence["visibility"], "public")
        self.assertEqual(evidence["publish_timing"], {"mode": "immediate"})
        self.assertEqual(evidence["cover_policy"], "package_cover")
        self.assertEqual(
            evidence["payload"]["control"],
            {
                "visibility": "public",
                "publish_timing": {"mode": "immediate"},
                "cover_policy": "package_cover",
            },
        )
        self.assertEqual(
            evidence["payload_sha256"],
            distribution.payload_sha256(evidence["payload"]),
        )
        self.assertEqual(evidence["screenshot_sha256"], release._sha256_file(evidence["screenshot_path"]))
        self.assertEqual(
            evidence["runtime_canary"]["screenshot_sha256"],
            evidence["screenshot_sha256"],
        )
        self.assertEqual(
            Path(evidence["state_dir"]),
            (self.package.parent / "multipost_distribution").resolve(),
        )

    def test_prepare_rejects_unsafe_timing_before_any_desktop_side_effect(self) -> None:
        self.write_targets([self.youtube_target()])
        unsafe_timeouts = (
            -1.0,
            float("nan"),
            float("inf"),
            release.MAX_POLL_TIMEOUT_SECONDS + 1,
        )
        for index, value in enumerate(unsafe_timeouts):
            with self.subTest(timeout_seconds=value):
                with self.assertRaises(release.MultiPostReleaseError):
                    release.prepare(
                        self.package,
                        self.targets,
                        self.root / f"unsafe-timeout-{index}",
                        client=self.client,
                        verify_func=self.verify,
                        timeout_seconds=value,
                        poll_interval=0,
                    )
                self.assertEqual(self.client.create_calls, [])
        unsafe_intervals = (
            -1.0,
            float("nan"),
            float("inf"),
            release.MAX_POLL_INTERVAL_SECONDS + 1,
        )
        for index, value in enumerate(unsafe_intervals):
            with self.subTest(poll_interval=value):
                with self.assertRaises(release.MultiPostReleaseError):
                    release.prepare(
                        self.package,
                        self.targets,
                        self.root / f"unsafe-interval-{index}",
                        client=self.client,
                        verify_func=self.verify,
                        timeout_seconds=0,
                        poll_interval=value,
                    )
                self.assertEqual(self.client.create_calls, [])

    def test_prepare_rejects_unhealthy_runtime_before_create(self) -> None:
        self.write_targets([self.youtube_target()])
        self.client.health_response = {"status": "error", "version": "test"}
        with self.assertRaises(release.MultiPostReleaseError):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_output_dir_cannot_change_idempotency_state_location(self) -> None:
        first = self.prepare_youtube()
        other_output = self.root / "different-evidence"
        second = release.prepare(
            self.package,
            self.targets,
            other_output,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        second_evidence = json.loads(Path(second["targets"][0]["prepared"]).read_text())
        first_evidence = json.loads(first.read_text())
        self.assertEqual(first_evidence["state_dir"], second_evidence["state_dir"])

    def test_runtime_account_binding_is_exact_before_any_prepare(self) -> None:
        target = self.youtube_target()
        target["account_id"] = "unknown-account"
        self.write_targets([target])
        with self.assertRaises(release.MultiPostReleaseError):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_wrong_video_is_blocked_before_any_desktop_create(self) -> None:
        target = self.youtube_target()
        target["data"] = dict(target["data"])
        target["data"]["video"] = str((self.root / "other.mp4").resolve())
        self.write_targets([target])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "verified package video"):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_arbitrary_cover_is_blocked_before_any_desktop_create(self) -> None:
        target = self.youtube_target()
        target["data"] = dict(target["data"])
        target["data"]["cover"] = str((self.root / "arbitrary.png").resolve())
        self.write_targets([target])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "verified package cover"):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_target_requires_explicit_visibility_and_publish_timing(self) -> None:
        missing_visibility = self.youtube_target()
        missing_visibility["data"] = dict(missing_visibility["data"])
        missing_visibility["data"].pop("visibility")
        blank_visibility = self.youtube_target()
        blank_visibility["data"] = dict(blank_visibility["data"])
        blank_visibility["data"]["visibility"] = "  "
        missing_timing = self.youtube_target()
        missing_timing.pop("publish_timing")
        cases = (
            (missing_visibility, "data.visibility"),
            (blank_visibility, "data.visibility"),
            (missing_timing, "publish_timing"),
        )
        for target, message in cases:
            with self.subTest(message=message):
                self.write_targets([target])
                with self.assertRaisesRegex(release.MultiPostReleaseError, message):
                    release.load_targets(self.targets)
        self.assertEqual(self.client.create_calls, [])

    def test_publish_timing_schema_is_closed_and_raw_schedule_is_rejected(self) -> None:
        invalid_timings = (
            {"mode": "later"},
            {"mode": "immediate", "scheduled_at": "2030-01-01T00:00:00Z"},
            {"mode": "scheduled_at"},
            {"mode": "scheduled_at", "scheduled_at": "2030-01-01T00:00:00"},
            {"mode": "scheduled_at", "scheduled_at": "2020-01-01T00:00:00Z"},
            {
                "mode": "scheduled_at",
                "scheduled_at": "2030-01-01T00:00:00Z",
                "timezone": "UTC",
            },
        )
        for timing in invalid_timings:
            with self.subTest(timing=timing):
                target = self.youtube_target()
                target["publish_timing"] = timing
                self.write_targets([target])
                with self.assertRaises(release.MultiPostReleaseError):
                    release.load_targets(self.targets)

        target = self.youtube_target()
        target["data"] = dict(target["data"])
        target["data"]["scheduledPublishTime"] = 1_893_524_645_000
        self.write_targets([target])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "control metadata"):
            release.load_targets(self.targets)
        self.assertEqual(self.client.create_calls, [])

    def test_scheduled_timing_maps_to_documented_millisecond_field_and_evidence(self) -> None:
        target = self.youtube_target()
        target["publish_timing"] = {
            "mode": "scheduled_at",
            "scheduled_at": "2099-01-02T03:04:05+08:00",
        }
        self.write_targets([target])
        result = release.prepare(
            self.package,
            self.targets,
            self.output,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        self.assertEqual(result["status"], "ready")
        expected_timing = {
            "mode": "scheduled_at",
            "scheduled_at": "2099-01-01T19:04:05.000Z",
        }
        self.assertEqual(
            self.client.create_calls[0]["data"]["scheduledPublishTime"],
            4_070_977_445_000,
        )
        self.assertNotIn("publish_timing", self.client.create_calls[0]["data"])
        self.assertNotIn("control", self.client.create_calls[0]["data"])
        evidence = json.loads(
            Path(result["targets"][0]["prepared"]).read_text(encoding="utf-8")
        )
        self.assertEqual(evidence["publish_timing"], expected_timing)
        self.assertEqual(
            evidence["payload"]["control"]["publish_timing"], expected_timing
        )

    def test_expired_prepared_schedule_blocks_approval_and_submit(self) -> None:
        before_schedule = datetime(2099, 1, 1, tzinfo=timezone.utc)
        after_schedule = datetime(2099, 1, 1, 0, 0, 11, tzinfo=timezone.utc)
        target = self.youtube_target()
        target["publish_timing"] = {
            "mode": "scheduled_at",
            "scheduled_at": "2099-01-01T00:00:10Z",
        }
        self.write_targets([target])
        with patch.object(release, "_utc_now", return_value=before_schedule):
            result = release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
            prepared = Path(result["targets"][0]["prepared"])
            approval_path = self.root / "approval.json"
            release.approve(
                prepared,
                "youtube:account-1",
                approval_path,
                confirmed_by_user=True,
            )

        expired_approval = self.root / "expired-approval.json"
        with patch.object(release, "_utc_now", return_value=after_schedule):
            with self.assertRaisesRegex(
                release.MultiPostReleaseError, "publish_timing is invalid or expired"
            ):
                release.approve(
                    prepared,
                    "youtube:account-1",
                    expired_approval,
                    confirmed_by_user=True,
                )
            with self.assertRaisesRegex(
                release.MultiPostReleaseError, "publish_timing is invalid or expired"
            ):
                release.submit(
                    self.package,
                    prepared,
                    approval_path,
                    self.root / "submission.json",
                    client=self.client,
                    verify_func=self.verify,
                    timeout_seconds=0,
                    poll_interval=0,
                )
        self.assertFalse(expired_approval.exists())
        self.assertFalse((self.root / "submission.json").exists())
        self.assertEqual(self.client.submit_calls, [])

    def test_video_requires_package_cover_and_ig_x_forbid_cover_fields(self) -> None:
        video = self.youtube_target()
        video["data"] = dict(video["data"])
        video["data"].pop("cover")
        self.write_targets([video])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "data.cover"):
            release.load_targets(self.targets)

        instagram = {
            "platform": "instagram",
            "account_id": "ig-1",
            "content_type": "DYNAMIC",
            "surface": "ordinary_post",
            "publish_timing": {"mode": "immediate"},
            "data": {
                "content": "hello",
                "videos": [str(self.video.resolve())],
                "visibility": "public",
            },
        }
        for policy in (None, "package_cover"):
            with self.subTest(cover_policy=policy):
                candidate = dict(instagram)
                if policy is not None:
                    candidate["cover_policy"] = policy
                self.write_targets([candidate])
                with self.assertRaisesRegex(release.MultiPostReleaseError, "cover_policy"):
                    release.load_targets(self.targets)

        instagram["cover_policy"] = "not_applicable"
        instagram["data"] = dict(instagram["data"])
        instagram["data"]["cover"] = str(self.master_cover.resolve())
        self.write_targets([instagram])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "forbids cover fields"):
            release.load_targets(self.targets)
        self.assertEqual(self.client.create_calls, [])

    def test_wechat_two_cover_target_is_blocked_before_runtime_mutation(self) -> None:
        self.write_targets(
            [
                {
                    "platform": "wechat_channels",
                    "account_id": "wx-1",
                    "content_type": "VIDEO",
                    "publish_timing": {"mode": "immediate"},
                    "data": {
                        "video": "/tmp/video.mp4",
                        "cover": "/tmp/one.png",
                        "visibility": "public",
                    },
                }
            ]
        )
        with self.assertRaisesRegex(release.MultiPostReleaseError, "manual_required"):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_instagram_requires_dynamic_ordinary_post(self) -> None:
        for content_type, surface in (("VIDEO", "ordinary_post"), ("DYNAMIC", "reel")):
            with self.subTest(content_type=content_type, surface=surface):
                self.write_targets(
                    [
                        {
                            "platform": "instagram",
                            "account_id": "ig-1",
                            "content_type": content_type,
                            "surface": surface,
                            "cover_policy": "not_applicable",
                            "publish_timing": {"mode": "immediate"},
                            "data": {
                                "content": "hello",
                                "video": "/tmp/video.mp4",
                                "visibility": "public",
                            },
                        }
                    ]
                )
                with self.assertRaisesRegex(release.MultiPostReleaseError, "ordinary_post"):
                    release.load_targets(self.targets)

    def test_non_ig_x_target_cannot_bypass_video_binding(self) -> None:
        target = self.youtube_target()
        target["content_type"] = "ARTICLE"
        target["data"] = {"title": "not a video"}
        self.write_targets([target])
        with self.assertRaisesRegex(release.MultiPostReleaseError, "must use VIDEO"):
            release.prepare(
                self.package,
                self.targets,
                self.output,
                client=self.client,
                verify_func=self.verify,
            )
        self.assertEqual(self.client.create_calls, [])

    def test_prepare_stops_after_first_non_ready_target(self) -> None:
        instagram = {
            "platform": "instagram",
            "account_id": "ig-1",
            "content_type": "DYNAMIC",
            "surface": "ordinary_post",
            "cover_policy": "not_applicable",
            "publish_timing": {"mode": "immediate"},
            "data": {
                "content": "hello",
                "videos": [str(self.video.resolve())],
                "visibility": "public",
            },
        }
        self.write_targets([self.youtube_target(), instagram])
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "failed",
                "targets": [{"accountId": "account-1", "status": "failed"}],
            }
        ]
        result = release.prepare(
            self.package,
            self.targets,
            self.output,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        self.assertEqual(result["status"], "partial_or_blocked")
        self.assertEqual(len(self.client.create_calls), 1)
        self.assertEqual(result["targets"][1]["status"], "not_attempted")

    def test_approval_requires_explicit_flag_and_unchanged_screenshot(self) -> None:
        prepared = self.prepare_youtube()
        key = "youtube:account-1"
        with self.assertRaises(distribution.AuthorizationError):
            release.approve(
                prepared,
                key,
                self.root / "approval.json",
                confirmed_by_user=False,
            )
        evidence = json.loads(prepared.read_text())
        Path(evidence["screenshot_path"]).write_bytes(PNG + b"tampered")
        with self.assertRaisesRegex(release.MultiPostReleaseError, "screenshot bytes changed"):
            release.approve(
                prepared,
                key,
                self.root / "approval.json",
                confirmed_by_user=True,
            )

    def test_approval_rejects_tampered_runtime_canary_binding(self) -> None:
        prepared = self.prepare_youtube()
        evidence = json.loads(prepared.read_text(encoding="utf-8"))
        evidence["runtime_canary"]["content_type"] = "DYNAMIC"
        prepared.write_text(json.dumps(evidence), encoding="utf-8")
        with self.assertRaisesRegex(release.MultiPostReleaseError, "canary binding mismatch"):
            release.approve(
                prepared,
                "youtube:account-1",
                self.root / "approval.json",
                confirmed_by_user=True,
            )

    def test_approval_rejects_tampered_visibility_timing_cover_control(self) -> None:
        prepared = self.prepare_youtube()
        evidence = json.loads(prepared.read_text(encoding="utf-8"))
        evidence["payload"]["control"]["visibility"] = "private"
        prepared.write_text(json.dumps(evidence), encoding="utf-8")
        with self.assertRaisesRegex(release.MultiPostReleaseError, "payload/control hash"):
            release.approve(
                prepared,
                "youtube:account-1",
                self.root / "approval.json",
                confirmed_by_user=True,
            )

    def test_submit_rejects_tampered_approval_control_binding(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        evidence = json.loads(approval_path.read_text(encoding="utf-8"))
        evidence["publish_timing"] = {
            "mode": "scheduled_at",
            "scheduled_at": "2030-01-01T00:00:00.000Z",
        }
        approval_path.write_text(json.dumps(evidence), encoding="utf-8")
        with self.assertRaisesRegex(
            release.MultiPostReleaseError, "approval prepared binding mismatch"
        ):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "submission.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(self.client.submit_calls, [])

    def test_submit_reverifies_package_and_submits_one_authorized_target(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        approval_evidence = release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
            approval_note="用户已核对截图、账号、文案、封面和可见性",
        )
        self.assertEqual(approval_evidence["visibility"], "public")
        self.assertEqual(approval_evidence["publish_timing"], {"mode": "immediate"})
        self.assertEqual(approval_evidence["cover_policy"], "package_cover")
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            },
            {
                "groupId": "group-1",
                "status": "success",
                "targets": [
                    {
                        "accountId": "account-1",
                        "status": "success",
                        "postId": "post-1",
                        "url": "https://example.test/post-1",
                    }
                ],
            }
        ]
        verification_calls: list[Path] = []

        def verify(path: Path) -> dict[str, object]:
            verification_calls.append(path)
            return self.verify(path)

        receipt_path = self.root / "submission.json"
        result = release.submit(
            self.package,
            prepared,
            approval_path,
            receipt_path,
            client=self.client,
            verify_func=verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["runtime_version"], "test")
        self.assertEqual(result["canary_status"], "passed")
        self.assertEqual(
            result["runtime_canary_sha256"], result["receipt"]["runtime_canary_sha256"]
        )
        self.assertEqual(verification_calls, [self.package.resolve()])
        self.assertEqual(len(self.client.submit_calls), 1)
        authorization = self.client.submit_calls[0]["approval"]
        self.assertTrue(authorization["authorized"])
        self.assertEqual(authorization["account_id"], "account-1")
        self.assertEqual(
            authorization["authorization_id"], result["receipt"]["authorization_id"]
        )

        creates_before = len(self.client.create_calls)
        submits_before = len(self.client.submit_calls)
        reconciled = release.status(receipt_path, receipt_path, client=self.client)
        self.assertEqual(reconciled["status"], "success")
        self.assertEqual(len(self.client.create_calls), creates_before)
        self.assertEqual(len(self.client.submit_calls), submits_before)

    def test_submit_rejects_unsafe_timing_before_public_side_effect(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        unsafe_timing = (
            (-1.0, 0.0),
            (float("nan"), 0.0),
            (float("inf"), 0.0),
            (release.MAX_POLL_TIMEOUT_SECONDS + 1, 0.0),
            (0.0, -1.0),
            (0.0, float("nan")),
            (0.0, float("inf")),
            (0.0, release.MAX_POLL_INTERVAL_SECONDS + 1),
        )
        for index, (timeout_seconds, poll_interval) in enumerate(unsafe_timing):
            with self.subTest(
                timeout_seconds=timeout_seconds, poll_interval=poll_interval
            ):
                with self.assertRaises(release.MultiPostReleaseError):
                    release.submit(
                        self.package,
                        prepared,
                        approval_path,
                        self.root / f"unsafe-submit-{index}.json",
                        client=self.client,
                        verify_func=self.verify,
                        timeout_seconds=timeout_seconds,
                        poll_interval=poll_interval,
                    )
                self.assertEqual(self.client.submit_calls, [])

    def test_retry_flag_rejects_first_submit_before_public_side_effect(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        with self.assertRaisesRegex(
            distribution.SubmissionBlockedError, "existing failed publish receipt"
        ):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "not-a-retry.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
                retry_failed=True,
            )
        self.assertEqual(self.client.submit_calls, [])

    def test_submit_rejects_runtime_version_change_after_canary(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        self.client.health_response = {"status": "ok", "version": "changed"}
        with self.assertRaisesRegex(release.MultiPostReleaseError, "version changed"):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "version-changed.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(self.client.submit_calls, [])

    def test_submit_does_not_use_group_failure_when_exact_account_is_missing(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            },
            {
                "groupId": "group-1",
                "status": "failed",
                "targets": [{"accountId": "different-account", "status": "failed"}],
            },
        ]

        result = release.submit(
            self.package,
            prepared,
            approval_path,
            self.root / "submission.json",
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )

        self.assertEqual(result["status"], "unknown")
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            }
        ]
        with self.assertRaises(distribution.SubmissionBlockedError):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "retry.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(len(self.client.submit_calls), 1)

    def test_network_interruption_stays_unknown_until_exact_target_reconciles(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            }
        ]
        self.client.submit_error = TimeoutError("connection dropped after submit request")
        submission_path = self.root / "submission.json"

        submitted = release.submit(
            self.package,
            prepared,
            approval_path,
            submission_path,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )
        self.assertEqual(submitted["status"], "unknown")

        self.client.submit_error = None
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "failed",
                "targets": [{"accountId": "different-account", "status": "failed"}],
            }
        ]
        reconciled = release.status(
            submission_path,
            self.root / "status.json",
            client=self.client,
        )
        self.assertEqual(reconciled["status"], "unknown")

        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "ready",
                "targets": [{"accountId": "account-1", "status": "ready"}],
            }
        ]
        with self.assertRaises(distribution.SubmissionBlockedError):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "retry.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(len(self.client.submit_calls), 1)

    def test_submit_rechecks_runtime_ready_before_reserving_submission(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )
        self.client.statuses = [
            {
                "groupId": "group-1",
                "status": "filling",
                "targets": [{"accountId": "account-1", "status": "filling"}],
            }
        ]
        with self.assertRaisesRegex(release.MultiPostReleaseError, "no longer ready"):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "submission.json",
                client=self.client,
                verify_func=self.verify,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(self.client.submit_calls, [])
        state_dir = self.package.parent / "multipost_distribution"
        plan = distribution.load_distribution_plan(state_dir)
        receipt_path = distribution.publish_receipt_path(
            state_dir, plan["targets"][0]["idempotency_key"]
        )
        self.assertFalse(receipt_path.exists())

    def test_changed_release_revision_is_blocked_before_submit(self) -> None:
        prepared = self.prepare_youtube()
        approval_path = self.root / "approval.json"
        release.approve(
            prepared,
            "youtube:account-1",
            approval_path,
            confirmed_by_user=True,
        )

        def changed(_: Path) -> dict[str, object]:
            return {
                "release_revision_id": REVISION_ID,
                "release_revision_hash": "b" * 64,
            }

        with self.assertRaises(distribution.AuthorizationError):
            release.submit(
                self.package,
                prepared,
                approval_path,
                self.root / "submission.json",
                client=self.client,
                verify_func=changed,
                timeout_seconds=0,
                poll_interval=0,
            )
        self.assertEqual(self.client.submit_calls, [])

    def test_prepare_three_platforms_ready_without_submit(self) -> None:
        video = str(self.video.resolve())
        youtube_cover = str(self.master_cover.resolve())
        douyin_cover = str(self.douyin_cover.resolve())
        immediate = {"mode": "immediate"}
        self.write_targets(
            [
                {
                    "platform": "youtube",
                    "account_id": "account-1",
                    "content_type": "VIDEO",
                    "publish_timing": immediate,
                    "data": {
                        "title": "YouTube title",
                        "content": "YouTube copy",
                        "video": video,
                        "cover": youtube_cover,
                        "visibility": "public",
                    },
                },
                {
                    "platform": "douyin",
                    "account_id": "douyin-1",
                    "content_type": "VIDEO",
                    "publish_timing": immediate,
                    "data": {
                        "title": "Douyin title",
                        "content": "Douyin copy",
                        "video": video,
                        "cover": douyin_cover,
                        "visibility": "public",
                    },
                },
                {
                    "platform": "instagram",
                    "account_id": "ig-1",
                    "content_type": "DYNAMIC",
                    "surface": "ordinary_post",
                    "cover_policy": "not_applicable",
                    "publish_timing": immediate,
                    "data": {
                        "content": "Instagram copy",
                        "videos": [video],
                        "visibility": "public",
                    },
                },
            ]
        )
        expected_groups = ["group-youtube", "group-douyin", "group-instagram"]
        self.client.create_group_ids = list(expected_groups)
        self.client.statuses = [
            {
                "groupId": "group-youtube",
                "status": "ready",
                "targets": [
                    {
                        "accountId": "account-1",
                        "platform": "youtube",
                        "status": "ready",
                    }
                ],
            },
            {
                "groupId": "group-douyin",
                "status": "ready",
                "targets": [
                    {
                        "accountId": "douyin-1",
                        "platform": "douyin",
                        "status": "ready",
                    }
                ],
            },
            {
                "groupId": "group-instagram",
                "status": "ready",
                "targets": [
                    {
                        "accountId": "ig-1",
                        "platform": "instagram",
                        "status": "ready",
                    }
                ],
            },
        ]

        result = release.prepare(
            self.package,
            self.targets,
            self.output,
            client=self.client,
            verify_func=self.verify,
            timeout_seconds=0,
            poll_interval=0,
        )

        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["targets"]), 3)
        self.assertEqual(len(self.client.create_calls), 3)
        self.assertTrue(all(call["auto_submit"] is False for call in self.client.create_calls))
        self.assertEqual(self.client.submit_calls, [])

        youtube_call, douyin_call, instagram_call = self.client.create_calls
        self.assertEqual(youtube_call["account_ids"], ["account-1"])
        self.assertEqual(youtube_call["content_type"], "VIDEO")
        self.assertEqual(youtube_call["data"]["video"], video)
        self.assertEqual(youtube_call["data"]["cover"], youtube_cover)
        self.assertEqual(douyin_call["account_ids"], ["douyin-1"])
        self.assertEqual(douyin_call["content_type"], "VIDEO")
        self.assertEqual(douyin_call["data"]["video"], video)
        self.assertEqual(douyin_call["data"]["cover"], douyin_cover)
        self.assertEqual(instagram_call["account_ids"], ["ig-1"])
        self.assertEqual(instagram_call["content_type"], "DYNAMIC")
        self.assertEqual(instagram_call["data"]["videos"], [video])
        self.assertNotIn("cover", instagram_call["data"])
        for call in self.client.create_calls:
            self.assertEqual(call["data"]["visibility"], "public")
            self.assertNotIn("publish_timing", call["data"])
            self.assertNotIn("scheduled_at", call["data"])
            self.assertNotIn("scheduledPublishTime", call["data"])

        prepared = [
            json.loads(Path(item["prepared"]).read_text(encoding="utf-8"))
            for item in result["targets"]
        ]
        self.assertEqual([item["group_id"] for item in prepared], expected_groups)
        expected_controls = [
            {
                "visibility": "public",
                "publish_timing": immediate,
                "cover_policy": "package_cover",
            },
            {
                "visibility": "public",
                "publish_timing": immediate,
                "cover_policy": "package_cover",
            },
            {
                "visibility": "public",
                "publish_timing": immediate,
                "cover_policy": "not_applicable",
            },
        ]
        for evidence, expected_group, expected_control in zip(
            prepared, expected_groups, expected_controls, strict=True
        ):
            self.assertEqual(evidence["runtime_snapshot"]["groupId"], expected_group)
            self.assertEqual(evidence["runtime_target"]["accountId"], evidence["account_id"])
            self.assertEqual(evidence["runtime_target"]["platform"], evidence["platform"])
            self.assertEqual(evidence["runtime_target"]["status"], "ready")
            self.assertEqual(evidence["payload"]["control"], expected_control)
            self.assertEqual(evidence["visibility"], expected_control["visibility"])
            self.assertEqual(evidence["publish_timing"], expected_control["publish_timing"])
            self.assertEqual(evidence["cover_policy"], expected_control["cover_policy"])


if __name__ == "__main__":
    unittest.main()
