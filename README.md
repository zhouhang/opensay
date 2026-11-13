# OpenSay

OpenSay 是一个口播视频模板库：把一段真人口播的音频或视频交给你的 agent，它会照着模板规范逐镜编排画面，渲染出成片。即使是能力一般的模型，按规范也能做出成片。

## 云端曲库 `bgm/`

`bgm/index.json` 列出了每首曲目的时长、大小、sha256 和下载地址。做片时，agent 会按文案情绪和片长挑选曲目，只下载用到的那一首，并用 sha256 核对文件。用户自己提供的音乐优先使用。

## 模板包 `template/`

| 模板 | 文件 | 说明 |
|---|---|---|
| 开放表达 | [`template/开放表达.opensay`](template/开放表达.opensay) | 横屏 16:9；35 个模块；支持真人出镜口播，也能只用口播音频做不出镜的片子 |

### 怎么用

1. 下载 `.opensay` 文件，不用解压。
2. 把它和你的口播视频（或口播音频）一起交给你的 agent（Claude Code、Codex、WorkBuddy 等能执行命令的都行），说一句"用这个模板把我的口播做成视频"。
3. agent 会按文件开头的说明自己解包、检查环境（缺什么会先问你要不要装）、逐镜编排并渲染出片。

需要的环境：Python 3.10+、Node.js 22+、ffmpeg、whisper.cpp（`whisper-cli` 加 `ggml-large-v3-turbo` 模型）。第一次渲染时会自动下载浏览器内核。

### 开放表达 · 部分模块预览

| | | |
|---|---|---|
| ![问题卡](docs/previews/问题卡.gif)<br>问题卡 | ![因果链](docs/previews/因果链.gif)<br>因果链 | ![柱状对比](docs/previews/柱状对比.gif)<br>柱状对比 |
| ![真人换位](docs/previews/真人换位.gif)<br>真人换位 | ![物件卡](docs/previews/物件卡.gif)<br>物件卡加 logo | ![浏览器演示](docs/previews/浏览器演示.gif)<br>浏览器演示 |
