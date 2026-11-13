---
name: short-release
description: Build and validate a shared release package from an approved video, captions, media QC and the user's own title, description and tags, then optionally prepare approval-gated distribution (platform drafts, private uploads, X drafts). Never writes or rewrites title, description or tags. Do not use it to create a video or infer public-post authority.
---

# Short Release

Turn one producer-owned, approved release handoff into the canonical multi-platform package. This skill owns package-approval validation, package assembly, cover-slot simulations, revision hashing, current-byte validation, and approval-gated distribution. The producer supplies approved video, captions and final-media QC; **the user supplies the title, description and tags, which this skill copies verbatim and never writes, rewrites or completes.**

Public publishing is a separate optional path through the MultiPost Desktop adapter. The adapter is implemented, but it remains
disabled for an installed Desktop version, platform, account, and content type until the
runtime preflight and canary requirements pass.

When public-platform automation or MultiPost applies, read both
[references/multipost-publishing.md](references/multipost-publishing.md) and
[references/multipost-evaluation.md](references/multipost-evaluation.md). Package
approval, a successful preflight, and a prepared `ready` task never
authorize a public post. Each target requires its own exact-account approval immediately
before submission.

## 来自 Sticker 的交接

Sticker 交来的是用户已经确认的完整正式预览（就是交付成片）、SRT 和 QC，以及用户自己写的标题、简介、标签。

- 用户可以设置条件式授权，例如"整片确认后直接出包并存到各平台草稿箱"。有这种设置时，保存它的原话和来源，每一集仍需绑定这一集的真实整片确认，不再重复问"是否出包""是否投递"。没有设置时，按下文逐步询问。
- 默认投递是各平台草稿箱或私密视频（经 `video-publisher` 技能，在你自己的技能目录里查找），以及 X 视频帖草稿箱（见 [X 投递契约](references/x-delivery.md)）。公开发布由用户最后自己操作。
- 缺账号、平台能力或材料时，只暂停受影响的那个目标，其他目标照常继续。
- 用户对某一集说"只预览""不出包""暂不投递"，优先按用户说的做。授权不能扩展到另一个版本、没展示过的发布素材，或无关的历史作品。

## Step 0 — 标题、简介、标签与封面

本节接收已经完成制作和技术 QC、且成片已获用户确认的交接。只收到标题和正文、没有成片时，交回制片流程，不当作成片交接。

平台内容审核、社区审核和 DOU+ 风险检查不属于本流程。出包和封面不自动创建、要求或附带这类报告；只有用户单独明确要求风险检查时才做。

**标题、简介、标签全部由用户在对话里直接告诉你，原样复用。** 把用户那条消息原文存成 UTF-8 文本，然后运行：

```bash
python3 <本技能目录>/scripts/record_user_release.py --message-file <work>/user_message.txt \
  --title '<用户写的标题>' --description '<用户写的简介>' \
  --tag 标签1 --tag 标签2 --tag 标签3 --tag 标签4 --tag 标签5 --out <work>/release-text
```

它会检查每一项都逐字出现在用户的消息里，然后生成 `release_copy.json`（`user_release_source.policy=user-supplied-release-v1`）。对不上或缺项时，它会列出来，你把缺项告诉用户，请用户补，不要代写。规则：

- 简介去掉空白后按字符数计，超过 50 字需要用户对这段原文的保留授权；
- 标签数量按用户给的，发布包要求 5 个时，如实告诉用户差几个，不自动补；
- 来源快照（用户原话及其哈希）必须能核对；
- `description_policy` 用 `user-supplied-release-v1`，没有互动句不阻断。

缺字段就列出缺项等用户补，不代写、不改写、不扩写、不重起标题，也不把缺项当作代写授权。

**封面**：封面大字必须和标题逐字一致（换行可以，改字不行）。用户提供封面时直接用；需要生成时，可以调用 `release-cover` 技能（在你自己的技能目录里查找；没有就请用户提供）。封面要给用户看过并确认，记下确认原话和封面路径、哈希。没改过的封面不重复确认。

`safe_area_warnings` 不阻断出包：如实告诉用户，标题或人脸被遮挡时由用户决定是否可用。

文字和封面都确认后，写完整的 `video-release-handoff-v1`，进入 Step 1。只改简介或标签时，不需要重做没变的封面，但下游发布包证据随之失效；改标题则封面要跟着改并重新确认。

