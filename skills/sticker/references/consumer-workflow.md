# 使用统一 OpenSay 消费工具

适用于整个模板库。字符剧场是参考实现，不能把其配色、模块名、画幅或出镜布局变成其他模板的默认值。用户稿、标题、简介和标签的原有入口与授权保持不变。

## 两种使用方式共用一个执行层

制作保障位于库内 `.opensay/`，普通 Agent 加模板库也能调用；Sticker 负责引导、语义编排、项目进度与审核。各模板通过自己的 `capability/consumer.v1.json` 声明真实能力，模板源码和素材是一文件夹一真源。原生 runtime 保留，消费侧通过共享入口调用，无需模型自行读全库源码或临时编写渲染胶水。

设置 `OPENSAY_LIBRARY_ROOT` 或使用当前明确的库路径，先查看共享 CLI 的帮助。技能内 `scripts/discover_opensay_templates.py` 只转发共享 `discover` 的简短结果。按需调用 `describe` 获取本镜候选的参数、素材、事件与限制，避免加载所有大能力文件。`.opensay/` 是共享代码、Schema 和规范，不是全局模板 registry。

## 内容到正式预览

1. 按原入口冻结用户稿和本期声音。真实声音确定总长；三种声音路线都经可信词时间证据进入消费编译，不用句长估算或均分词时间冒充词级对齐。缺证据时补实际对齐；可保留明确标注的设计或测试预览，不宣称达到正式词级制作要求。
2. 根据完整语义拆分镜头，写本镜要表达的关系、注意力目标和变化；镜内可有多个信息 beat。分镜与动作不能仅按句号切开，也不能让入场、字幕变色或背景呼吸替代语义推进。真实音频持续、不变速。
3. 逐镜标记素材为必需、建议或无需。需要时先检索可取得的官方/可信 Logo、人物、资料图片与视频，保存查询、候选、来源、下载/解码及镜头匹配结果。私有实操结果或检索仍无合格命中，再列具体对象、画面、时长和比例给用户；不拿泛用图库冒充真实产品证据。共享 `materials` 完成任务、搜索回执、下载与缺口闭环，`check-materials` 另核对计划实际绑定；其他联网来源由当前 Agent 的搜索工具执行后导入真实回执，不能把检查器称为已代搜。
4. 由共享 `recommend` 按实际语义覆盖、素材、出镜、画幅和时长约束缩小范围，结合真实动态样例推荐三个合格候选，说明匹配与剩余缺口；不足三个如实说明。用户已选模板则直接继承，仍核验该模板的真实覆盖范围。
5. 默认按库内 `.opensay/QUICKSTART.md` 写一份 `opensay-storyboard-v1` 分镜文件（每镜的起始原话 `from`、模块、严格参数、`事件名 → 本镜口播原词`、真实素材），先用共享 `script` 读带真实时间的口播短句、`describe --brief` 读模块卡片。共享 `storyboard` 据词级证据算出镜头秒数、字符锚点与字幕，生成唯一 `episode_plan.json` 并调用同一 `compile`；同时硬性检查语义变化间隔（≤4 秒，参考片中位 1.3 秒）和画面文字是否出自本镜口播，按返回的 `errors[].fix` 逐条修改分镜文件后重跑，不手改派生产物。国产模型一律走此入口；只有顶级 Agent 需要分镜格式表达不了的字段时才直接编辑 `episode_plan.json`：填写模块、严格参数、真实素材、重点词及对应事件。共享 `compile` 根据实际声音证据编译秒数和帧号，生成 `resolved-plan.json` 与单镜请求作为只读派生产物；不自由编辑第二份计划。缺必需事件、材料、容量、模式或证据时，按明确错误修正；真实模块缺口交 Builder。
6. 用共享 `check-shot`、`render-shot`、`render-film` 做技术检查及本期逐镜/完整正式预览。单镜与整片必须使用同一 renderer 和请求，整片旁白只混一次。配乐/音效从实际可用与明确来源的素材绑定，并按相同事件和时间轴混音。 **2026-11-12 用户决定：BGM 从库根目录 `bgm/` 选，音效按模板 `audio/sfx-map.v1.json` 落在真实语义事件上**；走分镜入口时两者默认自动绑定（见库内 `.opensay/QUALITY.md` 的 BGM 与音效两节），所选曲目、候选和音效数量在报告 `stats.sound` 里如实告诉用户，记录为曲库选曲而不是用户逐曲确认，用户审片时可换曲。库外音乐仍须先给用户试听并保留其真实选择。

## 素材任务与真实回执

在同一计划的每镜填写 `material_needs`。`necessity` 为 `required/helpful/unnecessary`；`type` 为 `image/logo/screenshot/video`。`query` 写可搜索对象，`entity` 消歧，`usage` 说明本镜用途；可附 `duration/orientation/slot`。不需要素材也明确记录，避免模型为了多样性强加图库。

