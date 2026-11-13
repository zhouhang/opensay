---
name: video-publisher
description: 使用 Ego Lite 将视频存入小红书、抖音、B站、视频号草稿箱并重开验收；YouTube 使用官方 Data API 上传为私密视频。用于多平台投递、原稿标签更新、封面替换、恢复、验收及适配器维护。禁止公开发布。不用于剪辑、封面制作、公众号长文或泛平台建议。
---

# 视频发布

确认一个视频内容包，交给维护好的程序上传、保存并重新读取验收。四个国内平台保留 Ego 和独立适配器；YouTube 仅走官方 Data API，交付的是私密视频，不冒充 Studio 草稿。

## 必须遵守

- 将本文件所在目录记为 `SKILL_DIR`，所有相对命令都在该目录运行。
- 日常发布只调用维护好的生产入口，不手工拆分平台阶段，也不自行控制创作者页面。
- 不点击任何平台的最终发布、保存或定时发布按钮。页面守卫只是最后一道保护，不是可试点的按钮。
- 专用的“暂存离开／存草稿／保存草稿”不是最终发布按钮，仅允许维护好的 `persist` 阶段操作；B站处理外来旧稿时仅 `quarantine` 可使用同一精确控件。通用“保存”、含发布含义的按钮、定时发布仍禁止。
- `READY` 必须通过 `persistedDraft`：同一内容指纹、本轮验收标识、稳定原生 ID、保存后从平台原生列表或恢复槽位重开，以及重开后的全部字段和封面。缺证据标记 `PERSISTENCE_UNVERIFIED`，不能接受点击回执或历史 READY；详见 `references/persistence-verification.md`。
- 保存前必须落盘保存意图；日志为 `intent` 时禁止再次点击保存，只能读取平台原生记录进行核对。`confirmed` 仅用于恢复重开，不是验收通过的证据。不得删除日志来绕过不确定状态。
- YouTube 不回退 Studio 网页，不公开、不设 unlisted、不通知订阅者；先运行 `node scripts/youtube-api-config.mjs status`，缺 OAuth 时按 `references/youtube-api-setup.md` 配置，不重复上传旧 Studio 草稿。
- 只有配置声明所有视频均为原创，或用户明确确认当前视频拥有原创权利时，才允许勾选原创、自制等声明；不得从视频内容自行推断。
- 使用用户确认的精确视频和封面路径，不静默替换、裁剪、转码或改用相似文件。
- 让程序判断上传完成、草稿身份、字段状态、回执和 `READY`；不要把“执行过动作”解释为成功。
- 当前请求与同一任务已经确认的标题、平台、封面意图和原创依据直接继承，不重复询问。做封面后继续发布的完整授权包含上传本次已生成封面；按 `references/intake-workflow.md` 交接。
- 开始前区分新建草稿、恢复原草稿、替换草稿封面和修改已发布内容。原稿换源不等于另发一条；本生产入口不支持已发布内容换源，不能用新建或重发冒充。

## 标准发布流程

1. 运行配置检查：

   ```bash
   node scripts/config.mjs status
   ```

2. 若 `onboardingRequired` 为 `true`，读取 `references/configuration.md`，完成配置并执行 `validate`；配置完成前不打开创作者页面。
3. 读取 `references/intake-workflow.md` 和 `references/content-package.md`，确认：
   - 精确本地视频；
   - 从 `availablePlatforms` 中选择的平台；
   - 标题、已审核的完整介绍和 tags/topics；按 `content-package.md` 原样投放，不另写平台文案；
   - 小红书标题按加权长度不超过 20：所有 ASCII 字符算 0.5，其他 Unicode 字符算 1；未超限时保留原始标题；
   - 当前视频的原创权利依据；
   - 是否上传用户已经提供的封面。
