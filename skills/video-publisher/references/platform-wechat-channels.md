# WeChat Channels Adapter Contract

Mandatory `persist -> verify` is defined in `persistence-verification.md`. Reopen the same draft from the draft list and verify video, description, short title, originality and both cover slots. Unknown entry controls or absent persisted identity must block, not produce READY.

Before changing the WeChat Channels adapter, read `platform-common.md` and `ego-browser-workflow.md`.

## Contents

- Wujie lifecycle
- Upload completion and draft identity
- Text, original declaration, custom covers, and required gates

## Wujie Lifecycle

The creator editor can be focused while `document.visibilityState` remains `hidden`. That state left `页面初始化中` and fade transitions stuck. Before readiness checks and during upload/dialog waits, call:

```text
Page.bringToFront
Page.setWebLifecycleState { state: active }
Emulation.setFocusEmulationEnabled { enabled: true }
```

Readiness requires the initialization toast to be gone and the real video input to exist, or an already uploaded editor to be proven. Perform at most one gentle reload after the initial activation window.

## Wujie Upload

Search `document` and all open shadow roots for the hidden video input whose `accept` contains `video`. Obtain the input’s CDP object id and use `DOM.setFileInputFiles` with the confirmed source path.

`页面初始化中` is a warning, not sufficient truth by itself. Do not inject while it is present merely because a stale input node exists.

After injection, dispatch one fallback change event only if no upload state appears. Never repeatedly inject the same file.

## Upload Completion

Cover cards can appear before upload completes. A real run displayed:

```text
50%
取消上传
封面预览
个人主页卡片
分享卡片
```

That state is uploading, not ready.

Require cover cards and the absence of all progress signals, including percentage text, `取消上传`, `正在处理文件`, `处理中` and `生成中`, for a stable interval before the upload runner exits. If an existing target upload is in progress, wait for it; do not inject again.

## 上传中预填

当页面同时证明视频仍在上传或生成封面，并且描述、短标题控件可见时，`upload_start` 返回 `editable_uploading`。随后通过单宽 UI 队列执行 `prefill`：

1. 写入精确的视频号描述。
2. 保持短标题为空。
3. 不操作原创声明、封面、活动、定时发表和最终 `发表`。

由于视频号页面不提供可靠文件名，上传启动回执必须同时绑定包指纹和任务空间 id。只有描述已经精确匹配，或存在匹配的上传启动回执时，才允许预填。快速视频可能在预填进程启动前完成平台处理；此时仍可安全预填，但不得宣称写入发生在上传中。

## Draft Identity

The page does not expose a reliable filename. Reuse an uploaded draft only when its description exactly matches the expected package, or a package-fingerprint and task-space receipt proves this job injected or resumed that upload. Treat an already uploaded draft with an empty description and no matching receipt as `STATE_AMBIGUOUS`; never fill its metadata or declarations. A different non-empty description is foreign and must block.

## Text Defaults

Use the description field as:

```text
TITLE

#TOPIC_1 #TOPIC_2 #TOPIC_3
```

Leave `短标题` empty unless explicitly requested.

## Original Declaration

Enable `声明原创`. If an agreement dialog appears, accept its checkbox and click the dialog’s `声明原创` action. This is not the final `发表` control.

The adapter must verify the checked state after the dialog closes.

## Custom Cover

When enabled, upload both user-provided assets. Use the same flow first for the personal-profile `3:4` card and then for the share-card `4:3` card:

