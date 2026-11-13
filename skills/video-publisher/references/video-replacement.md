# 替换原草稿的视频文件

仅用于用户已确认新版完整视频，并明确要求更新尚未发布的原草稿。入口沿用原 `--job-id`：

```sh
scripts/run-safe-platforms.sh --package /absolute/new-package.json \
  --job-id original-job --platforms bilibili --operation replace-video \
  --reuse-space --no-cleanup-stale-spaces
```

新版包只允许修改 `videoPath` 和视频字节。标题、正文、标签、原创声明、受众与可见性等设置、封面配置和封面文件必须与对应平台的原包相同。B站和视频号分别通过原生“更换视频”或清空当前编辑器上传内容后重选文件的界面操作，保存时必须保持同一原生草稿 ID。禁止通过新建 Job、重新创建草稿或旧上传回执改写 fingerprint 冒充更新。

替换前从原确认保存日志与不可变的独立 `verify` 文件绑定原草稿、空间和视频身份。只读检查造成的 `needs_persistence` 不会抹掉这些历史证据，但历史证据本身不授权上传：平台必须重新核对当前原生 ID、旧文件 ID 和未发布状态。

每次修订独立使用 `.video-<fingerprint>.json` 回执、`.video-<fingerprint>.replacement.json` 注入日志及 `.video-<fingerprint>.draft-save.json` 保存日志，原日志与旧证据保持不变。注入日志先原子落盘并 fsync，再进行清空和文件注入。结果不明的 intent 不允许再次注入；confirmed 重跑只允许读回同一原稿与已确认的新原生文件。验收必须证明新版 SHA-256、大小、mtime、新原生文件 ID、同一草稿 ID、文案和封面一致，并独立保存重开。禁止接受新增副本。

同一 Job 可依次更新不同平台；已经更新的平台对象、原生 ID 和回执保持不变，未更新的平台继续使用其原包和原 fingerprint。

## 小红书的显式原稿替换

小红书本地草稿的未发布状态不可从旧编辑器 `hasBeenPublishSuccess:false` 推断。现成的自动恢复保护保持有效。用户直接确认“尚未发布，只更新原草稿”后，可通过 `VIDEO_PUBLISHER_VIDEO_REPLACEMENT_AUTHORIZATION_PATH` 传入只绑定本次原稿替换的人类确认文件，类型必须是 `user_attested_original_draft_replacement`，并明确写明它不是原生发布状态证明。

确认绑定原 Job、平台 fingerprint、任务空间 ID/名称、账号 uid、原 UUID、旧 videoFileId、新版 SHA-256 及直接用户回复来源。它仅授权 `replace-video`，不授权 `auto`、`resume`、`inspect`、封面修订或另建草稿。任何原生已发布的正证据仍立即终止操作。

若原任务空间确已关闭，只有确认文件明确允许时，才可以在独立 `.space-binding.json` 日志中记录“原空间确实缺失”的空间清单，创建完全相同的原空间名称，并绑定新空间 ID。已存在的同名或原 ID 空间不能接管。原空间与历史证明 ID 保留，原账号本地库必须在重开编辑器和注入前再次确认原 UUID、旧文件 ID 和快照。完成独立验收后仍必须执行 park，离开旧编辑器以停止每 5 秒自动保存。

## 小红书旧保存快照的显式原稿重验

原 `confirmed` 日志的快照与原生 record/live 同源快照不一致、因此从未生成成功独立 verify 时，不可伪造旧 verify，也不可走普通 `resume` 再次保存。用户已明确说明尚未发布并授权更新同一原稿时，可使用专用维护入口：

```sh
node scripts/reconcile-xhs-original.mjs --package /absolute/original-package.json \
  --job-id original-job --authorization /absolute/human-authorization-v2.json
```

v2 授权保留真实的 `authorizationSource.answer` 和 `authorizationSource.source`，不要求用户复述固定句子。必需：`version:2`、`kind:user_attested_original_draft_replacement`、`platform:xiaohongshu`、`scopes:[unpublished,original-recovery,replace-video]`、`nativePublicationStatusProof:false`、`attestedAt`，以及原 `jobId/sourceFingerprint/sourceTaskSpaceId/sourceTaskSpaceName/uid/sourceDraftId/sourceVideoFileId/sourceJournalSha256` 和 `nextVideoSha256`。缺失空间恢复另须 `allowMissingOriginalTaskSpaceRecovery:true`。这是人类授权，不是伪写的原生未发布证明；任何真实的发布正信号仍立即终止。

入口只用原包，禁止视频注入及业务字段变更。从原生草稿箱重开同账号、UUID、旧视频；record/live 必须一致，原包全部业务和安全门通过。原日志逐字归档并绑定 SHA 后，才使用真实当前快照创建新的保存意图，实际暂存、同 UUID 重开、独立 verify、park。结果不确定的 `intent` 不允许再保存。旧空间确实缺失时，只创建同一原名的新空间，记录独立空间绑定，不接管任何现存空间。

成功后的新 verify 仍是原稿的视频身份，不代表新版视频已上传。随后运行正常 `replace-video`；其 v2 授权文件绑定实际恢复后的空间 ID 和当前保存日志 SHA，继续沿用真实人类原话。此维护入口不公开发布，不改变普通自动恢复保护。

## YouTube

`replace-video` 不支持 YouTube；官方接口不能替换现有视频字节。用户明确授权后另建 private 视频并保留旧视频，不能称为同一原资源的文件替换。

## 视频号的服务端转码

同一原草稿可能先恢复上传 UUID，随后由服务器改为转码文件的 MD5 和新大小。原注入日志必须保持不变，不能把转码 ID 或字节数写回成最初上传身份。只有独立 `.replacement.json.normalization.json` 证明绑定原确认日志、实际原生下载回执、批准源文件、转码文件和全片内容核验后，才允许接受该转换。恢复保存 intent 仍只重开核对，禁止再次上传或再次保存。

内容核验使用全片连续音频窗口及分层画面抽样。平台的单一全局增益和固定延时必须明确记录；不得逐窗口自由调增益、伸缩时间或把处理后的残差冒充原始差异。恒色画面的 Pearson 相关系数保留为空，通过实测空间方差和原像素误差阈值判断。原始严格比较报告保留，转换证明只说明新版内容身份，不声称音频字节或响度完全相同。每次读回还需核对当前原草稿 ID、转码任务 ID、MD5、大小、尺寸、文案和封面像素；证明缺失或变更继续阻断。
