# Video To Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a simplified skill `video-to-markdown` that extracts a video's spoken transcript into a local Markdown file, derived from `video-to-joyspace` with all upload/screenshot/OpenAI logic removed.

**Architecture:** A single Node.js workflow script (`video_to_markdown.js`) runs in steps sharing one `--work-dir`. Steps: download (parses link + detects platform + downloads) → audio (ffmpeg extracts mp3) → transcribe (local whisper → segments.json) → analyze (main AI writes paragraphs.json) → write (assembles output.md). Douyin downloads use a bundled Python parser; other platforms use yt-dlp.

**Tech Stack:** Node.js (≥18), Python 3 + `requests` + `faster_whisper`, `ffmpeg`/`ffprobe`, `yt-dlp`.

## Global Constraints

- Skill directory: `video-to-markdown/` at repo root (`/Users/lizhenhua.81/GithubStudy/my-skills`).
- Local transcription only — NO OpenAI Whisper fallback, NO `OPENAI_API_KEY`, NO `agents/` directory.
- NO screenshot/frames logic, NO media upload, NO JoySpace/Feishu API or MCP references.
- Output file is `output.md` (not `final_markdown.md`).
- The `audio` extraction is its own step producing `audio.mp3`.
- Support 5 platforms: Douyin (bundled parser), Kuaishou (SSR parse), Bilibili/Weibo/Xiaohongshu (yt-dlp). Reuse existing platform logic verbatim.
- All user-facing strings say "Markdown 文档" / the script name `video_to_markdown.js`, never "JoySpace" or "飞书".
- `paragraphs.json` items have fields `start`, `end`, `text`, `summary` only — NO `screenshot_at` / `frame_path`.

---

## Source Reference

The source script is `video-to-joyspace/scripts/video_to_joyspace.js` (1762 lines). Most of it is copied verbatim; this plan specifies only what changes. Line numbers below refer to the **source** file.

Functions copied **verbatim** (no change beyond the global find/replace in Task 2): `getArg`, `hasFlag`, `loadDotEnv`, `parsePositiveIntOrNull`, `persistTranscribeChunkSecToEnvFile`, `findLatestWorkDir`, `extractFirstUrl`, `detectPlatform`, `ytdlpBaseArgs`, `resolveRedirectUrl`, `normalizePlatformUrl`, `commandExists`, `pythonModuleExists`, `formatCmd`, `runFile`, `fmtTime`, `cleanupOldWorkDirs`, `stepDownload`, `stepDownloadDouyin`, `parseYtDlpJson`, `findDownloadedVideo`, `fetchTextWithUa`, `extractJsonAssignment`, `extractKuaishouState`, `findKuaishouPhoto`, `pickKuaishouVideoUrl`, `normalizeKuaishouTitle`, `downloadUrlToFile`, `stepDownloadKuaishou`, `stepDownloadWithYtDlp`, `stepWriteParagraphs` (minus screenshot defaults).

Functions **removed**: `resolveFramesDir`, `stepFrames`, `stepPolish`.

Functions **modified**: constants block, `checkDependencies`, `stepCheck`, `stepTranscribe` (split), `stepAnalyze`, `stepWriteParagraphs` (drop `screenshot_at`), `buildMarkdown`, `stepWrite`, `main`, help text.

Functions **added**: `stepAudio`.

---

## File Structure

- `video-to-markdown/SKILL.md` — skill frontmatter + usage (Task 7)
- `video-to-markdown/scripts/video_to_markdown.js` — main workflow script (Tasks 2-6)
- `video-to-markdown/scripts/douyin_video_parser.py` — copied verbatim (Task 1)

---

### Task 1: Scaffold directory and copy source files

**Files:**
- Create: `video-to-markdown/scripts/video_to_markdown.js` (copy of source)
- Create: `video-to-markdown/scripts/douyin_video_parser.py` (verbatim copy)

- [ ] **Step 1: Create directories and copy files**

```bash
cd /Users/lizhenhua.81/GithubStudy/my-skills
mkdir -p video-to-markdown/scripts
cp video-to-joyspace/scripts/douyin_video_parser.py video-to-markdown/scripts/douyin_video_parser.py
cp video-to-joyspace/scripts/video_to_joyspace.js   video-to-markdown/scripts/video_to_markdown.js
```

- [ ] **Step 2: Verify the douyin parser is byte-identical**

