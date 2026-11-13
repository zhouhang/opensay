# MultiPost approval-gated publishing contract

Read this reference only after a validated package exists and the user has separately chosen to enter MultiPost distribution. The adapter is
implemented, but every installed Desktop version and target combination remains subject
to runtime preflight and canary. This document governs public-post authorization and
receipts; it does not modify `publish_package.json` or replace package validation.

## Risk order and consent boundary

For minimum platform-policy exposure, prefer a supported official publishing API. If no
appropriate official API is available, manual submission in the platform's official UI is
the lower-risk fallback. MultiPost Desktop still controls a logged-in browser view and
performs DOM/page automation even when called through its local API.

Within MultiPost, the mandatory minimum-risk mode is:

1. `autoSubmit:false`;
2. prepare only to `ready`;
3. preserve the prepared-page screenshot and exact target details;
4. obtain one explicit user approval for each platform/account target;
5. submit targets one at a time;
6. reconcile the remote state before reporting success or retrying.

The user's agreement to use this mode authorizes its use as the workflow default. It does
not pre-approve a particular public post. Package approval, a prepared task, a screenshot,
or approval of another target is insufficient authority to submit.

## Runtime preflight and canary

Before preparing a target:

- require a MultiPost Desktop listener on a loopback address; reject non-loopback base
  URLs by default;
- load the bearer token only from a local secret source and redact it from every output;
- record Desktop health and version, then obtain `list_platforms` and `list_accounts`;
- use the runtime platform ID, account ID, and supported content type, not a display name
  or a static registry assumption;
- confirm the package still passes `release.py verify` and bind its current revision hash;
- run a non-public `autoSubmit:false` preparation canary for the installed-version/
  platform/content-type combination before marking it available.

The current Extension source indicates dedicated `VIDEO` adapters for Bilibili, Douyin,
Xiaohongshu, WeChat Channels, and YouTube. Instagram and X are `DYNAMIC` targets that can
carry video in an ordinary post; do not label them as dedicated video publishing, and do
not infer Instagram Reels/Stories or other unsupported products.

The documented Desktop `VIDEO` payload exposes one `cover` field. WeChat Channels needs
separate home and share covers in the current release package, so its MultiPost target is
`manual_required` or `canary_blocked` until an installed-runtime canary proves correct
two-cover mapping. Never silently discard or merge either cover slot.

## State and evidence model

Track each target independently:

```text
preflight_ok -> preparing -> ready -> approved -> submitting
                                             -> success
                                             -> failed
                                             -> unknown
```

A login, CAPTCHA, device-verification, platform warning, or user-action checkpoint enters
a paused/manual state rather than advancing automatically. Never bypass the challenge or
run stealth, fingerprint-spoofing, or proxy-rotation logic.

The prepared receipt must bind at least:

- release revision ID and current revision hash;
- runtime platform ID, account ID, and content type;
- task ID and task state;
- exact copy plus required visibility, cover policy/mapping, and publish-timing values or
  their hashes;
- `autoSubmit:false` evidence;
- prepared-page screenshot path and hash;
- creation time and Desktop version.

Only `ready` is approvable. Show the user the screenshot plus platform, account, content
type, copy, cover or not-applicable cover policy, visibility, and publish timing. Approval
means the user has just reviewed and confirmed those values for exactly one `target-key`.
General MultiPost consent or a batch-level preference is not approval. The approval receipt
must hash-bind all prepared evidence; any material change requires a new preparation and
approval.

Before submission, re-verify the package bytes and ensure the prepared and approval
receipts match the target and current revision. Submit only that target. Approval must not
be synthesized from earlier conversation, a batch-level preference, or another platform's
approval.

After submission, poll or query status and write a reconciliation receipt containing the
remote state and public URL when available. Treat `success` as terminal and idempotent.
Never resubmit `submitting` or `unknown`; reconcile first. Do not use an infinite retry
loop. A retry after an explicit failure must be bounded, preserve history, and require a
new user decision when the visible content or destination changed.

## CLI contract

The implemented release entrypoint is:

