#!/usr/bin/env python3
"""Small, safety-constrained client for the MultiPost Desktop local API.

The client deliberately exposes only the operations needed by the staged publishing
workflow.  In particular, task creation is always draft-only (``autoSubmit=false``),
and a single-target submit requires an authorization object produced by the upper
distribution-state layer.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib import error, parse, request


DEFAULT_BASE_URL = "http://127.0.0.1:19528"
TOKEN_ENV = "MULTIPOST_DESKTOP_TOKEN"
ALLOWED_CONTENT_TYPES = frozenset({"DYNAMIC", "VIDEO", "ARTICLE", "PODCAST"})
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class MultiPostDesktopError(RuntimeError):
    """Base error for a rejected or failed MultiPost Desktop operation."""


class MultiPostConfigurationError(MultiPostDesktopError):
    """The local endpoint or secret configuration is unsafe or incomplete."""


class MultiPostRequestError(MultiPostDesktopError):
    """The local API rejected a request or returned an invalid response."""


class MultiPostSafetyError(MultiPostDesktopError):
    """An operation was blocked by the staged-publishing safety policy."""


class _RejectRedirectHandler(request.HTTPRedirectHandler):
    """Turn every urllib-supported redirect into the original HTTP error."""

    def redirect_request(
        self,
        req: request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> request.Request | None:
        del newurl
        raise error.HTTPError(req.full_url, code, msg, headers, fp)


def _nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MultiPostSafetyError(f"{field} must be a non-empty string")
    return value.strip()


def _validated_base_url(value: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MultiPostConfigurationError("MultiPost Desktop base URL is required")
    try:
        parsed = parse.urlsplit(value.strip())
        # Accessing .port also validates malformed/out-of-range ports.
        port = parsed.port
    except ValueError as exc:
        raise MultiPostConfigurationError(
            "invalid MultiPost Desktop base URL: "
            f"{_redact(exc, os.environ.get(TOKEN_ENV))}"
        ) from None

    if parsed.scheme != "http":
        raise MultiPostConfigurationError(
            "MultiPost Desktop base URL must use http on the local loopback interface"
        )
    if parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise MultiPostConfigurationError(
            "MultiPost Desktop base URL must use 127.0.0.1 or localhost"
        )
    if parsed.username is not None or parsed.password is not None:
        raise MultiPostConfigurationError(
            "MultiPost Desktop base URL must not contain credentials"
        )
    if parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise MultiPostConfigurationError(
            "MultiPost Desktop base URL must not contain a path, query, or fragment"
        )
    if port is None:
        netloc = parsed.hostname
    else:
        netloc = f"{parsed.hostname}:{port}"
    return f"http://{netloc}"


def _redact(value: Any, token: str | None = None) -> str:
    text = str(value)
    if token:
        text = text.replace(token, "[REDACTED]")
    # Protect against an API echoing a different-looking Bearer value.
    return re.sub(r"(?i)Bearer\s+[^\s\"']+", "Bearer [REDACTED]", text)


def _redact_json(value: Any, token: str | None) -> Any:
    """Remove a token from any textual leaf before data leaves the client."""

    if isinstance(value, str):
        return _redact(value, token)
    if isinstance(value, list):
        return [_redact_json(item, token) for item in value]
    if isinstance(value, dict):
        return {
            _redact(key, token) if isinstance(key, str) else key: _redact_json(item, token)
            for key, item in value.items()
        }
    return value


class MultiPostDesktopClient:
    """HTTP client for a loopback-only MultiPost Desktop instance.

    The access token is intentionally not accepted as a constructor argument.  It is
    read from ``MULTIPOST_DESKTOP_TOKEN`` immediately before an authenticated call.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 15.0,
    ) -> None:
        self.base_url = _validated_base_url(base_url)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise MultiPostConfigurationError("timeout must be a positive number")
        self.timeout = float(timeout)
        self._opener = request.build_opener(
            request.ProxyHandler({}), _RejectRedirectHandler()
        )

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(base_url={self.base_url!r}, "
            f"timeout={self.timeout!r})"
        )

    @staticmethod
    def _token() -> str:
        token = os.environ.get(TOKEN_ENV)
        if not isinstance(token, str) or not token.strip():
            raise MultiPostConfigurationError(
                f"{TOKEN_ENV} is not set; copy the token from MultiPost Desktop settings"
            )
        return token.strip()

    def _url(self, path: str, query: Mapping[str, str] | None = None) -> str:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{parse.urlencode(query)}"
        return url

    def _open(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str] | None = None,
        authenticated: bool = True,
        accepted_statuses: Sequence[int] = (200,),
    ) -> tuple[bytes, str]:
        token = self._token() if authenticated else None
        headers = {"Accept": "application/json"}
        body: bytes | None = None
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if payload is not None:
            try:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            except (TypeError, ValueError):
                raise MultiPostSafetyError(
                    "MultiPost Desktop request payload must be JSON-serializable"
                ) from None
            headers["Content-Type"] = "application/json"
        req = request.Request(
            self._url(path, query), data=body, headers=headers, method=method
        )
        try:
            with self._opener.open(req, timeout=self.timeout) as response:
                status = int(response.status)
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
                content_type = response.headers.get_content_type()
        except error.HTTPError as exc:
            http_status = exc.code
            try:
                raw_error = exc.read(_MAX_RESPONSE_BYTES)
            finally:
                exc.close()
            message, code = self._api_error(raw_error, token)
            suffix = f" {code}" if code else ""
            raise MultiPostRequestError(
                f"MultiPost Desktop HTTP {http_status}{suffix}: {message}"
            ) from None
        except (error.URLError, TimeoutError, OSError) as exc:
            raise MultiPostRequestError(
                f"cannot reach MultiPost Desktop on the local API: {_redact(exc, token)}"
            ) from None
        except Exception as exc:
            raise MultiPostRequestError(
                f"MultiPost Desktop request failed: {_redact(exc, token)}"
            ) from None

        if len(raw) > _MAX_RESPONSE_BYTES:
            raise MultiPostRequestError("MultiPost Desktop response is unexpectedly large")
        if status not in accepted_statuses:
            raise MultiPostRequestError(
                f"MultiPost Desktop returned unexpected HTTP status {status}"
            )
        return raw, content_type

    @staticmethod
    def _api_error(raw: bytes, token: str | None) -> tuple[str, str | None]:
        text = raw.decode("utf-8", errors="replace")
        code: str | None = None
        message = text.strip() or "request rejected"
        try:
            value = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            pass
        else:
            if isinstance(value, Mapping):
                error_value = value.get("error")
                if isinstance(error_value, Mapping):
                    raw_code = error_value.get("code")
                    raw_message = error_value.get("message")
                    if isinstance(raw_code, str) and raw_code.strip():
                        candidate = _redact(raw_code.strip(), token)
                        if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", candidate):
                            code = candidate
                    if isinstance(raw_message, str) and raw_message.strip():
                        message = raw_message.strip()
                elif isinstance(error_value, str) and error_value.strip():
                    message = error_value.strip()
        return _redact(message[:1000], token), code

    def _json(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str] | None = None,
        authenticated: bool = True,
        accepted_statuses: Sequence[int] = (200,),
    ) -> Any:
        raw, _ = self._open(
            method,
            path,
            payload=payload,
            query=query,
            authenticated=authenticated,
            accepted_statuses=accepted_statuses,
        )
        if not raw:
            return {}
        token = os.environ.get(TOKEN_ENV) if authenticated else None
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MultiPostRequestError(
                f"MultiPost Desktop returned invalid JSON: {_redact(exc, token)}"
            ) from None
        return _redact_json(value, token)

    def health(self) -> Any:
        """Check whether the Desktop API is running; authentication is not required."""

        return self._json("GET", "/v1/health", authenticated=False)

    def list_platforms(self) -> Any:
        """Return platforms and content types supported by the installed Desktop app."""

        return self._json("GET", "/v1/platforms")

    def list_accounts(
        self, *, platform: str | None = None, group_id: str | None = None
    ) -> Any:
        """Return locally configured accounts, optionally filtered by platform/group."""

        query: dict[str, str] = {}
        if platform is not None:
            query["platform"] = _nonempty_string(platform, "platform")
        if group_id is not None:
            query["groupId"] = _nonempty_string(group_id, "group_id")
        return self._json("GET", "/v1/accounts", query=query)

    def create_publish(
        self,
        *,
        content_type: str,
        account_ids: Sequence[str],
        data: Mapping[str, Any],
        auto_submit: bool = False,
    ) -> Any:
        """Prepare a publish group without submitting it to any platform."""

        if auto_submit is not False:
            raise MultiPostSafetyError(
                "autoSubmit=true is forbidden; create a ready draft and request approval"
            )
        normalized_type = _nonempty_string(content_type, "content_type").upper()
        if normalized_type not in ALLOWED_CONTENT_TYPES:
            raise MultiPostSafetyError(
                f"unsupported content_type: {normalized_type}"
            )
        if isinstance(account_ids, (str, bytes)) or not isinstance(account_ids, Sequence):
            raise MultiPostSafetyError("account_ids must be a non-empty string list")
        normalized_accounts = [
            _nonempty_string(account_id, "account_id") for account_id in account_ids
        ]
        if not normalized_accounts:
            raise MultiPostSafetyError("account_ids must not be empty")
        if len(set(normalized_accounts)) != len(normalized_accounts):
            raise MultiPostSafetyError("account_ids must not contain duplicates")
        if not isinstance(data, Mapping):
            raise MultiPostSafetyError("data must be an object")
        payload = {
            "contentType": normalized_type,
            "accountIds": normalized_accounts,
            "data": dict(data),
            "autoSubmit": False,
        }
        return self._json(
            "POST", "/v1/publish", payload=payload, accepted_statuses=(200, 202)
        )

    def get_publish_status(self, group_id: str) -> Any:
        """Return the latest status snapshot for a prepared publish group."""

        group = parse.quote(_nonempty_string(group_id, "group_id"), safe="")
        return self._json("GET", f"/v1/publish/{group}")

    def take_screenshot(
        self, *, group_id: str | None = None, account_id: str | None = None
    ) -> bytes:
        """Capture the main Desktop view or one prepared target as PNG bytes."""

        if (group_id is None) != (account_id is None):
            raise MultiPostSafetyError(
                "group_id and account_id must be supplied together for a target screenshot"
            )
        query: dict[str, str] = {}
        if group_id is not None and account_id is not None:
            query = {
                "groupId": _nonempty_string(group_id, "group_id"),
                "accountId": _nonempty_string(account_id, "account_id"),
            }
        raw, content_type = self._open(
            "GET", "/v1/debug/screenshot", query=query
        )
        if content_type != "image/png":
            raise MultiPostRequestError(
                f"MultiPost Desktop screenshot returned {content_type}, expected image/png"
            )
        return raw

    def submit_target(
        self,
        group_id: str,
        account_id: str,
        *,
        approval: Mapping[str, Any],
    ) -> Any:
        """Submit exactly one ready target after upper-layer approval verification."""

        group_value = _nonempty_string(group_id, "group_id")
        account_value = _nonempty_string(account_id, "account_id")
        if not isinstance(approval, Mapping):
            raise MultiPostSafetyError(
                "submit_target requires a verified upper-layer authorization object"
            )
        if approval.get("authorized") is not True:
            raise MultiPostSafetyError("submission authorization is not active")
        if approval.get("group_id") != group_value:
            raise MultiPostSafetyError("submission authorization group_id mismatch")
        if approval.get("account_id") != account_value:
            raise MultiPostSafetyError("submission authorization account_id mismatch")
        _nonempty_string(approval.get("authorization_id"), "authorization_id")
        _nonempty_string(approval.get("approval_id"), "approval_id")

        group = parse.quote(group_value, safe="")
        account = parse.quote(account_value, safe="")
        return self._json(
            "POST", f"/v1/publish/{group}/targets/{account}/submit", payload={}
        )


__all__ = [
    "ALLOWED_CONTENT_TYPES",
    "DEFAULT_BASE_URL",
    "TOKEN_ENV",
    "MultiPostConfigurationError",
    "MultiPostDesktopClient",
    "MultiPostDesktopError",
    "MultiPostRequestError",
    "MultiPostSafetyError",
]