Run: `diff video-to-joyspace/scripts/douyin_video_parser.py video-to-markdown/scripts/douyin_video_parser.py && echo SAME`
Expected: `SAME`

- [ ] **Step 3: Verify the copied script is syntactically valid**

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add video-to-markdown/scripts/douyin_video_parser.py video-to-markdown/scripts/video_to_markdown.js
git commit -m "Scaffold video-to-markdown from video-to-joyspace copy"
```

---

### Task 2: Rename script identity and strip OpenAI from constants

**Files:**
- Modify: `video-to-markdown/scripts/video_to_markdown.js` (header comment lines 1-27, constants `OPENAI_KEY` line 70)

**Interfaces:**
- Produces: removes the `OPENAI_KEY` constant so later tasks must not reference it.

- [ ] **Step 1: Replace the header comment block (source lines 1-27)**

Replace the entire opening comment (lines 2-27, between `#!/usr/bin/env node` and `const { execFileSync }`) with:

```js
/**
 * 多平台视频 → 本地 Markdown 文案 核心脚本
 *
 * 派生自 video_to_joyspace.js，移除媒体上传 / 截帧 / JoySpace MCP / OpenAI 回退逻辑。
 * 仅本地转录（faster-whisper / whisper）。write 步骤组装纯文本 output.md。
 *
 * 整体流程：
 *   check → download → audio → transcribe → analyze(AI) → write
 *
 * 用法（分步，必须用同一 --work-dir 共享中间文件）：
 *   WORK=/tmp/video_to_markdown_task
 *   node scripts/video_to_markdown.js --step check
 *   node scripts/video_to_markdown.js --step download --url "<链接或分享文案>" --work-dir $WORK
 *   node scripts/video_to_markdown.js --step audio                              --work-dir $WORK
 *   node scripts/video_to_markdown.js --step transcribe                         --work-dir $WORK
 *   node scripts/video_to_markdown.js --step analyze                            --work-dir $WORK
 *   node scripts/video_to_markdown.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK
 *   node scripts/video_to_markdown.js --step write      --title "标题"          --work-dir $WORK
 *
 * 可选配置：
 *   YTDLP_COOKIES            yt-dlp cookies.txt 路径
 *   YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
 *   TRANSCRIBE_CHUNK_SEC     转录分段阈值（秒，默认 600）
 */
```

- [ ] **Step 2: Delete the OPENAI_KEY constant (source line 70)**

Delete this line entirely:

```js
const OPENAI_KEY    = process.env.OPENAI_API_KEY || dotenv.OPENAI_API_KEY;
```

- [ ] **Step 3: Add AUDIO_PATH constant next to the other path constants**

After the line `const VIDEO_PATH    = getArg('--video',        path.join(WORK_DIR, 'video.mp4'));` (source line 141), add:

```js
const AUDIO_PATH    = getArg('--audio',        path.join(WORK_DIR, 'audio.mp3'));
```

- [ ] **Step 4: Verify no OPENAI references remain in the constants region**

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK` (syntax still valid; `OPENAI_KEY` usages elsewhere are removed in Tasks 3-4)

- [ ] **Step 5: Commit**

```bash
git add video-to-markdown/scripts/video_to_markdown.js
git commit -m "Rebrand header, drop OPENAI_KEY, add AUDIO_PATH constant"
```

---

### Task 3: Strip OpenAI from dependency check and stepCheck

**Files:**
- Modify: `video-to-markdown/scripts/video_to_markdown.js` (`checkDependencies` source lines 379-435, `stepCheck` source lines 511-558)

**Interfaces:**
- Consumes: nothing new.
- Produces: `checkDependencies(strict)` and `stepCheck()` keep their signatures; behavior no longer references OpenAI.

- [ ] **Step 1: Replace the transcription-dependency branch in `checkDependencies`**

Replace source lines 379-396 (the block from `// ── 转录依赖（二选一）` through its closing `}`) with:

```js
  // ── 转录依赖（本地，二选一）────────────────────────
  const hasFasterWhisper = commandExists('python3') && pythonModuleExists('faster_whisper');
  const hasLocalWhisper = commandExists('whisper');

  if (hasFasterWhisper) {
    console.log('  ✅ faster-whisper（本地）  已安装');
  } else if (hasLocalWhisper) {
    const v = (() => { try { return execFileSync('whisper', ['--version'], { stdio: 'pipe' }).toString().trim().split('\n')[0]; } catch { return ''; } })();
    console.log(`  ⚠️  faster-whisper 未安装，检测到 whisper（本地）  ${v}`);
    optional.push('faster-whisper');
  } else {
    missing.push('faster-whisper（本地）');
    console.log('  ❌ faster-whisper  未安装');
  }
```

