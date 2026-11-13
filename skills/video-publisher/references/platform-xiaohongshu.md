# Xiaohongshu Adapter Contract

Mandatory `persist -> verify` is defined in `persistence-verification.md`. Reopen the same draft and verify video, selected cover ratio, title, approved body, actual topic entities and originality. Save notifications and editor previews alone do not prove persistence.

Before changing the Xiaohongshu adapter, read `platform-common.md` and `ego-browser-workflow.md`.

## Account Defaults

```text
short title, maximum 20 codepoints
real topic entities only
approved complete description from the release package
原创声明 enabled for original videos
```

## Upload And Identity

Use the confirmed video file. Reuse an uploaded editor only when the filename or expected title identifies this package. A different active draft is a blocker; Xiaohongshu has no tested automatic quarantine flow.

The orchestrator additionally reserves exact video bytes (SHA-256 plus size) before the first upload or mutation, under the fixed publisher lock. The durable `xiaohongshu-video-claims.json` lives beside the account-wide publisher lock, independently of `--state-root`. It also checks matching historical XHS jobs in the current/default and previously recorded state roots. Package fingerprints include metadata and paths and are therefore not video identities. A new Job for already claimed bytes is blocked before opening a creator page, even after a rename, new cover or title. Explicit user-authorized reposts remain possible only with both repost flags; ordinary same-Job resumes retain their existing claim.

The claim is a conservative installation-wide duplicate guard, not proof of an authenticated account or native draft. It points to the original Job; use that Job's exact package and read-only inspection, then recover its existing native UUID/account/file ID through the normal adapter. Do not transplant READY or invent native identity from a title. Historical roots outside the current/default roots can be found only after this registry has recorded them; a lost/deleted registry or unknown legacy root must be reconciled manually, never assumed empty. Corrupt registries fail closed. Do not remove them to create a replacement draft. No existing drafts are deleted or modified by the duplicate check.

A durable XHS save journal (including an uncertain `intent`) additionally forces original-resource-only page selection: no fresh task space/tab or file injection is permitted during recovery. A previously started upload cannot be bypassed with `--force-fresh-space`. Reopen and inspect the original resource; preserve an uncertain save journal and do not click save again. These protections have local mock/fixture coverage; they do not claim a live creator-page save has been qualified.

`run-safe-platforms.sh` faithfully forwards every argument to this core; it never filters platforms or treats a legacy ledger row as READY. Its comma-list parser and grep-based all-platform bookkeeping are superseded. The core strictly reads the existing local `content-pipeline/.draftbox_ledger.json` under its publisher lock: matching XHS SHA rows conservatively block a new Job, while original-Job recovery/revision still runs normal inspection. Corrupt ledgers stop writes and remain intact. Only a platform freshly verified READY with verification version 2 in the current invocation is mirrored to its own legacy key; partial failures never mark siblings. Inspect-only never marks or skips a platform. Existing selection-pool IDs and unrelated rows are retained. The core does not call `pool_draftbox.py`, reset its ledger or update an external selection pool.

视频上传仍在进行时，只要 fresh inspection 同时证明标题输入框、正文话题编辑器和原生话题按钮可见，就可通过单宽 UI 队列提前填写标题和话题。原创声明、封面和最终验证仍必须等上传完成。`prefill` 不满足 video gate，之后必须继续正式 `upload` 等待。

## Topic Entities

Clear the body editor completely, insert and verify the exact approved description (when supplied), then add topics one at a time through the real suggestion panel. Rebuilds must preserve that body, not erase it. The sticky final-publish footer can cover the visually exposed toolbar near the viewport bottom, so a pointer click may land on the footer instead of `话题`. Invoke the exact native `button.contentBtn.topic-btn` control through its page handler to make the platform editor insert `#`, explicitly refocus the editor at its end, type only the compact topic query, and select the exact suggestion row. Do not inject `#话题` as one text operation; that can create a suggestion decoration without loading candidates on a cold page.

