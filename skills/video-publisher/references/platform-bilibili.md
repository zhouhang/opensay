# Bilibili Adapter Contract

Mandatory saved-draft readback: `persistence-verification.md`. Cover receipt v2 reads only `.cover-content .cover-main .cover-module-main`, excludes recommendation previews, requires a changed HTTPS biliimg URL, and rejects the old fallback to an unchanged URL. Do not claim an unobserved second cover slot was uploaded.

Before changing the Bilibili adapter, read `platform-common.md` and `ego-browser-workflow.md`.

## Contents

- Draft resolution and upload entry recovery
- Metadata, declarations, and exact tags
- Custom cover and required gates

## Draft Resolution

Bilibili is the only platform with a tested automatic quarantine path.

Treat `本地浏览器存在…未提交的视频 / 继续编辑` as unresolved identity:

1. Click `继续编辑`.
2. If the resumed filename or expected title matches the package, reuse the target.
3. If another video owns the editor, atomically write a quarantine save intent, click only `span.submit-draft` with exact text `存草稿`, and reread `/x/vupre/web/draft/list` until exactly one new title-and-filename match supplies the draft ID.
4. Confirm the quarantine journal, return to the upload URL, rearm the final-publish guard, and verify that the page is clean before uploading the target. An unresolved intent may be reconciled by list reads, but must never cause a second save click.

The detector must distinguish:

```text
anyUploaded: a completed video exists
targetUploaded: the requested filename/title owns that completed video
```

Do not equate “target not found” with “no active upload”. This false equivalence previously skipped foreign-draft quarantine.

## Upload Entry Recovery

The current task-space tab may remain on another authenticated `member.bilibili.com` page that has no upload input. Treat this as a bounded page-readiness state, not immediate selector drift:

1. Wait for the target, an active upload, a restore banner, or the real upload input.
2. After six failed probes, navigate to the exact maintained upload URL once, only when no uploaded draft owns the page.
3. Re-arm the final-publish guard because full navigation replaces the guarded document.
4. Activate and focus the new page lifecycle before accepting its input.
5. Scope the file input to `.bcc-upload-wrapper`; ignore detached 1×1 video inputs elsewhere in the document.
6. Require upload progress or completed target evidence within 20 seconds after injection.

This flow was reproduced from the authenticated creator home page with zero video inputs. A hidden navigated page accepted a 93 MB file into `input.files` but did not start the upload component. The same clean page started immediately after lifecycle activation and reached `上传完成`. A later full recovery run recorded one navigation, reused the matching restored target without reinjection, and preserved the armed final-publish guard.

## Metadata And Declarations

视频上传仍在进行时，只要 fresh inspection 同时证明标题和标签输入控件可见，就可通过单宽 UI 队列提前修复标题与标签。简介、创作声明、原创权益和封面仍必须等上传完成。平台后续自动标签若改变集合，正式 mutation 会再次执行精确修复。

Set and independently verify:

```text
exact title
exact description
内容无需标注
内容为自制：未经作者允许，禁止转载
```

Bilibili may show the self-made value in the input while keeping `内容无需标注` in selected component state. Require both observations.

Preserve the current relevant partition unless a confirmed package requires another one. The current production ready model does not claim that it automatically chooses a partition.

## Tags

Read chips directly from `.label-item-v2-container`, not a broad body-text segment.

Remove unexpected tags through the chip component’s real close behavior. Keep only requested tags plus any exact automatic tags supplied by `bilibiliAllowedAutoTags`. The default allowlist is empty; do not embed content-category defaults in the adapter.

```text
"bilibiliAllowedAutoTags": []
```

Remove unexpected chips one at a time and wait for Vue state to settle after each close. Closing several chips synchronously from one stale DOM snapshot causes only the last batched removal to persist; this was reproduced with the automatic `学习`, `课程`, and `经验分享` chips.

Add missing tags one at a time using real focus, CDP text insertion, and real Enter. Wait for platform validation and a visible chip before continuing.

Critical rule: if the tag input is already empty, do not press Backspace; Bilibili interprets it as deleting the last committed chip.

The final tag set must contain every requested chip, no duplicate/malformed chip, and no unapproved extra chip.

If Bilibili reports that a requested tag is topic-only and cannot be added as a custom tag, preserve a typed metadata blocker. Continue independent cover repair so one rejected tag does not leave the rest of the draft unfinished. Do not silently drop or replace the requested tag.

## Custom Cover