- [ ] **Step 2: Fix the faster-whisper install hint (source lines 430-435)**

Replace those lines (the `if (missing.some(m => m.startsWith('faster-whisper')))` block) with:

```js
    if (missing.some(m => m.startsWith('faster-whisper'))) {
      console.log('  【faster-whisper】本地语音转文字（推荐）');
      console.log('    pip3 install faster-whisper\n');
    }
```

- [ ] **Step 3: Replace the OpenAI status section in `stepCheck` (source lines 515-520)**

Delete the block:

```js
  console.log('\n── OpenAI 配置状态 ──');
  if (OPENAI_KEY) {
    console.log(`  ✅ OPENAI_API_KEY    已配置（${OPENAI_KEY.substring(0, 6)}****）`);
  } else {
    console.log('  ℹ️  OPENAI_API_KEY    未配置（本地 whisper 可用时不需要）');
  }
```

(Remove it entirely — the next line `// 显示当前分段时长配置` follows directly.)

- [ ] **Step 4: Run the environment check end-to-end**

Run: `node video-to-markdown/scripts/video_to_markdown.js --step check`
Expected: prints dependency results and 分段时长配置 with NO mention of OpenAI; exits 0 if ffmpeg + a whisper backend are present (or lists missing deps without OpenAI).

- [ ] **Step 5: Verify no OpenAI strings survive in check paths**

