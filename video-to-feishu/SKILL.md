---
name: video-to-feishu
description: 将平台视频链接或分享文案转换为飞书文档。支持抖音、哔哩哔哩、快手、微博、小红书，并为未来新增平台保留扩展点。自动完成依赖检查、视频下载、本地转录、AI 语义分段、精准截帧、原视频上传到文档开头、正文与截图写入飞书文档、可选记录到飞书多维表格。Use when the user asks to convert/download/transcribe/summarize a video into a Feishu/Lark document, such as 视频转飞书、平台视频转文档、抖音/B站/快手/微博/小红书转飞书、视频提取文案并写入飞书。
---

# Video To Feishu

## Core Rule

Always run the environment check before downloading or transcribing:

```bash
node scripts/video_to_feishu.js --step check
```

Tell the user the key results: dependency status, Feishu credential status, local transcription availability, `TRANSCRIBE_CHUNK_SEC`, and whether Bitable logging is configured.

Use one `--work-dir` for every step in a run. Prefer `/tmp/douyin_task_YYYYMMDDHHMMSS` or an explicit task directory such as `/tmp/video_to_feishu_weibo`. The current task directory is kept after completion; old `/tmp/douyin_task_*` directories are cleaned only when a new download/full task starts unless `--no-cleanup-old` or `CLEAN_OLD_WORK_DIRS=0` is set.

## Workflow

1. Check dependencies and credentials.
2. Download the video.
3. Transcribe with local `faster-whisper`/`whisper`, falling back to OpenAI Whisper only when configured.
4. Read `segments.json` and create semantic `paragraphs.json`.
5. Extract one screenshot per semantic paragraph.
6. Write the Feishu doc: H1 title, original video file block at the beginning, then H2 sections, semantic paragraphs, and screenshots.
7. Record to Bitable when `BITABLE_APP_TOKEN` and `BITABLE_TABLE_ID` are configured.

Typical commands:

```bash
WORK=/tmp/video_to_feishu_task
node scripts/video_to_feishu.js --step check
node scripts/video_to_feishu.js --step download --url "<视频链接或分享文案>" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_feishu.js --step transcribe --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_feishu.js --step write-paragraphs --file "$WORK/paragraphs.json" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_feishu.js --step frames --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_feishu.js --step write --title "视频标题" --work-dir "$WORK" --no-cleanup-old
```

`--full` is only an assisted flow. It pauses at semantic analysis when `paragraphs.json` does not yet exist.

## Platform Strategy

- Douyin: use the bundled `scripts/douyin_parser.py` with multiple fallbacks.
- Kuaishou: resolve public share links and parse SSR state (`window.INIT_STATE` / `window.__APOLLO_STATE__`) to find the real File Block/video URL.
- Bilibili, Weibo, Xiaohongshu: use `yt-dlp`.
- Weibo: keep the original `video.weibo.com/show?...` URL for `yt-dlp`; do not replace it with the `h5.video.weibo.com` redirect, which can be unsupported.
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
  "summary": "段落摘要",
  "screenshot_at": 30
}
```

Guidelines:

- Merge transcript segments by meaning, not by equal duration.
- Prefer 5-10 paragraphs for normal 5-15 minute videos.
- Correct obvious transcription mistakes while preserving meaning.
- Put blank lines inside `text` when a section has multiple ideas; the script writes them as separate Feishu paragraphs.
- Pick screenshot times inside the paragraph, avoiding the first or last few seconds when possible.

## Feishu Notes

Run auth verification when credentials are uncertain:

```bash
node scripts/check_feishu_auth.js
```

This only validates token by default. Add `--create-test-doc` only when a real permission test document is acceptable.

For file/video insertion, use the real File Block ID. Feishu may create a `block_type: 33` View wrapper and nest the actual `block_type: 23` File Block under it. Upload and `replace_file` must target the nested File Block, not the wrapper. See `references/feishu_api.md` for the exact API sequence.

If owner transfer appears wrong, inspect Feishu UI and permissions. The script grants/tries owner transfer with `FEISHU_MEMBER_OPENID`; API responses can show `full_access` even when UI ownership differs.

## Bundled Resources

- `scripts/video_to_feishu.js`: main workflow script.
- `scripts/check_feishu_auth.js`: Feishu credential checker.
- `scripts/douyin_parser.py`: Douyin no-watermark parser/downloader used by the main script.
- `references/feishu_api.md`: Feishu Docx/image/file upload reference and gotchas.
