# Video To JoySpace — Design

**Date:** 2026-06-25
**Status:** Approved
**Reference skill:** `video-to-feishu`

## Goal

Produce a `video-to-joyspace` skill that mirrors `video-to-feishu`'s proven pipeline (download → transcribe → semantic paragraphs → screenshots) but writes plain-text content to JoySpace instead of Feishu. JoySpace has no REST API the script can call for media upload or block insertion, so the `write` step produces a local `final_markdown.md`, and the main AI publishes it to JoySpace via the MCP tool `create_doc_routing` (which uses the user's login session — no app accesskey/accesstoken needed in the script).

Image and video upload sections are **commented out** because JoySpace does not support uploading local media into documents.

## Non-Goals

- Direct script-to-JoySpace REST integration (no such API; MCP is the only write path).
- Editing/deleting existing JoySpace documents (delete is disallowed; edits require a new doc).
- Bitable/logging-equivalent record step (Feishu-specific; removed).

## Current State (pre-implementation)

| File | Status |
|------|--------|
| `SKILL.md` | ✅ written (104 lines) |
| `references/joyspace_api.md` | ✅ written (66 lines) |
| `agents/openai.yaml` | ✅ written |
| `scripts/douyin_video_parser.py` | ✅ copied (624 lines) |
| `scripts/video_to_joyspace.js` | ❌ **missing** — main script never written |

## Architecture

A single Node.js script `scripts/video_to_joyspace.js` with discrete steps invoked via `--step`:

```
check → download → transcribe → write-paragraphs → polish → frames → write
```

Mirrors `video-to-feishu.js` structure verbatim for the retained steps. Removed (Feishu-specific): `getFeishuToken`, `fetchWithRetry`, `writeMarkdown`, `addBlock`/`P`/`H1`/`H2`/`BR`/`parseBold`, `multipartBody`, `uploadMediaDirect`/`uploadMediaInParts`/`uploadMediaToBlock`, `IMG`, `FILE`, `transferDocOwner`, `stepLogToBitable`, `checkFeishuCredentials`, and the `log` step / `--full` bitable calls.

No JoySpace credentials, token, owner transfer, bitable, or media upload in the script.

## Components

### `stepWrite(paragraphsPath, title)` — the one rewritten step

1. Read `paragraphs.json`.
2. Build a Markdown string:
   - `# {title}\n\n`
   - For each paragraph: `## {summary || title || "段落 N"}\n\n{text || content}\n\n`
3. **Commented-out original-video upload** (replaces `FILE(...)`):
   ```js
   /* JoySpace 暂不支持上传本地视频到文档 — 原视频路径: {sourceVideoPath} */
   ```
4. **Commented-out per-paragraph screenshot upload** (replaces `IMG(...)`):
   ```js
   /* JoySpace 暂不支持上传图片到文档 — 截图: {p.frame_path} */
   ```
5. Write the string to `$WORK/final_markdown.md`, print the path, return it.

The script never contacts JoySpace. After `write`, the main AI reads `final_markdown.md` and calls MCP `create_doc_routing` (title + content), then reports `https://joyspace.jd.com/pages/{page_id}`.

### Local-file handling (extension for verification)

The feishu `download` step only handles platform URLs; a local file path falls through to yt-dlp, which cannot process it. Since verification uses a local desktop file, `stepDownload` gains a `local` path:

- `detectPlatform(input)`: existing platform regex checks (douyin/bilibili/kuaishou/weibo/xiaohongshu) evaluated first against the extracted URL — so platform share links are never misread as local files. Then, before the `other` fallback, if `fs.existsSync(input)` and it is a file → `{ key: 'local', label: '本地文件', url: input }`. (A platform URL like `https://...` never exists as a path, so the order is safe.)
- `stepDownload`: `key === 'local'` → copy file to `$WORK/video.mp4`, write `video_meta.json` (`{ platform: 'local', platform_key: 'local', title, author: '', duration, url }`), return the video path. Falls through to existing douyin/kuaishou/yt-dlp logic otherwise.

## Data Flow

```
video.mp4
  → (transcribe) segments.json
  → (AI)         paragraphs.json
  → (frames)     frames/*.jpg          ← generated & kept; not uploaded (commented)
  → (write)      final_markdown.md     ← script stops here
  → (main AI via MCP create_doc_routing) JoySpace doc URL
```

Screenshots remain in `$WORK/frames/` so they are ready to restore when JoySpace adds image upload support.

## Error Handling

Same posture as feishu:
- Missing dependencies (ffmpeg/whisper/yt-dlp/python) print guidance and exit non-zero.
- Missing `paragraphs.json` or video file → warn and exit.
- `write` has no network calls, so no retry logic (removes `fetchWithRetry`).
- Local-file copy failure → clear error + exit.

## Testing / Verification

Run the full pipeline on the local test video `/Users/lizhenhua.81/Desktop/主动添加好友.mp4`:

```bash
WORK=/tmp/video_to_joyspace_task
node scripts/video_to_joyspace.js --step check
node scripts/video_to_joyspace.js --step download --url "/Users/lizhenhua.81/Desktop/主动添加好友.mp4" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_joyspace.js --step transcribe --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_joyspace.js --step write-paragraphs --file "$WORK/paragraphs.json" --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_joyspace.js --step frames --work-dir "$WORK" --no-cleanup-old
node scripts/video_to_joyspace.js --step write --title "主动添加好友" --work-dir "$WORK" --no-cleanup-old
```

**Success criteria:**
- `download` copies the local file to `$WORK/video.mp4` and writes `video_meta.json` with `platform: 'local'`.
- `transcribe` produces `segments.json`.
- `write-paragraphs` (AI-assisted) produces `paragraphs.json`.
- `frames` produces `frames/*.jpg`.
- `write` produces `$WORK/final_markdown.md` containing: the H1 title, one H2 per paragraph with paragraph text, and the commented upload markers referencing the original video path and frame paths.

The script stops at `final_markdown.md`. Because the JoySpace MCP write path needs no credentials and was already verified working in this session (doc "测试", page `8wk6Zj46pmwZqk9sQ0Y5`), the live doc creation via `create_doc_routing` is an optional follow-on after the script-level verification passes — not a script responsibility.

## Open Items

None blocking. Future restoration of media upload is gated on JoySpace adding image/video block support; the commented sections and retained `frames/` output make that a localized change.