Under sustained browser load, the decoration may appear while the candidate panel remains empty. Verify the exact trailing query, poll the exact row for a finite extended window, and if it never appears clear the entire topic editor and retry the whole requested set. Use at most three whole-set attempts; never preserve a half-built set or accept plain text after an empty candidate response.

After an Ego restart, the selected Xiaohongshu tab may report `document.visibilityState: hidden` even though its DOM is readable. Hidden-page timer throttling can delay a real topic candidate response far beyond the bounded wait. Immediately before a serialized topic rebuild, bring the page to front, set its web lifecycle to `active`, enable focus emulation, and prove `visible` plus `document.hasFocus()`. Do not add longer blind waits to compensate for a hidden lifecycle.

Spaces terminate Xiaohongshu topic input. When a readable package label contains whitespace, query the compact form (for example `AI Agent` -> `AIAgent`) and accept it only when the committed entity's `data-topic.name`, normalized without whitespace, matches the requested label. Preserve the readable package label in evidence. Never accept compact plain text as a substitute for an entity.

Xiaohongshu topic entities do not support the half-width dot `.`. Reject any dotted `xhsTopics` label during package preflight instead of opening the creator page or silently rewriting the label. Use an explicitly chosen dot-free label such as `GPT56` when that still represents the intended topic.

The verifier must prove:

- every requested topic exists as a committed entity;
- no requested topic remains as plain text;
- no malformed or duplicate entity exists;
- no extra unrequested topic entity exists;
- no stale body residue remains when the package has no prose body.

Do not insert `.tiptap-topic` HTML manually.

## Original Declaration

Open `内容设置`, enable `原创声明`, accept the agreement checkbox when a dialog appears, and click the dialog’s `声明原创` control. That dialog control is not the final publish button.

The current switch uses `.d-switch-simulator.checked` and `.d-switch-simulator.unchecked`. Read the nested checkbox first and otherwise compare class tokens exactly; substring matching is forbidden because `unchecked` contains `checked`.

After accepting the agreement, wait for Vue to enable `声明原创` before clicking it. A disabled confirmation is a blocker, not a successful toggle. Verify both the enabled switch and the closed agreement dialog from a fresh inspection.

## Custom Cover

Default to the platform cover unless the package explicitly enables an existing-cover upload. Use the exact asset selected by `cover.platforms.xiaohongshu.nativeRatio` (3:4, 4:3, or 16:9); absent selector retains the legacy 3:4 mapping. The actual editor may offer only 3:4, 4:3 and 1:1, so an unavailable requested ratio is a blocker.

The current editor exposes a hover-only `.cover-edit-entry`. Pointer movement can remove that element before the click event completes, so this is a live-proven native-handler exception: invoke that exact entry’s page click handler before falling back to a stable preview click. Then poll for `.main-cover-editor-modal` and prefer its direct image input; the current editor may show only `上传` and `完成`, without a separate `上传封面` tab. Choose the crop ratio matching the asset when exposed and confirm the editor.

Accept the cover only when the main editor exposes the uploaded preview URL, normally on `ros-preview.xhscdn.com`, and no cover dialog blocks the page. Store that URL in the receipt and require the verify phase to find it again.

当前横屏稿的主卡片是 `.default.row`，操作区内部的 `.operator.default.column` 不是竖版封面槽。只接受唯一可见、带背景图且不在 operator 中的主卡片。原生 `裁剪` 工具中的 `.crop-panel .ratio-list button.ratio-option.active .ratio-label` 表示真实输出比例；上传图片原尺寸不代表该比例。确认后必须读取 contextStore 已导出封面的宽高和文件 ID，重开后还要检查 IndexedDB 记录的同一封面。只有已绑定并重新验证的正式回执可跳过上传；未绑定的旧缩略图必须替换，不能为它补造新文件哈希。

## Required Gates

```text
authenticated
correct draft identity
video fully uploaded
exact title
exact approved description, independently checked after removing topic entities
exact topic entities with no plain residue
原创声明 enabled
custom selected-ratio receipt when enabled, otherwise default cover state
no blocking dialog
one visible enabled final control labeled `发布` or `发布笔记`
final publish not clicked
```