Run: `grep -n -i "openai\|OPENAI_KEY" video-to-markdown/scripts/video_to_markdown.js | grep -vE "131[0-9]|13[2-4][0-9]|116[0-9]|117[0-9]|118[0-9]|119[0-9]|120[0-9]|121[0-9]"` — this is informational; full removal is verified in Task 4. For now just confirm `stepCheck`/`checkDependencies` regions are clean.

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add video-to-markdown/scripts/video_to_markdown.js
git commit -m "Strip OpenAI from dependency check and stepCheck"
```

---

### Task 4: Split audio extraction into stepAudio; strip OpenAI from transcribe

**Files:**
- Modify: `video-to-markdown/scripts/video_to_markdown.js` (`stepTranscribe` source lines 993-1369)

**Interfaces:**
- Produces:
  - `async function stepAudio(videoPath)` → extracts 16kHz mono mp3 to `AUDIO_PATH`, returns the audio path. Idempotent (skips if exists and `--force` not passed; always overwrites for simplicity here).
  - `async function stepTranscribe(audioPath)` → now takes the **audio** path (default `AUDIO_PATH`), produces `segments.json`. If the audio file is missing, it calls `stepAudio` is NOT automatic — instead it errors telling the user to run `--step audio` first. (Keeps steps explicit per the 6-step design.)

- [ ] **Step 1: Add `stepAudio` immediately before `stepTranscribe`**

Insert this new function just above `async function stepTranscribe(` (source line 993):

```js
// ══════════════════════════════════════
//  STEP 2: 提取音频（ffmpeg → 16kHz 单声道 mp3）
// ══════════════════════════════════════
async function stepAudio(videoPath) {
  console.log('\n🎵 [Step 2] 提取音频（16kHz 单声道 mp3）...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }
  if (!fs.existsSync(videoPath)) {
    console.error(`❌ 未找到视频文件：${videoPath}，请先运行 --step download`);
    process.exit(1);
  }

  runFile('ffmpeg', ['-y', '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', AUDIO_PATH]);
  console.log('✅ 音频提取完成:', AUDIO_PATH);
  return AUDIO_PATH;
}
```

- [ ] **Step 2: Change the `stepTranscribe` signature and remove its inline audio extraction**

Source lines 993-1005 currently read:

```js
async function stepTranscribe(videoPath) {
  console.log('\n🎙️ [Step 2] 提取音频 + 带时间戳转录...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }

  const audioPath = videoPath.replace(/\.[^.]+$/, '.mp3');
  runFile('ffmpeg', ['-y', '-i', videoPath, '-ar', '16000', '-ac', '1', '-b:a', '64k', audioPath]);
  console.log('✅ 音频提取完成:', audioPath);
```

Replace that span with:

```js
async function stepTranscribe(audioPath) {
  console.log('\n🎙️ [Step 3] 带时间戳转录...');

  if (!commandExists('ffmpeg')) {
    console.error('❌ ffmpeg 未安装！');
    console.error('   macOS：  brew install ffmpeg');
    console.error('   Ubuntu： sudo apt install ffmpeg');
    process.exit(1);
  }
  if (!fs.existsSync(audioPath)) {
    console.error(`❌ 未找到音频文件：${audioPath}，请先运行 --step audio`);
    process.exit(1);
  }
```

(Everything after this point already uses the local variable `audioPath`, which is now the parameter — no further change to the chunking logic.)

- [ ] **Step 3: Remove the chunked OpenAI fallback block (source lines 1161-1222)**

Delete the entire block starting at the comment `// ── 分段转录：OpenAI Whisper API ──` (source line 1161) through the closing `}` of that `if (segments.length === 0 && OPENAI_KEY) { ... }` (source line ~1222, the line after the `console.log(\`✅ OpenAI chunked 转录合并完成...`)`). The preceding faster-whisper chunk branch and the following non-chunk path remain.

- [ ] **Step 4: Remove the whisper-CLI catch's OpenAI mention (source line 1298)**

Change:

```js
        console.warn('⚠️  本地 whisper 失败，准备尝试 OpenAI Whisper API：', e.message);
```

to:

```js
        console.warn('⚠️  本地 whisper 转录失败：', e.message);
```

- [ ] **Step 5: Remove the final OpenAI fallback block (source lines 1302-1341)**

Delete the entire block from the comment `// 最终回退：OpenAI Whisper API` (source line 1302) through the closing `}` after `console.log(\`✅ API 转录完成...`)` (source line 1341).

- [ ] **Step 6: Simplify the "transcription failed" message (source lines 1344-1362)**

Replace the `if (segments.length === 0) { ... }` block with:

```js
  if (segments.length === 0) {
    console.error(`
❌ 转录失败：本地 faster-whisper/whisper 不可用

请安装 faster-whisper（推荐，无需联网）：
  pip3 install faster-whisper

安装完成后重新运行：
  node video_to_markdown.js --step transcribe --work-dir <WORK_DIR>
`);
    process.exit(1);
  }
```

- [ ] **Step 7: Verify all OpenAI references are gone**

Run: `grep -c -i "openai" video-to-markdown/scripts/video_to_markdown.js; echo "exit=$?"`
Expected: `0` (grep prints 0 and exits 1 when no match — either way, zero matches is the requirement). Confirm output count is `0`.

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK`

- [ ] **Step 8: Commit**

```bash
git add video-to-markdown/scripts/video_to_markdown.js
git commit -m "Split stepAudio out of transcribe; remove all OpenAI fallbacks"
```

---

### Task 5: Remove frames/polish; drop screenshot fields from analyze/write-paragraphs

**Files:**
- Modify: `video-to-markdown/scripts/video_to_markdown.js` (`resolveFramesDir` ~209-218, `stepAnalyze` 1383-1419, `stepWriteParagraphs` 1485-1496, `stepFrames` 1553-1596, `stepPolish` 1515-1550)

**Interfaces:**
- Consumes: `paragraphs.json` from analyze.
- Produces: `paragraphs.json` items have ONLY `start`, `end`, `text`, `summary`. No `screenshot_at`, no `frame_path`.

- [ ] **Step 1: Delete `resolveFramesDir` (source lines 206-218)**

Delete the whole function including its doc comment:

```js
/**
 * 获取 frames 目录路径（与 resolveParagraphsPath 联动）
 */
function resolveFramesDir(paragraphsPath) {
  ...
  return path.join(path.dirname(paragraphsPath), 'frames');
}
```

- [ ] **Step 2: Update the `stepAnalyze` main-AI task text (source lines 1395-1403)**

Replace the task instruction block with (note: 5~8 段, no screenshot decision):

```js
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 主 AI 任务：
   1. 阅读以上转录文本，按语义划分段落（建议 5~8 段）
   2. 修正 Whisper 转录错误（同音字、专有名词、明显错别字），保持原意
   3. 为每段写摘要（10~20 字）作为小标题
   4. 直接将 paragraphs.json 写入 ${PARAGRAPHS_PATH}
      每项格式：{ "start": 秒, "end": 秒, "text": "正文", "summary": "摘要" }
   ⚠️ 注意：后续 write 步骤会自动关联到此工作目录
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
```

- [ ] **Step 3: Remove the screenshot reference in `stepAnalyze`'s confirmation print (source line 1411)**

Change:

```js
        console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | 截图@${fmtTime(p.screenshot_at)} | ${p.summary || p.title || ''}`);
```

to:

```js
        console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | ${p.summary || p.title || ''}`);
```

- [ ] **Step 4: Remove screenshot defaulting + print in `stepWriteParagraphs` (source lines 1485-1496)**

Replace the validation loop and the final print loop:

```js
  for (const p of paragraphs) {
    if (typeof p.screenshot_at !== 'number' || p.screenshot_at < p.start || p.screenshot_at > p.end) {
      p.screenshot_at = parseFloat((p.start + (p.end - p.start) * 0.6).toFixed(1));
    }
    p.screenshot_at = parseFloat(p.screenshot_at.toFixed(1));
  }
  fs.mkdirSync(path.dirname(PARAGRAPHS_PATH), { recursive: true });
  fs.writeFileSync(PARAGRAPHS_PATH, JSON.stringify(paragraphs, null, 2), 'utf-8');
  console.log(`✅ paragraphs.json 已写入 ${PARAGRAPHS_PATH}，共 ${paragraphs.length} 段`);
  paragraphs.forEach((p, i) => {
    console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | 截图@${fmtTime(p.screenshot_at)} | ${p.summary || p.title || ''}`);
  });
