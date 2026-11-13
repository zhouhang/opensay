# 统一消费规范与开发准入

适用于所有通过参考视频新建的模板，以及已有模板新增、修复或修改的片段；字符剧场只是首个完整参考实现。技能不保存一份平行规范或模板副本。

## 唯一规范与运行入口

规范、Schema、校验规则和共享 CLI 随 OpenSay 库放在 `.opensay/`。先读取该库的规范与 `python3 <library>/.opensay/opensay.py --help`。默认库为 `~/Desktop/opensay`，用户指定库或 `OPENSAY_LIBRARY_ROOT` 优先。

每个模板的 `capability.json` 用 `consumer_contract.path` 指向本模板的 `capability/consumer.v1.json`。此合同统一描述：语义用途与反例、严格内容参数、素材槽、出镜与输出模式、时长、必需/可选事件、真实运行入口、当前源码与验证证据。风格、源码、素材、依赖与预览仍留在该模板目录。`.opensay/` 是共享工具与规范，不是全局片段 registry。

新模块直接接入相同的消费入口，不能只增加另一个孤立的演示入口。预览与整片使用相同 renderer、内容参数、素材和事件。缺字段、超容量或不支持的组合必须给可修复错误；不能截断、回退示例文案或用占位图冒充实际素材。

同时读取库内 `.opensay/QUALITY.md`。统一消费入口必须保留参考的构图、材质、空间/相机与动作机制；另写通用渲染器需给出相近内容、对应状态变化的真实动态并排对照。只保留配色/模块名或最终截图不算保真。普通图标/图片需要可替换载体；不能将素材槽省略后用色块代替。新增或修复模块还要放回本期上下文检查视觉重复。

## 每次新建和扩展的检查

1. 通过宿主检查并保留改前版本。扩展时查询本模板 `describe` 核对真实缺口；新建时先读取库规范与适用参考实现，建立本模板合同后再用 `describe` 检查其消费视图。
2. 在同一合同中实现完整片段，声明实际能力。关键词由用户稿与真实声音证据绑定，模型不手猜词时间；动作的最短完成时间与阅读停留保留。
3. 验证两套内容、容量与时长边界、所有承诺的素材/出镜/画幅、独立初始化、跳时/复播、语义事件与声音计划、实际有声完整渲染。未覆盖的模式保持未验证。
4. 证据必须关联当前源码、合同和输入字节，并保存真实预览及报告。修改相关依赖后重新验证；元数据迁移、成功渲染或像素变化均不能单独晋级。
5. 运行库拥有的准入检查，保存新工作回执：

```sh
python3 <skill>/scripts/check_consumer.py \
  --template /absolute/library/template \
  --modules changed-module-a,changed-module-b \
  --report /absolute/work/admission-r1.json
```

新模板省略 `--modules` 检查全部模块；扩展传本次新增和受影响模块。封装调用 `.opensay/opensay.py builder-check`，同一检查也可由其他 Agent 直接使用。缺规范、缺当前证据、`production_ready=false` 或执行失败均不能声明已投产，补齐后重跑；不通过时可以交回准确的预览或缺口状态。

## 状态与交回

- `structure_valid`：合同结构正确。
- `preview-verified`：有实际预览证据，可继续生成本期动态预览；不等于生产验收或用户批准。
- `builder-check.production_ready` 与 `evidence_current`：本次所选模块在承诺范围内的技术/视听测试与当前证据要求，由共享检查器验证；两者为真才可声明该模块范围已准入。模板测试可使用有标识且来源明确的代表素材，不要求未来每期私有素材提前存在。
- 本期 `compile/check-shot/render-film` 的 `production_ready` 另检查本期实际参数、素材、声音、事件与模板准入；模板准入通过不能替代本期输入就绪。缺少本期私有素材属于本期缺口，不倒推整个模板永远无法准入。
- 画面/听音自审与用户确认分别记录。准入检查不代表审美和语义已经由程序完全判定，也不代替本期正式预览确认。

交回当前模块 ID/版本/哈希、准入回执、真实缺口与本期同步动态画面，更新同一本期计划。回到 sticker 的完整正式动态预览同轮审核；不新增逐模块、样片或重复全片审批。

## 画面承载标注（2026-11-12 起必填）

每个模块在 `capability/consumer.v1.json` 声明 `visual_carriers`（`media/character/graphic/data/text` 的非空列表），依据是看实际渲染画面，定义和判断标准见库内 `.opensay/CONTRACT.md`「画面承载标注」。只有 `text` 的模块是全字片段，消费侧不能单独成镜——新做模块时应让画面主体由素材、角色、图形或数据承载。缺这个字段 `builder-check` 不通过。

## 跨镜头连续性与一键重验（2026-11-12）

- 模板有贯穿全片的角色时，在合同顶层声明 `"continuity":"protagonist"`，所有模块经同一入口画角色，无角色的模块由模板补旁观主角；规范见库内 `.opensay/CONTRACT.md`「跨镜头连续性」。参考实现：`character-theater/modules/protagonist.js`。
- 一个模板的所有模块共用一张源码图：改任何一个 `source_files` 里的文件，全部模块的证据都会失效。因此每个模板要维护一条重跑全部现行验证并重建证据的命令（参考 `character-theater/verification/reverify.sh`），改完源码立刻跑；不要留下大半模块处于 unverified 的库。重渲预览前先清掉旧预览，证据不能引用改动前的画面。

## 构图版式与用户审核（2026-11-12）

- 画面好不好看由用户判断，所以有真人出镜的模板要把常用构图做成固定版式模块（位置、大小、层次、动作写死，只开放内容槽），并声明 `"requires_user_review": true`。参考实现：`character-theater/modules/native-presets.js`、`presenter-rig.js`。
- 版式的验证预览必须用真实口播视频渲染（不能只用静态人像），并为每个版式至少准备两组不同内容。
- 交付时运行 `opensay.py review-page` 生成审核页交给用户；审核结果只能由用户本人给出，用 `opensay.py review` 记录用户原话。不得代填。
- 竖屏真人源在横屏模板里必须以人脸为中心裁切，全屏用清晰竖条加模糊铺底，不能把 9:16 直接铺满 16:9。

## 演示类模块与素材目录（2026-11-13）

- 模板在 `capability/usage-guide.v1.json` 声明 `demonstrates`（模块 → 能当场演示的效果，词表见 `.opensay/material-tags.json`）和 `plays_sounds`（会发声的模块）。口播说到某种效果时，消费侧要求使用这些模块或带对应标签的素材。
- 能放产品/品牌标识的模块要有 `logo` 种类的素材槽，便于口播提到产品时放 logo。
- 素材库交付时附 `catalog.json`：逐个看过画面后写 `shows`、`categories`、`demonstrates`，并交用户审核。
