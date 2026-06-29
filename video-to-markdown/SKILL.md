---
name: video-to-markdown
description: 将平台视频链接或分享文案转换为本地 Markdown 文案文档。支持抖音、哔哩哔哩、快手、微博、小红书。自动完成依赖检查、视频下载、音频提取、本地转录、AI 语义分段与文案修正，并将正文（纯文本）写入本地 output.md。无媒体上传、无截图。Use when the user asks to extract/transcribe a video's spoken content into a local Markdown file, such as 视频文案提取、视频转markdown、视频转文档、抖音/B站/快手/微博/小红书视频提取文案。
---

# Video To Markdown

## Core Rule

Always run the environment check before downloading or transcribing:

```bash
node scripts/video_to_markdown.js --step check
```

Tell the user the key results: dependency status, local transcription availability, and `TRANSCRIBE_CHUNK_SEC`.

转录使用本地 faster-whisper，首次运行会从 HuggingFace 下载模型（默认 `small`，约 480MB）。若网络受限：

- 设置镜像：`HF_ENDPOINT=https://hf-mirror.com`
- 或先把模型下到本地目录，再用 `WHISPER_MODEL=/path/to/model` 指向它（配合 `HF_HUB_OFFLINE=1` 完全离线）。例如：
  ```bash
  MODELDIR=/tmp/fw-small-model; mkdir -p $MODELDIR
  BASE=https://hf-mirror.com/Systran/faster-whisper-small/resolve/main
  for f in config.json model.bin tokenizer.json vocabulary.txt preprocessor_config.json; do
    curl -sL -o "$MODELDIR/$f" "$BASE/$f"
  done
  HF_HUB_OFFLINE=1 WHISPER_MODEL=$MODELDIR node scripts/video_to_markdown.js --step transcribe --work-dir "$WORK"
  ```


Use one `--work-dir` for every step in a run. Prefer an explicit task directory such as `/tmp/video_to_markdown_task`. The current task directory is kept after completion; old `/tmp/douyin_task_*` directories are cleaned only when a new download/full task starts unless `--no-cleanup-old` or `CLEAN_OLD_WORK_DIRS=0` is set.

## Workflow

1. 解析分享链接，识别平台 + 下载视频。
2. 提取音频（ffmpeg → 16kHz 单声道 mp3）。
3. 本地转录（faster-whisper / whisper），产出 `segments.json`。
4. 主 AI 读取 `segments.json`，语义分段并修正转录错误，写入 `paragraphs.json`。
5. 组装 `output.md`（H1 标题、每段 H2 摘要小标题、段落正文）。

Typical commands:

```bash
WORK=/tmp/video_to_markdown_task
node scripts/video_to_markdown.js --step check
node scripts/video_to_markdown.js --step download --url "<视频链接或分享文案>" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_markdown.js --step audio --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_markdown.js --step transcribe --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_markdown.js --step analyze --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_markdown.js --step write-paragraphs --file "$WORK/paragraphs.json" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_markdown.js --step write --title "视频标题" --work-dir "$WORK" --no-cleanup-old
```

`--full` is only an assisted flow. It pauses at semantic analysis when `paragraphs.json` does not yet exist.

After `write` completes, the final document is at `$WORK/output.md`. Read it and present the content (or path) to the user.

## Platform Strategy

- Douyin: use the bundled `scripts/douyin_video_parser.py` with multiple fallbacks.
- Kuaishou: resolve public share links and parse SSR state (`window.INIT_STATE` / `window.__APOLLO_STATE__`) to find the real video URL.
- Bilibili, Weibo, Xiaohongshu: use `yt-dlp`.
- Weibo: keep the original `video.weibo.com/show?...` URL for `yt-dlp`; do not replace it with the `h5.video.weibo.com` redirect.
- Short links: resolve redirects when it helps platform extractors, especially `b23.tv` and `xhslink.com`.
- Login-gated or private content may need `YTDLP_COOKIES=/path/to/cookies.txt` or `YTDLP_COOKIES_FROM_BROWSER=chrome`.

When adding a new platform, extend `detectPlatform()`, choose a downloader path, write `video_meta.json` with `platform`, `platform_key`, `title`, `author`, `duration`, `url`, and test with at least one public share link.

## Semantic Paragraphs

Create `paragraphs.json` as an array. Each item needs:

```json
{
  "start": 0,
  "end": 60,
  "text": "第一层意思。\n\n第二层意思。",
  "summary": "段落摘要"
}
```

Guidelines:

- Merge transcript segments by meaning, not by equal duration.
- Prefer 5-8 paragraphs for normal 5-15 minute videos.
- Correct obvious transcription mistakes (同音字、专有名词、错别字) while preserving meaning. Keep technical English terms in English.
- Put blank lines inside `text` when a section has multiple ideas; the script writes them as separate Markdown paragraphs.

## Bundled Resources

- `scripts/video_to_markdown.js`: main workflow script.
- `scripts/douyin_video_parser.py`: Douyin no-watermark parser/downloader used by the main script.