```

with:

```js
  fs.mkdirSync(path.dirname(PARAGRAPHS_PATH), { recursive: true });
  fs.writeFileSync(PARAGRAPHS_PATH, JSON.stringify(paragraphs, null, 2), 'utf-8');
  console.log(`✅ paragraphs.json 已写入 ${PARAGRAPHS_PATH}，共 ${paragraphs.length} 段`);
  paragraphs.forEach((p, i) => {
    console.log(`  [${i + 1}] ${fmtTime(p.start)}~${fmtTime(p.end)} | ${p.summary || p.title || ''}`);
  });
```

- [ ] **Step 5: Delete `stepPolish` entirely (source lines 1499-1550)**

Delete from the `// STEP 4.5: AI 文字优化` banner comment through the end of `stepPolish` (its `return paragraphs; }`).

- [ ] **Step 6: Delete `stepFrames` entirely (source lines 1553-1596)**

Delete from the `async function stepFrames(` line through its closing `return results; }`, including the `// STEP 5: 组装 ...` banner that immediately follows is KEPT (it precedes `buildMarkdown`). Delete only the frames function and its preceding banner if present.

- [ ] **Step 7: Verify**

Run: `grep -c -i "screenshot_at\|frame_path\|stepFrames\|stepPolish\|resolveFramesDir" video-to-markdown/scripts/video_to_markdown.js`
Expected: `0`

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK`

- [ ] **Step 8: Commit**

```bash
git add video-to-markdown/scripts/video_to_markdown.js
git commit -m "Remove frames/polish steps and screenshot fields"
```

---

### Task 6: Rewrite buildMarkdown/stepWrite and main() dispatch + help

**Files:**
- Modify: `video-to-markdown/scripts/video_to_markdown.js` (`buildMarkdown` 1605-1625, `stepWrite` 1627-1641, `main` 1647-1759)

**Interfaces:**
- Consumes: `stepAudio`, `stepTranscribe`, `stepAnalyze`, `stepWriteParagraphs`, `stepWrite`.
- Produces: `main()` dispatch for steps `check|download|audio|transcribe|analyze|write-paragraphs|write` and `--full`.

- [ ] **Step 1: Replace `buildMarkdown` (source lines 1601-1625)**

Replace the function and its doc comment with:

```js
// ══════════════════════════════════════
//  STEP 5: 组装 output.md
// ══════════════════════════════════════
/**
 * 将 paragraphs.json 组装为纯文本 Markdown：H1 标题 + 每段 H2 摘要小标题 + 正文。
 */
