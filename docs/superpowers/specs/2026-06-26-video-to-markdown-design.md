# Video To Markdown — 设计文档

## 目标

编写一个简单版本的 skill，将平台视频的口播文案提取为本地 Markdown 文档。相比
`video-to-feishu` / `video-to-joyspace`，去掉所有平台上传与截图逻辑，只产出本地
`.md` 文件。

六步流程：

1. 解析分享链接，识别平台
2. 下载视频
3. 提取音频（独立步骤）
4. 提取文案（转录）
5. AI 修正文案（语义分段 + 纠错）
6. 文案写入 Markdown 文档

## 位置与文件

新建独立目录 `video-to-markdown/`，从 `video-to-joyspace` 派生：

- `video-to-markdown/SKILL.md` — skill 说明
- `video-to-markdown/scripts/video_to_markdown.js` — 主脚本
- `video-to-markdown/scripts/douyin_video_parser.py` — 抖音无水印解析器（复制自现有 skill）

不包含 `references/`（无外部 API）和 `agents/`（不保留 OpenAI Whisper 回退）。

## 步骤与命令

| 步骤 | 命令 | 做什么 | 产物 |
|---|---|---|---|
| 1+2 解析+下载 | `--step download --url "<分享文案>"` | `extractFirstUrl` 提取链接 → `detectPlatform` 识别平台 → 对应下载器下载 | `video.*` + `video_meta.json` |
| 3 提取音频 | `--step audio` | ffmpeg 把视频抽成 16kHz 单声道 mp3 | `audio.mp3` |
| 4 提取文案 | `--step transcribe` | faster-whisper/whisper 吃 `audio.mp3` 转录（超长自动分块） | `segments.json` |
| 5 AI 修正文案 | `--step analyze` | 主 AI 读 `segments.json`，语义分段（5-10 段）+ 修正同音错别字/专名，写回 `paragraphs.json` | `paragraphs.json` |
| 6 写入 markdown | `--step write --title "标题"` | 组装 H1 标题 + H2 分段 + 段落正文，写本地文件 | `output.md` |

`--step write-paragraphs --file <path>` 保留为校验/写回工具步骤。

## 关键改造点（相对 video-to-joyspace）

- **拆分 `stepTranscribe`**：抽音频逻辑移到新 `stepAudio`（产出 `audio.mp3`）；
  `transcribe` 只吃 `audio.mp3`，若不存在则回退到直接从视频抽。
- **删除** `stepFrames`（截帧）、`stepPolish`（并入 analyze 提示）、
  `buildMarkdown` 中的视频/截图注释、所有 JoySpace MCP 说明。
- **删除** OpenAI Whisper 回退路径与相关环境变量提示，仅保留本地 faster-whisper /
  whisper；依赖检测 `stepCheck` 相应精简。
- **保留** 5 平台下载逻辑：抖音（parser）、B 站/微博/小红书（yt-dlp）、快手（SSR 解析）。
- `buildMarkdown` 仅产出纯文本：`# 标题` + 每段 `## 摘要` + 正文段落。
- 输出文件名改为 `output.md`（不再是 `final_markdown.md`）。

## 平台策略（沿用现有）

- Douyin：`scripts/douyin_video_parser.py` 多重回退。
- Kuaishou：解析公开分享链接的 SSR state（`window.INIT_STATE` / `window.__APOLLO_STATE__`）。
- Bilibili / Weibo / Xiaohongshu：`yt-dlp`。
- Weibo：保留原始 `video.weibo.com/show?...` URL。
- 短链：必要时解析重定向（`b23.tv`、`xhslink.com`）。
- 登录受限内容可用 `YTDLP_COOKIES` / `YTDLP_COOKIES_FROM_BROWSER`。

## 语义段落格式（沿用）

`paragraphs.json` 为数组，每项：

```json
{
  "start": 0,
  "end": 60,
  "text": "第一层意思。\n\n第二层意思。",
  "summary": "段落摘要"
}
```

注：本 skill 不截图，故 `screenshot_at` / `frame_path` 字段移除。

- 按语义合并转录片段，5-15 分钟视频建议 5-10 段。
- 修正明显的转录错误（同音字、专名、错别字），保持原意。
- `text` 内空行分隔多个意群，写入时作为独立 Markdown 段落。

## `--full` 流程

download → audio → transcribe → analyze（暂停等主 AI 写 `paragraphs.json`）→ write。
analyze 后若 `paragraphs.json` 不存在则暂停，提示主 AI 完成分段后继续 write。

## 依赖

- `ffmpeg` / `ffprobe`（音频抽取、分块、时长探测）
- `python3` + `faster_whisper`（首选）或 `whisper` CLI（次选）
- `yt-dlp`（非抖音平台下载）
- `python3`（抖音 parser）