Use the user-provided exact `4:3` homepage master from `cover.horizontal4x3Path` only when enabled. Bilibili’s current editor maintains two outputs: `首页推荐封面（4:3）` and `个人空间封面（16:9）`. The 4:3 editor is primary and can synchronize its changes to the 16:9 personal-space slot.

For an existing draft, open the unique visible main `.cover .cover-content .cover-img` with real pointer input. Its hover-only `.edit-text` may exist while hidden and cannot be treated as a working entry. Require the unique visible `封面制作` editor before locating its existing image-only file input; never select an unrelated or hidden editor's input from the whole document.

Upload through the active `.bcc-upload-wrapper` image input. The cover editor’s final control can be a `div.button.submit`, not a native button. Wait until its exact label becomes `完成`, click it through the real input channel, and require the editor to close.

On the currently tested editor, a correctly targeted real selector click may still be swallowed by the framework or time out at the CDP input boundary. First attempt the real click. If it times out, or the same visible `封面制作` dialog and the same enabled `.button.submit` control remain after the settle window, the adapter may invoke that exact scoped control through the page framework once. Record `frameworkFallbackUsed`, then still require the dialog to close and the accepted main-page cover URL to appear. Never broaden this fallback to text search or to any final-publish control.

Read the accepted main cover from `.cover .cover-content .cover-img`. Persist its `archive.biliimg.com` or `biliimg.com` URL as the receipt. The same content-addressed URL may remain when re-uploading the identical file, so proof requires the upload action, enabled completion control, closed editor, and accepted main-page URL together.

A matching checkpoint is only expected identity evidence. If a restored same-target editor does not expose the checkpoint URL on the live main cover, do not mark the cover ready. Re-upload the exact asset, record the new action receipt, and independently verify the main card even when the content-addressed CDN URL is unchanged.

## Required Gates

```text
authenticated
correct target or clean quarantined state
video fully uploaded
exact title and description
exact requested tag chips plus only allowed auto-tags
both declaration states
custom 4:3 source receipt covering the homepage 4:3 and synchronized space 16:9 slots when enabled
no blocking dialog
visible enabled 立即投稿 button
final publish not clicked
```

实测记录和待回归边界见 `acceptance-history.md`。


### 2026-10-20 黑图漏验修正

仅URL、点击回执和宽高不能证明用户封面已生效。真实故障的CDN JPG为960×720，但所有像素为RGB(13,7,7)。原生图片输入只支持PNG/JPEG，WebP投递必须先明确说明格式适配、保留原图并独立验证无损PNG像素相等；对已保存原稿使用原Job的replace-cover及独立修订日志，不能普通resume后丢弃未保存的新封面。

当前Bili收据以source-native-pixels-v1绑定实际上传文件SHA、源/平台64×48采样SHA和比较指标。上传后要求原生main lower-canvas出现新非黑画面；完成后及保存重开均需真实解码CDN图为4:3，与源图RMSE≤18、亮度相关≥0.97，双方亮度标准差>8。任意旧URL-only收据、黑图或不对应源图的图片均不通过。源预览画布可以是16:9工作区，不把它误当最终4:3输出。

### 显式无损 PNG 传输（WebP 原图身份保持）

B站原生封面图片输入只可靠支持 PNG/JPEG。用户确认的 4:3 原图若为 WebP，内容包、原图路径、包指纹和 `receipt.assetPath` 必须保持原样；不得改扩展名、覆盖原文件或把 PNG 当成新的批准素材。经用户授权并已说明格式适配后，可在 Skill 外生成尺寸不变、逐像素 RGBA 相同的 PNG，并保存独立 transport manifest。

恢复时设置：

```bash
VIDEO_PUBLISHER_BILIBILI_COVER_TRANSPORT_MANIFEST=/absolute/bilibili-4x3.json
```

runner 会把路径显式序列化进 Ego 脚本。manifest v1 必须绑定原 WebP 和传输 PNG 的绝对路径、各自字节 SHA-256、宽高、`pixelMode=RGBA`、相同的 `sourcePixelSha256` / `transportPixelSha256`、`conversion=lossless-png` 和 `reason=bilibili-native-webp-rejection`。适配器独立读取两份文件，核对真实格式、4:3 尺寸、每个声明字段及 manifest 字节 SHA-256；任一变化都在注入或收据验收前失败，不回退原 WebP。

正式收据继续以原 WebP 的路径和字节哈希作为素材身份，`transport` 子收据单独记录实际 PNG 与 manifest 绑定。上传后仍须通过新的非均匀原生画布、完成控件、主卡 CDN 解码像素比较、保存和重开验收；transport 不替代或降低这些 gate。同一 Job 恢复和重开必须继续提供同一 manifest。