1. Click `.vertical-cover-wrap .edit-btn` for 3:4 or `.horizon-cover-wrap .edit-btn` for 4:3. The horizontal entry can first open a material recommendation popover titled `使用此素材作为封面？`. For a requested custom cover, select its unique visible enabled `直接编辑` button inside `.btn-directly-edit`, only when the clicked horizontal trigger has `ant-popover-open`; do not accept the recommended material instead. Deduplicate nested tooltip/popover roots and select at most once per entry attempt. An already-open cover editor needs no such action.
2. In the active edit-cover dialog, locate its existing image file input across open roots.
3. Inject the file through its CDP object id; top-document `uploadFile` cannot reach it.
4. Wait for `.single-cover-uploader-wrap img` to show a real preview.
5. If `裁剪封面图` is visible, click its unique enabled `确定` first, only with a unique visible parent matching the requested slot title. Missing, hidden or duplicate parents must block.
6. Wait for the unique parent editor to become visible, then click its unique enabled `确认`. Check ancestor visibility as well as the button itself.
7. The requested custom-cover confirmation path must not click a global or hidden recommendation `使用素材` control. Unknown material-choice states block instead of accepting another asset. A timeout records the last bounded control probe, not image data or credentials.
8. Keep the lifecycle active until the editor closes and the corresponding main-card CDN URL changes.
9. Persist each URL with its absolute asset path and ratio, then require a separate verify process to find both again.

The slot-specific titles `编辑个人主页卡片` and `编辑分享卡片` remain preferred. A current page variant can instead expose the same active editor as `编辑封面`; accept that fallback only when the unique visible dialog also contains `上传封面`, `取消`, and `确认`. Recovery, image-input lookup, and confirmation must search visible `.weui-desktop-dialog__wrp` roots directly instead of depending on the removed `.edit-cover-dialog` ancestor.

Only `.vertical-cover-wrap img.vertical-img-size` and `.horizon-cover-wrap img.horizon-img-size` are receipt targets. Require separate `3:4` and `4:3` receipts.

If a prior attempt leaves `编辑个人主页卡片` or `裁剪封面图` open, safely cancel that known editor, wait for it to close, and retry once. Do not misclassify an unrelated cover dialog as an original-declaration failure.

## Required Gates

```text
authenticated
correct draft identity
upload fully complete, with no percentage or 取消上传
exact description and hashtags
short title empty
original declaration enabled
custom 3:4 and 4:3 receipts when enabled
no blocking dialog
visible enabled 发表 button
final publish not clicked
```

实测记录和待回归边界见 `acceptance-history.md`。

### 显式无损 PNG 传输（双槽 WebP 原图身份保持）

视频号原生封面输入对 WebP 可能在文件注入后无法生成预览。用户确认的 3:4 与 4:3 WebP 仍是内容包、包指纹和正式收据中的批准素材；不得覆盖、改名、裁剪或用 PNG 路径改写内容包。经用户授权并已说明格式适配后，可为两个槽分别提供尺寸不变、逐像素 RGBA 相同的 PNG transport：

```bash
VIDEO_PUBLISHER_WECHAT_VERTICAL_COVER_TRANSPORT_MANIFEST=/absolute/wechat-3x4.json
VIDEO_PUBLISHER_WECHAT_HORIZONTAL_COVER_TRANSPORT_MANIFEST=/absolute/wechat-4x3.json
```

runner 将两个 manifest 路径分别序列化到 Ego 脚本。每个 manifest v1 必须绑定对应原 WebP 和 PNG 的绝对路径、字节 SHA-256、宽高、`pixelMode=RGBA`、相同的 source/transport pixel SHA-256、`conversion=lossless-png` 与 `reason=wechat-channels-native-webp-rejection`。适配器按槽核对真实 WebP/PNG 格式、3:4 或 4:3 尺寸、manifest 字节哈希和全部绑定；缺失、串槽或文件变化均失败且不回退 WebP。

每个槽的 `receipt.assetPath` / `assetHash` 继续指原 WebP，`transport` 子收据指实际注入的 PNG。原生预览就绪、唯一槽位编辑器、裁剪/确认、主卡新 CDN URL、保存和重开像素验收全部保持原要求。组合 3:4 页面只使用竖版 manifest；双槽页面分别使用两个 manifest。同一 Job 后续恢复必须携带已被收据绑定的相同 manifest。

2026-11-02 实测：同objectId恢复可先结束初始化toast，再异步挂载视频与双封面。持久化重开必须在同objectId下等待initToast或video/cover未就绪消失（仍最多90秒），所有业务gate真实通过后才创建proof；超时或ID变化保留journal并阻断，不能将渲染空窗解释为需要重新上传。