实测记录和待回归边界见 `acceptance-history.md`。

## Original Draft Cover Revision

显式比例修订首次要求原 Job READY，仅选小红书并禁止清理旧空间。先落盘修订意图，绑定原账号、UUID、视频文件 ID、旧保存证明和原日志 SHA-256，再迁移封面身份；视频及非封面内容必须逐项相同。使用独立 `.covers-<fingerprint>` 回执和保存日志，原日志与其他平台状态保持不变。中断用相同包、Job 和 `replace-cover` 或 `resume` 恢复；禁止重新上传视频、重建空间或创建副本，保存不确定时只能核对原资源，不重复暂存。

封面修订不修复文案、话题或原创声明；这些字段变化即停止。只能向唯一可见原生编辑器的唯一图片输入注入指定文件，校验上传前后本地 SHA-256。临时选择器不得命中隐藏旧编辑器；未验证的旧缩略图不能作为新上传完成证据。最终仍要求原生导出封面和保存重开结果一致。

# 本地草稿与封闭组件

2026-09-12 真实页面确认：最终“发布”和“暂存离开”位于 `xhs-publish-btn` 的 closed Shadow DOM。必须使用 Ego 的 CDP 无障碍树解析原生 button，不能把导航“发布笔记”当最终按钮。共享守卫覆盖 closed root，组件替换后必须重新挂载。

草稿保存在当前浏览器 IndexedDB `draft-database-v1` 的 `video-draft`，不是云端草稿。专有实现位于 `scripts/v2/platforms/xiaohongshu-persistence.mjs`。以原生 `publisher.draftId`、当前账号和上传文件 ID 绑定，再从真实草稿箱匹配 UUID 重开。重开会丢失原文件名显示，需使用已绑定的上传文件 ID；不可单靠标题或“视频文件.mp4”认领视频。

2026-09-12 新版 Mojito 封面编辑器确认：正式封面写入 `content.contextStore.coverContext.cover.fileid`，同时 `draftStore.cover.fileid` 可能继续保留旧的视频帧。校验器必须优先读取前者，并要求它与主页面封面对象键、当前任务回执一致；旧版草稿缺少该字段时才回退 `draftStore.cover.fileid`。只看 CSS 预览或只看上传缩略图仍不得通过。

保存日志仅用于恢复，最终仍要求重开后的文案、话题、原创声明、封面和安全 gates 全部通过。新保存及整条生产调用尚待真实验收，不能将只读检查或模拟测试写成平台发布成功。


### 显式无损 PNG 传输（2026-10-20 实测）