4. 将确认后的内容包 JSON 写到 Skill 目录之外。只有明确上传已有封面时才读取 `references/cover-workflow.md`。
5. 直接运行生产入口；它会在打开页面前统一完成配置、内容包、媒体和封面校验：

   ```bash
   scripts/run-safe-platforms.sh <package.json> [task-suffix] [platform...]
   ```

   命名参数：`--package`、`--platform` / `--platforms`、`--task-suffix`、`--job-id`、`--operation`、`--space-name`、`--reuse-space`、`--cleanup-only`。默认新任务开新 Ego 空间，恢复复用原空间。小红书验收后 park 到原生草稿列表，停止5秒自动暂存；其他平台保留草稿页。仅清理退役空间，关闭本次空间须加 `--close-on-complete`。

   已经 `READY` 的 Job 默认拒绝再次创建草稿。用户明确要重发时使用全新 Job，并加 `--operation repost --confirm-new-copy`。替换已 `READY` 且尚未发布的草稿封面时，读取 `references/cover-workflow.md`，沿用原 `--job-id`，只修改封面路径并加 `--operation replace-cover`；程序会复用原任务空间，不重新上传视频。标题、正文、tags、视频或其他字段发生变化时不得冒充封面替换。

   改标签见 `references/scripts.md`：原 Job 用 `--operation update-tags --confirm-tag-change`，禁止重传。
   用户确认新版完整视频并要求更新未发布的原草稿时，读取 `references/video-replacement.md`，使用原 Job 的 `--operation replace-video`。新版源文件必须经独立注入日志、同一原生草稿 ID 保存重开验收，不能把旧视频上传回执改写成新版证据。YouTube 不能替换现有视频字节。

   同一个多平台 Job 只恢复或重开部分平台时，必须沿用原 `--job-id` 并加 `--no-cleanup-stale-spaces`，防止清理影响未选平台的待发布页面；命令若报告关闭了当前 Job 的未选平台空间，不得宣称页面仍可见，必须恢复对应平台。

   平台参数省略时使用配置中的默认平台。仅在用户确认当前视频原创权利后追加 `--confirm-original-rights`。
6. 读取命令最后输出的结构化摘要：
   - `ready: true`：所有所选平台已验证。草稿页留着，你检查后自己点发布；
   - `ready: false`：逐个平台报告 `blocker`、`missing` 和 `evidencePath`，不要笼统宣称失败或成功；
   - `USER_CONTROL`：立即停止全部浏览器工作，只有用户明确要求继续后才能重试；
   - `INPUT_CHANNEL_BROKEN`：立即说明受影响平台和缺失项，保留现有任务。通道未恢复时不重复跑生产命令；确认 Ego Lite 恢复后再沿用原 `--job-id` 和内容包，只恢复未完成平台；
   - 其他 blocker 只处理对应平台，不回退或重做已经 `READY` 的平台。

同一个内容包的中断恢复仍使用同一生产命令和 `--job-id`。程序负责复用任务状态、平台空间和已验证回执。

交付时区分“本地封面已生成”“平台已接收封面”“草稿 READY”和“用户确认已发布”。历史 READY 不能证明页面仍在；用户报告页面缺失时先检查原任务，不能直接报完成或默认重传。已由用户发布的平台不再恢复上传。

只读检查使用：

```bash
scripts/run-safe-platforms.sh <package.json> [task-suffix] [platform...] --inspect-only
```

## 按需读取

只读取当前任务需要的文档：

- 首次配置、修改默认平台或新增账号：`references/configuration.md`
- 选择视频、检查字幕、拟定发布内容：`references/intake-workflow.md`
- 创建或修复内容包 JSON：`references/content-package.md`
- 上传用户已有封面：`references/cover-workflow.md`
- 查看命令参数、任务状态或单平台诊断入口：`references/scripts.md`
- 诊断或修改页面适配器：先读 `references/platform-common.md`、`references/ego-browser-workflow.md`，再按平台读取 `references/platform-xiaohongshu.md`、`references/platform-douyin.md`、`references/platform-bilibili.md`、`references/platform-wechat-channels.md` 或 `references/platform-youtube.md`
- 自定义发布步骤：先读 `references/customizing-workflows.md`，再按其中路由读取共享和平台文档
- 更新实测范围或发布维护结论：`references/acceptance-history.md`

不要为普通发布加载适配器、调度、锁、恢复或历史验收文档。

## 维护边界

静态审查、文档修改和本地测试不读取个人配置，也不打开 Ego Lite。只有维护任务进入真实页面诊断时，才执行配置检查并遵循页面工作流。

页面适配器的改动必须以真实创作者页面证据和无操作复跑验收；调度、持久化、锁、任务空间、共享输入或回执改动还需要对应的崩溃恢复与完整生产回归。历史结果只记录在 `references/acceptance-history.md`。

任何 Agent 都不得并行控制创作者页面；生产编排器是唯一的页面控制入口。
