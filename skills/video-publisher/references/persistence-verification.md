# Saved Draft Verification

## Scope

Each browser platform owns `draftPersistenceContract` and its field inspector in its own adapter:

| Platform | Adapter | Required business fields |
| --- | --- | --- |
| Douyin | `platforms/douyin.mjs` | Video, title, body, exact committed topics, settings, both covers |
| WeChat Channels | `platforms/wechat-channels.mjs` | Video, body, short title, original declaration, both covers |
| Bilibili | `platforms/bilibili.mjs` | Video, title, body, tags, original declaration, main cover |
| Xiaohongshu | `platforms/xiaohongshu.mjs` | Video, title, body, exact topic entities, original declaration, 3:4 cover |
| YouTube | `platforms/youtube-api.mjs` | Private API resource, owner, processing, metadata, settings, thumbnail bytes |

## Browser Pipeline

`inspect -> upload/prefill -> mutate -> persist -> verify`

The orchestrator alone serializes mutation, draft saving, leaving, reopening and verification. It preserves account, job and platform locks. Inspect-only and circuit-breaker verification never save or navigate away.

The browser persistence routine is deliberately fail-closed:

1. All business fields must pass before saving.
2. Identify the platform's stable native identity before writing: Xiaohongshu Pinia UUID and file ID, Douyin React `creationID`, Bilibili draft-list ID or pre-save list snapshot, and WeChat Channels `objectId` or pre-save list snapshot.
3. Atomically persist save intent, then click only the exact dedicated draft-save control. A control click or toast is never final evidence.
4. Reread the platform's native persistence surface: Xiaohongshu IndexedDB and draft UI, Douyin's changed `publish_form_cache` plus unique recovery prompt, Bilibili `/x/vupre/web/draft/list`, or WeChat's native `draftStore.getDraftList()`.
5. Reopen the exact record or recovery slot into a new document, rearm the final-publish guard, and require the reopened native ID to equal the saved ID.
6. Independently inspect every business field and cover again. Evidence must belong to this invocation and content fingerprint.

An editor without a stable native ID, a SPA-only transition, unchanged browser storage, or a list without a unique ID-bearing record remains `PERSISTENCE_UNVERIFIED`. Do not guess routes, assume title uniqueness, or relax this condition to pass a job.

Local tests do not certify a new live save. Record real creator-page qualification per platform in `acceptance-history.md`; until then, describe the adapter as implemented and locally verified, not platform-accepted.

## Receipt Rules

`persistedDraft` version 2 requires platform, content fingerprint, invocation ID, draft ID, save/read timestamps and transport-specific proof. The evaluator recomputes validity; `ok: true` alone is insufficient. The read must precede the observation by at most 60 seconds.

Browser proof is kept only in the reopened document. Later mutations invalidate it. Disk checkpoints cannot manufacture new proof. Historical READY without verification version 2 is invalidated during job recovery, without deleting the video or reuploading it.

YouTube requires an independent `videos.list` with matching owned video ID and private status. A successful `videos.insert`, `videos.update`, or `thumbnails.set` is only a write receipt. Thumbnail acceptance also requires server image bytes to change from before upload and match the saved server digest on subsequent reads. A cached or unchanged image is unverified, not success.

## Safety And Delivery

Dedicated draft saving is authorized by a draft-delivery request; public publishing is not. Never use generic Save, Publish or Schedule controls. Preserve blocked-attempt history across navigation.

Never describe a held-open editor as a saved draft. Never describe a private YouTube video as a Studio draft. API copyright checks and subscription notification settings are not independently readable; report these limitations rather than claiming they were checked.
# 保存中断与恢复

浏览器保存日志为平台回执路径加 `.draft-save.json`。保存前原子写入 `intent` 并同步磁盘；观察到保存确认后记为 `confirmed`。

- `intent`：可能尚未点击，也可能已经保存但响应丢失；一律不自动再点击保存，只允许读取平台原生记录核对。
- `confirmed`：只恢复同一内容指纹和平台的草稿箱重开，不再点击保存按钮。日志不能直接生成 READY。
- 日志损坏、内容指纹不同、跨平台或非该平台 HTTPS 地址均阻断。不得删日志或改状态来“修复”验收失败。
- 测试通过不等于新草稿已可交付。抖音、B站和视频号已经分别使用恢复槽位、原生列表接口和原生 store 的专有适配，但仍需用下一条新视频做完整真实回归。

小红书已路由到独立原生本地草稿实现，不使用 URL 查询参数作为草稿 ID。以 Pinia UUID、账号、上传文件 ID 绑定内容；重新读取 IndexedDB 后再通过新页面的草稿箱列表重开。`browser_local_draft` 表示草稿仅保存在当前浏览器，清理浏览器数据可能丢失。满 100 篇视频草稿或 1000 篇总草稿且本次为新记录时阻断，避免原生保存隐式删除旧稿。仍需真实新保存和系统级回归。

抖音同样标记为 `browser_local_draft`。它以 React 原生 `creationID` 绑定当前编辑器，以恢复提示和 `publish_form_cache:<uid>` 的变化确认暂存，再从上传页恢复并验证同一 ID；不得把恢复提示本身当作草稿身份。

## Original-resource tag revision

`update-tags --confirm-tag-change` creates a new content fingerprint only after strict tag-only package/asset validation. Prior proof identifies the source resource but is never copied into a new READY verdict. All platforms obtain fresh current-fingerprint/current-run readbacks. Bilibili and WeChat require the exact original native ID in both the editor and saved list; existing list membership alone is not evidence an update was saved. Their revision journal is confirmed only after the same record reopens with every business gate passing.

Fingerprint-specific revision journals preserve all previous save journals. An interrupted revision intent blocks repeat saving; only safe observation can resolve it. YouTube checkpoint migration has an exact from/to audit and supports recovery between checkpoint and job-state commits, retaining videoId and thumbnail evidence. Upload/session creation, native ID replacement and browser-space recreation are prohibited throughout tag revision and subsequent same-revision resumes.

## Original-resource cover revision

Xiaohongshu, Bilibili and WeChat cover replacement binds each selected platform's source fingerprint, confirmed save journal and SHA-256, independent original-ID reopen proof, accepted cover receipt and exact task space before migrating identity. Only selected platforms receive the new fingerprint. Original journals/checkpoints and unselected platform state remain unchanged; the revision uses separate `.covers-<fingerprint>` files.

The original native ID must survive saving and list reopening. Cover-only mutation cannot repair metadata or declarations. Bilibili and WeChat confirm a revision journal only after every reopened business gate, including the new cover, passes and no new same-content native ID appears. An existing `intent` is recovered by observation and reopening only; a `confirmed` journal is still just a locator and never bypasses fresh field validation.