## Step 1 — caller confirmation and package generation

Read [references/handoff-and-package-contract.md](references/handoff-and-package-contract.md) before creating or revising a package.
Cover production is specified in [references/cover-production.md](references/cover-production.md); covers come from the user or the optional `release-cover` skill in Step 0. This skill remains the sole authority for the sizes, safe rects and parity rules that covers must satisfy.

Require a `video-release-handoff-v1` whose status is `approved`, whose media-validation report passes, whose paths are absolute, and whose exact current bytes are bound by a valid `release-package-approval-v1` receipt. Missing or failed producer evidence is a blocker; do not manufacture it inside this skill.

The cover headline is release copy, not a second hook-writing surface. New handoffs must carry
`cover_headline_text` and `cover_headline_lines`; after removing whitespace, both the full text and
the joined display lines must equal `title` exactly. Line breaks are allowed; shortening,
paraphrasing, changing punctuation, translating product names, or substituting a different hook is
not. The builder enforces this before writing a package. Font choice remains creative: select a
commercially usable display face from the user's supplied strong-cover reference or the account
font library, then keep that selection consistent across the three unique-size assets. Do not impose one
global headline font on every release.

Obtain package authorization once after the final creative/QC gate. A user's explicit request to generate this episode's package already supplies that authorization; create the byte-bound receipt after the current handoff is complete without repeating the question. When the user has set a conditional instruction (see above), preserve it together with this episode's real full-preview confirmation; once those conditions and QC pass, create the existing receipt against the complete current handoff without another package question. Reuse a caller receipt only if it is still valid for the exact current bytes. If neither applicable authorization nor a valid receipt exists, show the package summary, ask **“是否为当前版本生成发布包？”**, and stop. For other callers, full-video approval alone, “final/可发布”, historical preference, or silence is not package authorization.

After the applicable authorization and current-byte conditions above are satisfied, bind the handoff, referenced artifact bytes, release revision and intended output directory:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py package-approve \
  --handoff <work>/video-release-handoff.json \
  --output-dir <work>/publish \
  --confirmed-by-user \
  --output <work>/publish/release_package_approval.json
```

Build and validate in one command:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py package \
  --handoff <work>/video-release-handoff.json \
  --output <work>/publish \
  --approval <work>/publish/release_package_approval.json
```

The command writes `publish_copy.md`, five platform-slot simulations backed by three unique-size cover assets, `cover/platforms/platform-cover-specs.json`, `publish_package.json`, and `publish_package_validation.json`. A successful run returns `status=package_validated`; anything else blocks delivery and producer queue cleanup.

After PASS, report the package path, validation status, title, three unique cover assets, and their five platform-slot mappings. Draft/private delivery then follows the user's delivery setting through `video-publisher` (and the X contract); public-platform preparation/submission still follows Step 2 and requires its own applicable authorization.

Use `--force` only to repeat a deterministic build for the same declared revision. If video, audio, captions, copy, title, hashtags, master cover, or any platform cover changed, assign a new `release_revision_id` before rebuilding.

To verify an existing package without rewriting it:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py verify \
  --package <work>/publish/publish_package.json
