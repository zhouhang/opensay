from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SKILL_ROOT = Path(__file__).parents[1]
SCRIPTS = SKILL_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

import multipost_distribution as distribution  # noqa: E402


NOW = datetime(2026, 8, 30, 8, 0, 0, tzinfo=timezone.utc)
REVISION_ID = "release-test-r1"
REVISION_HASH = "a" * 64
PAYLOAD = {
    "type": "VIDEO",
    "title": "测试标题",
    "description": "测试发布文案",
    "video": "/tmp/final.mp4",
    "cover": "/tmp/cover.png",
    "visibility": "public",
}


class MultiPostDistributionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.package = self.root / "publish_package.json"
        self.package.write_text(
            json.dumps(
                {
                    "schema_version": "video-release-package-v1",
                    "status": "approved",
                    "release_revision_id": REVISION_ID,
                }
            ),
            encoding="utf-8",
        )
        self.package_before = self.package.read_bytes()
        self.state = self.root / "multipost"
        self.screenshot = self.root / "ready.png"
        self.screenshot.write_bytes(b"\x89PNG\r\n\x1a\nprepared-review")
        distribution.create_distribution_plan(
            self.state,
            release_package=self.package,
            release_revision_id=REVISION_ID,
            release_revision_hash=REVISION_HASH,
            targets=[
                {
                    "platform": "youtube",
                    "account_id": "channel-123",
                    "payload": PAYLOAD,
                }
            ],
            now=NOW,
        )
        self.prepared = distribution.record_prepared_target(
            self.state,
            platform="youtube",
            account_id="channel-123",
            group_id="group-1",
            prepared_payload=PAYLOAD,
            auto_submit=False,
            screenshot_path=self.screenshot.resolve(),
            runtime_version="test-runtime-1",
            canary_passed=True,
            now=NOW + timedelta(seconds=5),
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def approve(
        self,
        *,
        ttl_seconds: int = 900,
        at: datetime = NOW + timedelta(seconds=10),
    ) -> dict[str, object]:
        return distribution.approve_target(
            self.state,
            platform="youtube",
            account_id="channel-123",
            confirmed_by_user=True,
            approval_note="用户核对账号、文案、封面和可见性后确认",
            ttl_seconds=ttl_seconds,
            now=at,
        )

    def require(self, **overrides: object) -> dict[str, object]:
        arguments: dict[str, object] = {
            "platform": "youtube",
            "account_id": "channel-123",
            "group_id": "group-1",
            "payload": PAYLOAD,
            "current_release_revision_id": REVISION_ID,
            "current_release_revision_hash": REVISION_HASH,
            "now": NOW + timedelta(seconds=20),
        }
        arguments.update(overrides)
        return distribution.require_publish_authorization(self.state, **arguments)

    def begin(self, **overrides: object) -> dict[str, object]:
        arguments: dict[str, object] = {
            "platform": "youtube",
            "account_id": "channel-123",
            "group_id": "group-1",
            "payload": PAYLOAD,
            "current_release_revision_id": REVISION_ID,
            "current_release_revision_hash": REVISION_HASH,
            "now": NOW + timedelta(seconds=20),
        }
        arguments.update(overrides)
        return distribution.begin_submission(self.state, **arguments)

    def test_explicit_current_user_approval_authorizes_exact_binding(self) -> None:
        approval = self.approve()

        authorization = self.require()

        self.assertTrue(authorization["authorized"])
        self.assertEqual(authorization["approval_id"], approval["approval_id"])
        self.assertEqual(authorization["group_id"], "group-1")
        self.assertEqual(authorization["target_id"], "youtube:channel-123")
        self.assertEqual(authorization["account_id"], "channel-123")
        self.assertEqual(authorization["release_revision_hash"], REVISION_HASH)
        self.assertEqual(
            authorization["runtime_canary_sha256"],
            self.prepared["runtime_canary_sha256"],
        )
        self.assertEqual(self.package.read_bytes(), self.package_before)

    def test_refuses_implicit_approval(self) -> None:
        with self.assertRaises(distribution.AuthorizationError):
            distribution.approve_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                confirmed_by_user=False,
                now=NOW + timedelta(seconds=10),
            )

    def test_stale_approval_is_invalid_after_new_prepare_receipt(self) -> None:
        self.approve()
        distribution.record_prepared_target(
            self.state,
            platform="youtube",
            account_id="channel-123",
            group_id="group-2",
            prepared_payload=PAYLOAD,
            auto_submit=False,
            screenshot_path=self.screenshot.resolve(),
            runtime_version="test-runtime-1",
            canary_passed=True,
            now=NOW + timedelta(seconds=15),
        )

        with self.assertRaises(distribution.AuthorizationError):
            self.require(group_id="group-2")

    def test_wrong_account_is_not_authorized(self) -> None:
        self.approve()

        with self.assertRaises(distribution.DistributionStateError):
            self.require(account_id="different-account")

    def test_approval_binds_exact_group_and_target_id(self) -> None:
        self.approve()
        with self.assertRaises(distribution.AuthorizationError):
            self.require(group_id="different-group")

        path = distribution.approval_path(self.state, "youtube:channel-123")
        approval = json.loads(path.read_text(encoding="utf-8"))
        approval["target_id"] = "youtube:different-account"
        path.write_text(json.dumps(approval), encoding="utf-8")
        with self.assertRaises(distribution.AuthorizationError):
            self.require()

    def test_expired_approval_is_not_authorized(self) -> None:
        self.approve(ttl_seconds=30)

        with self.assertRaises(distribution.AuthorizationError):
            self.require(now=NOW + timedelta(seconds=40))

    def test_current_release_hash_must_match_approval(self) -> None:
        self.approve()

        with self.assertRaises(distribution.AuthorizationError):
            self.require(current_release_revision_hash="b" * 64)

    def test_changed_payload_is_not_authorized(self) -> None:
        self.approve()
        changed = dict(PAYLOAD)
        changed["visibility"] = "private"

        with self.assertRaises(distribution.AuthorizationError):
            self.require(payload=changed)

    def test_submitting_and_success_suppress_duplicate_submission(self) -> None:
        self.approve()
        authorization = self.require()
        first = self.begin()
        self.assertEqual(first["status"], "submitting")

        with self.assertRaises(distribution.SubmissionBlockedError):
            self.begin(now=NOW + timedelta(seconds=21))

        success = distribution.record_publish_result(
            self.state,
            authorization,
            status="success",
            remote_post_id="video-123",
            remote_post_url="https://example.test/video-123",
            now=NOW + timedelta(seconds=22),
        )
        self.assertEqual(success["status"], "success")
        with self.assertRaises(distribution.SubmissionBlockedError):
            self.begin(now=NOW + timedelta(seconds=23))

    def test_unknown_status_blocks_even_explicit_retry(self) -> None:
        self.approve()
        authorization = self.require()
        self.begin()
        unknown = distribution.record_publish_result(
            self.state,
            authorization,
            status="unknown",
            error="request timed out after submit click; remote outcome is unknown",
            now=NOW + timedelta(seconds=21),
        )
        self.assertEqual(unknown["status"], "unknown")

        with self.assertRaises(distribution.SubmissionBlockedError):
            distribution.retry_failed_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-1",
                payload=PAYLOAD,
                current_release_revision_id=REVISION_ID,
                current_release_revision_hash=REVISION_HASH,
                now=NOW + timedelta(seconds=22),
            )

    def test_retry_flag_rejects_a_first_submission_without_failed_receipt(self) -> None:
        self.approve()
        with self.assertRaisesRegex(
            distribution.SubmissionBlockedError, "existing failed publish receipt"
        ):
            distribution.retry_failed_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-1",
                payload=PAYLOAD,
                current_release_revision_id=REVISION_ID,
                current_release_revision_hash=REVISION_HASH,
                now=NOW + timedelta(seconds=20),
            )

    def test_failed_target_requires_explicit_single_target_retry(self) -> None:
        old_approval = self.approve()
        authorization = self.require()
        self.begin()
        failed = distribution.record_publish_result(
            self.state,
            authorization,
            status="failed",
            error="platform rejected the request before creating a post",
            now=NOW + timedelta(seconds=21),
        )
        self.assertEqual(failed["status"], "failed")

        with self.assertRaises(distribution.FailedRetryRequiresExplicitOptIn):
            self.begin(now=NOW + timedelta(seconds=22))

        with self.assertRaises(distribution.AuthorizationError):
            distribution.retry_failed_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-1",
                payload=PAYLOAD,
                current_release_revision_id=REVISION_ID,
                current_release_revision_hash=REVISION_HASH,
                now=NOW + timedelta(seconds=22),
            )

        same_time_approval = self.approve(at=NOW + timedelta(seconds=21))
        self.assertNotEqual(same_time_approval["approval_id"], old_approval["approval_id"])
        with self.assertRaises(distribution.AuthorizationError):
            distribution.retry_failed_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-1",
                payload=PAYLOAD,
                current_release_revision_id=REVISION_ID,
                current_release_revision_hash=REVISION_HASH,
                now=NOW + timedelta(seconds=22),
            )

        new_approval = self.approve(at=NOW + timedelta(seconds=22))
        self.assertNotEqual(new_approval["approval_id"], old_approval["approval_id"])
        self.assertNotEqual(
            new_approval["authorization_id"], old_approval["authorization_id"]
        )
        retried = distribution.retry_failed_target(
            self.state,
            platform="youtube",
            account_id="channel-123",
            group_id="group-1",
            payload=PAYLOAD,
            current_release_revision_id=REVISION_ID,
            current_release_revision_hash=REVISION_HASH,
            now=NOW + timedelta(seconds=23),
        )
        self.assertEqual(retried["status"], "submitting")
        self.assertEqual(retried["attempt"], 2)

    def test_prepare_must_not_auto_submit_or_change_payload(self) -> None:
        with self.assertRaises(distribution.DistributionValidationError):
            distribution.record_prepared_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-dangerous",
                prepared_payload=PAYLOAD,
                auto_submit=True,
                now=NOW,
            )

        with self.assertRaises(distribution.DistributionValidationError):
            distribution.record_prepared_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-no-screenshot",
                prepared_payload=PAYLOAD,
                auto_submit=False,
                status="ready",
                now=NOW,
            )
        with self.assertRaisesRegex(
            distribution.DistributionValidationError, "passed non-public runtime canary"
        ):
            distribution.record_prepared_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-no-canary",
                prepared_payload=PAYLOAD,
                auto_submit=False,
                status="ready",
                screenshot_path=self.screenshot.resolve(),
                now=NOW,
            )
        changed = dict(PAYLOAD)
        changed["title"] = "替换标题"
        with self.assertRaises(distribution.DistributionValidationError):
            distribution.record_prepared_target(
                self.state,
                platform="youtube",
                account_id="channel-123",
                group_id="group-changed",
                prepared_payload=changed,
                auto_submit=False,
                now=NOW,
            )


if __name__ == "__main__":
    unittest.main()
