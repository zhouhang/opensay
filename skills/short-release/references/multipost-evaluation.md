# MultiPost Desktop evaluation

Status: researched on 2026-08-30; adapter implemented, installed-runtime canary required.

## Current decision

MultiPost Desktop is an optional distribution adapter after package validation. It is
separate from `package`, `validate` and `verify`; package approval and
draft/private delivery do not authorize public publication. The adapter must remain blocked
for any installed Desktop version, platform, account, or content type that has not passed
runtime preflight and a non-public preparation canary.

Install and run the Desktop client and use its local API to call `health`,
`list_platforms`, and `list_accounts` before enabling a target. Runtime results are
authoritative; the open-source Extension registry is only evidence that an adapter exists
in that code base and may differ from the installed Desktop binary.

The adapter's mandatory default flow is:

1. verify the unchanged release package and revision hash;
2. bind exact platform account IDs and content types returned by the local API;
3. create one platform-specific task with `autoSubmit:false`;
4. wait for `ready`, save a screenshot, and show the account, copy, cover policy/mapping,
   visibility, and immediate-or-scheduled timing to the user;
5. require freshly reviewed, explicit approval for that exact platform/account submission before
   `submit_publish`; approval for one target never covers another;
6. reconcile each target independently and record post URL/status without rewriting
   `publish_package.json`;
7. never blindly retry `submitting`, `success`, or `unknown` targets.

This is the lowest-risk operating mode **within MultiPost**, not the lowest-risk release
method overall. A supported official platform API is preferable; otherwise manual
submission in the platform's official UI has less automation-policy exposure. MultiPost's
approval-gated mode reduces accidental posts and duplicate retries, but cannot remove the
residual risk of third-party browser automation.

## Cost boundary

The current official pricing page lists multi-platform publishing as free for the browser
extension, Extension API, and REST API. The page is marked WIP and does not separately
promise that the Desktop local API will remain free forever. Treat the current local
publishing call cost as zero only after checking the current product terms; AI generation,
Reader/search, hosting, and other value-added services may be charged.

Sources:

- https://multipost.app/docs/zh/user-guide/pricing
- https://multipost.app/docs/zh/api-reference/desktop
- https://multipost.app/docs/zh/api-reference/desktop/publish
- https://multipost.app/docs/zh/api-reference/desktop/mcp

## Platform boundary

The current Extension source has dedicated `VIDEO` adapters for Bilibili, Douyin,
Xiaohongshu, WeChat Channels, and YouTube. Instagram and X are registered as `DYNAMIC`;
their adapters accept video media for ordinary posts, but that does not prove support for
Instagram Reels/Stories or another platform-specific video product.

Relevant registries and adapters:

- https://github.com/leaperone/MultiPost-Extension/blob/main/src/sync/video.ts
- https://github.com/leaperone/MultiPost-Extension/blob/main/src/sync/dynamic.ts
- https://github.com/leaperone/MultiPost-Extension/blob/main/src/sync/dynamic/instagram.ts
- https://github.com/leaperone/MultiPost-Extension/blob/main/src/sync/dynamic/x.ts

The Desktop `VIDEO` payload documents one `cover` field. Therefore WeChat Channels must
remain `manual_required` or `canary_blocked`; do not collapse or guess the two required
slots (`home` and `share`) until a local canary proves the installed version maps both
correctly.

The official type definition documents optional `scheduledPublishTime` on relevant data
types as a numeric Unix timestamp in milliseconds, subject to platform support. The adapter
therefore keeps a required human-readable top-level timing control, derives that Desktop
field only for a future timezone-qualified schedule, and sends no schedule field for
immediate mode. This type declaration alone does not prove that an installed runtime and
platform implement scheduling; exact-target `ready` canary evidence remains the gate.

Source:

- https://multipost.app/docs/zh/development/types

## Risk boundary

The Desktop local API is a local control plane, not a replacement for each platform's
official publishing API. It opens or reuses logged-in browser views and drives the
publisher page through scripts and DOM-level automation. Risks include selector
breakage after site changes, login/verification interruptions, stale schedules being treated
as immediate publication, ambiguous success status,
duplicate posts after unsafe retries, and platform enforcement against unauthorized
third-party automation. MultiPost itself requires users to comply with target-platform
rules and does not guarantee compatibility after third-party changes.

Do not claim that use necessarily causes a ban, because platforms do not publish a
MultiPost-specific probability or threshold. Also do not claim it is risk-free. WeChat
and Xiaohongshu agreements contain especially restrictive language about unauthorized
third-party software/automation; Douyin offers an official content publishing API and
that route is preferable when practical.

Sources:

- https://multipost.app/legal/terms
- https://github.com/leaperone/MultiPost-Extension/issues/205
- https://weixin.qq.com/cgi-bin/readtemplate?head=true&lang=zh_CN&s=default&t=weixin_agreement
- https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1
- https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution

The Desktop token is equivalent to control of every account logged into the client. Read
it only from a local secret source, require a loopback base URL, and never write it to the
package, logs, receipts, source control, or prompts.

Never attempt CAPTCHA solving, verification bypass, fingerprint spoofing, stealth mode,
proxy rotation, or another measure intended to evade a platform control. Pause and ask
the user to complete the platform challenge in the visible official page. Do not use an
unbounded automatic retry; reconcile an interrupted or `unknown` task before deciding
whether one explicit retry is safe.
