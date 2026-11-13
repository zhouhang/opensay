from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib import parse


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import multipost_desktop as multipost  # noqa: E402


TOKEN = "mp-secret-token-for-tests"
PNG = b"\x89PNG\r\n\x1a\nsynthetic"


class FakeMultiPostHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    requests: list[dict[str, object]] = []
    echo_token_error = False
    redirect_platforms_to: str | None = None
    redirect_platforms_status = 302

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _record(self, body: bytes = b"") -> None:
        self.__class__.requests.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": body,
            }
        )

    def _send_json(self, status: int, value: object) -> None:
        raw = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        parsed = parse.urlsplit(self.path)
        self._record()
        if parsed.path == "/v1/health":
            self._send_json(200, {"status": "ok"})
            return
        if (
            self.__class__.redirect_platforms_to is not None
            and parsed.path == "/v1/platforms"
        ):
            self.send_response(self.__class__.redirect_platforms_status)
            self.send_header("Location", self.__class__.redirect_platforms_to)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.__class__.echo_token_error and parsed.path == "/v1/platforms":
            self._send_json(
                401,
                {
                    "error": {
                        "code": "unauthorized",
                        "message": f"bad Bearer {TOKEN}; raw={TOKEN}",
                    }
                },
            )
            return
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send_json(401, {"error": {"message": "missing token"}})
            return
        if parsed.path == "/v1/platforms":
            self._send_json(
                200,
                {
                    "platforms": [
                        {
                            "id": "youtube",
                            "name": "YouTube",
                            "supportedContentTypes": ["VIDEO"],
                        }
                    ]
                },
            )
        elif parsed.path == "/v1/accounts":
            self._send_json(
                200,
                {
                    "accounts": [
                        {"id": "account-1", "platform": "youtube", "isLoggedIn": True}
                    ]
                },
            )
        elif parsed.path == "/v1/publish/group-1":
            self._send_json(
                200,
                {
                    "groupId": "group-1",
                    "status": "ready",
                    "targets": [{"accountId": "account-1", "status": "ready"}],
                },
            )
        elif parsed.path == "/v1/debug/screenshot":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        else:
            self._send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self._record(body)
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self._send_json(401, {"error": {"message": "missing token"}})
            return
        if self.path == "/v1/publish":
            self._send_json(
                202,
                {
                    "groupId": "group-1",
                    "status": {"status": "preparing", "targets": []},
                },
            )
        elif self.path == "/v1/publish/group-1/targets/account-1/submit":
            self._send_json(
                200,
                {
                    "groupId": "group-1",
                    "targets": [{"accountId": "account-1", "status": "publishing"}],
                },
            )
        else:
            self._send_json(404, {"error": {"message": "not found"}})


class MultiPostDesktopTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        FakeMultiPostHandler.requests = []
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeMultiPostHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self) -> None:
        FakeMultiPostHandler.requests = []
        FakeMultiPostHandler.echo_token_error = False
        FakeMultiPostHandler.redirect_platforms_to = None
        FakeMultiPostHandler.redirect_platforms_status = 302
        self.env = mock.patch.dict(os.environ, {multipost.TOKEN_ENV: TOKEN}, clear=False)
        self.env.start()
        self.client = multipost.MultiPostDesktopClient(self.base_url, timeout=2)

    def tearDown(self) -> None:
        self.env.stop()

    def test_rejects_every_non_loopback_or_non_http_base_url(self) -> None:
        localhost = multipost.MultiPostDesktopClient("http://localhost:19528")
        self.assertEqual(localhost.base_url, "http://localhost:19528")
        unsafe = [
            "https://127.0.0.1:19528",
            "http://192.168.1.3:19528",
            "http://localhost.example.com:19528",
            "http://user@localhost:19528",
            "http://localhost:19528/api",
        ]
        for url in unsafe:
            with self.subTest(url=url), self.assertRaises(
                multipost.MultiPostConfigurationError
            ):
                multipost.MultiPostDesktopClient(url)

    def test_health_needs_no_token_but_authenticated_calls_do(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            client = multipost.MultiPostDesktopClient(self.base_url)
            self.assertEqual(client.health(), {"status": "ok"})
            with self.assertRaises(multipost.MultiPostConfigurationError):
                client.list_platforms()
        self.assertIsNone(FakeMultiPostHandler.requests[0]["authorization"])

    def test_token_is_redacted_from_api_errors_and_repr(self) -> None:
        FakeMultiPostHandler.echo_token_error = True
        with self.assertRaises(multipost.MultiPostRequestError) as caught:
            self.client.list_platforms()
        rendered = f"{caught.exception!s} {caught.exception!r} {self.client!r}"
        self.assertNotIn(TOKEN, rendered)
        self.assertIn("[REDACTED]", rendered)

        with self.assertRaises(multipost.MultiPostConfigurationError) as malformed:
            multipost.MultiPostDesktopClient(f"http://localhost:{TOKEN}")
        self.assertNotIn(TOKEN, str(malformed.exception))

    def test_authenticated_calls_reject_redirects_without_forwarding_token(self) -> None:
        FakeMultiPostHandler.redirect_platforms_to = f"{self.base_url}/redirect-target"

        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                FakeMultiPostHandler.requests = []
                FakeMultiPostHandler.redirect_platforms_status = status
                with self.assertRaisesRegex(
                    multipost.MultiPostRequestError, rf"HTTP {status}"
                ):
                    self.client.list_platforms()
                self.assertEqual(
                    [request["path"] for request in FakeMultiPostHandler.requests],
                    ["/v1/platforms"],
                )

    def test_loopback_calls_ignore_system_http_proxies(self) -> None:
        unreachable_proxy = "http://127.0.0.1:1"
        with mock.patch.object(
            multipost.request,
            "getproxies",
            return_value={"http": unreachable_proxy, "https": unreachable_proxy},
        ), mock.patch.object(multipost.request, "proxy_bypass", return_value=False):
            client = multipost.MultiPostDesktopClient(self.base_url, timeout=0.2)
            platforms = client.list_platforms()

        self.assertEqual(platforms["platforms"][0]["id"], "youtube")
        self.assertEqual(FakeMultiPostHandler.requests[-1]["path"], "/v1/platforms")

    def test_lists_platforms_and_filtered_accounts(self) -> None:
        platforms = self.client.list_platforms()
        accounts = self.client.list_accounts(platform="youtube", group_id="creators")
        self.assertEqual(platforms["platforms"][0]["id"], "youtube")
        self.assertEqual(accounts["accounts"][0]["id"], "account-1")
        request_path = FakeMultiPostHandler.requests[-1]["path"]
        self.assertIn("platform=youtube", request_path)
        self.assertIn("groupId=creators", request_path)

    def test_create_publish_always_sends_auto_submit_false(self) -> None:
        response = self.client.create_publish(
            content_type="video",
            account_ids=["account-1"],
            data={"title": "Title", "video": "/tmp/video.mp4"},
        )
        self.assertEqual(response["groupId"], "group-1")
        sent = json.loads(FakeMultiPostHandler.requests[-1]["body"])
        self.assertIs(sent["autoSubmit"], False)
        self.assertEqual(sent["contentType"], "VIDEO")

        count = len(FakeMultiPostHandler.requests)
        with self.assertRaises(multipost.MultiPostSafetyError):
            self.client.create_publish(
                content_type="VIDEO",
                account_ids=["account-1"],
                data={},
                auto_submit=True,
            )
        self.assertEqual(len(FakeMultiPostHandler.requests), count)

    def test_status_screenshot_and_approved_single_target_submit(self) -> None:
        status = self.client.get_publish_status("group-1")
        screenshot = self.client.take_screenshot(
            group_id="group-1", account_id="account-1"
        )
        result = self.client.submit_target(
            "group-1",
            "account-1",
            approval={
                "authorized": True,
                "authorization_id": "auth-1",
                "approval_id": "approval-1",
                "group_id": "group-1",
                "account_id": "account-1",
            },
        )
        self.assertEqual(status["status"], "ready")
        self.assertEqual(screenshot, PNG)
        self.assertEqual(result["targets"][0]["status"], "publishing")
        screenshot_path = FakeMultiPostHandler.requests[-2]["path"]
        self.assertIn("groupId=group-1", screenshot_path)
        self.assertIn("accountId=account-1", screenshot_path)

    def test_submit_requires_exact_verified_authorization(self) -> None:
        invalid = [
            None,
            {},
            {"authorized": False},
            {
                "authorized": True,
                "authorization_id": "auth-1",
                "approval_id": "approval-1",
                "group_id": "another-group",
                "account_id": "account-1",
            },
            {
                "authorized": True,
                "authorization_id": "auth-1",
                "approval_id": "approval-1",
                "group_id": "group-1",
                "account_id": "another-account",
            },
        ]
        for approval in invalid:
            with self.subTest(approval=approval), self.assertRaises(
                multipost.MultiPostSafetyError
            ):
                self.client.submit_target(
                    "group-1", "account-1", approval=approval  # type: ignore[arg-type]
                )
        self.assertFalse(
            any(
                request["method"] == "POST" and str(request["path"]).endswith("/submit")
                for request in FakeMultiPostHandler.requests
            )
        )


if __name__ == "__main__":
    unittest.main()