function buildMarkdown(paragraphs, title) {
  let md = `# ${title}\n\n`;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const sectionTitle = (p.summary && p.summary.trim())
      || (p.title && p.title.trim())
      || `段落 ${i + 1}`;
    const sectionBody = (p.text || p.content || '').trim();
    md += `## ${sectionTitle}\n\n${sectionBody}\n\n`;
  }
  return md;
}
```

- [ ] **Step 2: Replace `stepWrite` (source lines 1627-1641)**

```js
async function stepWrite(paragraphsPath, title) {
  console.log('\n📝 [Step 5] 组装 output.md ...');

  const paragraphs = JSON.parse(fs.readFileSync(paragraphsPath, 'utf-8'));
  console.log(`  段落数：${paragraphs.length}`);

  const md = buildMarkdown(paragraphs, title);
  const outPath = path.join(WORK_DIR, 'output.md');
  fs.writeFileSync(outPath, md, 'utf-8');

  console.log(`  ✅ 已生成: ${outPath}`);
  return outPath;
}
```

- [ ] **Step 3: Replace the `--full`/`all` branch in `main` (source lines 1656-1673)**

```js
  if (IS_FULL || STEP === 'all') {
    checkDependencies(true);
    const videoPath   = await stepDownload(DOUYIN_URL);
    const audioPath   = await stepAudio(videoPath);
    const _segments   = await stepTranscribe(audioPath);
    await stepAnalyze(SEGMENTS_PATH);
    if (fs.existsSync(PARAGRAPHS_PATH)) {
      const outPath = await stepWrite(PARAGRAPHS_PATH, DOC_TITLE);
      console.log('\n✅ 完整流程结束！', outPath);
    } else {
      console.log('\n⏸ 请主 AI 完成语义分析后，继续执行（write 会自动检测最新目录）：');
      console.log(`   node video_to_markdown.js --step write --title "${DOC_TITLE}" --work-dir "${WORK_DIR}"`);
    }
```

- [ ] **Step 4: Update the `needsWorkDir` step list (source line 1651)**

Change:

```js
  const needsWorkDir = IS_FULL || ['all', 'download', 'transcribe', 'analyze', 'write-paragraphs', 'polish', 'frames', 'write'].includes(STEP);
```

to:

```js
  const needsWorkDir = IS_FULL || ['all', 'download', 'audio', 'transcribe', 'analyze', 'write-paragraphs', 'write'].includes(STEP);
```

- [ ] **Step 5: Add the `audio` dispatch and fix `transcribe`; remove `polish`/`frames` branches**

In `main`, the `transcribe` branch (source lines 1680-1681) currently passes `VIDEO_PATH`. Replace the `transcribe` branch and insert an `audio` branch before it:

```js
  } else if (STEP === 'audio') {
    await stepAudio(VIDEO_PATH);

  } else if (STEP === 'transcribe') {
    await stepTranscribe(AUDIO_PATH);
```

Delete the `polish` branch (source lines 1691-1693) and the `frames` branch (source lines 1695-1706) entirely.

- [ ] **Step 6: Fix the `write` branch's stale error message (source line 1714)**

Change:

```js
      console.error('❌ 未找到 paragraphs.json，请先运行 --step analyze 和 --step frames');
```

to:

```js
      console.error('❌ 未找到 paragraphs.json，请先运行 --step analyze 并由主 AI 写入段落数据');
```

- [ ] **Step 7: Replace the help text (the final `else` block, source lines 1719-1759)**

```js
  } else {
    console.log(`
多平台视频 → 本地 Markdown 文案（抖音/快手内置解析 + yt-dlp 多平台下载；写入本地 output.md）

环境检测（推荐先运行）：
  node scripts/video_to_markdown.js --step check

流程（按顺序，--work-dir 共享同一目录）：
  WORK=/tmp/video_to_markdown_task

  1. 下载视频（平台链接或分享文案）
     node scripts/video_to_markdown.js --step download --url "<链接或分享文案>" --work-dir $WORK
     → 抖音：使用内置 douyin_video_parser
     → 快手：使用公开分享页解析器
     → 哔哩哔哩/微博/小红书：使用 yt-dlp
     → 如内容需要登录，可配置 YTDLP_COOKIES 或 YTDLP_COOKIES_FROM_BROWSER=chrome

  2. 提取音频
     node scripts/video_to_markdown.js --step audio --work-dir $WORK

  3. 本地 Whisper 转录
     node scripts/video_to_markdown.js --step transcribe --work-dir $WORK

  4. AI 语义分析 + 文案修正（主 AI 读 segments.json 后写入 paragraphs.json）
     node scripts/video_to_markdown.js --step analyze --work-dir $WORK
     node scripts/video_to_markdown.js --step write-paragraphs --file $WORK/paragraphs.json --work-dir $WORK

  5. 组装 output.md
     node scripts/video_to_markdown.js --step write --title "视频标题" --work-dir $WORK

环境变量：
  YTDLP_COOKIES             yt-dlp cookies.txt 路径
  YTDLP_COOKIES_FROM_BROWSER  从浏览器读取 cookies，例如 chrome
  TRANSCRIBE_CHUNK_SEC      转录分段阈值（秒，默认 600）
  CLEAN_OLD_WORK_DIRS       新任务启动时是否清理旧 /tmp/douyin_task_* 目录（默认 1）
    `);
  }