```bash
# Read-only local-runtime capability check.
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-preflight --output <preflight.json>

# Creates unpublished tasks only; implementation must force autoSubmit:false.
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-prepare \
  --package <publish_package.json> \
  --targets <multipost-targets.json> \
  --output-dir <prepared-dir>

# Records one exact-target approval after the user reviews its screenshot and details.
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-approve \
  --prepared <prepared-receipt.json> \
  --target <target-key> \
  --confirmed-by-user \
  --output <approval.json>

# Public mutation: requires matching package, ready receipt, and explicit approval.
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-submit \
  --package <publish_package.json> \
  --prepared <prepared-receipt.json> \
  --approval <approval.json> \
  --output <submission-receipt.json>

# Reconciles the same task; it must not create a replacement task.
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-status \
  --receipt <submission-receipt.json> \
  --output <submission-receipt.json>
```

`multipost-targets.json` must use runtime platform/account IDs and declare content type,
cover policy/mapping, visibility, and publish timing explicitly. Never store the Desktop token
in that file. Use `release.py --help` as the final authority if implementation flags
differ from this interface contract.

The implemented target schema is:

```json
{
  "schema_version": "multipost-targets-v1",
  "targets": [
    {
      "platform": "youtube",
      "account_id": "<runtime-account-id>",
      "content_type": "VIDEO",
      "publish_timing": {"mode": "immediate"},
      "data": {
        "title": "...",
        "content": "...",
        "video": "/absolute/path/from/publish_package.json",
        "cover": "/absolute/verified/package/cover.png",
        "visibility": "public"
      }
    }
  ]
}
```

Every non-Instagram/X target must be `VIDEO` and its `data.video` must resolve to the
verified package video. It must also provide a non-empty `data.cover` that comes from
`cover_master` or `cover_variants`; Douyin and Xiaohongshu must use their exact named
variant in `data.cover`.

Instagram/X must instead declare `content_type:DYNAMIC`, `surface:ordinary_post`,
`cover_policy:not_applicable`, and a one-item `data.videos` list containing that same
package video. Their `data` must not contain `cover`, `verticalCover`, or `horizontalCover`.
This is the Desktop ordinary-post payload currently implemented and tested here, not a claim
of Reels/Stories support.

Every target requires a non-empty `data.visibility` and one of these closed timing shapes:

```json
{"publish_timing": {"mode": "immediate"}}
{"publish_timing": {"mode": "scheduled_at", "scheduled_at": "2099-01-02T03:04:05+08:00"}}
```

`scheduled_at` must be a future ISO-8601 time with an explicit timezone. The adapter
normalizes it to UTC in control evidence and derives the documented Desktop
`data.scheduledPublishTime` Unix-millisecond value. Callers must not supply
`scheduledPublishTime` or timing controls inside `data`; immediate mode sends no schedule
field. MultiPost documents this field as optional and platform-dependent, so a type-valid
payload is not proof of support: the installed-version/platform/content-type `ready`
preparation canary and screenshot remain mandatory. See the official
[MultiPost type definition](https://multipost.app/docs/zh/development/types).

`multipost-prepare` writes `prepare-summary.json`, hashed prepared-evidence files, and PNG
screenshots under `--output-dir`. It stores authoritative state only at
`<package-parent>/multipost_distribution`, so choosing another output directory cannot
bypass idempotency. The approval and submission outputs are evidence envelopes that bind
the canonical state receipts and their hashes.

## Stop conditions

Stop without submitting when any of the following is true:

- Desktop health, platform support, account binding, or target canary is missing;
- package validation or revision binding no longer matches;
- visibility is empty, timing is missing/ambiguous/past, or cover policy is invalid;
- the task is not `ready`, or the screenshot/evidence is missing;
- exact-target approval is absent, stale, or mismatched;
- the platform presents a CAPTCHA, login, verification, or risk warning;
- target state is `submitting`, `success`, or `unknown`;
- WeChat Channels requires unverified two-cover behavior;
- Instagram or X was requested as a dedicated video product rather than a supported
  `DYNAMIC` ordinary post.