```json
{"shot_id":"S003","material_needs":[
  {"necessity":"required","type":"image","query":"Ada Lovelace portrait",
   "entity":"Ada Lovelace","usage":"展示本人肖像","orientation":"portrait","slot":"portrait"}
]}
```

使用本期库路径与外部项目目录；以下示例路径都替换成本期实际值：

```sh
python3 <library>/.opensay/opensay.py materials prepare \
  --plan /absolute/project/episode_plan.json --project /absolute/project
python3 <library>/.opensay/opensay.py materials search \
  --tasks /absolute/project/materials/tasks.json --task S003-M01 --provider commons
python3 <library>/.opensay/opensay.py materials bind \
  --tasks /absolute/project/materials/tasks.json --task S003-M01 \
  --search-receipt /absolute/project/materials/search/<actual-receipt>.json --candidate 0
```

Commons 公共 API 搜索返回实际 URL、MIME、尺寸、作者和许可元数据；它只提供候选，不决定哪个素材准确，也不自动宣称许可满足本期用途。Agent 检查实体、用途与真实候选后才显式选定 `--candidate`（从0开始）。`bind` 限制下载体积、实际解码、计算 SHA 并保存来源回执，只写外部项目 `materials/assets`；把其 `binding` 对象写回计划的真实素材槽。

官方直链可用 `search --provider official --url <actual-public-url>` 登记；这条只登记候选，不算已经执行网上搜索。当前 Agent 使用原生 web 等其他搜索工具时，将其真实查询和结果保存为 `opensay-external-search-v1` JSON，含 `performed:true/provider/query/executed_at/source_ref/candidates`，用 `search --provider import --import-receipt <file>` 导入；保留真实工具回执引用，不编查询或来源。`candidates` 每项包含 `url`，并保留已取得的 `mime/author/license/license_url/source_page/title`；无结果时明确空数组。

用户私有录屏等直接本地绑定，不上传给搜索服务：

```sh
python3 <library>/.opensay/opensay.py materials bind \
  --tasks /absolute/project/materials/tasks.json --task S003-M01 \
  --local /absolute/project/capture/user-recording.mp4 --source-ref '本期用户实际录屏附件'
python3 <library>/.opensay/opensay.py materials gaps \
  --tasks /absolute/project/materials/tasks.json \
  --search-receipt /absolute/project/materials/search/<actual-receipt>.json \
  --binding /absolute/project/materials/bindings/<actual-binding>.json
```

`gaps` 没有真实搜索回执时返回 `search_pending`，不得据此要求用户准备本可找到的普通素材。有真实搜索但没有选定并绑定素材时，才列出对象、用途、时长/比例与已搜来源；候选尚可选择时先检查候选。成功获取文件只代表技术可用，仍须确认画面确实支持旁白表达，不声称已经搜遍全网。

## 修改、状态与验收

`structure_valid` / 设计 `passed`、`production_ready`、`evidence_current`、画面/听音自审、用户当前版确认分别记录。设计通过而生产未就绪时继续补齐，不能只检查一个绿色 PASS。`preview-verified` 可进入本期预览，不自动成为生产或用户验收。

稳定 `shot_id` 贯穿稿件、素材和预览。用户修改后使用共享 `revise` 比较内容与依赖哈希，重做受影响镜头；时长变化可能影响后续时钟、字幕及声音衔接，应按实际依赖传播。本期所有镜头、完整声音、字幕、BGM/SFX、封面和发布文案同轮展示，覆盖齐备后一次正式确认，随后沿用原 QC、发布包和已授权草稿/私密投递规则。不增加样片、逐模块或重复同版审批。

## 新模板与新增片段

只由 Codex / Claude Code 按 `opensay-template-builder` 创建或扩展。新模板、原模板新增模块及修改已有模块都要通过相同统一合同与 Builder 准入；当前源码、输出模式、素材/真人范围未实测不得晋级。国产模型遇缺口输出真实请求单，消费侧不擅自修改模板，不用换名或通用文字卡掩盖缺口。

## 国产模型验收

记录实际模型版本、Agent/工具环境、输入与模板版本、非法调用、自动修复及人工介入。Codex 的补模块、改时序或代选镜头要单独记录，不能算作国产模型独立完成。正式选题验证整条链路；本期未覆盖的真人/素材/画幅另用有标识的能力样例补验。

## 视听质量复核

正式送审前读取库内 `.opensay/QUALITY.md`。必须对照真实参考的动态风格，检查实际素材表达、邻近与全片的构图/动作重复、旁白相对配乐的分轨响度及单声道兼容性。整片 LUFS、OCR、解码和模块数量通过不代表这些项目通过。保留缺口，不用“技术 QC 通过”掩盖未做视听审查。
