# 片段契约（segment-v2）与 segment-kit

本层保留给 OpenSay / MotionGit 旧渲染器的源码与像素诊断。正式制作遵循[统一消费流程](consumer-workflow.md)，由共享消费工具检查并渲染；探测与 resolve 不是完整制作引擎。

## 权责

| 类别 | 例子 | 只用模板 | sticker + 模板 |
| --- | --- | --- | --- |
| 政策 | 变化率下限、死静上限、片段唯一性、字幕安全带 | 无 | 引擎独占，声明改不了 |
| 事实 | states 切点、settle 秒数、能否吃图片/视频、底部占用 | 声明为准 | 以实测为准；声明作待验清单，核对通过才采纳 |
| 语义 | name / expresses / source_reference | 声明为准 | 声明优先（测不出来） |
| 渲染入口 | renderAt / entry.py / video | 声明为准 | 自动识别，识别不了 fail closed |

## 目录

```
~/.codex/skills/sticker/scripts/segment-kit/
├── VERSION                  contract-1
├── schema/segment-v2.schema.json
├── adapt/html-seek.mjs      适配器：静态服务 + 逐帧取样（只回传标量）
├── analyse/static.mjs       静态解析：源码动作常量 → 精确切点候选
├── probe/probe.mjs          探针：候选 → 渲帧验证 → 事实表
├── resolve/resolve.mjs      事实 + 声明 + 政策 → resolved contract + 账单
├── compose/ export/ plan/ validate/   （旧占位目录，不作为生产能力）
└── config/
```

缓存：`$XDG_CACHE_HOME/opensay/` 或 `segment-kit/.cache/`，键 `模板 id + 渲染器 sha256`，可删可重建。

## 命令

```bash
# 1) 探测（模板没声明、或想复核声明时）
node scripts/segment-kit/probe/probe.mjs \
  --template /path/to/template \
  --entry "modules/index.html?m={id}&t=0&d={d}&data=%7B%22chrome%22%3Afalse%7D" \
  --max-seconds 9 --params-from modules/module-catalog.json \
  --out .cache/<tpl>.probe.json

# 2) 合并声明 + 政策
node scripts/segment-kit/resolve/resolve.mjs \
  --probe .cache/<tpl>.probe.json \
  --declaration /path/to/template/capability/segments.v2.json \
  --out .cache/<tpl>.resolved.json --report .cache/<tpl>.report.json
```

`probe` 的 `--entry` 是模板的渲染入口模板串，`{id}` 与 `{d}` 会被替换。

## 模板侧（可选，但建议）

```
<template>/capability/
├── segments.v2.json      # 给“只用模板”的人排片用
└── CONTRACT.md
<template>/capability.json → "segment_contract": { "path": "capability/segments.v2.json", ... }
```

声明里的 `rendererSha256` 必须与模板当前渲染器一致；不一致或 `contractVersion` 不匹配时，引擎不再参考它，直接全量探测。

## 失败语义

- 找不到渲染器入口 → `TEMPLATE_NOT_COMPOSABLE`，不出片。
- 声明承诺了渲染器没实现的能力 → 判 `declared-but-unsupported`，按不支持处理。
- 探测确认度 `low`（0 个切点）→ 该片段只能做短镜或素材镜，规划器需避开。

## 实测范围与制作状态

源码中的 img/video 调用只生成 `assetSlotCandidates`，不能证明某个模块实际消费素材，也不能由未探测到源码字符串断言不支持。`assetSlots` 只接受逐模块素材渲染已验证的事实，旧纯源码探测报告保持 `assetSlotsVerified=false`。正式能力以统一消费合同及当前素材测试证据为准。

resolve 实际检查源码变化点之间的间隔，超出政策上限返回 `needs-review`、非零退出及具体 gap；不再只在 `policyApplied` 字符串中声称已应用。该结果只用于发现长空档，真实语义节奏、合法阅读停留和镜内事件由共享编译/检查与实际审片判断。`production_ready=false` 时不得把探测成功当作制作已就绪。

即使探测的变化间隔和素材检查都通过，本诊断工具仍返回 `production_ready=false`；正式制作就绪只能由共享消费合同检查、当前验证证据和实际本期执行共同判定。