原生Mojito封面输入虽声明image/*，实际解析器会拒绝WebP。不得仅改扩展名、声称原WebP已接收或静默换图。若用户授权提供的封面投递且已明确说明格式适配，可在Skill外制作保持尺寸、逐像素RGBA相同的PNG，保留原WebP与内容包，独立验证两者像素，并保存transport manifest。带 `VIDEO_PUBLISHER_XHS_COVER_TRANSPORT_MANIFEST=/absolute/manifest.json` 运行原job恢复；runner将该路径序列化进Ego脚本（远端Node不继承shell env）。

manifest v1绑定sourcePath/sourceSha256、transportPath/transportSha256、width/height、pixelMode=RGBA、相同sourcePixelSha256/transportPixelSha256、conversion=lossless-png及reason=xiaohongshu-native-webp-rejection。像素相等须由本地解码独立实测；adapter重新绑定文件hash、格式尺寸和manifest hash，不能把manifest声明当作自行解码证明。没有显式选项则不转换、不替换。原生新缩略图、封面导出、账号/UUID/videoFileId、独立保存重开全部仍必需；receipt.assetPath/assetHash指原图，transport子收据指实际PNG。后续原稿恢复及重开沿用同一manifest；任一文件或manifest改变均停止。

## Stop stale-editor autosave and park verified drafts

The current native editor writes its same UUID to local IndexedDB every 5 seconds and on unload. A stale editor can therefore recreate a locally deleted draft even after another editor published it. False `hasBeenPublished` / `hasBeenPublishSuccess` flags in a stale page are not proof of an unpublished video. Content SHA claims prevent repeat uploads but do not stop this native timer.

Every new XHS delivery now runs independent editor `verify`, then a serial `park` phase. Parking performs no upload, business-field mutation, save click, or draft editing. It checks the original immutable verify artifact, current account/UUID/video ID/full seven-field snapshot hash and accepted native cover ID/dimensions, navigates to the native upload/list document, rearms the final-publish guard, and opens the draft list without selecting Edit. READY requires a fresh matching IndexedDB record, exactly one visible native UUID row, and exactly one visible image whose source has the accepted cover object key, has completed loading with nonzero natural dimensions, and passes `HTMLImageElement.decode()`. A matching background URL or failed/blank image element is insufficient. The active editor must be empty. The list does not claim to contain a final publish button: its parked proof links to the original verified editor controls. Park failure blocks delivery and the legacy delivery ledger.

For an already READY resource, protective parking alone is available:

```bash
scripts/run-safe-platforms.sh /absolute/current-package.json --job-id original-job --platform xiaohongshu --operation park
```

This operation uses the original platform-specific fingerprint, including when an unrelated platform cover revision changed the global package fingerprint. It never invokes inspect/upload/mutate/persist/reopen phases. Repeating it on a parked list independently reads the same record and list without reopening an editor; the original editor run and parking time remain historical evidence. It cannot park a foreign, changed or unverified resource. No draft is deleted.

An old draft-save journal now blocks automatic recovery before Ego selects its page unless strong, fresh native publication-state evidence explicitly identifies the same account, UUID and video file ID. A positive note ID or either true native published flag is terminal `ALREADY_PUBLISHED`. Unknown state is `STATE_AMBIGUOUS`; title matches and absence from a published list are insufficient. Protective park is exempt because it only quiesces the existing editor. Confirmed snapshot drift no longer triggers automatic re-saving, even if the business fields appear acceptable.

The optional `VIDEO_PUBLISHER_XHS_PUBLICATION_STATUS_PATH` manifest contract is implemented in `scripts/v2/lib/xiaohongshu-publication-guard.mjs`. It binds a native evidence file by SHA-256. Explicit unpublished resource details must be complete and at most 60 seconds old; known published resource identities remain terminal. Never create negative status evidence from incomplete list metadata, remove journals, or reset a ledger to bypass this guard.


### 旧编辑页自动回写与保护性停放（2026-10-20 修复）

原生发布编辑器有每5秒、beforeunload及组件卸载自动暂存。用户从其他入口发布/删除本地草稿，并不能给遗留编辑页可靠传递发布终态；旧页false发布标志不能证明尚未发布。仅靠MP4 SHA/Job防重无法阻止这种同UUID回写。

投递流程需独立verify后执行专用park：保留原编辑器验收artifact，当前记录的账号/UUID/视频fileId/完整内容hash/封面及列表行均须核实，离开编辑器后停在原生草稿列表，不伪造列表页上的发布按钮。当前已验证原稿可用显式operation park做保护性退出，禁止上传、修改、暂存和重开。发布状态不明不妨碍退出旧页，但不得借park恢复或修改旧稿。

旧confirmed任务恢复必须先有强身份发布状态证据；已发布则ALREADY_PUBLISHED，未知则STATE_AMBIGUOUS。禁止自动restartConfirmedDraftSave把旧稿写回。现有旧草稿不因修复自动删除；先备份并保护仍未发布的内容。

2026-11-02 本轮真实页面观察到 PNG 已解码为 blob 缩略图后，原生服务器上传仍超过20秒。精确文件注入后的等待窗口扩为最多120秒，期间仍要求新缩略图、loaded=true、pending=false，并反复绑定原图/传输文件/manifest 哈希；本地 blob 预览本身不构成成功证据。