```

- [ ] **Step 8: Verify syntax and no stale references**

Run: `node --check video-to-markdown/scripts/video_to_markdown.js && echo OK`
Expected: `OK`

Run: `grep -c -i "joyspace\|飞书\|feishu\|final_markdown\|create_doc_routing" video-to-markdown/scripts/video_to_markdown.js`
Expected: `0`

- [ ] **Step 9: Smoke-test help and an offline step**

Run: `node video-to-markdown/scripts/video_to_markdown.js`
Expected: prints the new help text with steps download/audio/transcribe/analyze/write; no JoySpace mentions.

Run (synthetic end-to-end without network/whisper — verifies write assembles output.md):
```bash
WORK=/tmp/v2md_smoke; rm -rf $WORK; mkdir -p $WORK
printf '%s' '[{"start":0,"end":5,"text":"第一段正文。","summary":"开场"},{"start":5,"end":10,"text":"第二段正文。","summary":"要点"}]' > $WORK/paragraphs.json
node video-to-markdown/scripts/video_to_markdown.js --step write --title "测试标题" --work-dir $WORK
cat $WORK/output.md
```
Expected: `output.md` contains `# 测试标题`, `## 开场`, `第一段正文。`, `## 要点`, `第二段正文。` and NO HTML comments.

- [ ] **Step 10: Commit**

```bash
git add video-to-markdown/scripts/video_to_markdown.js
git commit -m "Rewrite buildMarkdown/stepWrite/main dispatch and help for output.md"
```

---

### Task 7: Write SKILL.md

**Files:**
- Create: `video-to-markdown/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
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
```

- [ ] **Step 2: Verify frontmatter parses (name matches directory)**

Run: `head -3 video-to-markdown/SKILL.md`
Expected: shows `name: video-to-markdown`.

- [ ] **Step 3: Commit**

```bash
git add video-to-markdown/SKILL.md
git commit -m "Add video-to-markdown SKILL.md"
```

---

## Self-Review

**Spec coverage:**
- 解析链接+识别平台 → Task 1 (copy) + reused `detectPlatform`/`extractFirstUrl`; download step in Task 6 main dispatch. ✓
- 下载视频 → reused `stepDownload` (Task 1), dispatched in Task 6. ✓
- 提取音频（独立步骤）→ Task 4 `stepAudio` + Task 6 dispatch. ✓
- 提取文案（转录）→ Task 4 `stepTranscribe`. ✓
- AI 修正文案（语义分段+纠错）→ Task 5 `stepAnalyze` text. ✓
- 写入 Markdown → Task 6 `buildMarkdown`/`stepWrite` → `output.md`. ✓
- No OpenAI → Tasks 2,3,4. ✓ No frames/upload → Task 5. ✓ 5 platforms → Task 1 verbatim copy. ✓ No agents/ dir → never created. ✓

**Placeholder scan:** All steps contain concrete code/commands/expected output. No TBD/TODO. ✓

**Type consistency:** `stepAudio(videoPath)→AUDIO_PATH`, `stepTranscribe(audioPath)`, `stepWrite(paragraphsPath, title)`, `buildMarkdown(paragraphs, title)` — call sites in Task 6 match these signatures. `AUDIO_PATH` defined in Task 2, used in Tasks 4 & 6. ✓

**Note on line numbers:** All line references are to the SOURCE file. After each edit, line numbers shift — the implementer should locate the quoted code by content (the exact strings are provided), not by line number alone.
