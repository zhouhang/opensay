#!/usr/bin/env python3
"""Package, validate or verify a shared video release."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import build_publish_package
import multipost_distribution
import multipost_release
import package_approval
import release_gate
import validate_publish_package
from multipost_desktop import DEFAULT_BASE_URL, MultiPostDesktopError


def _bounded_seconds(value: str, *, label: str, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(f"{label} must be a number") from None
    if not math.isfinite(parsed) or parsed < 0 or parsed > maximum:
        raise argparse.ArgumentTypeError(
            f"{label} must be finite and between 0 and {maximum:g} seconds"
        )
    return parsed


def _timeout_seconds(value: str) -> float:
    return _bounded_seconds(
        value,
        label="--timeout-seconds",
        maximum=multipost_release.MAX_POLL_TIMEOUT_SECONDS,
    )


def _poll_interval(value: str) -> float:
    return _bounded_seconds(
        value,
        label="--poll-interval",
        maximum=multipost_release.MAX_POLL_INTERVAL_SECONDS,
    )


def package_command(args: argparse.Namespace) -> int:
    package_approval.verify_package_approval(
        args.approval, args.handoff, args.output
    )
    package_path, report = build_publish_package.build_package(
        args.handoff, args.output, force=args.force
    )
    print(
        json.dumps(
            {
                "status": "package_validated",
                "package": str(package_path),
                "publish_package_validation": str(
                    Path(report["package"]).parent / "publish_package_validation.json"
                ),
                "release_revision_id": report.get("release_revision_id"),
                "release_revision_hash": report.get("release_revision_hash"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def package_approve_command(args: argparse.Namespace) -> int:
    result = package_approval.create_package_approval(
        args.handoff,
        args.output_dir,
        args.output,
        confirmed_by_user=args.confirmed_by_user,
        ttl_seconds=args.ttl_seconds,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def validate_command(args: argparse.Namespace) -> int:
    package_path = args.package.resolve()
    package = json.loads(package_path.read_text(encoding="utf-8"))
    declared = package.get("publish_package_validation")
    report_path = args.report.resolve() if args.report else None
    if report_path is None:
        if not isinstance(declared, str) or not declared.strip():
            raise release_gate.ReleaseGateError(
                "package does not declare publish_package_validation; pass --report"
            )
        report_path = release_gate.package_file_path(package_path, declared)
    report = validate_publish_package.validate_package(package_path)
    if package.get("cover_profile_id") == validate_publish_package.COVER_PROFILE_ID:
        declared_path = release_gate.package_file_path(package_path, declared)
        if report_path != declared_path:
            report["errors"].append(
                "--report does not match publish_package_validation declared in package"
            )
            report["passed"] = False
    build_publish_package.write_json(report_path, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report.get("passed") is True else 1


def verify_command(args: argparse.Namespace) -> int:
    result = release_gate.verify_release_ready(args.package)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def multipost_preflight_command(args: argparse.Namespace) -> int:
    result = multipost_release.preflight(args.output, base_url=args.base_url)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "preflight_ok" else 1


def multipost_prepare_command(args: argparse.Namespace) -> int:
    result = multipost_release.prepare(
        args.package,
        args.targets,
        args.output_dir,
        base_url=args.base_url,
        timeout_seconds=args.timeout_seconds,
        poll_interval=args.poll_interval,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "ready" else 1


def multipost_approve_command(args: argparse.Namespace) -> int:
    result = multipost_release.approve(
        args.prepared,
        args.target,
        args.output,
        confirmed_by_user=args.confirmed_by_user,
        approval_note=args.approval_note,
        ttl_seconds=args.ttl_seconds,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def multipost_submit_command(args: argparse.Namespace) -> int:
    result = multipost_release.submit(
        args.package,
        args.prepared,
        args.approval,
        args.output,
        base_url=args.base_url,
        timeout_seconds=args.timeout_seconds,
        poll_interval=args.poll_interval,
        retry_failed=args.retry_failed,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "success" else 1


def multipost_status_command(args: argparse.Namespace) -> int:
    result = multipost_release.status(
        args.receipt, args.output, base_url=args.base_url
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") == "success" else 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)

    approval_parser = subparsers.add_parser(
        "package-approve",
        help="Record the caller's just-obtained approval to generate one exact package",
        description=(
            "The producer asks the user once. This command records that explicit answer and "
            "binds it to the exact handoff, current referenced media, release revision, local "
            "OS user, and destination directory. short-release does not ask again."
        ),
    )
    approval_parser.add_argument("--handoff", required=True, type=Path)
    approval_parser.add_argument("--output-dir", required=True, type=Path)
    approval_parser.add_argument(
        "--confirmed-by-user",
        action="store_true",
        required=True,
        help="Attest that the user explicitly approved generating this release package now",
    )
    approval_parser.add_argument(
        "--ttl-seconds",
        type=int,
        default=package_approval.DEFAULT_APPROVAL_TTL_SECONDS,
    )
    approval_parser.add_argument("--output", required=True, type=Path)
    approval_parser.set_defaults(handler=package_approve_command)

    package_parser = subparsers.add_parser(
        "package",
        help="Build and validate an explicitly approved package",
        description=(
            "Requires a current release-package-approval-v1 receipt created only after the "
            "producer obtained explicit user confirmation."
        ),
    )
    package_parser.add_argument("--handoff", required=True, type=Path)
    package_parser.add_argument("--output", required=True, type=Path)
    package_parser.add_argument("--approval", required=True, type=Path)
    package_parser.add_argument("--force", action="store_true")
    package_parser.set_defaults(handler=package_command)

    validate_parser = subparsers.add_parser("validate", help="Write a validation report")
    validate_parser.add_argument("--package", required=True, type=Path)
    validate_parser.add_argument("--report", type=Path)
    validate_parser.set_defaults(handler=validate_command)

    verify_parser = subparsers.add_parser(
        "verify", help="Require current media and package validation"
    )
    verify_parser.add_argument("--package", required=True, type=Path)
    verify_parser.set_defaults(handler=verify_command)


    preflight_parser = subparsers.add_parser(
        "multipost-preflight",
        help="Require a healthy, versioned MultiPost Desktop runtime capability check",
        description=(
            "Read-only capability check. Fails unless Desktop reports healthy/ok with an "
            "explicit installed runtime version."
        ),
    )
    preflight_parser.add_argument("--output", required=True, type=Path)
    preflight_parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    preflight_parser.set_defaults(handler=multipost_preflight_command)

    prepare_parser = subparsers.add_parser(
        "multipost-prepare",
        help="Prepare unpublished targets and record a version-bound non-public canary",
        description=(
            "Prepare autoSubmit=false targets. A canary passes only after the exact target "
            "is ready and its review screenshot is saved."
        ),
    )
    prepare_parser.add_argument("--package", required=True, type=Path)
    prepare_parser.add_argument("--targets", required=True, type=Path)
    prepare_parser.add_argument("--output-dir", required=True, type=Path)
    prepare_parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    prepare_parser.add_argument(
        "--timeout-seconds",
        type=_timeout_seconds,
        default=300.0,
        help=f"Bounded prepare wait, 0..{multipost_release.MAX_POLL_TIMEOUT_SECONDS:g}s",
    )
    prepare_parser.add_argument(
        "--poll-interval",
        type=_poll_interval,
        default=2.0,
        help=f"Bounded status interval, 0..{multipost_release.MAX_POLL_INTERVAL_SECONDS:g}s",
    )
    prepare_parser.set_defaults(handler=multipost_prepare_command)

    approve_parser = subparsers.add_parser(
        "multipost-approve",
        help="Record just-reviewed approval for one exact ready target",
        description=(
            "Use only after the user has just reviewed this target's saved screenshot and "
            "confirmed its exact account, copy, cover (or not_applicable policy), visibility, "
            "and publish timing. General consent to use MultiPost or a batch-level preference "
            "is not approval for this public submission."
        ),
    )
    approve_parser.add_argument(
        "--prepared",
        required=True,
        type=Path,
        help="Prepared evidence whose screenshot and exact target details were just reviewed",
    )
    approve_parser.add_argument(
        "--target", required=True, help="Exact platform:account target key shown in that evidence"
    )
    approve_parser.add_argument(
        "--confirmed-by-user",
        action="store_true",
        required=True,
        help=(
            "Attest that the user just confirmed this exact screenshot/account/copy/cover/"
            "visibility/timing; never infer this from general or earlier consent"
        ),
    )
    approve_parser.add_argument(
        "--approval-note",
        default="",
        help="Optional target-specific audit note; does not replace explicit confirmation",
    )
    approve_parser.add_argument(
        "--ttl-seconds", type=int, default=multipost_distribution.DEFAULT_APPROVAL_TTL_SECONDS
    )
    approve_parser.add_argument("--output", required=True, type=Path)
    approve_parser.set_defaults(handler=multipost_approve_command)

    submit_parser = subparsers.add_parser(
        "multipost-submit",
        help="Submit one approved target and reconcile it",
        description=(
            "Public mutation for one exact approved target. The current Desktop version must "
            "match the preparation canary."
        ),
    )
    submit_parser.add_argument("--package", required=True, type=Path)
    submit_parser.add_argument("--prepared", required=True, type=Path)
    submit_parser.add_argument("--approval", required=True, type=Path)
    submit_parser.add_argument("--output", required=True, type=Path)
    submit_parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    submit_parser.add_argument(
        "--timeout-seconds",
        type=_timeout_seconds,
        default=180.0,
        help=f"Bounded reconciliation wait, 0..{multipost_release.MAX_POLL_TIMEOUT_SECONDS:g}s",
    )
    submit_parser.add_argument(
        "--poll-interval",
        type=_poll_interval,
        default=2.0,
        help=f"Bounded status interval, 0..{multipost_release.MAX_POLL_INTERVAL_SECONDS:g}s",
    )
    submit_parser.add_argument(
        "--retry-failed",
        action="store_true",
        help=(
            "Retry only an existing failed receipt; requires a new approval recorded after "
            "that failure"
        ),
    )
    submit_parser.set_defaults(handler=multipost_submit_command)

    status_parser = subparsers.add_parser(
        "multipost-status", help="Reconcile an existing task without creating another"
    )
    status_parser.add_argument("--receipt", required=True, type=Path)
    status_parser.add_argument("--output", required=True, type=Path)
    status_parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    status_parser.set_defaults(handler=multipost_status_command)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.handler(args))
    except (
        build_publish_package.HandoffError,
        package_approval.PackageApprovalError,
        release_gate.ReleaseGateError,
        multipost_distribution.DistributionStateError,
        multipost_release.MultiPostReleaseError,
        MultiPostDesktopError,
    ) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