```

Producer cleanup code should call `release.py verify`. Do not duplicate the revision-hash algorithm in producer skills.

## Step 1.5 — 路径冻结与安全归档

新项目在建立 handoff、QC 和批准链**之前**，将本项目选定成片、封面、
文案复制到 `final/<项目>/`，然后针对最终路径重新生成 QC、handoff 和发布包。
先冻结路径，再绑定哈希和批准；绝不能先出包再移动目录。

已有批准包保持原路径原样不动。可以另作副本，但副本不是可迁移的独立发布包：
其中绝对路径仍指向原位置。若需要独立归档，须重建路径绑定和校验，不能复制旧批准回执冒充新批准。

录制素材只从本项目的 `capture_inbox/<日期-项目>/` 或素材库复制，原片保留。
本阶段不移动其他项目的录屏、不清空公共 `temp/`、不自动删除 `work/`。
空间清理是单独授权的操作，不属于出包成功后的隐含步骤。

上游的成片 QC 报告可直接作 release_media_validation：必须包含 `passed`、
`video`、`video_sha256`，并与最终路径的真实文件匹配；任一失败不得进入发布。

## Step 2 — ask whether to enter publishing

Use MultiPost only after the package has passed and the user answers yes to the separate post-package question whether to enter publishing. That answer authorizes only preflight and unpublished `autoSubmit:false` preparation; it does not authorize any public submit. Use MultiPost only when the local Desktop
runtime has passed preflight. The safe default is always `autoSubmit:false`: prepare an
unpublished task, wait for `ready`, preserve the screenshot and exact account/content
mapping, obtain one explicit approval per platform target, then submit and reconcile that
target independently.

Every target must declare a non-empty `data.visibility` and a top-level
`publish_timing`. Use exactly `{"mode":"immediate"}` or
`{"mode":"scheduled_at","scheduled_at":"<future ISO-8601 timestamp with timezone>"}`.
Do not put scheduling controls directly in `data`: the adapter derives Desktop's documented
`scheduledPublishTime` millisecond field only for scheduled targets, while the human-readable
timing remains in hashed approval evidence. A `ready` preparation canary is still required;
the type definition does not prove that every installed runtime/platform supports scheduling.

Every `VIDEO` target must provide `data.cover` from the verified package; Douyin and
Xiaohongshu must still use their exact named variants. Instagram/X ordinary posts must use
`cover_policy:not_applicable` and must not contain `cover`, `verticalCover`, or
`horizontalCover`. The adapter hashes visibility, timing, and cover policy with the exact
payload, so changing any of them requires preparation and approval again.

The intended CLI sequence is:

```bash
uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-preflight --output <work>/publish/multipost/preflight.json

uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-prepare \
  --package <work>/publish/publish_package.json \
  --targets <work>/publish/multipost-targets.json \
  --output-dir <work>/publish/multipost/prepared

uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-approve \
  --prepared <work>/publish/multipost/prepared/<prepared-hash>.json \
  --target <target-key> \
  --confirmed-by-user \
  --output <work>/publish/multipost/approvals/<target-key>.json

uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-submit \
  --package <work>/publish/publish_package.json \
  --prepared <work>/publish/multipost/prepared/<prepared-hash>.json \
  --approval <work>/publish/multipost/approvals/<target-key>.json \
  --output <work>/publish/multipost/receipts/<target-key>.json

uv run --no-project --with pillow \
  python <本技能目录>/scripts/release.py \
  multipost-status \
  --receipt <work>/publish/multipost/receipts/<target-key>.json \
  --output <work>/publish/multipost/receipts/<target-key>.json
```

Read `prepared/prepare-summary.json` for the generated target-to-evidence paths. The
authoritative idempotency state is always derived from the package path and stored at
`<package-parent>/multipost_distribution`; changing `--output-dir` cannot create another
submission state. Evidence filenames use hashes so account IDs are not leaked in names.

Run `multipost-approve` only after the user has just reviewed that prepared target's saved
screenshot and explicitly confirmed its exact account, copy, cover (or not-applicable
policy), visibility, and timing. General agreement to use MultiPost, package approval, or a
batch-level preference is not approval for any particular public submission.

Use runtime platform IDs and account IDs returned by the installed Desktop client; never
infer them from display names. Treat `release.py --help` as authoritative if implementation
flags differ. Never bypass CAPTCHA, login, device-verification, or platform warnings, and
never use an unbounded retry loop. An `unknown` or interrupted submission must be
reconciled before any retry.

## Ownership and compatibility

- `short-release` is authoritative for the handoff schema, `cn_social_covers_v2`, package validation and release revision hash.
- Producer skills supply approved video, captions and media QC; the user supplies title, description and tags. This skill binds them into the handoff verbatim. Do not create a duplicate title set.
- Keep the legacy producer-side scripts only as temporary compatibility shims for old projects. New instructions and tests must point here; do not evolve two copies of the contract.
- The four original social slots remain mandatory, but equal dimensions must resolve to one shared asset in new handoffs. Bilibili is a configured 1920×1080 slot and is required whenever `target_platforms` includes `bilibili`. Additional slots require verified dimensions and full manifest metadata; do not guess them or silently redefine `cn_social_covers_v2`.
- Never describe draft or private delivery as public publishing. Never infer authorization to post to a platform from package approval or from approval of a different platform target.
