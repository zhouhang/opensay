# Sticker 声音入口

## 两种制作模式

| 用户给的 | 路线 | 成片 |
|---|---|---|
| 真人口播音频，或真人口播视频但不需要真人出镜 | 只用声音 | 不出现真人，只用不需要真人的模块 |
| 真人出镜口播视频 | 声音加真人画面 | 用模板里支持真人出镜的模块 |

只有文案、没有声音时不开工：说明需要真人口播音频或视频，然后等用户提供，不合成语音。

## 对齐

在模板库根目录运行：

```bash
python3 .opensay/opensay.py start <口播文件> [--script <文案文件>]
```

它会：

- 把声音转成统一格式；把帧率不稳、高于 30fps 或不是从 0 开始的视频规整成 30fps 副本，并把声音对到画面时钟上；
- 做词级对齐，生成 `voice/voice_timeline.json`；
- 新建项目目录和分镜骨架。

需要的环境（`python3 .opensay/opensay.py doctor` 会逐项检查）：

- Python 3.10+；
- Node.js 22+；
- ffmpeg 和 ffprobe；
- whisper.cpp 的 `whisper-cli`，以及模型 `ggml-large-v3-turbo.bin`（放在 `~/.cache/whisper.cpp/`，或者设环境变量 `OPENSAY_WHISPER_MODEL` 指向它）。

缺什么，先征得用户同意再安装。

## 有文案时

- 给了文案，文案里的写法就是专有名词的正确写法，对齐时以它为准。
- 实际说的和文案不一样时，以录音为准，并告诉用户哪里不同，不改用户的文案。

## 识别错误

专有名词被听错（例如 OpenSay 被听成 OpenSea）时，运行：

```bash
python3 .opensay/opensay.py retext --project <项目> --replace 错词=正词
```

可以写多个 `--replace`，不需要重新识别。拿不准正确写法时问用户，不要猜。改完时间轴，之前编译的分镜都作废，要重新跑 `storyboard`。

## 字幕文件

需要单独的 SRT 时，用本技能的 `scripts/timeline_to_srt.py` 从 `voice/voice_timeline.json` 转换，核对句子顺序、没有重叠、总时长和音频一致。
